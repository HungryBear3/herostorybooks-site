// Checkout access gate — DEFAULT-CLOSED.
//
// Controlled owner-test posture: checkout is refused unless BOTH conditions
// hold, so an accidental public / creator / gifting visitor cannot be charged
// before the proof/email/fulfillment gates are proven:
//
//   1. HSB_OWNER_TEST_CHECKOUT_ENABLED === 'true'  (global explicit enable)
//   2. the buyer email is on HSB_OWNER_TEST_EMAILS  (comma-separated,
//      case-insensitive, trimmed)
//
// Public checkout posture: checkout is opened to all syntactically-valid buyer
// emails only when HSB_PUBLIC_CHECKOUT_ENABLED === 'true'. Checkout pause,
// checkout_pause kill switch, durable photo persistence, proof release hold,
// proof QA, and print-go gates still apply downstream. With NO env set the gate
// is CLOSED. The customer-facing response never reveals the flag state or the
// allowlist — the refusal reason is internal only.

export const OWNER_TEST_GATE_CODE = 'owner_test_gate_closed';

export const OWNER_TEST_GATE_MESSAGE =
  'Checkout is currently limited to the HeroStoryBooks internal owner-test group. ' +
  'If you believe you should have access, contact support@herostorybooks.com.';

export type OwnerTestGateRefusal = 'public_flag_disabled' | 'flag_disabled' | 'email_not_allowlisted';

export type OwnerTestGateResult =
  | { allowed: true; mode: 'public' | 'owner_test' }
  | { allowed: false; reason: OwnerTestGateRefusal };

/** Public checkout enable flag. Only the exact string 'true' (whitespace/case
 *  tolerant for Vercel-pulled values) opens checkout to non-allowlisted buyers;
 *  everything else — including unset — falls back to the owner-test gate. */
export function isPublicCheckoutEnabled(
  value = process.env.HSB_PUBLIC_CHECKOUT_ENABLED,
): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** Global owner-test enable flag. Only the exact string 'true' (whitespace/case
 *  tolerant for Vercel-pulled values) enables; everything else — including unset
 *  — leaves the owner-test path closed. */
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
 * Combined default-closed decision. Public checkout, when explicitly enabled,
 * takes precedence over owner-test allowlisting. Otherwise the owner-test flag
 * is checked first so a probe with an unknown email cannot distinguish "flag
 * off" from "not allowlisted" beyond the internal reason (which is never
 * returned to the customer).
 */
export function evaluateOwnerTestGate(
  email: string,
  env: { publicFlag?: string; enabledFlag?: string; allowEmails?: string } = {},
): OwnerTestGateResult {
  const publicFlag = 'publicFlag' in env ? env.publicFlag : process.env.HSB_PUBLIC_CHECKOUT_ENABLED;
  const enabledFlag = 'enabledFlag' in env ? env.enabledFlag : process.env.HSB_OWNER_TEST_CHECKOUT_ENABLED;
  const allowEmails = 'allowEmails' in env ? env.allowEmails : process.env.HSB_OWNER_TEST_EMAILS;

  if (isPublicCheckoutEnabled(publicFlag)) {
    return { allowed: true, mode: 'public' };
  }
  if (!isOwnerTestCheckoutEnabled(enabledFlag)) {
    return { allowed: false, reason: 'flag_disabled' };
  }
  if (!isOwnerTestEmailAllowed(email, allowEmails)) {
    return { allowed: false, reason: 'email_not_allowlisted' };
  }
  return { allowed: true, mode: 'owner_test' };
}
