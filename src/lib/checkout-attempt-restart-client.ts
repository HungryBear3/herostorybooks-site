export type CheckoutAttemptRestartStatus = 'restart_allowed' | 'resume_required' | 'unknown';

const CHECKOUT_ATTEMPT_ID = /^[a-f0-9]{32}$/i;

export interface CheckoutAttemptLockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** Same-origin fallback for browsers that deny access to sessionStorage. */
export async function resolveServerCheckoutAttemptLease(
  fetchImpl: typeof fetch = fetch,
  lockManager?: CheckoutAttemptLockManager | null,
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
    let availableLockManager = lockManager;
    if (availableLockManager === undefined) {
      try {
        availableLockManager = typeof navigator === 'undefined' ? null : navigator.locks;
      } catch {
        availableLockManager = null;
      }
    }
    if (!availableLockManager) return await requestLease();

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
      return callbackStarted ? null : await requestLease();
    }
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
