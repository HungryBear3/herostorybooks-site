/**
 * Deferred fulfillment kickoff for the Stripe webhook.
 *
 * Background: the webhook MUST return 2xx fast (Stripe times out
 * delivery at ~10s) but digital fulfillment runs ~30–60s (story gen +
 * image gen + PDF build + upload). The previous attempt scheduled the
 * kickoff with `next/server after()` only; Rex's 2026-05-08 retest #2
 * showed those callbacks silently dropping in `next start`. That was
 * fixed with a setImmediate+after pair in commit `5b4155d`.
 *
 * Then Rex's 2026-05-08 retest #3 surfaced a subtler bug: the
 * scheduler-fired closure-local `ran=true` was set BEFORE
 * `triggerFulfillment` proved it actually started work. When `after()`
 * fired first and the readback observed `paymentStatus !== 'paid'`
 * (the persist hadn't converged), `triggerFulfillment` refused — but
 * `ran=true` had already been set, so when `setImmediate` fired second
 * it skipped with "already ran". Net result: a paid order's first
 * kickoff refused, the fallback was permanently blocked.
 *
 * This rewrite:
 *
 *   1. **`triggerFulfillment` now returns a `TriggerResult`**
 *      discriminated union: `started | skipped_already_running |
 *      skipped_already_complete | not_paid_yet | not_found`. The
 *      helper uses the result, not "scheduler fired", to decide
 *      whether to allow the fallback to run.
 *
 *   2. **`not_paid_yet` triggers a bounded retry** (default 5 retries
 *      at 200ms / 400ms / 800ms / 1600ms / 3200ms) so a single
 *      readback bounce can't permanently lose the order.
 *
 *   3. **In-flight promise dedupe** keeps the prior process-level
 *      "don't run twice in parallel" invariant: concurrent schedulers
 *      JOIN the same in-flight promise; the second doesn't re-enter
 *      `triggerFulfillment` until the first returns. If the first
 *      returns `not_paid_yet`, the in-flight slot is cleared so a
 *      retry (or the fallback scheduler) can fire.
 *
 *   4. **Observable.** Every transition logs an order-scoped line so
 *      `grep "ord_<id>" server.log` reconstructs the full flow:
 *      schedule, scheduler-fired, joined-existing, started, refused,
 *      retried-N-times, terminal status.
 */

import {
  triggerFulfillment as defaultTriggerFulfillment,
  type TriggerResult,
} from './fulfillment.ts';

export interface ScheduleKickoffDeps {
  /** Override for tests. In production, the real triggerFulfillment. */
  trigger?: (orderId: string) => Promise<TriggerResult>;
  /** Override for tests. Real `setImmediate` in production. */
  setImmediateImpl?: (cb: () => void) => unknown;
  /** Override for tests / serverless. Real `next/server` `after` in production. */
  afterImpl?: ((cb: () => void) => void) | null;
  /** Override for tests. Real console in production. */
  log?: (line: string) => void;
  /** Override for tests. Real console.error in production. */
  errorLog?: (line: string, err?: unknown) => void;
  /** Override for tests. Real `setTimeout` in production. */
  setTimeoutImpl?: (cb: () => void, ms: number) => unknown;
  /**
   * Maximum number of bounded retries when triggerFulfillment returns
   * `not_paid_yet`. Each retry runs after `retryDelayMs(attempt)`. The
   * helper will GIVE UP after this many retries; if the order is real
   * and paid, a later webhook delivery (or admin retry) will pick it
   * up. Default 5.
   */
  notPaidYetMaxRetries?: number;
  /**
   * Backoff schedule. Default: 200, 400, 800, 1600, 3200 ms.
   */
  retryDelayMs?: (attempt: number) => number;
}

const DEFAULT_NOT_PAID_RETRIES = 5;
const defaultRetryDelayMs = (attempt: number) => 200 * 2 ** Math.max(0, attempt);

/**
 * Module-level dedupe. Keys: orderId. Value: the in-flight promise that
 * any concurrent scheduler must JOIN rather than racing past it. The
 * entry is cleared when the result is `not_paid_yet` (so a retry can
 * re-enter), or kept when the result is terminal-for-this-process.
 */
const inFlight = new Map<string, Promise<TriggerResult>>();

export function _resetInFlightForTest() {
  inFlight.clear();
}

async function runOrJoin(
  orderId: string,
  trigger: (orderId: string) => Promise<TriggerResult>,
  log: (line: string) => void,
  errorLog: (line: string, err?: unknown) => void,
  label: string,
): Promise<TriggerResult> {
  // If a kickoff is already in flight for this orderId in this process,
  // join it. The other scheduler picked us up — sharing the promise
  // serializes execution and prevents two parallel runDigitalFulfillment
  // races past the readback gate.
  const existing = inFlight.get(orderId);
  if (existing) {
    log(`[webhook][kickoff][${label}] joining in-flight kickoff for ${orderId}`);
    const result = await existing;
    log(`[webhook][kickoff][${label}] joined result=${result.status} for ${orderId}`);
    return result;
  }

  log(`[webhook][kickoff][${label}] starting triggerFulfillment for ${orderId}`);
  const promise = (async () => {
    try {
      const result = await trigger(orderId);
      return result;
    } catch (err) {
      errorLog(`[webhook][kickoff][${label}] threw for ${orderId}:`, err);
      // Treat unexpected throws as "not paid yet" for the purposes of
      // the helper retry budget — we don't want a transient infra bump
      // to permanently block kickoff. The next retry / next webhook
      // will re-attempt.
      return { status: 'not_paid_yet', attempts: 0 } as const;
    }
  })();

  inFlight.set(orderId, promise);
  try {
    const result = await promise;
    log(`[webhook][kickoff][${label}] result=${result.status} for ${orderId}`);
    // Clear in-flight slot if the result allows a future attempt to
    // re-enter (not_paid_yet). For terminal results, keep the slot —
    // the next call will join the same promise and observe the same
    // outcome (no double runDigitalFulfillment).
    if (result.status === 'not_paid_yet') {
      inFlight.delete(orderId);
    }
    return result;
  } catch (err) {
    inFlight.delete(orderId);
    errorLog(`[webhook][kickoff][${label}] join threw for ${orderId}:`, err);
    return { status: 'not_paid_yet', attempts: 0 };
  }
}

export function scheduleFulfillmentKickoff(
  orderId: string,
  deps: ScheduleKickoffDeps = {},
): void {
  const trigger = deps.trigger ?? defaultTriggerFulfillment;
  const setImmediateFn = deps.setImmediateImpl ?? setImmediate;
  const setTimeoutFn = deps.setTimeoutImpl ?? setTimeout;
  const afterFn = deps.afterImpl;
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog =
    deps.errorLog ?? ((line: string, err?: unknown) => console.error(line, err));
  const maxRetries = deps.notPaidYetMaxRetries ?? DEFAULT_NOT_PAID_RETRIES;
  const retryDelay = deps.retryDelayMs ?? defaultRetryDelayMs;

  log(`[webhook][kickoff] scheduling for ${orderId}`);

  /**
   * Run one kickoff attempt under the given scheduler label. If the
   * result is `not_paid_yet`, schedule a bounded retry chain via
   * setTimeout with exponential backoff. The retry loop uses the SAME
   * in-flight Map so a parallel fallback scheduler will join us
   * instead of racing.
   */
  const attempt = async (label: string, retryCount: number): Promise<void> => {
    const result = await runOrJoin(orderId, trigger, log, errorLog, label);
    if (result.status !== 'not_paid_yet') {
      // Terminal: started, skipped_already_*, not_found.
      return;
    }
    if (retryCount >= maxRetries) {
      errorLog(
        `[webhook][kickoff][${label}] not_paid_yet after ${retryCount} retries — giving up for ${orderId}; next webhook delivery / admin retry will pick this up`,
      );
      return;
    }
    const delay = retryDelay(retryCount);
    log(
      `[webhook][kickoff][${label}] not_paid_yet (readback attempts=${result.attempts}) — retrying in ${delay}ms for ${orderId} (retry ${retryCount + 1}/${maxRetries})`,
    );
    setTimeoutFn(() => {
      void attempt(`${label}-retry${retryCount + 1}`, retryCount + 1);
    }, delay);
  };

  // Local-Node primary. Reliable in `next start`; the HTTP response is
  // already flushed by the time setImmediate callbacks fire.
  setImmediateFn(() => {
    void attempt('setImmediate', 0);
  });

  // Serverless backup. `after()` from next/server keeps the lambda
  // alive on Vercel where setImmediate callbacks may be discarded at
  // lambda freeze. The in-flight Map ensures only one of these
  // actually runs the trigger; the other joins.
  if (typeof afterFn === 'function') {
    try {
      afterFn(() => {
        void attempt('after', 0);
      });
    } catch (err) {
      errorLog(`[webhook][kickoff] after() unavailable for ${orderId}:`, err);
    }
  }
}
