import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { resolveTextChangeRequest } from '@/lib/page-review';

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
  const { pageIndex, storyText } = body as Record<string, unknown>;
  if (typeof pageIndex !== 'number' || typeof storyText !== 'string') {
    return NextResponse.json(
      { error: 'pageIndex (number) and storyText (string) are required' },
      { status: 400 },
    );
  }

  const result = await resolveTextChangeRequest({ orderId, pageIndex, storyText });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, snapshot: result.snapshot ?? null },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    proofRefreshed: result.proofRefreshed,
    snapshot: result.snapshot,
  });
}
