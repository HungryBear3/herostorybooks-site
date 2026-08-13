import { listOrdersAuthoritative } from './orders.ts';
import type { OrderRecord } from './orders.ts';
import { triggerFulfillment, type TriggerResult } from './fulfillment.ts';

export interface FulfillmentSweepEligibilityConfig {
  nowMs: number;
  graceMs: number;
}

export type FulfillmentSweepIneligibleReason =
  | 'not_paid'
  | 'refunded'
  | 'manual_hold'
  | 'internal_disposition'
  | 'missing_paidat'
  | 'invalid_paidat'
  | 'future_paidat'
  | 'below_grace'
  | 'fulfillment_not_startable'
  | 'run_lease_active';

export type FulfillmentSweepEligibility =
  | { eligible: true; ageMs: number }
  | { eligible: false; reason: FulfillmentSweepIneligibleReason };

export interface FulfillmentSweepDeps {
  listOrders: () => Promise<OrderRecord[]>;
  triggerFulfillment: (orderId: string) => Promise<TriggerResult>;
  now: () => number;
  graceMs: number;
  log: (line: string) => void;
  errorLog: (line: string, err?: unknown) => void;
  maxStarts?: number;
}

export interface FulfillmentSweepResult {
  ok: boolean;
  scanned: number;
  eligible: number;
  started: number;
  skipped: number;
  failed: number;
}

export function evaluateFulfillmentSweepEligibility(
  order: OrderRecord,
  cfg: FulfillmentSweepEligibilityConfig,
): FulfillmentSweepEligibility {
  if (order.paymentStatus !== 'paid') return { eligible: false, reason: 'not_paid' };
  if (order.refundedAt || order.stripeRefundId) return { eligible: false, reason: 'refunded' };
  if (order.fulfillmentMode !== 'auto') return { eligible: false, reason: 'manual_hold' };
  if (order.internalDisposition != null) return { eligible: false, reason: 'internal_disposition' };

  const fulfillmentStatus = order.fulfillmentStatus ?? 'not_started';
  const recoverableInProgress = new Set(['generating_story', 'generating_images', 'building_pdf']);
  if (fulfillmentStatus !== 'not_started') {
    if (!recoverableInProgress.has(fulfillmentStatus)) {
      return { eligible: false, reason: 'fulfillment_not_startable' };
    }
    const leaseAtMs = order.fulfillmentKickoffAt ? Date.parse(order.fulfillmentKickoffAt) : Number.NaN;
    if (!order.fulfillmentKickoffId || !Number.isFinite(leaseAtMs)) {
      return { eligible: false, reason: 'fulfillment_not_startable' };
    }
    if (cfg.nowMs - leaseAtMs < 6 * 60 * 1000) {
      return { eligible: false, reason: 'run_lease_active' };
    }
  }

  if (!order.paidAt) return { eligible: false, reason: 'missing_paidat' };
  const paidAtMs = Date.parse(order.paidAt);
  if (!Number.isFinite(paidAtMs)) return { eligible: false, reason: 'invalid_paidat' };
  if (paidAtMs > cfg.nowMs) return { eligible: false, reason: 'future_paidat' };

  const ageMs = cfg.nowMs - paidAtMs;
  if (ageMs < cfg.graceMs) return { eligible: false, reason: 'below_grace' };
  return { eligible: true, ageMs };
}

export function buildDefaultFulfillmentSweepDeps(): FulfillmentSweepDeps {
  return {
    listOrders: listOrdersAuthoritative,
    triggerFulfillment: (orderId: string) => triggerFulfillment(orderId),
    now: () => Date.now(),
    graceMs: 15 * 60 * 1000,
    log: (line: string) => console.log(line),
    errorLog: (line: string, err?: unknown) => console.error(line, err),
    maxStarts: 1,
  };
}

export async function runFulfillmentSweep(
  deps: FulfillmentSweepDeps,
): Promise<FulfillmentSweepResult> {
  const nowMs = deps.now();
  const orders = await deps.listOrders();
  let eligible = 0;
  let started = 0;
  let skipped = 0;
  let failed = 0;

  for (const order of orders) {
    if (started + failed + skipped >= (deps.maxStarts ?? 1)) break;
    const verdict = evaluateFulfillmentSweepEligibility(order, {
      nowMs,
      graceMs: deps.graceMs,
    });
    if (!verdict.eligible) continue;

    eligible += 1;
    try {
      const result = await deps.triggerFulfillment(order.id);
      if (result.status === 'started') {
        started += 1;
        deps.log(`[fulfillment-sweep] started orderId=${order.id}`);
      } else {
        skipped += 1;
        deps.log(`[fulfillment-sweep] skipped orderId=${order.id} status=${result.status}`);
      }
    } catch (err) {
      failed += 1;
      deps.errorLog(`[fulfillment-sweep] failed orderId=${order.id}`, err);
    }
  }

  return {
    ok: failed === 0,
    scanned: orders.length,
    eligible,
    started,
    skipped,
    failed,
  };
}
