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
  // Why the previous cookie identity is not restartable, when it exists. A paid
  // one must never be rotated away automatically: the buyer would get a second
  // payable checkout for a book they have already bought.
  let previousAttemptReason: string | null = null;
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
          previousAttemptReason = decision.reason;
          // Only an authoritatively expired+unpaid attempt authorizes a new
          // lease identity. A completed_paid one is withheld from rotation here
          // and reported below so the browser can route to confirmation.
          return decision.status === 'restart_allowed' && decision.reason !== 'expired_unpaid'
            ? 'resume_required'
            : decision.status;
        },
      },
    );

    if (result.status !== 'ready') {
      return NextResponse.json({ status: 'unknown' }, { status: 409, headers: NO_STORE_HEADERS });
    }

    if (previousAttemptReason === 'completed_paid') {
      return NextResponse.json(
        { status: 'paid_confirmation_required', attemptId: result.attemptId },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }

    const response = NextResponse.json(
      // `setCookie` is exactly the fresh/reused distinction: a minted identity
      // gets a new cookie, a reused one keeps the buyer's existing cookie. The
      // browser needs it because a reused lease may already own a dispatched
      // `/api/order` request, and must not be told nothing was charged.
      {
        status: 'ready',
        attemptId: result.attemptId,
        provenance: result.setCookie ? 'fresh' : 'reused',
      },
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
