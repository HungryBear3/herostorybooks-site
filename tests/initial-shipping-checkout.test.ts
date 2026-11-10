import assert from 'node:assert/strict';
import { createIntakeRecord, createVercelIntakeStore } from '../src/lib/checkout-intake.ts';
import { createShippingRouteHandler } from '../src/lib/initial-shipping-checkout.ts';
import { fakePrivateSdk, fakeLuluFetch } from './support/initial-shipping-fixture.ts';
import { sha256 } from '../src/lib/initial-shipping-contract.ts';
import test from 'node:test';
import {
  parseInitialShippingCommercialPolicy, parseInitialShippingProviderQualification, planInitialShippingProduct,
  readInitialShippingFlags, readOrderInitialShipping, InitialShippingError,
} from '../src/lib/initial-shipping-contract.ts';
import { createDraftStore, putShippingContact, quoteShippingDraft, selectShippingQuote, clearShippingSelection } from '../src/lib/initial-shipping-draft.ts';
import {
  assertExpeditedProviderRelease, buildExpeditedStripeSessionParams, buildInitialShippingMetadata, confirmExpeditedPreProvider,
  initialSettlement, parseSelectedShippingQuoteId, shippingFingerprintTuple,
} from '../src/lib/initial-shipping-checkout.ts';
import { settleExpeditedPayment, shippingCommitted } from '../src/lib/initial-shipping-settlement.ts';
import { authorizationStillMatches, expeditedPrintJobBody, preclaimShippingGate, preflightExpeditedDispatch } from '../src/lib/initial-shipping-dispatch.ts';
import { decorateConfirmationWithShipping, publicShippingSummary } from '../src/lib/initial-shipping-summary.ts';
import { CAP, CONTACT, FP, INTAKE, NS, ORDER, POLICY_RAW, PROVIDER, STORE_ID, fakeBlob, fakeMarkerStore, realProducer, synthOrderId, withLuluEnv } from './support/initial-shipping-fixture.ts';

const T0 = 1_800_000_000_000;
const product = planInitialShippingProduct('classic', () => '0850X0850.FC.STD.PB.080CW444.GXX');
const ON = { quotes: true, checkout: true };
const code = (c: string) => (e: unknown) => e instanceof InitialShippingError && e.code === c;

function setup(now = { t: T0 }) {
  const blob = fakeBlob(); const markers = fakeMarkerStore();
  const store = createDraftStore(blob.io, { namespace: NS, storeId: STORE_ID });
  const deps = { store, namespace: NS, storeId: STORE_ID, now: () => now.t,
    verifyIntake: async (id: string, cap: string) => ({ ok: id === INTAKE && cap === CAP, expiresAtMs: T0 + 24 * 3600_000 }) };
  return { blob, markers, store, deps, now };
}
const ctx = (over: Partial<{ flags: any; commercial: any; provider: any }> = {}) => ({
  flags: ON, commercial: parseInitialShippingCommercialPolicy(POLICY_RAW), provider: PROVIDER, ...over });

test('actual shipping handler projects only recognized current policy label with no extra quote calls', () => withLuluEnv(async () => {
  for (const label of ['landed-delta-v1', 'private-person-name', null]) {
    const sdk = fakePrivateSdk(); const now = () => 1_800_000_000_000;
    const token = 'vercel_blob_rw_syntheticIntake_syntheticSecret';
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', HSB_CHECKOUT_DIRECT_UPLOAD: 'true', HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true',
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: token, HSB_INITIAL_EXPEDITED_COMMERCIAL_POLICY: label ? JSON.stringify({ ...POLICY_RAW, pricingRuleVersion: label }) : '',
      HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: JSON.stringify({ ...PROVIDER, accountBinding: sha256('synthetic-client') }) };
    const owner = createIntakeRecord({ mediaAuthorizedAt: new Date(now()).toISOString(), documentAuthorizedAt: null, childVoiceAuthorizedAt: null, voiceSource: null }, new Date(now()));
    await createVercelIntakeStore(token, env, sdk.io).create(owner.record);
    const seen: string[] = []; const handler = createShippingRouteHandler({ env, now, blob: sdk.io, fetch: fakeLuluFetch(seen) });
    const send = async (op: string, extra: object = {}) => {
      const response = await handler(new Request('https://example.test/api/checkout/shipping', {
        method: 'POST', headers: { origin: 'https://example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ op, intakeId: owner.record.intakeId, capability: owner.capability, ...extra }),
      }));
      assert.equal(response.status, 200); const body = await response.json();
      assert.equal(body.pricingRuleVersion, label === 'landed-delta-v1' ? label : undefined);
      assert.deepEqual(Object.keys(body).sort(), ['bookFormat','revision','bookCents','deltaCents','deltaTaxIncludedCents','totalCents','contact','selectedQuoteId','quote','estimate', ...(label === 'landed-delta-v1' ? ['pricingRuleVersion'] : [])].sort());
      return body;
    };
    await send('put_contact', { contact: CONTACT, bookFormat: 'classic' }); assert.equal(seen.length, 0);
    const q = await send('quote'); const count = seen.length; assert.ok(count > 0);
    await send('select', { quoteId: q.quote.quoteId }); await send('clear'); assert.equal(seen.length, count);
  }
}));
async function selectedDraft(s: ReturnType<typeof setup>) {
  await putShippingContact(s.deps, { intakeId: INTAKE, capability: CAP, contact: CONTACT, product, provider: PROVIDER });
  const quoted = await quoteShippingDraft(s.deps, { intakeId: INTAKE, capability: CAP, provider: PROVIDER, produce: realProducer(s.deps.now) });
  return selectShippingQuote(s.deps, { intakeId: INTAKE, capability: CAP, quoteId: quoted.quote!.quoteId });
}

test('flags default off; commercial and provider qualification refuse absent/partial policy', () => {
  assert.deepEqual(readInitialShippingFlags({}), { quotes: false, checkout: false });
  assert.deepEqual(readInitialShippingFlags({ HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: '1', HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'TRUE' }), { quotes: false, checkout: false });
  assert.deepEqual(parseInitialShippingCommercialPolicy(undefined), { qualified: false, reason: 'promotion_policy_unqualified' });
  assert.deepEqual(parseInitialShippingCommercialPolicy({ ...POLICY_RAW, ttl: { sessionTtlMs: 15 * 60_000, minimumQuoteRemainingMs: 31 * 60_000 } }),
    { qualified: false, reason: 'ttl_policy_unqualified' });
  assert.equal(parseInitialShippingCommercialPolicy({ ...POLICY_RAW, extra: 1 }).qualified, false);
  assert.equal(parseInitialShippingCommercialPolicy(POLICY_RAW).qualified, true);
  assert.equal(parseInitialShippingProviderQualification({ ...PROVIDER, selectedService: 'MAIL' }), null);
  assert.ok(parseInitialShippingProviderQualification({ ...PROVIDER }));
});

test('server product plan: classic 32 / premium 38, digital unsupported', () => {
  assert.equal(product.interiorPageCount, 32);
  assert.equal(planInitialShippingProduct('premium', () => 'PKG.PREMIUM.0001').interiorPageCount, 38);
  assert.throws(() => planInitialShippingProduct('digital', () => 'X'), code('format_unsupported'));
});

test('whole positive journey: quote -> select -> metadata -> lock+marker -> itemized params -> signed settle -> email -> fresh print gate', () => withLuluEnv(async () => {
  const s = setup();
  const selected = await selectedDraft(s);
  assert.equal(selected.state, 'selected');
  const quoteId = parseSelectedShippingQuoteId([selected.selectedQuoteId]);
  const metadata = buildInitialShippingMetadata({ draft: selected, selectedQuoteId: quoteId!, product, bookCents: 3999, ctx: ctx(), now: s.now.t });
  assert.equal(metadata.totals.deltaCents, 420); assert.equal(metadata.totals.totalCents, 4419); assert.equal(metadata.totals.deltaTaxIncludedCents, 20);
  const text = JSON.stringify(metadata);
  for (const canary of [CONTACT.name, CONTACT.phone, CONTACT.line1, CAP, INTAKE, PROVIDER.accountBinding]) assert.ok(!text.includes(canary), canary);
  assert.deepEqual(shippingFingerprintTuple(undefined), {});

  // provider session cannot be released before lock + marker
  await assert.rejects(assertExpeditedProviderRelease({ markerStore: s.markers.store, namespace: NS, orderId: ORDER, metadata, draft: selected, ctx: ctx(), now: s.now.t }), code('lock_conflict'));
  const locked = await confirmExpeditedPreProvider({ draftStore: s.store, markerStore: s.markers.store, namespace: NS, intakeId: INTAKE,
    capability: CAP, canonicalOrderId: ORDER, checkoutIntentFingerprint: FP, metadata, now: s.now.t });
  assert.equal(locked.state, 'locked');
  assert.deepEqual([...s.markers.files.values()].map((b) => JSON.parse(b)), [{ schema: 'hsb.initial-shipping-provenance.v1', orderId: ORDER, operation: 'initial_checkout_shipping' }]);
  await assertExpeditedProviderRelease({ markerStore: s.markers.store, namespace: NS, orderId: ORDER, metadata, draft: locked, ctx: ctx(), now: s.now.t });

  const params = buildExpeditedStripeSessionParams({ orderId: ORDER, metadata, bookProductName: 'Classic book', ctx: ctx(), now: s.now.t,
    successUrl: 'https://example.test/thank-you', cancelUrl: 'https://example.test/checkout', customerEmail: 'parent@example.test' }) as any;
  assert.deepEqual(params.line_items.map((l: any) => l.price_data.unit_amount), [3999, 420]);
  assert.equal(params.allow_promotion_codes, undefined); assert.equal(params.shipping_address_collection, undefined); assert.equal(params.automatic_tax, undefined);
  assert.ok(params.expires_at * 1000 <= metadata.quoteWindow.expiresAtMs);

  // canonical order view with typed metadata
  let order: any = { id: ORDER, paymentStatus: 'paid', initialShipping: metadata, initialShippingSettlement: initialSettlement(new Date(s.now.t)) };
  assert.equal(readOrderInitialShipping(order).kind, 'present');
  assert.equal(preclaimShippingGate(order), 'hold');
  const event = { id: 'evt_synthetic_1', type: 'checkout.session.completed', created: Math.floor((s.now.t + 60_000) / 1000), livemode: false,
    data: { object: { id: 'cs_test_synthetic', payment_intent: 'pi_synthetic', payment_status: 'paid', mode: 'payment', currency: 'usd',
      amount_total: 4419, amount_subtotal: 4419, client_reference_id: ORDER, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 },
      metadata: params.metadata } } };
  const expectation = { orderId: ORDER, metadata, stripeAccountBinding: PROVIDER.stripeAccountBinding, stripeLivemode: false,
    accountBindingOf: () => PROVIDER.stripeAccountBinding, expectedSessionId: 'cs_test_synthetic' };
  const apply = async (mutate: any) => { const n = mutate(order); if (n) order = { ...order, initialShippingSettlement: n }; return n ? 'committed' : 'aborted'; };
  s.now.t += 3 * 3600_000; // late delivery of the SAME timely signed event is accepted
  const first = await settleExpeditedPayment({ event, expectation, draftStore: s.store, intakeId: INTAKE, now: () => s.now.t, applyToOrder: apply as any });
  assert.deepEqual(first, { projection: 'committed', scheduleCompletionMetric: true });
  const replay = await settleExpeditedPayment({ event, expectation, draftStore: s.store, intakeId: INTAKE, now: () => s.now.t, applyToOrder: apply as any });
  assert.deepEqual(replay, { projection: 'none', scheduleCompletionMetric: false }, 'replay: no second metric');
  assert.equal(shippingCommitted(order), 'committed'); assert.equal(preclaimShippingGate(order), 'ok');

  const summary = publicShippingSummary(order);
  assert.equal(summary.kind, 'expedited');
  assert.ok(!JSON.stringify(summary).includes(CONTACT.phone) && !JSON.stringify(summary).includes('pi_synthetic'));
  const email = decorateConfirmationWithShipping({ subject: 's', text: 'base', html: '<body>base</body>' }, metadata);
  assert.match(email.text, /^base\n\nShipping: Expedited\nBook: \$39\.99\nStandard shipping: Included\nExpedited shipping upgrade: \$4\.20/);
  assert.match(email.html, /Expedited shipping upgrade<\/td><td style="text-align:right">\$4\.20/);
  assert.deepEqual(decorateConfirmationWithShipping({ subject: 's', text: 'base', html: 'h' }, null), { subject: 's', text: 'base', html: 'h' });

  const artifact = { interiorPageCount: 32, podPackageId: product.podPackageId, layoutVersion: 'modern_full_bleed',
    interiorSha256: '1'.repeat(64), coverSha256: '2'.repeat(64), proofSha256: '3'.repeat(64) };
  const costCalls: any[] = [];
  const pre = await preflightExpeditedDispatch({ order, artifact, draftStore: s.store, intakeId: INTAKE, provider: PROVIDER, now: () => s.now.t,
    freshSelectedCost: async (r) => { costCalls.push(r); return { available: true, totalCents: 2180 }; } });
  assert.equal(pre.kind, 'authorized');
  assert.equal(costCalls[0].pageCount, 32); assert.equal(costCalls[0].service, 'EXPEDITED');
  const auth = (pre as any).authorization;
  assert.equal(authorizationStillMatches(auth, order, artifact, s.now.t + 1000), true);
  assert.equal(authorizationStillMatches(auth, { ...order, refundedAt: 'x' }, artifact, s.now.t), false, 'refund between preflight and CAS');
  assert.equal(authorizationStillMatches(auth, order, { ...artifact, proofSha256: '4'.repeat(64) }, s.now.t), false, 'proof change');
  assert.equal(authorizationStillMatches(auth, { ...order, printSubmissionAttemptedAt: 'x' }, artifact, s.now.t), false, 'marker already set');
  const body = expeditedPrintJobBody(auth, { interiorUrl: 'https://f/i.pdf', coverUrl: 'https://f/c.pdf' }, 'parent@example.test') as any;
  assert.equal(body.shipping_level, 'EXPEDITED'); assert.equal(body.shipping_address.phone_number, CONTACT.phone); assert.equal(body.shipping_address.name, CONTACT.name);

  const over = await preflightExpeditedDispatch({ order, artifact, draftStore: s.store, intakeId: INTAKE, provider: PROVIDER, now: () => s.now.t,
    freshSelectedCost: async () => ({ available: true, totalCents: 2181 }) });
  assert.deepEqual(over, { kind: 'hold', reason: 'dispatch_cost_exceeded' });
  const drift = await preflightExpeditedDispatch({ order, artifact: { ...artifact, interiorPageCount: 34 }, draftStore: s.store, intakeId: INTAKE,
    provider: PROVIDER, now: () => s.now.t, freshSelectedCost: async () => ({ available: true, totalCents: 1 }) });
  assert.deepEqual(drift, { kind: 'hold', reason: 'dispatch_artifact_drift' });
  const acct = await preflightExpeditedDispatch({ order, artifact, draftStore: s.store, intakeId: INTAKE, provider: { ...PROVIDER, accountBinding: 'e'.repeat(64) },
    now: () => s.now.t, freshSelectedCost: async () => ({ available: true, totalCents: 1 }) });
  assert.deepEqual(acct, { kind: 'hold', reason: 'dispatch_account_drift' });
}));

test('refusals before provider create: flag off, unqualified promotion/ttl/provider, wrong owner, duplicate quote id, product drift', () => withLuluEnv(async () => {
  const s = setup();
  const selected = await selectedDraft(s);
  const id = selected.selectedQuoteId!;
  const mk = (c: any, extra: any = {}) => () => buildInitialShippingMetadata({ draft: selected, selectedQuoteId: id, product, bookCents: 3999, ctx: c, now: s.now.t, ...extra });
  assert.throws(mk(ctx({ flags: { quotes: true, checkout: false } })), code('flag_off'));
  assert.throws(mk(ctx({ commercial: parseInitialShippingCommercialPolicy(null) })), code('promotion_policy_unqualified'));
  assert.throws(mk(ctx({ provider: null })), code('provider_unqualified'));
  assert.throws(mk(ctx(), { product: planInitialShippingProduct('premium', () => '0850X0850.FC.STD.PB.080CW444.GXX') }), code('product_drift'));
  assert.throws(mk(ctx(), { selectedQuoteId: '00000000-0000-4000-8000-000000000000' }), code('selection_invalid'));
  assert.throws(() => parseSelectedShippingQuoteId([id, id]), code('selection_invalid'));
  assert.throws(() => parseSelectedShippingQuoteId(['not-a-quote']), code('selection_invalid'));
  await assert.rejects(selectShippingQuote(s.deps, { intakeId: INTAKE, capability: 'wrong-capability-' + 'x'.repeat(40), quoteId: id }), code('owner_invalid'));
  // address edit clears paid choice without touching anything else
  const edited = await putShippingContact(s.deps, { intakeId: INTAKE, capability: CAP, contact: { ...CONTACT, zip: '60602' }, product, provider: PROVIDER });
  assert.equal(edited.state, 'editing'); assert.equal(edited.selectedQuoteId, null); assert.equal(edited.revision, selected.revision + 1);
  const cleared = await clearShippingSelection(s.deps, { intakeId: INTAKE, capability: CAP });
  assert.equal(cleared.quote, null);
}));

test('stale quote response after a concurrent contact edit is fenced (never applied)', () => withLuluEnv(async () => {
  const s = setup();
  await putShippingContact(s.deps, { intakeId: INTAKE, capability: CAP, contact: CONTACT, product, provider: PROVIDER });
  const real = realProducer(s.deps.now);
  await assert.rejects(quoteShippingDraft(s.deps, { intakeId: INTAKE, capability: CAP, provider: PROVIDER, produce: async (input, cap) => {
    const q = await real(input, cap);
    await putShippingContact(s.deps, { intakeId: INTAKE, capability: CAP, contact: { ...CONTACT, city: 'Evanston' }, product, provider: PROVIDER });
    return q;
  } }), code('quote_stale'));
  const cur = await s.store.read(INTAKE);
  assert.equal(cur!.record.quote, null);
}));

test('default production provenance: lock -> marker create -> exact readback -> release without an injected marker store', () => withLuluEnv(async () => {
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const keys = ['BLOB_READ_WRITE_TOKEN', 'HSB_ORDER_STORE_DIR', 'HSB_BLOB_NAMESPACE', 'HSB_REQUIRE_DURABLE_PERSISTENCE', 'VERCEL', 'NODE_ENV'] as const;
  const old = keys.map((k) => [k, process.env[k]] as const);
  const root = await mkdtemp(path.join(os.tmpdir(), 'hsb-prov-checkout-'));
  for (const k of keys) delete process.env[k];
  process.env.HSB_ORDER_STORE_DIR = root;
  try {
    const s = setup();
    const selected = await selectedDraft(s);
    const metadata = buildInitialShippingMetadata({ draft: selected, selectedQuoteId: selected.selectedQuoteId!, product, bookCents: 3999, ctx: ctx(), now: s.now.t });
    const markerFile = (id: string) => path.join(root, 'order-provenance', 'initial-shipping', '.flat', `${id}.json`);
    // explicit unavailable store holds before the provider boundary
    await assert.rejects(confirmExpeditedPreProvider({ draftStore: s.store, markerStore: null, intakeId: INTAKE, capability: CAP,
      canonicalOrderId: ORDER, checkoutIntentFingerprint: FP, metadata, now: s.now.t }), code('provenance_unavailable'));
    const locked = await confirmExpeditedPreProvider({ draftStore: s.store, intakeId: INTAKE, capability: CAP,
      canonicalOrderId: ORDER, checkoutIntentFingerprint: FP, metadata, now: s.now.t });
    assert.equal(locked.state, 'locked');
    assert.deepEqual(JSON.parse(await readFile(markerFile(ORDER), 'utf8')), { schema: 'hsb.initial-shipping-provenance.v1', orderId: ORDER, operation: 'initial_checkout_shipping' });
    await assertExpeditedProviderRelease({ orderId: ORDER, metadata, draft: locked, ctx: ctx(), now: s.now.t });
    // malformed / absent marker blocks release; production without token holds
    const lockedOther = { ...locked, lock: { ...locked.lock!, canonicalOrderId: synthOrderId('b') } };
    await assert.rejects(assertExpeditedProviderRelease({ orderId: synthOrderId('b'), metadata, draft: lockedOther, ctx: ctx(), now: s.now.t }), code('provenance_unavailable'));
    await mkdir(path.dirname(markerFile(synthOrderId('b'))), { recursive: true });
    await writeFile(markerFile(synthOrderId('b')), '{"schema":"tampered"}');
    await assert.rejects(assertExpeditedProviderRelease({ orderId: synthOrderId('b'), metadata, draft: lockedOther, ctx: ctx(), now: s.now.t }), code('provenance_unavailable'));
    process.env.VERCEL = '1';
    await assert.rejects(assertExpeditedProviderRelease({ orderId: ORDER, metadata, draft: locked, ctx: ctx(), now: s.now.t }), code('provenance_unavailable'));
    delete process.env.VERCEL;
    // a different draft namespace than the bound order-store namespace cannot confirm
    process.env.HSB_BLOB_NAMESPACE = 'nsA';
    await assert.rejects(assertExpeditedProviderRelease({ orderId: ORDER, metadata, draft: locked, ctx: ctx(), now: s.now.t }), code('provenance_unavailable'));
  } finally {
    await rm(root, { recursive: true, force: true });
    const env = process.env as Record<string, string | undefined>;
    for (const [k, v] of old) { if (v === undefined) delete env[k]; else env[k] = v; }
  }
}));

test('two attempts converge on one lock; a different canonical order is refused; marker outage holds', () => withLuluEnv(async () => {
  const s = setup();
  const selected = await selectedDraft(s);
  const metadata = buildInitialShippingMetadata({ draft: selected, selectedQuoteId: selected.selectedQuoteId!, product, bookCents: 3999, ctx: ctx(), now: s.now.t });
  const args = { draftStore: s.store, markerStore: s.markers.store, namespace: NS, intakeId: INTAKE, capability: CAP, canonicalOrderId: ORDER,
    checkoutIntentFingerprint: FP, metadata, now: s.now.t };
  const [a, b] = await Promise.allSettled([confirmExpeditedPreProvider(args), confirmExpeditedPreProvider(args)]);
  assert.ok(a.status === 'fulfilled' || b.status === 'fulfilled');
  await confirmExpeditedPreProvider(args); // idempotent replay (order created, lock present)
  await assert.rejects(confirmExpeditedPreProvider({ ...args, canonicalOrderId: synthOrderId('b') }), code('lock_conflict'));
  const s2 = setup(); const sel2 = await selectedDraft(s2);
  const md2 = buildInitialShippingMetadata({ draft: sel2, selectedQuoteId: sel2.selectedQuoteId!, product, bookCents: 3999, ctx: ctx(), now: s2.now.t });
  s2.markers.faults.createThrowBefore = true;
  await assert.rejects(confirmExpeditedPreProvider({ ...args, draftStore: s2.store, markerStore: s2.markers.store, metadata: md2 }), code('provenance_unavailable'));
  // expired quote window before marker
  await assert.rejects(confirmExpeditedPreProvider({ ...args, now: metadata.quoteWindow.expiresAtMs }), code('session_expired'));
}));
