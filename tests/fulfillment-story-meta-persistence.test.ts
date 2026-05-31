/**
 * Regression: storyMeta must survive every fulfillment write that
 * happens after the story-generation step.
 *
 * Origin: 2026-05-15 Gemini preview proof test (`ord_rexgemini340967`).
 * Final persisted storyMeta was null even though Gemini was the path
 * that generated the prose. Diagnosis: the digital + print fulfillment
 * paths persist storyMeta in an early `updateFulfillmentState` call,
 * but later writes (pageArtifacts, building_pdf, complete, proof_ready,
 * delivery_email_failed) are read-modify-write against blob storage.
 * If the blob read returns a slightly stale snapshot, the merge drops
 * storyMeta because the patch did not carry it forward.
 *
 * Patch under test: every paidFulfillmentPatch call AFTER storyMeta is
 * known now carries storyMeta explicitly so the merge is deterministic.
 *
 * Tests here would FAIL on origin/main pre-patch because the final
 * 'complete' write only set fulfillmentStatus/storyArtifactUrl/etc and
 * did not include storyMeta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  triggerFulfillment,
  type FulfillmentDeps,
} from '../src/lib/fulfillment.ts';
import {
  createOrderRecord,
  persistOrder,
  getOrder,
} from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';

const MOCK_STORY: StoryContent = {
  title: "Luna's Tale",
  dedication: 'For Luna.',
  characterDescription: 'A brave child named Luna.',
  pages: [
    { pageNum: 1, sceneTitle: 'A', story: 'A', imagePrompt: 'A' },
    { pageNum: 2, sceneTitle: 'B', story: 'B', imagePrompt: 'B' },
  ],
};

const MOCK_PDF = Buffer.from('%PDF-1.4 mock');

const GEMINI_META: StoryMeta = {
  source: 'gemini_page_prose',
  model: 'gemini:gemini-2.5-flash',
  generatedAt: '2026-05-15T17:00:00.000Z',
  fallbackError: null,
};

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-story-meta-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanupTmpDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function makeDigitalOrder(
  overrides: Partial<OrderRecord> = {},
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    {
      id: `ord_${Math.random().toString(36).slice(2, 10)}`,
      now: '2026-05-15T10:00:00Z',
    },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    stripeSessionId: 'cs_test_storymeta',
    qaPassAt: '2026-05-31T20:00:00.000Z',
    qaPassBy: 'admin',
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

async function makePrintOrder(
  overrides: Partial<OrderRecord> = {},
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' },
    {
      id: `ord_${Math.random().toString(36).slice(2, 10)}`,
      now: '2026-05-15T10:00:00Z',
    },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    stripeSessionId: 'cs_test_storymeta_print',
    qaPassAt: '2026-05-31T20:00:00.000Z',
    qaPassBy: 'admin',
    shippingAddress: {
      line1: '1 Test Way',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
    },
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const HAPPY_DEPS_DIGITAL: FulfillmentDeps = {
  generateStoryWithMeta: async () => ({
    story: MOCK_STORY,
    meta: GEMINI_META,
  }),
  generateImages: async (prompts) =>
    prompts.map((_, i) => `https://img.example.com/page${i}.png`),
  buildPdf: async () => MOCK_PDF,
  uploadArtifact: async (orderId, _buf, filename) =>
    `https://cdn.example.com/${orderId}/${filename}`,
  sleep: async () => {},
  getBaseUrl: () => 'https://test.herostorybooks.com',
};

const HAPPY_DEPS_PRINT: FulfillmentDeps = {
  ...HAPPY_DEPS_DIGITAL,
  buildPrintInteriorPdf: async () => MOCK_PDF,
};

// ── Digital: storyMeta survives all the way to 'complete' ──────────────────

test('digital fulfillment persists storyMeta.source=gemini_page_prose through final complete state', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const order = await makeDigitalOrder();
  const result = await triggerFulfillment(order.id, HAPPY_DEPS_DIGITAL);
  assert.equal(result.status, 'started');

  const persisted = await getOrder(order.id);
  assert.ok(persisted, 'order must persist');
  assert.equal(persisted!.fulfillmentStatus, 'complete');
  // The exact regression Rex caught:
  assert.ok(persisted!.storyMeta, 'final persisted storyMeta must NOT be null');
  assert.equal(persisted!.storyMeta!.source, 'gemini_page_prose');
  assert.equal(persisted!.storyMeta!.model, 'gemini:gemini-2.5-flash');
});

test('digital fulfillment preserves an injected story meta verbatim through final complete state', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const injectedMeta: StoryMeta = {
    source: 'openai_chat',
    model: 'gpt-4o-mini',
    generatedAt: '2026-05-15T10:00:01.000Z',
    fallbackError: null,
  };

  const deps: FulfillmentDeps = {
    ...HAPPY_DEPS_DIGITAL,
    generateStoryWithMeta: async () => ({
      story: MOCK_STORY,
      meta: injectedMeta,
    }),
  };

  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, deps);

  const persisted = await getOrder(order.id);
  assert.equal(persisted!.fulfillmentStatus, 'complete');
  assert.deepEqual(persisted!.storyMeta, injectedMeta);
});

// ── Digital: PDF/artifact patch does not drop storyMeta ────────────────────

test('digital fulfillment retains storyMeta after pageArtifacts/PDF state writes', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, HAPPY_DEPS_DIGITAL);

  const persisted = await getOrder(order.id);
  assert.ok(persisted);
  // pageArtifacts must have landed (basic sanity)
  assert.equal(persisted!.pageArtifacts?.length, MOCK_STORY.pages.length);
  // PDF must have landed (basic sanity)
  assert.ok(persisted!.storyArtifactUrl?.includes('/luna-storybook.pdf'));
  // The thing the patch is for:
  assert.equal(persisted!.storyMeta?.source, 'gemini_page_prose');
});

// ── Digital: email failure path must not drop storyMeta or pageArtifacts ───

test('digital delivery_email_failed path preserves storyMeta + storyArtifactUrl + pageArtifacts', async (t) => {
  const dir = makeTmpDir();
  const originalKey = process.env.HSB_RESEND_API_KEY;
  const originalUrl = process.env.NEXT_PUBLIC_URL;
  const originalFrom = process.env.HSB_EMAIL_FROM;
  const originalFallback = process.env.HSB_EMAIL_FROM_FALLBACK;
  const originalFetch = globalThis.fetch;

  process.env.HSB_RESEND_API_KEY = 're_test_stub';
  process.env.NEXT_PUBLIC_URL = 'https://test.herostorybooks.com';
  process.env.HSB_EMAIL_FROM = 'Hero Story Books <support@herostorybooks.com>';
  delete process.env.HSB_EMAIL_FROM_FALLBACK;

  // Force the email send to 403, same shape as the Resend domain-not-verified
  // incident already covered by fulfillment-email-failure.test.ts.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        statusCode: 403,
        name: 'validation_error',
        message: 'The herostorybooks.com domain is not verified.',
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;

  t.after(() => {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_URL;
    else process.env.NEXT_PUBLIC_URL = originalUrl;
    if (originalFrom === undefined) delete process.env.HSB_EMAIL_FROM;
    else process.env.HSB_EMAIL_FROM = originalFrom;
    if (originalFallback === undefined) delete process.env.HSB_EMAIL_FROM_FALLBACK;
    else process.env.HSB_EMAIL_FROM_FALLBACK = originalFallback;
    globalThis.fetch = originalFetch;
    cleanupTmpDir(dir);
  });

  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, HAPPY_DEPS_DIGITAL);

  const persisted = await getOrder(order.id);
  assert.ok(persisted);
  assert.equal(persisted!.fulfillmentStatus, 'delivery_email_failed');
  // All three must survive:
  assert.equal(persisted!.storyMeta?.source, 'gemini_page_prose');
  assert.ok(
    persisted!.storyArtifactUrl?.includes('/luna-storybook.pdf'),
    'storyArtifactUrl must survive the email-failure write',
  );
  assert.equal(
    persisted!.pageArtifacts?.length,
    MOCK_STORY.pages.length,
    'pageArtifacts must survive the email-failure write',
  );
});

// ── Print: storyMeta survives to proof_ready ───────────────────────────────

test('print fulfillment persists storyMeta through final proof_ready state', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const order = await makePrintOrder();
  const result = await triggerFulfillment(order.id, HAPPY_DEPS_PRINT);
  assert.equal(result.status, 'started');

  const persisted = await getOrder(order.id);
  assert.ok(persisted);
  assert.equal(persisted!.fulfillmentStatus, 'proof_ready');
  assert.equal(persisted!.storyMeta?.source, 'gemini_page_prose');
  assert.ok(persisted!.storyArtifactUrl?.includes('/luna-proof.pdf'));
  assert.ok(persisted!.printInteriorArtifactUrl?.includes('/luna-interior.pdf'));
});
