import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { buildFulfillmentOpsDigest } from '@/lib/fulfillment-backlog';
import { classifyPaidOrderOpsIssue } from '@/lib/order-diagnostics';
import { listOrders } from '@/lib/orders';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let orders = await listOrders();
  const opsDigest = buildFulfillmentOpsDigest(orders);
  const url = new URL(request.url);
  if (url.searchParams.get('opsIssue') === 'paid_artifact') {
    orders = orders.filter((order) => {
      const issue = classifyPaidOrderOpsIssue(order);
      return Boolean(issue && issue.severity !== 'info');
    });
  }
  // Newest first
  orders.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return NextResponse.json({ orders, opsDigest });
}
