/**
 * Metadata guarantee (Slice 2): every GENERATED and REGENERATED story page must
 * carry valid per-page layout metadata, so the modern book contract/renderer
 * never fails closed on missing metadata. Proven at the real generation path
 * (triggerFulfillment) and for the pure choke-point helper. Also asserts the
 * seeded order carries the current NEW_PROOF_LAYOUT_VERSION.
 *
 * Synthetic fixtures only; provider/blob creds stripped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { proofSourceFingerprint, triggerFulfillment, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import {
  isValidPageTextLayout,
  withRecommendedPageMetadata,
  NEW_PROOF_LAYOUT_VERSION,
  type StoryContent,
} from '../src/lib/fulfillment-types.ts';

// A 24-page story whose pages carry NO (or invalid) textLayout — the case that
// would fail a modern book without the guarantee.
const STORY_NO_LAYOUT: StoryContent = {
  title: 'Guarantee Story',
  characterDescription: 'Hero',
  pages: Array.from({ length: 24 }, (_, i) => ({
    pageNum: i + 1, sceneTitle: `Scene ${i + 1}`, story: `Story ${i + 1}`, imagePrompt: `Prompt ${i + 1}`,
  })),
};

const DEPS: FulfillmentDeps = {
  generateStory: async () => STORY_NO_LAYOUT,
  generateImages: async (prompts) => prompts.map((_, i) => `https://cdn.example.invalid/p${i}.jpg`),
  buildPdf: async () => Buffer.from('%PDF-1.4 mock'),
  buildPrintInteriorPdf: async () => Buffer.from('%PDF-1.4 mock-interior'),
  buildPrintCoverPdf: () => Buffer.from('%PDF-1.4 mock-cover'),
  calculateCoverDimensions: async () => ({ widthPt: 1200, heightPt: 650 }),
  uploadArtifact: async (orderId, _b, filename) => `https://cdn.example.invalid/${orderId}/${filename}`,
  submitPrint: async () => ({ jobId: 'job-1' }),
  sleep: async () => {},
  getBaseUrl: () => 'https://test.invalid',
};

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-meta-guarantee-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

test('new proofs use the modern full-bleed layout contract', () => {
  assert.equal(NEW_PROOF_LAYOUT_VERSION, 'modern_full_bleed');
});

test('withRecommendedPageMetadata fills a valid layout on every page (choke point)', () => {
  const out = withRecommendedPageMetadata(STORY_NO_LAYOUT);
  assert.equal(out.pages.length, 24);
  for (const p of out.pages) assert.ok(isValidPageTextLayout(p.textLayout), `page ${p.pageNum} lacks valid layout`);
  // A page with an INVALID persisted layout is also repaired to a valid one.
  const withBad = withRecommendedPageMetadata({
    ...STORY_NO_LAYOUT,
    pages: [{ ...STORY_NO_LAYOUT.pages[0], textLayout: { zone: 'bogus' } as never }, ...STORY_NO_LAYOUT.pages.slice(1)],
  });
  assert.ok(isValidPageTextLayout(withBad.pages[0].textLayout));
});

test('a generated digital order has valid layout metadata on EVERY page + the current layout version', async () => {
  const dir = makeTmp();
  try {
    const order = createOrderRecord(
      { childName: 'Kid', bookFormat: 'digital', email: 'r@example.invalid' },
      { id: 'ord_meta', now: '2026-08-05T00:00:00.000Z', fulfillmentMode: 'auto' },
    );
    await persistOrder({ ...order, paymentStatus: 'paid' });

    await triggerFulfillment('ord_meta', DEPS);

    const after = await getOrder('ord_meta');
    assert.equal(after?.pageArtifacts?.length, 24, 'full 24-page set generated');
    for (const p of after!.pageArtifacts!) {
      assert.ok(isValidPageTextLayout(p.textLayout), `generated page ${p.pageIndex} lacks valid layout metadata`);
    }
    assert.equal(after?.layoutVersion, NEW_PROOF_LAYOUT_VERSION, 'seeded with the current layout version');
    assert.equal(
      proofSourceFingerprint(after!),
      after?.proofSourceFingerprint,
      'initial generation must persist the fingerprint of its normalized modern page source',
    );
    assert.equal(after?.fulfillmentStatus, 'complete');
  } finally { cleanup(dir); }
});
