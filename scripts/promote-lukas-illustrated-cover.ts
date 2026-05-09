import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

import { buildPdf, buildPrintCoverPdf, buildPrintInteriorPdf, getPrintInteriorPageCount } from '../src/lib/pdf-builder.ts';
import {
  getBlobAccessMode,
  getOrder,
  persistOrder,
  withBlobNamespace,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';
import type { StoryContent, PageTextLayout } from '../src/lib/fulfillment-types.ts';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';
const EXPECTED_EXISTING_PRINT_JOB_ID = '2857729';
const FRONT_COVER_LOCAL = path.join(process.cwd(), 'tmp/cover-fix/front-cover-clean.png');
const FRONT_COVER_EXPECTED_MD5 = 'c57e98e85e9df916b29621ac1c91af9c';
const TEXT_LAYOUT: PageTextLayout = { zone: 'bottom_band', colorMode: 'dark', panelStyle: 'translucent_cream' };
const BACK_COVER_TAGLINE = 'When Lukas discovers stones that seem to listen, he follows their quiet magic into a jungle adventure made just for him. A brave, gentle keepsake about wonder, courage, and the small treasures that help us hear our own heart.';

function md5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function storyFromArtifacts(order: OrderRecord, artifacts: PageArtifact[]): StoryContent {
  const pages = artifacts
    .slice()
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((p) => ({
      pageNum: p.pageIndex + 1,
      sceneTitle: `Page ${p.pageIndex + 1}`,
      story: p.storyText,
      imagePrompt: p.basePrompt,
      textLayout: TEXT_LAYOUT,
    }));
  return {
    title: order.printTitle ?? `${order.childName}'s Adventure`,
    characterDescription: artifacts[0]?.characterAnchor ?? `${order.childName}, age ${order.childAge}`,
    pages,
  };
}

async function putBlob(pathname: string, buffer: Buffer, contentType: string, apply: boolean, token: string): Promise<string> {
  const namespaced = withBlobNamespace(pathname);
  if (!apply) return `[dry-run] ${namespaced}`;
  const blob = await put(namespaced, buffer, {
    access: getBlobAccessMode(),
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
  return blob.url;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');

  const order = await getOrder(ORDER_ID);
  if (!order) throw new Error(`Order not found: ${ORDER_ID}`);
  if (order.id !== ORDER_ID) throw new Error(`Refusing unexpected order id ${order.id}`);
  if (order.printJobId !== EXPECTED_EXISTING_PRINT_JOB_ID) {
    throw new Error(`Refusing: expected preserved printJobId=${EXPECTED_EXISTING_PRINT_JOB_ID}, got ${order.printJobId ?? 'null'}`);
  }
  if (order.pageArtifacts?.length !== 24) throw new Error(`Refusing: expected 24 pageArtifacts, got ${order.pageArtifacts?.length ?? 0}`);
  if (order.status !== 'print_in_production') throw new Error(`Refusing: expected print_in_production, got ${order.status}`);

  const frontCoverBuffer = await readFile(FRONT_COVER_LOCAL);
  const frontCoverMd5 = md5(frontCoverBuffer);
  if (frontCoverMd5 !== FRONT_COVER_EXPECTED_MD5) {
    throw new Error(`Refusing: front cover md5 mismatch expected ${FRONT_COVER_EXPECTED_MD5}, got ${frontCoverMd5}`);
  }

  const now = new Date().toISOString();
  const safeTs = now.replace(/[:.]/g, '-');
  const frontCoverUrl = await putBlob(
    `orders/${ORDER_ID}/canonical-cover/front-cover-clean-seed-240602.png`,
    frontCoverBuffer,
    'image/png',
    apply,
    token,
  );
  const backCoverUrl = frontCoverUrl;

  const pageArtifacts: PageArtifact[] = order.pageArtifacts.map((p) => ({
    ...p,
    textLayout: TEXT_LAYOUT,
  }));
  const story = storyFromArtifacts(order, pageArtifacts);
  const imageUrls = [frontCoverUrl, ...pageArtifacts.map((p) => p.currentImageUrl ?? null)];
  const proof = await buildPdf(story, order, imageUrls, { backCoverUrl, backCoverTagline: BACK_COVER_TAGLINE });
  const interior = await buildPrintInteriorPdf(story, order, imageUrls);
  const printInteriorPageCount = getPrintInteriorPageCount(story, order);
  const dims = order.bookFormat === 'classic'
    ? { widthPt: (17.25 + (printInteriorPageCount / 444 + 0.06)) * 72, heightPt: 8.75 * 72 }
    : (() => { throw new Error(`Refusing: local fallback cover dimensions only implemented for classic, got ${order.bookFormat}`); })();
  const printCover = await buildPrintCoverPdf(dims.widthPt, dims.heightPt, order.printTitle ?? story.title, order, {
    frontCoverUrl,
    backCoverUrl,
    backCoverTagline: BACK_COVER_TAGLINE,
  });

  const proofMd5 = md5(proof);
  const interiorMd5 = md5(interior);
  const printCoverMd5 = md5(printCover);

  const outDir = path.join(process.cwd(), 'tmp', 'lukas-illustrated-cover', safeTs);
  await mkdir(outDir, { recursive: true });
  const proofLocal = path.join(outDir, 'lukas-illustrated-cover-proof-local.pdf');
  const interiorLocal = path.join(outDir, 'lukas-illustrated-cover-interior-local.pdf');
  const printCoverLocal = path.join(outDir, 'lukas-illustrated-cover-print-cover-local.pdf');
  await writeFile(proofLocal, proof);
  await writeFile(interiorLocal, interior);
  await writeFile(printCoverLocal, printCover);

  const proofUrl = await putBlob(
    `orders/${ORDER_ID}/lukas-illustrated-cover-proof-2026-05-06-canonical.pdf`,
    proof,
    'application/pdf',
    apply,
    token,
  );
  const interiorUrl = await putBlob(
    `orders/${ORDER_ID}/lukas-illustrated-cover-interior-2026-05-06-canonical.pdf`,
    interior,
    'application/pdf',
    apply,
    token,
  );
  const printCoverUrl = await putBlob(
    `orders/${ORDER_ID}/lukas-illustrated-cover-print-cover-2026-05-06-canonical.pdf`,
    printCover,
    'application/pdf',
    apply,
    token,
  );

  const updated: OrderRecord = {
    ...order,
    storyArtifactUrl: proofUrl,
    printInteriorArtifactUrl: interiorUrl,
    printInteriorMd5: interiorMd5,
    printInteriorPageCount,
    printCoverArtifactUrl: printCoverUrl,
    printCoverMd5,
    proofReviewedAt: null,
    reviewStatus: 'in_review',
    pageArtifacts,
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'promote_lukas_illustrated_cover_no_lulu',
        meta: {
          frontCoverUrl,
          frontCoverMd5,
          backCoverUrl,
          backCoverTagline: BACK_COVER_TAGLINE,
          proofUrl,
          interiorUrl,
          printCoverUrl,
          proofMd5,
          interiorMd5,
          printCoverMd5,
          proofLocal,
          interiorLocal,
          printCoverLocal,
          printInteriorPageCount,
          coverWidthPt: dims.widthPt,
          coverHeightPt: dims.heightPt,
          preservedPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
          noLuluAction: true,
        },
      },
    ],
    updatedAt: now,
  };

  const backupDir = path.join(process.cwd(), '.data', 'recovery-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${ORDER_ID}-pre-illustrated-cover-${safeTs}.json`);

  console.log(JSON.stringify({
    apply,
    orderId: ORDER_ID,
    preservedPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
    frontCoverMd5,
    frontCoverUrl,
    proofMd5,
    interiorMd5,
    printCoverMd5,
    printInteriorPageCount,
    coverDimensions: dims,
    proofLocal,
    interiorLocal,
    printCoverLocal,
    proofUrl,
    interiorUrl,
    printCoverUrl,
    backupPath,
  }, null, 2));

  if (!apply) {
    console.log('[promote-lukas-illustrated-cover] dry-run only; pass --apply to upload/persist.');
    return;
  }

  await writeFile(backupPath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  await persistOrder(updated);
  console.log('[promote-lukas-illustrated-cover] applied; no Lulu submission/payment occurred');
}

main().catch((err) => {
  console.error('[promote-lukas-illustrated-cover] failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
