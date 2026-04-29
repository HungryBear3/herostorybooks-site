import type { OrderRecord } from './orders.ts';
import type { StoryContent } from './fulfillment-types.ts';

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

function buildKeepsakePages(story: StoryContent, order: OrderRecord, fillerCount: number): KeepsakePage[] {
  const lesson = order.lesson || 'courage';
  const theme = order.theme || 'adventure';
  const prompts: KeepsakePage[] = [
    {
      title: 'This Book Belongs To',
      body: `${order.childName}'s personalized Hero Story Book\n\nA keepsake adventure created just for your family.`,
      prompt: 'Write the date you received this book and where you first read it together.',
    },
    {
      title: 'Hero Spotlight',
      body: `${order.childName} is the hero of this story. Brave choices, a kind heart, and a spirit of ${lesson} carry the adventure forward.`,
      prompt: `What makes ${order.childName} special in real life?`,
    },
    {
      title: 'Favorite Memory',
      body: 'Books become keepsakes when families add their own memories to the story.',
      prompt: 'Write your favorite part of this adventure here.',
    },
    {
      title: 'Story Lesson',
      body: `This story was shaped around ${lesson}. Small brave moments often become the biggest memories.`,
      prompt: `How did ${order.childName} show ${lesson} today?`,
    },
    {
      title: 'Adventure Notes',
      body: `Theme: ${theme}\nFormat: ${order.bookFormat === 'premium' ? 'Hardcover keepsake edition' : order.bookFormat === 'classic' ? 'Softcover keepsake edition' : 'Digital edition'}`,
      prompt: 'Add a note from a parent, grandparent, aunt, uncle, or family friend.',
    },
    {
      title: 'Picture This Scene',
      body: 'Imagine one more page from the adventure and describe what happens next.',
      prompt: 'What would the next illustration show?',
    },
    {
      title: 'Read Together',
      body: 'The best personalized books become part of bedtime, gift moments, and family traditions.',
      prompt: 'Who should read this story aloud next?',
    },
    {
      title: 'A Note For Later',
      body: `One day ${order.childName} will look back at this story and remember being the hero.`,
      prompt: 'Leave a message for them to read in the future.',
    },
  ];

  return Array.from({ length: fillerCount }, (_, index) => {
    const template = prompts[index % prompts.length];
    return {
      title: template.title,
      body: template.body,
      prompt: template.prompt,
    };
  });
}

// ── Image fetching ─────────────────────────────────────────────────────────────

async function fetchImageBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

// ── Cover page ─────────────────────────────────────────────────────────────────

function drawCover(
  doc: InstanceType<typeof PDFDocument>,
  story: StoryContent,
  order: OrderRecord,
  coverImageBuffer: Buffer | null,
) {
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(FOREST);

  // gold accent bar
  doc.rect(0, PAGE_HEIGHT - 80, PAGE_WIDTH, 80).fill(GOLD);

  const centerX = PAGE_WIDTH / 2;

  if (coverImageBuffer) {
    try {
      doc.image(coverImageBuffer, MARGIN, 80, { width: CONTENT_WIDTH, height: 320, align: 'center' });
    } catch { /* skip broken image */ }
  }

  const titleY = coverImageBuffer ? 440 : 200;
  doc
    .fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .fontSize(28)
    .text(story.title, MARGIN, titleY, { width: CONTENT_WIDTH, align: 'center' });

  if (story.dedication) {
    doc
      .fillColor(GOLD)
      .font('Helvetica-Oblique')
      .fontSize(13)
      .text(story.dedication, MARGIN, doc.y + 16, { width: CONTENT_WIDTH, align: 'center' });
  }

  doc
    .fillColor(FOREST)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text('A HeroStoryBooks Original', MARGIN, PAGE_HEIGHT - 52, { width: CONTENT_WIDTH, align: 'center' });
}

// ── Story page ─────────────────────────────────────────────────────────────────

function drawStoryPage(
  doc: InstanceType<typeof PDFDocument>,
  pageNum: number,
  sceneTitle: string,
  storyText: string,
  imageBuffer: Buffer | null,
) {
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(CREAM);

  // Header bar
  doc.rect(0, 0, PAGE_WIDTH, 44).fill(FOREST);
  doc
    .fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(sceneTitle.toUpperCase(), MARGIN, 14, { width: CONTENT_WIDTH, align: 'center' });

  // Image zone
  const imgY = 56;
  const imgH = imageBuffer ? 300 : 0;

  if (imageBuffer) {
    try {
      doc.image(imageBuffer, MARGIN, imgY, {
        width: CONTENT_WIDTH,
        height: imgH,
        align: 'center',
        valign: 'center',
      });
    } catch { /* skip broken image */ }
  } else {
    // decorative placeholder
    doc.rect(MARGIN, imgY, CONTENT_WIDTH, 120).fill('#E5E7EB');
    doc
      .fillColor('#9CA3AF')
      .font('Helvetica')
      .fontSize(11)
      .text('✨', MARGIN, imgY + 50, { width: CONTENT_WIDTH, align: 'center' });
  }

  const textY = imageBuffer ? imgY + imgH + 20 : imgY + 20;
  doc
    .fillColor('#1f2937')
    .font('Helvetica')
    .fontSize(14)
    .lineGap(4)
    .text(storyText, MARGIN, textY, { width: CONTENT_WIDTH, align: 'justify' });

  // Page number
  doc
    .fillColor(GOLD)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(String(pageNum), MARGIN, PAGE_HEIGHT - 36, { width: CONTENT_WIDTH, align: 'center' });
}

function drawKeepsakePage(
  doc: InstanceType<typeof PDFDocument>,
  pageNum: number,
  page: KeepsakePage,
) {
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(CREAM);
  doc.rect(0, 0, PAGE_WIDTH, 32).fill(GOLD);

  doc
    .fillColor(FOREST)
    .font('Helvetica-Bold')
    .fontSize(24)
    .text(page.title, MARGIN, 72, { width: CONTENT_WIDTH, align: 'center' });

  doc
    .fillColor(SLATE)
    .font('Helvetica')
    .fontSize(15)
    .lineGap(6)
    .text(page.body, MARGIN, 138, { width: CONTENT_WIDTH, align: 'center' });

  if (page.prompt) {
    doc
      .fillColor(FOREST)
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(page.prompt, MARGIN, 280, { width: CONTENT_WIDTH, align: 'center' });

    const lineStart = 340;
    const lineGap = 34;
    for (let i = 0; i < 8; i += 1) {
      const y = lineStart + i * lineGap;
      doc.moveTo(MARGIN + 8, y).lineTo(PAGE_WIDTH - MARGIN - 8, y).strokeColor('#CBD5E1').lineWidth(1).stroke();
    }
  }

  doc
    .fillColor(GOLD)
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(String(pageNum), MARGIN, PAGE_HEIGHT - 36, { width: CONTENT_WIDTH, align: 'center' });
}

// ── Back page ──────────────────────────────────────────────────────────────────

function drawBackPage(doc: InstanceType<typeof PDFDocument>, order: OrderRecord) {
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(FOREST);
  doc.rect(0, PAGE_HEIGHT - 80, PAGE_WIDTH, 80).fill(GOLD);

  doc
    .fillColor(GOLD)
    .font('Helvetica-Bold')
    .fontSize(36)
    .text('The End', MARGIN, 260, { width: CONTENT_WIDTH, align: 'center' });

  doc
    .fillColor('#FFFFFF')
    .font('Helvetica')
    .fontSize(14)
    .text(
      `A personalized adventure created especially for ${order.childName}.`,
      MARGIN,
      330,
      { width: CONTENT_WIDTH, align: 'center' },
    );

  doc
    .fillColor(FOREST)
    .font('Helvetica-Bold')
    .fontSize(12)
    .text('herostorybooks.com', MARGIN, PAGE_HEIGHT - 52, { width: CONTENT_WIDTH, align: 'center' });
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function buildPdf(
  story: StoryContent,
  order: OrderRecord,
  imageUrls: (string | null)[],
): Promise<Buffer> {
  // Fetch all images in parallel (gracefully skip failures)
  const imageBuffers = await Promise.all(
    imageUrls.map(url => (url ? fetchImageBuffer(url) : Promise.resolve(null))),
  );

  const minimumTotalPages = getMinimumTotalPages(order.bookFormat);
  const currentTotalPages = story.pages.length + 2; // cover + back
  const fillerPages = buildKeepsakePages(story, order, Math.max(0, minimumTotalPages - currentTotalPages));

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      autoFirstPage: false,
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Cover
    doc.addPage();
    drawCover(doc, story, order, imageBuffers[0] ?? null);

    let renderedPageNumber = 1;

    // Story pages
    story.pages.forEach((page, i) => {
      doc.addPage();
      drawStoryPage(doc, renderedPageNumber, page.sceneTitle, page.story, imageBuffers[i + 1] ?? null);
      renderedPageNumber += 1;
    });

    fillerPages.forEach((page) => {
      doc.addPage();
      drawKeepsakePage(doc, renderedPageNumber, page);
      renderedPageNumber += 1;
    });

    // Back page
    doc.addPage();
    drawBackPage(doc, order);

    doc.end();
  });
}

export function getPrintInteriorPageCount(story: StoryContent, order: OrderRecord): number {
  const minimumPages = getMinimumTotalPages(order.bookFormat);
  return Math.max(story.pages.length, minimumPages);
}

export async function buildPrintInteriorPdf(
  story: StoryContent,
  order: OrderRecord,
  imageUrls: (string | null)[],
): Promise<Buffer> {
  const imageBuffers = await Promise.all(
    imageUrls.map(url => (url ? fetchImageBuffer(url) : Promise.resolve(null))),
  );

  const interiorPageCount = getPrintInteriorPageCount(story, order);
  const fillerPages = buildKeepsakePages(story, order, Math.max(0, interiorPageCount - story.pages.length));
  const trimWidth = 8.5 * 72;
  const trimHeight = 8.5 * 72;
  const margin = 42;
  const contentWidth = trimWidth - margin * 2;

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [trimWidth, trimHeight],
      margin: 0,
      autoFirstPage: false,
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let pageNumber = 1;
    story.pages.forEach((page, index) => {
      doc.addPage();
      doc.rect(0, 0, trimWidth, trimHeight).fill(CREAM);
      doc.rect(0, 0, trimWidth, 28).fill(FOREST);
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11).text(page.sceneTitle.toUpperCase(), margin, 9, { width: contentWidth, align: 'center' });

      const image = imageBuffers[index + 1] ?? null;
      if (image) {
        try {
          doc.image(image, margin, 42, { width: contentWidth, height: 250, align: 'center', valign: 'center' });
        } catch {
          doc.rect(margin, 42, contentWidth, 120).fill('#E5E7EB');
        }
      } else {
        doc.rect(margin, 42, contentWidth, 120).fill('#E5E7EB');
      }

      doc.fillColor('#1f2937').font('Helvetica').fontSize(12).lineGap(4).text(page.story, margin, 310, { width: contentWidth, align: 'justify' });
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(10).text(String(pageNumber), margin, trimHeight - 28, { width: contentWidth, align: 'center' });
      pageNumber += 1;
    });

    fillerPages.forEach((page) => {
      doc.addPage();
      doc.rect(0, 0, trimWidth, trimHeight).fill(CREAM);
      doc.rect(0, 0, trimWidth, 24).fill(GOLD);
      doc.fillColor(FOREST).font('Helvetica-Bold').fontSize(22).text(page.title, margin, 56, { width: contentWidth, align: 'center' });
      doc.fillColor(SLATE).font('Helvetica').fontSize(13).lineGap(5).text(page.body, margin, 120, { width: contentWidth, align: 'center' });
      if (page.prompt) {
        doc.fillColor(FOREST).font('Helvetica-Bold').fontSize(12).text(page.prompt, margin, 240, { width: contentWidth, align: 'center' });
        for (let i = 0; i < 7; i += 1) {
          const y = 295 + i * 32;
          doc.moveTo(margin + 6, y).lineTo(trimWidth - margin - 6, y).strokeColor('#CBD5E1').lineWidth(1).stroke();
        }
      }
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(10).text(String(pageNumber), margin, trimHeight - 28, { width: contentWidth, align: 'center' });
      pageNumber += 1;
    });

    doc.end();
  });
}

export function buildPrintCoverPdf(
  widthPoints: number,
  heightPoints: number,
  title: string,
  order: OrderRecord,
): Buffer {
  const doc = new PDFDocument({
    size: [widthPoints, heightPoints],
    margin: 0,
    autoFirstPage: false,
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  doc.addPage();
  doc.rect(0, 0, widthPoints, heightPoints).fill('#F8E7C7');
  doc.rect(widthPoints * 0.55, 0, widthPoints * 0.45, heightPoints).fill(FOREST);
  doc.rect(widthPoints * 0.5 - 8, 0, 16, heightPoints).fill(GOLD);

  const frontX = widthPoints * 0.58;
  const frontWidth = widthPoints * 0.36;
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(Math.max(22, widthPoints * 0.03)).text(title, frontX, 90, { width: frontWidth, align: 'center' });
  doc.fillColor(GOLD).font('Helvetica').fontSize(16).text(`A personalized story for ${order.childName}`, frontX, 190, { width: frontWidth, align: 'center' });

  doc.fillColor(FOREST).font('Helvetica-Bold').fontSize(18).text('Hero Story Books', 40, 90, { width: widthPoints * 0.38, align: 'center' });
  doc.fillColor(SLATE).font('Helvetica').fontSize(12).lineGap(4).text('A personalized keepsake adventure created for story time, gifting, and family memories.', 40, 150, { width: widthPoints * 0.38, align: 'center' });

  doc.end();
  return Buffer.concat(chunks);
}
