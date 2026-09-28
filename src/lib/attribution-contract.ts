/**
 * The privacy-safe attribution contract.
 *
 * One contract governs every campaign value that can leave the browser — into
 * the checkout API, the durable order, Stripe metadata, or the webhook's GA4
 * purchase. It holds exactly five UTM fields, a landing route and a capture
 * time, each independently bounded, and nothing else: no raw query string,
 * hash, referrer, name, email, address, child detail, questionnaire text,
 * provider identifier, or free text can be represented.
 *
 *  - Values use the field-specific closed marketing vocabulary below, not a
 *    generic token grammar (names and phone numbers can be tokens too).
 *    Unknown labels are dropped; utm_term is never retained.
 *  - A landing path is a known public route, a route TEMPLATE for the
 *    identifier-bearing routes, or one opaque `/(other)` bucket — so a 404 path
 *    a person typed can never be stored.
 *  - A touch is a campaign touch only when it carries one valid `utm_source`;
 *    otherwise it is direct and carries no UTM field at all.
 *  - The first touch is immutable for the attribution window; the last
 *    non-direct touch advances only on a later campaign landing.
 *  - A stored or transported state is re-validated in full — exact keys,
 *    canonical values, a canonical timestamp inside the window, first before
 *    last — before it can be used, and in particular before it can suppress
 *    capturing a new landing.
 *
 * Isomorphic and dependency-light: the browser, the checkout API and the
 * webhook all read the same rules.
 */
import { sanitizeAnalyticsPath } from './analytics-path.ts';
import { GIFT_OCCASIONS } from './gift-occasions.ts';

export const ATTRIBUTION_STORAGE_KEY = 'hsb:attribution:v1';
export const ATTRIBUTION_STATE_VERSION = 1;

const DAY_MS = 86_400_000;
/** How long the browser keeps a first touch before a landing replaces it. */
export const ATTRIBUTION_WINDOW_MS = 30 * DAY_MS;
/**
 * How old a touch the server still trusts: the browser window plus a Checkout
 * Session's 24-hour life plus Stripe's three-day webhook retry horizon, with
 * slack, so a state accepted at checkout is still trusted when the webhook lands.
 */
export const ATTRIBUTION_ACCEPT_MAX_AGE_MS = 35 * DAY_MS;
/** Clock skew tolerated between a browser capture and the server. */
export const ATTRIBUTION_FUTURE_SKEW_MS = 5 * 60_000;
export const ATTRIBUTION_SERIALIZED_MAX_LENGTH = 2_048;
const SEARCH_MAX_LENGTH = 2_048;
const PATH_MAX_LENGTH = 512;

export const ATTRIBUTION_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
export type AttributionUtmKey = (typeof ATTRIBUTION_UTM_KEYS)[number];

export const ATTRIBUTION_VALUE_MAX_LENGTH: Readonly<Record<AttributionUtmKey, number>> = Object.freeze({
  utm_source: 50,
  utm_medium: 30,
  utm_campaign: 100,
  utm_content: 100,
  utm_term: 50,
});

/**
 * Governed HSB tags, after trim/lowercase normalization:
 * source/medium: exactly the alternatives below.
 * campaign: launch, or YYYY-MM-{gifts|holiday|birthdays|launch}, years
 * 2026–2029 and months 01–12, optionally .v1 through .v9.
 * content: {video|image|carousel|text}-{a|b|c} creative variants only.
 * term: unsupported; free-text/search-keyword dimensions are always dropped.
 * Add new marketing labels by reviewed code change, never by user input.
 */
const VALUE_GRAMMARS: Readonly<Record<AttributionUtmKey, RegExp | null>> = {
  utm_source: /^(?:facebook|instagram|google|bing|newsletter|pinterest|youtube|tiktok|telegram)$/,
  utm_medium: /^(?:paid_social|social|email|cpc|organic|referral)$/,
  utm_campaign: /^(?:launch|202[6-9]-(?:0[1-9]|1[0-2])-(?:gifts|holiday|birthdays|launch)(?:\.v[1-9])?)$/,
  utm_content: /^(?:video|image|carousel|text)-[abc]$/,
  utm_term: null,
};
const CAPTURED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const OTHER_LANDING_PATH = '/(other)';
const LANDING_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/about',
  '/pricing',
  '/samples',
  '/gifts',
  ...GIFT_OCCASIONS.map((occasion) => `/gifts/${occasion.id}`),
  '/checkout',
  '/create/your-memory',
  '/order',
  '/privacy',
  '/terms',
  '/thank-you',
  '/family-review',
  '/status/[orderId]',
  '/review/[orderId]',
  '/family-review/review/[reviewToken]',
  '/family-review/review/[reviewToken]/image/[assetId]',
]);

export interface AttributionTouch {
  /** Null on a direct touch, and then every other UTM field is null too. */
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  landingPath: string;
  capturedAt: string;
}

export interface AttributionState {
  version: typeof ATTRIBUTION_STATE_VERSION;
  firstTouch: AttributionTouch;
  lastNonDirectTouch: AttributionTouch | null;
}

type TouchUtmField = 'source' | 'medium' | 'campaign' | 'content' | 'term';

const TOUCH_UTM: ReadonlyArray<readonly [TouchUtmField, AttributionUtmKey]> = [
  ['source', 'utm_source'],
  ['medium', 'utm_medium'],
  ['campaign', 'utm_campaign'],
  ['content', 'utm_content'],
  ['term', 'utm_term'],
];
const TOUCH_KEYS = ['source', 'medium', 'campaign', 'content', 'term', 'landingPath', 'capturedAt'] as const;
const STATE_KEYS = ['version', 'firstTouch', 'lastNonDirectTouch'] as const;

interface AcceptWindow {
  now: number;
  maxAgeMs: number;
}

function isUtmKey(key: string): key is AttributionUtmKey {
  return (ATTRIBUTION_UTM_KEYS as readonly string[]).includes(key);
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => hasOwn(record, key));
}

export function sanitizeAttributionValue(key: string, raw: unknown): string | null {
  if (!isUtmKey(key) || typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > ATTRIBUTION_VALUE_MAX_LENGTH[key]) return null;
  return VALUE_GRAMMARS[key]?.test(value) ? value : null;
}

/**
 * A pathname as a publishable landing route: a known public route, a route
 * template, or `/(other)`. Null for anything that is not a pathname at all.
 */
export function sanitizeLandingPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PATH_MAX_LENGTH || !raw.startsWith('/')) {
    return null;
  }
  let path = sanitizeAnalyticsPath(raw);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return LANDING_PATHS.has(path) ? path : OTHER_LANDING_PATH;
}

function isCanonicalLandingPath(value: unknown): value is string {
  return typeof value === 'string' && (value === OTHER_LANDING_PATH || LANDING_PATHS.has(value));
}

function acceptCapturedAt(raw: unknown, bounds: AcceptWindow): string | null {
  if (typeof raw !== 'string' || !CAPTURED_AT_RE.test(raw) || !Number.isFinite(bounds.now)) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== raw) return null;
  if (at > bounds.now + ATTRIBUTION_FUTURE_SKEW_MS || at < bounds.now - bounds.maxAgeMs) return null;
  return raw;
}

function directTouch(landingPath: string, capturedAt: string): AttributionTouch {
  return { source: null, medium: null, campaign: null, content: null, term: null, landingPath, capturedAt };
}

export function isCampaignTouch(touch: AttributionTouch): boolean {
  return touch.source !== null;
}

/** The bounded UTM tuple of one landing's query string; direct when it has no single valid source. */
function utmFromSearch(search: unknown): Omit<AttributionTouch, 'landingPath' | 'capturedAt'> {
  const none = { source: null, medium: null, campaign: null, content: null, term: null };
  if (typeof search !== 'string' || search.length > SEARCH_MAX_LENGTH) return none;
  const params = new URLSearchParams(search);
  const single = (key: AttributionUtmKey) => {
    const values = params.getAll(key);
    return values.length === 1 ? sanitizeAttributionValue(key, values[0]) : null;
  };
  const source = single('utm_source');
  if (!source) return none;
  return {
    source,
    medium: single('utm_medium'),
    campaign: single('utm_campaign'),
    content: single('utm_content'),
    term: single('utm_term'),
  };
}

export function captureAttributionTouch(input: { search: unknown; pathname: unknown; now: number }): AttributionTouch | null {
  const landingPath = sanitizeLandingPath(input.pathname);
  if (!landingPath || !Number.isFinite(input.now)) return null;
  return { ...utmFromSearch(input.search), landingPath, capturedAt: new Date(input.now).toISOString() };
}

export function mergeAttributionState(stored: AttributionState | null, touch: AttributionTouch): AttributionState {
  const campaignTouch = isCampaignTouch(touch) ? touch : null;
  if (!stored) {
    return { version: ATTRIBUTION_STATE_VERSION, firstTouch: touch, lastNonDirectTouch: campaignTouch };
  }
  return {
    version: ATTRIBUTION_STATE_VERSION,
    firstTouch: stored.firstTouch,
    lastNonDirectTouch: campaignTouch ?? stored.lastNonDirectTouch,
  };
}

function validateTouch(value: unknown, bounds: AcceptWindow): AttributionTouch | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, TOUCH_KEYS)) return null;
  const capturedAt = acceptCapturedAt(value.capturedAt, bounds);
  if (!capturedAt || !isCanonicalLandingPath(value.landingPath)) return null;
  const touch = directTouch(value.landingPath, capturedAt);
  for (const [field, key] of TOUCH_UTM) {
    const raw = value[field];
    if (raw === null) continue;
    // Stored values must already be canonical: a value the contract would
    // have rewritten was not written by the contract.
    if (sanitizeAttributionValue(key, raw) !== raw) return null;
    touch[field] = raw as string;
  }
  if (touch.source === null && TOUCH_UTM.some(([field]) => touch[field] !== null)) return null;
  return touch;
}

function validateState(value: unknown, bounds: AcceptWindow): AttributionState | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, STATE_KEYS)) return null;
  if (value.version !== ATTRIBUTION_STATE_VERSION) return null;
  const firstTouch = validateTouch(value.firstTouch, bounds);
  if (!firstTouch) return null;
  let lastNonDirectTouch: AttributionTouch | null = null;
  if (value.lastNonDirectTouch !== null) {
    lastNonDirectTouch = validateTouch(value.lastNonDirectTouch, bounds);
    if (!lastNonDirectTouch || !isCampaignTouch(lastNonDirectTouch)) return null;
    if (lastNonDirectTouch.capturedAt < firstTouch.capturedAt) return null;
  }
  return { version: ATTRIBUTION_STATE_VERSION, firstTouch, lastNonDirectTouch };
}

/** A serialized state, accepted only in its exact, current, canonical shape. */
export function parseAttributionState(raw: unknown, bounds: AcceptWindow): AttributionState | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ATTRIBUTION_SERIALIZED_MAX_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateState(parsed, bounds);
}

export function serializeAttributionState(state: AttributionState): string {
  const touch = (value: AttributionTouch) => ({
    source: value.source,
    medium: value.medium,
    campaign: value.campaign,
    content: value.content,
    term: value.term,
    landingPath: value.landingPath,
    capturedAt: value.capturedAt,
  });
  return JSON.stringify({
    version: state.version,
    firstTouch: touch(state.firstTouch),
    lastNonDirectTouch: state.lastNonDirectTouch ? touch(state.lastNonDirectTouch) : null,
  });
}

export interface AttributionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Record one landing. An invalid, tampered or expired stored value is treated
 * as absent, so it can never suppress capturing this landing. Storage failures
 * are swallowed: the current landing is still returned.
 */
export function recordAttributionLanding(input: {
  storage: AttributionStorage | null | undefined;
  search: unknown;
  pathname: unknown;
  now: number;
}): AttributionState | null {
  const touch = captureAttributionTouch(input);
  if (!touch) return null;
  let stored: AttributionState | null = null;
  try {
    stored = parseAttributionState(input.storage?.getItem(ATTRIBUTION_STORAGE_KEY) ?? null, {
      now: input.now,
      maxAgeMs: ATTRIBUTION_WINDOW_MS,
    });
  } catch {
    stored = null;
  }
  const next = mergeAttributionState(stored, touch);
  if (!stored || next.lastNonDirectTouch !== stored.lastNonDirectTouch) {
    try {
      input.storage?.setItem(ATTRIBUTION_STORAGE_KEY, serializeAttributionState(next));
    } catch {
      /* storage can be unavailable in privacy modes; the landing still counts */
    }
  }
  return next;
}

// Document-local fallback only when browser storage is unavailable. Keep a
// serialized snapshot so returned/typed state cannot mutate emission authority.
const browserFallback = new WeakMap<Window, string>();
const browserStorageFailed = new WeakSet<Window>();

function browserAttributionStorage(): AttributionStorage {
  return {
    getItem(key) {
      if (!browserStorageFailed.has(window)) {
        try { return window.localStorage.getItem(key); } catch { /* use document snapshot */ }
      }
      return browserFallback.get(window) ?? null;
    },
    setItem(key, value) {
      browserFallback.set(window, value);
      try {
        window.localStorage.setItem(key, value);
        browserStorageFailed.delete(window);
      } catch {
        browserStorageFailed.add(window);
      }
    },
  };
}

/** The sole browser landing capture owner. Legacy sessionStorage is never read or written. */
export function recordBrowserAttributionLanding(): AttributionState | null {
  if (typeof window === 'undefined') return null;
  try {
    return recordAttributionLanding({
      storage: browserAttributionStorage(),
      search: window.location?.search,
      pathname: window.location?.pathname,
      now: Date.now(),
    });
  } catch {
    return null;
  }
}

/** Read-only, final vendor-boundary projection. Never captures a URL landing. */
export function currentBrowserCampaignParams(): Partial<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content', string>> {
  const result: Partial<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content', string>> = {};
  if (typeof window === 'undefined') return result;
  try {
    const state = parseAttributionState(browserAttributionStorage().getItem(ATTRIBUTION_STORAGE_KEY), {
      now: Date.now(), maxAgeMs: ATTRIBUTION_WINDOW_MS,
    });
    if (!state) return result;
    const touch = state.lastNonDirectTouch ?? state.firstTouch;
    if (!isCampaignTouch(touch)) return result;
    for (const [field, key] of TOUCH_UTM) {
      if (key === 'utm_term') continue;
      const value = sanitizeAttributionValue(key, touch[field]);
      if (value !== null) result[key] = value;
    }
  } catch {
    // Storage/query/runtime failures must never break checkout.
  }
  return result;
}

// ── Stripe metadata ─────────────────────────────────────────────────────────
//
// Stripe metadata is flat string → string (≤ 50 keys, key ≤ 40 chars, value ≤
// 500 chars). Each touch becomes at most seven short keys; absent fields are
// omitted rather than sent empty.

const METADATA_VERSION_KEY = 'hsbAttrV';
type TouchMetadataKeys = Readonly<Record<keyof AttributionTouch, string>>;
const FIRST_TOUCH_KEYS: TouchMetadataKeys = {
  source: 'hsbFtSrc',
  medium: 'hsbFtMed',
  campaign: 'hsbFtCmp',
  content: 'hsbFtCnt',
  term: 'hsbFtTrm',
  landingPath: 'hsbFtPath',
  capturedAt: 'hsbFtAt',
};
const LAST_TOUCH_KEYS: TouchMetadataKeys = {
  source: 'hsbLtSrc',
  medium: 'hsbLtMed',
  campaign: 'hsbLtCmp',
  content: 'hsbLtCnt',
  term: 'hsbLtTrm',
  landingPath: 'hsbLtPath',
  capturedAt: 'hsbLtAt',
};

function touchToMetadata(touch: AttributionTouch, keys: TouchMetadataKeys): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [field] of TOUCH_UTM) {
    const value = touch[field];
    if (value !== null) metadata[keys[field]] = value;
  }
  metadata[keys.landingPath] = touch.landingPath;
  metadata[keys.capturedAt] = touch.capturedAt;
  return metadata;
}

export function attributionToStripeMetadata(state: AttributionState | null | undefined): Record<string, string> {
  if (!state) return {};
  // Recheck the closed vocabulary at the outbound boundary too: persisted
  // legacy state and typed callers are not authority to forward free text.
  for (const touch of [state.firstTouch, state.lastNonDirectTouch]) {
    if (!touch) continue;
    if (TOUCH_UTM.some(([field, key]) => sanitizeAttributionValue(key, touch[field]) !== touch[field])) return {};
  }
  return {
    [METADATA_VERSION_KEY]: String(ATTRIBUTION_STATE_VERSION),
    ...touchToMetadata(state.firstTouch, FIRST_TOUCH_KEYS),
    ...(state.lastNonDirectTouch ? touchToMetadata(state.lastNonDirectTouch, LAST_TOUCH_KEYS) : {}),
  };
}

function touchFromMetadata(
  metadata: Record<string, unknown>,
  keys: TouchMetadataKeys,
  bounds: AcceptWindow,
): AttributionTouch | null {
  const candidate: Record<string, unknown> = {};
  for (const field of TOUCH_KEYS) {
    const key = keys[field];
    if (!hasOwn(metadata, key)) {
      candidate[field] = null;
      continue;
    }
    const value = metadata[key];
    if (typeof value !== 'string') return null;
    candidate[field] = value;
  }
  return validateTouch(candidate, bounds);
}

/**
 * Re-validate provider-signed metadata. Unknown keys are never read; an
 * invalid first touch refuses the whole attribution; an invalid, source-less
 * or out-of-order last touch drops only the last touch.
 */
export function attributionFromStripeMetadata(
  metadata: unknown,
  opts: { now: number },
): AttributionState | null {
  if (!isPlainRecord(metadata)) return null;
  if (metadata[METADATA_VERSION_KEY] !== String(ATTRIBUTION_STATE_VERSION)) return null;
  const bounds = { now: opts.now, maxAgeMs: ATTRIBUTION_ACCEPT_MAX_AGE_MS };
  const firstTouch = touchFromMetadata(metadata, FIRST_TOUCH_KEYS, bounds);
  if (!firstTouch) return null;
  const lastPresent = Object.values(LAST_TOUCH_KEYS).some((key) => hasOwn(metadata, key));
  let lastNonDirectTouch = lastPresent ? touchFromMetadata(metadata, LAST_TOUCH_KEYS, bounds) : null;
  if (
    lastNonDirectTouch
    && (!isCampaignTouch(lastNonDirectTouch) || lastNonDirectTouch.capturedAt < firstTouch.capturedAt)
  ) {
    lastNonDirectTouch = null;
  }
  return { version: ATTRIBUTION_STATE_VERSION, firstTouch, lastNonDirectTouch };
}
