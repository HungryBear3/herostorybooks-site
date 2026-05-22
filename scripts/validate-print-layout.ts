/**
 * Local print-layout validation report.
 *
 * Reads `.data/orders/ord_*.json` fixtures and, for any page with a
 * `storyText`, computes the deterministic print-panel layout produced
 * by `getPictureBookStoryLayout('print', ...)` + `fitPictureBookText`
 * (the centering math landed in commit 95b5c81). Emits a JSON and a
 * Markdown report to /tmp so we can eyeball overflow / centering
 * deltas without rebuilding any PDFs and without paying for image
 * generation.
 *
 * Usage:
 *   node --experimental-strip-types scripts/validate-print-layout.ts
 *
 * The script never calls Lulu, Stripe, fulfillment, image generation,
 * or any production side-effect — it is read-only over local fixtures
 * and writes only to /tmp.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { fitPictureBookText, getPictureBookStoryLayout } from '../src/lib/pdf-builder.ts';
import type { PageTextLayout } from '../src/lib/fulfillment-types.ts';

const CENTER_DELTA_WARN_THRESHOLD_PT = 12;
const OVERFLOW_TOLERANCE_PT = 0.5;
const MIN_READABLE_FONT_PT = 12;

export interface PrintLayoutReportRow {
  orderId: string;
  pageIndex: number;
  pageNumber: number;
  storyTextLength: number;
  panelRect: { x: number; y: number; width: number; height: number };
  safeZone: { top: number; bottom: number; height: number };
  storyDrawY: number;
  storyDrawHeight: number;
  verticalPaddingTop: number;
  storyFontSize: number;
  storyLineGap: number;
  estimatedBodyHeight: number;
  estimatedBottomPadding: number;
  centerDelta: number;
  overflow: boolean;
  warnings: string[];
}

export interface AnalyzePrintPageLayoutInput {
  orderId: string;
  pageIndex: number;
  sceneTitle?: string;
  storyText: string;
  textLayout?: PageTextLayout;
}

/**
 * Pure: compute one report row for a print page. The body-height
 * estimate mirrors `estimateWrappedLineCount` in pdf-builder (we can't
 * import it without re-exporting, and the math is small/stable enough
 * to reproduce here for the report).
 */
export function analyzePrintPageLayout(
  input: AnalyzePrintPageLayoutInput,
): PrintLayoutReportRow {
  const layout = getPictureBookStoryLayout('print', input.textLayout);
  const fitted = fitPictureBookText(
    layout,
    input.sceneTitle ?? '',
    input.storyText,
    { renderTitle: false },
  );

  const safeTop = layout.textPanelY + layout.panelVerticalInset;
  const safeBottom = layout.textPanelY + layout.textPanelHeight - layout.panelVerticalInset;
  const safeHeight = safeBottom - safeTop;

  const textWidth = layout.textPanelWidth - layout.textInset * 2;
  const approxCharsPerLine = Math.max(
    10,
    Math.floor(textWidth / (fitted.storyFontSize * 0.56)),
  );
  const storyLines = Math.max(1, Math.ceil(input.storyText.length / approxCharsPerLine));
  const estimatedBodyHeight = storyLines * (fitted.storyFontSize + fitted.storyLineGap);

  const estimatedBottomPadding = safeBottom - fitted.storyDrawY - estimatedBodyHeight;
  const centerDelta = Math.abs(fitted.verticalPaddingTop - estimatedBottomPadding);
  const overflow = fitted.storyDrawY + estimatedBodyHeight > safeBottom + OVERFLOW_TOLERANCE_PT;

  const warnings: string[] = [];
  if (overflow) {
    const over = fitted.storyDrawY + estimatedBodyHeight - safeBottom;
    warnings.push(`body overflows safe zone by ${over.toFixed(1)}pt`);
  }
  if (centerDelta > CENTER_DELTA_WARN_THRESHOLD_PT) {
    warnings.push(`center delta ${centerDelta.toFixed(1)}pt > ${CENTER_DELTA_WARN_THRESHOLD_PT}pt`);
  }
  if (fitted.storyFontSize < MIN_READABLE_FONT_PT) {
    warnings.push(`storyFontSize=${fitted.storyFontSize} below readable threshold ${MIN_READABLE_FONT_PT}pt`);
  }

  return {
    orderId: input.orderId,
    pageIndex: input.pageIndex,
    pageNumber: input.pageIndex + 1,
    storyTextLength: input.storyText.length,
    panelRect: {
      x: layout.textPanelX,
      y: layout.textPanelY,
      width: layout.textPanelWidth,
      height: layout.textPanelHeight,
    },
    safeZone: { top: safeTop, bottom: safeBottom, height: safeHeight },
    storyDrawY: fitted.storyDrawY,
    storyDrawHeight: fitted.storyDrawHeight,
    verticalPaddingTop: fitted.verticalPaddingTop,
    storyFontSize: fitted.storyFontSize,
    storyLineGap: fitted.storyLineGap,
    estimatedBodyHeight,
    estimatedBottomPadding,
    centerDelta,
    overflow,
    warnings,
  };
}

interface SkippedFixture {
  file: string;
  reason: string;
}

interface ReportSummary {
  generatedAt: string;
  ordersDir: string;
  fixturesScanned: number;
  fixturesUsed: number;
  pagesAnalyzed: number;
  pagesWithOverflow: number;
  pagesWithCenterWarning: number;
  pagesWithFontWarning: number;
  skipped: SkippedFixture[];
}

export interface PrintLayoutReport {
  summary: ReportSummary;
  rows: PrintLayoutReportRow[];
}

interface FixtureRecord {
  id?: string;
  pageArtifacts?: Array<Record<string, unknown>>;
  story?: { pages?: Array<Record<string, unknown>> };
}

function extractPages(
  fixture: FixtureRecord,
): Array<{ pageIndex: number; sceneTitle?: string; storyText: string; textLayout?: PageTextLayout }> {
  const out: Array<{ pageIndex: number; sceneTitle?: string; storyText: string; textLayout?: PageTextLayout }> = [];
  const candidates =
    (Array.isArray(fixture.pageArtifacts) && fixture.pageArtifacts) ||
    (fixture.story && Array.isArray(fixture.story.pages) && fixture.story.pages) ||
    [];
  candidates.forEach((page, idx) => {
    const storyText =
      typeof page.storyText === 'string'
        ? page.storyText
        : typeof page.story === 'string'
        ? page.story
        : null;
    if (!storyText) return;
    const pageIndex =
      typeof page.pageIndex === 'number'
        ? page.pageIndex
        : typeof page.pageNum === 'number'
        ? page.pageNum - 1
        : idx;
    out.push({
      pageIndex,
      sceneTitle: typeof page.sceneTitle === 'string' ? page.sceneTitle : undefined,
      storyText,
      textLayout: (page.textLayout as PageTextLayout | undefined) ?? undefined,
    });
  });
  return out;
}

export async function buildReport(ordersDir: string): Promise<PrintLayoutReport> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(ordersDir)).filter((f) => f.startsWith('ord_') && f.endsWith('.json'));
  } catch {
    // Directory missing — handled by the empty-files path below.
  }

  const rows: PrintLayoutReportRow[] = [];
  const skipped: SkippedFixture[] = [];
  let fixturesUsed = 0;

  for (const file of files) {
    const full = path.join(ordersDir, file);
    let fixture: FixtureRecord;
    try {
      fixture = JSON.parse(await fs.readFile(full, 'utf8')) as FixtureRecord;
    } catch (err) {
      skipped.push({ file, reason: `parse error: ${(err as Error).message}` });
      continue;
    }
    const orderId = fixture.id ?? file.replace(/\.json$/, '');
    const pages = extractPages(fixture);
    if (pages.length === 0) {
      skipped.push({ file, reason: 'no pages with storyText' });
      continue;
    }
    for (const page of pages) {
      rows.push(
        analyzePrintPageLayout({
          orderId,
          pageIndex: page.pageIndex,
          sceneTitle: page.sceneTitle,
          storyText: page.storyText,
          textLayout: page.textLayout,
        }),
      );
    }
    fixturesUsed++;
  }

  const summary: ReportSummary = {
    generatedAt: new Date().toISOString(),
    ordersDir,
    fixturesScanned: files.length,
    fixturesUsed,
    pagesAnalyzed: rows.length,
    pagesWithOverflow: rows.filter((r) => r.overflow).length,
    pagesWithCenterWarning: rows.filter((r) => r.warnings.some((w) => w.startsWith('center delta'))).length,
    pagesWithFontWarning: rows.filter((r) => r.warnings.some((w) => w.startsWith('storyFontSize'))).length,
    skipped,
  };
  return { summary, rows };
}

export function renderMarkdown(report: PrintLayoutReport): string {
  const { summary, rows } = report;
  const lines: string[] = [];
  lines.push('# HSB print-layout validation report');
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Orders dir: \`${summary.ordersDir}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Fixtures scanned: ${summary.fixturesScanned}`);
  lines.push(`- Fixtures with usable pages: ${summary.fixturesUsed}`);
  lines.push(`- Pages analyzed: ${summary.pagesAnalyzed}`);
  lines.push(`- Pages with overflow: ${summary.pagesWithOverflow}`);
  lines.push(`- Pages with center-delta warning (>${CENTER_DELTA_WARN_THRESHOLD_PT}pt): ${summary.pagesWithCenterWarning}`);
  lines.push(`- Pages with font-size warning (<${MIN_READABLE_FONT_PT}pt): ${summary.pagesWithFontWarning}`);
  lines.push('');

  if (summary.skipped.length > 0) {
    lines.push('## Skipped fixtures');
    lines.push('');
    for (const s of summary.skipped) {
      lines.push(`- \`${s.file}\` — ${s.reason}`);
    }
    lines.push('');
  }

  if (rows.length === 0) {
    lines.push('## No usable fixtures found');
    lines.push('');
    lines.push('No `.data/orders/ord_*.json` fixtures contained pages with `storyText`. ');
    lines.push('Drop a fixture into `.data/orders/` and re-run.');
    return lines.join('\n');
  }

  lines.push('## Page rows');
  lines.push('');
  lines.push('| Order | Page | Chars | StoryDrawY | StoryDrawH | PadTop | EstBodyH | EstBotPad | CenterΔ | Font | Overflow | Warnings |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const warns = r.warnings.length > 0 ? r.warnings.join('; ') : '';
    lines.push(
      `| ${r.orderId} | ${r.pageNumber} | ${r.storyTextLength} | ${r.storyDrawY.toFixed(1)} | ${r.storyDrawHeight.toFixed(1)} | ${r.verticalPaddingTop.toFixed(1)} | ${r.estimatedBodyHeight.toFixed(1)} | ${r.estimatedBottomPadding.toFixed(1)} | ${r.centerDelta.toFixed(1)} | ${r.storyFontSize} | ${r.overflow ? 'YES' : 'no'} | ${warns} |`,
    );
  }
  lines.push('');

  const warned = rows.filter((r) => r.warnings.length > 0);
  if (warned.length > 0) {
    lines.push('## Pages with warnings');
    lines.push('');
    for (const r of warned) {
      lines.push(`- \`${r.orderId}\` page ${r.pageNumber}: ${r.warnings.join('; ')}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const ordersDir = path.join(process.cwd(), '.data/orders');
  const report = await buildReport(ordersDir);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = `/tmp/hsb-print-layout-report-${ts}.json`;
  const mdPath = `/tmp/hsb-print-layout-report-${ts}.md`;
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(mdPath, renderMarkdown(report));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(
    `Pages analyzed: ${report.summary.pagesAnalyzed} ` +
      `(overflow=${report.summary.pagesWithOverflow}, ` +
      `centerWarn=${report.summary.pagesWithCenterWarning}, ` +
      `fontWarn=${report.summary.pagesWithFontWarning})`,
  );
  if (report.summary.pagesAnalyzed === 0) {
    console.log('No usable fixtures found — see report for details.');
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
