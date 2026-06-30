import type { BookFormat, OrderRecord } from './orders';

export const PRINT_UPGRADE_TARGETS = ['classic', 'premium'] as const;
export type PrintUpgradeTargetFormat = (typeof PRINT_UPGRADE_TARGETS)[number];

export interface PrintUpgradeEligibility {
  eligible: boolean;
  reason: string | null;
}

export interface PrintUpgradeOffer {
  orderId: string;
  email: string;
  childName: string;
  targetFormat: PrintUpgradeTargetFormat;
  deltaCents: number;
  metadata: {
    kind: 'print_upgrade';
    orderId: string;
    sourceFormat: 'digital';
    targetFormat: PrintUpgradeTargetFormat;
  };
}

export const BOOK_FORMAT_PRICES_CENTS: Record<BookFormat, number> = {
  digital: 1900,
  classic: 3900,
  premium: 6400,
};

export function getPrintUpgradeEligibility(order: Pick<OrderRecord,
  | 'bookFormat'
  | 'paymentStatus'
  | 'email'
  | 'printJobId'
  | 'printJobStatus'
  | 'printUpgradeStatus'
  | 'printUpgradePaidAt'
>): PrintUpgradeEligibility {
  if (order.bookFormat !== 'digital') {
    return { eligible: false, reason: 'order is not a digital order' };
  }
  if (order.paymentStatus !== 'paid') {
    return { eligible: false, reason: 'digital order is not paid' };
  }
  if (!order.email || !order.email.includes('@')) {
    return { eligible: false, reason: 'order has no safe contact email' };
  }
  if (order.printJobId || order.printJobStatus) {
    return { eligible: false, reason: 'order already has print fulfillment state' };
  }
  if (
    order.printUpgradePaidAt ||
    order.printUpgradeStatus === 'checkout_open' ||
    order.printUpgradeStatus === 'paid' ||
    order.printUpgradeStatus === 'proof_required' ||
    order.printUpgradeStatus === 'print_pending'
  ) {
    return { eligible: false, reason: 'print upgrade already paid, open, or pending print' };
  }
  return { eligible: true, reason: null };
}

export function isPrintUpgradeEligible(order: Parameters<typeof getPrintUpgradeEligibility>[0]): boolean {
  return getPrintUpgradeEligibility(order).eligible;
}

export function calculatePrintUpgradeDeltaCents(
  sourceFormat: BookFormat,
  targetFormat: PrintUpgradeTargetFormat,
): number {
  const source = BOOK_FORMAT_PRICES_CENTS[sourceFormat];
  const target = BOOK_FORMAT_PRICES_CENTS[targetFormat];
  return Math.max(0, target - source);
}

export function buildPrintUpgradeOffer(
  order: OrderRecord,
  targetFormat: PrintUpgradeTargetFormat,
): PrintUpgradeOffer {
  const eligibility = getPrintUpgradeEligibility(order);
  if (!eligibility.eligible) {
    throw new Error(`order not eligible for print upgrade: ${eligibility.reason}`);
  }
  return {
    orderId: order.id,
    email: order.email,
    childName: order.childName,
    targetFormat,
    deltaCents: calculatePrintUpgradeDeltaCents('digital', targetFormat),
    metadata: {
      kind: 'print_upgrade',
      orderId: order.id,
      sourceFormat: 'digital',
      targetFormat,
    },
  };
}

export function buildPrintUpgradeDraftEmail(offer: PrintUpgradeOffer): { subject: string; text: string } {
  const dollars = (offer.deltaCents / 100).toFixed(2);
  const formatLabel = offer.targetFormat === 'classic' ? 'softcover' : 'hardcover';
  return {
    subject: `Want to add a printed ${formatLabel} for ${offer.childName}'s book?`,
    text: [
      `Your digital Hero Story Book for ${offer.childName} stays valid.`,
      `If you want a printed ${formatLabel} keepsake too, you can upgrade by paying the $${dollars} price difference plus any required shipping/tax.`,
      'Nothing goes to print automatically. We still hold the book behind proof review, QA, and owner print-go gates before any provider submission.',
      'This is a draft/internal upgrade offer until an operator explicitly approves sending it.',
    ].join('\n\n'),
  };
}
