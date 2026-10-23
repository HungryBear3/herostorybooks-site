import test from 'node:test';
import assert from 'node:assert/strict';
import { paidEvent, validWorkFence, type Lane } from '../src/lib/paid-order-outbox.ts';
import { handoffRequest, type HandoffRouteDeps } from '../src/lib/paid-order-handoff-route.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
// Synthetic in-memory transact only; no production DB, real orders or transports.
const base = () => { const o = { id: 'ord_secrecy', paymentStatus: 'paid', status: 'order_received', fulfillmentMode: 'manual_hold', stripeSessionId: 'cs_secrecy', settledAmountCents: 3900 } as OrderRecord; o.workOutbox = [paidEvent(o, '2026-10-21')]; return o; };
const memory = (initial: OrderRecord, overrides: Partial<HandoffRouteDeps> = {}) => {
  const box = { order: structuredClone(initial), calls: 0 };
  const deps: HandoffRouteDeps = { enabled: () => true, authenticate: () => true, transact: async (_id, mutate) => { box.calls++; const r = mutate(structuredClone(box.order)); box.order = r.order; return r.result; }, ...overrides };
  return { box, deps };
};
const call = async (deps: HandoffRouteDeps, body: unknown) => { const res = await handoffRequest(new Request('http://localhost/api/handoff', { method: 'POST', body: JSON.stringify(body) }), 'ord_secrecy', deps); const text = await res.text(); return { status: res.status, text, json: JSON.parse(text) }; };
const absent = (text: string, secrets: string[]) => { for (const s of secrets) assert.equal(text.includes(s), false, `response leaked ${s}`); };
const other = (lane: Lane): Lane => lane === 'owner' ? 'agent' : 'owner';

for (const lane of ['owner', 'agent'] as const) {
  test(`${lane} lane responses never contain opposite-lane secrets; tokens only on claim`, async () => {
    const opp = other(lane); const o = base(); const id = o.workOutbox![0].id;
    const oppSecrets = [`OPP-${opp}-TOKEN-x9`, `OPP-${opp}-WORK-x9`, `OPP-${opp}-RECEIPT-x9`, `OPP-${opp}-WORKER-x9`];
    o.workOutbox![0][opp] = { status: 'leased', attempts: 1, worker: oppSecrets[3], token: oppSecrets[0], workToken: oppSecrets[1], expiresAt: Date.now() + 1e9, receipt: oppSecrets[2] };
    const preloadOpp = structuredClone(o.workOutbox![0][opp]);
    const { box, deps } = memory(o);

    const claim = await call(deps, { action: 'claim', eventId: id, lane, worker: 'w1' });
    assert.equal(claim.status, 200);
    absent(claim.text, oppSecrets);
    assert.equal(claim.json.event.id, id); assert.equal(claim.json.event.kind, 'new_paid_order');
    assert.equal('owner' in claim.json.event, false); assert.equal('agent' in claim.json.event, false);
    const stored = box.order.workOutbox![0][lane];
    assert.ok(stored.token && stored.workToken);
    assert.equal(claim.json.delivery.token, stored.token); assert.equal(claim.json.delivery.workToken, stored.workToken);
    assert.equal(claim.json.delivery.status, 'leased');
    const own = [stored.token!, stored.workToken!];

    for (const body of [
      { action: 'renew', eventId: id, lane, token: own[0] },
      { action: 'ambiguous', eventId: id, lane, token: own[0] },
      { action: 'ack', eventId: id, lane, token: own[0], receipt: `${lane}:receipt1` },
      { action: 'list' },
    ]) {
      const r = await call(deps, body);
      assert.equal(r.status, 200, body.action);
      absent(r.text, [...oppSecrets, ...own]);
      assert.equal(/"(token|workToken)"/.test(r.text), false, `${body.action} exposed a token field`);
    }
    // Durable fences are retained, not erased by response projection.
    assert.equal(box.order.workOutbox![0][lane].token, own[0]);
    assert.equal(box.order.workOutbox![0][lane].workToken, own[1]);
    assert.equal(box.order.workOutbox![0][lane].status, 'delivered');
    assert.deepEqual(box.order.workOutbox![0][opp], preloadOpp);
  });
}

test('recover_accepted_run response exposes no token, workToken or owner-lane secrets', async () => {
  const o = base(); const id = o.workOutbox![0].id;
  o.workOutbox![0].owner = { status: 'leased', attempts: 1, token: 'OWNER-TOKEN-r7', workToken: 'OWNER-WORK-r7', expiresAt: Date.now() + 1e9 };
  o.workOutbox![0].agent = { status: 'delivered', attempts: 1, worker: 'w', token: 'AGENT-TOKEN-r7', workToken: 'AGENT-WORK-r7', receipt: 'run:accepted', expiresAt: 0 };
  // Recovery now requires a server-derived principal plus requestId/expectedRevision/evidence.
  const { box, deps } = memory(o, { principal: () => 'hsb-admin' });
  const r = await call(deps, { action: 'recover_accepted_run', eventId: id, lane: 'agent', token: 'AGENT-TOKEN-r7', workToken: 'AGENT-WORK-r7', receipt: 'run:accepted', attestation: 'verified_same_accepted_run', requestId: 'req-secrecy-r7', expectedRevision: 0, evidence: 'synthetic operator check' });
  assert.equal(r.status, 200);
  absent(r.text, ['OWNER-TOKEN-r7', 'OWNER-WORK-r7', 'AGENT-TOKEN-r7', 'AGENT-WORK-r7']);
  assert.equal(r.json.delivery.status, 'delivered');
  assert.equal(box.order.workOutbox![0].agent.token, 'AGENT-TOKEN-r7');
  assert.equal(validWorkFence(box.order, id, 'AGENT-WORK-r7', Date.now()), true);
});

test('failures, default-off and auth stay fail-closed and secret-free', async () => {
  const o = base(); const id = o.workOutbox![0].id;
  o.workOutbox![0].agent = { status: 'leased', attempts: 1, token: 'LIVE-TOKEN-f3', workToken: 'LIVE-WORK-f3', expiresAt: Date.now() + 1e9 };
  const secrets = ['LIVE-TOKEN-f3', 'LIVE-WORK-f3'];
  const { box, deps } = memory(o);
  const before = structuredClone(box.order);
  const stale = await call(deps, { action: 'ack', eventId: id, lane: 'agent', token: 'wrong', receipt: 'run:1' });
  assert.equal(stale.status, 409); absent(stale.text, secrets);
  const busy = await call(deps, { action: 'claim', eventId: id, lane: 'agent', worker: 'w2' });
  assert.equal(busy.status, 409); absent(busy.text, secrets);
  assert.deepEqual(box.order, before);
  const calls = box.calls;
  assert.equal((await call(memory(o, { enabled: () => false }).deps, { action: 'list' })).status, 409);
  const off = memory(o, { enabled: () => false }); await call(off.deps, { action: 'list' }); assert.equal(off.box.calls, 0);
  const unauth = memory(o, { authenticate: () => false }); const u = await call(unauth.deps, { action: 'list' });
  assert.equal(u.status, 401); assert.equal(unauth.box.calls, 0); absent(u.text, secrets);
  assert.equal(box.calls, calls);
});
