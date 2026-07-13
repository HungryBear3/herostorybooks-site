export interface CheckoutTracking {
  /** Private F&F / pilot cohort tag from /checkout?cohort=... */
  cohort?: string;
  /** Private tester/invite tag from /checkout?invite=... */
  invite?: string;
}

const TRACKING_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function sanitizeCheckoutTrackingValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase();
  if (!token) return null;
  return TRACKING_TOKEN_RE.test(token) ? token : null;
}

export function buildCheckoutTracking(input: {
  cohort?: unknown;
  invite?: unknown;
}): CheckoutTracking | null {
  const cohort = sanitizeCheckoutTrackingValue(input.cohort);
  const invite = sanitizeCheckoutTrackingValue(input.invite);
  if (!cohort && !invite) return null;
  return {
    ...(cohort ? { cohort } : {}),
    ...(invite ? { invite } : {}),
  };
}

export function checkoutTrackingFromSearchParams(params: URLSearchParams): CheckoutTracking | null {
  return buildCheckoutTracking({
    cohort: params.get('cohort'),
    invite: params.get('invite'),
  });
}
