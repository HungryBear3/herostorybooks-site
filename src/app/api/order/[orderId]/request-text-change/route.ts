import { NextResponse } from 'next/server';

import { saveTextChangeRequest } from '@/lib/page-review';
import { authorizeCustomerReviewWrite } from '@/lib/review-route-auth';

export const dynamic = 'force-dynamic';

/**
 * Customer submits a page-specific text-change request from the tokenized
 * review link. Authorization is server-side and token-based (a bare order id
 * cannot write); saving records review intent only and never approves the book,
 * rotates the token, mutates canonical text, or triggers fulfillment.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  const auth = await authorizeCustomerReviewWrite(request, orderId);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const token = new URL(request.url).searchParams.get('token');
  const body = await request.json().catch(() => ({}));
  const pageIndex = Number((body as { pageIndex?: unknown })?.pageIndex);
  const rawNote = (body as { note?: unknown })?.note;
  const note = typeof rawNote === 'string' ? rawNote : '';

  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return NextResponse.json({ ok: false, error: 'invalid_page_index' }, { status: 400 });
  }

  const result = await saveTextChangeRequest({ orderId, pageIndex, note, reviewToken: token });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, page: result.page });
}
