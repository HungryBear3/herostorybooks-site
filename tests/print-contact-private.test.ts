/**
 * Private print contact through the real webhook, quote, checkout, admin and
 * print-release consumers. Synthetic data and an explicit memory store only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BlobNotFoundError } from '@vercel/blob';
import sharp from 'sharp';

import { GET as adminContactGet } from '../src/app/api/admin/orders/[orderId]/print-contact/route.ts';
import { toAdminOrderDetail, toAdminOrderListItem } from '../src/lib/admin-order-dto.ts';
import { handleCheckoutOrderPost, type CheckoutOrderRouteDeps } from '../src/lib/checkout-order-route-handler.ts';
import { approvePrintProof, proofSourceFingerprint, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { clearTokenCache, submitPrintJob } from '../src/lib/lulu.ts';
import { buildOrderStatusView } from '../src/lib/order-status-view.ts';
import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  createOrderRecord,
  getOrder,
  persistOrder,
  withOrderTransaction,
  type OrderRecord,
  type OrderStoreAdapter,
  type ShippingAddress,
} from '../src/lib/orders.ts';
import {
  __setPrintContactStoreForTests,
  capturePrintUpgradeContact,
  createBlobPrintContactStore,
  loadAdminPrintContacts,
  normalizePrintContactPhone,
  printContactStorageProblem,
  recordSettledPrintContact,
  resolveOrderPrintContact,
  sessionPrintContactFacts,
} from '../src/lib/print-contact-store.ts';
import { PRINT_UPGRADE_STRIPE_KIND, printUpgradeCheckoutStatusView } from '../src/lib/print-upgrade-checkout.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import type { PrintCostQuoteProvider } from '../src/lib/print-upgrade-quote.ts';
import {
  handlePrintUpgradeCheckoutPost,
  handlePrintUpgradeOfferPost,
  handlePrintUpgradeQuotePost,
  type PrintUpgradeRouteDeps,
} from '../src/lib/print-upgrade-route-handler.ts';
import {
  ANALYTICS_SETTLED,
  completedEvent,
  CONFIRMATION_EMAIL_SETTLED,
  MP_ENDPOINT,
  NEWLY_PAID,
  runWebhook,
  setupWebhookStore,
} from './helpers/stripe-webhook-harness.ts';
import { padPageSet } from './support/full-page-set.ts';
import { installMemoryPrintContactStore, type MemoryPrintContactStore } from './support/print-contact-fixture.ts';

const NAME = 'Quill Recipient';
const PHONE_RAW = '(312) 555-0142';
const PHONE = '+13125550142';
const ADMIN_KEY = 'ops-key-test';
const NOW = '2026-10-14T12:00:00.000Z';
const SHIPPING: ShippingAddress = { line1: '10 Synthetic Way', line2: null, city: 'Testville', state: 'IL', zip: '60601', country: 'US' };
const STRIPE_SHIPPING = { name: NAME, address: { line1: SHIPPING.line1, line2: null, city: SHIPPING.city, state: SHIPPING.state, postal_code: SHIPPING.zip, country: SHIPPING.country } };

// A paid replay always runs the confirmation attempt, and a kickoff when the route schedules one.
const REPLAY_SETTLED = { settledBy: [CONFIRMATION_EMAIL_SETTLED], settleScheduledKickoff: true };

function env(extra: Record<string, string> = {}) {
  const restoreEnv = setupWebhookStore({ HSB_PRIVATE_READ_WRITE_TOKEN: '', HSB_ORDER_ADMIN_KEY: ADMIN_KEY, ...extra });
  const store = installMemoryPrintContactStore();
  return {
    store,
    restore: () => {
      __setPrintContactStoreForTests(null);
      restoreEnv();
    },
  };
}

function rawOrder(id: string): string {
  return readFileSync(path.join(process.env.HSB_ORDER_STORE_DIR!, `${id}.json`), 'utf8');
}

function assertContactFree(text: string) {
  assert.equal(text.includes(NAME), false);
  assert.equal(text.includes(PHONE), false);
  assert.equal(text.includes('555-0142'), false);
}

async function seedPendingPrint(id: string): Promise<OrderRecord> {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id, now: new Date().toISOString(), fulfillmentMode: 'manual_hold' }),
    // GA4 admits only the alphanumeric Checkout Session id shape.
    stripeSessionId: `cs_test_${id.slice(4).replace(/_/g, '')}`,
  };
  await persistOrder(order);
  return order;
}

function retailEvent(order: OrderRecord, session: Record<string, unknown> = { shipping_details: STRIPE_SHIPPING }) {
  const event = completedEvent(order, { orderId: order.id });
  Object.assign(event.data.object, { customer_details: { name: 'Card Holder', phone: PHONE_RAW } }, session);
  return event;
}

test('retail webhook keeps contact out of raw JSON, DTOs, logs and GA4; only authenticated admin reads it', async () => {
  const { restore } = env();
  try {
    const order = await seedPendingPrint('ord_contact_retail');
    const result = await runWebhook(retailEvent(order), { settledBy: NEWLY_PAID });
    assert.deepEqual(result.statuses, [200]);
    assertContactFree(rawOrder(order.id));
    assertContactFree(result.lines.join('\n'));
    assert.ok(result.outbound.length > 0, 'the GA4 purchase was actually sent');
    const purchases = result.outbound.filter((call) => call.url.startsWith(`${MP_ENDPOINT}?`));
    assert.equal(purchases.length, 1, 'exactly one GA4 Measurement Protocol purchase');
    assert.equal(JSON.parse(purchases[0].body).events[0].params.transaction_id, order.stripeSessionId);
    assertContactFree(result.outbound.map((call) => call.body).join('\n'));
    const stored = (await getOrder(order.id))!;
    assert.equal(stored.paymentStatus, 'paid');
    assertContactFree(JSON.stringify(stored));
    assertContactFree(JSON.stringify(toAdminOrderDetail(stored)));
    assertContactFree(JSON.stringify(toAdminOrderListItem(stored)));
    assertContactFree(JSON.stringify(buildOrderStatusView(stored)));

    const resolved = await resolveOrderPrintContact(stored);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.contact.recipientName, NAME);
    assert.equal(resolved.contact.phone, PHONE);
    assert.equal(resolved.contact.purchaseKind, 'order');
    assert.equal(resolved.contact.stripePaymentIntentId, 'pi_contact_retail');

    const denied = await adminContactGet(new Request('http://127.0.0.1/x'), { params: Promise.resolve({ orderId: order.id }) });
    assert.equal(denied.status, 401);
    assertContactFree(await denied.text());
    const wrongKey = await adminContactGet(new Request('http://127.0.0.1/x', { headers: { cookie: 'hsb-ops-key=wrong' } }), { params: Promise.resolve({ orderId: order.id }) });
    assert.equal(wrongKey.status, 401);
    const allowed = await adminContactGet(new Request('http://127.0.0.1/x', { headers: { cookie: `hsb-ops-key=${ADMIN_KEY}` } }), { params: Promise.resolve({ orderId: order.id }) });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('cache-control'), 'private, no-store, max-age=0');
    const body = await allowed.json() as { contacts: Array<Record<string, unknown>> };
    assert.equal(body.contacts[0].recipientName, NAME);
    assert.equal(body.contacts[0].phone, PHONE);
  } finally {
    restore();
  }
});

test('the newer Stripe collected_information shape supplies the address and recipient together', async () => {
  const { restore } = env();
  try {
    const order = await seedPendingPrint('ord_contact_collected');
    const result = await runWebhook(retailEvent(order, { collected_information: { shipping_details: STRIPE_SHIPPING } }), { settledBy: NEWLY_PAID });
    assert.deepEqual(result.statuses, [200]);
    const stored = (await getOrder(order.id))!;
    assert.deepEqual(stored.shippingAddress, SHIPPING);
    const resolved = await resolveOrderPrintContact(stored);
    assert.equal(resolved.ok, true);
  } finally {
    restore();
  }
});

test('contact storage failure keeps payment proof, stays contact-free, and a replay converges', async () => {
  const { restore } = env();
  try {
    const order = await seedPendingPrint('ord_contact_outage');
    let writes = 0;
    __setPrintContactStoreForTests({
      kind: 'failing',
      async read() { throw new Error(`private store unavailable ${NAME}`); },
      async createIfAbsent() { writes += 1; throw new Error(`private store unavailable ${NAME}`); },
    });
    const failed = await runWebhook(retailEvent(order), { settledBy: NEWLY_PAID });
    assert.deepEqual(failed.statuses, [500]);
    assert.equal(writes, 1);
    const paid = (await getOrder(order.id))!;
    assert.equal(paid.paymentStatus, 'paid');
    assert.equal(paid.settledAmountCents, order.priceCents);
    assertContactFree(rawOrder(order.id));
    assertContactFree(failed.lines.join('\n'));

    installMemoryPrintContactStore();
    const replay = await runWebhook(retailEvent(order), REPLAY_SETTLED);
    assert.deepEqual(replay.statuses, [200]);
    const resolved = await resolveOrderPrintContact((await getOrder(order.id))!);
    assert.equal(resolved.ok, true);
    assert.equal((await getOrder(order.id))!.paidAt, paid.paidAt);
  } finally {
    restore();
  }
});

test('a lost write acknowledgement converges on replay with one private record', async () => {
  const { store, restore } = env();
  try {
    const order = await seedPendingPrint('ord_contact_lost_ack');
    let lost = false;
    __setPrintContactStoreForTests({
      kind: 'lost-acknowledgement',
      read: store.read,
      async createIfAbsent(pathname, body) {
        const created = await store.createIfAbsent(pathname, body);
        if (!lost) {
          lost = true;
          throw new Error('response lost');
        }
        return created;
      },
    });
    assert.deepEqual((await runWebhook(retailEvent(order), { settledBy: NEWLY_PAID })).statuses, [500]);
    assert.equal(store.objects.size, 1);
    assert.deepEqual((await runWebhook(retailEvent(order), REPLAY_SETTLED)).statuses, [200]);
    assert.equal(store.objects.size, 1);
    assert.equal((await resolveOrderPrintContact((await getOrder(order.id))!)).ok, true);
  } finally {
    restore();
  }
});

test('a replay that carries different contact refuses and leaves the stored record and payment intact', async () => {
  const { store, restore } = env();
  try {
    const order = await seedPendingPrint('ord_contact_changed');
    assert.deepEqual((await runWebhook(retailEvent(order), { settledBy: NEWLY_PAID })).statuses, [200]);
    const before = [...store.objects.values()];
    const changed = retailEvent(order);
    Object.assign(changed.data.object, { customer_details: { phone: '(312) 555-0199' } });
    assert.deepEqual((await runWebhook(changed, REPLAY_SETTLED)).statuses, [500]);
    assert.deepEqual([...store.objects.values()], before);
    assert.equal((await getOrder(order.id))!.paymentStatus, 'paid');
  } finally {
    restore();
  }
});

const ATTEMPT = 'c1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

interface RouteResponse { httpStatus: number; body: Record<string, unknown> }

function memoryOrderStore() {
  const cells = new Map<string, { body: string; version: number }>();
  const adapter: OrderStoreAdapter = {
    kind: 'test-memory',
    async readVersioned(pathname) {
      const cell = cells.get(pathname);
      return cell ? { body: cell.body, version: String(cell.version) } : null;
    },
    async createIfAbsent(pathname, body) {
      if (cells.has(pathname)) return { ok: false, reason: 'exists' };
      cells.set(pathname, { body, version: 1 });
      return { ok: true, version: '1' };
    },
    async replaceIfVersion(pathname, body, expectedVersion) {
      const cell = cells.get(pathname);
      if (!cell || String(cell.version) !== expectedVersion) return { ok: false, reason: 'version_conflict' };
      cell.body = body;
      cell.version += 1;
      return { ok: true, version: String(cell.version) };
    },
  };
  __setOrderStoreAdapterFactoryForTests(() => adapter);
}

function checkoutDeps() {
  const provider: string[] = [];
  let next = 1;
  const open = (id: string, orderId: string) => ({ id, url: `https://checkout.stripe.test/${orderId}`, status: 'open', payment_status: 'unpaid', payment_intent: null });
  const deps = {
    json: (body: Record<string, unknown>, httpStatus: number) => ({ httpStatus, body }),
    async createCheckoutSession(request: { order: OrderRecord; idempotencyKey: string }) {
      provider.push(`create:${request.idempotencyKey}`);
      const id = `cs_test_contact_gate_${next}`;
      next += 1;
      return open(id, request.order.id);
    },
    async retrieveCheckoutSession(id: string) {
      provider.push(`retrieve:${id}`);
      return open(id, 'resume');
    },
    createIntakeStore() {
      provider.push('intake');
      throw new Error('must not run');
    },
    async uploadOrderPhoto(orderId: string) {
      return { pathname: `orders/${orderId}/photo-hero.jpg`, url: `https://blob.test/orders/${orderId}/photo-hero.jpg` };
    },
    async rollbackOrderMediaUploads() { return 0; },
    async markRecoveryLeadConverted() { return null; },
    logError: () => {},
  } as unknown as CheckoutOrderRouteDeps<RouteResponse>;
  return { deps, provider };
}

async function legacyForm(bookFormat: string, attempt = ATTEMPT): Promise<FormData> {
  const form = new FormData();
  form.set('checkoutAttemptId', attempt);
  form.set('childName', 'Fixture Child');
  form.set('email', 'payer@example.invalid');
  form.set('bookFormat', bookFormat);
  form.set('theme', 'space-adventure');
  form.set('characterNotes', 'Curly hair and a red cape');
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer();
  form.set('photo', new File([new Uint8Array(png)], 'hero.png', { type: 'image/png' }));
  return form;
}

const CHECKOUT_ENV = {
  HSB_REQUIRE_DURABLE_PERSISTENCE: 'true',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_testsecret',
  HSB_BLOB_ACCESS_MODE: 'private',
  STRIPE_PRODUCT_CLASSIC_ID: 'prod_testclassic',
  STRIPE_PRODUCT_DIGITAL_ID: 'prod_testdigital',
};

test('real checkout: a print order needs the capability, a resume refuses without it, and digital is unaffected', async () => {
  const { restore } = env(CHECKOUT_ENV);
  memoryOrderStore();
  try {
    const first = checkoutDeps();
    const opened = await handleCheckoutOrderPost(new Request('https://preview.test/api/order', { method: 'POST', body: await legacyForm('classic') }), first.deps);
    assert.equal(opened.httpStatus, 200, JSON.stringify(opened));
    assert.equal(first.provider.filter((call) => call.startsWith('create:')).length, 1);

    __setPrintContactStoreForTests(null);
    assert.equal(typeof printContactStorageProblem(), 'string');
    const resume = checkoutDeps();
    const refused = await handleCheckoutOrderPost(new Request('https://preview.test/api/order', { method: 'POST', body: await legacyForm('classic') }), resume.deps);
    assert.equal(refused.httpStatus, 503);
    assert.equal(refused.body.code, 'print_contact_storage_unavailable');
    assert.deepEqual(resume.provider, [], 'neither create nor resume reaches Stripe');

    const fresh = checkoutDeps();
    const freshRefused = await handleCheckoutOrderPost(new Request('https://preview.test/api/order', { method: 'POST', body: await legacyForm('premium', 'd'.repeat(32)) }), fresh.deps);
    assert.equal(freshRefused.body.code, 'print_contact_storage_unavailable');
    assert.deepEqual(fresh.provider, []);

    const digital = checkoutDeps();
    const allowed = await handleCheckoutOrderPost(new Request('https://preview.test/api/order', { method: 'POST', body: await legacyForm('digital', 'b'.repeat(32)) }), digital.deps);
    assert.equal(allowed.httpStatus, 200, JSON.stringify(allowed));
    assert.equal(digital.provider.filter((call) => call.startsWith('create:')).length, 1);
  } finally {
    __resetOrderStoreAdapterFactoryForTests();
    restore();
  }
});

test('real checkout: a direct print request refuses before the intake store or any provider', async () => {
  const { restore } = env({ ...CHECKOUT_ENV, HSB_CHECKOUT_DIRECT_UPLOAD: 'true' });
  memoryOrderStore();
  try {
    __setPrintContactStoreForTests(null);
    const form = await legacyForm('classic');
    form.delete('photo');
    form.set('checkoutIntakeCapability', 'synthetic-capability-0001');
    form.set('checkoutIntake', JSON.stringify({
      intakeId: `intake_${'1'.repeat(32)}`,
      familyCharacterIds: [],
      selection: {
        primaryHeroPhotoAssetId: `asset_${'2'.repeat(32)}`,
        familyCharacterAssets: [],
        guidedStillAssetIds: [],
        voiceAssetId: null,
        documentAssetId: null,
      },
    }));
    const { deps, provider } = checkoutDeps();
    const response = await handleCheckoutOrderPost(new Request('https://preview.test/api/order', { method: 'POST', body: form }), deps);
    assert.equal(response.httpStatus, 503);
    assert.equal(response.body.code, 'print_contact_storage_unavailable');
    assert.deepEqual(provider, []);
  } finally {
    __resetOrderStoreAdapterFactoryForTests();
    restore();
  }
});

interface UpgradeResponse { status: number; body: Record<string, unknown> }

function upgradeDeps(provider: PrintCostQuoteProvider, created: unknown[]): PrintUpgradeRouteDeps<UpgradeResponse> {
  return {
    json: (body, status) => ({ status, body: body as Record<string, unknown> }),
    quoteProvider: () => provider,
    createCheckoutSession: async (params) => {
      created.push(params);
      return { id: 'cs_test_upgrade_contact', url: 'https://checkout.stripe.test/x' };
    },
    baseUrl: () => 'https://hsb.test',
    now: () => NOW,
  };
}

const pricedProvider = (calls: { count: number; names: string[] }): PrintCostQuoteProvider => ({
  async quote(request) {
    calls.count += 1;
    calls.names.push(request.shippingAddress.name);
    return { provider: 'lulu', podPackageId: 'PKG', shippingLevel: 'MAIL', currency: 'usd', printCents: 1000, shippingCents: 300, fulfillmentCents: 100, taxCents: 100, totalCents: 1500, estimatedDeliveryStart: '2026-10-20', estimatedDeliveryEnd: '2026-10-30' };
  },
});

function post(body: unknown): Request {
  return new Request('https://hsb.test/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function preparedUpgrade(id: string): Promise<string> {
  await persistOrder({
    ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'digital', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' }),
    paymentStatus: 'paid', settledAmountCents: 1900, stripeSessionId: 'cs_test_original', fulfillmentMode: 'manual_hold', fulfillmentStatus: 'not_started',
  });
  const prepared = await prepareCustomerPrintUpgradeOffer(id, { approvedSourceSha256: 'a'.repeat(64), approvedSourcePageCount: 25, now: NOW });
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error('offer');
  return prepared.token;
}

const ADDRESS_INPUT = { ...SHIPPING, line2: '', name: NAME };

test('real quote handler: a missing capability refuses with zero provider calls and no public quote', async () => {
  const { restore } = env();
  try {
    const id = 'ord_contact_quote_refused';
    const token = await preparedUpgrade(id);
    __setPrintContactStoreForTests(null);
    const calls = { count: 0, names: [] as string[] };
    const created: unknown[] = [];
    const response = await handlePrintUpgradeQuotePost(post({ token, shippingAddress: ADDRESS_INPUT }), id, upgradeDeps(pricedProvider(calls), created));
    assert.deepEqual(response, { status: 503, body: { error: 'quote_unavailable' } });
    assert.equal(calls.count, 0);
    assert.equal((await getOrder(id))!.printUpgradeQuotes ?? null, null);
    assertContactFree(rawOrder(id));
  } finally {
    restore();
  }
});

test('real checkout handler: capability lost after the quote refuses with zero Stripe calls and no lock', async () => {
  const { restore } = env();
  try {
    const id = 'ord_contact_checkout_refused';
    const token = await preparedUpgrade(id);
    const calls = { count: 0, names: [] as string[] };
    const created: unknown[] = [];
    const deps = upgradeDeps(pricedProvider(calls), created);
    const quoted = await handlePrintUpgradeQuotePost(post({ token, shippingAddress: ADDRESS_INPUT }), id, deps);
    assert.equal(quoted.status, 200);
    const quote = (quoted.body.quotes as Array<{ quoteId: string; targetFormat: string }>)[0];
    __setPrintContactStoreForTests(null);
    const response = await handlePrintUpgradeCheckoutPost(post({ token, quoteId: quote.quoteId }), id, deps);
    assert.deepEqual(response, { status: 503, body: { error: 'provider_failed' } });
    assert.deepEqual(created, []);
    assert.equal((await getOrder(id))!.printUpgradeLock ?? null, null);
  } finally {
    restore();
  }
});

test('a provider error that echoes the recipient is not logged or returned', async () => {
  const { restore } = env();
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const id = 'ord_contact_quote_echo';
    const token = await preparedUpgrade(id);
    const provider: PrintCostQuoteProvider = { async quote() { throw new Error(`rejected ${NAME}`); } };
    const response = await handlePrintUpgradeQuotePost(post({ token, shippingAddress: ADDRESS_INPUT }), id, upgradeDeps(provider, []));
    assert.equal(response.status, 503);
    assert.ok(lines.length > 0);
    assertContactFree(lines.join('\n'));
    assertContactFree(rawOrder(id));
  } finally {
    console.error = original;
    restore();
  }
});

test('binding: another order, session, payment, kind or destination can never substitute a contact', async () => {
  const { store, restore } = env();
  try {
    const base = createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id: 'ord_contact_bound', now: '2026-09-01T12:00:00.000Z' });
    const order: OrderRecord = { ...base, paymentStatus: 'paid', stripeSessionId: 'cs_test_bound', stripePaymentIntentId: 'pi_bound', shippingAddress: SHIPPING };
    const input = { orderId: order.id, purchaseKind: 'order' as const, stripeSessionId: 'cs_test_bound', stripePaymentIntentId: 'pi_bound', quoteId: null, shippingAddress: SHIPPING, recipientName: NAME, phone: PHONE };
    assert.equal(await recordSettledPrintContact(input), 'stored');
    assert.equal((await resolveOrderPrintContact(order)).ok, true);
    const refused = (reason: string) => ({ ok: false, reason });
    assert.deepEqual(await resolveOrderPrintContact({ ...order, id: 'ord_contact_foreign' }), refused('print_contact_missing'));
    assert.deepEqual(await resolveOrderPrintContact({ ...order, stripeSessionId: 'cs_test_other' }), refused('print_contact_missing'));
    assert.deepEqual(await resolveOrderPrintContact({ ...order, stripePaymentIntentId: 'pi_other' }), refused('print_contact_binding_mismatch'));
    assert.deepEqual(await resolveOrderPrintContact({ ...order, stripePaymentIntentId: null }), refused('print_contact_binding_mismatch'), 'an absent expected identity substitutes nothing');
    assert.deepEqual(await resolveOrderPrintContact({ ...order, shippingAddress: { ...SHIPPING, zip: '60602' } }), refused('print_contact_binding_mismatch'));
    assert.deepEqual(await resolveOrderPrintContact({
      ...order,
      printUpgradeStatus: 'paid',
      printUpgradeSourceFormat: 'digital',
      printUpgradeStripeSessionId: 'cs_test_bound',
      printUpgradePaymentIntentId: 'pi_bound',
    }), refused('print_contact_binding_mismatch'), 'a retail record is not a legacy upgrade record');

    assert.equal(await recordSettledPrintContact(input), 'replayed');
    assert.equal(await recordSettledPrintContact({ ...input, phone: null }), 'replayed', 'no new evidence is not a conflict');
    for (const drift of [
      { stripePaymentIntentId: 'pi_other' },
      { stripePaymentIntentId: null },
      { purchaseKind: 'print_upgrade' as const },
      { purchaseKind: 'extra_copy' as const, quoteId: 'puq_0000000000000001' },
      { shippingAddress: { ...SHIPPING, zip: '60602' } },
      { phone: '+13125550199' },
      { recipientName: 'Other Recipient' },
    ]) {
      await assert.rejects(() => recordSettledPrintContact({ ...input, ...drift }), /print_contact_storage_unavailable/, JSON.stringify(drift));
    }
    assert.equal(store.objects.size, 1);
  } finally {
    restore();
  }
});

test('malformed private data is never accepted by print release or admin', async () => {
  const { store, restore } = env();
  try {
    const base = createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id: 'ord_contact_malformed', now: '2026-09-01T12:00:00.000Z' });
    const order: OrderRecord = { ...base, paymentStatus: 'paid', stripeSessionId: 'cs_test_malformed', shippingAddress: SHIPPING };
    await recordSettledPrintContact({ orderId: order.id, purchaseKind: 'order', stripeSessionId: 'cs_test_malformed', stripePaymentIntentId: null, quoteId: null, shippingAddress: SHIPPING, recipientName: NAME, phone: PHONE });
    const pathname = [...store.objects.keys()][0];
    const valid = JSON.parse(store.objects.get(pathname)!) as Record<string, unknown>;
    for (const body of [
      '{not json',
      '[]',
      JSON.stringify({ ...valid, extra: 1 }),
      JSON.stringify({ ...valid, phone: '555' }),
      JSON.stringify({ ...valid, recipientName: `  ${NAME}  ` }),
      JSON.stringify({ ...valid, recordedAt: 'yesterday' }),
      JSON.stringify({ ...valid, schema: 'hsb-print-contact/settled/v0' }),
      JSON.stringify({ ...valid, purchaseKind: 'gift' }),
      JSON.stringify({ ...valid, quoteId: 'puq_0000000000000001' }),
      JSON.stringify({ ...valid, shippingAddress: { ...SHIPPING, name: NAME } }),
      JSON.stringify({ ...valid, orderId: 'ord_contact_elsewhere' }),
    ]) {
      store.objects.set(pathname, body);
      assert.deepEqual(await resolveOrderPrintContact(order), { ok: false, reason: 'print_contact_binding_mismatch' }, body);
      const [view] = await loadAdminPrintContacts(order);
      assert.equal(view.status, 'binding_mismatch');
      assert.equal(view.recipientName, null);
      assert.equal(view.phone, null);
    }
  } finally {
    restore();
  }
});

test('blob adapter: private create-only writes, bounded strict reads, and no message-based absence', async () => {
  const options: Array<Record<string, unknown>> = [];
  const stream = (body: string | Uint8Array) => new Response(body).body!;
  const reader = (result: unknown) => createBlobPrintContactStore('private-store-value', {
    get: (async (_pathname: string, callOptions: Record<string, unknown>) => {
      options.push(callOptions);
      if (result instanceof Error) throw result;
      return result;
    }) as never,
    put: (async () => { throw new Error('unused'); }) as never,
  });

  assert.equal(await reader({ statusCode: 200, stream: stream('{"a":1}'), blob: { size: 7 } }).read('p'), '{"a":1}');
  assert.deepEqual(options[0], { access: 'private', token: 'private-store-value', useCache: false });
  assert.equal(await reader(null).read('p'), null);
  assert.equal(await reader({ statusCode: 404, stream: null, blob: null }).read('p'), null);
  assert.equal(await reader(new BlobNotFoundError()).read('p'), null);
  await assert.rejects(() => reader(new Error('This store does not exist.')).read('p'));
  await assert.rejects(() => reader({ statusCode: 500, stream: null, blob: null }).read('p'));
  await assert.rejects(() => reader({ statusCode: 200, stream: stream('x'), blob: { size: 1024 * 1024 } }).read('p'));
  await assert.rejects(() => reader({ statusCode: 200, stream: stream('x'.repeat(17 * 1024)), blob: {} }).read('p'));
  await assert.rejects(() => reader({ statusCode: 200, stream: stream(new Uint8Array([0xff])), blob: {} }).read('p'));

  const writes: Array<Record<string, unknown>> = [];
  const writer = (present: boolean, fail: boolean) => createBlobPrintContactStore('private-store-value', {
    get: (async () => (present ? { statusCode: 200, stream: stream('{}'), blob: { size: 2 } } : null)) as never,
    put: (async (_pathname: string, _body: string, callOptions: Record<string, unknown>) => {
      writes.push(callOptions);
      if (fail) throw new Error('unclassified store failure');
      return {};
    }) as never,
  });
  assert.equal(await writer(false, false).createIfAbsent('p', '{}'), 'created');
  assert.deepEqual(writes[0], { access: 'private', token: 'private-store-value', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' });
  assert.equal(await writer(true, true).createIfAbsent('p', '{}'), 'exists');
  await assert.rejects(() => writer(false, true).createIfAbsent('p', '{}'), /unclassified store failure/);
});

test('extra_copy keeps its own contact and never replaces the original order contact', async () => {
  const { restore } = env();
  try {
    const base = createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id: 'ord_contact_extra', now: '2026-09-01T12:00:00.000Z' });
    const other = { ...SHIPPING, line1: '20 Other Way' };
    const order: OrderRecord = {
      ...base, paymentStatus: 'paid', stripeSessionId: 'cs_test_original', stripePaymentIntentId: 'pi_original', shippingAddress: SHIPPING,
      printUpgradeStatus: 'paid', printUpgradeSourceFormat: 'digital', printUpgradeStripeSessionId: 'cs_test_extra',
      printCopyPurchases: [{
        version: 1, kind: 'extra_copy', offerId: 'puo_x', quoteId: 'puq_0000000000000001', approvedSourceSha256: 'a'.repeat(64), approvedProofVersion: null, approvedProofAt: null,
        targetFormat: 'classic', quantity: 2, totalCents: 4000, currency: 'usd', stripeSessionId: 'cs_test_extra', stripePaymentIntentId: 'pi_extra', shippingAddress: other,
        estimatedDeliveryStart: '2026-10-20', estimatedDeliveryEnd: '2026-10-30', paidAt: NOW, printJobId: null, printStatus: 'awaiting_files',
      }],
    };
    await recordSettledPrintContact({ orderId: order.id, purchaseKind: 'order', stripeSessionId: 'cs_test_original', stripePaymentIntentId: 'pi_original', quoteId: null, shippingAddress: SHIPPING, recipientName: NAME, phone: PHONE });
    await recordSettledPrintContact({ orderId: order.id, purchaseKind: 'extra_copy', stripeSessionId: 'cs_test_extra', stripePaymentIntentId: 'pi_extra', quoteId: 'puq_0000000000000001', shippingAddress: other, recipientName: 'Grandparent Recipient', phone: '+13125550199' });
    const resolved = await resolveOrderPrintContact(order);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.contact.recipientName, NAME);
    assert.equal(resolved.contact.stripeSessionId, 'cs_test_original');
    const admin = await loadAdminPrintContacts(order);
    assert.deepEqual(admin.map((row) => [row.purchase, row.status, row.recipientName]), [['order', 'complete', NAME], ['extra_copy', 'complete', 'Grandparent Recipient']]);
  } finally {
    restore();
  }
});

test('recipient comes only from shipping details and phone normalization is honest', () => {
  // A real Session carries the payer name; the interface deliberately does not admit it.
  const payerNamed = { id: 'cs_test_x', customer_details: { name: 'Card Holder', phone: PHONE_RAW } };
  assert.deepEqual(sessionPrintContactFacts(payerNamed), { recipientName: null, phone: PHONE });
  assert.equal(sessionPrintContactFacts({ id: 'cs_test_y', collected_information: { shipping_details: { name: NAME } } }).recipientName, NAME);
  assert.equal(normalizePrintContactPhone('312-555-0142'), PHONE);
  assert.equal(normalizePrintContactPhone('1 312 555 0142'), PHONE);
  assert.equal(normalizePrintContactPhone('+44 20 7946 0958'), '+442079460958');
  for (const bad of [null, '', '12345', 'call me', '000', '0000000000', '+0123456789']) assert.equal(normalizePrintContactPhone(bad), null);
});

function releasableOrder(id: string): OrderRecord {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' }),
    paymentStatus: 'paid', status: 'preview_ready', fulfillmentStatus: 'proof_ready', reviewStatus: 'approved', stripeSessionId: `cs_test_${id.slice(4)}`, shippingAddress: SHIPPING,
    pageArtifacts: padPageSet([]), storyArtifactUrl: 'https://example.invalid/proof.pdf', proofVersion: 'proof-v1', proofReviewedAt: '2026-09-02T12:00:00.000Z', proofReviewedVersion: 'proof-v1', proofApprovalToken: 'release-token',
    printInteriorArtifactUrl: 'https://example.invalid/interior.pdf', printInteriorMd5: 'interiormd5', printInteriorPageCount: 32, printInteriorProofVersion: 'proof-v1', printTitle: 'Fixture Title',
  };
  order.proofSourceFingerprint = proofSourceFingerprint(order);
  return order;
}

const releaseDeps = (submitted: unknown[]): FulfillmentDeps => ({
  calculateCoverDimensions: async () => ({ widthPt: 1200, heightPt: 650 }),
  buildPrintCoverPdf: () => Buffer.from('%PDF cover'),
  uploadArtifact: async (id, _buffer, filename) => `https://example.invalid/${id}/${filename}`,
  submitPrint: async (_order, contact) => { submitted.push(contact); return { jobId: 'job-contact' }; },
});

const recordFor = (order: OrderRecord, phone: string | null = PHONE) => recordSettledPrintContact({
  orderId: order.id, purchaseKind: 'order', stripeSessionId: order.stripeSessionId!, stripePaymentIntentId: null, quoteId: null, shippingAddress: SHIPPING, recipientName: NAME, phone,
});

test('print release refuses before any effect when contact, phone or capability is missing', async () => {
  const { restore } = env();
  try {
    const submitted: unknown[] = [];
    const missing = releasableOrder('ord_contact_none');
    await persistOrder(missing);
    assert.deepEqual(await approvePrintProof(missing.id, 'release-token', releaseDeps(submitted)), { ok: false, error: 'print_contact_missing' });
    assert.equal((await getOrder(missing.id))?.fulfillmentStatus, 'proof_ready');

    const noPhone = releasableOrder('ord_contact_nophone');
    await persistOrder(noPhone);
    await recordFor(noPhone, null);
    assert.deepEqual(await approvePrintProof(noPhone.id, 'release-token', releaseDeps(submitted)), { ok: false, error: 'print_contact_phone_missing' });
    assert.equal((await getOrder(noPhone.id))?.printSubmissionAttemptedAt ?? null, null);

    __setPrintContactStoreForTests(null);
    assert.deepEqual(await approvePrintProof(noPhone.id, 'release-token', releaseDeps(submitted)), { ok: false, error: 'print_contact_unavailable' });
    assert.equal(submitted.length, 0);
    assert.equal((await getOrder(noPhone.id))?.fulfillmentStatus, 'proof_ready');
  } finally {
    restore();
  }
});

for (const [label, drift] of [
  ['destination', { shippingAddress: { ...SHIPPING, zip: '60602' } }],
  ['payment', { stripePaymentIntentId: 'pi_drifted' }],
] as const) {
  test(`the submission fence refuses a ${label} that moved after the claim`, async () => {
    const { restore } = env();
    try {
      const order = releasableOrder(`ord_contact_drift_${label}`);
      await persistOrder(order);
      await recordFor(order);
      const submitted: unknown[] = [];
      const result = await approvePrintProof(order.id, 'release-token', {
        ...releaseDeps(submitted),
        uploadArtifact: async (id, _buffer, filename) => {
          await withOrderTransaction<null>(id, (current) => ({ commit: { ...current, ...drift }, result: null }));
          return `https://example.invalid/${id}/${filename}`;
        },
      });
      assert.deepEqual(result, { ok: false, error: 'print_submission_failed' });
      assert.equal(submitted.length, 0);
      const after = (await getOrder(order.id))!;
      assert.equal(after.printSubmissionAttemptedAt ?? null, null);
      assert.equal(after.fulfillmentStatus, 'failed_manual_review');
      assertContactFree(rawOrder(order.id));
    } finally {
      restore();
    }
  });
}

test('a bound contact reaches print and the Lulu payload never uses child or fallback values', async () => {
  const { restore } = env({ LULU_CLIENT_KEY: 'test-key', LULU_CLIENT_SECRET: 'test-secret', LULU_FALLBACK_PHONE: '+19999999999' });
  try {
    const order = releasableOrder('ord_contact_release');
    await persistOrder(order);
    await recordFor(order);
    const submitted: Array<{ recipientName: string; phone: string }> = [];
    const released = await approvePrintProof(order.id, 'release-token', releaseDeps(submitted));
    assert.equal(released.ok, true, released.error);
    assert.equal(submitted[0].recipientName, NAME);
    assertContactFree(rawOrder(order.id));

    clearTokenCache();
    let sent = '';
    const fetchMock = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      sent = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 1234 }));
    }) as typeof fetch;
    const printable = { ...order, printCoverArtifactUrl: 'https://example.invalid/cover.pdf', printCoverMd5: 'covermd5' };
    const binding = { orderId: order.id, purchaseKind: 'order' as const, stripeSessionId: order.stripeSessionId!, stripePaymentIntentId: null, quoteId: null, shippingAddress: SHIPPING };
    await submitPrintJob(printable, { fetch: fetchMock, contact: { ...binding, recipientName: NAME, phone: PHONE } });
    const payload = JSON.parse(sent);
    assert.equal(payload.shipping_address.name, NAME);
    assert.equal(payload.shipping_address.phone_number, PHONE);
    assert.equal(sent.includes('Fixture Child'), false);
    assert.equal(sent.includes('+19999999999'), false);
    await assert.rejects(() => submitPrintJob(printable, { fetch: fetchMock }), /print_contact_required/);
    await assert.rejects(() => submitPrintJob(printable, { fetch: fetchMock, contact: { ...binding, orderId: 'ord_contact_foreign', recipientName: NAME, phone: PHONE } }), /print_contact_required/);
  } finally {
    clearTokenCache();
    restore();
  }
});

test('a Lulu rejection that echoes contact never reaches the order record', async () => {
  const { restore } = env({ LULU_CLIENT_KEY: 'test-key', LULU_CLIENT_SECRET: 'test-secret' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => (String(url).includes('openid-connect/token')
    ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }))
    : new Response(`bad phone ${PHONE} for ${NAME}`, { status: 400 }))) as typeof fetch;
  try {
    clearTokenCache();
    const order = releasableOrder('ord_contact_lulu_echo');
    await persistOrder(order);
    await recordFor(order);
    const { submitPrint: _unused, ...deps } = releaseDeps([]);
    assert.deepEqual(await approvePrintProof(order.id, 'release-token', deps), { ok: false, error: 'print_submission_ambiguous' });
    assert.match((await getOrder(order.id))?.fulfillmentLastError ?? '', /Lulu API error 400/);
    assertContactFree(rawOrder(order.id));
  } finally {
    globalThis.fetch = realFetch;
    clearTokenCache();
    restore();
  }
});

const ECHOED_PRINT_REPLIES = [
  ['nonjson', 'a 2xx non-JSON body', 'Lulu API success response was not JSON; outcome requires reconciliation', () => new Response(`${NAME} ${PHONE}`, { status: 200 })],
  ['transport', 'a failed transport', 'Lulu API transport failed; outcome requires reconciliation', () => { throw new TypeError(`fetch failed for ${NAME} ${PHONE}`); }],
  ['jsonid', 'a 2xx JSON id', 'Lulu API success response missing print job id; outcome requires reconciliation', () => new Response(JSON.stringify({ id: `${NAME} ${PHONE}` }), { status: 201 })],
] as const;

for (const [slug, label, message, reply] of ECHOED_PRINT_REPLIES) {
  test(`${label} echoing contact stays out of the record, logs and result, and keeps the fence`, async () => {
    const { restore } = env({ LULU_CLIENT_KEY: 'test-key', LULU_CLIENT_SECRET: 'test-secret' });
    const realFetch = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes('openid-connect/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      posts += 1;
      return reply();
    }) as typeof fetch;
    const lines: string[] = [];
    const sinks = ['error', 'warn', 'log', 'info'] as const;
    const originals = sinks.map((sink) => console[sink]);
    for (const sink of sinks) console[sink] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      clearTokenCache();
      const order = releasableOrder(`ord_contact_echo_${slug}`);
      await persistOrder(order);
      await recordFor(order);
      const { submitPrint: _unused, ...deps } = releaseDeps([]);
      const result = await approvePrintProof(order.id, 'release-token', deps);
      assert.deepEqual(result, { ok: false, error: 'print_submission_ambiguous' });
      assert.equal(posts, 1);
      const after = (await getOrder(order.id))!;
      assert.equal(after.fulfillmentLastError, `print_submission_ambiguous: ${message}`);
      assert.equal(after.fulfillmentStatus, 'submitting_to_print');
      assert.ok(after.printSubmissionAttemptedAt);
      assert.equal(after.printJobId ?? null, null);
      assertContactFree(rawOrder(order.id));
      assertContactFree(JSON.stringify(result));
      assertContactFree(lines.join('\n'));
      assert.deepEqual(await approvePrintProof(order.id, 'release-token', deps), { ok: true });
      assert.equal(posts, 1, 'an unresolved submission is never sent again');
    } finally {
      sinks.forEach((sink, index) => { console[sink] = originals[index]; });
      globalThis.fetch = realFetch;
      clearTokenCache();
      restore();
    }
  });
}

test('at-cost upgrade stays contact-free in public records, converges on replay and stays visible to admin', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_contact_upgrade';
    const token = await preparedUpgrade(id);
    const calls = { count: 0, names: [] as string[] };
    const created: Array<Record<string, unknown>> = [];
    const deps = upgradeDeps(pricedProvider(calls), created);
    const quoted = await handlePrintUpgradeQuotePost(post({ token, shippingAddress: ADDRESS_INPUT }), id, deps);
    assert.equal(quoted.status, 200);
    assert.deepEqual(calls.names, [NAME, NAME], 'the provider prices the real recipient');
    assertContactFree(JSON.stringify(quoted.body));
    assertContactFree(rawOrder(id));
    assert.equal(store.objects.size, 2, 'one private intended recipient per quote');

    const premium = (quoted.body.quotes as Array<{ quoteId: string; targetFormat: string }>).find((quote) => quote.targetFormat === 'premium')!;
    const opened = await handlePrintUpgradeCheckoutPost(post({ token, quoteId: premium.quoteId }), id, deps);
    assert.equal(opened.status, 200);
    assert.deepEqual(created[0].phone_number_collection, { enabled: true });
    assertContactFree(JSON.stringify(created));
    assertContactFree(rawOrder(id));
    assert.equal('recipientName' in (await getOrder(id))!.printUpgradeLock!, false);

    const event = {
      id: 'evt_contact_upgrade', object: 'event', type: 'checkout.session.completed', created: 1_800_000_000,
      data: { object: {
        id: 'cs_test_upgrade_contact', object: 'checkout.session', client_reference_id: id,
        metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: id, quoteId: premium.quoteId, targetFormat: 'premium' },
        payment_intent: 'pi_upgrade_contact', amount_total: 1500, amount_subtotal: 1500, currency: 'usd', mode: 'payment', payment_status: 'paid',
        customer_details: { name: 'Card Holder', phone: PHONE_RAW },
      } },
    };

    const intended = new Map(store.objects);
    for (const pathname of intended.keys()) store.objects.set(pathname, '{not json');
    const failed = await runWebhook(event, { settledBy: [ANALYTICS_SETTLED] });
    assert.deepEqual(failed.statuses, [500]);
    assert.equal((await getOrder(id))!.printCopyPurchases?.length, 1, 'the settled purchase survives');
    assertContactFree(failed.lines.join('\n'));
    for (const [pathname, body] of intended) store.objects.set(pathname, body);

    const paid = await runWebhook(event);
    assert.deepEqual(paid.statuses, [200]);
    assertContactFree(paid.lines.join('\n'));
    assertContactFree(rawOrder(id));
    const stored = (await getOrder(id))!;
    assertContactFree(JSON.stringify(stored.printCopyPurchases));
    assertContactFree(JSON.stringify(buildOrderStatusView(stored)));
    assertContactFree(JSON.stringify(printUpgradeCheckoutStatusView(stored, 'cs_test_upgrade_contact')));
    assertContactFree(JSON.stringify(toAdminOrderDetail(stored)));
    const offered = await handlePrintUpgradeOfferPost(post({ token }), id, deps);
    assertContactFree(JSON.stringify(offered.body));

    assert.deepEqual((await runWebhook(event)).statuses, [200]);
    const admin = await loadAdminPrintContacts((await getOrder(id))!);
    assert.deepEqual(admin.map((row) => [row.purchase, row.status, row.recipientName, row.phone]), [['upgrade', 'complete', NAME, PHONE]]);
  } finally {
    restore();
  }
});

test('a signed extra_copy purchase keeps its own private contact and leaves the original order contact unchanged', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_contact_extra_webhook';
    const gift = { name: 'Grandparent Recipient', line1: '20 Other Way', line2: null, city: 'Testville', state: 'IL', zip: '60602', country: 'US' };
    await persistOrder({
      ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' }),
      paymentStatus: 'paid', settledAmountCents: 3900, stripeSessionId: 'cs_test_original', stripePaymentIntentId: 'pi_original', shippingAddress: SHIPPING, fulfillmentMode: 'manual_hold', fulfillmentStatus: 'not_started',
    });
    await recordSettledPrintContact({ orderId: id, purchaseKind: 'order', stripeSessionId: 'cs_test_original', stripePaymentIntentId: 'pi_original', quoteId: null, shippingAddress: SHIPPING, recipientName: NAME, phone: PHONE });
    const [[originalPath, originalBody]] = [...store.objects];

    const prepared = await prepareCustomerPrintUpgradeOffer(id, { purchaseKind: 'extra_copy', approvedSourceSha256: 'a'.repeat(64), approvedSourcePageCount: 25, now: NOW });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const created: Array<Record<string, unknown>> = [];
    const deps = upgradeDeps(pricedProvider({ count: 0, names: [] }), created);
    const quoted = await handlePrintUpgradeQuotePost(post({ token: prepared.token, shippingAddress: gift, quantity: 2 }), id, deps);
    assert.equal(quoted.status, 200);
    const classic = (quoted.body.quotes as Array<{ quoteId: string; targetFormat: string }>).find((quote) => quote.targetFormat === 'classic')!;
    const opened = await handlePrintUpgradeCheckoutPost(post({ token: prepared.token, quoteId: classic.quoteId }), id, deps);
    assert.equal(opened.status, 200);

    const event = {
      id: 'evt_contact_extra_copy', object: 'event', type: 'checkout.session.completed', created: 1_800_000_000,
      data: { object: {
        id: 'cs_test_upgrade_contact', object: 'checkout.session', client_reference_id: id,
        metadata: created[0].metadata,
        payment_intent: 'pi_extra_copy', amount_total: 1500, amount_subtotal: 1500, currency: 'usd', mode: 'payment', payment_status: 'paid',
        customer_details: { name: 'Card Holder', phone: '(312) 555-0199' },
      } },
    };
    const paid = await runWebhook(event, { settledBy: [ANALYTICS_SETTLED] });
    assert.deepEqual(paid.statuses, [200]);

    const stored = (await getOrder(id))!;
    assert.equal(stored.printCopyPurchases?.[0].kind, 'extra_copy');
    assert.equal(stored.bookFormat, 'classic');
    assert.equal(stored.printUpgradeStripeSessionId, 'cs_test_upgrade_contact');
    assert.deepEqual(stored.shippingAddress, SHIPPING);
    assert.equal(store.objects.get(originalPath), originalBody);
    assert.equal(store.objects.size, 4, 'original, two intended quotes and the purchase record');

    const resolved = await resolveOrderPrintContact(stored);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.contact.recipientName, NAME);
    assert.equal(resolved.contact.phone, PHONE);
    assert.equal(resolved.contact.purchaseKind, 'order');
    assert.equal(resolved.contact.stripeSessionId, 'cs_test_original');

    const expectedRows = [['order', 'complete', NAME, PHONE], ['extra_copy', 'complete', gift.name, '+13125550199']];
    const admin = await loadAdminPrintContacts(stored);
    assert.deepEqual(admin.map((row) => [row.purchase, row.status, row.recipientName, row.phone]), expectedRows);
    const allowed = await adminContactGet(new Request('http://127.0.0.1/x', { headers: { cookie: `hsb-ops-key=${ADMIN_KEY}` } }), { params: Promise.resolve({ orderId: id }) });
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as { contacts: Array<{ purchase: string; status: string; recipientName: string; phone: string }> };
    assert.deepEqual(body.contacts.map((row) => [row.purchase, row.status, row.recipientName, row.phone]), expectedRows);

    for (const text of [
      rawOrder(id),
      paid.lines.join('\n'),
      paid.outbound.map((call) => call.body).join('\n'),
      JSON.stringify(toAdminOrderDetail(stored)),
      JSON.stringify(buildOrderStatusView(stored)),
    ]) {
      assertContactFree(text);
      assert.equal(text.includes(gift.name), false);
      assert.equal(text.includes('555-0199'), false);
      assert.equal(text.includes('+13125550199'), false);
    }

    assert.deepEqual((await runWebhook(event)).statuses, [200]);
    assert.equal(store.objects.size, 4);
    assert.equal(store.objects.get(originalPath), originalBody);
  } finally {
    restore();
  }
});

test('a purchase settled before this boundary uses its inline recipient and stays bound on replay', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_contact_inline';
    const base = createOrderRecord({ childName: 'Fixture Child', bookFormat: 'digital', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' });
    await persistOrder({
      ...base, paymentStatus: 'paid', stripeSessionId: 'cs_test_original', shippingAddress: null,
      printCopyPurchases: [{
        version: 1, kind: 'upgrade', offerId: 'puo_x', quoteId: 'puq_0000000000000002', approvedSourceSha256: 'a'.repeat(64), approvedProofVersion: null, approvedProofAt: null,
        targetFormat: 'classic', quantity: 1, totalCents: 1500, currency: 'usd', stripeSessionId: 'cs_test_inline', stripePaymentIntentId: 'pi_inline', shippingAddress: { ...SHIPPING, name: NAME },
        estimatedDeliveryStart: '2026-10-20', estimatedDeliveryEnd: '2026-10-30', paidAt: NOW, printJobId: null, printStatus: 'awaiting_files',
      }],
    });
    const session = { id: 'cs_test_inline', payment_intent: 'pi_inline', customer_details: { phone: PHONE_RAW } };
    assert.equal(await capturePrintUpgradeContact(id, session), 'stored');
    assert.equal(await capturePrintUpgradeContact(id, session), 'replayed');
    await assert.rejects(() => capturePrintUpgradeContact(id, { ...session, payment_intent: 'pi_other' }), /print_contact_storage_unavailable/);
    assert.equal(store.objects.size, 1);
  } finally {
    restore();
  }
});

test('legacy retail-delta upgrade binds its own Session and PaymentIntent, and a replay converges', async () => {
  const { restore } = env();
  try {
    const id = 'ord_contact_legacy_upgrade';
    await persistOrder({
      ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'digital', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' }),
      paymentStatus: 'paid', settledAmountCents: 1900, stripeSessionId: 'cs_test_original', stripePaymentIntentId: 'pi_original', fulfillmentMode: 'manual_hold',
      printUpgradeStatus: 'checkout_open', printUpgradeStripeSessionId: 'cs_test_legacy_upgrade', printUpgradeTargetFormat: 'classic', printUpgradeAmountCents: 2000,
    });
    const event = {
      id: 'evt_contact_legacy_upgrade', object: 'event', type: 'checkout.session.completed', created: 1_800_000_000,
      data: { object: {
        id: 'cs_test_legacy_upgrade', object: 'checkout.session', client_reference_id: id,
        metadata: { kind: 'print_upgrade', orderId: id, targetFormat: 'classic' },
        payment_intent: 'pi_legacy_upgrade', amount_total: 2000, amount_subtotal: 2000, currency: 'usd', mode: 'payment', payment_status: 'paid',
        shipping_details: STRIPE_SHIPPING, customer_details: { name: 'Card Holder', phone: PHONE_RAW },
      } },
    };
    assert.deepEqual((await runWebhook(event, { settledBy: [ANALYTICS_SETTLED] })).statuses, [200]);
    assertContactFree(rawOrder(id));
    const stored = (await getOrder(id))!;
    assert.equal(stored.printUpgradePaymentIntentId, 'pi_legacy_upgrade');
    const resolved = await resolveOrderPrintContact(stored);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.contact.purchaseKind, 'print_upgrade');
    assert.equal(resolved.contact.stripeSessionId, 'cs_test_legacy_upgrade');
    assert.equal(resolved.contact.stripePaymentIntentId, 'pi_legacy_upgrade');
    assert.deepEqual((await runWebhook(event)).statuses, [200]);
  } finally {
    restore();
  }
});

test('source: Stripe contact collection is print-only and the store keeps no fallback or contact hash', () => {
  const route = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(route, /isPrintFormat\(order\.bookFormat\)\s*\?\s*\{ shipping_address_collection: \{ allowed_countries: \['US'\] as const \}, phone_number_collection: \{ enabled: true \} \}/);
  const store = readFileSync('src/lib/print-contact-store.ts', 'utf8');
  assert.doesNotMatch(store, /createHash|console\.|node:fs|customer_details\?\.name|requiresDurablePersistence/);
});
