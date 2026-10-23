import type { HandoffTransport, Lane } from './paid-order-outbox.ts';
import type { OrderRecord } from './orders.ts';
import { createHandoffStore, type HandoffTransaction } from './paid-order-handoff-store.ts';
/** SYNTHETIC, NON-DURABLE rehearsal inputs for the local milestone only. State
 * lives in process memory and is lost on restart; no environment, configuration,
 * network or production store is touched. Production adapter wiring is NOT_RUN. */
export function createSyntheticOrderTransaction(seed: OrderRecord[] = []) {
  const records = new Map<string, OrderRecord>(seed.map(o => [o.id, structuredClone(o)]));
  const locks = new Map<string, Promise<void>>();
  const counters = { transactions: 0, commits: 0 };
  let failures = 0;
  // Serialized per order id: each caller waits for the previous holder to finish.
  const transaction: HandoffTransaction = async (orderId, mutate, opts = {}) => {
    const previous = locks.get(orderId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const tail = previous.then(() => held);
    locks.set(orderId, tail);
    await previous;
    try {
      counters.transactions++;
      const stored = records.get(orderId);
      if (!stored) { if (opts.notFound) return opts.notFound(); throw Error('order_not_found'); }
      const outcome = await mutate(structuredClone(stored));
      if ('abort' in outcome) return structuredClone(outcome.abort);
      if (!outcome.commit || outcome.commit.id !== orderId) throw Error('commit_identity');
      if (failures > 0) { failures--; throw Error('commit_failed'); }
      records.set(orderId, structuredClone(outcome.commit)); counters.commits++;
      return structuredClone(outcome.result);
    } finally {
      release();
      if (locks.get(orderId) === tail) locks.delete(orderId);
    }
  };
  return {
    transaction,
    snapshot: (orderId: string) => { const o = records.get(orderId); return o && structuredClone(o); },
    injectCommitFailures: (count: number) => { failures = count; },
    stats: () => ({ ...counters }),
  };
}
/** Same createHandoffStore factory as production; only the transaction differs. */
export function createSyntheticHandoffStore(seed: OrderRecord[], now: () => number) {
  const memory = createSyntheticOrderTransaction(seed);
  return { memory, store: createHandoffStore(memory.transaction, now) };
}
export type FakeTransportOptions = {
  lane: Lane;
  /** accept: receipt returned. accepted_response_lost: remote accepted, caller sees an error.
   * hang: remote accepted, response never arrives. fail_before_accept: nothing accepted. */
  deliver?: 'accept' | 'accepted_response_lost' | 'hang' | 'fail_before_accept';
  /** ledger: authoritative lookup (agent run/task API). unknown: no lookup (owner Telegram). */
  reconcile?: 'ledger' | 'unknown';
  errorText?: string;
};
type DeliverInput = Parameters<HandoffTransport['deliver']>[0];
/** Deterministic fake: receipts are counters, calls are recorded, accepted events
 * keep one receipt (provider-side idempotency). Not Telegram/Gateway qualification. */
export function createFakeTransport(options: FakeTransportOptions) {
  const mode = options.deliver ?? 'accept';
  const lookup = options.reconcile ?? (options.lane === 'owner' ? 'unknown' : 'ledger');
  const calls: Array<{ op: 'reconcile' | 'deliver'; eventId: string }> = [];
  const payloads: DeliverInput[] = [];
  const accepted = new Map<string, string>();
  let sequence = 0;
  const transport: HandoffTransport = {
    reconcile: async eventId => {
      calls.push({ op: 'reconcile', eventId });
      if (lookup === 'unknown') return { status: 'unknown' };
      const receipt = accepted.get(eventId);
      return receipt ? { status: 'found', receipt } : { status: 'absent' };
    },
    deliver: async input => {
      calls.push({ op: 'deliver', eventId: input.eventId }); payloads.push(structuredClone(input));
      if (mode === 'fail_before_accept') throw Error(options.errorText ?? 'fake_transport_failure');
      if (!accepted.has(input.eventId)) accepted.set(input.eventId, `${options.lane === 'owner' ? 'telegram' : 'run'}:fake-${++sequence}`);
      if (mode === 'accepted_response_lost') throw Error(options.errorText ?? 'fake_response_lost');
      if (mode === 'hang') return new Promise<never>(() => {});
      return { receipt: accepted.get(input.eventId)! };
    },
  };
  return { ...transport, calls, payloads, accepted };
}
