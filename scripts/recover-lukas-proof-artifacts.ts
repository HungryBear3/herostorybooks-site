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
} from '../src/lib/orders.ts';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';
const EXPECTED_OLD_PRINT_JOB_ID = '2857729';
const PACKET_DIR = '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/fix-pass-2026-05-05-text-panel-rebuild';

const ARTIFACTS = {
  proof: {
    file: 'lukas-targeted-fix-proof-local.pdf',
    blobName: 'lukas-targeted-fix-proof-2026-05-05-text-panel-rebuild.pdf',
    expectedMd5: '8bf0f3e4bfd8bcdc3b50523692423880',
    orderField: 'storyArtifactUrl' as const,
  },
  interior: {
    file: 'lukas-targeted-fix-interior-local.pdf',
    blobName: 'lukas-targeted-fix-interior-2026-05-05-text-panel-rebuild.pdf',
    expectedMd5: 'a251ff94f09db2d28d7bf181f9a8afdd',
    orderField: 'printInteriorArtifactUrl' as const,
    md5Field: 'printInteriorMd5' as const,
  },
  cover: {
    file: 'lukas-targeted-fix-cover-local.pdf',
    blobName: 'lukas-targeted-fix-cover-2026-05-05-text-panel-rebuild.pdf',
    expectedMd5: '07bd65cd9ffa5e2b10e64a7a7bc417d3',
    orderField: 'printCoverArtifactUrl' as const,
    md5Field: 'printCoverMd5' as const,
  },
};

function md5(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function requireApplyFlag(): boolean {
  return process.argv.includes('--apply');
}

async function loadArtifact(name: keyof typeof ARTIFACTS) {
  const spec = ARTIFACTS[name];
  const buffer = await readFile(path.join(PACKET_DIR, spec.file));
  const digest = md5(buffer);
  if (digest !== spec.expectedMd5) {
    throw new Error(`${name} md5 mismatch: expected ${spec.expectedMd5}, got ${digest}`);
  }
  return { spec, buffer, digest };
}

async function main() {
  const apply = requireApplyFlag();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required');

  const order = await getOrder(ORDER_ID);
  if (!order) throw new Error(`Order not found: ${ORDER_ID}`);
  if (order.id !== ORDER_ID) throw new Error(`Refusing unexpected order id ${order.id}`);
  if (order.printJobId !== EXPECTED_OLD_PRINT_JOB_ID) {
    throw new Error(`Refusing: expected old printJobId=${EXPECTED_OLD_PRINT_JOB_ID}, got ${order.printJobId ?? 'null'}`);
  }

  const loaded = {
    proof: await loadArtifact('proof'),
    interior: await loadArtifact('interior'),
    cover: await loadArtifact('cover'),
  };

  const urls: Record<string, string> = {};
  for (const [name, { spec, buffer }] of Object.entries(loaded)) {
    const pathname = withBlobNamespace(`orders/${ORDER_ID}/${spec.blobName}`);
    if (apply) {
      const blob = await put(pathname, buffer, {
        access: getBlobAccessMode(),
        contentType: 'application/pdf',
        addRandomSuffix: false,
        allowOverwrite: true,
        token,
      });
      urls[name] = blob.url;
    } else {
      urls[name] = `[dry-run] ${pathname}`;
    }
  }

  const now = new Date().toISOString();
  const updated: OrderRecord = {
    ...order,
    storyArtifactUrl: urls.proof,
    printInteriorArtifactUrl: urls.interior,
    printInteriorMd5: loaded.interior.digest,
    printCoverArtifactUrl: urls.cover,
    printCoverMd5: loaded.cover.digest,
    proofReviewedAt: null,
    reviewStatus: order.reviewStatus === 'approved' ? 'in_review' : (order.reviewStatus ?? 'in_review'),
    auditEvents: [
      ...(order.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'recover_lukas_text_panel_rebuild_artifacts',
        meta: {
          proofUrl: urls.proof,
          interiorUrl: urls.interior,
          coverUrl: urls.cover,
          proofMd5: loaded.proof.digest,
          interiorMd5: loaded.interior.digest,
          coverMd5: loaded.cover.digest,
          supersedesPrintJobId: EXPECTED_OLD_PRINT_JOB_ID,
        },
      },
    ],
    updatedAt: now,
  };

  const backupDir = path.join(process.cwd(), '.data', 'recovery-backups');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${ORDER_ID}-${now.replace(/[:.]/g, '-')}.json`);

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
    },
    backupPath,
  }, null, 2));

  if (!apply) {
    console.log('[recover-lukas-proof-artifacts] dry-run only; pass --apply to upload and persist.');
    return;
  }

  await writeFile(backupPath, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  await persistOrder(updated);
  console.log('[recover-lukas-proof-artifacts] applied');
}

main().catch((error) => {
  console.error('[recover-lukas-proof-artifacts] failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
