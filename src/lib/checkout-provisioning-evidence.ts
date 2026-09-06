/**
 * Read-only operator evidence for the one checkout state that is ambiguous
 * about the buyer's money.
 *
 * `provisionCheckoutSession` names this state a DEAD END and refuses there with
 * `checkout_session_reconciliation_required`: a provisioning marker with no
 * durable candidate and no bound Session means a provider create was ENTERED for
 * the current generation and nothing durable knows how it ended. The provider may
 * be holding a payable Session for this order right now — a create whose response
 * was lost looks exactly like a create that never arrived — and elapsed time
 * cannot separate them. Reconciling it is a support/provider task.
 *
 * Nothing surfaced that state to an operator. `order-incident.ts` cannot: that
 * taxonomy returns null for any order whose `paymentStatus !== 'paid'`, and an
 * order stuck here has never been confirmed paid. So the orders that most need a
 * human were the ones no dashboard could enumerate.
 *
 * This module only classifies. It confers no authority, schedules nothing, and
 * writes nothing — replaying a create here is precisely the mistake the refusal
 * in the checkout path exists to prevent.
 *
 * Shape logic is NOT duplicated. Both reads below delegate to the parsers in
 * `orders.ts`, so this stays exactly as strict as the code that refuses: a marker
 * from a retired generation, or one this order cannot account for, parses as
 * `invalid` there and is not reported as the ambiguous state here.
 */
import {
  readCheckoutSessionCandidate,
  readCheckoutSessionProvisioning,
  type OrderRecord,
} from './orders.ts';

/** Operator-facing label. Deliberately about the action, not the mechanism. */
export const CHECKOUT_RECONCILIATION_LABEL = 'Checkout reconciliation required';
/**
 * The instruction that must travel with the label everywhere it is shown. An
 * automatic replay against a finite idempotency key is how a second payable
 * Session — and a duplicate charge — happens.
 */
export const CHECKOUT_RECONCILIATION_WARNING = 'Do not retry payment automatically';

/**
 * `startedAt` is the marker's own timestamp: how long the order has been stuck.
 * It is the only marker field exposed. The attempt id, the fingerprint and the
 * idempotency key are omitted on purpose — an operator cannot act on them, and
 * the one action they would enable is the forbidden one.
 */
export type CheckoutProvisioningEvidence =
  | { status: 'none' }
  | { status: 'reconciliation_required'; startedAt: string };

const NONE: CheckoutProvisioningEvidence = { status: 'none' };

/**
 * Classify ONLY the exact ambiguous state: an in-flight marker, no durable
 * candidate, no bound Session.
 *
 * A resumable candidate means the provider already answered and named a Session,
 * so the next attempt can reconcile it by id rather than by a key whose retention
 * nobody controls — recoverable, not ambiguous. A bound Session is not ambiguous
 * either; `readCheckoutSessionProvisioning` already refuses to read a marker
 * alongside one, and the explicit check below says so rather than relying on it.
 */
export function readCheckoutProvisioningEvidence(order: OrderRecord): CheckoutProvisioningEvidence {
  if (typeof order.stripeSessionId === 'string' && order.stripeSessionId.length > 0) return NONE;

  const provisioning = readCheckoutSessionProvisioning(order);
  if (provisioning.status !== 'in_flight') return NONE;

  if (readCheckoutSessionCandidate(order).status !== 'absent') return NONE;

  return { status: 'reconciliation_required', startedAt: provisioning.provisioning.startedAt };
}
