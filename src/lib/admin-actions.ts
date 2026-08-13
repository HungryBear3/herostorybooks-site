import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';

import { getOptionalStripeSecretKey } from './stripe-env.ts';

import {
  appendAuditEvent,
  getOrder,
  prepareOrderForAdminFulfillmentRetry,
  updateFulfillmentState,
  updateOrderStatus,
  withOrderTransaction,
  type OrderRecord,
} from './orders.ts';
import { triggerFulfillment, approvePrintProof, type FulfillmentDeps } from './fulfillment.ts';
import {
  sendProofReadyEmail,
  sendLifecycleEmail,
  sendDigitalDeliveryEmail,
} from './order-email.ts';
import { prepareCustomerReviewLink } from './page-review.ts';

function absoluteReviewUrl(reviewPath: string): string {
  const base = (process.env.NEXT_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${reviewPath}`;
}

async function deliveryReviewUrl(order: OrderRecord): Promise<string | undefined> {
  if (!order.pageArtifacts?.length) return undefined;
  const prepared = await prepareCustomerReviewLink(order.id);
  if (!prepared.ok || !prepared.reviewPath) {
    throw new Error(prepared.error ?? 'review_link_unavailable');
  }
  return absoluteReviewUrl(prepared.reviewPath);
}

export type ActionResult =
  | { ok: true; detail?: string }
  | { ok: false; status: 400 | 404 | 409 | 502 | 503; error: string };

export type RetryResult = ActionResult;

type EmailResendKind = NonNullable<OrderRecord['emailResendClaimKind']>;

async function claimEmailResend(
  orderId: string,
  kind: EmailResendKind,
  eligible: (order: OrderRecord) => boolean,
): Promise<{ order: OrderRecord; claimId: string } | null> {
  const claimId = randomUUID();
  const order = await withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (!eligible(current) || current.emailResendClaimId || current.refundClaimId) return { abort: null };
      const updated: OrderRecord = {
        ...current,
        emailResendClaimId: claimId,
        emailResendClaimKind: kind,
        emailResendClaimArtifact: current.storyArtifactUrl ?? null,
        emailResendClaimAt: new Date().toISOString(),
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
  return order ? { order, claimId } : null;
}

async function finalizeEmailResend(
  orderId: string,
  claimId: string,
  patch: Partial<OrderRecord> = {},
): Promise<OrderRecord | null> {
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (current.emailResendClaimId !== claimId) return { abort: null };
      const updated: OrderRecord = {
        ...current,
        ...patch,
        emailResendClaimId: null,
        emailResendClaimKind: null,
        emailResendClaimArtifact: null,
        emailResendClaimAt: null,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}

// ── Retry ─────────────────────────────────────────────────────────────────────

export async function retryOrderFulfillment(
  orderId: string,
  fulfillmentDeps: FulfillmentDeps = {},
): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Cannot retry: payment not confirmed' };
  }
  if (order.fulfillmentStatus === 'submitting_to_print' || order.printSubmissionAttemptedAt) {
    return {
      ok: false,
      status: 409,
      error: 'Print submission may already exist; reconcile the provider before any retry',
    };
  }

  // Email delivery is a customer-visible side effect and cannot be made atomic
  // with refund/disposition changes inside this generic retry action. Fail
  // closed and require the dedicated resend operation instead of sending from
  // a stale pre-read or silently regenerating already-correct artifacts.
  if (order.fulfillmentStatus === 'delivery_email_failed') {
    return {
      ok: false,
      status: 409,
      error: 'Artifacts already exist; use the dedicated email resend action after revalidating the order',
    };
  }

  const prepared = await prepareOrderForAdminFulfillmentRetry(orderId);
  if (!prepared) {
    return { ok: false, status: 409, error: 'Order is not eligible for an automatic retry' };
  }

  // Awaited so the admin retry actually waits for fulfillment to start.
  // On Vercel/serverless a fire-and-forget promise gets dropped when the
  // request returns, leaving the order stuck at not_started.
  try {
    await triggerFulfillment(orderId, fulfillmentDeps);
  } catch (err) {
    console.error(`[admin] retry trigger failed for ${orderId}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `Fulfillment retry failed: ${message.slice(0, 240)}` };
  }

  const afterRetry = await getOrder(orderId);
  if (afterRetry?.fulfillmentStatus === 'failed_manual_review') {
    return {
      ok: false,
      status: 502,
      error: `Fulfillment retry failed: ${(afterRetry.fulfillmentLastError ?? 'manual review required').slice(0, 240)}`,
    };
  }
  return { ok: true };
}

/**
 * Email-only recovery: resend the delivery / proof email for an order
 * whose artifacts are already persisted. Safe to call from the admin
 * dashboard or a runbook. Does not touch fulfillment state when the
 * order isn't in `delivery_email_failed` (caller should use the regular
 * `retryOrderFulfillment` or `resendProofEmail` paths in that case).
 */
export async function resendDigitalDelivery(orderId: string): Promise<ActionResult> {
  if (!await getOrder(orderId)) return { ok: false, status: 404, error: 'Order not found' };
  const claimed = await claimEmailResend(orderId, 'digital_delivery', (current) => (
    current.bookFormat === 'digital'
    && current.paymentStatus === 'paid'
    && !current.refundedAt
    && !current.stripeRefundId
    && current.internalDisposition == null
    && current.fulfillmentStatus === 'delivery_email_failed'
    && Boolean(current.storyArtifactUrl)
  ));
  if (!claimed) {
    return { ok: false, status: 409, error: 'Order is not eligible or an email/refund operation is already active' };
  }
  const { order, claimId } = claimed;
  try {
    const sendResult = await sendDigitalDeliveryEmail(order, {
      pdfUrl: order.storyArtifactUrl!,
      reviewUrl: await deliveryReviewUrl(order),
      idempotencyKeyBase: `digital-delivery-${order.id}-${order.proofVersion ?? 'legacy'}`,
    });
    if (sendResult.skipped) {
      await finalizeEmailResend(orderId, claimId, {
        fulfillmentLastError: `delivery_email_failed (manual resend): ${sendResult.reason}`,
      });
      return { ok: false, status: 503, error: `Delivery email not sent: ${sendResult.reason}` };
    }
    const completed = await finalizeEmailResend(orderId, claimId, {
      fulfillmentStatus: 'complete',
      fulfillmentLastError: null,
    });
    if (!completed) {
      return { ok: false, status: 409, error: 'Email sent, but resend claim was lost before finalization' };
    }
    return { ok: true, detail: 'Digital delivery email resent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Preserve the claim and stable provider idempotency key: an exception may
    // be a lost response after Resend accepted the message.
    return {
      ok: false,
      status: 502,
      error: `Delivery email outcome requires reconciliation: ${message.slice(0, 220)}`,
    };
  }
}

// ── Ship / mark shipped ───────────────────────────────────────────────────────

export interface ShipInput {
  trackingNumber?: string;
  trackingUrl?: string;
  printJobStatus?: string;
  expectedPrintJobId?: string;
}

export async function markOrderShipped(
  orderId: string,
  input: ShipInput,
): Promise<ActionResult> {
  const initial = await getOrder(orderId);
  if (!initial) return { ok: false, status: 404, error: 'Order not found' };
  if (initial.bookFormat !== 'classic' && initial.bookFormat !== 'premium') {
    return { ok: false, status: 400, error: 'Only print orders can be marked shipped' };
  }
  if (initial.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Payment not confirmed' };
  }
  if (initial.status === 'shipped' && initial.shippedEmailSentAt) {
    return { ok: true, detail: 'already_shipped_and_notified' };
  }

  const claimId = randomUUID();
  const tracking = (input.trackingNumber ?? '').trim();
  const trackingUrl = (input.trackingUrl ?? '').trim();
  const shipped = await withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      const isPrint = current.bookFormat === 'classic' || current.bookFormat === 'premium';
      if (
        !isPrint
        || current.paymentStatus !== 'paid'
        || current.refundedAt
        || current.stripeRefundId
        || current.refundClaimId
        || current.emailResendClaimId
        || !current.printJobId
        || (input.expectedPrintJobId != null && current.printJobId !== input.expectedPrintJobId)
        || (current.status !== 'print_in_production' && !(current.status === 'shipped' && !current.shippedEmailSentAt))
      ) return { abort: null };
      const now = new Date().toISOString();
      const updated: OrderRecord = {
        ...current,
        status: 'shipped',
        ...(tracking ? { trackingNumber: tracking } : {}),
        ...(trackingUrl ? { trackingUrl } : {}),
        ...(input.printJobStatus ? { printJobStatus: input.printJobStatus } : {}),
        shippedAt: now,
        emailResendClaimId: claimId,
        emailResendClaimKind: 'shipped',
        emailResendClaimArtifact: current.printJobId,
        emailResendClaimAt: now,
        updatedAt: now,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
  if (!shipped) {
    return { ok: false, status: 409, error: 'Shipping requires a paid in-production print job with no active refund/email operation' };
  }

  try {
    const result = await sendLifecycleEmail(shipped, {
      trackingNumber: shipped.trackingNumber ?? undefined,
      trackingUrl: shipped.trackingUrl ?? undefined,
      idempotencyKeyBase: `shipped-${shipped.id}-${shipped.printJobId}`,
    });
    if (result.skipped) {
      await finalizeEmailResend(orderId, claimId);
      return { ok: false, status: 503, error: `Shipped email not sent: ${result.reason}` };
    }
    await finalizeEmailResend(orderId, claimId, { shippedEmailSentAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the durable claim because Resend may have accepted the message.
    return { ok: false, status: 502, error: `Shipped email outcome requires reconciliation: ${message.slice(0, 220)}` };
  }

  return { ok: true };
}

// ── Resend proof email ────────────────────────────────────────────────────────

export async function resendProofEmail(
  orderId: string,
  baseUrl: string,
): Promise<ActionResult> {
  if (!await getOrder(orderId)) return { ok: false, status: 404, error: 'Order not found' };
  const claimed = await claimEmailResend(orderId, 'proof_ready', (current) => (
    (current.bookFormat === 'classic' || current.bookFormat === 'premium')
    && current.paymentStatus === 'paid'
    && !current.refundedAt
    && !current.stripeRefundId
    && current.internalDisposition == null
    && current.fulfillmentStatus === 'proof_ready'
    && Boolean(current.storyArtifactUrl)
    && Boolean(current.proofApprovalToken)
  ));
  if (!claimed) {
    return { ok: false, status: 409, error: 'Proof is not eligible or an email/refund operation is already active' };
  }
  const { order, claimId } = claimed;
  const reviewUrl = `${baseUrl.replace(/\/$/, '')}/review/${order.id}?token=${order.proofApprovalToken}`;
  try {
    const sendResult = await sendProofReadyEmail(order, {
      proofUrl: order.storyArtifactUrl!,
      reviewUrl,
      idempotencyKeyBase: `proof-ready-${order.id}-${order.proofVersion ?? 'legacy'}`,
    });
    if (sendResult.skipped) {
      await finalizeEmailResend(orderId, claimId, {
        fulfillmentLastError: `proof_email_failed (manual resend): ${sendResult.reason}`,
      });
      return { ok: false, status: 503, error: `Proof email not sent: ${sendResult.reason}` };
    }
    const finalized = await finalizeEmailResend(orderId, claimId);
    if (!finalized) {
      return { ok: false, status: 409, error: 'Email sent, but resend claim was lost before finalization' };
    }
    return { ok: true, detail: 'Proof email resent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Preserve the claim and stable provider idempotency key for reconciliation.
    return { ok: false, status: 502, error: `Proof email outcome requires reconciliation: ${message.slice(0, 220)}` };
  }
}

// ── Manual proof approval (ops override) ──────────────────────────────────────

export async function manuallyApproveProof(orderId: string): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.fulfillmentStatus !== 'proof_ready') {
    return { ok: false, status: 409, error: `Proof is in state ${order.fulfillmentStatus}` };
  }
  if (!order.proofApprovalToken) {
    return { ok: false, status: 409, error: 'No approval token on order' };
  }

  // Reuse the same code path as the customer approval — pass the stored token.
  const result = await approvePrintProof(order.id, order.proofApprovalToken);
  if (!result.ok) {
    return { ok: false, status: 409, error: result.error ?? 'Approval failed' };
  }
  return { ok: true, detail: 'Proof manually approved' };
}

// ── Pre-print Stripe refund ──────────────────────────────────────────────────

export interface RefundDeps {
  /** Inject for tests so we can assert the Stripe call shape without
   *  hitting the real API. Returning `null` from `getStripe` forces the
   *  503 manual-refund path. */
  getStripe?: () => StripeRefundClient | null;
  now?: () => string;
}

export interface StripeRefundClient {
  retrieveSession: (sessionId: string) => Promise<{ payment_intent: string | null }>;
  createRefund: (paymentIntent: string, reason: string, idempotencyKey: string) => Promise<{ id: string }>;
}

function defaultStripeRefundClient(): StripeRefundClient | null {
  const key = getOptionalStripeSecretKey();
  if (!key) return null;
  const stripe = new Stripe(key);
  return {
    async retrieveSession(sessionId) {
      const s = await stripe.checkout.sessions.retrieve(sessionId);
      const intent =
        typeof s.payment_intent === 'string'
          ? s.payment_intent
          : s.payment_intent?.id ?? null;
      return { payment_intent: intent };
    },
    async createRefund(paymentIntent, _reason, idempotencyKey) {
      const r = await stripe.refunds.create(
        { payment_intent: paymentIntent },
        { idempotencyKey },
      );
      return { id: r.id };
    },
  };
}

/**
 * Pre-print refund (Plan §8). Refuses unless the order is paid AND not
 * yet shipped/in-print AND not already refunded. Calls Stripe directly
 * — no fake "refund recorded" path: if Stripe is not configured the
 * action returns 503 without touching state, so the operator sees the
 * exact blocker. On success, persists `paymentStatus='refunded'`,
 * `refundedAt`, `stripeRefundId`, and an audit event; flips
 * `fulfillmentStatus` to `failed_manual_review` so downstream paths
 * cannot accidentally print a refunded order.
 */
export async function refundOrder(
  orderId: string,
  reason: string,
  deps: RefundDeps = {},
): Promise<ActionResult> {
  const initial = await getOrder(orderId);
  if (!initial) return { ok: false, status: 404, error: 'Order not found' };

  const refusal = preprintRefundRefusalReason(initial);
  if (refusal) {
    await appendAuditEvent(initial.id, {
      type: 'refund_refused',
      reason: refusal,
      meta: {
        paymentStatus: initial.paymentStatus,
        fulfillmentStatus: initial.fulfillmentStatus ?? null,
        status: initial.status,
      },
    });
    return { ok: false, status: 409, error: refusal };
  }

  if (!initial.stripeSessionId) {
    return {
      ok: false,
      status: 409,
      error: 'Order has no stripeSessionId — cannot run a real refund',
    };
  }

  const stripe = (deps.getStripe ?? defaultStripeRefundClient)();
  if (!stripe) {
    return {
      ok: false,
      status: 503,
      error: 'STRIPE_SECRET_KEY is not configured — refund cannot run',
    };
  }

  const trimmedReason = (reason || 'customer_request').trim().slice(0, 240);
  const now = deps.now ? deps.now() : new Date().toISOString();
  let paymentIntent: string;
  try {
    const session = await stripe.retrieveSession(initial.stripeSessionId);
    if (!session.payment_intent) {
      return {
        ok: false,
        status: 502,
        error: 'Stripe session has no payment_intent — refund cannot run',
      };
    }
    paymentIntent = session.payment_intent;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `Stripe session lookup failed: ${message.slice(0, 200)}` };
  }

  const claimId = randomUUID();
  const claimed = await withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (
        preprintRefundRefusalReason(current)
        || current.emailResendClaimId
        || current.refundClaimId
        || current.stripeSessionId !== initial.stripeSessionId
      ) return { abort: null };
      const updated: OrderRecord = {
        ...current,
        refundClaimId: claimId,
        refundClaimAt: now,
        refundPaymentIntent: paymentIntent,
        refundReason: trimmedReason,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
  if (!claimed) {
    return { ok: false, status: 409, error: 'Refund is no longer eligible or another email/refund operation is active' };
  }

  let refundId: string;
  try {
    const refund = await stripe.createRefund(
      paymentIntent,
      trimmedReason,
      `admin-refund-${orderId}-${claimId}`,
    );
    refundId = refund.id;
  } catch (err) {
    // Keep the durable claim: the provider may have completed despite a lost
    // response. Operations must reconcile this exact idempotency key before retry.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      error: `Stripe refund outcome requires reconciliation: ${message.slice(0, 180)}`,
    };
  }

  const persisted = await withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (
        current.refundClaimId !== claimId
        || current.refundPaymentIntent !== paymentIntent
        || preprintRefundRefusalReason(current)
      ) {
        return { abort: null };
      }
      const updated: OrderRecord = {
        ...current,
        paymentStatus: 'refunded',
        refundedAt: now,
        refundReason: trimmedReason,
        stripeRefundId: refundId,
        refundClaimId: null,
        refundClaimAt: null,
        refundPaymentIntent: null,
        fulfillmentStatus: 'failed_manual_review',
        fulfillmentLastError: `refunded_pre_print: ${trimmedReason}`,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
  if (!persisted) {
    return { ok: false, status: 409, error: 'Refund issued, but durable order finalization requires reconciliation' };
  }

  await appendAuditEvent(orderId, {
    type: 'refund_issued',
    reason: trimmedReason,
    meta: { stripeRefundId: refundId },
  });

  return { ok: true, detail: `Refund issued: ${refundId}` };
}

/** Pure predicate. Returns null when refund is allowed, or a short
 *  reason code when it must be refused. Exported for tests + UI gating. */
export function preprintRefundRefusalReason(order: OrderRecord): string | null {
  if (order.paymentStatus === 'refunded' || order.refundedAt) {
    return 'already_refunded';
  }
  if (order.paymentStatus !== 'paid') {
    return 'not_paid';
  }
  if (order.printUpgradeStatus === 'paid' && order.printUpgradeStripeSessionId) {
    return 'multi_payment_refund_required';
  }
  if (order.status === 'shipped') return 'already_shipped';
  if (order.status === 'print_in_production') return 'already_in_print';
  if (order.fulfillmentKickoffId) return 'fulfillment_active';
  if (
    order.fulfillmentStatus === 'generating_story'
    || order.fulfillmentStatus === 'generating_images'
    || order.fulfillmentStatus === 'building_pdf'
    || order.fulfillmentStatus === 'submitting_to_print'
    || order.fulfillmentStatus === 'complete'
  ) {
    return 'already_finalized';
  }
  return null;
}

// ── Lulu status sync ──────────────────────────────────────────────────────────

export interface LuluWebhookPayload {
  data?: {
    id?: number | string;
    status?: { name?: string } | string;
    line_items?: Array<{
      tracking_id?: string | null;
      tracking_urls?: string[] | null;
      external_id?: string | null;
    }>;
    external_id?: string | null;
  };
  topic?: string;
}

function extractLuluStatus(payload: LuluWebhookPayload): string | null {
  const status = payload.data?.status;
  if (!status) return null;
  if (typeof status === 'string') return status.toUpperCase();
  return (status.name ?? '').toUpperCase() || null;
}

function extractTracking(payload: LuluWebhookPayload): { trackingNumber?: string; trackingUrl?: string } {
  const items = payload.data?.line_items ?? [];
  for (const item of items) {
    const num = item.tracking_id;
    const urls = item.tracking_urls;
    if (num || (urls && urls.length > 0)) {
      return {
        ...(num ? { trackingNumber: num } : {}),
        ...(urls && urls[0] ? { trackingUrl: urls[0] } : {}),
      };
    }
  }
  return {};
}

/**
 * Apply an incoming Lulu webhook to the matching order.
 * Resolves the order by external_id (preferred) or by matching printJobId.
 */
export async function applyLuluStatusUpdate(
  payload: LuluWebhookPayload,
  resolveOrderByJobId?: (jobId: string) => Promise<string | null>,
): Promise<ActionResult> {
  const externalId = payload.data?.external_id ?? payload.data?.line_items?.[0]?.external_id;
  const jobId = payload.data?.id != null ? String(payload.data.id) : null;

  let orderId = (externalId ?? '').trim() || null;
  if (!orderId && jobId && resolveOrderByJobId) {
    orderId = await resolveOrderByJobId(jobId);
  }
  if (!orderId) {
    if (jobId) {
      return { ok: false, status: 409, error: 'Lulu print job is not durably bound yet; retry required' };
    }
    return { ok: false, status: 404, error: 'Could not resolve order from Lulu payload' };
  }

  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (!jobId || !order.printJobId || order.printJobId !== jobId) {
    return { ok: false, status: 409, error: 'Lulu job identity does not match the persisted print job' };
  }

  const status = extractLuluStatus(payload);
  const tracking = extractTracking(payload);

  const patch: Parameters<typeof updateFulfillmentState>[1] = {
    ...(status ? { printJobStatus: status } : {}),
    ...(tracking.trackingNumber ? { trackingNumber: tracking.trackingNumber } : {}),
    ...(tracking.trackingUrl ? { trackingUrl: tracking.trackingUrl } : {}),
  };

  // Map Lulu status → order.status
  if (status === 'IN_PRODUCTION' || status === 'PRODUCTION_READY' || status === 'PRODUCTION_DELAYED') {
    patch.status = 'print_in_production';
  } else if (status === 'SHIPPED') {
    patch.status = 'shipped';
    patch.shippedAt = new Date().toISOString();
  } else if (status === 'REJECTED' || status === 'CANCELED') {
    patch.fulfillmentStatus = 'failed_manual_review';
    patch.fulfillmentLastError = `Lulu returned ${status}`;
  }

  if (status === 'SHIPPED') {
    return markOrderShipped(orderId, {
      ...tracking,
      printJobStatus: status,
      expectedPrintJobId: jobId,
    });
  }

  const applied = await withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (
        current.printJobId !== jobId
        || current.paymentStatus !== 'paid'
        || current.refundedAt
        || current.stripeRefundId
        || current.refundClaimId
        || current.internalDisposition != null
      ) return { abort: null };
      // Provider events can arrive out of order. Once shipped, no older Lulu
      // production/rejection event may regress customer or fulfillment state.
      if (current.status === 'shipped') return { abort: current };
      const updated: OrderRecord = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
  if (!applied) {
    return { ok: false, status: 409, error: 'Lulu transition blocked by an active refund operation' };
  }

  return { ok: true, detail: status ?? 'updated' };
}
