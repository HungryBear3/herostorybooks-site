/**
 * Customer digital-to-print upgrade: the one-use, order-bound, expiring
 * chooser offer. Every gate here is fail-closed: an order that is not a paid,
 * unrefunded digital order with verified approved content gets no offer, and a
 * token that is wrong, expired, revoked or already consumed opens nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOrderRecord, getOrder, persistOrder, type OrderRecord, type PrintUpgradeLockV1 } from '../src/lib/orders.ts';
import {
  PRINT_UPGRADE_OFFER_DEFAULT_TTL_MS,
  authorizePrintUpgradeOffer,
  planQuotePageCounts,
  prepareCustomerPrintUpgradeOffer,
  printUpgradeChooserPathFor,
  printUpgradeOfferIneligibility,
  revokeCustomerPrintUpgradeOffer,
} from '../src/lib/print-upgrade-offer.ts';

const APPROVED_SHA = '97312217e67bdc8845f5c03cd0d06533a1fe9a84bd030ce8fb25460e79f2ba38';
const NOW = '2026-10-14T12:00:00.000Z';

function makePaidDigitalOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Lukas', bookFormat: 'digital', email: 'parent@example.com' },
      { id: 'ord_offer_test_0001', now: '2026-09-01T12:00:00Z' },
    ),
    paymentStatus: 'paid',
    paidAt: '2026-09-01T12:05:00Z',
    settledAmountCents: 1900,
    stripeSessionId: 'cs_original_digital',
    fulfillmentMode: 'manual_hold',
    ...overrides,
  };
}

function withLocalStore(run: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-upgrade-offer-'));
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

test('offer eligibility: only a paid, unrefunded, undisposed digital order without print history qualifies', () => {
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder()), null);
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder({ paymentStatus: 'pending' })), 'order_not_paid');
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder({ paymentStatus: 'refunded' })), 'order_not_paid');
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder({ refundedAt: NOW })), 'order_refunded');
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder({ stripeRefundId: 're_1' })), 'order_refunded');
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder({ refundClaimId: 'claim_1' })), 'order_refunded');
  assert.equal(
    printUpgradeOfferIneligibility(makePaidDigitalOrder({ bookFormat: 'classic', formatLabel: 'Classic softcover', priceCents: 3900 })),
    'not_digital_order',
  );
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder({ printUpgradeStatus: 'paid' })), 'print_upgrade_already_paid');
  assert.equal(printUpgradeOfferIneligibility(makePaidDigitalOrder({ printJobId: 'lulu_1' })), 'print_job_exists');
  assert.equal(
    printUpgradeOfferIneligibility(makePaidDigitalOrder({ internalDisposition: 'abandoned_internal_test' })),
    'internal_disposition',
  );
});

test('planQuotePageCounts: rounds the approved page count up to the provider minimum, even-paged', () => {
  assert.deepEqual(planQuotePageCounts(25), { classic: 32, premium: 26 });
  assert.deepEqual(planQuotePageCounts(32), { classic: 32, premium: 32 });
  assert.deepEqual(planQuotePageCounts(33), { classic: 34, premium: 34 });
  assert.throws(() => planQuotePageCounts(0), /page count/);
});

test('chooser path carries the token in the URL fragment, never the query', () => {
  const p = printUpgradeChooserPathFor('ord_offer_test_0001', 'tok');
  assert.equal(p, '/upgrade/ord_offer_test_0001#token=tok');
  assert.doesNotMatch(p, /\?/);
});

test('prepare: stores only the token hash, returns the bearer once, and records an audit event', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder());
  const result = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: APPROVED_SHA,
    approvedSourcePageCount: 25,
    approvedSourceLabel: 'lukas-dino-earth-25-page-private-review-v5.pdf',
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.match(result.token, /^[a-f0-9]{48}$/);
  assert.equal(result.chooserPath, `/upgrade/ord_offer_test_0001#token=${result.token}`);

  const stored = await getOrder('ord_offer_test_0001');
  const offer = stored?.printUpgradeOffer;
  assert.ok(offer);
  assert.equal(offer!.version, 1);
  assert.match(offer!.offerId, /^puo_[a-f0-9]{16}$/);
  assert.notEqual(offer!.tokenHash, result.token);
  assert.equal(JSON.stringify(stored).includes(result.token), false);
  assert.equal(offer!.issuedAt, NOW);
  assert.equal(Date.parse(offer!.expiresAt) - Date.parse(NOW), PRINT_UPGRADE_OFFER_DEFAULT_TTL_MS);
  assert.equal(offer!.approvedSource.sha256, APPROVED_SHA);
  assert.equal(offer!.approvedSource.pageCount, 25);
  assert.deepEqual(offer!.quotePageCounts, { classic: 32, premium: 26 });
  assert.equal(offer!.consumedAt ?? null, null);
  assert.equal(offer!.revokedAt ?? null, null);
  assert.equal(stored?.printUpgradeStatus, 'offered');
  assert.equal(stored?.printUpgradeOfferedAt, NOW);
  assert.equal(stored?.bookFormat, 'digital');
  const events = (stored?.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_offer_prepared');
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events[0]).includes(result.token), false);
}));

test('prepare: refuses ineligible orders and malformed approved-source evidence without writing', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder({ paymentStatus: 'pending' }));
  const unpaid = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW,
  });
  assert.deepEqual(unpaid, { ok: false, reason: 'order_not_paid' });

  await persistOrder(makePaidDigitalOrder());
  const badSha = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: 'not-a-sha', approvedSourcePageCount: 25, now: NOW,
  });
  assert.deepEqual(badSha, { ok: false, reason: 'approved_source_invalid' });
  const badPages = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 0, now: NOW,
  });
  assert.deepEqual(badPages, { ok: false, reason: 'approved_source_invalid' });
  assert.equal((await getOrder('ord_offer_test_0001'))?.printUpgradeOffer ?? null, null);

  const missing = await prepareCustomerPrintUpgradeOffer('ord_does_not_exist', {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW,
  });
  assert.deepEqual(missing, { ok: false, reason: 'order_not_found' });
}));

test('prepare: re-preparing an open offer rotates the token and invalidates the old one', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder());
  const first = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW,
  });
  const second = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW,
  });
  assert.ok(first.ok && second.ok);
  const stored = (await getOrder('ord_offer_test_0001'))!;
  assert.equal(authorizePrintUpgradeOffer(stored, first.token, new Date(NOW)).ok, false);
  assert.equal(authorizePrintUpgradeOffer(stored, second.token, new Date(NOW)).ok, true);
}));

test('prepare: refuses while a checkout lock may still be payable, and proceeds once its Session TTL has passed — for open and provisioning locks alike', withLocalStore(async () => {
  const lockAt = (status: 'open' | 'provisioning', openedAt: string): PrintUpgradeLockV1 => ({
    version: 1, quoteId: 'puq_lock_test', purchaseKind: 'upgrade', quantity: 1, approvedSourceSha256: APPROVED_SHA, offerId: 'puo_prior',
    targetFormat: 'premium', totalCents: 2832, currency: 'usd', status,
    stripeSessionId: status === 'open' ? 'cs_test_prior' : null, checkoutUrl: status === 'open' ? 'https://checkout.stripe.test/prior' : null,
    idempotencyKey: 'print-upgrade-at-cost:ord_offer_test_0001:puq_lock_test', recipientName: 'A', openedAt,
    expiresAt: new Date(Date.parse(openedAt) + 60 * 60 * 1000).toISOString(), paidAt: null, stripePaymentIntentId: null, supersededStripeSessionIds: [],
  });
  const input = { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25 };
  for (const status of ['open', 'provisioning'] as const) {
    await persistOrder(makePaidDigitalOrder({ printUpgradeStatus: 'checkout_open', printUpgradeLock: lockAt(status, NOW) }));
    const live = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', { ...input, now: new Date(Date.parse(NOW) + 59 * 60 * 1000).toISOString() });
    assert.deepEqual(live, { ok: false, reason: 'checkout_already_open' }, status);
    assert.equal((await getOrder('ord_offer_test_0001'))!.printUpgradeLock?.status, status);
    const after = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', { ...input, now: new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString() });
    assert.equal(after.ok, true, status);
    const stored = (await getOrder('ord_offer_test_0001'))!;
    assert.equal(stored.printUpgradeLock ?? null, null, status);
    assert.equal(stored.printUpgradeStatus, 'offered', status);
    assert.equal(stored.printUpgradeStripeSessionId ?? null, null, status);
  }
  // Expired and paid locks never block an (otherwise eligible) offer.
  await persistOrder(makePaidDigitalOrder({ printUpgradeLock: { ...lockAt('open', NOW), status: 'expired' } }));
  assert.equal((await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', { ...input, now: NOW })).ok, true);
}));

test('authorize: fails closed on missing offer, wrong token, expiry, revocation, consumption, and lost eligibility', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder());
  const noOffer = authorizePrintUpgradeOffer((await getOrder('ord_offer_test_0001'))!, 'anything', new Date(NOW));
  assert.deepEqual(noOffer, { ok: false, reason: 'offer_missing' });

  const prepared = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW,
  });
  assert.ok(prepared.ok);
  const order = (await getOrder('ord_offer_test_0001'))!;

  const good = authorizePrintUpgradeOffer(order, prepared.token, new Date(NOW));
  assert.equal(good.ok, true);
  assert.equal(good.ok === true && good.offer.offerId, order.printUpgradeOffer!.offerId);

  assert.deepEqual(authorizePrintUpgradeOffer(order, '', new Date(NOW)), { ok: false, reason: 'token_invalid' });
  assert.deepEqual(authorizePrintUpgradeOffer(order, null, new Date(NOW)), { ok: false, reason: 'token_invalid' });
  assert.deepEqual(
    authorizePrintUpgradeOffer(order, prepared.token.slice(0, -1) + (prepared.token.endsWith('0') ? '1' : '0'), new Date(NOW)),
    { ok: false, reason: 'token_invalid' },
  );
  assert.deepEqual(
    authorizePrintUpgradeOffer(order, order.printUpgradeOffer!.tokenHash, new Date(NOW)),
    { ok: false, reason: 'token_invalid' },
  );
  assert.deepEqual(
    authorizePrintUpgradeOffer(order, prepared.token, new Date(Date.parse(NOW) + PRINT_UPGRADE_OFFER_DEFAULT_TTL_MS)),
    { ok: false, reason: 'offer_expired' },
  );
  assert.deepEqual(
    authorizePrintUpgradeOffer({ ...order, printUpgradeOffer: { ...order.printUpgradeOffer!, revokedAt: NOW } }, prepared.token, new Date(NOW)),
    { ok: false, reason: 'offer_revoked' },
  );
  assert.deepEqual(
    authorizePrintUpgradeOffer({ ...order, printUpgradeOffer: { ...order.printUpgradeOffer!, consumedAt: NOW } }, prepared.token, new Date(NOW)),
    { ok: false, reason: 'offer_consumed' },
  );
  assert.deepEqual(
    authorizePrintUpgradeOffer({ ...order, refundedAt: NOW }, prepared.token, new Date(NOW)),
    { ok: false, reason: 'order_refunded' },
  );
  assert.deepEqual(
    authorizePrintUpgradeOffer({ ...order, printUpgradeStatus: 'paid' }, prepared.token, new Date(NOW)),
    { ok: false, reason: 'print_upgrade_already_paid' },
  );
}));

test('revoke: closes the offer durably and later authorization fails', withLocalStore(async () => {
  await persistOrder(makePaidDigitalOrder());
  const prepared = await prepareCustomerPrintUpgradeOffer('ord_offer_test_0001', {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW,
  });
  assert.ok(prepared.ok);
  const revoked = await revokeCustomerPrintUpgradeOffer('ord_offer_test_0001', { reason: 'operator_cancelled', now: NOW });
  assert.equal(revoked?.printUpgradeOffer?.revokedAt, NOW);
  assert.equal(revoked?.printUpgradeStatus, 'cancelled');
  const stored = (await getOrder('ord_offer_test_0001'))!;
  assert.deepEqual(authorizePrintUpgradeOffer(stored, prepared.token, new Date(NOW)), { ok: false, reason: 'offer_revoked' });
  assert.equal((stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_offer_revoked').length, 1);
}));
