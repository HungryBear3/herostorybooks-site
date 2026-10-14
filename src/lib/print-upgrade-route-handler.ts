/**
 * HTTP handlers for the customer at-cost print upgrade and the operator offer
 * action. Kept in lib (not in route files) so node:test can execute the exact
 * production handlers; the route files are thin adapters that supply the
 * Next/Stripe/Lulu boundaries.
 *
 * Customer privacy contract: the bearer token travels in the JSON body (never
 * the URL), every denial — unknown order, bad token, expired, consumed,
 * refunded — is the same 404 `{ error: 'not_found' }`, and no response carries
 * an email address, a shipping address, or the token.
 */
import { isAdminAuthedFromRequest } from './admin-auth.ts';
import { getOrder, type OrderRecord } from './orders.ts';
import {
  openPrintUpgradeCheckout,
  type CreatePrintUpgradeCheckoutSession,
} from './print-upgrade-checkout.ts';
import { buildPrintUpgradeOfferEmail } from './print-upgrade-email.ts';
import {
  authorizePrintUpgradeOffer,
  prepareCustomerPrintUpgradeOffer,
  type PrintUpgradeOfferDenial,
} from './print-upgrade-offer.ts';
import {
  quotePrintUpgradeAtCost,
  type PrintCostQuoteProvider,
} from './print-upgrade-quote.ts';

export interface PrintUpgradeRouteDeps<R> {
  json: (body: unknown, status: number) => R;
  /** Resolved per request so a missing Lulu configuration surfaces as 503, not a crash. */
  quoteProvider: () => PrintCostQuoteProvider;
  createCheckoutSession: CreatePrintUpgradeCheckoutSession;
  baseUrl: () => string;
  now?: () => string;
}

const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[a-f0-9]{48}$/;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function tokenFrom(body: Record<string, unknown>): string | null {
  return typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : null;
}

function notFound<R>(deps: PrintUpgradeRouteDeps<R>): R {
  return deps.json({ error: 'not_found' }, 404);
}

function formatLabel(targetFormat: 'classic' | 'premium'): string {
  return targetFormat === 'premium' ? 'Premium hardcover' : 'Classic softcover';
}

function bookTitle(order: OrderRecord): string {
  return order.printTitle?.trim() || `${order.childName}'s Hero Story Book`;
}

/** Denials the customer may legitimately distinguish are still collapsed to 404. */
function isDenial(reason: string): reason is PrintUpgradeOfferDenial | 'order_not_found' {
  return reason === 'order_not_found'
    || reason === 'offer_missing' || reason === 'token_invalid' || reason === 'offer_expired'
    || reason === 'offer_revoked' || reason === 'offer_consumed' || reason === 'order_not_paid'
    || reason === 'order_refunded' || reason === 'not_digital_order' || reason === 'print_upgrade_already_paid'
    || reason === 'print_job_exists' || reason === 'internal_disposition';
}

// ── POST /api/order/[orderId]/print-upgrade/offer ───────────────────────────

export async function handlePrintUpgradeOfferPost<R>(request: Request, orderId: string, deps: PrintUpgradeRouteDeps<R>): Promise<R> {
  if (!ORDER_ID.test(orderId)) return notFound(deps);
  const body = await readJson(request);
  const token = tokenFrom(body);
  if (!token) return notFound(deps);
  const order = await getOrder(orderId);
  if (!order) return notFound(deps);
  const now = new Date(deps.now?.() ?? new Date().toISOString());
  const access = authorizePrintUpgradeOffer(order, token, now);
  if (access.ok === false) return notFound(deps);
  const offer = access.offer;
  const lock = order.printUpgradeLock ?? null;
  const open = lock && lock.status === 'open' && Date.parse(lock.expiresAt) > now.getTime()
    ? { targetFormat: lock.targetFormat, totalCents: lock.totalCents, url: lock.checkoutUrl, expiresAt: lock.expiresAt }
    : null;
  return deps.json({
    status: order.printUpgradeStatus === 'checkout_open' && open ? 'checkout_open' : 'offered',
    bookTitle: bookTitle(order),
    pageCount: offer.approvedSource.pageCount,
    purchaseKind: offer.purchaseKind ?? 'upgrade',
    approvedProofVersion: offer.approvedProofVersion,
    expiresAt: offer.expiresAt,
    formats: (['classic', 'premium'] as const).map((targetFormat) => ({
      targetFormat,
      label: formatLabel(targetFormat),
      pageCount: offer.quotePageCounts[targetFormat],
    })),
    ...(open ? { openCheckout: open } : {}),
  }, 200);
}

// ── POST /api/order/[orderId]/print-upgrade/quote ───────────────────────────

export async function handlePrintUpgradeQuotePost<R>(request: Request, orderId: string, deps: PrintUpgradeRouteDeps<R>): Promise<R> {
  if (!ORDER_ID.test(orderId)) return notFound(deps);
  const body = await readJson(request);
  const token = tokenFrom(body);
  if (!token) return notFound(deps);

  let provider: PrintCostQuoteProvider;
  try {
    provider = deps.quoteProvider();
  } catch (error) {
    console.error(`[print-upgrade] quote provider unavailable: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`);
    // Still fail closed on identity before admitting the provider is down.
    const order = await getOrder(orderId);
    if (!order || !authorizePrintUpgradeOffer(order, token, new Date(deps.now?.() ?? Date.now())).ok) return notFound(deps);
    return deps.json({ error: 'quote_unavailable' }, 503);
  }

  const result = await quotePrintUpgradeAtCost(orderId, { token, shippingAddress: body.shippingAddress, quantity: typeof body.quantity === 'number' ? body.quantity : undefined }, { provider, now: deps.now?.() });
  if (result.ok === false) {
    if (result.reason === 'address_invalid') return deps.json({ error: 'address_invalid' }, 400);
    if (result.reason === 'quote_unavailable') return deps.json({ error: 'quote_unavailable' }, 503);
    if (isDenial(result.reason)) return notFound(deps);
    return deps.json({ error: 'quote_unavailable' }, 503);
  }
  return deps.json({
    destinationZip: result.quotes[0]?.shippingAddress.zip ?? null,
    quotes: result.quotes.map((q) => ({
      quoteId: q.quoteId,
      targetFormat: q.targetFormat,
      label: formatLabel(q.targetFormat),
      pageCount: q.pageCount,
      quantity: q.quantity,
      printCents: q.printCents,
      shippingCents: q.shippingCents,
      fulfillmentCents: q.fulfillmentCents,
      taxCents: q.taxCents,
      totalCents: q.totalCents,
      estimatedDeliveryStart: q.estimatedDeliveryStart,
      estimatedDeliveryEnd: q.estimatedDeliveryEnd,
      expiresAt: q.expiresAt,
    })),
  }, 200);
}

// ── POST /api/order/[orderId]/print-upgrade/checkout ────────────────────────

export async function handlePrintUpgradeCheckoutPost<R>(request: Request, orderId: string, deps: PrintUpgradeRouteDeps<R>): Promise<R> {
  if (!ORDER_ID.test(orderId)) return notFound(deps);
  const body = await readJson(request);
  const token = tokenFrom(body);
  if (!token) return notFound(deps);
  const result = await openPrintUpgradeCheckout(orderId, { token, quoteId: body.quoteId }, {
    createCheckoutSession: deps.createCheckoutSession,
    baseUrl: deps.baseUrl(),
    now: deps.now?.(),
  });
  if (result.ok === true) {
    return deps.json({ url: result.url, reused: result.reused, targetFormat: result.lock.targetFormat, totalCents: result.lock.totalCents, expiresAt: result.lock.expiresAt }, 200);
  }
  if (result.reason === 'checkout_already_open') return deps.json({ error: 'checkout_already_open', open: result.open }, 409);
  if (result.reason === 'quote_not_found' || result.reason === 'quote_expired' || result.reason === 'checkout_busy') {
    return deps.json({ error: result.reason }, 409);
  }
  if (result.reason === 'provider_failed') return deps.json({ error: 'provider_failed' }, 503);
  if (result.reason === 'delivery_unavailable') return deps.json({ error: 'delivery_unavailable' }, 503);
  return notFound(deps);
}

// ── POST /api/admin/orders/[orderId]/print-upgrade-offer ────────────────────

/**
 * Operator action: prepare (or rotate) the customer offer and return the
 * one-time chooser URL plus the email draft. It NEVER sends the email and
 * never creates a Stripe Session; the operator sends through the separately
 * gated path after reading the draft back.
 */
export async function handleAdminPrintUpgradeOfferPost<R>(request: Request, orderId: string, deps: PrintUpgradeRouteDeps<R>): Promise<R> {
  if (!isAdminAuthedFromRequest(request)) return deps.json({ error: 'Unauthorized' }, 401);
  if (!ORDER_ID.test(orderId)) return deps.json({ error: 'order_not_found' }, 404);
  const body = await readJson(request);
  const prepared = await prepareCustomerPrintUpgradeOffer(orderId, {
    purchaseKind: body.purchaseKind === 'extra_copy' ? 'extra_copy' : 'upgrade',
    approvedSourceSha256: typeof body.approvedSourceSha256 === 'string' ? body.approvedSourceSha256 : '',
    approvedSourcePageCount: typeof body.approvedSourcePageCount === 'number' ? body.approvedSourcePageCount : Number.NaN,
    approvedSourceLabel: typeof body.approvedSourceLabel === 'string' ? body.approvedSourceLabel : null,
    ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
    now: deps.now?.(),
  });
  if (prepared.ok === false) {
    if (prepared.reason === 'order_not_found') return deps.json({ error: 'order_not_found' }, 404);
    if (prepared.reason === 'approved_source_invalid') return deps.json({ error: 'approved_source_invalid' }, 400);
    return deps.json({ error: prepared.reason }, 409);
  }
  const chooserUrl = `${deps.baseUrl()}${prepared.chooserPath}`;
  const draft = buildPrintUpgradeOfferEmail(prepared.order, { chooserUrl, expiresAt: prepared.offer.expiresAt });
  return deps.json({
    ok: true,
    orderId,
    offerId: prepared.offer.offerId,
    expiresAt: prepared.offer.expiresAt,
    quotePageCounts: prepared.offer.quotePageCounts,
    chooserUrl,
    emailDraft: draft,
    sent: false,
    safety: 'Offer prepared only. No email was sent. No Stripe Checkout Session, print file, print job, or provider action was created. The chooser URL above is shown once; only its hash is stored.',
  }, 200);
}
