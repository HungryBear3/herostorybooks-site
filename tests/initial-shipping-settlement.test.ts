import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
// Only SDK/storage and scheduling I/O are replaced. constructEvent stays real.
const { default: RealStripe } = await import('stripe');
const realBlob = await import('@vercel/blob');
const next = await import('next/server.js');
let privateSdk: any;
let orderFiles: Map<string, { body: string; version: number }>;
const scheduled: unknown[] = [];
mock.module('@vercel/blob', { namedExports: { ...realBlob,
  list: async (opts: any) => {
    if (!opts.prefix?.startsWith('orders/')) throw new Error('UNMATCHED_BLOB_LIST');
    return { blobs: [...orderFiles.keys()].filter(p => p.startsWith(opts.prefix)).map(pathname => ({ pathname })), hasMore: false };
  },
  del: async () => { throw new Error('UNMATCHED_BLOB_DELETE'); },
  head: async () => { throw new Error('UNMATCHED_BLOB_HEAD'); },
  get: (...a: any[]) => privateSdk.io.get(...a), put: (...a: any[]) => privateSdk.io.put(...a) } });
mock.module('next/server.js', { namedExports: { ...next, after: (cb: unknown) => scheduled.push(cb) } });
class SyntheticStripe extends RealStripe {
  constructor(...args: ConstructorParameters<typeof RealStripe>) {
    super(...args);
    this.accounts.retrieveCurrent = (async () => ({ id: 'acct_synthetic' })) as any;
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });
const { parseInitialShippingCommercialPolicy, planInitialShippingProduct, sha256 } = await import('../src/lib/initial-shipping-contract.ts');
const { createDraftStore, putShippingContact, quoteShippingDraft, selectShippingQuote } = await import('../src/lib/initial-shipping-draft.ts');
const { buildExpeditedStripeSessionParams, buildInitialShippingMetadata, confirmExpeditedPreProvider, initialSettlement } = await import('../src/lib/initial-shipping-checkout.ts');
const { classifySignedPayment, settleExpeditedPayment, shippingCommitted } = await import('../src/lib/initial-shipping-settlement.ts');
const { CAP, CONTACT, FP, INTAKE, NS, ORDER, POLICY_RAW, PROVIDER, STORE_ID, fakeBlob, fakeMarkerStore, realProducer, withLuluEnv, fakePrivateSdk, syntheticOrderBlob } = await import('./support/initial-shipping-fixture.ts');
const { POST } = await import('../src/app/api/webhooks/stripe/route.ts');
const { createOrderRecord, getOrderAuthoritative, checkoutIntakeOrderContractDigest } = await import('../src/lib/orders.ts');
const { finalizationFingerprint } = await import('../src/lib/checkout-intake.ts');
const { confirmCheckoutPayment } = await import('../src/lib/checkout-session-confirmation.ts');
const { evaluateConfirmationEmailClaimability } = await import('../src/lib/confirmation-email-delivery.ts');

async function signedJourney(run: (j: any) => Promise<void>) {
  const env = { ...process.env }; const fetch = globalThis.fetch; const immediate = globalThis.setImmediate;
  const clock = Date.now; const orders = syntheticOrderBlob(); orderFiles = orders.files; privateSdk = fakePrivateSdk(); scheduled.length = 0;
  globalThis.fetch = async () => { throw new Error('UNMATCHED_OUTBOUND'); };
  globalThis.setImmediate = ((cb: unknown) => { scheduled.push(cb); return { unref() {} }; }) as any;
  Object.assign(process.env, { STRIPE_SECRET_KEY: ['sk', 'test', 'synthetic'].join('_'), STRIPE_WEBHOOK_SECRET: 'whsec_synthetic',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticIntake_syntheticSecret',
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'true', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticOrders_syntheticSecret', HSB_BLOB_ACCESS_MODE: 'private', HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'false', HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'false',
    HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: JSON.stringify({ ...PROVIDER, stripeAccountBinding: sha256('acct_synthetic') }) });
  try {
    const j = await lockedJourney('syntheticIntake');
    for (const [path, f] of j.blob.files) privateSdk.files.set(path, { body: f.body, etag: String(f.etag) });
    const order: any = { ...createOrderRecord({ childName: 'Synthetic', email: 'synthetic@example.invalid', bookFormat: 'classic' }, { id: ORDER }),
      priceCents: 3999, stripeSessionId: 'cs_test_1', checkoutIntentFingerprint: FP,
      checkoutIntake: { intakeId: INTAKE, fingerprint: finalizationFingerprint(INTAKE, []), selection: [], orderContractDigest: '' },
      checkoutIntakeMediaRetention: { status: 'active', activatedAt: new Date(T0).toISOString() },
      initialShipping: j.metadata, initialShippingSettlement: initialSettlement(new Date(T0)) };
    order.checkoutIntake.orderContractDigest = checkoutIntakeOrderContractDigest(order);
    const get = privateSdk.io.get;
    privateSdk.io.get = async (path: string, opts: any) => {
      if (path.startsWith('orders/')) { const f = orders.files.get(path); return f ? { stream: new Response(f.body).body, blob: { etag: String(f.version) } } : null; }
      return get(path, opts);
    };
    const path = `orders/${ORDER}.json`;
    orders.files.set(path, { body: JSON.stringify(order), version: 1 });
    const send = (event = j.event(), valid = true) => {
      const payload = JSON.stringify(event);
      const sig = new RealStripe(process.env.STRIPE_SECRET_KEY!).webhooks.generateTestHeaderString({ payload, secret: valid ? 'whsec_synthetic' : 'whsec_wrong' });
      return POST(new Request('https://example.test/api/webhooks/stripe', { method: 'POST', body: payload, headers: { 'stripe-signature': sig } }));
    };
    await run({ ...j, order, orders, path, sdk: privateSdk, send, read: () => getOrderAuthoritative(ORDER),
      draft: () => JSON.parse([...privateSdk.files.values()][0].body) });
  } finally {
    orders.close(); Date.now = clock; globalThis.fetch = fetch; globalThis.setImmediate = immediate;
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env);
  }
}

test('signed HTTP timely late paid event records private and financial commitment; exact replay has no new effects', () => withLuluEnv(() => signedJourney(async j => {
  const r = await j.send(); assert.equal(r.status, 200, await r.text());
  const paid = await j.read(); assert.equal(paid.paymentStatus, 'paid');
  assert.equal(j.draft().state, 'payment_recorded'); assert.equal(paid.initialShippingSettlement.state, 'committed');
  const count = scheduled.length; assert.ok(count > 0);
  assert.equal((await j.send()).status, 200); assert.equal(scheduled.length, count);
  assert.equal((await j.read()).paidAt, paid.paidAt);
})));

test('new shipping readiness requires real paid eligibility and suppresses legacy confirmation claim', () => withLuluEnv(async () => {
  const j = await lockedJourney();
  const committed = { ...j.box.order, initialShippingSettlement: { version: 1, state: 'committed', receiptDigest: 'a'.repeat(64), reason: null, updatedAt: new Date(T0).toISOString() } };
  assert.equal(shippingCommitted(committed), 'committed');
  for (const paymentStatus of ['pending', 'failed', 'refunded', 'partially_refunded']) assert.equal(shippingCommitted({ ...committed, paymentStatus }), 'not_committed');
  assert.equal(evaluateConfirmationEmailClaimability(j.box.order, { nowMs: T0, claimStaleMs: 1000 }), 'held_for_reconciliation');
}));

test('confirmation reader observes book plus delta without writing or calling it committed', () => withLuluEnv(() => signedJourney(async j => {
  const before = j.orders.files.get(j.path).body;
  const observed = await confirmCheckoutPayment({ orderId: ORDER, stripeSessionId: 'cs_test_1' }, {
    getOrder: j.read, retrieveSession: async () => j.event().data.object,
  });
  assert.equal(observed.status, 'paid'); assert.equal(observed.reason, 'paid_observed_shipping_held');
  assert.equal(j.orders.files.get(j.path).body, before); assert.equal(j.draft().state, 'locked'); assert.equal(scheduled.length, 0);
})));

test('signed HTTP rejects invalid signature with zero durable/scheduled effects', () => withLuluEnv(() => signedJourney(async j => {
  const before = JSON.stringify([...j.orders.files]); const privateBefore = JSON.stringify([...j.sdk.files]);
  assert.equal((await j.send(j.event(), false)).status, 400);
  assert.equal(JSON.stringify([...j.orders.files]), before); assert.equal(JSON.stringify([...j.sdk.files]), privateBefore); assert.equal(scheduled.length, 0);
})));

test('signed HTTP mismatch and deferred matrix retains observations and never schedules success', () => withLuluEnv(async () => {
  const rows = [
    [{ created: 0 }, {}, true], [{}, { amount_total: 0 }, true], [{}, { amount_total: 3999, amount_subtotal: 3999 }, true],
    [{}, { total_details: { amount_discount: 1 } }, true], [{}, { payment_status: 'unpaid' }, false],
    [{}, { payment_status: 'no_payment_required', amount_total: 0 }, false], [{}, { payment_method_types: ['us_bank_account'] }, true],
    [{ livemode: true }, {}, false], [{ account: 'acct_other' }, {}, false], [{}, { id: 'cs_other' }, false],
    [{}, { currency: 'eur' }, false], [{}, { metadata: { orderId: ORDER } }, true],
  ] as const;
  for (const [event, session, paid] of rows) await signedJourney(async j => {
    const r = await j.send(j.event(event, session)); assert.equal(r.status, 200, await r.text());
    const order = await j.read(); assert.equal(order.paymentStatus, paid ? 'paid' : 'pending', JSON.stringify([event,session]));
    assert.equal(order.initialShippingSettlement.state, 'held'); assert.equal(j.draft().state, 'held'); assert.equal(scheduled.length, 0);
    if (paid) assert.equal(order.settledAmountCents, (session as any).amount_total ?? 4419);
    assert.equal((await j.send(j.event(event, session))).status, 200); assert.equal(scheduled.length, 0);
  });
}));

test('signed HTTP private loss before/after commit converges on exact same event', () => withLuluEnv(async () => {
  for (const after of [false,true]) await signedJourney(async j => {
    const put = j.sdk.io.put;
    j.sdk.io.put = async (...a: any[]) => { if (after) await put(...a); throw new Error('synthetic write loss'); };
    const first = await j.send(); assert.equal(first.status, after ? 200 : 500);
    if (!after) { assert.equal((await j.read()).paymentStatus, 'pending'); assert.equal(j.draft().state, 'locked'); assert.equal(scheduled.length, 0); }
    j.sdk.io.put = put;
    assert.equal((await j.send()).status, 200);
    assert.equal((await j.read()).initialShippingSettlement.state, 'committed'); assert.equal(j.draft().state, 'payment_recorded');
  });
}));

test('signed HTTP canonical crash boundaries repair without replay notifications', () => withLuluEnv(async () => {
  for (const stage of ['financial', 'projection']) await signedJourney(async j => {
    const replace = j.orders.adapter.replaceIfVersion;
    j.orders.adapter.replaceIfVersion = async (path: string, body: string, version: string) => {
      const next = JSON.parse(body);
      if (path === j.path && (stage === 'financial' ? next.paymentStatus === 'paid' : next.initialShippingSettlement?.state === 'committed')) throw new Error('synthetic crash');
      return replace(path, body, version);
    };
    assert.equal((await j.send()).status, 500); assert.equal(j.draft().state, 'payment_recorded'); assert.equal(scheduled.length, 0);
    assert.equal((await j.read()).paymentStatus, stage === 'financial' ? 'pending' : 'paid');
    const before = (await j.read()).paidAt;
    j.orders.adapter.replaceIfVersion = replace;
    assert.equal((await j.send()).status, 200); assert.equal((await j.read()).initialShippingSettlement.state, 'committed');
    if (stage === 'projection') { assert.equal((await j.read()).paidAt, before); assert.equal(scheduled.length, 2, 'only shared immediate/after shipping metric scheduling; no purchase or notification'); }
  });
}));

test('signed HTTP concurrent same-event converges once; terminal CAS races win', () => withLuluEnv(async () => {
  await signedJourney(async j => {
    const results = await Promise.all([j.send(), j.send(), j.send()]);
    assert.ok(results.every(r => r.status === 200)); assert.equal((await j.read()).initialShippingSettlement.state, 'committed');
    const calls = scheduled.length; assert.ok(calls > 0); assert.equal((await j.send()).status, 200); assert.equal(scheduled.length, calls);
  });
  for (const stage of ['financial', 'projection']) await signedJourney(async j => {
    const replace = j.orders.adapter.replaceIfVersion; let raced = false;
    j.orders.adapter.replaceIfVersion = async (path: string, body: string, version: string) => {
      const next = JSON.parse(body);
      if (!raced && path === j.path && (stage === 'financial' ? next.paymentStatus === 'paid' : next.initialShippingSettlement?.state === 'committed')) {
        raced = true; const current = j.orders.files.get(path);
        j.orders.files.set(path, { body: JSON.stringify({ ...JSON.parse(current.body), paymentStatus: 'refunded', refundedAt: new Date().toISOString() }), version: current.version + 1 });
      }
      return replace(path, body, version);
    };
    assert.equal((await j.send()).status, 200); assert.ok(raced);
    assert.equal((await j.read()).paymentStatus, 'refunded'); assert.equal((await j.read()).initialShippingSettlement.reason, 'refund_or_terminal');
    assert.equal(scheduled.length, 0); assert.equal((await j.send()).status, 200); assert.equal(scheduled.length, 0);
  });
}));

test('signed HTTP real standard control preserves promotions and zero-total entitlement', () => withLuluEnv(async () => {
  for (const total of [3999, 3000, 0]) await signedJourney(async j => {
    const standard = { ...j.order }; delete standard.initialShipping; delete standard.initialShippingSettlement;
    standard.checkoutIntake.orderContractDigest = checkoutIntakeOrderContractDigest(standard);
    j.orders.files.set(j.path, { body: JSON.stringify(standard), version: 1 });
    const event = j.event({}, { metadata: { orderId: ORDER }, amount_subtotal: 3999, amount_total: total,
      payment_status: total === 0 ? 'no_payment_required' : 'paid', payment_intent: total === 0 ? null : 'pi_1' });
    assert.equal((await j.send(event)).status, 200); assert.equal((await j.read()).paymentStatus, 'paid');
    assert.equal((await j.read()).settledAmountCents, total); assert.equal(j.draft().state, 'locked'); assert.ok(scheduled.length > 0);
  });
}));

test('signed HTTP already-paid missing private/public writes repair; unavailable retries without effects', () => withLuluEnv(() => signedJourney(async j => {
  const paidAt = new Date(T0 + 60_000).toISOString();
  j.orders.files.set(j.path, { body: JSON.stringify({ ...j.order, paymentStatus: 'paid', paidAt,
    stripePaymentIntentId: 'pi_1', settledAmountCents: 4419 }), version: 2 });
  j.sdk.faults.unavailable = true;
  assert.equal((await j.send()).status, 500); assert.equal((await j.read()).paymentStatus, 'paid'); assert.equal(scheduled.length, 0);
  j.sdk.faults.unavailable = false;
  assert.equal((await j.send()).status, 200); assert.equal(j.draft().state, 'payment_recorded');
  assert.equal((await j.read()).initialShippingSettlement.state, 'committed'); assert.equal((await j.read()).paidAt, paidAt);
  assert.equal(scheduled.length, 2, 'shipping commit metric only'); assert.ok(j.sdk.calls.every((c: any) => !c.path.startsWith('intakes/')));
})));

test('signed HTTP immutable private lock and actual account qualification cannot be supplied by Session', () => withLuluEnv(async () => {
  for (const mode of ['fingerprint', 'order', 'quote', 'account', 'missing-intake']) await signedJourney(async j => {
    if (mode === 'account') process.env.HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION = JSON.stringify({ ...PROVIDER, stripeAccountBinding: sha256('acct_other') });
    else if (mode === 'missing-intake') {
      const o = { ...j.order }; delete o.checkoutIntake; delete o.checkoutIntakeMediaRetention;
      j.orders.files.set(j.path, { body: JSON.stringify(o), version: 2 });
    } else {
      const [p,f] = [...j.sdk.files][0] as any; const d = JSON.parse(f.body);
      if (mode === 'fingerprint') d.lock.checkoutIntentFingerprint = '0'.repeat(64);
      if (mode === 'order') d.lock.canonicalOrderId = 'ord_' + 'b'.repeat(16);
      if (mode === 'quote') d.quote.deltaCents++;
      j.sdk.files.set(p, { ...f, body: JSON.stringify(d) });
    }
    const r = await j.send(); assert.equal(r.status, mode === 'account' ? 200 : 500);
    assert.equal((await j.read()).paymentStatus, 'pending'); assert.equal(scheduled.length, 0);
  });
}));

test('signed HTTP terminal event remains reachable after expedited payment and replay cannot resurrect', () => withLuluEnv(() => signedJourney(async j => {
  assert.equal((await j.send()).status, 200); scheduled.length = 0;
  const refund = { id: 'evt_refund', type: 'charge.refunded', created: Math.floor(Date.now()/1000), livemode: false,
    data: { object: { id: 'ch_synthetic', payment_intent: 'pi_1', metadata: { orderId: ORDER }, amount: 4419,
      amount_refunded: 4419, refunded: true, refunds: { data: [{ id: 're_synthetic' }] } } } };
  assert.equal((await j.send(refund)).status, 200); assert.equal((await j.read()).paymentStatus, 'refunded');
  assert.equal((await j.send()).status, 200); assert.equal((await j.read()).initialShippingSettlement.reason, 'refund_or_terminal');
  assert.equal(scheduled.length, 0);
})));

test('signed HTTP paid order with missing public projection reconstructs only from verified private receipt', () => withLuluEnv(() => signedJourney(async j => {
  const paid = { ...j.order, paymentStatus: 'paid', paidAt: new Date(T0).toISOString(), settledAmountCents: 4419, stripePaymentIntentId: 'pi_1' };
  delete paid.initialShippingSettlement;
  j.orders.files.set(j.path, { body: JSON.stringify(paid), version: 2 });
  assert.equal((await j.send()).status, 200); assert.equal((await j.read()).initialShippingSettlement.state, 'committed');
  assert.equal(j.draft().state, 'payment_recorded'); assert.equal(scheduled.length, 2, 'shipping commit metric only');
})));

const T0 = Math.floor((Date.now() - 3 * 60 * 60_000) / 1000) * 1000;
const product = planInitialShippingProduct('classic', () => '0850X0850.FC.STD.PB.080CW444.GXX');
const ctx = { flags: { quotes: true, checkout: true }, commercial: parseInitialShippingCommercialPolicy(POLICY_RAW), provider: PROVIDER };

async function lockedJourney(storeId = STORE_ID) {
  const now = { t: T0 }; const blob = fakeBlob(); const markers = fakeMarkerStore();
  const store = createDraftStore(blob.io, { namespace: NS, storeId });
  const deps = { store, namespace: NS, storeId, now: () => now.t, verifyIntake: async () => ({ ok: true, expiresAtMs: T0 + 86_400_000 }) };
  await putShippingContact(deps, { intakeId: INTAKE, capability: CAP, contact: CONTACT, product, provider: PROVIDER });
  const q = await quoteShippingDraft(deps, { intakeId: INTAKE, capability: CAP, provider: PROVIDER, produce: realProducer(deps.now) });
  const sel = await selectShippingQuote(deps, { intakeId: INTAKE, capability: CAP, quoteId: q.quote!.quoteId });
  const metadata = buildInitialShippingMetadata({ draft: sel, selectedQuoteId: sel.selectedQuoteId!, product, bookCents: 3999, ctx, now: now.t });
  await confirmExpeditedPreProvider({ draftStore: store, markerStore: markers.store, namespace: NS, intakeId: INTAKE, capability: CAP,
    canonicalOrderId: ORDER, checkoutIntentFingerprint: FP, metadata, now: now.t });
  const params: any = buildExpeditedStripeSessionParams({ orderId: ORDER, metadata, bookProductName: 'Book', ctx, now: now.t,
    successUrl: 'https://x.test/s', cancelUrl: 'https://x.test/c', customerEmail: 'p@example.test' });
  const event = (over: any = {}, sess: any = {}) => ({ id: 'evt_1', type: 'checkout.session.completed', created: Math.floor((T0 + 60_000) / 1000),
    livemode: false, ...over, data: { object: { id: 'cs_test_1', payment_intent: 'pi_1', payment_status: 'paid', mode: 'payment', currency: 'usd',
      payment_method_types: ['card'], amount_total: 4419, amount_subtotal: 4419, client_reference_id: ORDER, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 },
      metadata: params.metadata, ...sess } } });
  const expectation = { orderId: ORDER, metadata, stripeAccountBinding: PROVIDER.stripeAccountBinding, stripeLivemode: false,
    accountBindingOf: () => PROVIDER.stripeAccountBinding, expectedSessionId: 'cs_test_1' };
  let order: any = { id: ORDER, paymentStatus: 'paid', initialShipping: metadata, initialShippingSettlement: initialSettlement(new Date(T0)) };
  const box = { get order() { return order; }, set order(v) { order = v; } };
  const apply = async (mutate: any) => { const n = mutate(order); if (n) order = { ...order, initialShippingSettlement: n }; return n ? 'committed' : 'aborted'; };
  return { now, blob, store, metadata, event, expectation, box, apply };
}

test('timing: event.created after expiry, missing created, or before issue holds; not paid writes nothing', () => withLuluEnv(async () => {
  const j = await lockedJourney();
  assert.equal(classifySignedPayment(j.event(), j.expectation).kind, 'timely');
  const late = classifySignedPayment(j.event({ created: Math.floor(j.metadata.quoteWindow.expiresAtMs / 1000) }), j.expectation);
  assert.deepEqual([late.kind, (late as any).reason], ['held', 'payment_untimely']);
  assert.equal((classifySignedPayment(j.event({ created: undefined }), j.expectation) as any).reason, 'payment_untimely');
  assert.equal((classifySignedPayment(j.event({ created: Math.floor(T0 / 1000) - 10 }), j.expectation) as any).reason, 'payment_untimely');
  assert.equal(classifySignedPayment(j.event({}, { payment_status: 'no_payment_required' }), j.expectation).kind, 'not_paid');
  assert.equal((classifySignedPayment(j.event({}, { payment_status: 'unpaid' }), j.expectation) as any).reason, 'payment_deferred_unsupported');
}));

test('mismatch matrix retains paid facts as held: account, mode, session, quote, amount, discount, tax, shipping', () => withLuluEnv(async () => {
  const j = await lockedJourney();
  const r = (e: any, x = j.expectation) => (classifySignedPayment(e, x) as any).reason;
  assert.equal(r(j.event({ livemode: true })), 'payment_evidence_mismatch');
  assert.equal(r(j.event(), { ...j.expectation, accountBindingOf: () => 'e'.repeat(64) }), 'payment_evidence_mismatch');
  assert.equal(r(j.event({}, { id: 'cs_test_other' })), 'payment_evidence_mismatch');
  assert.equal(r(j.event({}, { metadata: { ...j.event().data.object.metadata, hsbShippingQuote: '00000000-0000-4000-8000-000000000000' } })), 'payment_evidence_mismatch');
  assert.equal(r(j.event({}, { amount_total: 3999, amount_subtotal: 3999 })), 'payment_amount_mismatch');
  assert.equal(r(j.event({}, { amount_total: 3419, total_details: { amount_discount: 1000, amount_tax: 0, amount_shipping: 0 } })), 'payment_discounted');
  assert.equal(r(j.event({}, { total_details: { amount_discount: 0, amount_tax: 100, amount_shipping: 0 } })), 'payment_evidence_mismatch');
  assert.equal(r(j.event({}, { shipping_details: { address: {} } })), 'payment_evidence_mismatch');
  const held = await settleExpeditedPayment({ event: j.event({ livemode: true }), expectation: j.expectation, draftStore: j.store, intakeId: INTAKE, now: () => j.now.t, applyToOrder: j.apply as any });
  assert.deepEqual(held, { projection: 'held', scheduleCompletionMetric: false });
  assert.equal(j.box.order.paymentStatus, 'paid', 'never falsely unpaid');
  assert.equal(shippingCommitted(j.box.order), 'not_committed');
  const priv = await j.store.read(INTAKE);
  assert.equal(priv!.record.state, 'held'); assert.equal(priv!.record.payment!.sessionId, 'cs_test_1', 'paid facts retained');
}));

test('crash convergence: private receipt then crash before projection; replay repairs without second metric', () => withLuluEnv(async () => {
  const j = await lockedJourney();
  const crash = async () => 'unavailable' as const;
  const first = await settleExpeditedPayment({ event: j.event(), expectation: j.expectation, draftStore: j.store, intakeId: INTAKE, now: () => j.now.t, applyToOrder: crash as any });
  assert.deepEqual(first, { projection: 'none', scheduleCompletionMetric: false });
  assert.equal((await j.store.read(INTAKE))!.record.state, 'payment_recorded');
  const replay = await settleExpeditedPayment({ event: j.event(), expectation: j.expectation, draftStore: j.store, intakeId: INTAKE, now: () => j.now.t, applyToOrder: j.apply as any });
  assert.deepEqual(replay, { projection: 'committed', scheduleCompletionMetric: false });
  const conflict = await settleExpeditedPayment({ event: j.event({ id: 'evt_2' }, { payment_intent: 'pi_other' }), expectation: j.expectation, draftStore: j.store,
    intakeId: INTAKE, now: () => j.now.t, applyToOrder: j.apply as any });
  assert.equal(conflict.scheduleCompletionMetric, false);
  assert.equal(j.box.order.initialShippingSettlement.state, 'held');
  assert.equal(j.box.order.initialShippingSettlement.reason, 'receipt_conflict');
}));

test('refund/terminal wins every projection; replay cannot resurrect', () => withLuluEnv(async () => {
  const j = await lockedJourney();
  await settleExpeditedPayment({ event: j.event(), expectation: j.expectation, draftStore: j.store, intakeId: INTAKE, now: () => j.now.t, applyToOrder: j.apply as any });
  j.box.order = { ...j.box.order, refundedAt: new Date(T0).toISOString() };
  await settleExpeditedPayment({ event: j.event(), expectation: j.expectation, draftStore: j.store, intakeId: INTAKE, now: () => j.now.t, applyToOrder: j.apply as any });
  assert.equal(j.box.order.initialShippingSettlement.reason, 'refund_or_terminal');
  assert.equal(shippingCommitted({ ...j.box.order, refundedAt: null }), 'not_committed', 'held never auto-upgrades');
}));

test('private store ambiguity: write lost-response is exact-reread adopted; outage holds (not absent)', () => withLuluEnv(async () => {
  const j = await lockedJourney();
  j.blob.faults.putThrowAfter = true;
  const r = await settleExpeditedPayment({ event: j.event(), expectation: j.expectation, draftStore: j.store, intakeId: INTAKE, now: () => j.now.t, applyToOrder: j.apply as any });
  assert.deepEqual(r, { projection: 'committed', scheduleCompletionMetric: true });
  const k = await lockedJourney();
  k.blob.faults.getThrow = true;
  const h = await settleExpeditedPayment({ event: k.event(), expectation: k.expectation, draftStore: k.store, intakeId: INTAKE, now: () => k.now.t, applyToOrder: k.apply as any });
  assert.deepEqual(h, { projection: 'held', scheduleCompletionMetric: false });
  assert.equal(k.box.order.initialShippingSettlement.reason, 'receipt_unavailable');
}));
