import { NextResponse } from 'next/server';

import { getOrder } from '@/lib/orders';
import { approveWholeBook, hasReviewAccess } from '@/lib/page-review';

export const dynamic = 'force-dynamic';

async function readReviewToken(request: Request): Promise<string | null> {
  const fromHeader = request.headers.get('x-hsb-proof-token');
  if (fromHeader) return fromHeader;

  const fromQuery = new URL(request.url).searchParams.get('token');
  if (fromQuery) return fromQuery;

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;

  try {
    const body = await request.json() as { reviewToken?: unknown; proofToken?: unknown; token?: unknown };
    for (const value of [body.reviewToken, body.proofToken, body.token]) {
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    return null;
  }
  return null;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const order = await getOrder(orderId);
  if (!order) {
    return NextResponse.json({ ok: false, error: 'Order not found' }, { status: 404 });
  }

  const reviewToken = await readReviewToken(request);
  if (!hasReviewAccess(order, { reviewToken })) {
    return NextResponse.json({ ok: false, error: 'Invalid or missing proof token' }, { status: 403 });
  }

  const result = await approveWholeBook(orderId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    proofUrl: result.proofUrl ?? null,
    printApproved: result.printApproved ?? false,
    ...(result.error ? { warning: result.error } : {}),
  });
}
