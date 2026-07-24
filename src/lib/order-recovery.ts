// Order recovery helpers.
//
// Used by scripts/recover-orders.ts to manually reconstruct paid orders that
// never landed in the order store (e.g., post-payment crash). Writes records
// in the current OrderRecord shape so the existing status/review/fulfillment
// flows pick them up unchanged.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { put } from '@vercel/blob';

import {
  createOrderRecord,
  getBlobAccessMode,
  getOrder,
  persistOrder,
  withBlobNamespace,
  type OrderInput,
  type OrderRecord,
  type ShippingAddress,
} from './orders.ts';

export interface RecoveryInput extends OrderInput {
  /** REQUIRED — must match the original order id from Stripe metadata / receipts. */
  id: string;
  /** ISO timestamp; defaults to now. */
  now?: string;
  /** Stripe checkout session id from the original purchase, if known. */
  stripeSessionId?: string | null;
  /** Required for print orders that should reach fulfillment + ship. */
  shippingAddress?: ShippingAddress | null;
  /** Optional local file path; uploaded to blob storage during recovery. */
  photoFilePath?: string | null;
}

export interface RecoverySummary {
  orderId: string;
  childName: string;
  bookFormat: string;
  paymentStatus: 'paid';
  photoBlobPath: string | null;
  photoFileName: string | null;
  shippingPersisted: boolean;
  stripeSessionId: string | null;
  warnings: string[];
}

/**
 * Pure builder. Produces a recovery-ready OrderRecord:
 * - exact `id` preserved
 * - paymentStatus forced to 'paid'
 * - optional stripeSessionId / shippingAddress / photo refs flow through
 *
 * No I/O. Safe to call from tests without a tmp dir.
 */
export function buildRecoveryOrderRecord(input: RecoveryInput): OrderRecord {
  // Recovery reconstructs manual-path orders — explicit manual_hold (fail closed;
  // no auto workflow exists). Not inferred; preserved by the spread below.
  const base = createOrderRecord(input, { id: input.id, now: input.now, fulfillmentMode: 'manual_hold' });
  return {
    ...base,
    paymentStatus: 'paid',
    stripeSessionId: input.stripeSessionId ?? null,
    shippingAddress: input.shippingAddress ?? null,
    photoBlobPath: input.photoBlobPath ?? base.photoBlobPath ?? null,
    photoBlobUrl: input.photoBlobUrl ?? base.photoBlobUrl ?? null,
    photoFileName: input.photoFileName ?? base.photoFileName ?? null,
  };
}

function contentTypeForFilename(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
  return 'image/jpeg';
}

/**
 * Upload a local photo file to the same private blob path the order store uses.
 * Returns the resulting blob pathname (matches OrderRecord.photoBlobPath shape).
 * If BLOB_READ_WRITE_TOKEN is unset, returns a warning instead of throwing —
 * the recovery script can still persist the order; the photo is wired manually.
 */
export async function uploadOrderPhotoFromPath(
  orderId: string,
  filePath: string,
): Promise<{ photoBlobPath: string | null; photoBlobUrl: string | null; photoFileName: string; warning?: string }> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const buffer = await readFile(filePath);
  const safeName =
    path.basename(filePath).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
  const pathname = withBlobNamespace(`orders/${orderId}/photo-${safeName}`);

  if (!token) {
    return {
      photoBlobPath: null,
      photoBlobUrl: null,
      photoFileName: safeName,
      warning:
        'BLOB_READ_WRITE_TOKEN not set — photo NOT uploaded. Re-run with token, or set OrderRecord.photoBlobPath manually.',
    };
  }

  const blob = await put(pathname, buffer, {
    access: getBlobAccessMode(),
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: contentTypeForFilename(safeName),
    token,
  });

  return { photoBlobPath: blob.pathname, photoBlobUrl: blob.url, photoFileName: safeName };
}

/**
 * Full recovery: optionally upload photo, build record, persist, return summary.
 * Compatible with /status/[orderId], future fulfillment trigger, and the
 * review flow once fulfillment generates pageArtifacts.
 */
export async function recoverOrder(input: RecoveryInput): Promise<RecoverySummary> {
  // Recovery reconstructs records that are missing from the order store. Refuse
  // an existing id before uploading a photo or writing anything: rerunning a
  // recovery must never replace an existing order (including its routing intent).
  const existing = await getOrder(input.id);
  if (existing) {
    throw new Error(
      `order ${input.id} already exists; recovery refuses to overwrite existing records`,
    );
  }

  const warnings: string[] = [];
  let photoBlobPath = input.photoBlobPath ?? null;
  let photoBlobUrl = input.photoBlobUrl ?? null;
  let photoFileName = input.photoFileName ?? null;

  if (input.photoFilePath) {
    try {
      const r = await uploadOrderPhotoFromPath(input.id, input.photoFilePath);
      if (r.photoBlobPath) photoBlobPath = r.photoBlobPath;
      if (r.photoBlobUrl) photoBlobUrl = r.photoBlobUrl;
      if (r.photoFileName) photoFileName = r.photoFileName;
      if (r.warning) warnings.push(r.warning);
    } catch (err) {
      warnings.push(
        `photo upload failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const record = buildRecoveryOrderRecord({
    ...input,
    photoBlobPath,
    photoBlobUrl,
    photoFileName,
  });

  if (record.bookFormat !== 'digital' && !record.shippingAddress) {
    warnings.push(
      'print order has no shippingAddress — fulfillment will fail until shippingAddress is set',
    );
  }
  if (!record.stripeSessionId) {
    warnings.push(
      'no stripeSessionId — webhook idempotency check will not match; this is fine for recovery, but record manually if you have it',
    );
  }

  await persistOrder(record);

  return {
    orderId: record.id,
    childName: record.childName,
    bookFormat: record.bookFormat,
    paymentStatus: 'paid',
    photoBlobPath,
    photoFileName,
    shippingPersisted: Boolean(record.shippingAddress),
    stripeSessionId: record.stripeSessionId ?? null,
    warnings,
  };
}

export function formatRecoverySummary(summary: RecoverySummary): string {
  const lines = [
    `• ${summary.orderId}`,
    `  child:           ${summary.childName}`,
    `  bookFormat:      ${summary.bookFormat}`,
    `  paymentStatus:   ${summary.paymentStatus}`,
    `  photoBlobPath:   ${summary.photoBlobPath ?? '(none)'}`,
    `  photoFileName:   ${summary.photoFileName ?? '(none)'}`,
    `  shipping:        ${summary.shippingPersisted ? 'persisted' : 'NOT set'}`,
    `  stripeSessionId: ${summary.stripeSessionId ?? '(none)'}`,
  ];
  if (summary.warnings.length > 0) {
    lines.push('  warnings:');
    for (const w of summary.warnings) lines.push(`    - ${w}`);
  }
  return lines.join('\n');
}
