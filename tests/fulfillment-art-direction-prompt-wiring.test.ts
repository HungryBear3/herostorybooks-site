/**
 * Slice 3: prove the persisted art-direction packet actually reaches the live
 * page image prompt path during fulfillment — not just diagnostics/tests.
 *
 * These tests are fully offline: story, image, packet, PDF, upload, and email
 * are all injected deps. No provider/network/Stripe/print/customer calls run.
 *
 * Coverage:
 *  1. No packet  -> prompts are byte-identical to the pre-Slice-3 generic path.
 *  2. With packet -> each page prompt carries the packet's style bible,
 *     character anchors, page-scene notes, and negative guardrails, while the
 *     always-on generic guardrails (no masks, fully clothed, no readable text)
 *     remain present.
 *  3. Packet present but a page has no storyboard entry -> fail closed to
 *     failed_manual_review; image generation is never invoked (no silent
 *     downgrade to generic prompts for a paid/custom book).
 *  4. Packet present but a page references a missing character sheet -> same
 *     fail-closed behavior.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { triggerFulfillment, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';
import type { GeneratedImageResult } from '../src/lib/image-generator.ts';
import type {
  ArtDirectionPacketBuildResult,
} from '../src/lib/art-direction-packet-builder.ts';
import { validateStoryboardCompleteness } from '../src/lib/storyboard-validator.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';

const STORY: StoryContent = {
  title: "Lukas and Sprout",
  dedication: 'For Lukas.',
  characterDescription: 'A bright five-year-old named Lukas with a friendly dino.',
  pages: [
    { pageNum: 1, sceneTitle: 'Begin', story: 'Lukas set out.', imagePrompt: 'Lukas steps into the backyard.' },
    { pageNum: 2, sceneTitle: 'Onward', story: 'Sprout followed.', imagePrompt: 'Sprout pads beside Lukas.' },
    { pageNum: 3, sceneTitle: 'Wonder', story: 'They found a path.', imagePrompt: 'A winding garden path.' },
  ],
};

const META: StoryMeta = {
  source: 'gemini_page_prose',
  model: 'gemini:gemini-2.5-flash',
  generatedAt: '2026-06-04T10:00:00.000Z',
  fallbackError: null,
};

const MOCK_PDF = Buffer.from('%PDF-1.4 mock');

function packetResult(packet = lukasDinoArtDirectionFixture): ArtDirectionPacketBuildResult {
  return {
    packet,
    validation: validateStoryboardCompleteness(packet),
    generatedAt: '2026-06-04T10:00:01.000Z',
    humanReviewStatus: 'needs_review',
    humanReviewNotes: 'test packet',
  };
}

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-art-dir-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanupTmpDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function makeDigitalOrder(): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Lukas', bookFormat: 'digital', email: 'lukas@example.com', theme: 'brave-explorer' },
    { id: `ord_${Math.random().toString(36).slice(2, 10)}`, now: '2026-06-04T09:00:00Z' },
  );
  const order: OrderRecord = { ...base, paymentStatus: 'paid', stripeSessionId: 'cs_test_artdir' };
  await persistOrder(order);
  return order;
}

/** Deps that capture the prompts handed to image generation. */
function captureDeps(extra: Partial<FulfillmentDeps> = {}): {
  deps: FulfillmentDeps;
  captured: string[];
} {
  const captured: string[] = [];
  const deps: FulfillmentDeps = {
    generateStoryWithMeta: async () => ({ story: STORY, meta: META }),
    generateImageResults: async (prompts): Promise<GeneratedImageResult[]> => {
      captured.push(...prompts);
      return prompts.map((prompt, i): GeneratedImageResult => ({
        imageUrl: `https://img.example.com/p${i}.png`,
        provider: 'gemini',
        model: 'gemini-2.5-flash-image',
        promptUsed: prompt,
        conditioning: 'text_only',
        referencePhotoUrl: null,
        latencyMs: 1,
        error: null,
      }));
    },
    buildPdf: async () => MOCK_PDF,
    uploadArtifact: async (orderId, _buf, filename) => `https://cdn.example.com/${orderId}/${filename}`,
    sleep: async () => {},
    getBaseUrl: () => 'https://test.herostorybooks.com',
    ...extra,
  };
  return { deps, captured };
}

test('no art-direction packet -> page prompts use the generic path unchanged', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const { deps, captured } = captureDeps(); // no buildArtDirectionPacket dep
  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, deps);

  assert.equal(captured.length, STORY.pages.length);
  for (const prompt of captured) {
    assert.doesNotMatch(prompt, /ART DIRECTION \(authoritative/);
    assert.doesNotMatch(prompt, /Art-direction negative guardrails/);
  }
  // Generic guardrails still present.
  assert.match(captured[0], /Quality requirements:/);
  const persisted = await getOrder(order.id);
  assert.equal(persisted!.fulfillmentStatus, 'complete');
});

test('art-direction packet -> packet-derived style/character/scene guidance reaches each page prompt', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const { deps, captured } = captureDeps({
    buildArtDirectionPacket: async () => packetResult(),
  });
  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, deps);

  assert.equal(captured.length, STORY.pages.length);

  // Page 1 prompt proves packet fields reached the builder.
  const page1 = captured[0];
  assert.match(page1, /ART DIRECTION \(authoritative — follow exactly\):/);
  assert.match(page1, /Style bible watercolor_classic/); // global watercolor style direction
  assert.match(page1, /Lukas \(hero\) must stay visually consistent/); // character anchor
  assert.match(page1, /age 5; face round/); // apparent age / face
  assert.match(page1, /Page text context: Lukas and Sprout found wonder waiting on page 1/); // page-scene note
  assert.match(page1, /Continuity motifs: red-bandana, yellow-flower, cloth-map/); // theme continuity
  // Negative constraints: packet + always-on generic guardrails.
  assert.match(page1, /Art-direction negative guardrails \(must NOT appear in the image\):/);
  assert.match(page1, /- photorealism/);
  assert.match(page1, /No masks\. No superhero styling\./i);
  assert.match(page1, /child is fully clothed and age-appropriate/);
  assert.match(page1, /Render zero readable lettering anywhere in the image/);

  // Page 2 must be art-directed to ITS own storyboard entry (not page 1's).
  assert.match(captured[1], /Page text context: Lukas and Sprout found wonder waiting on page 2/);

  // No PII / object leakage in the assembled prompts.
  for (const prompt of captured) {
    assert.doesNotMatch(prompt, /\[object Object\]/);
  }

  const persisted = await getOrder(order.id);
  assert.equal(persisted!.fulfillmentStatus, 'complete');
});

test('packet present but a page has no storyboard entry -> fail closed, no image generation', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  // Drop the storyboard entry for page 2 so the packet cannot art-direct it.
  const gappy = structuredClone(lukasDinoArtDirectionFixture);
  gappy.storyboard.entries = gappy.storyboard.entries.filter((e) => e.page_number !== 2);

  const { deps, captured } = captureDeps({
    buildArtDirectionPacket: async () => packetResult(gappy),
  });
  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, deps);

  // Never silently fell through to generic image generation.
  assert.equal(captured.length, 0);

  const persisted = await getOrder(order.id);
  assert.equal(persisted!.fulfillmentStatus, 'failed_manual_review');
  assert.match(persisted!.fulfillmentLastError ?? '', /art-direction packet present but unusable/i);
  assert.match(persisted!.fulfillmentLastError ?? '', /no storyboard entry for page 2/i);
  // Fail-closed reason must not contain customer PII or prompt/photo content.
  assert.doesNotMatch(persisted!.fulfillmentLastError ?? '', /Lukas|example\.com|https?:\/\//);
});

test('packet present but a page references a missing character sheet -> fail closed', async (t) => {
  const dir = makeTmpDir();
  t.after(() => cleanupTmpDir(dir));

  const broken = structuredClone(lukasDinoArtDirectionFixture);
  broken.storyboard.entries[0]!.refs.character_sheet_ids = ['char_lukas', 'char_missing'];

  const { deps, captured } = captureDeps({
    buildArtDirectionPacket: async () => packetResult(broken),
  });
  const order = await makeDigitalOrder();
  await triggerFulfillment(order.id, deps);

  assert.equal(captured.length, 0);
  const persisted = await getOrder(order.id);
  assert.equal(persisted!.fulfillmentStatus, 'failed_manual_review');
  assert.match(persisted!.fulfillmentLastError ?? '', /art-direction packet present but unusable/i);
  assert.match(persisted!.fulfillmentLastError ?? '', /missing_referenced_character_sheet/i);
});
