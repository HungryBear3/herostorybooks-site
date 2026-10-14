/**
 * Customer digital-to-print upgrade: price-locked Stripe Checkout binding and
 * signed-webhook settlement.
 *
 * - A Checkout Session is created only for a live quote under a live offer,
 *   for exactly the quote's provider-cost total, with a deterministic
 *   idempotency key, and bound durably before its URL is released.
 * - A duplicate click reuses the open Session; no second provider create.
 * - Settlement applies only the exact bound Session with the exact locked
 *   amount; anything else is recorded as a conflict and never applied.
 * - Settlement never starts fulfillment and never submits a print job.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOrderRecord, getOrder, persistOrder, type OrderRecord } from '../src/lib/orders.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import { quotePrintUpgradeAtCost, type PrintCostQuoteProvider } from '../src/lib/print-upgrade-quote.ts';
import {
  PRINT_UPGRADE_CHECKOUT_SESSION_TTL_MS,
  PRINT_UPGRADE_STRIPE_KIND,
  PrintUpgradeCheckoutCreateRejectedError,
  checkoutCreateWasRejected,
  openPrintUpgradeCheckout,
  printPurchaseApprovalIsCurrent,
  printUpgradeCheckoutIdempotencyKey,
  printUpgradeCheckoutStatusView,
  recordPrintUpgradeCheckoutExpired,
  settlePrintUpgradeAtCostSession,
  type PrintUpgradeCheckoutSessionCreate,
  type PrintUpgradeCheckoutSessionLike,
} from '../src/lib/print-upgrade-checkout.ts';
import { isPrintUpgradeLockLive } from '../src/lib/print-upgrade-lock.ts';

function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString();
}

/** A failure that proves Stripe created nothing (shape of stripe-node's StripeInvalidRequestError). */
function stripeRejection(): Error {
  return Object.assign(new Error('Invalid expires_at'), { type: 'StripeInvalidRequestError', statusCode: 400 });
}

const APPROVED_SHA = '97312217e67bdc8845f5c03cd0d06533a1fe9a84bd030ce8fb25460e79f2ba38';
const NOW = '2026-10-14T12:00:00.000Z';
const ORDER_ID = 'ord_checkout_test_01';
const BASE_URL = 'https://hsb.test';
const ADDRESS = { name: 'Alexy Kaplun', line1: '1234 N Broadway', line2: null, city: 'Chicago', state: 'IL', zip: '60640', country: 'US' };

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
    fulfillmentStatus: 'not_started',
    ...overrides,
  };
}

function withLocalStore(run: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-upgrade-checkout-'));
    const saved = { store: process.env.HSB_ORDER_STORE_DIR, blob: process.env.BLOB_READ_WRITE_TOKEN };
    process.env.HSB_ORDER_STORE_DIR = dir;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    try {
      await run();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (saved.store === undefined) delete process.env.HSB_ORDER_STORE_DIR; else process.env.HSB_ORDER_STORE_DIR = saved.store;
      if (saved.blob !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved.blob;
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

async function quotedOffer() {
  await persistOrder(makePaidDigitalOrder());
  const prepared = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW });
  assert.ok(prepared.ok);
  const quoted = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: NOW });
  assert.ok(quoted.ok);
  const premium = quoted.quotes.find((q) => q.targetFormat === 'premium')!;
  const classic = quoted.quotes.find((q) => q.targetFormat === 'classic')!;
  return { token: prepared.token, offer: prepared.offer, premium, classic };
}

function fakeStripe(created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[], opts: { fail?: boolean } = {}) {
  return async (params: PrintUpgradeCheckoutSessionCreate, idempotencyKey: string) => {
    created.push({ params, idempotencyKey });
    if (opts.fail) throw new Error('stripe down');
    // Stripe idempotency: same key → same Session.
    const existing = created.findIndex((c) => c.idempotencyKey === idempotencyKey);
    const n = existing >= 0 ? existing + 1 : created.length;
    return { id: `cs_test_upgrade_${n}`, url: `https://checkout.stripe.test/c/pay/cs_test_upgrade_${n}` };
  };
}

function paidSession(overrides: Partial<PrintUpgradeCheckoutSessionLike> = {}): PrintUpgradeCheckoutSessionLike {
  return {
    id: 'cs_test_upgrade_1',
    mode: 'payment',
    payment_status: 'paid',
    amount_subtotal: 2832,
    amount_total: 2832,
    currency: 'usd',
    client_reference_id: ORDER_ID,
    payment_intent: 'pi_test_upgrade_1',
    metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: 'REPLACED' },
    ...overrides,
  };
}

test('idempotency key is deterministic per order + quote', () => {
  assert.equal(printUpgradeCheckoutIdempotencyKey('ord_a', 'puq_1'), printUpgradeCheckoutIdempotencyKey('ord_a', 'puq_1'));
  assert.notEqual(printUpgradeCheckoutIdempotencyKey('ord_a', 'puq_1'), printUpgradeCheckoutIdempotencyKey('ord_a', 'puq_2'));
  assert.notEqual(printUpgradeCheckoutIdempotencyKey('ord_a', 'puq_1'), printUpgradeCheckoutIdempotencyKey('ord_b', 'puq_1'));
});

test('open: creates one price-locked Session for the chosen quote and binds it before releasing the URL', withLocalStore(async () => {
  const { token, offer, premium } = await quotedOffer();
  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const result = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(result.stripeSessionId, 'cs_test_upgrade_1');
  assert.equal(result.url, 'https://checkout.stripe.test/c/pay/cs_test_upgrade_1');

  assert.equal(created.length, 1);
  const { params, idempotencyKey } = created[0];
  assert.equal(idempotencyKey, printUpgradeCheckoutIdempotencyKey(ORDER_ID, premium.quoteId));
  assert.equal(params.mode, 'payment');
  // Card only: no delayed-notification method can complete the Session unpaid.
  assert.deepEqual(params.payment_method_types, ['card']);
  assert.equal(params.client_reference_id, ORDER_ID);
  assert.equal(params.customer_email, 'parent@example.com');
  assert.equal(params.allow_promotion_codes, false);
  assert.deepEqual(params.metadata, { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, offerId: offer.offerId, quoteId: premium.quoteId, targetFormat: 'premium', purchaseKind: 'upgrade', quantity: '1', approvedSourceSha256: APPROVED_SHA });
  assert.deepEqual(params.payment_intent_data, { metadata: { orderId: ORDER_ID, kind: PRINT_UPGRADE_STRIPE_KIND, quoteId: premium.quoteId, purchaseKind: 'upgrade', quantity: '1' } });
  const amounts = params.line_items.map((li) => li.price_data.unit_amount);
  assert.deepEqual(amounts, [1973, 449, 150, 260]);
  assert.equal(amounts.reduce((a, b) => a + b, 0), premium.totalCents);
  assert.ok(params.line_items.every((li) => li.quantity === 1 && li.price_data.currency === 'usd'));
  assert.match(params.line_items[0].price_data.product_data.name, /hardcover/i);
  assert.match(params.line_items[0].price_data.product_data.name, /at cost/i);
  assert.equal('shipping_address_collection' in params, false);
  assert.equal(params.expires_at, Math.floor((Date.parse(NOW) + PRINT_UPGRADE_CHECKOUT_SESSION_TTL_MS) / 1000));
  assert.equal(params.success_url, `${BASE_URL}/upgrade/${ORDER_ID}/done?sessionId={CHECKOUT_SESSION_ID}`);
  assert.equal(params.cancel_url, `${BASE_URL}/upgrade/${ORDER_ID}/cancelled`);
  assert.equal(JSON.stringify(params).includes(token), false);
  assert.equal(JSON.stringify(params).includes('Broadway'), false);

  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradeStatus, 'checkout_open');
  assert.equal(stored.printUpgradeStripeSessionId, 'cs_test_upgrade_1');
  assert.equal(stored.printUpgradeTargetFormat, 'premium');
  assert.equal(stored.printUpgradeAmountCents, premium.totalCents);
  assert.equal(stored.printUpgradeLock?.status, 'open');
  assert.equal(stored.printUpgradeLock?.quoteId, premium.quoteId);
  assert.equal(stored.printUpgradeLock?.totalCents, premium.totalCents);
  assert.equal(stored.printUpgradeLock?.stripeSessionId, 'cs_test_upgrade_1');
  assert.equal(stored.printUpgradeLock?.recipientName, 'Alexy Kaplun');
  assert.equal(stored.bookFormat, 'digital');
  assert.equal(stored.printUpgradeOffer?.consumedAt ?? null, null);
  assert.equal((stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_checkout_opened').length, 1);
}));

test('open: refuses a wrong token, an unknown/foreign/expired quote, and a quote for a rotated offer — no provider call', withLocalStore(async () => {
  const { token, premium } = await quotedOffer();
  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const deps = { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: NOW };

  assert.deepEqual(await openPrintUpgradeCheckout(ORDER_ID, { token: 'bad', quoteId: premium.quoteId }, deps), { ok: false, reason: 'token_invalid' });
  assert.deepEqual(await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: 'puq_0000000000000000' }, deps), { ok: false, reason: 'quote_not_found' });
  assert.deepEqual(await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: '' }, deps), { ok: false, reason: 'quote_not_found' });
  assert.deepEqual(
    await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { ...deps, now: new Date(Date.parse(premium.expiresAt)).toISOString() }),
    { ok: false, reason: 'quote_expired' },
  );
  assert.deepEqual(await openPrintUpgradeCheckout('ord_nope', { token, quoteId: premium.quoteId }, deps), { ok: false, reason: 'order_not_found' });

  // Rotating the offer orphans every earlier quote.
  const rotated = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW });
  assert.ok(rotated.ok);
  assert.deepEqual(await openPrintUpgradeCheckout(ORDER_ID, { token: rotated.token, quoteId: premium.quoteId }, deps), { ok: false, reason: 'quote_not_found' });

  assert.equal(created.length, 0);
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeLock ?? null, null);
}));

test('open: a duplicate click reuses the open Session without a second provider create', withLocalStore(async () => {
  const { token, premium, classic } = await quotedOffer();
  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const deps = { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: NOW };
  const first = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, deps);
  const second = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, deps);
  assert.ok(first.ok && second.ok);
  assert.equal(second.reused, true);
  assert.equal(second.stripeSessionId, first.stripeSessionId);
  assert.equal(second.url, first.url);
  assert.equal(created.length, 1);

  // A different format while a Session is open: surface the open one, create nothing.
  const other = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: classic.quoteId }, deps);
  assert.equal(other.ok, false);
  if (other.ok !== false || other.reason !== 'checkout_already_open') throw new Error(`expected checkout_already_open, got ${JSON.stringify(other)}`);
  assert.equal(other.open.targetFormat, 'premium');
  assert.equal(other.open.url, first.url);
  assert.equal(created.length, 1);
}));

test('open: an ambiguous provider failure leaves no payable lock behind; the same quote retries the same idempotency key without extending the Session', withLocalStore(async () => {
  const { token, premium } = await quotedOffer();
  const failed: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const result = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe(failed, { fail: true }), baseUrl: BASE_URL, now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'provider_failed' });
  const afterFailure = (await getOrder(ORDER_ID))!;
  assert.notEqual(afterFailure.printUpgradeStatus, 'checkout_open');
  assert.equal(afterFailure.printUpgradeStripeSessionId ?? null, null);
  assert.equal(afterFailure.printUpgradeLock?.status, 'provisioning');
  const failures = (afterFailure.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_checkout_create_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].meta?.outcome, 'ambiguous');
  assert.equal(failures[0].meta?.lockReleased, false);
  assert.equal(JSON.stringify(failures[0]).includes('stripe down'), false, 'provider error text is not persisted');

  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const retry = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: minutesAfter(NOW, 2) });
  assert.equal(retry.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].idempotencyKey, printUpgradeCheckoutIdempotencyKey(ORDER_ID, premium.quoteId));
  assert.equal(created[0].idempotencyKey, failed[0].idempotencyKey, 'retry reuses the exact key the failed attempt used');
  assert.deepEqual(created[0].params, failed[0].params, 'retry sends byte-identical parameters so Stripe replays, never duplicates');
  assert.equal(created[0].params.expires_at, Math.floor((Date.parse(NOW) + PRINT_UPGRADE_CHECKOUT_SESSION_TTL_MS) / 1000), 'the original Session expiry is not extended');
  const bound = (await getOrder(ORDER_ID))!;
  assert.equal(bound.printUpgradeLock?.status, 'open');
  assert.equal(bound.printUpgradeLock?.expiresAt, minutesAfter(NOW, 60));
}));

test('open: while a create outcome is ambiguous, a different quote, a re-quote and a re-offer are refused until the Session TTL passes — then all proceed, and no second create happens before that', withLocalStore(async () => {
  const { token, premium, classic } = await quotedOffer();
  await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe([], { fail: true }), baseUrl: BASE_URL, now: NOW });
  const lock = (await getOrder(ORDER_ID))!.printUpgradeLock!;
  assert.equal(lock.status, 'provisioning');
  assert.equal(isPrintUpgradeLockLive(lock, Date.parse(minutesAfter(NOW, 59))), true);
  assert.equal(isPrintUpgradeLockLive(lock, Date.parse(minutesAfter(NOW, 60))), false);

  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  for (const at of [minutesAfter(NOW, 1), minutesAfter(NOW, 59)]) {
    const other = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: classic.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: at });
    assert.deepEqual(other, { ok: false, reason: 'checkout_busy' }, at);
    assert.deepEqual(await quotePrintUpgradeAtCost(ORDER_ID, { token, shippingAddress: ADDRESS }, { provider, now: at }), { ok: false, reason: 'quote_unavailable' }, at);
    assert.deepEqual(await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: at }), { ok: false, reason: 'checkout_already_open' }, at);
  }
  assert.equal(created.length, 0, 'no second payable Session while the first may exist');

  // Past the mirrored `expires_at`, any Session the failed call did create is
  // itself expired at Stripe, so the lock no longer blocks anything.
  const later = minutesAfter(NOW, 60);
  const requoted = await quotePrintUpgradeAtCost(ORDER_ID, { token, shippingAddress: ADDRESS }, { provider, now: later });
  assert.ok(requoted.ok);
  const next = requoted.quotes.find((q) => q.targetFormat === 'classic')!;
  const reopened = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: next.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: minutesAfter(NOW, 61) });
  assert.ok(reopened.ok);
  assert.equal(created.length, 1);
  assert.equal(created[0].idempotencyKey, printUpgradeCheckoutIdempotencyKey(ORDER_ID, next.quoteId));
  assert.notEqual(created[0].idempotencyKey, lock.idempotencyKey);
  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradeLock?.status, 'open');
  assert.equal(stored.printUpgradeLock?.quoteId, next.quoteId);
  assert.deepEqual(stored.printUpgradeLock?.supersededStripeSessionIds, [], 'a never-bound lock has no Session id to supersede');

  // The operator can also re-offer once that second Session's TTL has passed.
  const reoffered = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: minutesAfter(NOW, 121) });
  assert.ok(reoffered.ok);
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeLock ?? null, null);
}));

test('open: a definite provider rejection releases the lock in the same commit, so a different format, a re-quote and a re-offer proceed immediately', withLocalStore(async () => {
  const { token, premium, classic } = await quotedOffer();
  let rejections = 0;
  const result = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, {
    createCheckoutSession: async () => { rejections += 1; throw stripeRejection(); }, baseUrl: BASE_URL, now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'provider_failed' });
  assert.equal(rejections, 1);
  const released = (await getOrder(ORDER_ID))!;
  assert.equal(released.printUpgradeLock?.status, 'expired');
  assert.equal(released.printUpgradeLock?.stripeSessionId, null);
  assert.equal(released.printUpgradeLock?.checkoutUrl, null);
  assert.notEqual(released.printUpgradeStatus, 'checkout_open');
  const failures = (released.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_checkout_create_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].meta?.outcome, 'rejected');
  assert.equal(failures[0].meta?.lockReleased, true);
  assert.equal(isPrintUpgradeLockLive(released.printUpgradeLock, Date.parse(NOW)), false);

  // Same instant: the other format opens with its own key; nothing waits.
  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const other = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: classic.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: minutesAfter(NOW, 1) });
  assert.ok(other.ok);
  assert.equal(created[0].idempotencyKey, printUpgradeCheckoutIdempotencyKey(ORDER_ID, classic.quoteId));
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeLock?.targetFormat, 'classic');

  // And on a fresh order with the same rejection, re-quote and re-offer are not blocked either.
  await persistOrder(makePaidDigitalOrder());
  const again = await quotedOffer();
  await openPrintUpgradeCheckout(ORDER_ID, { token: again.token, quoteId: again.premium.quoteId }, { createCheckoutSession: async () => { throw new PrintUpgradeCheckoutCreateRejectedError('adapter says: not created'); }, baseUrl: BASE_URL, now: NOW });
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeLock?.status, 'expired');
  const requoted = await quotePrintUpgradeAtCost(ORDER_ID, { token: again.token, shippingAddress: ADDRESS }, { provider, now: minutesAfter(NOW, 1) });
  assert.ok(requoted.ok);
  const reoffered = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: minutesAfter(NOW, 1) });
  assert.ok(reoffered.ok);
}));

test('liveness: an open Session whose expiry webhook never arrives stops blocking re-quote, re-offer and a new checkout once its TTL passes', withLocalStore(async () => {
  const { token, premium } = await quotedOffer();
  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const opened = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: NOW });
  assert.ok(opened.ok);

  // Still live: everything that could mint a second payable Session is refused.
  const mid = minutesAfter(NOW, 30);
  assert.deepEqual(await quotePrintUpgradeAtCost(ORDER_ID, { token, shippingAddress: ADDRESS }, { provider, now: mid }), { ok: false, reason: 'quote_unavailable' });
  assert.deepEqual(await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: mid }), { ok: false, reason: 'checkout_already_open' });
  assert.deepEqual(printUpgradeCheckoutStatusView((await getOrder(ORDER_ID))!, 'cs_test_upgrade_1', new Date(mid)), { status: 'pending', targetFormat: 'premium' });

  // TTL passed, no `checkout.session.expired` delivered: the lock is still
  // recorded `open`, but it can no longer be paid and no longer blocks.
  const later = minutesAfter(NOW, 60);
  const stale = (await getOrder(ORDER_ID))!;
  assert.equal(stale.printUpgradeLock?.status, 'open');
  assert.deepEqual(printUpgradeCheckoutStatusView(stale, 'cs_test_upgrade_1', new Date(later)), { status: 'expired' });
  const requoted = await quotePrintUpgradeAtCost(ORDER_ID, { token, shippingAddress: ADDRESS }, { provider, now: later });
  assert.ok(requoted.ok);
  const next = requoted.quotes.find((q) => q.targetFormat === 'classic')!;
  const reopened = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: next.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: minutesAfter(NOW, 61) });
  assert.ok(reopened.ok);
  assert.equal(reopened.reused, false);
  assert.notEqual(reopened.stripeSessionId, 'cs_test_upgrade_1');
  const superseded = (await getOrder(ORDER_ID))!;
  assert.deepEqual(superseded.printUpgradeLock?.supersededStripeSessionIds, ['cs_test_upgrade_1']);

  // The old Session can neither settle nor, arriving late, disturb the new lock.
  const late = await settlePrintUpgradeAtCostSession(paidSession({ metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: premium.quoteId } }), { now: minutesAfter(NOW, 62) });
  assert.equal(late.outcome, 'conflict_recorded');
  assert.equal((await recordPrintUpgradeCheckoutExpired({ id: 'cs_test_upgrade_1', metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID } }, { now: minutesAfter(NOW, 62) })).outcome, 'ignored');
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeLock?.stripeSessionId, reopened.stripeSessionId);

  // Re-offer likewise waits only for the new lock's TTL.
  assert.deepEqual(await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: minutesAfter(NOW, 90) }), { ok: false, reason: 'checkout_already_open' });
  const reoffered = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: minutesAfter(NOW, 121) });
  assert.ok(reoffered.ok);
}));

test('create failure classification: only Stripe rejections that prove nothing was created release the lock', () => {
  for (const type of ['StripeInvalidRequestError', 'StripeAuthenticationError', 'StripePermissionError']) {
    assert.equal(checkoutCreateWasRejected(Object.assign(new Error(type), { type })), true, type);
  }
  for (const type of ['StripeConnectionError', 'StripeAPIError', 'StripeIdempotencyError', 'StripeCardError', 'SomethingElse']) {
    assert.equal(checkoutCreateWasRejected(Object.assign(new Error(type), { type })), false, type);
  }
  assert.equal(checkoutCreateWasRejected(new PrintUpgradeCheckoutCreateRejectedError('adapter-asserted')), true);
  assert.equal(checkoutCreateWasRejected(Object.assign(new Error('rate limited'), { type: 'StripeRateLimitError' })), false);
  assert.equal(checkoutCreateWasRejected(new Error('ETIMEDOUT')), false);
  assert.equal(checkoutCreateWasRejected('stripe down'), false);
  assert.equal(checkoutCreateWasRejected(null), false);
});

test('settle: a completed Session that is not yet paid never settles, and the later paid event for the same Session still does', withLocalStore(async () => {
  const { token, premium } = await quotedOffer();
  await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe([]), baseUrl: BASE_URL, now: NOW });
  const metadata = { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: premium.quoteId };

  // What a delayed-notification method would deliver first (unreachable with
  // card-only Checkout, but the settlement must still refuse it).
  const pending = await settlePrintUpgradeAtCostSession(paidSession({ metadata, payment_status: 'unpaid' }), { now: minutesAfter(NOW, 5) });
  assert.equal(pending.outcome, 'conflict_recorded');
  const untouched = (await getOrder(ORDER_ID))!;
  assert.equal(untouched.bookFormat, 'digital');
  assert.equal(untouched.printUpgradeStatus, 'checkout_open');
  assert.equal(untouched.printUpgradeLock?.status, 'open');
  assert.equal(untouched.printUpgradeOffer?.consumedAt ?? null, null);
  assert.equal((untouched.printCopyPurchases ?? []).length, 0);
  assert.deepEqual(printUpgradeCheckoutStatusView(untouched, 'cs_test_upgrade_1', new Date(minutesAfter(NOW, 5))), { status: 'pending', targetFormat: 'premium' });

  const paid = await settlePrintUpgradeAtCostSession(paidSession({ metadata }), { now: minutesAfter(NOW, 10) });
  assert.equal(paid.outcome, 'paid');
  const settled = (await getOrder(ORDER_ID))!;
  assert.equal(settled.printUpgradeStatus, 'paid');
  assert.equal(settled.bookFormat, 'premium');
  assert.equal((settled.printCopyPurchases ?? []).length, 1);
  assert.equal((settled.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_at_cost_paid').length, 1);
}));

test('settle: the exact bound Session with the exact locked amount flips the order to the chosen print format and consumes the offer', withLocalStore(async () => {
  const { token, premium } = await quotedOffer();
  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const opened = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: NOW });
  assert.ok(opened.ok);
  const paidAt = '2026-10-14T12:20:00.000Z';
  const session = paidSession({ metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: premium.quoteId } });
  const settled = await settlePrintUpgradeAtCostSession(session, { now: paidAt });
  assert.equal(settled.outcome, 'paid');

  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.bookFormat, 'premium');
  assert.equal(stored.formatLabel, 'Premium hardcover');
  assert.equal(stored.priceCents, 1900, 'original purchase price is never rewritten');
  assert.equal(stored.settledAmountCents, 1900);
  assert.equal(stored.stripeSessionId, 'cs_original_digital');
  assert.equal(stored.printUpgradeStatus, 'paid');
  assert.equal(stored.printUpgradeSourceFormat, 'digital');
  assert.equal(stored.printUpgradeTargetFormat, 'premium');
  assert.equal(stored.printUpgradeAmountCents, 2832);
  assert.equal(stored.printUpgradeStripeSessionId, 'cs_test_upgrade_1');
  assert.equal(stored.printUpgradePaidAt, paidAt);
  assert.equal(stored.printUpgradePrintProvider, 'lulu');
  assert.deepEqual(stored.shippingAddress, { line1: '1234 N Broadway', line2: null, city: 'Chicago', state: 'IL', zip: '60640', country: 'US' });
  assert.equal(stored.printUpgradeOffer?.consumedAt, paidAt);
  assert.equal(stored.printUpgradeLock?.status, 'paid');
  assert.equal(stored.printUpgradeLock?.stripePaymentIntentId, 'pi_test_upgrade_1');
  assert.equal(stored.printUpgradeLock?.paidAt, paidAt);
  // Nothing downstream moved.
  assert.equal(stored.fulfillmentStatus, 'not_started');
  assert.equal(stored.printJobId ?? null, null);
  assert.equal(stored.printJobStatus ?? null, null);
  assert.equal(stored.printInteriorArtifactUrl ?? null, null);
  assert.equal(stored.printSubmissionAttemptedAt ?? null, null);
  assert.equal(stored.proofApprovalToken ?? null, null);
  const events = (stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_at_cost_paid');
  assert.equal(events.length, 1);
  assert.equal(events[0].meta?.amountTotalCents, 2832);
  assert.equal(JSON.stringify(events[0]).includes('Broadway'), false);
  assert.equal(JSON.stringify(events[0]).includes('60640'), false);

  // Offer is consumed: the token can no longer open or quote anything.
  const again = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: paidAt });
  assert.equal(again.ok, false);
  assert.equal(created.length, 1);

  // Done-page view is PII-free and exact.
  assert.deepEqual(printUpgradeCheckoutStatusView(stored, 'cs_test_upgrade_1'), { status: 'paid', targetFormat: 'premium', amountTotalCents: 2832 });
  assert.deepEqual(printUpgradeCheckoutStatusView(stored, 'cs_someone_elses'), { status: 'unknown' });
}));

test('settle: a duplicate webhook for the paid Session is a no-op replay', withLocalStore(async () => {
  const { token, premium } = await quotedOffer();
  await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe([]), baseUrl: BASE_URL, now: NOW });
  const session = paidSession({ metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: premium.quoteId } });
  const first = await settlePrintUpgradeAtCostSession(session, { now: '2026-10-14T12:20:00.000Z' });
  const second = await settlePrintUpgradeAtCostSession(session, { now: '2026-10-14T12:25:00.000Z' });
  assert.equal(first.outcome, 'paid');
  assert.equal(second.outcome, 'replay');
  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradePaidAt, '2026-10-14T12:20:00.000Z');
  assert.equal((stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_at_cost_paid').length, 1);
}));

test('settle: amount, session, format, quote, currency, mode or reference drift is recorded as a conflict and never applied', withLocalStore(async () => {
  const { token, premium, classic } = await quotedOffer();
  await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe([]), baseUrl: BASE_URL, now: NOW });
  const good = paidSession({ metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: premium.quoteId } });
  const drifts: Array<[string, Partial<PrintUpgradeCheckoutSessionLike>]> = [
    ['amount_total low', { amount_total: 2831 }],
    ['amount_subtotal high', { amount_subtotal: 2833 }],
    ['discounted total', { amount_total: 2000 }],
    ['different session', { id: 'cs_test_upgrade_other' }],
    ['format drift', { metadata: { ...good.metadata!, targetFormat: 'classic' } }],
    ['quote drift', { metadata: { ...good.metadata!, quoteId: classic.quoteId } }],
    ['currency', { currency: 'eur' }],
    ['mode', { mode: 'subscription' }],
    ['unpaid', { payment_status: 'unpaid' }],
    ['reference', { client_reference_id: 'ord_other' }],
  ];
  let conflicts = 0;
  for (const [label, drift] of drifts) {
    const result = await settlePrintUpgradeAtCostSession({ ...good, ...drift }, { now: '2026-10-14T12:20:00.000Z' });
    assert.equal(result.outcome, 'conflict_recorded', label);
    conflicts += 1;
    const stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.bookFormat, 'digital', label);
    assert.equal(stored.printUpgradeStatus, 'checkout_open', label);
    assert.equal(stored.printUpgradeOffer?.consumedAt ?? null, null, label);
  }
  const stored = (await getOrder(ORDER_ID))!;
  const recorded = (stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_settlement_conflict');
  // One conflict per distinct incoming session id (idempotent by session).
  assert.equal(recorded.length, 2);
  assert.ok(conflicts > recorded.length);

  // Metadata that does not name an order or quote at all is rejected before any lookup.
  assert.equal((await settlePrintUpgradeAtCostSession({ ...good, metadata: { kind: PRINT_UPGRADE_STRIPE_KIND } }, { now: NOW })).outcome, 'invalid_metadata');
  assert.equal((await settlePrintUpgradeAtCostSession({ ...good, metadata: { ...good.metadata!, orderId: 'ord_nope' } }, { now: NOW })).outcome, 'order_not_found');
}));

test('settle: a paid Session for an order with no open lock is a conflict, not a payment', withLocalStore(async () => {
  const { premium } = await quotedOffer();
  const result = await settlePrintUpgradeAtCostSession(
    paidSession({ metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: premium.quoteId } }),
    { now: NOW },
  );
  assert.equal(result.outcome, 'conflict_recorded');
  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.bookFormat, 'digital');
  assert.equal(stored.printUpgradeStatus, 'offered');
}));

test('expired: an unpaid Session expiring reopens the offer and a fresh quote can open a new Session', withLocalStore(async () => {
  const { token, premium } = await quotedOffer();
  const created: { params: PrintUpgradeCheckoutSessionCreate; idempotencyKey: string }[] = [];
  const opened = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: NOW });
  assert.ok(opened.ok);
  const expired = await recordPrintUpgradeCheckoutExpired({ id: 'cs_test_upgrade_1', metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID } }, { now: '2026-10-14T13:05:00.000Z' });
  assert.equal(expired.outcome, 'expired');
  let stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradeStatus, 'offered');
  assert.equal(stored.printUpgradeLock?.status, 'expired');
  assert.equal(stored.printUpgradeStripeSessionId ?? null, null);
  // A late replay of the expiry is ignored, and an unknown session is ignored.
  assert.equal((await recordPrintUpgradeCheckoutExpired({ id: 'cs_test_upgrade_1', metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID } }, { now: NOW })).outcome, 'ignored');
  assert.equal((await recordPrintUpgradeCheckoutExpired({ id: 'cs_unknown', metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID } }, { now: NOW })).outcome, 'ignored');

  // The expired Session can never settle.
  const late = await settlePrintUpgradeAtCostSession(paidSession({ metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, targetFormat: 'premium', quoteId: premium.quoteId } }), { now: '2026-10-14T13:10:00.000Z' });
  assert.equal(late.outcome, 'conflict_recorded');

  // Fresh quote → fresh lock, old session recorded as superseded.
  const requoted = await quotePrintUpgradeAtCost(ORDER_ID, { token, shippingAddress: ADDRESS }, { provider, now: '2026-10-14T13:10:00.000Z' });
  assert.ok(requoted.ok);
  const next = requoted.quotes.find((q) => q.targetFormat === 'classic')!;
  const reopened = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: next.quoteId }, { createCheckoutSession: fakeStripe(created), baseUrl: BASE_URL, now: '2026-10-14T13:11:00.000Z' });
  assert.ok(reopened.ok);
  assert.notEqual(reopened.stripeSessionId, 'cs_test_upgrade_1');
  stored = (await getOrder(ORDER_ID))!;
  assert.deepEqual(stored.printUpgradeLock?.supersededStripeSessionIds, ['cs_test_upgrade_1']);
  assert.equal(stored.printUpgradeLock?.targetFormat, 'classic');
}));

test('source guard: the at-cost checkout never uses the retail delta, never submits print, never kicks off fulfillment', () => {
  const src = readFileSync('src/lib/print-upgrade-checkout.ts', 'utf8');
  assert.doesNotMatch(src, /calculatePrintUpgrade|recordPrintUpgradePayment|updatePrintUpgradePayment|getBookFormatMeta\([^)]*\)\.priceCents|PUBLIC_PRICING_PLANS/);
  assert.doesNotMatch(src, /submitPrintJob|scheduleFulfillmentKickoff|triggerFulfillment|approvePrintProof|runPrintProduction|sendDigitalDeliveryEmail|sendOrderConfirmationEmail/);
  for (const file of ['src/lib/print-upgrade-offer.ts', 'src/lib/print-upgrade-quote.ts']) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /calculatePrintUpgrade|submitPrintJob|scheduleFulfillmentKickoff|triggerFulfillment/);
  }
});

test('extra copies reuse the approved book, bind quantity/destination, and preserve prior purchase on webhook replay', withLocalStore(async () => {
  const { token, premium, offer } = await quotedOffer();
  const first = await openPrintUpgradeCheckout(ORDER_ID, { token, quoteId: premium.quoteId }, {
    createCheckoutSession: async () => ({ id: 'cs_test_upgrade_first', url: 'https://checkout.stripe.test/first' }),
    baseUrl: BASE_URL, now: NOW,
  });
  assert.ok(first.ok);
  const firstPaid = await settlePrintUpgradeAtCostSession({
    id: 'cs_test_upgrade_first', mode: 'payment', payment_status: 'paid',
    amount_subtotal: premium.totalCents, amount_total: premium.totalCents, currency: 'usd',
    client_reference_id: ORDER_ID,
    metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, offerId: offer.offerId, quoteId: premium.quoteId, targetFormat: 'premium', purchaseKind: 'upgrade', quantity: '1', approvedSourceSha256: APPROVED_SHA },
  }, { now: '2026-10-14T12:05:00.000Z' });
  assert.equal(firstPaid.outcome, 'paid');
  const afterFirst = (await getOrder(ORDER_ID))!;
  assert.equal(afterFirst.bookFormat, 'premium');
  assert.equal(afterFirst.printCopyPurchases?.length, 1);

  const extra = await prepareCustomerPrintUpgradeOffer(ORDER_ID, {
    purchaseKind: 'extra_copy', approvedSourceSha256: APPROVED_SHA,
    approvedSourcePageCount: 25, now: '2026-10-14T12:10:00.000Z',
  });
  assert.ok(extra.ok);
  const quantityProvider: PrintCostQuoteProvider = {
    async quote(request) {
      assert.equal(request.quantity, 3);
      return { provider: 'lulu', podPackageId: `${request.targetFormat}.PKG`, shippingLevel: 'MAIL', currency: 'usd', printCents: 3000, shippingCents: 500, fulfillmentCents: 100, taxCents: 400, totalCents: 4000, estimatedDeliveryStart: '2026-10-25', estimatedDeliveryEnd: '2026-11-03' };
    },
  };
  const quoted = await quotePrintUpgradeAtCost(ORDER_ID, { token: extra.token, shippingAddress: ADDRESS, quantity: 3 }, { provider: quantityProvider, now: '2026-10-14T12:11:00.000Z' });
  assert.ok(quoted.ok);
  const quote = quoted.quotes.find((q) => q.targetFormat === 'classic')!;
  assert.equal(quote.quantity, 3);
  const extraOpen = await openPrintUpgradeCheckout(ORDER_ID, { token: extra.token, quoteId: quote.quoteId }, {
    createCheckoutSession: async () => ({ id: 'cs_test_upgrade_extra', url: 'https://checkout.stripe.test/extra' }),
    baseUrl: BASE_URL, now: '2026-10-14T12:12:00.000Z',
  });
  assert.ok(extraOpen.ok);
  const extraPaid = await settlePrintUpgradeAtCostSession({
    id: 'cs_test_upgrade_extra', mode: 'payment', payment_status: 'paid',
    amount_subtotal: 4000, amount_total: 4000, currency: 'usd', client_reference_id: ORDER_ID,
    metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, offerId: extra.offer.offerId, quoteId: quote.quoteId, targetFormat: 'classic', purchaseKind: 'extra_copy', quantity: '3', approvedSourceSha256: APPROVED_SHA },
  }, { now: '2026-10-14T12:13:00.000Z' });
  assert.equal(extraPaid.outcome, 'paid');
  const final = (await getOrder(ORDER_ID))!;
  assert.equal(final.bookFormat, 'premium', 'extra copies do not mutate the original format');
  assert.equal(final.printCopyPurchases?.length, 2);
  assert.deepEqual(final.printCopyPurchases?.map((p) => [p.kind, p.targetFormat, p.quantity]), [['upgrade', 'premium', 1], ['extra_copy', 'classic', 3]]);
  assert.equal(final.printCopyPurchases?.[1].shippingAddress.zip, ADDRESS.zip);
  assert.equal(final.printCopyPurchases?.[1].printJobId, null);
  assert.equal(final.printCopyPurchases?.[1].printStatus, 'awaiting_files');
  const replay = await settlePrintUpgradeAtCostSession({
    id: 'cs_test_upgrade_first', mode: 'payment', payment_status: 'paid', amount_subtotal: premium.totalCents, amount_total: premium.totalCents, currency: 'usd', client_reference_id: ORDER_ID,
    metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, offerId: offer.offerId, quoteId: premium.quoteId, targetFormat: 'premium' },
  });
  assert.equal(replay.outcome, 'replay');
  assert.equal((await getOrder(ORDER_ID))!.printCopyPurchases?.length, 2);
}));

test('a changed native proof revision invalidates an open offer before quoting', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder({ proofVersion: 'v1', proofReviewedVersion: 'v1', proofApprovedAt: NOW }));
  const prepared = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW });
  assert.ok(prepared.ok);
  const order = (await getOrder(ORDER_ID))!;
  await persistOrder({ ...order, proofVersion: 'v2', proofReviewedVersion: null, proofApprovedAt: null });
  const quoted = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: NOW });
  assert.deepEqual(quoted, { ok: false, reason: 'offer_revoked' });
}));

test('no verified delivery window means no payable Checkout Session', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder());
  const prepared = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW });
  assert.ok(prepared.ok);
  const unverifiedProvider: PrintCostQuoteProvider = {
    async quote(request) {
      return { provider: 'lulu', podPackageId: `${request.targetFormat}.PKG`, shippingLevel: 'MAIL', currency: 'usd', printCents: 1000, shippingCents: 300, fulfillmentCents: 100, taxCents: 100, totalCents: 1500 };
    },
  };
  const quoted = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider: unverifiedProvider, now: NOW });
  assert.ok(quoted.ok);
  let calls = 0;
  const result = await openPrintUpgradeCheckout(ORDER_ID, { token: prepared.token, quoteId: quoted.quotes[0].quoteId }, {
    createCheckoutSession: async () => { calls++; throw new Error('must not run'); }, baseUrl: BASE_URL, now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: 'delivery_unavailable' });
  assert.equal(calls, 0);
}));

test('print-go helper requires the exact approved source and unchanged native proof approval', () => {
  const order = makePaidDigitalOrder({ proofVersion: 'v5', proofReviewedVersion: 'v5', proofApprovedAt: NOW });
  const purchase = {
    version: 1 as const, kind: 'extra_copy' as const, offerId: 'puo_test', quoteId: 'puq_test', approvedSourceSha256: APPROVED_SHA,
    approvedProofVersion: 'v5', approvedProofAt: NOW, targetFormat: 'classic' as const, quantity: 3, totalCents: 4000,
    currency: 'usd' as const, stripeSessionId: 'cs_test_print_go', stripePaymentIntentId: null, shippingAddress: ADDRESS,
    estimatedDeliveryStart: '2026-10-20', estimatedDeliveryEnd: '2026-10-30', paidAt: NOW,
    printJobId: null, printStatus: 'awaiting_files' as const,
  };
  assert.equal(printPurchaseApprovalIsCurrent(order, purchase, APPROVED_SHA), true);
  assert.equal(printPurchaseApprovalIsCurrent(order, purchase, '0'.repeat(64)), false);
  assert.equal(printPurchaseApprovalIsCurrent({ ...order, proofVersion: 'v6' }, purchase, APPROVED_SHA), false);
  assert.equal(printPurchaseApprovalIsCurrent({ ...order, proofApprovedAt: null }, purchase, APPROVED_SHA), false);
});
