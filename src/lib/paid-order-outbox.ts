import { randomUUID } from 'node:crypto';
import type { OrderRecord } from './orders.ts';
import { paidEvent, pendingDelivery as pending, type Delivery, type Lane, type RecoveryAudit, type WorkEvent } from './paid-order-event.ts';
/** The record schema and the paid-event constructor live in the pure
 * `paid-order-event` module (no store, transport or lease dependency). They are
 * re-exported here so the store, route, fake and existing suites keep one import;
 * the order module reaches them through the pure module only. */
export { paidEvent, type Delivery, type Lane, type RecoveryAudit, type WorkEvent };
export const WORK_LEASE_MS = 10 * 60 * 1000; // exceeds 300s adoption route + margin
/** No historical paid-order backfill. Only already durable character decisions are projected. */
export function events(order: OrderRecord): WorkEvent[] {
  const existing = order.workOutbox ?? [];
  const ids = new Set(existing.map(e => e.id));
  return [...existing, ...(order.characterReview?.workQueue ?? []).filter(e => e.status === 'pending' && !ids.has(e.id)).map(e => ({ id: e.id, kind: e.kind, version: e.version, at: e.at, revenue: paidEvent(order, e.at).revenue, owner: pending(), agent: pending() }))];
}
export function eligible(order: OrderRecord, event: WorkEvent, lane: Lane = 'agent'): boolean {
  if (order.paymentStatus !== 'paid' || order.refundedAt || order.stripeRefundId || order.refundClaimId || order.internalDisposition) return false;
  if (order.status !== 'order_received' || order.customerProofReleasedAt || order.printJobId) return false;
  if (order.fulfillmentMode !== 'manual_hold') return false;
  // Unknown/zero-total need an explicit separately designed owner-test workflow.
  if (event.revenue !== 'paid') return false;
  if (lane === 'owner') return true; // notification receipt survives progression
  if (order.proofVersion || order.pageArtifacts?.length) return false;
  const r = order.characterReview;
  if (event.kind === 'new_paid_order') return !r && event.version === null;
  return !!r && r.version === event.version && r.workQueue.some(e => e.id === event.id && e.status === 'pending') && r.status === (event.kind === 'character_approved' ? 'approved' : 'changes_requested');
}
export type Command = { action: 'recover_accepted_run'; eventId: string; lane: 'agent'; token: string; workToken: string; receipt: string; attestation: 'verified_same_accepted_run' } | { action: 'claim'; eventId: string; lane: Lane; worker: string } | { action: 'ack' | 'ambiguous' | 'renew'; eventId: string; lane: Lane; token: string; receipt?: string };
export function mutateOutbox(order: OrderRecord, command: Command, now: number): { order: OrderRecord; delivery: Delivery; event: WorkEvent } {
  const all = events(order); const index = all.findIndex(e => e.id === command.eventId); const event = all[index];
  if (!event || !eligible(order, event, command.lane)) throw Error('ineligible_or_stale');
  const previous = event[command.lane]; let next: Delivery;
  if (command.action === 'recover_accepted_run') {
    // Explicit admin reconciliation, never a resend. A receipt alone is not a
    // lease: require both current authorities, same run, expiry and eligibility.
    if (command.lane !== 'agent' || command.attestation !== 'verified_same_accepted_run'
      || previous.status !== 'delivered' || !previous.receipt || previous.receipt !== command.receipt
      || !command.token || previous.token !== command.token
      || !command.workToken || previous.workToken !== command.workToken
      || (previous.expiresAt ?? Infinity) > now || (previous.recoveries?.length ?? 0) >= 20) throw Error('recovery_refused');
    next = { ...previous, expiresAt: now + WORK_LEASE_MS,
      recoveries: [...(previous.recoveries ?? []), { at: now, receipt: command.receipt }] };
  } else if (command.action === 'claim') {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(command.worker)) throw Error('invalid_worker');
    if (previous.status === 'delivered' || previous.status === 'dead_letter') throw Error('terminal');
    if (['leased', 'ambiguous'].includes(previous.status) && (previous.expiresAt ?? 0) > now) throw Error('busy');
    // Expired leases are ambiguous too: the transport may already have accepted.
    next = { ...previous, status: previous.status === 'pending' ? 'leased' : 'ambiguous', worker: command.worker, token: randomUUID(), workToken: previous.workToken ?? randomUUID(), expiresAt: now + WORK_LEASE_MS, attempts: previous.attempts + 1 };
    if (previous.attempts >= 5) next = { ...next, status: 'dead_letter' };
  } else {
    if ((previous.token !== command.token && !(command.action === 'renew' && previous.workToken === command.token)) || !command.token) throw Error('stale_claim');
    if (previous.status === 'delivered' && command.action === 'ack' && previous.receipt === command.receipt) return { order, delivery: previous, event };
    if (!['leased', 'ambiguous', ...(command.action === 'renew' ? ['delivered'] : [])].includes(previous.status) || (command.action !== 'ack' && (previous.expiresAt ?? 0) <= now)) throw Error('expired_claim');
    if (command.action === 'renew') {
      next = { ...previous, expiresAt: now + WORK_LEASE_MS };
    } else if (command.action === 'ack') {
      if (!command.receipt || !/^[a-zA-Z0-9_:/.-]{1,200}$/.test(command.receipt)) throw Error('invalid_receipt');
      next = { ...previous, status: 'delivered', receipt: command.receipt };
    } else next = { ...previous, status: 'ambiguous' };
  }
  const updated = { ...event, [command.lane]: next }; all[index] = updated;
  return { order: { ...order, workOutbox: all }, delivery: next, event: updated };
}
/** Adapter must provide provider-side idempotency and authoritative reconciliation.
 * Receipt means Telegram message id (owner), durable accepted run/task id (agent).
 * A network success alone is not a receipt. No intake/PII is pushed here. */
export interface HandoffTransport {
  reconcile(eventId: string): Promise<{ status: 'found'; receipt: string } | { status: 'absent' } | { status: 'unknown' }>;
  deliver(input: { eventId: string; orderId: string; kind: WorkEvent['kind']; version: string | null; workToken: string }): Promise<{ receipt: string }>;
}
export interface HandoffStore {
  command(orderId: string, command: Command): Promise<{ delivery: Delivery; event: WorkEvent }>;
  validate(orderId: string, eventId: string, lane: Lane, token: string): Promise<boolean>;
}
export async function deliverClaim(store: HandoffStore, transport: HandoffTransport, orderId: string, eventId: string, lane: Lane, worker: string) {
  const claim = await store.command(orderId, { action: 'claim', eventId, lane, worker });
  if (claim.delivery.status === 'dead_letter') return 'dead_letter';
  const token = claim.delivery.token!;
  try {
    const found = claim.delivery.status === 'leased' && claim.delivery.attempts === 1
      ? { status: 'absent' as const } : await transport.reconcile(eventId);
    if (found.status === 'unknown') throw Error('unknown_transport_outcome');
    if (!(await store.validate(orderId, eventId, lane, token))) throw Error('stale_claim');
    const receipt = found.status === 'found' ? found.receipt : (await transport.deliver({ eventId, orderId, kind: claim.event.kind, version: claim.event.version, workToken: claim.delivery.workToken! })).receipt;
    await store.command(orderId, { action: 'ack', eventId, lane, token, receipt });
    return 'delivered';
  } catch {
    await store.command(orderId, { action: 'ambiguous', eventId, lane, token }).catch(() => {});
    return 'ambiguous';
  }
}
/** Transport lease authority is deliberately distinct from long-running work. */
export function validDeliveryClaim(order: OrderRecord, eventId: string, lane: Lane, token: string, now: number): boolean {
  const event = events(order).find(e => e.id === eventId);
  return !!event && eligible(order,event,lane) && event[lane].token === token && (event[lane].expiresAt ?? 0) > now && ['leased','ambiguous'].includes(event[lane].status);
}
/** Must also be called inside output-adoption CAS; receipt is not adoption authority. */
export function validWorkFence(order: OrderRecord, eventId: string, token: string, now: number): boolean {
  const event = events(order).find(e => e.id === eventId);
  return !!event && eligible(order, event) && event.agent.workToken === token && (event.agent.expiresAt ?? 0) > now && ['leased', 'delivered', 'ambiguous'].includes(event.agent.status);
}

export function requireAdoptionFence(order: OrderRecord, fence: unknown, purpose: 'character' | 'proof', now: number) {
  // Legacy manual operator workflows remain intact; enrolled outbox orders cannot bypass fencing.
  if (!order.workOutbox?.length) return;
  const f = fence as { eventId?: string; token?: string } | null;
  if (!f || typeof f.eventId !== 'string' || typeof f.token !== 'string' || !validWorkFence(order, f.eventId, f.token, now)) throw Error('invalid_work_fence');
  const event = events(order).find(e => e.id === f.eventId)!;
  if (purpose === 'proof' ? event.kind !== 'character_approved' : !['new_paid_order','revise_character'].includes(event.kind)) throw Error('invalid_work_kind');
}
