import { NextResponse } from 'next/server';

import { saveTextChangeRequest } from '@/lib/page-review';
import { authorizeCustomerReviewWrite } from '@/lib/review-route-auth';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const auth = await authorizeCustomerReviewWrite(request, orderId);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const body = await request.json().catch(() => ({}));
  const pageIndex = Number(body?.pageIndex);
  const note = typeof body?.note === 'string' ? body.note : '';

  // Forward the presented token so the service revalidates it against the order
  // as read inside its guarded transaction.
  const result = await saveTextChangeRequest({
    orderId,
    pageIndex,
    note,
    reviewToken: auth.reviewToken,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, page: result.page });
}
