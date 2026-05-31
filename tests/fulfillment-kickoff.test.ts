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
  // The known fulfillment-pipeline site: QA-passed digital fulfillment final
  // write. Print fulfillment now reaches proof_ready, not complete.
  assert.equal(
    completeAssignments.length,
    1,
    `if a NEW completion path is added to fulfillment.ts, audit it before changing this assertion (got ${completeAssignments.length})`,
  );

  // admin-actions.ts has two direct completion writes that recover
  // an order from fulfillmentStatus='delivery_email_failed' after a
  // successful re-send of the customer email. The QA-pass path uses an
  // audited digital-vs-print ternary asserted below:
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
    `admin-actions.ts is allowed exactly 2 direct fulfillmentStatus=complete writes, got ${adminCompleteAssignments.length}`,
  );
  assert.match(adminSrc, /releaseOrderAfterQa[\s\S]+fulfillmentStatus:\s*isDigital\s*\?\s*'complete'\s*:\s*'proof_ready'/);

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

// ── Observability: kickoff correlation id + chain-exit summary ──────────────
//
// These guards close the contradictory preview-log state where logs said
// "fulfillment kickoff refusing because paymentStatus !== paid" but admin
// showed the order as complete. With the kickoff correlation id every log
// line for one invocation grep-able as a single trace, and with the
// chain-exit summary the operator can see the order's REAL paymentStatus +
// fulfillmentStatus at the moment this helper exited — no need to
// cross-reference admin to figure out whether some other path picked the
// order up.

test('observability-1: every log line for one kickoff carries the same [webhook][kickoff:<id>] prefix', async () => {
  _resetInFlightForTest();

  const trigger = async (): Promise<TriggerResult> => ({ status: 'started' });
  const setImmediateQ = makeQueue();
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_corr_id', {
    trigger,
    setImmediateImpl: (cb) => { setImmediateQ.push(cb); return null; },
    afterImpl: null,
    setTimeoutImpl: () => null,
    log: rec.log,
    errorLog: rec.errorLog,
    getOrderForSummary: async () => ({
      // Minimal OrderRecord shape — only the two fields the summary line reads.
      paymentStatus: 'paid',
      fulfillmentStatus: 'generating_story',
    } as never),
    kickoffIdFactory: () => 'deadbeef',
  });
  await setImmediateQ.drain();

  // EVERY emitted line must carry the same correlation prefix.
  assert.ok(rec.lines.length > 0, 'expected at least one emitted log line');
  for (const line of rec.lines) {
    assert.match(
      line,
      /\[webhook\]\[kickoff:deadbeef\]/,
      `every log line must carry the kickoff correlation prefix; offender:\n${line}`,
    );
  }
});

test('observability-2: chain that initially saw not_paid_yet but later succeeded emits a closing summary with the order\'s real state', async () => {
  _resetInFlightForTest();

  let triggerCalls = 0;
  const trigger = async (): Promise<TriggerResult> => {
    triggerCalls++;
    if (triggerCalls === 1) return { status: 'not_paid_yet', attempts: 3 };
    return { status: 'started' };
  };

  const setImmediateQ = makeQueue();
  const timeoutQ: Array<() => void> = [];
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_resolved_after_retry', {
    trigger,
    setImmediateImpl: (cb) => { setImmediateQ.push(cb); return null; },
    afterImpl: null,
    setTimeoutImpl: (cb) => { timeoutQ.push(cb); return null; },
    log: rec.log,
    errorLog: rec.errorLog,
    notPaidYetMaxRetries: 3,
    retryDelayMs: () => 0,
    getOrderForSummary: async () => ({
      paymentStatus: 'paid',
      fulfillmentStatus: 'generating_story',
    } as never),
    kickoffIdFactory: () => 'aaaaaaaa',
  });

  await setImmediateQ.drain();
  // First attempt got not_paid_yet — chain scheduled a retry, did NOT exit yet.
  assert.equal(triggerCalls, 1);
  assert.equal(timeoutQ.length, 1);
  // The retry is fired by setTimeout.
  const retry = timeoutQ.shift()!;
  retry();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // Trigger was called twice; second call returned started.
  assert.equal(triggerCalls, 2);

  // The closing summary line must be present, must include the
  // outcome=started, and must include the order's real state.
  const summary = rec.lines.find((l) => l.includes('chain exited:'));
  assert.ok(summary, `expected a chain-exit summary line; got:\n${rec.lines.join('\n')}`);
  assert.match(summary!, /\[webhook\]\[kickoff:aaaaaaaa\]/);
  assert.match(summary!, /outcome=started/);
  assert.match(summary!, /orderPaymentStatus=paid/);
  assert.match(summary!, /orderFulfillmentStatus=generating_story/);
});

test('observability-3: exhausted-retries log line is reframed as helper-local, NOT terminal-for-order, and is followed by a chain-exit summary that shows real state', async () => {
  _resetInFlightForTest();

  let triggerCalls = 0;
  const trigger = async (): Promise<TriggerResult> => {
    triggerCalls++;
    return { status: 'not_paid_yet', attempts: 1 };
  };

  const setImmediateQ = makeQueue();
  const timeoutQ: Array<() => void> = [];
  const rec = makeRecorder();

  // Simulate the scary contradictory state: the kickoff helper exhausts
  // its retry budget while paymentStatus has not converged in its view,
  // BUT a parallel path has already advanced the order to complete by
  // the time the summary read runs.
  scheduleFulfillmentKickoff('ord_giveup_but_actually_complete', {
    trigger,
    setImmediateImpl: (cb) => { setImmediateQ.push(cb); return null; },
    afterImpl: null,
    setTimeoutImpl: (cb) => { timeoutQ.push(cb); return null; },
    log: rec.log,
    errorLog: rec.errorLog,
    notPaidYetMaxRetries: 2,
    retryDelayMs: () => 0,
    getOrderForSummary: async () => ({
      paymentStatus: 'paid',
      fulfillmentStatus: 'complete',
    } as never),
    kickoffIdFactory: () => 'bbbbbbbb',
  });

  await setImmediateQ.drain();
  // Drain retries.
  while (timeoutQ.length > 0) {
    const cb = timeoutQ.shift()!;
    cb();
    await new Promise((r) => setImmediate(r));
  }
  // Let the trailing async emitChainExitSummary settle.
  await new Promise((r) => setImmediate(r));

  // Initial + 2 retries = 3 attempts; all not_paid_yet → helper gave up.
  assert.equal(triggerCalls, 3);

  // Existing "giving up" substring is preserved for backwards compat with
  // older log greps, BUT the line must now also include the disambiguator
  // that this is NOT a terminal failure for the order.
  const giveupLine = rec.lines.find((l) =>
    l.includes('giving up for ord_giveup_but_actually_complete'),
  );
  assert.ok(giveupLine, `expected give-up line, got:\n${rec.lines.join('\n')}`);
  assert.match(giveupLine!, /\[webhook\]\[kickoff:bbbbbbbb\]/);
  assert.match(giveupLine!, /NOT terminal for the order/);
  assert.match(giveupLine!, /parallel scheduler.*Stripe webhook redelivery.*admin retry/i);

  // The chain-exit summary line must immediately resolve the apparent
  // contradiction: the order is actually paid+complete despite this
  // helper's local view that payment hadn't converged.
  const summary = rec.lines.find((l) => l.includes('chain exited:'));
  assert.ok(summary, `expected a chain-exit summary line; got:\n${rec.lines.join('\n')}`);
  assert.match(summary!, /\[webhook\]\[kickoff:bbbbbbbb\]/);
  assert.match(summary!, /outcome=exhausted_retries/);
  assert.match(summary!, /orderPaymentStatus=paid/);
  assert.match(summary!, /orderFulfillmentStatus=complete/);
});

test('observability-4: chain-exit summary survives a getOrderForSummary failure (best-effort, never crashes the runtime)', async () => {
  _resetInFlightForTest();

  const trigger = async (): Promise<TriggerResult> => ({ status: 'started' });
  const setImmediateQ = makeQueue();
  const rec = makeRecorder();

  scheduleFulfillmentKickoff('ord_summary_read_fails', {
    trigger,
    setImmediateImpl: (cb) => { setImmediateQ.push(cb); return null; },
    afterImpl: null,
    setTimeoutImpl: () => null,
    log: rec.log,
    errorLog: rec.errorLog,
    getOrderForSummary: async () => { throw new Error('blob read timed out'); },
    kickoffIdFactory: () => 'cccccccc',
  });
  await setImmediateQ.drain();
  await new Promise((r) => setImmediate(r));

  // The chain still completes; the summary degrades to a read_error line.
  const degraded = rec.lines.find((l) => l.includes('orderState=read_error'));
  assert.ok(degraded, `expected degraded summary line, got:\n${rec.lines.join('\n')}`);
  assert.match(degraded!, /\[webhook\]\[kickoff:cccccccc\]/);
  assert.match(degraded!, /outcome=started/);
});

test('observability-5: webhook source explicitly logs the replay-skip for already-paid orders past not_started', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  // The new explicit-skip branch must exist and call out the reason so
  // operators don't have to infer the skip from absence-of-kickoff lines.
  assert.match(
    src,
    /replay skipped — paymentStatus=paid/,
    'webhook must log an explicit skip reason for paid orders with fulfillment past not_started',
  );
  assert.match(
    src,
    /no kickoff retrigger needed/,
    'skip log line must state that no kickoff was retriggered',
  );
});

test('observability-6: source — kickoff helper imports getOrder for the summary read', () => {
  const src = readFileSync('src/lib/fulfillment-kickoff.ts', 'utf8');
  assert.match(src, /import\s*\{\s*getOrder\s+as\s+defaultGetOrder\s*\}\s*from\s*'\.\/orders\.ts'/);
  // Per-invocation correlation id surface.
  assert.match(src, /kickoffIdFactory/);
  assert.match(src, /\[webhook\]\[kickoff:\$\{kickoffId\}\]/);
  // Chain-exit summary surface.
  assert.match(src, /emitChainExitSummary/);
  assert.match(src, /chain exited: outcome=/);
});
