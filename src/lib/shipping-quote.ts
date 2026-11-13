/** Offline paired shipping producer: real strict Lulu discovery/cost transport → strict landed parser →
 * receipt checked by the real selection validator. Not customer auth, payment permission or a carrier
 * price guarantee. No Stripe/order/dispatch integration. Provider quote ID/expiry are unknown (null).
 */
import { randomUUID } from 'node:crypto';
import { createLuluShippingTransport, type LuluShippingRequest } from './lulu.ts';
import { parseLuluMoneyToCents } from './print-upgrade-quote.ts';
import {
  SHIPPING_QUOTE_TTL_MS, normalizeShippingInput, shippingBinding, shippingFailure, sumShippingCents,
  validateLandedSnapshot, validateShippingSelection,
  type CostBlock, type LandedCost, type ShippingFailure, type ShippingInput, type ShippingQuote,
} from './shipping-selection.ts';

export interface ShippingQuoteDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  /** Earlier trusted server authority expiry (e.g. draft lifetime). Caps, never extends, the local window. */
  readonly authorityExpiresAtMs?: number | null;
}

const CODES: readonly ShippingFailure[] = ['SHIPPING_INPUT_INVALID', 'SHIPPING_QUOTE_INVALID',
  'SHIPPING_QUOTE_UNAVAILABLE', 'SHIPPING_QUOTE_EXPIRED', 'SHIPPING_BINDING_MISMATCH'];
const invalid = () => shippingFailure('SHIPPING_QUOTE_INVALID');

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
/** Reuses the shared decimal parser but discards its value-bearing errors. */
function money(value: unknown): number {
  if (typeof value !== 'string') throw invalid();
  let n: number;
  try { n = parseLuluMoneyToCents(value); } catch { throw invalid(); }
  if (!Number.isSafeInteger(n) || n < 0) throw invalid();
  return n;
}
/** `taxRequired`: the public schema requires line_item_costs[].total_tax; shipping/fulfillment tax may be inferred. */
function costBlock(value: unknown, taxRequired = false): CostBlock {
  const r = record(value); const exclTaxCents = money(r.total_cost_excl_tax); const totalCents = money(r.total_cost_incl_tax);
  if (r.total_tax === undefined && !taxRequired) {
    if (totalCents < exclTaxCents) throw invalid(); // inferred tax must be >= 0
    return { exclTaxCents, taxCents: totalCents - exclTaxCents, totalCents };
  }
  const taxCents = money(r.total_tax);
  if (sumShippingCents([exclTaxCents, taxCents]) !== totalCents) throw invalid();
  return { exclTaxCents, taxCents, totalCents };
}

/** Strict complete one-item quantity=1 USD landed accounting from a raw cost-calculation response. */
export function parseShippingLandedCost(raw: unknown): LandedCost {
  try {
    const r = record(raw);
    if (r.currency !== 'USD' || !Array.isArray(r.line_item_costs) || r.line_item_costs.length !== 1) throw invalid();
    const item = record(r.line_item_costs[0]);
    if (item.quantity !== 1) throw invalid();
    const print = costBlock(item, true); const shipping = costBlock(r.shipping_cost);
    // fulfillment_cost is optional in the documented response: absent means a zero fee, which the
    // reconciliation below still requires the top totals to reflect. A supplied block stays strict.
    const fulfillment = r.fulfillment_cost === undefined ? { exclTaxCents: 0, taxCents: 0, totalCents: 0 } : costBlock(r.fulfillment_cost);
    // Every top-level aggregate is required and must match exactly; sums are safe-checked.
    const top = { exclTaxCents: money(r.total_cost_excl_tax), taxCents: money(r.total_tax), totalCents: money(r.total_cost_incl_tax) };
    return validateLandedSnapshot({ ...top, print, shipping, fulfillment });
  } catch { throw invalid(); }
}

interface DiscoveredService { readonly transitDays: number | null; }
/** Returned options decide eligibility; schema enum is vocabulary, not availability. */
function discoveredServices(raw: unknown, input: ShippingInput): Map<string, DiscoveredService> {
  if (!Array.isArray(raw)) throw invalid();
  const found = new Map<string, DiscoveredService | null>();
  for (const entry of raw) {
    const r = record(entry);
    if (typeof r.level !== 'string' || !/^[A-Z][A-Z_]{0,31}$/.test(r.level)) throw invalid();
    if (r.postbox_ok !== undefined && typeof r.postbox_ok !== 'boolean') throw invalid();
    // transit_time is average transit (schema default 0 = no real estimate). total_days_* include production.
    let transitDays: number | null = null;
    if (r.transit_time !== undefined) {
      if (!Number.isSafeInteger(r.transit_time) || (r.transit_time as number) < 0 || (r.transit_time as number) > 365) throw invalid();
      transitDays = (r.transit_time as number) > 0 ? r.transit_time as number : null;
    }
    // home_only/business_only describe delivery days, not destination type; only postbox is an address restriction.
    const eligible = !input.address.isPostbox || r.postbox_ok === true;
    found.set(r.level, found.has(r.level) ? null : (eligible ? { transitDays } : null)); // duplicate → ambiguous
  }
  const result = new Map<string, DiscoveredService>();
  for (const service of [input.baselineService, input.selectedService]) {
    const hit = found.get(service);
    if (!hit) throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE');
    result.set(service, hit);
  }
  return result;
}

/** Produces a server-held receipt for a single planned book's paired baseline/selected landed costs. */
export async function produceShippingQuote(rawInput: unknown, deps: ShippingQuoteDeps = {}): Promise<ShippingQuote> {
  try {
    // Everything below up to the first await runs synchronously: caller data, clock, cap, endpoint,
    // credentials and fetch are copied/frozen before any awaited work can observe mutation.
    const input = normalizeShippingInput(rawInput);
    const now = deps.now ?? Date.now;
    const issuedAtMs = now();
    const cap = deps.authorityExpiresAtMs ?? null;
    if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0 || !Number.isSafeInteger(issuedAtMs + SHIPPING_QUOTE_TTL_MS) ||
      (cap !== null && (!Number.isSafeInteger(cap) || cap < 0))) throw invalid();
    const expiresAtMs = Math.min(issuedAtMs + SHIPPING_QUOTE_TTL_MS, cap ?? Number.MAX_SAFE_INTEGER);
    const fresh = () => {
      const t = now();
      if (!Number.isSafeInteger(t) || t < issuedAtMs) throw invalid();
      if (t >= expiresAtMs) throw shippingFailure('SHIPPING_QUOTE_EXPIRED');
    };
    fresh();
    const transport = createLuluShippingTransport({ fetch: deps.fetch });
    const request: LuluShippingRequest = Object.freeze({ podPackageId: input.podPackageId, pageCount: input.pageCount,
      quantity: 1, currency: 'USD', address: input.address });
    const { baselineService, selectedService } = input; // distinct and frozen by normalizeShippingInput

    const services = discoveredServices(await transport.discover(request), input);
    fresh();
    await transport.authorize();
    fresh();
    const baseline = parseShippingLandedCost(await transport.cost(request, baselineService));
    fresh();
    const selected = parseShippingLandedCost(await transport.cost(request, selectedService));
    fresh();

    // Charge is the complete landed-total difference only; components are never clamped independently.
    const deltaCents = selected.totalCents - baseline.totalCents;
    if (deltaCents <= 0) throw shippingFailure('SHIPPING_QUOTE_UNAVAILABLE');
    const receipt: ShippingQuote = {
      version: 1, provider: 'lulu', quoteId: randomUUID(), providerQuoteId: null, providerExpiresAtMs: null,
      issuedAtMs, expiresAtMs, authorityExpiresAtMs: cap, input, binding: shippingBinding(input),
      baseline, selected, deltaCents, transitDays: services.get(selectedService)!.transitDays,
    };
    fresh();
    return validateShippingSelection(receipt, input, now());
  } catch (e) {
    const code = e instanceof Error && (CODES as readonly string[]).includes(e.message) ? e.message as ShippingFailure : 'SHIPPING_QUOTE_UNAVAILABLE';
    throw shippingFailure(code);
  }
}
