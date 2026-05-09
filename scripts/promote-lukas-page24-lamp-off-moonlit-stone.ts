import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

import { buildPdf, buildPrintInteriorPdf, getPrintInteriorPageCount } from '../src/lib/pdf-builder.ts';
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
const PAGE_24_LOCAL = path.join(process.cwd(), 'tmp/page24-fix/p24-lamp-off-moonlit-stone.png');
const PAGE_24_EXPECTED_MD5 = 'c85533cf6a7496ac5965c2a86d69ae9d';
const PAGE_24_BLOB_NAME = 'canonical-page24-lamp-off-moonlit-stone/page-24-p24-bedroom-lamp-off-moonlit-stone.png';
const TEXT_LAYOUT: PageTextLayout = { zone: 'bottom_band', colorMode: 'dark', panelStyle: 'translucent_cream' };

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

  const page24Buffer = await readFile(PAGE_24_LOCAL);
  const page24Md5 = md5(page24Buffer);
  if (page24Md5 !== PAGE_24_EXPECTED_MD5) {
    throw new Error(`Refusing: page24 local md5 mismatch expected ${PAGE_24_EXPECTED_MD5}, got ${page24Md5}`);
  }

  const now = new Date().toISOString();
  const safeTs = now.replace(/[:.]/g, '-');
  const page24Url = await putBlob(
    `orders/${ORDER_ID}/${PAGE_24_BLOB_NAME}`,
    page24Buffer,
    'image/png',
    apply,
    token,
  );

  const pageArtifacts: PageArtifact[] = order.pageArtifacts.map((p) => ({
    ...p,
    currentImageUrl: p.pageIndex === 23 ? page24Url : p.currentImageUrl,
    textLayout: TEXT_LAYOUT,
  }));

  const story = storyFromArtifacts(order, pageArtifacts);
  const imageUrls = [null, ...pageArtifacts.map((p) => p.currentImageUrl ?? null)];
  const proof = await buildPdf(story, order, imageUrls);
  const interior = await buildPrintInteriorPdf(story, order, imageUrls);
  const proofMd5 = md5(proof);
  const interiorMd5 = md5(interior);
  const printInteriorPageCount = getPrintInteriorPageCount(story, order);

  const outDir = path.join(process.cwd(), 'tmp', 'lukas-page24-clean-bottom-band', safeTs);
  await mkdir(outDir, { recursive: true });
  const proofLocal = path.join(outDir, 'lukas-page24-lamp-off-moonlit-stone-proof-local.pdf');
  const interiorLocal = path.join(outDir, 'lukas-page24-lamp-off-moonlit-stone-interior-local.pdf');
  await writeFile(proofLocal, proof);
  await writeFile(interiorLocal, interior);

  const proofUrl = await putBlob(
    `orders/${ORDER_ID}/lukas-page24-lamp-off-moonlit-stone-proof-2026-05-06-canonical.pdf`,
    proof,
    'application/pdf',
    apply,
    token,
  );
  const interiorUrl = await putBlob(
    `orders/${ORDER_ID}/lukas-page24-lamp-off-moonlit-stone-interior-2026-05-06-canonical.pdf`,
    interior,
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
    proofReviewedAt: null,
    reviewStatus: 'in_review',
    pageArtifacts,
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'promote_lukas_page24_lamp_off_moonlit_stone_no_lulu',
        meta: {
          page24Url,
          page24Md5,
          proofUrl,
          interiorUrl,
          proofMd5,
          interiorMd5,
          proofLocal,
          interiorLocal,
          printInteriorPageCount,
          pageArtifactCount: pageArtifacts.length,
          textPanelStyleAllPages: TEXT_LAYOUT.panelStyle,
          textZoneAllPages: TEXT_LAYOUT.zone,
          preservedPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
          noLuluAction: true,
        },
      },
    ],
    updatedAt: now,
  };

  const backupDir = path.join(process.cwd(), '.data', 'recovery-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${ORDER_ID}-pre-page24-lamp-off-moonlit-stone-${safeTs}.json`);

  console.log(JSON.stringify({
    apply,
    orderId: ORDER_ID,
    preservedPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
    page24Md5,
    page24Url,
    proofMd5,
    interiorMd5,
    printInteriorPageCount,
    proofLocal,
    interiorLocal,
    proofUrl,
    interiorUrl,
    backupPath,
  }, null, 2));

  if (!apply) {
    console.log('[promote-lukas-page24-lamp-off-moonlit-stone] dry-run only; pass --apply to upload/persist.');
    return;
  }

  await writeFile(backupPath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  await persistOrder(updated);
  console.log('[promote-lukas-page24-lamp-off-moonlit-stone] applied');
}

main().catch((err) => {
  console.error('[promote-lukas-page24-lamp-off-moonlit-stone] failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
