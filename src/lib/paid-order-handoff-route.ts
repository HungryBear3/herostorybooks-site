import type { Command, Delivery, Lane, WorkEvent } from './paid-order-outbox.ts';
import { createHandoffStore, parseRecoveryInput, PRINCIPAL_PATTERN, type HandoffEventStore, type HandoffTransaction, type HandoffTransactionOutcome } from './paid-order-handoff-store.ts';
import type { OrderRecord } from './orders.ts';
/** The single server-defined principal behind the shared admin credential. It names
 * the credential, not a human: anyone holding the shared key acts as this principal. */
export const HSB_ADMIN_PRINCIPAL = 'hsb-admin';
/** Lane-minimized response: safe event metadata plus only the requested lane.
 * Lease authority (token/workToken) is returned solely to a successful claim. */
export function projectOutcome(action: Command['action'], lane: Lane, event: WorkEvent, delivery: Delivery) {
  const claimed = action === 'claim' && (delivery.status === 'leased' || delivery.status === 'ambiguous');
  return { event: { id: event.id, kind: event.kind, version: event.version, at: event.at, revenue: event.revenue },
    delivery: { lane, status: delivery.status, attempts: delivery.attempts, worker: delivery.worker, expiresAt: delivery.expiresAt, receipt: delivery.receipt, recoveries: delivery.recoveries?.length,
      ...(claimed ? { token: delivery.token, workToken: delivery.workToken } : {}) } };
}
export interface HandoffRouteDeps {
  enabled(): boolean;
  authenticate(request: Request): boolean;
  /** Server-derived principal, required for recovery. A body `actor` is never consulted. */
  principal?(request: Request): string | null;
  /** Enrolled handoff store; every list and command goes through it. */
  store?: HandoffEventStore;
  /** Previous helper shape, still accepted: adapted to a HandoffTransaction and wrapped in createHandoffStore. */
  transact?(id: string, mutate: (order: OrderRecord) => { order: OrderRecord; result: unknown }): Promise<unknown>;
}
const adaptTransact = (transact: NonNullable<HandoffRouteDeps['transact']>) => ((id: string, mutate: (o: OrderRecord) => unknown) => transact(id, order => {
  const outcome = mutate(order) as HandoffTransactionOutcome<unknown>;
  if (typeof (outcome as unknown as Promise<unknown>)?.then === 'function') throw Error('async_mutate_unsupported');
  return 'abort' in outcome ? { order, result: outcome.abort } : { order: outcome.commit, result: outcome.result };
})) as HandoffTransaction;
export async function handoffRequest(request: Request, id: string, deps: HandoffRouteDeps) {
  const reply = (status: number, value: unknown) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } });
  const conflict = () => reply(409, { error: 'handoff_unavailable_or_conflict' });
  if (!deps.authenticate(request)) return reply(401, { error: 'unauthorized' });
  const origin = request.headers.get('origin');
  const requestUrl = new URL(request.url);
  if (origin && origin !== `${requestUrl.protocol}//${request.headers.get('host') ?? requestUrl.host}`) return reply(403, { error: 'origin_rejected' });
  if (!deps.enabled()) return reply(409, { error: 'handoff_disabled' });
  if (!/^ord_[a-zA-Z0-9_-]{1,100}$/.test(id)) return reply(400, { error: 'invalid_order' });
  let input: Record<string, unknown>;
  try {
    let size = 0; const chunks: Uint8Array[] = []; const reader = request.body?.getReader();
    if (!reader) throw Error('missing_body');
    try { for (;;) { const v = await reader.read(); if (v.done) break; size += v.value.length; if (size > 4096) throw Error('oversize'); chunks.push(v.value); } } finally { await reader.cancel(); }
    input = JSON.parse(Buffer.concat(chunks).toString());
    if (!input || typeof input !== 'object') throw Error('invalid_command');
    if (input.action !== 'list' && (!['claim', 'ack', 'ambiguous', 'renew', 'recover_accepted_run'].includes(input.action as string) || !['owner','agent'].includes(input.lane as string) || typeof input.eventId !== 'string')) throw Error('invalid_command');
  } catch { return conflict(); }
  let recovery = null;
  if (input.action === 'recover_accepted_run') {
    let actor: unknown = null;
    try { actor = deps.principal?.(request) ?? null; } catch { actor = null; }
    if (typeof actor !== 'string' || !PRINCIPAL_PATTERN.test(actor)) return reply(403, { error: 'recovery_principal_required' });
    // The server principal replaces anything the body claims about who is acting.
    recovery = parseRecoveryInput({ ...input, actor });
    if (!recovery) return reply(400, { error: 'invalid_recovery' });
  }
  try {
    const store = deps.store ?? (deps.transact ? createHandoffStore(adaptTransact(deps.transact), Date.now) : null);
    if (!store) throw Error('store_unavailable');
    if (input.action === 'list') return reply(200, await store.listAll(id));
    if (recovery) {
      const r = await store.recover(id, recovery);
      return reply(200, { ...projectOutcome('recover_accepted_run', 'agent', r.event, r.delivery),
        recovery: { replayed: r.replayed, actor: r.recovery.actor, requestId: r.recovery.requestId, expectedRevision: r.recovery.expectedRevision,
          evidenceSource: r.recovery.evidenceSource, expiresAt: r.recovery.expiresAt } });
    }
    const r = await store.command(id, input as Command);
    return reply(200, projectOutcome(input.action as Command['action'], input.lane as Lane, r.event, r.delivery));
  } catch { return conflict(); }
}
