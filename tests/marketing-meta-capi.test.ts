import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  META_CAPI_ACCESS_TOKEN_ENV,
  META_CAPI_DATASET_ID_ENV,
  META_CAPI_FLAG_ENV,
  META_EVENT_SOURCE_URL,
  META_GRAPH_API_VERSION,
  buildMetaCapiPurchaseEvent,
  deriveMetaEventId,
  resolveMetaCapiConfig,
  scheduleMetaCapiPurchase,
  sendMetaCapiPurchase,
  type MetaCapiPurchaseInput,
} from '../src/lib/marketing/meta-capi.ts';

const CONFIGURED = {
  [META_CAPI_FLAG_ENV]: 'true',
  [META_CAPI_DATASET_ID_ENV]: '987654321098765',
  [META_CAPI_ACCESS_TOKEN_ENV]: 'test-token-not-a-real-secret',
} as unknown as NodeJS.ProcessEnv;

const PAID: MetaCapiPurchaseInput = {
  stripeSessionId: 'cs_live_a1b2c3d4e5f60718',
  amountCents: 6400,
  currency: 'usd',
  contentId: 'book_premium',
  paymentStatus: 'paid',
  eventTimeSeconds: 1_790_000_000,
};

function capture() {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

// ── Disabled by default ─────────────────────────────────────────────────────

test('with no configuration nothing is built and no request is made', async () => {
  const { requests, fetchImpl } = capture();
  assert.equal(await sendMetaCapiPurchase(PAID, { env: {} as unknown as NodeJS.ProcessEnv, fetchImpl }), 'skipped');
  assert.equal(requests.length, 0);
});

test('every environment variable is required, and the flag must be exactly true', async () => {
  const partials: NodeJS.ProcessEnv[] = [
    { ...CONFIGURED, [META_CAPI_FLAG_ENV]: 'false' },
    { ...CONFIGURED, [META_CAPI_FLAG_ENV]: '1' },
    { ...CONFIGURED, [META_CAPI_FLAG_ENV]: undefined },
    { ...CONFIGURED, [META_CAPI_DATASET_ID_ENV]: '' },
    { ...CONFIGURED, [META_CAPI_DATASET_ID_ENV]: 'not-numeric' },
    { ...CONFIGURED, [META_CAPI_ACCESS_TOKEN_ENV]: '' },
  ];
  for (const env of partials) {
    assert.equal(resolveMetaCapiConfig(env), null, JSON.stringify(env[META_CAPI_FLAG_ENV] ?? 'unset'));
    const { requests, fetchImpl } = capture();
    assert.equal(await sendMetaCapiPurchase(PAID, { env, fetchImpl }), 'skipped');
    assert.equal(requests.length, 0);
  }
});

test('the endpoint is pinned to one Graph API version and built from the dataset id', () => {
  const config = resolveMetaCapiConfig(CONFIGURED)!;
  assert.equal(config.endpoint, `https://graph.facebook.com/${META_GRAPH_API_VERSION}/987654321098765/events`);
});

// ── Only the trusted paid path ──────────────────────────────────────────────

test('unpaid, pending, and unknown payment states are never a purchase', async () => {
  for (const paymentStatus of ['unpaid', 'pending', 'processing', null, undefined, '']) {
    const { requests, fetchImpl } = capture();
    assert.equal(
      await sendMetaCapiPurchase({ ...PAID, paymentStatus }, { env: CONFIGURED, fetchImpl, sentEventIds: new Set() }),
      'skipped',
      String(paymentStatus),
    );
    assert.equal(requests.length, 0);
  }
});

test('paid and no_payment_required are the only accepted states, matching GA4', async () => {
  for (const paymentStatus of ['paid', 'no_payment_required']) {
    const { requests, fetchImpl } = capture();
    assert.equal(
      await sendMetaCapiPurchase({ ...PAID, paymentStatus }, { env: CONFIGURED, fetchImpl, sentEventIds: new Set() }),
      'sent',
    );
    assert.equal(requests.length, 1);
  }
});

// ── Payload contents ────────────────────────────────────────────────────────

test('the payload carries value, currency, and a product content id, and nothing else', () => {
  const payload = buildMetaCapiPurchaseEvent(PAID);
  assert.deepEqual(Object.keys(payload), ['data']);
  assert.equal(payload.data.length, 1);
  assert.deepEqual(Object.keys(payload.data[0]).sort(), [
    'action_source', 'custom_data', 'event_id', 'event_name', 'event_source_url', 'event_time',
  ]);
  assert.equal(payload.data[0].event_name, 'Purchase');
  assert.equal(payload.data[0].action_source, 'website');
  assert.equal(payload.data[0].event_source_url, META_EVENT_SOURCE_URL);
  assert.deepEqual(payload.data[0].custom_data, {
    currency: 'USD', value: 64, content_ids: ['book_premium'], content_type: 'product',
  });
});

test('no user_data, no identity, no order or session identifier reaches the wire', async () => {
  const { requests, fetchImpl } = capture();
  await sendMetaCapiPurchase(PAID, { env: CONFIGURED, fetchImpl, sentEventIds: new Set() });
  const body = String(requests[0].init.body);
  for (const banned of [
    'user_data', 'external_id', 'client_ip_address', 'client_user_agent',
    'cs_live_a1b2c3d4e5f60718', 'transaction_id', 'orderId', 'order_id',
    'email', 'childName', 'shipping', 'address',
  ]) {
    assert.equal(body.includes(banned), false, `${banned} appeared in the CAPI body`);
  }
  // Meta's Advanced Matching keys are two or three letters, so a substring
  // search would trip on 'premium' and 'event_name'. Check them as JSON keys.
  for (const key of ['em', 'ph', 'fn', 'ln', 'ge', 'db', 'ct', 'st', 'zp', 'fbp', 'fbc']) {
    assert.equal(body.includes(`"${key}"`), false, `${key} appeared as a CAPI field`);
  }
  // The access token travels in a header, never in the URL.
  assert.equal(requests[0].url.includes('test-token-not-a-real-secret'), false);
  assert.equal(
    (requests[0].init.headers as Record<string, string>).authorization,
    'Bearer test-token-not-a-real-secret',
  );
});

test('a content id that looks like an identifier is refused rather than sent', () => {
  assert.throws(
    () => buildMetaCapiPurchaseEvent({ ...PAID, contentId: 'ord_synthetic0001' }),
    /Meta payload rejected/,
  );
  assert.throws(
    () => buildMetaCapiPurchaseEvent({ ...PAID, contentId: 'parent@example.com' }),
    /Meta payload rejected/,
  );
});

test('zero-dollar promotion purchases stay measurable and negative amounts floor at zero', () => {
  assert.equal(buildMetaCapiPurchaseEvent({ ...PAID, amountCents: 0 }).data[0].custom_data.value, 0);
  assert.equal(buildMetaCapiPurchaseEvent({ ...PAID, amountCents: -500 }).data[0].custom_data.value, 0);
});

// ── Deduplication and idempotency ───────────────────────────────────────────

test('the event id is stable per session, different across sessions, and not the session id', () => {
  const id = deriveMetaEventId('cs_live_a1b2c3d4e5f60718');
  assert.equal(id, deriveMetaEventId('cs_live_a1b2c3d4e5f60718'));
  assert.notEqual(id, deriveMetaEventId('cs_live_different'));
  assert.equal(id.includes('cs_live'), false);
  assert.match(id, /^hsb_[0-9a-f]{32}$/);
});

test('a webhook replay reuses the same event_id so Meta can deduplicate', async () => {
  const { requests, fetchImpl } = capture();
  const seen = new Set<string>();
  await sendMetaCapiPurchase(PAID, { env: CONFIGURED, fetchImpl, sentEventIds: seen });
  // Second delivery of the same Stripe session, in a fresh runtime.
  await sendMetaCapiPurchase(PAID, { env: CONFIGURED, fetchImpl, sentEventIds: new Set() });
  assert.equal(requests.length, 2);
  const ids = requests.map((r) => JSON.parse(String(r.init.body)).data[0].event_id);
  assert.equal(ids[0], ids[1]);
});

test('within one runtime a repeated send is refused outright', async () => {
  const { requests, fetchImpl } = capture();
  const seen = new Set<string>();
  assert.equal(await sendMetaCapiPurchase(PAID, { env: CONFIGURED, fetchImpl, sentEventIds: seen }), 'sent');
  assert.equal(await sendMetaCapiPurchase(PAID, { env: CONFIGURED, fetchImpl, sentEventIds: seen }), 'duplicate');
  assert.equal(requests.length, 1);
});

test('a failed send does not burn the event id, so a later delivery can still report it', async () => {
  const seen = new Set<string>();
  await assert.rejects(() => sendMetaCapiPurchase(PAID, {
    env: CONFIGURED, sentEventIds: seen,
    fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
  }));
  assert.equal(seen.size, 0);
  const { requests, fetchImpl } = capture();
  assert.equal(await sendMetaCapiPurchase(PAID, { env: CONFIGURED, fetchImpl, sentEventIds: seen }), 'sent');
  assert.equal(requests.length, 1);
});

// ── Failure containment ─────────────────────────────────────────────────────

test('the request is bounded by an abort signal', async () => {
  let signal: AbortSignal | undefined;
  await sendMetaCapiPurchase(PAID, {
    env: CONFIGURED, sentEventIds: new Set(), timeoutMs: 5,
    fetchImpl: (async (_i: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.ok(signal instanceof AbortSignal);
});

test('a timeout aborts and is swallowed by the scheduler, never reaching the caller', async () => {
  let callback: (() => void | Promise<void>) | undefined;
  const warnings: unknown[][] = [];
  scheduleMetaCapiPurchase(PAID, (cb) => { callback = cb; }, {
    env: CONFIGURED, sentEventIds: new Set(), timeoutMs: 5,
    fetchImpl: ((_i: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch,
    log: { warn: (...args: unknown[]) => { warnings.push(args); } },
  });
  await assert.doesNotReject(() => Promise.resolve(callback!()));
  assert.equal(warnings.length, 1);
});

test('network and HTTP failures are swallowed and logged without an identifier', async () => {
  for (const fetchImpl of [
    (async () => { throw new Error('network down'); }) as unknown as typeof fetch,
    (async () => new Response(null, { status: 400 })) as unknown as typeof fetch,
  ]) {
    let callback: (() => void | Promise<void>) | undefined;
    const warnings: unknown[][] = [];
    scheduleMetaCapiPurchase(PAID, (cb) => { callback = cb; }, {
      env: CONFIGURED, fetchImpl, sentEventIds: new Set(),
      log: { warn: (...args: unknown[]) => { warnings.push(args); } },
    });
    await assert.doesNotReject(() => Promise.resolve(callback!()));
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes('cs_live_a1b2c3d4e5f60718'), false);
  }
});

test('a scheduler that throws is swallowed synchronously, exactly like the GA4 path', () => {
  const warnings: unknown[][] = [];
  assert.doesNotThrow(() => scheduleMetaCapiPurchase(PAID, () => { throw new Error('after unavailable'); }, {
    env: CONFIGURED, log: { warn: (...args: unknown[]) => { warnings.push(args); } },
  }));
  assert.equal(warnings.length, 1);
});

test('scheduling never awaits: the webhook path is not held open', () => {
  let scheduled = false;
  scheduleMetaCapiPurchase(PAID, () => { scheduled = true; }, {
    env: CONFIGURED, sentEventIds: new Set(),
    fetchImpl: (async () => { throw new Error('must not run inline'); }) as unknown as typeof fetch,
  });
  assert.equal(scheduled, true);
});

// ── Server-only, by construction ────────────────────────────────────────────

test('no CAPI environment name is NEXT_PUBLIC_, and the module is never imported by client code', () => {
  for (const name of [META_CAPI_DATASET_ID_ENV, META_CAPI_ACCESS_TOKEN_ENV, META_CAPI_FLAG_ENV]) {
    assert.equal(name.startsWith('NEXT_PUBLIC_'), false, name);
  }
  const clientModules = [
    '../src/lib/marketing/meta-pixel.ts',
    '../src/lib/marketing/meta-bridge.ts',
    '../src/components/marketing/meta-pixel-mount.tsx',
    '../src/lib/analytics.ts',
  ];
  for (const relative of clientModules) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.equal(source.includes('meta-capi'), false, `${relative} imports the server CAPI module`);
    assert.equal(source.includes('META_CAPI'), false, `${relative} references a server CAPI env name`);
  }
});
