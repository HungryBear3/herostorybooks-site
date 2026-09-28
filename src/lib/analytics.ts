// Thin analytics shim. Calls window.gtag if it's loaded; otherwise no-ops.
// Also forwards to Vercel Analytics if available, so the A/B test isn't dark
// when GA isn't wired yet.
import type { CoverVariant } from './cover-variant';
import { sanitizeAnalyticsPath, sanitizeAnalyticsUrl } from './analytics-path.ts';
import { track as trackVercelEvent } from '@vercel/analytics';
import { currentBrowserCampaignParams } from './attribution-contract.ts';

type GtagFn = {
  (command: 'config' | 'event', target: string, params?: Record<string, unknown>): void;
  (command: 'js', target: Date): void;
  (command: 'set', params: Record<string, unknown>): void;
};

declare global {
  interface Window {
    gtag?: GtagFn;
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
    const eventParams = governedProps(params);
    if (typeof window.gtag === 'function') {
      window.gtag('event', name, googleSafeProps(eventParams));
    }
    trackVercelEvent(name, vercelSafeProps(eventParams));
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
// Why this lives alongside the cover-variant helpers: both paths forward to
// Google Analytics when gtag is available and to Vercel Analytics through its
// official client helper. This lower-level layer records every funnel event
// locally and forwards it when the runtime is mounted:
//
//   - pushes to `window.hsbEvents` (in-memory buffer; inspectable from
//     DevTools and Playwright tests),
//   - calls gtag exactly once instead of also pushing a GTM-style event object,
//   - forwards through the official Vercel Analytics `track` helper,
//   - attaches only governed campaign fields from the attribution contract,
//   - console-logs in non-production OR when
//     NEXT_PUBLIC_HSB_ANALYTICS_DEBUG=true,
//   - silently no-ops on the server,
//   - never throws.

export type HsbEventName =
  | 'page_view'
  | 'name_preview_submitted'
  | 'begin_checkout'
  | 'start_checkout'
  | 'format_selected'
  | 'story_selected'
  | 'order_submit_attempt'
  // Aliased name kept for the brief's "purchase_intent" terminology;
  // emitted alongside order_submit_attempt for downstream flexibility.
  | 'purchase_intent'
  // Five-step checkout funnel (src/lib/checkout-step-telemetry.ts).
  | 'checkout_step_view'
  | 'checkout_step_complete'
  | 'checkout_step_blocked'
  | 'proof_approved';

export interface HsbEventRecord {
  event: HsbEventName;
  timestamp: number;
  href?: string;
  pathname?: string;
  [k: string]: string | number | boolean | null | undefined;
}

declare global {
  interface Window {
    hsbEvents?: HsbEventRecord[];
  }
}

type CampaignParams = ReturnType<typeof currentBrowserCampaignParams>;

/** Campaign and referrer props from callers are never attribution authority. */
function governedProps(input: Record<string, unknown>): Record<string, unknown> {
  const props = Object.fromEntries(Object.entries(input).filter(([key]) =>
    !/^(?:utm_|campaign_|ref$|referrer$|page_referrer$|query$|search$)/i.test(key)));
  return { ...props, ...currentBrowserCampaignParams() };
}

function googleCampaignFields(campaign: CampaignParams): Record<string, string> {
  // Complete event-scoped overrides prevent inheritance from earlier campaigns.
  return {
    campaign_source: campaign.utm_source ?? '',
    campaign_medium: campaign.utm_medium ?? '',
    campaign_name: campaign.utm_campaign ?? '',
    campaign_content: campaign.utm_content ?? '',
  };
}

type VercelAnalyticsProps = Record<string, string | number | boolean | null>;

function vercelSafeProps(input: Record<string, unknown>): VercelAnalyticsProps {
  const props: VercelAnalyticsProps = {};
  for (const [key, value] of Object.entries(governedProps(input))) {
    if (key === 'event' || key === 'href' || value === undefined) continue;
    if (value === null) {
      props[key] = null;
      continue;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      props[key] = value;
    }
  }
  return props;
}

function sanitizedPageLocation(): string | undefined {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return undefined;
  return `${window.location.origin ?? ''}${sanitizeAnalyticsPath(window.location.pathname ?? '')}`;
}

const unwantedReferralHosts = new Set(['checkout.stripe.com']);

export function isUnwantedReferral(referrer: string): boolean {
  if (!referrer) return false;
  try {
    return unwantedReferralHosts.has(new URL(referrer).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Cookie values are browser- and third-party-controlled. A truncated or
 * otherwise malformed percent escape makes `decodeURIComponent` throw
 * `URIError`. Checkout reads cookies while building the order payload, so an
 * uncaught throw here aborts the submit before any request leaves the browser
 * and the customer sees a failure with no server-side trace. An undecodable
 * cookie is treated as absent.
 */
export function safeDecodeCookieValue(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

export function currentGaClientId(): string | null {
  if (typeof document === 'undefined') return null;
  const gaCookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('_ga='));
  if (!gaCookie) return null;
  const value = safeDecodeCookieValue(gaCookie.slice(4));
  const match = value.match(/^GA\d+\.\d+\.(\d+\.\d+)$/);
  return match?.[1] ?? null;
}

function sanitizedPageReferrer(): string {
  if (typeof document === 'undefined' || !document.referrer) return '';
  try {
    const referrer = new URL(document.referrer);
    if (isUnwantedReferral(referrer.href)) return '';
    return referrer.origin;
  } catch {
    return '';
  }
}

function googleSafeProps(input: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = {
    ...vercelSafeProps(input),
    ...googleCampaignFields(currentBrowserCampaignParams()),
  };
  const pageLocation = sanitizedPageLocation();
  if (pageLocation) props.page_location = pageLocation;
  props.page_referrer = sanitizedPageReferrer();
  if (typeof document !== 'undefined' && isUnwantedReferral(document.referrer)) {
    props.ignore_referrer = true;
  }
  return props;
}

function hsbAnalyticsIsDev(): boolean {
  if (typeof process === 'undefined') return false;
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.NEXT_PUBLIC_HSB_ANALYTICS_DEBUG === 'true';
}

/**
 * The GA4 `purchase` is written only by the signed Stripe webhook after a
 * durable settlement (src/lib/purchase-analytics.ts). A browser or success page
 * can be reloaded, replayed, or reached without paying, so the browser layer
 * refuses the name outright rather than trusting every caller's types.
 */
function isServerOnlyEvent(event: unknown): boolean {
  return typeof event === 'string' && event.trim().toLowerCase() === 'purchase';
}

/**
 * Push an HSB event. Safe to call anywhere (server, client, missing
 * globals). Returns the pushed record, or null on the server and for a
 * server-only event name.
 */
export function track(
  event: HsbEventName,
  props: Record<string, string | number | boolean | null | undefined> = {},
): HsbEventRecord | null {
  if (typeof window === 'undefined' || isServerOnlyEvent(event)) return null;
  const pathname =
    typeof window.location !== 'undefined'
      ? sanitizeAnalyticsPath(window.location.pathname ?? '')
      : undefined;
  const record: HsbEventRecord = {
    event,
    timestamp: Date.now(),
    href:
      typeof window.location !== 'undefined'
        ? `${window.location.origin ?? ''}${pathname ?? ''}`
        : undefined,
    pathname,
    ...governedProps(props),
  };
  // A caller-supplied pathname (AnalyticsPageView forwards usePathname()) lands
  // after the spread, so the merged values get sanitized rather than only the
  // defaults above.
  if (typeof record.pathname === 'string') {
    record.pathname = sanitizeAnalyticsPath(record.pathname);
  }
  if (typeof record.href === 'string') {
    record.href = sanitizeAnalyticsUrl(record.href);
  }
  try {
    window.hsbEvents = window.hsbEvents ?? [];
    window.hsbEvents.push(record);
    if (typeof window.gtag === 'function') {
      window.gtag('event', event, googleSafeProps(record));
    }
    if (event !== 'page_view') {
      trackVercelEvent(event, vercelSafeProps(record));
    }
  } catch {
    /* never throw from analytics */
  }
  if (hsbAnalyticsIsDev()) {
    // eslint-disable-next-line no-console
    console.info(`[hsb-analytics] ${event}`, record);
  }
  return record;
}

export function trackPageView(pathname?: string): void {
  track('page_view', pathname ? { pathname } : {});
}
