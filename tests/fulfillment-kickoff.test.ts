/**
 * Tests for the deferred fulfillment-kickoff helper. The webhook needs
 * to return 2xx fast AND reliably get triggerFulfillment running. The
 * 2026-05-08 retest #2 showed `next/server after()` callbacks silently
 * dropping in `next start`. This helper uses setImmediate (load-bearing
 * for local Node) plus after() (Vercel backup), with per-process
 * dedupe so the same orderId only runs triggerFulfillment once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  scheduleFulfillmentKickoff,
  _resetScheduledKickoffsForTest,
} from '../src/lib/fulfillment-kickoff.ts';

function makeRecorder() {
  const lines: string[] = [];
  return {
    log: (line: string) => lines.push(line),
    errorLog: (line: string, _err?: unknown) => lines.push(line),
    lines,
  };
}

test('scheduleFulfillmentKickoff: setImmediate fires triggerFulfillment exactly once', async () => {
  _resetScheduledKickoffsForTest();
  let triggerCalls = 0;
  const calledFor: string[] = [];
  const trigger = async (orderId: string) => {
    triggerCalls++;
    calledFor.push(orderId);
  };

  // Capture the setImmediate callback for manual control.
  let immediateCb: (() => void) | null = null;
  const setImmediateImpl = (cb: () => void) => {
    immediateCb = cb;
    return null;
  };
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_test_1', {
    trigger,
    setImmediateImpl,
    afterImpl: null,
    log: rec.log,
    errorLog: rec.errorLog,
  });

  // Schedule line is logged synchronously.
  assert.ok(
    rec.lines.some((l) => l.includes('scheduling for ord_test_1')),
    `expected schedule log line, got ${rec.lines.join(' | ')}`,
  );

  // Until the deferred callback fires, trigger has NOT been called.
  assert.equal(triggerCalls, 0);

  // Fire the deferred callback.
  assert.ok(immediateCb, 'setImmediate must have been called');
  immediateCb!();
  // Allow the async guarded() chain to settle.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(triggerCalls, 1);
  assert.deepEqual(calledFor, ['ord_test_1']);

  // Logs cover starting + completed.
  assert.ok(rec.lines.some((l) => l.includes('[setImmediate] starting triggerFulfillment for ord_test_1')));
  assert.ok(rec.lines.some((l) => l.includes('[setImmediate] completed triggerFulfillment for ord_test_1')));
});

test('scheduleFulfillmentKickoff: after() and setImmediate are deduped — triggerFulfillment runs at most once', async () => {
  _resetScheduledKickoffsForTest();
  let triggerCalls = 0;
  const trigger = async () => { triggerCalls++; };

  let immediateCb: (() => void) | null = null;
  let afterCb: (() => void) | null = null;
  const setImmediateImpl = (cb: () => void) => { immediateCb = cb; return null; };
  const afterImpl = (cb: () => void) => { afterCb = cb; };
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_dedup', {
    trigger,
    setImmediateImpl,
    afterImpl,
    log: rec.log,
    errorLog: rec.errorLog,
  });

  // Both schedulers were registered.
  assert.ok(immediateCb, 'setImmediate must be scheduled');
  assert.ok(afterCb, 'after() must be scheduled');

  // Fire BOTH. The closure-local `ran` guard must allow only one to
  // actually invoke triggerFulfillment.
  immediateCb!();
  afterCb!();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(triggerCalls, 1, 'triggerFulfillment must run at most once across both schedulers');
  assert.ok(rec.lines.some((l) => /\[after\] already ran|\[setImmediate\] already ran/.test(l)));
});

test('scheduleFulfillmentKickoff: same orderId scheduled twice in same process is deduped at the process level', async () => {
  _resetScheduledKickoffsForTest();
  let triggerCalls = 0;
  const trigger = async () => { triggerCalls++; };
  const rec = makeRecorder();

  // First schedule registers callbacks.
  let immediate1: (() => void) | null = null;
  scheduleFulfillmentKickoff('ord_proc_dedup', {
    trigger,
    setImmediateImpl: (cb) => { immediate1 = cb; return null; },
    afterImpl: null,
    log: rec.log,
    errorLog: rec.errorLog,
  });

  // Second schedule for the SAME orderId in the same process must be
  // a no-op (the process-level Set).
  let immediate2: (() => void) | null = null;
  scheduleFulfillmentKickoff('ord_proc_dedup', {
    trigger,
    setImmediateImpl: (cb) => { immediate2 = cb; return null; },
    afterImpl: null,
    log: rec.log,
    errorLog: rec.errorLog,
  });

  assert.ok(immediate1, 'first call must register setImmediate');
  assert.equal(immediate2, null, 'second call must NOT register a second setImmediate');
  assert.ok(rec.lines.some((l) => l.includes('already scheduled for ord_proc_dedup this process')));

  immediate1!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(triggerCalls, 1);
});

test('scheduleFulfillmentKickoff: triggerFulfillment failures are logged, not thrown', async () => {
  _resetScheduledKickoffsForTest();
  const trigger = async () => { throw new Error('boom'); };

  let immediateCb: (() => void) | null = null;
  const rec = makeRecorder();
  scheduleFulfillmentKickoff('ord_err', {
    trigger,
    setImmediateImpl: (cb) => { immediateCb = cb; return null; },
    afterImpl: null,
    log: rec.log,
    errorLog: rec.errorLog,
  });

  // The synchronous schedule call must NOT throw, even though trigger will.
  assert.ok(immediateCb);
  immediateCb!();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    rec.lines.some((l) => l.includes('[setImmediate] threw for ord_err')),
    `expected error log line, got ${rec.lines.join(' | ')}`,
  );
});

test('scheduleFulfillmentKickoff: missing afterImpl is tolerated (setImmediate-only path)', async () => {
  _resetScheduledKickoffsForTest();
  let triggerCalls = 0;
  const trigger = async () => { triggerCalls++; };
  let immediateCb: (() => void) | null = null;

  scheduleFulfillmentKickoff('ord_no_after', {
    trigger,
    setImmediateImpl: (cb) => { immediateCb = cb; return null; },
    afterImpl: null,
  });

  immediateCb!();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(triggerCalls, 1);
});

// ── Source-level guards ─────────────────────────────────────────────────────

test('source: webhook calls scheduleFulfillmentKickoff (not after() inline)', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  // Two call sites (new-paid and replay-backfill) both go through the helper.
  const calls = src.match(/scheduleFulfillmentKickoff\(orderId,\s*\{\s*afterImpl:\s*after\s*\}\s*\)/g) ?? [];
  assert.ok(calls.length >= 2, `expected at least 2 scheduleFulfillmentKickoff(...) call sites, got ${calls.length}`);
  // The previous direct after(async () => triggerFulfillment(...)) shape is gone.
  assert.doesNotMatch(src, /after\(async\s*\(\s*\)\s*=>\s*\{[\s\S]{0,200}triggerFulfillment\(/);
});

test('source: scheduleFulfillmentKickoff uses BOTH setImmediate and after()', () => {
  const src = readFileSync('src/lib/fulfillment-kickoff.ts', 'utf8');
  assert.match(src, /setImmediateFn\(/);
  assert.match(src, /afterFn\(/);
  assert.match(src, /scheduledOrderIds/);
});

test('source: triggerFulfillment logs at entry so silent kickoff drops are detectable', () => {
  const src = readFileSync('src/lib/fulfillment.ts', 'utf8');
  assert.match(src, /\[fulfillment\] entered for/);
  // Template-literal form in source.
  assert.match(src, /\[fulfillment\] starting \$\{[^}]*digital[^}]*\} run/);
});
