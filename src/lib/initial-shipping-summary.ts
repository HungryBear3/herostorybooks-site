/** Pure customer/admin/email itemization and closed metrics projections. No I/O, no private fields. */
import {
  INITIAL_SHIPPING_OWNER_COPY, HOLD_REASONS, readOrderInitialShipping, type InitialShippingOrderMetadataV1,
} from './initial-shipping-contract.ts';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export interface ShippingItemizationRow { readonly label: string; readonly amount: string }
export function itemizationRows(m: InitialShippingOrderMetadataV1): readonly ShippingItemizationRow[] {
  return Object.freeze([
    { label: 'Book', amount: usd(m.totals.bookCents) },
    { label: 'Standard shipping', amount: 'Included' },
    { label: 'Expedited shipping upgrade', amount: usd(m.totals.deltaCents) },
    { label: 'Shipping tax (included in upgrade)', amount: usd(m.totals.deltaTaxIncludedCents) },
    { label: 'Total', amount: usd(m.totals.totalCents) },
  ]);
}

export interface ShippingPresentationOrder {
  readonly initialShipping?: unknown; readonly initialShippingSettlement?: unknown;
  readonly paymentStatus?: unknown; readonly refundStatus?: unknown; readonly refundedAt?: unknown;
  readonly stripeRefundId?: unknown; readonly refundClaimId?: unknown;
  readonly fulfillmentLastError?: unknown; readonly fulfillmentStatus?: unknown;
  readonly printSubmissionAttemptedAt?: unknown; readonly printJobId?: unknown;
}
function terminalPayment(order: ShippingPresentationOrder) {
  return order.paymentStatus === 'failed' || order.paymentStatus === 'refunded' || order.paymentStatus === 'partially_refunded'
    || Boolean(order.stripeRefundId) || Boolean(order.refundClaimId) || order.refundedAt != null
    || (order.refundStatus != null && order.refundStatus !== 'none');
}
/** Never reflect arbitrary provider/error text. An unknown submitted job is reconciliation, not retry authority. */
function dispatchHold(order: ShippingPresentationOrder): string | null {
  if (order.printSubmissionAttemptedAt && !order.printJobId) return 'dispatch_reconciliation';
  const error = typeof order.fulfillmentLastError === 'string' ? order.fulfillmentLastError : '';
  const reason = /^(?:print_submission_failed_before_attempt: )?shipping_hold:([a-z_]+)$/.exec(error)?.[1];
  if (reason && HOLD_REASONS.includes(reason as typeof HOLD_REASONS[number])) return reason;
  if (error || order.fulfillmentStatus === 'failed_manual_review') return 'dispatch_reconciliation';
  return null;
}
export type PublicShippingSummary =
  | { readonly kind: 'standard' }
  | { readonly kind: 'expedited'; readonly status: 'confirmed' | 'pending' | 'held'; readonly serviceLabel: 'Expedited';
      readonly rows: readonly ShippingItemizationRow[]; readonly copy: string; readonly message: string; readonly payment: 'paid' | 'pending' | 'terminal' }
  | { readonly kind: 'held_malformed'; readonly message: string };
/** Closed projection only. Rows are accepted quote terms, never an inferred payment receipt. */
export function publicShippingSummary(order: ShippingPresentationOrder): PublicShippingSummary {
  const r = readOrderInitialShipping(order);
  if (r.kind === 'absent') return { kind: 'standard' };
  const payment = terminalPayment(order) ? 'terminal' : order.paymentStatus === 'paid' ? 'paid' : 'pending';
  const holdCopy = payment === 'paid'
    ? 'Payment received. Your shipping upgrade needs review before we can confirm service or release the book to print. Please contact support; do not pay again.'
    : payment === 'terminal' ? 'Shipping service is not confirmed. Please contact support about the payment status; do not pay again for this order.'
      : 'We are checking your payment and shipping upgrade. Service is not confirmed; please do not pay again.';
  if (r.kind === 'malformed') return { kind: 'held_malformed', message: holdCopy };
  const status = payment === 'terminal' || dispatchHold(order) || r.settlement.state === 'held' ? 'held'
    : payment === 'paid' && r.settlement.state === 'committed' ? 'confirmed' : 'pending';
  return { kind: 'expedited', status, payment, serviceLabel: 'Expedited', rows: itemizationRows(r.metadata), copy: INITIAL_SHIPPING_OWNER_COPY,
    message: status === 'confirmed' ? 'Expedited shipping upgrade paid. This is not a shipment or print-dispatch confirmation. Proof approval and final print checks still apply.' : holdCopy };
}

/** Admin projection: bounded positive fields only, including sanitized dispatch holds. */
export function adminShippingSummary(order: ShippingPresentationOrder) {
  const r = readOrderInitialShipping(order);
  if (r.kind === 'absent') return { kind: 'standard' as const };
  if (r.kind === 'malformed') return { kind: 'hold' as const, reason: 'metadata_malformed' as const };
  const summary = publicShippingSummary(order);
  return { kind: 'expedited' as const, settlement: r.settlement.state,
    reason: terminalPayment(order) ? 'refund_or_terminal' : dispatchHold(order) ?? r.settlement.reason,
    payment: summary.kind === 'expedited' ? summary.payment : 'pending',
    service: r.metadata.service.selected, rows: itemizationRows(r.metadata), pricingRuleVersion: r.metadata.pricingRuleVersion };
}

/** Pure readiness shared by the claim gate and renderer; absent legacy stays byte-identical. */
export function confirmationShippingReady(order: ShippingPresentationOrder): boolean {
  const summary = publicShippingSummary(order);
  return summary.kind === 'standard' || (summary.kind === 'expedited' && summary.status === 'confirmed');
}

/** Pure decorator over the single base confirmation render result (base body never changed). */
export function decorateConfirmationWithShipping<T extends { subject: string; text: string; html: string }>(
  base: T, m: InitialShippingOrderMetadataV1 | null): T {
  if (!m) return base;
  const rows = itemizationRows(m);
  const text = `${base.text}\n\nShipping: Expedited\n${rows.map((r) => `${r.label}: ${r.amount}`).join('\n')}\n${INITIAL_SHIPPING_OWNER_COPY}\n`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const table = `<table role="presentation" aria-label="Order itemization">${rows.map((r) =>
    `<tr><td>${esc(r.label)}</td><td style="text-align:right">${esc(r.amount)}</td></tr>`).join('')}</table><p>${esc(INITIAL_SHIPPING_OWNER_COPY)}</p>`;
  const html = base.html.includes('</body>') ? base.html.replace('</body>', `${table}</body>`) : `${base.html}${table}`;
  return { ...base, text, html };
}
/** Exact immutable inputs the decorator reads; bound into the snapshot render-input key only when present. */
export function shippingRenderInputs(m: InitialShippingOrderMetadataV1): readonly unknown[] {
  return [m.quoteId, m.service.selected, m.totals.bookCents, m.totals.deltaCents, m.totals.deltaTaxIncludedCents, m.totals.totalCents];
}

// ---- metrics: closed names/params only; browser-safe defining module ----
export { shippingMetricParams, type ShippingBrowserEvent, type ShippingMetricParams } from './analytics-event-contract.ts';
