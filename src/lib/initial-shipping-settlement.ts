/** Signed settlement for initial expedited shipping. Input is a Stripe event that the webhook has ALREADY
 * verified with constructEvent. Only the event's own `created` time decides timeliness (webhook arrival,
 * session.created/expires_at and local paidAt never authorize). Mismatch retains paid facts as HOLD;
 * nothing here refunds, charges, re-creates a session or falls back to standard.
 */
import {
  digestJson, parseInitialShippingSettlement, readOrderInitialShipping,
  type InitialShippingHoldReason, type InitialShippingOrderMetadataV1, type InitialShippingSettlementV1,
} from './initial-shipping-contract.ts';
import type { DraftPaymentEvidence, DraftStore, InitialShippingDraftV1 } from './initial-shipping-draft.ts';
import { expectedExpeditedSubtotalCents } from './initial-shipping-checkout.ts';
import { createPrivateShippingDraftAccess, draftRefOf, quoteInputFor } from './initial-shipping-draft.ts';
import { parseInitialShippingProviderQualification, providerBindingDigest, sha256 } from './initial-shipping-contract.ts';
import { validateShippingSelection } from './shipping-selection.ts';
import { getOrderAuthoritative, recordPaymentSettlementConflict, settleOrderPayment, withOrderTransaction, type OrderRecord } from './orders.ts';
import { shippingMetricParams } from './analytics-event-contract.ts';
import { getRequiredStripeSecretKey } from './stripe-env.ts';

/** Reconciliation is not sales admission: no browser capability, intake expiry or activation flags.
 * All reads and writes stay bound to the canonical order's immutable locator/lock and one frozen
 * private namespace + qualification. The signed event may corroborate these facts, never choose them.
 */
function settlementDraftAccess(order: OrderRecord, metadata: InitialShippingOrderMetadataV1) {
  const access = createPrivateShippingDraftAccess();
  const configuration = process.env.HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION;
  const key = getRequiredStripeSecretKey();
  const provider = parseInitialShippingProviderQualification(JSON.parse(configuration ?? 'null'));
  if (!provider || providerBindingDigest(provider) !== metadata.providerBindingDigest) throw new Error('shipping_authority_unavailable');
  const intakeId = order.checkoutIntake?.intakeId;
  if (!intakeId || draftRefOf(intakeId, access.namespace) !== metadata.draftRef) throw new Error('shipping_authority_unavailable');
  const intact = () => access.intact() && configuration === process.env.HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION && key === getRequiredStripeSecretKey();
  const validate = (d: InitialShippingDraftV1) => {
    if (!intact() || d.intakeId !== intakeId || d.namespace !== access.namespace || d.storeId !== access.storeId ||
      d.lock?.canonicalOrderId !== order.id || d.lock.checkoutIntentFingerprint !== order.checkoutIntentFingerprint ||
      d.lock.quoteId !== metadata.quoteId || d.selectedQuoteId !== metadata.quoteId || !d.quote ||
      d.lock.binding !== d.quote.binding || d.lock.lockedRevision !== d.revision ||
      d.providerBinding.accountBinding !== provider.accountBinding || d.providerBinding.endpointOrigin !== provider.endpointOrigin ||
      d.providerBinding.configurationVersion !== provider.configurationVersion) throw new Error('shipping_authority_mismatch');
    // Validate immutable historical terms at issue time, NOT at webhook arrival time.
    const q = validateShippingSelection(d.quote, quoteInputFor(d, provider), metadata.quoteWindow.issuedAtMs);
    if (digestJson(['quote', q.binding, q.quoteId]) !== metadata.quoteBindingDigest ||
      q.issuedAtMs !== metadata.quoteWindow.issuedAtMs || q.expiresAtMs !== metadata.quoteWindow.expiresAtMs ||
      q.deltaCents !== metadata.totals.deltaCents || q.selected.totalCents !== metadata.totals.selectedLandedCents ||
      order.priceCents !== metadata.totals.bookCents ||
      Object.entries(metadata.product).some(([k,v]) => d.product[k as keyof typeof d.product] !== v)) throw new Error('shipping_terms_mismatch');
  };
  const store: DraftStore = {
    async read(id) { if (id !== intakeId) throw new Error('shipping_authority_mismatch'); const r = await access.store.read(id); if (r) validate(r.record); return r; },
    async createIfAbsent() { throw new Error('settlement_cannot_create'); },
    async updateIfMatch(d, etag) { validate(d); return access.store.updateIfMatch(d, etag); },
  };
  return { store, intakeId, provider, intact, key };
}

/** Three durable stages, intentionally NOT an atomic cross-store transaction:
 * private receipt -> unchanged financial CAS -> shipping projection CAS + authoritative readback.
 * A retry always revisits all stages, including already-paid orders. A missing/ambiguous private
 * receipt records an operator observation and retries; it never poisons the projection permanently.
 * Purchase/notification ownership remains the financial transition; shipping metrics belong to the public commit.
 */
export async function reconcileSignedInitialShipping(event: SignedEventLike, observed: OrderRecord,
  retrieveAccount: () => Promise<{ id: string }>): Promise<{ order: OrderRecord; transitionedToPaid: boolean; completionMetric: import('./analytics-event-contract.ts').ShippingMetricParams | null }> {
  const s = event.data.object;
  // Only absence is repairable; malformed/non-null values never get reset. This local view grants
  // no authority: the real private receipt and financial CAS below must still precede projection.
  const repairableView = (order: OrderRecord): OrderRecord => order.initialShippingSettlement === undefined
    ? { ...order, initialShippingSettlement: { version: 1, state: 'unverified', receiptDigest: null, reason: null, updatedAt: new Date(0).toISOString() } }
    : order;
  const read = readOrderInitialShipping(repairableView(observed));
  const conflict = async (reason: string) => {
    const saved = await recordPaymentSettlementConflict(observed.id, { stripeSessionId: String(s.id),
      amountSubtotalCents: typeof s.amount_subtotal === 'number' ? s.amount_subtotal : null,
      amountTotalCents: typeof s.amount_total === 'number' ? s.amount_total : null, reason });
    if (!saved) throw new Error('shipping_observation_unavailable');
  };
  if (read.kind !== 'present') { await conflict('initial_shipping_metadata_malformed'); throw new Error('shipping_metadata_malformed'); }
  let access: ReturnType<typeof settlementDraftAccess>;
  let account: { id: string };
  try { access = settlementDraftAccess(observed, read.metadata); account = await retrieveAccount(); }
  catch { await conflict('initial_shipping_receipt_unavailable'); throw new Error('shipping_receipt_unavailable'); }
  if (!access.intact() || !/^acct_[A-Za-z0-9]+$/.test(account.id)) throw new Error('shipping_account_unavailable');
  const accountMatches = sha256(account.id) === access.provider.stripeAccountBinding &&
    (event.account == null || event.account === account.id) &&
    event.livemode === access.provider.stripeLivemode &&
    access.key.startsWith(access.provider.stripeLivemode ? 'sk_live_' : 'sk_test_');
  const sessionMatches = typeof s.id === 'string' && observed.stripeSessionId === s.id &&
    (!observed.stripePaymentIntentId || observed.stripePaymentIntentId === s.payment_intent);
  const classified = classifySignedPayment(event, { orderId: observed.id, metadata: read.metadata,
    stripeAccountBinding: access.provider.stripeAccountBinding, stripeLivemode: access.provider.stripeLivemode,
    accountBindingOf: a => sha256(a ?? account.id), expectedSessionId: observed.stripeSessionId || null });
  let c: PaymentClassification & { kind: 'timely' | 'held' } = classified.kind === 'not_paid'
    ? { kind: 'held', reason: 'payment_not_paid', evidence: null } : classified;
  if (!accountMatches || !sessionMatches) c = { kind: 'held', reason: 'payment_evidence_mismatch', evidence: c.evidence };
  if (!Array.isArray(s.payment_method_types) || s.payment_method_types.length !== 1 || s.payment_method_types[0] !== 'card')
    c = { kind: 'held', reason: 'payment_deferred_unsupported', evidence: c.evidence };
  const receipt = await recordPrivateReceipt(access.store, access.intakeId, observed.id, c, Date.now());
  if (!access.intact() || (receipt.outcome === 'held' && receipt.reason === 'receipt_unavailable')) {
    await conflict('initial_shipping_receipt_unavailable'); throw new Error('shipping_receipt_unavailable');
  }
  const privateReadback = await access.store.read(access.intakeId);
  if (!privateReadback || !receipt.draft || JSON.stringify(privateReadback.record) !== JSON.stringify(receipt.draft)) {
    await conflict('initial_shipping_receipt_unavailable'); throw new Error('shipping_receipt_unavailable');
  }
  // Paid-but-mismatched amounts/timing remain financial truth, with shipping held. Wrong account,
  // Session or PI is only an observation: it cannot settle somebody else's obligation.
  const financiallyPaid = accountMatches && sessionMatches && s.payment_status === 'paid' && s.mode === 'payment' &&
    s.currency === 'usd' && typeof s.payment_intent === 'string' && s.payment_intent.length > 0 &&
    Number.isSafeInteger(s.amount_total) && (s.amount_total as number) >= 0;
  const financial = financiallyPaid ? await settleOrderPayment(observed.id, {
    stripeSessionId: s.id as string, stripePaymentIntentId: s.payment_intent as string, settledAmountCents: s.amount_total as number,
  }) : null;
  if (!financial) await conflict('initial_shipping_payment_held');
  const projected = await withOrderTransaction<'invalid' | 'unchanged' | 'held' | 'committed'>(observed.id, current => {
    // Recheck current binding on EVERY CAS attempt; never rebind or revive a reversal.
    const terms = readOrderInitialShipping(repairableView(current));
    if (!access.intact() || current.stripeSessionId !== observed.stripeSessionId || current.checkoutIntentFingerprint !== observed.checkoutIntentFingerprint ||
      terms.kind !== 'present' || JSON.stringify(terms.metadata) !== JSON.stringify(read.metadata)) return { abort: 'invalid' };
    let result = receipt;
    if (result.outcome === 'recorded' && (current.stripePaymentIntentId !== s.payment_intent || current.settledAmountCents !== s.amount_total))
      result = { outcome: 'held', reason: 'receipt_conflict', draft: result.draft };
    const n = nextSettlementProjection(repairableView(current), result, new Date());
    return n.action === 'write' ? { commit: { ...current, initialShippingSettlement: n.settlement }, result: n.settlement.state === 'committed' ? 'committed' : 'held' } : { abort: 'unchanged' };
  }, { notFound: () => 'invalid' });
  const final = await getOrderAuthoritative(observed.id);
  const verified = final && readOrderInitialShipping(final);
  if (projected === 'invalid' || !access.intact() || !final || !verified || verified.kind !== 'present' || verified.settlement.state === 'unverified' ||
    final.stripeSessionId !== observed.stripeSessionId || JSON.stringify(verified.metadata) !== JSON.stringify(read.metadata) ||
    (verified.settlement.state === 'committed' && (receipt.outcome !== 'recorded' || !receipt.draft.payment ||
      verified.settlement.receiptDigest !== receiptDigest(receipt.draft.payment))) ||
    (financiallyPaid && !financial && !terminal(final))) throw new Error('shipping_projection_unavailable');
  // Private intent precedes public commit. Only this exact successful CAS owns delivery;
  // a lost response/readback after commit may lose analytics, never reclaim on replay.
  const completionMetric = projected === 'committed' && shippingCommitted(final) === 'committed' &&
    receipt.outcome === 'recorded' && Number.isSafeInteger(receipt.draft.completionMetricIntentAt)
    ? shippingMetricParams({ service: 'expedited', format: verified.metadata.product.bookFormat,
      outcome: 'paid', pricingRule: verified.metadata.pricingRuleVersion }) : null;
  return { order: final, transitionedToPaid: financial?.transitionedToPaid === true, completionMetric };
}

export interface SignedEventLike {
  readonly id: unknown; readonly type: unknown; readonly created: unknown; readonly livemode: unknown; readonly account?: unknown;
  readonly data: { readonly object: Record<string, unknown> };
}
export interface PaymentExpectation {
  readonly orderId: string; readonly metadata: InitialShippingOrderMetadataV1; readonly stripeAccountBinding: string;
  readonly stripeLivemode: boolean; readonly accountBindingOf: (account: string | null) => string; readonly expectedSessionId: string | null;
}
export type PaymentClassification =
  | { readonly kind: 'timely'; readonly evidence: DraftPaymentEvidence }
  | { readonly kind: 'held'; readonly reason: InitialShippingHoldReason; readonly evidence: DraftPaymentEvidence | null }
  | { readonly kind: 'not_paid' };

export function classifySignedPayment(event: SignedEventLike, exp: PaymentExpectation): PaymentClassification {
  const s = event.data?.object ?? {};
  if (event.type !== 'checkout.session.completed') return { kind: 'not_paid' };
  if (s.payment_status !== 'paid') {
    return s.payment_status === 'unpaid' ? { kind: 'held', reason: 'payment_deferred_unsupported', evidence: null } : { kind: 'not_paid' };
  }
  const meta = (s.metadata ?? {}) as Record<string, unknown>;
  const accountBinding = exp.accountBindingOf(typeof event.account === 'string' ? event.account : null);
  const evidenceOk = typeof event.id === 'string' && typeof s.id === 'string' && typeof s.payment_intent === 'string' && s.currency === 'usd' &&
    Number.isSafeInteger(s.amount_total) && Number.isSafeInteger(s.amount_subtotal);
  const evidence: DraftPaymentEvidence | null = evidenceOk ? Object.freeze({
    accountBinding, livemode: event.livemode === true, sessionId: s.id as string, paymentIntentId: s.payment_intent as string,
    amountTotalCents: s.amount_total as number, amountSubtotalCents: s.amount_subtotal as number, currency: 'usd',
    eventId: event.id as string, eventType: 'checkout.session.completed',
    eventCreatedMs: Number.isSafeInteger(event.created) ? (event.created as number) * 1000 : -1,
  }) : null;
  const held = (reason: InitialShippingHoldReason): PaymentClassification => ({ kind: 'held', reason, evidence });
  if (!evidence) return held('payment_evidence_mismatch');
  if (accountBinding !== exp.stripeAccountBinding || evidence.livemode !== exp.stripeLivemode || s.mode !== 'payment' ||
    s.client_reference_id !== exp.orderId || meta.orderId !== exp.orderId || meta.hsbShipping !== 'initial_expedited_v1' ||
    meta.hsbShippingQuote !== exp.metadata.quoteId || meta.hsbShippingBinding !== exp.metadata.quoteBindingDigest.slice(0, 32) ||
    (exp.expectedSessionId !== null && exp.expectedSessionId !== s.id)) return held('payment_evidence_mismatch');
  const details = (s.total_details ?? {}) as Record<string, unknown>;
  if ((details.amount_discount ?? 0) !== 0) return held('payment_discounted');
  if (s.currency !== 'usd' || (details.amount_tax ?? 0) !== 0 || (details.amount_shipping ?? 0) !== 0 ||
    s.shipping_cost != null || s.shipping_details != null) return held('payment_evidence_mismatch');
  const expected = expectedExpeditedSubtotalCents(exp.metadata);
  if (evidence.amountSubtotalCents !== expected || evidence.amountTotalCents !== expected) return held('payment_amount_mismatch');
  const t = evidence.eventCreatedMs;
  if (t < exp.metadata.quoteWindow.issuedAtMs || t >= exp.metadata.quoteWindow.expiresAtMs) return held('payment_untimely');
  return { kind: 'timely', evidence };
}

export const receiptDigest = (e: DraftPaymentEvidence): string => digestJson(['receipt', e.accountBinding, e.livemode, e.sessionId,
  e.paymentIntentId, e.amountTotalCents, e.amountSubtotalCents, e.currency]);

export type PrivateReceiptResult =
  | { readonly outcome: 'recorded'; readonly draft: InitialShippingDraftV1; readonly firstWinner: boolean }
  | { readonly outcome: 'held'; readonly reason: InitialShippingHoldReason; readonly draft: InitialShippingDraftV1 | null };

/** locked -> payment_recorded (or held), exact reread/adoption; replays of identical evidence converge; conflicts never overwrite. */
export async function recordPrivateReceipt(store: DraftStore, intakeId: string, orderId: string,
  c: PaymentClassification & { kind: 'timely' | 'held' }, now: number): Promise<PrivateReceiptResult> {
  for (let i = 0; i < 4; i++) {
    let cur: Awaited<ReturnType<DraftStore['read']>>;
    try { cur = await store.read(intakeId); } catch { return { outcome: 'held', reason: 'receipt_unavailable', draft: null }; }
    if (!cur || !cur.record.lock || cur.record.lock.canonicalOrderId !== orderId) return { outcome: 'held', reason: 'receipt_unavailable', draft: cur?.record ?? null };
    const d = cur.record;
    if (d.payment) {
      const same = c.evidence && receiptDigest(d.payment) === receiptDigest(c.evidence);
      if (!same) return { outcome: 'held', reason: 'receipt_conflict', draft: d };
      if (d.state === 'payment_recorded') return c.kind === 'held' ? { outcome: 'held', reason: c.reason, draft: d }
        : { outcome: 'recorded', draft: d, firstWinner: false };
      return { outcome: 'held', reason: (d.holdReason as InitialShippingHoldReason) ?? 'receipt_conflict', draft: d };
    }
    if (d.state !== 'locked') return { outcome: 'held', reason: 'receipt_conflict', draft: d };
    const next: InitialShippingDraftV1 = c.kind === 'timely'
      ? { ...d, state: 'payment_recorded', payment: c.evidence, completionMetricIntentAt: now }
      : { ...d, state: 'held', payment: c.evidence, holdReason: c.reason };
    let w: Awaited<ReturnType<DraftStore['updateIfMatch']>>;
    try { w = await store.updateIfMatch(next, cur.etag); } catch { w = 'ambiguous'; }
    if (w === 'written') {
      return c.kind === 'timely' ? { outcome: 'recorded', draft: next, firstWinner: true } : { outcome: 'held', reason: c.reason, draft: next };
    }
    if (w === 'ambiguous') return { outcome: 'held', reason: 'receipt_unavailable', draft: null };
  }
  return { outcome: 'held', reason: 'receipt_unavailable', draft: null };
}

/** Minimal shape of the canonical order the projection applier needs (validated by readOrderInitialShipping). */
export interface SettlementOrderView {
  readonly id: string; readonly paymentStatus?: unknown; readonly refundStatus?: unknown; readonly refundedAt?: unknown;
  readonly initialShipping?: unknown; readonly initialShippingSettlement?: unknown;
  readonly stripeRefundId?: unknown; readonly refundClaimId?: unknown;
}
const terminal = (o: SettlementOrderView) => o.paymentStatus === 'refunded' || o.paymentStatus === 'failed' ||
  o.paymentStatus === 'partially_refunded' || Boolean(o.stripeRefundId) || Boolean(o.refundClaimId) ||
  (o.refundStatus != null && o.refundStatus !== 'none') || o.refundedAt != null;

/** Pure next-projection computation for use inside the unchanged canonical transaction `mutate` callback. */
export function nextSettlementProjection(order: SettlementOrderView, result: PrivateReceiptResult, now: Date):
  { readonly action: 'write'; readonly settlement: InitialShippingSettlementV1 } | { readonly action: 'none' } {
  const read = readOrderInitialShipping(order);
  if (read.kind === 'absent') return { action: 'none' };
  const at = now.toISOString();
  if (read.kind === 'malformed') return { action: 'none' }; // malformed is surfaced as hold by readers; never repaired to standard
  const cur = read.settlement;
  if (terminal(order)) {
    if (cur.state === 'held' && cur.reason === 'refund_or_terminal') return { action: 'none' };
    return { action: 'write', settlement: { version: 1, state: 'held', receiptDigest: cur.receiptDigest, reason: 'refund_or_terminal', updatedAt: at } };
  }
  if (cur.state === 'held') return { action: 'none' }; // held never auto-upgrades
  if (result.outcome === 'recorded' && result.draft.payment && order.paymentStatus === 'paid') {
    const digest = receiptDigest(result.draft.payment);
    if (cur.state === 'committed') return cur.receiptDigest === digest ? { action: 'none' }
      : { action: 'write', settlement: { version: 1, state: 'held', receiptDigest: cur.receiptDigest, reason: 'receipt_conflict', updatedAt: at } };
    return { action: 'write', settlement: { version: 1, state: 'committed', receiptDigest: digest, reason: null, updatedAt: at } };
  }
  if (result.outcome === 'held') {
    const digest = result.draft?.payment ? receiptDigest(result.draft.payment) : null;
    if (cur.state === 'committed' && result.reason === 'receipt_unavailable') return { action: 'none' };
    return { action: 'write', settlement: { version: 1, state: 'held', receiptDigest: digest, reason: result.reason, updatedAt: at } };
  }
  return { action: 'none' };
}

/** The committed-shipping gate used by confirmation claimability and fulfillment. */
export function shippingCommitted(order: SettlementOrderView): 'standard' | 'committed' | 'not_committed' {
  const read = readOrderInitialShipping(order);
  if (read.kind === 'absent') return 'standard';
  if (read.kind === 'malformed') return 'not_committed';
  return order.paymentStatus === 'paid' && read.settlement.state === 'committed' && !terminal(order) && parseInitialShippingSettlement(order.initialShippingSettlement)
    ? 'committed' : 'not_committed';
}

/** Full convergence: classify -> private receipt -> canonical projection. Reached BEFORE any already-paid early exit. */
export async function settleExpeditedPayment(args: {
  event: SignedEventLike; expectation: PaymentExpectation; draftStore: DraftStore; intakeId: string; now: () => number;
  /** Runs the unchanged canonical transaction; the callback must be synchronous and return the next order or null. */
  applyToOrder: (mutate: (order: SettlementOrderView) => InitialShippingSettlementV1 | null) => Promise<'committed' | 'aborted' | 'unavailable'>;
}): Promise<{ readonly projection: 'committed' | 'held' | 'none'; readonly scheduleCompletionMetric: boolean }> {
  const c = classifySignedPayment(args.event, args.expectation);
  if (c.kind === 'not_paid') return { projection: 'none', scheduleCompletionMetric: false };
  const priv = await recordPrivateReceipt(args.draftStore, args.intakeId, args.expectation.orderId, c, args.now());
  let wrote: InitialShippingSettlementV1 | null = null;
  const status = await args.applyToOrder((order) => {
    const n = nextSettlementProjection(order, priv, new Date(args.now()));
    wrote = n.action === 'write' ? n.settlement : null;
    return wrote;
  });
  const final = wrote as InitialShippingSettlementV1 | null;
  const projection = status === 'committed' && final ? final.state === 'committed' ? 'committed' : 'held' : 'none';
  return { projection, scheduleCompletionMetric: priv.outcome === 'recorded' && priv.firstWinner && projection === 'committed' };
}
