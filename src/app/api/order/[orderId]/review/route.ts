import { NextResponse } from 'next/server';

import { getReviewSnapshot } from '@/lib/page-review';
import { getReviewTokenFromRequest } from '@/lib/review-capability';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const token = getReviewTokenFromRequest(request, orderId);
  const snapshot = await getReviewSnapshot(orderId, { reviewToken: token, now: new Date() });
  if (!snapshot) {
    return NextResponse.json(
      { error: 'Review not ready' },
      {
        status: 404,
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'X-Robots-Tag': 'noindex, nofollow',
          'Referrer-Policy': 'no-referrer',
        },
      },
    );
  }
  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'private, no-store, max-age=0',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
