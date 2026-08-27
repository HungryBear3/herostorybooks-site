/**
 * Consent resolution for ad-platform measurement. Fails closed.
 *
 * THE SOURCE OF TRUTH IS ./consent-store.ts. That module owns the stored
 * choice, notifies subscribers, and mirrors the current state onto the global
 * this file reads. `resolveConsent` remains the read-only accessor that
 * pre-existing consumers (notably the Meta pixel controller) already call, so
 * they did not need to change.
 *
 * HISTORY, BECAUSE THE PREVIOUS COMMENT HERE IS NOW WRONG. When this module was
 * written the repository genuinely had no consent mechanism: GA4 loaded
 * unconditionally in production and nothing ever set the global, which meant
 * the Meta pixel could never fire. That is no longer true. There is now a real
 * consent surface, GA4 and Vercel Analytics do not load at all before a grant,
 * and every browser destination is gated on this one state.
 *
 * The rule this module enforces is unchanged and still the important one:
 * 'unknown' is not consent. Only an explicit 'granted' enables anything.
 *
 * Pure and isomorphic apart from one optional read of a documented global.
 */

export type ConsentState = 'granted' | 'denied' | 'unknown';

/**
 * The single documented consent signal this module will read: a global set by
 * a future consent surface. Anything else — a cookie, a query parameter, a
 * localStorage key — is deliberately not honoured, because a consent signal
 * that can be set from a URL is not consent.
 */
export const CONSENT_GLOBAL_KEY = 'hsbMarketingConsent';

export interface ConsentCarrier {
  [CONSENT_GLOBAL_KEY]?: unknown;
}

/** Normalise an arbitrary value into a consent state. Unknown by default. */
export function normalizeConsent(raw: unknown): ConsentState {
  if (raw === 'granted' || raw === 'denied') return raw;
  return 'unknown';
}

/**
 * Resolve the current consent state.
 *
 * @param carrier defaults to `globalThis` so callers can inject a fake in tests
 *                without touching real globals.
 */
export function resolveConsent(carrier?: ConsentCarrier): ConsentState {
  const source = carrier ?? (typeof globalThis === 'undefined' ? undefined : (globalThis as ConsentCarrier));
  if (!source) return 'unknown';
  try {
    return normalizeConsent(source[CONSENT_GLOBAL_KEY]);
  } catch {
    // A getter that throws is not a grant.
    return 'unknown';
  }
}

/** Only an explicit grant enables an ad platform. Absent and unknown do not. */
export function isMarketingConsentGranted(state: ConsentState): boolean {
  return state === 'granted';
}
