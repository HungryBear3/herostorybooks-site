/**
 * Scheduled recovery for paid orders whose confirmation email never went out.
 *
 * The post-webhook path is best-effort by construction: it runs after the 200
 * on `setImmediate` and `after()`, both of which die with the serverless
 * invocation. This sweep is the durable backstop — authoritative enumeration,
 * exact eligibility, and the shared claim protocol in
 * `confirmation-email-delivery.ts`, so overlapping with a live webhook send
 * converges rather than duplicating.
 *
 * It touches nothing but the confirmation fields; fulfillment, proof, print and
 * refund state are none of its business.
 */
import {
  CONFIRMATION_EMAIL_AWAITING_FROZEN_DISPATCH,
  CONFIRMATION_EMAIL_CLAIM_STALE_MS,
  classifyConfirmationEmailError,
  deliverOrderConfirmationEmail,
  evaluateConfirmationEmailClaimability,
  type ConfirmationEmailBlockReason,
  type ConfirmationEmailDeliveryOutcome,
} from './confirmation-email-delivery.ts';
import { listOrdersAuthoritative, type OrderRecord } from './orders.ts';

/** How long after payment the sweep starts caring. The in-process path has the
 *  first attempt; this window keeps the sweep out of its way. */
export const CONFIRMATION_EMAIL_SWEEP_GRACE_MS = 15 * 60 * 1000;

/**
 * Activation floor: the instant this recovery path came into existence, which
 * is the boundary of the incident it was built for. An order paid before this
 * is out of scope permanently — it belongs to the operator, and no scheduled
 * job may decide on its own to email a historical buyer.
 *
 * Deliberately a FIXED instant rather than a moving max-age. A rolling window
 * would quietly stop covering a future incident once the affected orders aged
 * past it, which is the failure mode this whole sweep exists to prevent.
 */
export const CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT = '2026-09-21T12:48:51.665Z';
export const CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS = Date.parse(
  CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT,
);

/** Per-invocation work bound, so one tick cannot fan out unboundedly. */
export const CONFIRMATION_EMAIL_SWEEP_MAX_DELIVERIES = 10;

export type ConfirmationEmailSweepIneligibleReason =
  | ConfirmationEmailBlockReason
  | 'missing_paidat'
  | 'invalid_paidat'
  | 'future_paidat'
  | 'before_activation'
  | 'below_grace';

export type ConfirmationEmailSweepEligibility =
  | { eligible: true; ageMs: number }
  | { eligible: false; reason: ConfirmationEmailSweepIneligibleReason };

export interface ConfirmationEmailSweepEligibilityConfig {
  nowMs: number;
  graceMs: number;
  claimStaleMs: number;
  /** Fixed floor on `paidAt`; see CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT. */
  activationPaidAtMs: number;
  /** A3-5: admit records waiting for the frozen dispatcher. Absent or not
   *  exactly `true`: they stay ineligible, as before. */
  admitAwaitingFrozenDispatch?: boolean;
}

export interface ConfirmationEmailSweepDeps {
  listOrders: () => Promise<OrderRecord[]>;
  deliver: (orderId: string) => Promise<ConfirmationEmailDeliveryOutcome>;
  now: () => number;
  graceMs: number;
  claimStaleMs: number;
  activationPaidAtMs: number;
  log: (line: string) => void;
  /** Pre-sanitized lines only — see `classifyConfirmationEmailError`. */
  errorLog: (line: string) => void;
  maxDeliveries?: number;
  /** A3-5: see `ConfirmationEmailSweepEligibilityConfig`. The default deps
   *  leave it out. */
  admitAwaitingFrozenDispatch?: boolean;
}

export interface ConfirmationEmailSweepResult {
  ok: boolean;
  scanned: number;
  eligible: number;
  sent: number;
  skipped: number;
  blocked: number;
  failed: number;
  /** A3-4 R2: envelopes frozen and committed; nothing was sent. */
  snapshotted: number;
  /** A3-4 R2: records moved to a reconciliation hold; nothing was sent. */
  held: number;
  /** A3-4 R2: attempts that changed nothing and sent nothing; the next tick retries. */
  deferred: number;
}

/**
 * Fail-closed: an order is swept only when it is paid, unrefunded, carries no
 * confirmation receipt, is not under a live claim, and was paid long enough ago
 * that the in-process attempt has had its chance.
 */
export function evaluateConfirmationEmailSweepEligibility(
  order: OrderRecord,
  cfg: ConfirmationEmailSweepEligibilityConfig,
): ConfirmationEmailSweepEligibility {
  const blocked = evaluateConfirmationEmailClaimability(order, {
    nowMs: cfg.nowMs,
    claimStaleMs: cfg.claimStaleMs,
  });
  // A3-5: an opted-in sweep admits a frozen record past the shared fence, and
  // only that one reason; the paidAt rules below still apply to it.
  const admitted = blocked === CONFIRMATION_EMAIL_AWAITING_FROZEN_DISPATCH && cfg.admitAwaitingFrozenDispatch === true;
  if (blocked && !admitted) return { eligible: false, reason: blocked };

  if (!order.paidAt) return { eligible: false, reason: 'missing_paidat' };
  const paidAtMs = Date.parse(order.paidAt);
  if (!Number.isFinite(paidAtMs)) return { eligible: false, reason: 'invalid_paidat' };
  if (paidAtMs > cfg.nowMs) return { eligible: false, reason: 'future_paidat' };
  // Historical orders are never in scope, however long they have sat.
  if (paidAtMs < cfg.activationPaidAtMs) return { eligible: false, reason: 'before_activation' };

  const ageMs = cfg.nowMs - paidAtMs;
  if (ageMs < cfg.graceMs) return { eligible: false, reason: 'below_grace' };
  return { eligible: true, ageMs };
}

export function buildDefaultConfirmationEmailSweepDeps(): ConfirmationEmailSweepDeps {
  return {
    listOrders: () => listOrdersAuthoritative(),
    deliver: (orderId: string) => deliverOrderConfirmationEmail(orderId),
    now: () => Date.now(),
    graceMs: CONFIRMATION_EMAIL_SWEEP_GRACE_MS,
    claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS,
    log: (line: string) => console.log(line),
    errorLog: (line: string) => console.error(line),
    maxDeliveries: CONFIRMATION_EMAIL_SWEEP_MAX_DELIVERIES,
  };
}

export async function runConfirmationEmailSweep(
  deps: ConfirmationEmailSweepDeps,
): Promise<ConfirmationEmailSweepResult> {
  const nowMs = deps.now();
  const orders = await deps.listOrders();
  const maxDeliveries = deps.maxDeliveries ?? CONFIRMATION_EMAIL_SWEEP_MAX_DELIVERIES;

  let eligible = 0;
  let sent = 0;
  let skipped = 0;
  let blocked = 0;
  let failed = 0;
  let snapshotted = 0;
  let held = 0;
  let deferred = 0;

  for (const order of orders) {
    if (eligible >= maxDeliveries) break;
    const verdict = evaluateConfirmationEmailSweepEligibility(order, {
      nowMs,
      graceMs: deps.graceMs,
      claimStaleMs: deps.claimStaleMs,
      activationPaidAtMs: deps.activationPaidAtMs,
      admitAwaitingFrozenDispatch: deps.admitAwaitingFrozenDispatch,
    });
    if (!verdict.eligible) continue;

    eligible += 1;
    try {
      const outcome = await deps.deliver(order.id);
      // A3-4 R2: exhaustive — every arm ends the iteration, and the never
      // check below fails `tsc` the moment an outcome has no arm.
      switch (outcome.status) {
        case 'sent':
          sent += 1;
          deps.log(`[confirmation-email-sweep] sent orderId=${order.id}`);
          continue;
        case 'skipped':
          skipped += 1;
          deps.log(`[confirmation-email-sweep] skipped orderId=${order.id} reason=${outcome.reason}`);
          continue;
        case 'blocked':
          // Lost the race with a concurrent sender — the expected, benign
          // outcome of webhook/sweep overlap.
          blocked += 1;
          deps.log(`[confirmation-email-sweep] blocked orderId=${order.id} reason=${outcome.reason}`);
          continue;
        case 'receipt_unrecorded':
          // The provider accepted but nothing durable records it. That is a
          // failure, not a delivery: it must be visible and it must not be
          // counted as sent.
          failed += 1;
          deps.errorLog(
            `[confirmation-email-sweep] receipt unrecorded orderId=${order.id} reason=${outcome.reason}`,
          );
          continue;
        case 'failed':
          failed += 1;
          deps.errorLog(
            `[confirmation-email-sweep] delivery failed orderId=${order.id}`
              + ` reason=${outcome.reason} errorClass=${outcome.errorClass}`,
          );
          continue;
        case 'snapshotted':
          // Frozen, not sent: neither a delivery nor a failure.
          snapshotted += 1;
          deps.log(`[confirmation-email-sweep] snapshotted orderId=${order.id} via=${outcome.via}`);
          continue;
        case 'held':
          // A hold is the designed, durable outcome; it does not fail the run.
          held += 1;
          deps.errorLog(`[confirmation-email-sweep] held orderId=${order.id} reason=${outcome.reason}`);
          continue;
        case 'snapshot_deferred':
          // Nothing changed and nothing was sent; the run is not ok so the
          // deferral stays visible, and the next tick retries.
          deferred += 1;
          deps.errorLog(`[confirmation-email-sweep] deferred orderId=${order.id} reason=${outcome.reason}`);
          continue;
      }
      const _exhaustive: never = outcome;
      void _exhaustive;
    } catch (err) {
      failed += 1;
      deps.errorLog(
        `[confirmation-email-sweep] delivery threw orderId=${order.id}`
          + ` errorClass=${classifyConfirmationEmailError(err)}`,
      );
    }
  }

  return {
    ok: failed === 0 && deferred === 0,
    scanned: orders.length,
    eligible,
    sent,
    skipped,
    blocked,
    failed,
    snapshotted,
    held,
    deferred,
  };
}
