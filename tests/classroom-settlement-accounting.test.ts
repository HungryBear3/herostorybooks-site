// SYNTHETIC classroom zero-total accounting tests. Never real settlement.
// - The REAL Stripe SDK signs fixture bytes offline (generateTestHeaderString)
//   and the ACTUAL webhook route verifies them with constructEvent.
// - The 'stripe' module is replaced at import time by a subclass of the real
//   SDK whose events/checkout.sessions resources read an in-memory synthetic
//   provider (inline module mock); no request leaves the process.
// - The classroom assembly check is an inline module mock with a controllable
//   verdict, so roster withdrawal / expiry interleavings are deterministic.
// - Orders use the REAL local filesystem adapter under the owned runtime root.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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
const RUNTIME = ownedRuntime('classroom-settlement-accounting');
process.env.TMPDIR = RUNTIME;
const STORE = path.join(RUNTIME, `accounting-${process.pid}-${Date.now()}`);
mkdirSync(STORE, { recursive: true });
const WEBHOOK_SECRET = 'whsec_synthetic_classroom_accounting_only';
process.env.HSB_ORDER_STORE_DIR = STORE;
process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(STORE, 'recovery');
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
process.env.STRIPE_SECRET_KEY = 'sk_test_synthetic_classroom_accounting_only';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
for (const name of ['VERCEL', 'VERCEL_ENV', 'BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_NAMESPACE', 'HSB_PAID_ORDER_OUTBOX_ENABLED']) delete process.env[name];
const logs: string[] = [];
console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
globalThis.fetch = (async () => { throw new TypeError('synthetic_network_denied'); }) as typeof fetch;

// ---- synthetic provider + SDK module mock ---------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
const provider = {
  events: new Map<string, Obj>(),
  sessions: new Map<string, Obj>(),
  eventReads: 0,
  sessionReads: 0,
  creates: 0,
  failEventRead: 0,
  eventOverride: null as null | ((e: Obj) => Obj),
  onSessionRead: null as null | (() => Promise<void>),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RealStripe: any = (await import('stripe')).default;
class SyntheticStripe extends RealStripe {
  constructor(...args: unknown[]) {
    super(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    self.events = {
      retrieve: async (id: string) => {
        provider.eventReads += 1;
        if (provider.failEventRead > 0) { provider.failEventRead -= 1; throw new Error('synthetic_event_read_failed'); }
        const event = provider.events.get(id);
        if (!event) throw new Error('synthetic_no_such_event');
        return provider.eventOverride ? provider.eventOverride(structuredClone(event)) : structuredClone(event);
      },
    };
    self.checkout = {
      sessions: {
        retrieve: async (id: string) => {
          provider.sessionReads += 1;
          if (provider.onSessionRead) { const hook = provider.onSessionRead; provider.onSessionRead = null; await hook(); }
          const session = provider.sessions.get(id);
          if (!session) throw new Error('synthetic_no_such_session');
          return structuredClone(session);
        },
        create: async () => { throw new Error('synthetic_create_forbidden_in_producer'); },
      },
    };
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });

// Native group-book fixture (lifted from the preserved helper): '@vercel/blob'
// maps to the existing in-memory store fake; real roster/manifest code runs.
const GROUP_TOKEN = 'vercel_blob_rw_classroomsynthetic_accounting';
const NATIVE_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
// Exact invite shapes from the preserved native helper.
const NATIVE_INVITE = { token: 'SyntheticLegacyAlphaToken00000000001', cohortId: 'synthetic_cohort', familySlotId: 'legacy_family_a', cohortLabel: 'Synthetic classroom', expiresAt: NATIVE_FUTURE };
const NATIVE_INVITE_B = { ...NATIVE_INVITE, token: 'SyntheticLegacyBravoToken00000000002', cohortId: 'synthetic_cohort_b', familySlotId: 'legacy_family_b' };
const NATIVE_INVITE_C = { ...NATIVE_INVITE, token: 'SyntheticLegacyCharlieToken000000003', cohortId: 'synthetic_cohort_c', familySlotId: 'legacy_family_c' };
const NATIVE_INVITE_D = { ...NATIVE_INVITE, token: 'SyntheticLegacyDeltaToken00000000004', cohortId: 'synthetic_cohort_d', familySlotId: 'legacy_family_d' };
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = GROUP_TOKEN;
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify([NATIVE_INVITE, NATIVE_INVITE_B, NATIVE_INVITE_C, NATIVE_INVITE_D]);
process.env.HSB_ORDER_ADMIN_KEY = 'synthetic-classroom-accounting-admin-key-0001';
const blobFake = await import(new URL('./helpers/blob-store-fake.mjs', import.meta.url).href);
mock.module('@vercel/blob', { namedExports: { ...blobFake, BlobStoreNotFoundError: class BlobStoreNotFoundError extends Error {} } });

const assemblyUrl = new URL('../src/lib/group-book/assembly.ts', import.meta.url).href;
const realAssembly = await import(assemblyUrl);
const assembly = { verdict: null as string | null, calls: 0, hook: null as null | ((n: number) => Promise<void>), real: false, after: null as null | (() => Promise<void>) };
mock.module(assemblyUrl, {
  namedExports: {
    ...realAssembly,
    assertClassroomAssemblyCurrent: async (...args: unknown[]) => {
      if (assembly.real) {
        // REAL roster/manifest verdict; the one-shot hook runs AFTER that real check, before the caller's CAS.
        const real = await realAssembly.assertClassroomAssemblyCurrent(...args);
        if (assembly.after) { const after = assembly.after; assembly.after = null; await after(); }
        return real;
      }
      assembly.calls += 1;
      // The verdict is fixed at check time; the hook runs AFTER the check, before the caller's CAS.
      const verdict = assembly.verdict;
      if (assembly.hook) await assembly.hook(assembly.calls);
      return verdict ? { ok: false, reason: verdict } : { ok: true };
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orders: any = await import('../src/lib/orders.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib: any = await import('../src/lib/group-book/classroom-checkout.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webhook: any = await import('../src/app/api/webhooks/stripe/route.ts');

const KIND = 'hsb_classroom_zero_total_test';
const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
const BINDING = { schemaVersion: 1, cohortId: 'synthetic_cohort', digest: 'b'.repeat(64), participantCount: 3, expiresAt: FUTURE };
let seq = 0;
const freshId = () => { seq += 1; return `ord_${(Date.now().toString(16) + seq.toString(16).padStart(4, '0')).slice(-16).padStart(16, '0')}`; };
const raw = (id: string) => readFileSync(path.join(STORE, `${id}.json`), 'utf8');
const read = async (id: string) => JSON.parse(JSON.stringify((await orders.readOrderVersioned(id)).order)) as Obj;

async function seedBound(over: Obj = {}): Promise<string> {
  const id = freshId();
  const order = orders.createOrderRecord({ email: 'synthetic@example.invalid', bookFormat: 'digital', childName: 'SYNTH' }, { id, fulfillmentMode: 'manual_hold' });
  order.groupBookAssembly = { ...BINDING };
  Object.assign(order, over);
  await orders.persistNewOrder(order);
  return id;
}
const checkoutProvider = {
  hooks: new Map<string, () => Promise<void>>(),
  async barrier(point: string) { const h = checkoutProvider.hooks.get(point); if (h) { checkoutProvider.hooks.delete(point); await h(); } },
  async createZeroTotalSession(req: Obj) {
    provider.creates += 1;
    const id = `cs_test_synthetic_${provider.sessions.size + 1}_${seq}`;
    const s = {
      id, object: 'checkout.session', livemode: false, mode: 'payment', status: 'open', payment_status: 'unpaid',
      amount_subtotal: req.order.priceCents, amount_total: 0, total_details: { amount_discount: req.order.priceCents, amount_shipping: 0, amount_tax: 0 },
      currency: 'usd', client_reference_id: req.order.id, metadata: { ...req.metadata }, payment_intent: null, url: `https://checkout.synthetic.invalid/${id}`,
    };
    provider.sessions.set(id, s);
    return structuredClone(s);
  },
  async retrieveSession(id: string) { return structuredClone(provider.sessions.get(id)); },
};
async function checkout(orderId: string) {
  const res: Response = await lib.classroomCheckoutResponse(new Request('http://127.0.0.1/api/admin/group-book/checkout', { method: 'POST' }), {
    authenticate: () => true, target: () => ({ orderId }), provider: checkoutProvider, baseUrl: () => 'http://127.0.0.1',
  });
  return { status: res.status, body: (await res.json()) as Obj };
}
let eventSeq = 0;
function completeAndEvent(sessionId: string, orderId: string, sessionOver: Obj = {}, eventOver: Obj = {}): string {
  const s = provider.sessions.get(sessionId)!;
  Object.assign(s, { status: 'complete', payment_status: 'no_payment_required' }, sessionOver);
  eventSeq += 1;
  const id = `evt_synthetic_accounting_${eventSeq}`;
  provider.events.set(id, {
    id, object: 'event', type: 'checkout.session.completed', livemode: false, created: 1_777_000_000 + eventSeq, api_version: '2024-06-20',
    data: { object: { id: sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId } } }, ...eventOver,
  });
  return id;
}
function signed(eventId: string, secret = WEBHOOK_SECRET, header?: string) {
  const event = provider.events.get(eventId) ?? { id: eventId, object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_x', metadata: { kind: KIND } } } };
  const payload = JSON.stringify(event);
  const sig = header ?? new RealStripe('sk_test_synthetic_signer').webhooks.generateTestHeaderString({ payload, secret });
  return new Request('http://127.0.0.1/api/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
}
async function deliver(eventId: string, secret?: string, header?: string) {
  const res: Response = await webhook.POST(signed(eventId, secret, header));
  return { status: res.status, body: (await res.json()) as Obj };
}
async function boundCheckout(over: Obj = {}) {
  const orderId = await seedBound(over);
  assembly.verdict = null;
  const c = await checkout(orderId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const order = await read(orderId);
  return { orderId, sessionId: order.stripeSessionId as string, order };
}
const expectedReceipt = (order: Obj, eventId: string) => ({
  schemaVersion: 1, provider: 'stripe', providerEventId: eventId, providerEventType: 'checkout.session.completed', providerEventCreated: provider.events.get(eventId)!.created,
  sessionId: order.classroomAcceptedSession.sessionId, providerAccount: 'platform', livemode: false, orderId: order.id,
  dispatchAttemptId: order.classroomAcceptedTerms.dispatchAttemptId, cohortId: BINDING.cohortId, manifestDigest: BINDING.digest,
  manifestExpiresAt: BINDING.expiresAt, bookFormat: 'digital', amountSubtotalCents: order.classroomAcceptedTerms.priceCents,
  discountAmountCents: order.classroomAcceptedTerms.priceCents, amountTotalCents: 0, currency: 'usd', mode: 'payment',
  sessionStatus: 'complete', paymentStatus: 'no_payment_required', paymentIntent: null,
});

test('A01_signed_zero_receipt_and_full_replay', async () => {
  const { orderId, sessionId, order } = await boundCheckout();
  // Accepted terms reserved before create, accepted Session appended at bind.
  assert.deepEqual(order.classroomAcceptedTerms, {
    schemaVersion: 1, orderId, groupBookAssembly: BINDING, cohortId: BINDING.cohortId, manifestDigest: BINDING.digest,
    manifestExpiresAt: BINDING.expiresAt, bookFormat: 'digital', priceCents: order.priceCents, currency: 'usd',
    discountAmountCents: order.priceCents, expectedAmountTotalCents: 0, provider: 'stripe', providerAccount: 'platform',
    livemode: false, mode: 'payment', metadataKind: KIND, dispatchAttemptId: order.classroomCheckoutDispatch.attemptId,
    idempotencyKey: order.classroomCheckoutDispatch.idempotencyKey, reservedAt: order.classroomCheckoutDispatch.reservedAt,
    sessionBindingPolicy: 'single_session_for_dispatch',
  });
  assert.deepEqual(order.classroomAcceptedSession, { schemaVersion: 1, orderId, dispatchAttemptId: order.classroomCheckoutDispatch.attemptId, sessionId, providerAccount: 'platform', livemode: false });
  const eventId = completeAndEvent(sessionId, orderId);
  const reads = { e: provider.eventReads, s: provider.sessionReads };
  const first = await deliver(eventId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.classroomSettlement, 'receipt_recorded_held');
  assert.equal(provider.eventReads, reads.e + 1);
  assert.equal(provider.sessionReads, reads.s + 1);
  const paid = await read(orderId);
  assert.deepEqual(paid.classroomFinancialReceipt, expectedReceipt(order, eventId));
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal(paid.settledAmountCents, 0);
  assert.equal(paid.fulfillmentMode, 'manual_hold');
  assert.equal(paid.status, 'order_received');
  assert.equal(paid.workOutbox, undefined);
  assert.equal(orders.isClassroomReleaseHeld(paid), true);
  // Duplicate: BOTH provider verifications precede receipt equality; bytes unchanged.
  const before = raw(orderId);
  const dup = await deliver(eventId);
  assert.equal(dup.status, 200);
  assert.equal(dup.body.classroomSettlement, 'receipt_replay_held');
  assert.equal(provider.eventReads, reads.e + 2);
  assert.equal(provider.sessionReads, reads.s + 2);
  assert.equal(raw(orderId), before);
  assert.doesNotMatch(logs.join('\n'), /fulfillment kickoff|confirmation email|purchase analytics/i);
});

test('A02_authenticity_and_binding_negatives', async () => {
  const { orderId, sessionId, order } = await boundCheckout();
  const pristine = structuredClone(provider.sessions.get(sessionId)!);
  const reset = () => provider.sessions.set(sessionId, structuredClone(pristine));
  // Signature negatives: no provider reads at all.
  reset();
  const sigEvent = completeAndEvent(sessionId, orderId);
  const r0 = { e: provider.eventReads, s: provider.sessionReads };
  assert.equal((await deliver(sigEvent, 'whsec_wrong_synthetic')).status, 400);
  assert.equal((await deliver(sigEvent, undefined, 't=1,v1=deadbeef')).status, 400);
  assert.deepEqual({ e: provider.eventReads, s: provider.sessionReads }, r0, 'signature negatives perform no provider read');
  const sessionCases: [string, Obj][] = [
    ['session id', { id: 'cs_test_other' }], ['session livemode', { livemode: true }], ['mode', { mode: 'subscription' }],
    ['status', { status: 'open' }], ['payment_status', { payment_status: 'paid' }], ['amount_total', { amount_total: 100 }],
    ['subtotal', { amount_subtotal: 1 }], ['discount', { total_details: { amount_discount: 1 } }], ['currency', { currency: 'eur' }],
    ['client_reference', { client_reference_id: 'ord_synthetic_foreign_order' }],
    ['metadata kind', { metadata: { ...pristine.metadata, kind: 'other' } }],
    ['metadata orderId', { metadata: { ...pristine.metadata, orderId: 'ord_synthetic_foreign_order' } }],
    ['metadata cohortId', { metadata: { ...pristine.metadata, cohortId: 'other_cohort' } }],
    ['metadata manifestDigest', { metadata: { ...pristine.metadata, manifestDigest: 'f'.repeat(64) } }],
    ['metadata manifestExpiresAt', { metadata: { ...pristine.metadata, manifestExpiresAt: new Date(0).toISOString() } }],
    ['payment intent', { payment_intent: 'pi_synthetic' }],
  ];
  const eventCases: [string, (e: Obj) => Obj][] = [
    ['event id', (e) => ({ ...e, id: 'evt_other' })], ['event type', (e) => ({ ...e, type: 'checkout.session.expired' })],
    ['event account', (e) => ({ ...e, account: 'acct_synthetic' })], ['event livemode', (e) => ({ ...e, livemode: true })],
  ];
  const all: [string, () => void][] = [
    ...sessionCases.map(([l, over]) => [l, () => { reset(); provider.sessions.set(sessionId, { ...structuredClone(pristine), status: 'complete', payment_status: 'no_payment_required', ...over }); }] as [string, () => void]),
    ...eventCases.map(([l, fn]) => [l, () => { reset(); provider.sessions.set(sessionId, { ...structuredClone(pristine), status: 'complete', payment_status: 'no_payment_required' }); provider.eventOverride = fn; }] as [string, () => void]),
  ];
  for (const [label, arrange] of all) {
    const eventId = completeAndEvent(sessionId, orderId);
    arrange();
    const r = await deliver(eventId);
    provider.eventOverride = null;
    assert.notEqual(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    const o = await read(orderId);
    assert.equal(o.classroomFinancialReceipt, undefined, `${label}: zero accepted receipt`);
    assert.equal(o.paymentStatus, 'pending', `${label}: no paid projection`);
  }
  // Direct public command with a forged Event + forged provider cannot inject facts.
  let forgedReads = 0;
  const forged = await lib.settleClassroomZeroTotalEvent(
    { id: 'evt_forged_never_issued', type: 'checkout.session.completed', livemode: false, data: { object: { id: sessionId, metadata: { kind: KIND, orderId } } } },
    { retrieveSession: async () => { forgedReads += 1; return { ...pristine, status: 'complete', payment_status: 'no_payment_required' }; } },
  );
  assert.notEqual(forged.status, 200);
  assert.equal(forgedReads, 0, 'caller provider is never financial authority');
  assert.equal((await read(orderId)).classroomFinancialReceipt, undefined);
  // Genuine distinct Event for the same Session: original retained + conflict observation.
  reset();
  const genuine = completeAndEvent(sessionId, orderId);
  assert.equal((await deliver(genuine)).status, 200);
  const receipt = (await read(orderId)).classroomFinancialReceipt;
  assert.equal(receipt.providerEventId, genuine);
  const second = completeAndEvent(sessionId, orderId);
  const conflict = await deliver(second);
  assert.equal(conflict.status, 409);
  const after = await read(orderId);
  assert.deepEqual(after.classroomFinancialReceipt, receipt);
  assert.ok(after.classroomFinancialReconciliation.some((e: Obj) => e.reason === 'receipt_conflict' && e.providerEventId === second));
  void order;
});

const LIFECYCLE: [string, Obj][] = [
  ['paymentStatus failed', { paymentStatus: 'failed' }], ['paymentStatus refunded', { paymentStatus: 'refunded' }],
  ['status-only terminal', { status: 'delivered' }], ['refundClaimId', { refundClaimId: 'rc_synthetic' }],
  ['refundedAt', { refundedAt: '2026-10-01T00:00:00.000Z' }], ['stripeRefundId', { stripeRefundId: 're_synthetic' }],
  ['premium format', { bookFormat: 'premium' }], ['auto mode', { fulfillmentMode: 'auto' }], ['price', { priceCents: 1234 }],
];
async function genericMutate(orderId: string, over: Obj): Promise<'committed' | 'STORE_REJECTED'> {
  try {
    await orders.withOrderTransaction(orderId, (c: Obj) => ({ commit: { ...c, ...over, updatedAt: new Date().toISOString() }, result: true }));
    return 'committed';
  } catch { return 'STORE_REJECTED'; }
}

test('A03_reserve_and_bind_context_matrix', async () => {
  const cases: [string, Obj][] = [...LIFECYCLE, ['dispatch mismatch', { classroomCheckoutDispatch: { schemaVersion: 1, attemptId: '00000000-0000-4000-8000-00000000dead', idempotencyKey: 'other', reservedAt: '2026-10-01T00:00:00.000Z' } }]];
  const ledger: string[] = [];
  for (const phase of ['reserve', 'bind'] as const) {
    for (const timing of ['before_callback', 'cas_retry'] as const) {
      for (const [label, over] of cases) {
        if (phase === 'reserve' && label === 'dispatch mismatch' && timing === 'before_callback') {
          // A pre-existing foreign dispatch is the existing held path.
        }
        const orderId = await seedBound();
        assembly.verdict = null;
        const creates = provider.creates;
        let mutation: 'committed' | 'STORE_REJECTED' | 'not_run' = 'not_run';
        const point = phase === 'reserve'
          ? (timing === 'before_callback' ? null : 'checkout:reserve_guarded')
          : (timing === 'before_callback' ? 'checkout:after_create' : 'checkout:bind_guarded');
        // reserve/before_callback: the entry assembly check runs AFTER the initial
        // order context is captured and BEFORE the reservation callback.
        if (point === null) assembly.hook = async () => { assembly.hook = null; mutation = await genericMutate(orderId, over); };
        else checkoutProvider.hooks.set(point, async () => { mutation = await genericMutate(orderId, over); });
        const r = await checkout(orderId);
        checkoutProvider.hooks.clear();
        assembly.hook = null;
        ledger.push(`${phase}/${timing}/${label}:${mutation}`);
        console.log(`SUBCASE A03 ${phase}/${timing}/${label} mutation=${mutation} status=${r.status}`);
        assert.equal(mutation, 'committed', `${phase}/${timing}/${label}: existing-field mutation executed (STORE_REJECTED reported separately)`);
        assert.equal(r.status, 409, `${phase}/${timing}/${label}: ${JSON.stringify(r.body)}`);
        const o = await read(orderId);
        if (phase === 'reserve') {
          assert.equal(provider.creates, creates, `${phase}/${timing}/${label}: zero create`);
          assert.equal(o.classroomAcceptedTerms, undefined);
        } else {
          assert.equal(provider.creates, creates + 1);
          assert.ok(o.classroomAcceptedTerms, 'terms retained');
          assert.ok(o.classroomCheckoutDispatch, 'dispatch retained');
          assert.equal(o.classroomAcceptedSession, undefined, 'no accepted Session');
          assert.ok(!o.stripeSessionId);
          const again = await checkout(orderId);
          assert.equal(again.status, 409);
          assert.equal(provider.creates, creates + 1, 'no recreate');
        }
      }
    }
  }
  // Existing binding-change refusal remains a separate store safety control.
  const bid = await seedBound();
  assert.equal(await genericMutate(bid, { groupBookAssembly: { ...BINDING, participantCount: 7 } }), 'STORE_REJECTED');
  assert.equal(ledger.length, 2 * 2 * cases.length, ledger.join('\n'));
});

test('A04_invalid_lifecycle_preserves_receipt', async () => {
  for (const timing of ['before_settlement', 'on_retry'] as const) {
    for (const [label, over] of LIFECYCLE) {
      const { orderId, sessionId, order } = await boundCheckout();
      const eventId = completeAndEvent(sessionId, orderId);
      let mutation: string = 'not_run';
      if (timing === 'before_settlement') mutation = await genericMutate(orderId, over);
      else assembly.hook = async (n) => { if (n === assembly.calls && mutation === 'not_run') mutation = await genericMutate(orderId, over); };
      const callsBefore = assembly.calls;
      void callsBefore;
      const r = await deliver(eventId);
      assembly.hook = null;
      console.log(`SUBCASE A04 ${timing}/${label} mutation=${mutation} status=${r.status}`);
      assert.equal(mutation, 'committed', `${timing}/${label}: mutation executed at the intended seam`);
      const o = await read(orderId);
      assert.equal(r.status, 200, `${timing}/${label}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.classroomSettlement, 'receipt_recorded_held');
      assert.deepEqual(o.classroomFinancialReceipt, expectedReceipt(order, eventId), `${timing}/${label}: receipt appended from accepted terms`);
      for (const [k, v] of Object.entries(over)) assert.deepEqual(o[k], v, `${timing}/${label}: ${k} unchanged, no resurrection`);
      if (label !== 'status-only terminal' || o.paymentStatus !== 'paid') assert.notEqual(o.paymentStatus === 'paid' && label.startsWith('paymentStatus'), true);
      assert.equal(orders.isClassroomReleaseHeld(o), true);
    }
  }
  // B1: full canonical dispatch equality (schemaVersion/attemptId/idempotencyKey/reservedAt)
  // against frozen terms, under NATIVE supported-CAS drift (dispatch is a mutable,
  // non-custody field a generic writer may change).
  const dispatchDrifts: [string, (d: Obj) => Obj][] = [
    ['reservedAt', (d) => ({ ...d, reservedAt: '2000-01-01T00:00:00.000Z' })],
    ['schemaVersion', (d) => ({ ...d, schemaVersion: 999 })],
    ['malformed_extra_key', (d) => ({ ...d, extra: 'x' })],
    ['malformed_missing_reservedAt', (d) => { const n = { ...d }; delete n.reservedAt; return n; }],
    ['malformed_reservedAt_type', (d) => ({ ...d, reservedAt: 1234 })],
  ];
  const driftDispatch = async (oid: string, fn: (d: Obj) => Obj) => {
    await orders.withOrderTransaction(oid, (c: Obj) => ({ commit: { ...c, classroomCheckoutDispatch: fn(c.classroomCheckoutDispatch), updatedAt: new Date().toISOString() }, result: true }));
  };
  for (const [label, fn] of dispatchDrifts) {
    // (a) drift DURING bind (after create, before the guarded bind CAS)
    const bid = await seedBound();
    assembly.verdict = null;
    const creates0 = provider.creates;
    checkoutProvider.hooks.set('checkout:after_create', async () => { await driftDispatch(bid, fn); });
    const bres = await checkout(bid);
    checkoutProvider.hooks.clear();
    const bo = await read(bid);
    assert.equal(bres.status, 409, `B1 bind/${label}: ${JSON.stringify(bres.body)}`);
    assert.deepEqual(bres.body, { error: 'classroom_checkout_refused', reason: 'context_changed' }, `B1 bind/${label}: exact refusal`);
    assert.equal(bo.classroomAcceptedSession, undefined, `B1 bind/${label}: no accepted Session`);
    assert.ok(!bo.stripeSessionId, `B1 bind/${label}: not bound`);
    assert.ok(bo.classroomAcceptedTerms, `B1 bind/${label}: terms retained`);
    assert.equal(provider.creates, creates0 + 1, `B1 bind/${label}: exactly one create, no recreate`);
    console.log(`SUBCASE B1 bind_drift_${label} 409 unbound terms_retained`);

    // (b) drift AFTER bind: replay refused, authentic receipt STILL recorded, projection prevented
    const { orderId: rid, sessionId: rsid, order: rorder } = await boundCheckout();
    await driftDispatch(rid, fn);
    const rep = await checkout(rid);
    assert.equal(rep.status, 409, `B1 replay/${label}: ${JSON.stringify(rep.body)}`);
    assert.equal(rep.body.error, 'classroom_session_not_open');
    console.log(`SUBCASE B1 replay_drift_${label} 409`);
    const ev = completeAndEvent(rsid, rid);
    const pr = await deliver(ev);
    const po = await read(rid);
    assert.equal(pr.status, 200, `B1 projection/${label}: ${JSON.stringify(pr.body)}`);
    assert.equal(pr.body.classroomSettlement, 'receipt_recorded_held');
    assert.deepEqual(po.classroomFinancialReceipt, expectedReceipt(rorder, ev), `B1 projection/${label}: authentic receipt recorded exactly`);
    assert.equal(po.paymentStatus, 'pending', `B1 projection/${label}: drift prevents paid projection`);
    console.log(`SUBCASE B1 projection_drift_${label} receipt=yes paid=no`);
  }
  // Unchanged dispatch positive control: bind, replay and projection all succeed.
  {
    const { orderId: uid, sessionId: usid } = await boundCheckout();
    const urep = await checkout(uid);
    assert.equal(urep.status, 200, `B1 unchanged replay ${JSON.stringify(urep.body)}`);
    const upr = await deliver(completeAndEvent(usid, uid));
    assert.equal(upr.status, 200);
    assert.equal((await read(uid)).paymentStatus, 'paid', 'B1 unchanged: paid projection');
    console.log('SUBCASE B1 unchanged_dispatch bind=200 replay=200 projection=paid');
  }

  // Existing paid still fully validates provider facts; contradictory data gets no early 200.
  const { orderId, sessionId } = await boundCheckout();
  const good = completeAndEvent(sessionId, orderId);
  assert.equal((await deliver(good)).status, 200);
  const bad = completeAndEvent(sessionId, orderId, { amount_total: 500 });
  const r = await deliver(bad);
  assert.notEqual(r.status, 200, 'contradictory provider data on a paid order is not replayed as success');
});

test('A05_independent_withdrawal_and_expiry', async () => {
  for (const variant of ['R01_withdrawal', 'R02_expiry'] as const) {
    const { orderId, sessionId } = await boundCheckout();
    const eventId = completeAndEvent(sessionId, orderId);
    const versionBefore = (await orders.readOrderVersioned(orderId)).version;
    let versionAtBarrier = '';
    // Final check passes, then the roster changes (withdrawal / clock expiry) before the CAS.
    assembly.hook = async () => {
      assembly.hook = null;
      assembly.verdict = variant === 'R01_withdrawal' ? 'participation_changed' : 'expired';
      await new Promise((resolve) => setTimeout(resolve, 5)); // one awaited barrier
      versionAtBarrier = (await orders.readOrderVersioned(orderId)).version;
    };
    const r = await deliver(eventId);
    assert.equal(versionAtBarrier, versionBefore, `${variant}: order version unchanged across withdrawal`);
    assert.equal(r.status, 200);
    const o = await read(orderId);
    assert.ok(o.classroomFinancialReceipt, `${variant}: receipt retained`);
    assert.equal(orders.isClassroomReleaseHeld(o), true, `${variant}: all bound effects held`);
    assembly.verdict = null;
  }
  // Paired-order-CAS control: withdrawal plus a racing order write -> retry re-checks, projection disabled, receipt kept.
  const { orderId, sessionId } = await boundCheckout();
  const eventId = completeAndEvent(sessionId, orderId);
  let fired = 0;
  assembly.hook = async () => {
    if (fired++ > 0) return;
    assembly.verdict = 'participation_changed';
    await genericMutate(orderId, { queueStatusNote: 'racer' });
  };
  const r = await deliver(eventId);
  assembly.hook = null; assembly.verdict = null;
  assert.equal(r.status, 200);
  const o = await read(orderId);
  assert.ok(o.classroomFinancialReceipt, 'paired control: receipt retained');
  assert.equal(o.paymentStatus, 'pending', 'paired control: retry refused paid projection');
  console.log('SUBCASE A05 mock_seam_controls ok');

  // ---- NATIVE: real roster + manifest, real withdrawal, controlled real clock ----
  const release = await import('../src/lib/group-book/release.ts');
  const store = await import('../src/lib/group-book/store.ts');
  const orderHandler = await import('../src/lib/group-book/order-handler.ts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob: any = await import('@vercel/blob');
  async function nativeBound(invite: typeof NATIVE_INVITE) {
    const policy = release.groupBookPolicyState();
    assert.equal(policy.state, 'adopted', 'native policy adopted');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const current = (policy as any).current;
    const stamp = { version: current.record.version, digest: current.digest };
    const photo = { assetId: 'gbp_synthetic1', pathname: store.groupBookPhotoPath(invite, 'gbp_synthetic1', 'jpg'), mime: 'image/jpeg', size: 4, uploadedAt: new Date().toISOString(), storage: 'private' as const };
    await blob.put(photo.pathname, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { access: 'private', token: GROUP_TOKEN, allowOverwrite: false });
    const record = store.buildGroupBookSubmission({ invite, parentName: 'SYNTHETIC-PARENT', parentEmail: 'synthetic-parent@example.invalid', childFirstName: 'SYNTHETIC-CHILD', ageRange: '5-6', characterNotes: 'SYNTHETIC', photos: [photo], policy: stamp });
    assert.equal(await store.createGroupBookSubmission(record), true, 'create-only roster submission');
    const res = await orderHandler.classroomOrderResponse(new Request('http://127.0.0.1/api/admin/group-book/order', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hsb-order-admin-key': process.env.HSB_ORDER_ADMIN_KEY! }, body: '{}',
    }), { trustedInput: async () => ({ cohortId: invite.cohortId, bookFormat: 'digital', contactEmail: 'teacher@example.invalid' }) });
    let resBody = await res.clone().text();
    if (res.status !== 201) {
      const exportMod = await import('../src/lib/group-book/export.ts');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const probe: any = await exportMod.assembleGroupBookExport({ cohortId: invite.cohortId, publisher: async () => ({ published: true as const }) } as never);
      resBody += ` export=${JSON.stringify({ state: probe?.state, reason: probe?.reason })}`;
      const rosterMod = await import('../src/lib/group-book/roster.ts');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const roster: any = await rosterMod.loadClassroomRoster(invite.cohortId);
      resBody += ` roster=${JSON.stringify({ state: roster?.state, reason: roster?.reason })}`;
      const listed = await blob.list({ prefix: 'group-book/', token: GROUP_TOKEN });
      for (const row of listed.blobs) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r: any = await (store as any).readPrivateObject(row.pathname).catch((e: Error) => ({ state: `throw:${e.message}` }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = r?.state === 'found' && row.pathname.startsWith('group-book/families/') ? Boolean((store as any).parseSubmission(r.value, { cohortId: r.value?.cohort?.id, familySlotId: r.value?.cohort?.familySlotId })) : null;
        resBody += ` path=${row.pathname.slice(0, 40)}:${r?.state}:parsed=${parsed}`;
      }
    }
    assert.equal(res.status, 201, `native classroom order via manifest-only publisher: ${resBody}`);
    const nativeId = ((await res.json()) as { orderId: string }).orderId;
    const c = await checkout(nativeId);
    assert.equal(c.status, 200, `native checkout ${JSON.stringify(c.body)}`);
    const nativeOrder = await read(nativeId);
    return { nativeId, sessionId: nativeOrder.stripeSessionId as string, familyPath: `group-book/families/${record.familyStorageKey}.json`, binding: nativeOrder.groupBookAssembly };
  }
  assembly.real = true;
  try {
    // R01: real withdrawal of the roster record after the producer's last REAL check, before its CAS.
    const r01 = await nativeBound(NATIVE_INVITE);
    const e01 = completeAndEvent(r01.sessionId, r01.nativeId);
    const v01 = (await orders.readOrderVersioned(r01.nativeId)).version;
    let v01AtSeam = '';
    let r01Withdrawals = 0;
    assembly.after = async () => {
      // Native create-only withdrawal API (marker), not direct roster deletion.
      const w = await store.requestGroupBookWithdrawal(NATIVE_INVITE);
      assert.equal(w.created, true, 'R01: create-only withdrawal marker created');
      r01Withdrawals += 1;
      await new Promise((resolve) => setTimeout(resolve, 5)); // one awaited barrier
      v01AtSeam = (await orders.readOrderVersioned(r01.nativeId)).version;
    };
    const d01 = await deliver(e01);
    assert.equal(d01.status, 200, JSON.stringify(d01.body));
    assert.equal(r01Withdrawals, 1, 'R01: exactly one withdrawal at the seam');
    assert.equal(v01AtSeam, v01, 'R01: order version unchanged across the real withdrawal');
    const o01 = await read(r01.nativeId);
    assert.ok(o01.classroomFinancialReceipt, 'R01: receipt retained');
    assert.equal(orders.isClassroomReleaseHeld(o01), true, 'R01: bound effects held');
    const after01 = await realAssembly.assertClassroomAssemblyCurrent(r01.binding);
    assert.equal(after01.ok, false, 'R01: withdrawal is real (current assembly now refuses)');
    console.log(`SUBCASE A05 R01_native_withdrawal paid=${o01.paymentStatus} receipt=yes held=yes`);

    // R02: controlled REAL clock reaches manifest expiry at the same seam.
    const r02 = await nativeBound(NATIVE_INVITE_B);
    const e02 = completeAndEvent(r02.sessionId, r02.nativeId);
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      assembly.after = async () => { mock.timers.setTime(Date.parse(r02.binding.expiresAt) + 1000); };
      const d02 = await deliver(e02);
      assert.equal(d02.status, 200, JSON.stringify(d02.body));
      const o02 = await read(r02.nativeId);
      assert.ok(o02.classroomFinancialReceipt, 'R02: receipt retained');
      assert.equal(orders.isClassroomReleaseHeld(o02), true);
      const after02 = await realAssembly.assertClassroomAssemblyCurrent(r02.binding);
      assert.equal(after02.ok, false, 'R02: controlled clock really expired the manifest');
      console.log(`SUBCASE A05 R02_native_expiry paid=${o02.paymentStatus} receipt=yes held=yes`);
    } finally {
      mock.timers.reset();
    }

    // Paired order-CAS control: real withdrawal AND a racing order write -> retry re-checks the REAL roster.
    const r03 = await nativeBound(NATIVE_INVITE_C);
    const e03 = completeAndEvent(r03.sessionId, r03.nativeId);
    assembly.after = async () => {
      const w = await store.requestGroupBookWithdrawal(NATIVE_INVITE_C);
      assert.equal(w.created, true, 'paired: create-only withdrawal marker created');
      await genericMutate(r03.nativeId, { queueStatusNote: 'native-racer' });
    };
    const d03 = await deliver(e03);
    assert.equal(d03.status, 200, JSON.stringify(d03.body));
    const o03 = await read(r03.nativeId);
    assert.ok(o03.classroomFinancialReceipt, 'paired: receipt retained');
    assert.equal(o03.paymentStatus, 'pending', 'paired: retry observed real withdrawal; no paid projection');
    console.log('SUBCASE A05 paired_native_order_cas receipt=yes paid=no');

    // ---- C06 native manifest-only publisher (separately emitted; REAL assembly, native admin auth) ----
    {
      const policy = release.groupBookPolicyState();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cur = (policy as any).current;
      const photo = { assetId: 'gbp_synthetic1', pathname: store.groupBookPhotoPath(NATIVE_INVITE_D, 'gbp_synthetic1', 'jpg'), mime: 'image/jpeg', size: 4, uploadedAt: new Date().toISOString(), storage: 'private' as const };
      await blob.put(photo.pathname, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { access: 'private', token: GROUP_TOKEN, allowOverwrite: false });
      const sub = store.buildGroupBookSubmission({ invite: NATIVE_INVITE_D, parentName: 'SYNTHETIC-PARENT', parentEmail: 'synthetic-parent@example.invalid', childFirstName: 'SYNTHETIC-CHILD', ageRange: '5-6', characterNotes: 'SYNTHETIC', photos: [photo], policy: { version: cur.record.version, digest: cur.digest } });
      assert.equal(await store.createGroupBookSubmission(sub), true);
      const adminReq = (key: string | null) => new Request('http://127.0.0.1/api/admin/group-book/order', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-hsb-order-admin-key': key } : {}) }, body: '{}' });
      const trustedInput = async () => ({ cohortId: NATIVE_INVITE_D.cohortId, bookFormat: 'digital' as const, contactEmail: 'teacher@example.invalid' });
      const unauth = await orderHandler.classroomOrderResponse(adminReq('wrong-key'), { trustedInput });
      assert.equal(unauth.status, 401, 'C06: native admin auth refuses first');
      const journalBefore = blobFake.journal.length;
      const res = await orderHandler.classroomOrderResponse(adminReq(process.env.HSB_ORDER_ADMIN_KEY!), { trustedInput });
      assert.equal(res.status, 201, `C06: native manifest-only publisher ${await res.clone().text()}`);
      const cid = ((await res.json()) as { orderId: string }).orderId;
      const o = await read(cid);
      assert.equal(o.groupBookAssembly.cohortId, NATIVE_INVITE_D.cohortId, 'C06: order bound to the published manifest');
      assert.equal(o.paymentStatus, 'pending'); assert.equal(o.fulfillmentMode, 'manual_hold');
      for (const k of ['pageArtifacts', 'storyArtifactUrl', 'proofVersion', 'privateStoryArtifact', 'proofApprovalToken']) assert.equal(o[k] ?? undefined, undefined, `C06: no ${k}`);
      const puts = blobFake.journal.slice(journalBefore).filter((e: Obj) => e.op === 'put').map((e: Obj) => String(e.pathname));
      assert.ok(puts.length >= 1 && puts.every((p: string) => p.startsWith('group-book/assembly-manifests/')), `C06: metadata-only writes ${JSON.stringify(puts)}`);
      assert.ok(puts.includes(`group-book/assembly-manifests/${o.groupBookAssembly.cohortId}/${o.groupBookAssembly.digest}.json`), 'C06: manifest at the bound path');
      const realCheck = await realAssembly.assertClassroomAssemblyCurrent(o.groupBookAssembly);
      assert.equal(realCheck.ok, true, 'C06: REAL assembly check accepts the published manifest');
      // Admin export path keeps a null publisher: native export holds with no artifact producer.
      const exportMod = await import('../src/lib/group-book/export.ts');
      const held = await exportMod.assembleGroupBookExport({ cohortId: NATIVE_INVITE_D.cohortId, publisher: null });
      assert.equal(held.state, 'hold'); assert.equal((held as { reason?: string }).reason, 'no_group_book_artifact_producer');
      assert.equal(orders.isClassroomReleaseHeld(o), true, 'C06: bound order held');
      console.log(`SUBCASE C06 native_manifest_only_publisher 201 bound metadata_puts=${puts.length} export_null_publisher=hold`);
    }
  } finally {
    assembly.real = false;
    assembly.after = null;
  }
});

test('A06_legacy_and_crash_reconciliation', async () => {
  // Missing accepted terms (legacy bound + Session).
  const legacy = await seedBound({ stripeSessionId: 'cs_test_synthetic_legacy' });
  provider.sessions.set('cs_test_synthetic_legacy', {
    id: 'cs_test_synthetic_legacy', livemode: false, mode: 'payment', status: 'open', amount_subtotal: 2999, amount_total: 0,
    total_details: { amount_discount: 2999 }, currency: 'usd', client_reference_id: legacy, payment_intent: null,
    metadata: { kind: KIND, orderId: legacy, cohortId: BINDING.cohortId, manifestDigest: BINDING.digest, manifestExpiresAt: BINDING.expiresAt },
  });
  const legacyEvent = completeAndEvent('cs_test_synthetic_legacy', legacy);
  const l1 = await deliver(legacyEvent);
  assert.equal(l1.status, 409);
  assert.equal(l1.body.error, 'classroom_reconciliation_hold');
  const lo = await read(legacy);
  assert.equal(lo.classroomAcceptedTerms, undefined, 'no fabricated terms');
  assert.equal(lo.classroomFinancialReceipt, undefined);
  assert.equal(lo.paymentStatus, 'pending');
  assert.equal(lo.classroomFinancialReconciliation.length, 1);
  assert.equal(lo.classroomFinancialReconciliation[0].reason, 'missing_accepted_terms');
  await deliver(legacyEvent);
  assert.equal((await read(legacy)).classroomFinancialReconciliation.length, 1, 'duplicate observation deduped');

  // Missing accepted Session: reserved terms, Session id set by a generic writer.
  const noSession = await seedBound();
  const reserved = await orders.reserveClassroomCheckoutTerms(noSession, { guard: async () => null, dispatch: { schemaVersion: 1, attemptId: '00000000-0000-4000-8000-0000000000bb', idempotencyKey: orders.checkoutProviderIdempotencyKey(noSession), reservedAt: new Date().toISOString() } });
  assert.equal(reserved.ok, true);
  await genericMutate(noSession, { stripeSessionId: 'cs_test_synthetic_nosession' });
  provider.sessions.set('cs_test_synthetic_nosession', { ...provider.sessions.get('cs_test_synthetic_legacy'), id: 'cs_test_synthetic_nosession', client_reference_id: noSession, metadata: { ...provider.sessions.get('cs_test_synthetic_legacy')!.metadata, orderId: noSession } });
  const ns = await deliver(completeAndEvent('cs_test_synthetic_nosession', noSession));
  assert.equal(ns.status, 409);
  const nso = await read(noSession);
  assert.equal(nso.classroomFinancialReconciliation[0].reason, 'missing_accepted_session');
  assert.equal(nso.paymentStatus, 'pending');

  // Mismatched accepted context.
  const { orderId: mid, sessionId: msid } = await boundCheckout();
  const mm = await deliver(completeAndEvent(msid, mid, { metadata: { ...provider.sessions.get(msid)!.metadata, cohortId: 'other_cohort' } }));
  assert.equal(mm.status, 409);
  assert.equal((await read(mid)).classroomFinancialReconciliation[0].reason, 'accepted_context_mismatch');

  // Crash before commit: provider read failure is retryable 500 with no write, then succeeds.
  const { orderId, sessionId } = await boundCheckout();
  const eventId = completeAndEvent(sessionId, orderId);
  const before = raw(orderId);
  provider.failEventRead = 1;
  const crash = await deliver(eventId);
  assert.equal(crash.status, 500);
  assert.equal(raw(orderId), before);
  // Persistence failure: 500, never success.
  orders.__setOrderStoreAdapterFactoryForTests(() => ({
    kind: 'synthetic-failing',
    readVersioned: async (p: string) => { const body = readFileSync(path.join(STORE, path.basename(p)), 'utf8'); return { body, version: 'x' }; },
    createIfAbsent: async () => { throw new Error('synthetic_store_down'); },
    replaceIfVersion: async () => { throw new Error('synthetic_store_down'); },
  }));
  const down = await deliver(eventId);
  orders.__resetOrderStoreAdapterFactoryForTests();
  assert.equal(down.status, 500);
  assert.equal((await read(orderId)).classroomFinancialReceipt, undefined);
  // Outbox flag cannot discard the receipt.
  process.env.HSB_PAID_ORDER_OUTBOX_ENABLED = 'true';
  const ok = await deliver(eventId);
  delete process.env.HSB_PAID_ORDER_OUTBOX_ENABLED;
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const settled = await read(orderId);
  assert.ok(settled.classroomFinancialReceipt);
  assert.equal(settled.workOutbox, undefined, 'no outbox scheduling');
  // After commit, before response: the command replays the complete receipt.
  const replay = await orders.recordClassroomFinancialEvent(eventId);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.classroomSettlement, 'receipt_replay_held');
  // Conflict append retains originals.
  const conflictEvent = completeAndEvent(sessionId, orderId);
  assert.equal((await deliver(conflictEvent)).status, 409);
  const final = await read(orderId);
  assert.equal(final.classroomFinancialReceipt.providerEventId, eventId);

  // Strict read schemas: malformed stored receipt / reconciliation evidence
  // (raw-bytes fixture in the owned runtime store, as an unrestricted-storage
  // corruption control) fails closed as a hold; same-event replay is not success.
  const malformedCases: [string, (o: Obj) => void][] = [
    ['receipt extra key', (o) => { o.classroomFinancialReceipt = { ...o.classroomFinancialReceipt, extra: 1 }; }],
    ['receipt missing key', (o) => { const r = { ...o.classroomFinancialReceipt }; delete r.paymentIntent; o.classroomFinancialReceipt = r; }],
    ['receipt wrong literal', (o) => { o.classroomFinancialReceipt = { ...o.classroomFinancialReceipt, livemode: true }; }],
    ['reconciliation not array', (o) => { o.classroomFinancialReconciliation = { reason: 'receipt_conflict' }; }],
    ['reconciliation entry extra key', (o) => { o.classroomFinancialReconciliation = [{ ...o.classroomFinancialReconciliation[0], extra: 1 }]; }],
    ['reconciliation entry bad reason', (o) => { o.classroomFinancialReconciliation = [{ ...o.classroomFinancialReconciliation[0], reason: 'forged' }]; }],
  ];
  const good = raw(orderId);
  let malformedExecuted = 0;
  for (const [label, corrupt] of malformedCases) {
    const doc = JSON.parse(good);
    corrupt(doc);
    const bytes = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileSync(path.join(STORE, `${orderId}.json`), bytes);
    const r = await orders.recordClassroomFinancialEvent(eventId);
    assert.equal(r.status, 409, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.reason, 'malformed_custody', `${label}: fail-closed hold`);
    assert.equal(raw(orderId), bytes, `${label}: malformed evidence never rewritten`);
    malformedExecuted += 1;
    console.log(`SUBCASE A06 malformed ${label} held`);
  }
  writeFileSync(path.join(STORE, `${orderId}.json`), good);
  assert.equal(malformedExecuted, malformedCases.length);

  // Post-commit / pre-response crash: the store DURABLY writes the CAS body and
  // then the acknowledgement throws. Distinct from the pre-commit failure above.
  const pc = await boundCheckout();
  const pcEvent = completeAndEvent(pc.sessionId, pc.orderId);
  const pcBefore = raw(pc.orderId);
  let durableWrites = 0;
  orders.__setOrderStoreAdapterFactoryForTests(() => ({
    kind: 'synthetic-commit-then-crash',
    readVersioned: async (p: string) => ({ body: readFileSync(path.join(STORE, path.basename(p)), 'utf8'), version: 'synthetic-v' }),
    createIfAbsent: async () => { throw new Error('synthetic_create_unused'); },
    replaceIfVersion: async (p: string, body: string) => {
      writeFileSync(path.join(STORE, path.basename(p)), body);
      durableWrites += 1;
      throw new Error('synthetic_crash_after_durable_commit');
    },
  }));
  const crashed = await deliver(pcEvent);
  orders.__resetOrderStoreAdapterFactoryForTests();
  assert.equal(durableWrites, 1, 'commit landed durably');
  assert.equal(crashed.status, 500, 'no success acknowledged across the crash');
  assert.notEqual(raw(pc.orderId), pcBefore);
  const committedReceipt = (await read(pc.orderId)).classroomFinancialReceipt;
  assert.deepEqual(committedReceipt, expectedReceipt(pc.order, pcEvent), 'durable receipt complete');
  const reads = { e: provider.eventReads, s: provider.sessionReads };
  const afterCrash = raw(pc.orderId);
  const replayed = await deliver(pcEvent);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.classroomSettlement, 'receipt_replay_held');
  assert.deepEqual({ e: provider.eventReads, s: provider.sessionReads }, { e: reads.e + 1, s: reads.s + 1 }, 'replay re-authenticates Event and Session');
  assert.equal(raw(pc.orderId), afterCrash, 'replay writes nothing');
  console.log('SUBCASE A06 postcommit_crash_then_authenticated_replay ok');
});
