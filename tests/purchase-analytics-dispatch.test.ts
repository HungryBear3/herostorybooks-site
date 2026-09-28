/**
 * The trusted purchase dispatcher the signed Stripe webhook schedules after a
 * durable settlement. It re-validates the settlement facts and the
 * provider-signed metadata, is production-gated and default-off, carries the
 * GA session continuity and bounded attribution, and turns every failure into
 * a typed, redacted outcome that can never reach payment or fulfillment.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchTrustedPurchaseAnalytics,
  readTrustedPurchaseAnalytics,
  scheduleTrustedPurchaseAnalytics,
  type TrustedPurchaseSettlement,
} from '../src/lib/purchase-analytics.ts';
import { processEnv } from './support/process-env.ts';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const SECRET = 'test-mp-secret-7731';
const PROD_ENV = processEnv({ VERCEL_ENV: 'production', GA4_MEASUREMENT_ID: 'G-68FKEDZEG3', GA4_API_SECRET: SECRET });
const CLIENT = '123456789.1727500000';

const METADATA = {
  orderId: 'ord_synthetic_mp',
  gaClientId: CLIENT,
  gaSessionId: '1727500000',
  gaSessionNumber: '3',
  hsbAttrV: '1',
  hsbFtSrc: 'facebook',
  hsbFtMed: 'paid_social',
  hsbFtCmp: '2026-10-gifts',
  hsbFtPath: '/gifts/birthdays',
  hsbFtAt: '2026-09-20T10:00:00.000Z',
  hsbLtSrc: 'newsletter',
  hsbLtMed: 'email',
  hsbLtPath: '/',
  hsbLtAt: '2026-09-27T10:00:00.000Z',
  customer_email: 'zqx.parent.7731@example.invalid',
  childName: 'ZQX-CHILD-7731',
};

const SETTLEMENT: TrustedPurchaseSettlement = {
  transactionId: 'cs_test_a1B2c3D4e5',
  amountCents: 1900,
  currency: 'usd',
  paymentStatus: 'paid',
  itemId: 'book_digital',
  metadata: METADATA,
};

function recordingFetch(status = 204) {
  const calls: Array<{ url: string; body: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body), init });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// ── Revalidation of provider-signed metadata ───────────────────────────────

test('provider-signed metadata is re-validated before any of it is trusted', () => {
  const attribution = {
    version: 1,
    firstTouch: {
      source: 'facebook', medium: 'paid_social', campaign: '2026-10-gifts', content: null, term: null,
      landingPath: '/gifts/birthdays', capturedAt: '2026-09-20T10:00:00.000Z',
    },
    lastNonDirectTouch: {
      source: 'newsletter', medium: 'email', campaign: null, content: null, term: null,
      landingPath: '/', capturedAt: '2026-09-27T10:00:00.000Z',
    },
  };
  assert.deepEqual(readTrustedPurchaseAnalytics(METADATA, NOW), {
    gaClientId: CLIENT, gaSessionId: '1727500000', gaSessionNumber: '3', attribution,
  });
  assert.deepEqual(
    readTrustedPurchaseAnalytics({ ...METADATA, gaClientId: 'zqx.parent.7731@example.invalid' }, NOW),
    { gaClientId: null, gaSessionId: null, gaSessionNumber: null, attribution },
    'a session never survives without the client it belongs to',
  );
  assert.deepEqual(
    readTrustedPurchaseAnalytics({ ...METADATA, gaSessionNumber: '3; drop' }, NOW),
    { gaClientId: CLIENT, gaSessionId: null, gaSessionNumber: null, attribution },
  );
  for (const bad of [null, undefined, 'gaClientId=1.2', ['x'], 7]) {
    assert.deepEqual(
      readTrustedPurchaseAnalytics(bad, NOW),
      { gaClientId: null, gaSessionId: null, gaSessionNumber: null, attribution: null },
      String(bad),
    );
  }
});

// ── The GA4 purchase ────────────────────────────────────────────────────────

test('a verified settlement sends one GA4 purchase with session continuity and bounded attribution', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const outcome = await dispatchTrustedPurchaseAnalytics(SETTLEMENT, { env: PROD_ENV, fetchImpl, now: NOW });

  assert.deepEqual(outcome, { status: 'sent' });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://www.google-analytics.com/mp/collect');
  assert.equal(url.searchParams.get('measurement_id'), 'G-68FKEDZEG3');
  assert.deepEqual(JSON.parse(calls[0].body), {
    client_id: CLIENT,
    events: [{
      name: 'purchase',
      params: {
        transaction_id: 'cs_test_a1B2c3D4e5',
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
  assert.doesNotMatch(calls[0].body, /ZQX|zqx|example\.invalid|ord_synthetic|customer_email|childName/);
  assert.ok(calls[0].init?.signal, 'every Measurement Protocol request carries a bounded abort signal');
});

test('a direct first touch is reported as direct; absent attribution adds no attribution params', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const directFirst = {
    orderId: 'ord_synthetic_mp', gaClientId: CLIENT, hsbAttrV: '1',
    hsbFtPath: '/pricing', hsbFtAt: '2026-09-20T10:00:00.000Z',
  };
  await dispatchTrustedPurchaseAnalytics({ ...SETTLEMENT, metadata: directFirst }, { env: PROD_ENV, fetchImpl, now: NOW });
  await dispatchTrustedPurchaseAnalytics({ ...SETTLEMENT, metadata: { orderId: 'ord_synthetic_mp', gaClientId: CLIENT } }, {
    env: PROD_ENV, fetchImpl, now: NOW,
  });
  const [withDirect, withNone] = calls.map((call) => JSON.parse(call.body).events[0].params);
  assert.equal(withDirect.hsb_ft_source, '(direct)');
  assert.equal(withDirect.hsb_ft_medium, '(none)');
  assert.equal(withDirect.hsb_ft_landing, '/pricing');
  assert.equal(Object.keys(withDirect).some((key) => key.startsWith('hsb_lt_')), false);
  assert.equal(Object.keys(withNone).some((key) => key.startsWith('hsb_')), false);
  assert.equal('session_id' in withNone, false);
});

test('session continuity is sent only to the property that issued the session cookie', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const otherProperty = processEnv({ VERCEL_ENV: 'production', GA4_MEASUREMENT_ID: 'G-OTHERPROP1', GA4_API_SECRET: SECRET });
  assert.deepEqual(await dispatchTrustedPurchaseAnalytics(SETTLEMENT, { env: otherProperty, fetchImpl, now: NOW }), { status: 'sent' });
  const params = JSON.parse(calls[0].body).events[0].params;
  assert.equal('session_id' in params, false);
  assert.equal('session_number' in params, false);
  assert.equal(params.transaction_id, 'cs_test_a1B2c3D4e5');
});

test('without a real GA client id the session is withheld and a transaction-scoped id is used', async () => {
  const { calls, fetchImpl } = recordingFetch();
  const { gaClientId: _client, ...noClient } = METADATA;
  await dispatchTrustedPurchaseAnalytics({ ...SETTLEMENT, metadata: noClient }, { env: PROD_ENV, fetchImpl, now: NOW });
  const payload = JSON.parse(calls[0].body);
  assert.match(payload.client_id, /^hsb\.[0-9a-f]{24}$/);
  assert.equal('session_id' in payload.events[0].params, false);
});

test('nothing is sent outside production or without configuration', async () => {
  const cases: Array<[string, NodeJS.ProcessEnv, string]> = [
    ['preview', processEnv({ VERCEL_ENV: 'preview', GA4_MEASUREMENT_ID: 'G-68FKEDZEG3', GA4_API_SECRET: SECRET }), 'not_production'],
    ['development', processEnv({ VERCEL_ENV: 'development', GA4_MEASUREMENT_ID: 'G-68FKEDZEG3', GA4_API_SECRET: SECRET }), 'not_production'],
    ['no deployment environment', processEnv({ GA4_MEASUREMENT_ID: 'G-68FKEDZEG3', GA4_API_SECRET: SECRET }), 'not_production'],
    ['no api secret', processEnv({ VERCEL_ENV: 'production', GA4_MEASUREMENT_ID: 'G-68FKEDZEG3' }), 'not_configured'],
    ['no measurement id', processEnv({ VERCEL_ENV: 'production', GA4_API_SECRET: SECRET }), 'not_configured'],
  ];
  for (const [label, env, reason] of cases) {
    const { calls, fetchImpl } = recordingFetch();
    assert.deepEqual(
      await dispatchTrustedPurchaseAnalytics(SETTLEMENT, { env, fetchImpl, now: NOW }),
      { status: 'skipped', reason },
      label,
    );
    assert.equal(calls.length, 0, label);
  }
});

test('an unverifiable settlement is refused before any transport', async () => {
  const cases: Array<Partial<TrustedPurchaseSettlement>> = [
    { transactionId: 'pi_3Abc123' },
    { transactionId: 'cs_test_' },
    { transactionId: 'cs_test_a/../b' },
    { amountCents: -1 },
    { amountCents: 19.5 },
    { amountCents: null },
    { currency: 'eur' },
    { currency: null },
    { paymentStatus: 'unpaid' },
    { paymentStatus: 'no_payment_required' },
    { itemId: 'book_deluxe' },
    { itemId: 'zqx.parent.7731@example.invalid' },
  ];
  for (const override of cases) {
    const { calls, fetchImpl } = recordingFetch();
    assert.deepEqual(
      await dispatchTrustedPurchaseAnalytics({ ...SETTLEMENT, ...override }, { env: PROD_ENV, fetchImpl, now: NOW }),
      { status: 'skipped', reason: 'unverified_settlement' },
      JSON.stringify(override),
    );
    assert.equal(calls.length, 0, JSON.stringify(override));
  }
  const { calls, fetchImpl } = recordingFetch();
  assert.deepEqual(
    await dispatchTrustedPurchaseAnalytics(
      { ...SETTLEMENT, amountCents: 0, paymentStatus: 'no_payment_required', itemId: 'print_upgrade_premium' },
      { env: PROD_ENV, fetchImpl, now: NOW },
    ),
    { status: 'sent' },
    'a zero-amount promotion completion remains measurable',
  );
  const params = JSON.parse(calls[0].body).events[0].params;
  assert.equal(params.value, 0);
  assert.deepEqual(params.items, [{ item_id: 'print_upgrade_premium', item_name: 'Print upgrade: premium', price: 0, quantity: 1 }]);
});

test('transport failures are typed and redacted, and never thrown', async () => {
  const cases: Array<[typeof fetch, Record<string, unknown>]> = [
    [(async () => new Response('bad', { status: 500 })) as typeof fetch, { status: 'failed', code: 'ga4_http_5xx' }],
    [(async () => new Response('bad', { status: 400 })) as typeof fetch, { status: 'failed', code: 'ga4_http_4xx' }],
    [(async () => {
      throw new TypeError(`fetch failed https://www.google-analytics.com/mp/collect?api_secret=${SECRET}`);
    }) as typeof fetch, { status: 'failed', code: 'ga4_network' }],
  ];
  for (const [fetchImpl, expected] of cases) {
    const outcome = await dispatchTrustedPurchaseAnalytics(SETTLEMENT, { env: PROD_ENV, fetchImpl, now: NOW });
    assert.deepEqual(outcome, expected);
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(SECRET));
  }
});

test('a hung Measurement Protocol request is aborted at the bounded timeout', async () => {
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })) as typeof fetch;
  const started = Date.now();
  const outcome = await dispatchTrustedPurchaseAnalytics(SETTLEMENT, { env: PROD_ENV, fetchImpl, now: NOW, timeoutMs: 50 });
  assert.deepEqual(outcome, { status: 'failed', code: 'ga4_timeout' });
  assert.ok(Date.now() - started < 2_000);
});

// ── Scheduling ──────────────────────────────────────────────────────────────

test('scheduling defers past the response and runs exactly once across both schedulers', async () => {
  const immediates: Array<() => void> = [];
  const afters: Array<() => void | Promise<void>> = [];
  const lines: string[] = [];
  const { calls, fetchImpl } = recordingFetch();
  scheduleTrustedPurchaseAnalytics(SETTLEMENT, {
    env: PROD_ENV,
    fetchImpl,
    now: NOW,
    setImmediateImpl: (callback) => { immediates.push(callback); },
    afterImpl: (callback) => { afters.push(callback); },
    log: (line) => { lines.push(line); },
  });
  assert.equal(calls.length, 0, 'nothing runs before the webhook responds');
  assert.equal(immediates.length, 1);
  assert.equal(afters.length, 1);

  immediates[0]();
  await afters[0]();
  assert.equal(calls.length, 1, 'the second scheduler joins the first run instead of sending again');
  assert.deepEqual(lines, ['[purchase-analytics] ga4=sent transaction=cs_test_a1B2c3D4e5']);
});

test('an unavailable after() and a failing transport never escape into the webhook', async () => {
  const lines: string[] = [];
  let ran: Promise<void> | undefined;
  assert.doesNotThrow(() => scheduleTrustedPurchaseAnalytics(SETTLEMENT, {
    env: PROD_ENV,
    fetchImpl: (async () => { throw new Error(`boom api_secret=${SECRET}`); }) as typeof fetch,
    now: NOW,
    setImmediateImpl: (callback) => { ran = Promise.resolve().then(callback); },
    afterImpl: () => { throw new Error('`after` was called outside a request scope'); },
    log: (line) => { lines.push(line); },
  }));
  await ran;
  for (let i = 0; i < 20 && lines.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(lines, ['[purchase-analytics] ga4=failed:ga4_network transaction=cs_test_a1B2c3D4e5']);
  assert.doesNotMatch(lines.join('\n'), new RegExp(`${SECRET}|api_secret|boom`));
});

test('a skipped dispatch is logged with its typed reason', async () => {
  const lines: string[] = [];
  let ran: Promise<void> | undefined;
  scheduleTrustedPurchaseAnalytics({ ...SETTLEMENT, paymentStatus: 'unpaid' }, {
    env: PROD_ENV,
    now: NOW,
    setImmediateImpl: (callback) => { ran = Promise.resolve().then(callback); },
    afterImpl: null,
    log: (line) => { lines.push(line); },
  });
  await ran;
  for (let i = 0; i < 20 && lines.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(lines, ['[purchase-analytics] ga4=skipped:unverified_settlement transaction=cs_test_a1B2c3D4e5']);
});
