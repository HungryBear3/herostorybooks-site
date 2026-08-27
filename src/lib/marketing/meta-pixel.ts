/**
 * Privacy-safe Meta Pixel candidate — browser side.
 *
 * DISABLED BY DEFAULT AND BY CONSTRUCTION. The controller below produces zero
 * script loads, zero network calls, and zero events unless ALL of these hold:
 *
 *   1. NEXT_PUBLIC_META_PIXEL_ID is present and numeric-shaped,
 *   2. NEXT_PUBLIC_META_PIXEL_ENABLED === 'true',
 *   3. resolveConsent() === 'granted'  (see ./consent-store.ts, the shared
 *      surface that governs GA4, Vercel Analytics, and Meta together; default
 *      is 'unknown', which fails closed),
 *   4. the current route sanitises to one of META_TRACKABLE_ROUTES.
 *
 * Condition 4 gates the SCRIPT, not just the event. That is deliberate: the
 * mount lives in the root layout, and /family-review/* is served with
 * `Content-Security-Policy: default-src 'self'` by middleware.ts. Loading a
 * third-party script there would be a CSP violation even though the browser
 * would block it. Nothing is requested on a route we are not allowed to track.
 *
 * All I/O goes through an injected adapter, so tests drive this with a mock and
 * never touch connect.facebook.net.
 */

import { resolveConsent, isMarketingConsentGranted, type ConsentState } from './consent.ts';
import {
  filterBrowserParams,
  isAllowlistedBrowserEvent,
  assertNoBlockedFields,
  HSB_EVENT_TO_META_BROWSER,
  type MetaBrowserEvent,
} from './event-contract.ts';
import { metaRouteFor } from './route-sanitizer.ts';

/** Public, browser-safe. Never a token, never a secret. */
export const META_PIXEL_ID_ENV = 'NEXT_PUBLIC_META_PIXEL_ID';
export const META_PIXEL_FLAG_ENV = 'NEXT_PUBLIC_META_PIXEL_ENABLED';

/** Meta pixel ids are numeric. Anything else is a misconfiguration, not an id. */
const PIXEL_ID_RE = /^\d{8,20}$/;

export type MetaSkipReason =
  | 'no_pixel_id'
  | 'flag_off'
  | 'consent_not_granted'
  | 'route_not_trackable'
  | 'duplicate_route'
  | 'event_not_mapped'
  | 'event_not_allowlisted'
  | 'not_initialized'
  | 'blocked_payload';

export type MetaPixelOutcome =
  | { status: 'skipped'; reason: MetaSkipReason }
  | { status: 'tracked'; event: MetaBrowserEvent; route: string; params: Record<string, string | number> };

export interface MetaPixelAdapter {
  /** Inject the Meta base script. Called at most once per page load. */
  load(pixelId: string): void;
  /** fbq('init', pixelId). Called at most once per page load. */
  init(pixelId: string): void;
  /** fbq('track', event, params). Only allowlisted events reach here. */
  track(event: MetaBrowserEvent, params: Record<string, string | number>): void;
}

export interface MetaPixelEnv {
  [META_PIXEL_ID_ENV]?: string;
  [META_PIXEL_FLAG_ENV]?: string;
}

/**
 * Optional-field result rather than a discriminated union: this project
 * compiles with `strict: false`, where a boolean literal discriminant does not
 * narrow, so a union would make `settings.reason` a type error.
 */
export interface MetaPixelSettings {
  enabled: boolean;
  pixelId?: string;
  reason?: 'no_pixel_id' | 'flag_off';
}

/**
 * Resolve configuration from environment alone. Consent and route are checked
 * separately so a caller can tell "not configured" from "configured but not
 * permitted", which matters when reading a Preview validation report.
 */
export function resolveMetaPixelSettings(env: MetaPixelEnv = {}): MetaPixelSettings {
  const pixelId = (env[META_PIXEL_ID_ENV] ?? '').trim();
  if (!PIXEL_ID_RE.test(pixelId)) return { enabled: false, reason: 'no_pixel_id' };
  if (env[META_PIXEL_FLAG_ENV] !== 'true') return { enabled: false, reason: 'flag_off' };
  return { enabled: true, pixelId };
}

export interface MetaPixelControllerOptions {
  adapter: MetaPixelAdapter;
  env?: MetaPixelEnv;
  /** Injected so tests never mutate a real global. */
  consent?: () => ConsentState;
}

export interface MetaPixelController {
  /** Handle an initial mount or an SPA navigation. */
  handleRoute(rawPath: string): MetaPixelOutcome;
  /** Handle one HSB funnel event emitted by src/lib/analytics.ts. */
  handleHsbEvent(hsbEvent: string, props?: Record<string, unknown>): MetaPixelOutcome;
  /** Inspection surface for tests and DevTools. Never sent anywhere. */
  readonly debug: { initialized: boolean; scriptLoaded: boolean; lastRoute: string | null };
}

export function createMetaPixelController(options: MetaPixelControllerOptions): MetaPixelController {
  const { adapter } = options;
  const env = options.env ?? {};
  const readConsent = options.consent ?? (() => resolveConsent());

  let initialized = false;
  let scriptLoaded = false;
  let lastRoute: string | null = null;

  /**
   * Gate order matters, and it is the same on both entry points: configuration,
   * then consent, then route. The cheapest and least sensitive check runs first,
   * and no route information is computed at all for a visitor who has not
   * consented — so a skip reason never reveals more than the reason above it.
   */
  function configAndConsent(): { ok: boolean; pixelId?: string; reason?: MetaSkipReason } {
    const settings = resolveMetaPixelSettings(env);
    if (!settings.enabled) return { ok: false, reason: settings.reason };
    if (!isMarketingConsentGranted(readConsent())) return { ok: false, reason: 'consent_not_granted' };
    return { ok: true, pixelId: settings.pixelId };
  }

  function ensureInitialized(pixelId: string): void {
    if (!scriptLoaded) {
      adapter.load(pixelId);
      scriptLoaded = true;
    }
    if (!initialized) {
      adapter.init(pixelId);
      initialized = true;
    }
  }

  function emit(event: MetaBrowserEvent, route: string, params: Record<string, string | number>): MetaPixelOutcome {
    try {
      assertNoBlockedFields(params);
    } catch {
      return { status: 'skipped', reason: 'blocked_payload' };
    }
    adapter.track(event, params);
    return { status: 'tracked', event, route, params };
  }

  return {
    handleRoute(rawPath: string): MetaPixelOutcome {
      const decision = configAndConsent();
      if (!decision.ok) return { status: 'skipped', reason: decision.reason };
      const route = metaRouteFor(rawPath);
      if (route === null) return { status: 'skipped', reason: 'route_not_trackable' };

      // One PageView per route transition. The latch also absorbs React
      // StrictMode's double effect and any re-render that reports the same
      // pathname, so the initial page view cannot be sent twice.
      if (lastRoute === route) return { status: 'skipped', reason: 'duplicate_route' };

      ensureInitialized(decision.pixelId);
      lastRoute = route;
      return emit('PageView', route, {});
    },

    handleHsbEvent(hsbEvent: string, props: Record<string, unknown> = {}): MetaPixelOutcome {
      const mapped = HSB_EVENT_TO_META_BROWSER[hsbEvent];
      if (!mapped) return { status: 'skipped', reason: 'event_not_mapped' };
      if (!isAllowlistedBrowserEvent(mapped)) return { status: 'skipped', reason: 'event_not_allowlisted' };

      const decision = configAndConsent();
      if (!decision.ok) return { status: 'skipped', reason: decision.reason };

      // A funnel event carries no route of its own; it belongs to the route the
      // visitor is on, which handleRoute has already vetted and latched. With no
      // latched route there is no vetted route, and an empty path must never be
      // allowed to normalise into the homepage.
      if (lastRoute === null) return { status: 'skipped', reason: 'route_not_trackable' };
      if (!initialized) return { status: 'skipped', reason: 'not_initialized' };

      const { params } = filterBrowserParams(mapped, props);
      return emit(mapped, lastRoute, params);
    },

    get debug() {
      return { initialized, scriptLoaded, lastRoute };
    },
  };
}

/**
 * The only place that speaks to the real Meta runtime. Kept tiny and separate
 * so every test injects a mock instead. `fbq` is created by Meta's base code;
 * we do not reimplement its queue, and we never expose an arbitrary passthrough
 * — there is no `fbq(...anything)` escape hatch anywhere in this module.
 */
export function createBrowserFbqAdapter(): MetaPixelAdapter {
  type Fbq = ((...args: unknown[]) => void) & { queue?: unknown[]; callMethod?: (...args: unknown[]) => void; push?: unknown; loaded?: boolean; version?: string };
  const scope = globalThis as unknown as { fbq?: Fbq; _fbq?: Fbq; document?: Document };

  function ensureStub(): Fbq {
    if (scope.fbq) return scope.fbq;
    const stub = function (...args: unknown[]) {
      if (stub.callMethod) stub.callMethod(...args);
      else (stub.queue as unknown[]).push(args);
    } as Fbq;
    stub.queue = [];
    stub.push = stub;
    stub.loaded = true;
    stub.version = '2.0';
    scope.fbq = stub;
    scope._fbq = stub;
    return stub;
  }

  return {
    load(): void {
      ensureStub();
      const doc = scope.document;
      if (!doc) return;
      if (doc.getElementById('hsb-meta-pixel')) return;
      const script = doc.createElement('script');
      script.id = 'hsb-meta-pixel';
      script.async = true;
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      doc.head.appendChild(script);
    },
    init(pixelId: string): void {
      ensureStub()('init', pixelId);
    },
    track(event: MetaBrowserEvent, params: Record<string, string | number>): void {
      const fbq = ensureStub();
      if (Object.keys(params).length === 0) fbq('track', event);
      else fbq('track', event, params);
    },
  };
}
