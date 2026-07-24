/**
 * Tests for the alert-only stranded paid-order detector.
 *
 * Discriminator model: a candidate MUST be explicitly `fulfillmentMode==='auto'`
 * with a valid authoritative `paidAt`; everything else (manual_hold, legacy/
 * undefined mode, missing/invalid/future paidAt, unpaid, refunded, started/
 * terminal, internal disposition, allowlisted, below-threshold) fails closed.
 * Age is computed from `paidAt` ONLY. The detector remains alert-only with zero
 * reachability to fulfillment/email/Stripe/provider/order writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  evaluateEligibility,
  runStrandedScan,
  type AlertState,
  type ScanDeps,
  type StrandedAlert,
} from '../src/lib/stranded-order-detector.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-07-24T12:00:00Z');
const FOUNDER_ORDER_ID = 'ord_2ecc3480df0044ba'; // July 13 $9.50 fixture reference ONLY

/** Default fixture: auto + paid + not_started + paidAt 24h ago (i.e. a candidate). */
function makeOrder(partial: Partial<OrderRecord> & { id: string }): OrderRecord {
  return {
    id: partial.id,
    bookFormat: 'digital',
    formatLabel: 'Digital',
    priceCents: 950,
    status: 'order_received',
    paymentStatus: 'paid',
    fulfillmentMode: 'auto',
    fulfillmentStatus: 'not_started',
    paidAt: new Date(NOW - 24 * HOUR).toISOString(),
    deliveryExpectation: 'digital',
    createdAt: new Date(NOW - 48 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 24 * HOUR).toISOString(),
    ...partial,
  } as unknown as OrderRecord;
}

interface SpyDeps extends ScanDeps {
  alerts: StrandedAlert[];
  writes: AlertState[];
}

function spyDeps(orders: OrderRecord[], overrides: Partial<ScanDeps> & { state?: AlertState } = {}): SpyDeps {
  const alerts: StrandedAlert[] = [];
  const writes: AlertState[] = [];
  let state: AlertState = overrides.state ?? {};
  const deps: SpyDeps = {
    listOrders: overrides.listOrders ?? (async () => orders),
    readAlertState: overrides.readAlertState ?? (async () => state),
    writeAlertState: overrides.writeAlertState ?? (async (s) => { writes.push(structuredClone(s)); state = s; }),
    alert: overrides.alert ?? (async (p) => { alerts.push(p); }),
    log: overrides.log ?? (() => {}),
    now: overrides.now ?? (() => NOW),
    thresholdMs: overrides.thresholdMs ?? 12 * HOUR,
    cooldownMs: overrides.cooldownMs ?? 24 * HOUR,
    excludeOrderIds: overrides.excludeOrderIds ?? new Set<string>(),
    alerts,
    writes,
  };
  return deps;
}

const cfg = (over: Partial<{ thresholdMs: number; excludeOrderIds: Set<string>; nowMs: number }> = {}) => ({
  thresholdMs: over.thresholdMs ?? 12 * HOUR,
  excludeOrderIds: over.excludeOrderIds ?? new Set<string>(),
  nowMs: over.nowMs ?? NOW,
});

// ── 1. auto + valid paidAt + old enough alerts ─────────────────────────────────

test('1. auto + valid paidAt older than threshold alerts', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a', paidAt: new Date(NOW - 13 * HOUR).toISOString() })]);
  const r = await runStrandedScan(deps);
  assert.equal(r.ok, true);
  assert.equal(r.candidates, 1);
  assert.equal(r.alertsSent, 1);
  assert.equal(deps.alerts[0]!.orderId, 'ord_a');
  assert.equal(deps.alerts[0]!.paymentStatus, 'paid');
});

test('alert payload carries no PII (opaque orderId + non-PII fields only)', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a', paidAt: new Date(NOW - 13 * HOUR).toISOString() })]);
  await runStrandedScan(deps);
  assert.deepEqual(Object.keys(deps.alerts[0]!).sort(),
    ['ageHours', 'bookFormat', 'fulfillmentStatus', 'kind', 'orderId', 'paymentStatus', 'thresholdHours']);
});

// ── 2. below-threshold does not alert ──────────────────────────────────────────

test('2. below-threshold (recent paidAt) does not alert', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_new', paidAt: new Date(NOW - 2 * HOUR).toISOString() })]);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 0);
  assert.equal(deps.alerts.length, 0);
});

// ── exact threshold boundary (from paidAt) ─────────────────────────────────────

test('exact threshold boundary: paidAt == now-threshold alerts; +1ms newer does not', () => {
  const at = makeOrder({ id: 'x', paidAt: new Date(NOW - 12 * HOUR).toISOString() });
  const under = makeOrder({ id: 'y', paidAt: new Date(NOW - 12 * HOUR + 1).toISOString() });
  assert.equal(evaluateEligibility(at, cfg()).eligible, true);
  assert.equal(evaluateEligibility(under, cfg()).eligible, false);
  assert.equal(evaluateEligibility(under, cfg()).reason, 'below_threshold');
});

// ── age is from paidAt ONLY, never updatedAt (req #6) ──────────────────────────

test('age uses paidAt only — stale updatedAt does not suppress an old paidAt', () => {
  const o = makeOrder({ id: 'z', paidAt: new Date(NOW - 20 * HOUR).toISOString(), updatedAt: new Date(NOW - 1 * HOUR).toISOString() });
  const v = evaluateEligibility(o, cfg());
  assert.equal(v.eligible, true); // recent updatedAt is irrelevant
});

test('age uses paidAt only — recent paidAt is below threshold despite old updatedAt', () => {
  const o = makeOrder({ id: 'z2', paidAt: new Date(NOW - 1 * HOUR).toISOString(), updatedAt: new Date(NOW - 40 * HOUR).toISOString() });
  const v = evaluateEligibility(o, cfg());
  assert.equal(v.eligible, false);
  assert.equal(v.reason, 'below_threshold');
});

// ── 3. unpaid/refunded/completed/started never alert ───────────────────────────

test('3. unpaid, refunded, completed, or already-started never alert', async () => {
  const paidAt = new Date(NOW - 30 * HOUR).toISOString();
  const orders = [
    makeOrder({ id: 'unpaid', paymentStatus: 'pending', paidAt: null }),
    makeOrder({ id: 'failed_pay', paymentStatus: 'failed' }),
    makeOrder({ id: 'refunded_status', paymentStatus: 'refunded' }),
    makeOrder({ id: 'refunded_at', refundedAt: new Date(NOW - 20 * HOUR).toISOString(), paidAt }),
    makeOrder({ id: 'completed', fulfillmentStatus: 'complete', paidAt }),
    makeOrder({ id: 'in_progress', fulfillmentStatus: 'generating_images', paidAt }),
    makeOrder({ id: 'failed_review', fulfillmentStatus: 'failed_manual_review', paidAt }),
    makeOrder({ id: 'email_failed', fulfillmentStatus: 'delivery_email_failed', paidAt }),
    makeOrder({ id: 'proof_ready', fulfillmentStatus: 'proof_ready', paidAt }),
  ];
  const deps = spyDeps(orders);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 0);
  assert.equal(deps.alerts.length, 0);
});

// ── discriminator: manual_hold / legacy-undefined never alert ───────────────────

test('manual_hold never alerts', async () => {
  const deps = spyDeps([makeOrder({ id: 'held', fulfillmentMode: 'manual_hold', paidAt: new Date(NOW - 300 * HOUR).toISOString() })]);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 0);
  assert.equal(deps.alerts.length, 0);
  assert.equal(evaluateEligibility(makeOrder({ id: 'held', fulfillmentMode: 'manual_hold' }), cfg()).reason, 'manual_hold');
});

test('legacy undefined fulfillmentMode never alerts (fail closed)', async () => {
  // Legacy order: no fulfillmentMode field at all, very old paidAt.
  const legacy = makeOrder({ id: 'legacy', paidAt: new Date(NOW - 300 * HOUR).toISOString() });
  delete (legacy as { fulfillmentMode?: unknown }).fulfillmentMode;
  const deps = spyDeps([legacy]);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 0);
  assert.equal(deps.alerts.length, 0);
  assert.equal(evaluateEligibility(legacy, cfg()).reason, 'legacy_mode_unset');
});

// ── paidAt: missing / malformed / future never alert ───────────────────────────

test('missing paidAt never alerts', async () => {
  const o = makeOrder({ id: 'nopaidat', paidAt: null });
  const deps = spyDeps([o]);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 0);
  assert.equal(deps.alerts.length, 0);
  assert.equal(evaluateEligibility(o, cfg()).reason, 'missing_paidat');
});

test('malformed paidAt never alerts and is counted as a data-quality skip', async () => {
  const o = makeOrder({ id: 'badpaidat', paidAt: 'not-a-date' });
  const deps = spyDeps([o]);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 0);
  assert.equal(r.skipped, 1);
  assert.equal(deps.alerts.length, 0);
  assert.equal(evaluateEligibility(o, cfg()).reason, 'invalid_paidat');
});

test('future paidAt never alerts and is a data-quality skip', async () => {
  const o = makeOrder({ id: 'futurepaidat', paidAt: new Date(NOW + 5 * HOUR).toISOString() });
  const deps = spyDeps([o]);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 0);
  assert.equal(r.skipped, 1);
  assert.equal(deps.alerts.length, 0);
  assert.equal(evaluateEligibility(o, cfg()).reason, 'future_paidat');
});

// ── reason-code precision ──────────────────────────────────────────────────────

test('eligibility reason codes are precise per exclusion', () => {
  const c = cfg({ excludeOrderIds: new Set([FOUNDER_ORDER_ID]) });
  const old = new Date(NOW - 30 * HOUR).toISOString();
  const cases: Array<[OrderRecord, string]> = [
    [makeOrder({ id: 'p', paymentStatus: 'pending' }), 'not_paid'],
    [makeOrder({ id: 'r', refundedAt: old }), 'refunded'],
    [makeOrder({ id: 'c', fulfillmentStatus: 'complete' }), 'fulfillment_started_or_terminal'],
    [makeOrder({ id: 'd', internalDisposition: 'abandoned_internal_test' }), 'internal_disposition'],
    [makeOrder({ id: FOUNDER_ORDER_ID }), 'excluded_by_allowlist'],
    [makeOrder({ id: 'h', fulfillmentMode: 'manual_hold' }), 'manual_hold'],
    [makeOrder({ id: 'mp', paidAt: null }), 'missing_paidat'],
    [makeOrder({ id: 'ip', paidAt: 'xx' }), 'invalid_paidat'],
    [makeOrder({ id: 'fp', paidAt: new Date(NOW + HOUR).toISOString() }), 'future_paidat'],
    [makeOrder({ id: 'b', paidAt: new Date(NOW - 1 * HOUR).toISOString() }), 'below_threshold'],
  ];
  for (const [order, reason] of cases) {
    const v = evaluateEligibility(order, c);
    assert.equal(v.eligible, false, `${order.id} should be ineligible`);
    assert.equal(v.reason, reason, `${order.id}`);
  }
});

// ── 4. cooldown / dedup ────────────────────────────────────────────────────────

test('4. duplicate scans respect cooldown', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a', paidAt: new Date(NOW - 13 * HOUR).toISOString() })]);
  const first = await runStrandedScan(deps);
  assert.equal(first.alertsSent, 1);
  deps.now = () => NOW + 1 * HOUR;
  const second = await runStrandedScan(deps);
  assert.equal(second.candidates, 1);
  assert.equal(second.alertsSent, 0);
  assert.equal(second.alertsSuppressed, 1);
  assert.equal(deps.alerts.length, 1);
});

test('cooldown expiry re-alerts', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a', paidAt: new Date(NOW - 13 * HOUR).toISOString() })]);
  await runStrandedScan(deps);
  deps.now = () => NOW + 25 * HOUR;
  const r = await runStrandedScan(deps);
  assert.equal(r.alertsSent, 1);
  assert.equal(deps.alerts.length, 2);
});

// ── 5. multiple qualifying orders ──────────────────────────────────────────────

test('5. multiple qualifying orders are each alerted once', async () => {
  const orders = [
    makeOrder({ id: 'ord_a', paidAt: new Date(NOW - 13 * HOUR).toISOString() }),
    makeOrder({ id: 'ord_b', paidAt: new Date(NOW - 40 * HOUR).toISOString() }),
    makeOrder({ id: 'ord_new', paidAt: new Date(NOW - 1 * HOUR).toISOString() }),      // below threshold
    makeOrder({ id: 'ord_hold', fulfillmentMode: 'manual_hold', paidAt: new Date(NOW - 40 * HOUR).toISOString() }), // held
  ];
  const deps = spyDeps(orders);
  const r = await runStrandedScan(deps);
  assert.equal(r.candidates, 2);
  assert.equal(r.alertsSent, 2);
  assert.deepEqual(deps.alerts.map((a) => a.orderId).sort(), ['ord_a', 'ord_b']);
});

// ── 6. storage/config failures fail closed ─────────────────────────────────────

test('6a. listOrders failure fails closed with no alerts/writes', async () => {
  const deps = spyDeps([], { listOrders: async () => { throw new Error('blob down'); } });
  const r = await runStrandedScan(deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'storage_unavailable');
  assert.equal(deps.alerts.length, 0);
  assert.equal(deps.writes.length, 0);
});

test('6b. readAlertState failure fails closed', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a', paidAt: new Date(NOW - 13 * HOUR).toISOString() })], {
    readAlertState: async () => { throw new Error('no token'); },
  });
  const r = await runStrandedScan(deps);
  assert.equal(r.failed, true);
  assert.equal(deps.alerts.length, 0);
  assert.equal(deps.writes.length, 0);
});

test('6c. invalid config fails closed', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a' })], { thresholdMs: -1 });
  const r = await runStrandedScan(deps);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'invalid_config');
  assert.equal(deps.alerts.length, 0);
});

// ── 7. internal disposition + allowlist (founder July-13) ──────────────────────

test('7. founder/internal-test July 13 order excluded (disposition or allowlist)', async () => {
  const stale = new Date(NOW - 300 * HOUR).toISOString();
  const viaDisposition = spyDeps([makeOrder({ id: FOUNDER_ORDER_ID, internalDisposition: 'abandoned_internal_test', paidAt: stale })]);
  assert.equal((await runStrandedScan(viaDisposition)).candidates, 0);
  assert.equal(viaDisposition.alerts.length, 0);
  const viaAllow = spyDeps([makeOrder({ id: FOUNDER_ORDER_ID, paidAt: stale })], { excludeOrderIds: new Set([FOUNDER_ORDER_ID]) });
  assert.equal((await runStrandedScan(viaAllow)).candidates, 0);
  assert.equal(viaAllow.alerts.length, 0);
});

// ── 8. Zero reachability ───────────────────────────────────────────────────────

const CORE = fileURLToPath(new URL('../src/lib/stranded-order-detector.ts', import.meta.url));

test('8a. detector core imports nothing runtime (only `import type`)', () => {
  const src = readFileSync(CORE, 'utf8');
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  assert.ok(importLines.length > 0);
  for (const line of importLines) assert.match(line, /^\s*import\s+type\b/, `non-type import: ${line.trim()}`);
});

test('8b. detector core references no fulfillment/email/stripe/order-write symbol', () => {
  const src = readFileSync(CORE, 'utf8');
  for (const token of [
    'triggerFulfillment', 'scheduleFulfillmentKickoff', 'runDigitalFulfillment', 'runPrintFulfillment',
    'updateFulfillmentState', 'updateOrderPayment', 'persistOrder',
    "from './fulfillment", "from './order-email", "from './lulu", "from 'stripe'", "from '@vercel/blob'",
    'sendDigitalDeliveryEmail', 'sendProofReadyEmail', 'submitPrintJob',
  ]) assert.equal(src.includes(token), false, `core must not reference ${token}`);
});

test('8c. scan invokes ONLY injected deps — no mutating capability exists', async () => {
  const touched: string[] = [];
  const orders = [makeOrder({ id: 'ord_a', paidAt: new Date(NOW - 13 * HOUR).toISOString() })];
  const deps: ScanDeps = {
    listOrders: async () => { touched.push('listOrders'); return orders; },
    readAlertState: async () => { touched.push('readAlertState'); return {}; },
    writeAlertState: async () => { touched.push('writeAlertState'); },
    alert: async () => { touched.push('alert'); },
    log: () => { touched.push('log'); },
    now: () => NOW,
    thresholdMs: 12 * HOUR,
    cooldownMs: 24 * HOUR,
    excludeOrderIds: new Set<string>(),
  };
  await runStrandedScan(deps);
  assert.deepEqual([...new Set(touched)].sort(), ['alert', 'listOrders', 'log', 'readAlertState', 'writeAlertState']);
});

test('8d. endpoint + runtime modules import no fulfillment/email/stripe symbol', () => {
  const endpoint = readFileSync(fileURLToPath(new URL('../src/app/api/internal/stranded-scan/route.ts', import.meta.url)), 'utf8');
  const runtime = readFileSync(fileURLToPath(new URL('../src/lib/stranded-order-detector-runtime.ts', import.meta.url)), 'utf8');
  for (const src of [endpoint, runtime])
    for (const token of ["from './fulfillment", "from '@/lib/fulfillment", "from './order-email", "from '@/lib/order-email", 'triggerFulfillment', 'updateFulfillmentState', 'updateOrderPayment', "from 'stripe'"])
      assert.equal(src.includes(token), false, `must not reference ${token}`);
});

// ── 9. endpoint auth + data minimization ───────────────────────────────────────

test('9a. cron auth fails closed and authorizes only the exact bearer', async () => {
  const { evaluateCronAuth } = await import('../src/lib/cron-auth.ts');
  assert.equal(evaluateCronAuth('Bearer s3cret', undefined), 503);
  assert.equal(evaluateCronAuth('Bearer s3cret', ''), 503);
  assert.equal(evaluateCronAuth(null, 's3cret'), 401);
  assert.equal(evaluateCronAuth('Bearer wrong', 's3cret'), 401);
  assert.equal(evaluateCronAuth('s3cret', 's3cret'), 401);
  assert.equal(evaluateCronAuth('Bearer s3cret', 's3cret'), null);
});

test('9b. endpoint responds with counts only — never order data/PII', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/app/api/internal/stranded-scan/route.ts', import.meta.url)), 'utf8');
  for (const k of ['ok', 'scanned', 'candidates', 'alertsSent', 'alertsSuppressed', 'skipped']) assert.ok(src.includes(`${k}:`));
  for (const forbidden of ['orderId', 'customerName', 'customerAddress', 'shippingAddress', '.email', 'result.orders'])
    assert.equal(src.includes(forbidden), false, `route must not expose ${forbidden}`);
});
