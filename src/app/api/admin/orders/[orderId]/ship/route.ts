import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { markOrderShipped } from '@/lib/admin-actions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orderId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const result = await markOrderShipped(orderId, {
    trackingNumber: typeof body.trackingNumber === 'string' ? body.trackingNumber : undefined,
    trackingUrl: typeof body.trackingUrl === 'string' ? body.trackingUrl : undefined,
  });

  if (result.ok === true) return NextResponse.json({ ok: true });
  return NextResponse.json({ error: result.error }, { status: result.status });
}
