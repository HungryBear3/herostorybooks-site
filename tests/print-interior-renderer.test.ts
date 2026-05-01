/**
 * Print interior renderer (slice 2 of the print redesign).
 *
 * Locked product rule:
 *   digital  =  6 real story pages (no print interior)
 *   classic  = 24 real story pages
 *   premium  = 32 real story pages
 *
 * Print interior is now: front matter (2) + story (N) + filler safety
 * net (only if needed) + back matter (2). Filler is reduced from "the
 * normal path" to "safety net" — for new long-form orders it should
 * collapse or eliminate entirely.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

// ── Page-count helpers ─────────────────────────────────────────────────────

test('getPrintInteriorPageCount: classic 24-page story → 32 (24 story + 4 matter + 4 filler safety net)', () => {
  assert.equal(getPrintInteriorPageCount(buildStory(24), order('classic')), 32);
});

test('getPrintInteriorPageCount: premium 32-page story → 36 (32 story + 4 matter, no filler)', () => {
  assert.equal(getPrintInteriorPageCount(buildStory(32), order('premium')), 36);
});

test('getPrintFillerPageCount: new long-form premium → 0 filler (no longer the normal path)', () => {
  assert.equal(getPrintFillerPageCount(buildStory(32), order('premium')), 0);
});

test('getPrintFillerPageCount: new classic → 4 filler (safety net to hit Lulu 32 minimum)', () => {
  assert.equal(getPrintFillerPageCount(buildStory(24), order('classic')), 4);
});

test('getPrintFillerPageCount: legacy 6-page classic still pads up via safety net', () => {
  // 6 story + 4 matter = 10. Lulu min 32. Safety net fills the 22 gap.
  assert.equal(getPrintFillerPageCount(buildStory(6), order('classic')), 22);
});

test('getPrintFillerPageCount: legacy 6-page premium still pads up via safety net', () => {
  // 6 story + 4 matter = 10. Lulu min 24. Safety net fills the 14 gap.
  assert.equal(getPrintFillerPageCount(buildStory(6), order('premium')), 14);
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

test('buildPrintInteriorPdf: premium 32-page story produces exactly 36 pages (no filler)', async () => {
  const pdf = await buildPrintInteriorPdf(
    buildStory(32),
    order('premium'),
    Array.from({ length: 33 }, () => null),
  );
  assert.equal(countPdfPages(pdf), 36);
});

test('buildPrintInteriorPdf: every print interior includes the 4 intentional matter pages', async () => {
  // Smoke check via the page-count helper — if matter pages are dropped
  // we'd see (story + filler) only and the totals above would shift.
  // Rebuilding the assertion to be robust against future page-add tweaks:
  const interiorMath = (storyPages: number, format: BookFormat) =>
    getPrintInteriorPageCount(buildStory(storyPages), order(format))
    - getPrintFillerPageCount(buildStory(storyPages), order(format))
    - storyPages;
  // story + matter + filler = total → matter = total - story - filler.
  assert.equal(interiorMath(24, 'classic'), 4);
  assert.equal(interiorMath(32, 'premium'), 4);
  assert.equal(interiorMath(6, 'classic'), 4);
  assert.equal(interiorMath(6, 'premium'), 4);
});
