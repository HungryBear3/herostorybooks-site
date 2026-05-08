/**
 * Deferred fulfillment kickoff for the Stripe webhook.
 *
 * The webhook MUST return 2xx fast (Stripe times out delivery at ~10s),
 * but digital fulfillment runs ~30–60s (story gen + image gen + PDF
 * build + upload). The previous attempt used Next.js `after()` from
 * `next/server`. Rex's 2026-05-08 retest #2 showed `after()` callbacks
 * never observably firing in local `next start` — paid orders stayed
 * `fulfillmentStatus=not_started`, `attempts=0`, no log evidence the
 * kickoff ever ran.
 *
 * This helper is the durable-and-observable replacement:
 *
 *   - **`setImmediate`** schedules the kickoff for the next event-loop
 *     iteration. The HTTP response has already been flushed by then in
 *     `next start` (long-running Node process). This is the reliable
 *     local path.
 *
 *   - **`after()`** from `next/server` is also called as a Vercel
 *     serverless fallback — on a lambda, `setImmediate` callbacks may
 *     be killed at lambda freeze/teardown, while `after()` is the
 *     supported primitive there.
 *
 *   - **Per-process dedupe.** Both schedulers race; whichever fires
 *     first wins. A closure-local `ran` flag prevents the second
 *     from also calling `triggerFulfillment` (which would race with
 *     the first call past the `fulfillmentStatus !== 'not_started'`
 *     gate). A module-level `Set<string>` prevents two concurrent
 *     webhook deliveries from each scheduling a redundant pair.
 *
 *   - **Observable.** Every transition logs a structured line so a
 *     future "paid but never started" symptom has a definitive
 *     audit trail to diagnose against. If a future regression occurs,
 *     `grep [webhook][kickoff]` over `wolf.log`/server stdout shows
 *     exactly which scheduler fired and what triggerFulfillment did.
 *
 * Tests inject a fake `triggerFulfillment` to verify dedupe + logging
 * without running real generation. See tests/fulfillment-kickoff.test.ts.
 */

import { triggerFulfillment as defaultTriggerFulfillment } from './fulfillment.ts';

export interface ScheduleKickoffDeps {
  /** Override for tests. In production, the real triggerFulfillment. */
  trigger?: (orderId: string) => Promise<void>;
  /** Override for tests. Real `setImmediate` in production. */
  setImmediateImpl?: (cb: () => void) => unknown;
  /** Override for tests / serverless. Real `next/server` `after` in production. */
  afterImpl?: ((cb: () => void) => void) | null;
  /** Override for tests. Real console in production. */
  log?: (line: string) => void;
  /** Override for tests. Real console.error in production. */
  errorLog?: (line: string, err?: unknown) => void;
}

const scheduledOrderIds = new Set<string>();

export function _resetScheduledKickoffsForTest() {
  scheduledOrderIds.clear();
}

export function scheduleFulfillmentKickoff(
  orderId: string,
  deps: ScheduleKickoffDeps = {},
): void {
  const trigger = deps.trigger ?? defaultTriggerFulfillment;
  const setImmediateFn = deps.setImmediateImpl ?? setImmediate;
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog =
    deps.errorLog ?? ((line: string, err?: unknown) => console.error(line, err));

  if (scheduledOrderIds.has(orderId)) {
    log(`[webhook][kickoff] already scheduled for ${orderId} this process — skipping duplicate`);
    return;
  }
  scheduledOrderIds.add(orderId);

  log(`[webhook][kickoff] scheduling for ${orderId}`);

  // Closure-local guard — whichever scheduler fires first wins.
  let ran = false;

  const guarded = async (label: string): Promise<void> => {
    if (ran) {
      log(`[webhook][kickoff][${label}] already ran for ${orderId} — skip`);
      return;
    }
    ran = true;
    log(`[webhook][kickoff][${label}] starting triggerFulfillment for ${orderId}`);
    try {
      await trigger(orderId);
      log(`[webhook][kickoff][${label}] completed triggerFulfillment for ${orderId}`);
    } catch (err) {
      errorLog(`[webhook][kickoff][${label}] threw for ${orderId}:`, err);
    }
  };

  // Local-Node primary. Reliable in `next start`; the HTTP response is
  // already flushed by the time setImmediate callbacks fire.
  setImmediateFn(() => {
    void guarded('setImmediate');
  });

  // Serverless backup. `after()` from next/server keeps the lambda
  // alive on Vercel where setImmediate callbacks may be discarded at
  // lambda freeze. If it's null/undefined (e.g., outside a request
  // context, or a Next.js version that doesn't expose it), we silently
  // skip — setImmediate above is the load-bearing path locally.
  const afterFn = deps.afterImpl;
  if (typeof afterFn === 'function') {
    try {
      afterFn(() => {
        void guarded('after');
      });
    } catch (err) {
      errorLog(`[webhook][kickoff] after() unavailable for ${orderId}:`, err);
    }
  }
}
