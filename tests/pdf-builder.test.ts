import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  buildPdf,
  buildPrintCoverPdf,
  buildPrintInteriorPdf,
  fitPictureBookText,
  getPictureBookStoryLayout,
  getPrintFillerPageCount,
  getPrintInteriorPageCount,
  resolvePageTextLayout,
} from '../src/lib/pdf-builder.ts';
import { createOrderRecord } from '../src/lib/orders.ts';
import type { PageTextLayout, StoryContent } from '../src/lib/fulfillment-types.ts';

function countPdfPages(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
}

const SHORT_STORY: StoryContent = {
  title: "Luna's Great Adventure",
  dedication: 'For Luna',
  characterDescription: 'A brave child named Luna.',
  pages: [
    { pageNum: 1, sceneTitle: 'The Beginning', story: 'Luna begins her quest.', imagePrompt: 'Luna in a forest' },
    { pageNum: 2, sceneTitle: 'The Challenge', story: 'Luna faces a challenge.', imagePrompt: 'Luna climbing a hill' },
    { pageNum: 3, sceneTitle: 'The Victory', story: 'Luna returns home smiling.', imagePrompt: 'Luna celebrating' },
  ],
};

const LONG_STORY: StoryContent = {
  title: 'Lukas and the Listening Stones',
  dedication: 'For Lukas',
  characterDescription: 'A brave child named Lukas.',
  pages: Array.from({ length: 24 }, (_, index) => ({
    pageNum: index + 1,
    sceneTitle: `Story Page ${index + 1}`,
    story: `Lukas moves through story beat ${index + 1} with a new clue in hand.`,
    imagePrompt: `Lukas on page ${index + 1}`,
  })),
};

const PREMIUM_LONG_STORY: StoryContent = {
  ...LONG_STORY,
  pages: Array.from({ length: 32 }, (_, index) => ({
    pageNum: index + 1,
    sceneTitle: `Premium Story Page ${index + 1}`,
    story: `Lukas carries the adventure forward on premium page ${index + 1}.`,
    imagePrompt: `Premium Lukas on page ${index + 1}`,
  })),
};

function extractPdfText(pdf: Buffer, filename: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-pdf-text-'));
  try {
    const pdfPath = path.join(dir, filename);
    const txtPath = path.join(dir, `${filename}.txt`);
    writeFileSync(pdfPath, pdf);
    execFileSync('pdftotext', [pdfPath, txtPath]);
    return execFileSync('cat', [txtPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoLigatureDropout(text: string, label: string): void {
  const suspicious = [
    /\bfnger\b/i,
    /\bfrst\b/i,
    /\bdiferent\b/i,
    /\bfnal\b/i,
    /\bfnds\b/i,
    /\bfrefly\b/i,
    /\bfirefies\b/i,
    /\bpatern\b/i,
    /\brefecting\b/i,
    /\bratle\b/i,
    /\bsetle\b/i,
    /ord_f5dcfc8a0b84d06/i,
  ];
  const hit = suspicious.find((pattern) => pattern.test(text));
  assert.equal(hit, undefined, `${label} contains ligature-dropout text: ${hit}`);
}

function inspectPdfFonts(pdf: Buffer, filename: string): Array<{ name: string; embedded: boolean; subset: boolean }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-pdf-fonts-'));
  try {
    const pdfPath = path.join(dir, filename);
    writeFileSync(pdfPath, pdf);
    const output = execFileSync('pdffonts', [pdfPath], { encoding: 'utf8' });
    return output
      .trim()
      .split('\n')
      .slice(2)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const cols = line.split(/\s{2,}/);
        const flags = (cols[3] ?? '').trim().split(/\s+/);
        return {
          name: cols[0] ?? 'unknown',
          embedded: flags[0] === 'yes',
          subset: flags[1] === 'yes',
        };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('buildPdf pads classic print books to Lulu minimum page count', async () => {
  const order = createOrderRecord({ childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' });
  const pdf = await buildPdf(SHORT_STORY, order, [null, null, null, null]);

  assert.ok(countPdfPages(pdf) >= 32, `expected classic print PDF to have at least 32 pages, got ${countPdfPages(pdf)}`);
});

test('buildPdf pads premium print books to Lulu minimum page count', async () => {
  const order = createOrderRecord({ childName: 'Luna', bookFormat: 'premium', email: 'luna@example.com' });
  const pdf = await buildPdf(SHORT_STORY, order, [null, null, null, null]);

  assert.ok(countPdfPages(pdf) >= 24, `expected premium print PDF to have at least 24 pages, got ${countPdfPages(pdf)}`);
});

test('getPrintInteriorPageCount/getPrintFillerPageCount: classic 24-page books reserve room for book matter and only two blank safety pages', () => {
  const order = createOrderRecord({ childName: 'Lukas', bookFormat: 'classic', email: 'lukas@example.com' });

  assert.equal(getPrintInteriorPageCount(LONG_STORY, order), 32);
  assert.equal(getPrintFillerPageCount(LONG_STORY, order), 2);
});

test('getPrintInteriorPageCount/getPrintFillerPageCount: premium 32-page books keep the full matter stack without worksheet filler', () => {
  const order = createOrderRecord({ childName: 'Lukas', bookFormat: 'premium', email: 'lukas@example.com' });

  assert.equal(getPrintInteriorPageCount(PREMIUM_LONG_STORY, order), 38);
  assert.equal(getPrintFillerPageCount(PREMIUM_LONG_STORY, order), 0);
});

test('getPictureBookStoryLayout: proof pages crop art above a clean paper text band', () => {
  const layout = getPictureBookStoryLayout('proof');
  assert.ok(layout.imageHeight > 580, 'proof image should still dominate the page height');
  assert.ok(layout.imageWidth > 500, 'proof image should nearly span the page width');
  assert.ok(layout.textPanelY >= layout.imageY + layout.imageHeight, 'text band must sit fully below the artwork');
  assert.ok(layout.textPanelHeight >= 150, 'text band should be tall enough for friendly picture-book copy');
  assert.equal(layout.textPanelStyle, 'translucent_cream');
  assert.equal(layout.textColorMode, 'dark');
  assert.equal(layout.textPanelFillOpacity, 1);
});

test('getPictureBookStoryLayout: print pages crop art above a clean paper text band', () => {
  const layout = getPictureBookStoryLayout('print');
  assert.ok(layout.imageHeight >= 420, 'print image should occupy the top picture-book area');
  assert.ok(layout.imageWidth > 500, 'print image should nearly span the trim width');
  assert.ok(layout.textPanelY >= layout.imageY + layout.imageHeight, 'print text band must not overlap the artwork');
  assert.ok(layout.textPanelHeight >= 120, 'text band should be tall enough for real picture-book copy');
  assert.equal(layout.textPanelStyle, 'translucent_cream');
  assert.equal(layout.textColorMode, 'dark');
  assert.equal(layout.textPanelFillOpacity, 1);
});

test('fitPictureBookText: shrinks typography enough to prevent title/body overlap in paper band', () => {
  const layout = getPictureBookStoryLayout('print');
  const fitted = fitPictureBookText(
    layout,
    'THE EXTREMELY LONG DISCOVERY OF THE STONE MARKER BESIDE THE MOONLIT WATERFALL',
    'Lukas kneels beside the carved stones and studies each mark carefully. He presses his fingertips into the grooves, listens to the water, and keeps the small tablet tucked close while he decides what to do next.',
  );

  assert.ok(fitted.sceneTitleFontSize <= 15, 'long titles should not grow past the default size');
  assert.ok(fitted.storyFontSize <= 15, 'body copy should fit without growing past default');
  assert.ok(fitted.storyY > fitted.sceneTitleY + fitted.sceneTitleHeight, 'body text should start below the title block');
  assert.ok(fitted.storyHeight <= layout.textPanelHeight - 12, 'body text should stay inside the paper band');
});

test('buildPdf: does not render the internal all-caps sceneTitle/beat header on customer-facing pages', async () => {
  const order = createOrderRecord({ childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' });
  const story: StoryContent = {
    ...SHORT_STORY,
    pages: [
      {
        pageNum: 1,
        sceneTitle: 'LACES BOOTS AND CHECKS A FOLDED MAP AND SQUARES UP FOR THE FIRST STEP WITH CREASED PAPER MAP.',
        story: 'Luna slips on her boots and studies the map one last time before heading down the trail.',
        imagePrompt: 'Luna in a forest',
      },
    ],
  };
  const pdf = await buildPdf(story, order, [null, null]);
  const extracted = extractPdfText(pdf, 'proof.pdf');
  assert.doesNotMatch(extracted, /LACES BOOTS AND CHECKS A FOLDED MAP/i);
  assert.match(extracted, /Luna slips on her boots/i);
});

test('buildPrintInteriorPdf: classic 24-page books remove worksheet metadata pages and keep clean non-duplicative book matter', async () => {
  const order = createOrderRecord({ childName: 'Lukas Kaplun', bookFormat: 'classic', email: 'lukas@example.com' });
  const pdf = await buildPrintInteriorPdf(LONG_STORY, order, Array.from({ length: LONG_STORY.pages.length + 1 }, () => null));
  const extracted = extractPdfText(pdf, 'interior.pdf');

  assert.doesNotMatch(extracted, /Adventure Notes/i);
  assert.doesNotMatch(extracted, /Theme:/i);
  assert.doesNotMatch(extracted, /Format:/i);
  assert.doesNotMatch(extracted, /A personalized story created for/i);
  assert.doesNotMatch(extracted, /Add a family memory, favorite line, or bedtime note here\./i);
  assert.equal((extracted.match(/The End/g) || []).length, 1);
  assert.match(extracted, /A HeroStoryBooks Original/i);
});

test('buildPrintInteriorPdf: classic 24-page books use intentional end matter instead of blank numbered pages before the back matter', async () => {
  const order = createOrderRecord({ childName: 'Lukas Kaplun', bookFormat: 'classic', email: 'lukas@example.com' });
  const pdf = await buildPrintInteriorPdf(LONG_STORY, order, Array.from({ length: LONG_STORY.pages.length + 1 }, () => null));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-interior-pages-'));
  try {
    const pdfPath = path.join(dir, 'interior.pdf');
    writeFileSync(pdfPath, pdf);
    const page27 = execFileSync('pdftotext', ['-f', '27', '-l', '27', pdfPath, '-'], { encoding: 'utf8' }).replace(/\f/g, '').trim();
    const page28 = execFileSync('pdftotext', ['-f', '28', '-l', '28', pdfPath, '-'], { encoding: 'utf8' }).replace(/\f/g, '').trim();

    assert.notEqual(page27, '27');
    assert.notEqual(page28, '28');
    assert.match(page27, /The End/i);
    assert.match(page28, /©\s*2026 Hero Story Books|Hero Story Books Edition|Printed in/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildPdf: classic proof uses book matter instead of worksheet filler/admin copy after the story', async () => {
  const order = createOrderRecord({ childName: 'Lukas Kaplun', bookFormat: 'classic', email: 'lukas@example.com' });
  const pdf = await buildPdf(LONG_STORY, order, Array.from({ length: LONG_STORY.pages.length + 1 }, () => null));
  const extracted = extractPdfText(pdf, 'proof-long.pdf');

  assert.doesNotMatch(extracted, /Adventure Notes/i);
  assert.doesNotMatch(extracted, /Theme:/i);
  assert.doesNotMatch(extracted, /Format:/i);
  assert.doesNotMatch(extracted, /A personalized story created for/i);
  assert.doesNotMatch(extracted, /Add a family memory, favorite line, or bedtime note here\./i);
  assert.equal((extracted.match(/The End/g) || []).length, 1);
  assert.match(extracted, /A HeroStoryBooks Original/i);
});

test('buildPdf: proof cover does not duplicate the dedication line and expands placeholder dedication text', async () => {
  const order = createOrderRecord({ childName: 'Lukas Kaplun', bookFormat: 'classic', email: 'lukas@example.com' });
  const pdf = await buildPdf(LONG_STORY, order, Array.from({ length: LONG_STORY.pages.length + 1 }, () => null));
  const extracted = extractPdfText(pdf, 'proof-dedication-check.pdf');

  assert.equal((extracted.match(/For Lukas/g) || []).length, 1);
  assert.match(extracted, /For Lukas — may every brave step lead to a wonderful story\./i);
});

test('buildPrintCoverPdf: cover/back cover use publisher-style copy instead of customer-seam text', async () => {
  const order = createOrderRecord({ childName: 'Lukas Kaplun', bookFormat: 'classic', email: 'lukas@example.com' });
  const pdf = await buildPrintCoverPdf(1200, 650, 'Lukas and the Listening Stones', order);
  const extracted = extractPdfText(pdf, 'cover.pdf');

  assert.match(extracted, /Lukas and the Listening\s+Stones/i);
  assert.match(extracted, /A HeroStoryBooks Original/i);
  assert.match(extracted, /Hero Story Books/i);
  assert.doesNotMatch(extracted, /A personalized story for/i);
});

test('buildPrintCoverPdf: embeds all cover fonts for commercial printing', async () => {
  const order = createOrderRecord({ childName: 'Lukas Kaplun', bookFormat: 'classic', email: 'lukas@example.com' });
  const pdf = await buildPrintCoverPdf(1200, 650, 'Lukas and the Listening Stones', order);
  const fonts = inspectPdfFonts(pdf, 'cover-fonts.pdf');

  assert.ok(fonts.length > 0, 'expected at least one font in the generated cover PDF');
  assert.ok(fonts.every((font) => font.embedded), `expected all cover fonts to be embedded, got ${JSON.stringify(fonts)}`);
});

test('getPictureBookStoryLayout: legacy in-art metadata is preserved by type but rendered as bottom paper band', () => {
  const layout: PageTextLayout = { zone: 'top_band', colorMode: 'auto', panelStyle: 'translucent_dark' };
  const proof = getPictureBookStoryLayout('proof', layout);
  const print = getPictureBookStoryLayout('print', layout);
  for (const got of [proof, print]) {
    assert.ok(got.textPanelY >= got.imageY + got.imageHeight, 'Release 1 should not put copy over art');
    assert.ok(got.textPanelHeight >= 120, 'panel must remain tall enough for real picture-book copy');
    assert.equal(got.textPanelStyle, 'translucent_cream');
    assert.equal(got.textColorMode, 'dark');
  }
});

test('getPictureBookStoryLayout: translucent_cream metadata also renders as the bottom paper band', () => {
  const layout: PageTextLayout = { zone: 'bottom_left', colorMode: 'auto', panelStyle: 'translucent_cream' };
  const proof = getPictureBookStoryLayout('proof', layout);
  assert.ok(proof.textPanelY >= proof.imageY + proof.imageHeight, 'cream band should sit below art');
  assert.ok(proof.textPanelHeight >= 120, 'paper band still has to fit the caption legibly');
  assert.equal(proof.textPanelStyle, 'translucent_cream');
  assert.equal(proof.textColorMode, 'dark');
});

test('resolvePageTextLayout: story pages force dark text on cream, even for legacy dark scrim metadata', () => {
  assert.equal(resolvePageTextLayout({ zone: 'bottom_band', colorMode: 'auto', panelStyle: 'translucent_cream' }).colorMode, 'dark');
  assert.equal(resolvePageTextLayout({ zone: 'bottom_band', colorMode: 'auto', panelStyle: 'none' }).colorMode, 'dark');
  assert.deepEqual(resolvePageTextLayout({ zone: 'bottom_band', colorMode: 'auto', panelStyle: 'translucent_dark' }), {
    zone: 'bottom_band',
    panelStyle: 'translucent_cream',
    colorMode: 'dark',
  });
  assert.deepEqual(resolvePageTextLayout({ zone: 'bottom_band', colorMode: 'auto', panelStyle: 'soft_scrim' }), {
    zone: 'bottom_band',
    panelStyle: 'translucent_cream',
    colorMode: 'dark',
  });
});

test('resolvePageTextLayout: undefined input falls back to cream paper band with dark text', () => {
  const r = resolvePageTextLayout(undefined);
  assert.equal(r.zone, 'natural');
  assert.equal(r.panelStyle, 'translucent_cream');
  assert.equal(r.colorMode, 'dark');
});

test('buildPdf: per-page textLayout flows through and renders without throwing', async () => {
  const order = createOrderRecord({ childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' });
  const story: StoryContent = {
    title: "Luna's Adventure",
    characterDescription: 'A brave child.',
    pages: [
      { pageNum: 1, sceneTitle: 'Top', story: 'Top band caption.', imagePrompt: 'p1', textLayout: { zone: 'top_band', colorMode: 'auto', panelStyle: 'translucent_dark' } },
      { pageNum: 2, sceneTitle: 'Corner', story: 'Bottom-left caption.', imagePrompt: 'p2', textLayout: { zone: 'bottom_left', colorMode: 'auto', panelStyle: 'soft_scrim' } },
      { pageNum: 3, sceneTitle: 'Default', story: 'Default caption.', imagePrompt: 'p3' },
    ],
  };
  const pdf = await buildPdf(story, order, [null, null, null, null]);
  assert.ok(pdf.length > 1000, 'PDF should still be produced with per-page layouts');
});

test('buildPdf/buildPrintInteriorPdf: embeds all proof and interior fonts for commercial printing', async () => {
  const order = createOrderRecord({ childName: 'Lukas Kaplun', bookFormat: 'classic', email: 'lukas@example.com' });
  const urls = Array.from({ length: LONG_STORY.pages.length + 1 }, () => null);
  const proofPdf = await buildPdf(LONG_STORY, order, urls);
  const interiorPdf = await buildPrintInteriorPdf(LONG_STORY, order, urls);

  const proofFonts = inspectPdfFonts(proofPdf, 'proof-fonts.pdf');
  const interiorFonts = inspectPdfFonts(interiorPdf, 'interior-fonts.pdf');
  const proofText = extractPdfText(proofPdf, 'proof-ligatures.pdf');
  const interiorText = extractPdfText(interiorPdf, 'interior-ligatures.pdf');

  assert.ok(proofFonts.length > 0, 'expected at least one font in the generated proof PDF');
  assert.ok(interiorFonts.length > 0, 'expected at least one font in the generated interior PDF');
  assert.ok(proofFonts.every((font) => font.embedded), `expected all proof fonts to be embedded, got ${JSON.stringify(proofFonts)}`);
  assert.ok(interiorFonts.every((font) => font.embedded), `expected all interior fonts to be embedded, got ${JSON.stringify(interiorFonts)}`);
  assertNoLigatureDropout(proofText, 'proof PDF');
  assertNoLigatureDropout(interiorText, 'interior PDF');
});
