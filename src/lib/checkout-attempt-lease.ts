import crypto from 'node:crypto';

import { checkoutOrderIdForAttempt } from './checkout-attempt-restart.ts';
import type { OrderRecord } from './orders.ts';

type CheckoutAttemptRestartStatus = 'restart_allowed' | 'resume_required' | 'unknown';

const CHECKOUT_ATTEMPT_ID = /^[a-f0-9]{32}$/i;

export const CHECKOUT_ATTEMPT_LEASE_COOKIE = '__Host-hsb-checkout-attempt';
export const CHECKOUT_ATTEMPT_LEASE_HEADER = 'x-hsb-checkout-attempt';

/** A lease header opts into cookie fencing; normal storage-backed requests omit it. */
export function checkoutAttemptLeaseHeaderMatchesCookie(
  cookieValue: string | null | undefined,
  headerValue: string | null | undefined,
): boolean {
  if (!headerValue) return true;
  return Boolean(cookieValue
    && CHECKOUT_ATTEMPT_ID.test(cookieValue)
    && CHECKOUT_ATTEMPT_ID.test(headerValue)
    && cookieValue === headerValue);
}

export function checkoutAttemptLeaseCookieFromHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== CHECKOUT_ATTEMPT_LEASE_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return CHECKOUT_ATTEMPT_ID.test(value) ? value : null;
  }
  return null;
}

export interface CheckoutAttemptLeaseDependencies {
  mintAttemptId(): string;
  getOrder(orderId: string): Promise<OrderRecord | null>;
  resolveExistingAttempt(attemptId: string): Promise<CheckoutAttemptRestartStatus>;
}

export type CheckoutAttemptLeaseResult =
  | { status: 'ready'; attemptId: string; setCookie: boolean }
  | { status: 'blocked' };

export function mintCheckoutAttemptId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Resolve a server-backed attempt identity for browsers where sessionStorage is
 * unavailable. Reuse is the safe default: the order id and Stripe idempotency
 * key are deterministic from this identity, so reloads cannot mint a second
 * payable session. Rotation is allowed only after authoritative restart proof.
 */
export async function resolveCheckoutAttemptLease(
  cookieValue: string | null | undefined,
  deps: CheckoutAttemptLeaseDependencies,
): Promise<CheckoutAttemptLeaseResult> {
  if (!cookieValue || !CHECKOUT_ATTEMPT_ID.test(cookieValue)) {
    const attemptId = deps.mintAttemptId();
    return CHECKOUT_ATTEMPT_ID.test(attemptId)
      ? { status: 'ready', attemptId, setCookie: true }
      : { status: 'blocked' };
  }

  const order = await deps.getOrder(checkoutOrderIdForAttempt(cookieValue));
  // No durable order may mean the first request is still in flight. Reusing the
  // exact identity is safe; rotating based on absence would create a race.
  if (!order) return { status: 'ready', attemptId: cookieValue, setCookie: false };
  if (order.checkoutAttemptId !== cookieValue) return { status: 'blocked' };

  const decision = await deps.resolveExistingAttempt(cookieValue);
  if (decision !== 'restart_allowed') {
    // Open, unavailable, and ambiguous states all reuse the same deterministic
    // identity. They never authorize a new order/session identity.
    return { status: 'ready', attemptId: cookieValue, setCookie: false };
  }

  const attemptId = deps.mintAttemptId();
  return CHECKOUT_ATTEMPT_ID.test(attemptId)
    ? { status: 'ready', attemptId, setCookie: true }
    : { status: 'blocked' };
}
