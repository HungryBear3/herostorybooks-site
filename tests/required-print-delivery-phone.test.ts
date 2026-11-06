/** Candidate-native regression carry. All contacts are fictional; all transports local. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import * as orders from '../src/lib/orders.ts';
import { handleCheckoutOrderPost } from '../src/lib/checkout-order-route-handler.ts';
import { approvePrintProof, proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import { clearTokenCache, submitPrintJob } from '../src/lib/lulu.ts';
import { GET as adminContactGet } from '../src/app/api/admin/orders/[orderId]/print-contact/route.ts';
import { toAdminOrderDetail, toAdminOrderListItem } from '../src/lib/admin-order-dto.ts';
import { buildOrderStatusView } from '../src/lib/order-status-view.ts';
import { checkoutAnalyticsStripeMetadata } from '../src/lib/checkout-analytics-context.ts';
import {
  __setPrintContactStoreForTests, captureOrderPrintContact, capturePrintUpgradeContact,
  createBlobPrintContactStore, normalizePrintContactPhone, recordSettledPrintContact,
  resolveOrderPrintContact, sessionPrintContactFacts,
} from '../src/lib/print-contact-store.ts';
import { storyMediaPrivateToken, storyMediaPrivateTokenProblem } from '../src/lib/story-media-store.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import { quotePrintUpgradeAtCost } from '../src/lib/print-upgrade-quote.ts';
import { openPrintUpgradeCheckout, PRINT_UPGRADE_STRIPE_KIND } from '../src/lib/print-upgrade-checkout.ts';
import { ANALYTICS_SETTLED, completedEvent, CONFIRMATION_EMAIL_SETTLED, NEWLY_PAID, runWebhook, setupWebhookStore } from './helpers/stripe-webhook-harness.ts';
import { installMemoryPrintContactStore } from './support/print-contact-fixture.ts';
import { padPageSet } from './support/full-page-set.ts';

// Independently authored exact oracles, reserved NANP fictional number.
const NAME = 'Marlowe Paperbird';
const PHONE = '+16125550176';
const RAW_PHONE = '(612) 555-0176';
const ADDRESS = { line1: '76 Paperbird Lane', line2: 'Unit 4', city: 'Fable Grove', state: 'MN', zip: '55401', country: 'US' };
const SHIPPING = { name: NAME, address: { ...ADDRESS, postal_code: ADDRESS.zip } };
const NOW = '2026-11-04T12:00:00.000Z';
const ADMIN = 'fictional-phone-carry-admin';
const ROOT = process.env.PHONE_CARRY_COPY_ROOT ?? '.';

function noContact(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [NAME, PHONE, RAW_PHONE, '555-0176']) assert.equal(text.includes(secret), false, secret);
}

function local(extra: Record<string, string> = {}) {
  const restoreEnv = setupWebhookStore({ HSB_PRIVATE_READ_WRITE_TOKEN: '', HSB_ORDER_ADMIN_KEY: ADMIN, HSB_BLOB_NAMESPACE: 'phonecarry', ...extra });
  const store = installMemoryPrintContactStore();
  return { store, restore() { __setPrintContactStoreForTests(null); clearTokenCache(); restoreEnv(); } };
}

function order(id: string, format: orders.BookFormat = 'classic'): orders.OrderRecord {
  return { ...orders.createOrderRecord({ childName: 'Fable Child', bookFormat: format, email: 'paperbird@example.invalid' }, { id, now: NOW, fulfillmentMode: 'manual_hold' }), stripeSessionId: `cs_test_${id.slice(4)}`, shippingAddress: ADDRESS };
}

function releasable(id: string) {
  const value: orders.OrderRecord = {
    ...order(id), paymentStatus: 'paid', status: 'preview_ready', fulfillmentStatus: 'proof_ready', reviewStatus: 'approved',
    pageArtifacts: padPageSet([]), storyArtifactUrl: 'https://example.invalid/proof.pdf',
    proofVersion: 'paper-proof', proofReviewedVersion: 'paper-proof', proofReviewedAt: NOW, proofApprovalToken: 'paper-approval',
    printInteriorArtifactUrl: 'https://example.invalid/interior.pdf', printInteriorMd5: 'paper-interior', printInteriorPageCount: 32,
    printInteriorProofVersion: 'paper-proof', printTitle: 'The Paperbird Expedition',
  };
  value.proofSourceFingerprint = proofSourceFingerprint(value);
  return value;
}

test('UI/doc change: print-only copy explains Stripe-hosted shipping address and delivery phone', () => {
  const ui = readFileSync(path.join(ROOT, 'src/app/checkout/checkout-form.tsx'), 'utf8');
  assert.match(ui, /form\.bookFormat !== "digital" && \([\s\S]{0,180}Your shipping address and delivery phone are collected at Stripe-hosted secure payment\./);
  assert.doesNotMatch(ui, /type=["']tel["']|form\.phone|formData\.append\(["']phone["']/);
});

test('UI/doc change: quote fallback is distinguished from validated physical submission', () => {
  const doc = readFileSync(path.join(ROOT, 'docs/runbooks/customer-print-upgrade-at-cost.md'), 'utf8');
  assert.match(doc, /LULU_FALLBACK_PHONE \?\? '000-000-0000'/);
  assert.match(doc, /Quote fallback validation is deferred/);
  assert.doesNotMatch(doc, /cost calculation and print job both send it/);
});

test('GREEN BASELINE: actual retail POST and Stripe adapter collect phone/address for softcover and hardcover only', async () => {
  const { restore } = local({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_paperpublic_fictionalsecret', HSB_BLOB_ACCESS_MODE: 'private', STRIPE_PRODUCT_CLASSIC_ID: 'prod_paperclassic', STRIPE_PRODUCT_PREMIUM_ID: 'prod_paperpremium', STRIPE_PRODUCT_DIGITAL_ID: 'prod_paperdigital' });
  // Fresh owned persistence transport through the existing adapter seam.
  const cells = new Map<string, { body: string; version: number }>();
  const adapter: orders.OrderStoreAdapter = {
    kind: 'paper-memory',
    async readVersioned(key) { const cell = cells.get(key); return cell ? { body: cell.body, version: String(cell.version) } : null; },
    async createIfAbsent(key, body) { if (cells.has(key)) return { ok: false, reason: 'exists' }; cells.set(key, { body, version: 1 }); return { ok: true, version: '1' }; },
    async replaceIfVersion(key, body, version) { const cell = cells.get(key); if (!cell || String(cell.version) !== version) return { ok: false, reason: 'version_conflict' }; cell.body = body; cell.version++; return { ok: true, version: String(cell.version) }; },
  };
  orders.__setOrderStoreAdapterFactoryForTests(() => adapter);
  try {
    // Execute the whole existing route module, swapping only its external adapters.
    // The production POST, shared handler, persistence and Stripe parameter builder run unchanged.
    const creates: Array<Record<string, any>> = [];
    const sessions = new Map<string, Record<string, any>>();
    let retrieved = 0;
    class FakeStripe {
      checkout = { sessions: {
        create: async (params: Record<string, any>) => {
          creates.push(params);
          const value = { id: `cs_test_paper${creates.length}`, url: 'https://checkout.stripe.test/paper', status: 'open', payment_status: 'unpaid', payment_intent: null };
          sessions.set(value.id, value); return value;
        },
        retrieve: async (id: string) => { retrieved++; return sessions.get(id)!; },
      } };
    }
    const source = readFileSync('src/app/api/order/route.ts', 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports: Record<string, any> = {};
    const dependencies: Record<string, unknown> = {
      'next/server': { NextResponse: { json: (body: unknown, options: ResponseInit) => Response.json(body, options) } },
      stripe: FakeStripe,
      '@/lib/orders': { ...orders, uploadOrderPhoto: async (id: string) => ({ pathname: `phonecarry/orders/${id}/photo-paper.png`, url: `https://example.invalid/${id}.png` }) },
      '@/lib/recovery': { markRecoveryLeadConverted: async () => null },
      '@/lib/stripe-env': { getRequiredStripeSecretKey: () => 'sk_test_paper_local' },
      '@/lib/checkout-analytics-context': { checkoutAnalyticsStripeMetadata },
      '@/lib/checkout-intake': { createVercelIntakeStore: () => { throw new Error('unexpected intake'); } },
      '@/lib/checkout-order-route-handler': { handleCheckoutOrderPost },
    };
    vm.runInNewContext(js, { exports, console, URLSearchParams, require: (id: string) => { assert.ok(id in dependencies, id); return dependencies[id]; } });
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    for (const [index, format] of ['classic', 'premium', 'digital'].entries()) {
      const form = () => {
        const body = new FormData();
        for (const [key, value] of Object.entries({ checkoutAttemptId: String(index + 1).repeat(32), childName: 'Fable Child', email: 'paperbird@example.invalid', theme: 'space-adventure', bookFormat: format, characterNotes: 'Silver cape and curly hair' })) body.set(key, value);
        body.set('photo', new File([new Uint8Array(png)], 'paper.png', { type: 'image/png' })); return body;
      };
      const request = () => new Request('https://preview.test/api/order', { method: 'POST', body: form() });
      const response = await exports.POST(request());
      assert.equal(response.status, 200, await response.clone().text());
      const params = creates[index];
      if (format === 'digital') {
        assert.equal('phone_number_collection' in params, false);
        assert.equal('shipping_address_collection' in params, false);
      } else {
        assert.deepEqual(JSON.parse(JSON.stringify(params.phone_number_collection)), { enabled: true });
        assert.deepEqual(JSON.parse(JSON.stringify(params.shipping_address_collection)), { allowed_countries: ['US'] });
      }
      assert.equal((await exports.POST(request())).status, 200);
      assert.equal(creates.length, index + 1, 'resume reuses the existing Session');
    }
    assert.equal(retrieved, 3);
  } finally { orders.__resetOrderStoreAdapterFactoryForTests(); restore(); }
});

for (const shape of ['legacy', 'current'] as const) {
  test(`GREEN BASELINE: signed retail ${shape} Stripe shape captures exact private contact; admin/privacy/replay binding`, async () => {
    const { store, restore } = local();
    try {
      const pending = order(`ord_paper_${shape}`);
      await orders.persistOrder(pending);
      const event = completedEvent(pending, { orderId: pending.id });
      Object.assign(event.data.object, {
        ...(shape === 'legacy' ? { shipping_details: SHIPPING } : { shipping_details: null, collected_information: { shipping_details: SHIPPING } }),
        customer_details: { name: 'Fictional Payer', phone: RAW_PHONE },
      });
      const response = await runWebhook(event, { settledBy: NEWLY_PAID });
      assert.deepEqual(response.statuses, [200]);
      const paid = (await orders.getOrder(pending.id))!;
      assert.equal(paid.paymentStatus, 'paid');
      assert.deepEqual(paid.shippingAddress, ADDRESS);
      const resolved = await resolveOrderPrintContact(paid);
      assert.ok(resolved.ok);
      assert.deepEqual(resolved.contact, { orderId: paid.id, purchaseKind: 'order', stripeSessionId: paid.stripeSessionId, stripePaymentIntentId: `pi_paper_${shape}`, quoteId: null, shippingAddress: ADDRESS, recipientName: NAME, phone: PHONE });
      assert.deepEqual([...store.objects.keys()], [`phonecarry/private-contact/orders/${paid.id}/sessions/${paid.stripeSessionId}.json`]);
      const before = [...store.objects.values()];
      assert.equal(await captureOrderPrintContact(paid, event.data.object as never), 'replayed');
      await assert.rejects(() => captureOrderPrintContact(paid, { ...event.data.object, customer_details: { phone: '+16125550177' } } as never), /print_contact_storage_unavailable/);
      assert.deepEqual([...store.objects.values()], before);
      for (const drift of [{ id: 'ord_paper_other' }, { stripeSessionId: 'cs_test_other' }, { stripePaymentIntentId: 'pi_other' }, { shippingAddress: { ...ADDRESS, zip: '55402' } }]) assert.equal((await resolveOrderPrintContact({ ...paid, ...drift })).ok, false);
      noContact(readFileSync(path.join(process.env.HSB_ORDER_STORE_DIR!, `${paid.id}.json`), 'utf8'));
      noContact([toAdminOrderDetail(paid), toAdminOrderListItem(paid), buildOrderStatusView(paid), response.lines, response.outbound]);
      const context = { params: Promise.resolve({ orderId: paid.id }) };
      for (const cookie of ['', 'hsb-ops-key=wrong', `hsb-ops-key=${ADMIN}; hsb-ops-key=${ADMIN}`]) {
        const denied = await adminContactGet(new Request('https://example.invalid/contact', { headers: { cookie } }), context);
        assert.equal(denied.status, 401); noContact(await denied.text());
      }
      const allowed = await adminContactGet(new Request('https://example.invalid/contact', { headers: { cookie: `hsb-ops-key=${ADMIN}` } }), context);
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers.get('cache-control'), 'private, no-store, max-age=0');
      assert.deepEqual((await allowed.json()).contacts, [{ purchase: 'order', stripeSessionId: paid.stripeSessionId, status: 'complete', recipientName: NAME, phone: PHONE }]);
    } finally { restore(); }
  });
}

test('GREEN BASELINE: normalization rejects annotations and current shipping ignores stale embedded phone/payer', () => {
  for (const raw of ['6125550176 ext 2', 'call 6125550176', '', '0000000000']) assert.equal(normalizePrintContactPhone(raw), null);
  assert.deepEqual(sessionPrintContactFacts({ id: 'cs_test_paper', collected_information: { shipping_details: { name: NAME, phone: '+16125550177' } }, customer_details: { phone: RAW_PHONE, name: 'Fictional Payer' } } as never), { recipientName: NAME, phone: PHONE });
  assert.deepEqual(sessionPrintContactFacts({ id: 'cs_test_paper', customer_details: { phone: RAW_PHONE, name: NAME } } as never), { recipientName: null, phone: PHONE });
});

test('GREEN BASELINE: legacy upgrade signed receipt captures its own contact rather than original digital payment', async () => {
  const { restore } = local();
  try {
    const id = 'ord_paper_legacy_upgrade';
    await orders.persistOrder({ ...order(id, 'digital'), paymentStatus: 'paid', settledAmountCents: 1900, printUpgradeStatus: 'checkout_open', printUpgradeStripeSessionId: 'cs_test_paperlegacy', printUpgradeTargetFormat: 'classic', printUpgradeAmountCents: 2000 });
    const event = { id: 'evt_paperlegacy', type: 'checkout.session.completed', data: { object: { id: 'cs_test_paperlegacy', client_reference_id: id, metadata: { kind: 'print_upgrade', orderId: id, targetFormat: 'classic' }, mode: 'payment', payment_status: 'paid', currency: 'usd', amount_subtotal: 2000, amount_total: 2000, payment_intent: 'pi_paperlegacy', collected_information: { shipping_details: SHIPPING }, customer_details: { phone: RAW_PHONE } } } };
    assert.deepEqual((await runWebhook(event, { settledBy: [ANALYTICS_SETTLED] })).statuses, [200]);
    const paid = (await orders.getOrder(id))!;
    const contact = await resolveOrderPrintContact(paid);
    assert.ok(contact.ok);
    assert.equal(contact.contact.purchaseKind, 'print_upgrade');
    assert.equal(contact.contact.stripeSessionId, 'cs_test_paperlegacy');
    assert.equal(contact.contact.stripePaymentIntentId, 'pi_paperlegacy');
    assert.equal(contact.contact.recipientName, NAME); assert.equal(contact.contact.phone, PHONE);
    assert.deepEqual((await runWebhook(event)).statuses, [200]);
    assert.equal((await captureOrderPrintContact(paid, { id: paid.stripeSessionId!, customer_details: { phone: '+16125550177' } })), 'nothing_collected');
  } finally { restore(); }
});

test('GREEN BASELINE: at-cost checkout collects phone and signed settlement binds private intended recipient to purchase/quote', async () => {
  const { store, restore } = local();
  try {
    const id = 'ord_paper_atcost';
    await orders.persistOrder({ ...order(id, 'digital'), paymentStatus: 'paid', settledAmountCents: 1900 });
    const offer = await prepareCustomerPrintUpgradeOffer(id, { approvedSourceSha256: 'b'.repeat(64), approvedSourcePageCount: 25, now: NOW });
    assert.ok(offer.ok);
    const quote = await quotePrintUpgradeAtCost(id, { token: offer.token, shippingAddress: { ...ADDRESS, name: NAME } }, { now: NOW, provider: { async quote() { return { provider: 'lulu', podPackageId: 'PAPER', shippingLevel: 'MAIL', currency: 'usd', printCents: 1000, shippingCents: 300, fulfillmentCents: 100, taxCents: 100, totalCents: 1500, estimatedDeliveryStart: '2026-11-10', estimatedDeliveryEnd: '2026-11-20' }; } } });
    assert.ok(quote.ok);
    const chosen = quote.quotes[0];
    let creates = 0;
    const deps = { now: NOW, baseUrl: 'https://example.invalid', createCheckoutSession: async (params: any) => { creates++; assert.deepEqual(params.phone_number_collection, { enabled: true }); assert.equal('shipping_address_collection' in params, false); return { id: 'cs_test_paperatcost', url: 'https://checkout.stripe.test/paper' }; } };
    assert.ok((await openPrintUpgradeCheckout(id, { token: offer.token, quoteId: chosen.quoteId }, deps)).ok);
    assert.ok((await openPrintUpgradeCheckout(id, { token: offer.token, quoteId: chosen.quoteId }, deps)).ok);
    assert.equal(creates, 1);
    const session = { id: 'cs_test_paperatcost', client_reference_id: id, metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: id, quoteId: chosen.quoteId, targetFormat: chosen.targetFormat }, mode: 'payment', payment_status: 'paid', currency: 'usd', amount_subtotal: 1500, amount_total: 1500, payment_intent: 'pi_paperatcost', customer_details: { phone: RAW_PHONE } };
    const event = { id: 'evt_paperatcost', type: 'checkout.session.completed', data: { object: session } };
    assert.deepEqual((await runWebhook(event, { settledBy: [ANALYTICS_SETTLED] })).statuses, [200]);
    assert.equal(await capturePrintUpgradeContact(id, session), 'replayed');
    const paid = (await orders.getOrder(id))!;
    assert.equal(paid.bookFormat, 'digital');
    assert.equal(paid.printCopyPurchases?.length, 1);
    const key = `phonecarry/private-contact/orders/${id}/sessions/cs_test_paperatcost.json`;
    const privateRecord = JSON.parse(store.objects.get(key)!);
    assert.equal(privateRecord.recipientName, NAME); assert.equal(privateRecord.phone, PHONE);
    assert.equal(privateRecord.quoteId, chosen.quoteId); assert.equal(privateRecord.purchaseKind, 'upgrade');
    assert.equal(privateRecord.stripePaymentIntentId, 'pi_paperatcost');
    noContact(paid);
    await assert.rejects(() => capturePrintUpgradeContact(id, { ...session, payment_intent: 'pi_other' }), /print_contact_storage_unavailable/);
    assert.deepEqual((await runWebhook(event)).statuses, [200]);
    assert.equal((await orders.getOrder(id))!.printCopyPurchases?.length, 1);
  } finally { restore(); }
});

test('GREEN BASELINE: missing/incomplete private contact refuses before claim, cover or provider; valid contact reaches actual fake Lulu transport exactly', async () => {
  const { restore } = local({ LULU_CLIENT_KEY: 'paper-local-key', LULU_CLIENT_SECRET: 'paper-local-secret', LULU_FALLBACK_PHONE: '+16125550177' });
  try {
    let effects = 0;
    let payload: any;
    const fetchMock = (async (url: RequestInfo | URL, init?: RequestInit) => {
      effects++;
      if (String(url).endsWith('/openid-connect/token')) return Response.json({ access_token: 'local-token', expires_in: 3600 });
      assert.equal(String(url), 'https://api.lulu.com/print-jobs/');
      payload = JSON.parse(String(init?.body)); return Response.json({ id: 76176 });
    }) as typeof fetch;
    const deps = {
      calculateCoverDimensions: async () => { effects++; return { widthPt: 1200, heightPt: 650 }; },
      buildPrintCoverPdf: () => { effects++; return Buffer.from('%PDF local'); },
      uploadArtifact: async () => { effects++; return 'https://example.invalid/cover.pdf'; },
      submitPrint: async (value: orders.OrderRecord, contact: any) => submitPrintJob(value, { contact, fetch: fetchMock }),
    };
    for (const [label, name, phone, error] of [
      ['missing', null, null, 'print_contact_missing'],
      ['phone', NAME, null, 'print_contact_phone_missing'],
      ['recipient', null, PHONE, 'print_contact_recipient_missing'],
    ] as const) {
      const value = releasable(`ord_paper_hold_${label}`);
      await orders.persistOrder(value);
      await recordSettledPrintContact({ orderId: value.id, purchaseKind: 'order', stripeSessionId: value.stripeSessionId!, stripePaymentIntentId: null, quoteId: null, shippingAddress: ADDRESS, recipientName: name, phone });
      assert.deepEqual(await approvePrintProof(value.id, 'paper-approval', deps), { ok: false, error });
      const held = (await orders.getOrder(value.id))!;
      assert.equal(held.fulfillmentStatus, 'proof_ready');
      assert.equal(held.printSubmissionAttemptedAt ?? null, null);
      assert.equal(held.proofApprovedAt ?? null, null);
      assert.equal(effects, 0);
    }
    const value = releasable('ord_paper_valid'); await orders.persistOrder(value);
    await captureOrderPrintContact(value, { id: value.stripeSessionId!, collected_information: { shipping_details: { name: NAME } }, customer_details: { phone: RAW_PHONE } });
    assert.deepEqual(await approvePrintProof(value.id, 'paper-approval', deps), { ok: true });
    assert.deepEqual(payload.shipping_address, { name: NAME, street1: ADDRESS.line1, street2: ADDRESS.line2, city: ADDRESS.city, state_code: ADDRESS.state, postcode: ADDRESS.zip, country_code: 'US', phone_number: PHONE });
    assert.notEqual(payload.shipping_address.name, value.childName);
    assert.notEqual(payload.shipping_address.phone_number, process.env.LULU_FALLBACK_PHONE);
    const done = (await orders.getOrder(value.id))!;
    assert.equal(done.printJobId, '76176'); noContact(done);
  } finally { restore(); }
});

test('GREEN BASELINE: token store identity, exact private SDK options, namespace isolation and create-only binding', async () => {
  const privateToken = 'vercel_blob_rw_paperprivate_fictionalsecret';
  const publicToken = 'vercel_blob_rw_paperpublic_fictionalsecret';
  assert.equal(storyMediaPrivateToken({ HSB_PRIVATE_READ_WRITE_TOKEN: privateToken, BLOB_READ_WRITE_TOKEN: publicToken } as Partial<NodeJS.ProcessEnv> as NodeJS.ProcessEnv), privateToken);
  assert.equal(storyMediaPrivateToken({ HSB_PRIVATE_READ_WRITE_TOKEN: privateToken, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_paperprivate_othersecret' } as Partial<NodeJS.ProcessEnv> as NodeJS.ProcessEnv), null);
  assert.match(storyMediaPrivateTokenProblem({} as NodeJS.ProcessEnv)!, /is not set/);
  const { restore } = local();
  try {
    const bodies = new Map<string, string>();
    const calls: Array<{ path: string; options: unknown }> = [];
    const store = createBlobPrintContactStore(privateToken, {
      get: (async (key: string, options: unknown) => { calls.push({ path: key, options }); const body = bodies.get(key); return body === undefined ? null : { statusCode: 200, stream: new Response(body).body, blob: { size: body.length } }; }) as never,
      put: (async (key: string, body: string, options: unknown) => { calls.push({ path: key, options }); if (bodies.has(key)) throw new Error('exists'); bodies.set(key, body); return {}; }) as never,
    });
    __setPrintContactStoreForTests(store);
    const value = order('ord_paper_binding');
    const input = { orderId: value.id, purchaseKind: 'order' as const, stripeSessionId: value.stripeSessionId!, stripePaymentIntentId: null, quoteId: null, shippingAddress: ADDRESS, recipientName: NAME, phone: PHONE };
    assert.equal(await recordSettledPrintContact(input), 'stored');
    assert.deepEqual(calls[0], { path: 'phonecarry/private-contact/orders/ord_paper_binding/sessions/cs_test_paper_binding.json', options: { access: 'private', token: privateToken, allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' } });
    assert.equal((await resolveOrderPrintContact(value)).ok, true);
    assert.deepEqual(calls[1].options, { access: 'private', token: privateToken, useCache: false });
    assert.equal(await recordSettledPrintContact(input), 'replayed');
    await assert.rejects(() => recordSettledPrintContact({ ...input, purchaseKind: 'extra_copy', quoteId: 'puq_paper' }), /print_contact_storage_unavailable/);
    process.env.HSB_BLOB_NAMESPACE = 'othercarry';
    assert.deepEqual(await resolveOrderPrintContact(value), { ok: false, reason: 'print_contact_missing' });
    assert.equal(bodies.size, 1);
  } finally { restore(); }
});
