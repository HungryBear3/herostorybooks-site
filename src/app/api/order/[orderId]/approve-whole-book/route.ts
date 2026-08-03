import { NextResponse } from 'next/server';

import { approveWholeBook } from '@/lib/page-review';
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
