import Stripe from 'stripe';
import crypto from 'node:crypto';

import { getOptionalStripeSecretKey } from './stripe-env.ts';

import { appendAuditEvent, getOrder, updateFulfillmentState, updateOrderStatus, type OrderRecord } from './orders.ts';
import { triggerFulfillment, approvePrintProof } from './fulfillment.ts';
import {
  sendProofReadyEmail,
  sendLifecycleEmail,
  sendDigitalDeliveryEmail,
} from './order-email.ts';
import {
  describeFailureForAudit,
  evaluateReleaseGuard,
  type ReleaseFailureCode,
} from './generation-manifest.ts';

export type ActionResult =
  | { ok: true; detail?: string }
  | { ok: false; status: 400 | 404 | 409 | 502 | 503; error: string };

export type RetryResult = ActionResult;

/**
 * 12-item canonical QA checklist per Generation Operating Policy §7.
 *
 * The legacy 5-field checklist (storyReviewed / imagesReviewed /
 * proofArtifactReviewed / customerSafe / noPrintRelease) is preserved as
 * optional aliases so existing API callers continue to work, but the new
 * 12-item set is what `missingQaChecks` requires for a server-side QA pass.
 *
 * Backward-compat mapping (each legacy field requires the matching new ones):
 *  - storyReviewed       → storyPersonalizationQuality + noTemplateOrGenericProse
 *  - imagesReviewed      → imageConsistency + childLikenessSafety + noBrokenImages
 *  - proofArtifactReviewed → mobileProofPageCheck + emailReviewLinkCheck +
 *                            noMissingPages
 *  - customerSafe        → familyDetailsCorrectness + noFixtureArtifacts
 *  - noPrintRelease      → printOrDigitalSuitability + noProviderFallbackMismatch
 */
export interface QaPassChecklist {
  // ── Legacy 5-item aliases (still accepted; expand to the new items below) ─
  storyReviewed?: boolean;
  imagesReviewed?: boolean;
  proofArtifactReviewed?: boolean;
  customerSafe?: boolean;
  noPrintRelease?: boolean;
  // ── Canonical 12-item Generation Operating Policy checklist ──────────────
  storyPersonalizationQuality?: boolean;
  familyDetailsCorrectness?: boolean;
  noTemplateOrGenericProse?: boolean;
  imageConsistency?: boolean;
  childLikenessSafety?: boolean;
  noMissingPages?: boolean;
  noBrokenImages?: boolean;
  noFixtureArtifacts?: boolean;
  noProviderFallbackMismatch?: boolean;
  printOrDigitalSuitability?: boolean;
  mobileProofPageCheck?: boolean;
  emailReviewLinkCheck?: boolean;
}

export interface QaPassInput {
  qaPassBy?: string;
  checklist?: QaPassChecklist;
}

export interface QaPassDeps {
  now?: () => string;
  createProofToken?: () => string;
  getBaseUrl?: () => string;
  sendDigitalDeliveryEmail?: typeof sendDigitalDeliveryEmail;
  sendProofReadyEmail?: typeof sendProofReadyEmail;
}

/** Canonical 12 items required for qaStatus='passed' per policy §7. */
const CANONICAL_QA_CHECKS: Array<keyof QaPassChecklist> = [
  'storyPersonalizationQuality',
  'familyDetailsCorrectness',
  'noTemplateOrGenericProse',
  'imageConsistency',
  'childLikenessSafety',
  'noMissingPages',
  'noBrokenImages',
  'noFixtureArtifacts',
  'noProviderFallbackMismatch',
  'printOrDigitalSuitability',
  'mobileProofPageCheck',
  'emailReviewLinkCheck',
];

/**
 * Expand legacy 5-item checklist into the canonical 12-item set when
 * callers haven't supplied the new fields yet. Any explicit boolean in
 * the new set overrides the expansion.
 */
function expandLegacyChecklist(checklist: QaPassChecklist | undefined): QaPassChecklist {
  if (!checklist) return {};
  const out: QaPassChecklist = { ...checklist };
  if (checklist.storyReviewed === true) {
    out.storyPersonalizationQuality ??= true;
    out.noTemplateOrGenericProse ??= true;
  }
  if (checklist.imagesReviewed === true) {
    out.imageConsistency ??= true;
    out.childLikenessSafety ??= true;
    out.noBrokenImages ??= true;
  }
  if (checklist.proofArtifactReviewed === true) {
    out.mobileProofPageCheck ??= true;
    out.emailReviewLinkCheck ??= true;
    out.noMissingPages ??= true;
  }
  if (checklist.customerSafe === true) {
    out.familyDetailsCorrectness ??= true;
    out.noFixtureArtifacts ??= true;
  }
  if (checklist.noPrintRelease === true) {
    out.printOrDigitalSuitability ??= true;
    out.noProviderFallbackMismatch ??= true;
  }
  return out;
}

function missingQaChecks(checklist: QaPassChecklist | undefined): string[] {
  const expanded = expandLegacyChecklist(checklist);
  return CANONICAL_QA_CHECKS.filter((key) => expanded[key] !== true);
}

function defaultBaseUrl(): string {
  return process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
}

// ── Retry ─────────────────────────────────────────────────────────────────────

export async function retryOrderFulfillment(orderId: string): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Cannot retry: payment not confirmed' };
  }

  // Smart short-circuit: when the order's artifacts are already persisted
  // and the only failure was the delivery email (Resend domain not
  // verified, transient SMTP error, etc.), we MUST NOT reset to
  // not_started and regenerate. That would re-pay for the entire image
  // pipeline for a book that's already correct. Resend just the email.
  if (order.fulfillmentStatus === 'delivery_email_failed') {
    if (!order.qaPassAt) {
      return { ok: false, status: 409, error: 'Cannot resend customer email before QA pass' };
    }
    const isDigital = order.bookFormat === 'digital';
    if (isDigital && order.storyArtifactUrl) {
      // Generation Operating Policy §5 — the delivery_email_failed short-
      // circuit MUST re-run the release guard before any customer email
      // goes out. State may have drifted since the original release
      // attempt (a later page-regenerate could have introduced a fixture
      // asset; a config flag could have flipped; an admin could have
      // written qaPassAt without going through the gated path). Refuse
      // with a named code rather than silently shipping.
      const guard = evaluateReleaseGuard(order);
      if (!guard.ok) {
        await appendAuditEvent(order.id, {
          type: 'proof_release_failed',
          reason: guard.failureCode ?? 'UNKNOWN',
          meta: {
            ...describeFailureForAudit(guard),
            source: 'retryOrderFulfillment:delivery_email_failed:digital',
          },
        });
        return {
          ok: false,
          status: 409,
          error: `${guard.failureCode ?? 'POLICY_BLOCKED'}: ${guard.message ?? 'release guard refused retry'}`,
        };
      }
      try {
        await sendDigitalDeliveryEmail(order, { pdfUrl: order.storyArtifactUrl });
        await updateFulfillmentState(orderId, {
          fulfillmentStatus: 'complete',
          fulfillmentLastError: null,
        });
        return { ok: true, detail: 'Delivery email resent (artifacts already existed)' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updateFulfillmentState(orderId, {
          fulfillmentLastError: `delivery_email_failed (retry): ${message.slice(0, 500)}`,
        });
        return {
          ok: false,
          status: 502,
          error: `Delivery email still failing: ${message.slice(0, 240)}`,
        };
      }
    }
    if (!isDigital && order.storyArtifactUrl && order.proofApprovalToken) {
      // Same defense as the digital branch: re-run the release guard.
      const guard = evaluateReleaseGuard(order);
      if (!guard.ok) {
        await appendAuditEvent(order.id, {
          type: 'proof_release_failed',
          reason: guard.failureCode ?? 'UNKNOWN',
          meta: {
            ...describeFailureForAudit(guard),
            source: 'retryOrderFulfillment:delivery_email_failed:print',
          },
        });
        return {
          ok: false,
          status: 409,
          error: `${guard.failureCode ?? 'POLICY_BLOCKED'}: ${guard.message ?? 'release guard refused retry'}`,
        };
      }
      const baseUrl = process.env.NEXT_PUBLIC_URL?.replace(/\/$/, '') || 'http://localhost:3000';
      const reviewUrl = `${baseUrl}/review/${order.id}?token=${order.proofApprovalToken}`;
      try {
        await sendProofReadyEmail(order, { reviewUrl, proofUrl: order.storyArtifactUrl });
        await updateFulfillmentState(orderId, {
          fulfillmentStatus: 'proof_ready',
          fulfillmentLastError: null,
        });
        return { ok: true, detail: 'Proof-ready email resent (artifacts already existed)' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updateFulfillmentState(orderId, {
          fulfillmentLastError: `delivery_email_failed (retry): ${message.slice(0, 500)}`,
        });
        return {
          ok: false,
          status: 502,
          error: `Proof email still failing: ${message.slice(0, 240)}`,
        };
      }
    }
    // delivery_email_failed but somehow no artifact URL — fall through to
    // a normal full retry; that path will at least regenerate properly.
  }

  await updateFulfillmentState(orderId, {
    fulfillmentStatus: 'not_started',
    fulfillmentAttempts: 0,
    fulfillmentLastError: null,
  });

  // Awaited so the admin retry actually waits for fulfillment to start.
  // On Vercel/serverless a fire-and-forget promise gets dropped when the
  // request returns, leaving the order stuck at not_started.
  try {
    await triggerFulfillment(orderId);
  } catch (err) {
    console.error(`[admin] retry trigger failed for ${orderId}:`, err);
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
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.bookFormat !== 'digital') {
    return {
      ok: false,
      status: 400,
      error: `Use resendProofEmail / lifecycle paths for ${order.bookFormat} orders`,
    };
  }
  if (!order.storyArtifactUrl) {
    return { ok: false, status: 409, error: 'No digital artifact URL to resend' };
  }
  if (!order.qaPassAt) {
    return { ok: false, status: 409, error: 'Cannot resend customer email before QA pass' };
  }
  // Generation Operating Policy §5 — re-run the manifest guard before
  // touching the customer email. The order may have drifted into a
  // policy-blocked state since the original QA pass (e.g. a later page-
  // regenerate that introduced a fixture asset, or a config flag flip).
  const guard = evaluateReleaseGuard(order);
  if (!guard.ok) {
    await appendAuditEvent(order.id, {
      type: 'proof_release_failed',
      reason: guard.failureCode ?? 'UNKNOWN',
      meta: { ...describeFailureForAudit(guard), source: 'resendDigitalDelivery' },
    });
    return {
      ok: false,
      status: 409,
      error: `${guard.failureCode ?? 'POLICY_BLOCKED'}: ${guard.message ?? 'release guard refused resend'}`,
    };
  }
  try {
    await sendDigitalDeliveryEmail(order, { pdfUrl: order.storyArtifactUrl });
    await updateFulfillmentState(orderId, {
      fulfillmentStatus: 'complete',
      fulfillmentLastError: null,
    });
    return { ok: true, detail: 'Digital delivery email resent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateFulfillmentState(orderId, {
      fulfillmentLastError: `delivery_email_failed (manual resend): ${message.slice(0, 500)}`,
    });
    return {
      ok: false,
      status: 502,
      error: `Delivery email failed: ${message.slice(0, 240)}`,
    };
  }
}

// ── QA pass / customer release ────────────────────────────────────────────────

export async function releaseOrderAfterQa(
  orderId: string,
  input: QaPassInput,
  deps: QaPassDeps = {},
): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Cannot release: payment not confirmed' };
  }
  if (order.fulfillmentStatus !== 'awaiting_qa') {
    return { ok: false, status: 409, error: `Order is in state ${order.fulfillmentStatus ?? 'not_started'}` };
  }
  if (!order.storyArtifactUrl) {
    return { ok: false, status: 409, error: 'No proof/digital artifact URL to release' };
  }
  // Hard server-side block: story prose that fell back to a deterministic
  // template after the model failed must NEVER auto-ship to a paying
  // customer. The QA Room UI already disables the release button for this
  // case, but a second-line check here ensures any direct API caller —
  // including a stale browser tab or future code path that hasn't read the
  // dashboard's gating — cannot bypass. No override is honored from this
  // endpoint by design; an owner-approved override path would land as a
  // separate, explicitly tested change.
  if (order.storyMeta?.source === 'template_after_openai_failure') {
    return {
      ok: false,
      status: 409,
      error: 'Cannot release: story used template fallback and requires owner/manual override',
    };
  }

  const missing = missingQaChecks(input.checklist);
  if (missing.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `QA checklist incomplete: ${missing.join(', ')}`,
    };
  }

  const qaPassAt = deps.now ? deps.now() : new Date().toISOString();
  const qaPassBy = (input.qaPassBy ?? 'admin').trim().slice(0, 120) || 'admin';

  // Generation Operating Policy §5 — final release guard. Synthesize the
  // post-write order, run the guard against it, and refuse without writing
  // if any policy check fails. This catches conditions the checklist
  // can't (template story / fixture asset / missing lineage / emergency
  // approval missing / provider-route blocked) and produces named error
  // codes per the policy doc.
  const guardOrder: OrderRecord = {
    ...order,
    qaPassAt,
    qaPassBy,
    qaStatus: 'passed',
    qaReviewer: qaPassBy,
  };
  const guard = evaluateReleaseGuard(guardOrder);
  if (!guard.ok) {
    await appendAuditEvent(order.id, {
      type: 'proof_release_failed',
      reason: guard.failureCode ?? 'UNKNOWN',
      meta: {
        ...describeFailureForAudit(guard),
        qaPassBy,
      },
    });
    return {
      ok: false,
      status: 409,
      error: `${guard.failureCode ?? 'POLICY_BLOCKED'}: ${guard.message ?? 'release guard refused'}`,
    };
  }
  const isDigital = order.bookFormat === 'digital';
  const sendDigital = deps.sendDigitalDeliveryEmail ?? sendDigitalDeliveryEmail;
  const sendProof = deps.sendProofReadyEmail ?? sendProofReadyEmail;
  const proofApprovalToken = isDigital
    ? null
    : (order.proofApprovalToken || (deps.createProofToken ? deps.createProofToken() : crypto.randomBytes(24).toString('hex')));

  const updated = await updateFulfillmentState(order.id, {
    qaPassAt,
    qaPassBy,
    qaStatus: 'passed',
    qaReviewer: qaPassBy,
    customerProofReleasedAt: qaPassAt,
    manifestComplete: true,
    manifestHash: guard.manifest.manifestHash ?? null,
    fulfillmentStatus: isDigital ? 'complete' : 'proof_ready',
    status: 'preview_ready',
    fulfillmentLastError: null,
    ...(isDigital ? {} : { proofApprovalToken }),
  });
  if (!updated) return { ok: false, status: 404, error: 'Order not found' };

  try {
    if (isDigital) {
      await sendDigital(updated, { pdfUrl: order.storyArtifactUrl });
      await appendAuditEvent(order.id, {
        type: 'qa_pass_recorded',
        meta: {
          qaPassBy,
          bookFormat: order.bookFormat,
          releasedEmail: true,
          printReleased: false,
        },
      }, updated);
      return { ok: true, detail: 'QA passed; digital delivery email sent' };
    }

    const baseUrl = (deps.getBaseUrl ?? defaultBaseUrl)().replace(/\/$/, '');
    const reviewUrl = `${baseUrl}/review/${order.id}?token=${proofApprovalToken}`;
    await sendProof(updated, { proofUrl: order.storyArtifactUrl, reviewUrl });
    await appendAuditEvent(order.id, {
      type: 'qa_pass_recorded',
      meta: {
        qaPassBy,
        bookFormat: order.bookFormat,
        releasedEmail: true,
        printReleased: false,
      },
    }, updated);
    return { ok: true, detail: 'QA passed; proof-ready email sent' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await updateFulfillmentState(order.id, {
      fulfillmentStatus: 'delivery_email_failed',
      fulfillmentLastError: `delivery_email_failed (qa release): ${message.slice(0, 500)}`,
      qaPassAt,
      qaPassBy,
      ...(isDigital ? {} : { proofApprovalToken }),
    });
    if (failed) {
      await appendAuditEvent(order.id, {
        type: 'qa_pass_recorded',
        meta: {
          qaPassBy,
          bookFormat: order.bookFormat,
          releasedEmail: false,
          printReleased: false,
        },
      }, failed);
    }
    return {
      ok: false,
      status: 502,
      error: `QA pass saved, but customer email failed: ${message.slice(0, 240)}`,
    };
  }
}

// ── Ship / mark shipped ───────────────────────────────────────────────────────

export interface ShipInput {
  trackingNumber?: string;
  trackingUrl?: string;
}

export async function markOrderShipped(
  orderId: string,
  input: ShipInput,
): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };

  const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
  if (!isPrint) {
    return { ok: false, status: 400, error: 'Only print orders can be marked shipped' };
  }
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Payment not confirmed' };
  }

  const tracking = (input.trackingNumber ?? '').trim();
  const trackingUrl = (input.trackingUrl ?? '').trim();

  await updateFulfillmentState(orderId, {
    status: 'shipped',
    ...(tracking ? { trackingNumber: tracking } : {}),
    ...(trackingUrl ? { trackingUrl } : {}),
    shippedAt: new Date().toISOString(),
  });

  const updated = await getOrder(orderId);
  if (updated) {
    try {
      await sendLifecycleEmail(updated, {
        trackingNumber: tracking || undefined,
        trackingUrl: trackingUrl || undefined,
      });
    } catch (err) {
      console.error(`[admin] shipped email failed for ${orderId}:`, err);
    }
  }

  return { ok: true };
}

// ── Resend proof email ────────────────────────────────────────────────────────

export async function resendProofEmail(
  orderId: string,
  baseUrl: string,
): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (!order.storyArtifactUrl || !order.proofApprovalToken) {
    return { ok: false, status: 409, error: 'No proof ready to resend' };
  }
  if (!order.qaPassAt) {
    return { ok: false, status: 409, error: 'Cannot resend proof email before QA pass' };
  }
  if (order.fulfillmentStatus !== 'proof_ready') {
    return { ok: false, status: 409, error: `Proof is in state ${order.fulfillmentStatus}` };
  }
  // Generation Operating Policy §5 — re-run the manifest guard before
  // touching the customer email. State may have drifted since the
  // original release (later page-regenerate, config flip, etc.).
  const guard = evaluateReleaseGuard(order);
  if (!guard.ok) {
    await appendAuditEvent(order.id, {
      type: 'proof_release_failed',
      reason: guard.failureCode ?? 'UNKNOWN',
      meta: { ...describeFailureForAudit(guard), source: 'resendProofEmail' },
    });
    return {
      ok: false,
      status: 409,
      error: `${guard.failureCode ?? 'POLICY_BLOCKED'}: ${guard.message ?? 'release guard refused resend'}`,
    };
  }

  const reviewUrl = `${baseUrl.replace(/\/$/, '')}/review/${order.id}?token=${order.proofApprovalToken}`;
  await sendProofReadyEmail(order, { proofUrl: order.storyArtifactUrl, reviewUrl });
  return { ok: true, detail: 'Proof email resent' };
}

// ── Manual proof approval (ops override) ──────────────────────────────────────

export async function manuallyApproveProof(orderId: string): Promise<ActionResult> {
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.fulfillmentStatus !== 'proof_ready') {
    return { ok: false, status: 409, error: `Proof is in state ${order.fulfillmentStatus}` };
  }
  if (!order.qaPassAt) {
    return { ok: false, status: 409, error: 'Cannot manually approve print before QA pass' };
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
  createRefund: (paymentIntent: string, reason?: string) => Promise<{ id: string }>;
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
    async createRefund(paymentIntent) {
      const r = await stripe.refunds.create({ payment_intent: paymentIntent });
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
  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };

  const refusal = preprintRefundRefusalReason(order);
  if (refusal) {
    await appendAuditEvent(order.id, {
      type: 'refund_refused',
      reason: refusal,
      meta: {
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus ?? null,
        status: order.status,
      },
    });
    return { ok: false, status: 409, error: refusal };
  }

  if (!order.stripeSessionId) {
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

  let refundId: string;
  try {
    const session = await stripe.retrieveSession(order.stripeSessionId);
    if (!session.payment_intent) {
      return {
        ok: false,
        status: 502,
        error: 'Stripe session has no payment_intent — refund cannot run',
      };
    }
    const refund = await stripe.createRefund(session.payment_intent, trimmedReason);
    refundId = refund.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      error: `Stripe refund failed: ${message.slice(0, 200)}`,
    };
  }

  await updateFulfillmentState(order.id, {
    paymentStatus: 'refunded',
    refundedAt: now,
    refundReason: trimmedReason,
    stripeRefundId: refundId,
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentLastError: `refunded_pre_print: ${trimmedReason}`,
  });

  await appendAuditEvent(order.id, {
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
  if (order.status === 'shipped') return 'already_shipped';
  if (order.status === 'print_in_production') return 'already_in_print';
  if (
    order.fulfillmentStatus === 'submitting_to_print'
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
    return { ok: false, status: 404, error: 'Could not resolve order from Lulu payload' };
  }

  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };

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

  await updateFulfillmentState(orderId, patch);

  // Send shipped email on SHIPPED transition (idempotent: only if not already shipped)
  if (status === 'SHIPPED' && order.status !== 'shipped') {
    const updated = await getOrder(orderId);
    if (updated) {
      try {
        await sendLifecycleEmail(updated, {
          trackingNumber: tracking.trackingNumber,
          trackingUrl: tracking.trackingUrl,
        });
      } catch (err) {
        console.error(`[lulu-webhook] lifecycle email failed for ${orderId}:`, err);
      }
    }
  }

  return { ok: true, detail: status ?? 'updated' };
}
