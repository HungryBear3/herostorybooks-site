/**
 * The one process-wide seam between HSB's existing analytics layer and the Meta
 * Pixel candidate.
 *
 * Why a bridge rather than call sites: `src/lib/analytics.ts` `track()` is
 * already the single choke point every funnel event passes through, and
 * `src/app/checkout/checkout-form.tsx` already fires `begin_checkout` there. A
 * bridge means the Meta InitiateCheckout signal is derived from the exact same
 * emission GA4 sees, so the two cannot drift, and it means the checkout form —
 * a launch-safety file — does not need to learn about ad platforms.
 *
 * Everything here is defensive: it no-ops on the server, it swallows its own
 * failures, and it returns a reason so tests can assert the no-op rather than
 * infer it from silence.
 */

import {
  createBrowserFbqAdapter,
  createMetaPixelController,
  META_PIXEL_FLAG_ENV,
  META_PIXEL_ID_ENV,
  resolveMetaPixelSettings,
  type MetaPixelController,
  type MetaPixelOutcome,
} from './meta-pixel.ts';

/**
 * Read as two separate static member expressions so Next's build-time
 * substitution of NEXT_PUBLIC_* actually happens. A computed lookup
 * (`process.env[NAME]`) would not be inlined and would be undefined in the
 * browser bundle.
 */
function readEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined' || !process.env) return {};
  return {
    [META_PIXEL_ID_ENV]: process.env.NEXT_PUBLIC_META_PIXEL_ID,
    [META_PIXEL_FLAG_ENV]: process.env.NEXT_PUBLIC_META_PIXEL_ENABLED,
  };
}

let controller: MetaPixelController | null = null;

/**
 * Lazily build the controller, and only in a browser that is configured for
 * Meta at all. On the server, and on any deployment without the pixel id and
 * flag, this returns null and no adapter is ever constructed.
 */
export function getMetaPixelController(): MetaPixelController | null {
  if (typeof window === 'undefined') return null;
  if (controller) return controller;
  const env = readEnv();
  if (!resolveMetaPixelSettings(env).enabled) return null;
  controller = createMetaPixelController({ adapter: createBrowserFbqAdapter(), env });
  return controller;
}

const SERVER_OUTCOME: MetaPixelOutcome = { status: 'skipped', reason: 'no_pixel_id' };

/** Called by the root-layout mount on first paint and on every SPA navigation. */
export function metaHandleRoute(pathname: string): MetaPixelOutcome {
  try {
    return getMetaPixelController()?.handleRoute(pathname) ?? SERVER_OUTCOME;
  } catch {
    return SERVER_OUTCOME;
  }
}

/**
 * The only parameters HSB attaches to a mapped funnel event. Two constants, not
 * a projection of the live event record: the record carries theme names, photo
 * and voice booleans, family-character counts, and URL-prefill hints, and none
 * of that belongs on an ad platform. The controller re-filters this against the
 * contract allowlist anyway, so both layers have to fail for anything to leak.
 */
export const META_FUNNEL_PARAMS = Object.freeze({
  content_type: 'product',
  content_category: 'storybook',
});

/**
 * Called by src/lib/analytics.ts for every HSB funnel event. The caller's event
 * NAME selects the mapping; the caller's event PROPS are deliberately not
 * forwarded.
 */
export function metaHandleHsbEvent(hsbEvent: string): MetaPixelOutcome {
  try {
    return getMetaPixelController()?.handleHsbEvent(hsbEvent, { ...META_FUNNEL_PARAMS }) ?? SERVER_OUTCOME;
  } catch {
    return SERVER_OUTCOME;
  }
}

/** Test-only reset. Not referenced by product code. */
export function __resetMetaBridgeForTests(): void {
  controller = null;
}
