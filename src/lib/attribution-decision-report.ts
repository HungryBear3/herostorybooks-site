/**
 * Decision report join: `hsb.decision_report.attribution` v1.
 *
 * Joins one ledger export (`hsb.decision_export.ledger`), one HSB-native GA4
 * behavior export (`hsb.decision_export.ga4_behavior`) and the experiment
 * registry, for exactly one registered experiment, and computes only that
 * experiment's declared primary outcome — and only when its minimum
 * denominator and minimum events are both met.
 *
 *  - Payment facts come from the ledger alone (registered segment, primary
 *    model, paid day inside the experiment window). The GA4 purchase count is
 *    reported beside them, labelled `BEHAVIORAL_NOT_PAYMENT_AUTHORITY`, and
 *    never enters an outcome.
 *  - The GA4 denominator is the sessions whose session source, medium,
 *    campaign and content equal the experiment's, on every landing page,
 *    inside the window: under the 30-day last-UTM model a return visit keeps
 *    the campaign but lands elsewhere. A second experiment that shares the
 *    four fields on another landing path in an overlapping window makes that
 *    denominator ambiguous, so the report refuses.
 *  - The attribution model and the denominator's known biases are declared
 *    in fixed fields, never left to the reader.
 *
 * Refuses (value-free `CODE@$.path`) on any schema, identity, origin,
 * timezone, window-coverage, attestation or ledger-integrity mismatch. Pure.
 */
import { validateHsbGa4BehaviorExport, type Ga4BehaviorExport } from './analytics-decision-export.ts';
import {
  LEDGER_EXCLUSION_REASONS,
  ledgerIntegrityTouchesWindow,
  registryFingerprint,
  validateLedgerAttributionExport,
  type LedgerAttributionExport,
  type LedgerExclusionReason,
} from './attribution-ledger-export.ts';
import { parseGovernedRegistry, type GovernedExperiment, type PrimaryOutcome } from './campaign-governance.ts';

export const DECISION_REPORT_SCHEMA = 'hsb.decision_report.attribution';
export const DECISION_REPORT_VERSION = 1;

/** Fixed, value-free statements every report carries. */
export const DECISION_REPORT_DECLARATIONS = Object.freeze([
  // GA4 events carry the stored last UTM touch for 30 days, so a later
  // organic or referral visit is credited to the earlier campaign; the ledger
  // primary model is the same last non-direct touch. Controls must match.
  'ATTRIBUTION_MODEL_LAST_UTM_TOUCH_30D',
  // Ad/tracking blockers drop gtag sessions while localStorage attribution
  // still reaches the order: ledger ÷ GA4 sessions rates are biased upward.
  'GA4_DENOMINATOR_UNDERCOUNTS_BLOCKED_SESSIONS',
  'GA4_DENOMINATOR_ALL_LANDING_PATHS',
  'GA4_PURCHASE_BEHAVIORAL_NOT_PAYMENT_AUTHORITY',
  // A conversion paid after the window's last day is not counted.
  'LEDGER_PAID_DAY_WITHIN_WINDOW',
  'NET_PAID_ORDERS_EXCLUDE_FULL_REFUNDS',
  'PRINT_UPGRADE_REVENUE_NOT_IN_OUTCOME',
  // Owner/QA/F&F/sample orders are excluded only when durably marked.
  'UNMARKED_INTERNAL_ORDERS_COUNTED',
] as const);

const EVALUABLE_STATUSES: readonly string[] = ['running', 'paused', 'completed'];
const EXPERIMENT_ID_RE = /^hsb_exp_202[6-9]_(?!000)\d{3}$/;
const DAY_MS = 86_400_000;

type ComputableOutcome = Extract<PrimaryOutcome, 'paid_order_rate' | 'net_revenue_per_session' | 'checkout_start_rate'>;

interface OutcomeEvidence {
  events: string;
  denominator: 'ga4.sessions';
  /** What `outcome.value` counts; revenue is in USD cents, never dollars. */
  unit: string;
}

/** Evidence for each outcome this report can compute; app-sourced outcomes have no producer yet. */
const OUTCOME_EVIDENCE: Readonly<Record<ComputableOutcome, OutcomeEvidence>> = Object.freeze({
  paid_order_rate: { events: 'ledger.net_paid_orders', denominator: 'ga4.sessions', unit: 'net_paid_orders_per_session' },
  net_revenue_per_session: { events: 'ledger.net_paid_orders', denominator: 'ga4.sessions', unit: 'usd_cents_per_session' },
  checkout_start_rate: { events: 'ga4.checkout_starts', denominator: 'ga4.sessions', unit: 'checkout_starts_per_session' },
});

const LEDGER_FIELDS = [
  'paid_orders', 'net_paid_orders', 'fully_refunded_orders', 'partially_refunded_orders', 'settled_cents',
  'refunded_cents', 'net_settled_cents', 'print_upgrade_orders', 'print_upgrade_cents',
] as const;

export interface AttributionDecisionReport {
  schema: typeof DECISION_REPORT_SCHEMA;
  schema_version: typeof DECISION_REPORT_VERSION;
  data_origin: LedgerAttributionExport['data_origin'];
  business: 'hsb';
  experiment_id: string;
  experiment_status: string;
  timezone: string;
  window: { start: string; end: string };
  primary_outcome: ComputableOutcome;
  outcome_evidence: OutcomeEvidence;
  status: 'COMPUTED' | 'INSUFFICIENT_EVIDENCE';
  gates: { min_denominator: number; min_events: number; denominator: number; events: number; denominator_met: boolean; events_met: boolean };
  outcome: { numerator: number; denominator: number; value: number } | null;
  ledger: Record<(typeof LEDGER_FIELDS)[number], number> & {
    authority: 'PAYMENT_AUTHORITY';
    model: 'last_non_direct_touch';
    excluded_orders_all_segments: Partial<Record<LedgerExclusionReason, number>>;
  };
  ga4: { sessions: number; checkout_starts: number; purchase_events: number; purchase_events_authority: 'BEHAVIORAL_NOT_PAYMENT_AUTHORITY' };
  attribution_model: 'LAST_UTM_TOUCH_30D';
  declarations: string[];
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Every day of `window` lies in one of the ordered, disjoint attested ranges. */
function windowAttested(ranges: ReadonlyArray<{ start: string; end: string }>, window: { start: string; end: string }): boolean {
  let cursor = window.start;
  for (const range of [...ranges].sort((a, b) => (a.start < b.start ? -1 : 1))) {
    if (range.start > cursor) break;
    if (range.end >= cursor) cursor = addDays(range.end, 1);
    if (cursor > window.end) return true;
  }
  return cursor > window.end;
}

function covers(coverage: { start: string; end: string }, window: { start: string; end: string }): boolean {
  return coverage.start <= window.start && window.end <= coverage.end;
}

function sameFourTuple(a: GovernedExperiment, b: GovernedExperiment): boolean {
  return a.source === b.source && a.medium === b.medium && a.campaign === b.campaign && a.content === b.content;
}

function prefixed(issues: string[], at: string): string[] {
  return issues.map((issue) => issue.replace(/@\$/, `@$.${at}`));
}

const refuse = (...issues: string[]) => ({ ok: false as const, issues });

export function buildAttributionDecisionReport(input: {
  ledger: unknown;
  ga4: unknown;
  registry: unknown;
  experimentId: unknown;
}): { ok: true; report: AttributionDecisionReport } | { ok: false; issues: string[] } {
  // ── Registry and experiment ──
  const registry = parseGovernedRegistry(input.registry);
  if (registry.issues.length > 0) return refuse('REGISTRY_INVALID@$.registry');
  if (typeof input.experimentId !== 'string' || !EXPERIMENT_ID_RE.test(input.experimentId)) {
    return refuse('EXPERIMENT_ID_FORMAT@$.experiment_id');
  }
  const matches = registry.experiments.filter((experiment) => experiment.experimentId === input.experimentId);
  if (matches.length === 0) return refuse('EXPERIMENT_UNKNOWN@$.experiment_id');
  if (matches.length > 1) return refuse('EXPERIMENT_AMBIGUOUS@$.experiment_id');
  const experiment = matches[0];
  if (!EVALUABLE_STATUSES.includes(experiment.status)) return refuse('EXPERIMENT_NOT_EVALUABLE@$.experiment.status');
  if (!Object.hasOwn(OUTCOME_EVIDENCE, experiment.primaryOutcome)) return refuse('OUTCOME_SOURCE_UNAVAILABLE@$.experiment.primary_outcome');
  const primaryOutcome = experiment.primaryOutcome as ComputableOutcome;

  // ── Input schemas ──
  const ledgerIssues = validateLedgerAttributionExport(input.ledger);
  if (ledgerIssues.length > 0) return refuse(...prefixed(ledgerIssues, 'ledger'));
  const ga4Issues = validateHsbGa4BehaviorExport(input.ga4);
  if (ga4Issues.length > 0) return refuse(...prefixed(ga4Issues, 'ga4'));
  const ledger = input.ledger as LedgerAttributionExport;
  const ga4 = input.ga4 as Ga4BehaviorExport;
  const dataOrigin = (input.registry as { data_origin: string }).data_origin;

  // ── Identity, origin, timezone ──
  if (ledger.registry_sha256 !== registryFingerprint(input.registry)) return refuse('REGISTRY_IDENTITY_MISMATCH@$.ledger.registry_sha256');
  if (ga4.data_origin !== ledger.data_origin) return refuse('DATA_ORIGIN_MISMATCH@$.ga4.data_origin');
  if (dataOrigin !== ledger.data_origin) return refuse('DATA_ORIGIN_MISMATCH@$.registry.data_origin');
  if (ga4.timezone !== ledger.timezone) return refuse('TIMEZONE_MISMATCH@$.ga4.timezone');

  // ── Window completeness ──
  const window = { start: experiment.startDate, end: experiment.endDate };
  if (!covers(ledger.coverage, window)) return refuse('WINDOW_NOT_COVERED@$.ledger.coverage');
  if (!covers(ga4.coverage, window)) return refuse('WINDOW_NOT_COVERED@$.ga4.coverage');
  if (!windowAttested(ga4.attested_complete_ranges, window)) return refuse('GA4_WINDOW_NOT_ATTESTED@$.ga4.attested_complete_ranges');
  if (ledgerIntegrityTouchesWindow(ledger, window)) return refuse('LEDGER_INTEGRITY_INCOMPLETE@$.ledger.integrity_rejections');
  const sharedDenominator = registry.experiments.some((other) => other.experimentId !== experiment.experimentId
    && sameFourTuple(other, experiment)
    && other.startDate <= window.end && window.start <= other.endDate);
  if (sharedDenominator) return refuse('DENOMINATOR_AMBIGUOUS@$.registry');

  // ── Sums ──
  const inWindow = (date: string) => date >= window.start && date <= window.end;
  const segment = `registered:${experiment.experimentId}`;
  const exactLedgerSums = Object.fromEntries(LEDGER_FIELDS.map((field) => [field, BigInt(0)])) as Record<(typeof LEDGER_FIELDS)[number], bigint>;
  for (const row of ledger.rows) {
    if (row.model !== 'last_non_direct_touch' || row.segment !== segment || !inWindow(row.date)) continue;
    for (const field of LEDGER_FIELDS) exactLedgerSums[field] += BigInt(row[field]);
  }
  // Check before conversion, even if future schema bounds permit larger sums.
  const ledgerSums = {} as Record<(typeof LEDGER_FIELDS)[number], number>;
  for (const field of LEDGER_FIELDS) {
    if (exactLedgerSums[field] > BigInt(Number.MAX_SAFE_INTEGER)) {
      return refuse(`INTEGER_OUT_OF_RANGE@$.ledger.${field}`);
    }
    ledgerSums[field] = Number(exactLedgerSums[field]);
  }
  const excluded: Partial<Record<LedgerExclusionReason, number>> = {};
  for (const reason of LEDGER_EXCLUSION_REASONS) {
    const count = ledger.exclusions.filter((row) => row.reason === reason && inWindow(row.date)).reduce((sum, row) => sum + row.orders, 0);
    if (count > 0) excluded[reason] = count;
  }
  const content = experiment.content ?? 'not_set';
  const ga4Sums = { sessions: 0, checkout_starts: 0, purchase_events: 0 };
  for (const row of ga4.rows) {
    if (!inWindow(row.date) || row.source !== experiment.source || row.medium !== experiment.medium
      || row.campaign !== experiment.campaign || row.content !== content) continue;
    ga4Sums.sessions += row.sessions;
    ga4Sums.checkout_starts += row.checkout_starts;
    ga4Sums.purchase_events += row.purchase_events;
  }

  // ── Gates and the one outcome ──
  const events = primaryOutcome === 'checkout_start_rate' ? ga4Sums.checkout_starts : ledgerSums.net_paid_orders;
  const numerator = primaryOutcome === 'net_revenue_per_session' ? ledgerSums.net_settled_cents : events;
  const denominator = ga4Sums.sessions;
  const denominatorMet = denominator >= experiment.minDenominator;
  const eventsMet = events >= experiment.minEvents;
  const computed = denominatorMet && eventsMet;

  return {
    ok: true,
    report: {
      schema: DECISION_REPORT_SCHEMA,
      schema_version: DECISION_REPORT_VERSION,
      data_origin: ledger.data_origin,
      business: 'hsb',
      experiment_id: experiment.experimentId,
      experiment_status: experiment.status,
      timezone: ledger.timezone,
      window,
      primary_outcome: primaryOutcome,
      outcome_evidence: { ...OUTCOME_EVIDENCE[primaryOutcome] },
      status: computed ? 'COMPUTED' : 'INSUFFICIENT_EVIDENCE',
      gates: {
        min_denominator: experiment.minDenominator,
        min_events: experiment.minEvents,
        denominator,
        events,
        denominator_met: denominatorMet,
        events_met: eventsMet,
      },
      outcome: computed ? { numerator, denominator, value: Math.round((numerator / denominator) * 1e6) / 1e6 } : null,
      ledger: {
        authority: 'PAYMENT_AUTHORITY',
        model: 'last_non_direct_touch',
        ...ledgerSums,
        excluded_orders_all_segments: excluded,
      },
      ga4: { ...ga4Sums, purchase_events_authority: 'BEHAVIORAL_NOT_PAYMENT_AUTHORITY' },
      attribution_model: 'LAST_UTM_TOUCH_30D',
      declarations: [...DECISION_REPORT_DECLARATIONS],
    },
  };
}
