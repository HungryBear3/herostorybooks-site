import { NextResponse } from 'next/server';

import { acknowledgeProofReview } from '@/lib/page-review';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const result = await acknowledgeProofReview(orderId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, proofReviewedAt: result.proofReviewedAt });
}
