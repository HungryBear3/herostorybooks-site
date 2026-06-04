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
