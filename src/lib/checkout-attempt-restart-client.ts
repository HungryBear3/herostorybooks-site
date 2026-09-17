import {
  checkoutAttemptStorageUnavailable,
  type CheckoutAttemptStorageSnapshot,
  type MinimalWebStorage,
} from './checkout-saved-draft.ts';

export type CheckoutAttemptRestartStatus = 'restart_allowed' | 'resume_required' | 'unknown';

export type CheckoutAttemptRestartReason =
  | 'expired_unpaid'
  | 'completed_paid'
  | 'session_open'
  | 'invalid_attempt'
  | 'identity_mismatch'
  | 'provider_ambiguous'
  | 'provider_unavailable';

export interface CheckoutAttemptRestartDecision {
  status: CheckoutAttemptRestartStatus;
  reason: CheckoutAttemptRestartReason;
}

export type CheckoutAttemptLeaseResolution =
  | { status: 'ready'; attemptId: string; provenance: 'fresh' | 'reused' }
  | { status: 'paid_confirmation_required'; attemptId: string | null }
  | { status: 'unavailable' };

export type CheckoutAttemptSubmitLeaseTransition =
  | { action: 'use_browser_storage' }
  | { action: 'use_server_lease'; attemptId: string; provenance: 'fresh' | 'reused' }
  | { action: 'recover_paid_attempt'; attemptId: string | null }
  | { action: 'abort_unresolved' };

export type CheckoutAttemptContinueDecision =
  | { action: 'reuse_attempt' }
  | { action: 'rotate_attempt'; reason: 'expired_unpaid' | 'completed_paid' }
  | { action: 'paid_confirmation_required' };

/**
 * Automatic rotation to a new payable identity is authorized by exactly one
 * proof: the old Stripe Session is expired, unpaid, and carries no
 * PaymentIntent, so it can never take money. `completed_paid` is also a
 * terminal state, but it is terminal because the buyer ALREADY PAID — rotating
 * on it silently converts a recovery click into a second purchase.
 */
export function checkoutAttemptRotationAuthorized(
  decision: CheckoutAttemptRestartDecision,
): boolean {
  return decision.status === 'restart_allowed' && decision.reason === 'expired_unpaid';
}

/**
 * What a Continue click may do with a previously-dispatched attempt.
 *
 * Pressing Continue is consent to finish THIS order. It is never consent to buy
 * a second one, so a prior attempt that has become `completed_paid` routes to
 * confirmation and waits for a separate, explicit new-purchase action naming
 * that same attempt. Everything else — open sessions, provider outages, records
 * we cannot read — reuses the existing identity and fails closed.
 */
export function decideCheckoutAttemptContinue(input: {
  attemptId: string;
  decision: CheckoutAttemptRestartDecision;
  newPurchaseConsentAttemptId: string | null | undefined;
}): CheckoutAttemptContinueDecision {
  if (input.decision.status !== 'restart_allowed') return { action: 'reuse_attempt' };
  if (input.decision.reason === 'expired_unpaid') {
    return { action: 'rotate_attempt', reason: 'expired_unpaid' };
  }
  if (input.decision.reason !== 'completed_paid') return { action: 'reuse_attempt' };
  return input.newPurchaseConsentAttemptId === input.attemptId
    ? { action: 'rotate_attempt', reason: 'completed_paid' }
    : { action: 'paid_confirmation_required' };
}

const CHECKOUT_ATTEMPT_ID = /^[a-f0-9]{32}$/i;

export interface CheckoutAttemptLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * The submit boundary for browsers whose attempt storage may be unavailable.
 * An unavailable or malformed server lease is an explicit abort state: callers
 * must not fall through to local mint/reservation after this transition.
 */
export async function resolveCheckoutAttemptSubmitLease(input: {
  storage: MinimalWebStorage | null | undefined;
  snapshot: CheckoutAttemptStorageSnapshot;
  fetchImpl?: typeof fetch;
  lockManager?: CheckoutAttemptLockManager | null;
}): Promise<CheckoutAttemptSubmitLeaseTransition> {
  if (!checkoutAttemptStorageUnavailable(input.storage, input.snapshot)) {
    return { action: 'use_browser_storage' };
  }
  const lease = await resolveServerCheckoutAttemptLease(input.fetchImpl, input.lockManager);
  if (lease.status === 'ready') {
    return {
      action: 'use_server_lease',
      attemptId: lease.attemptId,
      provenance: lease.provenance,
    };
  }
  if (lease.status === 'paid_confirmation_required') {
    return { action: 'recover_paid_attempt', attemptId: lease.attemptId };
  }
  return { action: 'abort_unresolved' };
}

/** Same-origin fallback for browsers that deny access to sessionStorage. */
export async function resolveServerCheckoutAttemptLease(
  fetchImpl: typeof fetch = fetch,
  lockManager?: CheckoutAttemptLockManager | null,
): Promise<CheckoutAttemptLeaseResolution> {
  const requestLease = async (): Promise<CheckoutAttemptLeaseResolution> => {
    const response = await fetchImpl('/api/order/attempt-lease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return { status: 'unavailable' };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: 'unavailable' };
    }
    const lease = body as { status?: unknown; attemptId?: unknown; provenance?: unknown };
    if (lease?.status === 'paid_confirmation_required') {
      return {
        status: 'paid_confirmation_required',
        attemptId: typeof lease.attemptId === 'string' && CHECKOUT_ATTEMPT_ID.test(lease.attemptId)
          ? lease.attemptId
          : null,
      };
    }
    if (lease?.status !== 'ready'
      || typeof lease.attemptId !== 'string'
      || !CHECKOUT_ATTEMPT_ID.test(lease.attemptId)) {
      return { status: 'unavailable' };
    }
    // Provenance is load-bearing. A missing or malformed value cannot authorize
    // private upload or order work.
    if (lease.provenance !== 'fresh' && lease.provenance !== 'reused') {
      return { status: 'unavailable' };
    }
    return {
      status: 'ready',
      attemptId: lease.attemptId,
      provenance: lease.provenance,
    };
  };
  try {
    let availableLockManager = lockManager;
    if (availableLockManager === undefined) {
      try {
        availableLockManager = typeof navigator === 'undefined' ? null : navigator.locks;
      } catch {
        availableLockManager = null;
      }
    }
    if (!availableLockManager) return await requestLease();
    const unavailable: CheckoutAttemptLeaseResolution = { status: 'unavailable' };

    // Web Locks remain a best-effort convergence optimization. Correctness is
    // enforced server-side by the atomic semantic-intent claim before any order
    // or provider work. Retry lock ACQUISITION only when Safari rejected before
    // the callback began; once a fetch starts, a lost response is ambiguous and
    // must never be reissued by this invocation.
    let callbackStarted = false;
    try {
      return await availableLockManager.request('hsb-checkout-attempt-lease', async () => {
        callbackStarted = true;
        return requestLease();
      });
    } catch {
      return callbackStarted ? unavailable : await requestLease();
    }
  } catch {
    return { status: 'unavailable' };
  }
}

/** Same-origin, fail-closed preflight for a previously-sent browser attempt. */
export async function resolveStoredCheckoutAttemptForNewPurchase(
  attemptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutAttemptRestartDecision> {
  // The reason is load-bearing, not diagnostic: it is what separates an expired
  // attempt the browser may rotate away from a PAID one that must route to
  // confirmation. An approval whose reason is missing or unrecognized therefore
  // degrades to `unknown` rather than authorizing anything.
  try {
    const response = await fetchImpl('/api/order/attempt-restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutAttemptId: attemptId }),
      cache: 'no-store',
    });
    if (!response.ok) return { status: 'unknown', reason: 'provider_unavailable' };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { status: 'unknown', reason: 'provider_ambiguous' };
    }
    const decision = body as { status?: unknown; reason?: unknown };
    if (decision?.status === 'restart_allowed') {
      return decision.reason === 'expired_unpaid' || decision.reason === 'completed_paid'
        ? { status: 'restart_allowed', reason: decision.reason }
        : { status: 'unknown', reason: 'provider_ambiguous' };
    }
    if (decision?.status === 'resume_required') {
      return decision.reason === 'session_open'
        ? { status: 'resume_required', reason: 'session_open' }
        : { status: 'unknown', reason: 'provider_ambiguous' };
    }
    if (decision?.status === 'unknown') {
      return decision.reason === 'invalid_attempt'
        || decision.reason === 'identity_mismatch'
        || decision.reason === 'provider_ambiguous'
        || decision.reason === 'provider_unavailable'
        ? { status: 'unknown', reason: decision.reason }
        : { status: 'unknown', reason: 'provider_ambiguous' };
    }
    return { status: 'unknown', reason: 'provider_ambiguous' };
  } catch {
    return { status: 'unknown', reason: 'provider_unavailable' };
  }
}
