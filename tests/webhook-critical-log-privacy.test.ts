import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Stripe from 'stripe';

import { POST } from '../src/app/api/webhooks/stripe/route.ts';
import {
  createOrderRecord,
  persistOrder,
  __setOrderStoreAdapterFactoryForTests,
  __resetOrderStoreAdapterFactoryForTests,
  type OrderRecord,
} from '../src/lib/orders.ts';

// The missing-order CRITICAL webhook line is the loudest diagnostic this app
// emits: it fires on a paid Stripe session whose order cannot be found, and it
// lands in Vercel's shared runtime log where it is retained and searchable far
// beyond the order record itself. It must carry everything ops needs to run the
// recovery script — the order id, the Stripe session id, the amount — and
// nothing that identifies the buyer.

const WEBHOOK_SECRET = 'whsec_hsb_local_log_privacy_test';
const STRIPE_KEY = 'sk_test_hsb_local_log_privacy_test';
const BUYER_EMAIL = 'critical.log.buyer@example.com';
const ORDER_ID = 'ord_critical_log_privacy';

function setupStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-webhook-log-privacy-'));
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
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(root, { recursive: true, force: true });
  for (const key of [
    'HSB_ORDER_STORE_DIR',
    'HSB_PAYMENT_RECOVERY_STORE_DIR',
    'HSB_REQUIRE_DURABLE_PERSISTENCE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]) delete process.env[key];
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

/** Everything the handler writes to the runtime log during one request. */
async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const lines: string[] = [];
  const sinks = ['error', 'warn', 'log', 'info'] as const;
  const originals = sinks.map((sink) => console[sink]);
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
  };
  for (const sink of sinks) console[sink] = record;
  try {
    return { result: await run(), logged: lines.join('\n') };
  } finally {
    sinks.forEach((sink, i) => { console[sink] = originals[i]; });
  }
}

test('the missing-order CRITICAL webhook log carries recovery context but never the buyer email', async () => {
  const root = setupStore();
  try {
    const order = {
      ...createOrderRecord(
        { childName: 'Luna', bookFormat: 'digital', email: BUYER_EMAIL },
        { id: ORDER_ID, now: '2026-09-06T01:00:00.000Z', fulfillmentMode: 'auto' },
      ),
      stripeSessionId: `cs_${ORDER_ID}`,
      paymentStatus: 'pending',
    } satisfies OrderRecord;
    await persistOrder(order);

    // Production shape (a): the order was never durably persisted before Stripe
    // completed, so the guarded read finds nothing and the record is gone by the
    // time the handler re-reads it. Reached here by standing in a versioned
    // store that has no record and retracts the local one on read.
    const recordPath = path.join(process.env.HSB_ORDER_STORE_DIR!, `${ORDER_ID}.json`);
    __resetOrderStoreAdapterFactoryForTests();
    __setOrderStoreAdapterFactoryForTests(() => ({
      kind: 'missing-durable-record',
      async readVersioned() {
        rmSync(recordPath, { force: true });
        return null;
      },
      async createIfAbsent() { return { ok: false as const, reason: 'exists' as const }; },
      async replaceIfVersion() { return { ok: false as const, reason: 'version_conflict' as const }; },
    }));

    const { result: response, logged } = await captureConsole(() => POST(signedRequest({
      id: 'evt_critical_log_privacy',
      object: 'event',
      type: 'checkout.session.completed',
      created: 1_788_000_000,
      data: { object: {
        id: order.stripeSessionId,
        object: 'checkout.session',
        client_reference_id: order.id,
        metadata: { orderId: order.id },
        payment_intent: 'pi_critical_log_privacy',
        amount_total: order.priceCents,
        amount_subtotal: order.priceCents,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
        customer_email: BUYER_EMAIL,
      } },
    })));

    // Retry semantics are unchanged: Stripe must redeliver this one.
    assert.equal(response.status, 500);

    // The branch under test actually ran.
    assert.match(logged, /\[webhook\] CRITICAL/);

    // Ops keeps every opaque handle it needs to reconcile and recover.
    assert.equal(logged.includes(order.id), true, 'CRITICAL log must keep the order id');
    assert.equal(logged.includes(order.stripeSessionId), true, 'CRITICAL log must keep the Stripe session id');
    assert.match(logged, new RegExp(`amount=${order.priceCents}\\b`));
    assert.match(logged, /scripts\/recover-orders\.ts/);

    // …and nothing that identifies the buyer.
    assert.equal(
      logged.includes(BUYER_EMAIL),
      false,
      `webhook log leaked the buyer email address:\n${logged}`,
    );
    assert.doesNotMatch(logged, /customer_?email/i);
    assert.doesNotMatch(logged, /[\w.+-]+@[\w-]+\.[\w.-]+/);
  } finally { cleanupStore(root); }
});

test('the Stripe webhook route never reads a session customer email at all', () => {
  const route = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');

  // Whole-file, so the read cannot be reintroduced by moving it to another
  // diagnostic, a helper, or the session type.
  assert.doesNotMatch(
    route,
    /customer_?email/i,
    'the Stripe webhook has no use for the buyer email address',
  );

  // The print-upgrade twin of the CRITICAL log keeps its recovery context.
  assert.match(
    route,
    /\[webhook\] CRITICAL: print upgrade order \$\{upgradeOrderId\} not found after paid Stripe session \$\{session\.id\}/,
  );
  assert.match(route, /amount=\$\{session\.amount_total \?\? '\?'\}/);
});
