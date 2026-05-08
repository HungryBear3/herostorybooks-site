import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { sendOrderConfirmationEmail } from '@/lib/order-email';
import { isPrintFormat, updateOrderPayment, type ShippingAddress } from '@/lib/orders';
import { triggerFulfillment } from '@/lib/fulfillment';
import { getRequiredStripeSecretKey, getRequiredStripeWebhookSecret } from '@/lib/stripe-env';

interface StripeCheckoutSession {
  id: string;
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
  shipping_details?: {
    address?: {
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      postal_code?: string | null;
      country?: string | null;
    } | null;
  } | null;
}

function getStripe() {
  return new Stripe(getRequiredStripeSecretKey());
}

function extractShipping(session: StripeCheckoutSession): ShippingAddress | undefined {
  const addr = session.shipping_details?.address;
  if (!addr) return undefined;
  return {
    line1: addr.line1 ?? '',
    line2: addr.line2 ?? null,
    city: addr.city ?? '',
    state: addr.state ?? '',
    zip: addr.postal_code ?? '',
    country: addr.country ?? '',
  };
}

export async function POST(request: Request) {
  const stripe = getStripe();
  let webhookSecret: string;

  try {
    webhookSecret = getRequiredStripeWebhookSecret();
  } catch {
    console.error('STRIPE_WEBHOOK_SECRET not set');
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature') ?? '';

  let event: ReturnType<typeof stripe.webhooks.constructEvent>;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as StripeCheckoutSession;
    const orderId = (session.metadata?.orderId ?? session.client_reference_id) || null;

    if (!orderId) {
      console.error('Stripe webhook: no orderId in session metadata');
      return NextResponse.json({ received: true });
    }

    try {
      const existing = await (await import('@/lib/orders')).getOrder(orderId);

      // Refund-safe idempotency:
      //   1. If a prior session-completed already moved this order to paid,
      //      skip — same as before.
      //   2. If the order has since been refunded (paymentStatus='refunded'
      //      OR refundedAt set), the same session_id replaying must NOT
      //      flip state back to paid and must NOT re-trigger fulfillment.
      //      Refund is terminal for the payment lifecycle.
      //   3. More generally, for the same session_id we never overwrite
      //      a non-pending paymentStatus — only the first pending → paid
      //      transition is allowed.
      if (existing?.stripeSessionId === session.id) {
        if (existing.paymentStatus === 'paid') {
          console.warn(`Stripe webhook: session ${session.id} already processed — skipping payment update`);
          if (!existing.fulfillmentStatus || existing.fulfillmentStatus === 'not_started') {
            // Repair path for cases where the first webhook/replay marked the
            // order paid but fulfillment never started (for example, local
            // Stripe CLI delivery races or a previous serverless invocation
            // exiting after the payment write). This remains idempotent because
            // triggerFulfillment re-checks fulfillment state.
            //
            // Pass `existing` (the in-memory record we just loaded with
            // verified paymentStatus='paid') so triggerFulfillment doesn't
            // re-read the persistence backend and hit a stale 'pending'
            // read that would silently skip kickoff.
            console.warn(
              `Stripe webhook: paid order ${orderId} still fulfillmentStatus=${existing.fulfillmentStatus ?? 'unset'} — backfilling fulfillment`,
            );
            try {
              await triggerFulfillment(orderId, {}, { preloadedOrder: existing });
            } catch (err) {
              console.error(`[webhook] fulfillment backfill failed for ${orderId}:`, err);
            }
          }
          return NextResponse.json({ received: true });
        }
        if (existing.paymentStatus === 'refunded' || existing.refundedAt) {
          console.warn(
            `Stripe webhook: replay on refunded order ${orderId} (session=${session.id}) — refusing to resurrect; no state change, no fulfillment retrigger`,
          );
          return NextResponse.json({ received: true, refundedSkipped: true });
        }
        if (existing.paymentStatus !== 'pending') {
          console.warn(
            `Stripe webhook: session ${session.id} replay on terminal paymentStatus=${existing.paymentStatus} — skipping`,
          );
          return NextResponse.json({ received: true });
        }
      }

      const shipping = extractShipping(session);
      const updated = await updateOrderPayment(orderId, 'paid', {
        stripeSessionId: session.id,
        ...(shipping ? { shippingAddress: shipping } : {}),
      });

      if (!updated) {
        // Two distinct meanings collapse here in production: (a) the order
        // record was never durably persisted before Stripe completed (a
        // recovery candidate — run scripts/recover-orders.ts), (b) the order
        // was persisted to a different store than we're reading from (an
        // infra bug — investigate blob token + region). Both are losses.
        // Return 500 so Stripe retries delivery; if it's still missing on
        // retry, ops has a clear log line to act on.
        console.error(
          `[webhook] CRITICAL: order ${orderId} not found in durable store after paid Stripe session ${session.id} ` +
            `(amount=${(session as { amount_total?: number }).amount_total ?? '?'}, customer_email=${(session as { customer_email?: string }).customer_email ?? '?'}). ` +
            `This customer paid but their order is missing. Recovery via scripts/recover-orders.ts may be required.`,
        );
        return NextResponse.json(
          { error: `Order ${orderId} not found in durable store` },
          { status: 500 },
        );
      }

      await sendOrderConfirmationEmail(updated);

      // Awaited so serverless runtime keeps the request alive until fulfillment
      // actually starts. A fire-and-forget promise gets dropped when the
      // function returns, which on Vercel left orders stuck at
      // fulfillmentStatus='not_started' even after webhook marked them paid.
      // Errors are still captured on the order record by triggerFulfillment.
      //
      // Pass `updated` (the just-persisted post-write order record with
      // paymentStatus='paid') so triggerFulfillment skips the re-read of
      // the persistence backend. Read-after-write inconsistency on the
      // blob backend would otherwise return a stale 'pending' record and
      // make triggerFulfillment silently skip kickoff — that's the
      // 2026-05-08 paid-but-not-started incident pattern.
      try {
        await triggerFulfillment(orderId, {}, { preloadedOrder: updated });
      } catch (err) {
        console.error(`[webhook] fulfillment trigger failed for ${orderId}:`, err);
      }
    } catch (err) {
      console.error(`Stripe webhook: failed to process order ${orderId}:`, err);
      return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
