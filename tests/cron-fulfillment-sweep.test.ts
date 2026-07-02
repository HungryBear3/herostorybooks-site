/**
 * Tests for the durable fulfillment-sweep cron route.
 *
 * Auth/safety wiring is asserted at the source level (route handlers are heavy
 * to invoke), and the auth DECISIONS + auth-before-work guarantee are proven at
 * runtime against the extracted, importable helpers in fulfillment-backlog.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isFulfillmentSweepAuthorized,
  runFulfillmentSweep,
} from '../src/lib/fulfillment-backlog.ts';

const ROUTE = readFileSync(new URL('../src/app/api/cron/fulfillment-sweep/route.ts', import.meta.url), 'utf8');
const ADMIN_ORDERS_ROUTE = readFileSync(new URL('../src/app/api/admin/orders/route.ts', import.meta.url), 'utf8');
const VERCEL = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { await fn(); }
  finally { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const req = (headers: Record<string, string> = {}) =>
  new Request('https://herostorybooks.com/api/cron/fulfillment-sweep', { headers });

// ── source-level wiring/safety guards ──────────────────────────────────────

test('cron route is GET-only (no mutating HTTP verbs)', () => {
  assert.match(ROUTE, /export async function GET\(/);
  for (const v of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.doesNotMatch(ROUTE, new RegExp(`export async function ${v}\\(`), `must not expose ${v}`);
  }
});

test('cron route CODE no longer trusts the spoofable x-vercel-cron header / user-agent', () => {
  // Strip comments so the doc note ("...x-vercel-cron... are NOT trusted") is
  // allowed; only executable code is checked.
  const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /x-vercel-cron/i, 'code must not key authorization off x-vercel-cron');
  assert.doesNotMatch(code, /vercel-cron/i, 'code must not key authorization off the vercel-cron user-agent');
});

test('cron route gates work behind fail-closed auth (delegates 401 to the runner)', () => {
  // The route computes authorization from the request and hands it to the runner,
  // which refuses (401) before any list/trigger work. The auth-before-work
  // guarantee itself is proven by the runtime test below.
  assert.match(ROUTE, /authorized:\s*isFulfillmentSweepAuthorized\(request\)/);
  assert.match(ROUTE, /runFulfillmentSweep\(/);
  assert.match(ROUTE, /status:\s*out\.status/);
});

test('cron route runs fulfillment durably (long maxDuration) via idempotent trigger', () => {
  assert.match(ROUTE, /export const maxDuration = 300/);
  assert.match(ROUTE, /triggerFulfillment\(/);
});

test('repro order is excluded from auto-sweep until explicit approval', () => {
  assert.match(ROUTE, /SWEEP_EXCLUDE/);
  assert.match(ROUTE, /ord_d4b46e9123c147ac/);
  assert.match(ROUTE, /excludeOrderIds:\s*SWEEP_EXCLUDE/);
});

test('cron route triggers no print / no email-release / no payment side effects', () => {
  assert.doesNotMatch(ROUTE, /submitPrint|recordOwnerPrintGo|runPrintProduction|sendProofReadyEmail|sendDigitalDeliveryEmail|releaseOrderAfterQa|stripe|refund/i);
});

test('cron/admin routes expose ops digest hooks for paid-stuck and alert buckets', () => {
  assert.match(ROUTE, /runFulfillmentSweep\(/);
  assert.match(ADMIN_ORDERS_ROUTE, /buildFulfillmentOpsDigest\(orders\)/);
  assert.match(ADMIN_ORDERS_ROUTE, /opsDigest/);
});

test('vercel.json registers exactly one cron — the sweep route (no duplicate backfill cron)', () => {
  const cfg = JSON.parse(VERCEL);
  const crons = cfg.crons || [];
  assert.equal(crons.length, 1, 'exactly one cron');
  assert.equal(crons[0].path, '/api/cron/fulfillment-sweep');
  assert.match(crons[0].schedule, /\*/);
  assert.doesNotMatch(VERCEL, /fulfillment-backfill/, 'no competing backfill cron');
});

// ── RUNTIME: fail-closed cron auth decisions ───────────────────────────────

test('runtime: missing auth is unauthorized', async () => {
  await withEnv({ CRON_SECRET: undefined, HSB_ORDER_ADMIN_KEY: undefined }, () => {
    assert.equal(isFulfillmentSweepAuthorized(req()), false);
  });
});

test('runtime: forged x-vercel-cron header / user-agent WITHOUT CRON_SECRET is unauthorized', async () => {
  await withEnv({ CRON_SECRET: undefined, HSB_ORDER_ADMIN_KEY: undefined }, () => {
    assert.equal(isFulfillmentSweepAuthorized(req({ 'x-vercel-cron': '1' })), false);
    assert.equal(isFulfillmentSweepAuthorized(req({ 'user-agent': 'vercel-cron/1.0' })), false);
    assert.equal(isFulfillmentSweepAuthorized(req({ 'x-vercel-cron': '1', 'user-agent': 'vercel-cron/1.0' })), false);
  });
});

test('runtime: forged cron header is STILL rejected when CRON_SECRET is set but no valid bearer', async () => {
  await withEnv({ CRON_SECRET: 's3cret', HSB_ORDER_ADMIN_KEY: undefined }, () => {
    assert.equal(isFulfillmentSweepAuthorized(req({ 'x-vercel-cron': '1' })), false);
    assert.equal(isFulfillmentSweepAuthorized(req({ authorization: 'Bearer wrong' })), false);
  });
});

test('runtime: valid Bearer CRON_SECRET is authorized', async () => {
  await withEnv({ CRON_SECRET: 's3cret', HSB_ORDER_ADMIN_KEY: undefined }, () => {
    assert.equal(isFulfillmentSweepAuthorized(req({ authorization: 'Bearer s3cret' })), true);
  });
});

test('runtime: operator admin key still authorizes manual runs', async () => {
  await withEnv({ CRON_SECRET: undefined, HSB_ORDER_ADMIN_KEY: 'adm1n' }, () => {
    assert.equal(isFulfillmentSweepAuthorized(req({ 'x-hsb-order-admin-key': 'adm1n' })), true);
    assert.equal(isFulfillmentSweepAuthorized(req({ 'x-hsb-order-admin-key': 'nope' })), false);
  });
});

// ── RUNTIME: auth happens before any work; valid auth lets work run ────────

test('runtime: unauthorized sweep returns 401 and does NO work (no list, no trigger)', async () => {
  let listed = 0; let triggered = 0;
  const out = await runFulfillmentSweep({
    authorized: false,
    listOrders: async () => { listed += 1; return []; },
    trigger: async () => { triggered += 1; return { status: 'started' } as any; },
  });
  assert.equal(out.status, 401);
  assert.equal(listed, 0, 'must not list orders when unauthorized');
  assert.equal(triggered, 0, 'must not trigger fulfillment when unauthorized');
});

test('runtime: authorized sweep returns 200 and runs work (triggers eligible order once, excludes repro)', async () => {
  const now = new Date('2026-06-04T12:00:00.000Z');
  const calls: string[] = [];
  const orders = [
    { id: 'ord_stuck', paymentStatus: 'paid', fulfillmentStatus: 'not_started', createdAt: '2026-06-04T11:50:00.000Z', updatedAt: '2026-06-04T11:50:00.000Z' },
    { id: 'ord_d4b46e9123c147ac', paymentStatus: 'paid', fulfillmentStatus: 'not_started', createdAt: '2026-06-04T11:50:00.000Z', updatedAt: '2026-06-04T11:50:00.000Z' },
  ] as any[];
  const out = await runFulfillmentSweep({
    authorized: true,
    listOrders: async () => orders,
    trigger: async (id) => { calls.push(id); return { status: 'started' } as any; },
    excludeOrderIds: new Set(['ord_d4b46e9123c147ac']),
    limit: 3,
    now,
  });
  assert.equal(out.status, 200);
  assert.deepEqual(calls, ['ord_stuck'], 'triggers only the eligible, non-excluded order, once');
  assert.equal(out.body.swept, 1);
  assert.deepEqual(out.body.opsDigest?.orderIds.paidStuck, ['ord_stuck']);
});
