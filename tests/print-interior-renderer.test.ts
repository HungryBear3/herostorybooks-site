/**
 * Print interior renderer (slice 2 of the print redesign).
 *
 * Locked product rule:
 *   digital  = 24 real story pages (no print interior)
 *   classic  = 24 real story pages
 *   premium  = 32 real story pages
 *
 * Print interior is now: front matter (2) + story (N) + filler safety
 * net (only if needed) + back matter (4). Filler is reduced from "the
 * normal path" to "safety net" — for new long-form orders it should
 * collapse or eliminate entirely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPdf,
  buildPrintInteriorPdf,
  getPrintFillerPageCount,
  getPrintInteriorPageCount,
} from '../src/lib/pdf-builder.ts';
import { createOrderRecord, type BookFormat } from '../src/lib/orders.ts';
import type { StoryContent, StoryPage } from '../src/lib/fulfillment-types.ts';

function buildStory(pageCount: number): StoryContent {
  const pages: StoryPage[] = Array.from({ length: pageCount }, (_, i) => ({
    pageNum: i + 1,
    sceneTitle: `Scene ${i + 1}`,
    story: `Story text page ${i + 1}.`,
    imagePrompt: `prompt page ${i + 1}`,
  }));
  return { title: 'Test Title', dedication: 'For Luna', characterDescription: 'A child.', pages };
}

function order(bookFormat: BookFormat) {
  return createOrderRecord(
    { childName: 'Luna', bookFormat, email: 'a@b.com' },
    { id: `ord_${bookFormat}`, now: '2026-05-01T10:00:00Z' },
  );
}

function countPdfPages(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
}

function countPdfImages(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Subtype \/Image\b/g) || []).length;
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6kAAAAASUVORK5CYII=';

async function withMockImageFetch(fn: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from(TINY_PNG_BASE64, 'base64');
  globalThis.fetch = async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }) as typeof Response.prototype;

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── Page-count helpers ─────────────────────────────────────────────────────

test('getPrintInteriorPageCount: classic 24-page story → 32 (24 story + 6 matter + 2 filler safety net)', () => {
  assert.equal(getPrintInteriorPageCount(buildStory(24), order('classic')), 32);
});

test('getPrintInteriorPageCount: premium 32-page story → 38 (32 story + 6 matter, no filler)', () => {
  assert.equal(getPrintInteriorPageCount(buildStory(32), order('premium')), 38);
});

test('getPrintFillerPageCount: new long-form premium → 0 filler (no longer the normal path)', () => {
  assert.equal(getPrintFillerPageCount(buildStory(32), order('premium')), 0);
});

test('getPrintFillerPageCount: new classic → 2 safety pages after the 6-page matter stack', () => {
  assert.equal(getPrintFillerPageCount(buildStory(24), order('classic')), 2);
});

test('getPrintFillerPageCount: legacy 6-page classic still pads up via safety net', () => {
  // 6 story + 6 matter = 12. Lulu min 32. Safety net fills the 20 gap.
  assert.equal(getPrintFillerPageCount(buildStory(6), order('classic')), 20);
});

test('getPrintFillerPageCount: legacy 6-page premium still pads up via safety net', () => {
  // 6 story + 6 matter = 12. Lulu min 24. Safety net fills the 12 gap.
  assert.equal(getPrintFillerPageCount(buildStory(6), order('premium')), 12);
});

// ── Rendered PDF page counts ───────────────────────────────────────────────

test('buildPrintInteriorPdf: classic 24-page story produces exactly 32 pages (matter + story + filler)', async () => {
  const pdf = await buildPrintInteriorPdf(
    buildStory(24),
    order('classic'),
    Array.from({ length: 25 }, () => null), // 1 cover slot + 24 story slots
  );
  assert.equal(countPdfPages(pdf), 32);
});

test('buildPrintInteriorPdf: premium 32-page story produces exactly 38 pages (no filler)', async () => {
  const pdf = await buildPrintInteriorPdf(
    buildStory(32),
    order('premium'),
    Array.from({ length: 33 }, () => null),
  );
  assert.equal(countPdfPages(pdf), 38);
});

test('buildPrintInteriorPdf: every print interior includes the 6 intentional matter pages', async () => {
  // Smoke check via the page-count helper — if matter pages are dropped
  // we'd see (story + filler) only and the totals above would shift.
  // Rebuilding the assertion to be robust against future page-add tweaks:
  const interiorMath = (storyPages: number, format: BookFormat) =>
    getPrintInteriorPageCount(buildStory(storyPages), order(format))
    - getPrintFillerPageCount(buildStory(storyPages), order(format))
    - storyPages;
  // story + matter + filler = total → matter = total - story - filler.
  assert.equal(interiorMath(24, 'classic'), 6);
  assert.equal(interiorMath(32, 'premium'), 6);
  assert.equal(interiorMath(6, 'classic'), 6);
  assert.equal(interiorMath(6, 'premium'), 6);
});

test('buildPdf: proof renderer embeds fetched story images', async () => {
  await withMockImageFetch(async () => {
    const pdf = await buildPdf(
      buildStory(2),
      order('classic'),
      ['https://example.test/cover.png', 'https://example.test/page-1.png', 'https://example.test/page-2.png'],
    );
    assert.ok(countPdfImages(pdf) >= 3);
  });
});

test('buildPrintInteriorPdf: interior renderer embeds fetched story images', async () => {
  await withMockImageFetch(async () => {
    const pdf = await buildPrintInteriorPdf(
      buildStory(2),
      order('classic'),
      ['https://example.test/cover.png', 'https://example.test/page-1.png', 'https://example.test/page-2.png'],
    );
    assert.ok(countPdfImages(pdf) >= 2);
  });
});
