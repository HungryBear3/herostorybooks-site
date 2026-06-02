import { NextResponse } from 'next/server';

import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { releaseOwnerPrintGoLock } from '@/lib/admin-actions';

export const dynamic = 'force-dynamic';

const OWNER_BY_MAX_LEN = 120;

/**
 * Operator-only recovery: clear a stuck owner-print-go intent lock.
 *
 * Used when a paid owner-go attempt failed mid-flow (persistence error,
 * Lulu/RPI submit returned an error, etc.) and left the order in
 * `submitting_to_print` / `failed_manual_review` with the durable lock
 * still present. Without this action the only recovery was manual blob /
 * FS surgery; that was an explicit pre-G5 hardening blocker.
 *
 * Auth: admin cookie required (`isAdminAuthedFromRequest`).
 * Body: `{ ownerBy: string }` — REQUIRED and non-empty after trim. The
 * operator id is recorded into the `owner_print_go_lock_released` audit
 * event for permanent traceability. The route does NOT default it.
 *
 * Underlying `releaseOwnerPrintGoLock` refuses unless ALL of:
 *   - order exists,
 *   - no `printJobId` (PRINT_ALREADY_SUBMITTED — do not invalidate a
 *     real print job; investigate at the provider instead),
 *   - status is not `print_in_production` / `shipped`
 *     (ORDER_ALREADY_IN_PRINT_OR_SHIPPED),
 *   - some lock evidence exists (NO_LOCK_TO_RELEASE — nothing to do).
 *
 * Refusal HTTP statuses: 400 for ownerBy missing, 404 for unknown
 * order, 409 for guard refusals, 502 for persistence failures.
 *
 * Method is POST: the action mutates server state (clears lock,
 * appends audit, reverts fulfillmentStatus) so DELETE semantics aren't
 * a clean fit, and POST keeps this consistent with /print-go.
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

  const result = await releaseOwnerPrintGoLock(orderId, ownerBy);
  if (result.ok === true) {
    return NextResponse.json({ ok: true, detail: result.detail });
  }
  return NextResponse.json(
    { error: result.error, failureCode: result.failureCode ?? null },
    { status: result.status },
  );
}
