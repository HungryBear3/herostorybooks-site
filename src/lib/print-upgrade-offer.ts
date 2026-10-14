/**
 * Customer digital-to-print upgrade — the chooser OFFER.
 *
 * An offer is a one-use, order-bound, expiring capability that lets the
 * customer of a paid digital order open the private format chooser. It is
 * prepared by an operator only after the approved digital content has been
 * verified (SHA-256 + page count), carries only the token HASH on the order
 * record, and is consumed exactly once by a verified Stripe settlement.
 *
 * Nothing here prices anything, creates a Stripe Session, sends email, or
 * touches a print provider. Those live in print-upgrade-quote.ts,
 * print-upgrade-checkout.ts and print-upgrade-email.ts, and each re-validates
 * the offer through `authorizePrintUpgradeOffer` inside its own transaction.
 */
import crypto from 'node:crypto';

import {
  withOrderTransaction,
  type BookFormat,
  type OrderRecord,
  type PrintUpgradeOfferV1,
} from './orders.ts';

export const PRINT_UPGRADE_OFFER_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const PRINT_UPGRADE_OFFER_MAX_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Lulu perfect-bound softcover minimum interior page count. */
export const LULU_SOFTCOVER_MIN_PAGES = 32;
/** Lulu casewrap hardcover minimum interior page count. */
export const LULU_HARDCOVER_MIN_PAGES = 24;

export type PrintUpgradeTargetFormat = Extract<BookFormat, 'classic' | 'premium'>;
export type PrintPurchaseKind = 'upgrade' | 'extra_copy';

export type PrintUpgradeOfferIneligibility =
  | 'order_not_paid'
  | 'order_refunded'
  | 'not_digital_order'
  | 'print_upgrade_already_paid'
  | 'print_job_exists'
  | 'internal_disposition';

export type PrintUpgradeOfferDenial =
  | PrintUpgradeOfferIneligibility
  | 'offer_missing'
  | 'token_invalid'
  | 'offer_expired'
  | 'offer_revoked'
  | 'offer_consumed';

export type PrintUpgradeOfferAccess =
  | { ok: true; offer: PrintUpgradeOfferV1 }
  | { ok: false; reason: PrintUpgradeOfferDenial };

const SHA256_HEX = /^[a-f0-9]{64}$/;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function timingSafeHexMatch(expectedHex: string, candidateHex: string): boolean {
  if (!expectedHex || !candidateHex || expectedHex.length !== candidateHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'utf8'), Buffer.from(candidateHex, 'utf8'));
  } catch {
    return false;
  }
}

export function isPrintUpgradeTargetFormat(value: unknown): value is PrintUpgradeTargetFormat {
  return value === 'classic' || value === 'premium';
}

/** Base eligibility of an order for ANY at-cost print upgrade activity. */
export function printUpgradeOfferIneligibility(order: OrderRecord, kind: PrintPurchaseKind = 'upgrade'): PrintUpgradeOfferIneligibility | null {
  if (order.paymentStatus !== 'paid') return 'order_not_paid';
  if (order.refundedAt || order.stripeRefundId || order.refundClaimId) return 'order_refunded';
  if (kind === 'upgrade' && order.bookFormat !== 'digital') return 'not_digital_order';
  if (kind === 'upgrade' && (order.printCopyPurchases ?? []).some((purchase) => purchase.kind === 'upgrade')) return 'print_upgrade_already_paid';
  if (kind === 'upgrade' && order.printUpgradeStatus === 'paid') return 'print_upgrade_already_paid';
  if (kind === 'upgrade' && order.printJobId) return 'print_job_exists';
  if (order.internalDisposition) return 'internal_disposition';
  return null;
}

function roundUpEven(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

/** Interior page counts to quote per target format from the approved content. */
export function planQuotePageCounts(approvedSourcePageCount: number): { classic: number; premium: number } {
  if (!Number.isInteger(approvedSourcePageCount) || approvedSourcePageCount <= 0) {
    throw new Error('approved source page count must be a positive integer');
  }
  const even = roundUpEven(approvedSourcePageCount);
  return {
    classic: Math.max(LULU_SOFTCOVER_MIN_PAGES, even),
    premium: Math.max(LULU_HARDCOVER_MIN_PAGES, even),
  };
}

/** The token travels in the fragment so it never reaches server logs or Referer headers. */
export function printUpgradeChooserPathFor(orderId: string, token: string): string {
  return `/upgrade/${orderId}#token=${token}`;
}

export function authorizePrintUpgradeOffer(
  order: OrderRecord,
  token: string | null | undefined,
  now: Date = new Date(),
): PrintUpgradeOfferAccess {
  const offer = order.printUpgradeOffer ?? null;
  if (!offer || offer.version !== 1 || !offer.tokenHash) return { ok: false, reason: 'offer_missing' };
  const presented = typeof token === 'string' ? token : '';
  if (!presented || !timingSafeHexMatch(offer.tokenHash, sha256Hex(presented))) {
    return { ok: false, reason: 'token_invalid' };
  }
  if (offer.revokedAt) return { ok: false, reason: 'offer_revoked' };
  if (offer.consumedAt) return { ok: false, reason: 'offer_consumed' };
  const expiryMs = Date.parse(offer.expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime()) return { ok: false, reason: 'offer_expired' };
  const ineligible = printUpgradeOfferIneligibility(order, offer.purchaseKind ?? 'upgrade');
  if (ineligible) return { ok: false, reason: ineligible };
  if (offer.approvedProofVersion && (
    order.proofVersion !== offer.approvedProofVersion
    || order.proofApprovedAt !== offer.approvedProofAt
    || order.proofReviewedVersion !== offer.approvedProofVersion
  )) return { ok: false, reason: 'offer_revoked' };
  return { ok: true, offer };
}

export interface PrepareCustomerPrintUpgradeOfferInput {
  purchaseKind?: PrintPurchaseKind;
  approvedSourceSha256: string;
  approvedSourcePageCount: number;
  approvedSourceLabel?: string | null;
  ttlMs?: number;
  now?: string;
}

export type PrepareCustomerPrintUpgradeOfferResult =
  | { ok: true; order: OrderRecord; token: string; chooserPath: string; offer: PrintUpgradeOfferV1 }
  | { ok: false; reason: PrintUpgradeOfferIneligibility | 'approved_source_invalid' | 'order_not_found' | 'checkout_already_open' };

/**
 * Operator action. Mints a fresh bearer token (returned exactly once), stores
 * its hash with the verified approved-source evidence, and marks the order
 * `offered`. Re-preparing rotates the token; any previous token stops working.
 */
export async function prepareCustomerPrintUpgradeOffer(
  orderId: string,
  input: PrepareCustomerPrintUpgradeOfferInput,
): Promise<PrepareCustomerPrintUpgradeOfferResult> {
  const sha = (input.approvedSourceSha256 ?? '').trim().toLowerCase();
  const pageCount = input.approvedSourcePageCount;
  if (!SHA256_HEX.test(sha) || !Number.isInteger(pageCount) || pageCount <= 0) {
    return { ok: false, reason: 'approved_source_invalid' };
  }
  const ttlMs = input.ttlMs ?? PRINT_UPGRADE_OFFER_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > PRINT_UPGRADE_OFFER_MAX_TTL_MS) {
    return { ok: false, reason: 'approved_source_invalid' };
  }
  const now = input.now ?? new Date().toISOString();
  const token = crypto.randomBytes(24).toString('hex');
  const purchaseKind = input.purchaseKind ?? 'upgrade';
  const offer: PrintUpgradeOfferV1 = {
    version: 1,
    offerId: `puo_${crypto.randomBytes(8).toString('hex')}`,
    purchaseKind,
    tokenHash: sha256Hex(token),
    issuedAt: now,
    expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
    consumedAt: null,
    revokedAt: null,
    revokedReason: null,
    approvedSource: {
      sha256: sha,
      pageCount,
      label: input.approvedSourceLabel?.trim() || null,
    },
    approvedProofVersion: null,
    approvedProofAt: null,
    quotePageCounts: planQuotePageCounts(pageCount),
    provider: 'lulu',
  };

  return withOrderTransaction<PrepareCustomerPrintUpgradeOfferResult>(
    orderId,
    (current) => {
      if (current.printUpgradeLock?.status === 'open' || current.printUpgradeLock?.status === 'provisioning') {
        return { abort: { ok: false, reason: 'checkout_already_open' } };
      }
      const ineligible = printUpgradeOfferIneligibility(current, purchaseKind);
      if (ineligible) return { abort: { ok: false, reason: ineligible } };
      if (current.proofVersion && (
        !current.proofApprovedAt || current.proofReviewedVersion !== current.proofVersion
      )) return { abort: { ok: false, reason: 'approved_source_invalid' } };
      const boundOffer: PrintUpgradeOfferV1 = {
        ...offer,
        approvedProofVersion: current.proofVersion ?? null,
        approvedProofAt: current.proofApprovedAt ?? null,
      };
      const updated: OrderRecord = {
        ...current,
        printUpgradeOffer: boundOffer,
        // A new offer invalidates quotes and any unpaid lock issued under the old one.
        printUpgradeQuotes: null,
        printUpgradeLock: null,
        printUpgradeStatus: 'offered',
        printUpgradeOfferedAt: now,
        printUpgradeStripeSessionId: null,
        printUpgradeTargetFormat: null,
        printUpgradeAmountCents: null,
        printUpgradePrintProvider: 'lulu',
        auditEvents: [
          ...(current.auditEvents ?? []),
          {
            at: now,
            type: 'print_upgrade_offer_prepared',
            meta: {
              offerId: offer.offerId,
              expiresAt: offer.expiresAt,
              approvedSourceSha256: sha,
              approvedSourcePageCount: pageCount,
              rotatedOfferId: current.printUpgradeOffer?.offerId ?? null,
            },
          },
        ],
        updatedAt: now,
      };
      return {
        commit: updated,
        result: { ok: true, order: updated, token, chooserPath: printUpgradeChooserPathFor(orderId, token), offer: boundOffer },
      };
    },
    { notFound: () => ({ ok: false, reason: 'order_not_found' }) },
  );
}

export async function revokeCustomerPrintUpgradeOffer(
  orderId: string,
  input: { reason: string; now?: string },
): Promise<OrderRecord | null> {
  const now = input.now ?? new Date().toISOString();
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      const offer = current.printUpgradeOffer;
      if (!offer || offer.revokedAt || offer.consumedAt) return { abort: current };
      const updated: OrderRecord = {
        ...current,
        printUpgradeOffer: { ...offer, revokedAt: now, revokedReason: input.reason.slice(0, 120) },
        printUpgradeStatus: current.printUpgradeStatus === 'paid' ? current.printUpgradeStatus : 'cancelled',
        auditEvents: [
          ...(current.auditEvents ?? []),
          { at: now, type: 'print_upgrade_offer_revoked', meta: { offerId: offer.offerId, reason: input.reason.slice(0, 120) } },
        ],
        updatedAt: now,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}
