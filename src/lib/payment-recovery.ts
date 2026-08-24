import { mkdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { BlobNotFoundError, get, put } from '@vercel/blob';

import {
  getBlobAccessMode,
  listOrdersAuthoritative,
  recordStripeTerminalPaymentState,
  withBlobNamespace,
  type StripeTerminalPaymentEventType,
} from './orders.ts';

export interface PaymentRecoveryRecord {
  stripeSessionId: string;
  claimedOrderId: string | null;
  amountSubtotalCents: number | null;
  amountTotalCents: number | null;
  reason:
    | 'missing_order_identity'
    | 'order_not_found'
    | 'terminal_event_missing_identity'
    | 'terminal_event_order_not_found'
    | 'terminal_event_identity_mismatch'
    | 'terminal_event_invalid_refund_amount';
  stripeEventId?: string | null;
  stripeEventType?: StripeTerminalPaymentEventType | null;
  providerObjectId?: string | null;
  paymentIntentId?: string | null;
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
  stripeEventId?: string | null;
  stripeEventType?: StripeTerminalPaymentEventType | null;
  providerObjectId?: string | null;
  paymentIntentId?: string | null;
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
        stripeEventId: existing.stripeEventId ?? input.stripeEventId ?? null,
        stripeEventType: existing.stripeEventType ?? input.stripeEventType ?? null,
        providerObjectId: existing.providerObjectId ?? input.providerObjectId ?? null,
        paymentIntentId: existing.paymentIntentId ?? input.paymentIntentId ?? null,
        lastSeenAt: now,
        deliveryCount: existing.deliveryCount + 1,
      }
    : {
        stripeSessionId: input.stripeSessionId,
        claimedOrderId: input.claimedOrderId,
        amountSubtotalCents: input.amountSubtotalCents,
        amountTotalCents: input.amountTotalCents,
        reason: input.reason,
        stripeEventId: input.stripeEventId ?? null,
        stripeEventType: input.stripeEventType ?? null,
        providerObjectId: input.providerObjectId ?? null,
        paymentIntentId: input.paymentIntentId ?? null,
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

export interface StripePaymentTerminalEvent {
  id: string;
  type: StripeTerminalPaymentEventType;
  created?: number;
  data: { object: Record<string, unknown> };
}

export interface StripePaymentTerminalEventResult {
  acknowledged: true;
  outcome: 'converged' | 'already_terminal' | 'unresolved';
  orderId: string | null;
}

function stringId(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id.trim() || null;
  }
  return null;
}

function metadataOf(object: Record<string, unknown>): Record<string, unknown> {
  return object.metadata && typeof object.metadata === 'object'
    ? object.metadata as Record<string, unknown>
    : {};
}

function reversalIdOf(event: StripePaymentTerminalEvent, object: Record<string, unknown>): string | null {
  if (event.type === 'charge.dispute.created') return stringId(object.id);
  const refunds = object.refunds && typeof object.refunds === 'object'
    ? object.refunds as { data?: unknown }
    : null;
  const first = Array.isArray(refunds?.data) ? refunds.data[0] : null;
  return stringId(first) ?? stringId(object.id);
}

function eventOccurredAt(event: StripePaymentTerminalEvent): string {
  const seconds = event.created;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1_000).toISOString()
    : new Date().toISOString();
}

function classifyChargeRefund(object: Record<string, unknown>): {
  kind: 'full' | 'partial';
  refundedAmountCents: number;
} | null {
  const amount = object.amount;
  const amountRefunded = object.amount_refunded;
  const refunded = object.refunded;
  if (
    typeof amount !== 'number'
    || !Number.isSafeInteger(amount)
    || amount <= 0
    || typeof amountRefunded !== 'number'
    || !Number.isSafeInteger(amountRefunded)
    || amountRefunded <= 0
    || amountRefunded > amount
    || typeof refunded !== 'boolean'
    || refunded !== (amountRefunded === amount)
  ) return null;
  return {
    kind: refunded ? 'full' : 'partial',
    refundedAmountCents: amountRefunded,
  };
}

/**
 * Process only Slice 1 terminal events after the route verifies the signature.
 * No Stripe client is accepted or constructed here, so these branches cannot
 * initiate a provider call.
 */
export async function processStripePaymentTerminalEvent(
  event: StripePaymentTerminalEvent,
): Promise<StripePaymentTerminalEventResult> {
  const object = event.data.object;
  const metadata = metadataOf(object);
  const providerObjectId = stringId(object.id) ?? event.id;
  const paymentIntentId = stringId(object.payment_intent);
  const stripeSessionId = event.type === 'checkout.session.async_payment_failed'
    ? stringId(object.id)
    : null;
  const metadataOrderId = stringId(metadata.orderId) ?? stringId(metadata.hsbOrderId);
  let identitySource: 'payment_intent_index' | 'event_metadata' | null = null;
  let orderId = event.type === 'checkout.session.async_payment_failed'
    ? metadataOrderId ?? stringId(object.client_reference_id)
    : null;
  if (event.type !== 'checkout.session.async_payment_failed' && paymentIntentId) {
    const matches = (await listOrdersAuthoritative())
      .filter((order) => order.stripePaymentIntentId === paymentIntentId)
      .map((order) => order.id);
    if (matches.length === 1) {
      orderId = matches[0];
      identitySource = 'payment_intent_index';
      if (metadataOrderId && metadataOrderId !== orderId) orderId = null;
    } else if (matches.length === 0 && metadataOrderId) {
      orderId = metadataOrderId;
      identitySource = 'event_metadata';
    }
  }
  const recoveryKey = stripeSessionId ?? providerObjectId ?? event.id;

  const recordRecovery = async (reason: PaymentRecoveryRecord['reason']) => {
    await recordUnmatchedPaymentSettlement({
      stripeSessionId: recoveryKey,
      claimedOrderId: orderId,
      amountSubtotalCents: null,
      amountTotalCents: null,
      reason,
      stripeEventId: event.id,
      stripeEventType: event.type,
      providerObjectId,
      paymentIntentId,
    });
    return { acknowledged: true, outcome: 'unresolved', orderId } as const;
  };

  if (!orderId || (event.type !== 'checkout.session.async_payment_failed' && !paymentIntentId)) {
    return recordRecovery('terminal_event_missing_identity');
  }
  const refund = event.type === 'charge.refunded' ? classifyChargeRefund(object) : null;
  if (event.type === 'charge.refunded' && !refund) {
    return recordRecovery('terminal_event_invalid_refund_amount');
  }

  const transition = await recordStripeTerminalPaymentState(orderId, {
    stripeEventId: event.id,
    eventType: event.type,
    providerObjectId,
    stripeSessionId,
    paymentIntentId,
    identitySource,
    refundKind: refund?.kind ?? null,
    refundedAmountCents: refund?.refundedAmountCents ?? null,
    reversalId: reversalIdOf(event, object),
    occurredAt: eventOccurredAt(event),
  });
  if (!transition) return recordRecovery('terminal_event_order_not_found');
  if (transition.outcome === 'identity_mismatch') {
    return recordRecovery('terminal_event_identity_mismatch');
  }
  return { acknowledged: true, outcome: transition.outcome, orderId };
}
