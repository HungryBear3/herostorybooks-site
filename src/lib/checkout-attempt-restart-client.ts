export type CheckoutAttemptRestartStatus = 'restart_allowed' | 'resume_required' | 'unknown';

const CHECKOUT_ATTEMPT_ID = /^[a-f0-9]{32}$/i;

export interface CheckoutAttemptLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Same-origin fallback for browsers that deny access to sessionStorage. */
export async function resolveServerCheckoutAttemptLease(
  fetchImpl: typeof fetch = fetch,
  lockManager: CheckoutAttemptLockManager | null | undefined =
    typeof navigator === 'undefined' ? null : navigator.locks,
): Promise<string | null> {
  const requestLease = async (): Promise<string | null> => {
    const response = await fetchImpl('/api/order/attempt-lease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.status === 'ready' && CHECKOUT_ATTEMPT_ID.test(body?.attemptId)
      ? body.attemptId
      : null;
  };
  try {
    // Web Locks are origin-wide. Serializing here lets a cookie set by the first
    // Private tab become visible before a second tab begins its lease request.
    return lockManager
      ? await lockManager.request('hsb-checkout-attempt-lease', requestLease)
      : await requestLease();
  } catch {
    return null;
  }
}

/** Same-origin, fail-closed preflight for a previously-sent browser attempt. */
export async function resolveStoredCheckoutAttemptForNewPurchase(
  attemptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutAttemptRestartStatus> {
  try {
    const response = await fetchImpl('/api/order/attempt-restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutAttemptId: attemptId }),
      cache: 'no-store',
    });
    if (!response.ok) return 'unknown';
    const body = await response.json();
    return body?.status === 'restart_allowed' || body?.status === 'resume_required'
      ? body.status
      : 'unknown';
  } catch {
    return 'unknown';
  }
}
