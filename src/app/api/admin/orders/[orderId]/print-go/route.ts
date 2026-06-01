import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { recordOwnerPrintGo } from '@/lib/admin-actions';

export const dynamic = 'force-dynamic';

const OWNER_BY_MAX_LEN = 120;

/**
 * Operator/owner print go-ahead.
 *
 * Customer approval (via `/review` token) only advances the order to
 * `proof_approved`. The customer-facing route MUST NOT submit print.
 * This admin-authenticated endpoint is the single path that calls
 * `recordOwnerPrintGo` → `submitPrintAfterOwnerGo` → `runPrintProduction`.
 *
 * Auth: admin cookie required (`isAdminAuthedFromRequest`).
 * Body (optional): `{ ownerBy: string }`. If absent, falls back to
 * "admin" — bounded server-side to `OWNER_BY_MAX_LEN` chars.
 * Underlying `recordOwnerPrintGo` enforces:
 *   - order exists
 *   - paid + not refunded
 *   - qaPassAt set
 *   - customer approval timestamp set (printApprovedAt/proofApprovedAt)
 *   - fulfillmentStatus === 'proof_approved'
 *   - ownerBy non-empty after trim
 * On refusal it returns `{ ok: false, status: 409, error }` which this
 * route surfaces verbatim as a 409 with the named refusal message.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  if (!isAdminAuthedFromRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orderId } = await context.params;

  let body: { ownerBy?: unknown } = {};
  try {
    body = (await request.json()) as { ownerBy?: unknown };
  } catch {
    // Empty body is acceptable — we default ownerBy to 'admin' below.
  }
  const rawOwnerBy = typeof body.ownerBy === 'string' ? body.ownerBy : '';
  const ownerBy = rawOwnerBy.trim().slice(0, OWNER_BY_MAX_LEN) || 'admin';

  const result = await recordOwnerPrintGo(orderId, ownerBy);
  if (result.ok === true) {
    return NextResponse.json({ ok: true, detail: result.detail });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
