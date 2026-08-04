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
    return NextResponse.json({ ok: false, error: 'invalid_page_index' }, { status: 400 });
  }

  const result = await regeneratePage({
    orderId,
    pageIndex,
    feedback,
    actor: customerReviewActor(auth.reviewToken),
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error ?? 'regenerate_failed', page: result.page ?? null },
      { status: result.status ?? 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    page: result.page,
    warning: result.warning ?? null,
    // The client must re-fetch the snapshot for the new proof revision; a
    // failed refresh means no proof is currently available for acknowledgment.
    proofRefreshed: result.proofRefreshed ?? false,
    proofRefreshError: result.proofRefreshError ?? null,
  });
}
