import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { put } from '@vercel/blob';

import {
  getBlobAccessMode,
  getOrder,
  persistOrder,
  withBlobNamespace,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';
import type { PageTextLayout } from '../src/lib/fulfillment-types.ts';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';
const EXPECTED_EXISTING_PRINT_JOB_ID = '2857729';
const PASS_DIR = '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/rebuild-page24-window-fix-2026-05-06T17-26-03-859Z';

const PDF_ARTIFACTS = {
  proof: {
    file: 'lukas-page24-window-fix-proof-local.pdf',
    blobName: 'lukas-page24-window-fix-proof-2026-05-06-canonical.pdf',
    expectedMd5: '16f154743f3a02943c143fcb93bd86cd',
    orderField: 'storyArtifactUrl' as const,
  },
  interior: {
    file: 'lukas-page24-window-fix-interior-local.pdf',
    blobName: 'lukas-page24-window-fix-interior-2026-05-06-canonical.pdf',
    expectedMd5: '89a675426a27df70c335c0bf36c728a1',
    orderField: 'printInteriorArtifactUrl' as const,
    md5Field: 'printInteriorMd5' as const,
  },
};

const PAGE_24_REPLACEMENT = {
  pageIndex: 23,
  file: '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/polish-pass-2026-05-05T17-50-29-553Z/p24-bedroom-cozy-house-style.png',
  expectedMd5: '18fbb6dc5f478c397b488184439d7e61',
  label: 'p24-bedroom-cozy-house-style',
  replacesMd5: '111aa160dd75768087b40fa7165d8634',
};

const ALL_PAGE_TEXT_LAYOUT: PageTextLayout = {
  zone: 'natural',
  colorMode: 'auto',
  panelStyle: 'translucent_cream',
};

function md5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function requireApplyFlag(): boolean {
  return process.argv.includes('--apply');
}

async function readChecked(file: string, expectedMd5: string) {
  const buffer = await readFile(file);
  const digest = md5(buffer);
  if (digest !== expectedMd5) {
    throw new Error(`${file} md5 mismatch: expected ${expectedMd5}, got ${digest}`);
  }
  return { buffer, digest };
}

async function putBlob(pathname: string, buffer: Buffer, contentType: string, apply: boolean, token: string) {
  const blobPath = withBlobNamespace(pathname);
  if (!apply) return `[dry-run] ${blobPath}`;
  const blob = await put(blobPath, buffer, {
    access: getBlobAccessMode(),
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    token,
  });
  return blob.url;
}

function updatePageArtifact(page: PageArtifact, replacementUrl: string, now: string): PageArtifact {
  const existingHistory = page.versionHistory ?? [];
  const alreadyCurrent = page.currentImageUrl === replacementUrl;
  const versionHistory = alreadyCurrent
    ? existingHistory
    : [
        ...existingHistory,
        {
          createdAt: now,
          imageUrl: replacementUrl,
          provider: page.generationProvider ?? 'fal_edit',
          model: 'canonical-page24-window-fix-local-polish',
          promptUsed: 'Promoted page 24 window-fix candidate to remove moon/wall artifact while preserving review/PDF parity',
          conditioning: page.generationConditioning ?? 'photo_edit',
          referencePhotoUrl: null,
        },
      ];

  return {
    ...page,
    currentImageUrl: replacementUrl,
    acceptedImageUrl: null,
    accepted: false,
    textLayout: ALL_PAGE_TEXT_LAYOUT,
    versionHistory,
  } as PageArtifact & { textLayout: PageTextLayout };
}

async function main() {
  const apply = requireApplyFlag();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');

  const order = await getOrder(ORDER_ID);
  if (!order) throw new Error(`Order not found: ${ORDER_ID}`);
  if (order.id !== ORDER_ID) throw new Error(`Refusing unexpected order id ${order.id}`);
  if (order.printJobId !== EXPECTED_EXISTING_PRINT_JOB_ID) {
    throw new Error(`Refusing: expected existing printJobId=${EXPECTED_EXISTING_PRINT_JOB_ID}, got ${order.printJobId ?? 'null'}`);
  }
  if (!order.pageArtifacts || order.pageArtifacts.length !== 24) {
    throw new Error(`Refusing: expected 24 pageArtifacts, got ${order.pageArtifacts?.length ?? 0}`);
  }
  const oldPage24 = order.pageArtifacts.find((p) => p.pageIndex === PAGE_24_REPLACEMENT.pageIndex);
  if (!oldPage24) throw new Error('Refusing: page 24 artifact not found');

  const pdfs: Record<string, { url: string; digest: string }> = {};
  for (const [key, spec] of Object.entries(PDF_ARTIFACTS)) {
    const { buffer, digest } = await readChecked(path.join(PASS_DIR, spec.file), spec.expectedMd5);
    const url = await putBlob(`orders/${ORDER_ID}/${spec.blobName}`, buffer, 'application/pdf', apply, token);
    pdfs[key] = { url, digest };
  }

  const { buffer: page24Buffer, digest: page24Digest } = await readChecked(PAGE_24_REPLACEMENT.file, PAGE_24_REPLACEMENT.expectedMd5);
  const page24Url = await putBlob(
    `orders/${ORDER_ID}/canonical-page24-window-fix/page-24-${PAGE_24_REPLACEMENT.label}.png`,
    page24Buffer,
    'image/png',
    apply,
    token,
  );

  const now = new Date().toISOString();
  const updated: OrderRecord = {
    ...order,
    storyArtifactUrl: pdfs.proof.url,
    printInteriorArtifactUrl: pdfs.interior.url,
    printInteriorMd5: pdfs.interior.digest,
    // Cover is unchanged from pass5b; only proof/interior include page 24.
    proofReviewedAt: null,
    reviewStatus: 'in_review',
    pageArtifacts: order.pageArtifacts.map((p) =>
      p.pageIndex === PAGE_24_REPLACEMENT.pageIndex
        ? updatePageArtifact(p, page24Url, now)
        : { ...p, textLayout: p.textLayout ?? ALL_PAGE_TEXT_LAYOUT },
    ),
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'promote_lukas_page24_window_fix_review_sync',
        meta: {
          proofUrl: pdfs.proof.url,
          interiorUrl: pdfs.interior.url,
          coverUrl: order.printCoverArtifactUrl ?? null,
          proofMd5: pdfs.proof.digest,
          interiorMd5: pdfs.interior.digest,
          coverMd5: order.printCoverMd5 ?? null,
          pageArtifactCount: order.pageArtifacts.length,
          syncedReplacementPages: '24',
          textPanelStyleAllPages: ALL_PAGE_TEXT_LAYOUT.panelStyle,
          textZoneAllPages: ALL_PAGE_TEXT_LAYOUT.zone,
          supersedesPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
          page_24: page24Url,
          page_24_md5: page24Digest,
          page_24_replaces_md5: PAGE_24_REPLACEMENT.replacesMd5,
        },
      },
    ],
    updatedAt: now,
  };

  const backupDir = path.join(process.cwd(), '.data', 'recovery-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${ORDER_ID}-page24-window-fix-${now.replace(/[:.]/g, '-')}.json`);

  console.log(JSON.stringify({
    apply,
    orderId: ORDER_ID,
    old: {
      storyArtifactUrl: order.storyArtifactUrl,
      printInteriorArtifactUrl: order.printInteriorArtifactUrl,
      printInteriorMd5: order.printInteriorMd5,
      printCoverArtifactUrl: order.printCoverArtifactUrl,
      printCoverMd5: order.printCoverMd5,
      reviewStatus: order.reviewStatus,
      proofReviewedAt: order.proofReviewedAt,
      printJobId: order.printJobId,
      page24Url: oldPage24.currentImageUrl,
    },
    next: {
      storyArtifactUrl: updated.storyArtifactUrl,
      printInteriorArtifactUrl: updated.printInteriorArtifactUrl,
      printInteriorMd5: updated.printInteriorMd5,
      printCoverArtifactUrl: updated.printCoverArtifactUrl,
      printCoverMd5: updated.printCoverMd5,
      reviewStatus: updated.reviewStatus,
      proofReviewedAt: updated.proofReviewedAt,
      printJobId: updated.printJobId,
      page24Url,
      page24Md5: page24Digest,
    },
    backupPath,
  }, null, 2));

  if (!apply) {
    console.log('[promote-lukas-page24-window-fix] dry-run only; pass --apply to upload and persist.');
    return;
  }

  await writeFile(backupPath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  await persistOrder(updated);
  console.log('[promote-lukas-page24-window-fix] applied');
}

main().catch((error) => {
  console.error('[promote-lukas-page24-window-fix] failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
