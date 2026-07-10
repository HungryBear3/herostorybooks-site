// Durable fulfillment backlog selector (pure).
//
// Root cause it addresses: the Stripe webhook marks an order paid and then
// kicks off fulfillment via post-response scheduling (setImmediate + next/server
// after()). On Vercel serverless that background work is not durable — the
// lambda can freeze after the HTTP response, killing triggerFulfillment after it
// logs "starting … run" but BEFORE its first persisted write. The order is left
// paid + fulfillmentStatus='not_started', attempts=0, no lastError (exactly the
// ord_d4b46e9123c147ac repro).
//
// This selector lets a durable Vercel Cron sweep find those dropped orders and
// re-run fulfillment in a context with a long maxDuration. It is intentionally
// conservative: it only picks orders that NEVER STARTED. It does NOT touch
// in-progress runs, failed_manual_review (a human decision — re-running could
// re-burn provider cost), refunded orders, or already-complete/awaiting_qa
// orders. triggerFulfillment is itself idempotent, so an overlap with a healthy
// in-request kickoff is a safe no-op.

import type { OrderRecord } from './orders.ts';
import type { TriggerResult } from './fulfillment.ts';
import { isAdminAuthedFromRequest } from './admin-auth.ts';

/**
 * fulfillmentStatus values eligible for a durable (re)kickoff. Unset is treated
 * as 'not_started'. Everything else (in-progress, awaiting_qa, complete,
 * delivery_email_failed, failed_manual_review, print states) is excluded.
 */
const ELIGIBLE_STATUSES = new Set<string>(['not_started']);

export interface BacklogOptions {
  now?: Date;
  /** Grace period so a healthy in-request kickoff gets first crack. Default 90s. */
  minAgeMs?: number;
  /** Ignore ancient orders that need human attention. Default 7 days. */
  maxAgeMs?: number;
  /** Orders held out of auto-sweep (e.g. a preserved repro artifact). */
  excludeOrderIds?: ReadonlySet<string>;
  /** Max orders to return per sweep tick (bounds per-invocation work). Default 3. */
  limit?: number;
}

export function findFulfillmentBacklog(
  orders: readonly OrderRecord[],
  opts: BacklogOptions = {},
): OrderRecord[] {
  const now = (opts.now ?? new Date()).getTime();
  const minAgeMs = opts.minAgeMs ?? 90_000;
  const maxAgeMs = opts.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const exclude = opts.excludeOrderIds ?? new Set<string>();
  const limit = opts.limit ?? 3;

  const eligible = orders.filter((o) => {
    if (o.paymentStatus !== 'paid') return false;
    if (o.refundedAt) return false;
    if (exclude.has(o.id)) return false;
    const fs = o.fulfillmentStatus ?? 'not_started';
    if (!ELIGIBLE_STATUSES.has(fs)) return false;
    const ts = Date.parse(o.updatedAt || o.createdAt || '');
    if (!Number.isFinite(ts)) return false;
    const age = now - ts;
    if (age < minAgeMs) return false; // too fresh — let the in-request kickoff try first
    if (age > maxAgeMs) return false; // too old — escalate to a human, don't auto-run
    return true;
  });

  // FIFO: oldest paid-but-stuck order first.
  eligible.sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
  return eligible.slice(0, limit);
}

export interface FulfillmentOpsDigest {
  paidStuck: number;
  failedManualReview: number;
  deliveryEmailFailed: number;
  orderIds: {
    paidStuck: string[];
    failedManualReview: string[];
    deliveryEmailFailed: string[];
  };
}

export function buildFulfillmentOpsDigest(
  orders: readonly OrderRecord[],
  opts: BacklogOptions = {},
): FulfillmentOpsDigest {
  const paidStuckOrders = findFulfillmentBacklog(orders, opts);
  const failedManualReview = orders.filter((o) => o.paymentStatus === 'paid' && o.fulfillmentStatus === 'failed_manual_review');
  const deliveryEmailFailed = orders.filter((o) => o.paymentStatus === 'paid' && o.fulfillmentStatus === 'delivery_email_failed');
  return {
    paidStuck: paidStuckOrders.length,
    failedManualReview: failedManualReview.length,
    deliveryEmailFailed: deliveryEmailFailed.length,
    orderIds: {
      paidStuck: paidStuckOrders.map((o) => o.id),
      failedManualReview: failedManualReview.map((o) => o.id),
      deliveryEmailFailed: deliveryEmailFailed.map((o) => o.id),
    },
  };
}

/**
 * Fail-closed cron auth for the fulfillment sweep.
 *
 * Hardening over the original sweep check: the spoofable `x-vercel-cron` header
 * and `vercel-cron` user-agent are NO LONGER trusted on their own (any client
 * can forge them). Authorization now requires one of:
 *   - `Authorization: Bearer <CRON_SECRET>` — and `CRON_SECRET` must actually be
 *     configured (the header Vercel Cron sends when CRON_SECRET is set), or
 *   - a valid operator admin key (`isAdminAuthedFromRequest`) for manual runs.
 * If `CRON_SECRET` is unset, the cron path cannot authenticate at all — the
 * sweep fails closed (401) rather than running on a forged request.
 */
export function isFulfillmentSweepAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret && secret.length > 0) {
    if ((request.headers.get('authorization') ?? '') === `Bearer ${secret}`) return true;
  }
  return isAdminAuthedFromRequest(request);
}

export interface SweepDeps {
  /** Result of cron auth. The sweep does NO work when false. */
  authorized: boolean;
  listOrders: () => Promise<OrderRecord[]>;
  trigger: (orderId: string) => Promise<TriggerResult>;
  excludeOrderIds?: ReadonlySet<string>;
  limit?: number;
  now?: Date;
  log?: (line: string) => void;
}

export interface SweepResult {
  status: number;
  body: {
    error?: string;
    swept?: number;
    results?: Array<{ orderId: string; status: string }>;
    opsDigest?: FulfillmentOpsDigest;
  };
}

/**
 * Run the durable fulfillment sweep. Auth is checked BEFORE any work: an
 * unauthorized call never lists orders or triggers fulfillment. Otherwise it
 * selects the bounded FIFO backlog and re-runs the idempotent triggerFulfillment.
 */
export async function runFulfillmentSweep(deps: SweepDeps): Promise<SweepResult> {
  const log = deps.log ?? ((line: string) => console.log(line));

  if (!deps.authorized) {
    log('[cron][fulfillment-sweep] unauthorized — refused before any work');
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  const orders = await deps.listOrders();
  const opsDigest = buildFulfillmentOpsDigest(orders, {
    excludeOrderIds: deps.excludeOrderIds,
    limit: deps.limit,
    now: deps.now,
  });
  const backlog = findFulfillmentBacklog(orders, {
    excludeOrderIds: deps.excludeOrderIds,
    limit: deps.limit,
    now: deps.now,
  });

  const results: Array<{ orderId: string; status: string }> = [];
  for (const order of backlog) {
    try {
      const r = await deps.trigger(order.id);
      results.push({ orderId: order.id, status: r.status });
      log(`[cron][fulfillment-sweep] ${order.id} -> ${r.status}`);
    } catch (err) {
      results.push({ orderId: order.id, status: 'error' });
      log(`[cron][fulfillment-sweep] ${order.id} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { status: 200, body: { swept: backlog.length, results, opsDigest } };
}
