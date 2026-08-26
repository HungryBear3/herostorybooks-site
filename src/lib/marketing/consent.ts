/**
 * Consent resolution for ad-platform measurement. Fails closed.
 *
 * SOURCE TRUTH, STATED PLAINLY. This repository has no consent mechanism. There
 * is no cookie banner, no consent cookie, no consent state, and no Google
 * Consent Mode call anywhere in src/. GA4 today loads unconditionally whenever
 * `process.env.VERCEL_ENV === 'production'` (src/app/layout.tsx), and
 * `src/lib/ga4-purchase.ts` sends server purchases with no consent check.
 *
 * That is a description of what exists, not an endorsement. This module does
 * not change GA4's behaviour — touching the live GA4 consent posture is an
 * owner decision, not a side effect of adding a Meta candidate.
 *
 * What it does do is refuse to let a NEW ad-platform surface inherit that
 * posture. `resolveConsent` returns 'unknown' unless a consent decision is
 * explicitly published, and only 'granted' enables Meta. The practical
 * consequence, stated so nobody discovers it in production: **with no consent
 * surface in the repo, the Meta pixel cannot fire, even with the pixel id and
 * the feature flag both set.** Shipping the consent surface is a prerequisite
 * for any Meta test-event validation, and it is tracked as an open blocker in
 * docs/marketing/meta-measurement-candidate.md.
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
