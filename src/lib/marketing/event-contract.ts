/**
 * Canonical business-event contract, version 1.0.0.
 *
 * One table that says, for each business moment HSB cares about: what GA4 is
 * already called today (proven from source, not renamed), what Meta may be told
 * in the browser, what Meta may be told from the server, what Reddit would be
 * told if it were ever activated, and who owns the emission.
 *
 * TWO RULES DECIDE EVERYTHING BELOW.
 *
 *  1. Stripe is authoritative for purchase. `src/lib/ga4-purchase.ts` already
 *     sends GA4 `purchase` from the signed Stripe webhook after the durable
 *     payment write. No browser surface may emit a competing purchase, so
 *     `metaBrowserEvent` for the purchase stage is `null` and
 *     `META_BROWSER_EVENT_ALLOWLIST` does not contain `Purchase`.
 *
 *  2. An event is only mapped where live UI semantics prove it. HSB has no
 *     surface today that fires a discrete product-view event, so the canonical
 *     `view_product` stage maps to no Meta event and is documented as deferred
 *     rather than guessed onto the homepage.
 *
 * Pure and isomorphic: no DOM, no network, no environment, no node builtins.
 */

export const EVENT_CONTRACT_VERSION = '1.0.0';

/** Semantic stages, independent of any one vendor's naming. */
export type CanonicalStage =
  | 'page_view'
  | 'view_product'
  | 'begin_checkout'
  | 'purchase';

export type EventOwner = 'browser' | 'stripe_webhook';

export interface CanonicalEventMapping {
  stage: CanonicalStage;
  /**
   * The GA4 event name that HSB emits TODAY, read from source. `null` means the
   * stage has no live GA4 emission.
   */
  ga4Event: string | null;
  /** Where the GA4 emission is proven in source. */
  ga4Source: string | null;
  /** Meta browser standard event, or null when the browser must stay silent. */
  metaBrowserEvent: string | null;
  /** Meta Conversions API event, or null. */
  metaServerEvent: string | null;
  /** Reddit is design-only in this candidate; nothing is ever emitted. */
  redditEvent: string | null;
  owner: EventOwner;
  /** What makes two emissions of this stage the same emission. */
  dedupeKey: string;
  /** Why the mapping is what it is, including deliberate omissions. */
  note: string;
}

export const CANONICAL_EVENT_MATRIX: readonly CanonicalEventMapping[] = [
  {
    stage: 'page_view',
    ga4Event: 'page_view',
    ga4Source: 'src/components/analytics-page-view.tsx -> src/lib/analytics.ts trackPageView()',
    metaBrowserEvent: 'PageView',
    metaServerEvent: null,
    redditEvent: 'PageVisit',
    owner: 'browser',
    dedupeKey: 'sanitized template route per navigation',
    note:
      'GA4 already fires one page_view per pathname with query stripped. Meta PageView '
      + 'mirrors that, but only on the public funnel routes in META_TRACKABLE_ROUTES; every '
      + 'other route (checkout returns, proofs, family review, admin) stays silent.',
  },
  {
    stage: 'view_product',
    ga4Event: null,
    ga4Source: null,
    metaBrowserEvent: null,
    metaServerEvent: null,
    redditEvent: null,
    owner: 'browser',
    dedupeKey: 'n/a — not emitted',
    note:
      'DEFERRED, NOT GUESSED. No live surface fires a discrete product-view event today. '
      + 'The closest existing emission is cover_variant_shown (src/components/CoverPreview.tsx), '
      + 'which is an A/B variant impression, not a product view. Mapping ViewContent onto it '
      + 'would report an experiment artefact as shopping intent. Requires a real product-view '
      + 'surface before it is mapped.',
  },
  {
    stage: 'begin_checkout',
    ga4Event: 'begin_checkout',
    ga4Source: 'src/app/checkout/checkout-form.tsx:460 -> src/lib/analytics.ts track()',
    metaBrowserEvent: 'InitiateCheckout',
    metaServerEvent: null,
    redditEvent: 'AddToCart',
    owner: 'browser',
    dedupeKey: 'one per checkout page mount',
    note:
      'The existing begin_checkout fires once on checkout mount. Meta InitiateCheckout is '
      + 'derived from that same emission through the bridge, so the two cannot drift. Its '
      + 'HSB parameters (childName hints, photo/voice booleans, family counts) are NOT '
      + 'forwarded — only the allowlisted scalars below.',
  },
  {
    stage: 'purchase',
    ga4Event: 'purchase',
    ga4Source: 'src/lib/ga4-purchase.ts sendGa4Purchase(), called from src/app/api/webhooks/stripe/route.ts',
    metaBrowserEvent: null,
    metaServerEvent: 'Purchase',
    redditEvent: 'Purchase',
    owner: 'stripe_webhook',
    dedupeKey: 'Stripe Checkout Session id — GA4 transaction_id, Meta event_id (hashed)',
    note:
      'Server only, from the signed and payment-converged Stripe path. GA4 receives the raw '
      + 'Session id as transaction_id (existing, unchanged). Meta receives only a hash of it as '
      + 'event_id and no transaction identifier at all. A browser Purchase is prohibited by '
      + 'contract and by META_BROWSER_EVENT_ALLOWLIST.',
  },
];

/** Standard Meta events the browser adapter will accept. Purchase is absent. */
export const META_BROWSER_EVENT_ALLOWLIST = ['PageView', 'ViewContent', 'InitiateCheckout'] as const;
export type MetaBrowserEvent = (typeof META_BROWSER_EVENT_ALLOWLIST)[number];

/** Standard Meta events the server adapter will accept. */
export const META_SERVER_EVENT_ALLOWLIST = ['Purchase'] as const;
export type MetaServerEvent = (typeof META_SERVER_EVENT_ALLOWLIST)[number];

/** Explicitly prohibited in the browser, listed so the ban is greppable. */
export const META_BROWSER_PROHIBITED_EVENTS = ['Purchase', 'Subscribe', 'StartTrial', 'Lead', 'CompleteRegistration'] as const;

/**
 * Safe scalar parameters, per browser event. Anything not listed is dropped —
 * the adapter never passes an unknown key through, so a future caller cannot
 * widen the payload by accident.
 */
export const META_BROWSER_PARAM_ALLOWLIST: Readonly<Record<MetaBrowserEvent, readonly string[]>> = {
  PageView: [],
  ViewContent: ['content_type', 'content_category'],
  InitiateCheckout: ['content_type', 'content_category', 'num_items'],
};

/**
 * Allowlisted values for the two free-ish string params above. Bounding the
 * values as well as the keys is what stops `content_category: <child name>`.
 */
export const META_CONTENT_TYPE_ALLOWLIST = ['product'] as const;
export const META_CONTENT_CATEGORY_ALLOWLIST = ['storybook'] as const;

/**
 * Field names that must never appear anywhere in a Meta payload, browser or
 * server. Checked structurally by assertNoBlockedFields, not by hope.
 *
 * `user_data` and the hashed-identity keys are absent because this candidate
 * carries NO Advanced Matching and NO customer identity, and a separate privacy
 * approval does not exist. `client_ip_address` / `client_user_agent` are absent
 * for the same reason: forwarding them is an identity decision, not a plumbing
 * detail.
 */
export const META_BLOCKED_FIELD_NAMES: readonly string[] = [
  'user_data', 'advanced_matching', 'external_id',
  'em', 'ph', 'fn', 'ln', 'ge', 'db', 'ct', 'st', 'zp', 'country',
  'client_ip_address', 'client_user_agent', 'fbp', 'fbc',
  'email', 'phone', 'name', 'first_name', 'last_name', 'child_name', 'childName',
  'address', 'shipping', 'order_id', 'orderId', 'transaction_id', 'session_id',
  'review_token', 'reviewToken', 'capability', 'asset_url', 'assetUrl',
  'photo', 'photo_url', 'voice', 'notes', 'message', 'free_text',
];

/**
 * Substrings that mark a value as unsafe regardless of which key carries it.
 * These are the identifier prefixes and shapes this repo actually mints.
 */
const BLOCKED_VALUE_PATTERNS: readonly RegExp[] = [
  // Stripe ids carry further underscores after the prefix (cs_live_..., pi_3...),
  // so the body must admit them or `cs_live_abc123` slips through.
  /\b(?:cs|pi|sub|cus|seti|evt|ch|in|re|py|txn)_[A-Za-z0-9_]{8,}/,
  /\bord_[A-Za-z0-9_]{6,}/,
  /[0-9a-f]{16,}/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /https?:\/\/[^\s"']*\.(?:public\.)?blob\.vercel-storage\.com/i,
];

/**
 * The one deliberate exemption: HSB's purchase dedupe pseudonym, `hsb_` plus a
 * 32-character digest (see deriveMetaEventId in ./meta-capi.ts). It is hex by
 * construction, so the generic identifier-shape rule below would otherwise
 * reject the very field that makes deduplication possible.
 *
 * Anchored and fixed-length on purpose. A value that merely CONTAINS this shape
 * is still rejected, so a session id cannot be smuggled through by prefixing it.
 */
const HSB_DEDUPE_PSEUDONYM_RE = /^hsb_[0-9a-f]{32}$/;

export class BlockedMetaFieldError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`Meta payload rejected: ${detail} (${field})`);
    this.name = 'BlockedMetaFieldError';
    this.field = field;
  }
}

/**
 * Walk a payload and throw on any blocked key or identifier-shaped value.
 *
 * This is a guard, not a sanitiser: it refuses to send rather than quietly
 * removing the offending field, because a payload that reached this point with
 * a child's name in it means an upstream caller is wrong and must be fixed.
 */
export function assertNoBlockedFields(payload: unknown, path = '$'): void {
  if (payload === null || payload === undefined) return;

  if (typeof payload === 'string') {
    if (HSB_DEDUPE_PSEUDONYM_RE.test(payload)) return;
    for (const pattern of BLOCKED_VALUE_PATTERNS) {
      if (pattern.test(payload)) {
        throw new BlockedMetaFieldError(path, 'value looks like an identifier, email, or asset URL');
      }
    }
    return;
  }

  if (typeof payload === 'number' || typeof payload === 'boolean') return;

  if (Array.isArray(payload)) {
    payload.forEach((item, index) => assertNoBlockedFields(item, `${path}[${index}]`));
    return;
  }

  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (META_BLOCKED_FIELD_NAMES.includes(key)) {
        throw new BlockedMetaFieldError(`${path}.${key}`, 'blocked field name');
      }
      assertNoBlockedFields(value, `${path}.${key}`);
    }
    return;
  }

  throw new BlockedMetaFieldError(path, `unsupported value type ${typeof payload}`);
}

export type ParamFilterResult = {
  params: Record<string, string | number>;
  dropped: string[];
};

/**
 * Reduce caller-supplied parameters to the allowlist for one browser event.
 * Unknown keys, non-scalars, and out-of-vocabulary strings are dropped and
 * reported so a test can assert the drop happened.
 */
export function filterBrowserParams(
  event: MetaBrowserEvent,
  input: Record<string, unknown> = {},
): ParamFilterResult {
  const allowed = META_BROWSER_PARAM_ALLOWLIST[event] ?? [];
  const params: Record<string, string | number> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (!allowed.includes(key)) { dropped.push(key); continue; }
    if (key === 'num_items') {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 20) params[key] = value;
      else dropped.push(key);
      continue;
    }
    if (typeof value !== 'string') { dropped.push(key); continue; }
    const vocabulary = key === 'content_type' ? META_CONTENT_TYPE_ALLOWLIST : META_CONTENT_CATEGORY_ALLOWLIST;
    if ((vocabulary as readonly string[]).includes(value)) params[key] = value;
    else dropped.push(key);
  }

  return { params, dropped };
}

export function isAllowlistedBrowserEvent(name: string): name is MetaBrowserEvent {
  return (META_BROWSER_EVENT_ALLOWLIST as readonly string[]).includes(name);
}

export function isAllowlistedServerEvent(name: string): name is MetaServerEvent {
  return (META_SERVER_EVENT_ALLOWLIST as readonly string[]).includes(name);
}

/** Look up one canonical stage. */
export function mappingForStage(stage: CanonicalStage): CanonicalEventMapping {
  const mapping = CANONICAL_EVENT_MATRIX.find((entry) => entry.stage === stage);
  if (!mapping) throw new Error(`Unknown canonical stage: ${stage}`);
  return mapping;
}

/**
 * The HSB funnel events that the browser bridge translates into Meta events.
 * Every other HsbEventName stays GA4-only. Keyed by the event name that
 * `src/lib/analytics.ts` already emits, so the bridge cannot invent a source.
 */
export const HSB_EVENT_TO_META_BROWSER: Readonly<Record<string, MetaBrowserEvent>> = {
  begin_checkout: 'InitiateCheckout',
};
