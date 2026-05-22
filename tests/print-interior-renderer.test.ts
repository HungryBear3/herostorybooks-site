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
  fitPictureBookText,
  getPictureBookStoryLayout,
  getPrintFillerPageCount,
  getPrintInteriorPageCount,
} from '../src/lib/pdf-builder.ts';
import { createOrderRecord, type BookFormat } from '../src/lib/orders.ts';
import type { PageTextLayout, StoryContent, StoryPage } from '../src/lib/fulfillment-types.ts';

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

// ── Centering / safe-zone tests (Commit 1) ─────────────────────────────────
//
// These tests pin down the deterministic centering math added in commit 1.
// The bug they prevent: PDFKit text is top-anchored, so the legacy
// `textPanelY + 10` / `textPanelHeight - 20` draw call left uneven bottom
// whitespace on short story pages. The fix is `storyDrawY` /
// `storyDrawHeight` from `fitPictureBookText`, which centers the body
// inside the panel's safe zone (panel minus textInset + panelVerticalInset).

const SHORT_TEXT = 'Luna found one star.';
const MEDIUM_TEXT =
  'Luna climbed the soft hill at dusk. Fireflies blinked in the grass and the wind smelled like clean rain. She listened until the world felt slow.';
const LONG_TEXT = Array.from(
  { length: 6 },
  () =>
    'Luna walked under the long ribbon of stars and counted the ones that did not blink. A small fox followed two steps behind her, sniffing the cold air and humming a tune only foxes know.',
).join(' ');

function safeZone(layout: ReturnType<typeof getPictureBookStoryLayout>) {
  const top = layout.textPanelY + layout.panelVerticalInset;
  const bottom = layout.textPanelY + layout.textPanelHeight - layout.panelVerticalInset;
  return { top, bottom, height: bottom - top };
}

test('fitPictureBookText body-only: short text is centered inside the print safe zone', () => {
  const layout = getPictureBookStoryLayout('print');
  const fitted = fitPictureBookText(layout, 'Scene 1', SHORT_TEXT, { renderTitle: false });
  const zone = safeZone(layout);

  // Story must start inside the safe zone with some top padding.
  assert.ok(fitted.storyDrawY >= zone.top, 'storyDrawY must be at or below safeTop');
  assert.ok(fitted.storyDrawY + fitted.storyDrawHeight <= zone.bottom + 0.5,
    'storyDrawY + storyDrawHeight must stay inside safe zone');

  // Short text → measurable top padding (not top-anchored against safeTop).
  // The old hard-coded `textPanelY + 10` left this at 0 for short bodies.
  assert.ok(
    fitted.verticalPaddingTop > 0,
    'short text must produce non-zero verticalPaddingTop (i.e. actually be centered)',
  );

  // Vertical-centering delta: top padding should be close to bottom padding.
  // Estimate the rendered body height the same way the fit loop does
  // (single line × (storyFontSize + storyLineGap)). Single-line short
  // text → bottom padding = safeHeight - topPadding - bodyHeight, and
  // |top - bottom| should be ≤ 4pt for true centering.
  const bodyHeight = fitted.storyFontSize + fitted.storyLineGap;
  const bottomPadding = zone.height - fitted.verticalPaddingTop - bodyHeight;
  assert.ok(
    Math.abs(fitted.verticalPaddingTop - bottomPadding) <= 4,
    `top padding (${fitted.verticalPaddingTop}) should be within 4pt of bottom padding (${bottomPadding})`,
  );
});

test('fitPictureBookText body-only: medium text fits and stays inside safe zone', () => {
  const layout = getPictureBookStoryLayout('print');
  const fitted = fitPictureBookText(layout, 'Scene 1', MEDIUM_TEXT, { renderTitle: false });
  const zone = safeZone(layout);

  assert.ok(fitted.storyDrawY >= zone.top, 'storyDrawY must not be above safeTop');
  assert.ok(
    fitted.storyDrawY + fitted.storyDrawHeight <= zone.bottom + 0.5,
    'medium body must fit inside safe zone',
  );
  assert.ok(fitted.storyFontSize >= 11, 'storyFontSize must remain readable');
});

test('fitPictureBookText body-only: long text fits without drawing outside the safe zone', () => {
  const layout = getPictureBookStoryLayout('print');
  const fitted = fitPictureBookText(layout, 'Scene 1', LONG_TEXT, { renderTitle: false });
  const zone = safeZone(layout);

  // The shrink loop should bring the long body inside the safe zone.
  assert.ok(fitted.storyDrawY >= zone.top, 'long-text storyDrawY must not be above safeTop');
  assert.ok(
    fitted.storyDrawY + fitted.storyDrawHeight <= zone.bottom + 0.5,
    `long-text bottom (${fitted.storyDrawY + fitted.storyDrawHeight}) must stay ≤ safe-zone bottom (${zone.bottom})`,
  );

  // Long text fills the zone, so centering padding collapses to ~0.
  assert.ok(
    fitted.verticalPaddingTop <= 2,
    `long text should have minimal verticalPaddingTop, got ${fitted.verticalPaddingTop}`,
  );
});

test('fitPictureBookText body-only: title height is NOT budgeted when renderTitle is false', () => {
  const layout = getPictureBookStoryLayout('print');
  const withTitle = fitPictureBookText(layout, 'A Long Scene Title For Budgeting', MEDIUM_TEXT, { renderTitle: true });
  const bodyOnly = fitPictureBookText(layout, 'A Long Scene Title For Budgeting', MEDIUM_TEXT, { renderTitle: false });

  // Body-only must claim the same or larger draw height than the
  // title-budgeted variant — the title's vertical room is freed back to
  // the body.
  assert.ok(
    bodyOnly.storyDrawHeight >= withTitle.storyDrawHeight,
    `body-only storyDrawHeight (${bodyOnly.storyDrawHeight}) must be ≥ title-budgeted (${withTitle.storyDrawHeight})`,
  );
  // And body-only must NOT shift the story down by the title's height.
  assert.ok(
    bodyOnly.storyDrawY <= withTitle.storyDrawY,
    'body-only storyDrawY must not sit below the title-budgeted Y',
  );
  assert.equal(bodyOnly.renderTitle, false);
  assert.equal(withTitle.renderTitle, true);
});

test('getPictureBookStoryLayout: default (no textLayout) → bottom band panel, matching legacy print geometry', () => {
  const layout = getPictureBookStoryLayout('print');
  // Print: trim = 612, image height = 456, band height = 132, bandX = 36,
  // band width = 612 - 72 = 540.
  assert.equal(layout.textPanelX, 36);
  assert.equal(layout.textPanelY, 456);
  assert.equal(layout.textPanelWidth, 540);
  assert.equal(layout.textPanelHeight, 132);
  assert.equal(layout.textInset, 18);
  assert.equal(layout.panelVerticalInset, 10);
});

test('getPictureBookStoryLayout: legacy textLayout.zone metadata is IGNORED — panel stays at the bottom band', () => {
  // Release 1 contract: zone metadata never moves the panel. Only
  // panelStyle/colorMode flow through. This pins the contract so future
  // accidental zone routing fails loudly.
  const overrides: PageTextLayout[] = [
    { zone: 'top_band', panelStyle: 'translucent_cream', colorMode: 'auto' },
    { zone: 'bottom_right', panelStyle: 'translucent_cream', colorMode: 'auto' },
    { zone: 'top_left', panelStyle: 'translucent_dark', colorMode: 'auto' },
  ];
  for (const override of overrides) {
    const layout = getPictureBookStoryLayout('print', override);
    assert.equal(layout.textPanelX, 36, `zone=${override.zone} should not shift textPanelX`);
    assert.equal(layout.textPanelY, 456, `zone=${override.zone} should not shift textPanelY off the bottom band`);
    assert.equal(layout.textPanelWidth, 540);
    assert.equal(layout.textPanelHeight, 132);
    // Copy must never sit over art.
    assert.ok(
      layout.textPanelY >= layout.imageY + layout.imageHeight,
      `zone=${override.zone} should keep copy below art (Release 1 guard)`,
    );
  }
});
