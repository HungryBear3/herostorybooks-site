import test from 'node:test';
import assert from 'node:assert/strict';

import { scheduleGa4Purchase, sendGa4Purchase } from '../src/lib/ga4-purchase.ts';

const configuredEnv = {
  GA4_MEASUREMENT_ID: 'G-TEST123',
  GA4_API_SECRET: 'secret',
} as NodeJS.ProcessEnv;

test('sends a recommended purchase event using trusted cents and no PII', async () => {
  let request: { url: string; body: string } | undefined;
  const result = await sendGa4Purchase({
    transactionId: 'cs_live_stable',
    amountCents: 1999,
    currency: 'usd',
    itemId: 'book_digital',
    itemName: 'HeroStoryBooks digital',
    paymentStatus: 'paid',
  }, {
    env: configuredEnv,
    fetchImpl: async (input, init) => {
      request = { url: String(input), body: String(init?.body) };
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(result, 'sent');
  assert.match(request!.url, /measurement_id=G-TEST123/);
  const payload = JSON.parse(request!.body);
  assert.equal(payload.events[0].name, 'purchase');
  assert.equal(payload.events[0].params.transaction_id, 'cs_live_stable');
  assert.equal(payload.events[0].params.value, 19.99);
  assert.equal(payload.events[0].params.currency, 'USD');
  assert.equal(payload.events[0].params.items[0].item_id, 'book_digital');
  assert.doesNotMatch(request!.body, /email|child|customer|shipping/i);
});

test('unpaid sessions and missing configuration are no-ops', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(null, { status: 204 }); };
  assert.equal(await sendGa4Purchase({
    transactionId: 'cs_unpaid', amountCents: 1900, itemId: 'book_digital',
    itemName: 'HeroStoryBooks digital', paymentStatus: 'unpaid',
  }, { env: configuredEnv, fetchImpl }), 'skipped');
  assert.equal(await sendGa4Purchase({
    transactionId: 'cs_paid', amountCents: 1900, itemId: 'book_digital',
    itemName: 'HeroStoryBooks digital', paymentStatus: 'paid',
  }, { env: {}, fetchImpl }), 'skipped');
  assert.equal(calls, 0);
});

test('zero-dollar promotion-completed sessions remain measurable', async () => {
  let calls = 0;
  await sendGa4Purchase({
    transactionId: 'cs_zero', amountCents: 0, itemId: 'book_premium',
    itemName: 'HeroStoryBooks premium', paymentStatus: 'no_payment_required',
  }, { env: configuredEnv, fetchImpl: async () => { calls += 1; return new Response(null, { status: 204 }); } });
  assert.equal(calls, 1);
});

test('replays use the same transaction_id so GA4 can deduplicate purchase revenue', async () => {
  const ids: string[] = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    ids.push(JSON.parse(String(init?.body)).events[0].params.transaction_id);
    return new Response(null, { status: 204 });
  };
  const input = { transactionId: 'cs_replay', amountCents: 4500, itemId: 'upgrade_premium', itemName: 'Print upgrade', paymentStatus: 'paid' };
  await sendGa4Purchase(input, { env: configuredEnv, fetchImpl });
  await sendGa4Purchase(input, { env: configuredEnv, fetchImpl });
  assert.deepEqual(ids, ['cs_replay', 'cs_replay']);
});

test('scheduled network failures are swallowed and never escape into payment flow', async () => {
  let callback: (() => void | Promise<void>) | undefined;
  const warnings: unknown[][] = [];
  scheduleGa4Purchase({
    transactionId: 'cs_failure', amountCents: 1900, itemId: 'book_digital',
    itemName: 'HeroStoryBooks digital', paymentStatus: 'paid',
  }, (cb) => { callback = cb; }, {
    env: configuredEnv,
    fetchImpl: async () => { throw new Error('network down'); },
    log: { warn: (...args: unknown[]) => { warnings.push(args); } },
  });
  await assert.doesNotReject(() => callback!());
  assert.equal(warnings.length, 1);
});

test('a scheduler failure is also swallowed synchronously', () => {
  const warnings: unknown[][] = [];
  assert.doesNotThrow(() => scheduleGa4Purchase({
    transactionId: 'cs_scheduler_failure', amountCents: 1900, itemId: 'book_digital',
    itemName: 'HeroStoryBooks digital', paymentStatus: 'paid',
  }, () => { throw new Error('after unavailable'); }, {
    env: configuredEnv,
    log: { warn: (...args: unknown[]) => { warnings.push(args); } },
  }));
  assert.equal(warnings.length, 1);
});
