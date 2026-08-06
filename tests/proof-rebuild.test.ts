import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder, withOrderTransaction } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { proofSourceFingerprint, rebuildProofFromPageArtifacts } from '../src/lib/fulfillment.ts';
import { isValidPageTextLayout } from '../src/lib/fulfillment-types.ts';
import { padPageSet } from './support/full-page-set.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-rebuild-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1} story.`,
    basePrompt: `Original prompt for ${i}`,
    currentImageUrl: `https://example.com/current-${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

test('rebuildProofFromPageArtifacts: passes accepted/current URLs to PDF builder', async () => {
  const dir = makeTmp();
  try {
    const base = createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
      { id: 'ord_rebuild', now: '2026-04-26T10:00:00Z' },
    );
    const order: OrderRecord = {
      ...base,
      paymentStatus: 'paid',
      pageArtifacts: padPageSet([
        pageFixture(0, {
          accepted: true,
          acceptedImageUrl: 'https://example.com/accepted-0.png',
          currentImageUrl: 'https://example.com/regen-0.png',
        }),
        pageFixture(1),
        pageFixture(2, {
          accepted: true,
          acceptedImageUrl: 'https://example.com/accepted-2.png',
        }),
      ]),
    };
    await persistOrder(order);

    let capturedUrls: (string | null)[] = [];
    const result = await rebuildProofFromPageArtifacts('ord_rebuild', {
      buildPdf: async (_story, _order, urls) => {
        capturedUrls = urls;
        return Buffer.from('%PDF rebuilt');
      },
      uploadArtifact: async (orderId, _buffer, filename) => `https://cdn.example.com/${orderId}/${filename}`,
    });
    assert.equal(result.ok, true);
    // PDF builder receives [coverUrl, ...page urls]; first slot is the cover (page 0)
    assert.deepEqual(capturedUrls.slice(0, 4), [
      'https://example.com/accepted-0.png', // cover slot uses page 0
      'https://example.com/accepted-0.png',
      'https://example.com/current-1.png',
      'https://example.com/accepted-2.png',
    ]);
    assert.equal(capturedUrls.length, 25, 'cover + 24 story-page images');

    const after = await getOrder('ord_rebuild');
    // Proofs now land at an IMMUTABLE, version-keyed path so a published
    // artifact is never overwritten and the URL identifies it exactly.
    assert.match(after!.storyArtifactUrl ?? '', /\/proofs\/pv_[a-z0-9_]+\.pdf$/);
    // …and the identity fields move with it, so no record can carry a
    // proof URL that no gate can verify.
    assert.ok(after!.proofSourceFingerprint);
    assert.ok(after!.proofVersion);
  } finally {
    cleanup(dir);
  }
});

test('rebuildProofFromPageArtifacts: migrates legacy page metadata and persists matching modern proof identity', async () => {
  const dir = makeTmp();
  try {
    const base = createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
      { id: 'ord_rebuild_legacy_metadata', now: '2026-04-26T10:00:00Z' },
    );
    const legacyPages = padPageSet([pageFixture(0)]).map((artifact, i) => ({
      ...artifact,
      reviewerNotes: `preserve-${i}`,
      ...(i % 2 === 0
        ? { textLayout: undefined }
        : { textLayout: { zone: 'invalid' } as never }),
    }));
    await persistOrder({
      ...base,
      paymentStatus: 'paid',
      layoutVersion: 'legacy_bottom_band',
      pageArtifacts: legacyPages,
    });

    let renderedLayoutsAreValid = false;
    const result = await rebuildProofFromPageArtifacts(base.id, {
      buildPdf: async (story) => {
        renderedLayoutsAreValid = story.pages.every((page) => isValidPageTextLayout(page.textLayout));
        return Buffer.from('%PDF rebuilt modern');
      },
      uploadArtifact: async (orderId, _buffer, filename) =>
        `https://cdn.example.com/${orderId}/${filename}`,
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(renderedLayoutsAreValid, true, 'the renderer must receive normalized metadata on every page');
    const after = await getOrder(base.id);
    assert.equal(after?.layoutVersion, 'modern_full_bleed');
    assert.equal(after?.pageArtifacts?.every((page) => isValidPageTextLayout(page.textLayout)), true);
    assert.equal(after?.pageArtifacts?.[0]?.reviewerNotes, 'preserve-0');
    assert.equal(proofSourceFingerprint(after!), after?.proofSourceFingerprint);
  } finally {
    cleanup(dir);
  }
});

test('rebuildProofFromPageArtifacts: discards a build when a render-affecting order field changes', async () => {
  const dir = makeTmp();
  try {
    const base = createOrderRecord(
      { childName: 'Luna Original', bookFormat: 'digital', email: 'luna@example.com' },
      { id: 'ord_rebuild_stale_order', now: '2026-04-26T10:00:00Z' },
    );
    await persistOrder({ ...base, paymentStatus: 'paid', pageArtifacts: padPageSet([pageFixture(0)]) });
    let changed = false;
    const result = await rebuildProofFromPageArtifacts(base.id, {
      buildPdf: async () => {
        if (!changed) {
          changed = true;
          await withOrderTransaction(base.id, (current) => ({
            commit: { ...current, childName: 'Luna Concurrent Change' },
            result: undefined,
          }));
        }
        return Buffer.from('%PDF stale rebuild');
      },
      uploadArtifact: async (orderId, _buffer, filename) =>
        `https://cdn.example.com/${orderId}/${filename}`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'proof_source_changed_during_rebuild');
    const after = await getOrder(base.id);
    assert.equal(after?.childName, 'Luna Concurrent Change');
    assert.equal(after?.storyArtifactUrl ?? null, null);
    assert.equal(after?.proofSourceFingerprint ?? null, null);
    assert.equal(after?.proofVersion ?? null, null);
  } finally {
    cleanup(dir);
  }
});

test('rebuildProofFromPageArtifacts: 404 when no page artifacts', async () => {
  const dir = makeTmp();
  try {
    const base = createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'l@e.com' },
      { id: 'ord_no_artifacts', now: '2026-04-26T10:00:00Z' },
    );
    await persistOrder({ ...base, paymentStatus: 'paid' });
    const r = await rebuildProofFromPageArtifacts('ord_no_artifacts', {
      buildPdf: async () => Buffer.from('x'),
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /no page artifacts/i);
  } finally {
    cleanup(dir);
  }
});
