/**
 * Source-level guardrail tests for the durable fulfillment-sweep cron route.
 * (Route handlers are heavy to invoke; the repo convention is source assertions
 *  for wiring + auth + safety, with behavior covered by the pure selector.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROUTE = readFileSync(new URL('../src/app/api/cron/fulfillment-sweep/route.ts', import.meta.url), 'utf8');
const VERCEL = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');

test('cron route is GET-only (no mutating HTTP verbs)', () => {
  assert.match(ROUTE, /export async function GET\(/);
  for (const v of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.doesNotMatch(ROUTE, new RegExp(`export async function ${v}\\(`), `must not expose ${v}`);
  }
});

test('cron route is authorized before doing work (vercel-cron header or admin key) and 401s otherwise', () => {
  assert.match(ROUTE, /x-vercel-cron/);
  assert.match(ROUTE, /isAdminAuthedFromRequest/);
  assert.match(ROUTE, /401/);
  const authIdx = ROUTE.indexOf('isAuthorized(request)');
  const workIdx = ROUTE.indexOf('listOrders(');
  assert.ok(authIdx > -1 && workIdx > -1 && authIdx < workIdx, 'auth must precede any order work');
});

test('cron route runs fulfillment durably (long maxDuration) via the idempotent trigger', () => {
  assert.match(ROUTE, /export const maxDuration = 300/);
  assert.match(ROUTE, /findFulfillmentBacklog\(/);
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

test('vercel.json registers the durable cron schedule for the sweep route', () => {
  const cfg = JSON.parse(VERCEL);
  const crons = cfg.crons || [];
  const sweep = crons.find((c: { path: string }) => c.path === '/api/cron/fulfillment-sweep');
  assert.ok(sweep, 'sweep cron must be registered');
  assert.match(sweep.schedule, /\*/, 'must have a cron schedule');
});
