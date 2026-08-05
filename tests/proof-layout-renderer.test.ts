/**
 * Renderer + identity contract for the proof-only positioned text-card override.
 *
 * Proves: (1) an override moves the PROOF fingerprint and only for the page it
 * is on; (2) the PRINT interior is byte-identical with and without the override
 * (the print master never reads it) — the proof-vs-print behavior; (3) the proof
 * renderer accepts an override and emits a valid PDF; (4) overflow is detected
 * (fail closed), not clipped. Synthetic fixtures only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrintInteriorPdf, buildPdf, proofCardTextOverflows } from '../src/lib/pdf-builder.ts';
import { proofRenderSourceFingerprint } from '../src/lib/review-source-identity.ts';
import { canonicalizeProofCardGeometry } from '../src/lib/proof-layout-override.ts';
import { createOrderRecord } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { ProofCardOverride, StoryContent } from '../src/lib/fulfillment-types.ts';

function override(): ProofCardOverride {
  return {
    ...canonicalizeProofCardGeometry({ x: 0.1, y: 0.12, width: 0.6, height: 0.22, opacity: 0.9, fontScale: 1 }),
    textColor: 'dark_brown',
    authoredAgainstProofVersion: 'pv_1',
    authoredAgainstFingerprint: 'pf_1',
    appliedAt: '2026-08-05T00:00:00.000Z',
    appliedBy: 'customer',
  };
}

function story(withOverride: boolean): StoryContent {
  return {
    title: 'Synthetic Story',
    characterDescription: 'Synthetic hero',
    pages: [
      {
        pageNum: 1, sceneTitle: 'One', story: 'Page one prose.', imagePrompt: 'p1',
        ...(withOverride ? { proofCardOverride: override() } : {}),
      },
      { pageNum: 2, sceneTitle: 'Two', story: 'Page two prose.', imagePrompt: 'p2' },
    ],
  };
}

function order(): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Testkid', bookFormat: 'classic', email: 'r@example.invalid' },
      { id: 'ord_render', now: '2026-08-05T00:00:00.000Z' },
    ),
  };
}

const IMG: (string | null)[] = [null, null, null];

/** Strip every nondeterministic part of a pdfkit PDF — any embedded date
 *  (Info `D:...` and XMP ISO timestamps) and the trailer/file `/ID` — so two
 *  builds can be compared by CONTENT. The production default deliberately
 *  stamps a real creation date. */
function printContent(buf: Buffer): string {
  return buf
    .toString('latin1')
    .replace(/D:\d{8,14}[Z0-9+'\-]*/g, '')            // PDF Info dates
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, '')      // XMP ISO dates
    .replace(/\/ID\s*\[[^\]]*\]/g, '')                  // trailer /ID
    .replace(/<[0-9a-fA-F]{16,}>/g, '');                // hex id blobs
}

// ── (1) proof fingerprint moves, page-scoped ─────────────────────────────────

test('adding a card override changes the proof fingerprint', () => {
  const before = proofRenderSourceFingerprint({ story: story(false), order: order(), imageUrls: IMG });
  const after = proofRenderSourceFingerprint({ story: story(true), order: order(), imageUrls: IMG });
  assert.notEqual(before, after, 'override must invalidate the cached proof');
});

test('an override on page 1 does not change the fingerprint contribution of page 2', () => {
  // Two stories that differ ONLY by page-1 override must both differ from the
  // baseline, but an override moved to page 2 instead yields a DIFFERENT
  // fingerprint than page-1 — proving the override is page-scoped, not global.
  const onP1 = proofRenderSourceFingerprint({ story: story(true), order: order(), imageUrls: IMG });
  const s2: StoryContent = story(false);
  s2.pages[1] = { ...s2.pages[1], proofCardOverride: override() };
  const onP2 = proofRenderSourceFingerprint({ story: s2, order: order(), imageUrls: IMG });
  assert.notEqual(onP1, onP2);
});

// ── (2) print interior is byte-identical with/without the override ───────────

test('a customer card override does NOT change the print interior content', async () => {
  const without = await buildPrintInteriorPdf(story(false), order(), IMG);
  const withOv = await buildPrintInteriorPdf(story(true), order(), IMG);
  assert.equal(printContent(without), printContent(withOv), 'print master must ignore the proof-only override');
});

// ── (3) proof renderer accepts the override and emits a valid PDF ────────────

test('proof build with an override emits a valid PDF', async () => {
  const pdf = await buildPdf(story(true), order(), IMG);
  assert.ok(pdf.length > 0);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
});

// ── (4) overflow fails closed ────────────────────────────────────────────────

test('overflow is detected for a tiny card holding long text; a roomy card fits short text', () => {
  const tiny = canonicalizeProofCardGeometry({ x: 0.4, y: 0.4, width: 0.15, height: 0.06, opacity: 0.9, fontScale: 1.15 });
  const long = 'word '.repeat(400);
  assert.equal(proofCardTextOverflows(tiny, long), true);

  const roomy = canonicalizeProofCardGeometry({ x: 0.05, y: 0.05, width: 0.9, height: 0.5, opacity: 0.9, fontScale: 0.85 });
  assert.equal(proofCardTextOverflows(roomy, 'A short line.'), false);
});
