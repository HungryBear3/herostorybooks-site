import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { recordUnmatchedPaymentSettlement } from '../src/lib/payment-recovery.ts';
import {
  beginCheckoutSessionProvisioning,
  createOrderRecord,
  bindOrderCheckoutSession,
  persistOrResumeCheckoutOrder,
  recordCheckoutSessionCandidate,
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
  const route = readFileSync('src/lib/checkout-order-route-handler.ts', 'utf8') + readFileSync('src/app/api/order/route.ts', 'utf8');
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
  // The durable create-or-exact-resume of the owner record still happens
  // before any media and any provider call — it simply moved into the shared
  // legacy entrypoint, together with the recovery decision that depends on it
  // and the media continuation that may only run when there is none. The route
  // hands that whole orchestration its dependencies; the behaviour is driven
  // end-to-end through the exported production function against the real order
  // CAS in tests/checkout-legacy-order-entrypoint.test.ts.
  assert.match(route, /await runLegacyCheckoutRoute<TResponse>\(\{[\s\S]{0,400}?draftOrder,/);
  const legacyEntrypoint = readFileSync('src/lib/checkout-legacy-order.ts', 'utf8');
  assert.match(legacyEntrypoint, /await resumeOrContinueLegacyCheckout\(params, deps\)/);
  assert.match(legacyEntrypoint, /await deps\.persistOrResumeCheckoutOrder\(draft\)/);
  assert.match(route, /checkoutRequestFingerprint\(form\)/);
  assert.match(fingerprint, /value\.arrayBuffer\(\)/);
  assert.match(route, /current\.checkoutLeaseId !== draftOrder\.checkoutLeaseId/);
  assert.match(route, /deps\.uploadOrderPhoto\(draftOrder\.id, photo, draftOrder\.checkoutLeaseId/);
  assert.match(route, /deps\.uploadOrderSupportingPhoto\([\s\S]*draftOrder\.checkoutLeaseId/);
  assert.match(route, /deps\.uploadOrderVoice\([\s\S]*draftOrder\.checkoutLeaseId/);
  // The lease is still proven immediately before the provider call — that step
  // simply moved into the shared provisioner, where both paths get it. Assert
  // the guarantee where it is now enforced, and that it is atomic renewal
  // rather than a local re-read: renew → create, with nothing awaited between.
  const provisioner = readFileSync('src/lib/checkout-session-provisioning.ts', 'utf8');
  const renewAt = provisioner.indexOf('await deps.renewCheckoutLease(');
  const providerCreateAt = provisioner.indexOf('await deps.createCheckoutSession({');
  assert.ok(renewAt > -1 && providerCreateAt > renewAt, 'the exact lease is renewed before creating a Session');
  // The refusal itself, not merely the code string: a renewal that does not
  // commit refuses with ambiguity-safe copy, because a concurrent worker may
  // have bound a payable Session in the window this worker cannot see.
  assert.match(
    provisioner,
    /if \(!renewed\) \{[\s\S]{0,1200}?refused\(409, 'checkout_lease_lost', CHECKOUT_RECONCILIATION_SUPPORT, 'may_be_charged'\)/,
  );
  // Stripe idempotency stays deterministic per order and per provider attempt,
  // and the durable pre-provider marker names the SAME attempt the key was
  // derived from. The key is the second line of defence, not the first: a
  // retry that finds that marker still standing does not re-issue it at all —
  // it stops and asks for reconciliation, because provider retention is finite
  // and an interrupted create may already have minted a payable Session.
  assert.match(
    provisioner,
    /const attempt = current\.checkoutSessionAttempt \?\? 0;[\s\S]{0,200}?const idempotencyKey = checkoutProviderIdempotencyKey\(orderId, attempt\);/,
  );
  // The same generation the key came from is what the marker names, what the
  // candidate is filed under, and what the bind is fenced on.
  assert.match(provisioner, /checkoutSessionAttempt: attempt,/);
  assert.match(provisioner, /checkoutSessionAttempt: sessionAttempt,/);
  const markerAt = provisioner.indexOf('await deps.beginCheckoutSessionProvisioning(');
  assert.ok(
    markerAt > -1 && markerAt < provisioner.indexOf('await deps.createCheckoutSession({'),
    'durable provisioning evidence must be committed before the provider is asked to create',
  );
  const orderIdempotency = readFileSync('src/lib/orders.ts', 'utf8');
  assert.match(orderIdempotency, /return n === 0 \? `hsb_checkout_\$\{orderId\}` : `hsb_checkout_\$\{orderId\}_r\$\{n\}`/);
  // And both paths hand that renewal to the real guarded transaction.
  assert.equal(route.split('renewCheckoutLease').length - 1 >= 2, true);
  const orders = readFileSync('src/lib/orders.ts', 'utf8');
  assert.match(orders, /checkout-\$\{checkoutLeaseId\}/);
  // An order that already has provider history is recovered by the SHARED
  // machine, never by a local fast path in the route. The route used to
  // retrieve the bound Session itself and answer with its URL or a flat 409,
  // which permanently tombstoned any attempt whose Session had expired and was
  // blind to a Session created but never bound.
  const handler = route.slice(0, route.indexOf('async function retrieveDirectCheckoutSession'));
  assert.doesNotMatch(handler, /checkout\.sessions\.retrieve/);
  assert.doesNotMatch(handler, /persistedDraft\.stripeSessionId/);
  assert.match(legacyEntrypoint, /hasCheckoutProviderEvidence\(persisted\)/);
  assert.match(legacyEntrypoint, /await provisionCheckoutSession\(/);
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
      // The superseded lease can bind nothing, whatever it names.
      assert.equal(
        await bindOrderCheckoutSession(original.id, 'cs_stale_a', {
          leaseId: '11111111-1111-4111-8111-111111111111',
          fingerprint: 'fingerprint-a',
          checkoutSessionAttempt: 0,
          now: new Date('2026-08-12T20:06:02.000Z'),
        }),
        null,
      );

      // The winner does what the provisioner does, in the order it does it:
      // commit the marker under its live lease, ask the provider, record what
      // came back. Only then is there anything a bind may consume.
      assert.equal(
        (await beginCheckoutSessionProvisioning(original.id, {
          leaseId: '22222222-2222-4222-8222-222222222222',
          fingerprint: 'fingerprint-a',
          checkoutSessionAttempt: 0,
          now: new Date('2026-08-12T20:06:02.000Z'),
        })).status,
        'committed',
      );
      assert.ok(await recordCheckoutSessionCandidate(original.id, 'cs_winner_b', {
        checkoutAttemptId: 'a'.repeat(32),
        fingerprint: 'fingerprint-a',
        checkoutSessionAttempt: 0,
        now: new Date('2026-08-12T20:06:02.000Z'),
      }));

      // Right lease, right evidence, dead lease: liveness is still required.
      assert.equal(
        await bindOrderCheckoutSession(original.id, 'cs_winner_b', {
          leaseId: '22222222-2222-4222-8222-222222222222',
          fingerprint: 'fingerprint-a',
          checkoutSessionAttempt: 0,
          now: new Date('2026-08-12T20:11:02.000Z'),
        }),
        null,
      );
      // Right lease, live, but naming a Session this order never recorded.
      assert.equal(
        await bindOrderCheckoutSession(original.id, 'cs_expired_b', {
          leaseId: '22222222-2222-4222-8222-222222222222',
          fingerprint: 'fingerprint-a',
          checkoutSessionAttempt: 0,
          now: new Date('2026-08-12T20:06:02.000Z'),
        }),
        null,
      );
      // Right lease, live, but claiming a generation this order is not on.
      assert.equal(
        await bindOrderCheckoutSession(original.id, 'cs_winner_b', {
          leaseId: '22222222-2222-4222-8222-222222222222',
          fingerprint: 'fingerprint-a',
          checkoutSessionAttempt: 1,
          now: new Date('2026-08-12T20:06:02.000Z'),
        }),
        null,
      );
      const bound = await bindOrderCheckoutSession(original.id, 'cs_winner_b', {
        leaseId: '22222222-2222-4222-8222-222222222222',
        fingerprint: 'fingerprint-a',
        checkoutSessionAttempt: 0,
        now: new Date('2026-08-12T20:06:02.000Z'),
      });
      assert.equal(bound?.stripeSessionId, 'cs_winner_b');
      assert.equal(bound?.checkoutSessionCandidate ?? null, null, 'the bind consumed its candidate');
      assert.equal(bound?.checkoutSessionProvisioning ?? null, null, 'and the marker that authorised it');
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
