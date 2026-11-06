// SYNTHETIC custody tests for the four classroom financial custody fields.
// Two order-store backends: the REAL local filesystem adapter (labelled
// "local") under the owned runtime root, and an in-memory hosted adapter fake
// installed through the existing adapter test seam (labelled "hosted"). No
// provider, network, Blob or customer data is touched.
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';

// Owned fixture runtime: inherited HOME/TMPDIR must be existing canonical
// directories confined to the owned runtime, validated before any app import.
const OWNED_RUNTIME = '/Users/abigailclaw/.hermes/cache/scratch/hsb-suite-fixture-correction-runtime-20261029';
function ownedRuntime(sub: string): string {
  const owned = realpathSync(OWNED_RUNTIME);
  assert.equal(owned, OWNED_RUNTIME, 'owned runtime path is canonical');
  for (const name of ['HOME', 'TMPDIR'] as const) {
    const value = (process.env[name] ?? '').replace(/\/+$/, '');
    assert.ok(value && path.isAbsolute(value), `${name} must be absolute`);
    assert.equal(realpathSync(value), value, `${name} must be canonical`);
    assert.ok(statSync(value).isDirectory(), `${name} must be an existing directory`);
    assert.ok(value === owned || value.startsWith(`${owned}${path.sep}`), `${name} must be confined to the owned runtime`);
  }
  const dir = path.join((process.env.TMPDIR as string).replace(/\/+$/, ''), sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const RUNTIME = ownedRuntime('classroom-settlement-custody');
process.env.TMPDIR = RUNTIME;
const STORE = path.join(RUNTIME, `custody-${process.pid}-${Date.now()}`);
mkdirSync(STORE, { recursive: true });
process.env.HSB_ORDER_STORE_DIR = STORE;
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
for (const name of ['VERCEL', 'VERCEL_ENV', 'BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_NAMESPACE', 'HSB_PAID_ORDER_OUTBOX_ENABLED']) delete process.env[name];
globalThis.fetch = (async () => { throw new TypeError('synthetic_network_denied'); }) as typeof fetch;

// Inline 'stripe' module mock: subclass of the REAL SDK whose events and
// checkout.sessions resources read an in-memory SYNTHETIC provider, so the
// actual private producer (recordClassroomFinancialEvent) settles fixture
// records. Never real settlement; no request leaves the process.
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_classroom_custody_only';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const synthetic = { events: new Map<string, Obj>(), sessions: new Map<string, Obj>() };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RealStripe: any = (await import('stripe')).default;
class SyntheticStripe extends RealStripe {
  constructor(...args: unknown[]) {
    super(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    self.events = { retrieve: async (id: string) => { const e = synthetic.events.get(id); if (!e) throw new Error('no_event'); return structuredClone(e); } };
    self.checkout = { sessions: { retrieve: async (id: string) => { const s = synthetic.sessions.get(id); if (!s) throw new Error('no_session'); return structuredClone(s); }, create: async () => { throw new Error('forbidden'); } } };
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });

// Inline assembly mock (current manifest valid) so the private reservation's
// actual assembly check admits the synthetic binding; no Blob/roster I/O.
const assemblyUrl = new URL('../src/lib/group-book/assembly.ts', import.meta.url).href;
const realAssembly = await import(assemblyUrl);
mock.module(assemblyUrl, { namedExports: { ...realAssembly, assertClassroomAssemblyCurrent: async () => ({ ok: true }) } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orders: any = await import('../src/lib/orders.ts');

const FIELDS = ['classroomAcceptedTerms', 'classroomAcceptedSession', 'classroomFinancialReceipt', 'classroomFinancialReconciliation'] as const;
const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const BINDING = { schemaVersion: 1, cohortId: 'synthetic_cohort', digest: 'a'.repeat(64), participantCount: 3, expiresAt: FUTURE };

// ---- hosted adapter fake (in-memory, CAS semantics) -----------------------
const hostedRecords = new Map<string, { body: string; version: string }>();
let hostedSeq = 0;
const hostedAdapter = {
  kind: 'synthetic-hosted-fake',
  async readVersioned(p: string) { const r = hostedRecords.get(p); return r ? { ...r } : null; },
  async createIfAbsent(p: string, body: string) {
    if (hostedRecords.has(p)) return { ok: false as const, reason: 'exists' as const };
    const version = `v${++hostedSeq}`; hostedRecords.set(p, { body, version }); return { ok: true as const, version };
  },
  async replaceIfVersion(p: string, body: string, expected: string) {
    const r = hostedRecords.get(p);
    if (!r || r.version !== expected) return { ok: false as const, reason: 'version_conflict' as const };
    const version = `v${++hostedSeq}`; hostedRecords.set(p, { body, version }); return { ok: true as const, version };
  },
};
type Backend = 'local' | 'hosted';
function useBackend(backend: Backend) {
  orders.__resetOrderStoreAdapterFactoryForTests();
  if (backend === 'hosted') {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_syntheticcustody_fixture';
    orders.__setOrderStoreAdapterFactoryForTests(() => hostedAdapter);
  } else {
    delete process.env.BLOB_READ_WRITE_TOKEN;
  }
}
async function rawOf(id: string): Promise<{ body: string; version: string }> {
  const v = await orders.readOrderVersioned(id);
  assert.ok(v, 'record found');
  return { body: JSON.stringify(v.order), version: v.version };
}

let seq = 0;
function freshId() { seq += 1; return `ord_${(Date.now().toString(16) + seq.toString(16).padStart(4, '0')).slice(-16).padStart(16, '0')}`; }
function baseOrder(id: string, bound: boolean) {
  const order = orders.createOrderRecord({ email: 'synthetic@example.invalid', bookFormat: 'digital', childName: 'SYNTH' }, { id, fulfillmentMode: 'manual_hold' });
  if (bound) order.groupBookAssembly = { ...BINDING };
  return order;
}
const terms = (id: string) => ({
  schemaVersion: 1, orderId: id, groupBookAssembly: { ...BINDING }, cohortId: BINDING.cohortId, manifestDigest: BINDING.digest,
  manifestExpiresAt: BINDING.expiresAt, bookFormat: 'digital', priceCents: 2999, currency: 'usd', discountAmountCents: 2999,
  expectedAmountTotalCents: 0, provider: 'stripe', providerAccount: 'platform', livemode: false, mode: 'payment',
  metadataKind: 'hsb_classroom_zero_total_test', dispatchAttemptId: '00000000-0000-4000-8000-000000000001',
  idempotencyKey: `synthetic-${id}`, reservedAt: '2026-10-29T00:00:00.000Z', sessionBindingPolicy: 'single_session_for_dispatch',
});
const valueFor = (field: typeof FIELDS[number], id: string): unknown => {
  if (field === 'classroomAcceptedTerms') return terms(id);
  if (field === 'classroomAcceptedSession') return { schemaVersion: 1, orderId: id, dispatchAttemptId: '00000000-0000-4000-8000-000000000001', sessionId: 'cs_test_synthetic_forged', providerAccount: 'platform', livemode: false };
  if (field === 'classroomFinancialReceipt') return { schemaVersion: 1, provider: 'stripe', providerEventId: 'evt_forged', sessionId: 'cs_test_synthetic_forged', orderId: id, amountTotalCents: 0 };
  return [{ schemaVersion: 1, reason: 'missing_accepted_terms', providerEventId: 'evt_forged', orderId: id }];
};

// The five generic sinks, each committing a caller-built proposal.
type Sink = 'persistOrder' | 'persistOrderLocalRetry' | 'commitOrderConditional' | 'withOrderTransaction' | 'withOrderTransactionInNamespace';
const SINKS: Sink[] = ['persistOrder', 'persistOrderLocalRetry', 'commitOrderConditional', 'withOrderTransaction', 'withOrderTransactionInNamespace'];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeVia(sink: Sink, id: string, edit: (o: any) => any): Promise<'committed' | 'rejected'> {
  try {
    if (sink === 'persistOrder' || sink === 'persistOrderLocalRetry') {
      const current = (await orders.readOrderVersioned(id)).order;
      await orders.persistOrder(edit(current));
    } else if (sink === 'commitOrderConditional') {
      const v = await orders.readOrderVersioned(id);
      const r = await orders.commitOrderConditional(edit(v.order), v.version);
      if (!r.ok) return 'rejected';
    } else if (sink === 'withOrderTransaction') {
      await orders.withOrderTransaction(id, (c: unknown) => ({ commit: edit(c), result: true }));
    } else {
      const b = orders.bindOrderNamespace('');
      assert.equal(b.ok, true);
      const r = await orders.withOrderTransactionInNamespace(b.binding, id, (c: unknown) => ({ commit: edit(c), result: true }), { notFound: () => false });
      if (r.status !== 'committed') return 'rejected';
    }
    return 'committed';
  } catch {
    return 'rejected';
  }
}

test('W01_all_five_writers_protect_raw_custody', async () => {
  const results: string[] = [];
  for (const backend of ['hosted', 'local'] as Backend[]) {
    useBackend(backend);
    for (const sink of SINKS) {
      for (const field of FIELDS) {
        // ADD on an empty (absent) baseline must be denied.
        const id = freshId();
        await orders.persistNewOrder(baseOrder(id, true));
        const before = await rawOf(id);
        const add = await writeVia(sink, id, (o) => ({ ...o, [field]: valueFor(field, id), updatedAt: new Date().toISOString() }));
        assert.equal(add, 'rejected', `${backend}/${sink}/${field}: generic add denied`);
        assert.equal((await rawOf(id)).body, before.body, `${backend}/${sink}/${field}: raw bytes unchanged after denied add`);
        // Unchanged roundtrip allowed.
        const same = await writeVia(sink, id, (o) => ({ ...o, updatedAt: new Date().toISOString() }));
        assert.equal(same, 'committed', `${backend}/${sink}/${field}: unchanged roundtrip allowed`);
        results.push(`${backend}/${sink}/${field}/add`);
      }
    }
  }
  // Remove / replace / nested in-place on a record that already holds custody
  // (seeded through the private settlement path in the accounting test; here
  // through the exported reservation command, the only terms producer).
  assert.equal(typeof orders.reserveClassroomCheckoutTerms, 'function', 'orders.ts exports the reservation command');
  for (const backend of ['hosted', 'local'] as Backend[]) {
    useBackend(backend);
    for (const sink of SINKS) {
      const id = freshId();
      const seed = baseOrder(id, true);
      seed.priceCents = 2999;
      await orders.persistNewOrder(seed);
      const reserved = await orders.reserveClassroomCheckoutTerms(id, {
        guard: async () => null,
        dispatch: { schemaVersion: 1, attemptId: '00000000-0000-4000-8000-0000000000aa', idempotencyKey: orders.checkoutProviderIdempotencyKey(id), reservedAt: new Date().toISOString() },
      });
      assert.equal(reserved.ok, true, `${backend}/${sink}: reservation committed`);
      const bound = await orders.bindClassroomCheckoutSession(id, { dispatchAttemptId: '00000000-0000-4000-8000-0000000000aa', sessionId: `cs_test_synthetic_custody_${seq}`, guard: async () => null });
      assert.equal(bound.ok, true, `${backend}/${sink}: accepted Session bound`);
      const baseline = await rawOf(id);
      const parsed = JSON.parse(baseline.body);
      assert.equal(parsed.classroomAcceptedTerms.priceCents, 2999);
      for (const [label, edit] of [
        ['terms-remove', (o: Record<string, unknown>) => { const n = { ...o }; delete n.classroomAcceptedTerms; return n; }],
        ['terms-replace', (o: Record<string, unknown>) => ({ ...o, classroomAcceptedTerms: { ...(o.classroomAcceptedTerms as object), priceCents: 1 } })],
        ['terms-nested-in-place', (o: Record<string, Record<string, unknown>>) => { o.classroomAcceptedTerms.discountAmountCents = 1; o.classroomAcceptedTerms.groupBookAssembly = { ...BINDING, participantCount: 4 }; return o; }],
        ['session-remove', (o: Record<string, unknown>) => { const n = { ...o }; delete n.classroomAcceptedSession; return n; }],
        ['session-replace', (o: Record<string, unknown>) => ({ ...o, classroomAcceptedSession: { ...(o.classroomAcceptedSession as object), sessionId: 'cs_test_other' } })],
        ['session-nested-in-place', (o: Record<string, Record<string, unknown>>) => { o.classroomAcceptedSession.livemode = true as unknown as Record<string, unknown>; return o; }],
        ['session-id-divergence', (o: Record<string, unknown>) => ({ ...o, stripeSessionId: 'cs_test_diverged' })],
        ['receipt-add', (o: Record<string, unknown>) => ({ ...o, classroomFinancialReceipt: valueFor('classroomFinancialReceipt', id) })],
        ['generic-reconciliation-append', (o: Record<string, unknown>) => ({ ...o, classroomFinancialReconciliation: valueFor('classroomFinancialReconciliation', id) })],
      ] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outcome = await writeVia(sink, id, edit as any);
        assert.equal(outcome, 'rejected', `${backend}/${sink}/${label} denied`);
        assert.equal((await rawOf(id)).body, baseline.body, `${backend}/${sink}/${label}: raw pre-callback bytes preserved`);
        results.push(`${backend}/${sink}/${label}`);
      }
    }
  }
  assert.equal(results.length, 2 * 5 * 4 + 2 * 5 * 9);
  process.stdout.write(`SUBCASE W01 executed=${results.length}\n`);

  // Producer-settled receipt + observation records (actual private producer),
  // then every generic sink on both backends: remove / replace / nested in-place / append.
  const settledLedger: string[] = [];
  let eventSeq = 0;
  for (const backend of ['hosted', 'local'] as Backend[]) {
    useBackend(backend);
    for (const sink of SINKS) {
      const id = freshId();
      const seed = baseOrder(id, true);
      await orders.persistNewOrder(seed);
      const attemptId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      assert.equal((await orders.reserveClassroomCheckoutTerms(id, { guard: async () => null, dispatch: { schemaVersion: 1, attemptId, idempotencyKey: orders.checkoutProviderIdempotencyKey(id), reservedAt: new Date().toISOString() } })).ok, true);
      const sessionId = `cs_test_synthetic_settled_${seq}`;
      assert.equal((await orders.bindClassroomCheckoutSession(id, { dispatchAttemptId: attemptId, sessionId, guard: async () => null })).ok, true);
      const price = (await orders.readOrderVersioned(id)).order.priceCents;
      synthetic.sessions.set(sessionId, {
        id: sessionId, livemode: false, mode: 'payment', status: 'complete', payment_status: 'no_payment_required',
        amount_subtotal: price, amount_total: 0, total_details: { amount_discount: price }, currency: 'usd', client_reference_id: id, payment_intent: null,
        metadata: { kind: 'hsb_classroom_zero_total_test', orderId: id, cohortId: BINDING.cohortId, manifestDigest: BINDING.digest, manifestExpiresAt: BINDING.expiresAt },
      });
      const mkEvent = () => { eventSeq += 1; const eid = `evt_synthetic_custody_${eventSeq}`; synthetic.events.set(eid, { id: eid, object: 'event', type: 'checkout.session.completed', livemode: false, created: 1_777_000_000 + eventSeq, data: { object: { id: sessionId } } }); return eid; };
      const first = await orders.recordClassroomFinancialEvent(mkEvent());
      assert.equal(first.status, 200, `${backend}/${sink}: producer receipt ${JSON.stringify(first.body)}`);
      const conflict = await orders.recordClassroomFinancialEvent(mkEvent());
      assert.equal(conflict.status, 409, `${backend}/${sink}: producer conflict observation`);
      const baseline = await rawOf(id);
      const settled = JSON.parse(baseline.body);
      assert.ok(settled.classroomFinancialReceipt, 'producer-settled receipt present');
      assert.equal(settled.classroomFinancialReconciliation.length, 1, 'producer observation present');
      for (const [label, edit] of [
        ['receipt-remove', (o: Obj) => { const n = { ...o }; delete n.classroomFinancialReceipt; return n; }],
        ['receipt-replace', (o: Obj) => ({ ...o, classroomFinancialReceipt: { ...o.classroomFinancialReceipt, providerEventId: 'evt_forged' } })],
        ['receipt-nested-in-place', (o: Obj) => { o.classroomFinancialReceipt.amountSubtotalCents = 1; return o; }],
        ['observation-remove', (o: Obj) => { const n = { ...o }; delete n.classroomFinancialReconciliation; return n; }],
        ['observation-replace', (o: Obj) => ({ ...o, classroomFinancialReconciliation: [{ ...o.classroomFinancialReconciliation[0], reason: 'missing_accepted_terms' }] })],
        ['observation-nested-in-place', (o: Obj) => { o.classroomFinancialReconciliation[0].metadata.cohortId = 'forged'; return o; }],
        ['observation-append', (o: Obj) => ({ ...o, classroomFinancialReconciliation: [...o.classroomFinancialReconciliation, { ...o.classroomFinancialReconciliation[0], providerEventId: 'evt_forged_append' }] })],
        ['observation-truncate', (o: Obj) => ({ ...o, classroomFinancialReconciliation: [] })],
      ] as const) {
        const outcome = await writeVia(sink, id, edit);
        assert.equal(outcome, 'rejected', `${backend}/${sink}/${label}`);
        assert.equal((await rawOf(id)).body, baseline.body, `${backend}/${sink}/${label}: raw settled custody preserved`);
        settledLedger.push(`${backend}/${sink}/${label}`);
        process.stdout.write(`SUBCASE W01 settled ${backend}/${sink}/${label} rejected\n`);
      }
      // Unchanged roundtrip of a settled record stays allowed.
      assert.equal(await writeVia(sink, id, (o) => ({ ...o, queueStatusNote: `settled-${sink}` })), 'committed', `${backend}/${sink}: unchanged custody roundtrip`);
    }
  }
  assert.equal(settledLedger.length, 2 * 5 * 8);
  process.stdout.write(`SUBCASE W01 settled executed=${settledLedger.length}\n`);
});

test('W02_create_namespace_retry_and_stale_proposals', async () => {
  for (const backend of ['hosted', 'local'] as Backend[]) {
    useBackend(backend);
    // persistNewOrder preseeded custody denied; binding alone permitted.
    for (const field of FIELDS) {
      const id = freshId();
      const preseeded = { ...baseOrder(id, true), [field]: valueFor(field, id) };
      await assert.rejects(orders.persistNewOrder(preseeded), `${backend}: persistNewOrder refuses preseeded ${field}`);
      assert.equal(await orders.readOrderVersioned(id), null, `${backend}: nothing created for ${field}`);
    }
    const okId = freshId();
    await orders.persistNewOrder(baseOrder(okId, true));
    assert.ok(await orders.readOrderVersioned(okId), `${backend}: bound legacy creation permitted`);

    // Stale version refused.
    const v1 = await orders.readOrderVersioned(okId);
    await orders.withOrderTransaction(okId, (c: Record<string, unknown>) => ({ commit: { ...c, updatedAt: new Date(Date.now() + 1000).toISOString() }, result: true }));
    const stale = await orders.commitOrderConditional({ ...v1.order, updatedAt: new Date().toISOString() }, v1.version);
    assert.equal(stale.ok, false, `${backend}: stale version refused`);

    // Callback namespace drift: the captured namespace stays fixed.
    const b = orders.bindOrderNamespace('');
    const drift = await orders.withOrderTransactionInNamespace(b.binding, okId, (c: Record<string, unknown>) => {
      process.env.HSB_BLOB_NAMESPACE = 'synthetic-drift';
      return { commit: { ...c, updatedAt: new Date().toISOString() }, result: true };
    }, { notFound: () => false });
    delete process.env.HSB_BLOB_NAMESPACE;
    assert.equal(drift.status, 'committed');
    assert.deepEqual([...new Set(drift.provenance.commitPaths)], [drift.provenance.recordPath], `${backend}: no namespace drift`);

    // Retry uses a new raw version each attempt.
    let calls = 0;
    await orders.withOrderTransaction(okId, async (c: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) await orders.persistOrder({ ...c, updatedAt: new Date(Date.now() + 5000).toISOString(), queueStatusNote: 'racer' });
      return { commit: { ...c, updatedAt: new Date(Date.now() + 9000).toISOString() }, result: true };
    });
    assert.equal(calls, 2, `${backend}: forced CAS retry re-read`);
    assert.equal((await orders.readOrderVersioned(okId)).order.queueStatusNote, 'racer', `${backend}: retry carried the fresh raw record`);

    // Getter / toJSON on a custody field rejected without execution.
    let executed = 0;
    for (const variant of ['getter', 'toJSON'] as const) {
      const current = (await orders.readOrderVersioned(okId)).order;
      const proposal: Record<string, unknown> = { ...current };
      if (variant === 'getter') Object.defineProperty(proposal, 'classroomFinancialReceipt', { enumerable: true, get() { executed += 1; return undefined; } });
      else proposal.classroomFinancialReceipt = { toJSON() { executed += 1; return undefined; } };
      await assert.rejects(orders.persistOrder(proposal), `${backend}: ${variant} proposal rejected`);
    }
    assert.equal(executed, 0, `${backend}: accessor/toJSON never executed`);

    // Generic payment settlement cannot mint a receipt or accepted Session.
    const payId = freshId();
    const pay = baseOrder(payId, true);
    pay.stripeSessionId = 'cs_test_synthetic_generic';
    await orders.persistNewOrder(pay);
    await orders.settleOrderPayment(payId, { stripeSessionId: 'cs_test_synthetic_generic', settledAmountCents: 0 });
    const after = JSON.parse(JSON.stringify((await orders.readOrderVersioned(payId)).order));
    for (const field of FIELDS) assert.equal(Object.hasOwn(after, field), false, `${backend}: settleOrderPayment minted no ${field}`);
  }
  // Private authority is not exported and cannot be replayed.
  for (const name of Object.keys(orders)) assert.doesNotMatch(name, /token|witness|capability|privileged|commitClassroom/i, `no exported authority: ${name}`);
});

test('W03_legacy_hold_and_retail_control', async () => {
  assert.equal(typeof orders.isClassroomReleaseHeld, 'function', 'shared hold helper exported');
  for (const backend of ['hosted', 'local'] as Backend[]) {
    useBackend(backend);
    const variants: [string, (o: Record<string, unknown>) => void][] = [
      ['absent-additive-fields', () => {}],
      ['paid-auto', (o) => { o.paymentStatus = 'paid'; o.fulfillmentMode = 'auto'; }],
      ['terminal', (o) => { o.status = 'delivered'; o.paymentStatus = 'refunded'; }],
    ];
    for (const [label, mutate] of variants) {
      const id = freshId();
      const o = baseOrder(id, true);
      mutate(o);
      await orders.persistNewOrder(o);
      const stored = (await orders.readOrderVersioned(id)).order;
      for (const field of FIELDS) assert.equal(Object.hasOwn(stored, field), false);
      assert.equal(orders.isClassroomReleaseHeld(stored), true, `${backend}/${label} held`);
      for (const sink of SINKS) {
        assert.equal(await writeVia(sink, id, (c) => { const n = { ...c }; delete n.groupBookAssembly; return n; }), 'rejected', `${backend}/${label}/${sink}: binding removal denied`);
        assert.equal(await writeVia(sink, id, (c) => ({ ...c, groupBookAssembly: { ...BINDING, participantCount: 9 } })), 'rejected', `${backend}/${label}/${sink}: binding change denied`);
      }
      assert.equal(orders.isClassroomReleaseHeld((await orders.readOrderVersioned(id)).order), true);
    }
    // Malformed/null binding presence is still a hold (direct object; the store refuses to persist it).
    assert.equal(orders.isClassroomReleaseHeld({ ...baseOrder(freshId(), false), groupBookAssembly: null }), true);
    assert.equal(orders.isClassroomReleaseHeld({ ...baseOrder(freshId(), false), groupBookAssembly: { bogus: true } }), true);
    // Unbound retail stays functional and unheld, regardless of mode.
    const retail = freshId();
    const r = baseOrder(retail, false);
    r.fulfillmentMode = 'auto';
    await orders.persistNewOrder(r);
    assert.equal(orders.isClassroomReleaseHeld((await orders.readOrderVersioned(retail)).order), false);
    for (const sink of SINKS) assert.equal(await writeVia(sink, retail, (c) => ({ ...c, queueStatusNote: `retail-${sink}` })), 'committed', `${backend}: retail ${sink}`);
  }
  useBackend('local');
});

// ── F3: classroom-held confirmation-email fencing ──────────────────────────
// Bound PAID records come only from the real private settlement producer
// (reserve -> bind -> recordClassroomFinancialEvent) persisted on the real local
// store. Delivery, the claim transaction, sweep, kickoff and frozen dispatch run
// unmodified; the provider send, the frozen transport and the envelope blob seam
// are the only fakes. Unbound retail records are labelled fixtures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const confirmationDelivery: any = await import('../src/lib/confirmation-email-delivery.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const confirmationSweep: any = await import('../src/lib/confirmation-email-sweep.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const confirmationKickoff: any = await import('../src/lib/order-confirmation-kickoff.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const envelopeProducer: any = await import('../src/lib/confirmation-envelope-producer.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const frozenDispatch: any = await import('../src/lib/confirmation-email-dispatch.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const envelopeLib: any = await import('../src/lib/confirmation-email-envelope.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const envelopeConfig: any = await import('../src/lib/confirmation-envelope-config.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orderEmailLib: any = await import('../src/lib/order-email.ts');

const F3_HELD = 'classroom_release_held';
const F3_STALE_MS = confirmationDelivery.CONFIRMATION_EMAIL_CLAIM_STALE_MS as number;
const F3_WRITER_ENV = Object.freeze({
  HSB_CONFIRMATION_ENVELOPE_WRITER: 'true',
  HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: '2026-09-21T12:48:51.665Z',
  HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: 'vercel_blob_rw_SYNTHETICf3store01_SYNTHETICsecret000003',
  HSB_CONFIRMATION_FROZEN_DISPATCH: 'true',
});
const f3Quiet = () => {};
const f3Now = () => Date.now() + 1_000;

async function f3Stored(id: string): Promise<Obj> {
  return JSON.parse(JSON.stringify((await orders.readOrderVersioned(id)).order)) as Obj;
}

async function f3SettledClassroomOrder(): Promise<string> {
  useBackend('local');
  const id = freshId();
  await orders.persistNewOrder(baseOrder(id, true));
  const attemptId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const reserved = await orders.reserveClassroomCheckoutTerms(id, {
    guard: async () => null,
    dispatch: { schemaVersion: 1, attemptId, idempotencyKey: orders.checkoutProviderIdempotencyKey(id), reservedAt: new Date().toISOString() },
  });
  assert.equal(reserved.ok, true, 'F3 fixture: real classroom reservation');
  const sessionId = `cs_test_synthetic_f3_${seq}`;
  const bound = await orders.bindClassroomCheckoutSession(id, { dispatchAttemptId: attemptId, sessionId, guard: async () => null });
  assert.equal(bound.ok, true, 'F3 fixture: real classroom bind');
  const price = (await orders.readOrderVersioned(id)).order.priceCents;
  synthetic.sessions.set(sessionId, {
    id: sessionId, livemode: false, mode: 'payment', status: 'complete', payment_status: 'no_payment_required',
    amount_subtotal: price, amount_total: 0, total_details: { amount_discount: price }, currency: 'usd', client_reference_id: id, payment_intent: null,
    metadata: { kind: 'hsb_classroom_zero_total_test', orderId: id, cohortId: BINDING.cohortId, manifestDigest: BINDING.digest, manifestExpiresAt: BINDING.expiresAt },
  });
  const eventId = `evt_synthetic_f3_${seq}`;
  synthetic.events.set(eventId, { id: eventId, object: 'event', type: 'checkout.session.completed', livemode: false, created: 1_777_100_000 + seq, data: { object: { id: sessionId } } });
  const settled = await orders.recordClassroomFinancialEvent(eventId);
  assert.equal(settled.status, 200, `F3 fixture: real settlement ${JSON.stringify(settled.body)}`);
  const stored = await f3Stored(id);
  assert.equal(stored.paymentStatus, 'paid', 'F3 fixture: projected PAID by the settlement producer');
  assert.ok(stored.classroomFinancialReceipt, 'F3 fixture: authentic financial receipt');
  assert.equal(orders.isClassroomReleaseHeld(stored), true);
  return id;
}

async function f3PaidRetailOrder(): Promise<string> {
  useBackend('local');
  const id = freshId();
  const order = baseOrder(id, false);
  Object.assign(order, { paymentStatus: 'paid', paidAt: new Date().toISOString(), stripeSessionId: `cs_test_synthetic_f3_retail_${seq}` });
  await orders.persistNewOrder(order);
  assert.equal(orders.isClassroomReleaseHeld(await f3Stored(id)), false, 'retail fixture is unbound');
  return id;
}

function f3LegacySend() {
  const calls: string[] = [];
  return { calls, send: async (order: Obj) => { calls.push(order.id); return { skipped: false, id: `msg_f3_${calls.length}` }; } };
}

function f3FrozenTransport() {
  const calls: Obj[] = [];
  return {
    calls,
    transport: {
      ready: () => true,
      send: async (request: Obj, idempotencyKey: string) => { calls.push({ request, idempotencyKey }); return { kind: 'accepted', id: `f3-msg-${calls.length}` }; },
    },
  };
}

function f3EnvelopeStore(seed: Record<string, string> = {}) {
  const objects = new Map<string, Buffer>(Object.entries(seed).map(([key, value]) => [key, Buffer.from(value, 'utf8')]));
  const calls: string[] = [];
  return {
    calls,
    io: {
      put: async (pathname: string, body: unknown) => {
        calls.push(`put:${pathname}`);
        if (objects.has(pathname)) throw new Error('This blob already exists');
        objects.set(pathname, Buffer.from(String(body), 'utf8'));
        return { pathname };
      },
      get: async (pathname: string) => {
        calls.push(`get:${pathname}`);
        const stored = objects.get(pathname);
        if (!stored) return { statusCode: 404, stream: null, blob: null };
        const bytes = new Uint8Array(stored);
        return {
          statusCode: 200,
          stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
          blob: { size: bytes.byteLength },
        };
      },
      del: async (pathname: string) => { calls.push(`del:${pathname}`); throw new Error('F3: delete forbidden'); },
    },
  };
}

function f3FrozenEnvelope(order: Obj) {
  const supportEmail = orderEmailLib.getSupportEmail();
  const rendered = orderEmailLib.buildOrderConfirmationEmail(order, { supportEmail });
  const built = envelopeLib.buildConfirmationEmailEnvelope({
    orderId: order.id,
    templateVersion: envelopeConfig.CONFIRMATION_ENVELOPE_TEMPLATE_VERSION,
    createdAt: new Date().toISOString(),
    idempotencyKey: orderEmailLib.buildOrderConfirmationIdempotencyKey(order),
    providerBinding: { accountLabel: envelopeConfig.CONFIRMATION_ENVELOPE_ACCOUNT_LABEL },
    request: { from: orderEmailLib.getOrderSenderEmail(), to: [order.email], subject: rendered.subject, html: rendered.html, text: rendered.text, replyTo: supportEmail },
  });
  assert.equal(built.ok, true, 'F3 fixture: the frozen envelope builds');
  const e = built.envelope;
  const objectPath = envelopeConfig.confirmationEnvelopeObjectPath(order.id, '');
  return {
    objectPath,
    serialized: JSON.stringify(e),
    fields: {
      confirmationEmailState: 'SNAPSHOTTED',
      confirmationEmailHoldReason: null,
      confirmationEmailFrom: e.request.from,
      confirmationEmailIdempotencyKey: e.idempotencyKey,
      confirmationEmailEnvelopeRef: {
        envelopeVersion: 1, orderId: e.orderId, templateVersion: e.templateVersion, createdAt: e.createdAt,
        canonicalDigest: e.canonicalDigest, canonicalBytes: e.canonicalBytes, accountLabel: e.providerBinding.accountLabel,
        storageKind: 'private_blob', objectPath, purgedAt: null,
      },
    },
  };
}

async function f3Settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

const f3LegacyDeps = (send: (order: Obj) => Promise<unknown>) => ({ send, now: f3Now, log: f3Quiet, errorLog: f3Quiet });

const f3ArmedDeps = (store: ReturnType<typeof f3EnvelopeStore>, frozen: ReturnType<typeof f3FrozenTransport>, legacy: ReturnType<typeof f3LegacySend>) => ({
  send: legacy.send,
  now: f3Now,
  log: f3Quiet,
  errorLog: f3Quiet,
  envelopeWriter: { env: { ...F3_WRITER_ENV }, storeIo: store.io },
  frozenDispatch: { transport: frozen.transport },
});

test('F3-02 settled classroom record is held at delivery, claim transaction and kickoff; retail control sends once', async () => {
  const retail = await f3PaidRetailOrder();
  const retailSend = f3LegacySend();
  assert.deepEqual(await confirmationDelivery.deliverOrderConfirmationEmail(retail, f3LegacyDeps(retailSend.send)), { status: 'sent' });
  assert.deepEqual(await confirmationDelivery.deliverOrderConfirmationEmail(retail, f3LegacyDeps(retailSend.send)), { status: 'blocked', reason: 'already_sent' });
  assert.deepEqual(retailSend.calls, [retail], 'retail control: exactly one effect, replay suppressed');

  const id = await f3SettledClassroomOrder();
  const before = JSON.stringify(await f3Stored(id));
  const send = f3LegacySend();
  assert.deepEqual(await confirmationDelivery.deliverOrderConfirmationEmail(id, f3LegacyDeps(send.send)), { status: 'blocked', reason: F3_HELD });
  assert.deepEqual(await confirmationDelivery.claimConfirmationEmail(id, 'claim-f3-direct', { now: f3Now }), { ok: false, reason: F3_HELD });
  const record = await f3Stored(id);
  const cfg = { nowMs: f3Now(), claimStaleMs: F3_STALE_MS };
  assert.equal(confirmationDelivery.evaluateConfirmationEmailClaimability(record, cfg), F3_HELD);
  assert.equal(confirmationDelivery.evaluateConfirmationEmailClaimability({ ...record, groupBookAssembly: null }, cfg), F3_HELD, 'null binding presence stays held');
  assert.equal(confirmationDelivery.evaluateConfirmationEmailClaimability({ ...record, groupBookAssembly: { bogus: true } }, cfg), F3_HELD, 'malformed binding presence stays held');
  for (const scheduler of ['setImmediate', 'after'] as const) {
    confirmationKickoff._resetConfirmationEmailInFlightForTest();
    const queue: Array<() => unknown> = [];
    const errors: string[] = [];
    confirmationKickoff.scheduleOrderConfirmationEmail(record, {
      send: send.send,
      setImmediateImpl: (cb: () => void) => { if (scheduler === 'setImmediate') queue.push(cb); return null; },
      afterImpl: scheduler === 'after' ? (cb: () => unknown) => { queue.push(cb); } : null,
      log: f3Quiet,
      errorLog: (line: string) => { errors.push(line); },
    });
    assert.equal(queue.length, 1, `${scheduler}: one scheduled run`);
    await queue[0]();
    await f3Settle(() => errors.length > 0);
    assert.ok(errors.some((line) => line.includes(`confirmation_email_blocked:${F3_HELD}`)), `${scheduler}: ${JSON.stringify(errors)}`);
  }
  assert.deepEqual(send.calls, [], 'zero provider calls for the classroom record');
  assert.equal(JSON.stringify(await f3Stored(id)), before, 'no claim, identity or receipt was written');
});

test('F3-03 stale snapshot race: the claim transaction recheck holds a settled classroom record before transport', async () => {
  const id = await f3SettledClassroomOrder();
  const stale = await f3Stored(id);
  delete stale.groupBookAssembly;
  assert.equal(orders.isClassroomReleaseHeld(stale), false, 'the stale snapshot alone would admit a send');
  const send = f3LegacySend();
  let staleReads = 0;
  const staleRead = async () => { staleReads += 1; return structuredClone(stale); };
  const outcome = await confirmationDelivery.deliverOrderConfirmationEmail(id, { ...f3LegacyDeps(send.send), getOrder: staleRead });
  assert.equal(staleReads, 1, 'the entry read was the stale snapshot');
  assert.deepEqual(outcome, { status: 'blocked', reason: F3_HELD }, 'the claim transaction rechecked the authoritative record');
  let attempts = 0;
  const racingTransact = (orderId: string, mutate: (order: Obj) => unknown, opts: Obj) => orders.withOrderTransaction(orderId, async (latest: Obj) => {
    attempts += 1;
    if (attempts === 1) {
      await orders.withOrderTransaction(orderId, (c: Obj) => ({ commit: { ...c, queueStatusNote: 'f3-racer', updatedAt: new Date().toISOString() }, result: true }));
    }
    return mutate(latest);
  }, opts);
  const raced = await confirmationDelivery.deliverOrderConfirmationEmail(id, { ...f3LegacyDeps(send.send), getOrder: staleRead, transact: racingTransact });
  assert.deepEqual(raced, { status: 'blocked', reason: F3_HELD }, 'a concurrent writer cannot open the claim');
  assert.ok(attempts >= 1, 'the claim CAS ran against the latest record');
  assert.deepEqual(send.calls, [], 'no provider call');
  const after = await f3Stored(id);
  assert.equal(after.queueStatusNote, 'f3-racer', 'the concurrent write landed');
  for (const field of ['emailResendClaimId', 'emailResendClaimKind', 'confirmationEmailFrom', 'confirmationEmailIdempotencyKey', 'confirmationEmailSentAt']) {
    assert.equal(after[field] ?? null, null, `${field} was not written`);
  }
  assert.equal(orders.isClassroomReleaseHeld(after), true);
});

test('F3-04 sweep and stale-claim recovery never deliver a settled classroom record', async () => {
  const id = await f3SettledClassroomOrder();
  const retail = await f3PaidRetailOrder();
  const send = f3LegacySend();
  const delivered: string[] = [];
  const nowMs = f3Now();
  const sweepDeps = (list: () => Promise<Obj[]>) => ({
    listOrders: list,
    deliver: (orderId: string) => {
      delivered.push(orderId);
      return confirmationDelivery.deliverOrderConfirmationEmail(orderId, { send: send.send, now: () => nowMs, log: f3Quiet, errorLog: f3Quiet });
    },
    now: () => nowMs,
    graceMs: 0,
    claimStaleMs: F3_STALE_MS,
    activationPaidAtMs: confirmationSweep.CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS,
    log: f3Quiet,
    errorLog: f3Quiet,
    admitAwaitingFrozenDispatch: true,
  });
  const first = await confirmationSweep.runConfirmationEmailSweep(sweepDeps(async () => [await f3Stored(id), await f3Stored(retail)]));
  assert.deepEqual(delivered, [retail], 'the sweep never selects the classroom record');
  assert.deepEqual(first, { ok: true, scanned: 2, eligible: 1, sent: 1, skipped: 0, blocked: 0, failed: 0, snapshotted: 0, held: 0, deferred: 0 });
  assert.deepEqual(
    confirmationSweep.evaluateConfirmationEmailSweepEligibility(await f3Stored(id), {
      nowMs, graceMs: 0, claimStaleMs: F3_STALE_MS, activationPaidAtMs: confirmationSweep.CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS, admitAwaitingFrozenDispatch: true,
    }),
    { eligible: false, reason: F3_HELD },
  );
  delivered.length = 0;
  const staleCopy = await f3Stored(id);
  delete staleCopy.groupBookAssembly;
  const second = await confirmationSweep.runConfirmationEmailSweep(sweepDeps(async () => [staleCopy]));
  assert.deepEqual(delivered, [id], 'a stale listing admits the record to delivery');
  assert.deepEqual(second, { ok: true, scanned: 1, eligible: 1, sent: 0, skipped: 0, blocked: 1, failed: 0, snapshotted: 0, held: 0, deferred: 0 }, 'delivery holds it');
  await orders.withOrderTransaction(id, (c: Obj) => ({
    commit: {
      ...c,
      emailResendClaimId: 'claim-f3-abandoned',
      emailResendClaimKind: 'order_confirmation',
      emailResendClaimArtifact: c.stripeSessionId,
      emailResendClaimAt: new Date(nowMs - F3_STALE_MS - 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
    result: true,
  }));
  const recovered = await confirmationDelivery.deliverOrderConfirmationEmail(id, { send: send.send, now: () => nowMs, log: f3Quiet, errorLog: f3Quiet });
  assert.deepEqual(recovered, { status: 'blocked', reason: F3_HELD }, 'stale-claim recovery does not take the record over');
  const after = await f3Stored(id);
  assert.equal(after.emailResendClaimId, 'claim-f3-abandoned');
  assert.equal(after.confirmationEmailSentAt ?? null, null);
  assert.deepEqual(send.calls, [retail], 'only the retail control reached the provider');
});

test('F3-05 armed writer and frozen dispatcher hold a settled classroom record, including a pre-frozen envelope', async () => {
  const legacy = f3LegacySend();
  const retail = await f3PaidRetailOrder();
  const retailStore = f3EnvelopeStore();
  const retailFrozen = f3FrozenTransport();
  assert.deepEqual(await confirmationDelivery.deliverOrderConfirmationEmail(retail, f3ArmedDeps(retailStore, retailFrozen, legacy)), { status: 'sent' });
  assert.deepEqual(await confirmationDelivery.deliverOrderConfirmationEmail(retail, f3ArmedDeps(retailStore, retailFrozen, legacy)), { status: 'blocked', reason: 'already_sent' });
  assert.equal(retailFrozen.calls.length, 1, 'retail control: exactly one frozen effect, replay suppressed');
  assert.equal((await f3Stored(retail)).confirmationEmailState, 'ACCEPTED');

  const id = await f3SettledClassroomOrder();
  const before = JSON.stringify(await f3Stored(id));
  const store = f3EnvelopeStore();
  const frozen = f3FrozenTransport();
  assert.deepEqual(await confirmationDelivery.deliverOrderConfirmationEmail(id, f3ArmedDeps(store, frozen, legacy)), { status: 'blocked', reason: F3_HELD });
  assert.deepEqual(store.calls, [], 'no envelope was written');
  assert.equal(frozen.calls.length, 0);
  assert.equal(JSON.stringify(await f3Stored(id)), before, 'no snapshot was committed');

  // A frozen envelope that predates the fence: the dispatcher itself must refuse.
  const frozenId = await f3SettledClassroomOrder();
  const envelope = f3FrozenEnvelope(await f3Stored(frozenId));
  await orders.withOrderTransaction(frozenId, (c: Obj) => ({ commit: { ...c, ...envelope.fields, updatedAt: new Date().toISOString() }, result: true }));
  const frozenBefore = JSON.stringify(await f3Stored(frozenId));
  const frozenStore = f3EnvelopeStore({ [envelope.objectPath]: envelope.serialized });
  const frozenCalls = f3FrozenTransport();
  assert.deepEqual(await confirmationDelivery.deliverOrderConfirmationEmail(frozenId, f3ArmedDeps(frozenStore, frozenCalls, legacy)), { status: 'blocked', reason: F3_HELD });
  const gate = envelopeProducer.resolveConfirmationEnvelopeWriter({ env: { ...F3_WRITER_ENV }, storeIo: frozenStore.io });
  assert.equal(gate.kind, 'armed');
  const dispatcher = frozenDispatch.resolveFrozenDispatcher({ ...F3_WRITER_ENV }, { transport: frozenCalls.transport }, gate);
  assert.equal(dispatcher.kind, 'armed');
  const nowMs = f3Now();
  const direct = await frozenDispatch.dispatchFrozenConfirmation(frozenId, dispatcher, {
    nowMs,
    claimStaleMs: F3_STALE_MS,
    evaluateClaimability: (order: Obj) => confirmationDelivery.evaluateConfirmationEmailClaimability(order, { nowMs, claimStaleMs: F3_STALE_MS }),
    newClaimId: () => 'claim-f3-frozen',
    newAttemptId: () => 'attempt-f3-frozen',
    log: f3Quiet,
    errorLog: f3Quiet,
  });
  assert.deepEqual(direct, { status: 'blocked', reason: F3_HELD }, 'the frozen dispatcher refuses before intent');
  assert.deepEqual(
    confirmationSweep.evaluateConfirmationEmailSweepEligibility(await f3Stored(frozenId), {
      nowMs, graceMs: 0, claimStaleMs: F3_STALE_MS, activationPaidAtMs: confirmationSweep.CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS, admitAwaitingFrozenDispatch: true,
    }),
    { eligible: false, reason: F3_HELD },
  );
  assert.equal(frozenCalls.calls.length, 0, 'zero frozen provider calls');
  assert.deepEqual(frozenStore.calls, [], 'the frozen envelope was never read');
  assert.equal(JSON.stringify(await f3Stored(frozenId)), frozenBefore, 'no intent, claim or attempt was written');
  assert.deepEqual(legacy.calls, [], 'the legacy send was never reached');
});
