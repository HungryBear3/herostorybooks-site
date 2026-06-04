import { NextResponse } from 'next/server';

import { listOrders } from '@/lib/orders';
import { triggerFulfillment } from '@/lib/fulfillment';
import { isFulfillmentSweepAuthorized, runFulfillmentSweep } from '@/lib/fulfillment-backlog';

export const dynamic = 'force-dynamic';
// Durable kickoff lifecycle: unlike the webhook's post-response scheduling,
// a cron invocation runs as a first-class request, so Vercel keeps the lambda
// alive for the full maxDuration while fulfillment (story + image generation)
// completes and persists.
export const maxDuration = 300;

/**
 * Orders intentionally held OUT of the auto-sweep. ord_d4b46e9123c147ac is the
 * preserved G5 repro artifact (paid + not_started) — it must NOT be auto-retried
 * until a human explicitly approves the controlled retry. Remove its id here
 * only after that approval.
 */
const SWEEP_EXCLUDE = new Set<string>(['ord_d4b46e9123c147ac']);

/**
 * Durable backstop for dropped paid->fulfillment kickoffs. Auth is fail-closed
 * (requires `Bearer CRON_SECRET` or a valid admin key — the spoofable
 * `x-vercel-cron` header / `vercel-cron` user-agent are NOT trusted) and is
 * checked before any order work. Read-only except for invoking the idempotent
 * triggerFulfillment on paid+not_started orders. It never releases proof/delivery
 * email (fulfillment holds at awaiting_qa) and never submits print (print
 * requires a separate owner-go).
 */
export async function GET(request: Request) {
  const out = await runFulfillmentSweep({
    authorized: isFulfillmentSweepAuthorized(request),
    listOrders,
    trigger: (orderId) => triggerFulfillment(orderId),
    excludeOrderIds: SWEEP_EXCLUDE,
    limit: 3,
  });
  return NextResponse.json(out.body, { status: out.status });
}
