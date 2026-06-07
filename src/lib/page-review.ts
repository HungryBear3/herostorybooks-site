// Customer page-review service helpers.
//
// All functions operate on PageArtifact[] in a pure, predictable way and call
// updateFulfillmentState() at the end. Tests can also call the pure helpers
// directly via applyAcceptPage()/applyRegeneratePage().

import { appendAuditEvent, getOrder, getOrderPhotoUrl, updateFulfillmentState, withOrderWriteLock } from './orders.ts';
import type {
  OrderRecord,
  PageArtifact,
  PageFeedbackEntry,
  PageVersionEntry,
} from './orders.ts';
import { generatePageImage, type ImageProvider } from './image-generator.ts';
import { buildRegeneratePrompt } from './image-prompt-builder.ts';
import { rebuildProofFromPageArtifacts } from './fulfillment.ts';
import { sendRegenManualReviewAlert } from './order-email.ts';
import { evaluateProofSubmissionGate } from './proof-submission-gate.ts';

// Soft internal thresholds (runbook): warn at 3, manual review at 5.
export const REGEN_WARNING_THRESHOLD = 3;
export const REGEN_MANUAL_REVIEW_THRESHOLD = 5;

export interface RegenerateInput {
  orderId: string;
  pageIndex: number;
  feedback: string;
}

export interface RegenerateResult {
  ok: boolean;
  status: 200 | 400 | 404 | 409 | 502;
  page?: PageArtifact;
  warning?: 'regen_threshold_warning' | 'regen_manual_review_threshold';
  error?: string;
  /** True iff the proof PDF was successfully refreshed after this regeneration. */
  proofRefreshed?: boolean;
  /** Populated when the regeneration succeeded but the proof rebuild failed. */
  proofRefreshError?: string;
}

export interface AcceptInput {
  orderId: string;
  pageIndex: number;
}

export interface AcceptResult {
  ok: boolean;
  status: 200 | 400 | 404 | 409;
  page?: PageArtifact;
  error?: string;
}

export interface RequestChangesInput {
  orderId: string;
  pageIndex: number;
  note: string;
}

export interface RequestChangesResult {
  ok: boolean;
  status: 200 | 400 | 404 | 409;
  page?: PageArtifact;
  error?: string;
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
    customerReviewStatus: 'approved',
    customerRequestedChange: null,
  };
  return { artifacts: next, page: next[idx] };
}

export function applyRequestPageChanges(
  artifacts: PageArtifact[],
  pageIndex: number,
  rawNote: string,
  now: string,
): { artifacts: PageArtifact[]; page?: PageArtifact; error?: string } {
  const idx = artifacts.findIndex((p) => p.pageIndex === pageIndex);
  if (idx === -1) return { artifacts, error: 'page_not_found' };
  const note = rawNote.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!note) return { artifacts, error: 'change_note_required' };

  const current = artifacts[idx];
  const feedbackEntry: PageFeedbackEntry = {
    createdAt: now,
    rawText: note,
    tags: [],
    providerTried: null,
    resultImageUrl: current.currentImageUrl ?? null,
    success: true,
  };
  const next = artifacts.slice();
  next[idx] = {
    ...current,
    accepted: false,
    acceptedImageUrl: null,
    customerReviewStatus: 'changes_requested',
    customerRequestedChange: {
      requestedAt: now,
      note,
      lifecycleStatus: current.customerRequestedChange?.lifecycleStatus ?? 'triage',
      updatedAt: now,
    },
    feedbackHistory: [...current.feedbackHistory, feedbackEntry],
  };
  return { artifacts: next, page: next[idx] };
}

export function applyRegeneratePage(
  artifacts: PageArtifact[],
  pageIndex: number,
  newImageUrl: string | null,
  provider: 'manual' | 'openai' | 'fal' | 'fal_edit' | 'gemini' | 'seedream' | 'seedream_edit',
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

export interface RegenerateDeps {
  /** Inject providers (tests). */
  providers?: ImageProvider[];
  /** Inject the page-level generator (tests). */
  generatePageImage?: typeof generatePageImage;
  /** Optional clock injection (tests). */
  now?: () => Date;
  /** Inject proof rebuilder (tests). */
  rebuildProof?: typeof rebuildProofFromPageArtifacts;
  /** Inject operator alert sender (tests). */
  sendManualReviewAlert?: typeof sendRegenManualReviewAlert;
  /** Skip auto-rebuild entirely (used by tests that don't care). */
  skipProofRebuild?: boolean;
}

export async function regeneratePage(
  input: RegenerateInput,
  deps: RegenerateDeps = {},
): Promise<RegenerateResult> {
  const order = await getOrder(input.orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
    return { ok: false, status: 409, error: 'Page review not yet ready for this order' };
  }
  const target = order.pageArtifacts.find((p) => p.pageIndex === input.pageIndex);
  if (!target) return { ok: false, status: 400, error: 'Invalid page index' };

  const { prompt, tags, sanitizedFeedback } = buildRegeneratePrompt({
    basePrompt: target.basePrompt,
    storyText: target.storyText,
    feedback: input.feedback,
    order: {
      childName: order.childName,
      childAge: order.childAge,
      characterNotes: order.characterNotes,
      appearanceOptions: order.appearanceOptions,
      photoBlobPath: order.photoBlobPath ?? null,
      theme: order.theme,
    },
    // Reuse the same frozen anchor that initial generation persisted on this
    // page artifact, so a regenerate can't introduce a new "different kid".
    characterAnchor: target.characterAnchor ?? null,
  });

  const generate = deps.generatePageImage ?? generatePageImage;
  // Pass the customer photo URL so the regenerate request stays on the
  // photo-conditioned provider chain (Seedream primary, Nano Banana edit
  // secondary) when a photo is available — same identity continuity as
  // initial generation, with no text-only fallback.
  const referenceImageUrl = getOrderPhotoUrl(order);
  const result = await generate(
    { prompt, referenceImageUrl },
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

  // Image generation (above) happened OUTSIDE the order write lock — it can take
  // seconds and must not block other per-page writes. Now serialize the
  // read→modify→write per order and, INSIDE the lock, re-read the freshest order
  // and apply this page's change onto the latest array (not the stale
  // request-time snapshot), so a concurrent accept/regenerate on another page
  // that persisted during generation is preserved rather than reverted.
  const writeOutcome = await withOrderWriteLock(order.id, async () => {
    const latest = (await getOrder(order.id)) ?? order;
    if (latest.reviewStatus === 'approved') {
      return { error: 'Order is already approved', status: 409 as const };
    }
    const baseArtifacts = latest.pageArtifacts && latest.pageArtifacts.length > 0
      ? latest.pageArtifacts
      : order.pageArtifacts;
    const { artifacts: mergedArtifacts, page: mergedPage, error: applyErr } = applyRegeneratePage(
      baseArtifacts,
      input.pageIndex,
      result.imageUrl,
      result.provider,
      result.model,
      result.promptUsed,
      feedbackEntry,
      result.conditioning ?? null,
      result.referencePhotoUrl ?? null,
    );
    if (applyErr || !mergedPage) {
      return { error: applyErr ?? 'regenerate_failed' as string };
    }
    const savedOrder = await updateFulfillmentState(order.id, {
      pageArtifacts: mergedArtifacts,
      reviewStatus: 'customer_changes_requested',
    }, latest);
    const audit = await appendAuditEvent(order.id, {
      type: 'page_regenerated',
      pageIndex: input.pageIndex,
      reason: result.imageUrl ? null : (result.error ?? 'image_generation_failed'),
      meta: {
        provider: result.provider,
        model: result.model,
        regenerateCount: mergedPage.regenerateCount,
        success: Boolean(result.imageUrl),
        tags: tags.join(',') || '',
      },
    }, savedOrder ?? undefined);
    return { updatedPage: mergedPage, afterRegenAudit: audit };
  });

  if ('error' in writeOutcome) {
    return { ok: false, status: writeOutcome.status ?? 400, error: writeOutcome.error };
  }
  const updatedPage = writeOutcome.updatedPage;
  const afterRegenAudit = writeOutcome.afterRegenAudit;

  if (!result.imageUrl) {
    return {
      ok: false,
      status: 502,
      page: updatedPage,
      error: result.error ?? 'image_generation_failed',
    };
  }

  // Auto-refresh the proof PDF using accepted/current per-page URLs.
  // Successful regen still returns ok:true even if the proof rebuild fails —
  // we surface proofRefreshError so callers can log/alert without blocking the customer.
  let proofRefreshed = false;
  let proofRefreshError: string | undefined;
  if (!deps.skipProofRebuild) {
    try {
      const rebuild = deps.rebuildProof ?? rebuildProofFromPageArtifacts;
      // Pass afterRegenAudit so rebuildProof can use the fresh post-regen record
      // rather than doing another getOrder() that might return stale state.
      const rb = await rebuild(order.id, {}, afterRegenAudit ?? undefined);
      if (rb.ok) {
        proofRefreshed = true;
      } else {
        proofRefreshError = rb.error ?? 'proof_rebuild_failed';
      }
      // Thread rb.updatedOrder (when available) so appendAuditEvent doesn't
      // re-read and overwrite the storyArtifactUrl/proofReviewedAt the rebuild
      // just persisted.
      await appendAuditEvent(order.id, {
        type: 'proof_rebuilt',
        pageIndex: input.pageIndex,
        reason: proofRefreshError ?? null,
        meta: { triggeredBy: 'page_regenerated', success: proofRefreshed },
      }, rb.updatedOrder ?? undefined);
    } catch (err) {
      proofRefreshError = err instanceof Error ? err.message : String(err);
      await appendAuditEvent(order.id, {
        type: 'proof_rebuilt',
        pageIndex: input.pageIndex,
        reason: proofRefreshError,
        meta: { triggeredBy: 'page_regenerated', success: false },
      }, afterRegenAudit ?? undefined);
    }
  }

  // One-shot operator alert when this regeneration crosses the manual-review threshold.
  // Pre-count was target.regenerateCount; post-count is updatedPage.regenerateCount.
  // Fire only on the transition, so a 6th/7th regen doesn't re-alert.
  const wasBelow = target.regenerateCount < REGEN_MANUAL_REVIEW_THRESHOLD;
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
  const order = await getOrder(input.orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
    return { ok: false, status: 409, error: 'Page review not yet ready for this order' };
  }
  // Serialize the read→modify→write per order (cross-request clobber guard) and,
  // INSIDE the lock, re-read the freshest order and apply this single page's
  // accept onto the latest array. A concurrent regenerate/accept on another page
  // (incl. an in-flight regen that persists during this request) is preserved
  // rather than reverted by writing a request-time snapshot array.
  return withOrderWriteLock(input.orderId, async () => {
    const latest = (await getOrder(input.orderId)) ?? order;
    if (latest.reviewStatus === 'approved') {
      return { ok: false, status: 409, error: 'Order is already approved' };
    }
    const baseArtifacts = latest.pageArtifacts && latest.pageArtifacts.length > 0
      ? latest.pageArtifacts
      : order.pageArtifacts;
    const { artifacts, page, error } = applyAcceptPage(baseArtifacts, input.pageIndex);
    if (error || !page) {
      return { ok: false, status: 400, error: error ?? 'accept_failed' };
    }

    // IMPORTANT: do NOT flip reviewStatus to 'approved' here, even when every
    // page happens to be accepted. 'approved' is reserved exclusively for the
    // approveWholeBook flow (proof acknowledgment + full-proof rebuild). Setting
    // it here would short-circuit the ack/approve gate and cause approveWholeBook
    // to return `already_approved` for customers who never completed the
    // intended full-approval path. Thread `latest` so updateFulfillmentState
    // does not do a stale blob re-read inside the locked write.
    const savedOrder = await updateFulfillmentState(order.id, { pageArtifacts: artifacts }, latest);

    // Thread savedOrder so appendAuditEvent doesn't re-read stale blob state
    // and clobber the accepted pageArtifacts we just wrote (production clobber bug).
    await appendAuditEvent(order.id, {
      type: 'page_accepted',
      pageIndex: input.pageIndex,
      meta: {
        acceptedCount: artifacts.filter((p) => p.accepted).length,
        totalPages: artifacts.length,
        regenerateCountAtAccept: page.regenerateCount,
      },
    }, savedOrder ?? undefined);

    return { ok: true, status: 200, page };
  });
}

export async function requestPageChanges(
  input: RequestChangesInput,
  now: Date = new Date(),
): Promise<RequestChangesResult> {
  const order = await getOrder(input.orderId);
  if (!order) return { ok: false, status: 404, error: 'Order not found' };
  if (order.reviewStatus === 'approved') {
    return { ok: false, status: 409, error: 'Order is already approved' };
  }
  if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
    return { ok: false, status: 409, error: 'Page review not yet ready for this order' };
  }

  const ts = now.toISOString();
  // Serialize per order + re-read latest INSIDE the lock, then apply this single
  // page's change onto the freshest array so a concurrent accept/regenerate on
  // another page is preserved, not reverted by a request-time snapshot write.
  return withOrderWriteLock(input.orderId, async () => {
    const latest = (await getOrder(input.orderId)) ?? order;
    if (latest.reviewStatus === 'approved') {
      return { ok: false, status: 409, error: 'Order is already approved' };
    }
    const baseArtifacts = latest.pageArtifacts && latest.pageArtifacts.length > 0
      ? latest.pageArtifacts
      : order.pageArtifacts;
    const { artifacts, page, error } = applyRequestPageChanges(
      baseArtifacts,
      input.pageIndex,
      input.note,
      ts,
    );
    if (error || !page) {
      const status = error === 'change_note_required' ? 400 : 400;
      return { ok: false, status, error: error ?? 'request_changes_failed' };
    }

    const savedOrder = await updateFulfillmentState(order.id, {
      pageArtifacts: artifacts,
      reviewStatus: 'customer_changes_requested',
      proofReviewedAt: null,
    }, latest);
    await appendAuditEvent(order.id, {
      type: 'page_changes_requested',
      pageIndex: input.pageIndex,
      meta: {
        lifecycleStatus: page.customerRequestedChange?.lifecycleStatus ?? 'triage',
        noteLength: page.customerRequestedChange?.note.length ?? 0,
      },
    }, savedOrder ?? undefined);

    return { ok: true, status: 200, page };
  });
}

// ── Approve whole book ───────────────────────────────────────────────────────

export interface ApproveWholeBookResult {
  ok: boolean;
  status: 200 | 400 | 404 | 409 | 502;
  proofUrl?: string;
  error?: string;
  /** True iff the book was passed into the print-approval flow (print orders only). */
  printApproved?: boolean;
}

export interface ApproveWholeBookDeps {
  rebuildProof?: typeof rebuildProofFromPageArtifacts;
  /** Optional injection point for the print-approval handoff (tests). */
  approvePrint?: (orderId: string, token: string, existingOrder?: OrderRecord) => Promise<{ ok: boolean; error?: string }>;
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
): Promise<ApproveWholeBookResult> {
  // Serialize terminal approval with page-level review writes. Approval re-reads
  // the freshest order inside the lock and validates that every page is still
  // accepted immediately before rebuilding/marking approved, so an in-flight
  // regenerate/request-changes cannot approve stale page state.
  return withOrderWriteLock(orderId, async () => {
    const order = await getOrder(orderId);
    if (!order) return { ok: false, status: 404, error: 'Order not found' };
    if (order.reviewStatus === 'approved') {
      await appendAuditEvent(orderId, {
        type: 'whole_book_approval_rejected',
        reason: 'already_approved',
      }, order);
      return { ok: false, status: 409, error: 'Order is already approved' };
    }
    if (!order.pageArtifacts || order.pageArtifacts.length === 0) {
      await appendAuditEvent(orderId, {
        type: 'whole_book_approval_rejected',
        reason: 'review_not_ready',
      }, order);
      return { ok: false, status: 409, error: 'Page review not yet ready for this order' };
    }
    const allAccepted = order.pageArtifacts.every((p) => p.accepted && p.acceptedImageUrl);
    if (!allAccepted) {
      await appendAuditEvent(orderId, {
        type: 'whole_book_approval_rejected',
        reason: 'pages_not_accepted',
        meta: {
          acceptedCount: order.pageArtifacts.filter((p) => p.accepted).length,
          totalPages: order.pageArtifacts.length,
        },
      }, order);
      return { ok: false, status: 409, error: 'All pages must be accepted before approving the whole book' };
    }
    // The full proof PDF must exist on the order. Without it the customer is
    // approving the 6 illustrated pages only, which is the exact UX bug we fixed.
    if (!order.storyArtifactUrl) {
      await appendAuditEvent(orderId, {
        type: 'whole_book_approval_rejected',
        reason: 'proof_not_ready',
      }, order);
      return { ok: false, status: 409, error: 'Full proof PDF is not ready yet' };
    }
    // Server-side enforcement of the proof acknowledgment. Client UI checks the
    // box; this checks the persisted state. Don't trust the client.
    if (!order.proofReviewedAt) {
      await appendAuditEvent(orderId, {
        type: 'whole_book_approval_rejected',
        reason: 'proof_ack_missing',
      }, order);
      return {
        ok: false,
        status: 409,
        error:
          'Proof acknowledgment required — confirm you reviewed the full proof PDF before approving',
      };
    }
    const proofGate = evaluateProofSubmissionGate(order);
    if (!proofGate.allowed) {
      await appendAuditEvent(orderId, {
        type: 'whole_book_approval_rejected',
        reason: 'proof_release_gate_blocked',
        meta: { reasons: proofGate.reasons.map((reason) => reason.code).join(',') },
      }, order);
      return {
        ok: false,
        status: 409,
        error: `Proof release gate blocked: ${proofGate.reasons.map((reason) => reason.code).join(', ')}`,
      };
    }

    // Rebuild the proof from accepted/current artifacts.
    const rebuild = deps.rebuildProof ?? rebuildProofFromPageArtifacts;
    const rb = await rebuild(orderId, {}, order);
    if (!rb.ok) {
      await appendAuditEvent(orderId, {
        type: 'whole_book_approval_rejected',
        reason: 'proof_rebuild_failed',
        meta: { error: rb.error ?? 'proof_rebuild_failed' },
      }, order);
      return { ok: false, status: 502, error: rb.error ?? 'proof_rebuild_failed' };
    }
    const proofBaseOrder = rb.updatedOrder ?? (await getOrder(orderId)) ?? order;
    const afterProofRebuiltAudit = await appendAuditEvent(orderId, {
      type: 'proof_rebuilt',
      reason: null,
      meta: { triggeredBy: 'whole_book_approved', success: true },
    }, proofBaseOrder);

    const approvedOrder = await updateFulfillmentState(
      orderId,
      { reviewStatus: 'approved' },
      afterProofRebuiltAudit ?? proofBaseOrder,
    );
    await appendAuditEvent(orderId, {
      type: 'whole_book_approved',
      meta: {
        bookFormat: order.bookFormat,
        proofUrl: rb.proofUrl ?? null,
      },
    }, approvedOrder ?? undefined);

    const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
    if (!isPrint) {
      return { ok: true, status: 200, proofUrl: rb.proofUrl, printApproved: false };
    }

    // Print: hand off to the existing approve-proof flow using the stored token.
    if (!order.proofApprovalToken) {
      // No token means we never reached proof_ready; the customer can't legitimately
      // approve a print order from here. Return success on rebuild but flag the
      // print-approval gap so ops can finish manually.
      return { ok: true, status: 200, proofUrl: rb.proofUrl, printApproved: false };
    }

    const approveFn = deps.approvePrint ?? (await import('./fulfillment.ts')).approvePrintProof;
    try {
      const handoff = await approveFn(orderId, order.proofApprovalToken, approvedOrder ?? afterProofRebuiltAudit ?? proofBaseOrder);
      if (!handoff.ok) {
        return {
          ok: true,
          status: 200,
          proofUrl: rb.proofUrl,
          printApproved: false,
          error: handoff.error ?? 'print_approval_handoff_failed',
        };
      }
      return { ok: true, status: 200, proofUrl: rb.proofUrl, printApproved: true };
    } catch (err) {
      return {
        ok: true,
        status: 200,
        proofUrl: rb.proofUrl,
        printApproved: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

// ── Proof acknowledgment (persisted) ────────────────────────────────────────

export interface AckProofResult {
  ok: boolean;
  status: 200 | 404 | 409;
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
): Promise<AckProofResult> {
  return withOrderWriteLock(orderId, async () => {
    const order = await getOrder(orderId);
    if (!order) return { ok: false, status: 404, error: 'Order not found' };
    if (!order.storyArtifactUrl) {
      return {
        ok: false,
        status: 409,
        error: 'Full proof PDF is not ready yet — cannot acknowledge what does not exist',
      };
    }
    if (order.reviewStatus === 'approved') {
      return { ok: false, status: 409, error: 'Order is already approved' };
    }
    if (order.proofReviewedAt) {
      return { ok: true, status: 200, proofReviewedAt: order.proofReviewedAt };
    }
    const ts = now.toISOString();
    const savedOrder = await updateFulfillmentState(orderId, { proofReviewedAt: ts }, order);
    await appendAuditEvent(orderId, {
      at: ts,
      type: 'proof_review_acknowledged',
    }, savedOrder ?? order);
    return { ok: true, status: 200, proofReviewedAt: ts };
  });
}

// ── Approval-gate helpers (pure, testable) ──────────────────────────────────

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

export function hasOpenRequestedChanges(order: Pick<OrderRecord, 'reviewStatus' | 'pageArtifacts'>): boolean {
  if (order.reviewStatus === 'customer_changes_requested') return true;
  return Boolean(order.pageArtifacts?.some((page) =>
    page.customerReviewStatus === 'changes_requested' &&
    page.customerRequestedChange?.lifecycleStatus !== 'resolved',
  ));
}

export function shouldPauseCustomerReviewNudges(order: Pick<OrderRecord, 'reviewStatus' | 'pageArtifacts'>): boolean {
  return hasOpenRequestedChanges(order);
}

export function deliveryTrustCopy(bookFormat: OrderRecord['bookFormat']): string {
  if (bookFormat === 'digital') {
    return 'Nothing is delivered until you give the final go-ahead.';
  }
  if (bookFormat === 'classic' || bookFormat === 'premium') {
    return 'Nothing is sent to print until you give the final go-ahead.';
  }
  return 'Nothing is delivered or sent to print until you give the final go-ahead.';
}

export function deliveryModeFor(bookFormat: OrderRecord['bookFormat']): 'digital' | 'print' | 'combo' {
  if (bookFormat === 'digital') return 'digital';
  if (bookFormat === 'classic' || bookFormat === 'premium') return 'print';
  return 'combo';
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
  deliveryMode: 'digital' | 'print' | 'combo';
  trustCopy: string;
  openRequestedChangesCount: number;
  customerNudgesPaused: boolean;
}

export function hasReviewAccess(order: OrderRecord, input: ReviewAccessInput = {}): boolean {
  const isPrint = order.bookFormat === 'classic' || order.bookFormat === 'premium';
  if (!isPrint) return true;
  // Legacy/in-progress print orders may not have a proof token yet; preserve
  // operator visibility until proof_ready creates one.
  if (!order.proofApprovalToken) return true;
  return input.reviewToken === order.proofApprovalToken;
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
  if (isPrint && order.fulfillmentStatus === 'proof_ready') {
    const proofGate = evaluateProofSubmissionGate(order);
    if (!proofGate.allowed) return null;
  }
  return {
    orderId: order.id,
    childName: order.childName,
    reviewStatus: order.reviewStatus ?? 'in_review',
    pageArtifacts: [...order.pageArtifacts].sort((a, b) => a.pageIndex - b.pageIndex),
    storyArtifactUrl: order.storyArtifactUrl ?? null,
    isPrint,
    bookFormat: order.bookFormat,
    proofReviewedAt: order.proofReviewedAt ?? null,
    deliveryMode: deliveryModeFor(order.bookFormat),
    trustCopy: deliveryTrustCopy(order.bookFormat),
    openRequestedChangesCount: (order.pageArtifacts ?? []).filter((page) =>
      page.customerReviewStatus === 'changes_requested' &&
      page.customerRequestedChange?.lifecycleStatus !== 'resolved',
    ).length,
    customerNudgesPaused: shouldPauseCustomerReviewNudges(order),
  };
}
