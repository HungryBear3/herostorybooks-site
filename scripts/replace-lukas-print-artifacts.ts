// One-off recovery script for Lukas order validated PDF artifact replacement.
//
// Usage:
//   node --experimental-strip-types scripts/replace-lukas-print-artifacts.ts
//   node --experimental-strip-types scripts/replace-lukas-print-artifacts.ts --dry-run
//   node --experimental-strip-types scripts/replace-lukas-print-artifacts.ts --apply
//
// Default is dry-run. --apply is the only mode that writes to Vercel Blob or
// persists order metadata. This script intentionally does NOT submit to Lulu,
// pay Lulu, clear print-job state, regenerate images, regenerate story text, or
// touch checkout/Stripe/webhook flows.

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { put } from '@vercel/blob';

import {
  getBlobAccessMode,
  getOrder,
  persistOrder,
  withBlobNamespace,
  type OrderRecord,
} from '../src/lib/orders.ts';

const ORDER_ID = 'ord_f5dcffc8a0b84d06';
const OLD_PRINT_JOB_ID = '2857729';
const SOURCE_DIR =
  '/Users/abigailclaw/.openclaw/workspace/rex/briefings/hsb-lukas-proof-assets/fix-pass-2026-05-05-text-panel-rebuild';
const SCRIPT_NAME = 'scripts/replace-lukas-print-artifacts.ts';

const ARTIFACTS = [
  {
    key: 'proof',
    sourceFile: `${SOURCE_DIR}/lukas-targeted-fix-proof-local.pdf`,
    blobFilename: 'lukas-targeted-fix-proof-replacement.pdf',
    expectedMd5: '8bf0f3e4bfd8bcdc3b50523692423880',
    orderField: 'storyArtifactUrl',
  },
  {
    key: 'interior',
    sourceFile: `${SOURCE_DIR}/lukas-targeted-fix-interior-local.pdf`,
    blobFilename: 'lukas-targeted-fix-interior-replacement.pdf',
    expectedMd5: 'a251ff94f09db2d28d7bf181f9a8afdd',
    orderField: 'printInteriorArtifactUrl',
  },
  {
    key: 'cover',
    sourceFile: `${SOURCE_DIR}/lukas-targeted-fix-cover-local.pdf`,
    blobFilename: 'lukas-targeted-fix-cover-replacement.pdf',
    expectedMd5: '07bd65cd9ffa5e2b10e64a7a7bc417d3',
    orderField: 'printCoverArtifactUrl',
  },
] as const;

type Artifact = (typeof ARTIFACTS)[number];

type LoadedArtifact = Artifact & {
  buffer: Buffer;
  actualMd5: string;
  blobPath: string;
};

function md5Hex(buffer: Buffer): string {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function hasApplyFlag(): boolean {
  return process.argv.includes('--apply');
}

function printUsageAndExit(): never {
  console.error(
    'Usage: node --experimental-strip-types scripts/replace-lukas-print-artifacts.ts [--dry-run|--apply]',
  );
  process.exit(2);
}

function refuse(reason: string, detail?: string): never {
  console.error(`[replace-lukas-print-artifacts] REFUSED: ${reason}${detail ? ` (${detail})` : ''}`);
  process.exit(1);
}

function assertNoUnknownFlags() {
  const allowed = new Set(['--dry-run', '--apply']);
  const unknown = process.argv.slice(2).filter((arg) => arg.startsWith('--') && !allowed.has(arg));
  if (unknown.length > 0) printUsageAndExit();
  if (process.argv.includes('--apply') && process.argv.includes('--dry-run')) {
    refuse('conflicting_flags', 'Use either --apply or --dry-run, not both.');
  }
}

async function loadAndVerifyArtifacts(): Promise<LoadedArtifact[]> {
  const loaded: LoadedArtifact[] = [];
  for (const artifact of ARTIFACTS) {
    let buffer: Buffer;
    try {
      buffer = await readFile(artifact.sourceFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      refuse('local_artifact_missing', `${artifact.key}: ${artifact.sourceFile}: ${message}`);
    }

    const actualMd5 = md5Hex(buffer);
    if (actualMd5 !== artifact.expectedMd5) {
      refuse(
        'local_artifact_md5_mismatch',
        `${artifact.key}: expected ${artifact.expectedMd5}, got ${actualMd5}`,
      );
    }

    loaded.push({
      ...artifact,
      buffer,
      actualMd5,
      blobPath: withBlobNamespace(`orders/${ORDER_ID}/${artifact.blobFilename}`),
    });
  }
  return loaded;
}

function checkOrderSafety(order: OrderRecord | null) {
  if (!order) refuse('order_not_found', ORDER_ID);
  if (order.id !== ORDER_ID) refuse('unexpected_order_id', `expected ${ORDER_ID}, got ${order.id}`);
  if (order.paymentStatus !== 'paid') refuse('payment_not_paid', `paymentStatus=${order.paymentStatus}`);
  if (order.refundedAt) refuse('order_refunded', `refundedAt=${order.refundedAt}`);
  if (order.printJobId !== OLD_PRINT_JOB_ID) {
    refuse('unexpected_print_job_id', `expected ${OLD_PRINT_JOB_ID}, got ${order.printJobId ?? 'null'}`);
  }

  // Narrow recovery allowance: this order is already tied to the unpaid/old Lulu
  // job. We only allow the known in-production status observed during the Lukas
  // recovery; broader states would need a new script/review.
  if (order.status !== 'print_in_production') {
    refuse('unexpected_order_status', `status=${order.status}`);
  }
}

function buildPlan(artifacts: LoadedArtifact[], order: OrderRecord | null, apply: boolean) {
  return {
    orderId: ORDER_ID,
    oldPrintJobId: OLD_PRINT_JOB_ID,
    mode: apply ? 'apply' : 'dry-run',
    tokenPresent: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    blobAccessMode: getBlobAccessMode(),
    sourceDir: SOURCE_DIR,
    currentOrder: order
      ? {
          status: order.status,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: order.fulfillmentStatus ?? null,
          printJobId: order.printJobId ?? null,
          printJobStatus: order.printJobStatus ?? null,
          storyArtifactUrl: order.storyArtifactUrl ?? null,
          printInteriorArtifactUrl: order.printInteriorArtifactUrl ?? null,
          printInteriorMd5: order.printInteriorMd5 ?? null,
          printCoverArtifactUrl: order.printCoverArtifactUrl ?? null,
          printCoverMd5: order.printCoverMd5 ?? null,
        }
      : null,
    uploads: artifacts.map((artifact) => ({
      key: artifact.key,
      sourceFile: artifact.sourceFile,
      md5: artifact.actualMd5,
      blobPath: artifact.blobPath,
      stableFilename: artifact.blobFilename,
      allowOverwrite: true,
    })),
    metadataUpdates: {
      storyArtifactUrl: '<uploaded proof url>',
      printInteriorArtifactUrl: '<uploaded interior url>',
      printInteriorMd5: 'a251ff94f09db2d28d7bf181f9a8afdd',
      printCoverArtifactUrl: '<uploaded cover url>',
      printCoverMd5: '07bd65cd9ffa5e2b10e64a7a7bc417d3',
      auditEvent: {
        type: 'proof_rebuilt',
        reason: 'lukas_validated_artifact_replacement',
        oldPrintJobId: OLD_PRINT_JOB_ID,
      },
    },
    explicitlyNotModified: [
      'paymentStatus',
      'refundedAt',
      'stripeSessionId',
      'customer email/details',
      'shippingAddress',
      'pageArtifacts',
      'storyMeta/story data',
      'printJobId',
      'printJobStatus',
      'fulfillmentStatus',
    ],
    outOfScope: ['Lulu submission', 'Lulu payment', 'image generation', 'story generation', 'checkout/Stripe/webhooks'],
  };
}

async function uploadArtifact(artifact: LoadedArtifact, token: string): Promise<string> {
  const result = await put(artifact.blobPath, artifact.buffer, {
    access: getBlobAccessMode(),
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/pdf',
    token,
  });
  return result.url;
}

async function main() {
  assertNoUnknownFlags();

  const apply = hasApplyFlag();
  const artifacts = await loadAndVerifyArtifacts();
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  // Dry-run should be runnable on a local machine without accidentally falling
  // back to .data/orders and pretending production was checked. If a token is
  // present, include the live order snapshot and enforce the same safety checks.
  const order = token ? await getOrder(ORDER_ID) : null;
  if (order) checkOrderSafety(order);

  console.log('[replace-lukas-print-artifacts] PLAN');
  console.log(JSON.stringify(buildPlan(artifacts, order, apply), null, 2));

  if (!apply) {
    if (!token) {
      console.log(
        '[replace-lukas-print-artifacts] dry-run note — BLOB_READ_WRITE_TOKEN not set, so production order safety checks were not executed.',
      );
    }
    console.log('[replace-lukas-print-artifacts] dry-run — no changes persisted.');
    return;
  }

  if (!token) refuse('missing_blob_token', 'BLOB_READ_WRITE_TOKEN is required for --apply.');
  checkOrderSafety(order);

  const proofUrl = await uploadArtifact(artifacts.find((a) => a.key === 'proof')!, token);
  const interiorUrl = await uploadArtifact(artifacts.find((a) => a.key === 'interior')!, token);
  const coverUrl = await uploadArtifact(artifacts.find((a) => a.key === 'cover')!, token);

  const now = new Date().toISOString();
  const updated: OrderRecord = {
    ...order!,
    storyArtifactUrl: proofUrl,
    printInteriorArtifactUrl: interiorUrl,
    printInteriorMd5: 'a251ff94f09db2d28d7bf181f9a8afdd',
    printCoverArtifactUrl: coverUrl,
    printCoverMd5: '07bd65cd9ffa5e2b10e64a7a7bc417d3',
    updatedAt: now,
    auditEvents: [
      ...(order!.auditEvents ?? []),
      {
        at: now,
        type: 'proof_rebuilt',
        reason: 'lukas_validated_artifact_replacement',
        meta: {
          script: SCRIPT_NAME,
          oldPrintJobId: OLD_PRINT_JOB_ID,
          proofMd5: '8bf0f3e4bfd8bcdc3b50523692423880',
          printInteriorMd5: 'a251ff94f09db2d28d7bf181f9a8afdd',
          printCoverMd5: '07bd65cd9ffa5e2b10e64a7a7bc417d3',
          luluSubmitted: false,
          luluPaid: false,
        },
      },
    ],
  };

  await persistOrder(updated);

  console.log('[replace-lukas-print-artifacts] DONE');
  console.log(
    JSON.stringify(
      {
        orderId: ORDER_ID,
        oldPrintJobId: OLD_PRINT_JOB_ID,
        storyArtifactUrl: proofUrl,
        printInteriorArtifactUrl: interiorUrl,
        printInteriorMd5: updated.printInteriorMd5,
        printCoverArtifactUrl: coverUrl,
        printCoverMd5: updated.printCoverMd5,
        luluSubmitted: false,
        luluPaid: false,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error('[replace-lukas-print-artifacts] FAILED:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
