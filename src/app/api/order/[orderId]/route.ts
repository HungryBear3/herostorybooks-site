import { NextResponse } from 'next/server';

import { getOrder } from '@/lib/orders';

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

  void context;
  // Retired: generic status mutation bypassed payment/refund, print-release,
  // shipping, provider-identity, and lifecycle-email gates. Operators must use
  // the dedicated guarded admin actions/routes for each transition.
  return NextResponse.json(
    { error: 'Generic order status mutation is retired; use a guarded admin action' },
    { status: 410 },
  );
}
