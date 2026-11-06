/**
 * A legacy retail-delta upgrade keeps its own signed contact through every later
 * at-cost purchase, across the real webhook, quote, checkout, admin and
 * print-release consumers. Synthetic data and an explicit memory store only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { toAdminOrderDetail } from '../src/lib/admin-order-dto.ts';
import { approvePrintProof, proofSourceFingerprint, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { buildOrderStatusView } from '../src/lib/order-status-view.ts';
import {
  createOrderRecord,
  getOrder,
  persistOrder,
  withOrderTransaction,
  type OrderRecord,
  type PrintCopyPurchaseV1,
  type ShippingAddress,
} from '../src/lib/orders.ts';
import {
  __setPrintContactStoreForTests,
  capturePrintUpgradeContact,
  loadAdminPrintContacts,
  recordSettledPrintContact,
  resolveOrderPrintContact,
} from '../src/lib/print-contact-store.ts';
import { openPrintUpgradeCheckout, type PrintUpgradeCheckoutSessionCreate } from '../src/lib/print-upgrade-checkout.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import { quotePrintUpgradeAtCost, type PrintCostQuoteProvider } from '../src/lib/print-upgrade-quote.ts';
import {
  ANALYTICS_SETTLED,
  completedEvent,
  CONFIRMATION_EMAIL_SETTLED,
  MP_ENDPOINT,
  runWebhook,
  setupWebhookStore,
  type OutboundCall,
} from './helpers/stripe-webhook-harness.ts';
import { padPageSet } from './support/full-page-set.ts';
import { installMemoryPrintContactStore, type MemoryPrintContactStore } from './support/print-contact-fixture.ts';

const NAME = 'Quill Recipient';
const PHONE_RAW = '(312) 555-0142';
const PHONE = '+13125550142';
const GIFT_PHONE = '+13125550199';
const NOW = '2026-10-14T12:00:00.000Z';
const ORIGINAL_SESSION = 'cs_test_originaldigital';
const ORIGINAL_PI = 'pi_original';
const LEGACY_SESSION = 'cs_test_legacyupgrade1';
const LEGACY_PI = 'pi_legacy_upgrade';
const EXTRA_SESSION = 'cs_test_extracopy1';
const EXTRA_PI = 'pi_extra_copy';
const SHIPPING: ShippingAddress = { line1: '10 Synthetic Way', line2: null, city: 'Testville', state: 'IL', zip: '60601', country: 'US' };
const STRIPE_SHIPPING = { name: NAME, address: { line1: SHIPPING.line1, line2: null, city: SHIPPING.city, state: SHIPPING.state, postal_code: SHIPPING.zip, country: SHIPPING.country } };
const GIFT = { name: 'Grandparent Recipient', line1: '20 Other Way', line2: null, city: 'Testville', state: 'IL', zip: '60602', country: 'US' };
const REFUSED = { ok: false, reason: 'print_contact_binding_mismatch' };

const RELEASABLE: Partial<OrderRecord> = {
  status: 'preview_ready',
  fulfillmentStatus: 'proof_ready',
  reviewStatus: 'approved',
  pageArtifacts: padPageSet([]),
  storyArtifactUrl: 'https://example.invalid/proof.pdf',
  proofVersion: 'proof-v1',
  proofReviewedAt: '2026-09-02T12:00:00.000Z',
  proofReviewedVersion: 'proof-v1',
  proofApprovalToken: 'release-token',
  printInteriorArtifactUrl: 'https://example.invalid/interior.pdf',
  printInteriorMd5: 'interiormd5',
  printInteriorPageCount: 32,
  printInteriorProofVersion: 'proof-v1',
  printTitle: 'Fixture Title',
};

const EXTRA_PURCHASE: PrintCopyPurchaseV1 = {
  version: 1, kind: 'extra_copy', offerId: 'puo_x', quoteId: 'puq_0000000000000001', approvedSourceSha256: 'a'.repeat(64), approvedProofVersion: null, approvedProofAt: null,
  targetFormat: 'classic', quantity: 2, totalCents: 1500, currency: 'usd', stripeSessionId: EXTRA_SESSION, stripePaymentIntentId: EXTRA_PI,
  shippingAddress: { line1: GIFT.line1, line2: null, city: GIFT.city, state: GIFT.state, zip: GIFT.zip, country: GIFT.country },
  estimatedDeliveryStart: '2026-10-20', estimatedDeliveryEnd: '2026-10-30', paidAt: NOW, printJobId: null, printStatus: 'awaiting_files',
};

const provider: PrintCostQuoteProvider = {
  async quote() {
    return { provider: 'lulu', podPackageId: 'PKG', shippingLevel: 'MAIL', currency: 'usd', printCents: 1000, shippingCents: 300, fulfillmentCents: 100, taxCents: 100, totalCents: 1500, estimatedDeliveryStart: '2026-10-20', estimatedDeliveryEnd: '2026-10-30' };
  },
};

function env() {
  const restoreEnv = setupWebhookStore({ HSB_PRIVATE_READ_WRITE_TOKEN: '' });
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
  for (const value of [NAME, PHONE, '555-0142', GIFT.name, GIFT_PHONE, '555-0199']) assert.equal(text.includes(value), false, value);
}

const mpCalls = (outbound: OutboundCall[]) => outbound.filter((call) => call.url.startsWith(`${MP_ENDPOINT}?`));
const sessionKeys = (store: MemoryPrintContactStore, session: string) => [...store.objects.keys()].filter((key) => key.endsWith(`/sessions/${session}.json`));

async function seedLegacyCheckout(id: string): Promise<void> {
  await persistOrder({
    ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'digital', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' }),
    paymentStatus: 'paid', settledAmountCents: 1900, stripeSessionId: ORIGINAL_SESSION, stripePaymentIntentId: ORIGINAL_PI, fulfillmentMode: 'manual_hold',
    printUpgradeStatus: 'checkout_open', printUpgradeStripeSessionId: LEGACY_SESSION, printUpgradeTargetFormat: 'classic', printUpgradeAmountCents: 2000,
  });
}

function legacyEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_legacy_${id}`, object: 'event', type: 'checkout.session.completed', created: 1_800_000_000,
    data: { object: {
      id: LEGACY_SESSION, object: 'checkout.session', client_reference_id: id,
      metadata: { kind: 'print_upgrade', orderId: id, targetFormat: 'classic' },
      payment_intent: LEGACY_PI, amount_total: 2000, amount_subtotal: 2000, currency: 'usd', mode: 'payment', payment_status: 'paid',
      shipping_details: STRIPE_SHIPPING, customer_details: { name: 'Card Holder', phone: PHONE_RAW },
      ...overrides,
    } },
  };
}

async function settleLegacy(id: string) {
  const result = await runWebhook(legacyEvent(id), { settledBy: [ANALYTICS_SETTLED] });
  assert.deepEqual(result.statuses, [200], result.lines.join('\n'));
  return result;
}

async function quotedExtraCopy(id: string) {
  const prepared = await prepareCustomerPrintUpgradeOffer(id, { purchaseKind: 'extra_copy', approvedSourceSha256: 'a'.repeat(64), approvedSourcePageCount: 25, now: NOW });
  if (prepared.ok === false) throw new Error(prepared.reason);
  const quoted = await quotePrintUpgradeAtCost(id, { token: prepared.token, shippingAddress: GIFT, quantity: 2 }, { provider, now: NOW });
  if (quoted.ok === false) throw new Error(quoted.reason);
  return { token: prepared.token, quoteId: quoted.quotes.find((quote) => quote.targetFormat === 'classic')!.quoteId };
}

async function openExtraCopy(id: string, quoted: { token: string; quoteId: string }, sessionId: string) {
  const created: PrintUpgradeCheckoutSessionCreate[] = [];
  const opened = await openPrintUpgradeCheckout(id, { token: quoted.token, quoteId: quoted.quoteId }, {
    createCheckoutSession: async (params) => {
      created.push(params);
      return { id: sessionId, url: `https://checkout.stripe.test/${sessionId}` };
    },
    baseUrl: 'https://hsb.test',
    now: NOW,
  });
  assert.equal(opened.ok, true);
  return created[0];
}

function extraCopyEvent(id: string, params: PrintUpgradeCheckoutSessionCreate) {
  return {
    id: `evt_extra_${id}`, object: 'event', type: 'checkout.session.completed', created: 1_800_000_000,
    data: { object: {
      id: EXTRA_SESSION, object: 'checkout.session', client_reference_id: id, metadata: params.metadata,
      payment_intent: EXTRA_PI, amount_total: 1500, amount_subtotal: 1500, currency: 'usd', mode: 'payment', payment_status: 'paid',
      customer_details: { name: 'Card Holder', phone: '(312) 555-0199' },
    } },
  };
}

async function settleExtraCopy(id: string) {
  const quoted = await quotedExtraCopy(id);
  const params = await openExtraCopy(id, quoted, EXTRA_SESSION);
  const event = extraCopyEvent(id, params);
  assert.deepEqual((await runWebhook(event, { settledBy: [ANALYTICS_SETTLED] })).statuses, [200]);
  return event;
}

async function legacyThenExtraCopy(id: string) {
  await seedLegacyCheckout(id);
  await settleLegacy(id);
  const event = await settleExtraCopy(id);
  return { event, stored: (await getOrder(id))! };
}

async function assertLegacyContact(order: OrderRecord) {
  assert.deepEqual(await resolveOrderPrintContact(order), {
    ok: true,
    contact: {
      orderId: order.id, purchaseKind: 'print_upgrade', stripeSessionId: LEGACY_SESSION, stripePaymentIntentId: LEGACY_PI,
      quoteId: null, shippingAddress: SHIPPING, recipientName: NAME, phone: PHONE,
    },
  });
}

const releaseDeps = (submitted: Array<{ recipientName: string; stripeSessionId: string }>): FulfillmentDeps => ({
  calculateCoverDimensions: async () => ({ widthPt: 1200, heightPt: 650 }),
  buildPrintCoverPdf: () => Buffer.from('%PDF cover'),
  uploadArtifact: async (id, _buffer, filename) => `https://example.invalid/${id}/${filename}`,
  submitPrint: async (_order, contact) => { submitted.push(contact); return { jobId: 'job-legacy' }; },
});

test('STRUCTURAL: the signed legacy settlement commits one exact non-PII receipt', async () => {
  const { restore } = env();
  try {
    const id = 'ord_legacy_receipt';
    await seedLegacyCheckout(id);
    await settleLegacy(id);
    const stored = (await getOrder(id))!;
    assert.deepEqual(stored.legacyPrintUpgradeSettlement, { version: 1, stripeSessionId: LEGACY_SESSION, stripePaymentIntentId: LEGACY_PI, paidAt: stored.printUpgradePaidAt });
    const paid = (stored.auditEvents ?? []).filter((event) => event.type === 'print_upgrade_paid');
    assert.equal(paid.length, 1);
    assert.equal(paid[0].at, stored.printUpgradePaidAt);
    const receipt = JSON.stringify(stored.legacyPrintUpgradeSettlement);
    assertContactFree(receipt);
    assert.equal(receipt.includes(SHIPPING.line1), false, 'the receipt carries no address');
  } finally {
    restore();
  }
});

test('frozen counterexample: every extra-copy stage keeps the original legacy contact and neither contact crosses over', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_legacy_chain';
    await seedLegacyCheckout(id);
    const first = await settleLegacy(id);
    assert.equal(mpCalls(first.outbound).length, 1);
    await assertLegacyContact((await getOrder(id))!);
    const [legacyPath] = sessionKeys(store, LEGACY_SESSION);
    const legacyBody = store.objects.get(legacyPath);

    const quoted = await quotedExtraCopy(id);
    await assertLegacyContact((await getOrder(id))!);

    const abandoned = await openExtraCopy(id, quoted, 'cs_test_extraabandoned');
    assert.equal((await getOrder(id))!.printUpgradeStatus, 'checkout_open');
    await assertLegacyContact((await getOrder(id))!);

    const expired = await runWebhook({
      id: 'evt_legacy_extra_expired', object: 'event', type: 'checkout.session.expired', created: 1_800_000_000,
      data: { object: { id: 'cs_test_extraabandoned', object: 'checkout.session', metadata: abandoned.metadata } },
    });
    assert.deepEqual(expired.statuses, [200]);
    assert.equal((await getOrder(id))!.printUpgradeStripeSessionId, null);
    await assertLegacyContact((await getOrder(id))!);

    const params = await openExtraCopy(id, quoted, EXTRA_SESSION);
    const event = extraCopyEvent(id, params);
    const settled = await runWebhook(event, { settledBy: [ANALYTICS_SETTLED] });
    assert.deepEqual(settled.statuses, [200]);

    const stored = (await getOrder(id))!;
    assert.equal(stored.printUpgradeStripeSessionId, EXTRA_SESSION, 'the mutable field really moved');
    await assertLegacyContact(stored);
    assert.equal(store.objects.get(legacyPath), legacyBody);
    assert.deepEqual(
      (await loadAdminPrintContacts(stored)).map((row) => [row.purchase, row.status, row.recipientName, row.phone]),
      [['print_upgrade', 'complete', NAME, PHONE], ['extra_copy', 'complete', GIFT.name, GIFT_PHONE]],
    );
    for (const text of [rawOrder(id), settled.lines.join('\n'), JSON.stringify(toAdminOrderDetail(stored)), JSON.stringify(buildOrderStatusView(stored))]) {
      assertContactFree(text);
    }

    const objects = store.objects.size;
    assert.deepEqual((await runWebhook(event)).statuses, [200]);
    const legacyReplay = await runWebhook(legacyEvent(id));
    assert.deepEqual(legacyReplay.statuses, [200]);
    assert.equal(mpCalls(legacyReplay.outbound).length, 0);
    assert.equal(store.objects.size, objects);
    const after = (await getOrder(id))!;
    assert.equal(after.printCopyPurchases?.length, 1);
    assert.equal((after.auditEvents ?? []).filter((entry) => entry.type === 'print_upgrade_settlement_conflict').length, 0);
    assert.equal((after.auditEvents ?? []).filter((entry) => entry.type === 'print_upgrade_paid').length, 1);
  } finally {
    restore();
  }
});

test('print release continues on the legacy contact, even when another offer lands between claim and fence', async () => {
  const { restore } = env();
  try {
    const id = 'ord_legacy_release';
    await legacyThenExtraCopy(id);
    await withOrderTransaction<null>(id, (current) => {
      const next: OrderRecord = { ...current, ...RELEASABLE };
      next.proofSourceFingerprint = proofSourceFingerprint(next);
      return { commit: next, result: null };
    });
    const submitted: Array<{ recipientName: string; stripeSessionId: string }> = [];
    const deps = releaseDeps(submitted);
    const upload = deps.uploadArtifact!;
    const released = await approvePrintProof(id, 'release-token', {
      ...deps,
      uploadArtifact: async (orderId, buffer, filename) => {
        const offered = await prepareCustomerPrintUpgradeOffer(orderId, { purchaseKind: 'extra_copy', approvedSourceSha256: 'a'.repeat(64), approvedSourcePageCount: 25, now: NOW });
        assert.equal(offered.ok, true);
        return upload(orderId, buffer, filename);
      },
    });
    assert.deepEqual(released, { ok: true });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].recipientName, NAME);
    assert.equal(submitted[0].stripeSessionId, LEGACY_SESSION);
    assert.equal((await getOrder(id))!.printJobId, 'job-legacy');
  } finally {
    restore();
  }
});

test('a failed capture converges on redelivery after an extra copy, with no new payment, GA4 or print effect', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_legacy_capture_retry';
    await seedLegacyCheckout(id);
    __setPrintContactStoreForTests({
      kind: 'failing',
      async read() { throw new Error(`private store unavailable ${NAME}`); },
      async createIfAbsent() { throw new Error(`private store unavailable ${NAME}`); },
    });
    const failed = await runWebhook(legacyEvent(id), { settledBy: [ANALYTICS_SETTLED] });
    assert.deepEqual(failed.statuses, [500]);
    assert.equal(mpCalls(failed.outbound).length, 1);
    assertContactFree(failed.lines.join('\n'));
    assert.equal((await getOrder(id))!.printUpgradeStatus, 'paid');

    __setPrintContactStoreForTests(store);
    await settleExtraCopy(id);
    const before = rawOrder(id);
    assert.deepEqual(sessionKeys(store, LEGACY_SESSION), []);

    const wrongPayment = await runWebhook(legacyEvent(id, { payment_intent: 'pi_other' }));
    assert.deepEqual(wrongPayment.statuses, [500]);
    assert.deepEqual(sessionKeys(store, LEGACY_SESSION), []);
    assert.equal(rawOrder(id), before);

    const redelivered = await runWebhook(legacyEvent(id));
    assert.deepEqual(redelivered.statuses, [200]);
    assert.equal(mpCalls(redelivered.outbound).length, 0);
    assert.equal(rawOrder(id), before, 'capture changes nothing public');
    await assertLegacyContact((await getOrder(id))!);

    const objects = store.objects.size;
    assert.deepEqual((await runWebhook(legacyEvent(id))).statuses, [200]);
    assert.equal(store.objects.size, objects);
    const after = (await getOrder(id))!;
    assert.equal((after.auditEvents ?? []).filter((event) => event.type === 'print_upgrade_settlement_conflict').length, 0);
    assert.equal(after.printCopyPurchases?.length, 1);
    assert.equal(after.printJobId ?? null, null);
  } finally {
    restore();
  }
});

test('a replay of the original digital Session can never bind or store a retail contact after an extra copy', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_legacy_retail_replay';
    const { stored } = await legacyThenExtraCopy(id);
    const replay = completedEvent(stored, { orderId: id });
    Object.assign(replay.data.object, { payment_intent: ORIGINAL_PI, shipping_details: STRIPE_SHIPPING, customer_details: { name: 'Card Holder', phone: '(312) 555-0111' } });
    const result = await runWebhook(replay, { settledBy: [CONFIRMATION_EMAIL_SETTLED], settleScheduledKickoff: true });
    assert.deepEqual(result.statuses, [200]);
    assert.deepEqual(sessionKeys(store, ORIGINAL_SESSION), []);
    await assertLegacyContact((await getOrder(id))!);
  } finally {
    restore();
  }
});

test('wrong Session, PaymentIntent, destination, missing authority, ambiguity and tampering all fail closed', async () => {
  const { restore } = env();
  try {
    const id = 'ord_legacy_negative';
    const { stored } = await legacyThenExtraCopy(id);
    const receipt = stored.legacyPrintUpgradeSettlement!;
    const receiptAs = (value: unknown) => ({ ...stored, legacyPrintUpgradeSettlement: value }) as OrderRecord;
    const patched = (patch: Record<string, unknown>) => receiptAs({ ...receipt, ...patch });
    const paid = (stored.auditEvents ?? []).filter((event) => event.type === 'print_upgrade_paid');
    const others = (stored.auditEvents ?? []).filter((event) => event.type !== 'print_upgrade_paid');
    const { legacyPrintUpgradeSettlement: _removed, ...withoutReceipt } = stored;

    const cases: Array<[string, OrderRecord]> = [
      ['another valid Session', patched({ stripeSessionId: 'cs_test_other' })],
      ['original digital Session', patched({ stripeSessionId: ORIGINAL_SESSION })],
      ['extra-copy Session', patched({ stripeSessionId: EXTRA_SESSION })],
      ['another PaymentIntent', patched({ stripePaymentIntentId: 'pi_other' })],
      ['absent PaymentIntent', patched({ stripePaymentIntentId: null })],
      ['original PaymentIntent', patched({ stripePaymentIntentId: ORIGINAL_PI })],
      ['extra-copy PaymentIntent', patched({ stripePaymentIntentId: EXTRA_PI })],
      ['different paid time', patched({ paidAt: '2026-01-01T00:00:00.000Z' })],
      ['non-canonical paid time', patched({ paidAt: 'yesterday' })],
      ['extra key', patched({ contactRef: 'x' })],
      ['wrong version', patched({ version: 2 })],
      ['malformed Session', patched({ stripeSessionId: 'session' })],
      ['malformed PaymentIntent', patched({ stripePaymentIntentId: 'intent' })],
      ['non-object receipt', receiptAs([])],
      ['falsy receipt', receiptAs(0)],
      ['null receipt', receiptAs(null)],
      ['removed receipt', withoutReceipt as OrderRecord],
      ['audit removed', { ...stored, auditEvents: others }],
      ['audit duplicated', { ...stored, auditEvents: [...others, ...paid, ...paid] }],
      ['audit Session rewritten', { ...stored, auditEvents: [...others, { ...paid[0], meta: { ...paid[0].meta, stripeSessionId: 'cs_test_other' } }] }],
      ['wrong destination', { ...stored, shippingAddress: { ...SHIPPING, zip: '60699' } }],
    ];
    for (const [label, order] of cases) {
      assert.deepEqual(await resolveOrderPrintContact(order), REFUSED, label);
      const [row] = await loadAdminPrintContacts(order);
      assert.equal(row.status, 'binding_mismatch', label);
      assert.equal(row.recipientName, null, label);
      assert.equal(row.phone, null, label);
    }
    assert.deepEqual(await resolveOrderPrintContact({ ...stored, id: 'ord_legacy_foreign' }), { ok: false, reason: 'print_contact_missing' });
    await assertLegacyContact(stored);
  } finally {
    restore();
  }
});

test('a private record with the wrong kind, quote, payment, order, Session or destination is refused and never repaired', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_legacy_private_record';
    const { stored } = await legacyThenExtraCopy(id);
    const [pathname] = sessionKeys(store, LEGACY_SESSION);
    const original = store.objects.get(pathname)!;
    const valid = JSON.parse(original) as Record<string, unknown>;
    for (const drift of [
      { purchaseKind: 'order' },
      { purchaseKind: 'extra_copy', quoteId: 'puq_0000000000000001' },
      { quoteId: 'puq_0000000000000001' },
      { stripePaymentIntentId: 'pi_other' },
      { stripePaymentIntentId: null },
      { orderId: 'ord_legacy_foreign' },
      { stripeSessionId: 'cs_test_other' },
      { shippingAddress: { ...SHIPPING, zip: '60699' } },
      { contactHash: 'x' },
    ]) {
      store.objects.set(pathname, JSON.stringify({ ...valid, ...drift }));
      assert.deepEqual(await resolveOrderPrintContact(stored), REFUSED, JSON.stringify(drift));
    }
    store.objects.set(pathname, original);
    await assertLegacyContact(stored);
  } finally {
    restore();
  }
});

test('an extra copy keeps its own bindings and cannot disclose or rebind another purchase', async () => {
  const { store, restore } = env();
  try {
    const id = 'ord_legacy_extra_bound';
    const { stored } = await legacyThenExtraCopy(id);
    const session = { id: EXTRA_SESSION, payment_intent: EXTRA_PI, customer_details: { phone: '(312) 555-0199' } };
    assert.equal(await capturePrintUpgradeContact(id, session), 'replayed');
    await assert.rejects(() => capturePrintUpgradeContact(id, { ...session, payment_intent: 'pi_other' }), /print_contact_storage_unavailable/);
    assert.equal(await capturePrintUpgradeContact(id, { id: LEGACY_SESSION, payment_intent: LEGACY_PI }), 'nothing_collected');

    const purchase = stored.printCopyPurchases![0];
    for (const drift of [{ quoteId: 'puq_0000000000000099' }, { stripePaymentIntentId: 'pi_other' }, { shippingAddress: SHIPPING }]) {
      const rows = await loadAdminPrintContacts({ ...stored, printCopyPurchases: [{ ...purchase, ...drift }] });
      assert.equal(rows[1].status, 'binding_mismatch', JSON.stringify(drift));
      assert.equal(rows[1].recipientName, null);
      assert.equal(rows[0].recipientName, NAME, 'the legacy row is untouched');
    }
    await assert.rejects(() => recordSettledPrintContact({
      orderId: id, purchaseKind: 'extra_copy', stripeSessionId: LEGACY_SESSION, stripePaymentIntentId: LEGACY_PI, quoteId: purchase.quoteId,
      shippingAddress: SHIPPING, recipientName: GIFT.name, phone: GIFT_PHONE,
    }), /print_contact_storage_unavailable/);
    assert.equal(store.objects.size, 4, 'legacy, two intended quotes and the purchase record');
  } finally {
    restore();
  }
});

function historicLegacyOrder(id: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' }),
    paymentStatus: 'paid', settledAmountCents: 1900, stripeSessionId: ORIGINAL_SESSION, stripePaymentIntentId: ORIGINAL_PI, shippingAddress: SHIPPING, fulfillmentMode: 'manual_hold',
    printUpgradeStatus: 'paid', printUpgradeSourceFormat: 'digital', printUpgradeTargetFormat: 'classic', printUpgradeAmountCents: 2000,
    printUpgradeStripeSessionId: LEGACY_SESSION, printUpgradePaymentIntentId: LEGACY_PI, printUpgradePaidAt: NOW,
    auditEvents: [{ at: NOW, type: 'print_upgrade_paid', meta: { stripeSessionId: LEGACY_SESSION } }],
    ...overrides,
  } as OrderRecord;
}

const contactFor = (orderId: string, purchaseKind: 'order' | 'print_upgrade', stripeSessionId: string, stripePaymentIntentId: string, recipientName: string) =>
  recordSettledPrintContact({ orderId, purchaseKind, stripeSessionId, stripePaymentIntentId, quoteId: null, shippingAddress: SHIPPING, recipientName, phone: PHONE });

test('a settled legacy order with no receipt stays held: no backfill, no retail or payer fallback', async () => {
  const { store, restore } = env();
  try {
    const variants: Array<[string, Partial<OrderRecord>]> = [
      ['untouched', {}],
      ['after an extra copy', { printUpgradeStripeSessionId: EXTRA_SESSION, printCopyPurchases: [EXTRA_PURCHASE] }],
      ['audit evidence only', { printUpgradeStatus: 'offered', printUpgradeStripeSessionId: null, printUpgradePaymentIntentId: null }],
      ['PaymentIntent evidence only', { printUpgradeStatus: 'offered', printUpgradeStripeSessionId: null, auditEvents: [] }],
    ];
    for (const [index, [label, overrides]] of variants.entries()) {
      const id = `ord_legacy_historic_${index}`;
      await persistOrder(historicLegacyOrder(id, overrides));
      await contactFor(id, 'print_upgrade', LEGACY_SESSION, LEGACY_PI, NAME);
      await contactFor(id, 'order', ORIGINAL_SESSION, ORIGINAL_PI, 'Payer Substitute');
      const before = rawOrder(id);
      const order = (await getOrder(id))!;
      assert.deepEqual(await resolveOrderPrintContact(order), REFUSED, label);
      const [row] = await loadAdminPrintContacts(order);
      assert.equal(row.status, 'binding_mismatch', label);
      assert.equal(row.recipientName, null, label);
      assert.equal(rawOrder(id), before, label);
    }

    const id = 'ord_legacy_historic_0';
    const objects = store.objects.size;
    const before = rawOrder(id);
    assert.deepEqual((await runWebhook(legacyEvent(id))).statuses, [200]);
    assert.equal(rawOrder(id), before, 'a redelivery backfills nothing');
    assert.equal(store.objects.size, objects);

    const releasable = historicLegacyOrder('ord_legacy_historic_release', RELEASABLE);
    releasable.proofSourceFingerprint = proofSourceFingerprint(releasable);
    await persistOrder(releasable);
    await contactFor(releasable.id, 'print_upgrade', LEGACY_SESSION, LEGACY_PI, NAME);
    const submitted: Array<{ recipientName: string; stripeSessionId: string }> = [];
    assert.deepEqual(await approvePrintProof(releasable.id, 'release-token', releaseDeps(submitted)), { ok: false, error: 'print_contact_binding_mismatch' });
    assert.equal(submitted.length, 0);
    assert.equal((await getOrder(releasable.id))?.fulfillmentStatus, 'proof_ready');
  } finally {
    restore();
  }
});

test('a retail print order stays isolated: an extra copy writes no legacy authority and retail contact still binds', async () => {
  const { restore } = env();
  try {
    const id = 'ord_legacy_retail_control';
    await persistOrder({
      ...createOrderRecord({ childName: 'Fixture Child', bookFormat: 'classic', email: 'payer@example.invalid' }, { id, now: '2026-09-01T12:00:00.000Z' }),
      paymentStatus: 'paid', settledAmountCents: 3900, stripeSessionId: ORIGINAL_SESSION, stripePaymentIntentId: ORIGINAL_PI, shippingAddress: SHIPPING, fulfillmentMode: 'manual_hold',
    });
    await contactFor(id, 'order', ORIGINAL_SESSION, ORIGINAL_PI, NAME);
    await settleExtraCopy(id);
    const stored = (await getOrder(id))!;
    assert.equal('legacyPrintUpgradeSettlement' in stored, false);
    const resolved = await resolveOrderPrintContact(stored);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.contact.purchaseKind, 'order');
    assert.equal(resolved.contact.stripeSessionId, ORIGINAL_SESSION);
    assert.equal(resolved.contact.recipientName, NAME);
  } finally {
    restore();
  }
});
