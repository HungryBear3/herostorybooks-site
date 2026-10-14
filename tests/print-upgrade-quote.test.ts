/**
 * Customer digital-to-print upgrade: provider-cost QUOTES.
 *
 * The customer pays exactly what the print provider charges us for print,
 * shipping/handling, fulfillment and tax — nothing else. Quotes are exact
 * integer cents parsed from the provider's decimal strings, bound to the
 * offer that requested them, expire, and are never minted when the provider
 * is unavailable (so no payable checkout can exist without a real quote).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOrderRecord, getOrder, persistOrder, type OrderRecord, type PrintUpgradeLockV1 } from '../src/lib/orders.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import {
  PRINT_UPGRADE_QUOTE_TTL_MS,
  PRINT_UPGRADE_QUOTES_RETAINED,
  luluCostCalculationToQuote,
  normalizePrintUpgradeShippingAddress,
  parseLuluMoneyToCents,
  quotePrintUpgradeAtCost,
  type PrintCostQuoteProvider,
  type PrintCostQuoteRequest,
} from '../src/lib/print-upgrade-quote.ts';

const APPROVED_SHA = '97312217e67bdc8845f5c03cd0d06533a1fe9a84bd030ce8fb25460e79f2ba38';
const NOW = '2026-10-14T12:00:00.000Z';
const ORDER_ID = 'ord_quote_test_0001';

const ADDRESS = {
  name: 'Alexy Kaplun',
  line1: '1234 N Broadway',
  line2: 'Apt 2',
  city: 'Chicago',
  state: 'IL',
  zip: '60640',
  country: 'US',
};

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
    ...overrides,
  };
}

function withLocalStore(run: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-upgrade-quote-'));
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

async function preparedOffer() {
  await persistOrder(makePaidDigitalOrder());
  const prepared = await prepareCustomerPrintUpgradeOffer(ORDER_ID, {
    approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW,
  });
  assert.ok(prepared.ok);
  return prepared;
}

function fakeProvider(
  table: Partial<Record<'classic' | 'premium', { printCents: number; shippingCents: number; fulfillmentCents: number; taxCents: number }>>,
  calls: PrintCostQuoteRequest[] = [],
): PrintCostQuoteProvider {
  return {
    async quote(request) {
      calls.push(request);
      const row = table[request.targetFormat];
      if (!row) throw new Error('provider unavailable');
      return {
        provider: 'lulu',
        podPackageId: request.targetFormat === 'premium' ? 'HC.TEST' : 'SC.TEST',
        shippingLevel: 'MAIL',
        currency: 'usd',
        ...row,
        totalCents: row.printCents + row.shippingCents + row.fulfillmentCents + row.taxCents,
      };
    },
  };
}

function luluResponse(overrides: Record<string, unknown> = {}) {
  return {
    currency: 'USD',
    line_item_costs: [{
      quantity: 1,
      cost_excl_discounts: '9.73',
      total_cost_excl_discounts: '9.73',
      total_cost_excl_tax: '9.73',
      total_tax: '1.00',
      total_cost_incl_tax: '10.73',
      tax_rate: '0.1025',
      discounts: [],
    }],
    shipping_cost: { total_cost_excl_tax: '4.49', total_tax: '0.46', total_cost_incl_tax: '4.95', tax_rate: '0.1025' },
    fulfillment_cost: { total_cost_excl_tax: '1.50', total_cost_incl_tax: '1.65' },
    total_tax: '1.61',
    total_cost_excl_tax: '15.72',
    total_cost_incl_tax: '17.33',
    ...overrides,
  };
}

test('parseLuluMoneyToCents: exact decimal strings only', () => {
  assert.equal(parseLuluMoneyToCents('12.34'), 1234);
  assert.equal(parseLuluMoneyToCents('7'), 700);
  assert.equal(parseLuluMoneyToCents('0.5'), 50);
  assert.equal(parseLuluMoneyToCents('0.00'), 0);
  assert.equal(parseLuluMoneyToCents(' 3.10 '), 310);
  for (const bad of ['', 'abc', '-1', '1.234', '1e3', '1,00', '.5', '5.', null, undefined, 12.34]) {
    assert.throws(() => parseLuluMoneyToCents(bad as string), /money/i, `expected rejection for ${String(bad)}`);
  }
});

test('luluCostCalculationToQuote: sums print, shipping, fulfillment and tax exactly and cross-checks the provider total', () => {
  const quote = luluCostCalculationToQuote(luluResponse(), { podPackageId: 'HC.TEST', shippingLevel: 'MAIL' });
  assert.deepEqual(quote, {
    provider: 'lulu',
    podPackageId: 'HC.TEST',
    shippingLevel: 'MAIL',
    currency: 'usd',
    printCents: 973,
    shippingCents: 449,
    fulfillmentCents: 150,
    taxCents: 161,
    totalCents: 1733,
  });
  // Without a fulfillment block the fee is zero, never guessed.
  const noFulfillment = luluCostCalculationToQuote(
    luluResponse({ fulfillment_cost: undefined, total_tax: '1.46', total_cost_excl_tax: '14.22', total_cost_incl_tax: '15.68' }),
    { podPackageId: 'HC.TEST', shippingLevel: 'MAIL' },
  );
  assert.equal(noFulfillment.fulfillmentCents, 0);
  assert.equal(noFulfillment.totalCents, 1568);

  assert.throws(() => luluCostCalculationToQuote(luluResponse({ total_cost_incl_tax: '17.34' }), { podPackageId: 'x', shippingLevel: 'MAIL' }), /total/);
  assert.throws(() => luluCostCalculationToQuote(luluResponse({ currency: 'EUR' }), { podPackageId: 'x', shippingLevel: 'MAIL' }), /currency/);
  assert.throws(() => luluCostCalculationToQuote(luluResponse({ line_item_costs: [] }), { podPackageId: 'x', shippingLevel: 'MAIL' }), /line item/);
  const two = luluResponse();
  (two.line_item_costs as unknown[]).push(two.line_item_costs[0]);
  assert.throws(() => luluCostCalculationToQuote(two, { podPackageId: 'x', shippingLevel: 'MAIL' }), /line item/);
  assert.throws(() => luluCostCalculationToQuote(luluResponse({ line_item_costs: [{ ...luluResponse().line_item_costs[0], quantity: 2 }] }), { podPackageId: 'x', shippingLevel: 'MAIL' }), /quantity/);
  assert.throws(() => luluCostCalculationToQuote(luluResponse({ shipping_cost: undefined }), { podPackageId: 'x', shippingLevel: 'MAIL' }), /shipping/);
});

test('normalizePrintUpgradeShippingAddress: bounded US addresses only', () => {
  const ok = normalizePrintUpgradeShippingAddress({ ...ADDRESS, state: 'il', zip: ' 60640 ' });
  assert.deepEqual(ok, { ok: true, address: { ...ADDRESS, state: 'IL', zip: '60640' } });
  const okZip4 = normalizePrintUpgradeShippingAddress({ ...ADDRESS, zip: '60640-1234', line2: '' });
  assert.equal(okZip4.ok === true && okZip4.address.zip, '60640-1234');
  assert.equal(okZip4.ok === true && okZip4.address.line2, null);
  for (const bad of [
    null,
    'string',
    { ...ADDRESS, country: 'CA' },
    { ...ADDRESS, name: '' },
    { ...ADDRESS, line1: '' },
    { ...ADDRESS, city: '' },
    { ...ADDRESS, state: 'Illinois' },
    { ...ADDRESS, zip: '6064' },
    { ...ADDRESS, zip: 'ABCDE' },
    { ...ADDRESS, line1: 'x'.repeat(31) },
    { ...ADDRESS, city: 'x'.repeat(31) },
    { ...ADDRESS, name: 'x'.repeat(36) },
  ]) {
    const result = normalizePrintUpgradeShippingAddress(bad);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('quote: prices both formats from the provider, persists quotes bound to the offer, and audits without PII', withLocalStore(async () => {
  const prepared = await preparedOffer();
  const calls: PrintCostQuoteRequest[] = [];
  const provider = fakeProvider({
    classic: { printCents: 812, shippingCents: 449, fulfillmentCents: 150, taxCents: 140 },
    premium: { printCents: 1973, shippingCents: 449, fulfillmentCents: 150, taxCents: 260 },
  }, calls);

  const result = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.quotes.length, 2);
  const classic = result.quotes.find((q) => q.targetFormat === 'classic')!;
  const premium = result.quotes.find((q) => q.targetFormat === 'premium')!;
  assert.match(classic.quoteId, /^puq_[a-f0-9]{16}$/);
  assert.equal(classic.offerId, prepared.offer.offerId);
  assert.equal(classic.totalCents, 812 + 449 + 150 + 140);
  assert.equal(premium.totalCents, 1973 + 449 + 150 + 260);
  assert.equal(classic.pageCount, 32);
  assert.equal(premium.pageCount, 26);
  assert.equal(classic.issuedAt, NOW);
  assert.equal(Date.parse(classic.expiresAt) - Date.parse(NOW), PRINT_UPGRADE_QUOTE_TTL_MS);
  assert.deepEqual(classic.shippingAddress, ADDRESS);
  assert.deepEqual(calls.map((c) => [c.targetFormat, c.pageCount]).sort(), [['classic', 32], ['premium', 26]]);
  assert.deepEqual(calls[0].shippingAddress, ADDRESS);

  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradeQuotes?.length, 2);
  assert.equal(stored.printUpgradeStatus, 'offered');
  assert.equal(stored.bookFormat, 'digital');
  assert.equal(stored.printUpgradeLock ?? null, null);
  const events = (stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_quote_issued');
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('Broadway'), false);
  assert.equal(serialized.includes('60640'), false);
  assert.equal(serialized.includes('Kaplun'), false);
}));

test('quote: a wrong, expired or missing token never reaches the provider and never persists', withLocalStore(async () => {
  const prepared = await preparedOffer();
  const calls: PrintCostQuoteRequest[] = [];
  const provider = fakeProvider({ classic: { printCents: 1, shippingCents: 1, fulfillmentCents: 0, taxCents: 0 }, premium: { printCents: 1, shippingCents: 1, fulfillmentCents: 0, taxCents: 0 } }, calls);

  const wrong = await quotePrintUpgradeAtCost(ORDER_ID, { token: 'nope', shippingAddress: ADDRESS }, { provider, now: NOW });
  assert.deepEqual(wrong, { ok: false, reason: 'token_invalid' });
  const expired = await quotePrintUpgradeAtCost(
    ORDER_ID,
    { token: prepared.token, shippingAddress: ADDRESS },
    { provider, now: new Date(Date.parse(prepared.offer.expiresAt) + 1).toISOString() },
  );
  assert.deepEqual(expired, { ok: false, reason: 'offer_expired' });
  const missing = await quotePrintUpgradeAtCost('ord_nope', { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: NOW });
  assert.deepEqual(missing, { ok: false, reason: 'order_not_found' });
  const badAddress = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: { ...ADDRESS, country: 'FR' } }, { provider, now: NOW });
  assert.deepEqual(badAddress, { ok: false, reason: 'address_invalid' });

  assert.equal(calls.length, 0);
  assert.equal((await getOrder(ORDER_ID))!.printUpgradeQuotes ?? null, null);
}));

test('quote: refused while a checkout lock may still be payable, allowed once its Session TTL has passed — the provider is never called while blocked', withLocalStore(async () => {
  const prepared = await preparedOffer();
  const calls: PrintCostQuoteRequest[] = [];
  const provider = fakeProvider({ classic: { printCents: 812, shippingCents: 449, fulfillmentCents: 150, taxCents: 140 }, premium: { printCents: 1973, shippingCents: 449, fulfillmentCents: 150, taxCents: 260 } }, calls);
  const lockAt = (status: 'open' | 'provisioning'): PrintUpgradeLockV1 => ({
    version: 1, quoteId: 'puq_lock_test', purchaseKind: 'upgrade', quantity: 1, approvedSourceSha256: APPROVED_SHA, offerId: prepared.offer.offerId,
    targetFormat: 'premium', totalCents: 2832, currency: 'usd', status,
    stripeSessionId: status === 'open' ? 'cs_test_prior' : null, checkoutUrl: status === 'open' ? 'https://checkout.stripe.test/prior' : null,
    idempotencyKey: `print-upgrade-at-cost:${ORDER_ID}:puq_lock_test`, recipientName: 'A', openedAt: NOW,
    expiresAt: new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString(), paidAt: null, stripePaymentIntentId: null, supersededStripeSessionIds: [],
  });
  for (const status of ['open', 'provisioning'] as const) {
    const base = (await getOrder(ORDER_ID))!;
    await persistOrder({ ...base, printUpgradeQuotes: null, printUpgradeLock: lockAt(status) });
    const live = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: new Date(Date.parse(NOW) + 59 * 60 * 1000).toISOString() });
    assert.deepEqual(live, { ok: false, reason: 'quote_unavailable' }, status);
    assert.equal(calls.length, 0, status);
    assert.equal((await getOrder(ORDER_ID))!.printUpgradeQuotes ?? null, null, status);
    const after = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString() });
    assert.equal(after.ok, true, status);
    assert.equal(calls.length, 2, status);
    assert.equal((await getOrder(ORDER_ID))!.printUpgradeQuotes?.length, 2, status);
    calls.length = 0;
  }
}));

test('quote: provider failure for either format blocks the whole quote and records an unavailable event', withLocalStore(async () => {
  const prepared = await preparedOffer();
  const provider = fakeProvider({ classic: { printCents: 812, shippingCents: 449, fulfillmentCents: 150, taxCents: 140 } });
  const result = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'quote_unavailable' });
  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradeQuotes ?? null, null);
  const events = (stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_quote_unavailable');
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes('60640'), false);
}));

test('quote: rejects a provider answer whose arithmetic or currency does not add up', withLocalStore(async () => {
  const prepared = await preparedOffer();
  const broken: PrintCostQuoteProvider = {
    async quote(request) {
      return {
        provider: 'lulu', podPackageId: 'x', shippingLevel: 'MAIL',
        currency: request.targetFormat === 'classic' ? 'usd' : ('eur' as 'usd'),
        printCents: 100, shippingCents: 10, fulfillmentCents: 0, taxCents: 5, totalCents: 115,
      };
    },
  };
  const result = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider: broken, now: NOW });
  assert.deepEqual(result, { ok: false, reason: 'quote_unavailable' });

  const drift: PrintCostQuoteProvider = {
    async quote() {
      return { provider: 'lulu', podPackageId: 'x', shippingLevel: 'MAIL', currency: 'usd', printCents: 100, shippingCents: 10, fulfillmentCents: 0, taxCents: 5, totalCents: 116 };
    },
  };
  const result2 = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider: drift, now: NOW });
  assert.deepEqual(result2, { ok: false, reason: 'quote_unavailable' });
  const zero: PrintCostQuoteProvider = {
    async quote() {
      return { provider: 'lulu', podPackageId: 'x', shippingLevel: 'MAIL', currency: 'usd', printCents: 0, shippingCents: 0, fulfillmentCents: 0, taxCents: 0, totalCents: 0 };
    },
  };
  const result3 = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider: zero, now: NOW });
  assert.deepEqual(result3, { ok: false, reason: 'quote_unavailable' });
}));

test('quote: retained quotes are bounded and older ones fall off', withLocalStore(async () => {
  const prepared = await preparedOffer();
  const provider = fakeProvider({
    classic: { printCents: 812, shippingCents: 449, fulfillmentCents: 150, taxCents: 140 },
    premium: { printCents: 1973, shippingCents: 449, fulfillmentCents: 150, taxCents: 260 },
  });
  const ids: string[] = [];
  for (let i = 0; i < PRINT_UPGRADE_QUOTES_RETAINED; i += 1) {
    const result = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: NOW });
    assert.ok(result.ok);
    if (result.ok === true) ids.push(...result.quotes.map((q) => q.quoteId));
  }
  const stored = (await getOrder(ORDER_ID))!;
  assert.equal(stored.printUpgradeQuotes?.length, PRINT_UPGRADE_QUOTES_RETAINED);
  const kept = new Set(stored.printUpgradeQuotes!.map((q) => q.quoteId));
  assert.deepEqual([...kept], ids.slice(-PRINT_UPGRADE_QUOTES_RETAINED));
}));
