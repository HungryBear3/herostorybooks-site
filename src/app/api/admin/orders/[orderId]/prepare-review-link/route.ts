import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { prepareCustomerReviewLink } from '@/lib/page-review';

export const dynamic = 'force-dynamic';

/**
 * Authorized admin/system step that creates or preserves a customer review token
 * for a paid order that already has a review artifact. Idempotent, auditable,
 * and never sends email — link creation and customer delivery are distinct,
 * separately-authorized actions. Refuses unpaid / not-yet-reviewable orders.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { orderId } = await context.params;
  const result = await prepareCustomerReviewLink(orderId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    reviewPath: result.reviewPath,
    token: result.token,
    alreadyPrepared: result.alreadyPrepared ?? false,
  });
}
