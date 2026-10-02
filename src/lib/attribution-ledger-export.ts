/**
 * Read-only ledger attribution export: `hsb.decision_export.ledger` v1.
 *
 * Durable order records → paid orders and money per paid day (in the export
 * timezone) and governed segment class, under two attribution models over the
 * same orders:
 *
 *  - `last_non_direct_touch` (primary): `checkoutAttribution.lastNonDirectTouch`,
 *    falling back to the first touch exactly as the browser's GA4 projection
 *    does (`currentBrowserCampaignParams`);
 *  - `first_touch` (secondary): `checkoutAttribution.firstTouch`.
 *
 * A segment class is `registered:<experiment_id>` (the touch's source, medium,
 * campaign, content and landing path equal one validated registry entry's,
 * and its capture day in the export timezone lies in that entry's inclusive
 * window), `unregistered_governed` (a complete governed tuple that is not),
 * `partial` (a source without a medium or a campaign) or `direct`. No raw
 * campaign value, landing path, timestamp, name, email, address, order or
 * provider identifier is ever emitted.
 *
 * Every record lands in exactly one place, so nothing missing or contradictory
 * is ever treated as safe: outside coverage; a closed exclusion reason
 * (internal disposition, cohort/invite tag, unpaid, $0 settlement); a closed
 * integrity rejection (a record whose payment, refund, upgrade, tracking or
 * attribution facts cannot be trusted); or the counted rows. Owner/QA/F&F/
 * sample orders are excluded only through those durable markers — an unmarked
 * order is counted, so marking them is an operator precondition.
 *
 * Money is the authoritative ledger: `settledAmountCents` (the exact Stripe
 * amount_total accepted at settlement), refunds from the durable refund state,
 * and paid print upgrades in their own columns, never inside settled revenue.
 *
 * Pure apart from hashing; no store, network or clock access.
 */
import { createHash } from 'node:crypto';

import { EXPORT_TIMEZONES } from './analytics-decision-export.ts';
import {
  ATTRIBUTION_ACCEPT_MAX_AGE_MS,
  isCampaignTouch,
  parseAttributionState,
  type AttributionTouch,
} from './attribution-contract.ts';
import {
  DATA_ORIGINS,
  IssueCollector,
  checkClosedObject,
  enumValue,
  integerValue,
  isCalendarDate,
  isPlainRecord,
  parseGovernedRegistry,
  type GovernedExperiment,
} from './campaign-governance.ts';
import { sanitizeCheckoutTrackingValue } from './checkout-tracking.ts';

export const HSB_LEDGER_EXPORT_SCHEMA = 'hsb.decision_export.ledger';
export const HSB_LEDGER_EXPORT_VERSION = 1;

export const LEDGER_MODELS = Object.freeze(['first_touch', 'last_non_direct_touch'] as const);
export type LedgerModel = (typeof LEDGER_MODELS)[number];

/** Closed exclusion reasons, in precedence order: an order is excluded under the first that applies. */
export const LEDGER_EXCLUSION_REASONS = Object.freeze([
  'internal_disposition',
  'cohort_or_invite',
  'unpaid',
  'zero_or_no_payment_required',
] as const);
export type LedgerExclusionReason = (typeof LEDGER_EXCLUSION_REASONS)[number];

export const LEDGER_INTEGRITY_REASONS = Object.freeze([
  'record_invalid',
  'order_identity_invalid',
  'order_identity_duplicate',
  'timestamp_invalid',
  'internal_disposition_invalid',
  'checkout_tracking_invalid',
  'payment_status_invalid',
  'payment_facts_invalid',
  'refund_in_flight',
  'refund_facts_invalid',
  'print_upgrade_facts_invalid',
  'attribution_invalid',
  'registry_match_ambiguous',
] as const);
export type LedgerIntegrityReason = (typeof LEDGER_INTEGRITY_REASONS)[number];

const INTERNAL_DISPOSITIONS: readonly string[] = ['abandoned_internal_test', 'superseded_internal_smoke'];
const UNPAID_STATUSES: readonly string[] = ['pending', 'failed'];
const SETTLED_STATUSES: readonly string[] = ['paid', 'partially_refunded', 'refunded'];
const PRINT_UPGRADE_STATUSES: readonly string[] = [
  'pending', 'cancelled', 'offered', 'checkout_open', 'paid', 'proof_required', 'print_pending', 'declined', 'expired',
];

const MAX_CENTS = 1_000_000_000_000;
const MAX_COUNT = 1_000_000_000;
const MAX_RECORDS = 1_000_000;
const MAX_EXPORT_DAYS = 366;
const DAY_MS = 86_400_000;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SEGMENT_RE = /^(?:direct|partial|unregistered_governed|registered:hsb_exp_202[6-9]_(?!000)\d{3})$/;
// Same canonical identity as checkout/orders; keep the offline export free of store imports.
const ORDER_ID_RE = /^ord_[a-f0-9]{16}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const COUNT_KEYS = [
  'paid_orders', 'settled_cents', 'fully_refunded_orders', 'partially_refunded_orders', 'refunded_cents',
  'net_paid_orders', 'net_settled_cents', 'print_upgrade_orders', 'print_upgrade_cents',
] as const;
type CountKey = (typeof COUNT_KEYS)[number];

export interface LedgerRow extends Record<CountKey, number> {
  date: string;
  model: LedgerModel;
  segment: string;
}

export interface LedgerExclusionRow {
  date: string;
  reason: LedgerExclusionReason;
  orders: number;
}

export interface LedgerIntegrityRow {
  /** Null when the record carries no trustworthy day; such a rejection is in every window. */
  date: string | null;
  reason: LedgerIntegrityReason;
  orders: number;
}

export interface LedgerAttributionExport {
  schema: typeof HSB_LEDGER_EXPORT_SCHEMA;
  schema_version: typeof HSB_LEDGER_EXPORT_VERSION;
  data_origin: (typeof DATA_ORIGINS)[number];
  business: 'hsb';
  timezone: (typeof EXPORT_TIMEZONES)[number];
  generated_at: string;
  coverage: { start: string; end: string };
  registry_sha256: string;
  primary_model: 'last_non_direct_touch';
  secondary_model: 'first_touch';
  totals: { records_read: number; outside_coverage: number; excluded: number; integrity_rejected: number; counted: number };
  rows: LedgerRow[];
  exclusions: LedgerExclusionRow[];
  integrity_rejections: LedgerIntegrityRow[];
}

// ── Small pure helpers ──────────────────────────────────────────────────────

/** An exact `Date#toISOString` instant, as every order timestamp is written. */
function isoInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && TIMESTAMP_RE.test(value) && isoInstant(value.replace('Z', '.000Z')) !== null;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of an instant in one supported timezone. */
export function dayInTimezone(instantMs: number, timezone: string): string {
  let formatter = dayFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function durableIdentity(record: unknown): string | null {
  if (!isPlainRecord(record)) return null;
  const id = record.id;
  return typeof id === 'string' && id.length === 20 && ORDER_ID_RE.test(id) ? id : null;
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function isCents(value: unknown, min: number, max = MAX_CENTS): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of the registry's key-order-independent JSON: binds an export to the registry it was classified with. */
export function registryFingerprint(registry: unknown): string {
  return createHash('sha256').update(canonicalJson(registry)).digest('hex');
}

// ── Segment classification ──────────────────────────────────────────────────

/**
 * One touch's segment class against validated experiments. `ambiguous` (two
 * windows owning one tuple and day) cannot arise from a registry that
 * validates, and is refused rather than resolved if it ever does.
 */
export function classifyLedgerTouch(
  touch: AttributionTouch | null,
  experiments: readonly GovernedExperiment[],
  timezone: string,
): string {
  if (!touch || !isCampaignTouch(touch)) return 'direct';
  if (touch.medium === null || touch.campaign === null) return 'partial';
  const day = dayInTimezone(Date.parse(touch.capturedAt), timezone);
  const matches = experiments.filter((experiment) => experiment.source === touch.source
    && experiment.medium === touch.medium
    && experiment.campaign === touch.campaign
    && experiment.content === touch.content
    && experiment.landingPath === touch.landingPath
    && experiment.startDate <= day
    && day <= experiment.endDate);
  if (matches.length > 1) return 'ambiguous';
  return matches.length === 1 ? `registered:${matches[0].experimentId}` : 'unregistered_governed';
}

// ── One record → one outcome ────────────────────────────────────────────────

type Outcome =
  | { kind: 'outside' }
  | { kind: 'integrity'; date: string | null; reason: LedgerIntegrityReason }
  | { kind: 'excluded'; date: string; reason: LedgerExclusionReason }
  | { kind: 'counted'; date: string; segments: Record<LedgerModel, string>; money: Record<CountKey, number> };

interface Context {
  timezone: string;
  coverage: { start: string; end: string };
  experiments: readonly GovernedExperiment[];
}

function trackingOutcome(value: unknown): 'none' | 'tagged' | 'invalid' {
  if (isAbsent(value)) return 'none';
  if (!isPlainRecord(value)) return 'invalid';
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== 'cohort' && key !== 'invite')) return 'invalid';
  return keys.every((key) => typeof value[key] === 'string'
    && sanitizeCheckoutTrackingValue(value[key]) === value[key]) ? 'tagged' : 'invalid';
}

/** Refunded cents for a settled order, or null when the durable refund state is not internally consistent. */
function refundedCents(record: Record<string, unknown>, settled: number): { full: boolean; cents: number } | null {
  const status = record.paymentStatus;
  const refundedAt = record.refundedAt;
  const amount = record.stripeRefundedAmountCents;
  if (!isAbsent(refundedAt) && isoInstant(refundedAt) === null) return null;
  if (status === 'paid') {
    const clean = isAbsent(refundedAt) && isAbsent(record.stripeRefundId) && (isAbsent(amount) || amount === 0);
    return clean ? { full: false, cents: 0 } : null;
  }
  if (status === 'partially_refunded') {
    return isAbsent(refundedAt) && isCents(amount, 1, settled - 1) ? { full: false, cents: amount } : null;
  }
  // Fully refunded or disputed: the whole settlement is reversed. A recorded
  // amount may be absent (admin refunds, disputes) but never above settlement.
  return isAbsent(amount) || isCents(amount, 0, settled) ? { full: true, cents: settled } : null;
}

function upgradeCents(record: Record<string, unknown>): number | null {
  const status = record.printUpgradeStatus;
  if (isAbsent(status)) return 0;
  if (typeof status !== 'string' || !PRINT_UPGRADE_STATUSES.includes(status)) return null;
  if (status !== 'paid') return 0;
  return isCents(record.printUpgradeAmountCents, 1) && isoInstant(record.printUpgradePaidAt) !== null
    ? record.printUpgradeAmountCents
    : null;
}

function classifyRecord(record: unknown, context: Context): Outcome {
  if (!isPlainRecord(record)) return { kind: 'integrity', date: null, reason: 'record_invalid' };
  const created = isoInstant(record.createdAt);
  const paid = isAbsent(record.paidAt) ? null : isoInstant(record.paidAt);
  const paidInvalid = !isAbsent(record.paidAt) && paid === null;
  // A settlement cannot inherit a creation day: its unknown paid day may
  // intersect any decision window, even when creation was outside coverage.
  if (typeof record.paymentStatus === 'string' && SETTLED_STATUSES.includes(record.paymentStatus) && paid === null) {
    return { kind: 'integrity', date: null, reason: created === null || paidInvalid ? 'timestamp_invalid' : 'payment_facts_invalid' };
  }
  const instant = paid ?? created;
  const date = instant === null ? null : dayInTimezone(instant, context.timezone);
  if (date !== null && (date < context.coverage.start || date > context.coverage.end)) return { kind: 'outside' };
  if (created === null || paidInvalid) return { kind: 'integrity', date, reason: 'timestamp_invalid' };
  const day = date!;
  const integrity = (reason: LedgerIntegrityReason): Outcome => ({ kind: 'integrity', date: day, reason });
  const excluded = (reason: LedgerExclusionReason): Outcome => ({ kind: 'excluded', date: day, reason });

  const disposition = record.internalDisposition;
  if (!isAbsent(disposition)) {
    return typeof disposition === 'string' && INTERNAL_DISPOSITIONS.includes(disposition)
      ? excluded('internal_disposition')
      : integrity('internal_disposition_invalid');
  }
  const tracking = trackingOutcome(record.checkoutTracking);
  if (tracking === 'invalid') return integrity('checkout_tracking_invalid');
  if (tracking === 'tagged') return excluded('cohort_or_invite');

  const status = record.paymentStatus;
  if (typeof status === 'string' && UNPAID_STATUSES.includes(status)) return excluded('unpaid');
  if (typeof status !== 'string' || !SETTLED_STATUSES.includes(status)) return integrity('payment_status_invalid');
  const settled = record.settledAmountCents;
  if (paid === null || !isCents(settled, 0)) return integrity('payment_facts_invalid');
  if (settled === 0) return excluded('zero_or_no_payment_required');
  if (!isAbsent(record.refundClaimId)) return integrity('refund_in_flight');
  const refund = refundedCents(record, settled);
  if (!refund) return integrity('refund_facts_invalid');
  const upgrade = upgradeCents(record);
  if (upgrade === null) return integrity('print_upgrade_facts_invalid');

  let first: AttributionTouch | null = null;
  let last: AttributionTouch | null = null;
  if (!isAbsent(record.checkoutAttribution)) {
    // Re-validated exactly as the checkout API accepted it, relative to the
    // order's own creation instant.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(record.checkoutAttribution);
    } catch {
      serialized = undefined;
    }
    const state = parseAttributionState(serialized, { now: created, maxAgeMs: ATTRIBUTION_ACCEPT_MAX_AGE_MS });
    if (!state) return integrity('attribution_invalid');
    first = state.firstTouch;
    last = state.lastNonDirectTouch ?? state.firstTouch;
  }
  const segments: Record<LedgerModel, string> = {
    last_non_direct_touch: classifyLedgerTouch(last, context.experiments, context.timezone),
    first_touch: classifyLedgerTouch(first, context.experiments, context.timezone),
  };
  if (segments.last_non_direct_touch === 'ambiguous' || segments.first_touch === 'ambiguous') {
    return integrity('registry_match_ambiguous');
  }

  return {
    kind: 'counted',
    date: day,
    segments,
    money: {
      paid_orders: 1,
      settled_cents: settled,
      fully_refunded_orders: refund.full ? 1 : 0,
      partially_refunded_orders: refund.full || refund.cents === 0 ? 0 : 1,
      refunded_cents: refund.cents,
      net_paid_orders: refund.full ? 0 : 1,
      net_settled_cents: settled - refund.cents,
      print_upgrade_orders: upgrade > 0 ? 1 : 0,
      print_upgrade_cents: upgrade,
    },
  };
}

// ── Export ──────────────────────────────────────────────────────────────────

export interface LedgerExportInput {
  orders: readonly unknown[];
  registry: unknown;
  timezone: string;
  coverage: { start: string; end: string };
  generatedAt: string;
  dataOrigin: string;
}

function headerIssues(input: LedgerExportInput, out: IssueCollector): void {
  enumValue(DATA_ORIGINS, input.dataOrigin, '$.data_origin', out);
  if (!(EXPORT_TIMEZONES as readonly string[]).includes(input.timezone)) out.add('TIMEZONE_UNSUPPORTED', '$.timezone');
  const coverage = input.coverage;
  if (!isPlainRecord(coverage) || !isCalendarDate(coverage.start) || !isCalendarDate(coverage.end)) out.add('INVALID_DATE', '$.coverage');
  else if (coverage.start > coverage.end) out.add('RANGE_INVALID', '$.coverage');
  else if ((Date.parse(coverage.end) - Date.parse(coverage.start)) / DAY_MS >= MAX_EXPORT_DAYS) out.add('RANGE_TOO_LONG', '$.coverage');
  if (!isTimestamp(input.generatedAt)) out.add('INVALID_TIMESTAMP', '$.generated_at');
  else if (out.count === 0 && dayInTimezone(Date.parse(input.generatedAt), input.timezone) <= coverage.end) {
    // A day that has not ended in the export timezone cannot be complete.
    out.add('COVERAGE_AFTER_GENERATED_AT', '$.coverage.end');
  }
}

function compare(a: readonly (string | null)[], b: readonly (string | null)[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? '';
    const right = b[index] ?? '';
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * The closed ledger export, or value-free issues. Refuses an invalid
 * registry, header, coverage or clock; never refuses because of one record —
 * a record that cannot be trusted is counted as an integrity rejection.
 */
export function buildLedgerAttributionExport(input: LedgerExportInput):
  | { ok: true; document: LedgerAttributionExport }
  | { ok: false; issues: string[] } {
  const out = new IssueCollector();
  if (!Array.isArray(input.orders) || input.orders.length > MAX_RECORDS) {
    out.add('TYPE_ARRAY', '$.orders');
    return { ok: false, issues: out.issues };
  }
  const registry = parseGovernedRegistry(input.registry);
  if (registry.issues.length > 0) out.add('REGISTRY_INVALID', '$.registry');
  headerIssues(input, out);
  if (out.count > 0) return { ok: false, issues: out.issues };

  const context: Context = { timezone: input.timezone, coverage: input.coverage, experiments: registry.experiments };
  const rows = new Map<string, LedgerRow>();
  const exclusions = new Map<string, LedgerExclusionRow>();
  const integrity = new Map<string, LedgerIntegrityRow>();
  const totals = { records_read: input.orders.length, outside_coverage: 0, excluded: 0, integrity_rejected: 0, counted: 0 };

  // Inspect the whole snapshot before scoping. Reject ALL copies, not just
  // the second, so conflicting facts cannot be resolved by input order.
  // Identities stay solely in memory and never enter diagnostics or output.
  const identities = new Map<string, number>();
  for (const record of input.orders) {
    const id = durableIdentity(record);
    if (id !== null) identities.set(id, (identities.get(id) ?? 0) + 1);
  }
  for (const record of input.orders) {
    const id = durableIdentity(record);
    const outcome: Outcome = !isPlainRecord(record)
      ? { kind: 'integrity', date: null, reason: 'record_invalid' }
      : id === null
        ? { kind: 'integrity', date: null, reason: 'order_identity_invalid' }
        : identities.get(id)! > 1
          ? { kind: 'integrity', date: null, reason: 'order_identity_duplicate' }
          : classifyRecord(record, context);
    if (outcome.kind === 'outside') {
      totals.outside_coverage += 1;
    } else if (outcome.kind === 'integrity') {
      totals.integrity_rejected += 1;
      const key = JSON.stringify([outcome.date, outcome.reason]);
      const row = integrity.get(key) ?? { date: outcome.date, reason: outcome.reason, orders: 0 };
      row.orders += 1;
      integrity.set(key, row);
    } else if (outcome.kind === 'excluded') {
      totals.excluded += 1;
      const key = JSON.stringify([outcome.date, outcome.reason]);
      const row = exclusions.get(key) ?? { date: outcome.date, reason: outcome.reason, orders: 0 };
      row.orders += 1;
      exclusions.set(key, row);
    } else {
      totals.counted += 1;
      for (const model of LEDGER_MODELS) {
        const segment = outcome.segments[model];
        const key = JSON.stringify([outcome.date, model, segment]);
        let row = rows.get(key);
        if (!row) {
          row = { date: outcome.date, model, segment, ...Object.fromEntries(COUNT_KEYS.map((field) => [field, 0])) } as LedgerRow;
          rows.set(key, row);
        }
        for (const field of COUNT_KEYS) row[field] += outcome.money[field];
      }
    }
  }

  const document: LedgerAttributionExport = {
    schema: HSB_LEDGER_EXPORT_SCHEMA,
    schema_version: HSB_LEDGER_EXPORT_VERSION,
    data_origin: input.dataOrigin as LedgerAttributionExport['data_origin'],
    business: 'hsb',
    timezone: input.timezone as LedgerAttributionExport['timezone'],
    generated_at: input.generatedAt,
    coverage: { start: input.coverage.start, end: input.coverage.end },
    registry_sha256: registryFingerprint(input.registry),
    primary_model: 'last_non_direct_touch',
    secondary_model: 'first_touch',
    totals,
    rows: [...rows.values()].sort((a, b) => compare([a.date, a.model, a.segment], [b.date, b.model, b.segment])),
    exclusions: [...exclusions.values()].sort((a, b) => compare([a.date, a.reason], [b.date, b.reason])),
    integrity_rejections: [...integrity.values()].sort((a, b) => compare([a.date, a.reason], [b.date, b.reason])),
  };
  // Revalidate at the boundary: the builder's output passes the same closed schema as any other input.
  const issues = validateLedgerAttributionExport(document);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, document };
}

// ── Closed validator ────────────────────────────────────────────────────────

const HEADER_KEYS = [
  'schema', 'schema_version', 'data_origin', 'business', 'timezone', 'generated_at', 'coverage', 'registry_sha256',
  'primary_model', 'secondary_model', 'totals', 'rows', 'exclusions', 'integrity_rejections',
] as const;
const TOTAL_KEYS = ['records_read', 'outside_coverage', 'excluded', 'integrity_rejected', 'counted'] as const;
const ROW_KEYS = ['date', 'model', 'segment', ...COUNT_KEYS] as const;
const MAX_ROWS = 250_000;

function dayInCoverage(value: unknown, coverage: { start: string; end: string } | null, path: string, out: IssueCollector): boolean {
  if (!isCalendarDate(value)) {
    out.add('INVALID_DATE', path);
    return false;
  }
  if (coverage && (value < coverage.start || value > coverage.end)) {
    out.add('ROW_OUTSIDE_COVERAGE', path);
    return false;
  }
  return true;
}

/** Value-free `CODE@$.path` issues; an empty array means the ledger export is closed and consistent. */
export function validateLedgerAttributionExport(doc: unknown): string[] {
  const out = new IssueCollector();
  if (!isPlainRecord(doc)) {
    out.add('DOCUMENT_NOT_OBJECT', '$');
    return out.issues;
  }
  if (doc.schema !== HSB_LEDGER_EXPORT_SCHEMA) {
    out.add('SCHEMA_INVALID', '$.schema');
    return out.issues;
  }
  if (doc.schema_version !== HSB_LEDGER_EXPORT_VERSION) {
    out.add('SCHEMA_VERSION_UNSUPPORTED', '$.schema_version');
    return out.issues;
  }
  checkClosedObject(doc, HEADER_KEYS, '$', out);
  enumValue(DATA_ORIGINS, doc.data_origin, '$.data_origin', out);
  enumValue(['hsb'], doc.business, '$.business', out);
  const timezone = enumValue(EXPORT_TIMEZONES, doc.timezone, '$.timezone', out);
  enumValue(['last_non_direct_touch'], doc.primary_model, '$.primary_model', out);
  enumValue(['first_touch'], doc.secondary_model, '$.secondary_model', out);
  if (typeof doc.registry_sha256 !== 'string' || !SHA256_RE.test(doc.registry_sha256)) out.add('REGISTRY_FINGERPRINT_INVALID', '$.registry_sha256');

  let coverage: { start: string; end: string } | null = null;
  if (checkClosedObject(doc.coverage, ['start', 'end'], '$.coverage', out)) {
    if (!isCalendarDate(doc.coverage.start) || !isCalendarDate(doc.coverage.end)) out.add('INVALID_DATE', '$.coverage');
    else if (doc.coverage.start > doc.coverage.end) out.add('RANGE_INVALID', '$.coverage');
    else if ((Date.parse(doc.coverage.end) - Date.parse(doc.coverage.start)) / DAY_MS >= MAX_EXPORT_DAYS) {
      out.add('RANGE_TOO_LONG', '$.coverage');
      return out.issues;
    } else coverage = { start: doc.coverage.start, end: doc.coverage.end };
  }
  if (!isTimestamp(doc.generated_at)) out.add('INVALID_TIMESTAMP', '$.generated_at');
  else if (coverage && timezone && dayInTimezone(Date.parse(doc.generated_at), timezone) <= coverage.end) {
    out.add('COVERAGE_AFTER_GENERATED_AT', '$.coverage.end');
  }

  let totals: Record<(typeof TOTAL_KEYS)[number], number> | null = null;
  if (checkClosedObject(doc.totals, TOTAL_KEYS, '$.totals', out)) {
    const values = TOTAL_KEYS.map((key) => integerValue((doc.totals as Record<string, unknown>)[key], 0, MAX_RECORDS, `$.totals.${key}`, out));
    if (values.every((value) => value !== null)) totals = Object.fromEntries(TOTAL_KEYS.map((key, index) => [key, values[index]!])) as typeof totals;
  }

  const counted: Record<LedgerModel, number> = { first_touch: 0, last_non_direct_touch: 0 };
  // Segment assignments differ by model; every paid-day count and money
  // allocation must nevertheless agree. BigInt keeps large sums exact.
  const dayBalances = new Map<string, bigint[]>();
  let rowsValid = Array.isArray(doc.rows) && doc.rows.length <= MAX_ROWS;
  if (!rowsValid) out.add('TYPE_ARRAY', '$.rows');
  else {
    const seen = new Set<string>();
    (doc.rows as unknown[]).forEach((row, index) => {
      const path = `$.rows[${index}]`;
      const before = out.count;
      if (!checkClosedObject(row, ROW_KEYS, path, out)) return;
      dayInCoverage(row.date, coverage, `${path}.date`, out);
      const model = enumValue(LEDGER_MODELS, row.model, `${path}.model`, out);
      if (typeof row.segment !== 'string' || !SEGMENT_RE.test(row.segment)) out.add('SEGMENT_INVALID', `${path}.segment`);
      for (const field of COUNT_KEYS) {
        integerValue(row[field], 0, field.endsWith('_cents') ? MAX_CENTS : MAX_COUNT, `${path}.${field}`, out);
      }
      if (out.count !== before) {
        rowsValid = false;
        return;
      }
      const r = row as unknown as LedgerRow;
      const consistent = r.paid_orders >= 1
        && r.net_paid_orders === r.paid_orders - r.fully_refunded_orders
        && r.net_settled_cents === r.settled_cents - r.refunded_cents
        && r.fully_refunded_orders + r.partially_refunded_orders <= r.paid_orders
        && r.print_upgrade_orders <= r.paid_orders
        && (r.print_upgrade_orders === 0) === (r.print_upgrade_cents === 0);
      if (!consistent) out.add('ROW_INVARIANT', path);
      const key = JSON.stringify([r.date, r.model, r.segment]);
      if (seen.has(key)) out.add('DUPLICATE_ROW', path);
      seen.add(key);
      counted[model!] += r.paid_orders;
      const balance = dayBalances.get(r.date) ?? COUNT_KEYS.map(() => BigInt(0));
      const sign = model === 'first_touch' ? BigInt(1) : BigInt(-1);
      COUNT_KEYS.forEach((field, index) => { balance[index] += sign * BigInt(r[field]); });
      dayBalances.set(r.date, balance);
    });
  }
  // Equality per day implies equality over the entire coverage and every
  // decision subwindow, for ALL counts, refunds, revenue and print upgrades.
  if (rowsValid && [...dayBalances.values()].some((balance) => balance.some((value) => value !== BigInt(0)))) {
    out.add('MODEL_TOTALS_MISMATCH', '$.rows');
  }

  const sumReasons = (field: 'exclusions' | 'integrity_rejections', reasons: readonly string[], allowUndated: boolean): number | null => {
    const value = doc[field];
    if (!Array.isArray(value) || value.length > MAX_ROWS) {
      out.add('TYPE_ARRAY', `$.${field}`);
      return null;
    }
    let sum = 0;
    let valid = true;
    const seen = new Set<string>();
    value.forEach((row, index) => {
      const path = `$.${field}[${index}]`;
      const before = out.count;
      if (!checkClosedObject(row, ['date', 'reason', 'orders'], path, out)) {
        valid = false;
        return;
      }
      if (!(allowUndated && row.date === null)) dayInCoverage(row.date, coverage, `${path}.date`, out);
      enumValue(reasons, row.reason, `${path}.reason`, out);
      const orders = integerValue(row.orders, 1, MAX_RECORDS, `${path}.orders`, out);
      if (out.count !== before) {
        valid = false;
        return;
      }
      const key = JSON.stringify([row.date, row.reason]);
      if (seen.has(key)) out.add('DUPLICATE_ROW', path);
      seen.add(key);
      sum += orders!;
    });
    return valid ? sum : null;
  };
  const excluded = sumReasons('exclusions', LEDGER_EXCLUSION_REASONS, false);
  const rejected = sumReasons('integrity_rejections', LEDGER_INTEGRITY_REASONS, true);

  if (totals && rowsValid && excluded !== null && rejected !== null) {
    const consistent = totals.excluded === excluded
      && totals.integrity_rejected === rejected
      && totals.counted === counted.last_non_direct_touch
      && totals.records_read === totals.outside_coverage + totals.excluded + totals.integrity_rejected + totals.counted;
    if (!consistent) out.add('TOTALS_MISMATCH', '$.totals');
  }
  return out.issues;
}

/** Whether any integrity rejection could fall on a day of `window` (undated ones always can). */
export function ledgerIntegrityTouchesWindow(doc: LedgerAttributionExport, window: { start: string; end: string }): boolean {
  return doc.integrity_rejections.some((row) => row.date === null || (row.date >= window.start && row.date <= window.end));
}
