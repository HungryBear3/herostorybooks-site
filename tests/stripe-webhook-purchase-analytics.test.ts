/**
 * GA4 `purchase` through the real signed Stripe webhook.
 *
 * The purchase is sent once, only after the exact settled-payment check and
 * the durable pending → paid transition both succeed, with the GA session and
 * bounded attribution carried in the provider-signed metadata. A replay, a
 * settlement conflict, a non-production deployment, or a Measurement Protocol
 * failure can never double-count, roll back settlement, or change the
 * acknowledgement Stripe sees.
 *
 * Every network call is intercepted: the Measurement Protocol endpoint is
 * recorded and answered locally, anything else throws. Nothing leaves the host.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import Stripe from 'stripe';

import { POST } from '../src/app/api/webhooks/stripe/route.ts';
import { createOrderRecord, getOrder, persistOrder, type OrderRecord } from '../src/lib/orders.ts';

const WEBHOOK_SECRET = 'whsec_hsb_purchase_analytics_local_test';
const STRIPE_KEY = 'sk_test_hsb_purchase_analytics_local_test';
const MP_SECRET = 'test-mp-secret-7731';
const CLIENT = '123456789.1727500000';
const DAY = 86_400_000;
const MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect';

const MANAGED_ENV = [
  'HSB_ORDER_STORE_DIR', 'HSB_PAYMENT_RECOVERY_STORE_DIR', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VERCEL_ENV', 'VERCEL', 'BLOB_READ_WRITE_TOKEN',
  'GA4_MEASUREMENT_ID', 'GA4_API_SECRET', 'NEXT_PUBLIC_GA_MEASUREMENT_ID',
  'RESEND_API_KEY', 'HSB_RESEND_API_KEY', 'HSB_CONTROL_PLANE_SHADOW',
] as const;

function setupStore(opts: { production?: boolean } = {}) {
  const saved = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-purchase-analytics-'));
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.HSB_ORDER_STORE_DIR = path.join(root, 'orders');
  process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(root, 'recovery');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.GA4_MEASUREMENT_ID = 'G-68FKEDZEG3';
  process.env.GA4_API_SECRET = MP_SECRET;
  if (opts.production !== false) process.env.VERCEL_ENV = 'production';
  return () => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function seedOrder(hex: string, overrides: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const order = {
    ...createOrderRecord(
      { childName: 'ZQX-CHILD-7731', bookFormat: 'digital', email: 'zqx.parent.7731@example.invalid' },
      { id: `ord_${hex}`, now: new Date().toISOString() },
    ),
    stripeSessionId: `cs_test_${hex}`,
    paymentStatus: 'pending',
    ...overrides,
  } as OrderRecord;
  await persistOrder(order);
  return order;
}

function capturedAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** What the checkout API wrote into the Session metadata, plus hostile extras. */
function checkoutMetadata(order: OrderRecord, firstAt: string, lastAt: string): Record<string, string> {
  return {
    orderId: order.id,
    gaClientId: CLIENT,
    gaSessionId: '1727500000',
    gaSessionNumber: '3',
    hsbAttrV: '1',
    hsbFtSrc: 'facebook',
    hsbFtMed: 'paid_social',
    hsbFtCmp: '2026-10-gifts',
    hsbFtPath: '/gifts/birthdays',
    hsbFtAt: firstAt,
    hsbLtSrc: 'newsletter',
    hsbLtMed: 'email',
    hsbLtPath: '/',
    hsbLtAt: lastAt,
    // A dashboard edit or future code must not be able to smuggle these out.
    customer_email: 'zqx.parent.7731@example.invalid',
    childName: 'ZQX-CHILD-7731',
  };
}

function completedEvent(order: OrderRecord, metadata: Record<string, string>, sessionOverrides: Record<string, unknown> = {}) {
  return {
    id: `evt_${order.id.slice(4)}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: 1_800_000_000,
    data: {
      object: {
        id: order.stripeSessionId,
        object: 'checkout.session',
        client_reference_id: order.id,
        metadata,
        payment_intent: `pi_${order.id.slice(4)}`,
        amount_total: order.priceCents,
        amount_subtotal: order.priceCents,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
        ...sessionOverrides,
      },
    },
  };
}

function signed(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const signature = new Stripe(STRIPE_KEY).webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return new Request('http://127.0.0.1/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

const ANALYTICS_SETTLED = /^\[purchase-analytics\] ga4=/;
const CONFIRMATION_EMAIL_SETTLED = /^\[confirmation-email\] setImmediate (?:completed|failed|joined failed send) for /;
const FULFILLMENT_KICKOFF_SETTLED = /^\[webhook\]\[kickoff:[^\]]+\] \[setImmediate\] chain exited:/;

interface MpCall { url: string; body: string }

async function runWebhook(
  event: Record<string, unknown>,
  opts: { settledBy?: RegExp[]; mpStatus?: number; deliveries?: number; onResponse?: () => void } = {},
): Promise<{ response: Response; lines: string[]; mp: MpCall[] }> {
  const lines: string[] = [];
  const mp: MpCall[] = [];
  const sinks = ['error', 'warn', 'log', 'info'] as const;
  const originals = sinks.map((sink) => console[sink]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${MP_ENDPOINT}?`)) throw new Error('this test must make no other network call');
    mp.push({ url, body: String(init?.body) });
    return new Response(null, { status: opts.mpStatus ?? 204 });
  }) as typeof fetch;
  for (const sink of sinks) {
    console[sink] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
  }
  try {
    const responses = await Promise.all(Array.from({ length: opts.deliveries ?? 1 }, async () => { const result = await POST(signed(event)); opts.onResponse?.(); return result; }));
    const response = responses[0];
    for (const other of responses) assert.equal(other.status, response.status, lines.join('\n'));
    const markers = opts.settledBy ?? [];
    const expiry = Date.now() + 30_000;
    while (!markers.every((marker) => lines.some((line) => marker.test(line))) && Date.now() < expiry) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      markers.every((marker) => lines.some((line) => marker.test(line))),
      `deferred webhook work did not settle:\n${lines.join('\n')}`,
    );
    // Let any straggling deferred callback land inside this capture window.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return { response, lines: [...lines], mp };
  } finally {
    sinks.forEach((sink, index) => { console[sink] = originals[index]; });
    globalThis.fetch = realFetch;
  }
}

const NEWLY_PAID = [ANALYTICS_SETTLED, CONFIRMATION_EMAIL_SETTLED, FULFILLMENT_KICKOFF_SETTLED];

test('the newly-paid transition sends exactly one GA4 purchase with session continuity and bounded attribution', async () => {
  const restore = setupStore();
  try {
    const order = await seedOrder('5a6b7c8d9e0f1a2b');
    const firstAt = capturedAgo(3 * DAY);
    const lastAt = capturedAgo(DAY);
    const { response, lines, mp } = await runWebhook(
      completedEvent(order, checkoutMetadata(order, firstAt, lastAt)),
      { settledBy: NEWLY_PAID },
    );

    assert.equal(response.status, 200);
    assert.equal((await getOrder(order.id))?.paymentStatus, 'paid');
    assert.equal(mp.length, 1);
    assert.equal(new URL(mp[0].url).searchParams.get('measurement_id'), 'G-68FKEDZEG3');
    assert.deepEqual(JSON.parse(mp[0].body), {
      client_id: CLIENT,
      events: [{
        name: 'purchase',
        params: {
          transaction_id: order.stripeSessionId,
          value: 19,
          currency: 'USD',
          items: [{ item_id: 'book_digital', item_name: 'HeroStoryBooks digital', price: 19, quantity: 1 }],
          engagement_time_msec: 1,
          session_id: 1727500000,
          session_number: 3,
          hsb_ft_source: 'facebook',
          hsb_ft_medium: 'paid_social',
          hsb_ft_campaign: '2026-10-gifts',
          hsb_ft_landing: '/gifts/birthdays',
          hsb_lt_source: 'newsletter',
          hsb_lt_medium: 'email',
          hsb_lt_landing: '/',
        },
      }],
    });
    assert.doesNotMatch(mp[0].body, /ZQX|zqx|example\.invalid|ord_|pi_|customer_email|childName/);
    assert.deepEqual(
      lines.filter((line) => ANALYTICS_SETTLED.test(line)),
      [`[purchase-analytics] ga4=sent transaction=${order.stripeSessionId}`],
    );
  } finally {
    restore();
  }
});

test('concurrent pending reads and later redelivery dispatch exactly one purchase', async () => {
  const restore = setupStore();
  const originalRead = fsPromises.readFile;
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  let winnerFinished!: () => void;
  const winnerDone = new Promise<void>((resolve) => { winnerFinished = resolve; });
  const timeout = setTimeout(() => { release(); winnerFinished(); }, 5000);
  try {
    const order = await seedOrder('aa6b7c8d9e0f1a2b');
    // Hold each route's advisory read until BOTH have captured pending bytes.
    // The real transaction/CAS must distinguish its winner from its replay.
    fsPromises.readFile = (async (...args: Parameters<typeof originalRead>) => {
      const value = await originalRead(...args);
      if (String(args[0]).endsWith(`/${order.id}.json`) && reads < 2) {
        assert.equal(JSON.parse(String(value)).paymentStatus, 'pending');
        reads += 1;
        const position = reads;
        if (reads === 2) release();
        await bothRead;
        // Deliver the second stale snapshot only after the winner commits.
        if (position === 2) await winnerDone;
        assert.equal(reads, 2, 'both advisory reads must reach the barrier');
      }
      return value;
    }) as typeof originalRead;
    syncBuiltinESMExports();
    const event = completedEvent(order, checkoutMetadata(order, capturedAgo(3 * DAY), capturedAgo(DAY)));
    const concurrent = await runWebhook(event, { deliveries: 2, settledBy: NEWLY_PAID, onResponse: winnerFinished });
    assert.equal(reads, 2);
    assert.equal(concurrent.response.status, 200);
    assert.equal(concurrent.mp.length, 1);
    assert.equal(concurrent.lines.filter((line) => ANALYTICS_SETTLED.test(line)).length, 1);
    const replay = await runWebhook(event, { settledBy: [CONFIRMATION_EMAIL_SETTLED] });
    assert.equal(replay.response.status, 200);
    assert.equal(replay.mp.length, 0);
    assert.equal((await getOrder(order.id))?.paymentStatus, 'paid');
  } finally {
    clearTimeout(timeout);
    fsPromises.readFile = originalRead;
    syncBuiltinESMExports();
    restore();
  }
});

test('an already-paid replay never re-sends the purchase', async () => {
  const restore = setupStore();
  try {
    const order = await seedOrder('6b7c8d9e0f1a2b3c', {
      paymentStatus: 'paid',
      paidAt: new Date(Date.now() - 60_000).toISOString(),
      stripePaymentIntentId: 'pi_6b7c8d9e0f1a2b3c',
      fulfillmentStatus: 'complete',
    });
    const { response, lines, mp } = await runWebhook(
      completedEvent(order, checkoutMetadata(order, capturedAgo(3 * DAY), capturedAgo(DAY))),
      { settledBy: [CONFIRMATION_EMAIL_SETTLED] },
    );

    assert.equal(response.status, 200);
    assert.equal(mp.length, 0);
    assert.equal(lines.some((line) => ANALYTICS_SETTLED.test(line)), false);
  } finally {
    restore();
  }
});

test('a settlement that does not match the order records a conflict and sends nothing', async () => {
  const restore = setupStore();
  try {
    const order = await seedOrder('7c8d9e0f1a2b3c4d');
    const { response, lines, mp } = await runWebhook(completedEvent(
      order,
      checkoutMetadata(order, capturedAgo(3 * DAY), capturedAgo(DAY)),
      { amount_subtotal: order.priceCents - 100 },
    ));

    assert.equal(response.status, 200);
    assert.equal((await getOrder(order.id))?.paymentStatus, 'pending');
    assert.equal(mp.length, 0);
    assert.equal(lines.some((line) => ANALYTICS_SETTLED.test(line)), false);
  } finally {
    restore();
  }
});

test('outside production the settled transition logs a typed skip and sends nothing', async () => {
  const restore = setupStore({ production: false });
  try {
    const order = await seedOrder('8d9e0f1a2b3c4d5e');
    const { response, lines, mp } = await runWebhook(
      completedEvent(order, checkoutMetadata(order, capturedAgo(3 * DAY), capturedAgo(DAY))),
      { settledBy: NEWLY_PAID },
    );

    assert.equal(response.status, 200);
    assert.equal((await getOrder(order.id))?.paymentStatus, 'paid');
    assert.equal(mp.length, 0);
    assert.deepEqual(
      lines.filter((line) => ANALYTICS_SETTLED.test(line)),
      [`[purchase-analytics] ga4=skipped:not_production transaction=${order.stripeSessionId}`],
    );
  } finally {
    restore();
  }
});

test('a Measurement Protocol failure is typed and redacted and changes nothing Stripe or the order sees', async () => {
  const restore = setupStore();
  try {
    const order = await seedOrder('9e0f1a2b3c4d5e6f');
    const { response, lines, mp } = await runWebhook(
      completedEvent(order, checkoutMetadata(order, capturedAgo(3 * DAY), capturedAgo(DAY))),
      { settledBy: NEWLY_PAID, mpStatus: 500 },
    );

    assert.equal(response.status, 200, 'Stripe must not retry an analytics failure');
    assert.equal(mp.length, 1);
    const settled = await getOrder(order.id);
    assert.equal(settled?.paymentStatus, 'paid', 'settlement is never rolled back');
    assert.equal(settled?.stripePaymentIntentId, 'pi_9e0f1a2b3c4d5e6f');
    assert.deepEqual(
      lines.filter((line) => ANALYTICS_SETTLED.test(line)),
      [`[purchase-analytics] ga4=failed:ga4_http_5xx transaction=${order.stripeSessionId}`],
    );
    assert.doesNotMatch(lines.join('\n'), new RegExp(`${MP_SECRET}|api_secret`));
  } finally {
    restore();
  }
});

test('hostile or stale signed metadata is dropped; the verified purchase still counts', async () => {
  const restore = setupStore();
  try {
    const order = await seedOrder('0f1a2b3c4d5e6f70');
    const metadata = {
      ...checkoutMetadata(order, capturedAgo(90 * DAY), capturedAgo(DAY)),
      gaClientId: 'zqx.parent.7731@example.invalid',
      hsbLtTrm: 'call ZQX 555 0100',
    };
    const { response, mp } = await runWebhook(completedEvent(order, metadata), { settledBy: NEWLY_PAID });

    assert.equal(response.status, 200);
    assert.equal(mp.length, 1);
    const payload = JSON.parse(mp[0].body);
    assert.match(payload.client_id, /^hsb\.[0-9a-f]{24}$/);
    const params = payload.events[0].params;
    assert.equal(params.transaction_id, order.stripeSessionId);
    assert.equal('session_id' in params, false, 'no session without its own client id');
    assert.equal(Object.keys(params).some((key) => key.startsWith('hsb_')), false, 'a stale first touch refuses the attribution');
    assert.doesNotMatch(mp[0].body, /ZQX|zqx|example\.invalid|call /);
  } finally {
    restore();
  }
});

test('the webhook source has no remaining direct GA4 scheduler and no replay-path purchase', () => {
  const route = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.doesNotMatch(route, /scheduleGa4Purchase/);
  assert.equal(route.match(/scheduleTrustedPurchaseAnalytics\(/g)?.length, 2, 'print-upgrade settlement + newly-paid transition');
  const replay = route.slice(route.indexOf('already processed'), route.indexOf("paymentStatus === 'refunded' || existing.refundedAt"));
  assert.ok(replay.length > 0);
  assert.doesNotMatch(replay, /scheduleTrustedPurchaseAnalytics/);
});
