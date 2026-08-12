import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createOrderRecord,
  getOrderAuthoritative,
  persistOrder,
  type OrderRecord,
  updateOrderPayment,
  withOrderTransaction,
} from '../src/lib/orders.ts';
import { triggerFulfillment, type TriggerResult } from '../src/lib/fulfillment.ts';
import {
  evaluateFulfillmentSweepEligibility,
  runFulfillmentSweep,
  type FulfillmentSweepDeps,
} from '../src/lib/fulfillment-sweep.ts';
import {
  GET as getFulfillmentSweepRoute,
  __setFulfillmentSweepRouteDepsForTests,
  __resetFulfillmentSweepRouteDepsForTests,
} from '../src/app/api/cron/fulfillment-sweep/route.ts';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function localStore<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-fulfillment-sweep-'));
  return withEnv(
    {
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
      BLOB_READ_WRITE_TOKEN: undefined,
      HSB_ORDER_STORE_DIR: dir,
      VERCEL: undefined,
      NODE_ENV: 'development',
    },
    fn,
  ).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makeSweepOrder(
  partial: Partial<OrderRecord> & { id: string },
  nowMs = Date.parse('2026-08-12T18:00:00.000Z'),
): OrderRecord {
  return {
    id: partial.id,
    childName: 'Milo',
    bookFormat: 'digital',
    formatLabel: 'Digital proof',
    priceCents: 1900,
    email: 'buyer@example.com',
    status: 'order_received',
    paymentStatus: 'paid',
    fulfillmentMode: 'auto',
    fulfillmentStatus: 'not_started',
    paidAt: new Date(nowMs - 30 * 60 * 1000).toISOString(),
    createdAt: new Date(nowMs - 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(nowMs - 30 * 60 * 1000).toISOString(),
    deliveryExpectation: 'Digital proof usually ready soon.',
    ...partial,
  } as OrderRecord;
}

test.afterEach(() => {
  __resetFulfillmentSweepRouteDepsForTests();
});

test('authoritative read returns the freshly-written paid order even if the public URL is still stale pending bytes', async () => {
  const paidBody = JSON.stringify({ id: 'ord_auth', paymentStatus: 'paid', paidAt: '2026-08-12T16:39:24.566Z' });
  const order = await withEnv({
    BLOB_READ_WRITE_TOKEN: 'blob_rw_test',
    HSB_BLOB_ACCESS_MODE: 'public',
  }, () => getOrderAuthoritative('ord_auth', {
    listImpl: async () => ({
      blobs: [{
        pathname: 'orders/ord_auth.json',
        url: 'https://public.example/orders/ord_auth.json',
        downloadUrl: 'https://download.example/orders/ord_auth.json?download=1',
        etag: '"paid-etag"',
      }],
    }),
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.startsWith('https://download.example/')) {
        return new Response(paidBody, { status: 200, headers: { etag: '"paid-etag"' } });
      }
      return new Response(JSON.stringify({ id: 'ord_auth', paymentStatus: 'pending' }), {
        status: 200,
        headers: { etag: '"pending-etag"' },
      });
    },
  }));

  assert.equal(order?.paymentStatus, 'paid');
  assert.equal(order?.paidAt, '2026-08-12T16:39:24.566Z');
});

test('triggerFulfillment uses a durable claim so concurrent callers do not double-start the same paid not_started order', async () => {
  await localStore(async () => {
    const base = createOrderRecord(
      { childName: 'Milo', bookFormat: 'digital', email: 'buyer@example.com' },
      { id: 'ord_claim', fulfillmentMode: 'auto' },
    );
    await persistOrder(base);
    await updateOrderPayment('ord_claim', 'paid', { stripeSessionId: 'cs_test_claim' });

    let storyCalls = 0;
    let releaseStory: (() => void) | null = null;
    const blockStory = new Promise<void>((resolve) => {
      releaseStory = resolve;
    });

    const deps = {
      generateStory: async () => {
        storyCalls += 1;
        await blockStory;
        return {
          title: 'T',
          characterDescription: 'C',
          pages: Array.from({ length: 24 }, (_, index) => ({
            pageNum: index + 1,
            sceneTitle: `Scene ${index + 1}`,
            story: `Story ${index + 1}`,
            imagePrompt: `Prompt ${index + 1}`,
          })),
        };
      },
      generateImages: async (prompts: string[]) => prompts.map((_prompt, index) => `https://img/${index}`),
      buildPdf: async () => Buffer.from('pdf'),
      uploadArtifact: async (_orderId: string, _buffer: Buffer, filename: string) => `https://artifact/${filename}`,
    };

    const first = triggerFulfillment('ord_claim', deps);
    const second = triggerFulfillment('ord_claim', deps);
    await new Promise((resolve) => setImmediate(resolve));
    releaseStory?.();

    const results = await Promise.all([first, second]);
    const statuses = results.map((result) => result.status).sort();

    assert.equal(storyCalls, 1);
    assert.deepEqual(statuses, ['skipped_already_running', 'started']);
  });
});

test('replacement claim fences the old worker before PDF, upload, email, or state commit', async () => {
  await localStore(async () => {
    const base = createOrderRecord(
      { childName: 'Milo', bookFormat: 'digital', email: 'buyer@example.com' },
      { id: 'ord_takeover', fulfillmentMode: 'auto' },
    );
    await persistOrder(base);
    await updateOrderPayment('ord_takeover', 'paid', { stripeSessionId: 'cs_test_takeover' });

    let releaseStory: (() => void) | null = null;
    const blockedStory = new Promise<void>((resolve) => { releaseStory = resolve; });
    let storyStarted: (() => void) | null = null;
    const enteredStory = new Promise<void>((resolve) => { storyStarted = resolve; });
    let pdfCalls = 0;
    let uploadCalls = 0;

    const running = triggerFulfillment('ord_takeover', {
      generateStory: async () => {
        storyStarted?.();
        await blockedStory;
        return {
          title: 'T', characterDescription: 'C',
          pages: Array.from({ length: 24 }, (_, index) => ({
            pageNum: index + 1, sceneTitle: `Scene ${index + 1}`,
            story: `Story ${index + 1}`, imagePrompt: `Prompt ${index + 1}`,
          })),
        };
      },
      generateImages: async (prompts: string[]) => prompts.map((_prompt, index) => `https://img/${index}`),
      buildPdf: async () => { pdfCalls += 1; return Buffer.from('pdf'); },
      uploadArtifact: async () => { uploadCalls += 1; return 'https://artifact/stale.pdf'; },
      sleep: async () => {},
    });

    await enteredStory;
    await withOrderTransaction('ord_takeover', (current) => {
      const replacement = {
        ...current,
        fulfillmentKickoffId: 'replacement-claim',
        fulfillmentKickoffAt: new Date().toISOString(),
        fulfillmentStatus: 'generating_story' as const,
      };
      return { commit: replacement, result: replacement };
    });
    releaseStory?.();
    await running;

    const final = await getOrderAuthoritative('ord_takeover');
    assert.equal(pdfCalls, 0);
    assert.equal(uploadCalls, 0);
    assert.equal(final?.fulfillmentKickoffId, 'replacement-claim');
    assert.equal(final?.fulfillmentStatus, 'generating_story');
    assert.equal(final?.storyArtifactUrl ?? null, null);
    assert.equal(final?.fulfillmentLastError ?? null, null);
  });
});

test('failed_manual_review cannot be auto-restarted without an explicit admin reset', async () => {
  await localStore(async () => {
    const base = createOrderRecord(
      { childName: 'Milo', bookFormat: 'digital', email: 'buyer@example.com' },
      { id: 'ord_manual_review', fulfillmentMode: 'auto' },
    );
    await persistOrder({
      ...base,
      paymentStatus: 'paid',
      paidAt: '2026-08-12T16:00:00.000Z',
      fulfillmentStatus: 'failed_manual_review',
    });

    let storyCalls = 0;
    const result = await triggerFulfillment('ord_manual_review', {
      generateStory: async () => {
        storyCalls += 1;
        throw new Error('must not run');
      },
    });

    assert.equal(result.status, 'skipped_already_running');
    assert.equal(result.fulfillmentStatus, 'failed_manual_review');
    assert.equal(storyCalls, 0);
  });
});

test('claim boundary refuses paid manual-held and internally disposed orders', async () => {
  await localStore(async () => {
    const candidates = [
      { id: 'ord_held', fulfillmentMode: 'manual_hold' as const, internalDisposition: null },
      { id: 'ord_disposed', fulfillmentMode: 'auto' as const, internalDisposition: 'test_archived' as const },
    ];
    for (const candidate of candidates) {
      const base = createOrderRecord(
        { childName: 'Milo', bookFormat: 'digital', email: 'buyer@example.com' },
        { id: candidate.id, fulfillmentMode: candidate.fulfillmentMode },
      );
      await persistOrder({ ...base, internalDisposition: candidate.internalDisposition });
      await updateOrderPayment(candidate.id, 'paid');
      let storyCalls = 0;
      const result = await triggerFulfillment(candidate.id, {
        generateStory: async () => { storyCalls += 1; throw new Error('must not run'); },
      }, { readbackMaxAttempts: 1, readbackInitialDelayMs: 0 });
      assert.equal(result.status, 'skipped_already_running');
      assert.equal(storyCalls, 0);
    }
  });
});

test('sweep eligibility includes only paid, old enough, effectively not_started orders and skips terminal/in-progress/manual-hold states', () => {
  const nowMs = Date.parse('2026-08-12T18:00:00.000Z');
  const cfg = { nowMs, graceMs: 10 * 60 * 1000 };

  assert.equal(
    evaluateFulfillmentSweepEligibility(makeSweepOrder({ id: 'eligible' }, nowMs), cfg).eligible,
    true,
  );
  assert.equal(
    evaluateFulfillmentSweepEligibility(makeSweepOrder({ id: 'unset', fulfillmentStatus: undefined }, nowMs), cfg).eligible,
    true,
  );
  assert.equal(
    evaluateFulfillmentSweepEligibility(makeSweepOrder({ id: 'legacy', fulfillmentMode: undefined }, nowMs), cfg).eligible,
    false,
  );

  for (const order of [
    makeSweepOrder({ id: 'recent', paidAt: new Date(nowMs - 5 * 60 * 1000).toISOString() }, nowMs),
    makeSweepOrder({ id: 'pending', paymentStatus: 'pending' }, nowMs),
    makeSweepOrder({ id: 'refunded', refundedAt: new Date(nowMs - 1_000).toISOString() }, nowMs),
    makeSweepOrder({ id: 'held', fulfillmentMode: 'manual_hold' }, nowMs),
    makeSweepOrder({ id: 'story', fulfillmentStatus: 'generating_story' }, nowMs),
    makeSweepOrder({ id: 'images', fulfillmentStatus: 'generating_images' }, nowMs),
    makeSweepOrder({ id: 'pdf', fulfillmentStatus: 'building_pdf' }, nowMs),
    makeSweepOrder({ id: 'proof', fulfillmentStatus: 'proof_ready' }, nowMs),
    makeSweepOrder({ id: 'approved', fulfillmentStatus: 'proof_approved' }, nowMs),
    makeSweepOrder({ id: 'print', fulfillmentStatus: 'submitting_to_print' }, nowMs),
    makeSweepOrder({ id: 'complete', fulfillmentStatus: 'complete' }, nowMs),
    makeSweepOrder({ id: 'email', fulfillmentStatus: 'delivery_email_failed' }, nowMs),
    makeSweepOrder({ id: 'manual', fulfillmentStatus: 'failed_manual_review' }, nowMs),
  ]) {
    assert.equal(
      evaluateFulfillmentSweepEligibility(order, cfg).eligible,
      false,
      `expected ${order.id} to be skipped`,
    );
  }

  assert.equal(
    evaluateFulfillmentSweepEligibility(makeSweepOrder({
      id: 'active-lease',
      fulfillmentStatus: 'generating_story',
      fulfillmentKickoffId: 'run-1',
      fulfillmentKickoffAt: new Date(nowMs - 2 * 60 * 1000).toISOString(),
    }, nowMs), cfg).eligible,
    false,
  );
  assert.equal(
    evaluateFulfillmentSweepEligibility(makeSweepOrder({
      id: 'expired-lease',
      fulfillmentStatus: 'generating_story',
      fulfillmentKickoffId: 'run-1',
      fulfillmentKickoffAt: new Date(nowMs - 7 * 60 * 1000).toISOString(),
    }, nowMs), cfg).eligible,
    true,
  );
});

test('sweep isolates per-order failures and starts independent eligible orders', async () => {
  const orders = [
    makeSweepOrder({ id: 'ord_a' }),
    makeSweepOrder({ id: 'ord_b' }),
    makeSweepOrder({ id: 'ord_skip', fulfillmentStatus: 'proof_ready' }),
  ];
  const started: string[] = [];
  const errors: string[] = [];

  const deps: FulfillmentSweepDeps = {
    listOrders: async () => orders,
    triggerFulfillment: async (orderId: string): Promise<TriggerResult> => {
      if (orderId === 'ord_b') throw new Error('boom');
      started.push(orderId);
      return { status: 'started' };
    },
    now: () => Date.parse('2026-08-12T18:00:00.000Z'),
    graceMs: 10 * 60 * 1000,
    log: () => {},
    errorLog: (line) => errors.push(line),
    maxStarts: 3,
  };

  const result = await runFulfillmentSweep(deps);

  assert.equal(result.scanned, 3);
  assert.equal(result.eligible, 2);
  assert.equal(result.started, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(started, ['ord_a']);
  assert.equal(errors.length, 1);
});

test('cron route fails closed: unauthorized request causes zero sweep mutation/calls', async () => {
  let calls = 0;
  __setFulfillmentSweepRouteDepsForTests({
    runSweep: async () => {
      calls += 1;
      return {
        ok: true,
        scanned: 0,
        eligible: 0,
        started: 0,
        skipped: 0,
        failed: 0,
      };
    },
  });

  const response = await getFulfillmentSweepRoute(new Request('https://example.test/api/cron/fulfillment-sweep'));
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(body, { ok: false });
  assert.equal(calls, 0);
});
