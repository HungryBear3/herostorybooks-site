import { NextResponse } from 'next/server';

import { acceptPage } from '@/lib/page-review';
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

  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return NextResponse.json({ error: 'Invalid pageIndex' }, { status: 400 });
  }

  const result = await acceptPage({ orderId, pageIndex });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, page: result.page });
}
