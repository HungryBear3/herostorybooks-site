/**
 * Focused tests for the pure helper inside scripts/validate-print-layout.ts.
 *
 * The script also has a `main()` that walks `.data/orders/` and writes
 * timestamped report files to /tmp. That part is exercised manually by
 * running the script. Here we only pin the math the report depends on,
 * so the helper stays a stable contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzePrintPageLayout, renderMarkdown, type PrintLayoutReport } from '../scripts/validate-print-layout.ts';

const SHORT = 'Luna found one star.';
const MEDIUM =
  'Luna climbed the soft hill at dusk. Fireflies blinked in the grass and the wind smelled like clean rain. She listened until the world felt slow.';
const LONG = Array.from(
  { length: 6 },
  () =>
    'Luna walked under the long ribbon of stars and counted the ones that did not blink. A small fox followed two steps behind her, sniffing the cold air and humming a tune only foxes know.',
).join(' ');

test('analyzePrintPageLayout: short text → centered, no warnings, panel rect at print bottom band', () => {
  const row = analyzePrintPageLayout({ orderId: 'ord_test', pageIndex: 0, storyText: SHORT });
  // Locked-in print bottom-band geometry from getPictureBookStoryLayout.
  assert.deepEqual(row.panelRect, { x: 36, y: 456, width: 540, height: 132 });
  assert.equal(row.safeZone.top, 466);
  assert.equal(row.safeZone.bottom, 578);
  assert.equal(row.safeZone.height, 112);

  // Short body must be centered: storyDrawY pushed below safeTop, and
  // bottom padding ≈ top padding (within the 4pt threshold the centering
  // tests already pin).
  assert.ok(row.verticalPaddingTop > 0, 'short text must be centered (non-zero top padding)');
  assert.ok(row.centerDelta <= 4, `expected centerDelta ≤ 4pt, got ${row.centerDelta}`);
  assert.equal(row.overflow, false);
  assert.deepEqual(row.warnings, []);
});

test('analyzePrintPageLayout: medium text → fits inside safe zone, font stays readable', () => {
  const row = analyzePrintPageLayout({ orderId: 'ord_test', pageIndex: 1, storyText: MEDIUM });
  assert.equal(row.overflow, false);
  assert.ok(row.storyFontSize >= 12, `storyFontSize must remain readable, got ${row.storyFontSize}`);
  assert.equal(row.warnings.filter((w) => w.startsWith('storyFontSize')).length, 0);
});

test('analyzePrintPageLayout: long text → top padding collapses, no overflow when fit loop succeeds', () => {
  const row = analyzePrintPageLayout({ orderId: 'ord_test', pageIndex: 2, storyText: LONG });
  assert.ok(row.verticalPaddingTop <= 2, `long text should collapse top padding, got ${row.verticalPaddingTop}`);
  // The fit loop is allowed to shrink font; the report's overflow flag
  // must agree with whether the estimated body actually fits.
  if (row.overflow) {
    assert.ok(row.warnings.some((w) => w.startsWith('body overflows')), 'overflow must surface a warning');
  }
});

test('analyzePrintPageLayout: legacy textLayout.zone metadata does NOT shift the panel rect', () => {
  const top = analyzePrintPageLayout({
    orderId: 'ord_test',
    pageIndex: 0,
    storyText: SHORT,
    textLayout: { zone: 'top_band', panelStyle: 'translucent_cream', colorMode: 'auto' },
  });
  const corner = analyzePrintPageLayout({
    orderId: 'ord_test',
    pageIndex: 1,
    storyText: SHORT,
    textLayout: { zone: 'bottom_right', panelStyle: 'translucent_cream', colorMode: 'auto' },
  });
  for (const row of [top, corner]) {
    assert.deepEqual(
      row.panelRect,
      { x: 36, y: 456, width: 540, height: 132 },
      'Release 1 contract: zone metadata is preserved by type but copy stays in the bottom paper band',
    );
  }
});

test('renderMarkdown: empty report emits a clear "no usable fixtures" section', () => {
  const empty: PrintLayoutReport = {
    summary: {
      generatedAt: '2026-05-22T00:00:00.000Z',
      ordersDir: '/abs/.data/orders',
      fixturesScanned: 0,
      fixturesUsed: 0,
      pagesAnalyzed: 0,
      pagesWithOverflow: 0,
      pagesWithCenterWarning: 0,
      pagesWithFontWarning: 0,
      skipped: [],
    },
    rows: [],
  };
  const md = renderMarkdown(empty);
  assert.match(md, /No usable fixtures found/);
  assert.match(md, /# HSB print-layout validation report/);
});
