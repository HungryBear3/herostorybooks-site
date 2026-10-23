import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { paidEvent, validWorkFence, WORK_LEASE_MS } from '../src/lib/paid-order-outbox.ts';
import { createHandoffStore, type HandoffTransaction } from '../src/lib/paid-order-handoff-store.ts';
import { createSyntheticOrderTransaction } from '../src/lib/paid-order-handoff-fake.ts';
import { handoffRequest, type HandoffRouteDeps } from '../src/lib/paid-order-handoff-route.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
// Synthetic orders, in-memory/JSON fixtures only: no real orders persistence, providers, credentials or network.
const T0 = 5_000_000;
const order = (id = 'ord_i1') => { const o = { id, paymentStatus: 'paid', status: 'order_received', fulfillmentMode: 'manual_hold', stripeSessionId: `cs_${id}`, settledAmountCents: 3900, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' } as OrderRecord; o.workOutbox = [paidEvent(o, '2026-10-21')]; return o; };
/** Agent run accepted (delivered) whose lease already expired; owner lane holds unrelated live secrets. */
const accepted = (id = 'ord_i1', expiresAt = T0 - 1) => { const o = order(id);
  o.workOutbox![0].agent = { status: 'delivered', attempts: 1, worker: 'w', token: 'AGENT-TOKEN-k1', workToken: 'AGENT-WORK-k1', receipt: 'run:accepted-1', expiresAt };
  o.workOutbox![0].owner = { status: 'leased', attempts: 1, worker: 'ow', token: 'OWNER-TOKEN-k1', workToken: 'OWNER-WORK-k1', expiresAt: 9e15 }; return o; };
const legacyOrder = (id: string) => ({ id, paymentStatus: 'paid', status: 'order_received', fulfillmentMode: 'manual_hold', stripeSessionId: `cs_${id}`, settledAmountCents: 3900,
  characterReview: { version: 'v1', status: 'changes_requested', workQueue: [{ id: 'legacy-rev', version: 'v1', kind: 'revise_character', status: 'pending', at: '2026-10-01' }] } }) as unknown as OrderRecord;
const SECRETS = ['AGENT-TOKEN-k1', 'AGENT-WORK-k1', 'OWNER-TOKEN-k1', 'OWNER-WORK-k1'];
const LIST_KEYS = ['agent', 'agentEligible', 'blocked', 'id', 'kind', 'owner', 'ownerEligible', 'requiresAttention', 'revenue', 'version'];
const EVIDENCE = 'operator-checked run:accepted-1 in console';
const recoverBody = (eventId: string, patch: Record<string, unknown> = {}) => ({ action: 'recover_accepted_run', eventId, lane: 'agent', token: 'AGENT-TOKEN-k1', workToken: 'AGENT-WORK-k1',
  receipt: 'run:accepted-1', attestation: 'verified_same_accepted_run', requestId: 'req-0001-alpha', expectedRevision: 0, evidence: EVIDENCE, ...patch });
const recoverInput = (eventId: string, patch: Record<string, unknown> = {}) => { const { action: _a, ...rest } = recoverBody(eventId, patch); return { actor: 'hsb-admin', ...rest }; };
const absent = (text: string, secrets: string[]) => { for (const s of secrets) assert.equal(text.includes(s), false, `leaked ${s}`); };
const noAuthorityFields = (text: string) => assert.equal(/"(token|workToken|fingerprint)"/.test(text), false, 'authority field exposed');

const rig = (seed: OrderRecord[], deps: Record<string, unknown> = {}) => {
  let now = T0;
  const memory = createSyntheticOrderTransaction(seed);
  const store = createHandoffStore(memory.transaction, () => now);
  const full = { enabled: () => true, authenticate: () => true, principal: () => 'hsb-admin', store, ...deps } as unknown as HandoffRouteDeps;
  const call = async (body: unknown, id = seed[0].id) => {
    const res = await handoffRequest(new Request('http://localhost/api/admin/orders/x/handoff', { method: 'POST', body: JSON.stringify(body) }), id, full);
    const text = await res.text(); return { status: res.status, text, json: JSON.parse(text) };
  };
  return { memory, store, call, advance: (ms: number) => { now += ms; }, now: () => now };
};
/** Previous N2 helper deps shape (`transact`), still accepted but adapted through the store. */
const legacyTransactDeps = (seed: OrderRecord) => {
  const box = { order: structuredClone(seed), calls: 0 };
  const deps = { enabled: () => true, authenticate: () => true, transact: async (_id: string, mutate: (o: OrderRecord) => { order: OrderRecord; result: unknown }) => { box.calls++; const r = mutate(structuredClone(box.order)); box.order = r.order; return r.result; } } as unknown as HandoffRouteDeps;
  return { box, deps };
};
const agentOf = (r: { memory: { snapshot: (id: string) => OrderRecord | undefined } }, id = 'ord_i1') => r.memory.snapshot(id)!.workOutbox![0].agent;

test('legacy workQueue-only order: list and claim denied via store, including old transact deps; nothing seeded', async () => {
  const r = rig([legacyOrder('ord_l1')]);
  assert.equal((await r.call({ action: 'list' })).status, 409);
  assert.equal((await r.call({ action: 'claim', eventId: 'legacy-rev', lane: 'agent', worker: 'w' })).status, 409);
  assert.equal(r.memory.stats().commits, 0); assert.equal(r.memory.snapshot('ord_l1')!.workOutbox, undefined);
  const old = legacyTransactDeps(legacyOrder('ord_l1'));
  const req = (body: unknown) => handoffRequest(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), 'ord_l1', old.deps);
  assert.equal((await req({ action: 'list' })).status, 409);
  assert.equal((await req({ action: 'claim', eventId: 'legacy-rev', lane: 'agent', worker: 'w' })).status, 409);
  assert.equal(old.box.order.workOutbox, undefined);
});

test('valid enrolled order: full N2 list projection (terminal history kept) and claim through the store', async () => {
  const o = order(); const extra = { ...o.workOutbox![0], id: 'done-1', owner: { status: 'delivered' as const, attempts: 1, receipt: 'telegram:1' }, agent: { status: 'dead_letter' as const, attempts: 6 } };
  o.workOutbox!.push(extra);
  const r = rig([o]);
  const list = await r.call({ action: 'list' });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.events.map((e: { id: string }) => e.id), [o.workOutbox![0].id, 'done-1']);
  for (const e of list.json.events) assert.deepEqual(Object.keys(e).sort(), LIST_KEYS);
  assert.deepEqual(list.json.events[1], { id: 'done-1', kind: 'new_paid_order', version: null, owner: 'delivered', agent: 'dead_letter', ownerEligible: true, agentEligible: true, revenue: 'paid', requiresAttention: true, blocked: false });
  const claim = await r.call({ action: 'claim', eventId: o.workOutbox![0].id, lane: 'agent', worker: 'w1' });
  assert.equal(claim.status, 200);
  assert.equal(claim.json.delivery.token, agentOf(r).token); assert.equal(claim.json.delivery.status, 'leased');
  assert.equal(r.memory.stats().commits, 1);
  // Recovery cannot be smuggled through the generic command path without an actor.
  await assert.rejects(r.store.command('ord_i1', { action: 'recover_accepted_run', eventId: o.workOutbox![0].id, lane: 'agent', token: 'x', workToken: 'y', receipt: 'z', attestation: 'verified_same_accepted_run' }), /recovery_requires_actor/);
  assert.equal(r.memory.stats().commits, 1);
});

test('unauthenticated or disabled requests (recovery included) make zero transactions', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  for (const deps of [{ authenticate: () => false }, { authenticate: () => false, principal: () => 'hsb-admin' }, { enabled: () => false }]) {
    const r = rig([o], deps);
    for (const body of [{ action: 'list' }, recoverBody(id), { action: 'claim', eventId: id, lane: 'agent', worker: 'w' }]) {
      const res = await r.call(body);
      assert.equal(res.status, 'enabled' in deps ? 409 : 401); absent(res.text, SECRETS);
    }
    assert.equal(r.memory.stats().transactions, 0);
  }
});

test('recovery requires a server-derived principal; body actor is ignored', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  for (const deps of [{ principal: undefined }, { principal: () => null }, { principal: () => '' }, { principal: () => 'bad principal!' }]) {
    const r = rig([o], deps);
    const res = await r.call(recoverBody(id, { actor: 'hsb-admin' }));
    assert.equal(res.status, 403); assert.equal(r.memory.stats().transactions, 0);
  }
  const r = rig([o]);
  const res = await r.call(recoverBody(id, { actor: 'eve-forged' }));
  assert.equal(res.status, 200);
  absent(res.text, [...SECRETS, 'eve-forged']);
  assert.equal(agentOf(r).recoveries![0].actor, 'hsb-admin');
  assert.equal(JSON.stringify(r.memory.snapshot('ord_i1')).includes('eve-forged'), false);
});

test('missing or invalid requestId / expectedRevision / evidence denied before any transaction', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  const r = rig([o]);
  for (const patch of [{ requestId: undefined }, { requestId: '' }, { requestId: 'a b c d e f' }, { requestId: 'x'.repeat(200) }, { requestId: 7 },
    { expectedRevision: undefined }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { expectedRevision: '0' }, { expectedRevision: 21 },
    { evidence: undefined }, { evidence: '' }, { evidence: 'x'.repeat(300) }, { evidence: 'line\nbreak' }]) {
    const res = await r.call(recoverBody(id, patch));
    assert.equal(res.status, 400, JSON.stringify(patch));
  }
  for (const patch of [{ actor: '' }, { actor: undefined }, { requestId: '' }, { expectedRevision: '0' }, { evidence: '' }]) {
    await assert.rejects(r.store.recover('ord_i1', recoverInput(id, patch) as never), /invalid_recovery/);
  }
  assert.equal(r.memory.stats().transactions, 0);
  assert.deepEqual(r.memory.snapshot('ord_i1'), o);
});

test('accepted recovery audit records exact principal, request, revision, unverified evidence and one lease', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  const r = rig([o]);
  const res = await r.call(recoverBody(id));
  assert.equal(res.status, 200); absent(res.text, SECRETS); noAuthorityFields(res.text);
  assert.deepEqual(res.json.recovery, { replayed: false, actor: 'hsb-admin', requestId: 'req-0001-alpha', expectedRevision: 0, evidenceSource: 'operator_supplied_unverified', expiresAt: T0 + WORK_LEASE_MS });
  const agent = agentOf(r);
  assert.equal(agent.status, 'delivered'); assert.equal(agent.attempts, 1); assert.equal(agent.expiresAt, T0 + WORK_LEASE_MS);
  assert.equal(agent.token, 'AGENT-TOKEN-k1'); assert.equal(agent.workToken, 'AGENT-WORK-k1');
  assert.equal(agent.recoveries!.length, 1);
  const { fingerprint, ...audit } = agent.recoveries![0] as Record<string, unknown>;
  assert.match(String(fingerprint), /^[a-f0-9]{64}$/);
  assert.deepEqual(audit, { at: T0, receipt: 'run:accepted-1', actor: 'hsb-admin', requestId: 'req-0001-alpha', expectedRevision: 0, evidence: EVIDENCE, evidenceSource: 'operator_supplied_unverified', expiresAt: T0 + WORK_LEASE_MS });
  assert.equal(validWorkFence(r.memory.snapshot('ord_i1')!, id, 'AGENT-WORK-k1', T0 + 1), true);
  assert.deepEqual(r.memory.snapshot('ord_i1')!.workOutbox![0].owner, o.workOutbox![0].owner);
  assert.equal(r.memory.stats().commits, 1);
});

test('same-request replay after subsequent expiry returns the stored outcome with no lease or audit advance', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  const r = rig([o]);
  assert.equal((await r.call(recoverBody(id))).status, 200);
  r.advance(WORK_LEASE_MS + 5);
  const before = r.memory.snapshot('ord_i1');
  const replay = await r.call(recoverBody(id));
  assert.equal(replay.status, 200); absent(replay.text, SECRETS); noAuthorityFields(replay.text);
  assert.equal(replay.json.recovery.replayed, true); assert.equal(replay.json.recovery.expiresAt, T0 + WORK_LEASE_MS);
  assert.deepEqual(r.memory.snapshot('ord_i1'), before);
  assert.equal(r.memory.stats().commits, 1);
  assert.equal(validWorkFence(r.memory.snapshot('ord_i1')!, id, 'AGENT-WORK-k1', r.now()), false);
  const direct = await r.store.recover('ord_i1', recoverInput(id) as never);
  assert.equal(direct.replayed, true); assert.equal(direct.recovery.expiresAt, T0 + WORK_LEASE_MS);
  assert.deepEqual(r.memory.snapshot('ord_i1'), before);
});

test('conflicting reuse of a consumed requestId is refused without effect', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  const r = rig([o]);
  assert.equal((await r.call(recoverBody(id))).status, 200);
  r.advance(WORK_LEASE_MS + 5);
  const before = r.memory.snapshot('ord_i1');
  for (const patch of [{ evidence: 'different evidence text' }, { expectedRevision: 1 }]) {
    const res = await r.call(recoverBody(id, patch));
    assert.equal(res.status, 409, JSON.stringify(patch)); absent(res.text, SECRETS);
  }
  await assert.rejects(r.store.recover('ord_i1', recoverInput(id, { actor: 'other-admin' }) as never), /request_conflict/);
  await assert.rejects(r.store.recover('ord_i1', recoverInput(id, { expectedRevision: 1 }) as never), /request_conflict/);
  assert.deepEqual(r.memory.snapshot('ord_i1'), before);
  assert.equal(r.memory.stats().commits, 1);
});

test('stale expected revision with a new requestId is refused; current revision proceeds once', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  const r = rig([o]);
  assert.equal((await r.call(recoverBody(id))).status, 200);
  r.advance(WORK_LEASE_MS + 5);
  const before = r.memory.snapshot('ord_i1');
  assert.equal((await r.call(recoverBody(id, { requestId: 'req-0002-bravo', expectedRevision: 0 }))).status, 409);
  await assert.rejects(r.store.recover('ord_i1', recoverInput(id, { requestId: 'req-0002-bravo', expectedRevision: 0 }) as never), /stale_revision/);
  assert.deepEqual(r.memory.snapshot('ord_i1'), before);
  const next = await r.call(recoverBody(id, { requestId: 'req-0002-bravo', expectedRevision: 1 }));
  assert.equal(next.status, 200); assert.equal(next.json.recovery.expectedRevision, 1);
  const agent = agentOf(r);
  assert.equal(agent.recoveries!.length, 2); assert.equal(agent.expiresAt, r.now() + WORK_LEASE_MS);
  assert.equal(r.memory.stats().commits, 2);
});

test('concurrent recoveries: serialized fixture and optimistic CAS barrier each admit exactly one', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  const r = rig([o]);
  const settled = await Promise.allSettled([r.store.recover('ord_i1', recoverInput(id) as never), r.store.recover('ord_i1', recoverInput(id, { requestId: 'req-0003-charlie' }) as never)]);
  assert.equal(settled.filter(s => s.status === 'fulfilled').length, 1);
  assert.match(String(((settled.find(s => s.status === 'rejected') as PromiseRejectedResult).reason as Error).message), /stale_revision/);
  assert.equal(agentOf(r).recoveries!.length, 1);
  // Optimistic CAS: both read version 0 behind a barrier before either commits; the loser re-reads and recomputes.
  let record = { order: structuredClone(o), version: 0 }; let reads = 0; let conflicts = 0; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const cas: HandoffTransaction = async (_id, mutate, _opts) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const seen = { order: structuredClone(record.order), version: record.version };
      if (++reads === 2) release();
      if (reads <= 2) await barrier;
      const outcome = await mutate(seen.order);
      if ('abort' in outcome) return outcome.abort;
      if (record.version !== seen.version) { conflicts++; continue; }
      record = { order: structuredClone(outcome.commit), version: record.version + 1 };
      return outcome.result;
    }
    throw Error('cas_exhausted');
  };
  const store = createHandoffStore(cas, () => T0);
  const raced = await Promise.allSettled([store.recover('ord_i1', recoverInput(id) as never), store.recover('ord_i1', recoverInput(id, { requestId: 'req-0004-delta' }) as never)]);
  assert.equal(raced.filter(s => s.status === 'fulfilled').length, 1);
  assert.match(String(((raced.find(s => s.status === 'rejected') as PromiseRejectedResult).reason as Error).message), /stale_revision/);
  assert.equal(conflicts, 1); assert.equal(record.version, 1);
  assert.equal(record.order.workOutbox![0].agent.recoveries!.length, 1);
});

test('no authority leakage and caller mutation of store outputs cannot change transaction state', async () => {
  const o = accepted(); const id = o.workOutbox![0].id;
  const r = rig([o]);
  await r.call(recoverBody(id));
  const list = await r.call({ action: 'list' });
  assert.equal(list.status, 200); absent(list.text, [...SECRETS, String(agentOf(r).recoveries![0].fingerprint), 'run:accepted-1']); noAuthorityFields(list.text);
  // Pass-through transaction (no cloning, like a shared cache entry): only store-side cloning protects state.
  const shared = { order: order('ord_c1') };
  const passThrough: HandoffTransaction = async (_id, mutate) => { const outcome = await mutate(shared.order); if ('abort' in outcome) return outcome.abort; shared.order = outcome.commit; return outcome.result; };
  const store = createHandoffStore(passThrough, () => T0);
  const eventId = shared.order.workOutbox![0].id;
  const claim = await store.command('ord_c1', { action: 'claim', eventId, lane: 'agent', worker: 'w' });
  const token = claim.delivery.token!;
  claim.delivery.token = 'forged'; claim.event.agent.status = 'dead_letter';
  assert.equal(shared.order.workOutbox![0].agent.token, token); assert.equal(shared.order.workOutbox![0].agent.status, 'leased');
  const shared2 = { order: accepted('ord_c2') };
  const pass2: HandoffTransaction = async (_id, mutate) => { const outcome = await mutate(shared2.order); if ('abort' in outcome) return outcome.abort; shared2.order = outcome.commit; return outcome.result; };
  const out = await createHandoffStore(pass2, () => T0).recover('ord_c2', recoverInput(shared2.order.workOutbox![0].id) as never);
  out.delivery.expiresAt = 9e15; out.recovery.actor = 'forged'; out.event.agent.recoveries!.length = 0;
  const agent = shared2.order.workOutbox![0].agent;
  assert.equal(agent.expiresAt, T0 + WORK_LEASE_MS); assert.equal(agent.recoveries![0].actor, 'hsb-admin');
});

// ---- Production-mounted route. Dependency-free loader replaces ONLY the persistence
// module (`@/lib/orders`) with a JSON-string fixture; every other module is real. ----
type Fx = ReturnType<typeof jsonOrders>;
const jsonOrders = (seed: Record<string, string>) => {
  const records = new Map<string, string>(Object.entries(seed));
  const cache = new Map<string, string>(); // models a read-your-own-writes cache
  const stats = { transactions: 0, commits: 0, fresh: [] as unknown[] };
  const withOrderTransaction = async (id: string, mutate: (o: OrderRecord) => unknown, opts: { notFound?: () => unknown; fresh?: boolean } = {}) => {
    stats.transactions++; stats.fresh.push(opts.fresh);
    const body = opts.fresh === true ? records.get(id) : cache.get(id) ?? records.get(id);
    if (body === undefined) { if (opts.notFound) return opts.notFound(); throw Error('order_not_found'); }
    const outcome = await mutate(JSON.parse(body)) as { abort: unknown } | { commit: OrderRecord; result: unknown };
    if ('abort' in outcome) return outcome.abort;
    const next = JSON.stringify(outcome.commit); records.set(id, next); cache.set(id, next); stats.commits++;
    return outcome.result;
  };
  return { withOrderTransaction, stats, records, read: (id: string) => JSON.parse(records.get(id)!) as OrderRecord,
    write: (id: string, o: OrderRecord) => records.set(id, JSON.stringify(o)), dump: () => JSON.stringify(Object.fromEntries(records)) };
};
const FIXTURE_URL = `data:text/javascript,${encodeURIComponent('export function withOrderTransaction(i, m, o) { return globalThis.__handoffOrdersFixture.withOrderTransaction(i, m, o); }')}`;
const SRC = new URL('../src/', import.meta.url);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/orders') return { url: FIXTURE_URL, shortCircuit: true };
  if (specifier.startsWith('@/')) return nextResolve(new URL(`${specifier.slice(2)}.ts`, SRC).href, context);
  return nextResolve(specifier, context);
} });

test('mounted POST route: admin principal, enrolled store, fresh binding, fixture-only JSON restart replay', async () => {
  const KEY = 'synthetic-admin-key-m1';
  process.env.HSB_ORDER_ADMIN_KEY = KEY; process.env.HSB_PAID_ORDER_OUTBOX_ENABLED = 'true';
  const now = Date.now();
  const o = accepted('ord_m1', now - 1); const id = o.workOutbox![0].id;
  let fx: Fx = jsonOrders({ ord_m1: JSON.stringify(o), ord_m2: JSON.stringify(legacyOrder('ord_m2')), ord_m3: JSON.stringify(order('ord_m3')) });
  (globalThis as Record<string, unknown>).__handoffOrdersFixture = fx;
  let route: { POST: (r: Request, c: { params: Promise<{ orderId: string }> }) => Promise<Response> };
  try { route = await import('../src/app/api/admin/orders/[orderId]/handoff/route.ts'); }
  catch (error) { assert.fail(`mounted route must load without the provider graph: ${String((error as Error).message).slice(0, 160)}`); }
  const post = async (orderId: string, body: unknown, key: string | null = KEY) => {
    const res = await route.POST(new Request(`http://localhost/api/admin/orders/${orderId}/handoff`, { method: 'POST', headers: key ? { 'x-hsb-order-admin-key': key } : {}, body: JSON.stringify(body) }), { params: Promise.resolve({ orderId }) });
    const text = await res.text(); return { status: res.status, text, json: JSON.parse(text) };
  };
  assert.equal((await post('ord_m1', { action: 'list' }, null)).status, 401);
  assert.equal((await post('ord_m1', recoverBody(id), 'wrong-key')).status, 401);
  process.env.HSB_PAID_ORDER_OUTBOX_ENABLED = 'false';
  assert.equal((await post('ord_m1', recoverBody(id))).status, 409);
  process.env.HSB_PAID_ORDER_OUTBOX_ENABLED = 'true';
  assert.equal(fx.stats.transactions, 0);
  assert.equal((await post('ord_m2', { action: 'list' })).status, 409);
  assert.equal((await post('ord_m2', { action: 'claim', eventId: 'legacy-rev', lane: 'agent', worker: 'w' })).status, 409);
  assert.equal(fx.stats.commits, 0);
  const list = await post('ord_m1', { action: 'list' });
  assert.equal(list.status, 200); absent(list.text, SECRETS);
  for (const e of list.json.events) assert.deepEqual(Object.keys(e).sort(), LIST_KEYS);
  const rec = await post('ord_m1', recoverBody(id, { actor: 'eve-forged' }));
  assert.equal(rec.status, 200); absent(rec.text, [...SECRETS, 'eve-forged']); noAuthorityFields(rec.text);
  const audit = fx.read('ord_m1').workOutbox![0].agent.recoveries![0];
  assert.deepEqual([audit.actor, audit.requestId, audit.expectedRevision, audit.evidence, audit.evidenceSource], ['hsb-admin', 'req-0001-alpha', 0, EVIDENCE, 'operator_supplied_unverified']);
  // Fresh binding: a stale cached record must never decide. External refund after a committed claim.
  assert.equal((await post('ord_m3', { action: 'claim', eventId: order('ord_m3').workOutbox![0].id, lane: 'agent', worker: 'w' })).status, 200);
  fx.write('ord_m3', { ...fx.read('ord_m3'), refundedAt: '2026-10-21T01:00:00.000Z', stripeRefundId: 're_synthetic' });
  const refunded = await post('ord_m3', { action: 'list' });
  assert.equal(refunded.json.events[0].ownerEligible, false);
  assert.equal((await post('ord_m3', { action: 'claim', eventId: order('ord_m3').workOutbox![0].id, lane: 'owner', worker: 'w' })).status, 409);
  assert.ok(fx.stats.fresh.length > 0 && fx.stats.fresh.every(f => f === true), 'every mounted transaction is bound fresh');
  // Fixture-only durable JSON roundtrip "restart" (not real orders persistence); then the lease lapses.
  fx = jsonOrders(JSON.parse(fx.dump())); (globalThis as Record<string, unknown>).__handoffOrdersFixture = fx;
  const lapsed = fx.read('ord_m1'); lapsed.workOutbox![0].agent.expiresAt = 1; fx.write('ord_m1', lapsed);
  const replay = await post('ord_m1', recoverBody(id));
  assert.equal(replay.status, 200); assert.equal(replay.json.recovery.replayed, true); absent(replay.text, SECRETS);
  assert.equal(fx.read('ord_m1').workOutbox![0].agent.expiresAt, 1);
  assert.equal(fx.read('ord_m1').workOutbox![0].agent.recoveries!.length, 1);
  assert.equal(fx.stats.commits, 0);
  assert.equal((await post('ord_m1', recoverBody(id, { evidence: 'conflicting reuse' }))).status, 409);
  assert.equal(fx.stats.commits, 0);
});
