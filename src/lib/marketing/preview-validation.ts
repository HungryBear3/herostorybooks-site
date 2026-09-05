/**
 * Preview-only analytics validation switch. Fail-closed, inert by default.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 *
 * GA4 and Vercel Analytics are production-only, so an ordinary Preview
 * deployment cannot exercise the real consent → readiness → PageView lifecycle
 * at all. Reviewing that lifecycle by reading the code is not the same as
 * watching it run. This switch lets a Preview deployment mount the real
 * adapters against a THROWAWAY GA4 property, so the sequence can be observed
 * before anything reaches Production.
 *
 * ── WHAT IT CANNOT DO ────────────────────────────────────────────────────────
 *
 *  - It cannot override consent. Preview mode changes which measurement id is
 *    used and whether the adapters may mount at all; the consent gate is
 *    evaluated exactly as it is in Production, which is the entire point of
 *    validating there.
 *  - It cannot operate outside Preview. `VERCEL_ENV` must be exactly
 *    `'preview'`. On Production or on a local build the flag is ignored.
 *  - It cannot use the Production property. The preview measurement id must be
 *    present AND different from the Production id, or Preview validation stays
 *    off. A missing or colliding id disables the mode rather than falling back.
 *  - It carries no secret. Both variables are public by construction: a GA4
 *    measurement id is not a credential, and neither value is an access token.
 *    Nothing here reads or needs `GA4_API_SECRET`, which is server-only and
 *    belongs to the trusted Measurement Protocol purchase path.
 *
 * ── ENVIRONMENT VARIABLE NAMES ONLY ──────────────────────────────────────────
 *
 *     NEXT_PUBLIC_HSB_ANALYTICS_PREVIEW_VALIDATION   'true' to arm; absent = inert
 *     NEXT_PUBLIC_HSB_PREVIEW_GA_MEASUREMENT_ID      throwaway GA4 property id
 *
 * Neither is configured by this change. Setting them is a separate, approved
 * operator action — see docs/marketing/attribution-event-contract.md.
 */

export const PREVIEW_VALIDATION_FLAG_ENV = 'NEXT_PUBLIC_HSB_ANALYTICS_PREVIEW_VALIDATION';
export const PREVIEW_MEASUREMENT_ID_ENV = 'NEXT_PUBLIC_HSB_PREVIEW_GA_MEASUREMENT_ID';

export type AnalyticsMode = 'production' | 'preview_validation' | 'disabled';

export interface AnalyticsModeResult {
  mode: AnalyticsMode;
  /** The measurement id to use, or null when nothing may mount. */
  measurementId: string | null;
  /** Machine-readable reason when the mode is 'disabled'. */
  reason?:
    | 'not_a_measured_environment'
    | 'preview_flag_absent'
    | 'preview_id_missing'
    | 'preview_id_collides_with_production';
}

/** A GA4 measurement id shape. Not a secret, but it should still be an id. */
const MEASUREMENT_ID_RE = /^G-[A-Z0-9]{4,20}$/;

/**
 * Decide what may mount, from environment alone. Pure: no globals, no consent.
 *
 * Consent is applied separately and afterwards by the component. This function
 * answers only "is there a property we are allowed to measure into at all?".
 */
export function resolveAnalyticsMode(args: {
  vercelEnv: string | undefined;
  productionMeasurementId: string;
  previewFlag: string | undefined;
  previewMeasurementId: string | undefined;
}): AnalyticsModeResult {
  if (args.vercelEnv === 'production') {
    return { mode: 'production', measurementId: args.productionMeasurementId };
  }

  if (args.vercelEnv !== 'preview') {
    // Local, development, CI, and anything unrecognised measure nothing.
    return { mode: 'disabled', measurementId: null, reason: 'not_a_measured_environment' };
  }

  if (args.previewFlag !== 'true') {
    return { mode: 'disabled', measurementId: null, reason: 'preview_flag_absent' };
  }

  const previewId = (args.previewMeasurementId ?? '').trim();
  if (!MEASUREMENT_ID_RE.test(previewId)) {
    return { mode: 'disabled', measurementId: null, reason: 'preview_id_missing' };
  }
  if (previewId === args.productionMeasurementId) {
    // The one mistake this mode must never make.
    return {
      mode: 'disabled',
      measurementId: null,
      reason: 'preview_id_collides_with_production',
    };
  }

  return { mode: 'preview_validation', measurementId: previewId };
}
