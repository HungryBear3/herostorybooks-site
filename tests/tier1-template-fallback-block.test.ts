/**
 * Tier1 A — regression pin for the EXISTING template-fallback hard block.
 *
 * Not re-implemented (the block already lives in generation-manifest.ts +
 * fulfillment.ts). This pins the release guard so a paid order whose story is a
 * template / template-after-failure can never be released to a customer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateReleaseGuardStructural } from '../src/lib/generation-manifest.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import type { StoryMeta } from '../src/lib/fulfillment-types.ts';

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-tier1a-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  return dir;
}
function done(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function paidTemplateOrder(source: StoryMeta['source']): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'l@e.com' },
    { id: 'ord_t1a', now: '2026-06-05T10:00:00Z' },
  );
  return {
    ...base,
    paymentStatus: 'paid',
    theme: 'custom-voice-story',
    storyArtifactUrl: 'https://example.test/proof.pdf', // passes hasArtifact so we reach the story-route gate
    storyMeta: { source, model: 't', generatedAt: 't', fallbackError: null },
  };
}

test('paid order with a template story is blocked TEMPLATE_STORY_BLOCKED', () => {
  const dir = tmp();
  try {
    for (const source of ['template', 'template_after_openai_failure'] as const) {
      const r = evaluateReleaseGuardStructural(paidTemplateOrder(source));
      assert.equal(r.ok, false, `source=${source} must not be releasable`);
      assert.equal(r.failureCode, 'TEMPLATE_STORY_BLOCKED', `source=${source}`);
    }
  } finally {
    done(dir);
  }
});
