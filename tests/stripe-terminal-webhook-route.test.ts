import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Stripe from 'stripe';

import { POST } from '../src/app/api/webhooks/stripe/route.ts';
import { createOrderRecord, getOrder, persistOrder, type OrderRecord } from '../src/lib/orders.ts';

const WEBHOOK_SECRET = 'whsec_hsb_local_terminal_test';
const STRIPE_KEY = 'sk_test_hsb_local_terminal_test';

function setupStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-terminal-route-'));
  process.env.HSB_ORDER_STORE_DIR = path.join(root, 'orders');
  process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(root, 'recovery');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  delete process.env.VERCEL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return root;
}

function cleanupStore(root: string) {
  rmSync(root, { recursive: true, force: true });
  for (const key of [
    'HSB_ORDER_STORE_DIR',
    'HSB_PAYMENT_RECOVERY_STORE_DIR',
    'HSB_REQUIRE_DURABLE_PERSISTENCE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]) delete process.env[key];
}

async function seed(id: string, overrides: Partial<OrderRecord> = {}) {
  const order = {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.com' },
      { id, now: '2026-08-24T01:00:00.000Z', fulfillmentMode: 'auto' },
    ),
    stripeSessionId: `cs_${id}`,
    stripePaymentIntentId: `pi_${id}`,
    ...overrides,
  } satisfies OrderRecord;
  await persistOrder(order);
  return order;
}

function signedRequest(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const stripe = new Stripe(STRIPE_KEY);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return new Request('http://127.0.0.1/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

test('HTTP A1: signature-verified charge.refunded converges a full refund', async () => {
  const root = setupStore();
  try {
    const order = await seed('ord_http_refund', { paymentStatus: 'paid' });
    const response = await POST(signedRequest({
      id: 'evt_http_refund',
      object: 'event',
      type: 'charge.refunded',
      created: 1_777_000_000,
      data: { object: {
        id: 'ch_http_refund',
        object: 'charge',
        payment_intent: order.stripePaymentIntentId,
        metadata: { orderId: order.id },
        amount: 10_000,
        amount_refunded: 10_000,
        refunded: true,
        refunds: { data: [{ id: 're_http_refund' }] },
      } },
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).paymentConvergence, 'converged');
    const updated = await getOrder(order.id);
    assert.equal(updated?.paymentStatus, 'refunded');
    assert.equal(updated?.stripeRefundedAmountCents, 10_000);
  } finally { cleanupStore(root); }
});

test('HTTP A2: signature-verified dispute resolves by exact PaymentIntent without metadata', async () => {
  const root = setupStore();
  try {
    const order = await seed('ord_http_dispute', { paymentStatus: 'paid' });
    const response = await POST(signedRequest({
      id: 'evt_http_dispute',
      object: 'event',
      type: 'charge.dispute.created',
      created: 1_777_000_000,
      data: { object: {
        id: 'dp_http_dispute',
        object: 'dispute',
        payment_intent: order.stripePaymentIntentId,
        charge: 'ch_http_dispute',
        metadata: {},
      } },
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).paymentConvergence, 'converged');
    assert.equal((await getOrder(order.id))?.paymentStatus, 'refunded');
  } finally { cleanupStore(root); }
});

test('HTTP A3: signature-verified async failure marks only exact pending session failed', async () => {
  const root = setupStore();
  try {
    const order = await seed('ord_http_async_failed', { paymentStatus: 'pending' });
    const response = await POST(signedRequest({
      id: 'evt_http_async_failed',
      object: 'event',
      type: 'checkout.session.async_payment_failed',
      created: 1_777_000_000,
      data: { object: {
        id: order.stripeSessionId,
        object: 'checkout.session',
        client_reference_id: order.id,
        metadata: { orderId: order.id },
        payment_intent: order.stripePaymentIntentId,
      } },
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).paymentConvergence, 'converged');
    assert.equal((await getOrder(order.id))?.paymentStatus, 'failed');
  } finally { cleanupStore(root); }
});

test('HTTP paid replay backfills a legacy order PaymentIntent before returning', async () => {
  const root = setupStore();
  try {
    const order = await seed('ord_http_legacy_replay', {
      paymentStatus: 'paid',
      stripePaymentIntentId: null,
      fulfillmentStatus: 'proof_ready',
      confirmationEmailSentAt: '2026-08-24T01:05:00.000Z',
    });
    const response = await POST(signedRequest({
      id: 'evt_http_completed_replay',
      object: 'event',
      type: 'checkout.session.completed',
      created: 1_777_000_000,
      data: { object: {
        id: order.stripeSessionId,
        object: 'checkout.session',
        client_reference_id: order.id,
        metadata: { orderId: order.id },
        payment_intent: 'pi_http_legacy_backfill',
        amount_total: order.priceCents,
        amount_subtotal: order.priceCents,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
      } },
    }));
    assert.equal(response.status, 200);
    assert.equal((await getOrder(order.id))?.stripePaymentIntentId, 'pi_http_legacy_backfill');
  } finally { cleanupStore(root); }
});

test('HTTP terminal events reject invalid signatures before any mutation', async () => {
  const root = setupStore();
  try {
    const order = await seed('ord_http_bad_sig', { paymentStatus: 'paid' });
    const request = signedRequest({
      id: 'evt_http_bad_sig', object: 'event', type: 'charge.dispute.created',
      data: { object: { id: 'dp_bad', payment_intent: order.stripePaymentIntentId } },
    });
    request.headers.set('stripe-signature', 't=1,v1=bad');
    const response = await POST(request);
    assert.equal(response.status, 400);
    assert.equal((await getOrder(order.id))?.paymentStatus, 'paid');
  } finally { cleanupStore(root); }
});
