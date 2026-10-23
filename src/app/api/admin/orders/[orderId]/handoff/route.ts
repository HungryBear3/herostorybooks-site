import { handoffRequest, HSB_ADMIN_PRINCIPAL } from '@/lib/paid-order-handoff-route';
import { createHandoffStore, type HandoffTransaction } from '@/lib/paid-order-handoff-store';
import { isAdminAuthedFromRequest } from '@/lib/admin-auth';
import { withOrderTransaction } from '@/lib/orders';
export const dynamic = 'force-dynamic';
/** Handoff authority is always decided on a fresh read, never the read-your-own-writes cache. */
const transaction: HandoffTransaction = (id, mutate, opts) => withOrderTransaction(id, mutate, { notFound: opts?.notFound, fresh: true });
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;
  return handoffRequest(request, orderId, {
    enabled: () => process.env.HSB_PAID_ORDER_OUTBOX_ENABLED === 'true',
    authenticate: isAdminAuthedFromRequest,
    // Shared admin credential maps to one server-defined principal (not a named human).
    principal: request => (isAdminAuthedFromRequest(request) ? HSB_ADMIN_PRINCIPAL : null),
    store: createHandoffStore(transaction, Date.now),
  });
}
