import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
// Only SDK/storage and scheduling I/O are replaced. constructEvent stays real.
const { default: RealStripe } = await import('stripe');
const realBlob = await import('@vercel/blob');
const next = await import('next/server.js');
let privateSdk: any;
let orderFiles: Map<string, { body: string; version: number }>;
const scheduled: Array<() => unknown> = [];
const requests: any[] = [];
mock.module('@vercel/blob', { namedExports: { ...realBlob,
  list: async (opts: any) => {
    if (!opts.prefix?.startsWith('orders/')) throw new Error('UNMATCHED_BLOB_LIST');
    return { blobs: [...orderFiles.keys()].filter(p => p.startsWith(opts.prefix)).map(pathname => ({ pathname })), hasMore: false };
  },
  del: async () => { throw new Error('UNMATCHED_BLOB_DELETE'); },
  head: async () => { throw new Error('UNMATCHED_BLOB_HEAD'); },
  get: (...a: any[]) => privateSdk.io.get(...a), put: (...a: any[]) => privateSdk.io.put(...a) } });
mock.module('next/server.js', { namedExports: { ...next, after: (cb: unknown) => scheduled.push(cb as () => unknown) } });
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
  const clock = Date.now; const orders = syntheticOrderBlob(); orderFiles = orders.files; privateSdk = fakePrivateSdk(); scheduled.length = 0; requests.length = 0;
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).origin !== 'https://www.google-analytics.com') throw new Error('UNMATCHED_OUTBOUND');
    const body = JSON.parse(String(init?.body));
    const canonical = await getOrderAuthoritative(ORDER);
    assert.equal(canonical?.initialShippingSettlement?.state, 'committed');
    assert.ok(JSON.parse([...privateSdk.files.values()][0].body).completionMetricIntentAt);
    requests.push(body); return new Response(null, { status: 204 });
  };
  globalThis.setImmediate = ((cb: unknown) => { scheduled.push(cb as () => unknown); return { unref() {} }; }) as any;
  Object.assign(process.env, { VERCEL_ENV: 'production', GA4_MEASUREMENT_ID: 'G-VC2G7R7EX8', GA4_API_SECRET: 'synthetic-secret', STRIPE_SECRET_KEY: ['sk', 'test', 'synthetic'].join('_'), STRIPE_WEBHOOK_SECRET: 'whsec_synthetic',
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
      metadata: { ...params.metadata, gaClientId: '123456789.1700000000' }, ...sess } } });
  const expectation = { orderId: ORDER, metadata, stripeAccountBinding: PROVIDER.stripeAccountBinding, stripeLivemode: false,
    accountBindingOf: () => PROVIDER.stripeAccountBinding, expectedSessionId: 'cs_test_1' };
  let order: any = { id: ORDER, paymentStatus: 'paid', initialShipping: metadata, initialShippingSettlement: initialSettlement(new Date(T0)) };
  const box = { get order() { return order; }, set order(v) { order = v; } };
  const apply = async (mutate: any) => { const n = mutate(order); if (n) order = { ...order, initialShippingSettlement: n }; return n ? 'committed' : 'aborted'; };
  return { now, blob, store, metadata, event, expectation, box, apply };
}

async function drain() { for (const callback of scheduled) await callback(); await new Promise(resolve => setTimeout(resolve, 0)); }
const { dispatchTrustedShippingCompletion, scheduleTrustedShippingCompletion } = await import('../src/lib/purchase-analytics.ts');
const metric = { service_label: 'expedited', book_format: 'classic', outcome: 'paid', pricing_rule: 'landed-delta-v1' } as const;
const identity = { gaClientId: '123456789.1700000000' };
test('trusted production/config/identity gates and real MP failures are closed, typed and single-start', async () => {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', VERCEL_ENV: 'production', GA4_MEASUREMENT_ID: 'G-SYNTHETIC', GA4_API_SECRET: 'PRIVATE_SECRET' };
  let calls = 0; const fetchImpl: typeof fetch = async () => { calls++; return new Response(null, { status: 204 }); };
  assert.deepEqual(await dispatchTrustedShippingCompletion(metric, identity, { env: { NODE_ENV: 'test' }, fetchImpl }), { status: 'skipped', reason: 'not_production' });
  assert.deepEqual(await dispatchTrustedShippingCompletion(metric, identity, { env: { NODE_ENV: 'test', VERCEL_ENV: 'production' }, fetchImpl }), { status: 'skipped', reason: 'not_configured' });
  assert.deepEqual(await dispatchTrustedShippingCompletion(metric, {}, { env, fetchImpl }), { status: 'skipped', reason: 'unverified_settlement' });
  assert.equal(calls, 0);
  for (const [status, code] of [[400, 'ga4_http_4xx'], [503, 'ga4_http_5xx'], [302, 'ga4_http_other']] as const) {
    assert.deepEqual(await dispatchTrustedShippingCompletion(metric, identity, { env, fetchImpl: async () => new Response('PRIVATE_SECRET', { status }) }), { status: 'failed', code });
  }
  for (const [error, code] of [[new Error('PRIVATE_SECRET'), 'ga4_network'], [new DOMException('PRIVATE_SECRET', 'TimeoutError'), 'ga4_timeout']] as const) {
    assert.deepEqual(await dispatchTrustedShippingCompletion(metric, identity, { env, fetchImpl: async () => { throw error; } }), { status: 'failed', code });
  }
  const callbacks: Array<() => unknown> = []; const logs: string[] = [];
  scheduleTrustedShippingCompletion(metric, identity, { env, fetchImpl, setImmediateImpl: cb => callbacks.push(cb), afterImpl: cb => { callbacks.push(cb); }, log: line => logs.push(line) });
  await Promise.all(callbacks.map(cb => cb())); await new Promise(r => setTimeout(r, 0)); assert.equal(calls, 1);
  assert.deepEqual(logs, ['[shipping-analytics] ga4=sent']);
  scheduleTrustedShippingCompletion(metric, identity, { env, setImmediateImpl: () => { throw new Error('PRIVATE'); }, afterImpl: () => { throw new Error('PRIVATE'); } });
});
test('signed refusal/held/terminal matrix schedules no shipping completion and invalid signature writes nothing', () => withLuluEnv(async () => {
  for (const mode of ['invalid-signature', 'held', 'unpaid', 'failed', 'refunded', 'existing-hold']) await signedJourney(async j => {
    if (['failed', 'refunded', 'existing-hold'].includes(mode)) {
      const o = { ...j.order, ...(mode === 'existing-hold' ? { initialShippingSettlement: { version: 1, state: 'held', receiptDigest: null, reason: 'dispatch_cost_exceeded', updatedAt: new Date(T0).toISOString() } } : { paymentStatus: mode }) };
      // Existing canonical dispatch-cost hold is not a successful shipping commit.
      j.orders.files.set(j.path, { body: JSON.stringify(o), version: 2 });
    }
    const e = mode === 'held' ? j.event({ created: 0 }) : mode === 'unpaid' ? j.event({}, { payment_status: 'unpaid' }) : j.event();
    const response = await j.send(e, mode !== 'invalid-signature');
    assert.equal(response.status, mode === 'invalid-signature' ? 400 : 200); await drain(); assert.deepEqual(names(), []);
  });
}));
test('public CAS loser retries into refund/unchanged without a false winner', () => withLuluEnv(async () => {
  for (const race of ['refund', 'other-commit']) await signedJourney(async j => {
    const replace = j.orders.adapter.replaceIfVersion; let raced = false;
    j.orders.adapter.replaceIfVersion = async (path: string, body: string, version: string) => {
      const n = JSON.parse(body);
      if (!raced && path === j.path && n.initialShippingSettlement?.state === 'committed') {
        raced = true; const old = j.orders.files.get(path);
        j.orders.files.set(path, { body: race === 'refund' ? JSON.stringify({ ...JSON.parse(old.body), paymentStatus: 'refunded' }) : body, version: old.version + 1 });
      }
      return replace(path, body, version);
    };
    assert.equal((await j.send()).status, 200); await drain();
    assert.ok(raced); assert.equal(names().filter(n => n === 'shipping_payment_completed').length, 0);
  });
}));
test('transport failure cannot change paid acknowledgement or reclaim completion on replay', () => withLuluEnv(() => signedJourney(async j => {
  let attempts = 0; const logs: unknown[] = []; const warn = console.warn;
  console.warn = (...args) => { logs.push(args); };
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).origin !== 'https://www.google-analytics.com') throw new Error('UNMATCHED_OUTBOUND');
    if (JSON.parse(String(init?.body)).events[0].name === 'shipping_payment_completed') { attempts++; throw new Error('PRIVATE_SECRET recipient'); }
    return new Response(null, { status: 204 });
  };
  try {
    assert.equal((await j.send()).status, 200); await drain(); assert.equal(attempts, 1);
    assert.equal((await j.read()).initialShippingSettlement.state, 'committed');
    assert.equal((await j.send()).status, 200); await drain(); assert.equal(attempts, 1);
    assert.ok(JSON.stringify(logs).includes('ga4_network')); assert.ok(!JSON.stringify(logs).includes('PRIVATE_SECRET'));
  } finally { console.warn = warn; }
})));
const names = () => requests.flatMap(r => r.events.map((e: any) => e.name));
test('real signed HTTP winner emits one closed MP completion after durability; concurrent/replay no duplicates', () => withLuluEnv(() => signedJourney(async j => {
  assert.ok((await Promise.all([j.send(), j.send(), j.send()])).every(r => r.status === 200));
  await drain();
  assert.equal(names().filter(n => n === 'shipping_payment_completed').length, 1);
  assert.equal(names().filter(n => n === 'purchase').length, 1);
  const event = requests.flatMap(r => r.events).find(e => e.name === 'shipping_payment_completed');
  assert.deepEqual(event.params, { service_label: 'expedited', book_format: 'classic', outcome: 'paid', pricing_rule: 'landed-delta-v1', engagement_time_msec: 1 });
  assert.equal((await j.send()).status, 200); await drain(); assert.equal(requests.length, 2);
})));
test('receipt-first and financial-first crash repairs emit only first public commit, never repair purchase', () => withLuluEnv(async () => {
  for (const stage of ['financial', 'projection']) await signedJourney(async j => {
    const replace = j.orders.adapter.replaceIfVersion;
    j.orders.adapter.replaceIfVersion = async (path: string, body: string, version: string) => {
      const n = JSON.parse(body);
      if (path === j.path && (stage === 'financial' ? n.paymentStatus === 'paid' : n.initialShippingSettlement?.state === 'committed')) throw new Error('synthetic crash');
      return replace(path, body, version);
    };
    assert.equal((await j.send()).status, 500); assert.ok(j.draft().completionMetricIntentAt); assert.equal(scheduled.length, 0);
    j.orders.adapter.replaceIfVersion = replace;
    assert.equal((await j.send()).status, 200); await drain();
    assert.equal(names().filter(n => n === 'shipping_payment_completed').length, 1);
    assert.equal(names().filter(n => n === 'purchase').length, stage === 'financial' ? 1 : 0);
    assert.equal((await j.send()).status, 200); await drain();
    assert.equal(names().filter(n => n === 'shipping_payment_completed').length, 1);
  });
}));
test('ambiguous public commit acknowledgement is not a false winner and replay never reclaims it', () => withLuluEnv(() => signedJourney(async j => {
  const replace = j.orders.adapter.replaceIfVersion; let lost = false;
  j.orders.adapter.replaceIfVersion = async (path: string, body: string, version: string) => {
    const result = await replace(path, body, version);
    if (!lost && path === j.path && JSON.parse(body).initialShippingSettlement?.state === 'committed') { lost = true; throw new Error('synthetic lost commit acknowledgement'); }
    return result;
  };
  assert.equal((await j.send()).status, 500); assert.ok(lost); assert.equal(scheduled.length, 0);
  assert.equal((await j.read()).initialShippingSettlement.state, 'committed');
  assert.equal((await j.send()).status, 200); await drain(); assert.deepEqual(names(), []);
})));
test('private receipt ambiguous writes converge before exactly one public-commit metric', () => withLuluEnv(async () => {
  for (const after of [false, true]) await signedJourney(async j => {
    const put = j.sdk.io.put;
    j.sdk.io.put = async (...args: any[]) => { if (after) await put(...args); throw new Error('synthetic private write loss'); };
    const first = await j.send(); assert.equal(first.status, after ? 200 : 500);
    j.sdk.io.put = put;
    assert.equal((await j.send()).status, 200); await drain();
    assert.equal(names().filter(n => n === 'shipping_payment_completed').length, 1);
    assert.equal((await j.send(j.event({ id: 'evt_other' }))).status, 200); await drain();
    assert.equal(names().filter(n => n === 'shipping_payment_completed').length, 1);
  });
}));
test('committed response loss is intentionally not reclaimed', () => withLuluEnv(() => signedJourney(async j => {
  assert.equal((await j.send()).status, 200); scheduled.length = 0;
  assert.equal((await j.send()).status, 200); await drain(); assert.deepEqual(names(), []);
})));
