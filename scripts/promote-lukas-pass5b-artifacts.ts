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
const PASS_DIR = '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/rebuild-pass5b-2026-05-05T20-41-08-008Z';

const PDF_ARTIFACTS = {
  proof: {
    file: 'lukas-pass5b-proof-local.pdf',
    blobName: 'lukas-pass5b-proof-2026-05-05-canonical.pdf',
    expectedMd5: '202b530084fbc6a09e9b607a3ed88c94',
    orderField: 'storyArtifactUrl' as const,
  },
  interior: {
    file: 'lukas-pass5b-interior-local.pdf',
    blobName: 'lukas-pass5b-interior-2026-05-05-canonical.pdf',
    expectedMd5: 'b01ca7f9593cc62a0813bca487e737fe',
    orderField: 'printInteriorArtifactUrl' as const,
    md5Field: 'printInteriorMd5' as const,
  },
  cover: {
    file: 'lukas-pass5b-cover-local.pdf',
    blobName: 'lukas-pass5b-cover-2026-05-05-canonical.pdf',
    expectedMd5: '7397abab97aeb41d15f74e8d054fe577',
    orderField: 'printCoverArtifactUrl' as const,
    md5Field: 'printCoverMd5' as const,
  },
};

const IMAGE_SUBSTITUTIONS: Record<number, { file: string; expectedMd5: string; label: string }> = {
  5: {
    file: '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/rescue-2026-05-05T16-02-16-523Z/p6-remove-top-left-child-artifact.png',
    expectedMd5: 'f5e0c56d95c2352926bcc7565629b131',
    label: 'p6-remove-top-left-child-artifact',
  },
  7: {
    file: '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/rescue-pass2-2026-05-05T16-31-55-510Z/p8-remove-background-glyph.png',
    expectedMd5: '321600b43d448cb8cfedd291bc89c892',
    label: 'p8-remove-background-glyph',
  },
  15: {
    file: '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/polish-pass-2026-05-05T17-50-29-553Z/p16-rope-bridge-house-style.png',
    expectedMd5: 'af947eb3d9f2c390e3b251808a90f32e',
    label: 'p16-rope-bridge-house-style',
  },
  17: {
    file: '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/polish-pass5-2026-05-05T19-52-31-658Z/p18-house-style-v2.png',
    expectedMd5: '0f56797d12f0d497d4de43363bb50f75',
    label: 'p18-house-style-v2',
  },
  22: {
    file: '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/polish-pass5-2026-05-05T19-52-31-658Z/p23-house-style-v2.png',
    expectedMd5: '4fa320f3ef663b27531fdd6e9ed8ee4e',
    label: 'p23-house-style-v2',
  },
  23: {
    file: '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/polish-pass5-2026-05-05T19-52-31-658Z/p24-bedroom-v2.png',
    expectedMd5: '111aa160dd75768087b40fa7165d8634',
    label: 'p24-bedroom-v2',
  },
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

function withPageReplacement(page: PageArtifact, imageUrlByIndex: Map<number, string>): PageArtifact {
  const replacement = imageUrlByIndex.get(page.pageIndex);
  const versionHistory = [...(page.versionHistory ?? [])];
  if (replacement) {
    versionHistory.push({
      createdAt: new Date().toISOString(),
      imageUrl: replacement,
      provider: page.generationProvider ?? 'fal_edit',
      model: 'canonical-pass5b-local-polish',
      promptUsed: `Promoted canonical pass5b replacement for review/PDF parity on page ${page.pageIndex + 1}`,
      conditioning: page.generationConditioning ?? 'photo_edit',
      referencePhotoUrl: null,
    });
  }
  return {
    ...page,
    currentImageUrl: replacement ?? page.currentImageUrl,
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

  const pdfs: Record<string, { url: string; digest: string }> = {};
  for (const [key, spec] of Object.entries(PDF_ARTIFACTS)) {
    const { buffer, digest } = await readChecked(path.join(PASS_DIR, spec.file), spec.expectedMd5);
    const url = await putBlob(`orders/${ORDER_ID}/${spec.blobName}`, buffer, 'application/pdf', apply, token);
    pdfs[key] = { url, digest };
  }

  const imageUrlByIndex = new Map<number, string>();
  const imageMeta: Record<string, string> = {};
  for (const [idxText, spec] of Object.entries(IMAGE_SUBSTITUTIONS)) {
    const pageIndex = Number(idxText);
    const { buffer, digest } = await readChecked(spec.file, spec.expectedMd5);
    const url = await putBlob(
      `orders/${ORDER_ID}/canonical-pass5b/page-${String(pageIndex + 1).padStart(2, '0')}-${spec.label}.png`,
      buffer,
      'image/png',
      apply,
      token,
    );
    imageUrlByIndex.set(pageIndex, url);
    imageMeta[`page_${pageIndex + 1}`] = url;
    imageMeta[`page_${pageIndex + 1}_md5`] = digest;
  }

  const now = new Date().toISOString();
  const updated: OrderRecord = {
    ...order,
    storyArtifactUrl: pdfs.proof.url,
    printInteriorArtifactUrl: pdfs.interior.url,
    printInteriorMd5: pdfs.interior.digest,
    printCoverArtifactUrl: pdfs.cover.url,
    printCoverMd5: pdfs.cover.digest,
    proofReviewedAt: null,
    reviewStatus: 'in_review',
    pageArtifacts: order.pageArtifacts.map((p) => withPageReplacement(p, imageUrlByIndex)),
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'promote_lukas_pass5b_canonical_review_sync',
        meta: {
          proofUrl: pdfs.proof.url,
          interiorUrl: pdfs.interior.url,
          coverUrl: pdfs.cover.url,
          proofMd5: pdfs.proof.digest,
          interiorMd5: pdfs.interior.digest,
          coverMd5: pdfs.cover.digest,
          pageArtifactCount: order.pageArtifacts.length,
          syncedReplacementPages: Object.keys(IMAGE_SUBSTITUTIONS).map((i) => String(Number(i) + 1)).join(','),
          textPanelStyleAllPages: ALL_PAGE_TEXT_LAYOUT.panelStyle,
          textZoneAllPages: ALL_PAGE_TEXT_LAYOUT.zone,
          supersedesPrintJobId: EXPECTED_EXISTING_PRINT_JOB_ID,
          ...imageMeta,
        },
      },
    ],
    updatedAt: now,
  };

  const backupDir = path.join(process.cwd(), '.data', 'recovery-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${ORDER_ID}-pass5b-promote-${now.replace(/[:.]/g, '-')}.json`);

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
      replacedPageUrls: Object.fromEntries(Object.keys(IMAGE_SUBSTITUTIONS).map((idx) => {
        const page = order.pageArtifacts?.find((p) => p.pageIndex === Number(idx));
        return [String(Number(idx) + 1), page?.currentImageUrl ?? null];
      })),
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
      replacedPageUrls: Object.fromEntries([...imageUrlByIndex.entries()].map(([idx, url]) => [String(idx + 1), url])),
    },
    backupPath,
  }, null, 2));

  if (!apply) {
    console.log('[promote-lukas-pass5b-artifacts] dry-run only; pass --apply to upload and persist.');
    return;
  }

  await writeFile(backupPath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  await persistOrder(updated);
  console.log('[promote-lukas-pass5b-artifacts] applied');
}

main().catch((error) => {
  console.error('[promote-lukas-pass5b-artifacts] failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
