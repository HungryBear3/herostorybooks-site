// Owner-test checkout gate — DEFAULT-CLOSED.
//
// Controlled owner-test posture: checkout is refused unless BOTH conditions
// hold, so an accidental public / creator / gifting visitor cannot be charged
// before the proof/email/fulfillment gates are proven:
//
//   1. HSB_OWNER_TEST_CHECKOUT_ENABLED === 'true'  (global explicit enable)
//   2. the buyer email is on HSB_OWNER_TEST_EMAILS  (comma-separated,
//      case-insensitive, trimmed)
//
// With NO env set the gate is CLOSED. This sits AFTER the checkout-pause /
// kill-switch checks (those take precedence) and BEFORE any Stripe Checkout
// Session is created. The customer-facing response never reveals the flag
// state or the allowlist — the refusal reason is internal only.

export const OWNER_TEST_GATE_CODE = 'owner_test_gate_closed';

export const OWNER_TEST_GATE_MESSAGE =
  'Checkout is currently limited to the HeroStoryBooks internal owner-test group. ' +
  'If you believe you should have access, contact support@herostorybooks.com.';

export type OwnerTestGateRefusal = 'flag_disabled' | 'email_not_allowlisted';

export type OwnerTestGateResult =
  | { allowed: true }
  | { allowed: false; reason: OwnerTestGateRefusal };

/** Global enable flag. Only the exact string 'true' (whitespace/case tolerant
 *  for Vercel-pulled values) enables; everything else — including unset —
 *  leaves the gate closed. */
export function isOwnerTestCheckoutEnabled(
  value = process.env.HSB_OWNER_TEST_CHECKOUT_ENABLED,
): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** Parse the comma-separated allowlist into normalized (trimmed, lowercased,
 *  non-empty) email entries. */
export function parseOwnerTestEmails(
  raw = process.env.HSB_OWNER_TEST_EMAILS,
): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/** True iff `email` is on the allowlist (case-insensitive, trimmed). An empty
 *  or unset allowlist allows nobody. */
export function isOwnerTestEmailAllowed(
  email: string,
  raw = process.env.HSB_OWNER_TEST_EMAILS,
): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return parseOwnerTestEmails(raw).includes(normalized);
}

/**
 * Combined default-closed decision. The flag is checked first so a probe with
 * an unknown email cannot distinguish "flag off" from "not allowlisted" beyond
 * what the internal reason records (which is never returned to the customer).
 */
export function evaluateOwnerTestGate(
  email: string,
  env: { enabledFlag?: string; allowEmails?: string } = {},
): OwnerTestGateResult {
  const enabledFlag = 'enabledFlag' in env ? env.enabledFlag : process.env.HSB_OWNER_TEST_CHECKOUT_ENABLED;
  const allowEmails = 'allowEmails' in env ? env.allowEmails : process.env.HSB_OWNER_TEST_EMAILS;

  if (!isOwnerTestCheckoutEnabled(enabledFlag)) {
    return { allowed: false, reason: 'flag_disabled' };
  }
  if (!isOwnerTestEmailAllowed(email, allowEmails)) {
    return { allowed: false, reason: 'email_not_allowlisted' };
  }
  return { allowed: true };
}
