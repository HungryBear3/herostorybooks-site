/**
 * The read-only ledger attribution export (`hsb.decision_export.ledger` v1).
 *
 * Durable orders are grouped by paid day (in the export timezone) and by
 * governed segment class under two attribution models: the last non-direct
 * touch (primary) and the first touch (secondary). A segment class is only
 * `registered:<experiment_id>` (exact five-field tuple + capture day inside
 * one validated registry window), `unregistered_governed`, `partial` or
 * `direct` — never a raw campaign value. Every record lands in exactly one
 * place: out of coverage, a closed exclusion reason, a closed integrity
 * rejection, or the counted rows. All fixtures are synthetic.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LEDGER_EXCLUSION_REASONS,
  LEDGER_INTEGRITY_REASONS,
  buildLedgerAttributionExport,
  classifyLedgerTouch,
  registryFingerprint,
  validateLedgerAttributionExport,
  type LedgerAttributionExport,
  type LedgerRow,
} from '../src/lib/attribution-ledger-export.ts';
import type { AttributionTouch } from '../src/lib/attribution-contract.ts';
import type { GovernedExperiment } from '../src/lib/campaign-governance.ts';

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
  evidence_threshold: { min_denominator: 100, min_events: 2 },
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

/** 2026-10-05 10:00 America/Chicago. */
const CAPTURE = '2026-10-05T15:00:00.000Z';

function iso(base: string, plusMs: number): string {
  return new Date(Date.parse(base) + plusMs).toISOString();
}

function touch(over: Partial<AttributionTouch> = {}): AttributionTouch {
  return {
    source: 'facebook',
    medium: 'paid_social',
    campaign: '2026-10-holiday',
    content: 'video-a',
    term: null,
    landingPath: '/gifts/holidays',
    capturedAt: CAPTURE,
    ...over,
  };
}

function directTouch(capturedAt = CAPTURE): AttributionTouch {
  return { source: null, medium: null, campaign: null, content: null, term: null, landingPath: '/', capturedAt };
}

let serial = 0;
/** A synthetic durable order captured at `capture`, created an hour later and paid two hours later. */
function order(over: Rec = {}, capture = CAPTURE): Rec {
  serial += 1;
  const created = iso(capture, 3_600_000);
  return {
    id: `ord_${serial.toString(16).padStart(16, '0')}`,
    childName: 'Synthetic Hero',
    email: 'synthetic-buyer@example.invalid',
    bookFormat: 'digital',
    formatLabel: 'Digital Storybook',
    priceCents: 3900,
    status: 'order_received',
    paymentStatus: 'paid',
    paidAt: iso(capture, 7_200_000),
    settledAmountCents: 3900,
    stripeSessionId: 'cs_test_SYNTHa1B2c3D4e5F6',
    stripePaymentIntentId: 'pi_SYNTHa1B2c3D4e5F6',
    shippingAddress: { line1: '1 Synthetic Way', city: 'Testville', state: 'IL', zip: '60601', country: 'US' },
    checkoutTracking: null,
    checkoutAttribution: { version: 1, firstTouch: touch({ capturedAt: capture }), lastNonDirectTouch: touch({ capturedAt: capture }) },
    deliveryExpectation: 'Synthetic',
    createdAt: created,
    updatedAt: created,
    ...over,
  };
}

const BASE = {
  timezone: 'America/Chicago',
  coverage: { start: '2026-10-01', end: '2026-10-31' },
  generatedAt: '2026-11-02T12:00:00Z',
  dataOrigin: 'synthetic_fixture',
} as const;

function build(orders: unknown[], over: Rec = {}): LedgerAttributionExport {
  const result = buildLedgerAttributionExport({ ...BASE, registry: registry(), orders, ...over } as never);
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { ok: true; document: LedgerAttributionExport }).document;
}

function rows(doc: LedgerAttributionExport, model: 'last_non_direct_touch' | 'first_touch'): LedgerRow[] {
  return doc.rows.filter((row) => row.model === model);
}

function segmentsOf(doc: LedgerAttributionExport, model: 'last_non_direct_touch' | 'first_touch' = 'last_non_direct_touch'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows(doc, model)) out[row.segment] = (out[row.segment] ?? 0) + row.paid_orders;
  return out;
}

function exclusionsOf(doc: LedgerAttributionExport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of doc.exclusions) out[row.reason] = (out[row.reason] ?? 0) + row.orders;
  return out;
}

function integrityOf(doc: LedgerAttributionExport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of doc.integrity_rejections) out[row.reason] = (out[row.reason] ?? 0) + row.orders;
  return out;
}

// ── Shape ───────────────────────────────────────────────────────────────────

test('one paid registered order produces the exact closed document', () => {
  const doc = build([order()]);
  const row = {
    date: '2026-10-05',
    paid_orders: 1,
    settled_cents: 3900,
    fully_refunded_orders: 0,
    partially_refunded_orders: 0,
    refunded_cents: 0,
    net_paid_orders: 1,
    net_settled_cents: 3900,
    print_upgrade_orders: 0,
    print_upgrade_cents: 0,
  };
  assert.deepEqual(doc, {
    schema: 'hsb.decision_export.ledger',
    schema_version: 1,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    timezone: 'America/Chicago',
    generated_at: '2026-11-02T12:00:00Z',
    coverage: { start: '2026-10-01', end: '2026-10-31' },
    registry_sha256: registryFingerprint(registry()),
    primary_model: 'last_non_direct_touch',
    secondary_model: 'first_touch',
    totals: { records_read: 1, outside_coverage: 0, excluded: 0, integrity_rejected: 0, counted: 1 },
    rows: [
      { ...row, model: 'first_touch', segment: 'registered:hsb_exp_2026_001' },
      { ...row, model: 'last_non_direct_touch', segment: 'registered:hsb_exp_2026_001' },
    ].map(({ date, model, segment, ...counts }) => ({ date, model, segment, ...counts })),
    exclusions: [],
    integrity_rejections: [],
  });
  assert.deepEqual(validateLedgerAttributionExport(doc), []);
});

test('the export carries no PII, provider ids, order ids or raw campaign values', () => {
  const doc = build([
    order(),
    order({ checkoutAttribution: { version: 1, firstTouch: touch({ source: 'google', medium: 'cpc', campaign: '2026-10-gifts', content: 'text-b', landingPath: '/' }), lastNonDirectTouch: touch({ source: 'google', medium: 'cpc', campaign: '2026-10-gifts', content: 'text-b', landingPath: '/' }) } }),
    order({ checkoutTracking: { cohort: 'friends_family', invite: 'synthetic_tester' } }),
    order({ internalDisposition: 'abandoned_internal_test', internalDispositionNote: 'owner smoke by synthetic-owner@example.invalid' }),
    order({ paymentStatus: 'partially_refunded', stripeRefundedAmountCents: 900, stripeRefundId: 're_SYNTHa1B2c3D4e5', refundReason: 'synthetic reason text' }),
  ]);
  const text = JSON.stringify(doc);
  for (const forbidden of [
    /synthetic-buyer|synthetic-owner|example\.invalid/, /Synthetic Hero|Synthetic Way|Testville|60601/, /ord_SYNTH/, /cs_test|pi_SYNTH|re_SYNTH/,
    /facebook|paid_social|holiday|video-a|google|cpc|2026-10-gifts|text-b|\/gifts/, /friends_family|synthetic_tester/, /smoke|reason text/,
    /capturedAt|landingPath|utm_/,
  ]) {
    assert.doesNotMatch(text, forbidden);
  }
});

// ── Exclusions: each closed reason, exactly once, never counted ─────────────

test('each exclusion reason removes exactly its order and is counted by reason', () => {
  const cases: Array<[string, Rec, (typeof LEDGER_EXCLUSION_REASONS)[number]]> = [
    ['internal test', { internalDisposition: 'abandoned_internal_test' }, 'internal_disposition'],
    ['internal smoke', { internalDisposition: 'superseded_internal_smoke' }, 'internal_disposition'],
    ['F&F cohort', { checkoutTracking: { cohort: 'ff_pilot' } }, 'cohort_or_invite'],
    ['invite', { checkoutTracking: { invite: 'tester_1' } }, 'cohort_or_invite'],
    ['pending', { paymentStatus: 'pending', paidAt: null, settledAmountCents: null }, 'unpaid'],
    ['failed', { paymentStatus: 'failed', paidAt: null, settledAmountCents: null }, 'unpaid'],
    ['$0 / no payment required', { settledAmountCents: 0 }, 'zero_or_no_payment_required'],
  ];
  for (const [label, over, reason] of cases) {
    const doc = build([order(), order(over)]);
    assert.deepEqual(exclusionsOf(doc), { [reason]: 1 }, label);
    assert.deepEqual(integrityOf(doc), {}, label);
    assert.deepEqual(segmentsOf(doc), { 'registered:hsb_exp_2026_001': 1 }, label);
    assert.deepEqual(segmentsOf(doc, 'first_touch'), { 'registered:hsb_exp_2026_001': 1 }, label);
    assert.deepEqual(doc.totals, { records_read: 2, outside_coverage: 0, excluded: 1, integrity_rejected: 0, counted: 1 }, label);
    assert.deepEqual(doc.exclusions, [{ date: '2026-10-05', reason, orders: 1 }], label);
    assert.deepEqual(validateLedgerAttributionExport(doc), [], label);
  }
  assert.deepEqual([...LEDGER_EXCLUSION_REASONS], ['internal_disposition', 'cohort_or_invite', 'unpaid', 'zero_or_no_payment_required']);
});

test('exclusion precedence is fixed: internal, then cohort/invite, then unpaid, then $0', () => {
  const doc = build([
    order({ internalDisposition: 'abandoned_internal_test', checkoutTracking: { cohort: 'ff' }, paymentStatus: 'pending', paidAt: null }),
    order({ checkoutTracking: { invite: 'x1' }, paymentStatus: 'failed', paidAt: null }),
    order({ paymentStatus: 'pending', paidAt: null, settledAmountCents: 0 }),
  ]);
  assert.deepEqual(exclusionsOf(doc), { internal_disposition: 1, cohort_or_invite: 1, unpaid: 1 });
});

test('an unpaid order is dated by its creation day', () => {
  const doc = build([order({ paymentStatus: 'pending', paidAt: null, createdAt: '2026-10-07T04:00:00.000Z' })]);
  // 2026-10-07T04:00Z is still 2026-10-06 in Chicago.
  assert.deepEqual(doc.exclusions, [{ date: '2026-10-06', reason: 'unpaid', orders: 1 }]);
});

// ── Integrity: nothing missing or contradictory is treated as safe ──────────

test('each integrity defect rejects exactly its order with a closed reason', () => {
  const cases: Array<[string, unknown, (typeof LEDGER_INTEGRITY_REASONS)[number]]> = [
    ['not an object', 'ord_SYNTH', 'record_invalid'],
    ['array', [], 'record_invalid'],
    ['created missing', order({ createdAt: undefined }), 'timestamp_invalid'],
    ['created not ISO', order({ createdAt: '2026-10-05' }), 'timestamp_invalid'],
    ['paid not ISO', order({ paidAt: 'yesterday' }), 'timestamp_invalid'],
    ['unknown disposition', order({ internalDisposition: 'owner_order' }), 'internal_disposition_invalid'],
    ['tracking not object', order({ checkoutTracking: 'ff' }), 'checkout_tracking_invalid'],
    ['tracking unknown key', order({ checkoutTracking: { cohort: 'ff', source: 'x' } }), 'checkout_tracking_invalid'],
    ['tracking empty', order({ checkoutTracking: {} }), 'checkout_tracking_invalid'],
    ['tracking not canonical', order({ checkoutTracking: { invite: 'Jane Doe' } }), 'checkout_tracking_invalid'],
    ['unknown payment status', order({ paymentStatus: 'complete' }), 'payment_status_invalid'],
    ['paid without paidAt', order({ paidAt: null }), 'payment_facts_invalid'],
    ['paid without settled amount', order({ settledAmountCents: undefined }), 'payment_facts_invalid'],
    ['settled float', order({ settledAmountCents: 39.5 }), 'payment_facts_invalid'],
    ['settled negative', order({ settledAmountCents: -1 }), 'payment_facts_invalid'],
    ['settled string', order({ settledAmountCents: '3900' }), 'payment_facts_invalid'],
    ['refund claim in flight', order({ refundClaimId: 'claim_1', refundClaimAt: '2026-10-06T00:00:00.000Z' }), 'refund_in_flight'],
    ['paid but refundedAt', order({ refundedAt: '2026-10-06T00:00:00.000Z' }), 'refund_facts_invalid'],
    ['paid but refund id', order({ stripeRefundId: 're_SYNTHa1B2c3D4e5' }), 'refund_facts_invalid'],
    ['paid but refunded amount', order({ stripeRefundedAmountCents: 100 }), 'refund_facts_invalid'],
    ['partial without amount', order({ paymentStatus: 'partially_refunded' }), 'refund_facts_invalid'],
    ['partial zero', order({ paymentStatus: 'partially_refunded', stripeRefundedAmountCents: 0 }), 'refund_facts_invalid'],
    ['partial equals settled', order({ paymentStatus: 'partially_refunded', stripeRefundedAmountCents: 3900 }), 'refund_facts_invalid'],
    ['partial with refundedAt', order({ paymentStatus: 'partially_refunded', stripeRefundedAmountCents: 100, refundedAt: '2026-10-06T00:00:00.000Z' }), 'refund_facts_invalid'],
    ['full refund over settled', order({ paymentStatus: 'refunded', stripeRefundedAmountCents: 3901 }), 'refund_facts_invalid'],
    ['refundedAt not ISO', order({ paymentStatus: 'refunded', refundedAt: 'soon' }), 'refund_facts_invalid'],
    ['upgrade paid without amount', order({ printUpgradeStatus: 'paid', printUpgradePaidAt: '2026-10-08T00:00:00.000Z' }), 'print_upgrade_facts_invalid'],
    ['upgrade paid without paidAt', order({ printUpgradeStatus: 'paid', printUpgradeAmountCents: 2000 }), 'print_upgrade_facts_invalid'],
    ['upgrade zero', order({ printUpgradeStatus: 'paid', printUpgradeAmountCents: 0, printUpgradePaidAt: '2026-10-08T00:00:00.000Z' }), 'print_upgrade_facts_invalid'],
    ['upgrade unknown status', order({ printUpgradeStatus: 'settled' }), 'print_upgrade_facts_invalid'],
    ['attribution extra key', order({ checkoutAttribution: { version: 1, firstTouch: touch(), lastNonDirectTouch: touch(), email: 'x' } }), 'attribution_invalid'],
    ['attribution raw value', order({ checkoutAttribution: { version: 1, firstTouch: touch({ campaign: 'Jane Doe' }), lastNonDirectTouch: null } }), 'attribution_invalid'],
    ['attribution term', order({ checkoutAttribution: { version: 1, firstTouch: touch({ term: 'jane' }), lastNonDirectTouch: null } }), 'attribution_invalid'],
    ['attribution after checkout', order({ checkoutAttribution: { version: 1, firstTouch: touch({ capturedAt: iso(CAPTURE, 2 * 3_600_000) }), lastNonDirectTouch: null } }), 'attribution_invalid'],
    ['attribution too old for checkout', order({ checkoutAttribution: { version: 1, firstTouch: touch({ capturedAt: iso(CAPTURE, -36 * 86_400_000) }), lastNonDirectTouch: null } }), 'attribution_invalid'],
    ['attribution string', order({ checkoutAttribution: 'facebook' }), 'attribution_invalid'],
  ];
  for (const [label, record, reason] of cases) {
    const result = buildLedgerAttributionExport({ ...BASE, registry: registry(), orders: [order(), record] } as never);
    assert.equal(result.ok, true, label);
    const doc = (result as { document: LedgerAttributionExport }).document;
    assert.deepEqual(integrityOf(doc), { [reason]: 1 }, label);
    assert.deepEqual(exclusionsOf(doc), {}, label);
    assert.deepEqual(segmentsOf(doc), { 'registered:hsb_exp_2026_001': 1 }, label);
    assert.equal(doc.totals.integrity_rejected, 1, label);
    assert.deepEqual(validateLedgerAttributionExport(doc), [], label);
    assert.doesNotMatch(JSON.stringify(doc), /Jane|jane|facebook|claim_1|soon|yesterday/, label);
  }
});

test('integrity rejections without a trustworthy day stay in scope, undated', () => {
  const doc = build([order({ createdAt: 'never', paidAt: undefined }), 'garbage']);
  assert.deepEqual(doc.integrity_rejections, [{ date: null, reason: 'record_invalid', orders: 1 }, { date: null, reason: 'timestamp_invalid', orders: 1 }]);
  assert.equal(doc.totals.outside_coverage, 0);
});

// ── Segment classes ─────────────────────────────────────────────────────────

test('every tuple field and the landing path must match exactly to register', () => {
  const variants: Array<[string, Partial<AttributionTouch>]> = [
    ['source', { source: 'instagram' }],
    ['medium', { medium: 'social' }],
    ['campaign', { campaign: '2026-10-gifts' }],
    ['content', { content: 'video-b' }],
    ['content missing', { content: null }],
    ['landing path', { landingPath: '/gifts' }],
    ['landing other', { landingPath: '/(other)' }],
  ];
  for (const [label, change] of variants) {
    const doc = build([order({ checkoutAttribution: { version: 1, firstTouch: touch(change), lastNonDirectTouch: touch(change) } })]);
    assert.deepEqual(segmentsOf(doc), { unregistered_governed: 1 }, label);
    assert.deepEqual(segmentsOf(doc, 'first_touch'), { unregistered_governed: 1 }, label);
  }
  // A registered entry with no content matches only a touch with no content.
  const noContent = { ...EXPERIMENT, content: null };
  const doc = build([order({ checkoutAttribution: { version: 1, firstTouch: touch({ content: null }), lastNonDirectTouch: touch({ content: null }) } }), order()],
    { registry: registry([noContent]) });
  assert.deepEqual(segmentsOf(doc), { 'registered:hsb_exp_2026_001': 1, unregistered_governed: 1 });
});

test('the registry window is inclusive and evaluated on the capture day in the export timezone', () => {
  const cases: Array<[string, string, string]> = [
    // [capture instant, Chicago verdict, UTC verdict]
    ['2026-10-03T04:59:59.999Z', 'unregistered_governed', 'registered:hsb_exp_2026_001'], // Oct 2 23:59 CDT
    ['2026-10-03T05:00:00.000Z', 'registered:hsb_exp_2026_001', 'registered:hsb_exp_2026_001'], // Oct 3 00:00 CDT
    ['2026-10-11T04:59:59.999Z', 'registered:hsb_exp_2026_001', 'unregistered_governed'], // Oct 10 23:59 CDT, Oct 11 UTC
    ['2026-10-11T05:00:00.000Z', 'unregistered_governed', 'unregistered_governed'],
    ['2026-10-02T12:00:00.000Z', 'unregistered_governed', 'unregistered_governed'],
  ];
  for (const [capture, chicago, utc] of cases) {
    const record = order({}, capture);
    assert.deepEqual(segmentsOf(build([record])), { [chicago]: 1 }, `${capture} Chicago`);
    assert.deepEqual(segmentsOf(build([record], { timezone: 'UTC' })), { [utc]: 1 }, `${capture} UTC`);
  }
});

test('registered membership ignores status: any validated window owns its tuple', () => {
  for (const [status, decision] of [['planned', 'pending'], ['paused', 'pending'], ['completed', 'stop'], ['cancelled', 'pending']]) {
    const doc = build([order()], { registry: registry([{ ...EXPERIMENT, status, decision }]) });
    assert.deepEqual(segmentsOf(doc), { 'registered:hsb_exp_2026_001': 1 }, status);
  }
});

test('partial and direct touches are their own classes', () => {
  const partials: Array<Partial<AttributionTouch>> = [
    { medium: null, campaign: null, content: null },
    { campaign: null },
    { medium: null },
  ];
  for (const change of partials) {
    const doc = build([order({ checkoutAttribution: { version: 1, firstTouch: touch(change), lastNonDirectTouch: touch(change) } })]);
    assert.deepEqual(segmentsOf(doc), { partial: 1 }, JSON.stringify(change));
  }
  const direct = build([
    order({ checkoutAttribution: undefined }),
    order({ checkoutAttribution: null }),
    order({ checkoutAttribution: { version: 1, firstTouch: directTouch(), lastNonDirectTouch: null } }),
  ]);
  assert.deepEqual(segmentsOf(direct), { direct: 3 });
  assert.deepEqual(segmentsOf(direct, 'first_touch'), { direct: 3 });
});

test('the primary model uses the last non-direct touch and the secondary model the first touch', () => {
  const first = touch({ source: 'newsletter', medium: 'email', campaign: 'launch', content: null, landingPath: '/', capturedAt: '2026-10-04T15:00:00.000Z' });
  const mixed = build([
    order({ checkoutAttribution: { version: 1, firstTouch: first, lastNonDirectTouch: touch() } }),
    order({ checkoutAttribution: { version: 1, firstTouch: directTouch('2026-10-04T15:00:00.000Z'), lastNonDirectTouch: touch() } }),
    order({ checkoutAttribution: { version: 1, firstTouch: touch(), lastNonDirectTouch: touch({ medium: null, capturedAt: '2026-10-05T15:30:00.000Z' }) } }),
  ]);
  assert.deepEqual(segmentsOf(mixed), { 'registered:hsb_exp_2026_001': 2, partial: 1 });
  assert.deepEqual(segmentsOf(mixed, 'first_touch'), { unregistered_governed: 1, direct: 1, 'registered:hsb_exp_2026_001': 1 });
  // A campaign first touch with no recorded last touch is still that campaign (the browser projection's fallback).
  const fallback = build([order({ checkoutAttribution: { version: 1, firstTouch: touch(), lastNonDirectTouch: null } })]);
  assert.deepEqual(segmentsOf(fallback), { 'registered:hsb_exp_2026_001': 1 });
});

test('a touch matching two windows is ambiguous, never silently assigned', () => {
  const governed = (id: string, start: string, end: string): GovernedExperiment => ({
    experimentId: id, status: 'running', startDate: start, endDate: end, source: 'facebook', medium: 'paid_social',
    campaign: '2026-10-holiday', content: 'video-a', landingPath: '/gifts/holidays', budgetMinor: 0, budgetCurrency: 'USD',
    primaryOutcome: 'paid_order_rate', minDenominator: 1, minEvents: 1, decision: 'pending',
  });
  const one = [governed('hsb_exp_2026_001', '2026-10-01', '2026-10-10')];
  assert.equal(classifyLedgerTouch(touch(), one, 'UTC'), 'registered:hsb_exp_2026_001');
  assert.equal(classifyLedgerTouch(touch(), [...one, governed('hsb_exp_2026_002', '2026-10-05', '2026-10-20')], 'UTC'), 'ambiguous');
  assert.equal(classifyLedgerTouch(null, one, 'UTC'), 'direct');
  // An overlapping registry never reaches classification: it does not validate.
  const overlapping = registry([EXPERIMENT, { ...EXPERIMENT, experiment_id: 'hsb_exp_2026_002', start_date: '2026-10-05', end_date: '2026-10-20' }]);
  assert.deepEqual(buildLedgerAttributionExport({ ...BASE, registry: overlapping, orders: [order()] } as never), {
    ok: false,
    issues: ['REGISTRY_INVALID@$.registry'],
  });
});

// ── Money ───────────────────────────────────────────────────────────────────

test('refunds are separated from settlement and netted exactly', () => {
  const doc = build([
    order({ settledAmountCents: 3900 }),
    order({ settledAmountCents: 2900 }), // promotion code: settled below list price
    order({ paymentStatus: 'refunded', refundedAt: '2026-10-06T00:00:00.000Z', stripeRefundId: 're_SYNTHa1B2c3D4e5', refundReason: 'stripe_charge_refunded', stripeRefundedAmountCents: 3900 }),
    order({ paymentStatus: 'refunded', refundedAt: '2026-10-06T00:00:00.000Z', stripeRefundId: 're_SYNTHz9Y8x7W6v5' }), // admin refund: no amount recorded
    order({ paymentStatus: 'refunded', refundedAt: '2026-10-06T00:00:00.000Z', refundReason: 'stripe_dispute_created', stripeRefundedAmountCents: 0 }),
    order({ paymentStatus: 'partially_refunded', stripeRefundedAmountCents: 1000, stripeRefundId: 're_SYNTHp1Q2r3S4t5' }),
  ]);
  const [row] = rows(doc, 'last_non_direct_touch');
  assert.deepEqual(row, {
    date: '2026-10-05',
    model: 'last_non_direct_touch',
    segment: 'registered:hsb_exp_2026_001',
    paid_orders: 6,
    settled_cents: 3900 + 2900 + 3900 * 4,
    fully_refunded_orders: 3,
    partially_refunded_orders: 1,
    refunded_cents: 3900 * 3 + 1000,
    net_paid_orders: 3,
    net_settled_cents: 3900 + 2900 + 3900 - 1000,
    print_upgrade_orders: 0,
    print_upgrade_cents: 0,
  });
});

test('print-upgrade revenue is reported separately and never enters settled revenue', () => {
  const upgraded = { printUpgradeStatus: 'paid', printUpgradeAmountCents: 2000, printUpgradePaidAt: '2026-10-20T00:00:00.000Z', printUpgradeStripeSessionId: 'cs_test_SYNTHu1V2w3X4y5' };
  const doc = build([
    order(upgraded),
    order({ printUpgradeStatus: 'checkout_open', printUpgradeAmountCents: 2000 }),
    order({ printUpgradeStatus: 'offered' }),
    order({ ...upgraded, internalDisposition: 'abandoned_internal_test' }),
  ]);
  const [row] = rows(doc, 'last_non_direct_touch');
  assert.equal(row.settled_cents, 3900 * 3);
  assert.equal(row.net_settled_cents, 3900 * 3);
  assert.equal(row.print_upgrade_orders, 1);
  assert.equal(row.print_upgrade_cents, 2000);
  assert.doesNotMatch(JSON.stringify(doc), /cs_test/);
});

// ── Days, coverage, determinism ─────────────────────────────────────────────

test('orders are dated by paid day in the export timezone; days outside coverage only count in totals', () => {
  const doc = build([
    order({ paidAt: '2026-10-08T04:30:00.000Z' }), // Oct 7 in Chicago
    order({ paidAt: '2026-10-08T05:30:00.000Z' }), // Oct 8 in Chicago
    order({ paidAt: '2026-11-01T06:00:00.000Z' }), // Nov 1: outside coverage
    order({ paidAt: '2026-10-01T04:00:00.000Z', createdAt: '2026-10-01T03:00:00.000Z' }, '2026-10-01T02:00:00.000Z'), // Sep 30 in Chicago
  ]);
  assert.deepEqual(rows(doc, 'last_non_direct_touch').map((row) => [row.date, row.paid_orders]), [['2026-10-07', 1], ['2026-10-08', 1]]);
  assert.deepEqual(doc.totals, { records_read: 4, outside_coverage: 2, excluded: 0, integrity_rejected: 0, counted: 2 });
});

test('the export is independent of input order and of registry key order', () => {
  const orders = [order(), order({ paymentStatus: 'pending', paidAt: null }), order({ checkoutAttribution: null }), 'garbage', order({ paidAt: '2026-10-09T15:00:00.000Z' })];
  const forward = build(orders);
  const reverse = build([...orders].reverse());
  assert.deepEqual(forward, reverse);
  const shuffled = Object.fromEntries(Object.entries(registry()).reverse());
  shuffled.experiments = [Object.fromEntries(Object.entries(EXPERIMENT).reverse())];
  assert.equal(registryFingerprint(shuffled), registryFingerprint(registry()));
  assert.notEqual(registryFingerprint(registry([{ ...EXPERIMENT, end_date: '2026-10-11' }])), registryFingerprint(registry()));
  assert.match(registryFingerprint(registry()), /^[0-9a-f]{64}$/);
});

// ── Refusals ────────────────────────────────────────────────────────────────

test('the export refuses an invalid registry, header, window or clock', () => {
  const refuse = (over: Rec) => buildLedgerAttributionExport({ ...BASE, registry: registry(), orders: [order()], ...over } as never);
  assert.deepEqual(refuse({ registry: { ...registry(), schema: 'x' } }), { ok: false, issues: ['REGISTRY_INVALID@$.registry'] });
  assert.deepEqual(refuse({ registry: registry([{ ...EXPERIMENT, source: 'jane@example.com' }]) }), { ok: false, issues: ['REGISTRY_INVALID@$.registry'] });
  assert.deepEqual(refuse({ timezone: 'Europe/Paris' }), { ok: false, issues: ['TIMEZONE_UNSUPPORTED@$.timezone'] });
  assert.deepEqual(refuse({ dataOrigin: 'prod' }), { ok: false, issues: ['INVALID_ENUM@$.data_origin'] });
  assert.deepEqual(refuse({ coverage: { start: '2026-10-31', end: '2026-10-01' } }), { ok: false, issues: ['RANGE_INVALID@$.coverage'] });
  assert.deepEqual(refuse({ coverage: { start: '2026-01-01', end: '2027-01-02' } }), { ok: false, issues: ['RANGE_TOO_LONG@$.coverage'] });
  assert.deepEqual(refuse({ generatedAt: '2026-11-02' }), { ok: false, issues: ['INVALID_TIMESTAMP@$.generated_at'] });
  // The last covered day must be over in the export timezone: Oct 31 ends 2026-11-01T05:00Z in Chicago.
  assert.deepEqual(refuse({ generatedAt: '2026-11-01T04:59:59Z' }), { ok: false, issues: ['COVERAGE_AFTER_GENERATED_AT@$.coverage.end'] });
  assert.equal(refuse({ generatedAt: '2026-11-01T05:00:00Z' }).ok, true);
  assert.deepEqual(refuse({ orders: 'not-an-array' }), { ok: false, issues: ['TYPE_ARRAY@$.orders'] });
});

// ── Validator ───────────────────────────────────────────────────────────────

test('the validator refuses tampered, inconsistent or value-bearing ledger documents', () => {
  const doc = build([order(), order({ paymentStatus: 'partially_refunded', stripeRefundedAmountCents: 500 }), order({ paymentStatus: 'pending', paidAt: null }), 'garbage']);
  assert.deepEqual(validateLedgerAttributionExport(doc), []);
  const tamper = (change: (copy: Rec) => void): string[] => {
    const copy = structuredClone(doc) as Rec;
    change(copy);
    return validateLedgerAttributionExport(copy);
  };
  const cases: Array<[string, (copy: Rec) => void, string]> = [
    ['schema', (c) => { c.schema = 'hsb.decision_export.ga4_behavior'; }, 'SCHEMA_INVALID@$.schema'],
    ['unknown header key', (c) => { c.notes = 'x'; }, 'FORBIDDEN_KEY@$'],
    ['raw segment', (c) => { c.rows[0].segment = 'facebook'; }, 'SEGMENT_INVALID@$.rows[0].segment'],
    ['unknown model', (c) => { c.rows[0].model = 'linear'; }, 'INVALID_ENUM@$.rows[0].model'],
    ['row outside coverage', (c) => { c.rows[0].date = '2026-11-05'; }, 'ROW_OUTSIDE_COVERAGE@$.rows[0].date'],
    ['float', (c) => { c.rows[0].settled_cents = 1.5; }, 'TYPE_INTEGER@$.rows[0].settled_cents'],
    ['net orders', (c) => { c.rows[0].net_paid_orders += 1; }, 'ROW_INVARIANT@$.rows[0]'],
    ['net cents', (c) => { c.rows[0].net_settled_cents += 1; }, 'ROW_INVARIANT@$.rows[0]'],
    ['refund over settled', (c) => { c.rows[0].refunded_cents = c.rows[0].settled_cents + 1; c.rows[0].net_settled_cents = -1; }, 'INTEGER_OUT_OF_RANGE@$.rows[0].net_settled_cents'],
    ['models disagree', (c) => { c.rows[0].paid_orders += 1; c.rows[0].net_paid_orders += 1; }, 'MODEL_TOTALS_MISMATCH@$.rows'],
    ['duplicate row', (c) => { c.rows.push(structuredClone(c.rows[0])); }, 'DUPLICATE_ROW@$.rows[2]'],
    ['unknown exclusion', (c) => { c.exclusions[0].reason = 'owner'; }, 'INVALID_ENUM@$.exclusions[0].reason'],
    ['undated exclusion', (c) => { c.exclusions[0].date = null; }, 'INVALID_DATE@$.exclusions[0].date'],
    ['unknown integrity', (c) => { c.integrity_rejections[0].reason = 'meh'; }, 'INVALID_ENUM@$.integrity_rejections[0].reason'],
    ['totals', (c) => { c.totals.records_read += 1; }, 'TOTALS_MISMATCH@$.totals'],
    ['fingerprint', (c) => { c.registry_sha256 = 'abc'; }, 'REGISTRY_FINGERPRINT_INVALID@$.registry_sha256'],
    ['clock', (c) => { c.generated_at = '2026-10-31T12:00:00Z'; }, 'COVERAGE_AFTER_GENERATED_AT@$.coverage.end'],
    ['primary model', (c) => { c.primary_model = 'first_touch'; }, 'INVALID_ENUM@$.primary_model'],
  ];
  for (const [label, change, expected] of cases) assert.ok(tamper(change).includes(expected), `${label}: ${JSON.stringify(tamper(change))}`);
  assert.deepEqual(validateLedgerAttributionExport(null), ['DOCUMENT_NOT_OBJECT@$']);
});

// Independent-review regressions: malformed facts must not shrink the ledger.
test('tracking exclusions require canonical non-null strings', () => {
  for (const checkoutTracking of [{ cohort: null }, { invite: null }, { cohort: null, invite: null },
    { cohort: 'ff_pilot', invite: null }, { cohort: '' }, { cohort: 1 }, { invite: false }, { cohort: ' FF ' }]) {
    const doc = build([order({ checkoutTracking })]);
    assert.equal(doc.totals.excluded, 0);
    assert.equal(doc.totals.counted, 0);
    assert.deepEqual(integrityOf(doc), { checkout_tracking_invalid: 1 });
  }
  assert.equal(build([order({ checkoutTracking: null })]).totals.counted, 1);
  assert.equal(build([order({ checkoutTracking: { invite: 'ff_pilot' } })]).totals.excluded, 1);
});

test('settled missing or invalid paid days remain undated before coverage scoping', () => {
  for (const paymentStatus of ['paid', 'partially_refunded', 'refunded']) {
    for (const paidAt of [undefined, null, '', 'invalid', 123]) {
      for (const createdAt of ['2026-09-01T12:00:00.000Z', '2026-10-02T12:00:00.000Z', '2026-12-01T12:00:00.000Z']) {
        const doc = build([order({ paymentStatus, paidAt, createdAt })]);
        assert.equal(doc.totals.outside_coverage, 0);
        assert.equal(doc.totals.integrity_rejected, 1);
        assert.equal(doc.integrity_rejections[0].date, null);
      }
    }
  }
});

test('all monetary and count allocations reconcile per paid day across models', () => {
  const changes: Array<(row: LedgerRow) => void> = [
    (r) => { r.settled_cents += 100; r.net_settled_cents += 100; },
    (r) => { r.refunded_cents += 100; r.net_settled_cents -= 100; },
    (r) => { r.fully_refunded_orders += 1; r.net_paid_orders -= 1; },
    (r) => { r.partially_refunded_orders += 1; },
    (r) => { r.print_upgrade_orders += 1; r.print_upgrade_cents += 100; },
    (r) => { r.print_upgrade_cents += 100; },
    (r) => { r.date = '2026-10-06'; },
  ];
  for (const change of changes) {
    const doc = build([order(), order({ printUpgradeStatus: 'paid', printUpgradeAmountCents: 2000, printUpgradePaidAt: CAPTURE })]);
    change(rows(doc, 'last_non_direct_touch')[0]);
    assert.ok(validateLedgerAttributionExport(doc).includes('MODEL_TOTALS_MISMATCH@$.rows'));
  }
  // A day swap preserves every grand total, but changes the decision window.
  const doc = build([order(), order({ settledAmountCents: 2900, paidAt: '2026-10-11T12:00:00.000Z' })]);
  const primary = rows(doc, 'last_non_direct_touch');
  [primary[0].date, primary[1].date] = [primary[1].date, primary[0].date];
  assert.ok(validateLedgerAttributionExport(doc).includes('MODEL_TOTALS_MISMATCH@$.rows'));
});

test('duplicate and conflicting durable identities reject every copy without exposing identifiers', () => {
  const original = order();
  for (const second of [structuredClone(original), { ...original, settledAmountCents: 9999 },
    { ...original, paymentStatus: 'pending', paidAt: null }, { ...original, paidAt: '2026-12-01T12:00:00.000Z' }]) {
    const doc = build([original, second]);
    assert.deepEqual(doc.totals, { records_read: 2, outside_coverage: 0, excluded: 0, integrity_rejected: 2, counted: 0 });
    assert.deepEqual(doc.integrity_rejections, [{ date: null, reason: 'order_identity_duplicate', orders: 2 }]);
    assert.deepEqual(doc.rows, []);
    assert.deepEqual(build([second, original]), doc);
    assert.ok(!JSON.stringify(doc).includes(original.id));
  }
});

test('malformed durable identities are undated rejections before any classification', () => {
  const malformed = [undefined, null, '', ' ', '\t\n', 7, false, {}, [],
    'ord_SYNTH000001', ['ord_', '0123456789ABCDEf'].join(''), 'ord_0123456789abcde',
    ['ord_', '0123456789abcdef0'].join(''), [' ord_', '0123456789abcdef'].join(''),
    ['ord_', '0123456789abcdef', '\n'].join(''),
    'private-identity@example.invalid'];
  for (const id of malformed) {
    for (const over of [{}, { internalDisposition: 'abandoned_internal_test' },
      { checkoutTracking: { cohort: 'ff_pilot' } }, { paymentStatus: 'pending', paidAt: null },
      { settledAmountCents: 0 }, { paidAt: '2026-09-01T12:00:00.000Z' },
      { paidAt: '2026-12-01T12:00:00.000Z' }]) {
      const record = order({ ...over, id });
      if (id === undefined) delete record.id;
      for (const records of [[record], [record, structuredClone(record)]]) {
        const doc = build(records);
        assert.deepEqual(doc.totals, { records_read: records.length, outside_coverage: 0,
          excluded: 0, integrity_rejected: records.length, counted: 0 });
        assert.deepEqual(doc.integrity_rejections, [{ date: null, reason: 'order_identity_invalid', orders: records.length }]);
        assert.deepEqual(doc.rows, []);
        assert.deepEqual(doc.exclusions, []);
        assert.deepEqual(build([...records].reverse()), doc);
        assert.doesNotMatch(JSON.stringify(doc), /ord_|private-identity|example\.invalid/);
      }
    }
  }
});

test('closed ledger validation enforces the same inclusive coverage bound as the builder', () => {
  for (const days of [365, 366, 367, 10_000]) {
    const coverage = { start: '2026-01-01', end: iso('2026-01-01', (days - 1) * 86_400_000).slice(0, 10) };
    const generatedAt = iso(coverage.end, 2 * 86_400_000).replace('.000Z', 'Z');
    const doc = { ...build([]), coverage, generated_at: generatedAt };
    const expected = days <= 366 ? [] : ['RANGE_TOO_LONG@$.coverage'];
    assert.deepEqual(validateLedgerAttributionExport(doc), expected);
    const built = buildLedgerAttributionExport({ ...BASE, registry: registry(), orders: [], coverage, generatedAt });
    assert.equal(built.ok, days <= 366);
    if (built.ok === false) assert.deepEqual(built.issues, expected);
  }
});

// ── Operator CLI over a synthetic snapshot directory ────────────────────────

const CLI = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/attribution-decision.ts'];
function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [...CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON|file:\/\/|(?:^|\s)\/|[A-Za-z]:\\/);
  assert.ok(!result.stderr.includes(process.cwd()));
  if (result.status === 0 || result.status === 3) assert.equal(result.stderr, '');
  return result;
}

test('the ledger-export CLI reads a snapshot directory and prints the closed document, unreadable records counted', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-ledger-'));
  try {
    const orders = path.join(dir, 'orders');
    mkdirSync(orders);
    mkdirSync(path.join(orders, 'nested'));
    writeFileSync(path.join(orders, 'a.json'), JSON.stringify(order()));
    writeFileSync(path.join(orders, 'b.json'), JSON.stringify(order({ internalDisposition: 'abandoned_internal_test' })));
    writeFileSync(path.join(orders, 'c.json'), '{"email": "synthetic-buyer@example.invalid", ');
    writeFileSync(path.join(orders, 'README.txt'), 'not an order');
    const reg = path.join(dir, 'registry.json');
    writeFileSync(reg, JSON.stringify(registry()));
    const args = ['ledger-export', '--orders-dir', orders, '--registry', reg, '--start', '2026-10-01', '--end', '2026-10-31',
      '--timezone', 'America/Chicago', '--data-origin', 'synthetic_fixture', '--generated-at', '2026-11-02T12:00:00Z'];
    const ok = runCli(args);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const doc = JSON.parse(ok.stdout);
    assert.deepEqual(validateLedgerAttributionExport(doc), []);
    assert.deepEqual(doc.totals, { records_read: 3, outside_coverage: 0, excluded: 1, integrity_rejected: 1, counted: 1 });
    assert.deepEqual(doc.integrity_rejections, [{ date: null, reason: 'record_invalid', orders: 1 }]);
    assert.doesNotMatch(ok.stdout + ok.stderr, /synthetic-buyer|ord_SYNTH|facebook/);
    // Same input, same bytes.
    assert.equal(runCli(args).stdout, ok.stdout);

    // A second filename is not a second durable order, even with conflicting facts.
    const duplicate = order();
    writeFileSync(path.join(orders, 'd.json'), JSON.stringify(duplicate));
    writeFileSync(path.join(orders, 'e.json'), JSON.stringify({ ...duplicate, settledAmountCents: 9999 }));
    const duplicated = runCli(args);
    assert.equal(duplicated.status, 0);
    const duplicateDoc = JSON.parse(duplicated.stdout);
    assert.equal(duplicateDoc.totals.counted, 1);
    assert.equal(duplicateDoc.totals.integrity_rejected, 3);
    assert.ok(duplicateDoc.integrity_rejections.some((row: Rec) => row.reason === 'order_identity_duplicate' && row.date === null && row.orders === 2));
    assert.ok(!duplicated.stdout.includes(duplicate.id));

    const badRegistry = path.join(dir, 'bad-registry.json');
    writeFileSync(badRegistry, JSON.stringify(registry([{ ...EXPERIMENT, source: 'jane@example.com' }])));
    const refused = runCli(args.map((arg) => (arg === reg ? badRegistry : arg)));
    assert.equal(refused.status, 3);
    assert.equal(refused.stdout, 'REJECTED ledger_export REGISTRY_INVALID@$.registry\n');

    assert.equal(runCli(['ledger-export', '--orders-dir', orders]).status, 2);
    assert.equal(runCli([...args, '--start', '2026-10-01']).status, 2);
    assert.equal(runCli(args.map((arg) => (arg === orders ? path.join(dir, 'missing') : arg))).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
