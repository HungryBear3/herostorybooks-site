import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OrderRecord } from './orders.ts';
import type {
  PageTextLayout,
  StoryContent,
  TextColorMode,
  TextPanelStyle,
} from './fulfillment-types.ts';

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
  textInset: number;
  textPanelFillOpacity: number;
  sceneTitleY: number;
  pageNumberY: number;
  /** How the panel rectangle behind the text is rendered. Drives the
   *  scrim color/opacity. Defaults to translucent_dark (legacy behavior)
   *  when no PageTextLayout is supplied. */
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
  storyY: number;
  storyHeight: number;
  sceneTitleY: number;
}

/** Resolve a PageTextLayout's auto fields against the panel style so the
 *  renderer never has to guess. Pure — exposed for tests. */
export function resolvePageTextLayout(layout?: PageTextLayout): {
  panelStyle: TextPanelStyle;
  colorMode: Exclude<TextColorMode, 'auto'>;
  zone: PageTextLayout['zone'];
} {
  const panelStyle: TextPanelStyle = layout?.panelStyle ?? 'translucent_dark';
  const requestedMode = layout?.colorMode ?? 'auto';
  const colorMode: Exclude<TextColorMode, 'auto'> =
    requestedMode === 'auto'
      ? panelStyle === 'translucent_cream' || panelStyle === 'none'
        ? 'dark'
        : 'light'
      : requestedMode;
  return { panelStyle, colorMode, zone: layout?.zone ?? 'natural' };
}

export function getPictureBookStoryLayout(
  kind: 'proof' | 'print',
  _textLayout?: PageTextLayout,
): PictureBookStoryLayout {
  // Release 1 print/proof rule: never place story copy on top of the art.
  // Keep the PageTextLayout metadata API intact, but render every story page
  // as a picture-book composition: cropped illustration above, clean cream
  // paper band below. The deferred safe-zone system can re-enable in-art copy
  // later once image generation guarantees quiet zones.
  if (kind === 'print') {
    const trimWidth = 8.5 * 72;
    const trimHeight = 8.5 * 72;
    const bandY = 456;
    const bandHeight = 128;
    return {
      imageX: 18,
      imageY: 18,
      imageWidth: trimWidth - 36,
      imageHeight: bandY - 24,
      textInset: 18,
      textPanelFillOpacity: 1,
      pageNumberY: trimHeight - 26,
      textPanelStyle: 'translucent_cream',
      textColorMode: 'dark',
      textPanelX: 28,
      textPanelY: bandY,
      textPanelWidth: trimWidth - 56,
      textPanelHeight: bandHeight,
      sceneTitleY: bandY + 16,
    };
  }

  const bandY = 642;
  const bandHeight = 158;
  return {
    imageX: 24,
    imageY: 24,
    imageWidth: PAGE_WIDTH - 48,
    imageHeight: bandY - 34,
    textInset: 22,
    textPanelFillOpacity: 1,
    pageNumberY: PAGE_HEIGHT - 28,
    textPanelStyle: 'translucent_cream',
    textColorMode: 'dark',
    textPanelX: 36,
    textPanelY: bandY,
    textPanelWidth: PAGE_WIDTH - 72,
    textPanelHeight: bandHeight,
    sceneTitleY: bandY + 18,
  };
}

interface PanelRectInput {
  zone: PageTextLayout['zone'];
  surfaceWidth: number;
  surfaceHeight: number;
  bandHeight: number;
  bandX: number;
  bandWidth: number;
  bandTopY: number;
  bandBottomY: number;
  cornerWidth: number;
  cornerHeight: number;
  cornerInset: number;
}

function computePanelRect(input: PanelRectInput): { x: number; y: number; width: number; height: number } {
  switch (input.zone) {
    case 'top_band':
      return { x: input.bandX, y: input.bandTopY, width: input.bandWidth, height: input.bandHeight };
    case 'top_left':
      return {
        x: input.cornerInset,
        y: input.cornerInset + 12,
        width: input.cornerWidth,
        height: input.cornerHeight,
      };
    case 'top_right':
      return {
        x: input.surfaceWidth - input.cornerInset - input.cornerWidth,
        y: input.cornerInset + 12,
        width: input.cornerWidth,
        height: input.cornerHeight,
      };
    case 'bottom_left':
      return {
        x: input.cornerInset,
        y: input.surfaceHeight - input.cornerInset - input.cornerHeight - 12,
        width: input.cornerWidth,
        height: input.cornerHeight,
      };
    case 'bottom_right':
      return {
        x: input.surfaceWidth - input.cornerInset - input.cornerWidth,
        y: input.surfaceHeight - input.cornerInset - input.cornerHeight - 12,
        width: input.cornerWidth,
        height: input.cornerHeight,
      };
    case 'natural':
    case 'bottom_band':
    default:
      return { x: input.bandX, y: input.bandBottomY, width: input.bandWidth, height: input.bandHeight };
  }
}

function estimateWrappedLineCount(text: string, fontSize: number, width: number, weight: number): number {
  const approxCharsPerLine = Math.max(10, Math.floor(width / (fontSize * weight)));
  return Math.max(1, Math.ceil(text.length / approxCharsPerLine));
}

export function fitPictureBookText(
  layout: PictureBookStoryLayout,
  sceneTitle: string,
  storyText: string,
): FittedPictureBookText {
  const textWidth = layout.textPanelWidth - layout.textInset * 2;
  let sceneTitleFontSize = 15;
  let storyFontSize = 15;
  let storyLineGap = 5;

  while (sceneTitleFontSize > 11) {
    const titleLines = estimateWrappedLineCount(sceneTitle.toUpperCase(), sceneTitleFontSize, textWidth, 0.62);
    const titleHeight = titleLines * (sceneTitleFontSize + 2);
    const storyY = layout.sceneTitleY + titleHeight + 8;
    const storyHeight = layout.textPanelY + layout.textPanelHeight - storyY - 8;
    const storyLines = estimateWrappedLineCount(storyText, storyFontSize, textWidth, 0.56);
    const neededStoryHeight = storyLines * (storyFontSize + storyLineGap);

    if (neededStoryHeight <= storyHeight && titleHeight <= layout.textPanelHeight * 0.45) {
      return { sceneTitleFontSize, sceneTitleHeight: titleHeight, storyFontSize, storyLineGap, storyY, storyHeight, sceneTitleY: layout.sceneTitleY };
    }

    if (storyFontSize > 12) storyFontSize -= 1;
    else if (storyLineGap > 3) storyLineGap -= 1;
    else sceneTitleFontSize -= 1;
  }

  const titleLines = estimateWrappedLineCount(sceneTitle.toUpperCase(), sceneTitleFontSize, textWidth, 0.62);
  const titleHeight = titleLines * (sceneTitleFontSize + 2);
  const storyY = layout.sceneTitleY + titleHeight + 8;
  const storyHeight = Math.max(24, layout.textPanelY + layout.textPanelHeight - storyY - 8);
  return { sceneTitleFontSize, sceneTitleHeight: titleHeight, storyFontSize, storyLineGap, storyY, storyHeight, sceneTitleY: layout.sceneTitleY };
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
const FRONT_MATTER_COUNT = 3;
const BACK_MATTER_COUNT = 2;
const INTENTIONAL_MATTER_PAGES = FRONT_MATTER_COUNT + BACK_MATTER_COUNT;

interface MatterPage {
  kind: 'title' | 'dedication' | 'memory' | 'belongs' | 'closing';
  title: string;
  body: string;
  prompt?: string;
}

interface KeepsakePage {
  kind?: 'end_note' | 'copyright' | 'blank';
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
    {
      kind: 'memory',
      title: 'A Memory To Keep',
      body: 'Write a memory from the first time you read this story together.',
      prompt: 'Date, place, favorite page, funny moment, or the brave thing you want to remember:',
    },
  ];
}

function buildBackMatterPages(story: StoryContent, order: OrderRecord): MatterPage[] {
  const firstName = childFirstName(order);
  return [
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
      kind: 'end_note',
      title: 'The End',
      body: `Thank you for reading ${story.title} together.`,
    },
    {
      kind: 'copyright',
      title: story.title,
      body:
        `© 2026 Hero Story Books. All rights reserved.\n\n` +
        `This book was created uniquely for ${order.childName}.\n` +
        'Personal use only. No part of this book may be reproduced for resale.\n\n' +
        'Illustrations generated with AI assistance and reviewed before printing.\n\n' +
        `First printing, May 2026. Printed in the United States.\n\n` +
        `Hero Story Books Edition: ${order.id}\n` +
        'herostorybooks.com',
    },
    {
      kind: 'end_note',
      title: 'Notes From Our Adventure',
      body: 'A little extra room for favorite words, drawings, or memories from this story.',
      prompt: 'Sketch, write, or save one more thought here:',
    },
  ];
  while (pages.length < fillerCount) {
    pages.push({
      kind: 'end_note',
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
      return { color: TEXT_SCRIM, opacity: 0.42 };
    case 'translucent_dark':
    default:
      return { color: TEXT_SCRIM, opacity: 0.72 };
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

function drawStoryPage(
  doc: InstanceType<typeof PDFDocument>,
  pageNum: number,
  sceneTitle: string,
  storyText: string,
  imageBuffer: ArrayBuffer | null,
  textLayout?: PageTextLayout,
) {
  const layout = getPictureBookStoryLayout('proof', textLayout);
  const fitted = fitPictureBookText(layout, sceneTitle, storyText);
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
    layout.textPanelY + 10,
    layout.textPanelWidth - layout.textInset * 2,
    layout.textPanelHeight - 20,
    fitted.storyFontSize,
    fitted.storyLineGap,
    textFillColor(layout.textColorMode),
    Boolean(scrim),
  );

  doc
    .fillColor(GOLD)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(11)
    .text(String(pageNum), MARGIN, layout.pageNumberY, { width: CONTENT_WIDTH, align: 'center' });
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

  doc
    .fillColor(GOLD)
    .font(EMBEDDED_BOOK_FONT)
    .fontSize(11)
    .text(String(pageNum), MARGIN, PAGE_HEIGHT - 36, { width: CONTENT_WIDTH, align: 'center' });
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
      doc.fillColor(GOLD).font(EMBEDDED_BOOK_FONT).fontSize(10).text(String(pageNumber), MARGIN, PAGE_HEIGHT - 30, { width: CONTENT_WIDTH, align: 'center' });
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
      drawStoryPage(doc, renderedPageNumber, page.sceneTitle, page.story, imageBuffers[i + 1] ?? null, page.textLayout);
      renderedPageNumber += 1;
    });

    fillerPages.forEach((page) => {
      doc.addPage();
      drawKeepsakePage(doc, renderedPageNumber, page);
      renderedPageNumber += 1;
    });

    backMatter.forEach((page) => {
      drawProofMatterPage(page, renderedPageNumber);
      renderedPageNumber += 1;
    });

    // Back page
    doc.addPage();
    drawBackPage(doc, story, order, backCoverBuffer, options.backCoverTagline ?? null);

    doc.end();
  });
}

export function getPrintInteriorPageCount(story: StoryContent, order: OrderRecord): number {
  // Every print interior includes 5 intentional matter pages:
  // front matter (title + dedication + memory) and back matter (belongs,
  // merged closing note). Filler keepsake pages are a safety net only — used
  // when story + matter still falls short of the Lulu minimum. For new
  // long-form orders (classic 24 / premium 32) this collapses or eliminates
  // the filler dependency.
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
      doc
        .fillColor(GOLD)
        .font(EMBEDDED_BOOK_FONT)
        .fontSize(10)
        .text(String(pageNumber), margin, trimHeight - 28, { width: contentWidth, align: 'center' });
      pageNumber += 1;
    };

    // Front matter — title + dedication (intentional, designed pages).
    frontMatter.forEach(drawMatterPage);

    story.pages.forEach((page, index) => {
      doc.addPage();
      const layout = getPictureBookStoryLayout('print', page.textLayout);
      const fitted = fitPictureBookText(layout, page.sceneTitle, page.story);
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
        layout.textPanelY + 10,
        layout.textPanelWidth - layout.textInset * 2,
        layout.textPanelHeight - 20,
        fitted.storyFontSize,
        fitted.storyLineGap,
        textFillColor(layout.textColorMode),
        Boolean(scrim),
      );

      doc.fillColor(GOLD).font(EMBEDDED_BOOK_FONT).fontSize(10).text(String(pageNumber), margin, trimHeight - 28, { width: contentWidth, align: 'center' });
      pageNumber += 1;
    });

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
      doc.fillColor(GOLD).font(EMBEDDED_BOOK_FONT).fontSize(10).text(String(pageNumber), margin, trimHeight - 28, { width: contentWidth, align: 'center' });
      pageNumber += 1;
    });

    // Back matter — belongs page plus the merged about/quiet closing note.
    backMatter.forEach(drawMatterPage);

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
