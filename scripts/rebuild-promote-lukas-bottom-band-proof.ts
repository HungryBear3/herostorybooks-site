import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

import { buildPdf, buildPrintInteriorPdf } from '../src/lib/pdf-builder.ts';
import {
  getBlobAccessMode,
  getOrder,
  persistOrder,
  withBlobNamespace,
  type OrderRecord,
} from '../src/lib/orders.ts';
import type { StoryContent, PageTextLayout } from '../src/lib/fulfillment-types.ts';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';
const EXPECTED_EXISTING_PRINT_JOB_ID = '2857729';
const PAGE_24_URL = 'https://qhf3o9jip39ryj5m.public.blob.vercel-storage.com/orders/ord_f5dcffc8a0b84d06/canonical-page24-window-fix/page-24-p24-bedroom-cozy-house-style.png';
const PAGE_24_MD5 = '18fbb6dc5f478c397b488184439d7e61';
const TEXT_LAYOUT: PageTextLayout = { zone: 'bottom_band', colorMode: 'dark', panelStyle: 'translucent_cream' };

function md5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

async function fetchMd5(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${url}`);
  return md5(Buffer.from(await res.arrayBuffer()));
}

function storyFromOrder(order: OrderRecord): StoryContent {
  const pages = (order.pageArtifacts ?? [])
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
    characterDescription: order.pageArtifacts?.[0]?.characterAnchor ?? `${order.childName}, age ${order.childAge}`,
    pages,
  };
}

async function putPdf(blobName: string, buffer: Buffer, apply: boolean, token: string): Promise<string> {
  const pathname = withBlobNamespace(`orders/${ORDER_ID}/${blobName}`);
  if (!apply) return `[dry-run] ${pathname}`;
  const blob = await put(pathname, buffer, {
    access: getBlobAccessMode(),
    contentType: 'application/pdf',
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
  if (order.pageArtifacts[23]?.currentImageUrl !== PAGE_24_URL) throw new Error(`Refusing: page24 URL mismatch: ${order.pageArtifacts[23]?.currentImageUrl}`);
  const page24Md5 = await fetchMd5(PAGE_24_URL);
  if (page24Md5 !== PAGE_24_MD5) throw new Error(`Refusing: page24 md5 mismatch expected ${PAGE_24_MD5}, got ${page24Md5}`);

  const story = storyFromOrder(order);
  const imageUrls = [null, ...order.pageArtifacts.map((p) => p.currentImageUrl ?? null)];
  const proof = await buildPdf(story, order, imageUrls);
  const interior = await buildPrintInteriorPdf(story, order, imageUrls);
  const proofMd5 = md5(proof);
  const interiorMd5 = md5(interior);

  const now = new Date().toISOString();
  const safeTs = now.replace(/[:.]/g, '-');
  const outDir = path.join(process.cwd(), 'tmp', 'lukas-bottom-band-rebuild', safeTs);
  await mkdir(outDir, { recursive: true });
  const proofLocal = path.join(outDir, 'lukas-bottom-band-proof-local.pdf');
  const interiorLocal = path.join(outDir, 'lukas-bottom-band-interior-local.pdf');
  await writeFile(proofLocal, proof);
  await writeFile(interiorLocal, interior);

  const proofBlobName = `lukas-page24-bottom-band-proof-2026-05-06-canonical.pdf`;
  const interiorBlobName = `lukas-page24-bottom-band-interior-2026-05-06-canonical.pdf`;
  const proofUrl = await putPdf(proofBlobName, proof, apply, token);
  const interiorUrl = await putPdf(interiorBlobName, interior, apply, token);

  const updated: OrderRecord = {
    ...order,
    storyArtifactUrl: proofUrl,
    printInteriorArtifactUrl: interiorUrl,
    printInteriorMd5: interiorMd5,
    printInteriorPageCount: 32,
    proofReviewedAt: null,
    reviewStatus: 'in_review',
    pageArtifacts: order.pageArtifacts.map((p) => ({ ...p, textLayout: TEXT_LAYOUT })),
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'promote_lukas_page24_bottom_band_rebuild_no_lulu',
        meta: {
          proofUrl,
          interiorUrl,
          proofMd5,
          interiorMd5,
          proofLocal,
          interiorLocal,
          page24Url: PAGE_24_URL,
          page24Md5,
          pageArtifactCount: 24,
          textPanelStyleAllPages: TEXT_LAYOUT.panelStyle,
          textZoneAllPages: TEXT_LAYOUT.zone,
          supersedesPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
          noLuluAction: true,
        },
      },
    ],
    updatedAt: now,
  };

  const backupDir = path.join(process.cwd(), '.data', 'recovery-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${ORDER_ID}-pre-bottom-band-rebuild-${safeTs}.json`);

  console.log(JSON.stringify({ apply, orderId: ORDER_ID, proofLocal, interiorLocal, proofMd5, interiorMd5, proofUrl, interiorUrl, backupPath }, null, 2));
  if (!apply) {
    console.log('[rebuild-promote-lukas-bottom-band-proof] dry-run only; pass --apply to upload/persist.');
    return;
  }
  await writeFile(backupPath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  await persistOrder(updated);
  console.log('[rebuild-promote-lukas-bottom-band-proof] applied');
}

main().catch((err) => {
  console.error('[rebuild-promote-lukas-bottom-band-proof] failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
