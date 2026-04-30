import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { refundOrder } from '@/lib/admin-actions';

export const dynamic = 'force-dynamic';

/**
 * Admin-only pre-print refund. Mirrors the auth pattern of
 * /manual-approve. Body may carry a `{ reason: string }` field; if
 * absent we default to 'customer_request' (server-side trimmed).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { orderId } = await context.params;

  let body: { reason?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — refundOrder defaults the reason.
  }
  const reason = typeof body.reason === 'string' ? body.reason : 'customer_request';

  const result = await refundOrder(orderId, reason);
  if (result.ok === true) {
    return NextResponse.json({ ok: true, detail: result.detail ?? null });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
