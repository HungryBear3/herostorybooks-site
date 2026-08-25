/**
 * Tests for the incident-classification scan that replaced the false-green
 * stranded detector.
 *
 * The old detector could only ever nominate `fulfillmentMode==='auto'` +
 * `not_started` orders, and no production workflow sets that mode — so it
 * reported a clean scan while covering nothing. The scan now delegates every
 * verdict to the shared pure classifier in `src/lib/order-incident.ts`, and it
 * fails/degrades loudly instead of returning a clean 200 when its own
 * enumeration, alert sink, or cooldown persistence is unreliable.
 *
 * The module remains alert-only with zero reachability to fulfillment, email,
 * Stripe, print providers or order writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  runIncidentScan,
  type AlertState,
  type OperatorIncidentAlert,
  type ScanDeps,
} from '../src/lib/stranded-order-detector.ts';
import { DEFAULT_INCIDENT_THRESHOLDS } from '../src/lib/order-incident.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

/** Strip comments so source-level invariants assert on CODE, not on prose that
 *  legitimately names the thing being forbidden (e.g. a comment explaining why
 *  the permissive list helper or an external channel must not be used). */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const T = DEFAULT_INCIDENT_THRESHOLDS;
// Synthetic id only. A production-shaped `ord_<16+ hex>` literal is banned in
// any committable file by REQ16 in tests/review-snapshot-and-guards.test.ts.
const EXCLUDED_INTERNAL_ORDER_ID = 'ord_internal_test_fixture';

/** Default fixture: paid `auto` order stuck at not_started well past threshold. */
function makeOrder(partial: Partial<OrderRecord> & { id: string }): OrderRecord {
  return {
    id: partial.id,
    childName: 'Luna',
    email: 'parent@example.com',
    bookFormat: 'digital',
    formatLabel: 'Digital',
    priceCents: 950,
    status: 'order_received',
    paymentStatus: 'paid',
    fulfillmentMode: 'auto',
    fulfillmentStatus: 'not_started',
    paidAt: iso(NOW - T.autoNotStartedMs - HOUR),
    deliveryExpectation: 'digital',
    createdAt: iso(NOW - 72 * HOUR),
    updatedAt: iso(NOW - T.autoNotStartedMs - HOUR),
    ...partial,
  } as unknown as OrderRecord;
}

interface SpyDeps extends ScanDeps {
  alerts: OperatorIncidentAlert[];
  writes: AlertState[];
  logs: string[];
}

function spyDeps(orders: OrderRecord[], overrides: Partial<ScanDeps> & { state?: AlertState } = {}): SpyDeps {
  const alerts: OperatorIncidentAlert[] = [];
  const writes: AlertState[] = [];
  const logs: string[] = [];
  let state: AlertState = overrides.state ?? {};
  return {
    listOrdersAuthoritative: overrides.listOrdersAuthoritative ?? (async () => orders),
    readAlertState: overrides.readAlertState ?? (async () => state),
    writeAlertState: overrides.writeAlertState ?? (async (s) => { writes.push(structuredClone(s)); state = s; }),
    alert: overrides.alert ?? (async (p) => { alerts.push(p); }),
    log: overrides.log ?? ((line) => { logs.push(line); }),
    now: overrides.now ?? (() => NOW),
    cooldownMs: overrides.cooldownMs ?? 24 * HOUR,
    thresholds: overrides.thresholds ?? T,
    excludeOrderIds: overrides.excludeOrderIds ?? new Set<string>(),
    alerts,
    writes,
    logs,
  };
}

// ── 1. the scan actually covers the taxonomy (no more false green) ────────────

test('1. the scan nominates each incident class, not just auto/not_started', async () => {
  const orders = [
    makeOrder({ id: 'ord_auto' }),
    makeOrder({
      id: 'ord_hold',
      fulfillmentMode: 'manual_hold',
      paidAt: iso(NOW - T.manualHoldMs - HOUR),
      updatedAt: iso(NOW - T.manualHoldMs - HOUR),
    }),
    makeOrder({
      id: 'ord_stale',
      fulfillmentStatus: 'building_pdf',
      fulfillmentKickoffId: null,
      fulfillmentKickoffAt: null,
      updatedAt: iso(NOW - T.staleInProgressMs - MINUTE),
    }),
    makeOrder({ id: 'ord_failed', fulfillmentStatus: 'failed_manual_review', updatedAt: iso(NOW - 3 * HOUR) }),
    makeOrder({ id: 'ord_email', fulfillmentStatus: 'delivery_email_failed', updatedAt: iso(NOW - 3 * HOUR) }),
    makeOrder({
      id: 'ord_print',
      bookFormat: 'classic',
      fulfillmentStatus: 'submitting_to_print',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      printSubmissionAttemptedAt: iso(NOW - HOUR),
      fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
      updatedAt: iso(NOW - HOUR),
    }),
  ];
  const deps = spyDeps(orders);
  const r = await runIncidentScan(deps);
  assert.equal(r.ok, true);
  assert.equal(r.failed, false);
  assert.equal(r.scanned, 6);
  assert.equal(r.incidents, 6);
  assert.equal(r.alertsSent, 6);
  assert.deepEqual(
    deps.alerts.map((a) => a.incidentClass).sort(),
    [
      'auto_not_started', 'delivery_email_failed', 'failed_manual_review',
      'manual_hold_sla', 'print_submission_ambiguous', 'stale_in_progress_no_lease',
    ],
  );
});

test('1b. a healthy order set produces a genuinely clean scan', async () => {
  const orders = [
    makeOrder({ id: 'ord_fresh', paidAt: iso(NOW - MINUTE), updatedAt: iso(NOW - MINUTE) }),
    makeOrder({ id: 'ord_done', fulfillmentStatus: 'complete', storyArtifactUrl: 'https://example.com/s.pdf' }),
  ];
  const deps = spyDeps(orders);
  const r = await runIncidentScan(deps);
  assert.deepEqual(
    { ok: r.ok, failed: r.failed, degraded: r.degraded, incidents: r.incidents, alertsSent: r.alertsSent },
    { ok: true, failed: false, degraded: false, incidents: 0, alertsSent: 0 },
  );
});

test('1c. refund finalization is never mistaken for a fulfillment incident', async () => {
  const deps = spyDeps([
    makeOrder({
      id: 'ord_refunded',
      paymentStatus: 'refunded',
      refundedAt: iso(NOW - HOUR),
      stripeRefundId: 're_abc',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentLastError: 'stripe_charge_refunded: ch_abc',
      updatedAt: iso(NOW - HOUR),
    }),
    makeOrder({
      id: 'ord_partial',
      paymentStatus: 'partially_refunded',
      stripeRefundId: 're_def',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentLastError: 'stripe_partial_refund: ch_def',
      updatedAt: iso(NOW - HOUR),
    }),
  ]);
  const r = await runIncidentScan(deps);
  assert.equal(r.incidents, 0);
  assert.equal(deps.alerts.length, 0);
});

// ── 2. authoritative enumeration only ────────────────────────────────────────

test('2a. enumeration throw fails the scan closed with no alerts or writes', async () => {
  const deps = spyDeps([], {
    listOrdersAuthoritative: async () => { throw new Error('BLOB_READ_WRITE_TOKEN missing in production'); },
  });
  const r = await runIncidentScan(deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'enumeration_unavailable');
  assert.equal(r.scanned, 0);
  assert.equal(deps.alerts.length, 0);
  assert.equal(deps.writes.length, 0);
});

test('2b. partial-enumeration ambiguity from the blob cursor fails closed', async () => {
  const deps = spyDeps([], {
    listOrdersAuthoritative: async () => { throw new Error('Blob listing reported hasMore without a cursor'); },
  });
  const r = await runIncidentScan(deps);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'enumeration_unavailable');
  assert.equal(deps.alerts.length, 0);
});

test('2c. readAlertState failure fails closed — never alert against unknown cooldown', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a' })], {
    readAlertState: async () => { throw new Error('no token'); },
  });
  const r = await runIncidentScan(deps);
  assert.equal(r.failed, true);
  assert.equal(deps.alerts.length, 0);
  assert.equal(deps.writes.length, 0);
});

test('2d. runtime wiring uses listOrdersAuthoritative and never permissive listOrders', () => {
  const runtime = readFileSync(
    fileURLToPath(new URL('../src/lib/stranded-order-detector-runtime.ts', import.meta.url)),
    'utf8',
  );
  assert.ok(runtime.includes('listOrdersAuthoritative'), 'runtime must wire listOrdersAuthoritative');
  assert.equal(
    /listOrders(?!Authoritative)/.test(codeOnly(runtime)),
    false,
    'runtime must not reference the permissive listOrders',
  );
  const core = readFileSync(
    fileURLToPath(new URL('../src/lib/stranded-order-detector.ts', import.meta.url)),
    'utf8',
  );
  assert.equal(
    /listOrders(?!Authoritative)/.test(codeOnly(core)),
    false,
    'core must not name permissive listOrders',
  );
});

test('2e. invalid config fails closed', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a' })], { cooldownMs: -1 });
  const r = await runIncidentScan(deps);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'invalid_config');
  assert.equal(deps.alerts.length, 0);
});

// ── 3. alert-sink failure must fail the scan and NOT advance cooldown ─────────

test('3a. alert failure returns a failed scan and never advances cooldown', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a' })], {
    alert: async () => { throw new Error('sink down'); },
  });
  const r = await runIncidentScan(deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'alert_sink_failed');
  assert.equal(r.alertFailures, 1);
  assert.equal(r.alertsSent, 0);
  // No cooldown advanced → the next scan retries this incident.
  assert.equal(deps.writes.length, 0);
});

test('3b. a partially failing sink still fails the scan but keeps successful cooldowns', async () => {
  const orders = [makeOrder({ id: 'ord_ok' }), makeOrder({ id: 'ord_bad' })];
  const deps = spyDeps(orders, {
    alert: async (p) => { if (p.orderId === 'ord_bad') throw new Error('sink down'); },
  });
  const r = await runIncidentScan(deps);
  assert.equal(r.failed, true);
  assert.equal(r.alertsSent, 1);
  assert.equal(r.alertFailures, 1);
  assert.equal(deps.writes.length, 1);
  const persisted = deps.writes[0];
  assert.equal(Object.keys(persisted).some((k) => k.startsWith('ord_ok::')), true);
  assert.equal(Object.keys(persisted).some((k) => k.startsWith('ord_bad::')), false);
});

test('3c. cooldown write failure returns a failed scan', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a' })], {
    writeAlertState: async () => { throw new Error('blob write down'); },
  });
  const r = await runIncidentScan(deps);
  assert.equal(r.ok, false);
  assert.equal(r.failed, true);
  assert.equal(r.reason, 'cooldown_persist_failed');
});

test('3d. HTTP never reports a clean 200 for a sink or cooldown failure', () => {
  const route = readFileSync(
    fileURLToPath(new URL('../src/app/api/internal/stranded-scan/route.ts', import.meta.url)),
    'utf8',
  );
  assert.match(route, /result\.failed \? 500 : 200/);
  assert.ok(route.includes('degraded'), 'route body must carry the degraded signal');
});

// ── 4. incident identity + cooldown are per incident, not per order ───────────

test('4a. cooldown suppresses a repeat of the same incident identity', async () => {
  const orders = [makeOrder({ id: 'ord_a' })];
  const first = spyDeps(orders);
  const r1 = await runIncidentScan(first);
  assert.equal(r1.alertsSent, 1);
  const carried = first.writes[0];

  const second = spyDeps(orders, { state: carried, now: () => NOW + HOUR });
  const r2 = await runIncidentScan(second);
  assert.equal(r2.alertsSent, 0);
  assert.equal(r2.alertsSuppressed, 1);
  assert.equal(second.alerts.length, 0);
});

test('4b. a new attempt fingerprint defeats the cooldown even inside the window', async () => {
  const before = makeOrder({
    id: 'ord_a', fulfillmentStatus: 'failed_manual_review',
    fulfillmentAttempts: 1, updatedAt: iso(NOW - 3 * HOUR),
  });
  const first = spyDeps([before]);
  await runIncidentScan(first);
  const carried = first.writes[0];

  const after = makeOrder({
    id: 'ord_a', fulfillmentStatus: 'failed_manual_review',
    fulfillmentAttempts: 2, updatedAt: iso(NOW - 3 * HOUR),
  });
  const second = spyDeps([after], { state: carried, now: () => NOW + HOUR });
  const r2 = await runIncidentScan(second);
  assert.equal(r2.alertsSent, 1, 'a fresh attempt is a new incident identity');
  assert.equal(r2.alertsSuppressed, 0);
});

test('4c. cooldown state is keyed by dedup key, never by order id alone', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a' })]);
  await runIncidentScan(deps);
  const keys = Object.keys(deps.writes[0]);
  assert.equal(keys.length, 1);
  assert.notEqual(keys[0], 'ord_a');
  assert.ok(keys[0].startsWith('ord_a::auto_not_started::'));
});

test('4d. cooldown expiry re-alerts the same identity', async () => {
  const orders = [makeOrder({ id: 'ord_a' })];
  const first = spyDeps(orders);
  await runIncidentScan(first);
  const second = spyDeps(orders, { state: first.writes[0], now: () => NOW + 25 * HOUR });
  assert.equal((await runIncidentScan(second)).alertsSent, 1);
});

// ── 5. data-quality uncertainty degrades the scan ────────────────────────────

test('5a. timestamp/data-quality uncertainty marks the scan degraded', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_dq', paidAt: 'not-a-date' })]);
  const r = await runIncidentScan(deps);
  assert.equal(r.degraded, true);
  assert.equal(r.dataQuality, 1);
  assert.equal(r.failed, false);
  assert.equal(deps.alerts[0]?.incidentClass, 'data_quality_uncertain');
});

test('5b. a clean scan is not degraded', async () => {
  const deps = spyDeps([makeOrder({ id: 'ord_a' })]);
  assert.equal((await runIncidentScan(deps)).degraded, false);
});

// ── 6. operator exclusions ───────────────────────────────────────────────────

test('6. founder/internal-test July 13 order excluded (disposition or allowlist)', async () => {
  const stale = iso(NOW - 300 * HOUR);
  const viaDisposition = spyDeps([
    makeOrder({ id: EXCLUDED_INTERNAL_ORDER_ID, internalDisposition: 'abandoned_internal_test', paidAt: stale, updatedAt: stale }),
  ]);
  assert.equal((await runIncidentScan(viaDisposition)).incidents, 0);
  assert.equal(viaDisposition.alerts.length, 0);

  const viaAllow = spyDeps([makeOrder({ id: EXCLUDED_INTERNAL_ORDER_ID, paidAt: stale, updatedAt: stale })], {
    excludeOrderIds: new Set([EXCLUDED_INTERNAL_ORDER_ID]),
  });
  assert.equal((await runIncidentScan(viaAllow)).incidents, 0);
  assert.equal(viaAllow.alerts.length, 0);
});

// ── 7. PII absence in payload AND logs ───────────────────────────────────────

test('7. neither the alert payload nor any log line carries PII', async () => {
  const orders = [
    makeOrder({
      id: 'ord_pii',
      childName: 'Persephone',
      email: 'secret.parent@example.com',
      bookFormat: 'classic',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentLastError: 'stripe_charge_refunded_lookalike: ch_LEAKY_ID for secret.parent@example.com',
      storyArtifactUrl: 'https://blob.example.com/private/story-Persephone.pdf',
      proofApprovalToken: 'tok_SUPER_SECRET',
      shippingAddress: { line1: '9 Leak Lane', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
      updatedAt: iso(NOW - 3 * HOUR),
    }),
    makeOrder({
      id: 'ord_pii_print',
      childName: 'Persephone',
      email: 'secret.parent@example.com',
      bookFormat: 'classic',
      fulfillmentStatus: 'submitting_to_print',
      printSubmissionAttemptedAt: iso(NOW - HOUR),
      fulfillmentLastError: 'print_submission_ambiguous: lulu 502 for ch_LEAKY_ID',
      storyArtifactUrl: 'https://blob.example.com/private/story-Persephone.pdf',
      proofApprovalToken: 'tok_SUPER_SECRET',
      updatedAt: iso(NOW - HOUR),
    }),
  ];
  const deps = spyDeps(orders);
  const r = await runIncidentScan(deps);
  assert.equal(r.alertsSent, 2);

  const forbidden = [
    'Persephone', 'secret.parent@example.com', '@example.com', 'tok_SUPER_SECRET',
    'ch_LEAKY_ID', '9 Leak Lane', '60601', 'blob.example.com', 'https://', 'lulu',
  ];
  const surface = JSON.stringify(deps.alerts) + '\n' + deps.logs.join('\n');
  for (const needle of forbidden) {
    assert.equal(surface.includes(needle), false, `alert/log surface leaked ${needle}`);
  }
  assert.ok(surface.includes('ord_pii'), 'the opaque order id is the intended identifier');
});

test('7b. sink and enumeration errors are sanitized before they reach a log line', async () => {
  const deps = spyDeps([], {
    listOrdersAuthoritative: async () => {
      throw new Error('blob 500 for secret.parent@example.com token vercel_blob_rw_ABCDEFGH12345678');
    },
  });
  await runIncidentScan(deps);
  const surface = deps.logs.join('\n');
  assert.equal(surface.includes('secret.parent@example.com'), false);
  assert.equal(surface.includes('vercel_blob_rw_ABCDEFGH12345678'), false);
});

// ── 8. zero reachability ─────────────────────────────────────────────────────

const CORE = fileURLToPath(new URL('../src/lib/stranded-order-detector.ts', import.meta.url));

test('8a. the ONLY runtime import the core may have is the pure classifier', () => {
  // The invariant is reachability, not import syntax: the core must be unable
  // to reach fulfillment, storage, email, Stripe or a provider. A type-only
  // import can reach nothing; the shared classifier is itself proven pure by
  // tests/order-incident-classification.test.ts. Nothing else is permitted.
  const src = readFileSync(CORE, 'utf8');
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
  assert.ok(importLines.length > 0);
  for (const line of importLines) {
    const isTypeOnly = /^\s*import\s+type\b/.test(line);
    const isPureClassifier = /^\s*import\s+\{[^}]*\}\s+from\s+'\.\/order-incident\.ts';\s*$/.test(line);
    assert.ok(isTypeOnly || isPureClassifier, `disallowed runtime import: ${line.trim()}`);
  }
  const classifier = readFileSync(
    fileURLToPath(new URL('../src/lib/order-incident.ts', import.meta.url)),
    'utf8',
  );
  for (const line of classifier.split('\n').filter((l) => /^\s*import\b/.test(l))) {
    assert.match(line, /^\s*import\s+type\b/, `shared classifier must stay type-only: ${line.trim()}`);
  }
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
  const orders = [makeOrder({ id: 'ord_a' })];
  const deps: ScanDeps = {
    listOrdersAuthoritative: async () => { touched.push('listOrdersAuthoritative'); return orders; },
    readAlertState: async () => { touched.push('readAlertState'); return {}; },
    writeAlertState: async () => { touched.push('writeAlertState'); },
    alert: async () => { touched.push('alert'); },
    log: () => { touched.push('log'); },
    now: () => NOW,
    cooldownMs: 24 * HOUR,
    thresholds: T,
    excludeOrderIds: new Set<string>(),
  };
  await runIncidentScan(deps);
  assert.deepEqual(
    [...new Set(touched)].sort(),
    ['alert', 'listOrdersAuthoritative', 'log', 'readAlertState', 'writeAlertState'],
  );
});

test('8d. endpoint + runtime modules import no fulfillment/email/stripe symbol', () => {
  const endpoint = readFileSync(fileURLToPath(new URL('../src/app/api/internal/stranded-scan/route.ts', import.meta.url)), 'utf8');
  const runtime = readFileSync(fileURLToPath(new URL('../src/lib/stranded-order-detector-runtime.ts', import.meta.url)), 'utf8');
  for (const src of [endpoint, runtime])
    for (const token of ["from './fulfillment", "from '@/lib/fulfillment", "from './order-email", "from '@/lib/order-email", 'triggerFulfillment', 'updateFulfillmentState', 'updateOrderPayment', "from 'stripe'"])
      assert.equal(src.includes(token), false, `must not reference ${token}`);
});

test('8e. no external alert channel and no cron schedule are wired by this lane', () => {
  const runtime = readFileSync(fileURLToPath(new URL('../src/lib/stranded-order-detector-runtime.ts', import.meta.url)), 'utf8');
  const runtimeCode = codeOnly(runtime).toLowerCase();
  for (const token of ['resend', 'discord', 'slack', 'telegram', 'webhook', 'sendOperatorFailureAlert'])
    assert.equal(runtimeCode.includes(token.toLowerCase()), false, `sink must stay local: ${token}`);
  const vercelJson = readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8');
  assert.equal(vercelJson.includes('stranded-scan'), false, 'no cron activation in this lane');
});

// ── 9. endpoint auth + data minimization ─────────────────────────────────────

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
  for (const k of ['ok', 'degraded', 'scanned', 'incidents', 'alertsSent', 'alertsSuppressed', 'alertFailures', 'dataQuality'])
    assert.ok(src.includes(`${k}:`), `route body must report ${k}`);
  for (const forbidden of ['orderId', 'customerName', 'customerAddress', 'shippingAddress', '.email', 'result.orders', 'incidentClass'])
    assert.equal(src.includes(forbidden), false, `route must not expose ${forbidden}`);
});
