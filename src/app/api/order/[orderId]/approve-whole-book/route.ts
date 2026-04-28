import { NextResponse } from 'next/server';

import { approveWholeBook } from '@/lib/page-review';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
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
