/**
 * The decision report join: ledger export × HSB-native GA4 behavior export ×
 * experiment registry → one registered experiment's declared primary outcome,
 * computed only when its denominator and event gates pass. Payment authority
 * is the ledger; the GA4 purchase count is labelled behavioral only. The
 * attribution model and the GA4 denominator limitations are declared in
 * fixed fields. Identity, window, schema and completeness mismatches refuse.
 * All fixtures are synthetic.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Ga4BehaviorExport, Ga4BehaviorExportRow } from '../src/lib/analytics-decision-export.ts';
import { validateHsbGa4BehaviorExport } from '../src/lib/analytics-decision-export.ts';
import type { AttributionTouch } from '../src/lib/attribution-contract.ts';
import { buildAttributionDecisionReport, DECISION_REPORT_DECLARATIONS } from '../src/lib/attribution-decision-report.ts';
import { buildLedgerAttributionExport, type LedgerAttributionExport } from '../src/lib/attribution-ledger-export.ts';

type Rec = Record<string, any>;

const EXPERIMENT: Rec = {
  experiment_id: 'hsb_exp_2026_001',
  business: 'hsb',
  status: 'running',
  start_date: '2026-10-03',
  end_date: '2026-10-10',
  source: 'facebook',
  medium: 'paid_social',
  campaign: '2026-10-holiday',
  content: 'video-a',
  landing_path: '/gifts/holidays',
  budget: { amount_minor: 150000, currency: 'USD' },
  primary_outcome: 'paid_order_rate',
  evidence_threshold: { min_denominator: 200, min_events: 2 },
  decision: 'pending',
};

function registry(experiments: Rec[] = [EXPERIMENT]): Rec {
  return {
    schema: 'hsb.experiment_registry',
    schema_version: 1,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    currency: 'USD',
    experiments: experiments.map((experiment) => structuredClone(experiment)),
  };
}

const withExperiment = (change: Rec): Rec => registry([{ ...EXPERIMENT, ...change }]);

// ── Synthetic ledger ────────────────────────────────────────────────────────

function iso(base: string, plusMs: number): string {
  return new Date(Date.parse(base) + plusMs).toISOString();
}

function touch(capturedAt: string, over: Partial<AttributionTouch> = {}): AttributionTouch {
  return {
    source: 'facebook', medium: 'paid_social', campaign: '2026-10-holiday', content: 'video-a', term: null,
    landingPath: '/gifts/holidays', capturedAt, ...over,
  };
}

let serial = 0;
function order(capture: string, over: Rec = {}, lastOver: Partial<AttributionTouch> = {}, firstOver: Partial<AttributionTouch> = {}): Rec {
  serial += 1;
  const created = iso(capture, 3_600_000);
  return {
    id: `ord_${serial.toString(16).padStart(16, '0')}`,
    email: 'synthetic-buyer@example.invalid',
    childName: 'Synthetic Hero',
    bookFormat: 'digital',
    formatLabel: 'Digital Storybook',
    priceCents: 3900,
    status: 'order_received',
    paymentStatus: 'paid',
    paidAt: iso(capture, 7_200_000),
    settledAmountCents: 3900,
    checkoutAttribution: { version: 1, firstTouch: touch(capture, firstOver), lastNonDirectTouch: touch(capture, lastOver) },
    deliveryExpectation: 'Synthetic',
    createdAt: created,
    updatedAt: created,
    ...over,
  };
}

/** Oct 4, 6 and 8 at 10:00 CDT, inside the Oct 3–10 window. */
const IN_WINDOW = ['2026-10-04T15:00:00.000Z', '2026-10-06T15:00:00.000Z', '2026-10-08T15:00:00.000Z'];

function ledgerOrders(): Rec[] {
  return [
    order(IN_WINDOW[0]),
    order(IN_WINDOW[1], { paymentStatus: 'partially_refunded', stripeRefundedAmountCents: 1000 }),
    order(IN_WINDOW[2], { paymentStatus: 'refunded', refundedAt: '2026-10-09T00:00:00.000Z', printUpgradeStatus: 'paid', printUpgradeAmountCents: 2000, printUpgradePaidAt: '2026-10-09T01:00:00.000Z' }),
    // Captured on the last window day, paid on Oct 11 (Chicago): outside the window's paid days.
    order('2026-10-11T02:00:00.000Z', { paidAt: '2026-10-11T06:00:00.000Z' }),
    // Registered first touch, partial last touch: only the secondary model would count it.
    order(IN_WINDOW[0], {}, { medium: null }),
    // A mistyped sibling: governed, but not this experiment's tuple.
    order(IN_WINDOW[1], {}, { content: 'video-b' }, { content: 'video-b' }),
    order(IN_WINDOW[1], { internalDisposition: 'abandoned_internal_test' }),
    order(IN_WINDOW[2], { checkoutTracking: { cohort: 'ff_pilot' } }),
    // Excluded, but after the window: not in the window's exclusion counts.
    order('2026-10-20T15:00:00.000Z', { internalDisposition: 'superseded_internal_smoke' }),
  ];
}

function ledger(over: Rec = {}): LedgerAttributionExport {
  const result = buildLedgerAttributionExport({
    orders: ledgerOrders(),
    registry: registry(),
    timezone: 'America/Chicago',
    coverage: { start: '2026-10-01', end: '2026-10-31' },
    generatedAt: '2026-11-02T12:00:00Z',
    dataOrigin: 'synthetic_fixture',
    ...over,
  } as never);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { document: LedgerAttributionExport }).document;
}

// ── Synthetic GA4 behavior export ───────────────────────────────────────────

function day(offset: number): string {
  return iso('2026-10-01T00:00:00.000Z', offset * 86_400_000).slice(0, 10);
}

function ga4(over: Partial<Ga4BehaviorExport> = {}): Ga4BehaviorExport {
  const rows: Ga4BehaviorExportRow[] = [];
  const tuple = { source: 'facebook', medium: 'paid_social', campaign: '2026-10-holiday' };
  for (let index = 0; index < 31; index += 1) {
    const date = day(index);
    rows.push({ date, ...tuple, content: 'video-a', landing_path: '/gifts/holidays', sessions: 20, checkout_starts: 3, purchase_events: 1 });
    // Return visits under the 30-day last-UTM model land elsewhere but keep the tuple.
    rows.push({ date, ...tuple, content: 'video-a', landing_path: '/', sessions: 5, checkout_starts: 0, purchase_events: 0 });
    rows.push({ date, ...tuple, content: 'video-b', landing_path: '/gifts/holidays', sessions: 50, checkout_starts: 9, purchase_events: 4 });
    rows.push({ date, source: 'direct', medium: 'none', campaign: 'none', content: 'not_set', landing_path: '/', sessions: 70, checkout_starts: 5, purchase_events: 2 });
  }
  return {
    schema: 'hsb.decision_export.ga4_behavior',
    schema_version: 1,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    timezone: 'America/Chicago',
    generated_at: '2026-11-03T12:00:00Z',
    coverage: { start: '2026-10-01', end: '2026-10-31' },
    attested_complete_ranges: [{ start: '2026-10-01', end: '2026-10-31' }],
    quality: { sampled: false, thresholded: false, other_row: false },
    rows,
    ...over,
  };
}

function report(over: Rec = {}) {
  return buildAttributionDecisionReport({ ledger: ledger(), ga4: ga4(), registry: registry(), experimentId: 'hsb_exp_2026_001', ...over });
}

function computed(over: Rec = {}) {
  const result = report(over);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { ok: true; report: Rec }).report;
}

test('undated settlements and malformed tracking fail closed at the decision boundary', () => {
  for (const over of [{ checkoutTracking: { cohort: null } }, ...[undefined, null, 'invalid'].flatMap((paidAt) =>
    ['2026-09-01T12:00:00.000Z', '2026-10-02T12:00:00.000Z', '2026-12-01T12:00:00.000Z'].map((createdAt) => ({ paidAt, createdAt })))]) {
    const result = report({ ledger: ledger({ orders: [...ledgerOrders(), order(IN_WINDOW[0], over)] }) });
    assert.deepEqual(result, { ok: false, issues: ['LEDGER_INTEGRITY_INCOMPLETE@$.ledger.integrity_rejections'] });
  }
});

test('duplicate paid identities cannot satisfy the decision evidence threshold', () => {
  const single = order(IN_WINDOW[0]);
  assert.equal(computed({ ledger: ledger({ orders: [single] }) }).status, 'INSUFFICIENT_EVIDENCE');
  const result = report({ ledger: ledger({ orders: [single, structuredClone(single)] }) });
  assert.deepEqual(result, { ok: false, issues: ['LEDGER_INTEGRITY_INCOMPLETE@$.ledger.integrity_rejections'] });
});

test('malformed identities cannot inflate the evidence threshold or escape the window', () => {
  const valid = order(IN_WINDOW[0]);
  assert.equal(computed({ ledger: ledger({ orders: [valid] }) }).status, 'INSUFFICIENT_EVIDENCE');
  for (const id of [undefined, null, '', ' ', 42, false, {}, [], 'ord_bad',
    ['ord_', '0123456789abcdef', '\n'].join(''), 'private-identity@example.invalid']) {
    const bad = order(IN_WINDOW[0], { id });
    for (const orders of [[bad], [bad, structuredClone(bad)], [valid, bad],
      [valid, { ...bad, paidAt: '2026-12-01T12:00:00.000Z' }],
      [valid, { ...bad, internalDisposition: 'abandoned_internal_test' }]]) {
      assert.deepEqual(report({ ledger: ledger({ orders }) }), {
        ok: false, issues: ['LEDGER_INTEGRITY_INCOMPLETE@$.ledger.integrity_rejections'],
      });
    }
  }
});

/** Balanced, row-bounded cents; no unsafe Number is used to construct the fixture. */
function largeRevenue(total: bigint, days: number) {
  const end = day(days - 1);
  const reg = withExperiment({ start_date: day(0), end_date: end, primary_outcome: 'net_revenue_per_session' });
  const doc = ledger({ orders: [], registry: reg });
  doc.coverage = { start: day(0), end };
  doc.generated_at = `${day(days + 1)}T12:00:00Z`;
  let remaining = total;
  for (let index = 0; index < days; index += 1) {
    const cents = remaining > BigInt(1_000_000_000_000) ? BigInt(1_000_000_000_000) : remaining;
    remaining -= cents;
    for (const model of ['first_touch', 'last_non_direct_touch'] as const) {
      doc.rows.push({ date: day(index), model, segment: 'registered:hsb_exp_2026_001',
        paid_orders: 1, net_paid_orders: 1, fully_refunded_orders: 0, partially_refunded_orders: 0,
        settled_cents: Number(cents), net_settled_cents: Number(cents), refunded_cents: 0,
        print_upgrade_orders: 1, print_upgrade_cents: Number(cents) });
    }
  }
  assert.equal(remaining, BigInt(0));
  doc.totals.records_read = days;
  doc.totals.counted = days;
  const behavior = ga4({ coverage: doc.coverage, generated_at: doc.generated_at,
    attested_complete_ranges: [doc.coverage], rows: [] });
  for (let index = 0; index < days; index += 1) {
    behavior.rows.push({ date: day(index), source: 'facebook', medium: 'paid_social', campaign: '2026-10-holiday',
      content: 'video-a', landing_path: '/', sessions: 200, checkout_starts: 1, purchase_events: 1 });
  }
  return { ledger: doc, registry: reg, ga4: behavior };
}

test('10000-day exact 9999000000000001-cent adversary refuses before computation', () => {
  const input = largeRevenue(BigInt('9999000000000001'), 10_000);
  assert.equal(input.ledger.rows.filter((r) => r.model === 'last_non_direct_touch')
    .reduce((sum, row) => sum + BigInt(row.net_settled_cents), BigInt(0)), BigInt('9999000000000001'));
  assert.deepEqual(report(input), { ok: false, issues: ['RANGE_TOO_LONG@$.ledger.coverage'] });
});

test('safe-integer boundary totals never bypass the supported coverage bound', () => {
  for (const delta of [-1, 0, 1, 2]) {
    const input = largeRevenue(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(delta), 9008);
    assert.deepEqual(report(input), { ok: false, issues: ['RANGE_TOO_LONG@$.ledger.coverage'] });
  }
});

test('maximum supported coverage preserves exact cents for every reported money field', () => {
  const total = BigInt(366) * BigInt(1_000_000_000_000);
  const input = largeRevenue(total, 366);
  const result = computed(input);
  assert.equal(result.status, 'COMPUTED');
  for (const field of ['settled_cents', 'net_settled_cents', 'print_upgrade_cents']) {
    assert.equal(BigInt(result.ledger[field]), total);
    assert.ok(Number.isSafeInteger(result.ledger[field]));
  }
  assert.equal(result.ledger.refunded_cents, 0);
  assert.equal(BigInt(result.outcome.numerator), total);
  const reversed = { ...input, ledger: { ...input.ledger, rows: [...input.ledger.rows].reverse() } };
  assert.deepEqual(computed(reversed), result);
});

test('tampered primary revenue refuses rather than computing a revenue outcome', () => {
  const reg = withExperiment({ primary_outcome: 'net_revenue_per_session' });
  const doc = ledger({ registry: reg });
  const row = doc.rows.find((row) => row.model === 'last_non_direct_touch' && row.segment === 'registered:hsb_exp_2026_001')!;
  row.settled_cents += 10000;
  row.net_settled_cents += 10000;
  assert.deepEqual(report({ ledger: doc, registry: reg }), { ok: false, issues: ['MODEL_TOTALS_MISMATCH@$.ledger.rows'] });
});

test('the synthetic fixtures are themselves valid exports', () => {
  assert.deepEqual(validateHsbGa4BehaviorExport(ga4()), []);
  assert.equal(ledger().totals.counted, 6);
});

// ── The computed outcome ────────────────────────────────────────────────────

test('a registered experiment with passing gates yields its exact primary outcome and fixed declarations', () => {
  assert.deepEqual(computed(), {
    schema: 'hsb.decision_report.attribution',
    schema_version: 1,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    experiment_id: 'hsb_exp_2026_001',
    experiment_status: 'running',
    timezone: 'America/Chicago',
    window: { start: '2026-10-03', end: '2026-10-10' },
    primary_outcome: 'paid_order_rate',
    outcome_evidence: { events: 'ledger.net_paid_orders', denominator: 'ga4.sessions', unit: 'net_paid_orders_per_session' },
    status: 'COMPUTED',
    gates: { min_denominator: 200, min_events: 2, denominator: 200, events: 2, denominator_met: true, events_met: true },
    outcome: { numerator: 2, denominator: 200, value: 0.01 },
    ledger: {
      authority: 'PAYMENT_AUTHORITY',
      model: 'last_non_direct_touch',
      paid_orders: 3,
      net_paid_orders: 2,
      fully_refunded_orders: 1,
      partially_refunded_orders: 1,
      settled_cents: 11700,
      refunded_cents: 4900,
      net_settled_cents: 6800,
      print_upgrade_orders: 1,
      print_upgrade_cents: 2000,
      excluded_orders_all_segments: { internal_disposition: 1, cohort_or_invite: 1 },
    },
    ga4: {
      sessions: 200,
      checkout_starts: 24,
      purchase_events: 8,
      purchase_events_authority: 'BEHAVIORAL_NOT_PAYMENT_AUTHORITY',
    },
    attribution_model: 'LAST_UTM_TOUCH_30D',
    declarations: [...DECISION_REPORT_DECLARATIONS],
  });
  assert.deepEqual([...DECISION_REPORT_DECLARATIONS], [
    'ATTRIBUTION_MODEL_LAST_UTM_TOUCH_30D',
    'GA4_DENOMINATOR_UNDERCOUNTS_BLOCKED_SESSIONS',
    'GA4_DENOMINATOR_ALL_LANDING_PATHS',
    'GA4_PURCHASE_BEHAVIORAL_NOT_PAYMENT_AUTHORITY',
    'LEDGER_PAID_DAY_WITHIN_WINDOW',
    'NET_PAID_ORDERS_EXCLUDE_FULL_REFUNDS',
    'PRINT_UPGRADE_REVENUE_NOT_IN_OUTCOME',
    'UNMARKED_INTERNAL_ORDERS_COUNTED',
  ]);
});

test('each computable primary outcome uses only its own declared evidence', () => {
  const revenue = computed({ registry: withExperiment({ primary_outcome: 'net_revenue_per_session' }), ledger: ledger({ registry: withExperiment({ primary_outcome: 'net_revenue_per_session' }) }) });
  assert.deepEqual(revenue.outcome_evidence, { events: 'ledger.net_paid_orders', denominator: 'ga4.sessions', unit: 'usd_cents_per_session' });
  assert.deepEqual(revenue.outcome, { numerator: 6800, denominator: 200, value: 34 });
  const starts = computed({ registry: withExperiment({ primary_outcome: 'checkout_start_rate' }), ledger: ledger({ registry: withExperiment({ primary_outcome: 'checkout_start_rate' }) }) });
  assert.deepEqual(starts.outcome_evidence, { events: 'ga4.checkout_starts', denominator: 'ga4.sessions', unit: 'checkout_starts_per_session' });
  assert.deepEqual(starts.outcome, { numerator: 24, denominator: 200, value: 0.12 });
  assert.deepEqual(starts.gates, { min_denominator: 200, min_events: 2, denominator: 200, events: 24, denominator_met: true, events_met: true });
});

test('the GA4 purchase count never moves a payment outcome', () => {
  const inflated = ga4();
  for (const row of inflated.rows) row.purchase_events = row.sessions;
  const result = computed({ ga4: inflated });
  assert.deepEqual(result.outcome, { numerator: 2, denominator: 200, value: 0.01 });
  assert.equal(result.ga4.purchase_events, 200);
  assert.equal(result.ga4.purchase_events_authority, 'BEHAVIORAL_NOT_PAYMENT_AUTHORITY');
});

test('evidence gates are inclusive and an unmet gate withholds the outcome', () => {
  const at = (threshold: Rec) => {
    const reg = withExperiment({ evidence_threshold: threshold });
    return computed({ registry: reg, ledger: ledger({ registry: reg }) });
  };
  assert.equal(at({ min_denominator: 200, min_events: 2 }).status, 'COMPUTED');
  const lowSessions = at({ min_denominator: 201, min_events: 2 });
  assert.equal(lowSessions.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(lowSessions.outcome, null);
  assert.deepEqual(lowSessions.gates, { min_denominator: 201, min_events: 2, denominator: 200, events: 2, denominator_met: false, events_met: true });
  const lowEvents = at({ min_denominator: 200, min_events: 3 });
  assert.equal(lowEvents.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(lowEvents.outcome, null);
  assert.deepEqual(lowEvents.gates, { min_denominator: 200, min_events: 3, denominator: 200, events: 2, denominator_met: true, events_met: false });
});

test('only the registered segment, primary model, tuple sessions and window days are counted', () => {
  // Widen nothing: change every out-of-scope input and the outcome must not move.
  const noisyGa4 = ga4();
  for (const row of noisyGa4.rows) {
    if (row.content === 'video-b' || row.source === 'direct' || row.date < '2026-10-03' || row.date > '2026-10-10') row.sessions += 1000;
  }
  const result = computed({ ga4: noisyGa4 });
  assert.equal(result.ga4.sessions, 200);
  assert.equal(result.ledger.paid_orders, 3);
  // The narrower window drops the Oct 4 order and the Oct 3/4 sessions.
  const narrow = withExperiment({ start_date: '2026-10-05' });
  const shifted = computed({ registry: narrow, ledger: ledger({ registry: narrow }) });
  assert.equal(shifted.ga4.sessions, 150);
  assert.equal(shifted.ledger.paid_orders, 2);
  // An experiment without content matches only `not_set` content sessions.
  const noContent = withExperiment({ content: null });
  const none = report({ registry: noContent, ledger: ledger({ registry: noContent }) });
  assert.equal(none.ok, true);
  assert.equal((none as { report: Rec }).report.ga4.sessions, 0);
  assert.equal((none as { report: Rec }).report.status, 'INSUFFICIENT_EVIDENCE');
});

test('the report carries no raw campaign values, PII or identifiers', () => {
  const text = JSON.stringify(computed());
  assert.doesNotMatch(text, /facebook|paid_social|holiday|video-|\/gifts|synthetic-buyer|Synthetic Hero|ord_SYNTH|example\.invalid/);
});

// ── Fail closed ─────────────────────────────────────────────────────────────

test('unknown, malformed, unstarted or cancelled experiments and app-sourced outcomes refuse', () => {
  assert.deepEqual(report({ experimentId: 'hsb_exp_2026_009' }), { ok: false, issues: ['EXPERIMENT_UNKNOWN@$.experiment_id'] });
  assert.deepEqual(report({ experimentId: 'jane@example.com' }), { ok: false, issues: ['EXPERIMENT_ID_FORMAT@$.experiment_id'] });
  for (const [status, decision] of [['planned', 'pending'], ['cancelled', 'pending']]) {
    const reg = withExperiment({ status, decision });
    assert.deepEqual(report({ registry: reg, ledger: ledger({ registry: reg }) }), { ok: false, issues: ['EXPERIMENT_NOT_EVALUABLE@$.experiment.status'] }, status);
  }
  for (const [status, decision] of [['paused', 'pending'], ['completed', 'stop']]) {
    const reg = withExperiment({ status, decision });
    assert.equal(computed({ registry: reg, ledger: ledger({ registry: reg }) }).experiment_status, status);
  }
  for (const outcome of ['qualified_action_rate', 'paid_per_qualified_rate']) {
    const reg = withExperiment({ primary_outcome: outcome });
    assert.deepEqual(report({ registry: reg, ledger: ledger({ registry: reg }) }), { ok: false, issues: ['OUTCOME_SOURCE_UNAVAILABLE@$.experiment.primary_outcome'] }, outcome);
  }
});

test('schema, identity, origin and timezone mismatches refuse', () => {
  assert.deepEqual(report({ registry: { ...registry(), schema: 'x' } }), { ok: false, issues: ['REGISTRY_INVALID@$.registry'] });
  const ledgerIssues = report({ ledger: { ...ledger(), notes: 'jane' } });
  assert.deepEqual(ledgerIssues, { ok: false, issues: ['FORBIDDEN_KEY@$.ledger'] });
  assert.deepEqual(report({ ledger: { ...ledger(), schema: 'hsb.decision_export.ga4_behavior' } }), { ok: false, issues: ['SCHEMA_INVALID@$.ledger.schema'] });
  assert.deepEqual(report({ ga4: { ...ga4(), schema: 'hsb.decision_export.ledger' } }), { ok: false, issues: ['SCHEMA_INVALID@$.ga4.schema'] });
  assert.deepEqual(report({ ga4: { ...ga4(), rows: [{ ...ga4().rows[0], source: 'jane@example.com' }] } }), { ok: false, issues: ['FORBIDDEN_VALUE:EMAIL@$.ga4.rows[0].source'] });
  // The ledger was classified against another registry version.
  const edited = withExperiment({ budget: { amount_minor: 99, currency: 'USD' } });
  assert.deepEqual(report({ ledger: ledger({ registry: edited }) }), { ok: false, issues: ['REGISTRY_IDENTITY_MISMATCH@$.ledger.registry_sha256'] });
  assert.deepEqual(report({ ga4: ga4({ data_origin: 'operator_export' }) }), { ok: false, issues: ['DATA_ORIGIN_MISMATCH@$.ga4.data_origin'] });
  const operatorRegistry = { ...registry(), data_origin: 'operator_export' };
  assert.deepEqual(report({ registry: operatorRegistry, ledger: ledger({ registry: operatorRegistry }) }), { ok: false, issues: ['DATA_ORIGIN_MISMATCH@$.registry.data_origin'] });
  assert.deepEqual(report({ ga4: ga4({ timezone: 'UTC' }) }), { ok: false, issues: ['TIMEZONE_MISMATCH@$.ga4.timezone'] });
});

test('a window not fully covered, attested or integrity-clean refuses', () => {
  assert.deepEqual(report({ ledger: ledger({ coverage: { start: '2026-10-04', end: '2026-10-31' } }) }), { ok: false, issues: ['WINDOW_NOT_COVERED@$.ledger.coverage'] });
  assert.deepEqual(report({ ga4: ga4({ coverage: { start: '2026-10-01', end: '2026-10-09' }, attested_complete_ranges: [{ start: '2026-10-01', end: '2026-10-09' }], rows: ga4().rows.filter((row) => row.date <= '2026-10-09') }) }),
    { ok: false, issues: ['WINDOW_NOT_COVERED@$.ga4.coverage'] });
  // One unattested window day.
  assert.deepEqual(report({ ga4: ga4({ attested_complete_ranges: [{ start: '2026-10-01', end: '2026-10-06' }, { start: '2026-10-08', end: '2026-10-31' }] }) }),
    { ok: false, issues: ['GA4_WINDOW_NOT_ATTESTED@$.ga4.attested_complete_ranges'] });
  // Contiguous attestation split across ranges is fine.
  assert.equal(report({ ga4: ga4({ attested_complete_ranges: [{ start: '2026-10-01', end: '2026-10-06' }, { start: '2026-10-07', end: '2026-10-31' }] }) }).ok, true);
  // GA4-reported data loss carries no attestation.
  assert.deepEqual(report({ ga4: ga4({ quality: { sampled: true, thresholded: false, other_row: false }, attested_complete_ranges: [] }) }),
    { ok: false, issues: ['GA4_WINDOW_NOT_ATTESTED@$.ga4.attested_complete_ranges'] });
  // An integrity rejection on a window day, or an undated one, refuses; one outside the window does not.
  const withRecords = (records: unknown[]) => ledger({ orders: [...ledgerOrders(), ...records] });
  assert.deepEqual(report({ ledger: withRecords([order(IN_WINDOW[1], { settledAmountCents: null })]) }), { ok: false, issues: ['LEDGER_INTEGRITY_INCOMPLETE@$.ledger.integrity_rejections'] });
  assert.deepEqual(report({ ledger: withRecords(['garbage']) }), { ok: false, issues: ['LEDGER_INTEGRITY_INCOMPLETE@$.ledger.integrity_rejections'] });
  assert.equal(report({ ledger: withRecords([order('2026-10-20T15:00:00.000Z', { settledAmountCents: null })]) }).ok, true);
});

test('a second experiment sharing the tuple on another landing path makes the GA4 denominator ambiguous', () => {
  const sibling = { ...EXPERIMENT, experiment_id: 'hsb_exp_2026_002', landing_path: '/', start_date: '2026-10-09', end_date: '2026-10-20' };
  const reg = registry([EXPERIMENT, sibling]);
  assert.deepEqual(report({ registry: reg, ledger: ledger({ registry: reg }) }), { ok: false, issues: ['DENOMINATOR_AMBIGUOUS@$.registry'] });
  const later = registry([EXPERIMENT, { ...sibling, start_date: '2026-10-11' }]);
  assert.equal(report({ registry: later, ledger: ledger({ registry: later }) }).ok, true);
  const otherContent = registry([EXPERIMENT, { ...sibling, content: 'video-b' }]);
  assert.equal(report({ registry: otherContent, ledger: ledger({ registry: otherContent }) }).ok, true);
});

// ── CLI ─────────────────────────────────────────────────────────────────────

const CLI = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/attribution-decision.ts'];
function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [...CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON|file:\/\/|(?:^|\s)\/|[A-Za-z]:\\/);
  assert.ok(!result.stderr.includes(process.cwd()));
  if (result.status === 0 || result.status === 3) assert.equal(result.stderr, '');
  return result;
}

test('the decision-report CLI joins the three files or refuses value-free', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-decision-'));
  try {
    mkdirSync(path.join(dir, 'in'));
    const files = {
      ledger: path.join(dir, 'in', 'ledger.json'),
      ga4: path.join(dir, 'in', 'ga4.json'),
      registry: path.join(dir, 'in', 'registry.json'),
    };
    writeFileSync(files.ledger, JSON.stringify(ledger()));
    writeFileSync(files.ga4, JSON.stringify(ga4()));
    writeFileSync(files.registry, JSON.stringify(registry()));
    const args = ['decision-report', '--ledger', files.ledger, '--ga4', files.ga4, '--registry', files.registry, '--experiment', 'hsb_exp_2026_001'];
    const ok = runCli(args);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.deepEqual(JSON.parse(ok.stdout), computed());

    writeFileSync(files.ga4, JSON.stringify(ga4({ timezone: 'UTC' })));
    const refused = runCli(args);
    assert.equal(refused.status, 3);
    assert.equal(refused.stdout, 'REJECTED decision_report TIMEZONE_MISMATCH@$.ga4.timezone\n');

    writeFileSync(files.ga4, '{"rows": [jane@example.com');
    const malformed = runCli(args);
    assert.equal(malformed.status, 3);
    assert.equal(malformed.stdout, 'REJECTED decision_report JSON_INVALID@$.ga4\n');
    assert.doesNotMatch(malformed.stdout + malformed.stderr, /jane/);

    // The checked-in registry is empty: no experiment can be reported.
    writeFileSync(files.ga4, JSON.stringify(ga4()));
    const empty = runCli(['decision-report', '--ledger', files.ledger, '--ga4', files.ga4, '--experiment', 'hsb_exp_2026_001']);
    assert.equal(empty.status, 3);

    assert.equal(runCli(['decision-report', '--ledger', files.ledger]).status, 2);
    assert.equal(runCli([...args, '--experiment', 'hsb_exp_2026_001']).status, 2);
    assert.equal(runCli(args.map((arg) => (arg === files.ledger ? path.join(dir, 'missing.json') : arg))).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
