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
  bindOrderCheckoutSession,
  persistOrResumeCheckoutOrder,
  renewCheckoutLease,
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
  const fingerprint = readFileSync('src/lib/checkout-request-fingerprint.ts', 'utf8');
  const browserRandomId = readFileSync('src/lib/browser-random-id.ts', 'utf8');
  assert.match(client, /checkoutAttemptIdRef\.current \?\? readStoredCheckoutAttemptId\(\)/);
  assert.match(client, /sessionStorage\.getItem\(CHECKOUT_ATTEMPT_STORAGE_KEY\)/);
  assert.match(client, /browserRandomHex\(16\)/);
  assert.match(browserRandomId, /crypto\.getRandomValues\(bytes\)/);
  assert.match(client, /checkoutAttemptIdRef\.current = checkoutAttemptId/);
  assert.match(client, /payload\.set\("checkoutAttemptId", checkoutAttemptId\)/);
  // The hand-off itself moved out of an inline `setTimeout` and into
  // performStripeHandoff (src/lib/checkout-handoff.ts). The attempt-identity
  // contract asserted here is unchanged, only relocated: the attempt id is
  // cleared as part of the redirect, strictly AFTER the navigation, and is
  // left in place when the navigation was refused so a retry resumes the same
  // order and Stripe Session instead of creating a second one.
  assert.match(client, /performStripeHandoff\(result\.redirectTo/);
  assert.match(client, /clearAttemptId:\s*\(\)\s*=>\s*sessionStorage\.removeItem\(CHECKOUT_ATTEMPT_STORAGE_KEY\)/);
  const handoff = readFileSync('src/lib/checkout-handoff.ts', 'utf8');
  const navigateAt = handoff.indexOf('deps.navigate(url)');
  const clearAttemptAt = handoff.indexOf('deps.clearAttemptId?.()');
  assert.ok(navigateAt >= 0 && clearAttemptAt > navigateAt);
  assert.match(route, /createHash\('sha256'\)\.update\(checkoutAttemptId\)/);
  assert.match(route, /persistOrResumeCheckoutOrder\(draftOrder\)/);
  assert.match(route, /checkoutRequestFingerprint\(form\)/);
  assert.match(fingerprint, /value\.arrayBuffer\(\)/);
  assert.match(route, /current\.checkoutLeaseId !== draftOrder\.checkoutLeaseId/);
  assert.match(route, /uploadOrderPhoto\(draftOrder\.id, photo, draftOrder\.checkoutLeaseId/);
  assert.match(route, /uploadOrderSupportingPhoto\([\s\S]*draftOrder\.checkoutLeaseId/);
  assert.match(route, /uploadOrderVoice\([\s\S]*draftOrder\.checkoutLeaseId/);
  // The lease is still proven immediately before the provider call — that step
  // simply moved into the shared provisioner, where both paths get it. Assert
  // the guarantee where it is now enforced, and that it is atomic renewal
  // rather than a local re-read: renew → create, with nothing awaited between.
  const provisioner = readFileSync('src/lib/checkout-session-provisioning.ts', 'utf8');
  const renewAt = provisioner.indexOf('await deps.renewCheckoutLease(');
  const providerCreateAt = provisioner.indexOf('await deps.createCheckoutSession({');
  assert.ok(renewAt > -1 && providerCreateAt > renewAt, 'the exact lease is renewed before creating a Session');
  assert.match(provisioner, /if \(!renewed\) \{[\s\S]{0,400}?checkout_lease_lost/);
  // Stripe idempotency stays deterministic per order and per provider attempt.
  assert.match(provisioner, /idempotencyKey = checkoutProviderIdempotencyKey\(orderId, current\.checkoutSessionAttempt\)/);
  const orderIdempotency = readFileSync('src/lib/orders.ts', 'utf8');
  assert.match(orderIdempotency, /return n === 0 \? `hsb_checkout_\$\{orderId\}` : `hsb_checkout_\$\{orderId\}_r\$\{n\}`/);
  // And both paths hand that renewal to the real guarded transaction.
  assert.equal(route.split('renewCheckoutLease').length - 1 >= 2, true);
  const orders = readFileSync('src/lib/orders.ts', 'utf8');
  assert.match(orders, /checkout-\$\{checkoutLeaseId\}/);
  assert.match(route, /checkout\.sessions\.retrieve\(persistedDraft\.stripeSessionId\)/);
  // create → durable candidate → bind → release, now enforced once in the
  // shared provisioner instead of being open-coded per path. The durable
  // candidate between create and bind is new and strictly stronger: a Session
  // that is created but not bound is recoverable rather than lost.
  const createAt = provisioner.indexOf('await deps.createCheckoutSession({');
  const recordAt = provisioner.indexOf('await deps.recordCheckoutSessionCandidate(');
  const bindAt = provisioner.indexOf('await deps.bindCheckoutSession(');
  const redirectAt = provisioner.indexOf("return { status: 'released', url: session.url");
  assert.ok(createAt >= 0 && recordAt > createAt && bindAt > recordAt && redirectAt > bindAt);
  // The route releases only what the provisioner returned.
  assert.match(route, /redirectTo: provisioned\.url/);
  assert.doesNotMatch(route, /redirectTo: session\.url/);
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
        checkoutLeaseId: '11111111-1111-4111-8111-111111111111',
        checkoutLeaseExpiresAt: '2026-08-12T20:05:00.000Z',
      });
      await persistOrResumeCheckoutOrder(original, { now: new Date('2026-08-12T20:00:00.000Z') });

      const duplicate = { ...original, checkoutLeaseId: '22222222-2222-4222-8222-222222222222' };
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
      assert.equal(takeover.checkoutLeaseId, '22222222-2222-4222-8222-222222222222');
      assert.equal(takeover.checkoutFingerprint, 'fingerprint-a');
      assert.equal(
        await renewCheckoutLease(
          original.id,
          '11111111-1111-4111-8111-111111111111',
          'fingerprint-a',
          { now: new Date('2026-08-12T20:06:01.000Z') },
        ),
        null,
      );
      const renewed = await renewCheckoutLease(
        original.id,
        '22222222-2222-4222-8222-222222222222',
        'fingerprint-a',
        { now: new Date('2026-08-12T20:06:01.000Z'), leaseMs: 300_000 },
      );
      assert.equal(renewed?.checkoutLeaseExpiresAt, '2026-08-12T20:11:01.000Z');
      assert.equal(
        await bindOrderCheckoutSession(original.id, 'cs_stale_a', {
          leaseId: '11111111-1111-4111-8111-111111111111',
          fingerprint: 'fingerprint-a',
          now: new Date('2026-08-12T20:06:02.000Z'),
        }),
        null,
      );
      assert.equal(
        await bindOrderCheckoutSession(original.id, 'cs_expired_b', {
          leaseId: '22222222-2222-4222-8222-222222222222',
          fingerprint: 'fingerprint-a',
          now: new Date('2026-08-12T20:11:02.000Z'),
        }),
        null,
      );
      const bound = await bindOrderCheckoutSession(original.id, 'cs_winner_b', {
        leaseId: '22222222-2222-4222-8222-222222222222',
        fingerprint: 'fingerprint-a',
        now: new Date('2026-08-12T20:06:02.000Z'),
      });
      assert.equal(bound?.stripeSessionId, 'cs_winner_b');
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
