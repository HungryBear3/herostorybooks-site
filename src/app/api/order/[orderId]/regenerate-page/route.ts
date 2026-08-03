import { NextResponse } from 'next/server';

import { customerReviewActor, regeneratePage } from '@/lib/page-review';
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
  const feedback = typeof body?.feedback === 'string' ? body.feedback : '';

  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return NextResponse.json({ error: 'Invalid pageIndex' }, { status: 400 });
  }

  const result = await regeneratePage({
    orderId,
    pageIndex,
    feedback,
    actor: customerReviewActor(auth.reviewToken),
  });
  const status = result.status ?? (result.ok ? 200 : 500);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error ?? 'regenerate_failed', page: result.page ?? null },
      { status },
    );
  }
  return NextResponse.json({ ok: true, page: result.page, warning: result.warning ?? null });
}
