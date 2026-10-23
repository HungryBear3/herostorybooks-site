import { deliverClaim, type HandoffTransport, type Lane } from './paid-order-outbox.ts';
import type { HandoffEventStore } from './paid-order-handoff-store.ts';
/** One bounded, explicitly invoked pass over caller-named orders. No discovery
 * scan, loop, scheduler, route or real adapter. Default OFF. */
/** The store capability this worker consumes: exactly the three methods it binds
 * and calls. The admin discovery (`listAll`) and recovery (`recover`) surfaces of
 * the full event store are deliberately not part of it, so a caller can hand the
 * worker a store that cannot enumerate or recover anything. */
export type HandoffWorkerStore = Pick<HandoffEventStore, 'command' | 'validate' | 'listEvents'>;
export const MAX_WORKER_ORDERS = 100;
export const MAX_WORKER_ATTEMPTS = 200;
export const MAX_TRANSPORT_TIMEOUT_MS = 30_000;
export const MAX_EVENTS_PER_ORDER = 50;
/** Intentional bound: at most one entry per lane; longer lane lists are invalid. */
export const MAX_WORKER_LANES = 2;
export type WorkerStatus = 'delivered' | 'ambiguous' | 'dead_letter' | 'busy' | 'terminal' | 'ineligible' | 'not_enrolled' | 'not_found' | 'store_error' | 'skipped_budget' | 'events_truncated';
export type WorkerResult = { orderId: string; eventId?: string; lane?: Lane; status: WorkerStatus };
export type WorkerOutcome = { status: 'disabled' | 'invalid_input' | 'completed'; attempts: number; results: WorkerResult[] };
export type WorkerInput = {
  enabled?: boolean; store: HandoffWorkerStore; transports: Partial<Record<Lane, HandoffTransport>>; orderIds: string[]; worker: string;
  lanes?: Lane[]; maxAttempts?: number; transportTimeoutMs?: number; maxEventsPerOrder?: number;
};
// Only known store/core codes surface; any other error text is replaced, never echoed.
const KNOWN = new Map<string, WorkerStatus>([['busy', 'busy'], ['terminal', 'terminal'], ['ineligible_or_stale', 'ineligible'], ['not_enrolled', 'not_enrolled'], ['order_not_found', 'not_found']]);
const classify = (error: unknown): WorkerStatus => (error instanceof Error && KNOWN.get(error.message)) || 'store_error';
const bounded = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
const fns = (value: unknown, names: string[]) => !!value && typeof value === 'object' && names.every(k => typeof (value as Record<string, unknown>)[k] === 'function');
/** A timeout settles our wait only; it cannot abort a remote operation that may
 * already have been accepted, so the claim is left ambiguous, never resent. */
function withTimeout(transport: HandoffTransport, ms: number): HandoffTransport {
  const race = <T>(call: () => Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([Promise.resolve().then(call), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('transport_timeout')), ms); })])
      .finally(() => clearTimeout(timer));
  };
  const reconcile = transport.reconcile.bind(transport), deliver = transport.deliver.bind(transport);
  return { reconcile: eventId => race(() => reconcile(eventId)), deliver: input => race(() => deliver(input)) };
}
/** Reads a caller array exactly once, after bounding its length (no huge allocation).
 * Holes are invalid; afterwards only the returned dense snapshot is used. */
function snapshot(value: unknown, max: number): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  if (!Number.isInteger(length) || length < 1 || length > max) return undefined;
  const copy: unknown[] = [];
  for (let i = 0; i < length; i++) { if (!Object.hasOwn(value, i)) return undefined; copy.push(value[i]); }
  return copy;
}
type Parsed = { store: HandoffWorkerStore; wrapped: Record<Lane, HandoffTransport>; orderIds: string[]; wanted: Lane[]; worker: string; maxAttempts: number; maxEventsPerOrder: number };
// The entire input is snapshotted and validated before any store or transport effect.
// Callers may throw from getters/Proxy traps; runBoundedHandoffWorker maps that to invalid_input.
function parse(input: WorkerInput): Parsed | undefined {
  const { store, transports, orderIds, worker, lanes = ['owner', 'agent'], maxAttempts = 50, transportTimeoutMs = 10_000, maxEventsPerOrder = 20 } = input;
  const ids = snapshot(orderIds, MAX_WORKER_ORDERS), picked = snapshot(lanes, MAX_WORKER_LANES);
  if (!ids || !ids.every(id => typeof id === 'string' && /^ord_[a-zA-Z0-9_-]{1,100}$/.test(id))) return;
  if (typeof worker !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(worker)) return;
  if (!picked || !picked.every(l => l === 'owner' || l === 'agent')) return;
  if (!bounded(maxAttempts, MAX_WORKER_ATTEMPTS) || !bounded(transportTimeoutMs, MAX_TRANSPORT_TIMEOUT_MS) || !bounded(maxEventsPerOrder, MAX_EVENTS_PER_ORDER)) return;
  if (!fns(store, ['command', 'validate', 'listEvents']) || !transports) return;
  const wanted = [...new Set(picked as Lane[])];
  const wrapped = {} as Record<Lane, HandoffTransport>;
  for (const l of wanted) { const t = transports[l]; if (!fns(t, ['reconcile', 'deliver'])) return; wrapped[l] = withTimeout(t!, transportTimeoutMs); }
  const bound = { command: store.command.bind(store), validate: store.validate.bind(store), listEvents: store.listEvents.bind(store) };
  return { store: bound, wrapped, orderIds: [...new Set(ids as string[])], wanted, worker, maxAttempts, maxEventsPerOrder };
}
export async function runBoundedHandoffWorker(input: WorkerInput): Promise<WorkerOutcome> {
  let parsed: Parsed | undefined;
  try {
    if (input?.enabled !== true) return { status: 'disabled', attempts: 0, results: [] };
    parsed = parse(input);
  } catch { parsed = undefined; }
  if (!parsed) return { status: 'invalid_input', attempts: 0, results: [] };
  const { store, wrapped, orderIds, wanted, worker, maxAttempts, maxEventsPerOrder } = parsed;
  const results: WorkerResult[] = [];
  let attempts = 0;
  for (const orderId of orderIds) {
    let listing: Awaited<ReturnType<HandoffWorkerStore['listEvents']>>;
    try { listing = await store.listEvents(orderId, maxEventsPerOrder, wanted); } catch (error) { results.push({ orderId, status: classify(error) }); continue; }
    for (const event of listing.events) for (const lane of wanted) {
      const summary = event[lane];
      // Listing is advisory; the claim re-checks eligibility in a fresh transaction.
      const status: WorkerStatus = !summary.eligible ? 'ineligible'
        : summary.status === 'delivered' || summary.status === 'dead_letter' ? 'terminal'
        : attempts >= maxAttempts ? 'skipped_budget'
        : await (attempts++, (deliverClaim(store, wrapped[lane], orderId, event.id, lane, worker) as Promise<WorkerStatus>).catch(classify));
      results.push({ orderId, eventId: event.id, lane, status });
    }
    if (listing.truncated) results.push({ orderId, status: 'events_truncated' });
  }
  return { status: 'completed', attempts, results };
}
