/**
 * Governed UTM contract for Hero Story Books.
 *
 * WHY THIS EXISTS. Today `src/lib/analytics.ts` reads whatever `utm_*` values
 * happen to be in the URL, truncates them to 160 characters, and forwards them
 * to GA4 and Vercel Analytics. Nothing validates them, so a partner who pastes
 * a parent's email into `utm_content` puts that email into an analytics
 * platform. This module is the single place that decides which UTM values HSB
 * is willing to carry, and it fails closed: a value that is not provably safe
 * is dropped, never truncated-and-forwarded.
 *
 * SCOPE. Pure functions only. No DOM, no network, no environment reads, no
 * imports outside this file — so it is directly unit-testable and safe to run
 * on both the server and the browser.
 *
 * NOT A RENAME. This module does not change what `src/lib/analytics.ts`
 * currently sends. It is the contract that the marketing measurement candidate
 * and the experiment board validate against. Adopting it inside the existing
 * GA4 path is a separate, reviewed change.
 */

/**
 * The four governed fields. `utm_term` is deliberately absent: it exists in the
 * current analytics capture list but HSB has no paid-search programme, and an
 * unowned field is a field nobody validates.
 */
export const GOVERNED_UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const;

export type GovernedUtmField = (typeof GOVERNED_UTM_FIELDS)[number];

export type GovernedUtms = Partial<Record<GovernedUtmField, string>>;

/**
 * Closed vocabulary for `utm_medium`. A medium says how the visit was paid for
 * and who is accountable for it, which is exactly the kind of fact that must
 * not be invented per-link. Adding a value here is a reviewed act.
 *
 *  - partner        school / parent-group / community partnership link
 *  - flyer          printed handout or QR code
 *  - email          HSB-sent or partner-sent email
 *  - organic_social unpaid social post
 *  - paid_social    paid placement; requires a spend approval and a cap
 *  - referral       word-of-mouth or an existing customer link
 */
export const UTM_MEDIUM_ALLOWLIST = [
  'partner',
  'flyer',
  'email',
  'organic_social',
  'paid_social',
  'referral',
] as const;

/** Mediums that may only appear on a row carrying an approved spend cap. */
export const PAID_UTM_MEDIUMS = new Set<string>(['paid_social']);

/** Maximum characters for any governed value. Short enough to be a label. */
export const UTM_VALUE_MAX_LENGTH = 40;

/**
 * Deterministic token shape: lowercase, starts alphanumeric, then alphanumeric
 * plus `_` and `-`. Matches the shape `src/lib/checkout-tracking.ts` already
 * enforces for cohort/invite so operators learn one rule, not two.
 */
const UTM_TOKEN_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Values that pass the token shape but still look like a person, an account, or
 * an internal identifier. Each pattern is here because the token rule alone
 * cannot catch it:
 *
 *  - mailbox providers    a hand-mangled email ("jane-at-gmail-com")
 *  - `-at-` / `_at_`      the same mangling without a known provider
 *  - 7+ digit runs        phone numbers, ZIPs with suffixes, numeric ids
 *  - 16+ hex runs         HSB order ids (16-char hex) and blob path scopes
 *  - Stripe/HSB prefixes  cs_/pi_/sub_/ord_/ch_/in_ identifiers
 *  - review/proof tokens  anything announcing itself as a token or key
 */
const PII_LIKE_PATTERNS: readonly RegExp[] = [
  /(?:gmail|yahoo|hotmail|outlook|icloud|proton|aol)/,
  /(?:^|[_-])at[_-]/,
  /\d{7,}/,
  /[0-9a-f]{16,}/,
  /^(?:cs|pi|sub|ord|ch|in|cus|seti|evt)_/,
  /(?:token|secret|apikey|api_key|passwd|password|bearer)/,
];

export type UtmRejectionReason =
  | 'not_a_string'
  | 'empty'
  | 'too_long'
  | 'malformed'
  | 'pii_like'
  | 'medium_not_allowlisted';

/**
 * Result shape, written as one optional-field object rather than a
 * discriminated union. This project compiles with `strict: false`, where
 * TypeScript will not narrow a union on a boolean literal discriminant, so a
 * union here would make `result.reason` a type error at every call site.
 */
export interface UtmFieldResult {
  ok: boolean;
  value?: string;
  reason?: UtmRejectionReason;
}

/**
 * True when a token-shaped value still looks like personal or internal data.
 * Exported so the experiment-board validator can reject a planned link before
 * anyone prints it on a flyer.
 */
export function isPiiLikeUtmValue(value: string): boolean {
  return PII_LIKE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Lowercase and trim only. Deliberately not a "cleaner": we do not strip spaces
 * or punctuation to coerce a bad value into a good one, because a coerced value
 * silently changes which experiment a visit is attributed to.
 */
export function normalizeUtmValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** Validate one governed field. Fails closed with a machine-readable reason. */
export function validateUtmField(field: GovernedUtmField, raw: unknown): UtmFieldResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };
  const value = normalizeUtmValue(raw);
  if (value === null) return { ok: false, reason: 'empty' };
  if (value.length > UTM_VALUE_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (!UTM_TOKEN_RE.test(value)) return { ok: false, reason: 'malformed' };
  if (isPiiLikeUtmValue(value)) return { ok: false, reason: 'pii_like' };
  if (field === 'utm_medium' && !(UTM_MEDIUM_ALLOWLIST as readonly string[]).includes(value)) {
    return { ok: false, reason: 'medium_not_allowlisted' };
  }
  return { ok: true, value };
}

export interface GovernedUtmParseResult {
  /** Only the fields that passed validation. */
  utms: GovernedUtms;
  /** Every field that was present but rejected, with the reason. */
  rejected: { field: GovernedUtmField; reason: UtmRejectionReason }[];
}

/**
 * Read the governed fields out of an arbitrary parameter bag. A rejected field
 * is dropped, not truncated: partial attribution beats leaked attribution.
 */
export function parseGovernedUtms(
  params: URLSearchParams | Record<string, unknown>,
): GovernedUtmParseResult {
  const read = (key: string): unknown =>
    params instanceof URLSearchParams ? params.get(key) : (params as Record<string, unknown>)[key];

  const utms: GovernedUtms = {};
  const rejected: { field: GovernedUtmField; reason: UtmRejectionReason }[] = [];

  for (const field of GOVERNED_UTM_FIELDS) {
    const raw = read(field);
    if (raw === null || raw === undefined || raw === '') continue;
    const result = validateUtmField(field, raw);
    if (result.ok) utms[field] = result.value;
    else rejected.push({ field, reason: result.reason });
  }

  return { utms, rejected };
}

/**
 * A complete governed tuple: source + medium + campaign are required, content
 * is the optional partner/creative discriminator.
 */
export interface GovernedUtmTuple {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content?: string;
}

/** Same optional-field shape, for the same `strict: false` reason. */
export interface UtmTupleResult {
  ok: boolean;
  tuple?: GovernedUtmTuple;
  errors?: string[];
}

/** Validate a full tuple, as an experiment row must declare it. */
export function validateUtmTuple(raw: unknown): UtmTupleResult {
  const errors: string[] = [];
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, errors: ['utm must be an object with source, medium, and campaign'] };
  }
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!(GOVERNED_UTM_FIELDS as readonly string[]).includes(key)) {
      errors.push(`utm.${key} is not a governed field`);
    }
  }

  const resolved: Record<string, string> = {};
  for (const field of GOVERNED_UTM_FIELDS) {
    const present = input[field] !== undefined && input[field] !== null && input[field] !== '';
    if (!present) {
      if (field !== 'utm_content') errors.push(`utm.${field} is required`);
      continue;
    }
    const result = validateUtmField(field, input[field]);
    if (result.ok) resolved[field] = result.value;
    else errors.push(`utm.${field} rejected: ${result.reason}`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    tuple: {
      utm_source: resolved.utm_source,
      utm_medium: resolved.utm_medium,
      utm_campaign: resolved.utm_campaign,
      ...(resolved.utm_content ? { utm_content: resolved.utm_content } : {}),
    },
  };
}

/**
 * Collision key for a governed tuple. Two experiments sharing this key cannot
 * be told apart in GA4, so the board validator rejects the pair.
 */
export function utmTupleKey(tuple: GovernedUtmTuple): string {
  return [tuple.utm_source, tuple.utm_medium, tuple.utm_campaign, tuple.utm_content ?? ''].join('|');
}

/** Render the governed tuple as the query string a partner link must carry. */
export function utmQueryString(tuple: GovernedUtmTuple): string {
  const params = new URLSearchParams();
  params.set('utm_source', tuple.utm_source);
  params.set('utm_medium', tuple.utm_medium);
  params.set('utm_campaign', tuple.utm_campaign);
  if (tuple.utm_content) params.set('utm_content', tuple.utm_content);
  return params.toString();
}
