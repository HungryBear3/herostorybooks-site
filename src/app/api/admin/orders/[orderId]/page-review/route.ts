import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import {
  applyPageReviewPatch,
  getOrder,
  persistOrder,
  type PageReviewPatch,
} from '@/lib/orders';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { orderId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }
  const { pageIndex, ...rest } = body as Record<string, unknown>;
  if (typeof pageIndex !== 'number') {
    return NextResponse.json({ error: 'pageIndex (number) is required' }, { status: 400 });
  }
  const patch: PageReviewPatch = {};
  if (Object.prototype.hasOwnProperty.call(rest, 'targetedRegenNeeded')) {
    patch.targetedRegenNeeded = Boolean(rest.targetedRegenNeeded);
  }
  if (Object.prototype.hasOwnProperty.call(rest, 'reviewerNotes')) {
    const v = rest.reviewerNotes;
    patch.reviewerNotes = v === null ? null : typeof v === 'string' ? v : null;
  }

  const order = await getOrder(orderId);
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  const result = applyPageReviewPatch(order, pageIndex, patch, new Date().toISOString());
  if (result.ok === false) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  if (result.order !== order) {
    await persistOrder(result.order);
  }

  return NextResponse.json({
    ok: true,
    page: {
      pageIndex: result.page.pageIndex,
      targetedRegenNeeded: Boolean(result.page.targetedRegenNeeded),
      reviewerNotes: result.page.reviewerNotes ?? null,
      reviewedAt: result.page.reviewedAt ?? null,
    },
  });
}
