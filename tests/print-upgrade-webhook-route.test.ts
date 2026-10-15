/**
 * The at-cost print upgrade through the REAL signed Stripe webhook route.
 *
 * Only a correctly signed `checkout.session.completed` whose metadata names
 * the bound Session, quote and format, for exactly the locked amount, settles
 * the upgrade. A replay is acknowledged without change; a tampered amount is
 * recorded as a conflict and acknowledged without applying; an unsigned body
 * is rejected; a `checkout.session.expired` reopens the offer. The webhook
 * never starts fulfillment, never emails, never touches a print provider —
 * every network call is intercepted and nothing leaves the host.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Stripe from 'stripe';

import { POST } from '../src/app/api/webhooks/stripe/route.ts';
import { createOrderRecord, getOrder, persistOrder, type OrderRecord } from '../src/lib/orders.ts';
import { prepareCustomerPrintUpgradeOffer } from '../src/lib/print-upgrade-offer.ts';
import { quotePrintUpgradeAtCost, type PrintCostQuoteProvider } from '../src/lib/print-upgrade-quote.ts';
import { PRINT_UPGRADE_STRIPE_KIND, openPrintUpgradeCheckout } from '../src/lib/print-upgrade-checkout.ts';

const WEBHOOK_SECRET = 'whsec_hsb_print_upgrade_local_test';
const STRIPE_KEY = 'sk_test_hsb_print_upgrade_local_test';
const APPROVED_SHA = '97312217e67bdc8845f5c03cd0d06533a1fe9a84bd030ce8fb25460e79f2ba38';
const NOW = '2026-10-14T12:00:00.000Z';
const ORDER_ID = 'ord_webhook_upgrade_1';
const ADDRESS = { name: 'Alexy Kaplun', line1: '1234 N Broadway', line2: null, city: 'Chicago', state: 'IL', zip: '60640', country: 'US' };

const MANAGED_ENV = [
  'HSB_ORDER_STORE_DIR', 'HSB_PAYMENT_RECOVERY_STORE_DIR', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VERCEL_ENV', 'VERCEL', 'BLOB_READ_WRITE_TOKEN',
  'GA4_MEASUREMENT_ID', 'GA4_API_SECRET', 'NEXT_PUBLIC_GA_MEASUREMENT_ID',
  'RESEND_API_KEY', 'HSB_RESEND_API_KEY', 'HSB_CONTROL_PLANE_SHADOW', 'LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET',
] as const;

function setupStore() {
  const saved = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-upgrade-webhook-'));
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.HSB_ORDER_STORE_DIR = path.join(root, 'orders');
  process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(root, 'recovery');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  return () => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
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

async function seedOpenCheckout() {
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'ZQX-CHILD-7731', bookFormat: 'digital', email: 'zqx.parent.7731@example.invalid' },
      { id: ORDER_ID, now: '2026-09-01T12:00:00Z' },
    ),
    paymentStatus: 'paid',
    paidAt: '2026-09-01T12:05:00Z',
    settledAmountCents: 1900,
    stripeSessionId: 'cs_test_original_digital',
    fulfillmentMode: 'manual_hold',
    fulfillmentStatus: 'not_started',
  };
  await persistOrder(order);
  const prepared = await prepareCustomerPrintUpgradeOffer(ORDER_ID, { approvedSourceSha256: APPROVED_SHA, approvedSourcePageCount: 25, now: NOW });
  assert.ok(prepared.ok);
  const quoted = await quotePrintUpgradeAtCost(ORDER_ID, { token: prepared.token, shippingAddress: ADDRESS }, { provider, now: NOW });
  assert.ok(quoted.ok);
  const premium = quoted.quotes.find((q) => q.targetFormat === 'premium')!;
  const opened = await openPrintUpgradeCheckout(ORDER_ID, { token: prepared.token, quoteId: premium.quoteId }, {
    createCheckoutSession: async () => ({ id: 'cs_test_upgrade_webhook_1', url: 'https://checkout.stripe.test/x' }),
    baseUrl: 'https://hsb.test',
    now: NOW,
  });
  assert.ok(opened.ok);
  return { token: prepared.token, premium };
}

function completedEvent(quoteId: string, sessionOverrides: Record<string, unknown> = {}, metadataOverrides: Record<string, string> = {}) {
  return {
    id: 'evt_print_upgrade_1',
    object: 'event',
    type: 'checkout.session.completed',
    created: 1_800_000_000,
    data: {
      object: {
        id: 'cs_test_upgrade_webhook_1',
        object: 'checkout.session',
        client_reference_id: ORDER_ID,
        metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID, quoteId, targetFormat: 'premium', ...metadataOverrides },
        payment_intent: 'pi_test_upgrade_webhook_1',
        amount_total: 2832,
        amount_subtotal: 2832,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
        ...sessionOverrides,
      },
    },
  };
}

function signed(event: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const signature = new Stripe(STRIPE_KEY).webhooks.generateTestHeaderString({ payload, secret });
  return new Request('http://127.0.0.1/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

async function runWebhook(request: Request): Promise<{ response: Response; lines: string[] }> {
  const lines: string[] = [];
  const sinks = ['error', 'warn', 'log', 'info'] as const;
  const originals = sinks.map((sink) => console[sink]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('this test must make no network call'); }) as typeof fetch;
  for (const sink of sinks) {
    console[sink] = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  try {
    const response = await POST(request);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { response, lines };
  } finally {
    globalThis.fetch = realFetch;
    sinks.forEach((sink, i) => { console[sink] = originals[i]; });
  }
}

test('signed completed Session settles the at-cost upgrade exactly once; replay is acknowledged without change', async () => {
  const cleanup = setupStore();
  try {
    const { premium } = await seedOpenCheckout();
    const first = await runWebhook(signed(completedEvent(premium.quoteId)));
    assert.equal(first.response.status, 200);
    assert.deepEqual(await first.response.json(), { received: true, printUpgradeAtCost: 'paid' });
    const stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.printUpgradeStatus, 'paid');
    assert.equal(stored.bookFormat, 'digital');
    assert.equal(stored.printUpgradeTargetFormat, 'premium');
    assert.equal(stored.printUpgradeAmountCents, 2832);
    assert.equal(stored.printUpgradeOffer?.consumedAt != null, true);
    assert.equal(stored.fulfillmentStatus, 'not_started');
    assert.equal(stored.printJobId ?? null, null);
    assert.equal(stored.paymentStatus, 'paid');
    assert.equal(stored.settledAmountCents, 1900);
    assert.ok(!first.lines.some((l) => /kickoff|fulfillment|confirmation-email|lulu/i.test(l)), first.lines.join('\n'));
    assert.ok(!first.lines.some((l) => /zqx\.parent|ZQX-CHILD|Broadway|60640/.test(l)), 'no PII in logs');

    const replay = await runWebhook(signed(completedEvent(premium.quoteId)));
    assert.equal(replay.response.status, 200);
    assert.deepEqual(await replay.response.json(), { received: true, printUpgradeAtCost: 'replay' });
    const after = (await getOrder(ORDER_ID))!;
    assert.equal(after.printUpgradePaidAt, stored.printUpgradePaidAt);
    assert.equal((after.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_at_cost_paid').length, 1);
  } finally {
    cleanup();
  }
});

test('a tampered amount or wrong signature never settles', async () => {
  const cleanup = setupStore();
  try {
    const { premium } = await seedOpenCheckout();
    const unsigned = await runWebhook(signed(completedEvent(premium.quoteId), 'whsec_wrong'));
    assert.equal(unsigned.response.status, 400);

    const tampered = await runWebhook(signed(completedEvent(premium.quoteId, { amount_total: 1000, amount_subtotal: 1000 })));
    assert.equal(tampered.response.status, 200);
    assert.deepEqual(await tampered.response.json(), { received: true, printUpgradeAtCost: 'conflict_recorded' });
    const stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.bookFormat, 'digital');
    assert.equal(stored.printUpgradeStatus, 'checkout_open');
    assert.equal((stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_settlement_conflict').length, 1);

    const badMeta = await runWebhook(signed(completedEvent(premium.quoteId, {}, { quoteId: '' })));
    assert.equal(badMeta.response.status, 409);
    assert.equal((await getOrder(ORDER_ID))!.bookFormat, 'digital');
  } finally {
    cleanup();
  }
});

test('a legacy retail-delta print_upgrade Session is still routed to the legacy branch, not the at-cost settlement', async () => {
  const cleanup = setupStore();
  try {
    const { premium } = await seedOpenCheckout();
    const legacy = await runWebhook(signed(completedEvent(premium.quoteId, {}, { kind: 'print_upgrade' })));
    assert.equal(legacy.response.status, 200);
    const body = await legacy.response.json() as Record<string, unknown>;
    assert.equal('printUpgradeAtCost' in body, false);
    const stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.bookFormat, 'digital');
    assert.equal(stored.printUpgradeStatus, 'checkout_open');
  } finally {
    cleanup();
  }
});

test('checkout.session.expired for the bound Session reopens the offer; other expiries are ignored', async () => {
  const cleanup = setupStore();
  try {
    await seedOpenCheckout();
    const expired = await runWebhook(signed({
      id: 'evt_print_upgrade_expired',
      object: 'event',
      type: 'checkout.session.expired',
      created: 1_800_000_100,
      data: { object: { id: 'cs_test_upgrade_webhook_1', object: 'checkout.session', metadata: { kind: PRINT_UPGRADE_STRIPE_KIND, orderId: ORDER_ID } } },
    }));
    assert.equal(expired.response.status, 200);
    assert.deepEqual(await expired.response.json(), { received: true, printUpgradeAtCost: 'expired' });
    const stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.printUpgradeStatus, 'offered');
    assert.equal(stored.printUpgradeLock?.status, 'expired');

    const other = await runWebhook(signed({
      id: 'evt_other_expired',
      object: 'event',
      type: 'checkout.session.expired',
      created: 1_800_000_200,
      data: { object: { id: 'cs_test_original_digital', object: 'checkout.session', metadata: { orderId: ORDER_ID } } },
    }));
    assert.equal(other.response.status, 200);
    assert.deepEqual(await other.response.json(), { received: true });
  } finally {
    cleanup();
  }
});

test('delayed payment: a completed-but-unpaid Session is refused and recorded, an async success event settles nothing, and the eventual paid completion still settles exactly once', async () => {
  const cleanup = setupStore();
  try {
    const { premium } = await seedOpenCheckout();

    const unpaid = await runWebhook(signed(completedEvent(premium.quoteId, { payment_status: 'unpaid' })));
    assert.equal(unpaid.response.status, 200);
    assert.deepEqual(await unpaid.response.json(), { received: true, printUpgradeAtCost: 'conflict_recorded' });
    let stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.bookFormat, 'digital');
    assert.equal(stored.printUpgradeStatus, 'checkout_open');
    assert.equal(stored.printUpgradeLock?.status, 'open');
    assert.equal(stored.printUpgradeOffer?.consumedAt ?? null, null);
    assert.equal((stored.printCopyPurchases ?? []).length, 0);
    assert.ok(!unpaid.lines.some((l) => /kickoff|fulfillment|confirmation-email|lulu/i.test(l)), unpaid.lines.join('\n'));

    // Checkout is pinned to card, so Stripe cannot send this for the at-cost
    // kind; if it ever did, it is acknowledged and settles nothing.
    const asyncSuccess = await runWebhook(signed({ ...completedEvent(premium.quoteId), id: 'evt_async_success', type: 'checkout.session.async_payment_succeeded' }));
    assert.equal(asyncSuccess.response.status, 200);
    assert.deepEqual(await asyncSuccess.response.json(), { received: true });
    stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.printUpgradeStatus, 'checkout_open');
    assert.equal((stored.printCopyPurchases ?? []).length, 0);

    const paid = await runWebhook(signed({ ...completedEvent(premium.quoteId), id: 'evt_paid_completion' }));
    assert.equal(paid.response.status, 200);
    assert.deepEqual(await paid.response.json(), { received: true, printUpgradeAtCost: 'paid' });
    stored = (await getOrder(ORDER_ID))!;
    assert.equal(stored.printUpgradeStatus, 'paid');
    assert.equal(stored.bookFormat, 'digital');
    assert.equal(stored.printUpgradeTargetFormat, 'premium');
    assert.equal((stored.printCopyPurchases ?? []).length, 1);
    assert.equal((stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_at_cost_paid').length, 1);
    assert.equal((stored.auditEvents ?? []).filter((e) => e.type === 'print_upgrade_settlement_conflict').length, 1);
  } finally {
    cleanup();
  }
});

test('webhook source: the at-cost branch delegates to the lib settlement and never reaches fulfillment, email or print', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  const start = src.indexOf('PRINT_UPGRADE_STRIPE_KIND');
  assert.ok(start > 0, 'route references PRINT_UPGRADE_STRIPE_KIND');
  const branchStart = src.indexOf(`kind === PRINT_UPGRADE_STRIPE_KIND`);
  assert.ok(branchStart > 0, 'route branches on the at-cost kind');
  const branch = src.slice(branchStart, src.indexOf("kind === 'print_upgrade'", branchStart));
  assert.ok(branch.length > 0, 'at-cost branch precedes the legacy branch');
  assert.match(branch, /settlePrintUpgradeAtCostSession/);
  assert.doesNotMatch(branch, /scheduleFulfillmentKickoff|scheduleOrderConfirmationEmail|recordPrintUpgradePayment|calculatePrintUpgrade|updateOrderPayment|settleOrderPayment|submitPrintJob/);
});
