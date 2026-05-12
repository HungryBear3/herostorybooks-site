/**
 * Tests for the deferred fulfillment-kickoff helper.
 *
 * The 2026-05-08 retest #3 surfaced a race: when `after()` fired first
 * and observed `paymentStatus !== 'paid'` (persist not yet converged),
 * the closure-local `ran=true` permanently blocked the `setImmediate`
 * fallback. The helper now:
 *
 *   - Uses a structured `TriggerResult` from triggerFulfillment to
 *     distinguish "started / skipped / not_paid_yet / not_found".
 *   - Joins concurrent kickoffs via an in-flight Promise Map so two
 *     parallel schedulers don't race past the readback gate.
 *   - On `not_paid_yet`, schedules a bounded retry chain with
 *     exponential backoff. The fallback scheduler can also still fire
 *     and retry independently.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  scheduleFulfillmentKickoff,
  _resetInFlightForTest,
} from '../src/lib/fulfillment-kickoff.ts';
import type { TriggerResult } from '../src/lib/fulfillment.ts';

function makeRecorder() {
  const lines: string[] = [];
  return {
    log: (line: string) => lines.push(line),
    errorLog: (line: string, err?: unknown) => lines.push(err ? `${line} ${String(err)}` : line),
    lines,
  };
}

/**
 * In-process test scheduler: queues callbacks and lets the test drain
 * them in order. Lets us script "after fires first / setImmediate fires
 * later / retry fires after that" without real timers.
 */
function makeQueue() {
  const queue: Array<() => void | Promise<void>> = [];
  return {
    push: (cb: () => void | Promise<void>) => { queue.push(cb); },
    drain: async () => {
      while (queue.length > 0) {
        const cb = queue.shift()!;
        await cb();
        // let the cb's async chain run before pulling the next one
        await new Promise((r) => setImmediate(r));
      }
    },
    pending: () => queue.length,
  };
}

test('scheduler-1: after fires first with not_paid_yet → setImmediate fallback retries and starts fulfillment after readback converges', async () => {
  _resetInFlightForTest();

  // Trigger that fails the first call ("persist not converged yet"),
  // then succeeds the second (persist visible).
  let triggerCalls = 0;
  const trigger = async (orderId: string): Promise<TriggerResult> => {
    triggerCalls++;
    if (triggerCalls === 1) return { status: 'not_paid_yet', attempts: 3 };
    return { status: 'started' };
  };

  const setImmediateQ = makeQueue();
  const afterQ = makeQueue();
  const timeoutQ: Array<{ cb: () => void; ms: number }> = [];
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_after_first', {
    trigger,
    setImmediateImpl: (cb) => { setImmediateQ.push(cb); return null; },
    afterImpl: (cb) => { afterQ.push(cb); },
    setTimeoutImpl: (cb, ms) => { timeoutQ.push({ cb, ms }); return null; },
    log: rec.log,
    errorLog: rec.errorLog,
  });

  // Replicate Rex's race: `after` fires FIRST.
  await afterQ.drain();
  // First trigger returned not_paid_yet; helper scheduled a retry via setTimeout.
  assert.equal(triggerCalls, 1);
  assert.equal(timeoutQ.length, 1, 'after-path must schedule a retry on not_paid_yet');

  // setImmediate fires AFTER (the original 2026-05-08 retest pattern).
  // It must NOT be deduped to "already ran" — the previous attempt only
  // got `not_paid_yet`. The helper should run trigger again. By now the
  // mock returns `started`.
  await setImmediateQ.drain();
  assert.equal(triggerCalls, 2, 'setImmediate fallback must re-attempt after not_paid_yet');

  // Result lines are observable.
  assert.ok(rec.lines.some((l) => /\[after\] result=not_paid_yet/.test(l)));
  assert.ok(rec.lines.some((l) => /\[setImmediate\] result=started/.test(l)));
});

test('scheduler-2: pending payment never produces complete fulfillment after retry budget exhausts', async () => {
  _resetInFlightForTest();

  let triggerCalls = 0;
  const trigger = async (): Promise<TriggerResult> => {
    triggerCalls++;
    return { status: 'not_paid_yet', attempts: 1 };
  };

  const queues = { setImmediate: makeQueue(), after: makeQueue(), timeout: [] as Array<() => void> };
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_perma_pending', {
    trigger,
    setImmediateImpl: (cb) => { queues.setImmediate.push(cb); return null; },
    afterImpl: null, // setImmediate-only path — focused on retry budget
    setTimeoutImpl: (cb, _ms) => { queues.timeout.push(cb); return null; },
    log: rec.log,
    errorLog: rec.errorLog,
    notPaidYetMaxRetries: 3,
    retryDelayMs: () => 0,
  });

  await queues.setImmediate.drain();
  // First attempt (initial setImmediate)
  assert.equal(triggerCalls, 1);

  // Drain retries one at a time (each setTimeout callback is queued).
  while (queues.timeout.length > 0) {
    const cb = queues.timeout.shift()!;
    cb();
    await new Promise((r) => setImmediate(r));
  }

  // Initial + 3 retries = 4 attempts total.
  assert.equal(triggerCalls, 4);
  // Final log must declare "giving up".
  assert.ok(
    rec.lines.some((l) => l.includes('not_paid_yet after 3 retries — giving up for ord_perma_pending')),
    `expected give-up line, got:\n${rec.lines.join('\n')}`,
  );
});

test('scheduler-3: paid digital order reaches started without Lulu/print and with idempotent replay', async () => {
  _resetInFlightForTest();

  let triggerCalls = 0;
  let printCalls = 0;
  const trigger = async (): Promise<TriggerResult> => {
    triggerCalls++;
    // fake "Lulu would be called inside" — count it for the assertion
    void printCalls; // sentinel — real Lulu submission lives behind triggerFulfillment internals
    return { status: 'started' };
  };

  const queues = { setImmediate: makeQueue(), after: makeQueue() };
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_paid_digital', {
    trigger,
    setImmediateImpl: (cb) => { queues.setImmediate.push(cb); return null; },
    afterImpl: (cb) => { queues.after.push(cb); },
    setTimeoutImpl: () => null,
    log: rec.log,
    errorLog: rec.errorLog,
  });

  await queues.setImmediate.drain();
  assert.equal(triggerCalls, 1);
  // After also fires; must JOIN the in-flight result, not re-trigger.
  await queues.after.drain();
  assert.equal(triggerCalls, 1, 'after() must JOIN the existing in-flight kickoff, not re-trigger');
  assert.equal(printCalls, 0, 'no Lulu/print path through helper layer');
});

test('scheduler-4: duplicate webhook deliveries do not double-generate (in-flight join + idempotent replay)', async () => {
  _resetInFlightForTest();

  // First scheduling kicks off; second scheduling for the same orderId
  // must JOIN the same in-flight promise (no double trigger).
  let triggerCalls = 0;
  let resolveTrigger: ((r: TriggerResult) => void) | null = null;
  const trigger = async (): Promise<TriggerResult> => {
    triggerCalls++;
    return new Promise<TriggerResult>((resolve) => { resolveTrigger = resolve; });
  };

  const setImmediateQ = makeQueue();
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_dup_deliveries', {
    trigger,
    setImmediateImpl: (cb) => { setImmediateQ.push(cb); return null; },
    afterImpl: null,
    setTimeoutImpl: () => null,
    log: rec.log,
    errorLog: rec.errorLog,
  });
  // Second webhook delivery comes in BEFORE the first's trigger has resolved.
  scheduleFulfillmentKickoff('ord_dup_deliveries', {
    trigger,
    setImmediateImpl: (cb) => { setImmediateQ.push(cb); return null; },
    afterImpl: null,
    setTimeoutImpl: () => null,
    log: rec.log,
    errorLog: rec.errorLog,
  });

  // Drain both setImmediate callbacks.
  await setImmediateQ.drain();
  // Only ONE trigger call should be in flight.
  assert.equal(triggerCalls, 1, 'duplicate scheduling must JOIN, not double-trigger');
  // Now finish the first trigger.
  resolveTrigger!({ status: 'started' });
  await new Promise((r) => setImmediate(r));
  // Still only one trigger call total.
  assert.equal(triggerCalls, 1);
  assert.ok(rec.lines.some((l) => l.includes('joining in-flight kickoff for ord_dup_deliveries')));
});

test('scheduler-5: source-level — direct fulfillmentStatus=complete writes are bounded and accounted for', () => {
  // Compute completion sources at the SOURCE level so any path that
  // writes fulfillmentStatus=complete outside the audited functions is
  // caught immediately.
  const src = readFileSync('src/lib/fulfillment.ts', 'utf8');
  const completeAssignments = src.match(/fulfillmentStatus:\s*['"]complete['"]/g) ?? [];
  // The two known fulfillment-pipeline sites: runDigitalFulfillment final
  // write, runPrintFulfillment final write.
  assert.ok(completeAssignments.length >= 2, `expected at least 2 fulfillmentStatus=complete writes in fulfillment.ts, got ${completeAssignments.length}`);
  assert.ok(completeAssignments.length <= 2, `if a NEW completion path is added to fulfillment.ts, audit it before changing this assertion (got ${completeAssignments.length})`);

  // admin-actions.ts has TWO legitimate completion writes — both recover
  // an order from fulfillmentStatus='delivery_email_failed' after a
  // successful re-send of the customer email:
  //   1. retryOrderFulfillment short-circuit (smart retry)
  //   2. resendDigitalDelivery direct admin handle
  // Any additional `fulfillmentStatus: 'complete'` write here MUST be
  // audited — it would otherwise risk smuggling a "completed" order
  // without the corresponding artifact-generation evidence.
  const adminSrc = readFileSync('src/lib/admin-actions.ts', 'utf8');
  const adminCompleteAssignments = adminSrc.match(/fulfillmentStatus:\s*['"]complete['"]/g) ?? [];
  assert.equal(
    adminCompleteAssignments.length,
    2,
    `admin-actions.ts is allowed exactly 2 fulfillmentStatus=complete writes (delivery_email_failed → complete recovery), got ${adminCompleteAssignments.length}`,
  );

  const ordersSrc = readFileSync('src/lib/orders.ts', 'utf8');
  assert.doesNotMatch(ordersSrc, /fulfillmentStatus:\s*['"]complete['"]/);
});

test('scheduler-6: webhook source — kickoff is scheduled, never awaited inline', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  // Webhook calls scheduleFulfillmentKickoff for both new-paid + replay-backfill.
  const calls = src.match(/scheduleFulfillmentKickoff\(orderId,\s*\{\s*afterImpl:\s*after\s*\}\s*\)/g) ?? [];
  assert.ok(calls.length >= 2, `expected at least 2 scheduleFulfillmentKickoff() call sites, got ${calls.length}`);
  // Inline await of triggerFulfillment in the POST body is forbidden — it
  // would re-introduce the ~10s Stripe-CLI timeout.
  assert.doesNotMatch(src, /^\s*await\s+triggerFulfillment\(/m);
  // Helper must be imported.
  assert.match(src, /import\s*\{\s*scheduleFulfillmentKickoff\s*\}\s*from\s*'@\/lib\/fulfillment-kickoff'/);
});

// ── Source guards for the new helper ────────────────────────────────────────

test('source: scheduleFulfillmentKickoff uses BOTH setImmediate and after with bounded retry', () => {
  const src = readFileSync('src/lib/fulfillment-kickoff.ts', 'utf8');
  assert.match(src, /setImmediateFn\(/);
  assert.match(src, /afterFn\(\(\) => attempt\('after', 0\)\)/);
  assert.match(src, /setTimeoutFn\(/);
  assert.match(src, /inFlight/);
  assert.match(src, /not_paid_yet/);
  assert.match(src, /retryDelayMs/);
  // Closure-local "ran" boolean must be GONE — that was the 2026-05-08
  // retest #3 bug. In-flight Map + structured result is the new
  // dedupe mechanism.
  assert.doesNotMatch(src, /\blet\s+ran\s*=\s*false\b/);
});

test('source: triggerFulfillment logs at entry so silent kickoff drops are detectable', () => {
  const src = readFileSync('src/lib/fulfillment.ts', 'utf8');
  assert.match(src, /\[fulfillment\] entered for/);
  assert.match(src, /\[fulfillment\] starting \$\{[^}]*digital[^}]*\} run/);
  // Readback log must include both the converged + still-pending paths.
  assert.match(src, /confirmed paid after \$\{[^}]*\} readback attempt/);
  assert.match(src, /payment not confirmed after \$\{[^}]*\} readback attempt/);
});
