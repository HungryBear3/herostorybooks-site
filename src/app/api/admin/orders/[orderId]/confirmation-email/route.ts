/**
 * Operator reconciliation of a held confirmation email (L-4 Slice A3-6).
 *
 * A thin shell: authentication, origin, order-id grammar, the closed body, the
 * writer gate and the single guarded CAS all live in the reconciliation
 * module, in that order. State writes only — no door sends anything.
 *
 * Relative `.ts` imports, for the reason given in
 * `src/app/api/admin/orders/route.ts`: a `node:test` suite can call this
 * handler and assert on the bytes it returns.
 */
import { handleConfirmationEmailOperatorRequest } from '../../../../../../lib/confirmation-email-reconciliation.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
): Promise<Response> {
  return handleConfirmationEmailOperatorRequest(request, context.params);
}
