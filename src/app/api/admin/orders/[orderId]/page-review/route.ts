import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import {
  applyPageReviewPatch,
  withOrderTransaction,
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

  const result = await withOrderTransaction<
    | { ok: true; page: { pageIndex: number; targetedRegenNeeded?: boolean; reviewerNotes?: string | null; reviewedAt?: string | null } }
    | { ok: false; status: number; error: string }
  >(
    orderId,
    (current) => {
      const applied = applyPageReviewPatch(current, pageIndex, patch, new Date().toISOString());
      if (applied.ok === false) return { abort: applied };
      const response = { ok: true as const, page: applied.page };
      if (applied.order === current) return { abort: response };
      return { commit: applied.order, result: response };
    },
    { notFound: () => ({ ok: false as const, status: 404, error: 'Order not found' }) },
  );

  if (result.ok === false) {
    return NextResponse.json({ error: result.error }, { status: result.status });
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
