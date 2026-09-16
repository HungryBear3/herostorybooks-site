import { NextResponse } from 'next/server';
import Stripe from 'stripe';

import {
  checkoutAttemptRestartDependencies,
  resolveCheckoutAttemptRestart,
} from '@/lib/checkout-attempt-restart';
import {
  getOrderAuthoritative,
  releaseCheckoutIntentOrderId,
  resolveCheckoutOrderIdForAttempt,
  retireExpiredCheckoutAttempt,
} from '@/lib/orders';
import { getRequiredStripeSecretKey } from '@/lib/stripe-env';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

export async function POST(request: Request) {
  let checkoutAttemptId = '';
  try {
    const body = await request.json();
    checkoutAttemptId = typeof body?.checkoutAttemptId === 'string'
      ? body.checkoutAttemptId.trim()
      : '';
  } catch {
    // Invalid JSON is handled by the same non-disclosing invalid result below.
  }

  if (!/^[a-f0-9]{32}$/i.test(checkoutAttemptId)) {
    return NextResponse.json(
      { status: 'unknown' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const stripe = new Stripe(getRequiredStripeSecretKey());
    const result = await resolveCheckoutAttemptRestart(
      checkoutAttemptId,
      // The shared wiring owns the checkoutIntentFingerprint/generation release
      // rule, so this route and the lease route can never drift apart on it.
      checkoutAttemptRestartDependencies({
        resolveOrderId: resolveCheckoutOrderIdForAttempt,
        getOrder: getOrderAuthoritative,
        retrieveSession: async (stripeSessionId) => stripe.checkout.sessions.retrieve(stripeSessionId),
        retireExpiredAttempt: retireExpiredCheckoutAttempt,
        releaseIntentClaim: releaseCheckoutIntentOrderId,
      }),
    );
    return NextResponse.json(
      { status: result.status },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    console.error('[checkout-attempt-restart] reconciliation failed', error);
    return NextResponse.json(
      { status: 'unknown' },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
