import { NextResponse } from 'next/server';

import { handlePrivateReviewSessionRequest } from '@/lib/private-review-route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const reply = await handlePrivateReviewSessionRequest(request, orderId);
  return NextResponse.json(reply.body, { status: reply.status, headers: reply.headers });
}
