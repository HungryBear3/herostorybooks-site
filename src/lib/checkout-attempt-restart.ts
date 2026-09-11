import crypto from 'node:crypto';

import type { OrderRecord } from './orders.ts';

const CHECKOUT_ATTEMPT_ID = /^[a-f0-9]{32}$/i;

export interface CheckoutAttemptProviderSession {
  status?: string | null;
  payment_status?: string | null;
  payment_intent?: unknown;
}

export interface CheckoutAttemptRestartDeps {
  getOrder(orderId: string): Promise<OrderRecord | null>;
  retrieveSession(stripeSessionId: string): Promise<CheckoutAttemptProviderSession>;
  retireExpiredAttempt(order: OrderRecord): Promise<boolean>;
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

  const order = await deps.getOrder(checkoutOrderIdForAttempt(attemptId));
  // Absence is not enough: an earlier request may still be in flight and could
  // create the deterministic record immediately after this read.
  if (!order) return { status: 'unknown', reason: 'provider_ambiguous' };
  if (order.checkoutAttemptId !== attemptId) {
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

  if (session.status === 'open') {
    return { status: 'resume_required', reason: 'session_open' };
  }
  if (session.status === 'expired'
    && session.payment_status === 'unpaid'
    && !session.payment_intent) {
    // Close the exact old attempt atomically. A racing retry that already
    // superseded the Session makes this fail, and browser rotation stays
    // blocked instead of creating two payable Sessions.
    const retired = await deps.retireExpiredAttempt(order);
    return retired
      ? { status: 'restart_allowed', reason: 'expired_unpaid' }
      : { status: 'unknown', reason: 'provider_ambiguous' };
  }
  if (session.status === 'complete'
    && session.payment_status === 'paid'
    && Boolean(session.payment_intent)
    && order.paymentStatus === 'paid') {
    return { status: 'restart_allowed', reason: 'completed_paid' };
  }
  return { status: 'unknown', reason: 'provider_ambiguous' };
}
