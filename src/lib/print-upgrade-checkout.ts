/**
 * Customer digital-to-print upgrade — price-locked CHECKOUT and SETTLEMENT.
 *
 * The customer pays exactly one provider-cost quote. This module:
 *   - opens a Stripe Checkout Session for exactly the quote's components,
 *     with a deterministic per-(order, quote) idempotency key, and binds the
 *     Session durably (`printUpgradeLock`) BEFORE releasing its URL;
 *   - reuses an open Session on a duplicate click instead of minting another;
 *   - settles ONLY the exact bound Session for the exact locked amount from
 *     the signed webhook, consuming the one-use offer in the same commit;
 *   - records every other settlement as a conflict and leaves the order
 *     untouched for operator reconciliation.
 *
 * It never starts fulfillment, never prepares print files, never submits a
 * print job and never sends email. The retail price-difference calculator in
 * print-upgrades.ts is not consulted anywhere here.
 */
import {
  getBookFormatMeta,
  withOrderTransaction,
  type OrderRecord,
  type PrintCopyPurchaseV1,
  type PrintUpgradeLockV1,
  type PrintUpgradeQuoteV1,
  type ShippingAddress,
} from './orders.ts';
import {
  authorizePrintUpgradeOffer,
  isPrintUpgradeTargetFormat,
  type PrintUpgradeOfferDenial,
  type PrintUpgradeTargetFormat,
} from './print-upgrade-offer.ts';
import { isPrintUpgradeLockLive } from './print-upgrade-lock.ts';
import { isQuoteLive } from './print-upgrade-quote.ts';
import { recordPrintUpgradeSettlementConflict } from './print-upgrades.ts';

export const PRINT_UPGRADE_STRIPE_KIND = 'print_upgrade_at_cost';
/** Stripe allows 30 minutes to 24 hours. */
export const PRINT_UPGRADE_CHECKOUT_SESSION_TTL_MS = 60 * 60 * 1000;
/**
 * Card only. Every payment method that can leave `checkout.session.completed`
 * with `payment_status: 'unpaid'` and settle later through
 * `checkout.session.async_payment_succeeded` (bank debits, vouchers, BNPL) is
 * excluded, so the one settlement path here — exact `paid` facts on the
 * completed event — is the only path Stripe can take.
 */
export const PRINT_UPGRADE_PAYMENT_METHOD_TYPES: readonly ['card'] = ['card'];

/**
 * Stripe error `type`s that mean the create request was REJECTED before any
 * Session could be made (bad params, bad key, no permission). A rate-limit
 * response is treated as ambiguous, since the outcome of a retried request
 * should never be used to justify opening a second payable Session.
 * Everything else — connection errors, 5xx, idempotency-key conflicts, unknown
 * throwables — is AMBIGUOUS: the Session may exist, so its lock stays put
 * until a same-key retry resolves it or its `expires_at` passes.
 */
const STRIPE_CREATE_REJECTED_TYPES: ReadonlySet<string> = new Set([
  'StripeInvalidRequestError',
  'StripeAuthenticationError',
  'StripePermissionError',
]);

/**
 * Adapters may throw this to assert that the provider definitely did not
 * create a Session (the lib then releases the lock at once).
 */
export class PrintUpgradeCheckoutCreateRejectedError extends Error {
  readonly sessionCreated = false as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PrintUpgradeCheckoutCreateRejectedError';
  }
}

/** Pure: did this create failure prove that no Session was created? */
export function checkoutCreateWasRejected(error: unknown): boolean {
  if (error instanceof PrintUpgradeCheckoutCreateRejectedError) return true;
  if (!error || typeof error !== 'object') return false;
  const type = (error as { type?: unknown }).type;
  return typeof type === 'string' && STRIPE_CREATE_REJECTED_TYPES.has(type);
}

export interface PrintUpgradeCheckoutLineItem {
  price_data: {
    currency: 'usd';
    unit_amount: number;
    product_data: { name: string; description?: string };
  };
  quantity: 1;
}

/** Exactly the Stripe `checkout.sessions.create` params the adapter forwards. */
export interface PrintUpgradeCheckoutSessionCreate {
  mode: 'payment';
  payment_method_types: ['card'];
  allow_promotion_codes: false;
  customer_email: string;
  client_reference_id: string;
  metadata: Record<string, string>;
  payment_intent_data: { metadata: Record<string, string> };
  line_items: PrintUpgradeCheckoutLineItem[];
  expires_at: number;
  success_url: string;
  cancel_url: string;
}

export type CreatePrintUpgradeCheckoutSession = (
  params: PrintUpgradeCheckoutSessionCreate,
  idempotencyKey: string,
) => Promise<{ id: string; url?: string | null }>;

export interface PrintUpgradeCheckoutSessionLike {
  id: string;
  mode?: string | null;
  payment_status?: string | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  payment_intent?: string | { id?: string | null } | null;
  metadata?: Record<string, string> | null;
}

export function printUpgradeCheckoutIdempotencyKey(orderId: string, quoteId: string): string {
  return `print-upgrade-at-cost:${orderId}:${quoteId}`;
}

function formatLabel(targetFormat: PrintUpgradeTargetFormat): string {
  return targetFormat === 'premium' ? 'Premium hardcover' : 'Classic softcover';
}

export function buildPrintUpgradeCheckoutLineItems(quote: PrintUpgradeQuoteV1): PrintUpgradeCheckoutLineItem[] {
  const label = formatLabel(quote.targetFormat);
  const components: Array<{ name: string; description: string; amount: number }> = [
    {
      name: `${label} print — at cost`,
      description: `Our print provider's charge for ${quote.quantity ?? 1} ${label.toLowerCase()} ${quote.quantity === 1 ? 'copy' : 'copies'} (${quote.pageCount} interior pages each). No markup.`,
      amount: quote.printCents,
    },
    { name: 'Shipping and handling — at cost', description: 'Provider shipping and handling to the address you confirmed.', amount: quote.shippingCents },
    { name: 'Provider fulfillment fee — at cost', description: 'Provider order-processing fee, passed through unchanged.', amount: quote.fulfillmentCents },
    { name: 'Sales tax — at cost', description: 'Tax the provider charges on this print order, passed through unchanged.', amount: quote.taxCents },
  ];
  return components
    .filter((c) => c.amount > 0)
    .map((c) => ({
      price_data: { currency: 'usd', unit_amount: c.amount, product_data: { name: c.name, description: c.description } },
      quantity: 1,
    }));
}

export interface OpenPrintUpgradeCheckoutInput {
  token: string | null | undefined;
  quoteId: unknown;
}

export interface OpenPrintUpgradeCheckoutDeps {
  createCheckoutSession: CreatePrintUpgradeCheckoutSession;
  baseUrl: string;
  now?: string;
}

export interface OpenCheckoutSummary {
  targetFormat: PrintUpgradeTargetFormat;
  totalCents: number;
  url: string | null;
  expiresAt: string;
}

export type OpenPrintUpgradeCheckoutResult =
  | { ok: true; url: string; stripeSessionId: string; lock: PrintUpgradeLockV1; reused: boolean }
  | { ok: false; reason: PrintUpgradeOfferDenial | 'quote_not_found' | 'quote_expired' | 'delivery_unavailable' | 'order_not_found' | 'provider_failed' | 'checkout_busy' }
  | { ok: false; reason: 'checkout_already_open'; open: OpenCheckoutSummary };

type ClaimOutcome =
  | { kind: 'proceed'; lock: PrintUpgradeLockV1; quote: PrintUpgradeQuoteV1; order: OrderRecord }
  | { kind: 'done'; result: OpenPrintUpgradeCheckoutResult };

function lockIsOpenNow(lock: PrintUpgradeLockV1, nowMs: number): boolean {
  return lock.status === 'open' && Boolean(lock.stripeSessionId) && Date.parse(lock.expiresAt) > nowMs;
}

function supersededIds(lock: PrintUpgradeLockV1 | null | undefined): string[] {
  if (!lock) return [];
  const prior = lock.supersededStripeSessionIds ?? [];
  return lock.stripeSessionId ? [...prior, lock.stripeSessionId] : [...prior];
}

/**
 * Durable record of a failed provider create for one `provisioning` lock.
 *
 * - `rejected`: the provider proved no Session was created. The lock is
 *   released (`expired`, no Session id) in the same commit, so re-quote,
 *   re-offer and a different-quote checkout are possible immediately.
 * - `ambiguous`: the Session may exist. The lock stays `provisioning` and
 *   keeps its idempotency key; only a same-key retry or the Session TTL may
 *   end it. Nothing else may open a payable Session for this offer meanwhile.
 *
 * Best-effort: a persistence failure here is logged and never masks the
 * `provider_failed` answer the customer already gets.
 */
async function recordCheckoutCreateFailure(
  orderId: string,
  lock: PrintUpgradeLockV1,
  outcome: 'rejected' | 'ambiguous',
  now: string,
): Promise<void> {
  try {
    await withOrderTransaction<null>(
      orderId,
      (current) => {
        const pending = current.printUpgradeLock ?? null;
        if (!pending || pending.status !== 'provisioning' || pending.quoteId !== lock.quoteId || pending.idempotencyKey !== lock.idempotencyKey) {
          return { abort: null };
        }
        const released: PrintUpgradeLockV1 | null = outcome === 'rejected' ? { ...pending, status: 'expired' } : null;
        return {
          commit: {
            ...current,
            ...(released ? { printUpgradeLock: released } : {}),
            auditEvents: [
              ...(current.auditEvents ?? []),
              {
                at: now,
                type: 'print_upgrade_checkout_create_failed',
                meta: { offerId: pending.offerId, quoteId: pending.quoteId, targetFormat: pending.targetFormat, outcome, lockReleased: Boolean(released) },
              },
            ],
            updatedAt: now,
          },
          result: null,
        };
      },
      { notFound: () => null },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[print-upgrade] could not record checkout create failure for ${orderId}: ${message.slice(0, 200)}`);
  }
}

/**
 * Opens (or reuses) the payable Session for one quote. Two guarded commits
 * bracket the provider call: a `provisioning` claim that fixes the price and
 * idempotency key, then a bind that releases the URL only once the Session id
 * is durable on the order.
 */
export async function openPrintUpgradeCheckout(
  orderId: string,
  input: OpenPrintUpgradeCheckoutInput,
  deps: OpenPrintUpgradeCheckoutDeps,
): Promise<OpenPrintUpgradeCheckoutResult> {
  const now = deps.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const nowDate = new Date(now);
  const quoteId = typeof input.quoteId === 'string' ? input.quoteId.trim() : '';

  const claim = await withOrderTransaction<ClaimOutcome>(
    orderId,
    (current) => {
      const access = authorizePrintUpgradeOffer(current, input.token, nowDate);
      if (access.ok === false) return { abort: { kind: 'done', result: { ok: false, reason: access.reason } } };
      const offer = access.offer;
      const quote = quoteId
        ? (current.printUpgradeQuotes ?? []).find((q) => q.quoteId === quoteId && q.offerId === offer.offerId) ?? null
        : null;
      if (!quote) return { abort: { kind: 'done', result: { ok: false, reason: 'quote_not_found' } } };
      if (!isQuoteLive(quote, nowDate)) return { abort: { kind: 'done', result: { ok: false, reason: 'quote_expired' } } };
      if (!quote.estimatedDeliveryStart || !quote.estimatedDeliveryEnd || quote.estimatedDeliveryStart > quote.estimatedDeliveryEnd) {
        return { abort: { kind: 'done', result: { ok: false, reason: 'delivery_unavailable' } } };
      }

      const existing = current.printUpgradeLock ?? null;
      if (existing && existing.offerId === offer.offerId) {
        if (lockIsOpenNow(existing, nowMs)) {
          if (existing.quoteId === quote.quoteId && existing.stripeSessionId && existing.checkoutUrl) {
            return { abort: { kind: 'done', result: { ok: true, url: existing.checkoutUrl, stripeSessionId: existing.stripeSessionId, lock: existing, reused: true } } };
          }
          return {
            abort: {
              kind: 'done',
              result: {
                ok: false,
                reason: 'checkout_already_open',
                open: { targetFormat: existing.targetFormat, totalCents: existing.totalCents, url: existing.checkoutUrl, expiresAt: existing.expiresAt },
              },
            },
          };
        }
        if (existing.status === 'provisioning' && existing.quoteId === quote.quoteId) {
          // Retry the SAME Stripe idempotency key without extending the
          // original Session expiry or changing its locked parameters. If the
          // earlier attempt did create a Session, Stripe hands back that one;
          // it never mints a second.
          return {
            abort: { kind: 'proceed', lock: existing, quote, order: current },
          };
        }
        if (existing.status === 'provisioning' && isPrintUpgradeLockLive(existing, nowMs)) {
          // A different quote while an earlier create's outcome is unknown:
          // a payable Session for the earlier quote may exist until its
          // `expires_at`. Opening another would risk two payable Sessions.
          return { abort: { kind: 'done', result: { ok: false, reason: 'checkout_busy' } } };
        }
        if (existing.status === 'paid') {
          return { abort: { kind: 'done', result: { ok: false, reason: 'print_upgrade_already_paid' } } };
        }
        // `expired`, or `open`/`provisioning` past the Session TTL: no payable
        // Session can come of it any more, so a fresh lock supersedes it.
      }

      const lock: PrintUpgradeLockV1 = {
        version: 1,
        quoteId: quote.quoteId,
        purchaseKind: offer.purchaseKind ?? 'upgrade',
        quantity: quote.quantity ?? 1,
        approvedSourceSha256: offer.approvedSource.sha256,
        offerId: offer.offerId,
        targetFormat: quote.targetFormat,
        totalCents: quote.totalCents,
        currency: 'usd',
        status: 'provisioning',
        stripeSessionId: null,
        checkoutUrl: null,
        idempotencyKey: printUpgradeCheckoutIdempotencyKey(orderId, quote.quoteId),
        recipientName: quote.shippingAddress.name,
        openedAt: now,
        expiresAt: new Date(nowMs + PRINT_UPGRADE_CHECKOUT_SESSION_TTL_MS).toISOString(),
        paidAt: null,
        stripePaymentIntentId: null,
        supersededStripeSessionIds: supersededIds(existing),
      };
      return {
        commit: { ...current, printUpgradeLock: lock, updatedAt: now },
        result: { kind: 'proceed', lock, quote, order: current },
      };
    },
    { notFound: () => ({ kind: 'done', result: { ok: false, reason: 'order_not_found' } }) },
  );
  if (claim.kind === 'done') return claim.result;

  const { lock, quote, order } = claim;
  const params: PrintUpgradeCheckoutSessionCreate = {
    mode: 'payment',
    payment_method_types: [...PRINT_UPGRADE_PAYMENT_METHOD_TYPES],
    allow_promotion_codes: false,
    customer_email: order.email,
    client_reference_id: orderId,
    metadata: {
      kind: PRINT_UPGRADE_STRIPE_KIND,
      orderId,
      offerId: lock.offerId,
      quoteId: lock.quoteId,
      targetFormat: lock.targetFormat,
      purchaseKind: lock.purchaseKind,
      quantity: String(lock.quantity),
      approvedSourceSha256: lock.approvedSourceSha256,
    },
    payment_intent_data: { metadata: { orderId, kind: PRINT_UPGRADE_STRIPE_KIND, quoteId: lock.quoteId, purchaseKind: lock.purchaseKind, quantity: String(lock.quantity) } },
    line_items: buildPrintUpgradeCheckoutLineItems(quote),
    expires_at: Math.floor(Date.parse(lock.expiresAt) / 1000),
    success_url: `${deps.baseUrl}/upgrade/${orderId}/done?sessionId={CHECKOUT_SESSION_ID}`,
    cancel_url: `${deps.baseUrl}/upgrade/${orderId}/cancelled`,
  };

  let session: { id: string; url?: string | null };
  try {
    session = await deps.createCheckoutSession(params, lock.idempotencyKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = checkoutCreateWasRejected(error) ? 'rejected' : 'ambiguous';
    console.error(`[print-upgrade] checkout create failed (${outcome}) for ${orderId}: ${message.slice(0, 200)}`);
    await recordCheckoutCreateFailure(orderId, lock, outcome, now);
    return { ok: false, reason: 'provider_failed' };
  }
  if (!session?.id || !/^cs_[A-Za-z0-9_]{1,255}$/.test(session.id) || !session.url) {
    // Something may have been created; treat as ambiguous so the same-key
    // retry (or the Session TTL) resolves it rather than a second create.
    console.error(`[print-upgrade] checkout create returned an unusable Session for ${orderId}`);
    await recordCheckoutCreateFailure(orderId, lock, 'ambiguous', now);
    return { ok: false, reason: 'provider_failed' };
  }
  const url = session.url;

  return withOrderTransaction<OpenPrintUpgradeCheckoutResult>(
    orderId,
    (current) => {
      const access = authorizePrintUpgradeOffer(current, input.token, nowDate);
      if (access.ok === false) return { abort: { ok: false, reason: access.reason } };
      const pending = current.printUpgradeLock ?? null;
      if (!pending || pending.quoteId !== lock.quoteId || pending.idempotencyKey !== lock.idempotencyKey) {
        return { abort: { ok: false, reason: 'checkout_busy' } };
      }
      if (pending.status === 'open' && pending.stripeSessionId === session.id && pending.checkoutUrl) {
        return { abort: { ok: true, url: pending.checkoutUrl, stripeSessionId: session.id, lock: pending, reused: true } };
      }
      if (pending.status !== 'provisioning') return { abort: { ok: false, reason: 'checkout_busy' } };
      const bound: PrintUpgradeLockV1 = { ...pending, status: 'open', stripeSessionId: session.id, checkoutUrl: url };
      const updated: OrderRecord = {
        ...current,
        printUpgradeLock: bound,
        printUpgradeStatus: 'checkout_open',
        printUpgradeStripeSessionId: session.id,
        printUpgradeTargetFormat: bound.targetFormat,
        printUpgradeAmountCents: bound.totalCents,
        printUpgradePrintProvider: 'lulu',
        auditEvents: [
          ...(current.auditEvents ?? []),
          {
            at: now,
            type: 'print_upgrade_checkout_opened',
            meta: {
              offerId: bound.offerId,
              quoteId: bound.quoteId,
              targetFormat: bound.targetFormat,
              totalCents: bound.totalCents,
              stripeSessionId: session.id,
              expiresAt: bound.expiresAt,
            },
          },
        ],
        updatedAt: now,
      };
      return { commit: updated, result: { ok: true, url, stripeSessionId: session.id, lock: bound, reused: false } };
    },
    { notFound: () => ({ ok: false, reason: 'order_not_found' }) },
  );
}

// ── Settlement (signed webhook only) ────────────────────────────────────────

export type SettlePrintUpgradeResult =
  | { outcome: 'paid'; order: OrderRecord }
  | { outcome: 'replay' }
  | { outcome: 'conflict_recorded'; reason: string }
  | { outcome: 'conflict_unrecorded'; reason: string }
  | { outcome: 'order_not_found' }
  | { outcome: 'invalid_metadata' };

function paymentIntentId(session: PrintUpgradeCheckoutSessionLike): string | null {
  if (typeof session.payment_intent === 'string') return session.payment_intent || null;
  const id = session.payment_intent?.id;
  return typeof id === 'string' && id ? id : null;
}

function stripName(address: ShippingAddress & { name: string }): ShippingAddress {
  return { line1: address.line1, line2: address.line2 ?? null, city: address.city, state: address.state, zip: address.zip, country: address.country };
}

function settlementMismatch(
  current: OrderRecord,
  session: PrintUpgradeCheckoutSessionLike,
  orderId: string,
  quoteId: string,
  targetFormat: PrintUpgradeTargetFormat,
): { reason: string } | { lock: PrintUpgradeLockV1; quote: PrintUpgradeQuoteV1 } {
  const lock = current.printUpgradeLock ?? null;
  if (!lock || !lock.stripeSessionId) return { reason: 'no_open_checkout_lock' };
  if (lock.stripeSessionId !== session.id) return { reason: 'stripe_session_binding_mismatch' };
  if (lock.status !== 'open') return { reason: `lock_status_${lock.status}` };
  if (lock.quoteId !== quoteId) return { reason: 'quote_binding_mismatch' };
  if (lock.targetFormat !== targetFormat) return { reason: 'target_format_mismatch' };
  if (session.metadata?.purchaseKind && session.metadata.purchaseKind !== lock.purchaseKind) return { reason: 'purchase_kind_mismatch' };
  if (session.metadata?.quantity && session.metadata.quantity !== String(lock.quantity)) return { reason: 'quantity_mismatch' };
  if (session.metadata?.approvedSourceSha256 && session.metadata.approvedSourceSha256 !== lock.approvedSourceSha256) return { reason: 'source_mismatch' };
  const offer = current.printUpgradeOffer ?? null;
  if (!offer || offer.offerId !== lock.offerId) return { reason: 'offer_binding_mismatch' };
  if (session.metadata?.offerId && session.metadata.offerId !== lock.offerId) return { reason: 'session_offer_mismatch' };
  if (offer.approvedSource.sha256 !== lock.approvedSourceSha256) return { reason: 'source_changed' };
  if (offer.approvedProofVersion && (current.proofVersion !== offer.approvedProofVersion || current.proofApprovedAt !== offer.approvedProofAt || current.proofReviewedVersion !== offer.approvedProofVersion)) return { reason: 'proof_changed' };
  if (offer.revokedAt) return { reason: 'offer_revoked' };
  if (offer.consumedAt) return { reason: 'offer_consumed' };
  if (current.paymentStatus !== 'paid') return { reason: 'original_order_not_paid' };
  if (current.refundedAt || current.stripeRefundId || current.refundClaimId) return { reason: 'order_refunded' };
  if (lock.purchaseKind === 'upgrade' && current.bookFormat !== 'digital') return { reason: 'not_digital_order' };
  if (lock.purchaseKind === 'upgrade' && current.printJobId) return { reason: 'print_job_exists' };
  const quote = (current.printUpgradeQuotes ?? []).find((q) => q.quoteId === quoteId && q.offerId === lock.offerId) ?? null;
  if (!quote) return { reason: 'quote_missing' };
  if (quote.totalCents !== lock.totalCents || quote.targetFormat !== lock.targetFormat) return { reason: 'quote_lock_mismatch' };
  if ((quote.quantity ?? 1) !== lock.quantity) return { reason: 'quote_quantity_mismatch' };
  const exact =
    session.mode === 'payment'
    && session.payment_status === 'paid'
    && session.client_reference_id === orderId
    && session.metadata?.orderId === orderId
    && session.currency?.toLowerCase() === 'usd'
    && session.amount_subtotal === lock.totalCents
    && session.amount_total === lock.totalCents;
  if (!exact) return { reason: 'settlement_facts_mismatch' };
  return { lock, quote };
}

/**
 * Applies a `checkout.session.completed` for `kind=print_upgrade_at_cost`.
 * Caller has already verified the Stripe signature. Idempotent by Session id.
 */
export async function settlePrintUpgradeAtCostSession(
  session: PrintUpgradeCheckoutSessionLike,
  opts: { now?: string } = {},
): Promise<SettlePrintUpgradeResult> {
  const now = opts.now ?? new Date().toISOString();
  const meta = session.metadata ?? {};
  const orderId = typeof meta.orderId === 'string' ? meta.orderId : '';
  const quoteId = typeof meta.quoteId === 'string' ? meta.quoteId : '';
  const targetFormat = meta.targetFormat;
  if (meta.kind !== PRINT_UPGRADE_STRIPE_KIND || !orderId || !quoteId || !isPrintUpgradeTargetFormat(targetFormat)) {
    return { outcome: 'invalid_metadata' };
  }

  type Outcome = { kind: 'paid'; order: OrderRecord } | { kind: 'replay' } | { kind: 'conflict'; reason: string } | { kind: 'not_found' };
  const outcome = await withOrderTransaction<Outcome>(
    orderId,
    (current) => {
      if ((current.printCopyPurchases ?? []).some((purchase) => purchase.stripeSessionId === session.id)) {
        return { abort: { kind: 'replay' } };
      }
      if (current.printUpgradeStatus === 'paid' && current.printUpgradeStripeSessionId === session.id) {
        return { abort: { kind: 'replay' } };
      }
      const checked = settlementMismatch(current, session, orderId, quoteId, targetFormat);
      if ('reason' in checked) return { abort: { kind: 'conflict', reason: checked.reason } };
      const { lock, quote } = checked;
      const label = getBookFormatMeta(targetFormat).label;
      const purchase = {
        version: 1 as const,
        kind: lock.purchaseKind,
        offerId: lock.offerId,
        quoteId: lock.quoteId,
        approvedSourceSha256: lock.approvedSourceSha256,
        approvedProofVersion: current.printUpgradeOffer?.approvedProofVersion ?? null,
        approvedProofAt: current.printUpgradeOffer?.approvedProofAt ?? null,
        targetFormat,
        quantity: lock.quantity,
        totalCents: lock.totalCents,
        currency: 'usd' as const,
        stripeSessionId: session.id,
        stripePaymentIntentId: paymentIntentId(session),
        shippingAddress: quote.shippingAddress,
        estimatedDeliveryStart: quote.estimatedDeliveryStart ?? '',
        estimatedDeliveryEnd: quote.estimatedDeliveryEnd ?? '',
        paidAt: now,
        printJobId: null,
        printStatus: 'awaiting_files' as const,
      };
      const updated: OrderRecord = {
        ...current,
        ...(lock.purchaseKind === 'upgrade' ? {
          bookFormat: targetFormat,
          formatLabel: label,
          deliveryExpectation: `${label} prints only after you confirm the final print proof by email; we confirm again before anything prints and when it ships.`,
          shippingAddress: stripName(quote.shippingAddress),
        } : {}),
        printCopyPurchases: [...(current.printCopyPurchases ?? []), purchase],
        printUpgradeStatus: 'paid',
        printUpgradeSourceFormat: 'digital',
        printUpgradeTargetFormat: targetFormat,
        printUpgradeAmountCents: session.amount_total ?? lock.totalCents,
        printUpgradeStripeSessionId: session.id,
        printUpgradePaidAt: now,
        printUpgradePrintProvider: 'lulu',
        printUpgradeOffer: { ...current.printUpgradeOffer!, consumedAt: now },
        printUpgradeLock: { ...lock, status: 'paid', paidAt: now, stripePaymentIntentId: paymentIntentId(session) },
        auditEvents: [
          ...(current.auditEvents ?? []),
          {
            at: now,
            type: 'print_upgrade_at_cost_paid',
            meta: {
              offerId: lock.offerId,
              quoteId: lock.quoteId,
              targetFormat,
              purchaseKind: lock.purchaseKind,
              quantity: lock.quantity,
              approvedSourceSha256: lock.approvedSourceSha256,
              stripeSessionId: session.id,
              stripePaymentIntentId: paymentIntentId(session),
              amountSubtotalCents: session.amount_subtotal ?? null,
              amountTotalCents: session.amount_total ?? null,
              printCents: quote.printCents,
              shippingCents: quote.shippingCents,
              fulfillmentCents: quote.fulfillmentCents,
              taxCents: quote.taxCents,
              provider: 'lulu',
              printFilesPrepared: false,
              printSubmitted: false,
            },
          },
        ],
        updatedAt: now,
      };
      return { commit: updated, result: { kind: 'paid', order: updated } };
    },
    { notFound: () => ({ kind: 'not_found' }) },
  );

  if (outcome.kind === 'paid') return { outcome: 'paid', order: outcome.order };
  if (outcome.kind === 'replay') return { outcome: 'replay' };
  if (outcome.kind === 'not_found') return { outcome: 'order_not_found' };
  console.error(`[print-upgrade] settlement refused for ${orderId} session=${session.id}: ${outcome.reason}`);
  const recorded = await recordPrintUpgradeSettlementConflict(orderId, {
    stripeSessionId: session.id,
    targetFormat,
    amountSubtotalCents: session.amount_subtotal ?? null,
    amountTotalCents: session.amount_total ?? null,
    reason: outcome.reason,
  });
  if (!recorded) return { outcome: 'conflict_unrecorded', reason: outcome.reason };
  return { outcome: 'conflict_recorded', reason: outcome.reason };
}

/** Print-go must call this against current order state, not trust payment alone. */
export function printPurchaseApprovalIsCurrent(order: OrderRecord, purchase: PrintCopyPurchaseV1, approvedSourceFileSha256: string): boolean {
  if (purchase.printStatus !== 'awaiting_files' && purchase.printStatus !== 'ready_for_print') return false;
  if (purchase.approvedSourceSha256 !== approvedSourceFileSha256) return false;
  if (purchase.approvedProofVersion) {
    return order.proofVersion === purchase.approvedProofVersion
      && order.proofReviewedVersion === purchase.approvedProofVersion
      && order.proofApprovedAt === purchase.approvedProofAt;
  }
  // Legacy/manual owner approvals need a separately verified immutable file
  // hash; without one they remain HOLD even if the payment has settled.
  return Boolean(approvedSourceFileSha256);
}

// ── Expiry (signed webhook `checkout.session.expired`) ───────────────────────

export type ExpirePrintUpgradeResult =
  | { outcome: 'expired' }
  | { outcome: 'ignored' }
  | { outcome: 'order_not_found' }
  | { outcome: 'invalid_metadata' };

export async function recordPrintUpgradeCheckoutExpired(
  session: { id: string; metadata?: Record<string, string> | null },
  opts: { now?: string } = {},
): Promise<ExpirePrintUpgradeResult> {
  const now = opts.now ?? new Date().toISOString();
  const orderId = session.metadata?.orderId;
  if (session.metadata?.kind !== PRINT_UPGRADE_STRIPE_KIND || typeof orderId !== 'string' || !orderId) {
    return { outcome: 'invalid_metadata' };
  }
  return withOrderTransaction<ExpirePrintUpgradeResult>(
    orderId,
    (current) => {
      const lock = current.printUpgradeLock ?? null;
      if (!lock || lock.status !== 'open' || lock.stripeSessionId !== session.id) return { abort: { outcome: 'ignored' } };
      if (current.printUpgradeStatus === 'paid') return { abort: { outcome: 'ignored' } };
      const updated: OrderRecord = {
        ...current,
        printUpgradeLock: { ...lock, status: 'expired' },
        printUpgradeStatus: 'offered',
        printUpgradeStripeSessionId: null,
        printUpgradeTargetFormat: null,
        printUpgradeAmountCents: null,
        auditEvents: [
          ...(current.auditEvents ?? []),
          { at: now, type: 'print_upgrade_checkout_expired', meta: { quoteId: lock.quoteId, stripeSessionId: session.id } },
        ],
        updatedAt: now,
      };
      return { commit: updated, result: { outcome: 'expired' } };
    },
    { notFound: () => ({ outcome: 'order_not_found' }) },
  );
}

// ── Read model for the post-payment page ────────────────────────────────────

export type PrintUpgradeCheckoutStatusView =
  | { status: 'paid'; targetFormat: PrintUpgradeTargetFormat; amountTotalCents: number }
  | { status: 'pending'; targetFormat: PrintUpgradeTargetFormat }
  | { status: 'expired' }
  | { status: 'unknown' };

/** Never includes names, emails or addresses; the Session id is the only key. */
export function printUpgradeCheckoutStatusView(order: OrderRecord, sessionId: string | null | undefined, now: Date = new Date()): PrintUpgradeCheckoutStatusView {
  const prior = (order.printCopyPurchases ?? []).find((purchase) => purchase.stripeSessionId === sessionId);
  if (prior) return { status: 'paid', targetFormat: prior.targetFormat, amountTotalCents: prior.totalCents };
  const lock = order.printUpgradeLock ?? null;
  if (!sessionId || !lock || lock.stripeSessionId !== sessionId) return { status: 'unknown' };
  if (lock.status === 'paid' && order.printUpgradeStatus === 'paid' && order.printUpgradeStripeSessionId === sessionId) {
    return { status: 'paid', targetFormat: lock.targetFormat, amountTotalCents: order.printUpgradeAmountCents ?? lock.totalCents };
  }
  // An `open` lock past the Session TTL is expired even if the
  // `checkout.session.expired` webhook never reached us.
  if (lock.status === 'open' && isPrintUpgradeLockLive(lock, now.getTime())) return { status: 'pending', targetFormat: lock.targetFormat };
  if (lock.status === 'open' || lock.status === 'expired') return { status: 'expired' };
  return { status: 'unknown' };
}
