import { NextResponse } from 'next/server';

import { handlePrivateReviewAssetRequest } from '@/lib/private-review-route-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string; assetId: string }> },
) {
  const { orderId, assetId } = await context.params;
  const reply = await handlePrivateReviewAssetRequest(request, orderId, assetId);
  if (reply.body instanceof Uint8Array) {
    return new NextResponse(reply.body, { status: reply.status, headers: reply.headers });
  }
  return NextResponse.json(reply.body, { status: reply.status, headers: reply.headers });
}
