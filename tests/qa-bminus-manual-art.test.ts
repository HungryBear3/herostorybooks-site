/**
 * B-minus integration tests (on hsb/deploy-candidate-20260602): the net-new
 * manual/subscription-art behaviors, composed with the base canonical release
 * model (qaStatus/qaBlockedReason, evaluateReleaseGuard, qaPassAt).
 *
 * Local/read-only: no providers, no real email/print; image deps are injected.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { triggerFulfillment, detectMissingIllustrations, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { createOrderRecord, persistOrder, getOrder, type OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';
import type { GeneratedImageResult } from '../src/lib/image-generator.ts';
import {
  detectSingularTheyIssues,
  detectRepeatedProse,
  validatePageProse,
} from '../src/lib/story-generator.ts';
import { defaultProviderOrder, isTextToImageFallbackEnabled } from '../src/lib/image-generator.ts';
import { redactSecrets } from '../src/lib/redact-secrets.ts';

// ── unit: validators ─────────────────────────────────────────────────────────

test('detectMissingIllustrations flags null/blank image URLs (1-based)', () => {
  const r = [
    { imageUrl: 'https://x/1.png' },
    { imageUrl: null },
    { imageUrl: '   ' },
  ] as unknown as GeneratedImageResult[];
  assert.deepEqual(detectMissingIllustrations(r), [2, 3]);
  assert.deepEqual(detectMissingIllustrations([{ imageUrl: 'a' }] as unknown as GeneratedImageResult[]), []);
});

test('detectSingularTheyIssues catches agreement bugs; clean prose passes', () => {
  assert.ok(detectSingularTheyIssues('Then they walks on and they was afraid.').length >= 2);
  assert.deepEqual(detectSingularTheyIssues('Then they walk on and they were brave.'), []);
});

test('detectRepeatedProse flags a sentence reused across pages', () => {
  const issues = detectRepeatedProse([
    'Luna crossed the wide gray river today.',
    'A different sentence entirely here now.',
    'Luna crossed the wide gray river today.',
  ]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /pages 1,3/);
});

test('validatePageProse now fails closed on singular-they', () => {
  const issues = validatePageProse('They walks into the cave.', 'Luna');
  assert.ok(issues.some((i) => /singular-they/.test(i)));
});

test('redactSecrets strips provider key echoes', () => {
  const out = redactSecrets('OpenAI error: Incorrect API key provided: sk-proj-ABCDEFGH12345678');
  assert.doesNotMatch(out, /sk-proj-ABCDEFGH12345678/);
  assert.match(out, /redacted-secret/);
});

test('defaultProviderOrder: no photo + text-to-image OFF => empty (fail-closed); ON => routes', () => {
  const prev = process.env.HSB_ENABLE_TEXT_TO_IMAGE;
  try {
    delete process.env.HSB_ENABLE_TEXT_TO_IMAGE;
    assert.equal(isTextToImageFallbackEnabled(), false);
    assert.deepEqual(defaultProviderOrder({ prompt: 'x', referenceImageUrl: null }), []);
    process.env.HSB_ENABLE_TEXT_TO_IMAGE = 'true';
    assert.equal(isTextToImageFallbackEnabled(), true);
    assert.equal(defaultProviderOrder({ prompt: 'x', referenceImageUrl: null }).length, 1);
  } finally {
    if (prev === undefined) delete process.env.HSB_ENABLE_TEXT_TO_IMAGE;
    else process.env.HSB_ENABLE_TEXT_TO_IMAGE = prev;
  }
});

// ── live: fulfillment routing (composed with base) ───────────────────────────

const MOCK_STORY: StoryContent = {
  title: "Luna's Adventure",
  dedication: 'For Luna.',
  characterDescription: 'A brave child named Luna.',
  pages: [
    { pageNum: 1, sceneTitle: 'A', story: 'Luna set off on her quest.', imagePrompt: 'p1' },
    { pageNum: 2, sceneTitle: 'B', story: 'Luna faced a challenge.', imagePrompt: 'p2' },
    { pageNum: 3, sceneTitle: 'C', story: 'Luna returned home.', imagePrompt: 'p3' },
  ],
};
const META: StoryMeta = { source: 'ollama_page_prose', model: 'm', generatedAt: 't', fallbackError: null };

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-bminus-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.HSB_ENABLE_TEXT_TO_IMAGE;
  return dir;
}
function done(dir: string) { rmSync(dir, { recursive: true, force: true }); delete process.env.HSB_ORDER_STORE_DIR; }

let seq = 0;
async function seedPaid(over: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const base = createOrderRecord({ childName: 'Luna', bookFormat: 'classic', email: 'l@e.com' }, { id: `ord_bm_${seq++}`, now: '2026-06-05T10:00:00Z' });
  const o: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    ...over,
  };
  await persistOrder(o);
  return o;
}

test('no-photo paid order with no image route → awaiting_manual_art, qaStatus blocked, no proof', async () => {
  const dir = tmp();
  try {
    const o = await seedPaid(); // no photoBlobUrl, no image deps, flag OFF
    const deps: FulfillmentDeps = { generateStoryWithMeta: async () => ({ story: MOCK_STORY, meta: META }) };
    await triggerFulfillment(o.id, deps);
    const after = await getOrder(o.id);
    assert.equal(after?.fulfillmentStatus, 'awaiting_manual_art');
    assert.equal(after?.qaStatus, 'blocked');
    assert.match(after?.qaBlockedReason ?? '', /awaiting manual\/subscription art/i);
    assert.equal(after?.storyArtifactUrl ?? null, null, 'no proof PDF');
    assert.ok(after?.auditEvents?.some((e) => e.type === 'qa_blocked' && e.reason === 'awaiting_manual_art'));
  } finally { done(dir); }
});

test('image route present but a page returns null image → failed_manual_review, qaStatus blocked, no proof', async () => {
  const dir = tmp();
  try {
    const o = await seedPaid();
    const deps: FulfillmentDeps = {
      generateStoryWithMeta: async () => ({ story: MOCK_STORY, meta: META }),
      // hasImageRoute=true via injected dep; one page comes back null with NO error,
      // which detectFailedPages misses but detectMissingIllustrations catches.
      generateImageResults: async () => ([
        { imageUrl: 'https://x/1.png', provider: 'fal', model: 'm', promptUsed: 'p', latencyMs: 1 },
        { imageUrl: null, provider: 'fal', model: 'm', promptUsed: 'p', latencyMs: 1 },
        { imageUrl: 'https://x/3.png', provider: 'fal', model: 'm', promptUsed: 'p', latencyMs: 1 },
      ] as unknown as GeneratedImageResult[]),
      buildPdf: async () => Buffer.from('%PDF should-not-build'),
    };
    await triggerFulfillment(o.id, deps);
    const after = await getOrder(o.id);
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.equal(after?.qaStatus, 'blocked');
    assert.match(after?.qaBlockedReason ?? '', /missing illustrations/i);
    assert.equal(after?.storyArtifactUrl ?? null, null, 'no proof PDF on missing art');
    assert.ok(after?.auditEvents?.some((e) => e.type === 'qa_blocked' && e.reason === 'missing_illustrations'));
  } finally { done(dir); }
});
