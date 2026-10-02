/**
 * Campaign governance: one closed naming convention and a machine-readable
 * experiment registry.
 *
 * The campaign vocabulary IS the Phase-A attribution allowlist: every
 * source/medium/campaign/content value is checked by `sanitizeAttributionValue`
 * itself, so a governed link can never carry a label the landing capture would
 * drop, and the registry can never approve one. `utm_term` does not exist
 * here. A landing path is one approved public route template.
 *
 * The registry holds exactly: business, a normalized experiment id, the
 * governed segment (source, medium, campaign, content, landing path), a date
 * window, status, an integer-minor-unit budget in the registry's single
 * currency, exactly one primary outcome, minimum denominator/event thresholds,
 * and the decision. There is no free-text field. Every string is screened for
 * PII-, URL- and identifier-shaped values before any vocabulary check, and
 * issues are reported as value-free `CODE@$.path` strings.
 *
 * Isomorphic and dependency-light; field names mirror the offline decision
 * packet's experiment registry so the mapping contract is field-for-field.
 */
import { APPROVED_PUBLIC_ROUTE_TEMPLATES } from './analytics-event-contract.ts';
import { captureAttributionTouch, sanitizeAttributionValue } from './attribution-contract.ts';
import { PRODUCTION_ORIGIN } from './site-url.ts';

export const EXPERIMENT_REGISTRY_SCHEMA = 'hsb.experiment_registry';
export const EXPERIMENT_REGISTRY_VERSION = 1;

// ── Governed vocabulary (Phase-A canonical values) ──────────────────────────

export const CAMPAIGN_SOURCE_VALUES = Object.freeze([
  'facebook', 'instagram', 'google', 'bing', 'newsletter', 'pinterest', 'youtube', 'tiktok', 'telegram',
] as const);
export const CAMPAIGN_MEDIUM_VALUES = Object.freeze(['paid_social', 'social', 'email', 'cpc', 'organic', 'referral'] as const);
export const CAMPAIGN_CONTENT_VALUES: readonly string[] = Object.freeze(
  ['video', 'image', 'carousel', 'text'].flatMap((format) => ['a', 'b', 'c'].map((variant) => `${format}-${variant}`)),
);

export const DATA_ORIGINS = Object.freeze(['synthetic_fixture', 'operator_export'] as const);
export const EXPERIMENT_STATUSES = Object.freeze(['planned', 'running', 'paused', 'completed', 'cancelled'] as const);
export const OPEN_STATUSES: readonly string[] = Object.freeze(['planned', 'running', 'paused']);
export const DECISIONS = Object.freeze(['pending', 'continue', 'scale', 'iterate', 'stop'] as const);
/** ISO 4217 codes the offline packet understands; a registry holds exactly one. */
export const KNOWN_CURRENCIES = Object.freeze(['USD', 'CAD', 'EUR', 'GBP'] as const);
export const REGISTRY_CURRENCIES = Object.freeze(['USD'] as const);

export const PRIMARY_OUTCOMES = Object.freeze([
  'qualified_action_rate',
  'checkout_start_rate',
  'paid_order_rate',
  'paid_per_qualified_rate',
  'net_revenue_per_session',
] as const);
export type PrimaryOutcome = (typeof PRIMARY_OUTCOMES)[number];

/**
 * What each primary outcome is measured from: GA4 behavior, application
 * outcomes, or the payment ledger. Never Meta, whose server path is DEFERRED;
 * never a GA4 purchase event, which is behavioral and not payment authority.
 */
export const PRIMARY_OUTCOME_EVIDENCE: Readonly<Record<PrimaryOutcome, { events: string; denominator: string }>> = Object.freeze({
  qualified_action_rate: Object.freeze({ events: 'app.qualified_actions', denominator: 'ga4.sessions' }),
  checkout_start_rate: Object.freeze({ events: 'ga4.checkout_starts', denominator: 'ga4.sessions' }),
  paid_order_rate: Object.freeze({ events: 'ledger.paid_orders', denominator: 'ga4.sessions' }),
  paid_per_qualified_rate: Object.freeze({ events: 'ledger.paid_orders', denominator: 'app.qualified_actions' }),
  net_revenue_per_session: Object.freeze({ events: 'ledger.paid_orders', denominator: 'ga4.sessions' }),
});

const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  planned: ['planned', 'running', 'cancelled'],
  running: ['running', 'paused', 'completed', 'cancelled'],
  paused: ['paused', 'running', 'completed', 'cancelled'],
  completed: ['completed'],
  cancelled: ['cancelled'],
});
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const NEW_EXPERIMENT_STATUSES = new Set(['planned', 'running']);

const MAX_ISSUES = 50;
const MAX_EXPERIMENTS = 500;
const MAX_BUDGET_MINOR = 1_000_000_000_000;
const MAX_COUNT = 1_000_000_000;
const MAX_VALUE_LENGTH = 96;

// ── PII / identifier / free-text screening ──────────────────────────────────

const URL_RE = /:\/\/|^\/\/|^www\.|\.(?:com|net|org|io|co|us|app|dev|ai|info|biz|edu|gov)(?:[/:?#]|$)/i;
const QUERY_RE = /[?&=#%]/;
const PROVIDER_PREFIXES = [
  'acct', 'ba', 'bpc', 'card', 'ch', 'cn', 'cs', 'cus', 'dp', 'du', 'evt', 'fr', 'ic', 'ii', 'il', 'in', 'ipi',
  'pi', 'pm', 'po', 'price', 'prod', 'promo', 'py', 'pyr', 're', 'seti', 'si', 'src', 'sub', 'tok', 'tr', 'trr',
  'txn', 'txr',
];
// Provider ids carry a random body with an uppercase letter or digit, so a
// lowercase word after a prefix is a naming slip, not an id.
const PROVIDER_ID_RE = new RegExp(
  `(?<![A-Za-z0-9])(?:${PROVIDER_PREFIXES.join('|')})_(?:test_|live_)?(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{8,}`,
);
const ORDER_ID_RE = /(?<![A-Za-z0-9])ord_[A-Za-z0-9]{6,}/i;
const GA_CLIENT_ID_RE = /(?<!\d)\d{6,}\.\d{6,}(?!\d)|^GA\d\.\d/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PHONE_RE = /(?<!\d)\(?\d{3}\)?[-.]?\d{3}[-.]\d{4}(?!\d)/;
const OPAQUE_TOKEN_RE = /(?<![0-9A-Za-z])[0-9a-f]{32,}(?![0-9A-Za-z])|[A-Za-z0-9]{33,}/i;
const NUMERIC_ID_RE = /\d{7,}/;

const ORDERED_VALUE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['URL', URL_RE],
  ['QUERY_STRING', QUERY_RE],
  ['PROVIDER_ID', PROVIDER_ID_RE],
  ['ORDER_ID', ORDER_ID_RE],
  ['GA_CLIENT_ID', GA_CLIENT_ID_RE],
  ['UUID', UUID_RE],
  ['PHONE', PHONE_RE],
  ['OPAQUE_TOKEN', OPAQUE_TOKEN_RE],
  ['NUMERIC_IDENTIFIER', NUMERIC_ID_RE],
];

/** A category code when `value` looks like free text, a URL, PII or an identifier; otherwise null. */
export function forbiddenValueCode(value: string): string | null {
  if (/\s/.test(value)) return 'FREE_TEXT';
  if (/[^\x21-\x7e]/.test(value)) return 'NON_ASCII';
  if (value.length > MAX_VALUE_LENGTH) return 'FREE_TEXT';
  if (value.includes('@')) return 'EMAIL';
  for (const [code, pattern] of ORDERED_VALUE_PATTERNS) if (pattern.test(value)) return code;
  return null;
}

const FORBIDDEN_KEY_TOKENS = new Set([
  'email', 'mail', 'phone', 'tel', 'mobile', 'name', 'firstname', 'lastname', 'fullname', 'child', 'kid',
  'customer', 'user', 'buyer', 'payer', 'person', 'member', 'account', 'order', 'receipt', 'transaction', 'txn',
  'stripe', 'payment', 'charge', 'invoice', 'checkout', 'session', 'client', 'cid', 'gclid', 'fbclid', 'fbp',
  'fbc', 'ga', 'url', 'uri', 'href', 'link', 'referrer', 'referer', 'location', 'query', 'utm', 'term', 'note',
  'notes', 'comment', 'comments', 'description', 'message', 'memo', 'text', 'hypothesis', 'details', 'remarks',
  'address', 'street', 'zip', 'postal', 'city', 'ip', 'property',
]);

/** Unknown keys are always rejected; the code only says whether the key itself looks sensitive. */
export function forbiddenKeyCode(key: string): 'FORBIDDEN_KEY' | 'UNKNOWN_KEY' {
  if (forbiddenValueCode(key) !== null) return 'FORBIDDEN_KEY';
  const tokens = key.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '_').toLowerCase().match(/[a-z]+|[0-9]+/g) ?? [];
  const joined = tokens.join('');
  return tokens.some((token) => FORBIDDEN_KEY_TOKENS.has(token)) || FORBIDDEN_KEY_TOKENS.has(joined)
    ? 'FORBIDDEN_KEY'
    : 'UNKNOWN_KEY';
}

// ── Issue collection ────────────────────────────────────────────────────────

export class IssueCollector {
  readonly issues: string[] = [];

  add(code: string, path: string): void {
    const issue = `${code}@${path}`;
    if (this.issues.includes(issue) || this.issues.length > MAX_ISSUES) return;
    this.issues.push(this.issues.length === MAX_ISSUES ? 'TOO_MANY_ISSUES@$' : issue);
  }

  get count(): number {
    return this.issues.length;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Exact keys: unknown keys are classified, missing keys named. Returns false when the value is not an object. */
export function checkClosedObject(value: unknown, keys: readonly string[], path: string, out: IssueCollector): value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    out.add('TYPE_OBJECT', path);
    return false;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) out.add(forbiddenKeyCode(key), path);
  for (const key of keys) if (!hasOwn(value, key)) out.add(`MISSING_KEY:${key}`, path);
  return true;
}

/** A string that passes PII/identifier screening, or null after recording why not. */
export function screenedString(value: unknown, path: string, out: IssueCollector): string | null {
  if (typeof value !== 'string') {
    out.add('TYPE_STRING', path);
    return null;
  }
  const code = forbiddenValueCode(value);
  if (code) {
    out.add(`FORBIDDEN_VALUE:${code}`, path);
    return null;
  }
  return value;
}

export function enumValue<T extends string>(values: readonly T[], value: unknown, path: string, out: IssueCollector): T | null {
  const text = screenedString(value, path, out);
  if (text === null) return null;
  if (!(values as readonly string[]).includes(text)) {
    out.add('INVALID_ENUM', path);
    return null;
  }
  return text as T;
}

export function integerValue(value: unknown, min: number, max: number, path: string, out: IssueCollector): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    out.add('TYPE_INTEGER', path);
    return null;
  }
  if (value < min || value > max) {
    out.add('INTEGER_OUT_OF_RANGE', path);
    return null;
  }
  return value;
}

/**
 * An exact YYYY-MM-DD calendar date between 0001-01-01 and 9999-12-31. Year
 * zero exists in ISO 8601 and in JavaScript's Date, but not in the pinned
 * decision packet's calendar (`date.fromisoformat`), so it is not a date here.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function dateValue(value: unknown, path: string, out: IssueCollector): string | null {
  if (typeof value !== 'string') {
    out.add('TYPE_STRING', path);
    return null;
  }
  if (!isCalendarDate(value)) {
    out.add('INVALID_DATE', path);
    return null;
  }
  return value;
}

type UtmField = 'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content';

/** A governed campaign label: Phase-A canonical, or a precise reason it is not. */
function governedValue(key: UtmField, value: unknown, path: string, out: IssueCollector): string | null {
  const text = screenedString(value, path, out);
  if (text === null) return null;
  const canonical = sanitizeAttributionValue(key, text);
  if (canonical === text) return text;
  out.add(canonical === null ? 'VALUE_NOT_GOVERNED' : 'VALUE_NOT_CANONICAL', path);
  return null;
}

// ── Experiments ─────────────────────────────────────────────────────────────

const REGISTRY_KEYS = ['schema', 'schema_version', 'data_origin', 'business', 'currency', 'experiments'] as const;
const EXPERIMENT_KEYS = [
  'experiment_id', 'business', 'status', 'start_date', 'end_date', 'source', 'medium', 'campaign', 'content',
  'landing_path', 'budget', 'primary_outcome', 'evidence_threshold', 'decision',
] as const;
const EXPERIMENT_ID_RE = /^hsb_exp_202[6-9]_(?!000)\d{3}$/;

export interface GovernedExperiment {
  experimentId: string;
  status: (typeof EXPERIMENT_STATUSES)[number];
  startDate: string;
  endDate: string;
  source: string;
  medium: string;
  campaign: string;
  content: string | null;
  landingPath: string;
  budgetMinor: number;
  budgetCurrency: string;
  primaryOutcome: PrimaryOutcome;
  minDenominator: number;
  minEvents: number;
  decision: (typeof DECISIONS)[number];
}

function parseExperiment(
  value: unknown,
  path: string,
  registryCurrency: string | null,
  out: IssueCollector,
): GovernedExperiment | null {
  const before = out.count;
  if (!checkClosedObject(value, EXPERIMENT_KEYS, path, out)) return null;
  const at = (field: string) => `${path}.${field}`;

  let experimentId: string | null = screenedString(value.experiment_id, at('experiment_id'), out);
  if (experimentId !== null && !EXPERIMENT_ID_RE.test(experimentId)) {
    out.add('EXPERIMENT_ID_FORMAT', at('experiment_id'));
    experimentId = null;
  }
  enumValue(['hsb'], value.business, at('business'), out);
  const status = enumValue(EXPERIMENT_STATUSES, value.status, at('status'), out);
  const startDate = dateValue(value.start_date, at('start_date'), out);
  const endDate = dateValue(value.end_date, at('end_date'), out);
  const source = governedValue('utm_source', value.source, at('source'), out);
  const medium = governedValue('utm_medium', value.medium, at('medium'), out);
  const campaign = governedValue('utm_campaign', value.campaign, at('campaign'), out);
  const content = value.content === null ? null : governedValue('utm_content', value.content, at('content'), out);

  const landingPath = screenedString(value.landing_path, at('landing_path'), out);
  if (landingPath !== null && !APPROVED_PUBLIC_ROUTE_TEMPLATES.includes(landingPath)) {
    out.add('LANDING_PATH_NOT_APPROVED', at('landing_path'));
  }

  let budgetMinor: number | null = null;
  let budgetCurrency: string | null = null;
  if (checkClosedObject(value.budget, ['amount_minor', 'currency'], at('budget'), out)) {
    budgetMinor = integerValue(value.budget.amount_minor, 0, MAX_BUDGET_MINOR, at('budget.amount_minor'), out);
    budgetCurrency = enumValue(KNOWN_CURRENCIES, value.budget.currency, at('budget.currency'), out);
    if (budgetCurrency !== null && registryCurrency !== null && budgetCurrency !== registryCurrency) {
      out.add('MIXED_CURRENCY', at('budget.currency'));
    }
  }

  let primaryOutcome: PrimaryOutcome | null = null;
  if (Array.isArray(value.primary_outcome)) out.add('MULTIPLE_PRIMARY_OUTCOMES', at('primary_outcome'));
  else primaryOutcome = enumValue(PRIMARY_OUTCOMES, value.primary_outcome, at('primary_outcome'), out);

  let minDenominator: number | null = null;
  let minEvents: number | null = null;
  if (checkClosedObject(value.evidence_threshold, ['min_denominator', 'min_events'], at('evidence_threshold'), out)) {
    minDenominator = integerValue(value.evidence_threshold.min_denominator, 1, MAX_COUNT, at('evidence_threshold.min_denominator'), out);
    minEvents = integerValue(value.evidence_threshold.min_events, 1, MAX_COUNT, at('evidence_threshold.min_events'), out);
  }
  const decision = enumValue(DECISIONS, value.decision, at('decision'), out);

  if (out.count !== before) return null;
  return {
    experimentId: experimentId!,
    status: status!,
    startDate: startDate!,
    endDate: endDate!,
    source: source!,
    medium: medium!,
    campaign: campaign!,
    content,
    landingPath: landingPath!,
    budgetMinor: budgetMinor!,
    budgetCurrency: budgetCurrency!,
    primaryOutcome: primaryOutcome!,
    minDenominator: minDenominator!,
    minEvents: minEvents!,
    decision: decision!,
  };
}

function segmentKey(experiment: GovernedExperiment): string {
  return JSON.stringify([experiment.source, experiment.medium, experiment.campaign, experiment.content, experiment.landingPath]);
}

export interface ParsedRegistry {
  issues: string[];
  experiments: GovernedExperiment[];
}

function parseRegistry(doc: unknown): ParsedRegistry {
  const out = new IssueCollector();
  const fail = (): ParsedRegistry => ({ issues: out.issues, experiments: [] });
  if (!isPlainRecord(doc)) {
    out.add('DOCUMENT_NOT_OBJECT', '$');
    return fail();
  }
  if (doc.schema !== EXPERIMENT_REGISTRY_SCHEMA) {
    out.add('SCHEMA_INVALID', '$.schema');
    return fail();
  }
  if (doc.schema_version !== EXPERIMENT_REGISTRY_VERSION) {
    out.add('SCHEMA_VERSION_UNSUPPORTED', '$.schema_version');
    return fail();
  }
  checkClosedObject(doc, REGISTRY_KEYS, '$', out);
  enumValue(DATA_ORIGINS, doc.data_origin, '$.data_origin', out);
  enumValue(['hsb'], doc.business, '$.business', out);
  const registryCurrency = enumValue(REGISTRY_CURRENCIES, doc.currency, '$.currency', out);
  if (!Array.isArray(doc.experiments)) {
    out.add('TYPE_ARRAY', '$.experiments');
    return fail();
  }
  if (doc.experiments.length > MAX_EXPERIMENTS) {
    out.add('TOO_MANY_ITEMS', '$.experiments');
    return fail();
  }

  const parsed = doc.experiments.map((item, index) => parseExperiment(item, `$.experiments[${index}]`, registryCurrency, out));
  const seen = new Set<string>();
  const windowed: Array<{ index: number; experiment: GovernedExperiment }> = [];
  parsed.forEach((experiment, index) => {
    if (!experiment) return;
    const path = `$.experiments[${index}]`;
    if (seen.has(experiment.experimentId)) out.add('DUPLICATE_EXPERIMENT_ID', `${path}.experiment_id`);
    seen.add(experiment.experimentId);
    if (experiment.startDate > experiment.endDate) {
      out.add('DATE_WINDOW_INVALID', path);
      return;
    }
    if (OPEN_STATUSES.includes(experiment.status) && experiment.decision !== 'pending') {
      out.add('DECISION_BEFORE_COMPLETION', `${path}.decision`);
    }
    // One governed segment cannot run two experiments at once: their traffic
    // is indistinguishable. Cancelled windows count too, as in the packet.
    const overlapping = windowed.some(({ experiment: earlier }) => segmentKey(earlier) === segmentKey(experiment)
      && earlier.startDate <= experiment.endDate && experiment.startDate <= earlier.endDate);
    if (overlapping) out.add('EXPERIMENT_OVERLAP', path);
    windowed.push({ index, experiment });
  });
  return { issues: out.issues, experiments: parsed.filter((item): item is GovernedExperiment => item !== null) };
}

/** Value-free `CODE@$.path` issues; an empty array means the registry is governed. */
export function validateExperimentRegistry(doc: unknown): string[] {
  return parseRegistry(doc).issues;
}

/** The parsed experiments of a registry that validates, or its issues and none. */
export function parseGovernedRegistry(doc: unknown): ParsedRegistry {
  const parsed = parseRegistry(doc);
  return parsed.issues.length > 0 ? { issues: parsed.issues, experiments: [] } : parsed;
}

/** Fields that define what an experiment measures; frozen once it leaves `planned`. */
const IMMUTABLE_AFTER_START: ReadonlyArray<readonly [keyof GovernedExperiment, string]> = [
  ['source', 'source'],
  ['medium', 'medium'],
  ['campaign', 'campaign'],
  ['content', 'content'],
  ['landingPath', 'landing_path'],
  ['startDate', 'start_date'],
  ['primaryOutcome', 'primary_outcome'],
  ['minDenominator', 'evidence_threshold.min_denominator'],
  ['minEvents', 'evidence_threshold.min_events'],
  ['budgetCurrency', 'budget.currency'],
];
const IMMUTABLE_WHEN_TERMINAL: ReadonlyArray<readonly [keyof GovernedExperiment, string]> = [
  ['endDate', 'end_date'],
  ['budgetMinor', 'budget.amount_minor'],
];

/**
 * A registry change is valid when both versions validate, no experiment is
 * removed, a new experiment starts `planned` or `running`, statuses move only
 * forward, an experiment's definition is frozen once it has started, its
 * window and budget are frozen once it is terminal, and a decision, once made,
 * is final.
 */
export function validateExperimentRegistryTransition(previous: unknown, next: unknown): string[] {
  const before = parseRegistry(previous);
  if (before.issues.length > 0) return ['PREVIOUS_INVALID@$'];
  const after = parseRegistry(next);
  if (after.issues.length > 0) return after.issues;

  const out = new IssueCollector();
  const nextIds = new Set(after.experiments.map((experiment) => experiment.experimentId));
  if (before.experiments.some((experiment) => !nextIds.has(experiment.experimentId))) out.add('EXPERIMENT_REMOVED', '$.experiments');
  const previousById = new Map(before.experiments.map((experiment) => [experiment.experimentId, experiment]));
  after.experiments.forEach((experiment, index) => {
    const path = `$.experiments[${index}]`;
    const prior = previousById.get(experiment.experimentId);
    if (!prior) {
      if (!NEW_EXPERIMENT_STATUSES.has(experiment.status)) out.add('NEW_EXPERIMENT_STATUS_INVALID', `${path}.status`);
      return;
    }
    if (!ALLOWED_TRANSITIONS[prior.status].includes(experiment.status)) {
      out.add('STATUS_TRANSITION_INVALID', `${path}.status`);
      return;
    }
    const frozen = [
      ...(prior.status === 'planned' ? [] : IMMUTABLE_AFTER_START),
      ...(TERMINAL_STATUSES.has(prior.status) ? IMMUTABLE_WHEN_TERMINAL : []),
    ];
    for (const [field, name] of frozen) {
      if (experiment[field] !== prior[field]) out.add('IMMUTABLE_FIELD_CHANGED', `${path}.${name}`);
    }
    if (prior.decision !== 'pending' && experiment.decision !== prior.decision) out.add('DECISION_FINAL', `${path}.decision`);
  });
  return out.issues;
}

// ── Governed links ──────────────────────────────────────────────────────────

/**
 * The one canonical tagged link for a governed experiment, or null when the
 * experiment does not validate. The link is re-read through the Phase-A
 * landing capture before it is returned: a link that would not attribute to
 * exactly this segment is never produced.
 */
export function buildGovernedCampaignUrl(experiment: unknown): string | null {
  const out = new IssueCollector();
  const governed = parseExperiment(experiment, '$', null, out);
  if (!governed || out.count > 0) return null;
  const url = new URL(governed.landingPath, PRODUCTION_ORIGIN);
  url.searchParams.set('utm_source', governed.source);
  url.searchParams.set('utm_medium', governed.medium);
  url.searchParams.set('utm_campaign', governed.campaign);
  if (governed.content !== null) url.searchParams.set('utm_content', governed.content);
  const touch = captureAttributionTouch({ search: url.search, pathname: url.pathname, now: 0 });
  const exact = touch !== null
    && touch.source === governed.source
    && touch.medium === governed.medium
    && touch.campaign === governed.campaign
    && touch.content === governed.content
    && touch.term === null
    && touch.landingPath === governed.landingPath;
  return exact ? url.toString() : null;
}

const LINKABLE_STATUSES: ReadonlySet<string> = new Set(['planned', 'running']);

/**
 * The one canonical link for one registry entry, found by its exact
 * experiment id, or value-free issues. The whole registry must validate (an
 * invalid sibling or a duplicate id refuses every link), the entry must be
 * unique and still `planned` or `running`, and its link must round-trip
 * exactly through the Phase-A capture (`buildGovernedCampaignUrl`).
 */
export function resolveRegistryCampaignLink(registry: unknown, experimentId: unknown):
  | { ok: true; url: string }
  | { ok: false; issues: string[] } {
  const parsed = parseRegistry(registry);
  if (parsed.issues.length > 0) return { ok: false, issues: parsed.issues };
  if (typeof experimentId !== 'string' || !EXPERIMENT_ID_RE.test(experimentId)) {
    return { ok: false, issues: ['EXPERIMENT_ID_FORMAT@$.experiment_id'] };
  }
  const matches = parsed.experiments
    .map((experiment, index) => ({ experiment, index }))
    .filter(({ experiment }) => experiment.experimentId === experimentId);
  if (matches.length === 0) return { ok: false, issues: ['EXPERIMENT_UNKNOWN@$.experiment_id'] };
  if (matches.length > 1) return { ok: false, issues: ['EXPERIMENT_AMBIGUOUS@$.experiment_id'] };
  const [{ experiment, index }] = matches;
  if (!LINKABLE_STATUSES.has(experiment.status)) {
    return { ok: false, issues: [`EXPERIMENT_NOT_LINKABLE@$.experiments[${index}].status`] };
  }
  const url = buildGovernedCampaignUrl((registry as { experiments: unknown[] }).experiments[index]);
  return url === null ? { ok: false, issues: [`LINK_NOT_EXACT@$.experiments[${index}]`] } : { ok: true, url };
}
