import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { getOrder } from '@/lib/orders';
import { buildOrderDiagnostics, formatDiagnosticsSummary } from '@/lib/order-diagnostics';

export const dynamic = 'force-dynamic';

// Admin/support diagnostics endpoint.
//
// GET /api/admin/orders/<id>/diagnostics
//   → JSON OrderDiagnostics structure (machine-readable, safe to paste into a ticket)
// GET /api/admin/orders/<id>/diagnostics?format=text
//   → text/plain escalation block (one paste-friendly summary)
export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { orderId } = await context.params;
  const order = await getOrder(orderId);
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

  const diagnostics = buildOrderDiagnostics(order);

  const url = new URL(request.url);
  if (url.searchParams.get('format') === 'text') {
    return new NextResponse(formatDiagnosticsSummary(diagnostics), {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  return NextResponse.json({ diagnostics });
}
