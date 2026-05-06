import { NextResponse } from 'next/server';

import { getReviewSnapshot } from '@/lib/page-review';

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
