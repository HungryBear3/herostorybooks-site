// Manual Fulfillment Factory — admin staging actions (Phase 3, 2026-06-10).
//
// First-cut manual path with EXACTLY three operations, all auth-gated at the
// route layer:
//   1. registerManualArtifact  — register an uploaded artifact by Blob ref
//   2. setManualQaReport        — record the internal QA report
//   3. markManualProofReady     — advance to proof_ready_for_customer ONLY if
//                                 isManifestProofReady() passes (422 otherwise)
//
// SCOPE GUARANTEES (enforced by construction — this module imports none of them):
//   - no Stripe, no Lulu/RPI, no print submission
//   - no customer email send, no proof token, no customer proof release
//   - no large-binary transport: artifacts are registered as Blob REFS only;
//     raw bytes / base64 / data URIs / arbitrary external URLs are rejected.
//
// The manifest is persisted on OrderRecord.artifactManifest via the existing
// CAS/locked write path (updateFulfillmentState → mutateOrderRecord), so it is
// blob-ref-only and concurrency-safe. Its presence marks an order as
// manual-managed; the proof-release guard (admin-actions.releaseOrderAfterQa)
// then requires isManifestProofReady() before any customer-visible release.

import {
  appendAuditEvent,
  getOrder,
  updateFulfillmentState,
  type OrderRecord,
} from './orders.ts';
import {
  describeManifestGateFailures,
  isManifestProofReady,
  type ArtifactRecord,
  type OrderArtifactManifest,
  type QAReportRecord,
} from './fulfillment-types.ts';

// ── Blob-ref validation ──────────────────────────────────────────────────────
//
// Only the approved Vercel Blob host is accepted. data:/base64/data-URI and
// arbitrary external domains are rejected at this write boundary so no raw or
// off-platform payload can ever enter the durable manifest.
export const APPROVED_BLOB_URL_RE =
  /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/[^\s]+$/;

export function isApprovedBlobUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // Reject data URIs / embedded base64 payloads outright.
  if (/^data:/i.test(trimmed)) return false;
  if (/;base64,/i.test(trimmed)) return false;
  // Only the approved public Blob host — never an arbitrary external URL.
  return APPROVED_BLOB_URL_RE.test(trimmed);
}

const VALID_ARTIFACT_SOURCES: ReadonlySet<ArtifactRecord['source']> = new Set([
  'openai_chat',
  'openai_page_prose',
  'ollama_page_prose',
  'gemini_page_prose',
  'template',
  'template_after_openai_failure',
  'manual',
  'operator_upload',
  'api_generated',
]);

export type ManualArtifactSlot =
  | 'storyBrief'
  | 'pagePlan'
  | 'proseFinal'
  | 'artDirectionPacket'
  | 'proofPdf'
  | 'pageImage';

export interface RegisterArtifactInput {
  slot: ManualArtifactSlot;
  /** 1-based page number — required iff slot === 'pageImage'. */
  pageNumber?: number;
  url: string;
  source: ArtifactRecord['source'];
  producedBy: string;
  checksum?: string;
  producedAt?: string;
}

export interface SetQaReportInput {
  passed: boolean;
  reviewedBy: string;
  notes?: string;
  checks: QAReportRecord['checks'];
  reviewedAt?: string;
}

export type ManualActionResult =
  | { ok: true; manifest: OrderArtifactManifest; fulfillmentStatus: OrderRecord['fulfillmentStatus'] }
  | { ok: false; status: 400 | 404 | 409 | 422; error: string; code: string; reasons?: string[] };

function emptyManifest(orderId: string, now: string): OrderArtifactManifest {
  return {
    schemaVersion: 1,
    orderId,
    createdAt: now,
    updatedAt: now,
    generatedBy: 'operator',
    storyBrief: null,
    pagePlan: null,
    proseFinal: null,
    artDirectionPacket: null,
    pageImages: null,
    proofPdf: null,
    qaReport: null,
  };
}

/** Manual orders are paid orders parked in the manual queue. Returns a failure
 *  ManualActionResult to return verbatim, or null when the order is eligible.
 *  (Single-shape style: this codebase compiles with tsconfig "strict": false,
 *  under which `!result.ok` does not narrow a discriminated union.) */
function manualEligibilityFailure(order: OrderRecord | null): ManualActionResult | null {
  if (!order) return { ok: false, status: 404, error: 'Order not found', code: 'order_not_found' };
  if (order.paymentStatus !== 'paid') {
    return { ok: false, status: 400, error: 'Order is not paid', code: 'order_not_paid' };
  }
  return null;
}

// ── 1. Register artifact (blob ref only) ──────────────────────────────────────

export async function registerManualArtifact(
  orderId: string,
  input: RegisterArtifactInput,
  now: string = new Date().toISOString(),
): Promise<ManualActionResult> {
  const order = await getOrder(orderId);
  const ineligible = manualEligibilityFailure(order);
  if (ineligible) return ineligible;

  if (!isApprovedBlobUrl(input.url)) {
    return {
      ok: false,
      status: 400,
      error:
        'Artifact must be an approved Vercel Blob URL — data URIs, base64 payloads, and external URLs are rejected.',
      code: 'invalid_artifact_url',
    };
  }
  if (!VALID_ARTIFACT_SOURCES.has(input.source)) {
    return { ok: false, status: 400, error: `Unknown artifact source: ${input.source}`, code: 'invalid_artifact_source' };
  }
  const producedBy = (input.producedBy ?? '').trim().slice(0, 120);
  if (!producedBy) {
    return { ok: false, status: 400, error: 'producedBy required (non-empty operator/model id)', code: 'produced_by_required' };
  }
  if (input.slot === 'pageImage') {
    if (!Number.isInteger(input.pageNumber) || (input.pageNumber as number) < 1) {
      return { ok: false, status: 400, error: 'pageNumber (>= 1) required for a pageImage artifact', code: 'page_number_required' };
    }
  }

  const record: ArtifactRecord = {
    url: input.url.trim(),
    source: input.source,
    producedAt: input.producedAt ?? now,
    producedBy,
    ...(input.checksum ? { checksum: String(input.checksum).slice(0, 200) } : {}),
  };

  const manifest: OrderArtifactManifest = order.artifactManifest
    ? { ...order.artifactManifest, updatedAt: now }
    : emptyManifest(orderId, now);

  if (input.slot === 'pageImage') {
    manifest.pageImages = { ...(manifest.pageImages ?? {}), [input.pageNumber as number]: record };
  } else {
    manifest[input.slot] = record;
  }
  // mixed once any operator-registered ref coexists with an api/template source.
  manifest.generatedBy = 'operator';

  // First artifact moves the order from the queue into in-progress; never
  // regress a later state.
  const nextStatus =
    order.fulfillmentStatus === 'manual_generation_required'
      ? ('generation_in_progress' as const)
      : order.fulfillmentStatus;

  const updated = await updateFulfillmentState(orderId, {
    artifactManifest: manifest,
    ...(nextStatus !== order.fulfillmentStatus ? { fulfillmentStatus: nextStatus } : {}),
  });
  if (!updated) return { ok: false, status: 404, error: 'Order not found', code: 'order_not_found' };

  await appendAuditEvent(
    orderId,
    {
      type: 'manual_artifact_registered',
      meta: {
        slot: input.slot,
        ...(input.slot === 'pageImage' ? { pageNumber: input.pageNumber ?? null } : {}),
        source: input.source,
        producedBy,
        hasChecksum: Boolean(input.checksum),
      },
    },
    updated,
  );

  return { ok: true, manifest, fulfillmentStatus: updated.fulfillmentStatus };
}

// ── 2. Set QA report ──────────────────────────────────────────────────────────

export async function setManualQaReport(
  orderId: string,
  input: SetQaReportInput,
  now: string = new Date().toISOString(),
): Promise<ManualActionResult> {
  const order = await getOrder(orderId);
  const ineligible = manualEligibilityFailure(order);
  if (ineligible) return ineligible;

  if (!order.artifactManifest) {
    return { ok: false, status: 409, error: 'No artifact manifest yet — register artifacts before QA', code: 'manifest_missing' };
  }
  const reviewedBy = (input.reviewedBy ?? '').trim().slice(0, 120);
  if (!reviewedBy) {
    return { ok: false, status: 400, error: 'reviewedBy required (non-empty operator id)', code: 'reviewed_by_required' };
  }
  if (!input.checks || typeof input.checks !== 'object') {
    return { ok: false, status: 400, error: 'checks object required', code: 'qa_checks_required' };
  }

  const qaReport: QAReportRecord = {
    passed: input.passed === true,
    reviewedAt: input.reviewedAt ?? now,
    reviewedBy,
    notes: String(input.notes ?? '').slice(0, 2000),
    checks: {
      noTemplateSource: input.checks.noTemplateSource === true,
      allPageImagesPresent: input.checks.allPageImagesPresent === true,
      proofPdfPresent: input.checks.proofPdfPresent === true,
      artDirectionPacketPresent: input.checks.artDirectionPacketPresent === true,
      proseFinalPresent: input.checks.proseFinalPresent === true,
    },
  };

  const manifest: OrderArtifactManifest = { ...order.artifactManifest, qaReport, updatedAt: now };

  // When the QA report is recorded and the order is still in-progress, surface
  // it as awaiting internal QA disposition. No customer-visible effect.
  const nextStatus =
    order.fulfillmentStatus === 'generation_in_progress' ||
    order.fulfillmentStatus === 'manual_generation_required'
      ? ('proof_ready_for_internal_qa' as const)
      : order.fulfillmentStatus;

  const updated = await updateFulfillmentState(orderId, {
    artifactManifest: manifest,
    ...(nextStatus !== order.fulfillmentStatus ? { fulfillmentStatus: nextStatus } : {}),
  });
  if (!updated) return { ok: false, status: 404, error: 'Order not found', code: 'order_not_found' };

  await appendAuditEvent(
    orderId,
    { type: 'manual_qa_report_set', meta: { reviewedBy, passed: qaReport.passed } },
    updated,
  );

  return { ok: true, manifest, fulfillmentStatus: updated.fulfillmentStatus };
}

// ── 3. Mark proof ready (gated) ───────────────────────────────────────────────

export async function markManualProofReady(
  orderId: string,
  now: string = new Date().toISOString(),
): Promise<ManualActionResult> {
  const order = await getOrder(orderId);
  const ineligible = manualEligibilityFailure(order);
  if (ineligible) return ineligible;

  const manifest = order.artifactManifest ?? null;
  if (!isManifestProofReady(manifest)) {
    const reasons = describeManifestGateFailures(manifest);
    await appendAuditEvent(orderId, {
      type: 'manual_proof_ready_blocked',
      reason: reasons[0] ?? 'manifest_incomplete',
      meta: { reasons: reasons.join(',') },
    });
    return {
      ok: false,
      status: 422,
      error: `Manifest is not proof-ready: ${reasons.join(', ')}`,
      code: 'manifest_not_proof_ready',
      reasons,
    };
  }

  // Gate passed. Advance to proof_ready_for_customer as an INTERNAL state only —
  // NO customer email, NO proof token, NO storyArtifactUrl write (which would
  // engage the legacy release guard). Customer release is a later, separately
  // gated phase (must require proof_ready_for_customer AND isManifestProofReady).
  const updated = await updateFulfillmentState(orderId, {
    artifactManifest: { ...manifest!, updatedAt: now },
    fulfillmentStatus: 'proof_ready_for_customer',
  });
  if (!updated) return { ok: false, status: 404, error: 'Order not found', code: 'order_not_found' };

  await appendAuditEvent(
    orderId,
    { type: 'manual_proof_ready_marked', meta: { qaReviewer: manifest!.qaReport?.reviewedBy ?? null } },
    updated,
  );

  return { ok: true, manifest: updated.artifactManifest!, fulfillmentStatus: updated.fulfillmentStatus };
}
