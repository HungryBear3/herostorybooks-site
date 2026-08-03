// Customer page-review service helpers.
//
// All functions operate on PageArtifact[] in a pure, predictable way. Every
// customer mutation commits through withOrderTransaction (conditional CAS on the
// order record) — this module never persists order state through an
// unconditional updateFulfillmentState. Tests can also call the pure helpers
// directly via applyAcceptPage()/applyRegeneratePage().

import crypto from 'node:crypto';

import {
  appendAuditEvent,
  appendAuditEventTo,
  applyFulfillmentPatchTo,
  getOrder,
  getOrderPhotoUrl,
  OrderMutationLockError,
  OrderVersionConflictError,
  orderRequiresReferenceImage,
  withOrderMutationLock,
  withOrderTransaction,
} from './orders.ts';
import type {
  OrderRecord,
  PageArtifact,
  PageFeedbackEntry,
  PageVersionEntry,
} from './orders.ts';
import { generatePageImage, type ImageProvider } from './image-generator.ts';
import { buildRegeneratePrompt } from './image-prompt-builder.ts';
import {
  buildProofArtifactFromPageArtifacts,
  proofSourceFingerprint,
  rebuildProofFromPageArtifacts,
  type ProofBuildResult,
} from './fulfillment.ts';
import { sendRegenManualReviewAlert } from './order-email.ts';
import {
  recordCustomerTextChangeRequest,
  type RecordCustomerTextChangeInput,
} from './customer-text-change-request.ts';

// Soft internal thresholds (runbook): warn at 3, manual review at 5.
export const REGEN_WARNING_THRESHOLD = 3;
export const REGEN_MANUAL_REVIEW_THRESHOLD = 5;

export interface RegenerateInput extends ReviewActorInput {
  orderId: string;
  pageIndex: number;
  feedback: string;
}

export interface RegenerateResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404 | 409 | 502;
  page?: PageArtifact;
  warning?: 'regen_threshold_warning' | 'regen_manual_review_threshold';
  error?: string;
  /** True iff the proof PDF was successfully refreshed after this regeneration. */
  proofRefreshed?: boolean;
  /** Populated when the regeneration succeeded but the proof rebuild failed. */
  proofRefreshError?: string;
}

export interface AcceptInput extends ReviewActorInput {
  orderId: string;
  pageIndex: number;
}

export interface AcceptResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404 | 409;
  page?: PageArtifact;
  error?: string;
}

// ── Review capability + eligibility (revalidated inside every transaction) ───

/**
 * Who is performing a review mutation.
 *
 * `customer` carries the capability token from the /review/<orderId>?token=…
 * link. It is passed all the way into the mutator so it can be revalidated
 * against the order as read INSIDE the guarded transaction — route-level
 * preauthorization is only an early-refusal optimization, never the gate of
 * record. A token can be rotated, or the order refunded, between the route
 * check and the commit.
 *
 * `internal` is for operator/system/service callers that never present a
 * capability. It is explicit and must be stated at the call site; it is not a
 * customer-surface bypass, because every customer route constructs a `customer`
 * actor (locked by tests/review-source-guards.test.ts). Internal actors are
 * still subject to every non-capability gate below.
 */
export type ReviewActor =
  | { kind: 'customer'; reviewToken?: string | null }
  | { kind: 'internal'; reason: string };

export const INTERNAL_REVIEW_ACTOR: ReviewActor = {
  kind: 'internal',
  reason: 'direct_service_call',
};

export function customerReviewActor(reviewToken?: string | null): ReviewActor {
  return { kind: 'customer', reviewToken };
}

export interface ReviewActorInput {
  /** Defaults to the internal actor when a service caller omits it. */
  actor?: ReviewActor;
}

export interface ReviewMutationRefusal {
  status: 403 | 409;
  error: string;
}

/**
 * Authoritative per-mutation gate, evaluated against the order as read inside
 * the transaction on every attempt.
 *
 * Fails closed on:
 *   - a customer actor whose capability token is missing/absent/mismatched (403)
 *   - anything other than a paid order (403)
 *   - any refund marker, even if paymentStatus still reads 'paid' (403)
 *
 * A refunded order is terminal for customer review: no review state, proof,
 * audit, print, email, or provider work may follow it. The refund check applies
 * to internal actors too — it is an order-state invariant, not a capability one.
 */
export function evaluateReviewMutationEligibility(
  order: OrderRecord,
  actor: ReviewActor = INTERNAL_REVIEW_ACTOR,
): ReviewMutationRefusal | null {
  if (actor.kind === 'customer' && !hasReviewWriteAccess(order, { reviewToken: actor.reviewToken })) {
    return { status: 403, error: 'invalid_or_missing_token' };
  }
  if (order.paymentStatus !== 'paid') {
    return { status: 403, error: 'order_not_eligible' };
  }
  // Belt-and-braces: a refund can be recorded before paymentStatus flips.
  if (order.refundedAt || order.stripeRefundId) {
    return { status: 403, error: 'order_refunded' };
  }
  return null;
}

// ── Pure helpers (testable without prisma/blob) ──────────────────────────────

export function applyAcceptPage(
  artifacts: PageArtifact[],
  pageIndex: number,
): { artifacts: PageArtifact[]; page?: PageArtifact; error?: string } {
  const idx = artifacts.findIndex((p) => p.pageIndex === pageIndex);
  if (idx === -1) return { artifacts, error: 'page_not_found' };
  if (!artifacts[idx].currentImageUrl) {
    return { artifacts, error: 'page_has_no_image_to_accept' };
  }
  const next = artifacts.slice();
  const current = next[idx];
  next[idx] = {
    ...current,
    accepted: true,
    acceptedImageUrl: current.currentImageUrl,
  };
  return { artifacts: next, page: next[idx] };
}

export function applyRegeneratePage(
  artifacts: PageArtifact[],
  pageIndex: number,
  newImageUrl: string | null,
  provider: 'openai' | 'fal' | 'fal_edit' | 'gemini',
  model: string,
  promptUsed: string,
  feedbackEntry: PageFeedbackEntry,
  conditioning: 'text_only' | 'photo_edit' | null = null,
  referencePhotoUrl: string | null = null,
): { artifacts: PageArtifact[]; page?: PageArtifact; error?: string } {
  const idx = artifacts.findIndex((p) => p.pageIndex === pageIndex);
  if (idx === -1) return { artifacts, error: 'page_not_found' };
  const current = artifacts[idx];
  // Critical: NEVER overwrite an already-accepted page's acceptedImageUrl.
  // Customers who regenerate a previously-accepted page implicitly un-accept it
  // (they want a different version) — but their other accepted pages must
  // remain untouched. We only mutate the targeted page here; siblings are
  // returned by reference.
  const versionEntry: PageVersionEntry = {
    createdAt: feedbackEntry.createdAt,
    imageUrl: newImageUrl,
    provider,
    model,
    promptUsed,
    conditioning,
    referencePhotoUrl,
  };
  const next = artifacts.slice();
  next[idx] = {
    ...current,
    currentImageUrl: newImageUrl,
    generationProvider: provider,
    generationModel: model,
    generationConditioning: conditioning,
    regenerateCount: current.regenerateCount + 1,
    accepted: false,
    acceptedImageUrl: null,
    feedbackHistory: [...current.feedbackHistory, feedbackEntry],
    versionHistory: [...current.versionHistory, versionEntry],
  };
  return { artifacts: next, page: next[idx] };
}

export function regenWarningFor(count: number): RegenerateResult['warning'] | undefined {
  if (count >= REGEN_MANUAL_REVIEW_THRESHOLD) return 'regen_manual_review_threshold';
  if (count >= REGEN_WARNING_THRESHOLD) return 'regen_threshold_warning';
  return undefined;
}

// ── Guarded proof refresh ────────────────────────────────────────────────────

export interface GuardedProofRefreshResult {
  refreshed: boolean;
  error?: string;
  /** True when a built proof was thrown away because the source moved under it. */
  discardedStale?: boolean;
}

/**
 * Build a proof PDF and persist it through a CONDITIONAL, fingerprint-checked
 * commit.
 *
 * Why this exists: `rebuildProofFromPageArtifacts` finishes with an
 * unconditional `updateFulfillmentState`, which last-write-wins over any
 * concurrent review mutation. Every customer review flow uses this instead.
 *
 * Sequence:
 *   1. build + upload the PDF outside any transaction, capturing the
 *      fingerprint of the artifact set it rendered from;
 *   2. inside a guarded transaction, re-read the order and compare that
 *      fingerprint against the CURRENT artifacts;
 *   3. on match, commit storyArtifactUrl + the ack invalidation + the audit
 *      entry in one conditional write;
 *   4. on mismatch, discard the built proof — a newer proof is owed to the
 *      newer artifacts and whoever made that change is responsible for it.
 *
 * Bounded rebuild retries are deliberately NOT attempted here: a regenerate
 * storm would otherwise chain PDF builds indefinitely. Discarding is safe —
 * `storyArtifactUrl` simply keeps pointing at the previous proof, and the
 * approval gate independently requires a fresh acknowledgment.
 */
export async function refreshProofGuarded(
  orderId: string,
  opts: {
    buildProof?: typeof buildProofArtifactFromPageArtifacts;
    auditPageIndex?: number;
    triggeredBy: 'page_regenerated' | 'whole_book_approved';
    /** Revalidated against the freshly-read order before the proof is written. */
    actor?: ReviewActor;
  },
): Promise<GuardedProofRefreshResult> {
  let built: Awaited<ReturnType<typeof buildProofArtifactFromPageArtifacts>>;
  try {
    const build = opts.buildProof ?? buildProofArtifactFromPageArtifacts;
    built = await build(orderId);
  } catch (err) {
    return { refreshed: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!built.ok || !built.proofUrl) {
    return { refreshed: false, error: built.error ?? 'proof_rebuild_failed' };
  }
  const proofUrl = built.proofUrl;
  const builtFrom = built.sourceFingerprint;

  try {
    return await withOrderMutationLock(orderId, async (lock) =>
      withOrderTransaction<GuardedProofRefreshResult>(
        orderId,
        (order) => {
          // The refresh runs AFTER its triggering mutation committed, and the
          // render is slow — the order can have been refunded or approved in
          // that window. Re-evaluate both here, against the freshly-read record,
          // and ABORT (never commit, not even an audit row) if either fails.
          // A refunded order is terminal: no proof and no audit may follow it.
          const refusal = evaluateReviewMutationEligibility(order, opts.actor);
          if (refusal) {
            return { abort: { refreshed: false, error: refusal.error } };
          }
          // An approved book is frozen. A refresh still in flight from an
          // earlier mutation must not replace the approved proof or clear the
          // acknowledgment — the print handoff may already have run. Note a
          // render-neutral change can still fingerprint-match here, so the
          // fingerprint check alone would not catch this.
          if (order.reviewStatus === 'approved') {
            return { abort: { refreshed: false, error: 'already_approved' } };
          }
          const current = proofSourceFingerprint(order.pageArtifacts ?? []);
          if (builtFrom && current !== builtFrom) {
            // The artifact set moved while we rendered. Discard: writing this
            // URL would advertise a proof that does not match the live pages.
            return {
              commit: appendAuditEventTo(order, {
                type: 'proof_rebuilt',
                ...(opts.auditPageIndex != null ? { pageIndex: opts.auditPageIndex } : {}),
                reason: 'stale_source_discarded',
                meta: { triggeredBy: opts.triggeredBy, success: false, discardedStale: true },
              }),
              result: {
                refreshed: false,
                discardedStale: true,
                error: 'proof_source_changed_during_rebuild',
              },
            };
          }
          let next = applyFulfillmentPatchTo(order, {
            storyArtifactUrl: proofUrl,
            // Stale-ack invalidation: a new PDF has not been acknowledged.
            proofReviewedAt: null,
          });
          next = appendAuditEventTo(next, {
            type: 'proof_rebuilt',
            ...(opts.auditPageIndex != null ? { pageIndex: opts.auditPageIndex } : {}),
            reason: null,
            meta: { triggeredBy: opts.triggeredBy, success: true },
          });
          return { commit: next, result: { refreshed: true } };
        },
        { lock, notFound: () => ({ refreshed: false, error: 'order_not_found' }) },
      ),
    );
  } catch (err) {
    if (err instanceof OrderMutationLockError || err instanceof OrderVersionConflictError) {
      return { refreshed: false, error: 'order_mutation_busy' };
    }
    return { refreshed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Service entry points ─────────────────────────────────────────────────────

export interface RegenerateDeps {
  /** Inject providers (tests). */
  providers?: ImageProvider[];
  /** Inject the page-level generator (tests). */
  generatePageImage?: typeof generatePageImage;
  /** Optional clock injection (tests). */
  now?: () => Date;
  /** @deprecated TEST-ONLY legacy shim: persists unconditionally on its own. */
  rebuildProof?: typeof rebuildProofFromPageArtifacts;
  /** Inject the build-only proof step (tests). Persisting is guarded. */
  buildProof?: typeof buildProofArtifactFromPageArtifacts;
  /** Inject operator alert sender (tests). */
  sendManualReviewAlert?: typeof sendRegenManualReviewAlert;
  /** Skip auto-rebuild entirely (used by tests that don't care). */
  skipProofRebuild?: boolean;
}

export async function regeneratePage(
  input: RegenerateInput,
  deps: RegenerateDeps = {},
): Promise<RegenerateResult> {
  // Pre-flight read: validate + build the prompt. The provider call below must
  // NOT hold the order lock (it can take many seconds); we re-read and apply the
  // result under the lock afterwards, so a concurrent mutation can't be lost.
  const preOrder = await getOrder(input.orderId);
  if (!preOrder) return { ok: false, status: 404, error: 'Order not found' };
  // Capability + paid/non-refunded gate BEFORE any provider work. This is the
  // early-refusal optimization; the authoritative copy runs against the order
  // re-read inside the guarded transaction below.
  const preRefusal = evaluateReviewMutationEligibility(preOrder, input.actor);
  if (preRefusal) return { ok: false, status: preRefusal.status, error: preRefusal.error };
  // Cheap pre-flight rejection so an already-approved book does not burn a
  // provider call. This is an optimization ONLY — it is not the safety check.
  // The authoritative approved-state guard is the re-read under the lock below,
  // because the book can be approved while the provider call is in flight.
  if (preOrder.reviewStatus === 'approved') {
    return { ok: false, status: 409, error: 'already_approved' };
  }
  if (!preOrder.pageArtifacts || preOrder.pageArtifacts.length === 0) {
    return { ok: false, status: 409, error: 'Page review not yet ready for this order' };
  }
  const preTarget = preOrder.pageArtifacts.find((p) => p.pageIndex === input.pageIndex);
  if (!preTarget) return { ok: false, status: 400, error: 'Invalid page index' };

  const { prompt, tags, sanitizedFeedback } = buildRegeneratePrompt({
    basePrompt: preTarget.basePrompt,
    storyText: preTarget.storyText,
    feedback: input.feedback,
    order: {
      childName: preOrder.childName,
      childAge: preOrder.childAge,
      characterNotes: preOrder.characterNotes,
      appearanceOptions: preOrder.appearanceOptions,
      photoBlobPath: preOrder.photoBlobPath ?? null,
      theme: preOrder.theme,
    },
    // Reuse the same frozen anchor that initial generation persisted on this
    // page artifact, so a regenerate can't introduce a new "different kid".
    characterAnchor: preTarget.characterAnchor ?? null,
  });

  const generate = deps.generatePageImage ?? generatePageImage;
  // Pass the customer photo URL so the regenerate request stays on the
  // photo-conditioned provider chain (Seedream primary, Nano Banana edit
  // secondary) when a photo is available — same identity continuity as
  // initial generation, with no text-only fallback.
  const referenceImageUrl = getOrderPhotoUrl(preOrder);
  const result = await generate(
    {
      prompt,
      referenceImageUrl,
      referenceImageRequired: orderRequiresReferenceImage(preOrder),
    },
    { providers: deps.providers },
  );
  const now = (deps.now ?? (() => new Date()))();

  const feedbackEntry: PageFeedbackEntry = {
    createdAt: now.toISOString(),
    rawText: sanitizedFeedback,
    tags,
    providerTried: result.provider,
    resultImageUrl: result.imageUrl,
    success: Boolean(result.imageUrl),
  };

  type RegenApplied = { updatedPage: PageArtifact; preCount: number; order: OrderRecord };
  let applied: { error: RegenerateResult } | RegenApplied;
  try {
    applied = await withOrderMutationLock<{ error: RegenerateResult } | RegenApplied>(
      input.orderId,
      async (lock) =>
        // GUARDED COMMIT. The mutator below runs against the freshly-read order
        // on every attempt and the whole mutation (artifacts + reviewStatus +
        // audit entry) is committed in ONE conditional write keyed on the
        // version we read. The provider call above ran outside the lock, so this
        // is exactly where a lapsed holder must be stopped — and it is stopped
        // by the store rejecting the ifMatch, not by a preceding check.
        withOrderTransaction<{ error: RegenerateResult } | RegenApplied>(
          input.orderId,
          (order) => {
            // AUTHORITATIVE capability + paid/non-refunded gate, re-evaluated
            // against the freshly-read order on every attempt. The token could
            // have been rotated, or the order refunded, while the provider ran.
            const refusal = evaluateReviewMutationEligibility(order, input.actor);
            if (refusal) {
              return { abort: { error: { ok: false, status: refusal.status, error: refusal.error } } };
            }
            if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
              return {
                abort: { error: { ok: false, status: 409, error: 'Page review not yet ready for this order' } },
              };
            }
            // Re-evaluated on the LATEST record every attempt: the book can have
            // been approved while the provider ran, or between a conflict and a
            // retry. Persisting would downgrade reviewStatus to
            // 'customer_changes_requested' on a book that may already be in
            // print, and replace an accepted page's image. Fail closed and
            // discard the generated result.
            if (order.reviewStatus === 'approved') {
              return {
                commit: appendAuditEventTo(order, {
                  type: 'page_regenerate_rejected',
                  pageIndex: input.pageIndex,
                  reason: 'already_approved',
                  meta: { discardedProvider: result.provider, discardedResult: true },
                }),
                result: { error: { ok: false, status: 409, error: 'already_approved' } },
              };
            }
            const latestTarget = order.pageArtifacts.find((p) => p.pageIndex === input.pageIndex);
            if (!latestTarget) {
              return { abort: { error: { ok: false, status: 400, error: 'Invalid page index' } } };
            }
            const { artifacts: updatedArtifacts, page: updatedPage, error } = applyRegeneratePage(
              order.pageArtifacts,
              input.pageIndex,
              result.imageUrl,
              result.provider,
              result.model,
              result.promptUsed,
              feedbackEntry,
              result.conditioning ?? null,
              result.referencePhotoUrl ?? null,
            );
            if (error || !updatedPage) {
              return { abort: { error: { ok: false, status: 400, error: error ?? 'regenerate_failed' } } };
            }
            let next = applyFulfillmentPatchTo(order, {
              pageArtifacts: updatedArtifacts,
              reviewStatus: 'customer_changes_requested',
              // Invalidate the proof acknowledgment HERE, with the content
              // change that caused it. Doing it only on a successful proof
              // refresh would leave a stale ack in force whenever the rebuild
              // fails or is discarded, letting approval pass on an ack the
              // customer gave for different pages.
              proofReviewedAt: null,
            });
            next = appendAuditEventTo(next, {
              type: 'page_regenerated',
              pageIndex: input.pageIndex,
              reason: result.imageUrl ? null : (result.error ?? 'image_generation_failed'),
              meta: {
                provider: result.provider,
                model: result.model,
                regenerateCount: updatedPage.regenerateCount,
                success: Boolean(result.imageUrl),
                tags: tags.join(',') || '',
              },
            });
            return {
              commit: next,
              result: { updatedPage, preCount: latestTarget.regenerateCount, order: next },
            };
          },
          {
            lock,
            notFound: () => ({
              error: { ok: false, status: 409, error: 'Page review not yet ready for this order' },
            }),
          },
        ),
    );
  } catch (error) {
    // A lost lock OR an exhausted CAS retry budget both mean: we could not
    // safely commit. Fail closed with the same safe, retryable response rather
    // than letting a stale write through.
    if (
      error instanceof OrderMutationLockError ||
      error instanceof OrderVersionConflictError
    ) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
  if ('error' in applied) return applied.error;
  const { updatedPage, preCount, order } = applied;

  if (!result.imageUrl) {
    return {
      ok: false,
      status: 502,
      page: updatedPage,
      error: result.error ?? 'image_generation_failed',
    };
  }

  // Auto-refresh the proof PDF using accepted/current per-page URLs.
  //
  // The build is slow, so it runs outside the transaction — but it is BOUND to
  // the exact artifact set it rendered from (sourceFingerprint). Persisting the
  // resulting storyArtifactUrl (and the ack invalidation) happens through a
  // conditional commit that re-checks that fingerprint against the freshly-read
  // order. If a concurrent accept/regenerate/approve changed any page in the
  // meantime, the built proof is stale and is DISCARDED rather than written over
  // newer state. Nothing here uses an unconditional updateFulfillmentState.
  //
  // A successful regen still returns ok:true even if the proof refresh fails —
  // proofRefreshError is surfaced so callers can log/alert without blocking.
  let proofRefreshed = false;
  let proofRefreshError: string | undefined;
  if (!deps.skipProofRebuild) {
    if (deps.rebuildProof) {
      // Legacy TEST-ONLY injection: the stub persists on its own. No production
      // caller supplies this; the default path below is the guarded one.
      try {
        const rb = await deps.rebuildProof(order.id);
        proofRefreshed = rb.ok;
        if (!rb.ok) proofRefreshError = rb.error ?? 'proof_rebuild_failed';
      } catch (err) {
        proofRefreshError = err instanceof Error ? err.message : String(err);
      }
      await appendAuditEvent(order.id, {
        type: 'proof_rebuilt',
        pageIndex: input.pageIndex,
        reason: proofRefreshError ?? null,
        meta: { triggeredBy: 'page_regenerated', success: proofRefreshed },
      });
    } else {
      const outcome = await refreshProofGuarded(order.id, {
        buildProof: deps.buildProof,
        auditPageIndex: input.pageIndex,
        triggeredBy: 'page_regenerated',
        actor: input.actor,
      });
      proofRefreshed = outcome.refreshed;
      proofRefreshError = outcome.error;
    }
  }

  // One-shot operator alert when this regeneration crosses the manual-review threshold.
  // Pre-count is the latest target's count (read under the lock); post-count is
  // updatedPage.regenerateCount. Fire only on the transition, so a 6th/7th regen doesn't re-alert.
  const wasBelow = preCount < REGEN_MANUAL_REVIEW_THRESHOLD;
  const isAtOrAbove = updatedPage.regenerateCount >= REGEN_MANUAL_REVIEW_THRESHOLD;
  if (wasBelow && isAtOrAbove) {
    const alertSender = deps.sendManualReviewAlert ?? sendRegenManualReviewAlert;
    alertSender(order, {
      pageIndex: updatedPage.pageIndex,
      regenerateCount: updatedPage.regenerateCount,
      latestFeedback: sanitizedFeedback,
    }).catch((e) =>
      console.error(`[page-review] manual-review alert failed for ${order.id} page ${updatedPage.pageIndex}:`, e),
    );
  }

  const warning = regenWarningFor(updatedPage.regenerateCount);
  return {
    ok: true,
    status: 200,
    page: updatedPage,
    ...(warning ? { warning } : {}),
    proofRefreshed,
    ...(proofRefreshError ? { proofRefreshError } : {}),
  };
}

export async function acceptPage(input: AcceptInput): Promise<AcceptResult> {
  try {
    // Whole read-modify-write-audit runs under the single per-order lock so a
    // concurrent wording-save/regenerate/approve cannot clobber this write.
    return await withOrderMutationLock(input.orderId, async (lock) =>
      withOrderTransaction<AcceptResult>(
        input.orderId,
        (order) => {
          // AUTHORITATIVE capability + paid/non-refunded gate, re-evaluated
          // against the freshly-read record on every attempt.
          const refusal = evaluateReviewMutationEligibility(order, input.actor);
          if (refusal) {
            return { abort: { ok: false, status: refusal.status, error: refusal.error } };
          }
          // Approved books are frozen. An accept mutates pageArtifacts, so
          // letting it through after approval would rewrite the artifact set the
          // approved (and possibly already-printing) proof was built from.
          if (order.reviewStatus === 'approved') {
            return {
              commit: appendAuditEventTo(order, {
                type: 'page_accept_rejected',
                pageIndex: input.pageIndex,
                reason: 'already_approved',
              }),
              result: { ok: false, status: 409, error: 'already_approved' },
            };
          }
          if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
            return { abort: { ok: false, status: 409, error: 'Page review not yet ready for this order' } };
          }
          const { artifacts, page, error } = applyAcceptPage(order.pageArtifacts, input.pageIndex);
          if (error || !page) {
            return { abort: { ok: false, status: 400, error: error ?? 'accept_failed' } };
          }

          // IMPORTANT: do NOT flip reviewStatus to 'approved' here, even when
          // every page happens to be accepted. 'approved' is reserved exclusively
          // for the approveWholeBook flow (proof acknowledgment + full-proof
          // rebuild). Setting it here would short-circuit the ack/approve gate.
          let next = applyFulfillmentPatchTo(order, { pageArtifacts: artifacts });
          next = appendAuditEventTo(next, {
            type: 'page_accepted',
            pageIndex: input.pageIndex,
            meta: {
              acceptedCount: artifacts.filter((p) => p.accepted).length,
              totalPages: artifacts.length,
              regenerateCountAtAccept: page.regenerateCount,
            },
          });
          return { commit: next, result: { ok: true, status: 200, page } };
        },
        { lock, notFound: () => ({ ok: false, status: 404, error: 'Order not found' }) },
      ),
    );
  } catch (error) {
    // A lost lock OR an exhausted CAS retry budget both mean: we could not
    // safely commit. Fail closed with the same safe, retryable response rather
    // than letting a stale write through.
    if (
      error instanceof OrderMutationLockError ||
      error instanceof OrderVersionConflictError
    ) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

// ── Approve whole book ───────────────────────────────────────────────────────

interface ApprovalGateRejection {
  reason: string;
  status: 409 | 502;
  error: string;
  meta?: Record<string, string | number | boolean | null>;
}

/**
 * Pure server-side approval gate. Returns a rejection or null.
 *
 * Shared deliberately: approveWholeBook evaluates it BOTH before the proof
 * rebuild and again inside the committing transaction, so a wording request,
 * an un-accept, or a competing approval that lands during the rebuild still
 * blocks the commit. The client's disabled button is never trusted.
 *
 * `requireProofAck` is false ONLY on the legacy `deps.rebuildProof` path, where
 * the injected rebuilder clears proofReviewedAt as part of its own update, so
 * re-checking the ack afterwards would reject the very approval that triggered
 * it. On the production (build-only) path nothing clears the ack before the
 * commit, so it stays enforced in the committing transaction. Skipping it on the
 * legacy path does not weaken the gate: clearing an ack only makes approval
 * harder, and setting one requires the review token.
 */
function evaluateApprovalGateRejection(
  order: OrderRecord,
  opts: { requireProofAck: boolean } = { requireProofAck: true },
): ApprovalGateRejection | null {
  if (order.reviewStatus === 'approved') {
    return { reason: 'already_approved', status: 409, error: 'Order is already approved' };
  }
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
    return {
      reason: 'review_not_ready',
      status: 409,
      error: 'Page review not yet ready for this order',
    };
  }
  if (!order.pageArtifacts.every((p) => p.accepted && p.acceptedImageUrl)) {
    return {
      reason: 'pages_not_accepted',
      status: 409,
      error: 'All pages must be accepted before approving the whole book',
      meta: {
        acceptedCount: order.pageArtifacts.filter((p) => p.accepted).length,
        totalPages: order.pageArtifacts.length,
      },
    };
  }
  // The full proof PDF must exist on the order. Without it the customer is
  // approving the illustrated pages only, which is the exact UX bug we fixed.
  if (!order.storyArtifactUrl) {
    return { reason: 'proof_not_ready', status: 409, error: 'Full proof PDF is not ready yet' };
  }
  // Fail closed while any customer text-change request is still unresolved.
  if (hasUnresolvedChangeRequests(order.pageArtifacts)) {
    return {
      reason: 'unresolved_change_requests',
      status: 409,
      error: 'Resolve the pending text-change requests before approving the whole book',
      meta: {
        unresolvedPages: order.pageArtifacts.filter(
          (p) =>
            p.customerReviewStatus === 'changes_requested' ||
            (p.customerRequestedChange != null &&
              p.customerRequestedChange.lifecycleStatus !== 'resolved'),
        ).length,
      },
    };
  }
  // Server-side enforcement of the proof acknowledgment.
  if (opts.requireProofAck && !order.proofReviewedAt) {
    return {
      reason: 'proof_ack_missing',
      status: 409,
      error:
        'Proof acknowledgment required — confirm you reviewed the full proof PDF before approving',
    };
  }
  return null;
}

export interface ApproveWholeBookResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404 | 409 | 502;
  proofUrl?: string;
  error?: string;
  /** True iff the book was passed into the print-approval flow (print orders only). */
  printApproved?: boolean;
}

export interface ApproveWholeBookDeps {
  /** @deprecated TEST-ONLY legacy shim: persists unconditionally on its own. */
  rebuildProof?: typeof rebuildProofFromPageArtifacts;
  /** Inject the build-only proof step; persisting stays guarded. */
  buildProof?: typeof buildProofArtifactFromPageArtifacts;
  /** Optional injection point for the print-approval handoff (tests). */
  approvePrint?: (orderId: string, token: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Customer-driven whole-book approval from the review page.
 * - Verifies every page is accepted.
 * - Rebuilds the proof artifact from accepted/current per-page images.
 * - Marks reviewStatus = 'approved'.
 * - For print orders: hands off to the existing approvePrintProof flow using
 *   the order's stored proofApprovalToken so the print pipeline runs unchanged.
 * - For digital orders: stops at the refreshed proof URL (delivery email
 *   already went out with the original digital PDF; the refreshed one is
 *   reachable via /status and the review page).
 */
export async function approveWholeBook(
  orderId: string,
  deps: ApproveWholeBookDeps = {},
  opts: ReviewActorInput = {},
): Promise<ApproveWholeBookResult> {
  type Proceed = { proofUrl: string | undefined; isPrint: boolean; token: string | null };
  let outcome: { done: ApproveWholeBookResult } | { proceed: Proceed };
  try {
    // Gate checks + proof rebuild + the reviewStatus='approved' transition all
    // run under the single per-order lock, so a concurrent wording-save can't
    // slip an unresolved request past the gate and be silently overwritten. The
    // slow print handoff is deliberately performed AFTER the lock (see below).
    // Phase 1 — gate check under the lock. The lock is RELEASED before the slow
    // proof render so a concurrent review mutation is not blocked for the whole
    // duration; phase 3 re-acquires it and re-validates everything.
    const gateOutcome = await withOrderMutationLock<{ done: ApproveWholeBookResult } | { ready: true }>(
      orderId,
      async (lock) => {
        // Validate the approval gates against the latest record. A
        // rejection is itself committed conditionally (it appends an audit
        // event), so it cannot clobber a concurrent change either.
        const pre = await withOrderTransaction<{ done: ApproveWholeBookResult } | { ready: true }>(
          orderId,
          (order) => {
            // AUTHORITATIVE capability + paid/non-refunded gate first.
            const refusal = evaluateReviewMutationEligibility(order, opts.actor);
            if (refusal) {
              // Abort, do NOT commit: an ineligible caller must leave no audit
              // trace and must not be able to append rows to the order.
              return { abort: { done: { ok: false, status: refusal.status, error: refusal.error } } };
            }
            const gate = evaluateApprovalGateRejection(order);
            if (gate) {
              return {
                commit: appendAuditEventTo(order, {
                  type: 'whole_book_approval_rejected',
                  reason: gate.reason,
                  ...(gate.meta ? { meta: gate.meta } : {}),
                }),
                result: { done: { ok: false, status: gate.status, error: gate.error } },
              };
            }
            return { abort: { ready: true } };
          },
          { lock, notFound: () => ({ done: { ok: false, status: 404, error: 'Order not found' } }) },
        );
        return pre;
      },
    );
    if ('done' in gateOutcome) return gateOutcome.done;

    // Phase 2 — produce the proof PDF with NO lock held. Rendering is slow, so it
    // happens outside both the lock and the committing transaction. By default it
    // is BUILD-ONLY (`buildProofArtifactFromPageArtifacts`) and persists nothing:
    // the resulting storyArtifactUrl is written by the guarded commit in phase 3,
    // bound to the artifact fingerprint it was rendered from. An earlier
    // unconditional rebuild would NOT have been made safe by a later guarded
    // approval write.
    //
    // `deps.rebuildProof` is a legacy TEST-ONLY injection point that persists on
    // its own; no production caller supplies it.
    const legacyPersisted = Boolean(deps.rebuildProof);
    const rb = legacyPersisted
      ? await deps.rebuildProof!(orderId)
      : await (deps.buildProof ?? buildProofArtifactFromPageArtifacts)(orderId);
    const builtFrom = legacyPersisted ? undefined : (rb as ProofBuildResult).sourceFingerprint;
    if (!rb.ok) {
      try {
        await withOrderMutationLock(orderId, async (lock) =>
          withOrderTransaction<null>(
            orderId,
            (order) => ({
              commit: appendAuditEventTo(order, {
                type: 'whole_book_approval_rejected',
                reason: 'proof_rebuild_failed',
                meta: { error: rb.error ?? 'proof_rebuild_failed' },
              }),
              result: null,
            }),
            { lock, notFound: () => null },
          ),
        );
      } catch {
        /* audit is best-effort; the refusal below is what matters */
      }
      return { ok: false, status: 502, error: rb.error ?? 'proof_rebuild_failed' };
    }

    // Phase 3 — re-acquire the lock and commit. Re-read post-render, RE-VALIDATE
    // every gate against that fresh record (so a wording request, an un-accept,
    // a refund, a rotated token, or a competing approval that landed during the
    // render still blocks us), verify the proof still matches the artifact set it
    // was rendered from, then write reviewStatus='approved' + storyArtifactUrl +
    // both audit entries in ONE conditional write.
    outcome = await withOrderMutationLock<{ done: ApproveWholeBookResult } | { proceed: Proceed }>(
      orderId,
      async (lock) =>
        withOrderTransaction<{ done: ApproveWholeBookResult } | { proceed: Proceed }>(
          orderId,
          (order) => {
            // Re-check the capability/paid/refund gate on the fresh record too.
            const refusal2 = evaluateReviewMutationEligibility(order, opts.actor);
            if (refusal2) {
              return { abort: { done: { ok: false, status: refusal2.status, error: refusal2.error } } };
            }
            // The proof was rendered outside this transaction. If the artifact
            // set moved underneath it, the built PDF no longer represents the
            // book — refuse rather than approve against a stale proof.
            if (builtFrom && proofSourceFingerprint(order.pageArtifacts ?? []) !== builtFrom) {
              return {
                commit: appendAuditEventTo(order, {
                  type: 'whole_book_approval_rejected',
                  reason: 'proof_source_changed_during_rebuild',
                }),
                result: {
                  done: {
                    ok: false,
                    status: 409,
                    error: 'proof_source_changed_during_rebuild',
                  },
                },
              };
            }
            // requireProofAck is false ONLY on the legacy path, where the
            // injected rebuild cleared the ack itself. On the guarded path
            // nothing cleared it, so the ack stays enforced here too.
            const gate = evaluateApprovalGateRejection(order, {
              requireProofAck: !legacyPersisted,
            });
            if (gate) {
              return {
                commit: appendAuditEventTo(order, {
                  type: 'whole_book_approval_rejected',
                  reason: gate.reason,
                  ...(gate.meta ? { meta: gate.meta } : {}),
                }),
                result: { done: { ok: false, status: gate.status, error: gate.error } },
              };
            }
            let next = appendAuditEventTo(order, {
              type: 'proof_rebuilt',
              reason: null,
              meta: { triggeredBy: 'whole_book_approved', success: true },
            });
            // Guarded path: the freshly-built proof URL is persisted HERE, in the
            // same conditional write as the approval — never through an earlier
            // unconditional updateFulfillmentState.
            next = applyFulfillmentPatchTo(next, {
              reviewStatus: 'approved',
              ...(legacyPersisted ? {} : { storyArtifactUrl: rb.proofUrl }),
            });
            next = appendAuditEventTo(next, {
              type: 'whole_book_approved',
              meta: { bookFormat: order.bookFormat, proofUrl: rb.proofUrl ?? null },
            });
            const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
            return {
              commit: next,
              result: {
                proceed: { proofUrl: rb.proofUrl, isPrint, token: order.proofApprovalToken ?? null },
              },
            };
          },
          { lock, notFound: () => ({ done: { ok: false, status: 404, error: 'Order not found' } }) },
        ),
    );
  } catch (error) {
    // A lost lock OR an exhausted CAS retry budget both mean: we could not
    // safely commit. Fail closed with the same safe, retryable response rather
    // than letting a stale write through.
    if (
      error instanceof OrderMutationLockError ||
      error instanceof OrderVersionConflictError
    ) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }

  if ('done' in outcome) return outcome.done;
  const { proofUrl, isPrint, token } = outcome.proceed;

  if (!isPrint) {
    return { ok: true, status: 200, proofUrl, printApproved: false };
  }
  // Print: hand off to the existing approve-proof flow using the stored token.
  // No token means we never reached proof_ready; flag the gap for ops.
  if (!token) {
    return { ok: true, status: 200, proofUrl, printApproved: false };
  }

  // The print handoff runs OUTSIDE the order mutation lock: it can be
  // long-running (print production + retries) and the 'approved' state is
  // already durably persisted. approvePrintProof carries its own token +
  // fulfillment-state guards.
  const approveFn = deps.approvePrint ?? (await import('./fulfillment.ts')).approvePrintProof;
  try {
    const handoff = await approveFn(orderId, token);
    if (!handoff.ok) {
      return {
        ok: true,
        status: 200,
        proofUrl,
        printApproved: false,
        error: handoff.error ?? 'print_approval_handoff_failed',
      };
    }
    return { ok: true, status: 200, proofUrl, printApproved: true };
  } catch (err) {
    return {
      ok: true,
      status: 200,
      proofUrl,
      printApproved: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Proof acknowledgment (persisted) ────────────────────────────────────────

export interface AckProofResult {
  ok: boolean;
  status: 200 | 403 | 404 | 409;
  proofReviewedAt?: string;
  error?: string;
}

/**
 * Persist the customer's "I reviewed the full proof PDF" acknowledgment.
 * Required server-side before approveWholeBook will run. Idempotent — calling
 * it again on an already-acknowledged order returns the existing timestamp.
 */
export async function acknowledgeProofReview(
  orderId: string,
  now: Date = new Date(),
  opts: ReviewActorInput = {},
): Promise<AckProofResult> {
  try {
    return await withOrderMutationLock(orderId, async (lock) =>
      withOrderTransaction<AckProofResult>(
        orderId,
        (order) => {
          // AUTHORITATIVE capability + paid/non-refunded gate.
          const refusal = evaluateReviewMutationEligibility(order, opts.actor);
          if (refusal) {
            return { abort: { ok: false, status: refusal.status, error: refusal.error } };
          }
          if (!order.storyArtifactUrl) {
            return {
              abort: {
                ok: false,
                status: 409,
                error: 'Full proof PDF is not ready yet — cannot acknowledge what does not exist',
              },
            };
          }
          // Re-evaluated on the latest record: an approval that landed
          // concurrently must not be reopened by a late acknowledgment.
          if (order.reviewStatus === 'approved') {
            return { abort: { ok: false, status: 409, error: 'Order is already approved' } };
          }
          if (order.proofReviewedAt) {
            // Idempotent: nothing to commit.
            return { abort: { ok: true, status: 200, proofReviewedAt: order.proofReviewedAt } };
          }
          const ts = now.toISOString();
          let next = applyFulfillmentPatchTo(order, { proofReviewedAt: ts });
          next = appendAuditEventTo(next, { at: ts, type: 'proof_review_acknowledged' });
          return { commit: next, result: { ok: true, status: 200, proofReviewedAt: ts } };
        },
        { lock, notFound: () => ({ ok: false, status: 404, error: 'Order not found' }) },
      ),
    );
  } catch (error) {
    // A lost lock OR an exhausted CAS retry budget both mean: we could not
    // safely commit. Fail closed with the same safe, retryable response rather
    // than letting a stale write through.
    if (
      error instanceof OrderMutationLockError ||
      error instanceof OrderVersionConflictError
    ) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

// ── Approval-gate helpers (pure, testable) ──────────────────────────────────

export type ApproveBlockReason =
  | 'pages_not_accepted'
  | 'proof_not_ready'
  | 'proof_ack_missing'
  | 'unresolved_change_requests'
  | 'already_approved'
  | null;

/**
 * True when any page still carries an unresolved customer text-change request.
 * A request is unresolved while its lifecycle status is anything other than
 * 'resolved' (mirrored by customerReviewStatus === 'changes_requested'). Pure so
 * both the approve gate and tests can share one definition.
 */
export function hasUnresolvedChangeRequests(pages: PageArtifact[]): boolean {
  return pages.some(
    (p) =>
      p.customerReviewStatus === 'changes_requested' ||
      (p.customerRequestedChange != null &&
        p.customerRequestedChange.lifecycleStatus !== 'resolved'),
  );
}

/**
 * Returns null when the customer is allowed to approve the whole book, or a
 * specific reason string otherwise. Mirrors the disabled-state logic on
 * /review/[orderId] so tests can lock the contract without rendering React.
 *
 *   1. all illustrated pages must be accepted
 *   2. the assembled proof PDF must exist (storyArtifactUrl)
 *   3. no unresolved customer text-change requests remain
 *   4. the customer must check the "I reviewed the full proof PDF" ack
 *   5. order must not already be approved
 */
export function evaluateApproveGate(args: {
  pageArtifacts: PageArtifact[];
  reviewStatus: NonNullable<OrderRecord['reviewStatus']>;
  storyArtifactUrl: string | null;
  proofAcknowledged: boolean;
}): ApproveBlockReason {
  if (args.reviewStatus === 'approved') return 'already_approved';
  if (args.pageArtifacts.length === 0) return 'pages_not_accepted';
  const allAccepted = args.pageArtifacts.every((p) => p.accepted);
  if (!allAccepted) return 'pages_not_accepted';
  if (!args.storyArtifactUrl) return 'proof_not_ready';
  if (hasUnresolvedChangeRequests(args.pageArtifacts)) return 'unresolved_change_requests';
  if (!args.proofAcknowledged) return 'proof_ack_missing';
  return null;
}

export interface ReviewAccessInput {
  /** Token from /review/<orderId>?token=... links. Required for print orders
   *  once a proofApprovalToken exists, so a bare order id is not enough to
   *  open the public-facing proof review route. */
  reviewToken?: string | null;
}

export interface ReviewSnapshot {
  orderId: string;
  childName: string;
  reviewStatus: NonNullable<OrderRecord['reviewStatus']>;
  pageArtifacts: PageArtifact[];
  /** Full assembled proof PDF URL — for print orders this is the print-ready
   *  proof including any padded keepsake pages required by Lulu. */
  storyArtifactUrl: string | null;
  /** True when the order is classic/premium (book ships physically). */
  isPrint: boolean;
  bookFormat: OrderRecord['bookFormat'];
  /** Persisted server-side ack timestamp; null until the customer ticks it. */
  proofReviewedAt: string | null;
}

export function hasReviewAccess(order: OrderRecord, input: ReviewAccessInput = {}): boolean {
  // Legacy/in-progress orders may not have a prepared token yet. Once a token
  // exists, both digital and print review reads become capability-gated.
  if (!order.proofApprovalToken) return true;
  return tokensMatch(order.proofApprovalToken, input.reviewToken ?? '');
}

export async function getReviewSnapshot(
  orderId: string,
  input: ReviewAccessInput = {},
): Promise<ReviewSnapshot | null> {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) return null;
  if (!hasReviewAccess(order, input)) return null;
  const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
  return {
    orderId: order.id,
    childName: order.childName,
    reviewStatus: order.reviewStatus ?? 'in_review',
    pageArtifacts: [...order.pageArtifacts].sort((a, b) => a.pageIndex - b.pageIndex),
    storyArtifactUrl: order.storyArtifactUrl ?? null,
    isPrint,
    bookFormat: order.bookFormat,
    proofReviewedAt: order.proofReviewedAt ?? null,
  };
}

// ── Customer text-change requests (editable review) ─────────────────────────

/** Constant-time token comparison. Never `===` on secrets. */
function tokensMatch(stored: string, provided: string): boolean {
  if (!stored || !provided || stored.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(provided));
  } catch {
    return false;
  }
}

/**
 * Authorization for customer WRITES to the review surface (submitting a
 * text-change request). Stricter than hasReviewAccess (which allows read for
 * digital orders): a write ALWAYS requires a prepared proof token that matches,
 * for both digital and print orders. A bare order id never authorizes a write.
 */
export function hasReviewWriteAccess(order: OrderRecord, input: ReviewAccessInput = {}): boolean {
  if (!order.proofApprovalToken) return false;
  return tokensMatch(order.proofApprovalToken, input.reviewToken ?? '');
}

export function reviewPathFor(orderId: string, token: string): string {
  return `/review/${orderId}?token=${token}`;
}

export interface SaveTextChangeInput {
  orderId: string;
  pageIndex: number;
  note: string;
  reviewToken?: string | null;
}

export interface SaveTextChangeResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404 | 409 | 500;
  page?: PageArtifact;
  error?: string;
}

/**
 * Persist a page-specific customer text-change request via the pure
 * recordCustomerTextChangeRequest contract. This records review intent only:
 * it never alters canonical caption/manuscript text, changes payment, sets
 * reviewStatus to 'approved', rotates the proof token, marks a page accepted,
 * acknowledges the proof, calls approveWholeBook, or triggers rebuild /
 * fulfillment / email / provider work.
 *
 * The full read/modify/write/audit sequence runs under the order storage
 * layer's single-writer lock. This prevents two requests from both passing a
 * check-then-write guard against the last-write-wins order blob.
 */
export async function saveTextChangeRequest(
  input: SaveTextChangeInput,
  deps: { now?: () => Date } = {},
): Promise<SaveTextChangeResult> {
  if (!Number.isInteger(input.pageIndex) || input.pageIndex < 0) {
    return { ok: false, status: 400, error: 'invalid_page_index' };
  }
  if (typeof input.note !== 'string') {
    return { ok: false, status: 400, error: 'invalid_note' };
  }
  try {
    return await withOrderMutationLock(input.orderId, async (lock) =>
      withOrderTransaction<SaveTextChangeResult>(
        input.orderId,
        (order) => {
          const now = (deps.now ?? (() => new Date()))();
          // Every security and approval invariant is re-evaluated against the
          // freshly-read record on each attempt — a retry can never inherit a
          // stale authorization or a stale reviewStatus.
          const refusal = evaluateReviewMutationEligibility(
            order,
            customerReviewActor(input.reviewToken),
          );
          if (refusal) {
            return { abort: { ok: false, status: refusal.status, error: refusal.error } };
          }
          // Once approved, the book is locked: a wording request must not
          // downgrade reviewStatus back to 'customer_changes_requested'.
          if (order.reviewStatus === 'approved') {
            return { abort: { ok: false, status: 409, error: 'already_approved' } };
          }
          if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
            return { abort: { ok: false, status: 409, error: 'review_not_ready' } };
          }
          const target = order.pageArtifacts.find((p) => p.pageIndex === input.pageIndex);
          if (!target) return { abort: { ok: false, status: 400, error: 'invalid_page' } };

          let updatedPage: PageArtifact;
          try {
            const recordInput: RecordCustomerTextChangeInput = {
              note: input.note,
              at: now.toISOString(),
            };
            updatedPage = recordCustomerTextChangeRequest(target, recordInput);
          } catch {
            return { abort: { ok: false, status: 400, error: 'empty_or_invalid_note' } };
          }

          const updatedArtifacts = order.pageArtifacts.map((p) =>
            p.pageIndex === input.pageIndex ? updatedPage : p,
          );

          let next = applyFulfillmentPatchTo(order, {
            pageArtifacts: updatedArtifacts,
            reviewStatus: 'customer_changes_requested',
          });
          // Audit minimally: page + note length only. Never the note text or a token.
          next = appendAuditEventTo(next, {
            type: 'customer_text_change_requested',
            pageIndex: input.pageIndex,
            meta: { noteChars: updatedPage.customerRequestedChange?.note.length ?? 0 },
          });
          return { commit: next, result: { ok: true, status: 200, page: updatedPage } };
        },
        { lock, notFound: () => ({ ok: false, status: 404, error: 'order_not_found' }) },
      ),
    );
  } catch (error) {
    // A lost lock OR an exhausted CAS retry budget both mean: we could not
    // safely commit. Fail closed with the same safe, retryable response rather
    // than letting a stale write through.
    if (
      error instanceof OrderMutationLockError ||
      error instanceof OrderVersionConflictError
    ) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

// ── Review-link preparation (authorized admin/system step) ───────────────────

export interface PrepareReviewLinkResult {
  ok: boolean;
  status: 200 | 404 | 409;
  token?: string;
  reviewPath?: string;
  alreadyPrepared?: boolean;
  error?: string;
}

/**
 * Create or preserve a customer review token for a paid order that already has
 * a review artifact. Reuses the SAME proofApprovalToken model the print proof
 * flow uses (crypto.randomBytes(24) hex) rather than introducing a second token
 * model. Idempotent (preserves an existing token, never rotates), auditable,
 * and refuses unpaid / missing-artifact / not-yet-reviewable orders. It never
 * sends email — link preparation and customer delivery are separate,
 * separately-authorized actions. The route that calls this must be
 * admin-authenticated.
 */
export async function prepareCustomerReviewLink(
  orderId: string,
  deps: { tokenFactory?: () => string } = {},
): Promise<PrepareReviewLinkResult> {
  try {
    return await withOrderMutationLock(orderId, async (lock) =>
      withOrderTransaction<PrepareReviewLinkResult>(
        orderId,
        (order) => {
          if (order.paymentStatus !== 'paid') {
            return { abort: { ok: false, status: 409, error: 'order_not_paid' } };
          }
          // A refunded order is terminal: never mint or hand back a review
          // capability for it, even idempotently.
          if (order.refundedAt || order.stripeRefundId) {
            return { abort: { ok: false, status: 409, error: 'order_refunded' } };
          }
          if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
            return { abort: { ok: false, status: 409, error: 'review_not_ready' } };
          }
          if (!order.storyArtifactUrl) {
            return { abort: { ok: false, status: 409, error: 'review_artifact_missing' } };
          }

          // Idempotent: preserve any existing token (print orders already carry
          // one). Re-checked against the latest record on every attempt, so a
          // retry can never rotate a token another writer just prepared.
          if (order.proofApprovalToken) {
            return {
              abort: {
                ok: true,
                status: 200,
                token: order.proofApprovalToken,
                reviewPath: reviewPathFor(orderId, order.proofApprovalToken),
                alreadyPrepared: true,
              },
            };
          }

          const token = (deps.tokenFactory ?? (() => crypto.randomBytes(24).toString('hex')))();
          let next = applyFulfillmentPatchTo(order, { proofApprovalToken: token });
          next = appendAuditEventTo(next, {
            type: 'review_link_prepared',
            // Never log the token value. Record only non-sensitive shape.
            meta: { hadExistingToken: false, bookFormat: order.bookFormat },
          });
          return {
            commit: next,
            result: {
              ok: true,
              status: 200,
              token,
              reviewPath: reviewPathFor(orderId, token),
              alreadyPrepared: false,
            },
          };
        },
        { lock, notFound: () => ({ ok: false, status: 404, error: 'order_not_found' }) },
      ),
    );
  } catch (error) {
    // A lost lock OR an exhausted CAS retry budget both mean: we could not
    // safely commit. Fail closed with the same safe, retryable response rather
    // than letting a stale write through.
    if (
      error instanceof OrderMutationLockError ||
      error instanceof OrderVersionConflictError
    ) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}
