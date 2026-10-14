/**
 * Customer + admin HTTP handlers for the at-cost print upgrade, executed with
 * the real order store and doubles only at the provider boundaries.
 *
 * Privacy contract: a guessed or tokenless URL learns nothing — not whether
 * the order exists, not the child's name, not an address. Every customer
 * denial is a uniform 404 with a generic reason; every success body is PII-free
 * beyond the first name the customer already knows.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOrderRecord, getOrder, persistOrder, type OrderRecord } from '../src/lib/orders.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import type { PrintCostQuoteProvider } from '../src/lib/print-upgrade-quote.ts';
import type { PrintUpgradeCheckoutSessionCreate } from '../src/lib/print-upgrade-checkout.ts';
import {
  handleAdminPrintUpgradeOfferPost,
  handlePrintUpgradeCheckoutPost,
  handlePrintUpgradeOfferPost,
  handlePrintUpgradeQuotePost,
  type PrintUpgradeRouteDeps,
} from '../src/lib/print-upgrade-route-handler.ts';

const APPROVED_SHA = '97312217e67bdc8845f5c03cd0d06533a1fe9a84bd030ce8fb25460e79f2ba38';
const NOW = '2026-10-14T12:00:00.000Z';
const ORDER_ID = 'ord_route_test_0001';
const ADDRESS = { name: 'Alexy Kaplun', line1: '1234 N Broadway', line2: '', city: 'Chicago', state: 'IL', zip: '60640', country: 'US' };

type JsonResponse = { status: number; body: Record<string, unknown> };

function makePaidDigitalOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Lukas', bookFormat: 'digital', email: 'parent@example.com' },
      { id: ORDER_ID, now: '2026-09-01T12:00:00Z' },
    ),
    paymentStatus: 'paid',
    paidAt: '2026-09-01T12:05:00Z',
    settledAmountCents: 1900,
    stripeSessionId: 'cs_original_digital',
    fulfillmentMode: 'manual_hold',
    printTitle: 'Lukas, King of Dino Earth',
    ...overrides,
  };
}

function withLocalStore(run: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-upgrade-route-'));
    const saved = { store: process.env.HSB_ORDER_STORE_DIR, blob: process.env.BLOB_READ_WRITE_TOKEN, admin: process.env.HSB_ORDER_ADMIN_KEY };
    process.env.HSB_ORDER_STORE_DIR = dir;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.HSB_ORDER_ADMIN_KEY = 'ops-key-test';
    try {
      await run();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (saved.store === undefined) delete process.env.HSB_ORDER_STORE_DIR; else process.env.HSB_ORDER_STORE_DIR = saved.store;
      if (saved.blob !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved.blob;
      if (saved.admin === undefined) delete process.env.HSB_ORDER_ADMIN_KEY; else process.env.HSB_ORDER_ADMIN_KEY = saved.admin;
    }
  };
}

const provider: PrintCostQuoteProvider = {
  async quote(request) {
    const row = request.targetFormat === 'premium'
      ? { printCents: 1973, shippingCents: 449, fulfillmentCents: 150, taxCents: 260 }
      : { printCents: 812, shippingCents: 449, fulfillmentCents: 150, taxCents: 140 };
    return { provider: 'lulu', podPackageId: `${request.targetFormat}.PKG`, shippingLevel: 'MAIL', currency: 'usd', ...row, totalCents: row.printCents + row.shippingCents + row.fulfillmentCents + row.taxCents, estimatedDeliveryStart: '2026-10-20', estimatedDeliveryEnd: '2026-10-30' };
  },
};

function deps(overrides: Partial<PrintUpgradeRouteDeps<JsonResponse>> = {}): PrintUpgradeRouteDeps<JsonResponse> & { created: PrintUpgradeCheckoutSessionCreate[] } {
  const created: PrintUpgradeCheckoutSessionCreate[] = [];
  return {
    created,
    json: (body, status) => ({ status, body: body as Record<string, unknown> }),
    quoteProvider: () => provider,
    createCheckoutSession: async (params) => { created.push(params); return { id: `cs_test_route_${created.length}`, url: `https://checkout.stripe.test/${created.length}` }; },
    baseUrl: () => 'https://hsb.test',
    now: () => NOW,
    ...overrides,
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function preparedToken() {
  await persistOrder(makePaidDigitalOrder());
  const prepared = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW });
  assert.ok(prepared.ok);
  return prepared.token;
}

test('offer: a valid token returns a PII-free chooser view; every denial is a uniform 404', withLocalStore(async () => {
  const token = await preparedToken();
  const d = deps();
  const ok = await handlePrintUpgradeOfferPost(post('https://hsb.test/api/order/x/print-upgrade/offer', { token }), ORDER_ID, d);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'offered');
  assert.equal(ok.body.bookTitle, 'Lukas, King of Dino Earth');
  assert.equal(ok.body.pageCount, 25);
  assert.deepEqual(ok.body.formats, [
    { targetFormat: 'classic', label: 'Classic softcover', pageCount: 32 },
    { targetFormat: 'premium', label: 'Premium hardcover', pageCount: 26 },
  ]);
  assert.equal(typeof ok.body.expiresAt, 'string');
  const text = JSON.stringify(ok.body);
  assert.equal(text.includes('parent@example.com'), false);
  assert.equal(text.includes(token), false);
  assert.equal(text.includes('tokenHash'), false);

  for (const [label, req, id] of [
    ['no body', post('https://hsb.test/x', undefined), ORDER_ID],
    ['empty token', post('https://hsb.test/x', { token: '' }), ORDER_ID],
    ['wrong token', post('https://hsb.test/x', { token: 'a'.repeat(48) }), ORDER_ID],
    ['token in query ignored', post(`https://hsb.test/x?token=${token}`, {}), ORDER_ID],
    ['unknown order', post('https://hsb.test/x', { token }), 'ord_other_order_0001'],
    ['overlong order id', post('https://hsb.test/x', { token }), 'o'.repeat(200)],
  ] as const) {
    const denied = await handlePrintUpgradeOfferPost(req, id, d);
    assert.equal(denied.status, 404, label);
    assert.deepEqual(denied.body, { error: 'not_found' }, label);
  }
}));

test('offer: consumed, expired and refunded states deny uniformly', withLocalStore(async () => {
  const token = await preparedToken();
  const d = deps();
  const expired = await handlePrintUpgradeOfferPost(post('https://hsb.test/x', { token }), ORDER_ID, deps({ now: () => '2026-12-01T00:00:00.000Z' }));
  assert.equal(expired.status, 404);
  const stored = (await getOrder(ORDER_ID))!;
  await persistOrder({ ...stored, refundedAt: NOW });
  const refunded = await handlePrintUpgradeOfferPost(post('https://hsb.test/x', { token }), ORDER_ID, d);
  assert.deepEqual(refunded, { status: 404, body: { error: 'not_found' } });
}));

test('quote: returns both at-cost quotes for the submitted address and never echoes the address', withLocalStore(async () => {
  const token = await preparedToken();
  const d = deps();
  const res = await handlePrintUpgradeQuotePost(post('https://hsb.test/x', { token, shippingAddress: ADDRESS }), ORDER_ID, d);
  assert.equal(res.status, 200);
  const quotes = res.body.quotes as Array<Record<string, unknown>>;
  assert.equal(quotes.length, 2);
  const premium = quotes.find((q) => q.targetFormat === 'premium')!;
  assert.deepEqual(Object.keys(premium).sort(), ['estimatedDeliveryEnd', 'estimatedDeliveryStart', 'expiresAt', 'fulfillmentCents', 'label', 'pageCount', 'printCents', 'quantity', 'quoteId', 'shippingCents', 'targetFormat', 'taxCents', 'totalCents']);
  assert.equal(premium.totalCents, 2832);
  assert.equal(premium.label, 'Premium hardcover');
  assert.equal(res.body.destinationZip, '60640');
  assert.equal(JSON.stringify(res.body).includes('Broadway'), false);
  assert.equal(JSON.stringify(res.body).includes('Kaplun'), false);
}));

test('quote: an invalid address is a 400, a provider outage is a 503 that blocks payment, a bad token is 404', withLocalStore(async () => {
  const token = await preparedToken();
  const bad = await handlePrintUpgradeQuotePost(post('https://hsb.test/x', { token, shippingAddress: { ...ADDRESS, zip: '1' } }), ORDER_ID, deps());
  assert.deepEqual(bad, { status: 400, body: { error: 'address_invalid' } });
  const down = await handlePrintUpgradeQuotePost(
    post('https://hsb.test/x', { token, shippingAddress: ADDRESS }),
    ORDER_ID,
    deps({ quoteProvider: () => ({ async quote() { throw new Error('lulu down'); } }) }),
  );
  assert.equal(down.status, 503);
  assert.equal(down.body.error, 'quote_unavailable');
  const unconfigured = await handlePrintUpgradeQuotePost(
    post('https://hsb.test/x', { token, shippingAddress: ADDRESS }),
    ORDER_ID,
    deps({ quoteProvider: () => { throw new Error('LULU_CLIENT_KEY missing'); } }),
  );
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.error, 'quote_unavailable');
  const denied = await handlePrintUpgradeQuotePost(post('https://hsb.test/x', { token: 'nope', shippingAddress: ADDRESS }), ORDER_ID, deps());
  assert.deepEqual(denied, { status: 404, body: { error: 'not_found' } });
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeQuotes ?? null, null);
}));

test('checkout: opens the price-locked Session for the chosen quote; a duplicate click returns the same URL', withLocalStore(async () => {
  const token = await preparedToken();
  const d = deps();
  const quoted = await handlePrintUpgradeQuotePost(post('https://hsb.test/x', { token, shippingAddress: ADDRESS }), ORDER_ID, d);
  const premium = (quoted.body.quotes as Array<Record<string, unknown>>).find((q) => q.targetFormat === 'premium')!;
  const first = await handlePrintUpgradeCheckoutPost(post('https://hsb.test/x', { token, quoteId: premium.quoteId }), ORDER_ID, d);
  assert.equal(first.status, 200);
  assert.equal(first.body.url, 'https://checkout.stripe.test/1');
  assert.equal(first.body.reused, false);
  assert.equal(d.created.length, 1);
  assert.equal(d.created[0].metadata.kind, 'print_upgrade_at_cost');
  assert.equal(d.created[0].line_items.reduce((a, li) => a + li.price_data.unit_amount, 0), 2832);
  const second = await handlePrintUpgradeCheckoutPost(post('https://hsb.test/x', { token, quoteId: premium.quoteId }), ORDER_ID, d);
  assert.equal(second.status, 200);
  assert.equal(second.body.url, 'https://checkout.stripe.test/1');
  assert.equal(second.body.reused, true);
  assert.equal(d.created.length, 1);

  const classic = (quoted.body.quotes as Array<Record<string, unknown>>).find((q) => q.targetFormat === 'classic')!;
  const other = await handlePrintUpgradeCheckoutPost(post('https://hsb.test/x', { token, quoteId: classic.quoteId }), ORDER_ID, d);
  assert.equal(other.status, 409);
  assert.equal(other.body.error, 'checkout_already_open');
  assert.equal((other.body.open as Record<string, unknown>).targetFormat, 'premium');
}));

test('checkout: unknown/expired quote is 409, provider failure is 503, bad token is 404, and nothing is created', withLocalStore(async () => {
  const token = await preparedToken();
  const d = deps();
  const quoted = await handlePrintUpgradeQuotePost(post('https://hsb.test/x', { token, shippingAddress: ADDRESS }), ORDER_ID, d);
  const premium = (quoted.body.quotes as Array<Record<string, unknown>>).find((q) => q.targetFormat === 'premium')!;
  assert.deepEqual(await handlePrintUpgradeCheckoutPost(post('https://hsb.test/x', { token, quoteId: 'puq_ffffffffffffffff' }), ORDER_ID, d), { status: 409, body: { error: 'quote_not_found' } });
  assert.deepEqual(await handlePrintUpgradeCheckoutPost(post('https://hsb.test/x', { token, quoteId: premium.quoteId }), ORDER_ID, deps({ now: () => '2026-10-14T13:30:00.000Z' })), { status: 409, body: { error: 'quote_expired' } });
  assert.deepEqual(await handlePrintUpgradeCheckoutPost(post('https://hsb.test/x', { token: 'nope', quoteId: premium.quoteId }), ORDER_ID, d), { status: 404, body: { error: 'not_found' } });
  const failing = deps({ createCheckoutSession: async () => { throw new Error('stripe down'); } });
  assert.deepEqual(await handlePrintUpgradeCheckoutPost(post('https://hsb.test/x', { token, quoteId: premium.quoteId }), ORDER_ID, failing), { status: 503, body: { error: 'provider_failed' } });
  assert.equal(d.created.length, 0);
  assert.notEqual((await getOrder(ORDER_ID))!.printUpgradeStatus, 'checkout_open');
}));

test('admin offer: requires the ops key, verifies the approved source, and returns the one-time link + email draft without sending', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder());
  const d = deps();
  const body = { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, approvedSourceLabel: 'private-review-v5.pdf' };
  const unauth = await handleAdminPrintUpgradeOfferPost(post('https://hsb.test/x', body), ORDER_ID, d);
  assert.equal(unauth.status, 401);
  const wrongKey = await handleAdminPrintUpgradeOfferPost(post('https://hsb.test/x', body, { cookie: 'hsb-ops-key=wrong' }), ORDER_ID, d);
  assert.equal(wrongKey.status, 401);
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeOffer ?? null, null);

  const res = await handleAdminPrintUpgradeOfferPost(post('https://hsb.test/x', body, { cookie: 'hsb-ops-key=ops-key-test' }), ORDER_ID, d);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(String(res.body.chooserUrl), /^https:\/\/hsb\.test\/upgrade\/ord_route_test_0001#token=[a-f0-9]{48}$/);
  const email = res.body.emailDraft as Record<string, string>;
  assert.equal(email.to, 'parent@example.com');
  assert.match(email.subject, /Lukas/);
  assert.ok(email.text.includes(String(res.body.chooserUrl)));
  assert.equal(res.body.sent, false);
  assert.match(String(res.body.safety), /No email was sent/);
  assert.match(String(res.body.safety), /No Stripe Checkout Session/);
  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradeStatus, 'offered');
  assert.equal(JSON.stringify(stored).includes(String(res.body.chooserUrl).split('#token=')[1]), false);

  const bad = await handleAdminPrintUpgradeOfferPost(post('https://hsb.test/x', { ...body, approvedSourceSha256: 'nope' }, { cookie: 'hsb-ops-key=ops-key-test' }), ORDER_ID, d);
  assert.deepEqual(bad, { status: 400, body: { error: 'approved_source_invalid' } });
  await persistOrder({ ...stored, paymentStatus: 'pending' });
  const unpaid = await handleAdminPrintUpgradeOfferPost(post('https://hsb.test/x', body, { cookie: 'hsb-ops-key=ops-key-test' }), ORDER_ID, d);
  assert.deepEqual(unpaid, { status: 409, body: { error: 'order_not_paid' } });
}));

test('route files: customer routes are thin adapters over the lib handlers and the admin preview route is untouched', () => {
  const base = 'src/app/api/order/[orderId]/print-upgrade';
  for (const [file, handler] of [
    [`${base}/offer/route.ts`, 'handlePrintUpgradeOfferPost'],
    [`${base}/quote/route.ts`, 'handlePrintUpgradeQuotePost'],
    [`${base}/checkout/route.ts`, 'handlePrintUpgradeCheckoutPost'],
  ] as const) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, new RegExp(handler), file);
    assert.match(src, /export async function POST/, file);
    assert.doesNotMatch(src, /submitPrintJob|scheduleFulfillmentKickoff|triggerFulfillment|calculatePrintUpgrade/, file);
  }
  const checkoutRoute = readFileSync(`${base}/checkout/route.ts`, 'utf8');
  assert.match(checkoutRoute, /checkout\.sessions\.create\(params, \{ idempotencyKey \}\)/);
  const quoteRoute = readFileSync(`${base}/quote/route.ts`, 'utf8');
  assert.match(quoteRoute, /createLuluPrintCostQuoteProvider/);
  const adminOffer = readFileSync('src/app/api/admin/orders/[orderId]/print-upgrade-offer/route.ts', 'utf8');
  assert.match(adminOffer, /handleAdminPrintUpgradeOfferPost/);
  const adminPreview = readFileSync('src/app/api/admin/orders/[orderId]/print-upgrade/route.ts', 'utf8');
  assert.match(adminPreview, /print_upgrade_checkout_retired/);
  assert.match(adminPreview, /dryRun: true/);
});
