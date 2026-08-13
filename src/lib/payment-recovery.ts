import { mkdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { BlobNotFoundError, get, put } from '@vercel/blob';

import { getBlobAccessMode, withBlobNamespace } from './orders.ts';

export interface PaymentRecoveryRecord {
  stripeSessionId: string;
  claimedOrderId: string | null;
  amountSubtotalCents: number | null;
  amountTotalCents: number | null;
  reason: 'missing_order_identity' | 'order_not_found';
  firstSeenAt: string;
  lastSeenAt: string;
  deliveryCount: number;
}

function safeSessionKey(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

function blobPath(sessionId: string): string {
  return withBlobNamespace(`payment-recovery/${safeSessionKey(sessionId)}.json`);
}

function localPath(sessionId: string): string {
  const root = process.env.HSB_PAYMENT_RECOVERY_STORE_DIR
    ?? (process.env.VERCEL ? '/tmp/hsb/payment-recovery' : '.data/payment-recovery');
  return `${root}/${safeSessionKey(sessionId)}.json`;
}

function requiresDurablePersistence(): boolean {
  return process.env.HSB_REQUIRE_DURABLE_PERSISTENCE === 'true'
    || process.env.NODE_ENV === 'production'
    || Boolean(process.env.VERCEL);
}

async function readExisting(sessionId: string): Promise<PaymentRecoveryRecord | null> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    try {
      const result = await get(blobPath(sessionId), {
        access: getBlobAccessMode(),
        token,
        useCache: false,
      });
      if (!result?.stream) return null;
      return JSON.parse(await new Response(result.stream).text()) as PaymentRecoveryRecord;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (error instanceof BlobNotFoundError || status === 404) return null;
      throw error;
    }
  }
  if (requiresDurablePersistence()) {
    throw new Error('durable_payment_recovery_unavailable');
  }
  try {
    return JSON.parse(await readFile(localPath(sessionId), 'utf8')) as PaymentRecoveryRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function recordUnmatchedPaymentSettlement(input: {
  stripeSessionId: string;
  claimedOrderId: string | null;
  amountSubtotalCents: number | null;
  amountTotalCents: number | null;
  reason: PaymentRecoveryRecord['reason'];
  now?: string;
}): Promise<PaymentRecoveryRecord> {
  const now = input.now ?? new Date().toISOString();
  const existing = await readExisting(input.stripeSessionId);
  const record: PaymentRecoveryRecord = existing
    ? {
        ...existing,
        claimedOrderId: existing.claimedOrderId ?? input.claimedOrderId,
        amountSubtotalCents: existing.amountSubtotalCents ?? input.amountSubtotalCents,
        amountTotalCents: existing.amountTotalCents ?? input.amountTotalCents,
        lastSeenAt: now,
        deliveryCount: existing.deliveryCount + 1,
      }
    : {
        stripeSessionId: input.stripeSessionId,
        claimedOrderId: input.claimedOrderId,
        amountSubtotalCents: input.amountSubtotalCents,
        amountTotalCents: input.amountTotalCents,
        reason: input.reason,
        firstSeenAt: now,
        lastSeenAt: now,
        deliveryCount: 1,
      };

  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    await put(blobPath(input.stripeSessionId), serialized, {
      access: getBlobAccessMode(),
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: 'application/json',
      token,
    });
    return record;
  }
  if (requiresDurablePersistence()) {
    throw new Error('durable_payment_recovery_unavailable');
  }
  const path = localPath(input.stripeSessionId);
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await writeFile(path, serialized, 'utf8');
  return record;
}
