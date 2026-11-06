/**
 * Admin read of the private print contact. Kept apart from the order detail
 * route so the pinned order DTO never gains a contact field.
 */
import { NextResponse } from 'next/server.js';

import { isAdminAuthedFromRequest } from '../../../../../../lib/admin-auth.ts';
import { getOrder } from '../../../../../../lib/orders.ts';
import { loadAdminPrintContacts } from '../../../../../../lib/print-contact-store.ts';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0' };

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE_HEADERS });
  }
  const { orderId } = await context.params;
  const order = await getOrder(orderId);
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404, headers: NO_STORE_HEADERS });
  return NextResponse.json({ contacts: await loadAdminPrintContacts(order) }, { headers: NO_STORE_HEADERS });
}
