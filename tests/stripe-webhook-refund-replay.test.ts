/**
 * Webhook refund-safe replay regression tests.
 *
 * The Stripe webhook route imports next/server + Stripe SDK and
 * verifies signatures, so a full end-to-end test would need a mocked
 * Stripe constructEvent. We test the BEHAVIOR by directly exercising
 * the order-update path the webhook calls (`updateOrderPayment`) and
 * source-asserting that the route guards against:
 *
 *   1. paid → paid replay (skip)
 *   2. refunded → paid replay (skip + clear log + no fulfillment retrigger)
 *   3. pending → paid first time (proceeds normally)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  getOrder,
  persistOrder,
  updateOrderPayment,
  type OrderRecord,
} from '../src/lib/orders.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-webhook-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function seed(overrides: Partial<OrderRecord>, id: string): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id, now: '2026-04-29T00:00:00Z' },
  );
  const order: OrderRecord = { ...base, ...overrides };
  await persistOrder(order);
  return order;
}

// ── Source-level guards: the webhook route must contain the new branches.

test('webhook source: paid replay backfills fulfillment when still not_started', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.match(src, /already processed/);
  assert.match(src, /paymentStatus === 'paid'/);
  assert.match(src, /fulfillmentStatus === 'not_started'/);
});

test('webhook source: fulfillment is scheduled via setImmediate+after helper (response not blocked by long fulfillment)', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  // Webhook must import after from next/server (still needed as the
  // serverless backup path passed to the helper).
  assert.match(src, /import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*'next\/server'/);
  // The helper is the actual durable kickoff path.
  assert.match(src, /import\s*\{\s*scheduleFulfillmentKickoff\s*\}\s*from\s*'@\/lib\/fulfillment-kickoff'/);
  // Both fulfillment kickoffs (new-paid + replay-backfill) must use the helper.
  const calls = src.match(/scheduleFulfillmentKickoff\(orderId,\s*\{\s*afterImpl:\s*after\s*\}\s*\)/g) ?? [];
  assert.ok(calls.length >= 2, `expected at least 2 scheduleFulfillmentKickoff() call sites, got ${calls.length}`);
  // The previous direct after(async ...) → triggerFulfillment shape and the
  // earlier preloadedOrder shortcut must both be gone.
  assert.doesNotMatch(src, /after\(async\s*\(\s*\)\s*=>\s*\{[\s\S]{0,200}triggerFulfillment\(/);
  assert.doesNotMatch(src, /preloadedOrder/);
  // Inline awaited triggerFulfillment in the POST body would re-introduce
  // the ~10s Stripe-CLI timeout. Forbid it.
  assert.doesNotMatch(src, /^\s*await\s+triggerFulfillment\(/m);
});

test('webhook source: payment write is awaited before responding (must commit before 200)', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.match(src, /const\s+updated\s*=\s*await\s+updateOrderPayment\(/);
});

test('webhook source: refuses to resurrect a refunded order on replay', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.match(src, /paymentStatus === 'refunded'/);
  assert.match(src, /refusing to resurrect/);
  assert.match(src, /refundedSkipped/);
});

test('webhook source: rejects same-session replay for any non-pending paymentStatus', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  // Defensive branch: paymentStatus !== 'pending' on replay → skip.
  assert.match(src, /paymentStatus !== 'pending'/);
});

// ── Behavioral guards: the order-update path is what the webhook drives.
// On a refunded order, calling updateOrderPayment(_, 'paid', ...) WOULD
// resurrect state — these tests document that the webhook MUST refuse
// before reaching that call. The dedicated source-level guards above
// confirm the webhook does refuse.

test('refunded order is detectable on replay: paymentStatus and refundedAt both set', async () => {
  const dir = makeTmp();
  try {
    const order = await seed(
      {
        paymentStatus: 'refunded',
        stripeSessionId: 'cs_replay_1',
        refundedAt: '2026-04-30T00:00:00Z',
        refundReason: 'cust_request',
        stripeRefundId: 're_x',
      },
      'ord_refunded',
    );
    const reloaded = await getOrder(order.id);
    assert.equal(reloaded?.paymentStatus, 'refunded');
    assert.ok(reloaded?.refundedAt);
    // The webhook check uses BOTH conditions (paymentStatus OR refundedAt).
    const webhookWouldSkip =
      reloaded?.stripeSessionId === 'cs_replay_1'
      && (reloaded?.paymentStatus === 'refunded' || Boolean(reloaded?.refundedAt));
    assert.equal(webhookWouldSkip, true);
  } finally { cleanup(dir); }
});

test('pending → paid first webhook still flips state to paid', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'pending' }, 'ord_first');
    const updated = await updateOrderPayment('ord_first', 'paid', { stripeSessionId: 'cs_first' });
    assert.equal(updated?.paymentStatus, 'paid');
    assert.equal(updated?.stripeSessionId, 'cs_first');
  } finally { cleanup(dir); }
});

test('paid → paid replay: matching condition for the skip branch is satisfied', async () => {
  const dir = makeTmp();
  try {
    await seed(
      { paymentStatus: 'paid', stripeSessionId: 'cs_dup' },
      'ord_dup',
    );
    const reloaded = await getOrder('ord_dup');
    const webhookWouldSkip =
      reloaded?.stripeSessionId === 'cs_dup' && reloaded?.paymentStatus === 'paid';
    assert.equal(webhookWouldSkip, true);
  } finally { cleanup(dir); }
});
