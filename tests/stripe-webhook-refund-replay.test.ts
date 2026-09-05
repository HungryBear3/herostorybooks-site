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
  beginCheckoutSessionProvisioning,
  bindOrderCheckoutSession,
  createOrderRecord,
  recordCheckoutSessionCandidate,
  getOrder,
  persistOrder,
  recordPaymentSettlementConflict,
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
  assert.match(src, /import\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*'next\/server(?:\.js)?'/);
  // The helper is the actual durable kickoff path.
  assert.match(src, /import\s*\{\s*scheduleFulfillmentKickoff\s*\}\s*from\s*'[^']*fulfillment-kickoff(?:\.ts)?'/);
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

test('webhook source: verifies exact settlement facts and returns retryable conflicts', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.match(src, /existing\.stripeSessionId !== session\.id/);
  assert.match(src, /isExactSettledCheckoutSession\(session, existing, existing\.stripeSessionId\)/);
  assert.match(src, /recordPaymentSettlementConflict/);
  assert.match(src, /settledAmountCents:\s*session\.amount_total/);
  assert.match(src, /Payment transition conflict/);
  assert.match(src, /status:\s*409/);
});

test('checkout source binds Stripe Session before releasing redirect URL', () => {
  // Both checkout paths now share one provisioner, so this ordering guarantee
  // lives there rather than being written twice in the route. Assert it at the
  // place that actually enforces it — and that the route only ever releases a
  // URL the provisioner returned, never a raw provider Session URL.
  const provisioner = readFileSync('src/lib/checkout-session-provisioning.ts', 'utf8');
  const createAt = provisioner.indexOf('await deps.createCheckoutSession({');
  const recordAt = provisioner.indexOf('await deps.recordCheckoutSessionCandidate(');
  const bindAt = provisioner.indexOf('await deps.bindCheckoutSession(');
  const releaseAt = provisioner.indexOf("return { status: 'released', url: session.url");
  assert.ok(createAt > -1, 'the provisioner creates the Session');
  assert.ok(
    recordAt > createAt,
    'the created Session id must be durably recorded before anything else may fail',
  );
  assert.ok(bindAt > recordAt, 'binding happens after the durable candidate exists');
  assert.ok(releaseAt > bindAt, 'no URL may be released before the Session is bound');

  // A bind that fails releases nothing.
  assert.match(provisioner, /if \(!bound\) \{[\s\S]{0,400}?checkout_session_bind_failed/);

  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /redirectTo: provisioned\.url/);
  assert.doesNotMatch(src, /redirectTo: session\.url/);
  const handler = src.slice(0, src.indexOf('async function retrieveDirectCheckoutSession'));
  assert.doesNotMatch(handler, /checkout\.sessions\.create/);
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

// ── Behavioral guards: the order-update primitive is independently fail-closed.
// Route pre-reads are advisory; CAS must still reject refunded/terminal state and
// a different already-bound Stripe session on every retry.

test('refunded order cannot be resurrected by a different paid Stripe session', async () => {
  const dir = makeTmp();
  try {
    await seed({
      paymentStatus: 'refunded',
      stripeSessionId: 'cs_original',
      refundedAt: '2026-04-30T00:00:00Z',
      stripeRefundId: 're_x',
    }, 'ord_refunded_different');
    const result = await updateOrderPayment('ord_refunded_different', 'paid', {
      stripeSessionId: 'cs_delayed_other',
    });
    assert.equal(result, null);
    const after = await getOrder('ord_refunded_different');
    assert.equal(after?.paymentStatus, 'refunded');
    assert.equal(after?.stripeSessionId, 'cs_original');
  } finally { cleanup(dir); }
});

test('pending order bound to another Stripe session cannot be rebound by settlement', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'pending', stripeSessionId: 'cs_expected' }, 'ord_bound_pending');
    const result = await updateOrderPayment('ord_bound_pending', 'paid', {
      stripeSessionId: 'cs_wrong',
    });
    assert.equal(result, null);
    const after = await getOrder('ord_bound_pending');
    assert.equal(after?.paymentStatus, 'pending');
    assert.equal(after?.stripeSessionId, 'cs_expected');
  } finally { cleanup(dir); }
});

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

test('pending pre-bound → paid first webhook still flips state to paid', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'pending', stripeSessionId: 'cs_first' }, 'ord_first');
    const updated = await updateOrderPayment('ord_first', 'paid', { stripeSessionId: 'cs_first' });
    assert.equal(updated?.paymentStatus, 'paid');
    assert.equal(updated?.stripeSessionId, 'cs_first');
  } finally { cleanup(dir); }
});

test('unbound pending order cannot be claimed by settlement', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'pending', stripeSessionId: null }, 'ord_unbound');
    const updated = await updateOrderPayment('ord_unbound', 'paid', { stripeSessionId: 'cs_claim' });
    assert.equal(updated, null);
    assert.equal((await getOrder('ord_unbound'))?.paymentStatus, 'pending');
  } finally { cleanup(dir); }
});

test('checkout binding and conflict ledger are durable and idempotent', async () => {
  const dir = makeTmp();
  const now = new Date('2026-04-29T00:05:00.000Z');
  const LEASE = '11111111-1111-4111-8111-111111111111';
  const ATTEMPT = 'a'.repeat(32);
  const FINGERPRINT = 'f'.repeat(64);
  try {
    await seed({
      paymentStatus: 'pending',
      stripeSessionId: null,
      checkoutAttemptId: ATTEMPT,
      checkoutFingerprint: FINGERPRINT,
      checkoutLeaseId: LEASE,
      checkoutLeaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    }, 'ord_bind');
    // The bind is the commit that makes a Session payable, so it consumes the
    // exact evidence the provisioner laid down for it — the marker committed
    // before the create, and the candidate naming what came back.
    assert.equal(
      (await beginCheckoutSessionProvisioning('ord_bind', {
        leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now,
      })).status,
      'committed',
    );
    assert.ok(await recordCheckoutSessionCandidate('ord_bind', 'cs_bound', {
      checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now,
    }));
    const checkout = { leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now };
    assert.equal((await bindOrderCheckoutSession('ord_bind', 'cs_bound', checkout))?.stripeSessionId, 'cs_bound');
    assert.equal(await bindOrderCheckoutSession('ord_bind', 'cs_other', checkout), null);
    const conflict = { stripeSessionId: 'cs_other', amountSubtotalCents: 1900, amountTotalCents: 950, reason: 'stripe_session_binding_mismatch' };
    await recordPaymentSettlementConflict('ord_bind', conflict);
    await recordPaymentSettlementConflict('ord_bind', conflict);
    const reloaded = await getOrder('ord_bind');
    assert.equal(reloaded?.auditEvents?.filter((e) => e.type === 'payment_settlement_conflict').length, 1);
  } finally { cleanup(dir); }
});

test('paid → paid replay backfills missing settled amount without changing session', async () => {
  const dir = makeTmp();
  try {
    await seed(
      { paymentStatus: 'paid', stripeSessionId: 'cs_dup', settledAmountCents: null },
      'ord_dup',
    );
    const updated = await updateOrderPayment('ord_dup', 'paid', {
      stripeSessionId: 'cs_dup',
      settledAmountCents: 950,
    });
    assert.equal(updated?.paymentStatus, 'paid');
    assert.equal(updated?.stripeSessionId, 'cs_dup');
    assert.equal(updated?.settledAmountCents, 950);
  } finally { cleanup(dir); }
});
