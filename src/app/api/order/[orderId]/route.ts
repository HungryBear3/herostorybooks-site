import { NextResponse } from 'next/server';

import { getConfiguredAdminKey, isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { getOrder } from '@/lib/orders';

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!getConfiguredAdminKey()) {
    return NextResponse.json({ error: 'Order admin key is not configured' }, { status: 503 });
  }

  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
  if (!getConfiguredAdminKey()) {
    return NextResponse.json({ error: 'Order admin key is not configured' }, { status: 503 });
  }

  if (!isAdminAuthedFromRequest(request)) {
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
