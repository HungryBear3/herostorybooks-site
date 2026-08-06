import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OrderRecord } from './orders.ts';
import type {
  LayoutVersion,
  PageTextLayout,
  ProofCardOverride,
  ProofTextColor,
  StoryContent,
  TextColorMode,
  TextPanelStyle,
} from './fulfillment-types.ts';
import { isKnownLayoutVersion, isModernLayout, isValidPageTextLayout } from './fulfillment-types.ts';
import {
  canonicalizeProofCardGeometry,
  isValidProofCardOverride,
  resolveProofTextColor,
  resolveProofCardFontFit,
  PROOF_ART_FRAME_HEIGHT_PT,
  PROOF_CARD_TEXT_INSET_PT,
  PROOF_CARD_VERTICAL_INSET_PT,
  PROOF_CARD_CORNER_RADIUS_PT,
  type ProofCardFit,
  type ProofCardGeometry,
} from './proof-layout-override.ts';

/**
 * Thrown when a book explicitly marked `modern_full_bleed` reaches the story
 * renderer with a page whose layout metadata is missing or invalid. The build
 * aborts (fail closed) rather than silently coercing to the legacy bottom
 * band, so a partial/legacy proof is never produced for a modern book.
 */
export class ModernLayoutMetadataError extends Error {
  readonly pageIndex: number | undefined;
  constructor(pageIndex?: number) {
    super(
      `Modern book is missing valid per-page layout metadata` +
        (pageIndex != null ? ` (page index ${pageIndex})` : '') +
        ` — refusing to render through the legacy bottom band`,
    );
    this.name = 'ModernLayoutMetadataError';
    this.pageIndex = pageIndex;
  }
}

/**
 * Thrown when a proof over-art card's text cannot fit its bounded card at the
 * approved minimum font — the build fails closed rather than ellipsis-clipping
 * customer prose. Deterministic and privacy-safe: it carries only the page
 * index (never story text, child name, order id, email, or any PII).
 */
export class ProofCardOverflowError extends Error {
  readonly pageIndex: number | undefined;
  constructor(pageIndex?: number) {
    super(
      `Proof over-art card text overflows its bounded card` +
        (pageIndex != null ? ` (page index ${pageIndex})` : '') +
        ` — refusing to clip`,
    );
    this.name = 'ProofCardOverflowError';
    this.pageIndex = pageIndex;
  }
}

/** Unknown persisted layout markers must never silently select legacy output. */
export class UnknownLayoutVersionError extends Error {
  constructor() {
    super('Unknown layout version — refusing to render through the legacy bottom band');
    this.name = 'UnknownLayoutVersionError';
  }
}

// Import the standalone PDFKit build directly. The default 'pdfkit' entry
// (js/pdfkit.js) reads its AFM font metrics from node_modules/pdfkit/js/data
// at runtime via fs.readFileSync, which fails on Vercel serverless with:
//   ENOENT: no such file or directory, open
//   '/ROOT/node_modules/pdfkit/js/data/Helvetica.afm'
// because Next 16's NFT cannot statically detect those fs reads. Two
// next.config.js packaging attempts (outputFileTracingIncludes and
// serverExternalPackages) did not resolve the runtime ENOENT.
//
// pdfkit.standalone.js is a self-contained variant (~2.4 MB vs ~200 KB)
// with all AFM font data inlined via the bundled virtual-fs shim — no
// runtime fs reads. Same PDFDocument API; types still come from
// '@types/pdfkit' via the type-only import below.
//
import PDFDocumentStandalone from 'pdfkit/js/pdfkit.standalone.js';
import type PDFDocumentType from 'pdfkit';
const PDFDocument = PDFDocumentStandalone as unknown as typeof PDFDocumentType;

const PAGE_WIDTH = 595.28;  // A4 pt
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const FOREST = '#1F3A5F';
const GOLD = '#D4AF37';
const CREAM = '#FFF8F0';
const SLATE = '#475569';
const TEXT_SCRIM = '#0F172A';
const TEXT_ON_SCRIM = '#FFF9F1';

const EMBEDDED_BOOK_FONT = readFileSync(path.join(process.cwd(), 'src/lib/fonts/Geist-Regular.ttf'));
const NO_LIGATURE_FEATURES = { liga: false, clig: false, dlig: false, hlig: false };

function withNoLigatureText<T extends InstanceType<typeof PDFDocument>>(doc: T): T {
  const originalText = doc.text.bind(doc);
  doc.text = ((text: string, x?: number | string | Record<string, unknown>, y?: number | string | Record<string, unknown>, options?: Record<string, unknown>) => {
    if (typeof x === 'object' && x !== null) {
      return originalText(text, { ...(x as Record<string, unknown>), features: NO_LIGATURE_FEATURES } as never);
    }
    if (typeof y === 'object' && y !== null) {
      return originalText(text, x as never, { ...(y as Record<string, unknown>), features: NO_LIGATURE_FEATURES } as never);
    }
    return originalText(text, x as never, y as never, { ...(options ?? {}), features: NO_LIGATURE_FEATURES } as never);
  }) as typeof doc.text;
  return doc;
}

function assertPdfEmbedsFonts(buffer: Buffer, label: string): void {
  const raw = buffer.toString('latin1');
  if (/\/BaseFont\/(Helvetica(?:-Bold)?|Times-Roman|Courier(?:-Bold)?)/.test(raw)) {
    throw new Error(`${label} uses an unembedded base PDF font; commercial print PDFs must embed fonts.`);
  }
  if (!/\/FontFile[123]\b/.test(raw)) {
    throw new Error(`${label} is missing embedded font data.`);
  }
}

export interface PictureBookStoryLayout {
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
  textPanelX: number;
  textPanelY: number;
  textPanelWidth: number;
  textPanelHeight: number;
  /** Horizontal inset applied symmetrically inside the text panel. Story
   *  copy is drawn between `textPanelX + textInset` and
   *  `textPanelX + textPanelWidth - textInset`. */
  textInset: number;
  /** Vertical inset applied symmetrically at the top + bottom of the text
   *  panel. The "text safe zone" rectangle (used by the centering math
   *  and by the layout tests) is the panel minus textInset on the sides
   *  and panelVerticalInset on the top/bottom. Held distinct from
   *  textInset so we don't accidentally shrink the existing typography
   *  budget — the legacy hard-coded value was +10pt top / -20pt height,
   *  which matches `panelVerticalInset: 10`. */
  panelVerticalInset: number;
  textPanelFillOpacity: number;
  sceneTitleY: number;
  pageNumberY: number;
  /** How the panel rectangle behind the text is rendered. Release 1 story
   *  pages must never use the old translucent dark overlay; all story copy
   *  resolves to dark text on an opaque cream paper band. */
  textPanelStyle: TextPanelStyle;
  /** Resolved color mode for the rendered text. 'auto' is collapsed to
   *  light/dark inside this helper based on panelStyle so the renderer
   *  can pick a fill color directly. */
  textColorMode: Exclude<TextColorMode, 'auto'>;
}

export interface FittedPictureBookText {
  sceneTitleFontSize: number;
  sceneTitleHeight: number;
  storyFontSize: number;
  storyLineGap: number;
  /** Legacy top-anchored story Y. Kept for backward compatibility — the
   *  renderers now consume storyDrawY instead. */
  storyY: number;
  /** Legacy story-height from the top-anchored Y to the panel bottom. */
  storyHeight: number;
  /** Legacy scene-title Y. */
  sceneTitleY: number;
  /** Mirrors the renderTitle option so the renderer doesn't have to
   *  remember which path it asked for. */
  renderTitle: boolean;
  /** Y at which the renderer should draw the story body. When
   *  renderTitle is false, this is vertically centered inside the safe
   *  zone (panel minus textInset/panelVerticalInset). When renderTitle
   *  is true, the title + story block is centered as a group and
   *  storyDrawY lands below the title. */
  storyDrawY: number;
  /** Maximum height the story body can occupy starting at storyDrawY.
   *  Always stays inside the safe zone. */
  storyDrawHeight: number;
  /** Y at which the renderer should draw the scene title (only used
   *  when renderTitle is true). */
  titleDrawY: number;
  /** Vertical padding above the title/story block — i.e. the centering
   *  offset. 0 when the rendered content fills the safe zone. */
  verticalPaddingTop: number;
}

export interface FitPictureBookTextOptions {
  /** When false (the new print/proof default for body-only pages), the
   *  helper does NOT reserve vertical room for the title and centers
   *  the story body alone inside the panel safe zone. When true, it
   *  budgets for the title and centers the title+body group. */
  renderTitle?: boolean;
}

/** Resolve a PageTextLayout's auto fields against the panel style so the
 *  renderer never has to guess. Pure — exposed for tests. */
export function resolvePageTextLayout(layout?: PageTextLayout): {
  panelStyle: TextPanelStyle;
  colorMode: Exclude<TextColorMode, 'auto'>;
  zone: PageTextLayout['zone'];
} {
  const requestedStyle: TextPanelStyle = layout?.panelStyle ?? 'translucent_cream';
  const panelStyle: TextPanelStyle =
    requestedStyle === 'translucent_dark' || requestedStyle === 'soft_scrim'
      ? 'translucent_cream'
      : requestedStyle;
  const requestedMode = layout?.colorMode ?? 'auto';
  const colorMode: Exclude<TextColorMode, 'auto'> =
    requestedMode === 'auto' || requestedStyle === 'translucent_dark' || requestedStyle === 'soft_scrim'
      ? 'dark'
      : requestedMode;
  return { panelStyle, colorMode, zone: layout?.zone ?? 'natural' };
}

export function getPictureBookStoryLayout(
  kind: 'proof' | 'print',
  textLayout?: PageTextLayout,
  layoutVersion?: LayoutVersion | null,
  pageIndex?: number,
): PictureBookStoryLayout {
  if (!isKnownLayoutVersion(layoutVersion)) {
    throw new UnknownLayoutVersionError();
  }
  // Fail closed for modern books: an explicitly-modern book must carry valid
  // per-page layout metadata. Never silently fall back to the legacy bottom
  // band for a modern page. Legacy/unmarked books keep the existing tolerant
  // normalization below.
  if (isModernLayout(layoutVersion) && !isValidPageTextLayout(textLayout)) {
    throw new ModernLayoutMetadataError(pageIndex);
  }

  // Release 1 contract: story pages are always rendered as a clean bottom
  // paper band under the art. Legacy `textLayout.zone` metadata is parsed
  // through resolvePageTextLayout so panelStyle/colorMode normalization
  // still happens, but the panel rectangle itself is pinned to the bottom
  // band — copy must never sit over art. Per-page zone routing is
  // intentionally out of scope for Commit 1.
  const { panelStyle, colorMode } = resolvePageTextLayout(textLayout);

  if (kind === 'print') {
    const trimWidth = 8.5 * 72;
    const trimHeight = 8.5 * 72;
    const imageHeight = 456;
    const bandHeight = 132;
    const bandX = 36;
    const bandWidth = trimWidth - 72;
    return {
      imageX: 0,
      imageY: 0,
      imageWidth: trimWidth,
      imageHeight,
      textInset: 18,
      panelVerticalInset: 10,
      textPanelFillOpacity: 1,
      pageNumberY: trimHeight - 24,
      textPanelStyle: panelStyle,
      textColorMode: colorMode,
      textPanelX: bandX,
      textPanelY: imageHeight,
      textPanelWidth: bandWidth,
      textPanelHeight: bandHeight,
      sceneTitleY: imageHeight + 12,
    };
  }

  const imageHeight = 650;
  const bandHeight = 156;
  const bandX = 42;
  const bandWidth = PAGE_WIDTH - 84;
  return {
    imageX: 0,
    imageY: 0,
    imageWidth: PAGE_WIDTH,
    imageHeight,
    textInset: 20,
    panelVerticalInset: 10,
    textPanelFillOpacity: 1,
    pageNumberY: PAGE_HEIGHT - 24,
    textPanelStyle: panelStyle,
    textColorMode: colorMode,
    textPanelX: bandX,
    textPanelY: imageHeight,
    textPanelWidth: bandWidth,
    textPanelHeight: bandHeight,
    sceneTitleY: imageHeight + 12,
  };
}

function estimateWrappedLineCount(text: string, fontSize: number, width: number, weight: number): number {
  const approxCharsPerLine = Math.max(10, Math.floor(width / (fontSize * weight)));
  return Math.max(1, Math.ceil(text.length / approxCharsPerLine));
}

/**
 * Fit story (and optionally title) inside a panel's safe zone and return
 * deterministic draw coordinates the renderer can pass straight into
 * `doc.text(...)`. Output fields `storyDrawY` / `storyDrawHeight` /
 * `titleDrawY` are vertically centered when the rendered content is
 * shorter than the safe zone — fixing the previous top-anchor bug where
 * short story bodies left uneven whitespace at the bottom of the cream
 * band.
 *
 * `options.renderTitle` defaults to true (legacy behavior: budget for
 * title). Pass `false` for body-only pages — both active story render
 * paths currently omit the title, so they pass false. When false, the
 * helper does not reserve any vertical room for the title, which gives
 * the story body access to the full safe zone and removes the extra
 * bottom whitespace previously caused by a phantom title budget.
 *
 * The legacy `storyY` / `sceneTitleY` fields are preserved on the
 * return type so any older caller still compiles, but the active
 * renderers now consume `storyDrawY` / `titleDrawY` instead.
 */
export function fitPictureBookText(
  layout: PictureBookStoryLayout,
  sceneTitle: string,
  storyText: string,
  options: FitPictureBookTextOptions = {},
): FittedPictureBookText {
  const renderTitle = options.renderTitle ?? true;
  const textWidth = layout.textPanelWidth - layout.textInset * 2;

  // Safe zone = panel rect minus the textInset on each side and the
  // panelVerticalInset on top/bottom. All centering math operates on
  // this rectangle.
  const safeTop = layout.textPanelY + layout.panelVerticalInset;
  const safeBottom = layout.textPanelY + layout.textPanelHeight - layout.panelVerticalInset;
  const safeHeight = safeBottom - safeTop;

  let sceneTitleFontSize = 15;
  let storyFontSize = 15;
  let storyLineGap = 5;

  // Iterative shrink loop — same shape as before, but now considers
  // whether the renderer actually plans to draw the title. When
  // renderTitle is false, titleHeight is treated as 0 in the budget.
  while (sceneTitleFontSize > 11) {
    const titleLines = renderTitle
      ? estimateWrappedLineCount(sceneTitle.toUpperCase(), sceneTitleFontSize, textWidth, 0.62)
      : 0;
    const titleHeight = renderTitle ? titleLines * (sceneTitleFontSize + 2) : 0;
    const titleStoryGap = renderTitle ? 8 : 0;

    const storyLines = estimateWrappedLineCount(storyText, storyFontSize, textWidth, 0.56);
    const neededStoryHeight = storyLines * (storyFontSize + storyLineGap);
    const renderedTotalHeight = titleHeight + titleStoryGap + neededStoryHeight;

    const fits =
      renderedTotalHeight <= safeHeight &&
      (!renderTitle || titleHeight <= safeHeight * 0.45);

    if (fits) {
      const verticalPaddingTop = Math.max(
        0,
        Math.floor((safeHeight - renderedTotalHeight) / 2),
      );
      const titleDrawY = safeTop + verticalPaddingTop;
      const storyDrawY = titleDrawY + titleHeight + titleStoryGap;
      const storyDrawHeight = Math.max(24, safeBottom - storyDrawY);
      // Legacy top-anchored fields kept stable for any other reader.
      const storyY = layout.sceneTitleY + titleHeight + 8;
      const storyHeight = layout.textPanelY + layout.textPanelHeight - storyY - 8;
      return {
        sceneTitleFontSize,
        sceneTitleHeight: titleHeight,
        storyFontSize,
        storyLineGap,
        storyY,
        storyHeight,
        sceneTitleY: layout.sceneTitleY,
        renderTitle,
        storyDrawY,
        storyDrawHeight,
        titleDrawY,
        verticalPaddingTop,
      };
    }

    if (storyFontSize > 12) storyFontSize -= 1;
    else if (storyLineGap > 3) storyLineGap -= 1;
    else if (renderTitle) sceneTitleFontSize -= 1;
    else break; // body-only path can't shrink further once font/lineGap bottoms out
  }

  // Fallback — text is too long to fit at the minimum size; ellipsis at
  // draw time will handle clipping. We still emit centered coords for
  // the title block (even if it overflows) so the renderer stays
  // deterministic and tests stay green on a known edge.
  const titleLines = renderTitle
    ? estimateWrappedLineCount(sceneTitle.toUpperCase(), sceneTitleFontSize, textWidth, 0.62)
    : 0;
  const titleHeight = renderTitle ? titleLines * (sceneTitleFontSize + 2) : 0;
  const titleStoryGap = renderTitle ? 8 : 0;
  const verticalPaddingTop = 0;
  const titleDrawY = safeTop;
  const storyDrawY = titleDrawY + titleHeight + titleStoryGap;
  const storyDrawHeight = Math.max(24, safeBottom - storyDrawY);
  const storyY = layout.sceneTitleY + titleHeight + 8;
  const storyHeight = Math.max(24, layout.textPanelY + layout.textPanelHeight - storyY - 8);
  return {
    sceneTitleFontSize,
    sceneTitleHeight: titleHeight,
    storyFontSize,
    storyLineGap,
    storyY,
    storyHeight,
    sceneTitleY: layout.sceneTitleY,
    renderTitle,
    storyDrawY,
    storyDrawHeight,
    titleDrawY,
    verticalPaddingTop,
  };
}

type BookFormat = OrderRecord['bookFormat'];

interface KeepsakePage {
  title: string;
  body: string;
  prompt?: string;
}

function getMinimumTotalPages(bookFormat: BookFormat): number {
  if (bookFormat === 'classic') return 32;
  if (bookFormat === 'premium') return 24;
  return 0;
}

/** Intentional, designed front-and-back matter pages added to every print
 *  interior/proof. These pages make the book feel finished without padding
 *  the story itself. */
const FRONT_MATTER_COUNT = 2;
const BACK_MATTER_COUNT = 4;
const INTENTIONAL_MATTER_PAGES = FRONT_MATTER_COUNT + BACK_MATTER_COUNT;

interface MatterPage {
  kind: 'title' | 'dedication' | 'end' | 'copyright' | 'belongs' | 'closing';
  title: string;
  body: string;
  prompt?: string;
}

interface KeepsakePage {
  kind?: 'endpaper' | 'vignette' | 'copyright';
  title: string;
  body: string;
  prompt?: string;
}

function childFirstName(order: OrderRecord): string {
  return order.childName.trim().split(/\s+/)[0] || order.childName.trim();
}

function buildRichDedication(_story: StoryContent, order: OrderRecord): string {
  const firstName = childFirstName(order);
  return `For ${firstName} — may every brave step lead to a wonderful story.`;
}

function buildFrontMatterPages(story: StoryContent, order: OrderRecord): MatterPage[] {
  return [
    {
      kind: 'title',
      title: story.title,
      body: 'A HeroStoryBooks Original',
    },
    {
      kind: 'dedication',
      title: '',
      body: buildRichDedication(story, order),
    },
  ];
}

function buildCopyrightBody(story: StoryContent, order: OrderRecord): string {
  return (
    `© 2026 Hero Story Books. All rights reserved.\n\n` +
    `This book was created uniquely for ${order.childName}.\n` +
    'Personal use only. No part of this book may be reproduced for resale.\n\n' +
    'Illustrations generated with AI assistance and reviewed before printing.\n\n' +
    `First printing, May 2026. Printed in the United States.\n\n` +
    `Hero Story Books Edition: ${order.id}\n` +
    'herostorybooks.com'
  );
}

function buildBackMatterPages(story: StoryContent, order: OrderRecord): MatterPage[] {
  const firstName = childFirstName(order);
  return [
    {
      kind: 'end',
      title: 'The End',
      body: `Thank you for reading ${story.title} together.`,
    },
    {
      kind: 'copyright',
      title: story.title,
      body: buildCopyrightBody(story, order),
    },
    {
      kind: 'belongs',
      title: 'This Book Belongs To',
      body: `${firstName}\n\nFirst read on ____________________\nAt ____________________`,
    },
    {
      kind: 'closing',
      title: 'About This Book',
      body:
        `This book was made just for ${firstName}. Every word and illustration was created uniquely for this story by Hero Story Books.\n\n` +
        `Every story has a little magic tucked inside it. ${story.title} was made to be read, remembered, and returned to whenever ${firstName} needs a brave step forward.\n\n` +
        'herostorybooks.com',
    },
  ];
}

function buildKeepsakePages(story: StoryContent, order: OrderRecord, fillerCount: number): KeepsakePage[] {
  if (fillerCount <= 0) return [];
  const pages: KeepsakePage[] = [
    {
      kind: 'endpaper',
      title: 'Adventure Endpaper',
      body: `A patterned keepsake page inspired by ${story.title}.`,
      prompt: 'Little marks for the path, the clue, the brave choice, and the way home.',
    },
    {
      kind: 'vignette',
      title: 'One More Brave Step',
      body: `Every adventure leaves a small glow behind. Here is a place to remember ${childFirstName(order)}'s favorite moment from the journey.`,
      prompt: 'Favorite scene, biggest smile, or bravest choice:',
    },
    {
      kind: 'endpaper',
      title: 'Star Map Of The Story',
      body: 'A tiny constellation for the beginning, the tricky middle, the bright answer, and the cozy ending.',
      prompt: 'Trace the path again with your finger before the next bedtime read.',
    },
    {
      kind: 'vignette',
      title: 'A Memory To Keep',
      body: 'Write a memory from the first time you read this story together.',
      prompt: 'Date, place, favorite page, funny moment, or the brave thing you want to remember:',
    },
    {
      kind: 'copyright',
      title: story.title,
      body: buildCopyrightBody(story, order),
    },
  ];
  while (pages.length < fillerCount) {
    pages.push({
      kind: pages.length % 2 === 0 ? 'endpaper' : 'vignette',
      title: 'Notes From Our Adventure',
      body: 'A little extra room for favorite words, drawings, or memories from this story.',
      prompt: 'Sketch, write, or save one more thought here:',
    });
  }
  return pages.slice(0, fillerCount);
}

function drawWatercolorFlourish(
  doc: InstanceType<typeof PDFDocument>,
  pageWidth: number,
  y: number,
): void {
  const centerX = pageWidth / 2;
  doc.save();
  doc.strokeColor(GOLD).lineWidth(0.8).opacity(0.55);
  doc.moveTo(centerX - 88, y).bezierCurveTo(centerX - 44, y - 10, centerX + 44, y + 10, centerX + 88, y).stroke();
  doc.restore();

  const leaves = [
    { x: centerX - 64, y: y - 3, r: -22 },
    { x: centerX - 34, y: y + 6, r: 18 },
    { x: centerX + 34, y: y - 6, r: -18 },
    { x: centerX + 64, y: y + 3, r: 22 },
  ];
  leaves.forEach((leaf, index) => {
    doc.save();
    doc.translate(leaf.x, leaf.y).rotate(leaf.r);
    doc.ellipse(0, 0, 12, 4.2).fillOpacity(index % 2 === 0 ? 0.26 : 0.18).fill(FOREST);
    doc.restore();
  });
}

function drawWritingLines(
  doc: InstanceType<typeof PDFDocument>,
  x1: number,
  x2: number,
  startY: number,
  count: number,
  gap: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const y = startY + i * gap;
    doc.moveTo(x1, y).lineTo(x2, y).strokeColor('#CBD5E1').lineWidth(1).stroke();
  }
}

// ── Image fetching ─────────────────────────────────────────────────────────────

async function fetchImageBuffer(url: string): Promise<ArrayBuffer | null> {
  try {
    if (url.startsWith('file://')) {
      const localPath = fileURLToPath(url);
      const buffer = await readFile(localPath);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    if (path.isAbsolute(url)) {
      const buffer = await readFile(url);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

// ── Cover page ─────────────────────────────────────────────────────────────────

function drawCover(
  doc: InstanceType<typeof PDFDocument>,
  story: StoryContent,
  order: OrderRecord,
  coverImageBuffer: ArrayBuffer | null,
) {
  if (coverImageBuffer) {
    doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(FOREST);
    try {
      doc.image(coverImageBuffer, 0, 0, {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        cover: [PAGE_WIDTH, PAGE_HEIGHT],
        align: 'center',
        valign: 'center',
      });
    } catch { /* skip broken image */ }

    // Keep cover title/personalization as live PDF text, but remove the old
    // rounded plaque so the illustration/character remains unobstructed.
    const titleX = 46;
    const titleY = 26;
    const titleW = PAGE_WIDTH - 92;
    doc.save();
    doc.fillColor('#FFFFFF').fillOpacity(0.72).font(EMBEDDED_BOOK_FONT).fontSize(40).lineGap(2)
      .text(story.title, titleX + 1.4, titleY + 1.4, { width: titleW, align: 'center' });
    doc.restore();
    doc.fillOpacity(1).fillColor(FOREST).font(EMBEDDED_BOOK_FONT).fontSize(40).lineGap(2)
      .text(story.title, titleX, titleY, { width: titleW, align: 'center' });
    doc.fillColor(FOREST).font(EMBEDDED_BOOK_FONT).fontSize(15)
      .text(`Made for ${order.childName}`, titleX, titleY + 132, { width: titleW, align: 'center' });

    doc.fillColor('#FFFFFF').font(EMBEDDED_BOOK_FONT).fontSize(10)
      .text('A HeroStoryBooks Original', MARGIN, PAGE_HEIGHT - 30, { width: CONTENT_WIDTH, align: 'center' });
    return;
  }

  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(FOREST);

  // gold accent bar
  doc.rect(0, PAGE_HEIGHT - 80, PAGE_WIDTH, 80).fill(GOLD);

  doc
    .fillColor('#FFFFFF')
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(28)
    .text(story.title, MARGIN, 200, { width: CONTENT_WIDTH, align: 'center' });

  doc
    .fillColor(GOLD)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(12)
    .text('A HeroStoryBooks Original', MARGIN, PAGE_HEIGHT - 52, { width: CONTENT_WIDTH, align: 'center' });
}

// ── Story page ─────────────────────────────────────────────────────────────────

/** Picks the scrim color/opacity for a panel style. None = no scrim
 *  (text rides directly on the illustration; only safe when the image
 *  was generated with a quiet zone there). */
function panelScrim(style: TextPanelStyle): { color: string; opacity: number } | null {
  switch (style) {
    case 'none':
      return null;
    case 'translucent_cream':
      // Release 1 print/proof story pages use this as an opaque paper band,
      // not as a translucent overlay on top of the illustration.
      return { color: CREAM, opacity: 1 };
    case 'soft_scrim':
    case 'translucent_dark':
    default:
      // Hard product rule: no translucent black boxes with white text on
      // story pages. Legacy metadata may still request these styles, but the
      // renderer must coerce them to the approved cream paper band.
      return { color: CREAM, opacity: 1 };
  }
}

/** Corner radius for the text panel. Cream/scrim panels use a softer
 *  radius so they read as book typography rather than UI chrome. */
function panelCornerRadius(style: TextPanelStyle): number {
  return style === 'translucent_cream' || style === 'soft_scrim' ? 10 : 18;
}

function textFillColor(mode: Exclude<TextColorMode, 'auto'>): string {
  return mode === 'dark' ? FOREST : TEXT_ON_SCRIM;
}

/** Draw caption text with an optional subtle drop shadow when there is
 *  no panel scrim behind it. The shadow keeps text-directly-on-art legible
 *  without forcing a UI-style box. Two-pass: shadow first at low opacity,
 *  then the main text. */
function drawCaptionText(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number,
  lineGap: number,
  fillColor: string,
  hasPanel: boolean,
): void {
  if (!hasPanel) {
    doc.save();
    doc
      .fillColor('#000000')
      .fillOpacity(0.45)
      .font(EMBEDDED_BOOK_FONT)
      .fontSize(fontSize)
      .lineGap(lineGap)
      .text(text, x + 1, y + 1, { width, height, align: 'left', ellipsis: true });
    doc.restore();
  }
  doc
    .fillOpacity(1)
    .fillColor(fillColor)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(fontSize)
    .lineGap(lineGap)
    .text(text, x, y, { width, height, align: 'left', ellipsis: true });
}

// ── Proof-only positioned text-card override renderer ────────────────────────
//
// The sanctioned exception to the bottom-band invariant: when a story page
// carries a customer-authored ProofCardOverride, the customer-review PDF draws
// the story prose as a positioned translucent legibility card that may overlap
// the artwork. The print master never reads this field. Geometry is
// canonicalized at the render boundary so drawn pixels equal fingerprinted
// values; overflow is detected (fail closed) rather than clipped.

// Renderer card metrics are the SHARED single source of truth (see
// proof-layout-override.ts) so the customer CSS preview cannot drift from print.
const PROOF_CARD_TEXT_INSET = PROOF_CARD_TEXT_INSET_PT;
const PROOF_CARD_VERTICAL_INSET = PROOF_CARD_VERTICAL_INSET_PT;
const PROOF_CARD_CORNER_RADIUS = PROOF_CARD_CORNER_RADIUS_PT;

/** Normalized card geometry (page-relative fractions). Structural type shared
 *  with proof-layout-override without importing it into the fingerprint path. */
interface ProofCardGeometryLike {
  x: number;
  y: number;
  width: number;
  height: number;
  fontScale: number;
}

/** Map a normalized card box onto a PictureBookStoryLayout whose text panel IS
 *  the card. Image fields use the standard proof frame so the artwork is
 *  unaffected — only the text panel moves. */
function proofCardLayout(box: { x: number; y: number; width: number; height: number }): PictureBookStoryLayout {
  const panelX = box.x * PAGE_WIDTH;
  const panelY = box.y * PAGE_HEIGHT;
  const panelWidth = box.width * PAGE_WIDTH;
  const panelHeight = box.height * PAGE_HEIGHT;
  return {
    imageX: 0,
    imageY: 0,
    imageWidth: PAGE_WIDTH,
    imageHeight: PROOF_ART_FRAME_HEIGHT_PT,
    textInset: PROOF_CARD_TEXT_INSET,
    panelVerticalInset: PROOF_CARD_VERTICAL_INSET,
    textPanelFillOpacity: 1,
    pageNumberY: PAGE_HEIGHT - 24,
    textPanelStyle: 'translucent_cream',
    textColorMode: 'dark',
    textPanelX: panelX,
    textPanelY: panelY,
    textPanelWidth: panelWidth,
    textPanelHeight: panelHeight,
    sceneTitleY: panelY + 12,
  };
}

interface ProofCardText {
  fontSize: number;
  lineGap: number;
  drawY: number;
  drawHeight: number;
  overflowed: boolean;
}

/** Deterministically fit the story body into an override card at the bounded
 *  font scale, using the exact embedded font + PDFKit wrapping the renderer
 *  uses. Reports overflow (used to fail closed) rather than clipping. */
function computeProofCardText(box: ProofCardGeometryLike, storyText: string): ProofCardText {
  const layout = proofCardLayout(box);
  const textWidth = layout.textPanelWidth - layout.textInset * 2;
  const safeTop = layout.textPanelY + layout.panelVerticalInset;
  const safeBottom = layout.textPanelY + layout.textPanelHeight - layout.panelVerticalInset;
  const safeHeight = safeBottom - safeTop;

  const measureDoc = withNoLigatureText(new PDFDocument({ autoFirstPage: false })).font(EMBEDDED_BOOK_FONT);
  // Shared fit policy (single source of truth with the customer preview). The
  // PDFKit measurer keeps print output byte-identical to the prior inline loop.
  const fit = resolveProofCardFontFit({
    measure: (fontSize: number, lineGap: number) => measureDoc
      .fontSize(fontSize)
      .lineGap(lineGap)
      .heightOfString(storyText, { width: textWidth, align: 'left' }),
    safeHeightPt: safeHeight,
    fontScale: box.fontScale,
  });

  const pad = Math.max(0, Math.floor((safeHeight - fit.neededHeightPt) / 2));
  const drawY = safeTop + pad;
  const drawHeight = Math.max(24, safeBottom - drawY);
  return { fontSize: fit.fontSize, lineGap: fit.lineGap, drawY, drawHeight, overflowed: fit.overflowed };
}

/**
 * The renderer's ACTUAL adaptive fit decision for a card geometry + story text,
 * using real PDFKit measurement. Exposed so the browser preview's deterministic
 * fit can be proven to resolve the same 15→12pt / line-gap decision.
 */
export function proofCardRendererFit(geometry: ProofCardGeometry, storyText: string): ProofCardFit {
  const g = canonicalizeProofCardGeometry(geometry);
  const layout = proofCardLayout(g);
  const textWidth = layout.textPanelWidth - layout.textInset * 2;
  const safeHeight = layout.textPanelHeight - layout.panelVerticalInset * 2;
  const measureDoc = withNoLigatureText(new PDFDocument({ autoFirstPage: false })).font(EMBEDDED_BOOK_FONT);
  return resolveProofCardFontFit({
    measure: (fontSize: number, lineGap: number) => measureDoc
      .fontSize(fontSize)
      .lineGap(lineGap)
      .heightOfString(storyText, { width: textWidth, align: 'left' }),
    safeHeightPt: safeHeight,
    fontScale: g.fontScale,
  });
}

/** True when the story text cannot fit the card at the bounded font scale.
 *  Exposed for the server-side save/preview guard (fail closed, no clipping). */
export function proofCardTextOverflows(box: ProofCardGeometryLike, storyText: string): boolean {
  return computeProofCardText(box, storyText).overflowed;
}

/** Draw the over-art card: the illustration stays as drawn; a translucent
 *  legibility panel is laid at the normalized rect and the body text is fit
 *  inside it. Called only from the proof story-page path. */
function drawProofCardAt(
  doc: InstanceType<typeof PDFDocument>,
  text: string,
  geometry: ProofCardGeometryLike & { opacity: number; textColor?: ProofTextColor },
  pageIndex?: number,
): void {
  // Canonicalize at the render boundary so drawn pixels equal fingerprinted values.
  const g = canonicalizeProofCardGeometry(geometry);
  // Resolve the approved semantic color; absence === legacy default (#1F3A5F on
  // cream), byte-identical to the prior hardcoded render.
  const color = resolveProofTextColor(geometry.textColor);
  const layout = proofCardLayout(g);
  const fit = computeProofCardText(g, text);

  // Fail closed: an over-art card whose prose does not fit the bounded card at
  // the approved minimum font must NOT be drawn (drawCaptionText would clip via
  // ellipsis). Throw so buildPdf rejects instead of returning a clipped proof.
  if (fit.overflowed) {
    throw new ProofCardOverflowError(pageIndex);
  }

  doc.save();
  doc
    .roundedRect(layout.textPanelX, layout.textPanelY, layout.textPanelWidth, layout.textPanelHeight, PROOF_CARD_CORNER_RADIUS)
    .fillOpacity(g.opacity)
    .fill(color.fill);
  doc.restore();

  drawCaptionText(
    doc,
    text,
    layout.textPanelX + layout.textInset,
    fit.drawY,
    layout.textPanelWidth - layout.textInset * 2,
    fit.drawHeight,
    fit.fontSize,
    fit.lineGap,
    color.text,
    true,
  );
}

/** Draw a story-page over-art card (the sanctioned exception). */
function drawProofOverrideCard(
  doc: InstanceType<typeof PDFDocument>,
  storyText: string,
  override: ProofCardOverride,
  pageIndex?: number,
): void {
  drawProofCardAt(doc, storyText, override, pageIndex);
}

function drawStoryPage(
  doc: InstanceType<typeof PDFDocument>,
  pageNum: number,
  sceneTitle: string,
  storyText: string,
  imageBuffer: ArrayBuffer | null,
  textLayout?: PageTextLayout,
  layoutVersion?: LayoutVersion | null,
  pageIndex?: number,
  cardOverride?: ProofCardOverride | null,
) {
  const layout = getPictureBookStoryLayout('proof', textLayout, layoutVersion, pageIndex);
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(CREAM);

  if (imageBuffer) {
    try {
      doc.image(imageBuffer, layout.imageX, layout.imageY, {
        width: layout.imageWidth,
        height: layout.imageHeight,
        cover: [layout.imageWidth, layout.imageHeight],
        align: 'center',
        valign: 'center',
      });
    } catch {
      doc.rect(layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight).fill('#E5E7EB');
    }
  } else {
    doc.rect(layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight).fill('#E5E7EB');
    doc
      .fillColor('#9CA3AF')
      .font(EMBEDDED_BOOK_FONT)
      .fontSize(11)
      .text('Illustration preview unavailable', layout.imageX, layout.imageY + 280, {
        width: layout.imageWidth,
        align: 'center',
      });
  }

  if (isValidProofCardOverride(cardOverride)) {
    // Sanctioned over-art exception: a customer-authored positioned card
    // supersedes the bottom band for THIS page's text. Proof-only. A malformed
    // / legacy override fails this guard and falls through to the bottom band,
    // exactly as the fingerprint projection treats it (render == identity).
    drawProofOverrideCard(doc, storyText, cardOverride, pageIndex);
  } else {
    // Default bottom-band render — byte-identical to prior behavior. Body-only:
    // the proof draw site does NOT print sceneTitle, so the fitter budgets no
    // vertical room for it and the body uses the whole safe zone.
    const fitted = fitPictureBookText(layout, sceneTitle, storyText, { renderTitle: false });
    const scrim = panelScrim(layout.textPanelStyle);
    if (scrim) {
      doc.save();
      doc.roundedRect(
        layout.textPanelX,
        layout.textPanelY,
        layout.textPanelWidth,
        layout.textPanelHeight,
        panelCornerRadius(layout.textPanelStyle),
      ).fillOpacity(scrim.opacity).fill(scrim.color);
      doc.restore();
    }

    drawCaptionText(
      doc,
      storyText,
      layout.textPanelX + layout.textInset,
      fitted.storyDrawY,
      layout.textPanelWidth - layout.textInset * 2,
      fitted.storyDrawHeight,
      fitted.storyFontSize,
      fitted.storyLineGap,
      textFillColor(layout.textColorMode),
      Boolean(scrim),
    );
  }

  doc
    .fillColor(SLATE)
    .fillOpacity(0.55)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(9)
    .text(String(pageNum), MARGIN, layout.pageNumberY, { width: CONTENT_WIDTH, align: 'center' })
    .fillOpacity(1);
}

function drawKeepsakePage(
  doc: InstanceType<typeof PDFDocument>,
  pageNum: number,
  page: KeepsakePage,
) {
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(CREAM);
  drawWatercolorFlourish(doc, PAGE_WIDTH, 52);

  doc
    .fillColor(FOREST)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(page.kind === 'copyright' ? 18 : 24)
    .text(page.title, MARGIN, page.kind === 'copyright' ? 84 : 72, { width: CONTENT_WIDTH, align: 'center' });

  doc
    .fillColor(SLATE)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(page.kind === 'copyright' ? 11 : 15)
    .lineGap(page.kind === 'copyright' ? 4 : 6)
    .text(page.body, MARGIN, page.kind === 'copyright' ? 150 : 138, { width: CONTENT_WIDTH, align: 'center' });

  if (page.prompt) {
    doc
      .fillColor(FOREST)
      .font(EMBEDDED_BOOK_FONT)
      .fontSize(13)
      .text(page.prompt, MARGIN, 280, { width: CONTENT_WIDTH, align: 'center' });

    drawWritingLines(doc, MARGIN + 8, PAGE_WIDTH - MARGIN - 8, 340, 8, 34);
  }

  // Keepsake/filler pages intentionally omit visible page numbers; numbering
  // otherwise makes quiet cream pages look emptier instead of more premium.
  void pageNum;
}

// ── Back page ──────────────────────────────────────────────────────────────────

function drawBackPage(
  doc: InstanceType<typeof PDFDocument>,
  story: StoryContent,
  order: OrderRecord,
  backCoverImage: ArrayBuffer | null = null,
  tagline: string | null = null,
) {
  if (backCoverImage) {
    // Full-bleed back-cover illustration with a translucent cream synopsis
    // panel typeset on top.
    try {
      doc.image(backCoverImage, 0, 0, {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        cover: [PAGE_WIDTH, PAGE_HEIGHT],
        align: 'center',
        valign: 'center',
      });
    } catch {
      doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(FOREST);
    }

    if (tagline) {
      const textX = 42;
      const textY = PAGE_HEIGHT * 0.085;
      const textW = PAGE_WIDTH * 0.63;
      doc.save();
      doc.fillColor('#FFFFFF').fillOpacity(0.32).font(EMBEDDED_BOOK_FONT).fontSize(17).lineGap(6)
        .text(tagline, textX + 1.2, textY + 1.2, { width: textW, align: 'left' });
      doc.restore();
      doc.fillOpacity(1).fillColor('#10263D').font(EMBEDDED_BOOK_FONT).fontSize(17).lineGap(6)
        .text(tagline, textX, textY, { width: textW, align: 'left' });
    }

    doc.fillOpacity(1).fillColor('#FFFFFF').font(EMBEDDED_BOOK_FONT).fontSize(8.5)
      .text('A HeroStoryBooks Original  ·  herostorybooks.com', MARGIN, PAGE_HEIGHT - 24, {
        width: CONTENT_WIDTH, align: 'center',
      });
    return;
  }

  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(FOREST);
  doc.rect(0, PAGE_HEIGHT - 80, PAGE_WIDTH, 80).fill(GOLD);

  doc
    .fillColor('#FFFFFF')
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(28)
    .text(story.title, MARGIN, 250, { width: CONTENT_WIDTH, align: 'center' });

  doc
    .fillColor(GOLD)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(14)
    .text('A HeroStoryBooks Original', MARGIN, 330, { width: CONTENT_WIDTH, align: 'center' });

  doc
    .fillColor(FOREST)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(12)
    .text('herostorybooks.com', MARGIN, PAGE_HEIGHT - 52, { width: CONTENT_WIDTH, align: 'center' });
}

// ── Main export ────────────────────────────────────────────────────────────────

export interface BuildPdfOptions {
  /** Optional URL/path for a back-cover illustration. When provided, the
   *  back page renders the image full-bleed with the tagline (if any) in a
   *  translucent cream panel. When omitted, the legacy non-illustrated
   *  back page is used (preserves existing tests). */
  backCoverUrl?: string | null;
  /** Optional tagline typeset on the back cover. Ignored if no back-cover
   *  image is supplied. */
  backCoverTagline?: string | null;
}

export async function buildPdf(
  story: StoryContent,
  order: OrderRecord,
  imageUrls: (string | null)[],
  options: BuildPdfOptions = {},
): Promise<Buffer> {
  // Fetch all images in parallel (gracefully skip failures)
  const imageBuffers = await Promise.all(
    imageUrls.map(url => (url ? fetchImageBuffer(url) : Promise.resolve(null))),
  );
  const backCoverBuffer = options.backCoverUrl ? await fetchImageBuffer(options.backCoverUrl) : null;

  const minimumTotalPages = getMinimumTotalPages(order.bookFormat);
  const frontMatter = buildFrontMatterPages(story, order);
  const backMatter = buildBackMatterPages(story, order);
  // Proof PDFs include front/back cover pages outside the interior minimum.
  // Keep the interior flow aligned with the printed book by calculating filler
  // against story + matter only, not against the extra proof-only cover pages.
  const currentInteriorPages = story.pages.length + frontMatter.length + backMatter.length;
  const fillerPages = buildKeepsakePages(story, order, Math.max(0, minimumTotalPages - currentInteriorPages));

  return new Promise<Buffer>((resolve, reject) => {
    const doc = withNoLigatureText(new PDFDocument({
      size: 'A4',
      margin: 0,
      autoFirstPage: false,
    }));

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      const pdf = Buffer.concat(chunks);
      assertPdfEmbedsFonts(pdf, 'proof PDF');
      resolve(pdf);
    });
    doc.on('error', reject);

    const drawProofMatterPage = (page: MatterPage, pageNumber: number) => {
      doc.addPage();
      doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(CREAM);
      drawWatercolorFlourish(doc, PAGE_WIDTH, 58);
      doc
        .fillColor(FOREST)
        .font(EMBEDDED_BOOK_FONT)
        .fontSize(page.kind === 'title' ? 30 : page.kind === 'closing' ? 20 : 22)
        .text(page.title, MARGIN, page.kind === 'closing' ? 118 : 96, { width: CONTENT_WIDTH, align: 'center' });
      doc
        .fillColor(SLATE)
        .font(EMBEDDED_BOOK_FONT)
        .fontSize(page.kind === 'closing' ? 13 : 15)
        .lineGap(page.kind === 'closing' ? 6 : 8)
        .text(page.body, MARGIN, page.kind === 'closing' ? 196 : 190, { width: CONTENT_WIDTH, align: 'center' });
      if (page.prompt) {
        doc
          .fillColor(FOREST)
          .font(EMBEDDED_BOOK_FONT)
          .fontSize(12)
          .text(page.prompt, MARGIN, 336, { width: CONTENT_WIDTH, align: 'center' });
        drawWritingLines(doc, MARGIN + 10, PAGE_WIDTH - MARGIN - 10, 390, 6, 42);
      }
      // Front/back matter pages are designed as keepsake pages, so proof PDFs
      // do not add small floating page numbers to the quiet cream field.
      void pageNumber;
    };

    // Cover
    doc.addPage();
    drawCover(doc, story, order, imageBuffers[0] ?? null);

    let renderedPageNumber = 1;

    frontMatter.forEach((page) => {
      drawProofMatterPage(page, renderedPageNumber);
      renderedPageNumber += 1;
    });

    // Story pages
    story.pages.forEach((page, i) => {
      doc.addPage();
      drawStoryPage(doc, renderedPageNumber, page.sceneTitle, page.story, imageBuffers[i + 1] ?? null, page.textLayout, order.layoutVersion, i, page.proofCardOverride ?? null);
      renderedPageNumber += 1;
    });

    backMatter.forEach((page) => {
      drawProofMatterPage(page, renderedPageNumber);
      renderedPageNumber += 1;
    });

    fillerPages.forEach((page) => {
      doc.addPage();
      drawKeepsakePage(doc, renderedPageNumber, page);
      renderedPageNumber += 1;
    });

    // Back page
    doc.addPage();
    drawBackPage(doc, story, order, backCoverBuffer, options.backCoverTagline ?? null);

    doc.end();
  });
}

export function getPrintInteriorPageCount(story: StoryContent, order: OrderRecord): number {
  // Every print interior includes 6 intentional matter pages:
  // front matter (title + dedication) and back matter (The End, copyright,
  // belongs, merged closing note). Filler keepsake pages are a safety net only
  // when story + matter still falls short of the Lulu minimum.
  const minimumPages = getMinimumTotalPages(order.bookFormat);
  return Math.max(story.pages.length + INTENTIONAL_MATTER_PAGES, minimumPages);
}

/** Pure helper exposed for tests: how many filler keepsake pages would
 *  be inserted for an order. Returns 0 once the story is long enough that
 *  story + matter already meets the Lulu minimum. */
export function getPrintFillerPageCount(story: StoryContent, order: OrderRecord): number {
  const total = getPrintInteriorPageCount(story, order);
  return Math.max(0, total - story.pages.length - INTENTIONAL_MATTER_PAGES);
}

export async function buildPrintInteriorPdf(
  story: StoryContent,
  order: OrderRecord,
  imageUrls: (string | null)[],
): Promise<Buffer> {
  const imageBuffers = await Promise.all(
    imageUrls.map(url => (url ? fetchImageBuffer(url) : Promise.resolve(null))),
  );

  const fillerCount = getPrintFillerPageCount(story, order);
  const fillerPages = fillerCount > 0 ? buildKeepsakePages(story, order, fillerCount) : [];
  const frontMatter = buildFrontMatterPages(story, order);
  const backMatter = buildBackMatterPages(story, order);
  const trimWidth = 8.5 * 72;
  const trimHeight = 8.5 * 72;
  const margin = 42;
  const contentWidth = trimWidth - margin * 2;

  return new Promise<Buffer>((resolve, reject) => {
    const doc = withNoLigatureText(new PDFDocument({
      size: [trimWidth, trimHeight],
      margin: 0,
      autoFirstPage: false,
    }));

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      const pdf = Buffer.concat(chunks);
      assertPdfEmbedsFonts(pdf, 'print interior PDF');
      resolve(pdf);
    });
    doc.on('error', reject);

    let pageNumber = 1;

    const drawMatterPage = (page: MatterPage) => {
      doc.addPage();
      doc.rect(0, 0, trimWidth, trimHeight).fill(CREAM);
      drawWatercolorFlourish(doc, trimWidth, 44);
      doc
        .fillColor(FOREST)
        .font(EMBEDDED_BOOK_FONT)
        .fontSize(page.kind === 'title' ? 28 : page.kind === 'closing' ? 18 : 20)
        .text(page.title, margin, page.kind === 'closing' ? 96 : 80, { width: contentWidth, align: 'center' });
      doc
        .fillColor(SLATE)
        .font(EMBEDDED_BOOK_FONT)
        .fontSize(page.kind === 'closing' ? 12 : 13)
        .lineGap(page.kind === 'closing' ? 5 : 6)
        .text(page.body, margin, page.kind === 'closing' ? 172 : 160, { width: contentWidth, align: 'center' });
      if (page.prompt) {
        doc
          .fillColor(FOREST)
          .font(EMBEDDED_BOOK_FONT)
          .fontSize(11)
          .text(page.prompt, margin, 284, { width: contentWidth, align: 'center' });
        drawWritingLines(doc, margin + 8, trimWidth - margin - 8, 336, 5, 36);
      }
      pageNumber += 1;
    };

    // Front matter — title + dedication (intentional, designed pages).
    frontMatter.forEach(drawMatterPage);

    story.pages.forEach((page, index) => {
      doc.addPage();
      const layout = getPictureBookStoryLayout('print', page.textLayout, order.layoutVersion, index);
      // Body-only render — the print loop does NOT print sceneTitle on
      // story pages, so the fitter must not budget for a title or the
      // story copy sits in the upper half of the cream band with
      // unbalanced bottom whitespace.
      const fitted = fitPictureBookText(layout, page.sceneTitle, page.story, { renderTitle: false });
      doc.rect(0, 0, trimWidth, trimHeight).fill(CREAM);

      const image = imageBuffers[index + 1] ?? null;
      if (image) {
        try {
          doc.image(image, layout.imageX, layout.imageY, {
            width: layout.imageWidth,
            height: layout.imageHeight,
            cover: [layout.imageWidth, layout.imageHeight],
            align: 'center',
            valign: 'center',
          });
        } catch {
          doc.rect(layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight).fill('#E5E7EB');
        }
      } else {
        doc.rect(layout.imageX, layout.imageY, layout.imageWidth, layout.imageHeight).fill('#E5E7EB');
      }

      const scrim = panelScrim(layout.textPanelStyle);
      if (scrim) {
        doc.save();
        doc.roundedRect(
          layout.textPanelX,
          layout.textPanelY,
          layout.textPanelWidth,
          layout.textPanelHeight,
          panelCornerRadius(layout.textPanelStyle),
        ).fillOpacity(scrim.opacity).fill(scrim.color);
        doc.restore();
      }

      drawCaptionText(
        doc,
        page.story,
        layout.textPanelX + layout.textInset,
        fitted.storyDrawY,
        layout.textPanelWidth - layout.textInset * 2,
        fitted.storyDrawHeight,
        fitted.storyFontSize,
        fitted.storyLineGap,
        textFillColor(layout.textColorMode),
        Boolean(scrim),
      );

      doc.fillColor(SLATE).fillOpacity(0.55).font(EMBEDDED_BOOK_FONT).fontSize(9).text(String(pageNumber), margin, trimHeight - 24, { width: contentWidth, align: 'center' }).fillOpacity(1);
      pageNumber += 1;
    });

    // Back matter — The End, copyright, belongs page, and merged about/quiet closing note.
    backMatter.forEach(drawMatterPage);

    // Filler keepsake pages — safety net only. For new long-form classic
    // (24 story) this still runs to hit Lulu's 32 minimum; for new
    // premium (32 story) and legacy short stories that already exceed
    // the minimum, fillerPages is empty.
    fillerPages.forEach((page) => {
      doc.addPage();
      doc.rect(0, 0, trimWidth, trimHeight).fill(CREAM);
      drawWatercolorFlourish(doc, trimWidth, 44);
      doc.fillColor(FOREST).font(EMBEDDED_BOOK_FONT).fontSize(page.kind === 'copyright' ? 16 : 22).text(page.title, margin, page.kind === 'copyright' ? 72 : 56, { width: contentWidth, align: 'center' });
      doc.fillColor(SLATE).font(EMBEDDED_BOOK_FONT).fontSize(page.kind === 'copyright' ? 10 : 13).lineGap(page.kind === 'copyright' ? 4 : 5).text(page.body, margin, page.kind === 'copyright' ? 130 : 120, { width: contentWidth, align: 'center' });
      if (page.prompt) {
        doc.fillColor(FOREST).font(EMBEDDED_BOOK_FONT).fontSize(12).text(page.prompt, margin, 240, { width: contentWidth, align: 'center' });
        drawWritingLines(doc, margin + 6, trimWidth - margin - 6, 295, 7, 32);
      }
      pageNumber += 1;
    });

    doc.end();
  });
}

export interface BuildPrintCoverOptions {
  frontCoverUrl?: string | null;
  backCoverUrl?: string | null;
  backCoverTagline?: string | null;
}

export async function buildPrintCoverPdf(
  widthPoints: number,
  heightPoints: number,
  title: string,
  order: OrderRecord,
  options: BuildPrintCoverOptions = {},
): Promise<Buffer> {
  const frontCoverBuffer = options.frontCoverUrl ? await fetchImageBuffer(options.frontCoverUrl) : null;
  const backCoverBuffer = options.backCoverUrl ? await fetchImageBuffer(options.backCoverUrl) : null;

  return new Promise<Buffer>((resolve, reject) => {
    const doc = withNoLigatureText(new PDFDocument({
      size: [widthPoints, heightPoints],
      margin: 0,
      autoFirstPage: false,
    }));

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      const pdf = Buffer.concat(chunks);
      assertPdfEmbedsFonts(pdf, 'print cover PDF');
      resolve(pdf);
    });
    doc.on('error', reject);

    doc.addPage();

    // Spread layout: back cover on the left half, spine in middle, front
    // cover on the right half. Print specs use a single landscape page
    // with both halves rendered onto it.
    if (frontCoverBuffer || backCoverBuffer) {
      const spineW = Math.max(8, widthPoints - (17.25 * 72));
      const coverPanelW = (widthPoints - spineW) / 2;
      const frontX = coverPanelW + spineW;
      // Back cover (left)
      if (backCoverBuffer) {
        try {
          doc.image(backCoverBuffer, 0, 0, {
            width: coverPanelW, height: heightPoints,
            cover: [coverPanelW, heightPoints], align: 'center', valign: 'center',
          });
        } catch { doc.rect(0, 0, coverPanelW, heightPoints).fill('#F8E7C7'); }
        if (options.backCoverTagline) {
          const textX = 34;
          const textY = heightPoints * 0.085;
          const textW = coverPanelW * 0.64;
          const tagSize = Math.max(14, widthPoints * 0.014);
          doc.save();
          doc.fillColor('#FFFFFF').fillOpacity(0.32).font(EMBEDDED_BOOK_FONT).fontSize(tagSize).lineGap(6)
            .text(options.backCoverTagline, textX + 1.2, textY + 1.2, { width: textW, align: 'left' });
          doc.restore();
          doc.fillOpacity(1).fillColor('#10263D').font(EMBEDDED_BOOK_FONT).fontSize(tagSize).lineGap(6)
            .text(options.backCoverTagline, textX, textY, { width: textW, align: 'left' });
        }
        doc.fillColor('#FFFFFF').font(EMBEDDED_BOOK_FONT).fontSize(Math.max(7, widthPoints * 0.0065))
          .text('herostorybooks.com', 32, heightPoints - 26, { width: coverPanelW - 64, align: 'center' });
        doc.save();
        doc.roundedRect(38, heightPoints - 92, 118, 52, 4).fillOpacity(0.88).fill('#FFFFFF');
        doc.restore();
        doc.fillOpacity(1).fillColor(SLATE).font(EMBEDDED_BOOK_FONT).fontSize(6.5)
          .text('Print barcode area', 44, heightPoints - 68, { width: 106, align: 'center' });
      } else {
        doc.rect(0, 0, coverPanelW, heightPoints).fill(FOREST);
      }
      // Front cover (right)
      if (frontCoverBuffer) {
        try {
          doc.image(frontCoverBuffer, frontX, 0, {
            width: coverPanelW, height: heightPoints,
            cover: [coverPanelW, heightPoints], align: 'center', valign: 'center',
          });
        } catch { doc.rect(frontX, 0, coverPanelW, heightPoints).fill(FOREST); }
        // Title typeset high as live PDF text. No plaque/card here: the
        // customer called out that the old rounded box covered Lukas's head.
        const titleY = heightPoints * 0.035;
        const titleX = frontX + 34;
        const titleW = coverPanelW - 68;
        const titleSize = Math.max(28, widthPoints * 0.032);
        doc.save();
        doc.fillColor('#FFFFFF').fillOpacity(0.7).font(EMBEDDED_BOOK_FONT)
          .fontSize(titleSize).lineGap(1)
          .text(title, titleX + 1.2, titleY + 1.2, { width: titleW, align: 'center' });
        doc.restore();
        doc.fillOpacity(1).fillColor(FOREST).font(EMBEDDED_BOOK_FONT)
          .fontSize(titleSize).lineGap(1)
          .text(title, titleX, titleY, { width: titleW, align: 'center' });
        doc.fillColor(FOREST).font(EMBEDDED_BOOK_FONT).fontSize(Math.max(11, widthPoints * 0.012))
          .text(`Made for ${order.childName}`, titleX, titleY + Math.min(150, heightPoints * 0.22), {
            width: titleW, align: 'center',
          });
        doc.fillColor('#FFFFFF').font(EMBEDDED_BOOK_FONT).fontSize(Math.max(8, widthPoints * 0.0075))
          .text('A HeroStoryBooks Original', frontX + 32, heightPoints - 28, { width: coverPanelW - 64, align: 'center' });
      } else {
        doc.rect(frontX, 0, coverPanelW, heightPoints).fill(FOREST);
      }
      // Slim spine seam over the centerline. For this 32-page classic book
      // the spine is only about 0.13in wide, below a safe readable-text margin
      // after binding tolerance, so intentionally do not place spine text.
      doc.rect(coverPanelW, 0, spineW, heightPoints).fill(GOLD);

      doc.end();
      return;
    }

    // Legacy non-illustrated cover (preserves existing tests).
    doc.rect(0, 0, widthPoints, heightPoints).fill('#F8E7C7');
    doc.rect(widthPoints * 0.55, 0, widthPoints * 0.45, heightPoints).fill(FOREST);
    doc.rect(widthPoints * 0.5 - 8, 0, 16, heightPoints).fill(GOLD);

    const frontX = widthPoints * 0.58;
    const frontWidth = widthPoints * 0.36;
    doc.fillColor('#FFFFFF').font(EMBEDDED_BOOK_FONT).fontSize(Math.max(22, widthPoints * 0.03)).text(title, frontX, 90, { width: frontWidth, align: 'center' });
    doc.fillColor(GOLD).font(EMBEDDED_BOOK_FONT).fontSize(16).text('A HeroStoryBooks Original', frontX, 190, { width: frontWidth, align: 'center' });

    doc.fillColor(FOREST).font(EMBEDDED_BOOK_FONT).fontSize(18).text('Hero Story Books', 40, 90, { width: widthPoints * 0.38, align: 'center' });
    doc.fillColor(SLATE).font(EMBEDDED_BOOK_FONT).fontSize(12).lineGap(4).text(`A keepsake adventure created for ${order.childName}.`, 40, 150, { width: widthPoints * 0.38, align: 'center' });

    doc.end();
  });
}
