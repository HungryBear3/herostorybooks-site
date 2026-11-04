import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preprintRefundRefusalReason, refundOrder } from '../src/lib/admin-actions.ts';
import { createOrderRecord, persistOrder, getOrder, getBookFormatMeta,
  withOrderTransaction, __resetOrderStoreAdapterFactoryForTests, type OrderRecord } from '../src/lib/orders.ts';
import { recordPrintUpgradePayment } from '../src/lib/print-upgrades.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';

const now = '2026-11-04T00:00:00.000Z';
function freshStore() {
  __resetOrderStoreAdapterFactoryForTests();
  process.env.HSB_ORDER_STORE_DIR = mkdtempSync(path.join(os.tmpdir(), 'synthetic-refund-authority-'));
  delete process.env.BLOB_READ_WRITE_TOKEN;
}
function base(id = 'ord_synthetic_refund_authority'): OrderRecord {
  return { ...createOrderRecord({ childName: 'Synthetic', bookFormat: 'digital', email: 'synthetic@example.invalid' }, { id, now }),
    paymentStatus: 'paid', stripeSessionId: 'cs_test_initialSynthetic', stripePaymentIntentId: 'pi_initialSynthetic',
    settledAmountCents: getBookFormatMeta('digital').priceCents,
    status: 'order_received', fulfillmentStatus: 'not_started', proofVersion: null };
}
async function settleUpgrade(order: OrderRecord) {
  const amount = getBookFormatMeta('classic').priceCents - getBookFormatMeta('digital').priceCents;
  await withOrderTransaction(order.id, current => ({ commit: { ...current,
    printUpgradeStatus: 'checkout_open', printUpgradeStripeSessionId: 'cs_test_upgradeSynthetic',
    printUpgradeTargetFormat: 'classic', printUpgradeAmountCents: amount }, result: null }));
  const settled = await recordPrintUpgradePayment(order.id, { stripeSessionId: 'cs_test_upgradeSynthetic',
    targetFormat: 'classic', amountCents: amount, paidAt: now });
  assert.equal(settled?.printUpgradeStatus, 'paid');
  assert.ok(settled?.auditEvents?.some(event => event.type === 'print_upgrade_paid'));
}

for (const status of ['offered', 'checkout_open', 'expired'] as const) {
  test(`paid legacy upgrade remains refund-blocking after real extra-copy offer: ${status}`, { concurrency: false }, async () => {
    freshStore(); const original = base(); await persistOrder(original); await settleUpgrade(original);
    const offer = await prepareCustomerPrintUpgradeOffer(original.id, { purchaseKind: 'extra_copy',
      approvedSourceSha256: 'a'.repeat(64), approvedSourcePageCount: 32, now });
    assert.equal(offer.ok, true);
    if (status !== 'offered') await withOrderTransaction(original.id, current => ({ commit: { ...current,
      printUpgradeStatus: status, printUpgradeStripeSessionId: status === 'checkout_open' ? 'cs_test_extraSynthetic' : null }, result: null }));
    const before = (await getOrder(original.id))!;
    let factoryCalls = 0; let retrieves = 0; let refunds = 0;
    const result = await refundOrder(original.id, 'synthetic regression', { getStripe: () => {
      factoryCalls++; return { retrieveSession: async () => { retrieves++; return { payment_intent: 'pi_initialSynthetic' }; },
        createRefund: async () => { refunds++; return { id: 're_synthetic_must_not_issue' }; } };
    } });
    assert.deepEqual({ ok: result.ok, error: result.ok === false ? result.error : null, factoryCalls, retrieves, refunds },
      { ok: false, error: 'multi_payment_refund_required', factoryCalls: 0, retrieves: 0, refunds: 0 });
    const after = (await getOrder(original.id))!;
    for (const field of ['paymentStatus', 'refundedAt', 'stripeRefundId', 'refundClaimId', 'fulfillmentStatus', 'legacyPrintUpgradeSettlement'] as const)
      assert.deepEqual(after[field], before[field], field);
    assert.equal(after.auditEvents?.at(-1)?.type, 'refund_refused');
  });
}

const evidenceCases: Array<[string, Record<string, unknown>]> = [
  ['legacy receipt with missing fields remains ambiguous', { legacyPrintUpgradeSettlement: {} }],
  ['settled copy ledger', { printCopyPurchases: [{ version: 1, kind: 'extra_copy', paidAt: now }] }],
  ['malformed copy ledger', { printCopyPurchases: {} }],
  ['durable legacy paid timestamp', { printUpgradePaidAt: now }],
  ['additional payment-intent evidence', { printUpgradePaymentIntentId: 'pi_upgradeSynthetic' }],
  ['paid state with missing session evidence', { printUpgradeStatus: 'paid', printUpgradeStripeSessionId: null }],
  ['legacy paid audit', { auditEvents: [{ type: 'print_upgrade_paid', at: now }] }],
  ['at-cost paid audit', { auditEvents: [{ type: 'print_upgrade_at_cost_paid', at: now }] }],
  ['unreconciled settlement audit', { auditEvents: [{ type: 'print_upgrade_settlement_conflict', at: now }] }],
  ['malformed audit container', { auditEvents: {} }],
  ['malformed audit member', { auditEvents: [null] }],
  ['in-flight at-cost payment lock', { printUpgradeLock: { stripeSessionId: 'cs_test_pendingSynthetic' } }],
  ['in-flight legacy payment', { printUpgradeStatus: 'checkout_open', printUpgradeStripeSessionId: 'cs_test_pendingSynthetic' }],
];
for (const [label, evidence] of evidenceCases) test(`durable refund refusal: ${label}`, () => {
  const order = { ...base(), printUpgradeStatus: 'offered', printUpgradeStripeSessionId: null, ...evidence } as unknown as OrderRecord;
  assert.equal(preprintRefundRefusalReason(order), 'multi_payment_refund_required');
});

test('ordinary single-payment order with empty additive history remains eligible', () => {
  assert.equal(preprintRefundRefusalReason({ ...base(), printCopyPurchases: [], auditEvents: [] }), null);
});

test('settlement during initial session retrieval is caught by actual refund-claim transaction', { concurrency: false }, async () => {
  freshStore(); const original = base(); await persistOrder(original);
  let entered!: () => void; const wasEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let refunds = 0;
  const running = refundOrder(original.id, 'synthetic scheduled race', { getStripe: () => ({
    retrieveSession: async () => { entered(); await barrier; return { payment_intent: 'pi_initialSynthetic' }; },
    createRefund: async () => { refunds++; return { id: 're_synthetic_must_not_issue' }; },
  }) });
  await wasEntered;
  try {
    await settleUpgrade(original);
    assert.equal((await prepareCustomerPrintUpgradeOffer(original.id, { purchaseKind: 'extra_copy',
      approvedSourceSha256: 'a'.repeat(64), approvedSourcePageCount: 32, now })).ok, true);
  } finally { release(); }
  const result = await running;
  assert.equal(result.ok, false); assert.equal(refunds, 0);
  const after = (await getOrder(original.id))!;
  assert.equal(after.paymentStatus, 'paid'); assert.equal(after.refundedAt ?? null, null);
  assert.equal(after.refundClaimId ?? null, null);
});

test('durable refund claim prevents a real new extra-copy offer during provider callback', { concurrency: false }, async () => {
  freshStore(); const original = base(); await persistOrder(original);
  const result = await refundOrder(original.id, 'synthetic single-payment control', { getStripe: () => ({
    retrieveSession: async () => ({ payment_intent: 'pi_initialSynthetic' }),
    createRefund: async () => {
      const offer = await prepareCustomerPrintUpgradeOffer(original.id, { purchaseKind: 'extra_copy',
        approvedSourceSha256: 'a'.repeat(64), approvedSourcePageCount: 32, now });
      assert.equal(offer.ok, false); if (!offer.ok) assert.equal(offer.reason, 'order_refunded');
      return { id: 're_synthetic_single_control' };
    },
  }) });
  assert.equal(result.ok, true); assert.equal((await getOrder(original.id))?.paymentStatus, 'refunded');
});
