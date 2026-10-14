/**
 * Customer digital-to-print upgrade — provider-cost QUOTES.
 *
 * The customer pays exactly the provider's print + shipping/handling +
 * fulfillment + tax for the chosen format and destination, with no markup and
 * never the retail price difference. A quote is:
 *   - exact integer cents parsed from the provider's decimal strings;
 *   - cross-checked against the provider's own total;
 *   - bound to the live offer (offerId) and to the destination it priced;
 *   - short-lived (PRINT_UPGRADE_QUOTE_TTL_MS) and bounded on the record;
 *   - never minted when the provider is unavailable, so a payable checkout
 *     cannot exist without a real provider price.
 *
 * This module never creates a Stripe Session, never emails, and never submits
 * a print job. It calls the provider's COST CALCULATION only (no print job).
 */
import crypto from 'node:crypto';

import {
  withOrderTransaction,
  type OrderRecord,
  type PrintUpgradeQuoteV1,
  type ShippingAddress,
} from './orders.ts';
import { isPrintUpgradeLockLive } from './print-upgrade-lock.ts';
import {
  authorizePrintUpgradeOffer,
  type PrintUpgradeOfferDenial,
  type PrintUpgradeTargetFormat,
} from './print-upgrade-offer.ts';

export const PRINT_UPGRADE_QUOTE_TTL_MS = 60 * 60 * 1000;
export const PRINT_UPGRADE_QUOTES_RETAINED = 6;
export const PRINT_UPGRADE_TARGET_FORMATS: readonly PrintUpgradeTargetFormat[] = ['classic', 'premium'];

export type PrintUpgradeShippingAddress = ShippingAddress & { name: string };

export interface PrintCostQuoteRequest {
  targetFormat: PrintUpgradeTargetFormat;
  pageCount: number;
  quantity?: number;
  shippingAddress: PrintUpgradeShippingAddress;
}

export interface PrintCostQuoteResult {
  provider: 'lulu';
  podPackageId: string;
  shippingLevel: string;
  currency: 'usd';
  printCents: number;
  shippingCents: number;
  fulfillmentCents: number;
  taxCents: number;
  totalCents: number;
  estimatedDeliveryStart?: string | null;
  estimatedDeliveryEnd?: string | null;
}

export interface PrintCostQuoteProvider {
  quote(request: PrintCostQuoteRequest): Promise<PrintCostQuoteResult>;
}

// ── Exact money parsing ──────────────────────────────────────────────────────

const MONEY = /^(\d+)(?:\.(\d{1,2}))?$/;

/** "12.34" → 1234. Decimal strings only; anything else is a provider contract error. */
export function parseLuluMoneyToCents(value: unknown): number {
  if (typeof value !== 'string') throw new Error(`Lulu money value is not a decimal string: ${String(value)}`);
  const match = MONEY.exec(value.trim());
  if (!match) throw new Error(`Lulu money value is malformed: ${value}`);
  const whole = Number.parseInt(match[1], 10);
  const frac = match[2] ? Number.parseInt(match[2].padEnd(2, '0'), 10) : 0;
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) throw new Error(`Lulu money value is out of range: ${value}`);
  return cents;
}

interface LuluCostBlock {
  total_cost_excl_tax?: unknown;
  total_tax?: unknown;
  total_cost_incl_tax?: unknown;
}

export interface LuluCostCalculationResponse {
  currency?: unknown;
  line_item_costs?: unknown;
  shipping_cost?: LuluCostBlock | null;
  fulfillment_cost?: LuluCostBlock | null;
  total_tax?: unknown;
  total_cost_excl_tax?: unknown;
  total_cost_incl_tax?: unknown;
}

function blockCents(block: LuluCostBlock | null | undefined, label: string): { exclTax: number; tax: number; inclTax: number } {
  if (!block || typeof block !== 'object') throw new Error(`Lulu cost calculation is missing the ${label} block`);
  const exclTax = parseLuluMoneyToCents(block.total_cost_excl_tax);
  const inclTax = parseLuluMoneyToCents(block.total_cost_incl_tax);
  const tax = block.total_tax === undefined ? inclTax - exclTax : parseLuluMoneyToCents(block.total_tax);
  if (exclTax + tax !== inclTax) throw new Error(`Lulu ${label} block does not add up`);
  return { exclTax, tax, inclTax };
}

/** Pure: documented Lulu cost-calculation JSON → exact quote components. */
export function luluCostCalculationToQuote(
  response: LuluCostCalculationResponse,
  binding: { podPackageId: string; shippingLevel: string; quantity?: number },
): PrintCostQuoteResult {
  if (typeof response.currency !== 'string' || response.currency.toUpperCase() !== 'USD') {
    throw new Error(`Lulu cost calculation currency is not USD: ${String(response.currency)}`);
  }
  const items = response.line_item_costs;
  if (!Array.isArray(items) || items.length !== 1) {
    throw new Error('Lulu cost calculation must contain exactly one line item');
  }
  const item = items[0] as LuluCostBlock & { quantity?: unknown };
  if (item.quantity !== (binding.quantity ?? 1)) throw new Error('Lulu cost calculation line item quantity mismatch');
  const print = blockCents(item, 'line item');
  const shipping = blockCents(response.shipping_cost, 'shipping');
  const fulfillment = response.fulfillment_cost == null
    ? { exclTax: 0, tax: 0, inclTax: 0 }
    : blockCents(response.fulfillment_cost, 'fulfillment');

  const taxCents = print.tax + shipping.tax + fulfillment.tax;
  const totalCents = print.inclTax + shipping.inclTax + fulfillment.inclTax;
  const providerTotal = parseLuluMoneyToCents(response.total_cost_incl_tax);
  if (providerTotal !== totalCents) {
    throw new Error(`Lulu cost calculation total ${providerTotal} does not match components ${totalCents}`);
  }
  return {
    provider: 'lulu',
    podPackageId: binding.podPackageId,
    shippingLevel: binding.shippingLevel,
    currency: 'usd',
    printCents: print.exclTax,
    shippingCents: shipping.exclTax,
    fulfillmentCents: fulfillment.exclTax,
    taxCents,
    totalCents,
  };
}

// ── Destination ──────────────────────────────────────────────────────────────

const US_STATE = /^[A-Z]{2}$/;
const US_ZIP = /^\d{5}(?:-\d{4})?$/;
const LULU_LINE_MAX = 30;
const LULU_NAME_MAX = 35;

function cleanLine(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export type NormalizedShippingAddress =
  | { ok: true; address: PrintUpgradeShippingAddress }
  | { ok: false; reason: 'address_invalid' };

/** US-only, provider-bounded field lengths. Never throws on customer input. */
export function normalizePrintUpgradeShippingAddress(input: unknown): NormalizedShippingAddress {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'address_invalid' };
  const raw = input as Record<string, unknown>;
  const name = cleanLine(raw.name, LULU_NAME_MAX);
  const line1 = cleanLine(raw.line1, LULU_LINE_MAX);
  const line2Raw = raw.line2 == null || raw.line2 === '' ? null : cleanLine(raw.line2, LULU_LINE_MAX);
  const city = cleanLine(raw.city, LULU_LINE_MAX);
  const state = typeof raw.state === 'string' ? raw.state.trim().toUpperCase() : '';
  const zip = typeof raw.zip === 'string' ? raw.zip.trim() : '';
  const country = typeof raw.country === 'string' ? raw.country.trim().toUpperCase() : '';
  if (!name || !line1 || !city) return { ok: false, reason: 'address_invalid' };
  if (raw.line2 != null && raw.line2 !== '' && line2Raw === null) return { ok: false, reason: 'address_invalid' };
  if (!US_STATE.test(state) || !US_ZIP.test(zip) || country !== 'US') return { ok: false, reason: 'address_invalid' };
  return { ok: true, address: { name, line1, line2: line2Raw, city, state, zip, country } };
}

// ── Quote issuance ───────────────────────────────────────────────────────────

export interface QuotePrintUpgradeInput {
  token: string | null | undefined;
  shippingAddress: unknown;
  quantity?: number;
}

export interface QuotePrintUpgradeDeps {
  provider: PrintCostQuoteProvider;
  now?: string;
}

export type QuotePrintUpgradeResult =
  | { ok: true; quotes: PrintUpgradeQuoteV1[]; order: OrderRecord }
  | { ok: false; reason: PrintUpgradeOfferDenial | 'address_invalid' | 'quote_unavailable' | 'order_not_found' };

function isSaneQuote(result: PrintCostQuoteResult): boolean {
  const parts = [result.printCents, result.shippingCents, result.fulfillmentCents, result.taxCents, result.totalCents];
  if (!parts.every((n) => Number.isSafeInteger(n) && n >= 0)) return false;
  if (result.currency !== 'usd' || result.provider !== 'lulu') return false;
  if (result.printCents + result.shippingCents + result.fulfillmentCents + result.taxCents !== result.totalCents) return false;
  if (result.totalCents <= 0 || result.printCents <= 0) return false;
  if (!result.podPackageId || !result.shippingLevel) return false;
  const start = result.estimatedDeliveryStart;
  const end = result.estimatedDeliveryEnd;
  if ((start == null) !== (end == null)) return false;
  if (start != null && end != null && (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end)) return false;
  return true;
}

export function isQuoteLive(quote: PrintUpgradeQuoteV1, now: Date): boolean {
  const expiry = Date.parse(quote.expiresAt);
  return Number.isFinite(expiry) && expiry > now.getTime();
}

/**
 * Prices BOTH target formats for one destination so the chooser can show the
 * customer real numbers before they pick. The provider is contacted only after
 * the token and destination validate; any provider failure blocks the whole
 * quote (and therefore any payable checkout) rather than guessing.
 */
export async function quotePrintUpgradeAtCost(
  orderId: string,
  input: QuotePrintUpgradeInput,
  deps: QuotePrintUpgradeDeps,
): Promise<QuotePrintUpgradeResult> {
  const now = deps.now ?? new Date().toISOString();
  const nowDate = new Date(now);

  // Pre-flight read: the authorizer runs again inside the commit transaction.
  const preflight = await withOrderTransaction<QuotePrintUpgradeResult | { ok: true; quotes: never[]; order: OrderRecord }>(
    orderId,
    (current) => {
      const access = authorizePrintUpgradeOffer(current, input.token, nowDate);
      if (access.ok === false) return { abort: { ok: false, reason: access.reason } };
      // While a payable Session may still exist for an earlier quote, a new
      // quote could only lead to a second one. Once the lock's Session TTL
      // has passed (webhook or not), re-quoting is allowed again.
      if (isPrintUpgradeLockLive(current.printUpgradeLock, nowDate.getTime())) {
        return { abort: { ok: false, reason: 'quote_unavailable' } };
      }
      return { abort: { ok: true, quotes: [] as never[], order: current } };
    },
    { notFound: () => ({ ok: false, reason: 'order_not_found' }) },
  );
  if (preflight.ok === false) return preflight;
  const offer = preflight.order.printUpgradeOffer!;

  const normalized = normalizePrintUpgradeShippingAddress(input.shippingAddress);
  if (normalized.ok === false) return { ok: false, reason: 'address_invalid' };
  const address = normalized.address;
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return { ok: false, reason: 'address_invalid' };

  const priced: PrintUpgradeQuoteV1[] = [];
  try {
    for (const targetFormat of PRINT_UPGRADE_TARGET_FORMATS) {
      const pageCount = offer.quotePageCounts[targetFormat];
      const result = await deps.provider.quote({ targetFormat, pageCount, quantity, shippingAddress: address });
      if (!isSaneQuote(result)) throw new Error(`provider quote for ${targetFormat} failed sanity checks`);
      priced.push({
        version: 1,
        quoteId: `puq_${crypto.randomBytes(8).toString('hex')}`,
        quantity,
        offerId: offer.offerId,
        targetFormat,
        provider: 'lulu',
        podPackageId: result.podPackageId,
        shippingLevel: result.shippingLevel,
        pageCount,
        currency: 'usd',
        printCents: result.printCents,
        shippingCents: result.shippingCents,
        fulfillmentCents: result.fulfillmentCents,
        taxCents: result.taxCents,
        totalCents: result.totalCents,
        estimatedDeliveryStart: result.estimatedDeliveryStart ?? null,
        estimatedDeliveryEnd: result.estimatedDeliveryEnd ?? null,
        shippingAddress: address,
        issuedAt: now,
        expiresAt: new Date(Date.parse(now) + PRINT_UPGRADE_QUOTE_TTL_MS).toISOString(),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[print-upgrade] quote unavailable for ${orderId}: ${message.slice(0, 200)}`);
    await withOrderTransaction<OrderRecord | null>(
      orderId,
      (current) => ({
        commit: {
          ...current,
          auditEvents: [
            ...(current.auditEvents ?? []),
            { at: now, type: 'print_upgrade_quote_unavailable', meta: { offerId: offer.offerId, provider: 'lulu' } },
          ],
          updatedAt: now,
        },
        result: current,
      }),
      { notFound: () => null },
    );
    return { ok: false, reason: 'quote_unavailable' };
  }

  return withOrderTransaction<QuotePrintUpgradeResult>(
    orderId,
    (current) => {
      const access = authorizePrintUpgradeOffer(current, input.token, nowDate);
      if (access.ok === false) return { abort: { ok: false, reason: access.reason } };
      if (access.offer.offerId !== offer.offerId) return { abort: { ok: false, reason: 'offer_revoked' } };
      const retained = [...(current.printUpgradeQuotes ?? []).filter((q) => q.offerId === offer.offerId), ...priced]
        .slice(-PRINT_UPGRADE_QUOTES_RETAINED);
      const updated: OrderRecord = {
        ...current,
        printUpgradeQuotes: retained,
        auditEvents: [
          ...(current.auditEvents ?? []),
          {
            at: now,
            type: 'print_upgrade_quote_issued',
            meta: {
              offerId: offer.offerId,
              provider: 'lulu',
              classicQuoteId: priced[0].quoteId,
              classicTotalCents: priced[0].totalCents,
              premiumQuoteId: priced[1].quoteId,
              premiumTotalCents: priced[1].totalCents,
            },
          },
        ],
        updatedAt: now,
      };
      return { commit: updated, result: { ok: true, quotes: priced, order: updated } };
    },
    { notFound: () => ({ ok: false, reason: 'order_not_found' }) },
  );
}
