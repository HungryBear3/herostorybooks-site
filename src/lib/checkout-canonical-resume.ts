import {
  getOrderAuthoritative,
  hasCheckoutProviderEvidence,
  resolveCheckoutOrderIdForAttempt,
} from './orders.ts';
import {
  CHECKOUT_RECONCILIATION_SUPPORT,
  provisionCheckoutSession,
  type CheckoutSessionProvisionDeps,
} from './checkout-session-provisioning.ts';

export type CanonicalCheckoutResumeResult =
  | { status: 'not_applicable' }
  | { status: 'resumed'; url: string }
  | { status: 'refused'; code: string; message: string; httpStatus: number };

/**
 * Resume an already-provider-backed semantic checkout through its canonical
 * order. Alternate browser attempts may observe that order only after their
 * immutable attempt index has converged on it; they never adopt its lease or
 * perform pre-provider work.
 */
export async function resumeCanonicalCheckoutSession(input: {
  orderId: string;
  checkoutAttemptId: string;
  intentFingerprint: string;
  stripeProductId: string;
  baseUrl: string;
  gaClientId: string | null;
}, deps: CheckoutSessionProvisionDeps): Promise<CanonicalCheckoutResumeResult> {
  const canonical = await getOrderAuthoritative(input.orderId);
  if (!canonical || !hasCheckoutProviderEvidence(canonical)) {
    return { status: 'not_applicable' };
  }

  const attemptOrderId = await resolveCheckoutOrderIdForAttempt(input.checkoutAttemptId);
  if (
    canonical.checkoutIntentFingerprint !== input.intentFingerprint
    || attemptOrderId !== canonical.id
  ) {
    deps.logError?.(
      `[order] ABORT BEFORE MEDIA/PROVIDER: canonical order ${canonical.id} did not match semantic or attempt identity`,
    );
    return {
      status: 'refused',
      code: 'checkout_canonical_reconciliation_required',
      message: CHECKOUT_RECONCILIATION_SUPPORT,
      httpStatus: 409,
    };
  }

  if (!canonical.checkoutLeaseId || !canonical.checkoutFingerprint) {
    deps.logError?.(
      `[order] ABORT BEFORE MEDIA/PROVIDER: canonical order ${canonical.id} has provider evidence but no checkout identity`,
    );
    return {
      status: 'refused',
      code: 'checkout_session_identity_missing',
      message: CHECKOUT_RECONCILIATION_SUPPORT,
      httpStatus: 503,
    };
  }

  const result = await provisionCheckoutSession({
    order: canonical,
    leaseId: canonical.checkoutLeaseId,
    fingerprint: canonical.checkoutFingerprint,
    stripeProductId: input.stripeProductId,
    baseUrl: input.baseUrl,
    gaClientId: input.gaClientId,
  }, deps);

  if (result.status === 'refused') return result;
  return { status: 'resumed', url: result.url };
}
