import {
  getBookFormatMeta,
  isPrintFormat,
  withOrderTransaction,
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

export interface RecordPrintUpgradeSettlementConflictInput {
  stripeSessionId: string;
  targetFormat: BookFormat;
  amountSubtotalCents: number | null;
  amountTotalCents: number | null;
  reason: string;
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
  if (typeof order.settledAmountCents !== 'number' || order.settledAmountCents < 0) {
    return { ok: false, status: 409, error: 'original_settled_amount_unknown' };
  }
  const amountCents = target.priceCents - order.settledAmountCents;

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
  const paidAt = input.paidAt ?? new Date().toISOString();
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      const upgrade = calculatePrintUpgrade(current, input.targetFormat);
      if (upgrade.ok === false) {
        throw new Error(`print upgrade refused for ${orderId}: ${upgrade.error}`);
      }
      const target = getBookFormatMeta(input.targetFormat);
      const updated: OrderRecord = {
        ...current,
        bookFormat: input.targetFormat,
        formatLabel: target.label,
        priceCents: target.priceCents,
        deliveryExpectation: input.targetFormat === 'premium'
          ? 'Hardcover ships after proof approval and manual print QA'
          : 'Softcover ships after proof approval and manual print QA',
        printUpgradeStatus: 'paid',
        printUpgradeSourceFormat: current.bookFormat,
        printUpgradeTargetFormat: input.targetFormat,
        printUpgradeAmountCents: input.amountCents,
        printUpgradeStripeSessionId: input.stripeSessionId,
        printUpgradePaidAt: paidAt,
        printUpgradePrintProvider: input.printProvider ?? 'rpi',
        ...(input.shippingAddress ? { shippingAddress: input.shippingAddress } : {}),
        printJobId: current.printJobId ?? null,
        printJobStatus: current.printJobStatus ?? null,
        auditEvents: [
          ...(current.auditEvents ?? []),
          {
            at: paidAt,
            type: 'print_upgrade_paid',
            meta: {
              sourceFormat: upgrade.sourceFormat,
              targetFormat: upgrade.targetFormat,
              amountCents: input.amountCents,
              stripeSessionId: input.stripeSessionId,
              printProvider: input.printProvider ?? 'rpi',
            },
          },
        ],
        updatedAt: paidAt,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}

/** Durable, idempotent non-PII recovery anchor for an unapplied signed settlement. */
export async function recordPrintUpgradeSettlementConflict(
  orderId: string,
  input: RecordPrintUpgradeSettlementConflictInput,
): Promise<OrderRecord | null> {
  const now = new Date().toISOString();
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      const alreadyRecorded = (current.auditEvents ?? []).some((event) =>
        event.type === 'print_upgrade_settlement_conflict'
        && event.meta?.stripeSessionId === input.stripeSessionId,
      );
      if (alreadyRecorded) return { abort: current };
      const updated: OrderRecord = {
        ...current,
        auditEvents: [
          ...(current.auditEvents ?? []),
          {
            at: now,
            type: 'print_upgrade_settlement_conflict',
            meta: {
              stripeSessionId: input.stripeSessionId,
              targetFormat: input.targetFormat,
              amountSubtotalCents: input.amountSubtotalCents,
              amountTotalCents: input.amountTotalCents,
              reason: input.reason,
            },
          },
        ],
        updatedAt: now,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}
