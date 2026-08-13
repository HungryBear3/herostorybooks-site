import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { recordUnmatchedPaymentSettlement } from '../src/lib/payment-recovery.ts';
import {
  createOrderRecord,
  persistOrResumeCheckoutOrder,
} from '../src/lib/orders.ts';

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) old[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) value == null ? delete process.env[key] : process.env[key] = value;
  try { return await fn(); }
  finally {
    for (const [key, value] of Object.entries(old)) value == null ? delete process.env[key] : process.env[key] = value;
  }
}

test('checkout source uses stable attempt identity and Stripe idempotency before URL release', () => {
  const route = readFileSync('src/app/api/order/route.ts', 'utf8');
  const client = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.match(client, /sessionStorage\.getItem\(attemptStorageKey\)/);
  assert.match(client, /payload\.set\("checkoutAttemptId", checkoutAttemptId\)/);
  assert.match(client, /window\.location\.href = result\.redirectTo;\s*sessionStorage\.removeItem\(attemptStorageKey\)/);
  assert.match(route, /createHash\('sha256'\)\.update\(checkoutAttemptId\)/);
  assert.match(route, /persistOrResumeCheckoutOrder\(draftOrder\)/);
  assert.match(route, /checkoutFingerprint\(form\)/);
  assert.match(route, /value\.arrayBuffer\(\)/);
  assert.match(route, /current\.checkoutLeaseId !== draftOrder\.checkoutLeaseId/);
  assert.match(route, /uploadOrderPhoto\(draftOrder\.id, photo, draftOrder\.checkoutLeaseId/);
  assert.match(route, /uploadOrderSupportingPhoto\([\s\S]*draftOrder\.checkoutLeaseId/);
  const orders = readFileSync('src/lib/orders.ts', 'utf8');
  assert.match(orders, /checkout-\$\{checkoutLeaseId\}/);
  assert.match(route, /checkout\.sessions\.retrieve\(persistedDraft\.stripeSessionId\)/);
  assert.match(route, /idempotencyKey: `hsb_checkout_\$\{order\.id\}`/);
  const createAt = route.indexOf('stripe.checkout.sessions.create');
  const bindAt = route.indexOf('bindOrderCheckoutSession(order.id, session.id)');
  const redirectAt = route.indexOf('redirectTo: session.url');
  assert.ok(createAt >= 0 && bindAt > createAt && redirectAt > bindAt);
});

test('checkout resume rejects active duplicates and payload mismatch, then permits exact expired takeover', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-checkout-lease-'));
  try {
    await withEnv({
      HSB_ORDER_STORE_DIR: dir,
      BLOB_READ_WRITE_TOKEN: undefined,
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      NODE_ENV: 'test',
      VERCEL: undefined,
    }, async () => {
      const original = createOrderRecord({
        childName: 'Hero',
        theme: 'Adventure',
        bookFormat: 'digital',
        email: 'buyer@example.com',
      }, { id: 'ord_checkout_lease' });
      Object.assign(original, {
        checkoutAttemptId: 'a'.repeat(32),
        checkoutFingerprint: 'fingerprint-a',
        checkoutLeaseId: 'lease-original',
        checkoutLeaseExpiresAt: '2026-08-12T20:05:00.000Z',
      });
      await persistOrResumeCheckoutOrder(original, { now: new Date('2026-08-12T20:00:00.000Z') });

      const duplicate = { ...original, checkoutLeaseId: 'lease-duplicate' };
      await assert.rejects(
        persistOrResumeCheckoutOrder(duplicate, { now: new Date('2026-08-12T20:01:00.000Z') }),
        /checkout_attempt_in_progress/,
      );

      const mismatch = { ...duplicate, checkoutFingerprint: 'fingerprint-b' };
      await assert.rejects(
        persistOrResumeCheckoutOrder(mismatch, { now: new Date('2026-08-12T20:06:00.000Z') }),
      );

      const takeover = await persistOrResumeCheckoutOrder(
        duplicate,
        { now: new Date('2026-08-12T20:06:00.000Z') },
      );
      assert.equal(takeover.checkoutLeaseId, 'lease-duplicate');
      assert.equal(takeover.checkoutFingerprint, 'fingerprint-a');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unmatched settlement recovery is durable and idempotent by Stripe Session', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-payment-recovery-'));
  try {
    await withEnv({
      HSB_PAYMENT_RECOVERY_STORE_DIR: dir,
      BLOB_READ_WRITE_TOKEN: undefined,
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      NODE_ENV: 'test',
      VERCEL: undefined,
    }, async () => {
      const first = await recordUnmatchedPaymentSettlement({
        stripeSessionId: 'cs_missing_identity',
        claimedOrderId: null,
        amountSubtotalCents: 3900,
        amountTotalCents: 0,
        reason: 'missing_order_identity',
        now: '2026-08-12T20:00:00.000Z',
      });
      const second = await recordUnmatchedPaymentSettlement({
        stripeSessionId: 'cs_missing_identity',
        claimedOrderId: 'ord_later_claim',
        amountSubtotalCents: 3900,
        amountTotalCents: 0,
        reason: 'order_not_found',
        now: '2026-08-12T20:01:00.000Z',
      });
      assert.equal(first.deliveryCount, 1);
      assert.equal(second.deliveryCount, 2);
      assert.equal(second.claimedOrderId, 'ord_later_claim');
      assert.equal(second.firstSeenAt, first.firstSeenAt);
      const files = await import('node:fs/promises').then((fs) => fs.readdir(dir));
      assert.equal(files.length, 1);
      const stored = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
      assert.equal(stored.stripeSessionId, 'cs_missing_identity');
      assert.equal(stored.deliveryCount, 2);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('webhook records missing identity and missing order before retryable response', () => {
  const route = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.match(route, /recordUnmatchedPaymentSettlement/);
  assert.match(route, /reason: 'missing_order_identity'/);
  assert.match(route, /reason: 'order_not_found'/);
  assert.match(route, /Payment recovery persistence failed/);
});
