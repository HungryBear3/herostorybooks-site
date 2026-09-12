import crypto from 'node:crypto';

import type { OrderRecord } from './orders.ts';

const CHECKOUT_ATTEMPT_ID = /^[a-f0-9]{32}$/i;

export interface CheckoutAttemptProviderSession {
  status?: string | null;
  payment_status?: string | null;
  payment_intent?: unknown;
}

export interface CheckoutAttemptRestartDeps {
  resolveOrderId?(attemptId: string): Promise<string | null>;
  getOrder(orderId: string): Promise<OrderRecord | null>;
  retrieveSession(stripeSessionId: string): Promise<CheckoutAttemptProviderSession>;
  retireExpiredAttempt(order: OrderRecord): Promise<boolean>;
  releaseIntentClaim(order: OrderRecord): Promise<boolean>;
}

/** The durable primitives both attempt routes hand to the decision below. */
export interface CheckoutAttemptRestartPrimitives {
  resolveOrderId(attemptId: string): Promise<string | null>;
  getOrder(orderId: string): Promise<OrderRecord | null>;
  retrieveSession(stripeSessionId: string): Promise<CheckoutAttemptProviderSession>;
  retireExpiredAttempt(order: OrderRecord): Promise<boolean>;
  releaseIntentClaim(fingerprint: string, orderId: string, generation: number): Promise<boolean>;
}

/**
 * Wire the durable primitives into one restart decision.
 *
 * The claim release is the part no caller may re-implement: a release is only
 * ever offered for the EXACT generation this order observed, and an order that
 * never claimed a semantic identity has nothing to release. Getting either half
 * wrong releases a live intent — which is how a second payable Session for the
 * same purchase gets minted — so both attempt routes share this one wiring.
 */
export function checkoutAttemptRestartDependencies(
  primitives: CheckoutAttemptRestartPrimitives,
): CheckoutAttemptRestartDeps {
  return {
    resolveOrderId: primitives.resolveOrderId,
    getOrder: primitives.getOrder,
    retrieveSession: primitives.retrieveSession,
    retireExpiredAttempt: primitives.retireExpiredAttempt,
    releaseIntentClaim: async (order) => {
      // Pre-claim legacy orders have nothing to release. New orders carry the
      // exact semantic fingerprint; malformed values fail closed in the helper.
      if (order.checkoutIntentFingerprint == null) return true;
      if (order.checkoutIntentClaimGeneration == null) return false;
      return primitives.releaseIntentClaim(
        order.checkoutIntentFingerprint,
        order.id,
        order.checkoutIntentClaimGeneration,
      );
    },
  };
}

export type CheckoutAttemptRestartResult =
  | { status: 'restart_allowed'; reason: 'expired_unpaid' | 'completed_paid' }
  | { status: 'resume_required'; reason: 'session_open' }
  | { status: 'unknown'; reason: 'invalid_attempt' | 'identity_mismatch' | 'provider_ambiguous' | 'provider_unavailable' };

export function checkoutOrderIdForAttempt(attemptId: string): string {
  return `ord_${crypto.createHash('sha256').update(attemptId).digest('hex').slice(0, 16)}`;
}

/**
 * Decide whether a browser may rotate away from a previously-sent checkout
 * identity. Rotation is allowed only when authoritative state proves the old
 * identity cannot create a second payment: no durable order exists, its bound
 * Stripe Session is expired+unpaid with no PaymentIntent, or it is already a
 * completed paid Session. Every outage or unfamiliar state fails closed.
 */
export async function resolveCheckoutAttemptRestart(
  attemptId: string,
  deps: CheckoutAttemptRestartDeps,
): Promise<CheckoutAttemptRestartResult> {
  if (!CHECKOUT_ATTEMPT_ID.test(attemptId)) {
    return { status: 'unknown', reason: 'invalid_attempt' };
  }

  const indexedOrderId = await deps.resolveOrderId?.(attemptId);
  const order = await deps.getOrder(indexedOrderId ?? checkoutOrderIdForAttempt(attemptId));
  // Absence is not enough: an earlier request may still be in flight and could
  // create the deterministic record immediately after this read.
  if (!order) return { status: 'unknown', reason: 'provider_ambiguous' };
  if (!indexedOrderId && order.checkoutAttemptId !== attemptId) {
    return { status: 'unknown', reason: 'identity_mismatch' };
  }
  if (!order.stripeSessionId) {
    return { status: 'unknown', reason: 'provider_ambiguous' };
  }

  let session: CheckoutAttemptProviderSession;
  try {
    session = await deps.retrieveSession(order.stripeSessionId);
  } catch {
    return { status: 'unknown', reason: 'provider_unavailable' };
  }

  if (session.status === 'open'
    && session.payment_status === 'unpaid'
    && !session.payment_intent) {
    return { status: 'resume_required', reason: 'session_open' };
  }
  if (session.status === 'expired'
    && session.payment_status === 'unpaid'
    && session.payment_intent === null) {
    if (order.paymentStatus === 'failed'
      && order.fulfillmentLastError === 'stripe_session_expired_unpaid') {
      const released = await deps.releaseIntentClaim(order);
      return released
        ? { status: 'restart_allowed', reason: 'expired_unpaid' }
        : { status: 'unknown', reason: 'provider_ambiguous' };
    }
    if (order.paymentStatus !== 'pending') {
      return { status: 'unknown', reason: 'provider_ambiguous' };
    }
    // Close the exact old attempt atomically. A racing retry that already
    // superseded the Session makes this fail, and browser rotation stays
    // blocked instead of creating two payable Sessions.
    const retired = await deps.retireExpiredAttempt(order);
    if (!retired) return { status: 'unknown', reason: 'provider_ambiguous' };
    const released = await deps.releaseIntentClaim(order);
    return released
      ? { status: 'restart_allowed', reason: 'expired_unpaid' }
      : { status: 'unknown', reason: 'provider_ambiguous' };
  }
  if (session.status === 'complete'
    && session.payment_status === 'paid'
    && Boolean(session.payment_intent)
    && order.paymentStatus === 'paid') {
    const released = await deps.releaseIntentClaim(order);
    return released
      ? { status: 'restart_allowed', reason: 'completed_paid' }
      : { status: 'unknown', reason: 'provider_ambiguous' };
  }
  return { status: 'unknown', reason: 'provider_ambiguous' };
}
