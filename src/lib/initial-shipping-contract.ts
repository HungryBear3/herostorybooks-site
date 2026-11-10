/** Initial expedited shipping: strict public/private types, parsers and closed refusals. No I/O.
 * Nothing here activates a sale: both flags default off and the commercial/provider
 * qualification parsers below are versioned schemas that refuse absent or partial policy.
 */
import { createHash } from 'node:crypto';

export const INITIAL_SHIPPING_OPERATION = 'initial_checkout_shipping' as const;
export const INITIAL_SHIPPING_OWNER_COPY =
  'Faster transit after your book prints. Proof preparation and printing time are unchanged. Arrival estimates are not guaranteed.';

export type InitialShippingRefusal =
  | 'flag_off' | 'input_invalid' | 'owner_invalid' | 'draft_absent' | 'draft_malformed' | 'draft_conflict'
  | 'draft_locked' | 'draft_expired' | 'store_unavailable' | 'quote_unavailable' | 'quote_expired'
  | 'quote_stale' | 'selection_invalid' | 'lock_conflict' | 'product_drift' | 'format_unsupported'
  | 'promotion_policy_unqualified' | 'ttl_policy_unqualified' | 'provider_unqualified'
  | 'provenance_unavailable' | 'provenance_conflict' | 'metadata_malformed' | 'session_expired';

export class InitialShippingError extends Error {
  readonly code: InitialShippingRefusal;
  constructor(code: InitialShippingRefusal) { super(code); this.name = 'InitialShippingError'; this.code = code; }
}
export const refuse = (code: InitialShippingRefusal): never => { throw new InitialShippingError(code); };

// ---- flags (both default off; only the literal string 'true' enables) ----
export interface InitialShippingFlags { readonly quotes: boolean; readonly checkout: boolean; }
export function readInitialShippingFlags(env: Readonly<Record<string, string | undefined>>): InitialShippingFlags {
  return Object.freeze({
    quotes: env.HSB_INITIAL_EXPEDITED_QUOTES_ENABLED === 'true',
    checkout: env.HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED === 'true',
  });
}

// ---- small strict helpers ----
export function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(value, k))) return null;
  return value as Record<string, unknown>;
}
export const isCents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
export const isHex64 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const isQuoteId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export const isService = (v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Z_]{0,31}$/.test(v);
export const ORDER_ID = /^ord_[a-f0-9]{16}$/; // canonical grammar, unchanged
export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export function digestJson(value: unknown): string { return sha256(JSON.stringify(value)); }

// ---- server product plan (classic 32 / premium 38 interior pages) ----
export type ShippingBookFormat = 'classic' | 'premium';
export const PLANNED_INTERIOR_PAGES: Readonly<Record<ShippingBookFormat, number>> = Object.freeze({ classic: 32, premium: 38 });
export const PLANNED_LAYOUT_VERSION = 'modern_full_bleed' as const;
export const PLANNED_PRODUCT_VERSION = 'hsb-initial-print-v1' as const;
export interface PlannedProduct {
  readonly bookFormat: ShippingBookFormat; readonly podPackageId: string; readonly interiorPageCount: number;
  readonly layoutVersion: typeof PLANNED_LAYOUT_VERSION; readonly plannedProductVersion: typeof PLANNED_PRODUCT_VERSION;
  readonly quantity: 1; readonly currency: 'USD';
}
export function planInitialShippingProduct(bookFormat: unknown, podPackageIdFor: (f: ShippingBookFormat) => string): PlannedProduct {
  if (bookFormat !== 'classic' && bookFormat !== 'premium') refuse('format_unsupported');
  const f = bookFormat as ShippingBookFormat;
  const podPackageId = podPackageIdFor(f);
  if (typeof podPackageId !== 'string' || !/^[A-Z0-9.]{10,100}$/.test(podPackageId)) refuse('provider_unqualified');
  return Object.freeze({ bookFormat: f, podPackageId, interiorPageCount: PLANNED_INTERIOR_PAGES[f],
    layoutVersion: PLANNED_LAYOUT_VERSION, plannedProductVersion: PLANNED_PRODUCT_VERSION, quantity: 1, currency: 'USD' });
}

// ---- versioned commercial policy (no default qualifies) ----
export interface InitialShippingCommercialPolicyV1 {
  readonly version: 1; readonly pricingRuleVersion: string;
  readonly promotion: { readonly mode: 'book_only_verified'; readonly approvalRef: string };
  readonly ttl: { readonly sessionTtlMs: number; readonly minimumQuoteRemainingMs: number };
  readonly tax: { readonly rule: 'landed_delta_tax_included_v1' };
  readonly paymentMethodTypes: readonly ['card'];
}
export type CommercialPolicyResult =
  | { readonly qualified: true; readonly policy: InitialShippingCommercialPolicyV1 }
  | { readonly qualified: false; readonly reason: 'promotion_policy_unqualified' | 'ttl_policy_unqualified' };
/** Stripe Checkout session lifetime bounds (30 minutes .. 24 hours). */
export const STRIPE_SESSION_MIN_MS = 30 * 60 * 1000;
export const STRIPE_SESSION_MAX_MS = 24 * 60 * 60 * 1000;
export function parseInitialShippingCommercialPolicy(raw: unknown): CommercialPolicyResult {
  const r = exactObject(raw, ['version', 'pricingRuleVersion', 'promotion', 'ttl', 'tax', 'paymentMethodTypes']);
  const promo = r && exactObject(r.promotion, ['mode', 'approvalRef']);
  if (!r || r.version !== 1 || typeof r.pricingRuleVersion !== 'string' || !/^[a-z0-9_.-]{1,40}$/.test(r.pricingRuleVersion) ||
    !promo || promo.mode !== 'book_only_verified' || typeof promo.approvalRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(promo.approvalRef)) {
    return { qualified: false, reason: 'promotion_policy_unqualified' };
  }
  const ttl = exactObject(r.ttl, ['sessionTtlMs', 'minimumQuoteRemainingMs']);
  const tax = exactObject(r.tax, ['rule']);
  const methods = r.paymentMethodTypes;
  if (!ttl || !Number.isSafeInteger(ttl.sessionTtlMs) || (ttl.sessionTtlMs as number) < STRIPE_SESSION_MIN_MS ||
    (ttl.sessionTtlMs as number) > STRIPE_SESSION_MAX_MS || !Number.isSafeInteger(ttl.minimumQuoteRemainingMs) ||
    (ttl.minimumQuoteRemainingMs as number) < (ttl.sessionTtlMs as number) ||
    !tax || tax.rule !== 'landed_delta_tax_included_v1' ||
    !Array.isArray(methods) || methods.length !== 1 || methods[0] !== 'card') {
    return { qualified: false, reason: 'ttl_policy_unqualified' };
  }
  return { qualified: true, policy: Object.freeze({ version: 1, pricingRuleVersion: r.pricingRuleVersion,
    promotion: Object.freeze({ mode: 'book_only_verified', approvalRef: promo.approvalRef as string }),
    ttl: Object.freeze({ sessionTtlMs: ttl.sessionTtlMs as number, minimumQuoteRemainingMs: ttl.minimumQuoteRemainingMs as number }),
    tax: Object.freeze({ rule: 'landed_delta_tax_included_v1' }), paymentMethodTypes: Object.freeze(['card']) as readonly ['card'] }) };
}

// ---- versioned provider qualification (no default qualifies) ----
export interface InitialShippingProviderQualificationV1 {
  readonly version: 1; readonly endpointOrigin: string; readonly accountBinding: string; readonly configurationVersion: string;
  readonly baselineService: string; readonly selectedService: string; readonly selectedServiceLabel: 'Expedited';
  readonly stripeAccountBinding: string; readonly stripeLivemode: boolean;
}
export function parseInitialShippingProviderQualification(raw: unknown): InitialShippingProviderQualificationV1 | null {
  const r = exactObject(raw, ['version', 'endpointOrigin', 'accountBinding', 'configurationVersion', 'baselineService',
    'selectedService', 'selectedServiceLabel', 'stripeAccountBinding', 'stripeLivemode']);
  if (!r || r.version !== 1 || typeof r.endpointOrigin !== 'string' || !/^https:\/\/[a-z0-9.-]+$/.test(r.endpointOrigin) ||
    !isHex64(r.accountBinding) || typeof r.configurationVersion !== 'string' || !/^[a-z0-9_.-]{1,40}$/.test(r.configurationVersion) ||
    !isService(r.baselineService) || !isService(r.selectedService) || r.baselineService === r.selectedService ||
    r.selectedServiceLabel !== 'Expedited' || !isHex64(r.stripeAccountBinding) || typeof r.stripeLivemode !== 'boolean') return null;
  return Object.freeze({ ...(r as unknown as InitialShippingProviderQualificationV1) });
}
export function providerBindingDigest(q: InitialShippingProviderQualificationV1): string {
  return digestJson(['provider', q.endpointOrigin, q.accountBinding, q.configurationVersion, q.baselineService, q.selectedService]);
}

// ---- public non-PII order metadata (immutable terms) ----
export interface InitialShippingOrderMetadataV1 {
  readonly version: 1;
  readonly operation: typeof INITIAL_SHIPPING_OPERATION;
  readonly draftRef: string; // sha256 of the private draft path; opaque, not a locator credential
  readonly quoteId: string;
  readonly quoteBindingDigest: string;
  readonly product: {
    readonly bookFormat: ShippingBookFormat; readonly podPackageId: string; readonly interiorPageCount: number;
    readonly layoutVersion: typeof PLANNED_LAYOUT_VERSION; readonly plannedProductVersion: typeof PLANNED_PRODUCT_VERSION;
  };
  readonly service: { readonly baseline: string; readonly selected: string; readonly selectedLabel: 'Expedited' };
  readonly currency: 'USD';
  readonly totals: {
    readonly bookCents: number; readonly deltaCents: number; readonly deltaTaxIncludedCents: number;
    readonly selectedLandedCents: number; readonly totalCents: number;
  };
  readonly quoteWindow: { readonly issuedAtMs: number; readonly expiresAtMs: number };
  readonly providerBindingDigest: string;
  readonly pricingRuleVersion: string;
}
const METADATA_KEYS = ['version', 'operation', 'draftRef', 'quoteId', 'quoteBindingDigest', 'product', 'service',
  'currency', 'totals', 'quoteWindow', 'providerBindingDigest', 'pricingRuleVersion'] as const;

export function parseInitialShippingMetadata(raw: unknown): InitialShippingOrderMetadataV1 | null {
  const r = exactObject(raw, METADATA_KEYS);
  if (!r) return null;
  const p = exactObject(r.product, ['bookFormat', 'podPackageId', 'interiorPageCount', 'layoutVersion', 'plannedProductVersion']);
  const s = exactObject(r.service, ['baseline', 'selected', 'selectedLabel']);
  const t = exactObject(r.totals, ['bookCents', 'deltaCents', 'deltaTaxIncludedCents', 'selectedLandedCents', 'totalCents']);
  const w = exactObject(r.quoteWindow, ['issuedAtMs', 'expiresAtMs']);
  if (r.version !== 1 || r.operation !== INITIAL_SHIPPING_OPERATION || !isHex64(r.draftRef) || !isQuoteId(r.quoteId) ||
    !isHex64(r.quoteBindingDigest) || !p || !s || !t || !w || r.currency !== 'USD' || !isHex64(r.providerBindingDigest) ||
    typeof r.pricingRuleVersion !== 'string' || !/^[a-z0-9_.-]{1,40}$/.test(r.pricingRuleVersion)) return null;
  if ((p.bookFormat !== 'classic' && p.bookFormat !== 'premium') || typeof p.podPackageId !== 'string' ||
    p.interiorPageCount !== PLANNED_INTERIOR_PAGES[p.bookFormat as ShippingBookFormat] ||
    p.layoutVersion !== PLANNED_LAYOUT_VERSION || p.plannedProductVersion !== PLANNED_PRODUCT_VERSION) return null;
  if (!isService(s.baseline) || !isService(s.selected) || s.baseline === s.selected || s.selectedLabel !== 'Expedited') return null;
  if (!isCents(t.bookCents) || !isCents(t.deltaCents) || (t.deltaCents as number) <= 0 || (t.bookCents as number) <= 0 ||
    !isCents(t.deltaTaxIncludedCents) || (t.deltaTaxIncludedCents as number) > (t.deltaCents as number) ||
    !isCents(t.selectedLandedCents) || (t.selectedLandedCents as number) < (t.deltaCents as number) ||
    !isCents(t.totalCents) || t.totalCents !== (t.bookCents as number) + (t.deltaCents as number)) return null;
  if (!Number.isSafeInteger(w.issuedAtMs) || !Number.isSafeInteger(w.expiresAtMs) || (w.expiresAtMs as number) <= (w.issuedAtMs as number)) return null;
  return deepFreeze(JSON.parse(JSON.stringify(r))) as InitialShippingOrderMetadataV1;
}

// ---- mutable settlement projection (not part of the payable fingerprint) ----
export type InitialShippingHoldReason =
  | 'payment_untimely' | 'payment_evidence_mismatch' | 'payment_amount_mismatch' | 'payment_discounted'
  | 'payment_not_paid' | 'payment_deferred_unsupported' | 'receipt_conflict' | 'receipt_unavailable'
  | 'refund_or_terminal' | 'metadata_malformed' | 'dispatch_cost_exceeded' | 'dispatch_service_unavailable'
  | 'dispatch_artifact_drift' | 'dispatch_account_drift' | 'dispatch_private_unavailable';
export const HOLD_REASONS: readonly InitialShippingHoldReason[] = ['payment_untimely', 'payment_evidence_mismatch',
  'payment_amount_mismatch', 'payment_discounted', 'payment_not_paid', 'payment_deferred_unsupported', 'receipt_conflict',
  'receipt_unavailable', 'refund_or_terminal', 'metadata_malformed', 'dispatch_cost_exceeded', 'dispatch_service_unavailable',
  'dispatch_artifact_drift', 'dispatch_account_drift', 'dispatch_private_unavailable'];
export interface InitialShippingSettlementV1 {
  readonly version: 1; readonly state: 'unverified' | 'committed' | 'held';
  readonly receiptDigest: string | null; readonly reason: InitialShippingHoldReason | null; readonly updatedAt: string;
}
export function parseInitialShippingSettlement(raw: unknown): InitialShippingSettlementV1 | null {
  const r = exactObject(raw, ['version', 'state', 'receiptDigest', 'reason', 'updatedAt']);
  if (!r || r.version !== 1 || !['unverified', 'committed', 'held'].includes(r.state as string)) return null;
  if (r.receiptDigest !== null && !isHex64(r.receiptDigest)) return null;
  if (r.reason !== null && !HOLD_REASONS.includes(r.reason as InitialShippingHoldReason)) return null;
  if (r.state === 'committed' && (r.receiptDigest === null || r.reason !== null)) return null;
  if (r.state === 'held' && r.reason === null) return null;
  if (r.state === 'unverified' && (r.receiptDigest !== null || r.reason !== null)) return null;
  if (typeof r.updatedAt !== 'string' || Number.isNaN(Date.parse(r.updatedAt))) return null;
  return Object.freeze({ ...(r as unknown as InitialShippingSettlementV1) });
}

/** Strict reader used by every new effect: absent legacy is distinct from present malformed. */
export type InitialShippingRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'present'; readonly metadata: InitialShippingOrderMetadataV1; readonly settlement: InitialShippingSettlementV1 };
export function readOrderInitialShipping(order: { readonly initialShipping?: unknown; readonly initialShippingSettlement?: unknown }): InitialShippingRead {
  const hasM = Object.prototype.hasOwnProperty.call(order, 'initialShipping') && order.initialShipping !== undefined;
  const hasS = Object.prototype.hasOwnProperty.call(order, 'initialShippingSettlement') && order.initialShippingSettlement !== undefined;
  if (!hasM && !hasS) return { kind: 'absent' };
  if (!hasM || !hasS) return { kind: 'malformed' };
  const metadata = parseInitialShippingMetadata(order.initialShipping);
  const settlement = parseInitialShippingSettlement(order.initialShippingSettlement);
  if (!metadata || !settlement) return { kind: 'malformed' };
  return { kind: 'present', metadata, settlement };
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); }
  return value;
}
