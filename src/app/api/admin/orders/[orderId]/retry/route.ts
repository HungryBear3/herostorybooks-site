import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { retryOrderFulfillment } from '@/lib/admin-actions';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orderId } = await context.params;
  const result = await retryOrderFulfillment(orderId);
  if (result.ok === true) {
    return NextResponse.json({ ok: true });
  } else {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
}
