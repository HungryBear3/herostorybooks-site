export type AdminOrdersPrivacyVerdict = 'safe_login_shell' | 'unsafe_exposed_data' | 'unknown';

export interface AdminOrdersPrivacyCheck {
  status: number;
  body: string;
}

export interface AdminOrdersPrivacyClassification {
  verdict: AdminOrdersPrivacyVerdict;
  safe: boolean;
  reason: string;
}

const LOGIN_SHELL_RE = /ops sign-in|operator key|name=["']key["']|type=["']password["']|\/api\/admin\/login/i;
const EXPOSED_ORDER_DATA_RE = /\bord_[a-z0-9_-]+\b|customer_email|paymentStatus|fulfillmentStatus|stripeSessionId|proofApprovalToken|shippingAddress|photoBlobUrl|guidedReferencePhotos/i;

/**
 * Classifies unauthenticated /admin/orders fetch output for readiness checks.
 * A 200 is acceptable only when it is the login shell. A 200 that contains
 * order/customer markers is unsafe even if the status code itself looks healthy.
 */
export function classifyUnauthedAdminOrdersResponse(
  response: AdminOrdersPrivacyCheck,
): AdminOrdersPrivacyClassification {
  if (response.status === 401 || response.status === 403 || response.status === 302 || response.status === 307 || response.status === 308) {
    return { verdict: 'safe_login_shell', safe: true, reason: `blocked or redirected with ${response.status}` };
  }

  const body = response.body || '';
  if (EXPOSED_ORDER_DATA_RE.test(body)) {
    return { verdict: 'unsafe_exposed_data', safe: false, reason: 'unauthenticated response contains order/customer data markers' };
  }

  if (response.status === 200 && LOGIN_SHELL_RE.test(body)) {
    return { verdict: 'safe_login_shell', safe: true, reason: '200 response is the ops login shell only' };
  }

  return { verdict: 'unknown', safe: false, reason: `unexpected unauthenticated admin response status/body (${response.status})` };
}
