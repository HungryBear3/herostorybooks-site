import { createHash } from 'node:crypto';
/** Pure paid-order work-event record schema and its deterministic constructor.
 *
 * This is the shared boundary between the order record (which declares the
 * `workOutbox` field and seeds the paid event inside the pending -> paid
 * transaction) and the handoff transport, lease and recovery machinery that
 * consumes those records. It imports nothing but `node:crypto`: no order store,
 * no transport, no lease policy, no confirmation module. Everything here is a
 * type or a pure function of its arguments. */
export type Lane = 'owner' | 'agent';
/** Same-run recovery audit. Core writes `{ at, receipt }`; the enrolled store adds the
 * server-derived actor, the consumed requestId, the revision it expected, operator-supplied
 * (NOT provider-verified) evidence, the granted lease expiry and a request fingerprint. */
export type RecoveryAudit = { at: number; receipt: string; actor?: string; requestId?: string; expectedRevision?: number; evidence?: string;
  evidenceSource?: 'operator_supplied_unverified'; expiresAt?: number; fingerprint?: string };
export type Delivery = { status: 'pending' | 'leased' | 'ambiguous' | 'delivered' | 'dead_letter'; attempts: number; worker?: string; token?: string; workToken?: string; expiresAt?: number; receipt?: string; recoveries?: RecoveryAudit[] };
export type WorkEvent = { id: string; kind: 'new_paid_order' | 'revise_character' | 'character_approved'; version: string | null; at: string; revenue: 'paid' | 'zero_total' | 'unknown'; owner: Delivery; agent: Delivery };
/** The order fields the constructor reads. Structural on purpose: an `OrderRecord`
 * satisfies it, and this module never has to name the order module to say so. */
export type PaidEventSource = { id: string; stripeSessionId?: string | null; settledAmountCents?: number | null; characterReview?: { version: string } | null };
export const pendingDelivery = (): Delivery => ({ status: 'pending', attempts: 0 });
/** Deterministic: the same paid order always yields the same event id, so a replayed
 * paid transition cannot mint a second event. */
export function paidEvent(order: PaidEventSource, now: string): WorkEvent {
  return { id: createHash('sha256').update(`new_paid_order:${order.id}:${order.stripeSessionId}`).digest('hex'), kind: 'new_paid_order', version: order.characterReview?.version ?? null, at: now,
    revenue: order.settledAmountCents == null ? 'unknown' : order.settledAmountCents === 0 ? 'zero_total' : 'paid', owner: pendingDelivery(), agent: pendingDelivery() };
}
