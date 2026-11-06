import { readFile } from 'node:fs/promises';
import path from 'node:path';

// The standalone build, as pdf-builder.ts: no runtime AFM reads.
import PDFDocumentStandalone from 'pdfkit/js/pdfkit.standalone.js';
import type PDFDocumentType from 'pdfkit';

const PDFDocument = PDFDocumentStandalone as unknown as typeof PDFDocumentType;

/**
 * Native classroom local proof renderer. Deterministic content from eligible
 * first names and pinned approved art only. Retail back matter is deliberately
 * not reused: its printing and illustration statements are untrue here.
 */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const ROSTER_PAGE_SIZE = 28;
const FOREST = '#1F3A5F';
const CREAM = '#FFF8F0';
const SLATE = '#475569';
const NO_LIGATURES = { liga: false, clig: false, dlig: false, hlig: false };
const NOTICE = 'LOCAL PROOF ONLY. NOT A FINISHED BOOK. NOT RELEASED.';

export interface ClassroomProofContent {
  title: string;
  participantNames: string[];
  pages: { assetSha256: string; caption: string }[];
}

export function classroomProofContent(participantNames: string[], assetSha256: string[]): ClassroomProofContent {
  const count = participantNames.length;
  return {
    title: 'Our Classroom Book',
    participantNames: [...participantNames],
    pages: assetSha256.map((digest, index) => ({
      assetSha256: digest,
      caption: `Layout page ${index + 1} of ${assetSha256.length} for ${count} participating ${count === 1 ? 'family' : 'families'}. This sample art does not depict anyone in this class.`,
    })),
  };
}

function textOn(
  doc: InstanceType<typeof PDFDocument>,
  value: string,
  y: number,
  options: { size: number; color: string; align?: string },
): void {
  doc.fillColor(options.color).fontSize(options.size)
    .text(value, MARGIN, y, { width: CONTENT_WIDTH, align: options.align ?? 'center', features: NO_LIGATURES } as never);
}

function startPage(doc: InstanceType<typeof PDFDocument>): void {
  doc.addPage();
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(CREAM);
  textOn(doc, NOTICE, PAGE_HEIGHT - 36, { size: 9, color: SLATE });
}

/** `images` are ArrayBuffers: the standalone build's Buffer does not recognize a Node Buffer as image data. */
export async function renderClassroomProofPdf(
  content: ClassroomProofContent,
  images: ArrayBuffer[],
  createdAt: Date,
): Promise<Buffer> {
  const font = await readFile(path.join(process.cwd(), 'src/lib/fonts/Geist-Regular.ttf'));
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      autoFirstPage: false,
      info: {
        Title: `${content.title} (local proof)`,
        Subject: `Local proof for: ${content.participantNames.join(', ')}`,
        CreationDate: createdAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      const pdf = Buffer.concat(chunks);
      if (!/\/FontFile[123]\b/.test(pdf.toString('latin1'))) {
        reject(new Error('classroom_proof:font_not_embedded'));
        return;
      }
      resolve(pdf);
    });
    doc.on('error', reject);
    try {
      doc.font(font);
      startPage(doc);
      textOn(doc, content.title, 300, { size: 34, color: FOREST });
      textOn(doc, NOTICE, 370, { size: 12, color: SLATE });
      for (let start = 0; start < content.participantNames.length; start += ROSTER_PAGE_SIZE) {
        startPage(doc);
        textOn(doc, 'In this class', 72, { size: 24, color: FOREST });
        content.participantNames.slice(start, start + ROSTER_PAGE_SIZE).forEach((name, index) => {
          textOn(doc, name, 130 + index * 22, { size: 14, color: SLATE });
        });
      }
      content.pages.forEach((page, index) => {
        startPage(doc);
        doc.image(images[index], MARGIN, 72, { fit: [CONTENT_WIDTH, 590], align: 'center', valign: 'center' });
        textOn(doc, page.caption, 690, { size: 13, color: SLATE });
      });
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
