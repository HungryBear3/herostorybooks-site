import Stripe from 'stripe';
import crypto from 'node:crypto';

import { getOptionalStripeSecretKey } from './stripe-env.ts';

import {
  appendAuditEvent,
  acquireProofReleaseEmailLock,
  getOrder,
  releaseOwnerPrintGoIntentLock,
  updateFulfillmentState,
  updateOrderStatus,
  type OrderRecord,
} from './orders.ts';
import { triggerFulfillment, approvePrintProof, submitPrintAfterOwnerGo } from './fulfillment.ts';
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
import { describeManifestGateFailures } from './fulfillment-types.ts';
import {
  enforceKillSwitch,
  KILL_SWITCH_STATE_UNAVAILABLE_CODE,
  killSwitchRefusal,
  killSwitchUnavailableMessage,
} from './ops-kill-switches.ts';

export type ActionResult =
  | { ok: true; detail?: string }
  | {
      ok: false;
      status: 400 | 404 | 409 | 502 | 503;
      error: string;
      /** Optional machine-readable refusal code. Currently set by
       *  `recordOwnerPrintGo` so the admin UI can render structured
       *  safe-state copy (e.g. RACE_LOST, ALREADY_OWNER_GO,
       *  ALREADY_SUBMITTED) without substring-matching `error`. Other
       *  actions may omit this; UIs must tolerate it being absent. */
      failureCode?: string;
    };

export type RetryResult = ActionResult;

// ── Kill-switch refusal helpers ───────────────────────────────────────────────
//
// Every admin path that either sends a customer email OR submits print
// must consult the relevant kill switch with fail-closed durable-read
// semantics. The helpers below collapse the three states
// (off / on / store-unavailable) into a uniform ActionResult so seams
// stay one-liners and so the "store unavailable → refuse" policy
// cannot be forgotten at any seam.
//
// IMPORTANT: returning `null` means the switch is OFF and the caller
// may proceed. Returning a non-null ActionResult is ALWAYS a refusal
// (either active-switch or durability-failure). Callers MUST return it
// to the API layer without modification.

async function refuseIfProofReleaseHeld(): Promise<ActionResult | null> {
  const ks = await enforceKillSwitch('proof_release_hold');
  if (ks.kind === 'active') {
    return {
      ok: false,
      status: 409,
      error: killSwitchRefusal('proof_release_hold', 'Proof release hold'),
      failureCode: 'PROOF_RELEASE_HELD',
    };
  }
  if (ks.kind === 'unavailable') {
    return {
      ok: false,
      status: 503,
      error: killSwitchUnavailableMessage('Proof release hold', ks.reason),
      failureCode: KILL_SWITCH_STATE_UNAVAILABLE_CODE,
    };
  }
  return null;
}

async function refuseIfOwnerPrintGoHeld(): Promise<ActionResult | null> {
  const ks = await enforceKillSwitch('owner_print_go_hold');
  if (ks.kind === 'active') {
    return {
      ok: false,
      status: 409,
      error: killSwitchRefusal('owner_print_go_hold', 'Owner print-go hold'),
      failureCode: 'OWNER_PRINT_GO_HELD',
    };
  }
  if (ks.kind === 'unavailable') {
    return {
      ok: false,
      status: 503,
      error: killSwitchUnavailableMessage('Owner print-go hold', ks.reason),
      failureCode: KILL_SWITCH_STATE_UNAVAILABLE_CODE,
    };
  }
  return null;
}

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
  acquireProofReleaseEmailLock?: typeof acquireProofReleaseEmailLock;
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

/**
 * Returns a short human description of customer review work that a destructive
 * full retry (re-seed) would wipe, or null if there is none to protect.
 * Covers: an active/finished review status, and any page that has been accepted,
 * carries customer feedback, or has been regenerated (>1 version).
 */
export function describeCustomerReviewWork(order: OrderRecord): string | null {
  const reasons: string[] = [];
  if (
    order.reviewStatus === 'in_review' ||
    order.reviewStatus === 'customer_changes_requested' ||
    order.reviewStatus === 'approved'
  ) {
    reasons.push(`reviewStatus=${order.reviewStatus}`);
  }
  const pages = order.pageArtifacts ?? [];
  const accepted = pages.filter((p) => p.accepted).length;
  const withFeedback = pages.filter((p) => (p.feedbackHistory?.length ?? 0) > 0).length;
  const regenerated = pages.filter((p) => (p.versionHistory?.length ?? 0) > 1).length;
  if (accepted > 0) reasons.push(`${accepted} accepted page(s)`);
  if (withFeedback > 0) reasons.push(`${withFeedback} page(s) with customer feedback`);
  if (regenerated > 0) reasons.push(`${regenerated} regenerated page(s)`);
  return reasons.length > 0 ? reasons.join(', ') : null;
}

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
    // KS-2 gate. R2 leak closure: both the digital and print branches
    // below transport customer email, so proof_release_hold must
    // refuse before either branch runs.
    const ksRefusal = await refuseIfProofReleaseHeld();
    if (ksRefusal) return ksRefusal;
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

  // C1 guard: a full retry resets to not_started and re-runs fulfillment, which
  // re-seeds pageArtifacts from scratch — destroying accepted images, customer
  // regenerations, feedback/version history, the review status, and the built
  // proof. Refuse (rather than silently wipe) when the order already carries
  // customer review work. Recover such orders via the artifact-preserving paths
  // (proof rebuild / email resend), not a destructive re-seed.
  const reviewWork = describeCustomerReviewWork(order);
  if (reviewWork) {
    return {
      ok: false,
      status: 409,
      error:
        `Refusing full retry: order has customer review work (${reviewWork}). `
        + `Re-seeding would destroy accepted/regenerated pages and the approved proof. `
        + `Use proof rebuild or email resend instead.`,
    };
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
  // KS-2 gate. The original implementation only checked the kill
  // switch inside releaseOrderAfterQa; the Opus review (R2) flagged
  // that operators flipping proof_release_hold could still send
  // customer email via this resend path. Closed here.
  const ksRefusal = await refuseIfProofReleaseHeld();
  if (ksRefusal) return ksRefusal;

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
  const ksRefusal = await refuseIfProofReleaseHeld();
  if (ksRefusal) return ksRefusal;

  const order = await getOrder(orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Cannot release: payment not confirmed' };
  }
  // Manual Fulfillment Factory boundary (Phase 3). An order carrying an
  // artifactManifest is manual-managed: it must NEVER reach customer release
  // through this legacy auto-QA/email path. Manual orders release only via the
  // manifest-gated manual path (a later, separately gated phase). This is
  // belt-and-suspenders on top of the awaiting_qa precondition below (manual
  // orders are not in awaiting_qa) and guarantees the new manifest gate cannot
  // be bypassed even if a manual order were somehow routed here.
  if (order.artifactManifest) {
    return {
      ok: false,
      status: 409,
      error:
        'Manual-factory order: customer release must go through the manifest-gated manual path, not legacy QA release. ' +
        `Manifest gate reasons: ${describeManifestGateFailures(order.artifactManifest).join(', ') || 'gate-ready (manual release path pending)'}`,
      failureCode: 'MANUAL_ORDER_USES_MANIFEST_PATH',
    };
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
  // Named-operator enforcement (pre-G5 hardening). No silent default to
  // "admin": a blank/whitespace operator id must refuse server-side so the
  // qaPassBy / qaReviewer audit trail always names a real reviewer. The QA
  // Room and order-detail UIs disable submit until this is typed, but the
  // server is the authority — a direct API caller cannot bypass it.
  const qaPassBy = (input.qaPassBy ?? '').trim().slice(0, 120);
  if (!qaPassBy) {
    return {
      ok: false,
      status: 400,
      error: 'qaPassBy required (non-empty operator identifier)',
    };
  }

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
  const manifestHash = guard.manifest.manifestHash ?? null;
  const releaseLock = await (deps.acquireProofReleaseEmailLock ?? acquireProofReleaseEmailLock)(
    order.id,
    manifestHash,
    crypto.randomBytes(16).toString('hex'),
    qaPassBy,
    qaPassAt,
  );
  if (!releaseLock.acquired) {
    return {
      ok: false,
      status: 409,
      error: releaseLock.error ?? 'Proof release email already in progress or sent for this artifact',
    };
  }

  const updated = await updateFulfillmentState(order.id, {
    qaPassAt,
    qaPassBy,
    qaStatus: 'passed',
    qaReviewer: qaPassBy,
    customerProofReleasedAt: qaPassAt,
    manifestComplete: true,
    manifestHash,
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
  // KS-2 gate. Closes the R2 leak — proof_release_hold must block this
  // resend path too, not just releaseOrderAfterQa.
  const ksRefusal = await refuseIfProofReleaseHeld();
  if (ksRefusal) return ksRefusal;

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

/**
 * Admin override that approves the proof on the customer's behalf.
 *
 * NOTE per Rex G3: this records ONLY the customer-approval half (sets
 * `proof_approved` + `proofApprovedAt`/`printApprovedAt`). It does NOT
 * submit to print. Operator must additionally call
 * `recordOwnerPrintGo(orderId, ownerBy)` to authorize and execute print
 * submission. This decoupling exists because customer approval alone —
 * whether by the customer themselves or by ops on their behalf — must
 * not trigger automated print per the Generation Operating Policy §6.
 */
/**
 * Manually mark a proof as approved (operator acts on the customer's
 * behalf because they couldn't or wouldn't click the email link).
 *
 * KS-2 / proof_release_hold is intentionally NOT consulted here. This
 * action advances `fulfillmentStatus` to `proof_approved` and writes
 * `proofApprovedAt` / `printApprovedAt`; it does NOT transport any
 * customer email. The customer email had to have already been sent
 * (the order must be in `proof_ready` and carry a proof token), so
 * the email-release decision was already gated by KS-2 upstream.
 *
 * KS-3 / owner_print_go_hold is NOT consulted here either: this
 * action does not call runPrintProduction. Operator must follow up
 * with `recordOwnerPrintGo`, which IS KS-3-gated.
 */
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

  // Reuse the same code path as the customer approval — pass the stored
  // token. This advances state to `proof_approved` ONLY; it does NOT
  // call runPrintProduction. Operator's next step is recordOwnerPrintGo.
  const result = await approvePrintProof(order.id, order.proofApprovalToken, {}, order);
  if (!result.ok) {
    return { ok: false, status: 409, error: result.error ?? 'Approval failed' };
  }
  return {
    ok: true,
    detail: 'Proof manually approved — proof_approved. Call recordOwnerPrintGo to submit print.',
  };
}

/**
 * Operator/owner records explicit print go and triggers `submitPrint`.
 * This is the ONLY admin path that ultimately reaches Lulu/RPI. Customer
 * approval — direct or via `manuallyApproveProof` — is necessary but
 * NOT sufficient.
 *
 * Server-side checks (delegated to `submitPrintAfterOwnerGo`):
 *  - paymentStatus paid + not refunded
 *  - qaPassAt set
 *  - customer approval timestamp present
 *  - fulfillmentStatus === 'proof_approved'
 *  - ownerBy is non-empty
 *
 * Side effect: persists `ownerPrintGoAt` + `ownerPrintGoBy`, then
 * runs print production. Print guard inside runPrintProduction will
 * still re-validate the manifest, QA, and lineage before invoking
 * the submitPrint dep.
 */
export async function recordOwnerPrintGo(
  orderId: string,
  ownerBy: string,
): Promise<ActionResult> {
  const ksRefusal = await refuseIfOwnerPrintGoHeld();
  if (ksRefusal) return ksRefusal;

  const result = await submitPrintAfterOwnerGo(orderId, ownerBy);
  if (result.ok === true) {
    return { ok: true, detail: 'Owner print-go recorded; print submission attempted.' };
  }
  // Map the acquisition path's named failure codes to clean HTTP
  // statuses. 400 for input-shape problems the caller can fix
  // (OWNER_BY_REQUIRED), 404 for unknown order, 502 when the upstream
  // print provider submission itself failed (PRINT_SUBMIT_FAILED), 409
  // for everything else (already-acquired, wrong state, race lost,
  // etc.).
  const code = result.failureCode;
  const status: 400 | 404 | 409 | 502 =
    code === 'OWNER_BY_REQUIRED' ? 400 :
    code === 'ORDER_NOT_FOUND' ? 404 :
    code === 'PRINT_SUBMIT_FAILED' ? 502 :
    409;
  return {
    ok: false,
    status,
    error: result.error ?? 'Owner print-go refused',
    // Surface the machine-readable refusal code so the admin UI can
    // render structured safe-state copy (RACE_LOST / ALREADY_OWNER_GO /
    // ALREADY_SUBMITTED / etc.) without parsing `error` strings.
    failureCode: code,
  };
}

// ── Owner print-go lock recovery ──────────────────────────────────────────────

/**
 * Named refusal codes for `releaseOwnerPrintGoLock`. Kept narrow on
 * purpose so the admin UI can render structured safe-state copy and
 * the runbook can enumerate each one.
 */
export type ReleaseOwnerPrintGoLockFailureCode =
  | 'OWNER_BY_REQUIRED'
  | 'ORDER_NOT_FOUND'
  | 'PRINT_ALREADY_SUBMITTED'
  | 'ORDER_ALREADY_IN_PRINT_OR_SHIPPED'
  | 'NO_LOCK_TO_RELEASE'
  | 'LOCK_NOT_STALE'
  | 'CONFIRMATION_REQUIRED'
  | 'PERSIST_FAILED';

/**
 * Conservative lease window for owner-go lock recovery. Recovery refuses to
 * clear a lock whose `ownerPrintGoAt` is younger than this — a fresh lock may
 * still front an in-flight provider submit, and clearing it then re-running
 * owner-go is exactly the double-print hazard the durable lock exists to
 * prevent. A real Lulu/RPI submit completes in seconds; 30 minutes means
 * "this is genuinely stuck", not "still working".
 */
export const OWNER_PRINT_GO_LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * Provider-dashboard confirmation phrase required to clear a lock while the
 * order is still in `submitting_to_print` (the genuinely in-flight window).
 * The operator must verify at the print provider that NO job was created
 * before typing this. Enforced server-side; the UI cannot weaken it.
 */
export const OWNER_PRINT_GO_LOCK_RECOVERY_CONFIRMATION = 'PROVIDER DASHBOARD CHECKED';

/**
 * Clear a stuck owner-print-go intent lock.
 *
 * `acquireOwnerPrintGoIntentLock` creates a durable blob/FS lock before
 * any provider submit so concurrent operator clicks cannot double-submit.
 * The lock is never deleted on the happy path — that is by design
 * (a successful print is a permanent state-change marker).
 *
 * It is ALSO not deleted on the failure path: if persistence or the
 * provider submit fails, the order is left with the lock in place and
 * `submitting_to_print` / `failed_manual_review` state, and the
 * operator UI showed RACE_LOST on retry. That left the operator with
 * no recovery path short of manual blob/FS surgery.
 *
 * This action provides the safe recovery path. It refuses unless:
 *   - ownerBy is non-blank (audit trail integrity)
 *   - order exists
 *   - `printJobId` is empty (PRINT_ALREADY_SUBMITTED — a real print
 *     job exists; do not invalidate it)
 *   - status is not `print_in_production` / `shipped`
 *     (ORDER_ALREADY_IN_PRINT_OR_SHIPPED)
 *   - either the lock exists OR `ownerPrintGoAt` is set (otherwise
 *     NO_LOCK_TO_RELEASE — nothing to recover)
 *
 * On success:
 *   - Deletes the lock blob + FS lock (whichever exists).
 *   - Clears `ownerPrintGoAt`, `ownerPrintGoBy`, `ownerPrintGoLockToken`.
 *   - If `fulfillmentStatus` is `submitting_to_print` or
 *     `failed_manual_review`, reverts to `proof_approved` so a fresh
 *     owner-go can run after operator investigation.
 *   - Appends an audit event `owner_print_go_lock_released` so the
 *     reset is permanently recorded.
 *
 * NOT a generic "undo" — does not touch printJobId, qa, or customer
 * approval. Refunds and shipping are out of scope.
 */
export async function releaseOwnerPrintGoLock(
  orderId: string,
  ownerBy: string,
  opts: { confirmation?: string; now?: () => number } = {},
): Promise<ActionResult> {
  const trimmed = (ownerBy ?? '').trim().slice(0, 120);
  if (!trimmed) {
    return {
      ok: false,
      status: 400,
      error: 'ownerBy required (non-empty operator identifier)',
      failureCode: 'OWNER_BY_REQUIRED',
    };
  }

  const order = await getOrder(orderId);
  if (!order) {
    return { ok: false, status: 404, error: 'Order not found', failureCode: 'ORDER_NOT_FOUND' };
  }

  if (order.printJobId) {
    return {
      ok: false,
      status: 409,
      error: `Refusing release: printJobId=${order.printJobId} already exists (PRINT_ALREADY_SUBMITTED). Do not clear the lock — investigate at the print provider.`,
      failureCode: 'PRINT_ALREADY_SUBMITTED',
    };
  }
  if (order.status === 'print_in_production' || order.status === 'shipped') {
    return {
      ok: false,
      status: 409,
      error: `Refusing release: order.status=${order.status} (ORDER_ALREADY_IN_PRINT_OR_SHIPPED).`,
      failureCode: 'ORDER_ALREADY_IN_PRINT_OR_SHIPPED',
    };
  }
  if (!order.ownerPrintGoAt && !order.ownerPrintGoLockToken) {
    return {
      ok: false,
      status: 409,
      error: 'No owner-print-go lock to release on this order.',
      failureCode: 'NO_LOCK_TO_RELEASE',
    };
  }

  // Staleness / lease guard (pre-G5 hardening). Recovery must not clear a
  // lock that may still front an in-flight provider submit. Require
  // `ownerPrintGoAt` to be older than the conservative lease window before
  // ANY clear is allowed. If `ownerPrintGoAt` is absent/unparseable the
  // order-state write never landed (no in-flight submit is tied to a
  // timestamp), so a token-only orphan is treated as stale and recoverable.
  const nowMs = (opts.now ?? (() => Date.now()))();
  const goAtMs = order.ownerPrintGoAt ? Date.parse(order.ownerPrintGoAt) : NaN;
  const lockAgeMs = Number.isFinite(goAtMs) ? nowMs - goAtMs : Infinity;
  if (lockAgeMs < OWNER_PRINT_GO_LOCK_STALE_MS) {
    const ageSec = Math.max(0, Math.round(lockAgeMs / 1000));
    const minMin = Math.round(OWNER_PRINT_GO_LOCK_STALE_MS / 60000);
    return {
      ok: false,
      status: 409,
      error: `Refusing release: owner-go lock is only ${ageSec}s old (LOCK_NOT_STALE). A print submit may be in flight. Wait until the lock is at least ${minMin} minutes old and confirm at the print provider dashboard first.`,
      failureCode: 'LOCK_NOT_STALE',
    };
  }

  // In-flight (`submitting_to_print`) is the most dangerous state to clear:
  // the provider may have accepted the job even though no printJobId was
  // recorded. Require explicit provider-dashboard confirmation text. This is
  // checked AFTER staleness so confirmation alone can never bypass the lease
  // window, and it is enforced HERE so a direct route POST cannot skip it.
  if (order.fulfillmentStatus === 'submitting_to_print') {
    const confirmation = (opts.confirmation ?? '').trim();
    if (confirmation !== OWNER_PRINT_GO_LOCK_RECOVERY_CONFIRMATION) {
      return {
        ok: false,
        status: 409,
        error: `Refusing release of an in-flight submitting_to_print lock without provider-dashboard confirmation (CONFIRMATION_REQUIRED). Re-submit with confirmation="${OWNER_PRINT_GO_LOCK_RECOVERY_CONFIRMATION}" only after verifying at the print provider that no job was created.`,
        failureCode: 'CONFIRMATION_REQUIRED',
      };
    }
  }

  // Clear the durable lock first; only then mutate the order record so
  // a transient blob/FS delete failure does not leave the order in a
  // "lock missing but state thinks it's cleared" inconsistent shape.
  await releaseOwnerPrintGoIntentLock(orderId);

  // Revert state. Always clear the owner-go markers. If the order was
  // stuck in submitting_to_print / failed_manual_review (the only
  // states this recovery action accepts), restore it to proof_approved
  // so the operator can re-attempt owner-go after investigation. Leave
  // proof_approved alone if it's already there (defensive — no-op
  // status transition).
  const restoredFs =
    order.fulfillmentStatus === 'submitting_to_print' ||
    order.fulfillmentStatus === 'failed_manual_review'
      ? 'proof_approved'
      : order.fulfillmentStatus;

  const updated = await updateFulfillmentState(orderId, {
    fulfillmentStatus: restoredFs,
    ownerPrintGoAt: null,
    ownerPrintGoBy: null,
    ownerPrintGoLockToken: null,
    // Clear the last error so the operator sees a clean recovered
    // state. The audit event preserves the history.
    fulfillmentLastError: null,
  });
  if (!updated) {
    return {
      ok: false,
      status: 502,
      error: 'Lock cleared but failed to persist order-state revert',
      failureCode: 'PERSIST_FAILED',
    };
  }

  await appendAuditEvent(orderId, {
    type: 'owner_print_go_lock_released',
    meta: {
      releasedBy: trimmed,
      priorFulfillmentStatus: order.fulfillmentStatus ?? 'unknown',
      priorOwnerPrintGoAt: order.ownerPrintGoAt ?? null,
      priorOwnerPrintGoBy: order.ownerPrintGoBy ?? null,
      priorOwnerPrintGoLockToken: order.ownerPrintGoLockToken ?? null,
      priorFulfillmentLastError: order.fulfillmentLastError ?? null,
    },
  });

  return {
    ok: true,
    detail: `Owner print-go lock released by ${trimmed}; order restored to ${restoredFs ?? 'unchanged'}.`,
  };
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
