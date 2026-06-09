/**
 * Tier1 D — repeated-prose gate.
 *
 * `detectRepeatedProse` (already unit-tested in qa-bminus-manual-art.test.ts)
 * is now surfaced on `storyMeta.repeatedProse`, and fulfillment fails closed to
 * manual review for proof-gated orders rather than shipping duplicated text.
 * Verified through the real fulfillment path with an injected story generator.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { triggerFulfillment, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { createOrderRecord, persistOrder, getOrder, type OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';

const STORY: StoryContent = {
  title: 'T',
  dedication: 'd',
  characterDescription: 'c',
  pages: [
    { pageNum: 1, sceneTitle: 'A', story: 'Luna crossed the wide gray river today.', imagePrompt: 'p1' },
    { pageNum: 2, sceneTitle: 'B', story: 'A different sentence entirely here now.', imagePrompt: 'p2' },
    { pageNum: 3, sceneTitle: 'C', story: 'Luna crossed the wide gray river today.', imagePrompt: 'p3' },
  ],
};

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-tier1d-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  return dir;
}
function done(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

let seq = 0;
async function seedGatedOrder(): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'l@e.com' },
    { id: `ord_t1d_${seq++}`, now: '2026-06-05T10:00:00Z' },
  );
  const o: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    theme: 'custom-voice-story', // proof-gated (isCustomProofGatedOrder)
    shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
  };
  await persistOrder(o);
  return o;
}

test('repeated cross-page prose on a proof-gated order fails closed to manual review', async () => {
  const dir = tmp();
  try {
    const meta: StoryMeta = {
      source: 'gemini_page_prose',
      model: 'm',
      generatedAt: 't',
      fallbackError: null,
      repeatedProse: ['repeated sentence on pages 1,3: "luna crossed the wide gray river today."'],
    };
    const o = await seedGatedOrder();
    const deps: FulfillmentDeps = { generateStoryWithMeta: async () => ({ story: STORY, meta }) };
    await triggerFulfillment(o.id, deps);
    const after = await getOrder(o.id);
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.match(after?.fulfillmentLastError ?? '', /repeated cross-page prose/);
    assert.equal(after?.storyArtifactUrl ?? null, null, 'no proof PDF on repeated prose');
  } finally {
    done(dir);
  }
});

test('clean story (no repeatedProse) is not blocked by the repetition gate', async () => {
  const dir = tmp();
  try {
    const meta: StoryMeta = { source: 'gemini_page_prose', model: 'm', generatedAt: 't', fallbackError: null };
    const o = await seedGatedOrder();
    const deps: FulfillmentDeps = { generateStoryWithMeta: async () => ({ story: STORY, meta }) };
    await triggerFulfillment(o.id, deps);
    const after = await getOrder(o.id);
    assert.notEqual(after?.fulfillmentStatus, 'failed_manual_review');
  } finally {
    done(dir);
  }
});
