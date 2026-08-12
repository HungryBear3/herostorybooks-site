import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  preprintRefundRefusalReason,
  refundOrder,
  type StripeRefundClient,
} from '../src/lib/admin-actions.ts';
import {
  createOrderRecord,
  __resetOrderStoreAdapterFactoryForTests,
  getOrder,
  persistOrder,
  type OrderRecord,
} from '../src/lib/orders.ts';

function makeTmp() {
  __resetOrderStoreAdapterFactoryForTests();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-refund-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function seed(overrides: Partial<OrderRecord> = {}, id = 'ord_r'): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' },
    { id, now: '2026-04-29T00:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    stripeSessionId: 'cs_test_123',
    fulfillmentStatus: 'proof_ready',
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const happyStripe: StripeRefundClient = {
  retrieveSession: async () => ({ payment_intent: 'pi_test' }),
  createRefund: async () => ({ id: 're_test_xyz' }),
};

// ── Refusal predicate ────────────────────────────────────────────────────────

test('preprintRefundRefusalReason: paid + proof_ready → null (allowed)', { concurrency: false }, () => {
  const order = { paymentStatus: 'paid', status: 'order_received', fulfillmentStatus: 'proof_ready' } as OrderRecord;
  assert.equal(preprintRefundRefusalReason(order), null);
});

test('preprintRefundRefusalReason: not paid → not_paid', { concurrency: false }, () => {
  const o = { paymentStatus: 'pending', status: 'order_received' } as OrderRecord;
  assert.equal(preprintRefundRefusalReason(o), 'not_paid');
});

test('preprintRefundRefusalReason: shipped → already_shipped', { concurrency: false }, () => {
  const o = { paymentStatus: 'paid', status: 'shipped' } as OrderRecord;
  assert.equal(preprintRefundRefusalReason(o), 'already_shipped');
});

test('preprintRefundRefusalReason: print_in_production → already_in_print', { concurrency: false }, () => {
  const o = { paymentStatus: 'paid', status: 'print_in_production' } as OrderRecord;
  assert.equal(preprintRefundRefusalReason(o), 'already_in_print');
});

test('preprintRefundRefusalReason: submitting_to_print → already_finalized', { concurrency: false }, () => {
  const o = { paymentStatus: 'paid', status: 'order_received', fulfillmentStatus: 'submitting_to_print' } as OrderRecord;
  assert.equal(preprintRefundRefusalReason(o), 'already_finalized');
});

test('preprintRefundRefusalReason: already refunded → already_refunded', { concurrency: false }, () => {
  const o = { paymentStatus: 'refunded', status: 'order_received' } as OrderRecord;
  assert.equal(preprintRefundRefusalReason(o), 'already_refunded');
});

// ── refundOrder happy path ───────────────────────────────────────────────────

test('refundOrder: paid + proof_ready → calls Stripe, persists state + audit event', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed();
    const result = await refundOrder('ord_r', 'changed_mind', { getStripe: () => happyStripe });
    assert.equal(result.ok, true);

    const after = await getOrder('ord_r');
    assert.equal(after?.paymentStatus, 'refunded');
    assert.equal(after?.refundReason, 'changed_mind');
    assert.equal(after?.stripeRefundId, 're_test_xyz');
    assert.ok(after?.refundedAt);
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.match(String(after?.fulfillmentLastError), /refunded_pre_print/);

    const audit = (after?.auditEvents ?? []).filter((e) => e.type === 'refund_issued');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, 'changed_mind');
  } finally { cleanup(dir); }
});

test('refundOrder: defaults reason to customer_request when blank', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed();
    const result = await refundOrder('ord_r', '', { getStripe: () => happyStripe });
    assert.equal(result.ok, true);
    const after = await getOrder('ord_r');
    assert.equal(after?.refundReason, 'customer_request');
  } finally { cleanup(dir); }
});

// ── refundOrder refusal paths ────────────────────────────────────────────────

test('refundOrder: 404 for unknown order', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    const r = await refundOrder('ord_missing', 'x', { getStripe: () => happyStripe });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 404);
  } finally { cleanup(dir); }
});

test('refundOrder: 409 + refund_refused audit when already shipped', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed({ status: 'shipped' });
    const r = await refundOrder('ord_r', 'x', { getStripe: () => happyStripe });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 409);
    assert.equal(r.error, 'already_shipped');

    const after = await getOrder('ord_r');
    const audit = (after?.auditEvents ?? []).filter((e) => e.type === 'refund_refused');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, 'already_shipped');
    // State must be untouched.
    assert.equal(after?.paymentStatus, 'paid');
    assert.equal(after?.refundedAt ?? null, null);
  } finally { cleanup(dir); }
});

test('refundOrder: 409 when already refunded', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'refunded', refundedAt: '2026-04-29T05:00:00Z' });
    const r = await refundOrder('ord_r', 'x', { getStripe: () => happyStripe });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, 'already_refunded');
  } finally { cleanup(dir); }
});

test('refundOrder: 409 when print_in_production', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed({ status: 'print_in_production' });
    const r = await refundOrder('ord_r', 'x', { getStripe: () => happyStripe });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, 'already_in_print');
  } finally { cleanup(dir); }
});

test('refundOrder: 503 when Stripe is not configured (getStripe returns null)', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed();
    const r = await refundOrder('ord_r', 'x', { getStripe: () => null });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 503);
    // State must be untouched — no state change without Stripe.
    const after = await getOrder('ord_r');
    assert.equal(after?.paymentStatus, 'paid');
  } finally { cleanup(dir); }
});

test('refundOrder: 502 when Stripe throws', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed();
    const failingStripe: StripeRefundClient = {
      retrieveSession: async () => ({ payment_intent: 'pi_test' }),
      createRefund: async () => { throw new Error('stripe 500'); },
    };
    const r = await refundOrder('ord_r', 'x', { getStripe: () => failingStripe });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 502);
    assert.match(r.error, /stripe 500/);
    const after = await getOrder('ord_r');
    // State must be untouched on processor failure.
    assert.equal(after?.paymentStatus, 'paid');
    assert.equal(after?.refundedAt ?? null, null);
  } finally { cleanup(dir); }
});

test('refundOrder: 502 when Stripe session has no payment_intent', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed();
    const noIntentStripe: StripeRefundClient = {
      retrieveSession: async () => ({ payment_intent: null }),
      createRefund: async () => ({ id: 're_x' }),
    };
    const r = await refundOrder('ord_r', 'x', { getStripe: () => noIntentStripe });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 502);
  } finally { cleanup(dir); }
});

test('refundOrder: 409 when order has no stripeSessionId', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed({ stripeSessionId: null });
    const r = await refundOrder('ord_r', 'x', { getStripe: () => happyStripe });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 409);
    assert.match(r.error, /stripeSessionId/);
  } finally { cleanup(dir); }
});

test('concurrent refunds acquire one durable claim and call Stripe once', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed();
    let createCalls = 0;
    const stripe: StripeRefundClient = {
      retrieveSession: async () => ({ payment_intent: 'pi_once' }),
      createRefund: async () => {
        createCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { id: 're_once' };
      },
    };
    const results = await Promise.all([
      refundOrder('ord_r', 'one', { getStripe: () => stripe }),
      refundOrder('ord_r', 'two', { getStripe: () => stripe }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(createCalls, 1);
    assert.equal((await getOrder('ord_r'))?.stripeRefundId, 're_once');
  } finally { cleanup(dir); }
});

test('ambiguous Stripe refund leaves a durable reconciliation claim', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed();
    let idempotencyKey = '';
    const stripe: StripeRefundClient = {
      retrieveSession: async () => ({ payment_intent: 'pi_ambiguous' }),
      createRefund: async (_intent, _reason, key) => {
        idempotencyKey = key;
        throw new Error('connection reset after provider accepted request');
      },
    };
    const result = await refundOrder('ord_r', 'ambiguous', { getStripe: () => stripe });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error : '', /requires reconciliation/);
    assert.match(idempotencyKey, /^admin-refund-ord_r-/);
    const after = await getOrder('ord_r');
    assert.ok(after?.refundClaimId);
    assert.equal(after?.refundPaymentIntent, 'pi_ambiguous');
    assert.equal(after?.paymentStatus, 'paid');
  } finally { cleanup(dir); }
});

test('refund is refused while automatic fulfillment is actively generating', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentStatus: 'generating_images', fulfillmentKickoffId: 'active-worker' });
    let createCalls = 0;
    const result = await refundOrder('ord_r', 'race', { getStripe: () => ({
      retrieveSession: async () => ({ payment_intent: 'pi_race' }),
      createRefund: async () => { createCalls += 1; return { id: 're_race' }; },
    }) });
    assert.equal(result.ok, false);
    assert.equal(createCalls, 0);
  } finally { cleanup(dir); }
});

test('refund is refused while a proof-ready fulfillment worker still owns the email lease', { concurrency: false }, async () => {
  const dir = makeTmp();
  try {
    await seed({ fulfillmentKickoffId: 'email-worker', fulfillmentKickoffAt: new Date().toISOString() });
    let createCalls = 0;
    const result = await refundOrder('ord_r', 'race', { getStripe: () => ({
      retrieveSession: async () => ({ payment_intent: 'pi_email_race' }),
      createRefund: async () => { createCalls += 1; return { id: 're_email_race' }; },
    }) });
    assert.equal(result.ok, false);
    assert.equal(createCalls, 0);
  } finally { cleanup(dir); }
});
