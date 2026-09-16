import { type NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';

import {
  CHECKOUT_ATTEMPT_LEASE_COOKIE,
  mintCheckoutAttemptId,
  resolveCheckoutAttemptLease,
} from '@/lib/checkout-attempt-lease';
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
const LEASE_MAX_AGE_SECONDS = 24 * 60 * 60;

export async function POST(request: NextRequest) {
  const requestOrigin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const forwardedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const forwardedProto = request.headers.get('x-forwarded-proto')
    ?? new URL(request.url).protocol.replace(':', '');
  const publicOrigin = forwardedHost ? `${forwardedProto}://${forwardedHost}` : null;
  if ((requestOrigin && (!publicOrigin || requestOrigin !== publicOrigin))
    || (fetchSite && fetchSite !== 'same-origin')
    || contentType !== 'application/json') {
    return NextResponse.json({ status: 'unknown' }, { status: 403, headers: NO_STORE_HEADERS });
  }
  try {
    const result = await resolveCheckoutAttemptLease(
      request.cookies.get(CHECKOUT_ATTEMPT_LEASE_COOKIE)?.value,
      {
        mintAttemptId: mintCheckoutAttemptId,
        resolveOrderId: resolveCheckoutOrderIdForAttempt,
        getOrder: getOrderAuthoritative,
        resolveExistingAttempt: async (attemptId) => {
          const stripe = new Stripe(getRequiredStripeSecretKey());
          const decision = await resolveCheckoutAttemptRestart(
            attemptId,
            // Same shared wiring as /api/order/attempt-restart: one rule decides
            // when a checkoutIntentFingerprint generation may be released.
            checkoutAttemptRestartDependencies({
              resolveOrderId: resolveCheckoutOrderIdForAttempt,
              getOrder: getOrderAuthoritative,
              retrieveSession: async (sessionId) => stripe.checkout.sessions.retrieve(sessionId),
              retireExpiredAttempt: retireExpiredCheckoutAttempt,
              releaseIntentClaim: releaseCheckoutIntentOrderId,
            }),
          );
          return decision.status;
        },
      },
    );

    if (result.status !== 'ready') {
      return NextResponse.json({ status: 'unknown' }, { status: 409, headers: NO_STORE_HEADERS });
    }

    const response = NextResponse.json(
      { status: 'ready', attemptId: result.attemptId },
      { status: 200, headers: NO_STORE_HEADERS },
    );
    if (result.setCookie) {
      response.cookies.set(CHECKOUT_ATTEMPT_LEASE_COOKIE, result.attemptId, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
        maxAge: LEASE_MAX_AGE_SECONDS,
      });
    }
    return response;
  } catch (error) {
    console.error('[checkout-attempt-lease] resolution failed', error);
    return NextResponse.json({ status: 'unknown' }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
