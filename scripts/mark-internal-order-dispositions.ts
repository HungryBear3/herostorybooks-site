// Mark stale/internal HSB orders with an internal-only disposition.
//
// Safety boundaries:
// - Does not issue refunds.
// - Does not call Stripe/Lulu.
// - Does not change paymentStatus, Stripe session ids, print job ids, artifacts, or print state.
// - Writes a timestamped JSON backup before mutating any order.
//
// Usage:
//   set -a; . .vercel/.env.production.latest; set +a
//   node --experimental-strip-types scripts/mark-internal-order-dispositions.ts --apply

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listOrders, updateFulfillmentState } from '../src/lib/orders.ts';
import type { InternalOrderDisposition, OrderRecord, ReviewAuditEvent } from '../src/lib/orders.ts';

const IMPORTANT_UNTOUCHED = new Set([
  'ord_bf353ac3d5184062',
  'ord_f5dcffc8a0b84d06',
]);

const PAID_SUPERSEDED = new Set([
  'ord_060cd476d0a94aaf',
  'ord_09f2391715a14bc3',
]);

const BACKUP_ROOT = '/Users/abigailclaw/.openclaw/workspace/hsb-order-cleanup-backups';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function hasNoArtifacts(order: OrderRecord) {
  return !order.stripeSessionId
    && !(order.pageArtifacts?.length)
    && !order.storyArtifactUrl
    && !order.printInteriorArtifactUrl
    && !order.printCoverArtifactUrl
    && !order.printJobId;
}

function dispositionFor(order: OrderRecord): { disposition: InternalOrderDisposition; note: string } | null {
  if (IMPORTANT_UNTOUCHED.has(order.id)) return null;

  if (PAID_SUPERSEDED.has(order.id)) {
    if (order.paymentStatus !== 'paid') throw new Error(`${order.id} expected paid before superseded mark`);
    if (order.internalDisposition === 'superseded_internal_smoke') return null;
    return {
      disposition: 'superseded_internal_smoke',
      note: 'Paid internal classic proof/smoke artifact superseded by newer print evidence; payment/proof/artifact/print state intentionally preserved.',
    };
  }

  if (order.paymentStatus === 'pending' && order.status === 'order_received' && hasNoArtifacts(order)) {
    if (order.internalDisposition === 'abandoned_internal_test') return null;
    return {
      disposition: 'abandoned_internal_test',
      note: 'Abandoned internal checkout/test artifact; no Stripe session, no artifacts, no customer liability.',
    };
  }

  return null;
}

function summarize(order: OrderRecord) {
  return {
    id: order.id,
    bookFormat: order.bookFormat,
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus ?? null,
    internalDisposition: order.internalDisposition ?? null,
    stripeSessionId: order.stripeSessionId ?? null,
    pageArtifactCount: order.pageArtifacts?.length ?? 0,
    hasStoryArtifact: Boolean(order.storyArtifactUrl),
    hasPrintInterior: Boolean(order.printInteriorArtifactUrl),
    hasPrintCover: Boolean(order.printCoverArtifactUrl),
    printJobId: order.printJobId ?? null,
    auditEventCount: order.auditEvents?.length ?? 0,
    updatedAt: order.updatedAt,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const orders = await listOrders();
  const candidates = orders
    .map((order) => ({ order, target: dispositionFor(order) }))
    .filter((entry): entry is { order: OrderRecord; target: NonNullable<ReturnType<typeof dispositionFor>> } => Boolean(entry.target))
    .sort((a, b) => a.order.createdAt.localeCompare(b.order.createdAt));

  const runStamp = stamp();
  const backupDir = path.join(BACKUP_ROOT, runStamp);

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', candidateCount: candidates.length, backupDir: apply ? backupDir : null }, null, 2));
  for (const { order, target } of candidates) {
    console.log(JSON.stringify({ before: summarize(order), target }, null, 2));
  }

  if (!apply) return;

  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), candidates: candidates.map(({ order, target }) => ({ id: order.id, target, before: summarize(order) })) }, null, 2) + '\n', 'utf8');

  const changed = [];
  for (const { order, target } of candidates) {
    await writeFile(path.join(backupDir, `${order.id}.json`), JSON.stringify(order, null, 2) + '\n', 'utf8');

    const event: ReviewAuditEvent = {
      at: new Date().toISOString(),
      type: 'internal_disposition_marked',
      reason: target.disposition,
      meta: {
        note: target.note,
        previousInternalDisposition: order.internalDisposition ?? null,
        preservedPaymentStatus: order.paymentStatus,
        preservedStatus: order.status,
        preservedFulfillmentStatus: order.fulfillmentStatus ?? null,
        preservedStripeSessionId: order.stripeSessionId ?? null,
        preservedPrintJobId: order.printJobId ?? null,
      },
    };

    const updated = await updateFulfillmentState(order.id, {
      internalDisposition: target.disposition,
      internalDispositionNote: target.note,
      internalDispositionAt: event.at,
      auditEvents: [...(order.auditEvents ?? []), event],
    });
    if (!updated) throw new Error(`Failed to update ${order.id}`);
    changed.push({ id: order.id, changedFields: ['internalDisposition', 'internalDispositionNote', 'internalDispositionAt', 'auditEvents', 'updatedAt'], after: summarize(updated) });
  }

  console.log(JSON.stringify({ backupDir, changed }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
