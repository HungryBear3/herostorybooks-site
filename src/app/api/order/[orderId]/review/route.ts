import { NextResponse } from 'next/server';

import { getReviewSnapshot } from '@/lib/page-review';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const snapshot = await getReviewSnapshot(orderId);
  if (!snapshot) {
    return NextResponse.json({ error: 'Review not ready' }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
