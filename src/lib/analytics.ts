// Thin analytics shim. Calls window.gtag if it's loaded; otherwise no-ops.
// Also forwards to Vercel Analytics if available, so the A/B test isn't dark
// when GA isn't wired yet.
import type { CoverVariant } from './cover-variant';
import { track as trackVercelEvent } from '@vercel/analytics';

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
  | 'start_checkout'
  | 'format_selected'
  | 'story_selected'
  | 'order_submit_attempt'
  // Aliased name kept for the brief's "purchase_intent" terminology;
  // emitted alongside order_submit_attempt for downstream flexibility.
  | 'purchase_intent'
  // Homepage 16:9 photo-to-story walkthrough (src/components/homepage-walkthrough.tsx).
  // One-shot per page view; carry non-PII props video_id/placement/duration_seconds/
  // muted/source_format.
  | 'video_impression'
  | 'video_play'
  | 'video_25'
  | 'video_50'
  | 'video_75'
  | 'video_complete'
  | 'video_cta_click';

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
    hsbEvents?: HsbEventRecord[];
  }
}

type CampaignParams = Partial<Record<(typeof campaignParamKeys)[number], string>>;
const campaignSessionKey = 'hsb:first-touch-campaign:v1';

function campaignParamsFromUrl(): CampaignParams {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const campaignParams: CampaignParams = {};
  for (const key of campaignParamKeys) {
    const value = params.get(key);
    if (value) campaignParams[key] = value.slice(0, 160);
  }
  return campaignParams;
}

function parseStoredCampaign(value: string | null): CampaignParams {
  if (!value) return {};
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    const campaignParams: CampaignParams = {};
    for (const key of campaignParamKeys) {
      const field = candidate[key];
      if (typeof field === 'string' && field) campaignParams[key] = field.slice(0, 160);
    }
    return campaignParams;
  } catch {
    return {};
  }
}

function currentCampaignParams(): CampaignParams {
  const fromUrl = campaignParamsFromUrl();
  if (typeof window === 'undefined') return fromUrl;
  try {
    const stored = parseStoredCampaign(window.sessionStorage?.getItem(campaignSessionKey) ?? null);
    if (Object.keys(stored).length) return stored;
    if (Object.keys(fromUrl).length) {
      window.sessionStorage?.setItem(campaignSessionKey, JSON.stringify(fromUrl));
    }
  } catch {
    /* storage can be unavailable in privacy modes; current URL still works */
  }
  return fromUrl;
}

function googleCampaignFields(campaign: CampaignParams): Record<string, string> {
  const fields: Record<string, string> = {};
  if (campaign.utm_source) fields.campaign_source = campaign.utm_source;
  if (campaign.utm_medium) fields.campaign_medium = campaign.utm_medium;
  if (campaign.utm_campaign) fields.campaign_name = campaign.utm_campaign;
  if (campaign.utm_term) fields.campaign_term = campaign.utm_term;
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

function sanitizedPageReferrer(): string {
  if (typeof document === 'undefined' || !document.referrer) return '';
  try {
    const referrer = new URL(document.referrer);
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
    if (typeof window.gtag === 'function') {
      const googleCampaign = googleCampaignFields(campaignParams);
      if (Object.keys(googleCampaign).length) window.gtag('set', googleCampaign);
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
    console.info(`[hsb-analytics] ${event}`, props);
  }
  return record;
}

export function trackPageView(pathname?: string): void {
  track('page_view', pathname ? { pathname } : {});
}
