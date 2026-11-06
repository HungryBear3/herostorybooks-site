import Stripe from 'stripe';

import { getReturnBaseUrl } from '../../../../../lib/checkout-order-route-handler.ts';
import {
  classroomCheckoutResponse,
  classroomCheckoutTargetFromEnv,
  resolveClassroomCheckoutProvider,
  type ClassroomCheckoutProvider,
  type ClassroomProviderSession,
} from '../../../../../lib/group-book/classroom-checkout.ts';
import {
  classroomOrderMatchesPaymentQaPolicy,
  classroomPaymentQaTestKey,
  getOrder,
  readClassroomPaymentQaPolicy,
} from '../../../../../lib/orders.ts';

export const runtime = 'nodejs';

/** Server-owned TEST coupon that makes the Session total zero; unset supplies no provider. */
const CLASSROOM_TEST_COUPON_ENV = 'HSB_CLASSROOM_TEST_COUPON_ID';

/**
 * Existing server coupon only, read natively and never created or changed:
 * TEST, valid, unrestricted 100 percent off, not exhausted or past redeem_by.
 * Fixed-amount or product-restricted coupons refuse rather than broaden scope.
 */
type CouponFacts = Awaited<ReturnType<InstanceType<typeof Stripe>['coupons']['retrieve']>>;

function fullDiscountCoupon(coupon: CouponFacts | null | undefined, couponId: string): boolean {
  if (!coupon || coupon.id !== couponId || coupon.object !== 'coupon') return false;
  if (coupon.livemode !== false || coupon.valid !== true || (coupon as unknown as { deleted?: boolean }).deleted === true) return false;
  if (coupon.percent_off !== 100 || (coupon.amount_off !== null && coupon.amount_off !== undefined)) return false;
  const appliesTo = coupon.applies_to as { products?: unknown[] } | null | undefined;
  if (appliesTo !== null && appliesTo !== undefined && !(Array.isArray(appliesTo.products) && appliesTo.products.length === 0)) return false;
  if (typeof coupon.max_redemptions === 'number' && !(coupon.times_redeemed < coupon.max_redemptions)) return false;
  if (typeof coupon.redeem_by === 'number' && coupon.redeem_by * 1000 <= Date.now()) return false;
  return true;
}

/** Native zero-total facts for a classroom Session; throws so the library holds, never releases. */
function requireNativeZero(session: ClassroomProviderSession, priceCents?: number): ClassroomProviderSession {
  const subtotal = session?.amount_subtotal;
  if (session?.livemode !== false || session.amount_total !== 0 || session.currency !== 'usd'
    || !Number.isSafeInteger(subtotal) || (subtotal as number) <= 0
    || (priceCents !== undefined && subtotal !== priceCents)
    || session.total_details?.amount_discount !== subtotal
    || session.payment_intent !== null) {
    throw new Error('classroom_native_session_not_zero');
  }
  return session;
}

/**
 * Stripe TEST adapter only inside an armed payment-QA Preview with its strict
 * server policy: anything else (Production, inactive, live/restricted key,
 * missing coupon) yields no provider and the handler answers 503 after
 * authentication.
 */
function stripeTestProvider(): ClassroomCheckoutProvider | null {
  const policy = readClassroomPaymentQaPolicy();
  const key = classroomPaymentQaTestKey();
  const coupon = process.env[CLASSROOM_TEST_COUPON_ENV];
  if (!policy || !key || !coupon || coupon !== policy.couponId || !/^[A-Za-z0-9_-]{1,64}$/.test(coupon)) return null;
  const stripe = new Stripe(key);
  return {
    async createZeroTotalSession({ order, idempotencyKey, metadata, baseUrl }) {
      const success = new URLSearchParams({ orderId: order.id });
      const created = await stripe.checkout.sessions.create({
        mode: 'payment',
        client_reference_id: order.id,
        customer_email: order.email,
        metadata,
        line_items: [{ price_data: { currency: 'usd', unit_amount: order.priceCents, product_data: { name: 'Classroom digital book' } }, quantity: 1 }],
        discounts: [{ coupon }],
        success_url: `${baseUrl}/thank-you?${success.toString()}&sessionId={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/`,
      }, { idempotencyKey }) as unknown as ClassroomProviderSession;
      requireNativeZero(created, order.priceCents);
      // The provider's own record, re-read: the same zero facts must hold there too.
      const retrieved = await stripe.checkout.sessions.retrieve(created.id) as unknown as ClassroomProviderSession;
      if (retrieved?.id !== created.id) throw new Error('classroom_native_session_identity');
      return requireNativeZero(retrieved, order.priceCents);
    },
    async retrieveSession(sessionId) {
      return requireNativeZero(await stripe.checkout.sessions.retrieve(sessionId) as unknown as ClassroomProviderSession);
    },
  };
}

/**
 * Armed target: the existing server target, the policy's exact order and its
 * native assembly identity, and the existing server coupon read natively
 * BEFORE any reservation or create. Any refusal is "no target" (503).
 */
async function paymentQaTarget(): Promise<{ orderId: string } | null> {
  const policy = readClassroomPaymentQaPolicy();
  const key = classroomPaymentQaTestKey();
  const target = classroomCheckoutTargetFromEnv();
  if (!policy || !key || !target || target.orderId !== policy.orderId) return null;
  const order = await getOrder(target.orderId);
  if (!order || !classroomOrderMatchesPaymentQaPolicy(order, policy)) return null;
  const coupon = await new Stripe(key).coupons.retrieve(policy.couponId);
  return fullDiscountCoupon(coupon, policy.couponId) ? target : null;
}

/** Thin wrapper: existing admin auth, server-owned target, Stripe TEST adapter. */
export async function POST(request: Request): Promise<Response> {
  return classroomCheckoutResponse(request, {
    target: readClassroomPaymentQaPolicy() ? paymentQaTarget : classroomCheckoutTargetFromEnv,
    provider: resolveClassroomCheckoutProvider(stripeTestProvider),
    baseUrl: getReturnBaseUrl,
  });
}
