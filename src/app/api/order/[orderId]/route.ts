import { NextResponse } from 'next/server';

import { isOrderStatus, getOrder, updateOrderStatus } from '@/lib/orders';
import { sendLifecycleEmail } from '@/lib/order-email';

function getAdminKey() {
  return process.env.HSB_ORDER_ADMIN_KEY;
}

function isAuthorized(request: Request) {
  const adminKey = getAdminKey();
  if (!adminKey) {
    return false;
  }

  return request.headers.get('x-hsb-order-admin-key') === adminKey;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const order = await getOrder(orderId);

  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  return NextResponse.json({
    order: {
      id: order.id,
      childName: order.childName,
      bookFormat: order.bookFormat,
      formatLabel: order.formatLabel,
      status: order.status,
      deliveryExpectation: order.deliveryExpectation,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    },
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!getAdminKey()) {
    return NextResponse.json({ error: 'Order admin key is not configured' }, { status: 503 });
  }

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  if (!body?.status || !isOrderStatus(body.status)) {
    return NextResponse.json({ error: 'Invalid order status' }, { status: 400 });
  }

  const { orderId } = await context.params;
  const order = await updateOrderStatus(orderId, body.status);
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  // Send lifecycle email for the new status. Email failure does not fail the request.
  let emailResult: { skipped: boolean; reason?: string; id?: string | null } = {
    skipped: true,
    reason: 'not_attempted',
  };
  try {
    emailResult = await sendLifecycleEmail(order, {
      trackingNumber: typeof body.trackingNumber === 'string' ? body.trackingNumber : undefined,
      trackingUrl: typeof body.trackingUrl === 'string' ? body.trackingUrl : undefined,
    });
  } catch {
    emailResult = { skipped: true, reason: 'email_send_error' };
  }

  return NextResponse.json({ ok: true, order, email: emailResult });
}
