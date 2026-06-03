// Thin analytics shim. Calls window.gtag if it's loaded; otherwise no-ops.
// Also forwards to Vercel Analytics if available, so the A/B test isn't dark
// when GA isn't wired yet.
import type { CoverVariant } from './cover-variant';

type GtagFn = (command: string, eventName: string, params?: Record<string, unknown>) => void;

declare global {
  interface Window {
    gtag?: GtagFn;
    // Vercel Analytics drops this at runtime when @vercel/analytics is installed.
    va?: (action: 'track', name: string, props?: Record<string, unknown>) => void;
  }
}

export type CoverEventName =
  | 'cover_variant_shown'
  | 'preview_click'
  | 'premium_select'
  | 'checkout_start';

export function trackCoverEvent(name: CoverEventName, params: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, params);
    }
    if (typeof window.va === 'function') {
      window.va('track', name, params);
    }
  } catch {
    /* never let analytics throw into the UI */
  }
}

export function trackVariantShown(variant: CoverVariant, page: string) {
  trackCoverEvent('cover_variant_shown', { variant, page });
}

export function trackPreviewClick(variant: CoverVariant, extra: Record<string, unknown> = {}) {
  trackCoverEvent('preview_click', { variant, ...extra });
}

export function trackPremiumSelect(variant: CoverVariant) {
  trackCoverEvent('premium_select', { variant });
}

export function trackCheckoutStart(variant: CoverVariant) {
  trackCoverEvent('checkout_start', { variant });
}

// ── Generic HSB event layer ────────────────────────────────────────────────
//
// Why this lives alongside the cover-variant helpers: the cover-variant ones
// gate on window.gtag / window.va (Google + Vercel Analytics). This lower-level
// layer records every funnel event locally and forwards to Vercel Analytics
// when the runtime is mounted:
//
//   - pushes to `window.dataLayer` (GTM convention; when GTM is wired in
//     later, every queued event flushes automatically),
//   - pushes to `window.hsbEvents` (in-memory buffer; inspectable from
//     DevTools and Playwright tests),
//   - forwards to Vercel Analytics when `window.va` is present,
//   - attaches campaign params (`utm_*`, `ref`) from the current URL,
//   - console-logs in non-production OR when
//     NEXT_PUBLIC_HSB_ANALYTICS_DEBUG=true,
//   - silently no-ops on the server,
//   - never throws.

export type HsbEventName =
  | 'page_view'
  | 'name_preview_submitted'
  | 'start_checkout'
  | 'format_selected'
  | 'story_selected'
  | 'order_submit_attempt'
  // Aliased name kept for the brief's "purchase_intent" terminology;
  // emitted alongside order_submit_attempt for downstream flexibility.
  | 'purchase_intent';

export interface HsbEventRecord {
  event: HsbEventName;
  timestamp: number;
  href?: string;
  pathname?: string;
  [k: string]: string | number | boolean | null | undefined;
}

const campaignParamKeys = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
] as const;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    hsbEvents?: HsbEventRecord[];
  }
}

function currentCampaignParams(): Partial<Record<(typeof campaignParamKeys)[number], string>> {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const campaignParams: Partial<Record<(typeof campaignParamKeys)[number], string>> = {};
  for (const key of campaignParamKeys) {
    const value = params.get(key);
    if (value) campaignParams[key] = value.slice(0, 160);
  }
  return campaignParams;
}

function vercelSafeProps(
  record: HsbEventRecord,
): Record<string, string | number | boolean | null | undefined> {
  const { event: _event, href: _href, ...props } = record;
  return props;
}

function hsbAnalyticsIsDev(): boolean {
  if (typeof process === 'undefined') return false;
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.NEXT_PUBLIC_HSB_ANALYTICS_DEBUG === 'true';
}

/**
 * Push an HSB event. Safe to call anywhere (server, client, missing
 * globals). Returns the pushed record or null on the server.
 */
export function track(
  event: HsbEventName,
  props: Record<string, string | number | boolean | null | undefined> = {},
): HsbEventRecord | null {
  if (typeof window === 'undefined') return null;
  const record: HsbEventRecord = {
    event,
    timestamp: Date.now(),
    href: typeof window.location !== 'undefined' ? window.location.href : undefined,
    pathname:
      typeof window.location !== 'undefined' ? window.location.pathname : undefined,
    ...currentCampaignParams(),
    ...props,
  };
  try {
    window.dataLayer = window.dataLayer ?? [];
    window.dataLayer.push(record);
    window.hsbEvents = window.hsbEvents ?? [];
    window.hsbEvents.push(record);
    if (typeof window.va === 'function') {
      window.va('track', event, vercelSafeProps(record));
    }
  } catch {
    /* never throw from analytics */
  }
  if (hsbAnalyticsIsDev()) {
    // eslint-disable-next-line no-console
    console.info(`[hsb-analytics] ${event}`, props);
  }
  return record;
}

export function trackPageView(pathname?: string): void {
  track('page_view', pathname ? { pathname } : {});
}
