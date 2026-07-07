import {
  appendAuditEvent,
  getBookFormatMeta,
  getOrder,
  isPrintFormat,
  persistOrder,
  type BookFormat,
  type OrderRecord,
  type ShippingAddress,
} from './orders.ts';

export type PrintUpgradeProvider = 'rpi' | 'lulu' | string;

export type CalculatePrintUpgradeResult =
  | {
      ok: true;
      sourceFormat: BookFormat;
      targetFormat: BookFormat;
      amountCents: number;
      description: string;
    }
  | { ok: false; status: number; error: string };

export interface RecordPrintUpgradePaymentInput {
  stripeSessionId: string;
  amountCents: number;
  targetFormat: BookFormat;
  printProvider?: PrintUpgradeProvider | null;
  shippingAddress?: ShippingAddress;
  paidAt?: string;
}

export function parsePrintUpgradeTargetFormat(value: unknown): BookFormat | null {
  if (value === 'classic' || value === 'premium') return value;
  return null;
}

export function calculatePrintUpgrade(
  order: OrderRecord,
  targetFormat: BookFormat,
): CalculatePrintUpgradeResult {
  if (!isPrintFormat(targetFormat)) {
    return { ok: false, status: 400, error: 'target_must_be_print_format' };
  }
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 409, error: 'original_order_not_paid' };
  }
  if (isPrintFormat(order.bookFormat)) {
    return { ok: false, status: 409, error: 'already_print_order' };
  }
  if (order.printUpgradeStatus === 'paid') {
    return { ok: false, status: 409, error: 'print_upgrade_already_paid' };
  }
  if (order.printJobId) {
    return { ok: false, status: 409, error: 'print_job_already_exists' };
  }

  const source = getBookFormatMeta(order.bookFormat);
  const target = getBookFormatMeta(targetFormat);
  const amountCents = target.priceCents - source.priceCents;

  if (amountCents <= 0) {
    return { ok: false, status: 400, error: 'target_not_higher_value' };
  }

  return {
    ok: true,
    sourceFormat: order.bookFormat,
    targetFormat,
    amountCents,
    description: `${source.label} → ${target.label} print upgrade`,
  };
}

export async function recordPrintUpgradePayment(
  orderId: string,
  input: RecordPrintUpgradePaymentInput,
): Promise<OrderRecord | null> {
  const existing = await getOrder(orderId);
  if (!existing) return null;

  const upgrade = calculatePrintUpgrade(existing, input.targetFormat);
  if (upgrade.ok === false) {
    throw new Error(`print upgrade refused for ${orderId}: ${upgrade.error}`);
  }

  const target = getBookFormatMeta(input.targetFormat);
  const paidAt = input.paidAt ?? new Date().toISOString();
  const updated: OrderRecord = {
    ...existing,
    bookFormat: input.targetFormat,
    formatLabel: target.label,
    priceCents: target.priceCents,
    deliveryExpectation: input.targetFormat === 'premium'
      ? 'Hardcover ships after proof approval and manual print QA'
      : 'Softcover ships after proof approval and manual print QA',
    printUpgradeStatus: 'paid',
    printUpgradeSourceFormat: existing.bookFormat,
    printUpgradeTargetFormat: input.targetFormat,
    printUpgradeAmountCents: input.amountCents,
    printUpgradeStripeSessionId: input.stripeSessionId,
    printUpgradePaidAt: paidAt,
    printUpgradePrintProvider: input.printProvider ?? 'rpi',
    ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
    // Slice A safety: payment only. Preserve proof/review state, but never mark
    // approved/submitted and never create a print job from the webhook.
    printJobId: existing.printJobId ?? null,
    printJobStatus: existing.printJobStatus ?? null,
    updatedAt: paidAt,
  };

  await persistOrder(updated);
  await appendAuditEvent(orderId, {
    at: paidAt,
    type: 'print_upgrade_paid',
    meta: {
      sourceFormat: upgrade.sourceFormat,
      targetFormat: upgrade.targetFormat,
      amountCents: input.amountCents,
      stripeSessionId: input.stripeSessionId,
      printProvider: input.printProvider ?? 'rpi',
    },
  });

  return getOrder(orderId);
}
