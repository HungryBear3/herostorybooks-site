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
 * Body: `{ ownerBy: string }` — REQUIRED and non-empty after trim.
 * Direct API callers must supply an explicit operator identifier; the
 * route does NOT silently default missing/whitespace `ownerBy` to
 * "admin". The admin UI may still set the field default in the form,
 * but the route refuses an empty value with 400 so the underlying
 * audit trail can't have a meaningless "admin" identifier.
 *
 * Underlying `recordOwnerPrintGo` further enforces:
 *   - order exists
 *   - paid + not refunded
 *   - qaPassAt set
 *   - customer approval timestamp set (printApprovedAt/proofApprovedAt)
 *   - fulfillmentStatus === 'proof_approved'
 *   - not already submitted / not shipped / no prior ownerPrintGoAt
 *   - exclusive lock acquisition via CAS-with-readback (race-loss
 *     returns a safe idempotent refusal — no submitPrint side effect).
 *
 * Refusal HTTP statuses: 400 for ownerBy missing, 404 for unknown
 * order, 409 for everything else.
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
    // Body parse failure falls through to the explicit ownerBy check
    // below, which will reject with 400.
  }
  const rawOwnerBy = typeof body.ownerBy === 'string' ? body.ownerBy : '';
  const ownerBy = rawOwnerBy.trim().slice(0, OWNER_BY_MAX_LEN);
  if (!ownerBy) {
    return NextResponse.json(
      { error: 'ownerBy required (non-empty operator identifier)' },
      { status: 400 },
    );
  }

  const result = await recordOwnerPrintGo(orderId, ownerBy);
  if (result.ok === true) {
    return NextResponse.json({ ok: true, detail: result.detail });
  }
  return NextResponse.json({ error: result.error }, { status: result.status });
}
