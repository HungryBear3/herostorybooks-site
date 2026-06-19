import { NextResponse } from 'next/server';

import { acceptPage, getReviewSnapshot, requestPageChanges } from '@/lib/page-review';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const token = new URL(request.url).searchParams.get('token');
  const snapshot = await getReviewSnapshot(orderId, { reviewToken: token });
  if (!snapshot) {
    return NextResponse.json({ error: 'Review not ready' }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const body = await request.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : '';
  const pageIndex = Number(body?.pageIndex);

  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return NextResponse.json({ ok: false, error: 'Invalid pageIndex' }, { status: 400 });
  }

  if (action === 'approve_page') {
    const result = await acceptPage({ orderId, pageIndex });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, page: result.page });
  }

  if (action === 'request_changes') {
    const note = typeof body?.note === 'string' ? body.note : '';
    const result = await requestPageChanges({ orderId, pageIndex, note });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, page: result.page });
  }

  return NextResponse.json({ ok: false, error: 'Unsupported review action' }, { status: 400 });
}
