/**
 * Read-only funnel diagnostics: where anonymous visitors stop between landing
 * and a settled purchase, from aggregate GA4 data only.
 *
 * Built entirely from events the analytics contract already governs
 * (src/lib/analytics-event-contract.ts); nothing here adds collection:
 *
 *   landing          all users / sessions in the range (GA4 built-in)
 *   checkout_entry   `checkout_step_view` at any step (a resumed draft may open
 *                    past step 1, so this is not the step-1 view)
 *   step_view:*      `checkout_step_view` per `step_id`
 *   step_complete:*  `checkout_step_complete` per `step_id`
 *   submit_attempt   `order_submit_attempt` (a validated, lock-winning submit;
 *                    its `purchase_intent` alias and `begin_checkout`, which
 *                    fire at the same moment, are not read)
 *   purchase         the server-only GA4 `purchase` written by the signed Stripe
 *                    webhook's settled winner — behavioral evidence, never
 *                    payment authority
 *
 * plus context outside the chain (`name_preview_submitted` engagement) and
 * friction (`checkout_step_blocked` per step and closed `reason`).
 *
 * The stages are an open funnel: each is counted independently (users who
 * fired that event in the range), not as a nested sequence, so a later stage
 * can exceed an earlier one (`NON_MONOTONIC`); that is reported, never
 * clamped. The basis is users, not events, because the review step completes
 * again on every validated retry and a reload re-emits a step view.
 *
 * `buildFunnelRequestPlan` returns the exact Data API `runReport` requests;
 * the operator runs them with an `analytics.readonly` token outside this repo.
 * `buildFunnelReport` reduces the responses to the closed
 * `hsb.funnel_diagnostics` v1 report, bound to the exact plan that produced
 * them. Every response goes through the strict reader
 * (src/lib/ga4-run-report.ts); every raw GA4 value is re-governed into a
 * closed vocabulary or collapsed to `not_set`/`other`, so a URL, query,
 * referrer host, identifier or free text cannot reach the report. What GA4
 * cannot vouch for (sampled, thresholded, `(other)`-folded, truncated,
 * empty-for-a-reason, a dimension not yet populated, an out-of-contract value)
 * is an explicit `INSUFFICIENT_EVIDENCE` with null counts, never a number.
 *
 * Nothing here calls GA4, reads a credential, or touches the network.
 */
import { GA4_PURCHASE_CONTRACT } from './analytics-event-contract.ts';
import { governGa4BehaviorDimensions } from './analytics-decision-export.ts';
import { sanitizeAttributionValue } from './attribution-contract.ts';
import {
  IssueCollector,
  checkClosedObject,
  hasOwn,
  isCalendarDate,
  isPlainRecord,
} from './campaign-governance.ts';
import {
  CHECKOUT_STEP_BLOCKED_REASONS,
  CHECKOUT_TELEMETRY_STEP_IDS,
  type CheckoutStepBlockedReason,
  type CheckoutTelemetryStepId,
} from './checkout-step-telemetry.ts';
import { GA4_READONLY_SCOPE } from './ga4-admin-checklist.ts';
import { readGa4RunReport, type Ga4ReportGap } from './ga4-run-report.ts';

export const FUNNEL_PLAN_SCHEMA = 'hsb.funnel_request_plan';
export const FUNNEL_REPORT_SCHEMA = 'hsb.funnel_diagnostics';
export const FUNNEL_SCHEMA_VERSION = 1;

/** Below this many users in the denominator a rate is withheld, not computed. */
export const FUNNEL_MIN_DENOMINATOR = 30;

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const ROW_LIMIT = 10_000;
const MAX_COUNT = 1_000_000_000;
const PROPERTY_ID_RE = /^[1-9]\d{5,14}$/;
const TIMEZONE_RE = /^(?:UTC|[A-Z][A-Za-z_]{1,30}(?:\/[A-Z][A-Za-z_-]{1,30}){1,2})$/;
const NOT_SET = new Set(['', '(not set)']);

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const FUNNEL_BREAKDOWNS = ['none', 'device_category', 'landing_route', 'campaign', 'selected_format'] as const;
export type FunnelBreakdown = (typeof FUNNEL_BREAKDOWNS)[number];

/** The GA4 dimension each breakdown reads; `selected_format` exists only on the step events. */
const BREAKDOWN_DIMENSION: Readonly<Record<FunnelBreakdown, string | null>> = Object.freeze({
  none: null,
  device_category: 'deviceCategory',
  landing_route: 'landingPage',
  campaign: 'sessionCampaignName',
  selected_format: 'customEvent:selected_format',
});

const DEVICE_CATEGORIES = ['desktop', 'mobile', 'tablet'] as const;
const BOOK_FORMATS = ['digital', 'classic', 'premium'] as const;

const EVENT_STAGE_EVENTS = ['name_preview_submitted', 'checkout_step_view', 'order_submit_attempt', GA4_PURCHASE_CONTRACT.event] as const;
const STEP_EVENTS = ['checkout_step_view', 'checkout_step_complete', 'checkout_step_blocked'] as const;
const BLOCKED_EVENT = 'checkout_step_blocked';

/** Every GA4 custom dimension the plan reads; each must be in the Admin checklist. */
export const FUNNEL_CUSTOM_DIMENSIONS: readonly string[] = Object.freeze(['step_id', 'reason', 'selected_format']);

export const FUNNEL_STAGE_IDS: readonly string[] = Object.freeze([
  'landing',
  'checkout_entry',
  ...CHECKOUT_TELEMETRY_STEP_IDS.flatMap((step) => [`step_view:${step}`, `step_complete:${step}`]),
  'submit_attempt',
  'purchase',
]);

export const FUNNEL_EVIDENCE_REASONS = [
  'SAMPLED', 'THRESHOLDED', 'OTHER_ROW', 'TRUNCATED', 'EMPTY_REASON', 'DIMENSION_VALUE_NOT_SET', 'OUT_OF_CONTRACT_VALUE',
] as const;
export type FunnelEvidenceReason = (typeof FUNNEL_EVIDENCE_REASONS)[number];

export const FUNNEL_STAGE_CAVEATS = ['BEHAVIORAL_NOT_PAYMENT_AUTHORITY', 'SERVER_EVENT_SEGMENT_PARTIAL'] as const;
export type FunnelStageCaveat = (typeof FUNNEL_STAGE_CAVEATS)[number];

export const FUNNEL_RATE_STATUSES = ['OK', 'FIRST_STAGE', 'NOT_COMPUTED', 'NO_DENOMINATOR', 'DENOMINATOR_BELOW_MINIMUM', 'NON_MONOTONIC'] as const;
export type FunnelRateStatus = (typeof FUNNEL_RATE_STATUSES)[number];

type Evidence = 'MEASURED' | 'INSUFFICIENT_EVIDENCE' | 'NOT_APPLICABLE';

function segmentVocabulary(breakdown: FunnelBreakdown): readonly string[] | null {
  switch (breakdown) {
    case 'none': return ['all'];
    case 'device_category': return [...DEVICE_CATEGORIES, 'not_set', 'other'];
    case 'selected_format': return [...BOOK_FORMATS, 'not_set', 'other'];
    case 'landing_route':
    case 'campaign': return null;
  }
}

/** A governed segment label for one raw GA4 breakdown value. Nothing raw survives. */
export function governFunnelSegment(breakdown: FunnelBreakdown, raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : null;
  switch (breakdown) {
    case 'none':
      return 'all';
    case 'device_category':
    case 'selected_format': {
      if (text === null) return 'other';
      if (NOT_SET.has(text)) return 'not_set';
      const vocabulary = breakdown === 'device_category' ? DEVICE_CATEGORIES : BOOK_FORMATS;
      return (vocabulary as readonly string[]).includes(text) ? text : 'other';
    }
    case 'landing_route':
      return governGa4BehaviorDimensions({ landingPage: raw }).landing_path;
    case 'campaign':
      return governGa4BehaviorDimensions({ sessionCampaignName: raw }).campaign;
  }
}

function segmentValueAllowed(breakdown: FunnelBreakdown, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const vocabulary = segmentVocabulary(breakdown);
  if (vocabulary) return vocabulary.includes(value);
  // A value is allowed exactly when governing it returns it unchanged.
  if (breakdown === 'campaign') {
    return ['none', 'not_set', 'other'].includes(value) || sanitizeAttributionValue('utm_campaign', value) === value;
  }
  return value === 'not_set' || value === 'other' || governFunnelSegment('landing_route', value) === value;
}

function segmentOrder(breakdown: FunnelBreakdown, a: string, b: string): number {
  const vocabulary = segmentVocabulary(breakdown);
  const rank = (value: string) => {
    if (vocabulary) return vocabulary.indexOf(value);
    return value === 'not_set' ? 2 : value === 'other' ? 3 : value === 'none' ? 1 : 0;
  };
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ── Read-only request plan ──────────────────────────────────────────────────

export type FunnelRequestId = 'traffic' | 'events' | 'steps' | 'blocked';

export interface FunnelRequest {
  id: FunnelRequestId;
  method: 'POST';
  url: string;
  oauthScope: typeof GA4_READONLY_SCOPE;
  body: Record<string, unknown>;
}

export interface FunnelRequestPlan {
  schema: typeof FUNNEL_PLAN_SCHEMA;
  schema_version: typeof FUNNEL_SCHEMA_VERSION;
  property_id: string;
  start_date: string;
  end_date: string;
  breakdown: FunnelBreakdown;
  requests: FunnelRequest[];
}

interface RequestShape {
  dimensions: string[];
  metrics: string[];
  events: readonly string[] | null;
}

function requestShapes(breakdown: FunnelBreakdown): Partial<Record<FunnelRequestId, RequestShape>> {
  const segment = BREAKDOWN_DIMENSION[breakdown];
  const lead = segment ? [segment] : [];
  const counts = ['totalUsers', 'eventCount'];
  const shapes: Partial<Record<FunnelRequestId, RequestShape>> = {};
  // `selected_format` is only sent on the step events: traffic and the other
  // stages have no value to break down by.
  if (breakdown !== 'selected_format') {
    shapes.traffic = { dimensions: lead, metrics: ['sessions', 'totalUsers'], events: null };
    shapes.events = { dimensions: [...lead, 'eventName'], metrics: counts, events: EVENT_STAGE_EVENTS };
  }
  shapes.steps = { dimensions: [...lead, 'eventName', 'customEvent:step_id'], metrics: counts, events: STEP_EVENTS };
  shapes.blocked = { dimensions: [...lead, 'customEvent:step_id', 'customEvent:reason'], metrics: counts, events: [BLOCKED_EVENT] };
  return shapes;
}

const REQUEST_ORDER: readonly FunnelRequestId[] = ['traffic', 'events', 'steps', 'blocked'];

export function buildFunnelRequestPlan(input: { propertyId: string; startDate: string; endDate: string; breakdown?: string }):
  | { ok: true; plan: FunnelRequestPlan }
  | { ok: false; reason: 'PROPERTY_ID_INVALID' | 'DATE_INVALID' | 'DATE_RANGE_INVALID' | 'BREAKDOWN_INVALID' } {
  if (!isPlainRecord(input) || typeof input.propertyId !== 'string' || !PROPERTY_ID_RE.test(input.propertyId)) {
    return { ok: false, reason: 'PROPERTY_ID_INVALID' };
  }
  if (!isCalendarDate(input.startDate) || !isCalendarDate(input.endDate)) return { ok: false, reason: 'DATE_INVALID' };
  const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / DAY_MS;
  if (span < 0 || span >= MAX_RANGE_DAYS) return { ok: false, reason: 'DATE_RANGE_INVALID' };
  const breakdown = input.breakdown === undefined ? 'none' : input.breakdown;
  if (typeof breakdown !== 'string' || !(FUNNEL_BREAKDOWNS as readonly string[]).includes(breakdown)) {
    return { ok: false, reason: 'BREAKDOWN_INVALID' };
  }
  const shapes = requestShapes(breakdown as FunnelBreakdown);
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${input.propertyId}:runReport`;
  const requests: FunnelRequest[] = [];
  for (const id of REQUEST_ORDER) {
    const shape = shapes[id];
    if (!shape) continue;
    const body: Record<string, unknown> = {
      dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
      dimensions: shape.dimensions.map((name) => ({ name })),
      metrics: shape.metrics.map((name) => ({ name })),
    };
    if (shape.events) {
      body.dimensionFilter = shape.events.length === 1
        ? { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: shape.events[0], caseSensitive: true } } }
        : { filter: { fieldName: 'eventName', inListFilter: { values: [...shape.events], caseSensitive: true } } };
    }
    body.keepEmptyRows = false;
    body.limit = String(ROW_LIMIT);
    requests.push({ id, method: 'POST', url, oauthScope: GA4_READONLY_SCOPE, body });
  }
  return {
    ok: true,
    plan: {
      schema: FUNNEL_PLAN_SCHEMA,
      schema_version: FUNNEL_SCHEMA_VERSION,
      property_id: input.propertyId,
      start_date: input.startDate,
      end_date: input.endDate,
      breakdown: breakdown as FunnelBreakdown,
      requests,
    },
  };
}

/** Structural equality over plain JSON values: own keys only. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameJson(item, b[index]));
  }
  if (isPlainRecord(a) || isPlainRecord(b)) {
    if (!isPlainRecord(a) || !isPlainRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return a === b;
}

/** The plan rebuilt from the fields it names; null unless it is exactly a built plan. */
function reboundPlan(plan: unknown): FunnelRequestPlan | null {
  if (!isPlainRecord(plan)) return null;
  const rebuilt = buildFunnelRequestPlan({
    propertyId: plan.property_id as string,
    startDate: plan.start_date as string,
    endDate: plan.end_date as string,
    breakdown: plan.breakdown as string,
  });
  return rebuilt.ok && sameJson(rebuilt.plan, plan) ? rebuilt.plan : null;
}

// ── The closed report ───────────────────────────────────────────────────────

export interface FunnelStage {
  stage_id: string;
  evidence: Evidence;
  evidence_reasons: FunnelEvidenceReason[];
  caveats: FunnelStageCaveat[];
  users: number | null;
  events: number | null;
  /** Landing only: GA4 sessions in the segment. */
  sessions: number | null;
  rate_from_first: number | null;
  rate_from_previous: number | null;
  drop_off_users: number | null;
  drop_off_rate: number | null;
  rate_status: FunnelRateStatus;
}

export interface FunnelCount {
  evidence: Evidence;
  evidence_reasons: FunnelEvidenceReason[];
  users: number | null;
  events: number | null;
}

export interface FunnelBlockedReason {
  reason: CheckoutStepBlockedReason;
  users: number;
  events: number;
}

export interface FunnelFriction extends FunnelCount {
  step_id: CheckoutTelemetryStepId;
  /** Share of this step's viewers who were blocked at least once; null when not computable. */
  blocked_rate: number | null;
  /** Closed reasons with a nonzero count, by users descending; empty when the reason report is insufficient. */
  reasons: FunnelBlockedReason[];
  reasons_evidence: Evidence;
  reasons_evidence_reasons: FunnelEvidenceReason[];
}

export interface FunnelSegment {
  segment: string;
  /** Several raw GA4 values collapsed into this label: its user counts are sums, so an upper bound. */
  merged_raw_values: boolean;
  stages: FunnelStage[];
  engagement: FunnelCount & { stage: 'name_preview_submitted'; rate_from_landing: number | null };
  friction: FunnelFriction[];
}

export interface FunnelReport {
  schema: typeof FUNNEL_REPORT_SCHEMA;
  schema_version: typeof FUNNEL_SCHEMA_VERSION;
  business: 'hsb';
  evidence_kind: 'ga4_behavioral_aggregate';
  payment_authority: 'excluded';
  property_id: string;
  coverage: { start: string; end: string };
  timezone: string | null;
  breakdown: FunnelBreakdown;
  metric_basis: 'users';
  min_denominator: number;
  evidence: 'COMPLETE' | 'INSUFFICIENT_EVIDENCE';
  evidence_reasons: FunnelEvidenceReason[];
  segments: FunnelSegment[];
}

// ── Response → report ───────────────────────────────────────────────────────

interface Counts { users: number; events: number }
interface RequestResult {
  /** segment → key → counts. Key shape depends on the request. */
  cells: Map<string, Map<string, Counts>>;
  reasons: Set<FunnelEvidenceReason>;
}

const GAP_REASON: Readonly<Record<Ga4ReportGap, FunnelEvidenceReason>> = Object.freeze({
  SAMPLED: 'SAMPLED',
  THRESHOLDED: 'THRESHOLDED',
  OTHER_ROW: 'OTHER_ROW',
  TRUNCATED: 'TRUNCATED',
  EMPTY_REASON: 'EMPTY_REASON',
});

function rate(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function sortedReasons(reasons: Iterable<FunnelEvidenceReason>): FunnelEvidenceReason[] {
  const set = new Set(reasons);
  return FUNNEL_EVIDENCE_REASONS.filter((reason) => set.has(reason));
}

/**
 * Reduce the operator-supplied responses to the closed report. `responses`
 * maps each plan request id to its raw `runReport` JSON. Refuses — with
 * value-free `CODE@$.path` issues — a plan that is not exactly a built plan,
 * a response set that does not answer exactly its requests, and any response
 * the strict reader rejects, with a row outside the request's event filter, a
 * repeated row, a malformed or incoherent count, or a foreign timezone.
 */
export function buildFunnelReport(plan: unknown, responses: unknown):
  | { ok: true; report: FunnelReport }
  | { ok: false; issues: string[] } {
  const out = new IssueCollector();
  const refuse = () => ({ ok: false as const, issues: out.issues });
  const bound = reboundPlan(plan);
  if (!bound) {
    out.add('REQUEST_PLAN_INVALID', '$.plan');
    return refuse();
  }
  const ids = bound.requests.map((request) => request.id);
  if (!isPlainRecord(responses) || Object.keys(responses).length !== ids.length || !ids.every((id) => hasOwn(responses, id))) {
    out.add('RESPONSES_SHAPE', '$.responses');
    return refuse();
  }

  const breakdown = bound.breakdown;
  const shapes = requestShapes(breakdown);
  const segmentLead = BREAKDOWN_DIMENSION[breakdown] ? 1 : 0;
  const results: Partial<Record<FunnelRequestId, RequestResult>> = {};
  const merged = new Set<string>();
  const rawSeen = new Map<string, string>();
  let timezone: string | null = null;

  for (const id of ids) {
    const shape = shapes[id]!;
    const path = `$.responses.${id}`;
    const read = readGa4RunReport(responses[id], { dimensions: shape.dimensions, metrics: shape.metrics, limit: ROW_LIMIT });
    if (read.ok === false) {
      out.add(read.defect, `${path}${read.path.slice(1)}`);
      continue;
    }
    const { rows, gaps, timeZone } = read.report;
    if (timeZone !== null) {
      if (!TIMEZONE_RE.test(timeZone) || (timezone !== null && timezone !== timeZone)) {
        out.add('TIMEZONE_INVALID', `${path}.metadata.timeZone`);
        continue;
      }
      timezone = timeZone;
    }
    const result: RequestResult = { cells: new Map(), reasons: new Set(gaps.map((gap) => GAP_REASON[gap])) };
    const seenRaw = new Set<string>();
    rows.forEach(({ dimensions, metrics }, index) => {
      const rowPath = `${path}.rows[${index}]`;
      const rawKey = JSON.stringify(dimensions);
      if (seenRaw.has(rawKey)) {
        out.add('DUPLICATE_ROW', rowPath);
        return;
      }
      seenRaw.add(rawKey);
      if (!metrics.every((value) => /^\d{1,10}$/.test(value) && Number(value) <= MAX_COUNT)) {
        out.add('METRIC_INVALID', rowPath);
        return;
      }
      const [first, second] = metrics.map(Number);
      // Event rows: users who fired an event can never outnumber its events.
      if (id !== 'traffic' && first > second) {
        out.add('METRIC_INCOHERENT', rowPath);
        return;
      }
      const counts: Counts = id === 'traffic' ? { users: second, events: first } : { users: first, events: second };
      const rawSegment = segmentLead ? dimensions[0] : undefined;
      const segment = governFunnelSegment(breakdown, rawSegment);
      if (segmentLead) {
        // Two raw values folded into one label: its user counts become sums.
        const previous = rawSeen.get(`${id}\u0000${segment}\u0000${JSON.stringify(dimensions.slice(1))}`);
        if (previous !== undefined && previous !== rawSegment) merged.add(segment);
        rawSeen.set(`${id}\u0000${segment}\u0000${JSON.stringify(dimensions.slice(1))}`, rawSegment!);
      }
      const rest = dimensions.slice(segmentLead);
      let key: string;
      if (id === 'traffic') {
        key = 'traffic';
      } else if (id === 'events') {
        if (!(EVENT_STAGE_EVENTS as readonly string[]).includes(rest[0])) {
          out.add('ROW_OUTSIDE_REQUEST', rowPath);
          return;
        }
        key = rest[0];
      } else {
        const eventName = id === 'steps' ? rest[0] : BLOCKED_EVENT;
        const step = id === 'steps' ? rest[1] : rest[0];
        if (!(STEP_EVENTS as readonly string[]).includes(eventName)) {
          out.add('ROW_OUTSIDE_REQUEST', rowPath);
          return;
        }
        const values = id === 'steps' ? [step] : [step, rest[1]];
        if (values.some((value) => NOT_SET.has(value))) {
          result.reasons.add('DIMENSION_VALUE_NOT_SET');
          return;
        }
        const stepKnown = (CHECKOUT_TELEMETRY_STEP_IDS as readonly string[]).includes(step);
        const reasonKnown = id === 'steps' || (CHECKOUT_STEP_BLOCKED_REASONS as readonly string[]).includes(rest[1]);
        if (!stepKnown || !reasonKnown) {
          result.reasons.add('OUT_OF_CONTRACT_VALUE');
          return;
        }
        key = id === 'steps' ? `${eventName}\u0000${step}` : `${step}\u0000${rest[1]}`;
      }
      const bySegment = result.cells.get(segment) ?? new Map<string, Counts>();
      const existing = bySegment.get(key);
      if (existing) {
        existing.users += counts.users;
        existing.events += counts.events;
        if (existing.users > MAX_COUNT || existing.events > MAX_COUNT) out.add('METRIC_OVERFLOW', rowPath);
      } else {
        bySegment.set(key, { ...counts });
      }
      result.cells.set(segment, bySegment);
    });
    results[id] = result;
  }
  if (out.count > 0) return refuse();

  const segments = new Set<string>(breakdown === 'none' ? ['all'] : []);
  for (const result of Object.values(results)) for (const segment of result!.cells.keys()) segments.add(segment);

  const report: FunnelReport = {
    schema: FUNNEL_REPORT_SCHEMA,
    schema_version: FUNNEL_SCHEMA_VERSION,
    business: 'hsb',
    evidence_kind: 'ga4_behavioral_aggregate',
    payment_authority: 'excluded',
    property_id: bound.property_id,
    coverage: { start: bound.start_date, end: bound.end_date },
    timezone,
    breakdown,
    metric_basis: 'users',
    min_denominator: FUNNEL_MIN_DENOMINATOR,
    evidence: 'COMPLETE',
    evidence_reasons: [],
    segments: [...segments]
      .sort((a, b) => segmentOrder(breakdown, a, b))
      .map((segment) => buildSegment(breakdown, segment, results, merged.has(segment))),
  };
  const reasons = new Set<FunnelEvidenceReason>();
  for (const segment of report.segments) {
    const counted: Array<{ evidence: Evidence; evidence_reasons: FunnelEvidenceReason[] }> = [
      ...segment.stages, segment.engagement, ...segment.friction,
      ...segment.friction.map((item) => ({ evidence: item.reasons_evidence, evidence_reasons: item.reasons_evidence_reasons })),
    ];
    for (const item of counted) {
      if (item.evidence === 'INSUFFICIENT_EVIDENCE') report.evidence = 'INSUFFICIENT_EVIDENCE';
      for (const reason of item.evidence_reasons) reasons.add(reason);
    }
  }
  report.evidence_reasons = sortedReasons(reasons);

  // Revalidate at the boundary: the builder's output must pass the same closed schema as any input.
  const issues = validateFunnelReport(report);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, report };
}

function countFrom(result: RequestResult | undefined, segment: string, key: string): FunnelCount {
  if (!result) return { evidence: 'NOT_APPLICABLE', evidence_reasons: [], users: null, events: null };
  if (result.reasons.size > 0) {
    return { evidence: 'INSUFFICIENT_EVIDENCE', evidence_reasons: sortedReasons(result.reasons), users: null, events: null };
  }
  // A complete report without a row for this key is evidence of zero.
  const counts = result.cells.get(segment)?.get(key) ?? { users: 0, events: 0 };
  return { evidence: 'MEASURED', evidence_reasons: [], users: counts.users, events: counts.events };
}

function stageSource(stageId: string): { request: FunnelRequestId; key: string } {
  if (stageId === 'landing') return { request: 'traffic', key: 'traffic' };
  if (stageId === 'checkout_entry') return { request: 'events', key: 'checkout_step_view' };
  if (stageId === 'submit_attempt') return { request: 'events', key: 'order_submit_attempt' };
  if (stageId === 'purchase') return { request: 'events', key: GA4_PURCHASE_CONTRACT.event };
  const [kind, step] = stageId.split(':');
  return { request: 'steps', key: `${kind === 'step_view' ? 'checkout_step_view' : 'checkout_step_complete'}\u0000${step}` };
}

function buildSegment(
  breakdown: FunnelBreakdown,
  segment: string,
  results: Partial<Record<FunnelRequestId, RequestResult>>,
  mergedRawValues: boolean,
): FunnelSegment {
  const stages: FunnelStage[] = [];
  let first: FunnelStage | null = null;
  let previous: FunnelStage | null = null;
  for (const stageId of FUNNEL_STAGE_IDS) {
    const source = stageSource(stageId);
    const count = countFrom(results[source.request], segment, source.key);
    const caveats: FunnelStageCaveat[] = [];
    if (stageId === 'purchase') {
      caveats.push('BEHAVIORAL_NOT_PAYMENT_AUTHORITY');
      // A Measurement Protocol purchase joins a session (and its device,
      // landing page and campaign) only when the webhook had a GA session id.
      if (breakdown !== 'none') caveats.push('SERVER_EVENT_SEGMENT_PARTIAL');
    }
    const stage: FunnelStage = {
      stage_id: stageId,
      evidence: count.evidence,
      evidence_reasons: count.evidence_reasons,
      caveats,
      users: count.users,
      events: count.events,
      sessions: stageId === 'landing' && count.evidence === 'MEASURED'
        ? results.traffic!.cells.get(segment)?.get('traffic')?.events ?? 0
        : null,
      rate_from_first: null,
      rate_from_previous: null,
      drop_off_users: null,
      drop_off_rate: null,
      rate_status: 'NOT_COMPUTED',
    };
    if (count.evidence !== 'NOT_APPLICABLE') {
      if (first === null) {
        first = stage;
        stage.rate_status = stage.evidence === 'MEASURED' ? 'FIRST_STAGE' : 'NOT_COMPUTED';
      } else {
        applyRates(stage, first, previous);
      }
      previous = stage;
    }
    stages.push(stage);
  }
  // The landing sessions are carried in the traffic cell's `events` slot.
  const landing = stages[0];
  if (landing.evidence === 'MEASURED') landing.events = null;

  const engagementCount = countFrom(results.events, segment, 'name_preview_submitted');
  const engagement = {
    stage: 'name_preview_submitted' as const,
    ...engagementCount,
    rate_from_landing: engagementCount.evidence === 'MEASURED' && landing.evidence === 'MEASURED'
      && landing.users! >= FUNNEL_MIN_DENOMINATOR && engagementCount.users! <= landing.users!
      ? rate(engagementCount.users!, landing.users!)
      : null,
  };

  const friction: FunnelFriction[] = CHECKOUT_TELEMETRY_STEP_IDS.map((step) => {
    const blocked = countFrom(results.steps, segment, `${BLOCKED_EVENT}\u0000${step}`);
    const view = stages.find((item) => item.stage_id === `step_view:${step}`)!;
    const blockedResult = results.blocked!;
    const reasonsInsufficient = blockedResult.reasons.size > 0;
    const reasons: FunnelBlockedReason[] = reasonsInsufficient ? [] : CHECKOUT_STEP_BLOCKED_REASONS
      .map((reason) => ({ reason, ...(blockedResult.cells.get(segment)?.get(`${step}\u0000${reason}`) ?? { users: 0, events: 0 }) }))
      .filter((item) => item.events > 0)
      .sort((a, b) => b.users - a.users || b.events - a.events
        || CHECKOUT_STEP_BLOCKED_REASONS.indexOf(a.reason) - CHECKOUT_STEP_BLOCKED_REASONS.indexOf(b.reason));
    return {
      step_id: step,
      ...blocked,
      blocked_rate: blocked.evidence === 'MEASURED' && view.evidence === 'MEASURED'
        && view.users! >= FUNNEL_MIN_DENOMINATOR && blocked.users! <= view.users!
        ? rate(blocked.users!, view.users!)
        : null,
      reasons,
      reasons_evidence: reasonsInsufficient ? 'INSUFFICIENT_EVIDENCE' : 'MEASURED',
      reasons_evidence_reasons: sortedReasons(blockedResult.reasons),
    };
  });

  return { segment, merged_raw_values: mergedRawValues, stages, engagement, friction };
}

function applyRates(stage: FunnelStage, first: FunnelStage, previous: FunnelStage | null): void {
  if (stage.evidence !== 'MEASURED') return;
  const users = stage.users!;
  if (first.evidence === 'MEASURED' && first.users! >= FUNNEL_MIN_DENOMINATOR && users <= first.users!) {
    stage.rate_from_first = rate(users, first.users!);
  }
  // The step-to-step rate needs only a measured predecessor, not a measured first stage.
  if (previous?.evidence !== 'MEASURED') return;
  const previousUsers = previous.users!;
  if (previousUsers === 0) {
    stage.rate_status = 'NO_DENOMINATOR';
  } else if (users > previousUsers) {
    stage.rate_status = 'NON_MONOTONIC';
  } else if (previousUsers < FUNNEL_MIN_DENOMINATOR) {
    stage.rate_status = 'DENOMINATOR_BELOW_MINIMUM';
    stage.drop_off_users = previousUsers - users;
  } else {
    stage.rate_status = 'OK';
    stage.rate_from_previous = rate(users, previousUsers);
    stage.drop_off_users = previousUsers - users;
    stage.drop_off_rate = rate(previousUsers - users, previousUsers);
  }
}

// ── Closed-schema validator ─────────────────────────────────────────────────

const REPORT_KEYS = [
  'schema', 'schema_version', 'business', 'evidence_kind', 'payment_authority', 'property_id', 'coverage', 'timezone',
  'breakdown', 'metric_basis', 'min_denominator', 'evidence', 'evidence_reasons', 'segments',
] as const;
const SEGMENT_KEYS = ['segment', 'merged_raw_values', 'stages', 'engagement', 'friction'] as const;
const STAGE_KEYS = [
  'stage_id', 'evidence', 'evidence_reasons', 'caveats', 'users', 'events', 'sessions', 'rate_from_first',
  'rate_from_previous', 'drop_off_users', 'drop_off_rate', 'rate_status',
] as const;
const COUNT_KEYS = ['evidence', 'evidence_reasons', 'users', 'events'] as const;
const ENGAGEMENT_KEYS = ['stage', ...COUNT_KEYS, 'rate_from_landing'] as const;
const FRICTION_KEYS = ['step_id', ...COUNT_KEYS, 'blocked_rate', 'reasons', 'reasons_evidence', 'reasons_evidence_reasons'] as const;
const REASON_KEYS = ['reason', 'users', 'events'] as const;
const EVIDENCE: readonly Evidence[] = ['MEASURED', 'INSUFFICIENT_EVIDENCE', 'NOT_APPLICABLE'];

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
}

function isRate(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function closedList(value: unknown, vocabulary: readonly string[]): boolean {
  return Array.isArray(value) && value.every((item) => vocabulary.includes(item as string))
    && new Set(value).size === value.length
    && value.every((item, index) => index === 0 || vocabulary.indexOf(value[index - 1]) < vocabulary.indexOf(item));
}

function checkCount(item: Record<string, unknown>, path: string, out: IssueCollector): void {
  if (!EVIDENCE.includes(item.evidence as Evidence)) out.add('VALUE_INVALID', `${path}.evidence`);
  if (!closedList(item.evidence_reasons, FUNNEL_EVIDENCE_REASONS)) out.add('VALUE_INVALID', `${path}.evidence_reasons`);
  const measured = item.evidence === 'MEASURED';
  for (const key of ['users', 'events']) {
    if (measured ? !isCount(item[key]) : item[key] !== null) out.add('VALUE_INVALID', `${path}.${key}`);
  }
  if ((item.evidence === 'INSUFFICIENT_EVIDENCE') !== (Array.isArray(item.evidence_reasons) && item.evidence_reasons.length > 0)) {
    out.add('EVIDENCE_REASONS_MISMATCH', `${path}.evidence_reasons`);
  }
}

/** Value-free `CODE@$.path` issues; an empty array means the report is closed and governed. */
export function validateFunnelReport(doc: unknown): string[] {
  const out = new IssueCollector();
  if (!isPlainRecord(doc)) {
    out.add('DOCUMENT_NOT_OBJECT', '$');
    return out.issues;
  }
  if (doc.schema !== FUNNEL_REPORT_SCHEMA) {
    out.add('SCHEMA_INVALID', '$.schema');
    return out.issues;
  }
  if (doc.schema_version !== FUNNEL_SCHEMA_VERSION) {
    out.add('SCHEMA_VERSION_UNSUPPORTED', '$.schema_version');
    return out.issues;
  }
  checkClosedObject(doc, REPORT_KEYS, '$', out);
  if (doc.business !== 'hsb') out.add('VALUE_INVALID', '$.business');
  if (doc.evidence_kind !== 'ga4_behavioral_aggregate') out.add('VALUE_INVALID', '$.evidence_kind');
  if (doc.payment_authority !== 'excluded') out.add('VALUE_INVALID', '$.payment_authority');
  if (typeof doc.property_id !== 'string' || !PROPERTY_ID_RE.test(doc.property_id)) out.add('VALUE_INVALID', '$.property_id');
  if (checkClosedObject(doc.coverage, ['start', 'end'], '$.coverage', out)
    && (!isCalendarDate(doc.coverage.start) || !isCalendarDate(doc.coverage.end) || doc.coverage.start > doc.coverage.end)) {
    out.add('VALUE_INVALID', '$.coverage');
  }
  if (doc.timezone !== null && (typeof doc.timezone !== 'string' || !TIMEZONE_RE.test(doc.timezone))) out.add('VALUE_INVALID', '$.timezone');
  const breakdown = (FUNNEL_BREAKDOWNS as readonly unknown[]).includes(doc.breakdown) ? doc.breakdown as FunnelBreakdown : null;
  if (!breakdown) out.add('VALUE_INVALID', '$.breakdown');
  if (doc.metric_basis !== 'users') out.add('VALUE_INVALID', '$.metric_basis');
  if (doc.min_denominator !== FUNNEL_MIN_DENOMINATOR) out.add('VALUE_INVALID', '$.min_denominator');
  if (doc.evidence !== 'COMPLETE' && doc.evidence !== 'INSUFFICIENT_EVIDENCE') out.add('VALUE_INVALID', '$.evidence');
  if (!closedList(doc.evidence_reasons, FUNNEL_EVIDENCE_REASONS)) out.add('VALUE_INVALID', '$.evidence_reasons');
  if (!Array.isArray(doc.segments) || doc.segments.length > 1000) {
    out.add('TYPE_ARRAY', '$.segments');
    return out.issues;
  }
  const seen = new Set<string>();
  let insufficient = false;
  doc.segments.forEach((segment, index) => {
    const path = `$.segments[${index}]`;
    if (!checkClosedObject(segment, SEGMENT_KEYS, path, out)) return;
    if (!breakdown || !segmentValueAllowed(breakdown, segment.segment)) out.add('SEGMENT_NOT_GOVERNED', `${path}.segment`);
    else if (seen.has(segment.segment as string)) out.add('DUPLICATE_SEGMENT', `${path}.segment`);
    seen.add(segment.segment as string);
    if (typeof segment.merged_raw_values !== 'boolean') out.add('VALUE_INVALID', `${path}.merged_raw_values`);

    if (!Array.isArray(segment.stages) || segment.stages.length !== FUNNEL_STAGE_IDS.length) {
      out.add('TYPE_ARRAY', `${path}.stages`);
    } else {
      segment.stages.forEach((stage, stageIndex) => {
        const stagePath = `${path}.stages[${stageIndex}]`;
        if (!checkClosedObject(stage, STAGE_KEYS, stagePath, out)) return;
        if (stage.stage_id !== FUNNEL_STAGE_IDS[stageIndex]) out.add('VALUE_INVALID', `${stagePath}.stage_id`);
        checkCount({ ...stage, events: stage.stage_id === 'landing' && stage.evidence === 'MEASURED' ? 0 : stage.events }, stagePath, out);
        if (stage.stage_id === 'landing' && stage.evidence === 'MEASURED' && stage.events !== null) out.add('VALUE_INVALID', `${stagePath}.events`);
        if (stage.evidence === 'INSUFFICIENT_EVIDENCE') insufficient = true;
        if (!closedList(stage.caveats, FUNNEL_STAGE_CAVEATS)) out.add('VALUE_INVALID', `${stagePath}.caveats`);
        const sessionsExpected = stage.stage_id === 'landing' && stage.evidence === 'MEASURED';
        if (sessionsExpected ? !isCount(stage.sessions) : stage.sessions !== null) out.add('VALUE_INVALID', `${stagePath}.sessions`);
        for (const key of ['rate_from_first', 'rate_from_previous', 'drop_off_rate']) {
          if (!isRate(stage[key])) out.add('VALUE_INVALID', `${stagePath}.${key}`);
        }
        if (stage.drop_off_users !== null && !isCount(stage.drop_off_users)) out.add('VALUE_INVALID', `${stagePath}.drop_off_users`);
        if (!(FUNNEL_RATE_STATUSES as readonly unknown[]).includes(stage.rate_status)) out.add('VALUE_INVALID', `${stagePath}.rate_status`);
        if (stage.rate_status !== 'OK' && (stage.rate_from_previous !== null || stage.drop_off_rate !== null)) {
          out.add('RATE_WITHOUT_STATUS', stagePath);
        }
      });
    }

    if (checkClosedObject(segment.engagement, ENGAGEMENT_KEYS, `${path}.engagement`, out)) {
      if (segment.engagement.stage !== 'name_preview_submitted') out.add('VALUE_INVALID', `${path}.engagement.stage`);
      checkCount(segment.engagement, `${path}.engagement`, out);
      if (segment.engagement.evidence === 'INSUFFICIENT_EVIDENCE') insufficient = true;
      if (!isRate(segment.engagement.rate_from_landing)) out.add('VALUE_INVALID', `${path}.engagement.rate_from_landing`);
    }

    if (!Array.isArray(segment.friction) || segment.friction.length !== CHECKOUT_TELEMETRY_STEP_IDS.length) {
      out.add('TYPE_ARRAY', `${path}.friction`);
      return;
    }
    segment.friction.forEach((item, frictionIndex) => {
      const itemPath = `${path}.friction[${frictionIndex}]`;
      if (!checkClosedObject(item, FRICTION_KEYS, itemPath, out)) return;
      if (item.step_id !== CHECKOUT_TELEMETRY_STEP_IDS[frictionIndex]) out.add('VALUE_INVALID', `${itemPath}.step_id`);
      checkCount(item, itemPath, out);
      if (!isRate(item.blocked_rate)) out.add('VALUE_INVALID', `${itemPath}.blocked_rate`);
      if (item.reasons_evidence !== 'MEASURED' && item.reasons_evidence !== 'INSUFFICIENT_EVIDENCE') {
        out.add('VALUE_INVALID', `${itemPath}.reasons_evidence`);
      }
      if (!closedList(item.reasons_evidence_reasons, FUNNEL_EVIDENCE_REASONS)
        || (item.reasons_evidence === 'INSUFFICIENT_EVIDENCE') !== (item.reasons_evidence_reasons as unknown[]).length > 0) {
        out.add('VALUE_INVALID', `${itemPath}.reasons_evidence_reasons`);
      }
      if (item.reasons_evidence === 'INSUFFICIENT_EVIDENCE' && Array.isArray(item.reasons) && item.reasons.length > 0) {
        out.add('VALUE_INVALID', `${itemPath}.reasons`);
      }
      if (item.evidence === 'INSUFFICIENT_EVIDENCE' || item.reasons_evidence === 'INSUFFICIENT_EVIDENCE') insufficient = true;
      if (!Array.isArray(item.reasons) || item.reasons.length > CHECKOUT_STEP_BLOCKED_REASONS.length) {
        out.add('TYPE_ARRAY', `${itemPath}.reasons`);
        return;
      }
      const reasonsSeen = new Set<unknown>();
      item.reasons.forEach((entry, reasonIndex) => {
        const entryPath = `${itemPath}.reasons[${reasonIndex}]`;
        if (!checkClosedObject(entry, REASON_KEYS, entryPath, out)) return;
        if (!(CHECKOUT_STEP_BLOCKED_REASONS as readonly unknown[]).includes(entry.reason) || reasonsSeen.has(entry.reason)) {
          out.add('VALUE_INVALID', `${entryPath}.reason`);
        }
        reasonsSeen.add(entry.reason);
        if (!isCount(entry.users) || !isCount(entry.events) || entry.users > entry.events) out.add('VALUE_INVALID', entryPath);
      });
    });
  });
  if ((doc.evidence === 'INSUFFICIENT_EVIDENCE') !== insufficient) out.add('EVIDENCE_MISMATCH', '$.evidence');
  return out.issues;
}

// ── Plain-text view for the owner ───────────────────────────────────────────

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function count(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** A fixed-width table per segment, rendered only from an already-valid report. */
export function renderFunnelReportText(report: FunnelReport): string {
  const lines: string[] = [
    `HSB funnel ${report.coverage.start}..${report.coverage.end} (${report.timezone ?? 'timezone not reported'}), breakdown=${report.breakdown}`,
    `evidence=${report.evidence}${report.evidence_reasons.length ? ` [${report.evidence_reasons.join(', ')}]` : ''}; basis=users; rates withheld below ${report.min_denominator} users`,
    'GA4 behavioral evidence only. Stripe settlement is the payment authority; this report is not revenue.',
  ];
  for (const segment of report.segments) {
    lines.push('', `== segment: ${segment.segment}${segment.merged_raw_values ? ' (merged raw values: counts are upper bounds)' : ''}`);
    lines.push(`${'stage'.padEnd(30)}${'users'.padStart(9)}${'from first'.padStart(12)}${'from prev'.padStart(11)}${'drop-off'.padStart(10)}  status`);
    for (const stage of segment.stages) {
      if (stage.evidence === 'NOT_APPLICABLE') continue;
      const status = stage.evidence === 'MEASURED' ? stage.rate_status : `INSUFFICIENT_EVIDENCE [${stage.evidence_reasons.join(', ')}]`;
      lines.push(`${stage.stage_id.padEnd(30)}${count(stage.users).padStart(9)}${percent(stage.rate_from_first).padStart(12)}`
        + `${percent(stage.rate_from_previous).padStart(11)}${count(stage.drop_off_users).padStart(10)}  ${status}`
        + `${stage.caveats.length ? ` (${stage.caveats.join(', ')})` : ''}`);
    }
    if (segment.engagement.evidence !== 'NOT_APPLICABLE') {
      lines.push(`context: name preview used by ${count(segment.engagement.users)} users (${percent(segment.engagement.rate_from_landing)} of landing)`);
    }
    for (const item of segment.friction) {
      const reasons = item.reasons_evidence === 'MEASURED'
        ? item.reasons.map((entry) => `${entry.reason}=${entry.users}`).join(', ') || 'none'
        : `INSUFFICIENT_EVIDENCE [${item.reasons_evidence_reasons.join(', ')}]`;
      lines.push(`blocked ${item.step_id}: ${count(item.users)} users (${percent(item.blocked_rate)} of viewers); reasons: ${reasons}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
