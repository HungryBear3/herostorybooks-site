/**
 * Admin order detail.
 *
 * Relative `.ts` imports and `next/server.js`, for the reason given in
 * `src/app/api/admin/orders/route.ts`: it is what lets a `node:test` suite call
 * this handler and assert on the bytes it actually returns.
 */
import { NextResponse } from 'next/server.js';

import { isAdminAuthedFromRequest } from '../../../../../lib/admin-auth.ts';
import { toAdminOrderDetail } from '../../../../../lib/admin-order-dto.ts';
import { getOrder } from '../../../../../lib/orders.ts';

export const dynamic = 'force-dynamic';

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
  // The projection, never the record — see src/lib/admin-order-dto.ts.
  return NextResponse.json({ order: toAdminOrderDetail(order) });
}
