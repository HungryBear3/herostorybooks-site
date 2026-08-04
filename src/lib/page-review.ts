// Customer page-review service.
//
// CONCURRENCY: every mutation here is a single `withOrderTransaction` — a
// versioned read, a full recompute against that record, and a conditional
// commit, with bounded retry from a fresh read. There is deliberately NO
// distributed lock: the order-record ETag/ifMatch CAS is the only correctness
// boundary. Slow work (image generation, PDF rendering) runs strictly outside
// the transaction and is bound to the state it was computed from by an explicit
// proof fingerprint.
//
// PRODUCT: customer approval and print release are SEPARATE gates.
// `approveWholeBook` verifies the customer reviewed the exact current proof,
// sets reviewStatus='approved', appends audit, and stops. It never rebuilds a
// proof and never touches print, email, payment, refund, fulfillment or any
// external provider.

import crypto from 'node:crypto';

import {
  appendAuditEventTo,
  applyFulfillmentPatchTo,
  getOrder,
  getOrderPhotoUrl,
  OrderVersionConflictError,
  orderRequiresReferenceImage,
  withOrderTransaction,
} from './orders.ts';
import type { OrderRecord, PageArtifact, PageFeedbackEntry, PageVersionEntry } from './orders.ts';
import { generatePageImage, type ImageProvider } from './image-generator.ts';
import { buildRegeneratePrompt } from './image-prompt-builder.ts';
import {
  buildProofArtifactFromPageArtifacts,
  isUsableProofBuild,
  proofSourceFingerprint,
} from './fulfillment.ts';
import { sendRegenManualReviewAlert } from './order-email.ts';
import {
  hasUnresolvedChangeRequests,
  recordCustomerTextChangeRequest,
  type RecordCustomerTextChangeInput,
} from './customer-text-change-request.ts';
import { pageGenerationSourceFingerprint } from './review-source-identity.ts';

// Soft internal thresholds (runbook): warn at 3, manual review at 5.
export const REGEN_WARNING_THRESHOLD = 3;
export const REGEN_MANUAL_REVIEW_THRESHOLD = 5;

// ── Review capability + eligibility ─────────────────────────────────────────

/**
 * Who is performing a review mutation.
 *
 * `customer` carries the capability token from the tokenized review link. It is
 * passed into the mutator so it can be revalidated against the order as read
 * INSIDE the transaction on every attempt — route-level authorization is only
 * an early-refusal optimization, never the gate of record, because a token can
 * be rotated (or the order refunded) between the route check and the commit.
 *
 * `internal` is for operator/system callers that present no capability. It must
 * be stated explicitly at the call site and is still subject to every
 * non-capability gate.
 */
export type ReviewActor =
  | { kind: 'customer'; reviewToken?: string | null }
  | { kind: 'internal'; reason: string };

export const INTERNAL_REVIEW_ACTOR: ReviewActor = { kind: 'internal', reason: 'direct_service_call' };

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
 * the transaction. Fails closed on a missing/mismatched capability, on anything
 * other than a paid order, and on any refund marker even when paymentStatus
 * still reads 'paid'. A refunded order is terminal for customer review: no
 * review state, proof, audit, print, email or provider work may follow it.
 */
export function evaluateReviewMutationEligibility(
  order: OrderRecord,
  actor: ReviewActor = INTERNAL_REVIEW_ACTOR,
): ReviewMutationRefusal | null {
  if (actor.kind === 'customer' && !hasReviewWriteAccess(order, { reviewToken: actor.reviewToken })) {
    return { status: 403, error: 'invalid_or_missing_token' };
  }
  if (order.paymentStatus !== 'paid') return { status: 403, error: 'order_not_eligible' };
  if (order.refundedAt || order.stripeRefundId) return { status: 403, error: 'order_refunded' };
  return null;
}

/**
 * The five fields that identify the currently published proof plus the
 * acknowledgment bound to it. A rendered-content mutation clears them together,
 * in the same commit as the content change, so there is never a window where a
 * stale proof is advertised or a stale acknowledgment is in force.
 */
export const CLEARED_PROOF_STATE = {
  storyArtifactUrl: null,
  proofSourceFingerprint: null,
  proofVersion: null,
  proofReviewedAt: null,
  proofReviewedVersion: null,
} as const;

/** True when the persisted proof identity is complete AND matches the pages. */
export function proofIsFresh(order: OrderRecord): boolean {
  if (!order.storyArtifactUrl) return false;
  if (!order.proofSourceFingerprint || !order.proofVersion) return false;
  return order.proofSourceFingerprint === proofSourceFingerprint(order);
}

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
  /** True iff a NEW proof revision was published after this regeneration. */
  proofRefreshed?: boolean;
  proofRefreshError?: string;
  /** Exact record committed by the final successful mutation step. */
  snapshot?: ReviewSnapshot;
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
  snapshot?: ReviewSnapshot;
}

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

// ── Service entry points ─────────────────────────────────────────────────────


// ── Guarded proof publication ───────────────────────────────────────────────

export interface ProofPublishResult {
  refreshed: boolean;
  error?: string;
  proofVersion?: string;
  snapshot?: ReviewSnapshot;
}

/**
 * Publish a freshly built proof through a conditional, fingerprint-checked
 * commit.
 *
 * The render happened outside any transaction, so before persisting anything we
 * re-read the order and require: a usable build (URL + fingerprint + version all
 * present at runtime), a still-valid capability, paid and non-refunded state, a
 * book that is not already approved, and a page set whose fingerprint still
 * equals the one the PDF was rendered from.
 *
 * If any of that fails the built artifact is DISCARDED. Nothing is advertised:
 * `storyArtifactUrl` stays null, so no acknowledgment and no approval can
 * proceed until a fresh proof is successfully published.
 */
export async function publishProofGuarded(
  orderId: string,
  built: unknown,
  opts: { actor?: ReviewActor; auditPageIndex?: number } = {},
): Promise<ProofPublishResult> {
  // Fail closed on a claimed-successful build that is missing any identity
  // field. This is a RUNTIME check; the discriminated union alone is not
  // enough, because an injected or future builder can lie about its shape.
  if (!isUsableProofBuild(built as never)) {
    const err =
      built && typeof built === 'object' && 'error' in (built as Record<string, unknown>)
        ? String((built as Record<string, unknown>).error)
        : 'proof_build_incomplete';
    return { refreshed: false, error: err };
  }
  const usable = built as { proofUrl: string; sourceFingerprint: string; proofVersion: string };

  try {
    return await withOrderTransaction<ProofPublishResult>(
      orderId,
      (order) => {
        const refusal = evaluateReviewMutationEligibility(order, opts.actor);
        if (refusal) return { abort: { refreshed: false, error: refusal.error } };
        // An approved book is frozen: never replace its proof or clear its ack.
        if (order.reviewStatus === 'approved') {
          return { abort: { refreshed: false, error: 'already_approved' } };
        }
        if (hasUnresolvedChangeRequests(order.pageArtifacts ?? [])) {
          return { abort: { refreshed: false, error: 'unresolved_change_requests' } };
        }
        if (proofSourceFingerprint(order) !== usable.sourceFingerprint) {
          return { abort: { refreshed: false, error: 'proof_source_changed_during_rebuild' } };
        }
        let next = applyFulfillmentPatchTo(order, {
          storyArtifactUrl: usable.proofUrl,
          proofSourceFingerprint: usable.sourceFingerprint,
          proofVersion: usable.proofVersion,
          // A newly published revision has not been acknowledged.
          proofReviewedAt: null,
          proofReviewedVersion: null,
        });
        next = appendAuditEventTo(next, {
          type: 'proof_published',
          ...(opts.auditPageIndex != null ? { pageIndex: opts.auditPageIndex } : {}),
          meta: { proofVersion: usable.proofVersion },
        });
        return {
          commit: next,
          result: {
            refreshed: true,
            proofVersion: usable.proofVersion,
            snapshot: reviewSnapshotFromOrder(next),
          },
        };
      },
      { notFound: () => ({ refreshed: false, error: 'order_not_found' }) },
    );
  } catch (err) {
    if (err instanceof OrderVersionConflictError) {
      return { refreshed: false, error: 'order_mutation_busy' };
    }
    return { refreshed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Service entry points ───────────────────────────────────────────────────

export interface RegenerateDeps {
  providers?: ImageProvider[];
  generatePageImage?: typeof generatePageImage;
  now?: () => Date;
  /** Build-only proof step. Publishing is always guarded. */
  buildProof?: typeof buildProofArtifactFromPageArtifacts;
  sendManualReviewAlert?: typeof sendRegenManualReviewAlert;
  /** Skip proof publication entirely (tests that do not exercise it). */
  skipProofRebuild?: boolean;
}

export async function regeneratePage(
  input: RegenerateInput,
  deps: RegenerateDeps = {},
): Promise<RegenerateResult> {
  // Pre-flight: validate and build the prompt. The provider call must NOT be
  // inside the transaction, so the result is applied to a fresh record after.
  const preOrder = await getOrder(input.orderId);
  if (!preOrder) return { ok: false, status: 404, error: 'Order not found' };
  const preRefusal = evaluateReviewMutationEligibility(preOrder, input.actor);
  if (preRefusal) return { ok: false, status: preRefusal.status, error: preRefusal.error };
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
    characterAnchor: preTarget.characterAnchor ?? null,
  });

  const generate = deps.generatePageImage ?? generatePageImage;
  const referenceImageUrl = getOrderPhotoUrl(preOrder);
  const referenceImageRequired = orderRequiresReferenceImage(preOrder);
  const generationSource = pageGenerationSourceFingerprint({
    order: preOrder,
    page: preTarget,
    referenceImageUrl,
    referenceImageRequired,
  });
  const result = await generate(
    { prompt, referenceImageUrl, referenceImageRequired },
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

  type Applied = { updatedPage: PageArtifact; preCount: number; snapshot: ReviewSnapshot };
  let applied: { error: RegenerateResult } | Applied;
  try {
    applied = await withOrderTransaction<{ error: RegenerateResult } | Applied>(
      input.orderId,
      (order) => {
        // AUTHORITATIVE gate, re-evaluated on the freshly-read record: the
        // capability can have been rotated, or the order refunded, while the
        // provider ran.
        const refusal = evaluateReviewMutationEligibility(order, input.actor);
        if (refusal) {
          return { abort: { error: { ok: false, status: refusal.status, error: refusal.error } } };
        }
        if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
          return { abort: { error: { ok: false, status: 409, error: 'Page review not yet ready for this order' } } };
        }
        if (order.reviewStatus === 'approved') {
          return {
            commit: appendAuditEventTo(order, {
              type: 'page_regenerate_rejected',
              pageIndex: input.pageIndex,
              reason: 'already_approved',
              meta: { discardedProvider: result.provider },
            }),
            result: { error: { ok: false, status: 409, error: 'already_approved' } },
          };
        }
        const latestTarget = order.pageArtifacts.find((p) => p.pageIndex === input.pageIndex);
        if (!latestTarget) {
          return { abort: { error: { ok: false, status: 400, error: 'Invalid page index' } } };
        }
        const latestReferenceImageUrl = getOrderPhotoUrl(order);
        const latestReferenceImageRequired = orderRequiresReferenceImage(order);
        const latestGenerationSource = pageGenerationSourceFingerprint({
          order,
          page: latestTarget,
          referenceImageUrl: latestReferenceImageUrl,
          referenceImageRequired: latestReferenceImageRequired,
        });
        if (latestGenerationSource !== generationSource) {
          return {
            abort: {
              error: { ok: false, status: 409, error: 'page_changed_during_generation' },
            },
          };
        }
        const { artifacts, page: updatedPage, error } = applyRegeneratePage(
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
        // The rendered content changed, so the published proof and any
        // acknowledgment of it are void. Clear the whole tuple ATOMICALLY with
        // the content change — never as a follow-up write that could fail.
        let next = applyFulfillmentPatchTo(order, {
          pageArtifacts: artifacts,
          reviewStatus: 'customer_changes_requested',
          ...CLEARED_PROOF_STATE,
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
        next = appendAuditEventTo(next, {
          type: 'proof_invalidated',
          pageIndex: input.pageIndex,
          reason: 'page_regenerated',
        });
        return {
          commit: next,
          result: {
            updatedPage,
            preCount: latestTarget.regenerateCount,
            snapshot: reviewSnapshotFromOrder(next),
          },
        };
      },
      { notFound: () => ({ error: { ok: false, status: 404, error: 'Order not found' } }) },
    );
  } catch (error) {
    if (error instanceof OrderVersionConflictError) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
  if ('error' in applied) return applied.error;
  const { updatedPage, preCount } = applied;
  let authoritativeSnapshot: ReviewSnapshot | undefined = applied.snapshot;

  if (!result.imageUrl) {
    return {
      ok: false,
      status: 502,
      page: updatedPage,
      error: result.error ?? 'image_generation_failed',
      snapshot: authoritativeSnapshot,
    };
  }

  // Publish a fresh proof revision. Built outside the transaction, published
  // through a fingerprint-checked conditional commit. A failure leaves NO proof
  // available — the old one was already invalidated above and is never restored.
  let proofRefreshed = false;
  let proofRefreshError: string | undefined;
  if (!deps.skipProofRebuild) {
    const build = deps.buildProof ?? buildProofArtifactFromPageArtifacts;
    let outcome: ProofPublishResult;
    try {
      outcome = await publishProofGuarded(input.orderId, await build(input.orderId), {
        actor: input.actor,
        auditPageIndex: input.pageIndex,
      });
    } catch (err) {
      outcome = { refreshed: false, error: err instanceof Error ? err.message : String(err) };
    }
    proofRefreshed = outcome.refreshed;
    proofRefreshError = outcome.error;
    authoritativeSnapshot = outcome.refreshed && outcome.snapshot
      ? outcome.snapshot
      : await freshMutationSnapshot(input.orderId, input.actor ?? INTERNAL_REVIEW_ACTOR);
  }

  const wasBelow = preCount < REGEN_MANUAL_REVIEW_THRESHOLD;
  const isAtOrAbove = updatedPage.regenerateCount >= REGEN_MANUAL_REVIEW_THRESHOLD;
  if (wasBelow && isAtOrAbove) {
    const alertSender = deps.sendManualReviewAlert ?? sendRegenManualReviewAlert;
    const latest = await getOrder(input.orderId);
    if (latest) {
      alertSender(latest, {
        pageIndex: updatedPage.pageIndex,
        regenerateCount: updatedPage.regenerateCount,
        latestFeedback: sanitizedFeedback,
      }).catch((e) =>
        console.error(`[page-review] manual-review alert failed for ${input.orderId}:`, e),
      );
    }
  }

  const warning = regenWarningFor(updatedPage.regenerateCount);
  return {
    ok: true,
    status: 200,
    page: updatedPage,
    ...(warning ? { warning } : {}),
    proofRefreshed,
    snapshot: authoritativeSnapshot,
    ...(proofRefreshError ? { proofRefreshError } : {}),
  };
}

export async function acceptPage(input: AcceptInput): Promise<AcceptResult> {
  try {
    return await withOrderTransaction<AcceptResult>(
      input.orderId,
      (order) => {
        const refusal = evaluateReviewMutationEligibility(order, input.actor);
        if (refusal) return { abort: { ok: false, status: refusal.status, error: refusal.error } };
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
        // Accepting promotes the already-current image, which is what the proof
        // already renders — so it is render-neutral and deliberately does NOT
        // invalidate the published proof. `proofSourceFingerprint` derives from
        // `imageUrlForPage`, so the fingerprint is unchanged by construction.
        //
        // Never flip reviewStatus to 'approved' here; approval is its own gate.
        let next = applyFulfillmentPatchTo(order, { pageArtifacts: artifacts });
        next = appendAuditEventTo(next, {
          type: 'page_accepted',
          pageIndex: input.pageIndex,
          meta: {
            acceptedCount: artifacts.filter((pp) => pp.accepted).length,
            totalPages: artifacts.length,
            regenerateCountAtAccept: page.regenerateCount,
          },
        });
        return {
          commit: next,
          result: { ok: true, status: 200, page, snapshot: reviewSnapshotFromOrder(next) },
        };
      },
      { notFound: () => ({ ok: false, status: 404, error: 'Order not found' }) },
    );
  } catch (error) {
    if (error instanceof OrderVersionConflictError) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

// ── Acknowledgment (bound to the exact persisted revision) ─────────────────

export interface AckProofResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404 | 409;
  proofReviewedAt?: string;
  proofReviewedVersion?: string;
  error?: string;
  snapshot?: ReviewSnapshot;
}

export interface AcknowledgeProofInput extends ReviewActorInput {
  /** The revision the customer actually reviewed, echoed from the snapshot. */
  proofVersion: string;
  now?: Date;
}

/**
 * Record that the customer reviewed the full proof PDF.
 *
 * Bound to the exact artifact: the submitted `proofVersion` must equal the
 * persisted one, and the persisted fingerprint must still match the current
 * pages. An acknowledgment therefore always names WHICH revision was reviewed,
 * so it can never be carried over to a different one.
 */
export async function acknowledgeProofReview(
  orderId: string,
  input: AcknowledgeProofInput,
): Promise<AckProofResult> {
  const now = input.now ?? new Date();
  try {
    return await withOrderTransaction<AckProofResult>(
      orderId,
      (order) => {
        const refusal = evaluateReviewMutationEligibility(order, input.actor);
        if (refusal) return { abort: { ok: false, status: refusal.status, error: refusal.error } };
        if (order.reviewStatus === 'approved') {
          return { abort: { ok: false, status: 409, error: 'already_approved' } };
        }
        // No proof, or an incompletely identified one, is unacknowledgeable.
        if (!order.storyArtifactUrl || !order.proofVersion || !order.proofSourceFingerprint) {
          return { abort: { ok: false, status: 409, error: 'proof_unavailable' } };
        }
        if (!input.proofVersion || input.proofVersion !== order.proofVersion) {
          return { abort: { ok: false, status: 409, error: 'proof_version_mismatch' } };
        }
        // Idempotent: this exact revision is already acknowledged. Return the
        // original timestamp rather than moving it or duplicating the audit row.
        if (order.proofReviewedAt && order.proofReviewedVersion === order.proofVersion) {
          return {
            abort: {
              ok: true,
              status: 200,
              proofReviewedAt: order.proofReviewedAt,
              proofReviewedVersion: order.proofReviewedVersion,
              snapshot: reviewSnapshotFromOrder(order),
            },
          };
        }
        // The persisted proof must still describe the current pages.
        if (order.proofSourceFingerprint !== proofSourceFingerprint(order)) {
          return { abort: { ok: false, status: 409, error: 'proof_stale' } };
        }
        const ts = now.toISOString();
        let next = applyFulfillmentPatchTo(order, {
          proofReviewedAt: ts,
          proofReviewedVersion: order.proofVersion,
        });
        next = appendAuditEventTo(next, {
          at: ts,
          type: 'proof_review_acknowledged',
          meta: { proofVersion: order.proofVersion },
        });
        return {
          commit: next,
          result: {
            ok: true,
            status: 200,
            proofReviewedAt: ts,
            proofReviewedVersion: order.proofVersion,
            snapshot: reviewSnapshotFromOrder(next),
          },
        };
      },
      { notFound: () => ({ ok: false, status: 404, error: 'Order not found' }) },
    );
  } catch (error) {
    if (error instanceof OrderVersionConflictError) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

// ── Approval (inert: review approval only) ─────────────────────────────────

export interface ApproveWholeBookResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404 | 409;
  proofUrl?: string;
  proofVersion?: string;
  error?: string;
  snapshot?: ReviewSnapshot;
}

export interface ApproveWholeBookInput extends ReviewActorInput {}

/**
 * Customer-driven whole-book approval.
 *
 * Verifies in ONE conditional transaction that the customer reviewed the exact
 * current proof, then sets reviewStatus='approved' and appends the audit event.
 * That is the entire operation.
 *
 * It deliberately does NOT rebuild the proof, hand off to print, submit or queue
 * a print job, email anyone, or touch Stripe, Lulu, Cloudprinter, image
 * generation or any other external provider. Customer approval and print
 * release are separate gates; releasing to print is a distinct, separately
 * authorized operator action.
 */
export async function approveWholeBook(
  orderId: string,
  input: ApproveWholeBookInput = {},
): Promise<ApproveWholeBookResult> {
  try {
    return await withOrderTransaction<ApproveWholeBookResult>(
      orderId,
      (order) => {
        // Customer-facing prose for the long-standing gates; stable codes for
        // the proof-identity gates the client branches on.
        const PROSE: Record<string, string> = {
          already_approved: 'Order is already approved',
          review_not_ready: 'Page review not yet ready for this order',
          pages_not_accepted: 'All pages must be accepted before approving the whole book',
          unresolved_change_requests:
            'Resolve the pending text-change requests before approving the whole book',
          proof_not_ready: 'Full proof PDF is not ready yet',
          proof_ack_missing:
            'Proof acknowledgment required — confirm you reviewed the full proof PDF before approving',
        };
        const reject = (
          reason: string,
          error?: string,
          meta?: Record<string, string | number | boolean | null>,
        ): { commit: OrderRecord; result: ApproveWholeBookResult } => ({
          commit: appendAuditEventTo(order, {
            type: 'whole_book_approval_rejected',
            reason,
            ...(meta ? { meta } : {}),
          }),
          result: { ok: false, status: 409, error: error ?? PROSE[reason] ?? reason },
        });

        const refusal = evaluateReviewMutationEligibility(order, input.actor);
        // An ineligible caller must leave NO trace — abort without committing.
        if (refusal) return { abort: { ok: false, status: refusal.status, error: refusal.error } };

        if (order.reviewStatus === 'approved') return reject('already_approved');
        if (!order.pageArtifacts || order.pageArtifacts.length === 0) return reject('review_not_ready');
        if (!order.pageArtifacts.every((p) => p.accepted && p.acceptedImageUrl)) {
          return reject('pages_not_accepted', undefined, {
            acceptedCount: order.pageArtifacts.filter((p) => p.accepted).length,
            totalPages: order.pageArtifacts.length,
          });
        }
        if (hasUnresolvedChangeRequests(order.pageArtifacts)) {
          return reject('unresolved_change_requests', undefined, {
            unresolvedPages: order.pageArtifacts.filter(
              (p) =>
                p.customerReviewStatus === 'changes_requested' ||
                (p.customerRequestedChange != null &&
                  p.customerRequestedChange.lifecycleStatus !== 'resolved'),
            ).length,
          });
        }
        // The proof must exist AND be completely identified.
        if (!order.storyArtifactUrl) return reject('proof_not_ready');
        if (!order.proofVersion || !order.proofSourceFingerprint) {
          return reject('proof_identity_missing', 'proof_unavailable');
        }
        // …and still describe the pages being approved.
        if (order.proofSourceFingerprint !== proofSourceFingerprint(order)) {
          return reject('proof_stale', 'proof_stale');
        }
        // …and be the exact revision the customer acknowledged.
        if (!order.proofReviewedAt || !order.proofReviewedVersion) {
          return reject('proof_ack_missing');
        }
        if (order.proofReviewedVersion !== order.proofVersion) {
          return reject('proof_ack_stale', 'proof_ack_stale');
        }

        let next = applyFulfillmentPatchTo(order, { reviewStatus: 'approved' });
        next = appendAuditEventTo(next, {
          type: 'whole_book_approved',
          meta: {
            bookFormat: order.bookFormat,
            proofUrl: order.storyArtifactUrl,
            proofVersion: order.proofVersion,
          },
        });
        return {
          commit: next,
          result: {
            ok: true,
            status: 200,
            proofUrl: order.storyArtifactUrl,
            proofVersion: order.proofVersion,
            snapshot: reviewSnapshotFromOrder(next),
          },
        };
      },
      { notFound: () => ({ ok: false, status: 404, error: 'Order not found' }) },
    );
  } catch (error) {
    if (error instanceof OrderVersionConflictError) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

export type ApproveBlockReason =
  | 'pages_not_accepted'
  | 'proof_not_ready'
  | 'proof_ack_missing'
  | 'already_approved'
  | null;

/**
 * Returns null when the customer is allowed to approve the whole book, or a
 * specific reason string otherwise. Mirrors the disabled-state logic on
 * /review/[orderId] so tests can lock the contract without rendering React.
 *
 *   1. all illustrated pages must be accepted
 *   2. the assembled proof PDF must exist (storyArtifactUrl)
 *   3. the customer must check the "I reviewed the full proof PDF" ack
 *   4. order must not already be approved
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
  if (!args.proofAcknowledged) return 'proof_ack_missing';
  return null;
}

export interface ReviewAccessInput {
  /** Token from /review/<orderId>?token=... links. Required for print orders
   *  once a proofApprovalToken exists, so a bare order id is not enough to
   *  open the public-facing proof review route. */
  reviewToken?: string | null;
}


// ── Customer text-change requests ──────────────────────────────────────────

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
  snapshot?: ReviewSnapshot;
}

/**
 * Persist a page-specific customer wording request. Records review INTENT only:
 * it never alters canonical text, payment, approval, the proof token, accepted
 * state, or triggers rebuild/fulfillment/email/provider work.
 *
 * A wording request changes what the book should say, so it invalidates the
 * published proof and its acknowledgment in the same commit.
 */
export async function saveTextChangeRequest(
  input: SaveTextChangeInput,
  deps: { now?: () => Date } = {},
): Promise<SaveTextChangeResult> {
  if (!Number.isInteger(input.pageIndex) || input.pageIndex < 0) {
    return { ok: false, status: 400, error: 'invalid_page_index' };
  }
  if (typeof input.note !== 'string') return { ok: false, status: 400, error: 'invalid_note' };
  try {
    return await withOrderTransaction<SaveTextChangeResult>(
      input.orderId,
      (order) => {
        const now = (deps.now ?? (() => new Date()))();
        const refusal = evaluateReviewMutationEligibility(order, customerReviewActor(input.reviewToken));
        if (refusal) return { abort: { ok: false, status: refusal.status, error: refusal.error } };
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
          const recordInput: RecordCustomerTextChangeInput = { note: input.note, at: now.toISOString() };
          updatedPage = recordCustomerTextChangeRequest(target, recordInput);
        } catch {
          return { abort: { ok: false, status: 400, error: 'empty_or_invalid_note' } };
        }
        const artifacts = order.pageArtifacts.map((p) =>
          p.pageIndex === input.pageIndex ? updatedPage : p,
        );
        let next = applyFulfillmentPatchTo(order, {
          pageArtifacts: artifacts,
          reviewStatus: 'customer_changes_requested',
          ...CLEARED_PROOF_STATE,
        });
        // Audit shape only: page index and note LENGTH. Never the note text,
        // never a token.
        next = appendAuditEventTo(next, {
          type: 'customer_text_change_requested',
          pageIndex: input.pageIndex,
          meta: { noteChars: updatedPage.customerRequestedChange?.note.length ?? 0 },
        });
        next = appendAuditEventTo(next, {
          type: 'proof_invalidated',
          pageIndex: input.pageIndex,
          reason: 'customer_text_change_requested',
        });
        return {
          commit: next,
          result: {
            ok: true,
            status: 200,
            page: updatedPage,
            snapshot: reviewSnapshotFromOrder(next),
          },
        };
      },
      { notFound: () => ({ ok: false, status: 404, error: 'order_not_found' }) },
    );
  } catch (error) {
    if (error instanceof OrderVersionConflictError) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

export interface ResolveTextChangeResult {
  ok: boolean;
  status: 200 | 400 | 403 | 404 | 409 | 502;
  error?: string;
  snapshot?: ReviewSnapshot;
  proofRefreshed?: boolean;
}

/** Admin-only service operation: apply canonical wording with CAS, resolve the
 * request, invalidate all rendered artifacts, then build/publish a fresh proof
 * outside the transaction. The caller must enforce admin authentication. */
export async function resolveTextChangeRequest(
  input: { orderId: string; pageIndex: number; storyText: string },
  deps: {
    now?: () => Date;
    buildProof?: typeof buildProofArtifactFromPageArtifacts;
  } = {},
): Promise<ResolveTextChangeResult> {
  const storyText = typeof input.storyText === 'string' ? input.storyText.trim() : '';
  if (!Number.isInteger(input.pageIndex) || input.pageIndex < 0) {
    return { ok: false, status: 400, error: 'invalid_page_index' };
  }
  if (!storyText) return { ok: false, status: 400, error: 'invalid_story_text' };

  let staged: ResolveTextChangeResult;
  try {
    staged = await withOrderTransaction<ResolveTextChangeResult>(
      input.orderId,
      (order) => {
        const refusal = evaluateReviewMutationEligibility(order, {
          kind: 'internal',
          reason: 'admin_resolve_text_change',
        });
        if (refusal) return { abort: { ok: false, status: refusal.status, error: refusal.error } };
        if (order.reviewStatus === 'approved') {
          return { abort: { ok: false, status: 409, error: 'already_approved' } };
        }
        const target = order.pageArtifacts?.find((p) => p.pageIndex === input.pageIndex);
        if (!target?.customerRequestedChange) {
          return { abort: { ok: false, status: 409, error: 'text_change_request_missing' } };
        }
        const at = (deps.now ?? (() => new Date()))().toISOString();
        const updatedPage: PageArtifact = {
          ...target,
          storyText,
          customerReviewStatus: 'resolved',
          customerRequestedChange: {
            ...target.customerRequestedChange,
            lifecycleStatus: 'resolved',
            updatedAt: at,
          },
        };
        const pages = (order.pageArtifacts ?? []).map((page) =>
          page.pageIndex === input.pageIndex ? updatedPage : page,
        );
        let next = applyFulfillmentPatchTo(order, {
          pageArtifacts: pages,
          reviewStatus: 'in_review',
          ...CLEARED_PROOF_STATE,
          printInteriorArtifactUrl: null,
          printInteriorMd5: null,
          printInteriorPageCount: null,
          printCoverArtifactUrl: null,
          printCoverMd5: null,
        });
        next = appendAuditEventTo(next, {
          type: 'customer_text_change_resolved',
          pageIndex: input.pageIndex,
          meta: { storyChars: storyText.length },
        });
        next = appendAuditEventTo(next, {
          type: 'proof_invalidated',
          pageIndex: input.pageIndex,
          reason: 'canonical_text_changed',
        });
        return {
          commit: next,
          result: { ok: true, status: 200, snapshot: reviewSnapshotFromOrder(next) },
        };
      },
      { notFound: () => ({ ok: false, status: 404, error: 'order_not_found' }) },
    );
  } catch (error) {
    if (error instanceof OrderVersionConflictError) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
  if (!staged.ok) return staged;

  const built = await (deps.buildProof ?? buildProofArtifactFromPageArtifacts)(input.orderId);
  const published = await publishProofGuarded(input.orderId, built, {
    actor: { kind: 'internal', reason: 'admin_resolve_text_change' },
  });
  if (!published.refreshed || !published.snapshot) {
    return {
      ok: false,
      status: 502,
      error: published.error ?? 'proof_refresh_failed',
      snapshot: await freshMutationSnapshot(input.orderId, {
        kind: 'internal',
        reason: 'admin_resolve_text_change',
      }),
      proofRefreshed: false,
    };
  }
  return { ok: true, status: 200, snapshot: published.snapshot, proofRefreshed: true };
}

// ── Review-link preparation (admin-authenticated caller) ───────────────────

export interface PrepareReviewLinkResult {
  ok: boolean;
  status: 200 | 404 | 409;
  token?: string;
  reviewPath?: string;
  alreadyPrepared?: boolean;
  error?: string;
}

/**
 * Create or preserve a customer review capability for a paid order that already
 * has a review artifact. Idempotent — never rotates an existing token. Never
 * sends email: link preparation and customer delivery are separate, separately
 * authorized actions. The calling route must be admin-authenticated.
 */
export async function prepareCustomerReviewLink(
  orderId: string,
  deps: { tokenFactory?: () => string } = {},
): Promise<PrepareReviewLinkResult> {
  try {
    return await withOrderTransaction<PrepareReviewLinkResult>(
      orderId,
      (order) => {
        if (order.paymentStatus !== 'paid') {
          return { abort: { ok: false, status: 409, error: 'order_not_paid' } };
        }
        // A refunded order is terminal: never mint or hand back a capability.
        if (order.refundedAt || order.stripeRefundId) {
          return { abort: { ok: false, status: 409, error: 'order_refunded' } };
        }
        if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
          return { abort: { ok: false, status: 409, error: 'review_not_ready' } };
        }
        if (!order.storyArtifactUrl) {
          return { abort: { ok: false, status: 409, error: 'review_artifact_missing' } };
        }
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
          // Never log the token value; record only non-sensitive shape.
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
      { notFound: () => ({ ok: false, status: 404, error: 'order_not_found' }) },
    );
  } catch (error) {
    if (error instanceof OrderVersionConflictError) {
      return { ok: false, status: 409, error: 'order_mutation_busy' };
    }
    throw error;
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────

export interface ReviewSnapshot {
  orderId: string;
  childName: string;
  reviewStatus: NonNullable<OrderRecord['reviewStatus']>;
  pageArtifacts: PageArtifact[];
  /**
   * The IMMUTABLE persisted proof URL, or null when no usable proof exists.
   * Null is authoritative: the client must not offer acknowledgment or approval.
   */
  storyArtifactUrl: string | null;
  /** Revision the client must echo back when acknowledging. */
  proofVersion: string | null;
  /** Revision the customer has already acknowledged, if any. */
  proofReviewedVersion: string | null;
  proofReviewedAt: string | null;
  /** True when a complete proof identity is persisted. */
  proofAvailable: boolean;
  /** True when that proof still describes the current pages. */
  proofFresh: boolean;
  isPrint: boolean;
  bookFormat: OrderRecord['bookFormat'];
}

export function reviewSnapshotFromOrder(order: OrderRecord): ReviewSnapshot {
  const fresh = proofIsFresh(order);
  const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
  return {
    orderId: order.id,
    childName: order.childName,
    reviewStatus: order.reviewStatus ?? 'in_review',
    pageArtifacts: [...(order.pageArtifacts ?? [])].sort((a, b) => a.pageIndex - b.pageIndex),
    // Advertise the proof ONLY when it is complete and current.
    storyArtifactUrl: fresh ? (order.storyArtifactUrl ?? null) : null,
    proofVersion: fresh ? (order.proofVersion ?? null) : null,
    proofReviewedVersion: order.proofReviewedVersion ?? null,
    proofReviewedAt: order.proofReviewedAt ?? null,
    proofAvailable: fresh,
    proofFresh: fresh,
    isPrint,
    bookFormat: order.bookFormat,
  };
}

/** Fresh snapshot for a mutation response after slow work failed. Customer
 * callers are re-authorized against the latest token before any data is exposed;
 * authenticated internal callers may read the latest committed review state. */
async function freshMutationSnapshot(
  orderId: string,
  actor: ReviewActor = INTERNAL_REVIEW_ACTOR,
): Promise<ReviewSnapshot | undefined> {
  const current = await getOrder(orderId);
  if (!current?.pageArtifacts?.length) return undefined;
  if (actor.kind === 'customer' && !hasReviewWriteAccess(current, { reviewToken: actor.reviewToken })) {
    return undefined;
  }
  return reviewSnapshotFromOrder(current);
}

export async function getReviewSnapshot(
  orderId: string,
  input: ReviewAccessInput = {},
): Promise<ReviewSnapshot | null> {
  const order = await getOrder(orderId);
  if (!order) return null;
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) return null;
  if (!hasReviewAccess(order, input)) return null;
  return reviewSnapshotFromOrder(order);
}

// ── Capability helpers ─────────────────────────────────────────────────────

/** Constant-time token comparison. Never `===` on a secret. */
function tokensMatch(stored: string, provided: string): boolean {
  if (!stored || !provided || stored.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(provided));
  } catch {
    return false;
  }
}

/** Public review reads are capability-gated for every order. Operator access
 * belongs on authenticated admin surfaces, never on this public helper. */
export function hasReviewAccess(order: OrderRecord, input: ReviewAccessInput = {}): boolean {
  if (!order.proofApprovalToken) return false;
  return tokensMatch(order.proofApprovalToken, input.reviewToken ?? '');
}

/**
 * WRITE access. Stricter than read: a write ALWAYS requires a prepared token
 * that matches, for digital and print alike. A bare order id never authorizes
 * a customer mutation.
 */
export function hasReviewWriteAccess(order: OrderRecord, input: ReviewAccessInput = {}): boolean {
  if (!order.proofApprovalToken) return false;
  return tokensMatch(order.proofApprovalToken, input.reviewToken ?? '');
}

export function reviewPathFor(orderId: string, token: string): string {
  return `/review/${orderId}?token=${token}`;
}
