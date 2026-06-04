import { NextResponse } from 'next/server';

import { listOrders } from '@/lib/orders';
import { triggerFulfillment } from '@/lib/fulfillment';
import { findFulfillmentBacklog } from '@/lib/fulfillment-backlog';
import { isAdminAuthedFromRequest } from '@/lib/admin-auth';

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

/** Vercel Cron invocations carry the `x-vercel-cron` header. Operators may also
 *  invoke manually with the admin key. No secrets are read or printed. */
function isAuthorized(request: Request): boolean {
  if (request.headers.get('x-vercel-cron') != null) return true;
  if ((request.headers.get('user-agent') ?? '').includes('vercel-cron')) return true;
  return isAdminAuthedFromRequest(request);
}

/**
 * Durable backstop for dropped paid->fulfillment kickoffs. Read-only except for
 * invoking the idempotent triggerFulfillment on paid+not_started orders. It
 * never releases proof/delivery email (fulfillment holds at awaiting_qa) and
 * never submits print (print requires a separate owner-go).
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const orders = await listOrders();
  const backlog = findFulfillmentBacklog(orders, { excludeOrderIds: SWEEP_EXCLUDE, limit: 3 });

  const results: Array<{ orderId: string; status: string }> = [];
  for (const order of backlog) {
    try {
      const r = await triggerFulfillment(order.id);
      results.push({ orderId: order.id, status: r.status });
      console.log(`[cron][fulfillment-sweep] ${order.id} -> ${r.status}`);
    } catch (err) {
      results.push({ orderId: order.id, status: 'error' });
      console.error(`[cron][fulfillment-sweep] ${order.id} threw:`, err);
    }
  }

  return NextResponse.json({ swept: backlog.length, results });
}
