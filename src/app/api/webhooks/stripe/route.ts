import { NextResponse, after } from 'next/server';
import Stripe from 'stripe';

import { sendOrderConfirmationEmail } from '@/lib/order-email';
import { isPrintFormat, updateOrderPayment, type ShippingAddress } from '@/lib/orders';
import { scheduleFulfillmentKickoff } from '@/lib/fulfillment-kickoff';
import { getRequiredStripeSecretKey, getRequiredStripeWebhookSecret } from '@/lib/stripe-env';
import { parsePrintUpgradeTargetFormat, recordPrintUpgradePayment } from '@/lib/print-upgrades';

// kept for future use (print-vs-digital branching); referenced by tests
void isPrintFormat;

interface StripeCheckoutSession {
  id: string;
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
  amount_total?: number | null;
  customer_email?: string | null;
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
    console.error('Stripe signature verification failed:', {
      message: err instanceof Error ? err.message : String(err),
      hasWebhookSecret: Boolean(webhookSecret),
      hasSignatureHeader: Boolean(sig),
      signatureHeaderLength: sig.length,
      bodyLength: body.length,
      bodyLooksJson: body.trimStart().startsWith('{'),
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as StripeCheckoutSession;
    const kind = session.metadata?.kind ?? null;

    if (kind === 'print_upgrade') {
      const upgradeOrderId = (session.metadata?.orderId ?? session.client_reference_id) || null;
      const targetFormat = parsePrintUpgradeTargetFormat(session.metadata?.targetFormat);
      if (!upgradeOrderId || !targetFormat) {
        console.error('Stripe webhook: invalid print upgrade metadata', {
          sessionId: session.id,
          orderId: upgradeOrderId,
          targetFormat: session.metadata?.targetFormat ?? null,
        });
        return NextResponse.json({ received: true, printUpgradeSkipped: true });
      }

      try {
        const updated = await recordPrintUpgradePayment(upgradeOrderId, {
          stripeSessionId: session.id,
          amountCents: session.amount_total ?? 0,
          targetFormat,
          printProvider: session.metadata?.printProvider ?? 'rpi',
          ...(extractShipping(session) ? { shippingAddress: extractShipping(session) } : {}),
        });
        if (!updated) {
          console.error(
            `[webhook] CRITICAL: print upgrade order ${upgradeOrderId} not found after paid Stripe session ${session.id} ` +
              `(amount=${session.amount_total ?? '?'}, customer_email=${session.customer_email ?? '?'}).`,
          );
          return NextResponse.json(
            { error: `Order ${upgradeOrderId} not found in durable store` },
            { status: 500 },
          );
        }
        console.warn(
          `Stripe webhook: recorded print upgrade for ${upgradeOrderId} session=${session.id}; ` +
            `manual print-go still required after QA`,
        );
      } catch (err) {
        console.error(`Stripe webhook: failed to process print upgrade for ${upgradeOrderId}:`, err);
        return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
      }

      return NextResponse.json({ received: true, printUpgradeRecorded: true });
    }

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
            // Repair path: a prior webhook/replay marked the order paid but
            // fulfillment never started. Schedule a kickoff via the
            // setImmediate+after-backed helper so a Vercel-style after()
            // failure (Rex 2026-05-08 retest #2) doesn't silently drop it.
            console.warn(
              `Stripe webhook: paid order ${orderId} still fulfillmentStatus=${existing.fulfillmentStatus ?? 'unset'} — scheduling fulfillment backfill after response`,
            );
            scheduleFulfillmentKickoff(orderId, { afterImpl: after });
          } else {
            // Make the no-op explicit: a Stripe redelivery for a paid order
            // whose fulfillment is in-progress or already complete is a
            // benign skip — there is nothing to do here. Logging it
            // closes a preview-log observability gap where this branch
            // was previously silent (operators had to infer the skip
            // reason from absence-of-kickoff lines).
            console.warn(
              `Stripe webhook: paid order ${orderId} replay skipped — paymentStatus=paid ` +
                `fulfillmentStatus=${existing.fulfillmentStatus} (already in-progress or complete); ` +
                `no kickoff retrigger needed`,
            );
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

      // Webhook contract:
      //   - The payment write (above) is awaited so the order is durably
      //     paid BEFORE we return 200 — a Stripe retry must never observe
      //     "still pending" after we've ack'd.
      //   - Fulfillment is decoupled via scheduleFulfillmentKickoff which
      //     uses `setImmediate` (reliable in `next start`) plus
      //     `next/server after()` (serverless backup). Whichever scheduler
      //     fires first runs `triggerFulfillment(orderId)`; the second is
      //     deduped. Every transition is logged.
      //   - The 2026-05-08 retest #2 showed `after()` callbacks silently
      //     dropping in `next start`, leaving paid orders stuck. The
      //     setImmediate path is the load-bearing kickoff for local QA.
      //   - triggerFulfillment re-reads authoritative paid state from
      //     persistence before running anything (see fulfillment.ts).
      //     If the read does not show paid, fulfillment refuses.
      scheduleFulfillmentKickoff(orderId, { afterImpl: after });
    } catch (err) {
      console.error(`Stripe webhook: failed to process order ${orderId}:`, err);
      return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ received: true });
}
