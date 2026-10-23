import test from 'node:test';
import assert from 'node:assert/strict';
import { paidEvent, mutateOutbox, validWorkFence, WORK_LEASE_MS, type WorkEvent } from '../src/lib/paid-order-outbox.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
// Synthetic in-memory store and fake transports only: no production store, real orders, credentials or network.
type StoreModule = typeof import('../src/lib/paid-order-handoff-store.ts');
type WorkerModule = typeof import('../src/lib/paid-order-handoff-worker.ts');
type FakeModule = typeof import('../src/lib/paid-order-handoff-fake.ts');
const load = async (): Promise<{ S: StoreModule; W: WorkerModule; F: FakeModule }> => {
  try {
    return { S: await import('../src/lib/paid-order-handoff-store.ts'), W: await import('../src/lib/paid-order-handoff-worker.ts'), F: await import('../src/lib/paid-order-handoff-fake.ts') };
  } catch (error) { assert.fail(`implementation missing: ${String((error as Error).message).slice(0, 200)}`); }
};
const order = (id = 'ord_w1', patch: Partial<OrderRecord> = {}) => { const o = { id, paymentStatus: 'paid', status: 'order_received', fulfillmentMode: 'manual_hold', stripeSessionId: `cs_${id}`, settledAmountCents: 3900, ...patch } as OrderRecord; o.workOutbox = [paidEvent(o, '2026-10-21')]; return o; };
const legacy = (id: string) => ({ id, paymentStatus: 'paid', status: 'order_received', fulfillmentMode: 'manual_hold', stripeSessionId: `cs_${id}`, settledAmountCents: 3900,
  characterReview: { version: 'v1', status: 'changes_requested', workQueue: [{ id: 'legacy-rev', version: 'v1', kind: 'revise_character', status: 'pending', at: '2026-10-01' }] } }) as unknown as OrderRecord;
const sends = (t: { calls: Array<{ op: string }> }) => t.calls.filter(c => c.op === 'deliver').length;
const reconciles = (t: { calls: Array<{ op: string }> }) => t.calls.filter(c => c.op === 'reconcile').length;
type Tx = Parameters<StoreModule['createHandoffStore']>[0];
const harness = async (orders: OrderRecord[], opts: { owner?: object; agent?: object; wrap?: (tx: Tx) => Tx } = {}) => {
  const { S, W, F } = await load();
  let now = 1_000_000;
  const memory = F.createSyntheticOrderTransaction(orders);
  const store = S.createHandoffStore(opts.wrap ? opts.wrap(memory.transaction) : memory.transaction, () => now);
  const owner = F.createFakeTransport({ lane: 'owner', ...opts.owner });
  const agent = F.createFakeTransport({ lane: 'agent', ...opts.agent });
  const input = (patch: Record<string, unknown> = {}) => ({ enabled: true, store, transports: { owner, agent }, orderIds: orders.map(o => o.id), worker: 'w1', ...patch });
  const run = (patch: Record<string, unknown> = {}) => W.runBoundedHandoffWorker(input(patch) as never);
  return { S, W, F, memory, store, owner, agent, input, run, advance: (ms: number) => { now += ms; } };
};
const STATUSES = ['delivered', 'ambiguous', 'dead_letter', 'busy', 'terminal', 'ineligible', 'not_enrolled', 'not_found', 'store_error', 'skipped_budget', 'events_truncated'];

test('both lanes deliver once; repeat invocations never resend', async () => {
  const h = await harness([order()]);
  const first = await h.run();
  assert.equal(first.status, 'completed');
  assert.deepEqual(first.results.map(r => [r.lane, r.status]), [['owner', 'delivered'], ['agent', 'delivered']]);
  const stored = h.memory.snapshot('ord_w1')!.workOutbox![0];
  assert.equal(stored.owner.status, 'delivered'); assert.equal(stored.agent.status, 'delivered');
  assert.equal(stored.owner.receipt, h.owner.accepted.get(stored.id)); assert.equal(stored.agent.receipt, h.agent.accepted.get(stored.id));
  for (const ms of [0, WORK_LEASE_MS * 3]) {
    h.advance(ms);
    // Fix B1: fully terminal events are no longer listed, so repeats report nothing.
    assert.deepEqual(await h.run(), { status: 'completed', attempts: 0, results: [] });
  }
  assert.equal(sends(h.owner), 1); assert.equal(sends(h.agent), 1);
  assert.equal(h.owner.calls.length + h.agent.calls.length, 2);
});

test('default-off and non-true enabled make zero store or transport calls', async () => {
  const h = await harness([order()]);
  for (const enabled of [undefined, false, 'true', 1]) assert.deepEqual(await h.run({ enabled }), { status: 'disabled', attempts: 0, results: [] });
  const { enabled: _omitted, ...withoutFlag } = h.input();
  assert.deepEqual(await h.W.runBoundedHandoffWorker(withoutFlag as never), { status: 'disabled', attempts: 0, results: [] });
  assert.deepEqual(await h.run({ enabled: false, orderIds: ['bad'] }), { status: 'disabled', attempts: 0, results: [] });
  assert.equal(h.memory.stats().transactions, 0); assert.equal(h.owner.calls.length + h.agent.calls.length, 0);
});

test('malformed or oversized input is rejected before any store or transport effect', async () => {
  const h = await harness([order()]);
  const before = h.memory.snapshot('ord_w1');
  const many = Array.from({ length: 101 }, (_, i) => `ord_x${i}`);
  for (const patch of [{ orderIds: [] }, { orderIds: 'ord_w1' }, { orderIds: many }, { orderIds: ['ord_w1', 'bad'] }, { orderIds: ['ord_w1', 'ord_'] },
    { orderIds: ['ord_w1', 7] }, { orderIds: ['ord_w1', `ord_${'a'.repeat(101)}`] }, { orderIds: ['ord_w1', 'ord_a/../b'] }, { worker: 'bad worker' }, { worker: '' }, { worker: 'a'.repeat(81) },
    { lanes: [] }, { lanes: ['admin'] }, { lanes: ['owner', 'owner2'] }, { lanes: 'owner' }, { maxAttempts: 0 }, { maxAttempts: 201 }, { maxAttempts: 1.5 }, { maxAttempts: Infinity },
    { transportTimeoutMs: 0 }, { transportTimeoutMs: 30_001 }, { maxEventsPerOrder: 0 }, { maxEventsPerOrder: 51 }, { transports: { owner: h.owner } }, { store: {} }]) {
    assert.deepEqual(await h.run(patch), { status: 'invalid_input', attempts: 0, results: [] }, JSON.stringify(Object.keys(patch)));
  }
  assert.equal(h.memory.stats().transactions, 0); assert.equal(h.owner.calls.length + h.agent.calls.length, 0);
  assert.deepEqual(h.memory.snapshot('ord_w1'), before);
});

test('duplicate order ids and lanes are processed once', async () => {
  const h = await harness([order()]);
  const r = await h.run({ orderIds: ['ord_w1', 'ord_w1', 'ord_w1'], lanes: ['agent', 'agent'] });
  assert.deepEqual(r.results.map(x => [x.lane, x.status]), [['agent', 'delivered']]);
  assert.equal(sends(h.owner), 0); assert.equal(sends(h.agent), 1);
  // Fix B2 intentional bound: at most two lane entries; longer lists are invalid, not deduped.
  assert.deepEqual(await h.run({ lanes: ['agent', 'owner', 'agent'] }), { status: 'invalid_input', attempts: 0, results: [] });
  const both = await h.run({ orderIds: ['ord_w1', 'ord_w1'], lanes: ['owner', 'agent'] });
  assert.deepEqual(both.results.map(x => [x.lane, x.status]), [['owner', 'delivered'], ['agent', 'terminal']]);
  assert.equal(sends(h.owner), 1); assert.equal(sends(h.agent), 1);
});

test('terminal and ineligible prefixes never starve a later pending event', async () => {
  const starve = order('ord_s1');
  const base = starve.workOutbox![0];
  const ev = (id: string, patch: Partial<WorkEvent> = {}): WorkEvent => ({ ...base, id, owner: { status: 'pending', attempts: 0 }, agent: { status: 'pending', attempts: 0 }, ...patch });
  const done: Partial<WorkEvent> = { owner: { status: 'delivered', attempts: 1, receipt: 'telegram:old' }, agent: { status: 'dead_letter', attempts: 6 } };
  starve.workOutbox = [ev(base.id, done), ev('done-1', done), ev('inel-0', { revenue: 'unknown' }), ev('inel-1', { revenue: 'zero_total' }),
    ev('half', { owner: { status: 'delivered', attempts: 1, receipt: 'telegram:half' } }), ev('late')];
  const h = await harness([starve]);
  const ids = async (limit: number, lanes?: unknown) => { const l = await h.store.listEvents('ord_s1', limit, lanes as never); return [l.events.map(e => e.id), l.truncated]; };
  assert.deepEqual(await ids(1), [['half'], true]);
  assert.deepEqual(await ids(1, ['owner']), [['late'], false]);
  assert.deepEqual(await ids(2, ['agent']), [['half', 'late'], false]);
  const tx = h.memory.stats().transactions;
  for (const lanes of [[], ['admin'], ['owner', 'agent', 'owner'], 'owner', Object.assign(new Array(2), { 0: 'owner' })]) await assert.rejects(h.store.listEvents('ord_s1', 5, lanes as never), /invalid_lanes/);
  assert.equal(h.memory.stats().transactions, tx);
  const r = await h.run({ maxEventsPerOrder: 2 });
  assert.deepEqual(r.results.map(x => [x.eventId, x.lane, x.status]), [['half', 'owner', 'terminal'], ['half', 'agent', 'delivered'], ['late', 'owner', 'delivered'], ['late', 'agent', 'delivered']]);
  assert.equal(sends(h.owner), 1); assert.equal(sends(h.agent), 2);
  for (let i = 0; i < 2; i++) assert.deepEqual(await h.run({ maxEventsPerOrder: 1 }), { status: 'completed', attempts: 0, results: [] });
  assert.deepEqual(await ids(50), [[], false]);
  assert.equal(h.owner.calls.length + h.agent.calls.length, 3);
});

test('sparse, oversized, throwing or changing input arrays never reach the store', async () => {
  const invalid = { status: 'invalid_input', attempts: 0, results: [] };
  const settle = (p: Promise<unknown>) => p.catch(error => ({ rejected: String((error as Error)?.message).slice(0, 80) }));
  const holes = (length: number, values: Record<number, unknown>) => Object.assign(new Array(length), values);
  const getter = (get: () => unknown) => { const a: unknown[] = []; Object.defineProperty(a, 0, { enumerable: true, configurable: true, get }); return a; };
  const changing = (first: unknown, later: unknown) => { let reads = 0; return getter(() => (reads++ === 0 ? first : later)); };
  const badLength = new Proxy(['ord_w1'], { get: (t, k) => { if (k === 'length') throw Error('GETTER-SECRET-g2'); return Reflect.get(t, k); } });
  for (const patch of [{ orderIds: holes(2, { 0: 'ord_w1' }) }, { orderIds: holes(3, { 0: 'ord_w1', 2: 'ord_w1' }) }, { orderIds: holes(2 ** 32 - 1, { 0: 'ord_w1' }) },
    { lanes: holes(2, { 0: 'owner' }) }, { lanes: holes(1_000_000, { 0: 'owner' }) }, { lanes: ['owner', 'agent', 'owner'] },
    { orderIds: getter(() => { throw Error('GETTER-SECRET-g1'); }) }, { lanes: getter(() => { throw Error('GETTER-SECRET-g1'); }) }, { orderIds: badLength }]) {
    const h = await harness([order()]);
    assert.deepEqual(await settle(h.run(patch)), invalid, JSON.stringify(Object.keys(patch)));
    assert.equal(h.memory.stats().transactions, 0); assert.equal(h.owner.calls.length + h.agent.calls.length, 0);
  }
  const g = await harness([order()]);
  const thrown = g.input(); Object.defineProperty(thrown, 'orderIds', { get: () => { throw Error('GETTER-SECRET-g3'); } });
  assert.deepEqual(await settle(g.W.runBoundedHandoffWorker(thrown as never)), invalid);
  assert.equal(g.memory.stats().transactions, 0);
  // Each caller array element is read once; only the validated snapshot is used.
  const c = await harness([order()]);
  const eventId = c.memory.snapshot('ord_w1')!.workOutbox![0].id;
  assert.deepEqual(await settle(c.run({ orderIds: changing('ord_w1', 'ord_zz'), lanes: changing('owner', 'admin') })),
    { status: 'completed', attempts: 1, results: [{ orderId: 'ord_w1', eventId, lane: 'owner', status: 'delivered' }] });
  const d = await harness([order()]);
  const ids = await settle(d.run({ orderIds: changing('ord_w1', 'ord_zz') })) as { results?: Array<{ orderId: string; status: string }> };
  assert.deepEqual(ids.results?.map(x => [x.orderId, x.status]), [['ord_w1', 'delivered'], ['ord_w1', 'delivered']]);
  assert.equal(sends(c.owner) + sends(d.owner) + sends(d.agent), 3); assert.equal(sends(c.agent), 0);
});

test('per-invocation attempt, order and event enumeration bounds hold', async () => {
  const orders = Array.from({ length: 5 }, (_, i) => order(`ord_b${i}`));
  const h = await harness(orders);
  const r = await h.run({ lanes: ['agent'], maxAttempts: 3 });
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.results.map(x => x.status), ['delivered', 'delivered', 'delivered', 'skipped_budget', 'skipped_budget']);
  assert.equal(sends(h.agent), 3);
  const hundred = [...Array.from({ length: 99 }, (_, i) => `ord_m${i}`), 'ord_b4'];
  const wide = await h.run({ orderIds: hundred, lanes: ['agent'], maxAttempts: 200 });
  assert.equal(wide.status, 'completed'); assert.equal(wide.results.filter(x => x.status === 'not_found').length, 99);
  assert.equal(wide.results.at(-1)!.status, 'delivered'); assert.equal(sends(h.agent), 4);
  const big = order('ord_big');
  const extra = (i: number): WorkEvent => ({ ...big.workOutbox![0], id: `extra-${i}` });
  big.workOutbox = [big.workOutbox![0], ...Array.from({ length: 59 }, (_, i) => extra(i))];
  const g = await harness([big]);
  const listing = await g.store.listEvents('ord_big', 50);
  assert.equal(listing.events.length, 50); assert.equal(listing.truncated, true);
  for (const limit of [0, 51, 1.5]) await assert.rejects(g.store.listEvents('ord_big', limit), /invalid_limit/);
  const limited = await g.run({ lanes: ['owner'], maxEventsPerOrder: 2 });
  assert.deepEqual(limited.results.map(x => x.status), ['delivered', 'delivered', 'events_truncated']);
  assert.equal(sends(g.owner), 2);
});

test('unenrolled legacy records, including pending character workQueue, are never adopted', async () => {
  const charOnly = legacy('ord_l3');
  charOnly.workOutbox = [{ id: 'char-only', kind: 'revise_character', version: 'v1', at: 'x', revenue: 'paid', owner: { status: 'pending', attempts: 0 }, agent: { status: 'pending', attempts: 0 } }];
  const plain = order('ord_l2'); delete plain.workOutbox;
  const records = [legacy('ord_l1'), plain, charOnly];
  // The raw core alone would project and seed the legacy workQueue item; the store must refuse.
  assert.doesNotThrow(() => mutateOutbox(legacy('ord_l1'), { action: 'claim', eventId: 'legacy-rev', lane: 'agent', worker: 'w' }, 0));
  const h = await harness(records);
  const before = records.map(o => h.memory.snapshot(o.id));
  const r = await h.run();
  assert.deepEqual(r.results, records.map(o => ({ orderId: o.id, status: 'not_enrolled' })));
  await assert.rejects(h.store.command('ord_l1', { action: 'claim', eventId: 'legacy-rev', lane: 'agent', worker: 'w' }), /not_enrolled/);
  await assert.rejects(h.store.command('ord_l3', { action: 'claim', eventId: 'char-only', lane: 'owner', worker: 'w' }), /not_enrolled/);
  assert.equal(await h.store.validate('ord_l1', 'legacy-rev', 'agent', 'any'), false);
  await assert.rejects(h.store.listEvents('ord_l2', 10), /not_enrolled/);
  assert.deepEqual(records.map(o => h.memory.snapshot(o.id)), before);
  assert.equal(h.memory.snapshot('ord_l1')!.workOutbox, undefined);
  assert.equal(h.memory.stats().commits, 0); assert.equal(h.owner.calls.length + h.agent.calls.length, 0);
});

test('concurrent workers and concurrent claims produce one send per lane', async () => {
  const h = await harness([order()]);
  const [a, b] = await Promise.all([h.run({ worker: 'wa' }), h.run({ worker: 'wb' })]);
  for (const lane of ['owner', 'agent']) {
    const statuses = [...a.results, ...b.results].filter(x => x.lane === lane).map(x => x.status).sort();
    assert.equal(statuses.filter(s => s === 'delivered').length, 1, lane);
    assert.ok(statuses.every(s => s === 'delivered' || s === 'busy' || s === 'terminal'), statuses.join());
  }
  assert.equal(sends(h.owner), 1); assert.equal(sends(h.agent), 1);
  const c = await harness([order('ord_c2')]);
  const eventId = c.memory.snapshot('ord_c2')!.workOutbox![0].id;
  const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => c.store.command('ord_c2', { action: 'claim', eventId, lane: 'agent', worker: `w${i}` })));
  assert.equal(settled.filter(s => s.status === 'fulfilled').length, 1);
  assert.ok(settled.every(s => s.status === 'fulfilled' || /busy/.test(String((s.reason as Error).message))));
});

test('failed commit returns no claim and makes zero sends', async () => {
  const h = await harness([order()]);
  const before = h.memory.snapshot('ord_w1');
  h.memory.injectCommitFailures(1);
  assert.deepEqual((await h.run({ lanes: ['agent'] })).results.map(x => x.status), ['store_error']);
  assert.equal(h.agent.calls.length, 0); assert.deepEqual(h.memory.snapshot('ord_w1'), before);
  h.memory.injectCommitFailures(1);
  await assert.rejects(h.store.command('ord_w1', { action: 'claim', eventId: before!.workOutbox![0].id, lane: 'owner', worker: 'w' }), /commit_failed/);
  assert.deepEqual(h.memory.snapshot('ord_w1'), before); assert.equal(h.owner.calls.length, 0);
});

test('agent accepted-but-response-lost reconciles the same receipt without resend', async () => {
  const h = await harness([order()], { agent: { deliver: 'accepted_response_lost' } });
  assert.deepEqual((await h.run({ lanes: ['agent'] })).results.map(x => x.status), ['ambiguous']);
  const eventId = h.memory.snapshot('ord_w1')!.workOutbox![0].id;
  const workToken = h.memory.snapshot('ord_w1')!.workOutbox![0].agent.workToken!;
  assert.deepEqual((await h.run({ lanes: ['agent'] })).results.map(x => x.status), ['busy']);
  h.advance(WORK_LEASE_MS + 1);
  assert.deepEqual((await h.run({ lanes: ['agent'] })).results.map(x => x.status), ['delivered']);
  const agent = h.memory.snapshot('ord_w1')!.workOutbox![0].agent;
  assert.equal(sends(h.agent), 1); assert.equal(reconciles(h.agent), 1);
  assert.equal(agent.receipt, h.agent.accepted.get(eventId)); assert.equal(agent.workToken, workToken);
  assert.equal(h.agent.payloads[0].workToken, workToken);
});

test('owner transport timeout stays ambiguous and is never blindly resent', async () => {
  const h = await harness([order()], { owner: { deliver: 'hang' } });
  const started = Date.now();
  assert.deepEqual((await h.run({ lanes: ['owner'], transportTimeoutMs: 25 })).results.map(x => x.status), ['ambiguous']);
  for (let i = 0; i < 2; i++) {
    h.advance(WORK_LEASE_MS + 1);
    assert.deepEqual((await h.run({ lanes: ['owner'], transportTimeoutMs: 25 })).results.map(x => x.status), ['ambiguous']);
  }
  assert.ok(Date.now() - started < 2000);
  const owner = h.memory.snapshot('ord_w1')!.workOutbox![0].owner;
  assert.equal(owner.status, 'ambiguous'); assert.equal(owner.receipt, undefined);
  assert.equal(sends(h.owner), 1); assert.equal(reconciles(h.owner), 2);
});

for (const lane of ['owner', 'agent'] as const) {
  test(`${lane}: refund between claim and validate stops the send`, async () => {
    let n = 0;
    const h = await harness([order()], { wrap: tx => (async (id: string, mutate: never, opts: never) => {
      const r = await tx(id, mutate, opts);
      if (++n === 2) await tx(id, ((o: OrderRecord) => ({ commit: { ...o, refundedAt: '2026-10-21T00:00:00Z', stripeRefundId: 're_synthetic' }, result: null })) as never);
      return r;
    }) as Tx });
    assert.deepEqual((await h.run({ lanes: [lane] })).results.map(x => x.status), ['ambiguous']);
    assert.equal(sends(h[lane]), 0);
    assert.equal(h.memory.snapshot('ord_w1')!.refundedAt, '2026-10-21T00:00:00Z');
    // Fix B1: refunded (ineligible) events are filtered out of the listing.
    assert.deepEqual((await h.run({ lanes: [lane] })).results.map(x => x.status), []);
    assert.equal(h[lane].calls.length, 0);
  });
}

test('busy, terminal, missing and store-error orders do not abort the rest', async () => {
  const busy = order('ord_busy'); busy.workOutbox![0].agent = { status: 'leased', attempts: 1, worker: 'other', token: 'OTHER-TOKEN-b1', workToken: 'OTHER-WORK-b1', expiresAt: 9e15 };
  const dead = order('ord_dead'); dead.workOutbox![0].agent = { status: 'dead_letter', attempts: 6 };
  const h = await harness([busy, dead, order('ord_good')], { wrap: tx => ((id: string, m: never, o: never) => id === 'ord_broken' ? Promise.reject(Error('SECRET-DB-TEXT dsn=postgres://u:p@h')) : tx(id, m, o)) as Tx });
  const busyBefore = h.memory.snapshot('ord_busy');
  const r = await h.run({ lanes: ['agent'], orderIds: ['ord_busy', 'ord_missing', 'ord_broken', 'ord_dead', 'ord_good'] });
  // Fix B1: ord_dead's only event is terminal in the requested lane, so it is not listed (no row).
  assert.deepEqual(r.results.map(x => [x.orderId, x.status]), [['ord_busy', 'busy'], ['ord_missing', 'not_found'], ['ord_broken', 'store_error'], ['ord_good', 'delivered']]);
  assert.equal(sends(h.agent), 1); assert.deepEqual(h.memory.snapshot('ord_busy'), busyBefore);
  for (const s of ['SECRET-DB-TEXT', 'postgres', 'OTHER-TOKEN-b1', 'OTHER-WORK-b1']) assert.equal(JSON.stringify(r).includes(s), false, s);
  await assert.rejects(h.store.command('ord_dead', { action: 'claim', eventId: dead.workOutbox![0].id, lane: 'agent', worker: 'w' }), /terminal/);
});

test('synthetic store isolates callers with deep clones', async () => {
  const seed = order(); const h = await harness([seed]);
  const eventId = seed.workOutbox![0].id;
  seed.paymentStatus = 'refunded' as never; seed.workOutbox![0].agent.status = 'delivered';
  assert.equal(h.memory.snapshot('ord_w1')!.paymentStatus, 'paid');
  const snap = h.memory.snapshot('ord_w1')!; snap.workOutbox![0].owner.status = 'dead_letter';
  assert.equal(h.memory.snapshot('ord_w1')!.workOutbox![0].owner.status, 'pending');
  const claim = await h.store.command('ord_w1', { action: 'claim', eventId, lane: 'agent', worker: 'w' });
  const token = claim.delivery.token!;
  claim.delivery.token = 'forged'; claim.event.agent.status = 'delivered';
  const agent = h.memory.snapshot('ord_w1')!.workOutbox![0].agent;
  assert.equal(agent.token, token); assert.equal(agent.status, 'leased');
  assert.equal(await h.store.validate('ord_w1', eventId, 'agent', 'forged'), false);
  assert.equal(await h.store.validate('ord_w1', eventId, 'agent', token), true);
  await h.memory.transaction('ord_w1', o => { o.paymentStatus = 'refunded' as never; return { abort: null }; });
  await assert.rejects(h.memory.transaction('ord_w1', o => { o.paymentStatus = 'refunded' as never; throw Error('boom'); }));
  assert.equal(h.memory.snapshot('ord_w1')!.paymentStatus, 'paid');
  const listing = await h.store.listEvents('ord_w1', 10); listing.events[0].agent.status = 'pending';
  assert.equal((await h.store.listEvents('ord_w1', 10)).events[0].agent.status, 'leased');
  assert.equal(h.memory.snapshot('ord_missing'), undefined);
  assert.equal(validWorkFence(h.memory.snapshot('ord_w1')!, eventId, claim.delivery.workToken!, 1_000_001), true);
});

test('worker results are sanitized: no tokens, receipts payloads or exception text', async () => {
  const h = await harness([order(), order('ord_w2')], { agent: { deliver: 'fail_before_accept', errorText: 'EXC-SECRET-q1 Bearer abc' } });
  const r = await h.run();
  assert.deepEqual(r.results.map(x => x.status), ['delivered', 'ambiguous', 'delivered', 'ambiguous']);
  const text = JSON.stringify(r);
  const secrets = ['EXC-SECRET-q1', 'Bearer', ...h.agent.payloads.map(p => p.workToken), ...h.owner.payloads.map(p => p.workToken)];
  for (const id of ['ord_w1', 'ord_w2']) for (const lane of ['owner', 'agent'] as const) {
    const d = h.memory.snapshot(id)!.workOutbox![0][lane];
    secrets.push(d.token!, d.workToken!); if (d.receipt) secrets.push(d.receipt);
  }
  for (const s of secrets) assert.equal(text.includes(s), false, `leaked ${s}`);
  assert.equal(/token|receipt|worker/i.test(text), false);
  assert.deepEqual(Object.keys(r).sort(), ['attempts', 'results', 'status']);
  for (const x of r.results) { assert.ok(Object.keys(x).every(k => ['orderId', 'eventId', 'lane', 'status'].includes(k))); assert.ok(STATUSES.includes(x.status)); }
});
