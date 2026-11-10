import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { CHECKOUT_DIAGNOSTIC_EVENT_KEYS, CHECKOUT_DIAGNOSTIC_REFERENCE, CHECKOUT_ORDER_REFUSAL_CODES } from '../src/lib/checkout-submit-diagnostics.ts';
import { chromium, expect } from '@playwright/test';
import { fillCheckoutToReview, clickInSameTask } from './e2e/checkout-handoff-harness.ts';

// Mounted optimized client -> literal in-memory request -> actual production
// route adapters. Only SDK I/O, schedulers and browser API transport are fake.
// Private multipart/receipts/credentials never leave this process.
const { default: Stripe } = await import('stripe');
const blob = await import('@vercel/blob');
const next = await import('next/server.js');
let sdk: any;
let orders: any;
let active: any;
const deferred: Array<{ kind: string; cb: () => any }> = [];
const originalImmediate = globalThis.setImmediate;
const enqueue = (cb: () => any) => {
  const stack = new Error().stack ?? '';
  if (!/fulfillment-kickoff|order-confirmation-kickoff|purchase-analytics/.test(stack)) return originalImmediate(cb);
  const kind = stack.includes('fulfillment-kickoff') ? 'manual-generation-boundary' : 'delivery';
  deferred.push({ kind, cb }); return { unref() {} };
};
const unexpected = async () => { throw new Error('UNMATCHED_EXTERNAL_IO'); };
mock.module('@vercel/blob', { namedExports: { ...blob,
  get: (...args: any[]) => sdk.io.get(...args), put: (...args: any[]) => sdk.io.put(...args),
  head: unexpected, del: unexpected,
  list: async (opts: any) => {
    if (!opts.prefix?.startsWith('orders/')) throw new Error('UNMATCHED_BLOB_LIST');
    return { blobs: [...orders.files.keys()].filter((p: string) => p.startsWith(opts.prefix)).map((pathname: string) => ({ pathname })), hasMore: false };
  },
} });
mock.module('next/server.js', { namedExports: { ...next, after: enqueue } });
mock.module('resend', { namedExports: { Resend: class {
  emails = { send: async (...args: any[]) => { active.emails.push(structuredClone(args)); return { data: { id: 'synthetic-message' }, error: null }; } };
} } });
class SyntheticStripe extends Stripe {
  constructor(...args: ConstructorParameters<typeof Stripe>) {
    super(...args);
    this.accounts.retrieveCurrent = (async () => ({ id: 'acct_synthetic' })) as any;
    this.checkout.sessions.create = (async (params: any, options: any) => {
      const canonical = await getOrderAuthoritative(params.client_reference_id);
      assert.ok(canonical?.checkoutSessionProvisioning);
      if (canonical?.initialShipping) {
        const d = draft(); assert.equal(d.state, 'locked');
        assert.equal(d.lock.canonicalOrderId, canonical.id);
        assert.equal(d.lock.checkoutIntentFingerprint, canonical.checkoutIntentFingerprint);
        assert.ok([...sdk.files.keys()].some((p: any) => p.includes('order-provenance/initial-shipping/')));
      }
      active.creates.push(JSON.parse(JSON.stringify({ params, options })));
      const total = params.line_items.reduce((n: number, x: any) => n + x.quantity * x.price_data.unit_amount, 0);
      const session = { id: 'cs_test_synthetic' + active.serial, url: 'https://checkout.stripe.com/synthetic', status: 'open',
        payment_status: 'unpaid', mode: params.mode, currency: 'usd', amount_subtotal: total, amount_total: total,
        client_reference_id: params.client_reference_id, metadata: params.metadata, payment_method_types: ['card'],
        total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 }, expires_at: params.expires_at };
      active.session = session;
      if (active.mode === 'stripe-lost') throw new Error('synthetic lost acknowledgement');
      return session;
    }) as any;
    this.checkout.sessions.retrieve = (async (id: string) => { assert.equal(id, active.session.id); return active.session; }) as any;
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });
const { POST: orderPost } = await import('../src/app/api/order/route.ts');
const { POST: signedPost } = await import('../src/app/api/webhooks/stripe/route.ts');
const { createShippingRouteHandler } = await import('../src/lib/initial-shipping-checkout.ts');
const { createIntakeRecord, createVercelIntakeStore } = await import('../src/lib/checkout-intake.ts');
const { getOrderAuthoritative, withOrderTransaction, getBookFormatMeta } = await import('../src/lib/orders.ts');
const { approvePrintProof, proofSourceFingerprint, normalizePageArtifactTextLayouts } = await import('../src/lib/fulfillment.ts');
const { deliverOrderConfirmationEmail } = await import('../src/lib/confirmation-email-delivery.ts');
const { publicShippingSummary, adminShippingSummary } = await import('../src/lib/initial-shipping-summary.ts');
const { clearTokenCache } = await import('../src/lib/lulu.ts');
const { sha256 } = await import('../src/lib/initial-shipping-contract.ts');
const { fakePrivateSdk, syntheticOrderBlob, fakeLuluFetch, luluCost, PROVIDER, POLICY_RAW, CONTACT } = await import('./support/initial-shipping-fixture.ts');
const { padPageSet } = await import('./support/full-page-set.ts');
const BASE = 'http://127.0.0.1:3199';
const byteHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pdf = Buffer.from('%PDF-1.4\nsynthetic immutable bytes\n%%EOF');
const md5 = createHash('md5').update(pdf).digest('hex');
const draft = () => JSON.parse([...sdk.files.entries()].find(([p]: any) => p.includes('checkout-shipping-drafts/'))[1].body);
let serial = 0;
async function journey(format: 'expedited' | 'classic' | 'digital', mode: string, run: (j: any) => Promise<void>) {
  const env = { ...process.env }; const fetch = globalThis.fetch; const immediate = globalThis.setImmediate; const clock = Date.now;
  orders = syntheticOrderBlob(); sdk = fakePrivateSdk(); deferred.length = 0; clearTokenCache();
  const state: any = active = { serial: ++serial, mode, creates: [], emails: [], mp: [], posts: [], artifacts: [], quoteCalls: [], captures: [], responses: [], errors: [], diagnostics: 0 };
  const get = sdk.io.get;
  sdk.io.get = async (path: string, options: any) => {
    if (path.startsWith('orders/')) { const f = orders.files.get(path); return f ? { stream: new Response(f.body).body, blob: { etag: String(f.version), pathname: path } } : null; }
    return get(path, options);
  };
  Object.assign(process.env, {
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'true', BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticorders_syntheticSecret', HSB_BLOB_ACCESS_MODE: 'private',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_syntheticintake_syntheticSecret', HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true', HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'true',
    HSB_INITIAL_EXPEDITED_COMMERCIAL_POLICY: JSON.stringify(POLICY_RAW),
    HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: JSON.stringify({ ...PROVIDER, accountBinding: sha256('synthetic-client'), stripeAccountBinding: sha256('acct_synthetic') }),
    LULU_CLIENT_KEY: 'synthetic-client', LULU_CLIENT_SECRET: 'synthetic-secret', LULU_API_URL: PROVIDER.endpointOrigin,
    STRIPE_SECRET_KEY: ['sk', 'test', 'synthetic'].join('_'), STRIPE_WEBHOOK_SECRET: 'whsec_synthetic',
    STRIPE_PRODUCT_CLASSIC_ID: 'prod_syntheticClassic', STRIPE_PRODUCT_DIGITAL_ID: 'prod_syntheticDigital',
    HSB_RESEND_API_KEY: 'synthetic', HSB_EMAIL_FROM: 'sender@example.invalid',
  });
  const transport = fakeLuluFetch();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://www.google-analytics.com/mp/collect?')) {
      const body = JSON.parse(String(init?.body)); state.mp.push(body);
      if (body.events[0].name === 'shipping_payment_completed') {
        assert.equal((await getOrderAuthoritative(state.session.client_reference_id))?.initialShippingSettlement?.state, 'committed');
        assert.ok(draft().completionMetricIntentAt);
      }
      return new Response(null, { status: 204 });
    }
    if (u.startsWith('https://syntheticorders.public.blob.vercel-storage.com/')) {
      assert.ok(u.includes('/orders/' + state.session.client_reference_id + '/')); state.artifacts.push(u);
      return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'content-length': String(pdf.length) } });
    }
    if (u === PROVIDER.endpointOrigin + '/print-jobs/') {
      const o = await getOrderAuthoritative(state.session.client_reference_id);
      assert.ok(o?.printSubmissionAttemptedAt); state.posts.push(JSON.parse(String(init?.body)));
      if (state.mode === 'lulu-lost') throw new Error('synthetic lost acknowledgement');
      return Response.json({ id: 'synthetic-job' });
    }
    if (u.endsWith('/print-job-cost-calculations/')) {
      state.quoteCalls.push(JSON.parse(String(init?.body)));
      if (state.dispatch && state.mode === 'cost-hold' && JSON.parse(String(init?.body)).shipping_option === 'EXPEDITED') return Response.json(luluCost(1900, 70));
    }
    return transport(url, init);
  };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const ship = createShippingRouteHandler({ blob: sdk.io });
  try {
    await context.addCookies([{ name: '_ga', value: 'GA1.1.123456789.1700000000', url: BASE }]);
    await page.addInitScript(() => { (window as any).dataLayer = []; (window as any).gtag = (...args: any[]) => (window as any).dataLayer.push(args); });
    await page.route('**/*', async route => {
      const req = route.request(); const url = new URL(req.url());
      if (url.origin !== BASE) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      console.log('API_ENVELOPE ' + req.method() + ' ' + url.pathname);
      try {
        if (url.pathname === '/api/checkout/diagnostics') {
          assert.equal(req.method(), 'POST'); assert.equal(url.search, '');
          assert.ok(['expired', 'stripe-lost'].includes(mode));
          assert.match(req.headers()['content-type'], /^application\/json(?:;|$)/);
          assert.ok(req.postDataBuffer()!.byteLength <= 512);
          const event = req.postDataJSON();
          assert.deepEqual(Object.keys(event).sort(), [...CHECKOUT_DIAGNOSTIC_EVENT_KEYS].sort());
          assert.equal(event.code, 'order_request_refused'); assert.equal(event.phase, 'order');
          assert.match(event.reference, CHECKOUT_DIAGNOSTIC_REFERENCE);
          assert.ok(event.serverCode === null || event.serverCode === 'other' || CHECKOUT_ORDER_REFUSAL_CODES.includes(event.serverCode));
          state.diagnostics++;
          return route.fulfill({ status: 204, headers: { 'cache-control': 'no-store' } });
        }
        if (url.pathname === '/api/checkout/intake') {
          assert.equal(req.postDataJSON().action, 'create'); assert.ok(!state.owner);
          const owner = createIntakeRecord({ mediaAuthorizedAt: new Date().toISOString(), documentAuthorizedAt: null, childVoiceAuthorizedAt: null, voiceSource: null });
          await createVercelIntakeStore(process.env.HSB_INTAKE_BLOB_READ_WRITE_TOKEN, process.env, sdk.io).create(owner.record);
          state.owner = owner;
          return route.fulfill({ json: { intakeId: owner.record.intakeId, capability: owner.capability, expiresAt: owner.record.expiresAt } });
        }
        if (url.pathname === '/api/order/attempt-lease') return route.fulfill({ json: { status: 'ready', attemptId: 'e'.repeat(32), provenance: 'fresh' } });
        if (url.pathname === '/api/checkout/attempt-status') return route.fulfill({ status: 500, json: {} });
        if (url.pathname !== '/api/order' && url.pathname !== '/api/checkout/shipping') throw new Error('UNMATCHED_BROWSER_API');
        const bytes = req.postDataBuffer()!; const headers = await req.allHeaders();
        console.log('HEADER_FIELDSET ' + JSON.stringify(Object.keys(headers).sort()));
        const literal = new Request(req.url(), { method: req.method(), headers, body: new Uint8Array(bytes) });
        assert.equal(byteHash(new Uint8Array(await literal.clone().arrayBuffer())), byteHash(bytes));
        if (url.pathname === '/api/checkout/shipping') {
          // Shipping fixture envelopes supply Chromium's post-interception
          // Fetch Metadata; JSON, intake, capability and quote remain untouched.
          // The ORDER multipart below is replayed with its captured headers.
          const shippingEnvelope = new Request(req.url(), { method: req.method(), headers: { ...headers, 'sec-fetch-site': 'same-origin' }, body: new Uint8Array(bytes) });
          const response = await ship(shippingEnvelope); const body = await response.text();
          console.log('SHIPPING_ENVELOPE ' + JSON.stringify({ op: req.postDataJSON().op, status: response.status, fields: Object.keys(JSON.parse(body)), hasQuote: !!JSON.parse(body).quote, error: JSON.parse(body).error }));
          if (response.status !== 200) {
            console.log('REJECTED_CONTACT_FIELDSET ' + JSON.stringify({ fields: Object.keys(req.postDataJSON().contact ?? {}).sort(), privateDraftCount: [...sdk.files.keys()].filter((p: any) => p.includes('checkout-shipping-drafts/')).length, providerCalls: state.quoteCalls.length, stripeCreates: state.creates.length }));
            state.errors.push(new Error('shipping HTTP ' + response.status + ' code=' + JSON.parse(body).error));
          }
          if (req.postDataJSON().op === 'select') state.selected = JSON.parse(body);
          return route.fulfill({ status: response.status, contentType: 'application/json', body });
        }
        state.captures.push({ bytes, headers, url: req.url() });
        const fields = await literal.clone().formData();
        state.fields = [...fields.keys()].sort(); state.requestHash = byteHash(bytes);
        if (format === 'expedited') {
          assert.equal(fields.get('expeditedQuoteId'), state.selected.quote.quoteId);
          assert.equal(fields.get('checkoutIntakeCapability'), state.owner.capability);
          assert.equal(JSON.parse(String(fields.get('checkoutIntake'))).intakeId, state.owner.record.intakeId);
        }
        if (mode === 'expired') Date.now = () => state.selected.quote.expiresAtMs + 1;
        const response = await orderPost(literal); const body = await response.text();
        state.responses.push({ status: response.status, body: JSON.parse(body) });
        if (response.status === 200) assert.equal((await getOrderAuthoritative(state.session.client_reference_id))?.stripeSessionId, state.session.id);
        return route.fulfill({ status: response.status, contentType: 'application/json', body });
      } catch (e) { state.errors.push(e); await route.abort(); }
    });
    const pay = await fillCheckoutToReview(page);
    // Request bytes and headers are replayed without post-capture repair.
    if (format !== 'digital') await page.getByRole('button', { name: /^Softcover Classic/ }).click();
    if (format === 'expedited') {
      await expect(page.getByRole('radio', { name: 'Standard shipping — Included' })).toBeChecked();
      await page.getByRole('radio', { name: 'Expedited shipping', exact: true }).check();
      for (const [label, value] of Object.entries({ 'Delivery recipient name': CONTACT.name, 'Delivery phone': CONTACT.phone, 'Street address': CONTACT.line1, City: CONTACT.city, 'State (2 letters)': CONTACT.state, 'ZIP code': CONTACT.zip })) await page.getByLabel(label, { exact: true }).fill(value);
      await page.getByRole('button', { name: 'Get shipping quote' }).click();
      await expect.poll(async () => state.errors.length > 0 || await page.getByRole('button', { name: 'Use this expedited quote' }).isVisible()).toBe(true);
      if (state.errors.length) throw state.errors[0];
      await page.getByRole('button', { name: 'Use this expedited quote' }).click();
      await expect(page.getByText('Expedited shipping selected', { exact: true })).toBeVisible();
      const s = state.selected; assert.equal(s.bookCents, getBookFormatMeta('classic').priceCents);
      assert.equal(s.deltaCents, 420); assert.equal(s.deltaTaxIncludedCents, 20);
      await expect(page.getByLabel('Shipping itemization')).toContainText(`Total$${(s.totalCents / 100).toFixed(2)}`);
      await expect(page.getByLabel('Shipping itemization')).toContainText('Shipping tax (included in upgrade)$0.20');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    // Register before submit; await the actual background response, not a timer.
    const diagnosticsDone = ['expired', 'stripe-lost'].includes(mode)
      ? page.waitForResponse(r => new URL(r.url()).pathname === '/api/checkout/diagnostics', { timeout: 10000 })
          .then(r => { assert.equal(r.status(), 204); })
      : null;
    await clickInSameTask(pay, 2);
    if (diagnosticsDone) { await diagnosticsDone; assert.equal(state.diagnostics, 1); }
    await expect.poll(() => state.responses.length + state.errors.length).toBe(1);
    if (state.errors.length) throw state.errors[0];
    assert.equal(state.captures.length, 1);
    // Byte-for-byte replay: not a reconstructed FormData or substituted authority.
    state.replay = () => { const c = state.captures[0]; assert.equal(byteHash(c.bytes), state.requestHash); return orderPost(new Request(c.url, { method: 'POST', headers: c.headers, body: c.bytes })); };
    state.read = () => getOrderAuthoritative(state.session.client_reference_id);
    state.page = page;
    await run(state);
    await page.unrouteAll({ behavior: 'wait' });
    assert.equal(state.errors.length, 0);
    console.log('JOINED_RECEIPT ' + JSON.stringify({ format, mode, fieldset: state.fields, multipartSha256: state.requestHash, literalEqual: true,
      diagnostics: state.diagnostics, creates: state.creates.length, confirmationSends: state.emails.filter((args: any[]) => String(args[1]?.idempotencyKey ?? '').startsWith('order-confirmation-')).length,
      otherEmailSends: state.emails.filter((args: any[]) => !String(args[1]?.idempotencyKey ?? '').startsWith('order-confirmation-')).length,
      metrics: state.mp.flatMap((r: any) => r.events.map((e: any) => e.name)), printPosts: state.posts.length, artifactReads: state.artifacts.length }));
  } catch (error) {
    if (state.errors.length) throw state.errors[0];
    throw error;
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await browser.close(); orders.close(); globalThis.fetch = fetch; globalThis.setImmediate = immediate; Date.now = clock; clearTokenCache();
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env);
  }
}
async function settle(j: any, payment = 'timely', delayed = false) {
  Object.assign(process.env, { HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'false', HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'false',
    VERCEL_ENV: 'production', GA4_MEASUREMENT_ID: 'G-SYNTHETIC', GA4_API_SECRET: 'synthetic' });
  const created = Math.ceil(Date.now() / 1000);
  const event = { id: 'evt_synthetic_' + j.serial, type: 'checkout.session.completed', livemode: false,
    created: payment === 'untimely' ? Math.ceil(j.selected.quote.expiresAtMs / 1000) + 1 : created,
    data: { object: { ...j.session, status: 'complete', payment_intent: 'pi_synthetic_' + j.serial, payment_status: payment === 'unpaid' ? 'unpaid' : 'paid' } } };
  if (delayed) Date.now = () => j.selected.quote.expiresAtMs + 3 * 3600_000;
  const send = () => {
    const body = JSON.stringify(event);
    const signature = new Stripe(process.env.STRIPE_SECRET_KEY!).webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    return signedPost(new Request(BASE + '/api/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signature } }));
  };
  globalThis.setImmediate = enqueue as any;
  assert.equal((await send()).status, 200);
  const financial = await j.read();
  assert.equal(financial.paymentStatus, payment === 'unpaid' ? 'pending' : 'paid');
  if (j.selected) assert.equal(financial.initialShippingSettlement.state, payment === 'timely' ? 'committed' : 'held');
  if (j.selected && payment === 'timely') {
    const captured = j.captures[0];
    const originalFields = await new Request(captured.url, { method: 'POST', headers: captured.headers, body: captured.bytes }).formData();
    assert.equal(originalFields.get('gaClientId'), '123456789.1700000000');
    assert.ok(j.creates[0].params.metadata.gaClientId === originalFields.get('gaClientId'), 'actual expedited Stripe producer must preserve captured GA identity');
    assert.equal(event.data.object.metadata.gaClientId, j.creates[0].params.metadata.gaClientId, 'same Session signed metadata custody');
    console.log('METRIC_JOIN_DIAGNOSTIC ' + JSON.stringify({
      capturedGaClientIdMatchesBrowserFixture: originalFields.get('gaClientId') === '123456789.1700000000',
      providerMetadataHasGaClientId: Object.hasOwn(j.creates[0].params.metadata, 'gaClientId'),
      signedMetadataHasGaClientId: Object.hasOwn(event.data.object.metadata, 'gaClientId'),
      privateMetricIntentRecorded: Number.isSafeInteger(draft().completionMetricIntentAt),
      publicSettlementCommitted: financial.initialShippingSettlement.state === 'committed',
    }));
  }
  // Generation is deliberately NOT executed. A manual approved artifact stage follows.
  // Delivery/analytics scheduler closures run unchanged; only scheduler transport is fake.
  for (const item of deferred) if (item.kind === 'delivery') await item.cb();
  await new Promise(r => setTimeout(r, 20));
  const sent = j.emails.length; const metrics = j.mp.length; const paidAt = (await j.read()).paidAt;
  assert.equal((await send()).status, 200);
  for (const item of deferred) if (item.kind === 'delivery') await item.cb();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(j.emails.length, sent); assert.equal(j.mp.length, metrics); assert.equal((await j.read()).paidAt, paidAt);
  assert.equal(sent, payment === 'timely' ? 1 : 0);
  assert.equal(j.mp.flatMap((r: any) => r.events).filter((e: any) => e.name === 'shipping_payment_completed').length, j.selected && payment === 'timely' ? 1 : 0);
  if (payment === 'timely') {
    assert.equal(j.mp.flatMap((r: any) => r.events).filter((e: any) => e.name === 'purchase').length, 1);
    assert.equal((await deliverOrderConfirmationEmail(financial.id)).status, 'blocked');
    if (j.selected) {
      assert.equal((publicShippingSummary(await j.read()) as any).status, 'confirmed');
      assert.match(j.emails[0][0].text, /Expedited shipping upgrade: \$4\.20/);
      assert.match(j.emails[0][0].text, /Shipping tax \(included in upgrade\): \$0\.20/);
      assert.deepEqual(draft().contact, CONTACT);
    }
  } else assert.notEqual((publicShippingSummary(await j.read()) as any).status, 'confirmed');
}
async function manualProof(j: any) {
  const id = j.session.client_reference_id;
  const artifact = (name: string) => `https://syntheticorders.public.blob.vercel-storage.com/orders/${id}/${name}.pdf`;
  await withOrderTransaction(id, current => {
    const o = { ...current, fulfillmentStatus: 'proof_ready', status: 'preview_ready', reviewStatus: 'approved', layoutVersion: 'modern_full_bleed',
      pageArtifacts: normalizePageArtifactTextLayouts(padPageSet([])), proofApprovalToken: 'synthetic-approval', proofVersion: 'proof-v1',
      proofReviewedVersion: 'proof-v1', proofReviewedAt: new Date().toISOString(), storyArtifactUrl: artifact('proof'),
      printInteriorArtifactUrl: artifact('interior'), printInteriorMd5: md5, printInteriorPageCount: 32, printInteriorProofVersion: 'proof-v1',
      printCoverArtifactUrl: artifact('cover'), printCoverMd5: md5, printTitle: 'Manually approved synthetic book' } as typeof current;
    o.proofSourceFingerprint = proofSourceFingerprint(o);
    return { commit: o, result: true };
  });
  j.dispatch = true;
  const result = await approvePrintProof(id, 'synthetic-approval');
  const o = await j.read();
  if (j.mode === 'cost-hold') {
    assert.equal(result.ok, false); assert.equal(j.posts.length, 0); assert.ok(!o.printSubmissionAttemptedAt);
    assert.equal(o.paymentStatus, 'paid'); assert.match(o.fulfillmentLastError, /dispatch_cost_exceeded/);
    assert.equal((adminShippingSummary(o) as any).reason, 'dispatch_cost_exceeded');
    assert.notEqual((publicShippingSummary(o) as any).status, 'confirmed');
  } else if (j.mode === 'lulu-lost') {
    assert.equal(result.ok, false); assert.equal(j.posts.length, 1); assert.ok(o.printSubmissionAttemptedAt); assert.ok(!o.printJobId);
    await approvePrintProof(id, 'synthetic-approval'); assert.equal(j.posts.length, 1);
    assert.notEqual((publicShippingSummary(await j.read()) as any).status, 'confirmed');
  } else {
    assert.equal(result.ok, true); assert.equal(o.printJobId, 'synthetic-job'); assert.equal(j.posts.length, 1);
    assert.equal(j.posts[0].shipping_level, j.selected ? 'EXPEDITED' : 'MAIL');
    assert.equal(j.posts[0].line_items[0].quantity, 1);
    if (j.selected) {
      assert.equal(j.artifacts.length, 3); assert.equal(j.posts[0].shipping_address.name, CONTACT.name);
      assert.equal(j.posts[0].shipping_address.phone_number, CONTACT.phone);
      assert.equal(j.posts[0].shipping_address.country_code, 'US');
    }
    await approvePrintProof(id, 'synthetic-approval'); assert.equal(j.posts.length, 1);
  }
  assert.equal(j.creates.length, 1);
}
for (const mode of ['ok', 'cost-hold', 'lulu-lost']) test(`joined mounted literal expedited -> signed paid -> confirmation/MP -> manual proof ${mode}`, { timeout: 90000 }, () => journey('expedited', mode, async j => {
  assert.equal(j.responses[0].status, 200); assert.equal((await j.replay()).status, 200); assert.equal(j.creates.length, 1);
  const p = j.creates[0].params; const o = await j.read();
  assert.deepEqual(p.line_items.map((x: any) => x.price_data.unit_amount), [j.selected.bookCents, 420]);
  assert.equal(p.shipping_address_collection, undefined); assert.equal(o.initialShipping.totals.totalCents, j.selected.totalCents);
  assert.equal(o.initialShipping.totals.deltaTaxIncludedCents, 20);
  await settle(j, 'timely', mode === 'ok'); await manualProof(j);
}));
for (const format of ['classic', 'digital'] as const) test(`joined mounted ${format} baseline -> signed settlement -> confirmation`, { timeout: 90000 }, () => journey(format, 'ok', async j => {
  assert.equal(j.responses[0].status, 200); assert.equal(j.creates.length, 1); assert.equal(j.quoteCalls.length, 0); assert.ok(!j.owner);
  const p = j.creates[0].params;
  assert.equal(p.line_items.length, 1); assert.equal(p.line_items[0].price_data.unit_amount, getBookFormatMeta(format).priceCents);
  assert.deepEqual(p.shipping_address_collection, format === 'classic' ? { allowed_countries: ['US'] } : undefined);
  assert.ok(!(await j.read()).initialShipping); await settle(j);
  if (format === 'classic') await manualProof(j);
}));
for (const mode of ['expired', 'stripe-lost']) test(`joined mounted literal ${mode} creates no duplicate`, { timeout: 90000 }, () => journey('expedited', mode, async j => {
  assert.notEqual(j.responses[0].status, 200); assert.notEqual((await j.replay()).status, 200);
  assert.equal(j.creates.length, mode === 'expired' ? 0 : 1); assert.equal(j.emails.length, 0); assert.equal(j.posts.length, 0);
}));
for (const payment of ['untimely', 'unpaid']) test(`joined mounted signed ${payment} preserves truth and suppresses confirmation`, { timeout: 90000 }, () => journey('expedited', 'ok', async j => {
  assert.equal(j.responses[0].status, 200); await settle(j, payment); assert.equal(j.posts.length, 0);
  assert.equal((await deliverOrderConfirmationEmail(j.session.client_reference_id)).status, 'blocked');
}));
