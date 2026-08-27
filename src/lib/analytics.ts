// Thin analytics shim. Calls window.gtag if it's loaded; otherwise no-ops.
// Also forwards to Vercel Analytics if available, so the A/B test isn't dark
// when GA isn't wired yet.
import type { CoverVariant } from './cover-variant';
import { track as trackVercelEvent } from '@vercel/analytics';
import { metaHandleHsbEvent } from './marketing/meta-bridge.ts';
import { getConsent } from './marketing/consent-store.ts';
import {
  attributionMetadata,
  currentAttribution,
} from './marketing/attribution-session.ts';
import { sanitizeRoute } from './marketing/route-sanitizer.ts';
import { isMarketingConsentGranted } from './marketing/consent.ts';

/**
 * Optional browser measurement is off until the visitor explicitly grants it.
 *
 * This governs the THREE outbound browser destinations -- GA4 (gtag), Vercel
 * Analytics, and the Meta candidate -- from one source of truth, so they cannot
 * drift apart. The in-memory `window.hsbEvents` buffer is deliberately still
 * populated: it never leaves the tab, it carries no identifier, and it is what
 * makes the funnel inspectable in DevTools and assertable in Playwright without
 * turning on any transmission.
 *
 * Essential behaviour and the trusted server-side Stripe purchase path do not
 * consult this.
 */
function optionalAnalyticsAllowed(): boolean {
  try {
    return isMarketingConsentGranted(getConsent());
  } catch {
    return false;
  }
}

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
  if (!optionalAnalyticsAllowed()) return;
  try {
    const campaignParams = currentCampaignParams();
    const eventParams = { ...campaignParams, ...params };
    if (typeof window.gtag === 'function') {
      const googleCampaign = googleCampaignFields(campaignParams);
      if (Object.keys(googleCampaign).length) window.gtag('set', googleCampaign);
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
//   - attaches campaign params (`utm_*`, `ref`) from the current URL,
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
  | 'proof_approved';

declare global {
  interface Window {
    /** In-memory funnel buffer. Never transmitted; inspectable in DevTools. */
    hsbEvents?: HsbEventRecord[];
  }
}

export interface HsbEventRecord {
  event: HsbEventName;
  timestamp: number;
  href?: string;
  pathname?: string;
  [k: string]: string | number | boolean | null | undefined;
}

/**
 * Campaign attribution comes from ONE place: the governed record in
 * ./marketing/attribution-session.ts, validated by ./marketing/utm-contract.ts.
 *
 * The previous implementation read utm_term, ref, and any utm_* value up to
 * 160 raw characters straight off the URL, mirrored them into sessionStorage,
 * and forwarded them to GA4 and Vercel. That was the last ungoverned campaign
 * surface in the browser: it accepted media outside the closed vocabulary,
 * values past the 40-character bound, and anything PII-shaped. It is gone. A
 * link using a non-allowlisted medium, or a legacy utm_term / ref link, now
 * contributes NO campaign attribution rather than bypassing governance.
 */
function currentCampaignParams(): Record<string, string> {
  return attributionMetadata(currentAttribution());
}

/**
 * GA4's reserved campaign fields, built only from a governed tuple. There is
 * no governed equivalent of utm_term, so nothing maps to campaign_term.
 */
function googleCampaignFields(campaign: Record<string, string>): Record<string, string> {
  const fields: Record<string, string> = {};
  if (campaign.utm_source) fields.campaign_source = campaign.utm_source;
  if (campaign.utm_medium) fields.campaign_medium = campaign.utm_medium;
  if (campaign.utm_campaign) fields.campaign_name = campaign.utm_campaign;
  if (campaign.utm_content) fields.campaign_content = campaign.utm_content;
  return fields;
}

type VercelAnalyticsProps = Record<string, string | number | boolean | null>;

function vercelSafeProps(input: Record<string, unknown>): VercelAnalyticsProps {
  const props: VercelAnalyticsProps = {};
  for (const [key, value] of Object.entries(input)) {
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
  return `${window.location.origin ?? ''}${window.location.pathname ?? ''}`;
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

export function currentGaClientId(): string | null {
  if (typeof document === 'undefined') return null;
  const gaCookie = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('_ga='));
  if (!gaCookie) return null;
  const value = decodeURIComponent(gaCookie.slice(4));
  const match = value.match(/^GA\d+\.\d+\.(\d+\.\d+)$/);
  return match?.[1] ?? null;
}

function sanitizedPageReferrer(): string {
  if (typeof document === 'undefined' || !document.referrer) return '';
  try {
    const referrer = new URL(document.referrer);
    if (isUnwantedReferral(referrer.href)) return '';
    return `${referrer.origin}${referrer.pathname}`;
  } catch {
    return '';
  }
}

function googleSafeProps(input: Record<string, unknown>): Record<string, unknown> {
  const props: Record<string, unknown> = { ...vercelSafeProps(input) };
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
 * Push an HSB event. Safe to call anywhere (server, client, missing
 * globals). Returns the pushed record or null on the server.
 */
export function track(
  event: HsbEventName,
  props: Record<string, string | number | boolean | null | undefined> = {},
): HsbEventRecord | null {
  if (typeof window === 'undefined') return null;
  const pathname =
    typeof window.location !== 'undefined' ? window.location.pathname : undefined;
  const campaignParams = currentCampaignParams();
  const record: HsbEventRecord = {
    event,
    timestamp: Date.now(),
    href:
      typeof window.location !== 'undefined'
        ? `${window.location.origin ?? ''}${pathname ?? ''}`
        : undefined,
    pathname,
    ...campaignParams,
    ...props,
  };
  try {
    window.hsbEvents = window.hsbEvents ?? [];
    window.hsbEvents.push(record);
    // Everything below this line leaves the browser. Nothing does without an
    // explicit grant.
    if (!optionalAnalyticsAllowed()) {
      if (hsbAnalyticsIsDev()) {
        // eslint-disable-next-line no-console
        console.info(`[hsb-analytics] ${event} (buffered only: no consent)`);
      }
      return record;
    }
    if (typeof window.gtag === 'function') {
      const googleCampaign = googleCampaignFields(campaignParams);
      if (Object.keys(googleCampaign).length) window.gtag('set', googleCampaign);
      window.gtag('event', event, googleSafeProps(record));
    }
    if (event !== 'page_view') {
      trackVercelEvent(event, vercelSafeProps(record));
    }
    // Meta candidate. Only the event NAME crosses this line: the bridge
    // supplies its own fixed, allowlisted parameters and never reads `record`,
    // which carries theme, photo/voice flags, and URL-prefill hints. Returns a
    // skip reason and does nothing at all unless the pixel is fully enabled.
    metaHandleHsbEvent(event);
  } catch {
    /* never throw from analytics */
  }
  if (hsbAnalyticsIsDev()) {
    // eslint-disable-next-line no-console
    console.info(`[hsb-analytics] ${event}`, props);
  }
  return record;
}

/**
 * One sanitized page view. The route is templated by `sanitizeRoute`, so
 * /review/<id> is reported as /review/[orderId] and an order id, review token,
 * or asset id can never itself become the route. Query strings and fragments
 * were already excluded by the caller and are stripped again here.
 */
export function trackPageView(pathname?: string): void {
  track('page_view', pathname ? { pathname: sanitizeRoute(pathname) } : {});
}
