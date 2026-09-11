export type CheckoutAttemptRestartStatus = 'restart_allowed' | 'resume_required' | 'unknown';

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
