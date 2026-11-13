import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createHash } from 'node:crypto';
// Install the catchall before importing SDK consumers; no network fallback.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('UNMATCHED_OUTBOUND'); };
const blob = await import('@vercel/blob');
let sdk: any; let files: Map<string, any>;
mock.module('@vercel/blob', { namedExports: { ...blob,
  get: (...a: any[]) => sdk.io.get(...a), put: (...a: any[]) => sdk.io.put(...a),
  list: async () => ({ blobs: [], hasMore: false }),
  head: async () => { throw new Error('UNMATCHED_HEAD'); }, del: async () => { throw new Error('UNMATCHED_DEL'); },
} });
mock.module('../src/lib/order-email.ts', { namedExports: Object.fromEntries(['sendLifecycleEmail','sendProofReadyEmail','sendDigitalDeliveryEmail','sendOperatorFailureAlert'].map(k => [k, async () => {}])) });
const { approvePrintProof, proofSourceFingerprint, normalizePageArtifactTextLayouts } = await import('../src/lib/fulfillment.ts');
const { submitPrintJob, podPackageIdForFormat } = await import('../src/lib/lulu.ts');
const { createOrderRecord, getOrderAuthoritative, checkoutIntakeOrderContractDigest } = await import('../src/lib/orders.ts');
const { createIntakeRecord, createVercelIntakeStore, finalizationFingerprint } = await import('../src/lib/checkout-intake.ts');
const { createShippingRouteHandler, buildInitialShippingMetadata, confirmExpeditedPreProvider } = await import('../src/lib/initial-shipping-checkout.ts');
const { createPrivateShippingDraftAccess } = await import('../src/lib/initial-shipping-draft.ts');
const { receiptDigest, classifySignedPayment, recordPrivateReceipt } = await import('../src/lib/initial-shipping-settlement.ts');
const { sha256, planInitialShippingProduct, parseInitialShippingCommercialPolicy } = await import('../src/lib/initial-shipping-contract.ts');
const { PROVIDER, POLICY_RAW, CONTACT, FP, ORDER, fakePrivateSdk, fakeLuluFetch, syntheticOrderBlob, fakeMarkerStore } = await import('./support/initial-shipping-fixture.ts');
const { padPageSet } = await import('./support/full-page-set.ts');
const pdf = Buffer.from('%PDF-1.4\nsynthetic immutable bytes\n%%EOF');
const md5 = createHash('md5').update(pdf).digest('hex');
const artifact = (name: string) => `https://syntheticorders.public.blob.vercel-storage.com/orders/${ORDER}/${name}.pdf`;
async function journey(run: (j: any) => Promise<void>) {
  const env = { ...process.env }; const orders = syntheticOrderBlob(); files = orders.files; sdk = fakePrivateSdk();
  const privateGet = sdk.io.get;
  sdk.io.get = async (path: string, options: any) => {
    if (path.startsWith('orders/')) { const f = files.get(path); return f ? { stream: new Response(f.body).body, blob: { etag: String(f.version) } } : null; }
    return privateGet(path, options);
  };
  const provider = { ...PROVIDER, accountBinding: sha256('synthetic-client') };
  Object.assign(process.env, { LULU_CLIENT_KEY: 'synthetic-client', LULU_CLIENT_SECRET: 'synthetic-secret', LULU_API_URL: PROVIDER.endpointOrigin,
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticorders_syntheticSecret', HSB_BLOB_ACCESS_MODE: 'private', HSB_REQUIRE_DURABLE_PERSISTENCE: 'true',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticintake_syntheticSecret', HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true', HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'true',
    HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: JSON.stringify(provider), HSB_INITIAL_EXPEDITED_COMMERCIAL_POLICY: JSON.stringify(POLICY_RAW) });
  const posts: any[] = []; const reads: string[] = []; let mode = 'ok'; let hook: ((u: string) => Promise<void>) | undefined;
  const transport = fakeLuluFetch();
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url); await hook?.(u);
    if (u.startsWith('https://syntheticorders.public.blob.vercel-storage.com/')) {
      reads.push(u); return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) } });
    }
    if (u === PROVIDER.endpointOrigin + '/print-jobs/') {
      posts.push(JSON.parse(init.body));
      if (mode === 'lost') throw new Error(JSON.stringify(CONTACT));
      if (mode === 'error') return new Response(JSON.stringify(CONTACT), { status: 400 });
      return Response.json({ id: 'synthetic-job' });
    }
    return transport(url, init);
  }) as typeof fetch;
  try {
    const owner = createIntakeRecord({ mediaAuthorizedAt: new Date().toISOString(), documentAuthorizedAt: null, childVoiceAuthorizedAt: null, voiceSource: null });
    const intake = createVercelIntakeStore(process.env.HSB_INTAKE_BLOB_READ_WRITE_TOKEN!, process.env, sdk.io); await intake.create(owner.record);
    const route = createShippingRouteHandler({ blob: sdk.io });
    const send = (op: string, extra: any = {}) => route(new Request('https://example.test/api/checkout/shipping', { method: 'POST',
      headers: { origin: 'https://example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ op, intakeId: owner.record.intakeId, capability: owner.capability, ...extra }) }));
    assert.equal((await send('put_contact', { contact: CONTACT, bookFormat: 'classic' })).status, 200);
    const q = await (await send('quote')).json(); assert.ok(q.quote);
    assert.equal((await send('select', { quoteId: q.quote.quoteId })).status, 200);
    const access = createPrivateShippingDraftAccess(process.env, sdk.io); const selected = (await access.store.read(owner.record.intakeId))!.record;
    const metadata = buildInitialShippingMetadata({ draft: selected, selectedQuoteId: q.quote.quoteId,
      product: planInitialShippingProduct('classic', podPackageIdForFormat), bookCents: 3999,
      ctx: { flags: { quotes: true, checkout: true }, commercial: parseInitialShippingCommercialPolicy(POLICY_RAW), provider }, now: Date.now() });
    await confirmExpeditedPreProvider({ draftStore: access.store, markerStore: fakeMarkerStore().store, intakeId: owner.record.intakeId, capability: owner.capability,
      canonicalOrderId: ORDER, checkoutIntentFingerprint: FP, metadata, now: Date.now() });
    const event: any = { id: 'evt_synthetic', type: 'checkout.session.completed', created: Math.ceil(Date.now()/1000), livemode: false,
      data: { object: { id: 'cs_synthetic', payment_intent: 'pi_synthetic', payment_status: 'paid', mode: 'payment', currency: 'usd',
        amount_total: 4419, amount_subtotal: 4419, client_reference_id: ORDER, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 },
        metadata: { orderId: ORDER, hsbShipping: 'initial_expedited_v1', hsbShippingQuote: metadata.quoteId, hsbShippingBinding: metadata.quoteBindingDigest.slice(0,32) } } } };
    const classification = classifySignedPayment(event, { orderId: ORDER, metadata, stripeAccountBinding: provider.stripeAccountBinding,
      stripeLivemode: false, accountBindingOf: () => provider.stripeAccountBinding, expectedSessionId: 'cs_synthetic' });
    assert.equal(classification.kind, 'timely');
    await recordPrivateReceipt(access.store, owner.record.intakeId, ORDER, classification as any, Date.now());
    const payment = (await access.store.read(owner.record.intakeId))!.record.payment!;
    const order: any = { ...createOrderRecord({ childName: 'Synthetic Child', email: 'synthetic@example.invalid', bookFormat: 'classic' }, { id: ORDER }),
      paymentStatus: 'paid', paidAt: new Date().toISOString(), priceCents: 3999, stripeSessionId: 'cs_synthetic', stripePaymentIntentId: 'pi_synthetic', checkoutIntentFingerprint: FP,
      checkoutIntake: { intakeId: owner.record.intakeId, selection: [], fingerprint: finalizationFingerprint(owner.record.intakeId, []), orderContractDigest: '' },
      checkoutIntakeMediaRetention: { status: 'active', activatedAt: new Date().toISOString() }, initialShipping: metadata,
      initialShippingSettlement: { version: 1, state: 'committed', receiptDigest: receiptDigest(payment), reason: null, updatedAt: new Date().toISOString() },
      fulfillmentStatus: 'proof_ready', status: 'preview_ready', reviewStatus: 'approved', layoutVersion: 'modern_full_bleed',
      pageArtifacts: normalizePageArtifactTextLayouts(padPageSet([])), proofApprovalToken: 'synthetic-approval', proofVersion: 'proof-v1',
      proofReviewedVersion: 'proof-v1', proofReviewedAt: new Date().toISOString(), storyArtifactUrl: artifact('proof'),
      printInteriorArtifactUrl: artifact('interior'), printInteriorMd5: md5, printInteriorPageCount: 32, printInteriorProofVersion: 'proof-v1',
      printCoverArtifactUrl: artifact('cover'), printCoverMd5: md5, printTitle: 'Synthetic book' };
    order.updatedAt = new Date().toISOString(); // retention activation must not postdate updatedAt
    order.proofSourceFingerprint = proofSourceFingerprint(order);
    order.checkoutIntake.orderContractDigest = checkoutIntakeOrderContractDigest(order);
    const path = `orders/${ORDER}.json`; files.set(path, { body: JSON.stringify(order), version: 1 });
    process.env.HSB_INITIAL_EXPEDITED_QUOTES_ENABLED = 'false'; process.env.HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED = 'false';
    const edit = (patch: any) => { const f = files.get(path)!; files.set(path, { body: JSON.stringify({ ...JSON.parse(f.body), ...patch }), version: f.version + 1 }); };
    try { await run({ order, posts, reads, sdk, edit, read: () => getOrderAuthoritative(ORDER), approve: (deps: any = {}) => approvePrintProof(ORDER, 'synthetic-approval', deps),
      adapter: orders.adapter,
      mode: (v: string) => { mode = v; }, hook: (fn: any) => { hook = fn; } }); }
    catch (error) { if (error instanceof Error && error.cause) throw error.cause; throw error; }
  } finally { orders.close(); globalThis.fetch = async () => { throw new Error('UNMATCHED_OUTBOUND'); }; for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
}
test('real approval/default adapter dispatches selected service and private real contact after final bytes/cost', () => journey(async j => {
  const result = await j.approve(); assert.equal(result.ok, true, JSON.stringify({ result, error: (await j.read())?.fulfillmentLastError })); assert.equal(j.posts.length, 1);
  assert.equal(j.posts[0].shipping_level, 'EXPEDITED'); assert.equal(j.posts[0].shipping_address.name, CONTACT.name);
  assert.equal(j.posts[0].shipping_address.phone_number, CONTACT.phone); assert.equal(j.posts[0].line_items[0].quantity, 1);
  assert.equal((await j.read()).printJobId, 'synthetic-job'); assert.equal(j.reads.length, 3);
}));
test('direct adapter cannot bypass expedited dispatch authority', () => journey(async j => {
  await assert.rejects(() => submitPrintJob(j.order), /shipping/); assert.equal(j.posts.length, 0);
}));
test('missing private receipt holds paid canonical order with zero POST', () => journey(async j => {
  j.sdk.faults.unavailable = true; assert.equal((await j.approve()).ok, false);
  const o = await j.read(); assert.equal(o.paymentStatus, 'paid'); assert.equal(o.fulfillmentStatus, 'failed_manual_review');
  assert.match(o.fulfillmentLastError, /dispatch_private_unavailable/); assert.equal(j.posts.length, 0); assert.ok(!o.printSubmissionAttemptedAt);
}));
for (const mode of ['lost','error']) test(`provider ${mode} is sanitized and fenced against repeated approval`, () => journey(async j => {
  j.mode(mode); assert.equal((await j.approve()).ok, false); await j.approve(); assert.equal(j.posts.length, 1);
  const o = await j.read(); assert.ok(o.printSubmissionAttemptedAt); assert.match(o.fulfillmentLastError, /ambiguous/);
  assert.ok(!JSON.stringify(o).includes(CONTACT.name)); assert.ok(!o.printJobId);
}));
test('proof replacement during slow cover cannot authorize old generated cover for a new proof', () => journey(async j => {
  j.edit({ printCoverArtifactUrl: null, printCoverMd5: null });
  const result = await j.approve({ calculateCoverDimensions: async () => {
    j.edit({ proofVersion: 'proof-v2', proofReviewedVersion: 'proof-v2', printInteriorProofVersion: 'proof-v2' });
    return { widthPt: 1200, heightPt: 600 };
  }, buildPrintCoverPdf: () => pdf, uploadArtifact: async () => artifact('cover') });
  assert.equal(result.ok, false); assert.equal(j.posts.length, 0); assert.ok(!(await j.read()).printSubmissionAttemptedAt);
}));
test('standard approval retains original payload and never reads private dispatch artifacts', () => journey(async j => {
  // Standard lane: the Stripe-collected contact lives on the order (never the private expedited CONTACT).
  j.edit({ initialShipping: undefined, initialShippingSettlement: undefined,
    shippingAddress: { line1: '1 Standard Way', line2: null, city: 'Springfield', state: 'IL', zip: '62701', country: 'US', name: 'Standard Recipient', phone: '+12175550123' } });
  assert.equal((await j.approve()).ok, true); assert.equal(j.posts.length, 1); assert.equal(j.posts[0].shipping_level, 'MAIL');
  assert.equal(j.posts[0].shipping_address.phone_number, '+12175550123');
  assert.equal(j.posts[0].line_items[0].interior.source_md5_sum, md5); assert.equal(j.reads.length, 0);
}));
for (const mode of ['uncommitted','malformed','private-malformed','wrong-account','wrong-endpoint','wrong-store','page-count','layout','md5','foreign-url','foreign-path','proof-source','refunded']) {
  test(`real dispatch refusal: ${mode}`, () => journey(async j => {
    if (mode === 'uncommitted') j.edit({ initialShippingSettlement: { ...j.order.initialShippingSettlement, state: 'unverified', receiptDigest: null } });
    if (mode === 'malformed') j.edit({ initialShipping: { version: 9 } });
    if (mode === 'private-malformed') { const p = [...j.sdk.files.keys()].find((p: string) => p.startsWith('checkout-shipping-drafts/')); j.sdk.files.set(p, { body: '{}', etag: '99' }); }
    if (mode === 'wrong-account') process.env.LULU_CLIENT_KEY = 'different-client';
    if (mode === 'wrong-endpoint') process.env.LULU_API_URL = 'https://api.lulu.com';
    if (mode === 'wrong-store') process.env.HSB_INTAKE_BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_otherintake_syntheticSecret';
    if (mode === 'page-count') j.edit({ printInteriorPageCount: 34 });
    if (mode === 'layout') j.edit({ layoutVersion: 'legacy_bottom_band' });
    if (mode === 'md5') j.edit({ printInteriorMd5: '0'.repeat(32) });
    if (mode === 'foreign-url') j.edit({ printInteriorArtifactUrl: 'https://foreign.public.blob.vercel-storage.com/orders/x/interior.pdf' });
    if (mode === 'foreign-path') j.edit({ printInteriorArtifactUrl: artifact('interior').replace('/orders/', '/foreign/') });
    if (mode === 'proof-source') j.edit({ proofSourceFingerprint: '0'.repeat(64) });
    if (mode === 'refunded') j.edit({ paymentStatus: 'refunded', refundedAt: new Date().toISOString() });
    const result = await j.approve(); assert.equal(result.ok, false); assert.equal(j.posts.length, 0);
    const o = await j.read(); assert.ok(!o.printSubmissionAttemptedAt); assert.ok(!o.printJobId);
    assert.equal(o.paymentStatus, mode === 'refunded' ? 'refunded' : 'paid');
  }));
}
for (const mode of ['type','length','redirect','oversize-header','oversize-stream','bad-signature','missing','read-failure']) {
  test(`trusted artifact reader refuses and cancels: ${mode}`, () => journey(async j => {
    const fetch = globalThis.fetch; let cancelled = false; let accessed = false;
    globalThis.fetch = (async (url: any, init: any) => {
      if (!String(url).startsWith('https://syntheticorders.public.')) return fetch(url, init);
      accessed = true; assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store'); assert.ok(init.signal);
      let sent = false;
      const stream = new ReadableStream({ pull(c) {
        if (mode === 'read-failure') { c.error(new Error(JSON.stringify(CONTACT))); return; }
        if (sent) { if (mode !== 'oversize-stream') c.close(); return; } sent = true;
        c.enqueue(mode === 'oversize-stream' ? new Uint8Array(64 * 1024 * 1024 + 1) : mode === 'bad-signature' ? Buffer.from('not PDF bytes') : pdf);
      }, cancel() { cancelled = true; } });
      return new Response(stream, { status: mode === 'missing' ? 404 : mode === 'redirect' ? 302 : 200,
        headers: { 'content-type': mode === 'type' ? 'text/html' : 'application/pdf',
          'content-length': String(mode === 'oversize-header' ? 64 * 1024 * 1024 + 1 : mode === 'length' ? pdf.length + 1 : pdf.length) } });
    }) as typeof fetch;
    assert.equal((await j.approve()).ok, false); assert.ok(accessed); assert.equal(j.posts.length, 0);
    assert.match((await j.read()).fulfillmentLastError, /dispatch_artifact_drift/);
    if (['type','redirect','oversize-header','oversize-stream','missing'].includes(mode)) assert.ok(cancelled);
  }));
}
for (const mode of ['cost-increase','unavailable','cost-error']) test(`fresh selected cost refuses ${mode}`, () => journey(async j => {
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (mode === 'unavailable' && String(url).endsWith('/shipping-options/')) return Response.json([{ level: 'MAIL' }]);
    if (String(url).endsWith('/print-job-cost-calculations/') && JSON.parse(init.body).shipping_option === 'EXPEDITED') {
      if (mode === 'cost-error') throw new Error(JSON.stringify(CONTACT));
      const { luluCost } = await import('./support/initial-shipping-fixture.ts'); return Response.json(luluCost(1900, 70));
    }
    return fetch(url, init);
  }) as typeof fetch;
  assert.equal((await j.approve()).ok, false); assert.equal(j.posts.length, 0); assert.ok(!(await j.read()).printSubmissionAttemptedAt);
}));
for (const mode of ['refund','proof','receipt','artifact','expiry']) test(`canonical attempt fence rejects ${mode} after fresh cost`, () => journey(async j => {
  let costSeen = false; j.hook(async (u: string) => { if (u.endsWith('/print-job-cost-calculations/')) costSeen = true; });
  const replace = j.adapter.replaceIfVersion; const clock = Date.now;
  j.adapter.replaceIfVersion = async (path: string, body: string, version: string) => {
    if (costSeen && path === `orders/${ORDER}.json` && JSON.parse(body).printSubmissionAttemptedAt) {
      costSeen = false;
      if (mode === 'refund') j.edit({ refundedAt: new Date().toISOString(), paymentStatus: 'refunded' });
      if (mode === 'proof') j.edit({ proofVersion: 'proof-v2', printInteriorProofVersion: 'proof-v2', proofReviewedVersion: 'proof-v2' });
      if (mode === 'receipt') j.edit({ initialShippingSettlement: { ...j.order.initialShippingSettlement, receiptDigest: '0'.repeat(64) } });
      if (mode === 'artifact') j.edit({ printCoverArtifactUrl: artifact('replacement') });
      if (mode === 'expiry') { j.edit({}); const t = clock() + 11 * 60_000; Date.now = () => t; }
    }
    return replace(path, body, version);
  };
  try { assert.equal((await j.approve()).ok, false); assert.equal(j.posts.length, 0); assert.ok(!(await j.read()).printSubmissionAttemptedAt); }
  finally { Date.now = clock; }
}));
test('refund during cover remains refunded with zero POST', () => journey(async j => {
  j.edit({ printCoverArtifactUrl: null, printCoverMd5: null });
  assert.equal((await j.approve({ calculateCoverDimensions: async () => { j.edit({ paymentStatus: 'refunded', refundedAt: new Date().toISOString() }); return { widthPt: 1200, heightPt: 600 }; },
    buildPrintCoverPdf: () => pdf, uploadArtifact: async () => artifact('cover') })).ok, false);
  assert.equal((await j.read()).paymentStatus, 'refunded'); assert.equal(j.posts.length, 0);
}));
test('generated cover reuses its exact bytes instead of refetching', () => journey(async j => {
  j.edit({ printCoverArtifactUrl: null, printCoverMd5: null });
  assert.equal((await j.approve({ calculateCoverDimensions: async () => ({ widthPt: 1200, heightPt: 600 }), buildPrintCoverPdf: () => pdf,
    uploadArtifact: async () => artifact('cover') })).ok, true);
  assert.equal(j.posts.length, 1); assert.equal(j.reads.length, 2);
}));
test('final artifact authorization contains actual SHA256, and copied capability cannot authorize the adapter', () => journey(async j => {
  j.edit({ proofApprovedAt: new Date().toISOString(), fulfillmentStatus: 'submitting_to_print' });
  const { prepareProductionDispatch } = await import('../src/lib/initial-shipping-dispatch.ts');
  const preflight = await prepareProductionDispatch(await j.read()); assert.equal(preflight.kind, 'authorized');
  if (preflight.kind !== 'authorized') return;
  const expected = createHash('sha256').update(pdf).digest('hex');
  assert.deepEqual([preflight.authorization.artifact.interiorSha256, preflight.authorization.artifact.coverSha256, preflight.authorization.artifact.proofSha256], [expected, expected, expected]);
  assert.ok(Object.isFrozen(preflight.authorization));
  await assert.rejects(() => submitPrintJob({ ...j.order, printSubmissionAttemptedAt: new Date().toISOString(), printSubmissionProofVersion: 'proof-v1' },
    { authorization: { ...preflight.authorization } }), /shipping_dispatch_authorization_required/);
  assert.equal(j.posts.length, 0);
}));
test('artifact timeout cancels stalled stream and persists a paid hold', () => journey(async j => {
  const fetch = globalThis.fetch; let cancelled = false;
  globalThis.fetch = (async (url: any, init: any) => {
    if (!String(url).startsWith('https://syntheticorders.public.')) return fetch(url, init);
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) } });
  }) as typeof fetch;
  assert.equal((await j.approve()).ok, false); assert.ok(cancelled); assert.equal(j.posts.length, 0);
  assert.equal((await j.read()).paymentStatus, 'paid'); assert.ok(!(await j.read()).printSubmissionAttemptedAt);
}));
test('lost canonical job-binding write preserves attempt fence and cannot resubmit', () => journey(async j => {
  const replace = j.adapter.replaceIfVersion;
  j.adapter.replaceIfVersion = async (path: string, body: string, version: string) => {
    if (JSON.parse(body).printJobId) throw new Error('synthetic binding lost');
    return replace(path, body, version);
  };
  assert.equal((await j.approve()).ok, false); await j.approve(); assert.equal(j.posts.length, 1);
  assert.ok((await j.read()).printSubmissionAttemptedAt); assert.ok(!(await j.read()).printJobId);
}));
test.after(() => { globalThis.fetch = originalFetch; });
