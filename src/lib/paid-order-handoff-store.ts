import { createHash } from 'node:crypto';
import { events, eligible, mutateOutbox, validDeliveryClaim, type Command, type Delivery, type HandoffStore, type Lane, type RecoveryAudit, type WorkEvent } from './paid-order-outbox.ts';
import type { OrderRecord } from './orders.ts';
/** Shape of `withOrderTransaction` (orders.ts): mutate sees a fresh read on every
 * attempt and returns `{ commit, result }` to write, or `{ abort }` to write nothing.
 * The result is only returned after the commit succeeded. Type-only import: this
 * module never loads the orders/provider graph at runtime. */
export type HandoffTransactionOutcome<T> = { commit: OrderRecord; result: T } | { abort: T };
export type HandoffTransaction = <T>(orderId: string, mutate: (order: OrderRecord) => HandoffTransactionOutcome<T> | Promise<HandoffTransactionOutcome<T>>, opts?: { notFound?: () => T }) => Promise<T>;
export const MAX_LISTED_EVENTS = 50;
export type LaneSummary = { status: Delivery['status']; eligible: boolean };
export type EventSummary = { id: string; kind: WorkEvent['kind']; owner: LaneSummary; agent: LaneSummary };
/** The N2 admin list row: safe status metadata only, never tokens, receipts or audit. */
export type ListedEvent = { id: string; kind: WorkEvent['kind']; version: string | null; owner: Delivery['status']; agent: Delivery['status']; ownerEligible: boolean; agentEligible: boolean;
  revenue: WorkEvent['revenue']; requiresAttention: boolean; blocked: boolean };
/** `actor` must be server-derived by the caller (never a request body field). */
export type RecoveryInput = { actor: string; requestId: string; expectedRevision: number; evidence: string; eventId: string; token: string; workToken: string; receipt: string; attestation: 'verified_same_accepted_run' };
export type RecoveryOutcome = { replayed: boolean; event: WorkEvent; delivery: Delivery; recovery: RecoveryAudit };
export interface HandoffEventStore extends HandoffStore {
  /** Only actionable events (eligible and non-terminal in at least one requested lane)
   * are listed and counted for `truncated`, so terminal/ineligible history cannot
   * starve later events. `lanes` defaults to both for API compatibility. */
  listEvents(orderId: string, limit: number, lanes?: readonly Lane[]): Promise<{ events: EventSummary[]; truncated: boolean }>;
  /** Full safe projection of every event (terminal history included) for the admin route. */
  listAll(orderId: string): Promise<{ events: ListedEvent[] }>;
  /** Same-run agent recovery: requestId consumption, expected revision check and lease
   * extension commit in one transaction. Exact replay returns the stored outcome. */
  recover(orderId: string, input: RecoveryInput): Promise<RecoveryOutcome>;
}
const LANES: readonly Lane[] = ['owner', 'agent'];
/** Core caps recoveries at 20, so revisions 0..19 are the only ones that can succeed. */
export const MAX_RECOVERY_REVISION = 19;
export const PRINCIPAL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;
const EVIDENCE = /^[A-Za-z0-9 _:/.,#@-]{1,200}$/;
const text = (v: unknown) => typeof v === 'string' && v.length >= 1 && v.length <= 200;
/** Reads each field once into a plain snapshot; null when anything is missing or malformed. */
export function parseRecoveryInput(input: unknown): RecoveryInput | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const v = { actor: i.actor, requestId: i.requestId, expectedRevision: i.expectedRevision, evidence: i.evidence, eventId: i.eventId,
    token: i.token, workToken: i.workToken, receipt: i.receipt, attestation: i.attestation, lane: i.lane };
  if (typeof v.actor !== 'string' || !PRINCIPAL_PATTERN.test(v.actor) || typeof v.requestId !== 'string' || !REQUEST_ID.test(v.requestId)
    || typeof v.expectedRevision !== 'number' || !Number.isInteger(v.expectedRevision) || v.expectedRevision < 0 || v.expectedRevision > MAX_RECOVERY_REVISION
    || typeof v.evidence !== 'string' || !EVIDENCE.test(v.evidence) || !text(v.eventId) || !text(v.token) || !text(v.workToken) || !text(v.receipt)
    || v.attestation !== 'verified_same_accepted_run' || (v.lane !== undefined && v.lane !== 'agent')) return null;
  const { lane: _lane, ...parsed } = v;
  return parsed as RecoveryInput;
}
const fingerprintOf = (orderId: string, r: RecoveryInput) => createHash('sha256')
  .update(JSON.stringify(['handoff-recovery-v1', orderId, r.eventId, r.actor, r.expectedRevision, r.evidence, r.receipt, r.attestation, r.token, r.workToken])).digest('hex');
const actionable = (order: OrderRecord, e: WorkEvent, lanes: readonly Lane[]) =>
  lanes.some(l => e[l].status !== 'delivered' && e[l].status !== 'dead_letter' && eligible(order, e, l));
/** Explicit enrollment only: a durable new_paid_order outbox entry. Legacy
 * workQueue-only records are never seeded or adopted through this store. */
export function enrolled(order: OrderRecord): boolean {
  return !!order.workOutbox?.some(e => e.kind === 'new_paid_order');
}
const notFound = (): never => { throw Error('order_not_found'); };
/** Outputs are deep clones: a caller can never mutate state a transaction (or its cache) holds. */
const detached = <T>(value: T): T => structuredClone(value);
export function createHandoffStore(transaction: HandoffTransaction, now: () => number): HandoffEventStore {
  return {
    command: (orderId: string, command: Command) => {
      // Recovery needs a server-derived actor, requestId and revision: only `recover` may do it.
      if (command?.action === 'recover_accepted_run') return Promise.reject(Error('recovery_requires_actor'));
      return transaction(orderId, order => {
        if (!enrolled(order)) throw Error('not_enrolled');
        const outcome = mutateOutbox(order, command, now());
        const result = { delivery: outcome.delivery, event: outcome.event };
        return outcome.order === order ? { abort: result } : { commit: outcome.order, result };
      }, { notFound }).then(detached);
    },
    validate: (orderId: string, eventId: string, lane: Lane, token: string) => transaction(orderId, order =>
      ({ abort: enrolled(order) && validDeliveryClaim(order, eventId, lane, token, now()) }), { notFound: () => false }),
    listEvents: (orderId: string, limit: number, lanes: readonly Lane[] = LANES) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTED_EVENTS) return Promise.reject(Error('invalid_limit'));
      let wanted: Lane[];
      try { wanted = Array.isArray(lanes) && lanes.length >= 1 && lanes.length <= LANES.length ? Array.from(lanes) : []; } catch { wanted = []; }
      if (wanted.length < 1 || !wanted.every(l => l === 'owner' || l === 'agent')) return Promise.reject(Error('invalid_lanes'));
      return transaction(orderId, order => {
        if (!enrolled(order)) throw Error('not_enrolled');
        const all = events(order).filter(e => actionable(order, e, wanted));
        return { abort: { truncated: all.length > limit, events: all.slice(0, limit).map(e => ({ id: e.id, kind: e.kind,
          owner: { status: e.owner.status, eligible: eligible(order, e, 'owner') }, agent: { status: e.agent.status, eligible: eligible(order, e, 'agent') } })) } };
      }, { notFound });
    },
    listAll: (orderId: string) => transaction(orderId, order => {
      if (!enrolled(order)) throw Error('not_enrolled');
      return { abort: { events: events(order).map((e): ListedEvent => ({ id: e.id, kind: e.kind, version: e.version, owner: e.owner.status, agent: e.agent.status,
        ownerEligible: eligible(order, e, 'owner'), agentEligible: eligible(order, e, 'agent'), revenue: e.revenue,
        requiresAttention: [e.owner.status, e.agent.status].some(s => s === 'dead_letter' || s === 'ambiguous'), blocked: !eligible(order, e, 'owner') })) } };
    }, { notFound }).then(detached),
    recover: (orderId: string, raw: RecoveryInput) => {
      const input = parseRecoveryInput(raw);
      if (!input) return Promise.reject(Error('invalid_recovery'));
      const fingerprint = fingerprintOf(orderId, input);
      return transaction<RecoveryOutcome>(orderId, order => {
        if (!enrolled(order)) throw Error('not_enrolled');
        const all = events(order);
        // A requestId is consumed once per order: exact replay grants nothing new.
        for (const e of all) for (const lane of LANES) for (const r of e[lane].recoveries ?? []) {
          if (r.requestId !== input.requestId) continue;
          if (lane !== 'agent' || e.id !== input.eventId || r.fingerprint !== fingerprint) throw Error('request_conflict');
          return { abort: { replayed: true, event: e, delivery: e.agent, recovery: r } };
        }
        const event = all.find(e => e.id === input.eventId);
        if (!event) throw Error('ineligible_or_stale');
        if ((event.agent.recoveries?.length ?? 0) !== input.expectedRevision) throw Error('stale_revision');
        const outcome = mutateOutbox(order, { action: 'recover_accepted_run', eventId: input.eventId, lane: 'agent', token: input.token,
          workToken: input.workToken, receipt: input.receipt, attestation: input.attestation }, now());
        const prior = outcome.delivery.recoveries!;
        const recovery: RecoveryAudit = { ...prior[prior.length - 1], actor: input.actor, requestId: input.requestId, expectedRevision: input.expectedRevision,
          evidence: input.evidence, evidenceSource: 'operator_supplied_unverified', expiresAt: outcome.delivery.expiresAt, fingerprint };
        const delivery: Delivery = { ...outcome.delivery, recoveries: [...prior.slice(0, -1), recovery] };
        const updated: WorkEvent = { ...outcome.event, agent: delivery };
        const commit = { ...outcome.order, workOutbox: outcome.order.workOutbox!.map(e => e.id === updated.id ? updated : e) };
        return { commit, result: { replayed: false, event: updated, delivery, recovery } };
      }, { notFound }).then(detached);
    },
  };
}
