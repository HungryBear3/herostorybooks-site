import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { classifyPaidOrderOpsIssue } from '@/lib/order-diagnostics';
import { buildStuckOrderReport } from '@/lib/order-watchdog';
import { listOrders } from '@/lib/orders';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let orders = await listOrders();
  const url = new URL(request.url);
  const opsIssue = url.searchParams.get('opsIssue');

  if (opsIssue === 'paid_artifact') {
    orders = orders.filter((order) => {
      const issue = classifyPaidOrderOpsIssue(order);
      return Boolean(issue && issue.severity !== 'info');
    });
  } else if (opsIssue === 'stuck') {
    // Broad watchdog sweep: paid orders stuck anywhere on the way to delivery
    // (pre-artifact, delivery-email-failed, proof stale, print follow-up gaps).
    const report = buildStuckOrderReport(orders);
    const stuckIds = new Set(report.findings.map((f) => f.orderId));
    orders = orders
      .filter((order) => stuckIds.has(order.id))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return NextResponse.json({ orders, watchdog: report });
  }

  // Newest first
  orders.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return NextResponse.json({ orders });
}
