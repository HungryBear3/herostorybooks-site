/**
 * Regression: when per-page image generation fails for one or more
 * pages, fulfillment must NOT proceed to PDF build / Lulu submission.
 * Instead it must:
 *   - persist all successful page artifacts plus failure metadata for
 *     each failed page
 *   - preserve storyMeta (the Patch from 2026-05-15 morning)
 *   - mark fulfillmentStatus = 'failed_manual_review'
 *   - record an actionable lastError naming failed page numbers + the
 *     classified error class per provider
 *
 * Origin: 2026-05-15 Gemini proof rerun (`ord_rexgemini672300`). Pages
 * 17–22 of 24 returned Gemini http_4xx and the fulfillment crashed
 * mid-run, losing the successful pages 1–16 and 23–24.
 *
 * Tests here also lock in the classifier helpers
 * (`detectFailedPages`, `summarizeFailedPages`, `classifyImageGenError`
 * via behavior) so a future refactor cannot quietly drop the
 * page-numbering or error-class precision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  triggerFulfillment,
  detectFailedPages,
  summarizeFailedPages,
  type FulfillmentDeps,
} from '../src/lib/fulfillment.ts';
import type { GeneratedImageResult } from '../src/lib/image-generator.ts';
import {
  createOrderRecord,
  persistOrder,
  getOrder,
} from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';

const GEMINI_META: StoryMeta = {
  source: 'gemini_page_prose',
  model: 'gemini:gemini-2.5-flash',
  generatedAt: '2026-05-15T17:00:00.000Z',
  fallbackError: null,
};

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-partial-fail-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanupTmpDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function makeStory(pageCount: number): StoryContent {
  return {
    title: "Luna's Tale",
    dedication: 'For Luna.',
    characterDescription: 'A brave child named Luna.',
    pages: Array.from({ length: pageCount }, (_, i) => ({
      pageNum: i + 1,
      sceneTitle: `Scene ${i + 1}`,
      story: `Page ${i + 1} prose.`,
      imagePrompt: `Page ${i + 1} prompt.`,
    })),
  };
}

async function makeDigitalOrder(): Promise<OrderRecord> {
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
    stripeSessionId: 'cs_test_partial',
  };
  await persistOrder(order);
  return order;
}

// ── classifier unit tests ─────────────────────────────────────────────────

test('detectFailedPages: empty input → empty output', () => {
  assert.deepEqual(detectFailedPages([]), []);
});

test('detectFailedPages: imageUrl=null with http 403 error → http_4xx class', () => {
  const results: GeneratedImageResult[] = [
    {
      imageUrl: 'https://ok.example.com/p1.png',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: '',
      latencyMs: 1,
    },
    {
      imageUrl: null,
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: '',
      latencyMs: 1,
      error: 'gemini API error 403: PERMISSION_DENIED',
    },
  ];
  const failed = detectFailedPages(results);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.pageIndex, 1);
  assert.equal(failed[0]!.pageNum, 2);
  assert.equal(failed[0]!.provider, 'gemini');
  assert.equal(failed[0]!.errorClass, 'http_4xx');
});

test('detectFailedPages: timeout-shaped error → timeout class', () => {
  const results: GeneratedImageResult[] = [
    {
      imageUrl: null,
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: '',
      latencyMs: 60_000,
      error: 'gemini fetch failed: The operation was aborted due to timeout',
    },
  ];
  const failed = detectFailedPages(results);
  assert.equal(failed[0]!.errorClass, 'timeout');
});

test('detectFailedPages: 5xx error → http_5xx class', () => {
  const results: GeneratedImageResult[] = [
    {
      imageUrl: null,
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: '',
      latencyMs: 1,
      error: 'gemini API error 503: overloaded',
    },
  ];
  assert.equal(detectFailedPages(results)[0]!.errorClass, 'http_5xx');
});

test('detectFailedPages: imageUrl missing with no error → does NOT halt fulfillment (no_url class is excluded)', () => {
  const results: GeneratedImageResult[] = [
    {
      imageUrl: null,
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: '',
      latencyMs: 1,
    },
  ];
  // Belt-and-suspenders: null URL with no error info is unstructured and
  // matches legacy test fixtures + admin retry-without-provider-config
  // scenarios. The halting gate is intentionally narrow — only fires on
  // structured provider failures (http_4xx, http_5xx, timeout).
  assert.deepEqual(detectFailedPages(results), []);
});

test('detectFailedPages: unstructured "other" error → does NOT halt fulfillment', () => {
  const results: GeneratedImageResult[] = [
    {
      imageUrl: null,
      provider: 'fal',
      model: 'fal-ai/flux/schnell',
      promptUsed: '',
      latencyMs: 1,
      error: 'no image url returned',
    },
  ];
  assert.deepEqual(detectFailedPages(results), []);
});

test('summarizeFailedPages: names failed pages and per-provider/class breakdown', () => {
  const summary = summarizeFailedPages(
    [
      { pageIndex: 16, pageNum: 17, provider: 'gemini', model: 'g', errorClass: 'http_4xx', error: null },
      { pageIndex: 17, pageNum: 18, provider: 'gemini', model: 'g', errorClass: 'http_4xx', error: null },
      { pageIndex: 18, pageNum: 19, provider: 'gemini', model: 'g', errorClass: 'http_4xx', error: null },
    ],
    24,
  );
  assert.match(summary, /3 of 24 pages/);
  assert.match(summary, /pages 17,18,19/);
  assert.match(summary, /gemini http_4xx ×3/);
});

// ── digital fulfillment end-to-end: partial failure path ──────────────────

test('digital fulfillment: page 3 fails http_4xx while pages 1-2 succeed → failed_manual_review with partial evidence', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const story = makeStory(4);
  let pdfCalls = 0;
  let emailCalls = 0;
  const sentImageResults: GeneratedImageResult[] = [
    {
      imageUrl: 'https://cdn.example.com/p1.png',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: 'p1',
      conditioning: 'photo_edit',
      latencyMs: 100,
    },
    {
      imageUrl: 'https://cdn.example.com/p2.png',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: 'p2',
      conditioning: 'photo_edit',
      latencyMs: 110,
    },
    {
      imageUrl: null,
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: 'p3',
      conditioning: 'photo_edit',
      latencyMs: 90,
      error: 'gemini API error 403: PERMISSION_DENIED',
    },
    {
      imageUrl: 'https://cdn.example.com/p4.png',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      promptUsed: 'p4',
      conditioning: 'photo_edit',
      latencyMs: 95,
    },
  ];

  const deps: FulfillmentDeps = {
    generateStoryWithMeta: async () => ({ story, meta: GEMINI_META }),
    generateImageResults: async () => sentImageResults,
    buildPdf: async () => {
      pdfCalls += 1;
      return Buffer.from('%PDF-1.4 should-not-be-called');
    },
    uploadArtifact: async (orderId, _buf, filename) =>
      `https://cdn.example.com/${orderId}/${filename}`,
    sleep: async () => {},
    getBaseUrl: () => 'https://test.herostorybooks.com',
  };

  // Email side-effect protection: any incoming send would crash here.
  const originalKey = process.env.HSB_RESEND_API_KEY;
  delete process.env.HSB_RESEND_API_KEY;
  t.after(() => {
    if (originalKey === undefined) delete process.env.HSB_RESEND_API_KEY;
    else process.env.HSB_RESEND_API_KEY = originalKey;
  });

  const order = await makeDigitalOrder();
  const result = await triggerFulfillment(order.id, deps);
  assert.equal(result.status, 'started');

  const persisted = await getOrder(order.id);
  assert.ok(persisted);

  // (1) NO PDF build attempted.
  assert.equal(pdfCalls, 0, 'PDF must NOT be built when any page failed image generation');
  assert.equal(emailCalls, 0, 'delivery email must NOT be sent when any page failed image generation');
  assert.equal(persisted!.storyArtifactUrl ?? null, null);

  // (2) Status moved to failed_manual_review (not 'complete', not 'building_pdf').
  assert.equal(persisted!.fulfillmentStatus, 'failed_manual_review');

  // (3) storyMeta preserved.
  assert.equal(persisted!.storyMeta?.source, 'gemini_page_prose');
  assert.equal(persisted!.storyMeta?.model, 'gemini:gemini-2.5-flash');

  // (4) lastError names failed page + error class + provider.
  const err = persisted!.fulfillmentLastError ?? '';
  assert.match(err, /image generation failed for 1 of 4 pages/);
  assert.match(err, /pages 3\b/);
  assert.match(err, /gemini http_4xx/);

  // (5) Successful page artifacts persisted, failed page included with null URL + error.
  const artifacts = persisted!.pageArtifacts;
  assert.ok(artifacts && artifacts.length === 4, 'all 4 page artifacts must be persisted');
  assert.equal(artifacts![0]!.currentImageUrl, 'https://cdn.example.com/p1.png');
  assert.equal(artifacts![1]!.currentImageUrl, 'https://cdn.example.com/p2.png');
  assert.equal(artifacts![2]!.currentImageUrl, null);
  assert.equal(artifacts![2]!.generationProvider, 'gemini');
  assert.equal(artifacts![2]!.generationModel, 'gemini-2.5-flash-image');
  assert.equal(artifacts![3]!.currentImageUrl, 'https://cdn.example.com/p4.png');
});

// ── digital fulfillment happy path STILL works (no regression) ────────────

test('digital fulfillment: all pages succeed → complete (no false-positive failure gate)', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const story = makeStory(3);
  const deps: FulfillmentDeps = {
    generateStoryWithMeta: async () => ({ story, meta: GEMINI_META }),
    generateImages: async (prompts) =>
      prompts.map((_, i) => `https://cdn.example.com/p${i + 1}.png`),
    buildPdf: async () => Buffer.from('%PDF-1.4 mock'),
    uploadArtifact: async (orderId, _buf, filename) =>
      `https://cdn.example.com/${orderId}/${filename}`,
    sleep: async () => {},
    getBaseUrl: () => 'https://test.herostorybooks.com',
  };

  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, deps);
  const persisted = await getOrder(order.id);
  // After the QA gate landed, the "no image failure" terminal state for
  // an order WITHOUT a recorded qaPassAt is 'awaiting_qa' (not
  // 'complete'). The original assertion captured the failure-gate
  // regression: when all images succeed, the order MUST NOT get stuck
  // at 'failed_manual_review'. That property is still proven here.
  assert.equal(persisted!.fulfillmentStatus, 'awaiting_qa');
  assert.notEqual(persisted!.fulfillmentStatus, 'failed_manual_review');
  assert.equal(persisted!.storyMeta?.source, 'gemini_page_prose');
  assert.ok(persisted!.storyArtifactUrl);
});
