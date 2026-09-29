/**
 * The HSB analytics event contract (version 1): the one checked-in, executable
 * definition of what may reach an analytics vendor.
 *
 *  - Browser events are behavioral evidence only. Each declares a closed
 *    parameter set; `track()` and `trackCoverEvent()` project every caller's
 *    props through it before anything is buffered or sent, so an undeclared
 *    key or an out-of-vocabulary value never leaves the page. The analytics
 *    layer then adds only its own sanitized fields: an approved route, route
 *    template or `/(other)` (never a raw path), a referrer origin, governed
 *    `utm_*` values, and the complete event-scoped
 *    `campaign_*` projection (explicit empty strings clear absent fields; a
 *    persistent `set` is never used).
 *  - `purchase` is server-only. The signed Stripe webhook's settled winner
 *    (src/lib/purchase-analytics.ts) is its sole writer, through the GA4
 *    Measurement Protocol. GA4 is behavioral evidence, never payment authority.
 *  - Meta: the browser candidate may carry PageView and InitiateCheckout only.
 *    Purchase is server-only and DEFERRED (src/lib/meta-capi-status.ts).
 *
 * The validators below are the contract's executable form: tests run the real
 * emitters through them. Browser-safe — no server-only imports.
 */
import type { CoverEventName, HsbEventName } from './analytics.ts';
import type { CoverVariant } from './cover-variant.ts';
import type { BookFormat } from './orders.ts';
import { isCanonicalLandingPath, sanitizeAttributionValue, sanitizeLandingPath } from './attribution-contract.ts';
import {
  CHECKOUT_STEP_BLOCKED_REASONS,
  CHECKOUT_TELEMETRY_STEP_IDS,
  CHECKOUT_TELEMETRY_TOTAL_STEPS,
} from './checkout-step-telemetry.ts';
import { GIFT_OCCASIONS } from './gift-occasions.ts';
import { STORY_THEMES } from './story-catalog.ts';

export const ANALYTICS_EVENT_CONTRACT_VERSION = 1;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

const BOOK_FORMATS = ['digital', 'classic', 'premium'] as const satisfies readonly BookFormat[];
const COVER_VARIANTS = ['A', 'B'] as const satisfies readonly CoverVariant[];
type Exhaustive<T extends never> = T;
export type BookFormatsCovered = Exhaustive<Exclude<BookFormat, (typeof BOOK_FORMATS)[number]>>;
export type CoverVariantsCovered = Exhaustive<Exclude<CoverVariant, (typeof COVER_VARIANTS)[number]>>;

/**
 * Public, identifier-free route templates that may be a governed campaign
 * landing path, a Meta pixel location, or a decision-export landing path.
 * Every entry is a Phase-A canonical landing path.
 */
export const APPROVED_PUBLIC_ROUTE_TEMPLATES: readonly string[] = Object.freeze([
  '/',
  '/about',
  '/pricing',
  '/samples',
  '/gifts',
  ...GIFT_OCCASIONS.map((occasion) => `/gifts/${occasion.id}`),
  '/checkout',
  '/create/your-memory',
]);

// ── Parameter rules ─────────────────────────────────────────────────────────

export type ParamRule =
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly nullable: boolean }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'path' };

export interface ParamSpec {
  readonly rule: ParamRule;
  /** Decision-grade and closed-vocabulary: may be registered as an event-scoped GA4 custom dimension. */
  readonly dimension: boolean;
}

const oneOf = (values: readonly string[], opts: { nullable?: boolean; dimension?: boolean } = {}): ParamSpec => ({
  rule: { kind: 'enum', values: [...values], nullable: opts.nullable ?? false },
  dimension: opts.dimension ?? false,
});
const integer = (min: number, max: number): ParamSpec => ({ rule: { kind: 'integer', min, max }, dimension: false });
const flag: ParamSpec = { rule: { kind: 'boolean' }, dimension: false };
const routePath: ParamSpec = { rule: { kind: 'path' }, dimension: false };

function ruleAccepts(rule: ParamRule, value: unknown): boolean {
  switch (rule.kind) {
    case 'enum':
      return (value === null && rule.nullable) || (typeof value === 'string' && rule.values.includes(value));
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= rule.min && value <= rule.max;
    case 'boolean':
      return typeof value === 'boolean';
    case 'path':
      // The approved landing route set, a route template, or `/(other)` — never a raw path.
      return isCanonicalLandingPath(value);
  }
}

// ── Browser events ──────────────────────────────────────────────────────────

export type BrowserEventName = HsbEventName | CoverEventName;

export interface BrowserEventSpec {
  readonly emitter: 'track' | 'trackCoverEvent';
  /** Decision-grade events need an explicit GA4 key-event decision in the Admin checklist. */
  readonly decisionGrade: boolean;
  readonly params: Readonly<Record<string, ParamSpec>>;
}

const THEME_IDS = STORY_THEMES.map((theme) => theme.id);

const STEP_PARAMS = {
  step_id: oneOf(CHECKOUT_TELEMETRY_STEP_IDS, { dimension: true }),
  step_number: integer(1, CHECKOUT_TELEMETRY_TOTAL_STEPS),
  total_steps: integer(CHECKOUT_TELEMETRY_TOTAL_STEPS, CHECKOUT_TELEMETRY_TOTAL_STEPS),
  selected_format: oneOf(BOOK_FORMATS, { nullable: true, dimension: true }),
};

const INTENT_PARAMS = {
  theme: oneOf(THEME_IDS, { nullable: true }),
  bookFormat: oneOf(BOOK_FORMATS, { nullable: true }),
  hasPhoto: flag,
  hasVoice: flag,
  familyCharacterCount: integer(0, 100),
};

const tracked = (decisionGrade: boolean, params: Record<string, ParamSpec>): BrowserEventSpec =>
  ({ emitter: 'track', decisionGrade, params });
const cover = (): BrowserEventSpec => ({ emitter: 'trackCoverEvent', decisionGrade: false, params: { variant: oneOf(COVER_VARIANTS) } });

/**
 * Every browser event name the analytics layer accepts. The explicit type
 * makes a new `HsbEventName`/`CoverEventName` fail to compile until it is
 * declared here. `purchase` is deliberately absent.
 */
export const BROWSER_EVENT_CONTRACT: Readonly<Record<BrowserEventName, BrowserEventSpec>> = deepFreeze({
  page_view: tracked(true, { pathname: routePath }),
  begin_checkout: tracked(true, { bookFormat: oneOf(BOOK_FORMATS) }),
  checkout_step_view: tracked(true, STEP_PARAMS),
  checkout_step_complete: tracked(true, STEP_PARAMS),
  checkout_step_blocked: tracked(true, { ...STEP_PARAMS, reason: oneOf(CHECKOUT_STEP_BLOCKED_REASONS, { dimension: true }) }),
  name_preview_submitted: tracked(false, { has_name: flag, preview_name_length: integer(0, 200) }),
  start_checkout: tracked(false, {}),
  format_selected: tracked(false, { format: oneOf(BOOK_FORMATS) }),
  story_selected: tracked(false, { theme: oneOf(THEME_IDS) }),
  order_submit_attempt: tracked(false, INTENT_PARAMS),
  purchase_intent: tracked(false, INTENT_PARAMS),
  proof_approved: tracked(false, { bookFormat: oneOf(BOOK_FORMATS) }),
  cover_variant_shown: cover(),
  preview_click: cover(),
  premium_select: cover(),
  checkout_start: cover(),
});

export function browserEventSpec(event: unknown): BrowserEventSpec | null {
  if (typeof event !== 'string' || !hasOwn(BROWSER_EVENT_CONTRACT, event)) return null;
  return BROWSER_EVENT_CONTRACT[event as BrowserEventName];
}

export function isBrowserPurchase(event: unknown): boolean {
  return typeof event === 'string' && event.trim().toLowerCase() === 'purchase';
}

export type ContractParamValue = string | number | boolean | null;

/**
 * The caller's props reduced to the event's declared parameters with valid
 * values. A path is collapsed to its approved route, template or `/(other)`;
 * a value that is not a path is dropped. Null for an event the contract does
 * not declare — the caller must then emit nothing. Never throws, even for
 * hostile getters.
 */
export function projectBrowserEventParams(event: unknown, props: unknown): Record<string, ContractParamValue> | null {
  const spec = browserEventSpec(event);
  if (!spec) return null;
  const projected: Record<string, ContractParamValue> = {};
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return projected;
  for (const [key, param] of Object.entries(spec.params)) {
    let value: unknown;
    try {
      if (!hasOwn(props, key)) continue;
      value = (props as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    const candidate = param.rule.kind === 'path' ? sanitizeLandingPath(value) : value;
    if (ruleAccepts(param.rule, candidate)) projected[key] = candidate as ContractParamValue;
  }
  return projected;
}

// ── Layer fields the analytics layer adds (not caller-declarable) ───────────

/** Complete event-scoped campaign projection: GA4 field → governed attribution key. */
export const CAMPAIGN_PROJECTION: ReadonlyArray<readonly [string, 'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content']> =
  Object.freeze([
    ['campaign_source', 'utm_source'],
    ['campaign_medium', 'utm_medium'],
    ['campaign_name', 'utm_campaign'],
    ['campaign_content', 'utm_content'],
  ] as const);
const CAMPAIGN_KEYS: ReadonlySet<string> = new Set(CAMPAIGN_PROJECTION.map(([key]) => key));
const UTM_KEYS: ReadonlySet<string> = new Set(CAMPAIGN_PROJECTION.map(([, key]) => key));

function isSanitizedPath(value: unknown): value is string {
  return isCanonicalLandingPath(value);
}

function isSanitizedLocation(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && `${url.origin}${url.pathname}` === value
      && isSanitizedPath(url.pathname);
  } catch {
    return false;
  }
}

function isReferrerOrigin(value: unknown): boolean {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

function layerValueValid(key: string, value: unknown, params: Record<string, unknown>): boolean {
  if (key === 'timestamp') return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (key === 'pathname') return isSanitizedPath(value);
  if (key === 'ignore_referrer') return value === true && params.page_referrer === '';
  if (UTM_KEYS.has(key)) return typeof value === 'string' && sanitizeAttributionValue(key, value) === value;
  return false;
}

/**
 * Violations of the contract by one recorded gtag call, as value-free codes.
 * An empty array means the call is exactly what the contract allows.
 */
export function checkGa4BrowserEventCall(call: unknown): string[] {
  if (!Array.isArray(call)) return ['CALL_SHAPE'];
  const [command, name, params] = call;
  if (command === 'set') return ['PERSISTENT_SET_FORBIDDEN'];
  if (command !== 'event') return ['NOT_AN_EVENT_CALL'];
  if (isBrowserPurchase(name)) return ['BROWSER_PURCHASE_FORBIDDEN'];
  const spec = browserEventSpec(name);
  if (!spec) return ['UNDECLARED_EVENT'];
  if (!isPlainRecord(params)) return ['PARAMS_SHAPE'];

  const violations: string[] = [];
  const trackOnly = spec.emitter === 'track';
  let undeclared = false;
  for (const [key, value] of Object.entries(params)) {
    if (hasOwn(spec.params, key)) {
      if (!ruleAccepts(spec.params[key].rule, value)) violations.push(`PARAM_VALUE_INVALID:${key}`);
    } else if (CAMPAIGN_KEYS.has(key)) {
      // Checked as a complete projection below.
    } else if (key === 'page_location') {
      if (!isSanitizedLocation(value)) violations.push('PAGE_LOCATION_NOT_SANITIZED');
    } else if (key === 'page_referrer') {
      if (!isReferrerOrigin(value)) violations.push('PAGE_REFERRER_NOT_ORIGIN');
    } else if (UTM_KEYS.has(key) || key === 'ignore_referrer' || (trackOnly && (key === 'timestamp' || key === 'pathname'))) {
      if (!layerValueValid(key, value, params)) violations.push(`LAYER_VALUE_INVALID:${key}`);
    } else {
      undeclared = true;
    }
  }
  if (undeclared) violations.push('UNDECLARED_PARAM');
  for (const key of [...(trackOnly ? ['timestamp', 'pathname'] : []), 'page_location', 'page_referrer']) {
    if (!hasOwn(params, key)) violations.push(`LAYER_PARAM_MISSING:${key}`);
  }

  if (!CAMPAIGN_PROJECTION.every(([key]) => hasOwn(params, key))) {
    violations.push('CAMPAIGN_PROJECTION_INCOMPLETE');
    return violations;
  }
  for (const [campaignKey, utmKey] of CAMPAIGN_PROJECTION) {
    const value = params[campaignKey];
    if (value !== '' && (typeof value !== 'string' || sanitizeAttributionValue(utmKey, value) !== value)) {
      violations.push('CAMPAIGN_VALUE_UNGOVERNED');
      continue;
    }
    const expected = hasOwn(params, utmKey) ? params[utmKey] : '';
    if (value !== expected) violations.push('CAMPAIGN_PROJECTION_MISMATCH');
  }
  return violations;
}

// ── The server purchase ─────────────────────────────────────────────────────

/** A Stripe Checkout Session id: the deterministic GA4 `transaction_id`. */
export const GA4_TRANSACTION_ID_PATTERN = /^cs_(?:test|live)_[A-Za-z0-9]{1,255}$/;

/** The one-item purchase catalog; display names are derived here, never passed in. */
export const GA4_PURCHASE_ITEMS: Readonly<Record<string, string>> = Object.freeze({
  book_digital: 'HeroStoryBooks digital',
  book_classic: 'HeroStoryBooks classic',
  book_premium: 'HeroStoryBooks premium',
  print_upgrade_classic: 'Print upgrade: classic',
  print_upgrade_premium: 'Print upgrade: premium',
});

const TOUCH_PREFIXES = ['hsb_ft', 'hsb_lt'] as const;
const TOUCH_FIELDS = ['source', 'medium', 'campaign', 'content', 'landing'] as const;
type TouchField = (typeof TOUCH_FIELDS)[number];

function touchValueAllowed(field: TouchField, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  switch (field) {
    case 'source': return value === '(direct)' || sanitizeAttributionValue('utm_source', value) === value;
    case 'medium': return value === '(none)' || sanitizeAttributionValue('utm_medium', value) === value;
    case 'campaign': return sanitizeAttributionValue('utm_campaign', value) === value;
    case 'content': return sanitizeAttributionValue('utm_content', value) === value;
    case 'landing': return sanitizeLandingPath(value) === value;
  }
}

const PURCHASE_REQUIRED = ['transaction_id', 'value', 'currency', 'items', 'engagement_time_msec'] as const;
const PURCHASE_PARAMS = new Set<string>([
  ...PURCHASE_REQUIRED,
  'session_id',
  'session_number',
  ...TOUCH_PREFIXES.flatMap((prefix) => TOUCH_FIELDS.map((field) => `${prefix}_${field}`)),
]);

/** The server purchase in contract form; `purchase-analytics.ts` is its only writer. */
export const GA4_PURCHASE_CONTRACT = deepFreeze({
  event: 'purchase',
  transport: 'server_measurement_protocol',
  authority: 'settled_webhook_winner',
  browser: 'forbidden',
  keyEvent: { countingMethod: 'ONCE_PER_EVENT' },
  params: [...PURCHASE_PARAMS],
  /** First/last-touch attribution: decision-grade, closed vocabulary, event-scoped. */
  dimensionParams: TOUCH_PREFIXES.flatMap((prefix) => TOUCH_FIELDS.map((field) => `${prefix}_${field}`)),
} as const);

function isMoney(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000) return false;
  return Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function itemsValid(items: unknown, value: unknown): boolean {
  if (!Array.isArray(items) || items.length !== 1 || !isPlainRecord(items[0])) return false;
  const item = items[0];
  const keys = Object.keys(item).sort();
  if (keys.join(',') !== 'item_id,item_name,price,quantity') return false;
  return typeof item.item_id === 'string'
    && hasOwn(GA4_PURCHASE_ITEMS, item.item_id)
    && item.item_name === GA4_PURCHASE_ITEMS[item.item_id]
    && item.price === value
    && item.quantity === 1;
}

/** Violations of the server purchase contract by one Measurement Protocol body. */
export function checkGa4PurchasePayload(body: unknown): string[] {
  let doc: unknown = body;
  if (typeof body === 'string') {
    try {
      doc = JSON.parse(body);
    } catch {
      return ['BODY_NOT_JSON'];
    }
  }
  if (!isPlainRecord(doc)) return ['BODY_SHAPE'];
  const violations: string[] = [];
  if (Object.keys(doc).some((key) => key !== 'client_id' && key !== 'events')) violations.push('UNDECLARED_FIELD');
  const clientId = doc.client_id;
  if (typeof clientId !== 'string' || !(/^\d{1,20}\.\d{1,20}$/.test(clientId) || /^hsb\.[0-9a-f]{24}$/.test(clientId))) {
    violations.push('CLIENT_ID_INVALID');
  }
  if (!Array.isArray(doc.events) || doc.events.length !== 1) return [...violations, 'EVENTS_SHAPE'];
  const event = doc.events[0];
  if (!isPlainRecord(event) || Object.keys(event).sort().join(',') !== 'name,params') return [...violations, 'EVENT_SHAPE'];
  if (event.name !== 'purchase') violations.push('EVENT_NAME_INVALID');
  const params = event.params;
  if (!isPlainRecord(params)) return [...violations, 'PARAMS_SHAPE'];

  if (Object.keys(params).some((key) => !PURCHASE_PARAMS.has(key))) violations.push('UNDECLARED_PARAM');
  for (const key of PURCHASE_REQUIRED) if (!hasOwn(params, key)) violations.push(`PARAM_MISSING:${key}`);
  if (hasOwn(params, 'transaction_id')
    && (typeof params.transaction_id !== 'string' || !GA4_TRANSACTION_ID_PATTERN.test(params.transaction_id))) {
    violations.push('PARAM_VALUE_INVALID:transaction_id');
  }
  if (hasOwn(params, 'value') && !isMoney(params.value)) violations.push('PARAM_VALUE_INVALID:value');
  if (hasOwn(params, 'currency') && params.currency !== 'USD') violations.push('PARAM_VALUE_INVALID:currency');
  if (hasOwn(params, 'items') && !itemsValid(params.items, params.value)) violations.push('PARAM_VALUE_INVALID:items');
  if (hasOwn(params, 'engagement_time_msec') && params.engagement_time_msec !== 1) {
    violations.push('PARAM_VALUE_INVALID:engagement_time_msec');
  }

  const hasSession = hasOwn(params, 'session_id');
  if (hasSession !== hasOwn(params, 'session_number')) violations.push('SESSION_UNPAIRED');
  if (hasSession && !(Number.isSafeInteger(params.session_id) && (params.session_id as number) >= 1e9 && (params.session_id as number) < 1e10)) {
    violations.push('PARAM_VALUE_INVALID:session_id');
  }
  if (hasOwn(params, 'session_number')
    && !(Number.isSafeInteger(params.session_number) && (params.session_number as number) >= 1 && (params.session_number as number) <= 999_999)) {
    violations.push('PARAM_VALUE_INVALID:session_number');
  }

  for (const prefix of TOUCH_PREFIXES) {
    const present = TOUCH_FIELDS.filter((field) => hasOwn(params, `${prefix}_${field}`));
    if (present.length === 0) continue;
    for (const field of present) {
      if (!touchValueAllowed(field, params[`${prefix}_${field}`])) violations.push(`PARAM_VALUE_INVALID:${prefix}_${field}`);
    }
    if (!present.includes('source') || !present.includes('landing')) {
      violations.push(`TOUCH_INCOMPLETE:${prefix}`);
    } else if (params[`${prefix}_source`] === '(direct)'
      && (params[`${prefix}_medium`] !== '(none)' || present.includes('campaign') || present.includes('content'))) {
      violations.push(`TOUCH_INCOHERENT:${prefix}`);
    }
  }
  return violations;
}

// ── GA4 Admin eligibility (consumed by the Admin checklist) ─────────────────

/** Events that need an explicit key-event decision: decision-grade browser events and the purchase. */
export const GA4_DECISION_GRADE_EVENTS: readonly string[] = Object.freeze([
  ...Object.entries(BROWSER_EVENT_CONTRACT).filter(([, spec]) => spec.decisionGrade).map(([name]) => name),
  GA4_PURCHASE_CONTRACT.event,
]);

/** Key-event eligibility: only the webhook-authoritative purchase, counted once per event. */
export const GA4_KEY_EVENT_POLICY: Readonly<Record<string, 'ONCE_PER_EVENT'>> = Object.freeze({
  purchase: GA4_PURCHASE_CONTRACT.keyEvent.countingMethod,
});

export type DimensionEligibility = 'eligible' | 'not_eligible' | 'undeclared';

/** Whether `param`, as sent on `event`, may be an event-scoped GA4 custom dimension. */
export function ga4DimensionEligibility(event: string, param: string): DimensionEligibility {
  if (event === GA4_PURCHASE_CONTRACT.event) {
    if (!PURCHASE_PARAMS.has(param)) return 'undeclared';
    return (GA4_PURCHASE_CONTRACT.dimensionParams as readonly string[]).includes(param) ? 'eligible' : 'not_eligible';
  }
  const spec = browserEventSpec(event);
  if (!spec || !hasOwn(spec.params, param)) return 'undeclared';
  return spec.params[param].dimension ? 'eligible' : 'not_eligible';
}

/** Whether a reported value of an eligible dimension is inside the contract's vocabulary. */
export function ga4DimensionValueAllowed(event: string, param: string, value: unknown): boolean {
  if (ga4DimensionEligibility(event, param) !== 'eligible') return false;
  if (event === GA4_PURCHASE_CONTRACT.event) {
    const field = param.slice('hsb_ft_'.length) as TouchField;
    return touchValueAllowed(field, value);
  }
  const spec = browserEventSpec(event);
  return spec !== null && value !== null && ruleAccepts(spec.params[param].rule, value);
}

// ── Meta ────────────────────────────────────────────────────────────────────

export interface MetaEventSpec {
  readonly transport: 'browser_image_beacon' | 'server_conversions_api';
  readonly state: 'candidate_default_off' | 'DEFERRED';
  readonly browser: 'allowed' | 'forbidden';
  /** Route templates the browser event may fire on. */
  readonly routes: readonly string[];
}

/**
 * Meta events. No custom data and no Advanced Matching on any event; the
 * browser beacon carries only the event name and a sanitized origin + route
 * template. Purchase is server-only and DEFERRED.
 */
export const META_EVENT_CONTRACT = deepFreeze({
  PageView: {
    transport: 'browser_image_beacon',
    state: 'candidate_default_off',
    browser: 'allowed',
    routes: APPROVED_PUBLIC_ROUTE_TEMPLATES,
  },
  InitiateCheckout: {
    transport: 'browser_image_beacon',
    state: 'candidate_default_off',
    browser: 'allowed',
    routes: ['/checkout'],
  },
  Purchase: {
    transport: 'server_conversions_api',
    state: 'DEFERRED',
    browser: 'forbidden',
    routes: [],
  },
} satisfies Record<string, MetaEventSpec>);
