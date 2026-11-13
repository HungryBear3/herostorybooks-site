/** Offline shipping terms. This validates server-held receipts, not customer authorization.
 * No sales/Stripe/dispatch route is activated here. Approved artifacts bind later.
 */
import { createHash } from 'node:crypto';

export const SHIPPING_QUOTE_TTL_MS = 45 * 60 * 1000; // proposed local authority, NOT a carrier price guarantee
export type ShippingFailure = 'SHIPPING_INPUT_INVALID' | 'SHIPPING_QUOTE_INVALID' |
  'SHIPPING_QUOTE_UNAVAILABLE' | 'SHIPPING_QUOTE_EXPIRED' | 'SHIPPING_BINDING_MISMATCH';
export const shippingFailure = (code: ShippingFailure): Error => new Error(code);
export interface ShippingContact {
  readonly name: string; readonly phone: string; readonly line1: string; readonly line2: string | null;
  readonly city: string; readonly state: string; readonly zip: string; readonly country: 'US';
  readonly isBusiness: boolean; readonly isPostbox: boolean;
}
export interface ShippingInput {
  readonly draftId: string; readonly ownerBinding: string; readonly operation: 'initial_checkout_shipping';
  readonly plannedProductVersion: string; readonly bookFormat: 'classic' | 'premium';
  readonly podPackageId: string; readonly pageCount: number; readonly quantity: 1; readonly currency: 'USD';
  readonly baselineService: string; readonly selectedService: string; readonly address: ShippingContact;
}
export interface CostBlock { readonly exclTaxCents: number; readonly taxCents: number; readonly totalCents: number; }
export interface LandedCost extends CostBlock {
  readonly print: CostBlock; readonly shipping: CostBlock; readonly fulfillment: CostBlock;
}
export interface ShippingQuote {
  readonly version: 1; readonly provider: 'lulu'; readonly quoteId: string; // internal, NOT a provider ID
  readonly providerQuoteId: null; readonly providerExpiresAtMs: null;
  readonly issuedAtMs: number; readonly expiresAtMs: number; readonly authorityExpiresAtMs: number | null;
  readonly input: ShippingInput; readonly binding: string; readonly baseline: LandedCost; readonly selected: LandedCost;
  readonly deltaCents: number; readonly transitDays: number | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw shippingFailure('SHIPPING_INPUT_INVALID');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) throw shippingFailure('SHIPPING_INPUT_INVALID');
  const s = value.trim().replace(/ +/g, ' ');
  if (!s || s.length > max) throw shippingFailure('SHIPPING_INPUT_INVALID');
  return s;
}
function flag(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw shippingFailure('SHIPPING_INPUT_INVALID');
  return value;
}
export function normalizeShippingContact(value: unknown): ShippingContact {
  try {
    const r = object(value); const name = text(r.name, 35); const phone = text(r.phone, 20);
    const digits = phone.replace(/\D/g, '');
    if (!/^\+?[\d ()\-./]{8,20}$/.test(phone) || digits.length < 8 || digits.length > 15 || /^(\d)\1+$/.test(digits)) {
      throw shippingFailure('SHIPPING_INPUT_INVALID');
    }
    const state = text(r.state, 2).toUpperCase(); const country = text(r.country, 2).toUpperCase();
    const zip = text(r.zip, 10);
    if (!/^[A-Z]{2}$/.test(state) || country !== 'US' || !/^\d{5}(?:-\d{4})?$/.test(zip)) throw shippingFailure('SHIPPING_INPUT_INVALID');
    return Object.freeze({ name, phone, line1: text(r.line1, 30), line2: r.line2 == null || r.line2 === '' ? null : text(r.line2, 30),
      city: text(r.city, 30), state, zip, country: 'US', isBusiness: flag(r.isBusiness), isPostbox: flag(r.isPostbox) });
  } catch { throw shippingFailure('SHIPPING_INPUT_INVALID'); }
}
export function shippingService(value: unknown): string {
  const service = text(value, 32);
  if (!/^[A-Z][A-Z_]*$/.test(service)) throw shippingFailure('SHIPPING_INPUT_INVALID');
  return service; // vocabulary is not destination eligibility; discovery must confirm it
}
export function normalizeShippingInput(value: unknown): ShippingInput {
  try {
    const r = object(value); const address = normalizeShippingContact(r.address);
    const draftId = text(r.draftId, 100); const ownerBinding = text(r.ownerBinding, 64);
    if (!/^[A-Za-z0-9_-]+$/.test(draftId) || !/^[a-f0-9]{64}$/.test(ownerBinding) ||
      r.operation !== 'initial_checkout_shipping' || !['classic', 'premium'].includes(String(r.bookFormat)) ||
      !Number.isSafeInteger(r.pageCount) || (r.pageCount as number) < 1 || r.quantity !== 1 || r.currency !== 'USD') {
      throw shippingFailure('SHIPPING_INPUT_INVALID');
    }
    const baselineService = shippingService(r.baselineService); const selectedService = shippingService(r.selectedService);
    if (baselineService === selectedService) throw shippingFailure('SHIPPING_INPUT_INVALID');
    return Object.freeze({ draftId, ownerBinding, operation: 'initial_checkout_shipping',
      plannedProductVersion: text(r.plannedProductVersion, 100), bookFormat: r.bookFormat as 'classic' | 'premium',
      podPackageId: text(r.podPackageId, 100), pageCount: r.pageCount as number, quantity: 1, currency: 'USD',
      baselineService, selectedService, address });
  } catch { throw shippingFailure('SHIPPING_INPUT_INVALID'); }
}
export function shippingBinding(value: ShippingInput): string {
  const r = normalizeShippingInput(value); const a = r.address;
  return createHash('sha256').update(JSON.stringify([r.draftId, r.ownerBinding, r.operation, r.plannedProductVersion,
    r.bookFormat, r.podPackageId, r.pageCount, r.quantity, r.currency, r.baselineService, r.selectedService,
    a.name, a.phone, a.line1, a.line2, a.city, a.state, a.zip, a.country, a.isBusiness, a.isPostbox])).digest('hex');
}
function cents(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw shippingFailure('SHIPPING_QUOTE_INVALID');
  return value as number;
}
export function sumShippingCents(values: number[]): number {
  const sum = values.reduce((s, n) => s + BigInt(cents(n)), BigInt(0));
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw shippingFailure('SHIPPING_QUOTE_INVALID');
  return Number(sum);
}
function checkedBlock(value: unknown): CostBlock {
  const r = object(value); const exclTaxCents = cents(r.exclTaxCents); const taxCents = cents(r.taxCents); const totalCents = cents(r.totalCents);
  if (sumShippingCents([exclTaxCents, taxCents]) !== totalCents) throw shippingFailure('SHIPPING_QUOTE_INVALID');
  return Object.freeze({ exclTaxCents, taxCents, totalCents });
}
export function validateLandedSnapshot(value: unknown): LandedCost {
  try {
    const r = object(value); const all = checkedBlock(r); const print = checkedBlock(r.print);
    const shipping = checkedBlock(r.shipping); const fulfillment = checkedBlock(r.fulfillment);
    for (const field of ['exclTaxCents', 'taxCents', 'totalCents'] as const) {
      if (sumShippingCents([print[field], shipping[field], fulfillment[field]]) !== all[field]) throw shippingFailure('SHIPPING_QUOTE_INVALID');
    }
    return Object.freeze({ ...all, print, shipping, fulfillment });
  } catch { throw shippingFailure('SHIPPING_QUOTE_INVALID'); }
}
export function assertShippingWindow(issued: number, expiry: number, now: number, cap: number | null): void {
  if (![issued, expiry, now].every(Number.isSafeInteger) || issued < 0 || now < issued ||
    !Number.isSafeInteger(issued + SHIPPING_QUOTE_TTL_MS) ||
    (cap !== null && (!Number.isSafeInteger(cap) || cap < 0))) throw shippingFailure('SHIPPING_QUOTE_INVALID');
  const expected = Math.min(issued + SHIPPING_QUOTE_TTL_MS, cap ?? Number.MAX_SAFE_INTEGER);
  if (expiry !== expected) throw shippingFailure('SHIPPING_QUOTE_INVALID');
  if (now >= expiry) throw shippingFailure('SHIPPING_QUOTE_EXPIRED');
}
/** expected must come from trusted server ownership/product context; receipt must be server-held.
 * This is deliberately NOT a signature/authentication check and grants no payment or dispatch authority.
 */
export function validateShippingSelection(receipt: unknown, expected: unknown, now: number): ShippingQuote {
  try {
    const r = object(receipt); const input = normalizeShippingInput(r.input); const wanted = normalizeShippingInput(expected);
    const binding = shippingBinding(input);
    if (binding !== shippingBinding(wanted) || r.binding !== binding) throw shippingFailure('SHIPPING_BINDING_MISMATCH');
    if (r.version !== 1 || r.provider !== 'lulu' || r.providerQuoteId !== null || r.providerExpiresAtMs !== null ||
      typeof r.quoteId !== 'string' || !/^[a-f0-9-]{36}$/.test(r.quoteId)) throw shippingFailure('SHIPPING_QUOTE_INVALID');
    assertShippingWindow(r.issuedAtMs as number, r.expiresAtMs as number, now, r.authorityExpiresAtMs as number | null);
    const baseline = validateLandedSnapshot(r.baseline); const selected = validateLandedSnapshot(r.selected);
    const deltaCents = selected.totalCents - baseline.totalCents;
    if (deltaCents <= 0 || r.deltaCents !== deltaCents) throw shippingFailure('SHIPPING_QUOTE_INVALID');
    if (r.transitDays !== null && (!Number.isSafeInteger(r.transitDays) || (r.transitDays as number) < 0)) throw shippingFailure('SHIPPING_QUOTE_INVALID');
    return Object.freeze({ version: 1, provider: 'lulu', quoteId: r.quoteId, providerQuoteId: null, providerExpiresAtMs: null,
      issuedAtMs: r.issuedAtMs as number, expiresAtMs: r.expiresAtMs as number, authorityExpiresAtMs: r.authorityExpiresAtMs as number | null,
      input, binding, baseline, selected, deltaCents, transitDays: r.transitDays as number | null });
  } catch (e) {
    if (e instanceof Error && ['SHIPPING_BINDING_MISMATCH', 'SHIPPING_QUOTE_EXPIRED'].includes(e.message)) throw shippingFailure(e.message as ShippingFailure);
    throw shippingFailure('SHIPPING_QUOTE_INVALID');
  }
}
