import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import { missingFieldErrorCode, missingRequiredField } from '@/lib/checkout-flow';
import { evaluateCheckoutAccessGate } from '@/lib/checkout-access-gate';
import { getReferralCodeFromCookieHeader, sanitizeReferralCode } from '@/lib/referrals';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';
import { finalizeIntakeDraft, getIntakeDraft, persistIntakeDraft, type FinalizeIntakeInput, type IntakeDraftRecord } from '@/lib/order-intake';
import { isPrintFormat } from '@/lib/orders';
import { markRecoveryLeadConverted } from '@/lib/recovery';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getStripe() {
  return new Stripe(getRequiredStripeSecretKey());
}

function getReturnBaseUrl(request: Request): string {
  if (process.env.VERCEL_ENV === 'production') {
    const explicit = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '');
    if (explicit) return explicit;
    return 'https://herostorybooks.com';
  }
  try {
    const origin = new URL(request.url).origin;
    if (origin) return origin;
  } catch {}
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

export async function POST(request: Request) {
  let finalizedDraftForRetry: IntakeDraftRecord | null = null;
  try {
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      return NextResponse.json({ error: 'Finalize must be JSON only; upload assets before payment.', code: 'json_required' }, { status: 415 });
    }
    const body = await request.json() as FinalizeIntakeInput & Record<string, unknown>;
    const draftOrderId = String(body.draftOrderId ?? '').trim();
    if (!draftOrderId) return NextResponse.json({ error: 'Missing draft order id. You have not been charged.', code: 'draft_missing' }, { status: 400 });
    const draft = await getIntakeDraft(draftOrderId);
    if (!draft) return NextResponse.json({ error: 'Draft order not found. You have not been charged.', code: 'draft_not_found' }, { status: 404 });
    const fields = { ...draft.fields, ...(body.fields ?? {}) };
    const appearanceRaw = String(fields.appearanceOptions ?? '');
    let appearance: { skinTone?: string; hairStyle?: string } = {};
    try { appearance = JSON.parse(appearanceRaw) as typeof appearance; } catch { appearance = {}; }
    const childName = String(fields.childName ?? '').trim();
    const email = String(fields.email ?? '').trim();
    const theme = String(fields.theme ?? '').trim();
    const skinTone = String((fields as Record<string, unknown>).skinTone ?? appearance.skinTone ?? '').trim();
    const hairStyle = String((fields as Record<string, unknown>).hairStyle ?? appearance.hairStyle ?? '').trim();
    const missing = missingRequiredField({ theme, childName, email, skinTone, hairStyle });
    if (missing !== null || !isValidEmail(email)) {
      const code = missing ? missingFieldErrorCode(missing) : 'email_invalid';
      return NextResponse.json({ error: code === 'email_invalid' ? 'A valid email is required.' : `Missing required field: ${code}`, code }, { status: 400 });
    }
    const gate = await evaluateCheckoutAccessGate(email, 'order-finalize');
    if (gate.ok === false) return NextResponse.json(gate.body, { status: gate.status });

    const referralCode = sanitizeReferralCode((fields as Record<string, unknown>).referralCode) ?? getReferralCodeFromCookieHeader(request.headers.get('cookie'));
    const { draft: finalizedDraft, order } = await finalizeIntakeDraft({
      ...body,
      draftOrderId,
      fields: { ...fields, referralCode },
    });
    finalizedDraftForRetry = finalizedDraft;

    markRecoveryLeadConverted(order.email, order.id).catch(() => {});

    const stripe = getStripe();
    const baseUrl = getReturnBaseUrl(request);
    const successParams = new URLSearchParams({ orderId: order.id, childName: order.childName, format: order.formatLabel, email: order.email });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: order.email,
      client_reference_id: order.id,
      metadata: {
        orderId: order.id,
        draftOrderId,
        assetRefCount: String(draft.assets.length),
        ...(order.referralCode ? { referralCode: order.referralCode } : {}),
      },
      allow_promotion_codes: true,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: order.priceCents,
            product_data: { name: `${order.formatLabel} HeroStoryBook — ${order.childName}`, description: order.deliveryExpectation },
          },
          quantity: 1,
        },
      ],
      ...(isPrintFormat(order.bookFormat) ? { shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ'] } } : {}),
      success_url: `${baseUrl}/thank-you?${successParams.toString()}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout?cancelled=1&orderId=${order.id}`,
    });
    return NextResponse.json({ ok: true, orderId: order.id, redirectTo: session.url });
  } catch (error) {
    if (finalizedDraftForRetry) {
      try {
        await persistIntakeDraft({
          ...finalizedDraftForRetry,
          status: 'assets_uploaded',
          orderId: null,
          finalizedAt: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (rollbackError) {
        console.error('[order-finalize] failed to reopen finalized draft after Stripe checkout creation failure', rollbackError);
      }
    }
    const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 503;
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'finalize_failed';
    const message = error instanceof Error && error.message ? error.message : 'We could not securely finalize your order. You have not been charged.';
    console.error('[order-finalize] failed before Stripe or during checkout creation', error);
    return NextResponse.json({ error: message, code }, { status });
  }
}
