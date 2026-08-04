import { NextResponse } from 'next/server';

import { acknowledgeProofReview, customerReviewActor } from '@/lib/page-review';
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
  const proofVersion = typeof body?.proofVersion === 'string' ? body.proofVersion : '';
  if (!proofVersion) {
    // The acknowledgment must name the exact revision reviewed; without it we
    // cannot bind the ack to an artifact, so fail closed.
    return NextResponse.json({ ok: false, error: 'proof_version_required' }, { status: 400 });
  }

  const result = await acknowledgeProofReview(orderId, {
    proofVersion,
    actor: customerReviewActor(auth.reviewToken),
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    proofReviewedAt: result.proofReviewedAt,
    proofReviewedVersion: result.proofReviewedVersion,
  });
}
