// Order diagnostics — single read-only summary of the critical state
// support/ops needs to triage a live order. Pure over OrderRecord so it can
// power the admin page, the support API endpoint, and the CLI script with
// identical semantics.

import type { OrderRecord, ReviewAuditEvent } from './orders.ts';
import { isPrintFormat } from './orders.ts';
import { ArtDirectionPacketSchema } from './art-direction-schemas.ts';
import { validateStoryboardCompleteness, type StoryboardValidationIssue } from './storyboard-validator.ts';
import { evaluateProofSubmissionGate, hasUsableShippingAddress } from './proof-submission-gate.ts';
import { evaluateArtifactEvidence, type ArtifactEvidenceResult } from './artifact-evidence.ts';

export type DiagnosticSeverity = 'ok' | 'info' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: string;
  label: string;
  severity: DiagnosticSeverity;
  detail: string;
}

export type PaidOrderOpsIssueKind =
  | 'paid_no_artifact_not_started'
  | 'paid_no_artifact_failed'
  | 'paid_no_artifact_stale_in_progress'
  | 'paid_no_artifact_terminal'
  | 'paid_no_artifact_waiting';

export interface PaidOrderOpsIssue {
  kind: PaidOrderOpsIssueKind;
  severity: Exclude<DiagnosticSeverity, 'ok'>;
  label: string;
  detail: string;
  minutesSinceUpdate: number | null;
}

export interface OrderDiagnostics {
  orderId: string;
  capturedAt: string;
  identity: {
    childName: string;
    email: string;
    bookFormat: string;
    formatLabel: string;
    isPrint: boolean;
    priceCents: number;
    createdAt: string;
    updatedAt: string;
  };
  payment: {
    status: string;
    stripeSessionId: string | null;
  };
  photo: {
    hasFileName: boolean;
    hasBlobPath: boolean;
    fileName: string | null;
    blobPath: string | null;
  };
  /** Guided multi-angle reference photos captured at checkout. Metadata only
   *  (label + filename + blob path presence); still images only, never video. */
  guidedPhotos: {
    count: number;
    persistedCount: number;
    labels: string[];
    refs: Array<{ label: string; fileName: string; hasBlobPath: boolean; consentAt: string | null }>;
  };
  /** How the story was produced (template / openai_chat / fallback). Null
   *  when storyMeta wasn't persisted (legacy orders before observability). */
  story: {
    source: string | null;
    model: string | null;
    generatedAt: string | null;
    fallbackError: string | null;
  };
  /** Admin/support-visible source material captured at checkout. This is
   *  metadata and bounded text only; blob URLs/invite tokens are intentionally
   *  not exposed here. */
  storyInput: {
    hasCustomText: boolean;
    hasTheme: boolean;
    theme: string | null;
    hasLesson: boolean;
    lesson: string | null;
    hasOccasion: boolean;
    occasion: string | null;
    hasGiftMessage: boolean;
    giftMessagePreview: string | null;
    hasCharacterNotes: boolean;
    characterNotesPreview: string | null;
    hasVoiceOrUpload: boolean;
    voiceSource: string | null;
    voiceFileName: string | null;
    voiceBlobPath: string | null;
    voiceConsentAt: string | null;
    transcriptStatus: 'none' | 'stored' | 'failed';
    transcriptModel: string | null;
    transcriptChars: number | null;
    transcriptPreview: string | null;
    inspirationChars: number | null;
    inspirationPreview: string | null;
    transcriptError: string | null;
  };
  /** Read-only art-direction/storyboard visibility for admin/support.
   *  Bounded summaries only: no raw prompt text, URLs, tokens, or full packet. */
  artDirection: ArtDirectionDiagnostics;
  artifacts: {
    storyArtifactUrl: string | null;
    pageArtifactCount: number;
    pagesAccepted: number;
    pagesPending: number;
    totalRegenerations: number;
    pagesWithoutImage: number;
    /** Per-conditioning page counts so ops can see at a glance whether the
     *  customer's photo actually drove the illustrations or whether we
     *  fell back to text-only on every page. */
    pagesPhotoConditioned: number;
    pagesTextOnly: number;
    pagesUnknownConditioning: number;
    /** Per-page conditioning detail. One entry per pageArtifact, in page
     *  order. Lets admin/ops see exactly which path ran on each page
     *  without parsing versionHistory. */
    perPageConditioning: Array<{
      pageIndex: number;
      provider: string | null;
      model: string | null;
      conditioning: string | null;
      hasReferencePhoto: boolean;
      hasImage: boolean;
      regenerateCount: number;
    }>;
  };
  review: {
    reviewStatus: string;
    proofReviewedAt: string | null;
    proofApprovalToken: string | null;
    proofApprovedAt: string | null;
    auditEventCount: number;
    recentEvents: ReviewAuditEvent[];
  };
  fulfillment: {
    fulfillmentStatus: string;
    orderStatus: string;
    attempts: number;
    lastError: string | null;
  };
  proofGate: {
    gated: boolean;
    allowed: boolean;
    overrideApplied: boolean;
    reasons: string[];
  };
  print: {
    printJobId: string | null;
    printJobStatus: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    shippedAt: string | null;
    hasShippingAddress: boolean;
  };
  /** Top-level boolean shortcuts that summarize "what's wrong" at a glance. */
  flags: {
    isPaid: boolean;
    isFailed: boolean;
    needsCustomerAction: boolean;
    proofReady: boolean;
    proofAcknowledged: boolean;
    approved: boolean;
    sentToPrint: boolean;
    shipped: boolean;
    /** Paid order has not produced a customer-facing proof/digital PDF yet. */
    paidWithoutArtifact: boolean;
    /** Paid-without-artifact is actionable now (not merely seconds into generation). */
    paidArtifactNeedsAttention: boolean;
  };
  /** Compact ops-facing classification for paid orders missing their artifact. */
  paidOrderOpsIssue: PaidOrderOpsIssue | null;
  /**
   * Artifact evidence gate (Slice 4). Read-only/diagnostic: structured evidence
   * for whether the persisted artifacts support a gift-quality/custom proof
   * claim. Does NOT flip proof_release_hold or manual review — Rex decides.
   * Default fail-closed for unknown/template-only/short/imageless artifacts.
   */
  evidence: ArtifactEvidenceResult;
  /** Ordered list of named checks — the ones that fail are what to escalate on. */
  checks: DiagnosticCheck[];
}

export interface ArtDirectionDiagnostics {
  status: 'absent' | 'present' | 'invalid';
  packetPresent: boolean;
  schemaValid: boolean | null;
  generatedAt: string | null;
  humanReviewStatus: string | null;
  humanReviewNotes: string | null;
  styleBible: {
    bookId: string | null;
    templateId: string | null;
    targetIllustrationStyle: string | null;
    renderingLevel: string | null;
    paletteColorCount: number;
    prohibitedCount: number;
    continuityMotifCount: number;
    continuityMotifs: string[];
    approvedBy: string | null;
    approvedAt: string | null;
  } | null;
  characterSheets: {
    count: number;
    approvedCount: number;
    roles: string[];
    summaries: Array<{
      id: string | null;
      name: string | null;
      role: string | null;
      approvedBy: string | null;
      approvedAt: string | null;
      recurringTraitCount: number;
      neverChangeCount: number;
    }>;
  };
  storyboard: {
    validationStatus: 'complete' | 'incomplete' | 'not_available';
    bookId: string | null;
    expectedEntries: number | null;
    actualEntries: number | null;
    missingPages: number[];
    duplicatePages: number[];
    coveredStoryBeats: string[];
    missingStoryBeats: string[];
    errors: Array<BoundedArtDirectionIssue>;
    warnings: Array<BoundedArtDirectionIssue>;
    errorCount: number;
    warningCount: number;
  };
  continuity: {
    pagesWithContinuityCallback: number;
    pagesWithRecurringObjects: number;
    recurringObjectCount: number;
    uniqueRecurringObjectCount: number;
  };
  schemaErrors: Array<BoundedArtDirectionIssue>;
}

export interface BoundedArtDirectionIssue {
  code: string;
  message: string;
  path: string;
  pageNumber?: number;
}

export const PAID_ARTIFACT_STALE_AFTER_MS = 15 * 60 * 1000;

const IN_PROGRESS_FULFILLMENT_STATUSES = new Set([
  'generating_story',
  'generating_images',
  'building_pdf',
  'submitting_to_print',
]);

/**
 * Single source of truth for the ops dashboard/query: a paid order without a
 * story/proof artifact is either (a) an immediate action item, or (b) a fresh
 * in-progress run that is still inside the normal generation window.
 */
export function classifyPaidOrderOpsIssue(
  order: OrderRecord,
  now: Date = new Date(),
): PaidOrderOpsIssue | null {
  if (order.paymentStatus !== 'paid' || order.storyArtifactUrl) return null;

  const fulfillment = order.fulfillmentStatus ?? 'not_started';
  const updatedAt = Date.parse(order.updatedAt ?? order.createdAt ?? '');
  const minutesSinceUpdate = Number.isFinite(updatedAt)
    ? Math.max(0, Math.floor((now.getTime() - updatedAt) / 60_000))
    : null;
  const ageMs = minutesSinceUpdate == null ? Number.POSITIVE_INFINITY : minutesSinceUpdate * 60_000;

  if (fulfillment === 'not_started') {
    return {
      kind: 'paid_no_artifact_not_started',
      severity: 'fail',
      label: 'Paid but fulfillment has not started',
      detail: 'Payment is confirmed, but no proof/digital artifact exists and fulfillmentStatus is not_started. Check webhook/kickoff logs; use admin retry if safe.',
      minutesSinceUpdate,
    };
  }

  if (fulfillment === 'failed_manual_review') {
    return {
      kind: 'paid_no_artifact_failed',
      severity: 'fail',
      label: 'Paid fulfillment failed before artifact',
      detail: `No proof/digital artifact exists. Last error: ${order.fulfillmentLastError ?? '(none recorded)'}`,
      minutesSinceUpdate,
    };
  }

  if (IN_PROGRESS_FULFILLMENT_STATUSES.has(fulfillment)) {
    if (ageMs >= PAID_ARTIFACT_STALE_AFTER_MS) {
      return {
        kind: 'paid_no_artifact_stale_in_progress',
        severity: 'fail',
        label: 'Paid fulfillment appears stuck before artifact',
        detail: `No proof/digital artifact exists and fulfillmentStatus=${fulfillment} has not updated for ${minutesSinceUpdate ?? 'unknown'} minute(s).`,
        minutesSinceUpdate,
      };
    }
    return {
      kind: 'paid_no_artifact_waiting',
      severity: 'info',
      label: 'Paid fulfillment in progress; artifact pending',
      detail: `fulfillmentStatus=${fulfillment}; still inside the ${PAID_ARTIFACT_STALE_AFTER_MS / 60_000}-minute stuck threshold.`,
      minutesSinceUpdate,
    };
  }

  return {
    kind: 'paid_no_artifact_terminal',
    severity: 'fail',
    label: 'Paid order is in an artifact-inconsistent state',
    detail: `fulfillmentStatus=${fulfillment} but no proof/digital artifact URL exists. This needs manual review before customer follow-up.`,
    minutesSinceUpdate,
  };
}

const RECENT_EVENT_LIMIT = 10;
const INPUT_PREVIEW_LIMIT = 280;
const ART_DIRECTION_ISSUE_LIMIT = 8;
const ART_DIRECTION_CHARACTER_LIMIT = 8;
const ART_DIRECTION_MOTIF_LIMIT = 8;

function cleanPreview(value: string | null | undefined, max = INPUT_PREVIEW_LIMIT): string | null {
  const cleaned = String(value ?? '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(cleanPreview(value, 1));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedIssue(issue: StoryboardValidationIssue): BoundedArtDirectionIssue {
  return {
    code: issue.code,
    message: cleanPreview(issue.message, 180) ?? '',
    path: issue.path,
    ...(issue.pageNumber !== undefined ? { pageNumber: issue.pageNumber } : {}),
  };
}

function countPaletteColors(palette: unknown): number {
  if (!isRecord(palette)) return 0;
  return ['primary', 'secondary', 'accent']
    .map((key) => palette[key])
    .filter(Array.isArray)
    .reduce((sum, colors) => sum + colors.length, 0);
}

function extractPacket(order: OrderRecord): unknown | null {
  return order.artDirectionPacket ?? null;
}

function buildArtDirectionDiagnostics(order: OrderRecord): ArtDirectionDiagnostics {
  const rawPacket = extractPacket(order);
  if (!rawPacket) {
    return {
      status: 'absent',
      packetPresent: false,
      schemaValid: null,
      generatedAt: order.artDirectionGeneratedAt ?? null,
      humanReviewStatus: order.artDirectionHumanReviewStatus ?? null,
      humanReviewNotes: cleanPreview(order.artDirectionHumanReviewNotes, 180),
      styleBible: null,
      characterSheets: { count: 0, approvedCount: 0, roles: [], summaries: [] },
      storyboard: {
        validationStatus: 'not_available',
        bookId: null,
        expectedEntries: null,
        actualEntries: null,
        missingPages: [],
        duplicatePages: [],
        coveredStoryBeats: [],
        missingStoryBeats: [],
        errors: [],
        warnings: [],
        errorCount: 0,
        warningCount: 0,
      },
      continuity: {
        pagesWithContinuityCallback: 0,
        pagesWithRecurringObjects: 0,
        recurringObjectCount: 0,
        uniqueRecurringObjectCount: 0,
      },
      schemaErrors: [],
    };
  }

  const parsed = ArtDirectionPacketSchema.safeParse(rawPacket);
  const packet = parsed.success ? parsed.data : (isRecord(rawPacket) ? rawPacket : {});
  const styleBible = isRecord(packet.style_bible) ? packet.style_bible : null;
  const sheets = Array.isArray(packet.character_sheets)
    ? packet.character_sheets.filter(isRecord)
    : [];
  const storyboard = isRecord(packet.storyboard) ? packet.storyboard : null;
  const entries = storyboard && Array.isArray(storyboard.entries)
    ? storyboard.entries.filter(isRecord)
    : [];

  const validation = order.artDirectionValidation ?? validateStoryboardCompleteness(rawPacket);
  const recurringObjects = entries.flatMap((entry) =>
    Array.isArray(entry.required_recurring_objects)
      ? entry.required_recurring_objects.filter((value) => typeof value === 'string' && value.trim())
      : [],
  );

  const schemaErrors = parsed.success ? [] : parsed.error.issues.slice(0, ART_DIRECTION_ISSUE_LIMIT).map((issue) => ({
    code: 'schema_invalid',
    message: cleanPreview(issue.message, 180) ?? '',
    path: issue.path.join('.') || 'artDirectionPacket',
  }));

  return {
    status: parsed.success ? 'present' : 'invalid',
    packetPresent: true,
    schemaValid: parsed.success,
    generatedAt: order.artDirectionGeneratedAt ?? null,
    humanReviewStatus: order.artDirectionHumanReviewStatus ?? null,
    humanReviewNotes: cleanPreview(order.artDirectionHumanReviewNotes, 180),
    styleBible: styleBible ? {
      bookId: typeof styleBible.book_id === 'string' ? styleBible.book_id : null,
      templateId: typeof styleBible.template_id === 'string' ? styleBible.template_id : null,
      targetIllustrationStyle: typeof styleBible.target_illustration_style === 'string' ? styleBible.target_illustration_style : null,
      renderingLevel: typeof styleBible.rendering_level === 'string' ? styleBible.rendering_level : null,
      paletteColorCount: countPaletteColors(styleBible.palette),
      prohibitedCount: Array.isArray(styleBible.prohibited) ? styleBible.prohibited.length : 0,
      continuityMotifCount: Array.isArray(styleBible.continuity_motifs) ? styleBible.continuity_motifs.length : 0,
      continuityMotifs: Array.isArray(styleBible.continuity_motifs)
        ? styleBible.continuity_motifs.filter((value): value is string => typeof value === 'string').slice(0, ART_DIRECTION_MOTIF_LIMIT)
        : [],
      approvedBy: isRecord(styleBible.versioning) && typeof styleBible.versioning.approved_by === 'string'
        ? styleBible.versioning.approved_by
        : null,
      approvedAt: isRecord(styleBible.versioning) && typeof styleBible.versioning.approved_at === 'string'
        ? styleBible.versioning.approved_at
        : null,
    } : null,
    characterSheets: {
      count: sheets.length,
      approvedCount: sheets.filter((sheet) =>
        isRecord(sheet.versioning) &&
        typeof sheet.versioning.approved_by === 'string' &&
        typeof sheet.versioning.approved_at === 'string',
      ).length,
      roles: [...new Set(sheets.map((sheet) => typeof sheet.role === 'string' ? sheet.role : 'unknown'))],
      summaries: sheets.slice(0, ART_DIRECTION_CHARACTER_LIMIT).map((sheet) => ({
        id: typeof sheet.character_id === 'string' ? sheet.character_id : null,
        name: typeof sheet.display_name === 'string' ? sheet.display_name : null,
        role: typeof sheet.role === 'string' ? sheet.role : null,
        approvedBy: isRecord(sheet.versioning) && typeof sheet.versioning.approved_by === 'string'
          ? sheet.versioning.approved_by
          : null,
        approvedAt: isRecord(sheet.versioning) && typeof sheet.versioning.approved_at === 'string'
          ? sheet.versioning.approved_at
          : null,
        recurringTraitCount: isRecord(sheet.companion_anchors) && Array.isArray(sheet.companion_anchors.recurring_traits)
          ? sheet.companion_anchors.recurring_traits.length
          : 0,
        neverChangeCount: Array.isArray(sheet.never_change) ? sheet.never_change.length : 0,
      })),
    },
    storyboard: {
      validationStatus: validation.status,
      bookId: validation.bookId,
      expectedEntries: validation.summary.expectedEntries,
      actualEntries: validation.summary.actualEntries,
      missingPages: validation.summary.missingPages,
      duplicatePages: validation.summary.duplicatePages,
      coveredStoryBeats: validation.summary.coveredStoryBeats,
      missingStoryBeats: validation.summary.missingStoryBeats,
      errors: validation.errors.slice(0, ART_DIRECTION_ISSUE_LIMIT).map(boundedIssue),
      warnings: validation.warnings.slice(0, ART_DIRECTION_ISSUE_LIMIT).map(boundedIssue),
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
    },
    continuity: {
      pagesWithContinuityCallback: entries.filter((entry) => isRecord(entry.continuity_callback)).length,
      pagesWithRecurringObjects: entries.filter((entry) =>
        Array.isArray(entry.required_recurring_objects) && entry.required_recurring_objects.length > 0,
      ).length,
      recurringObjectCount: recurringObjects.length,
      uniqueRecurringObjectCount: new Set(recurringObjects).size,
    },
    schemaErrors,
  };
}

export function buildOrderDiagnostics(order: OrderRecord): OrderDiagnostics {
  const isPrint = isPrintFormat(order.bookFormat);
  const fulfillment = order.fulfillmentStatus ?? 'not_started';
  const proofGate = evaluateProofSubmissionGate(order);
  const isFailed = fulfillment === 'failed_manual_review';
  const isPaid = order.paymentStatus === 'paid';
  const proofReady = fulfillment === 'proof_ready' && Boolean(order.storyArtifactUrl);
  const approved = order.reviewStatus === 'approved';
  const proofAcknowledged = Boolean(order.proofReviewedAt);
  const sentToPrint =
    fulfillment === 'submitting_to_print' ||
    fulfillment === 'complete' ||
    order.status === 'print_in_production' ||
    order.status === 'shipped';
  const shipped = order.status === 'shipped';
  const paidOrderOpsIssue = classifyPaidOrderOpsIssue(order);

  const pages = order.pageArtifacts ?? [];
  const pagesAccepted = pages.filter((p) => p.accepted).length;
  const pagesPending = pages.length - pagesAccepted;
  const pagesPhotoConditioned = pages.filter((p) => p.generationConditioning === 'photo_edit').length;
  const pagesTextOnly = pages.filter((p) => p.generationConditioning === 'text_only').length;
  const pagesUnknownConditioning = pages.length - pagesPhotoConditioned - pagesTextOnly;
  const totalRegenerations = pages.reduce((sum, p) => sum + p.regenerateCount, 0);
  const pagesWithoutImage = pages.filter((p) => !p.currentImageUrl).length;

  const auditEvents = order.auditEvents ?? [];
  const recentEvents = auditEvents.slice(-RECENT_EVENT_LIMIT);

  const diag: OrderDiagnostics = {
    orderId: order.id,
    capturedAt: new Date().toISOString(),
    identity: {
      childName: order.childName,
      email: order.email,
      bookFormat: order.bookFormat,
      formatLabel: order.formatLabel,
      isPrint,
      priceCents: order.priceCents,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    },
    payment: {
      status: order.paymentStatus,
      stripeSessionId: order.stripeSessionId ?? null,
    },
    guidedPhotos: {
      count: order.guidedReferencePhotos?.length ?? 0,
      persistedCount: (order.guidedReferencePhotos ?? []).filter((r) => Boolean(r.photoBlobPath)).length,
      labels: (order.guidedReferencePhotos ?? []).map((r) => r.label),
      refs: (order.guidedReferencePhotos ?? []).map((r) => ({
        label: r.label,
        fileName: r.fileName,
        hasBlobPath: Boolean(r.photoBlobPath),
        consentAt: r.consentAt ?? null,
      })),
    },
    photo: {
      hasFileName: Boolean(order.photoFileName),
      hasBlobPath: Boolean(order.photoBlobPath),
      fileName: order.photoFileName ?? null,
      blobPath: order.photoBlobPath ?? null,
    },
    story: {
      source: order.storyMeta?.source ?? null,
      model: order.storyMeta?.model ?? null,
      generatedAt: order.storyMeta?.generatedAt ?? null,
      fallbackError: order.storyMeta?.fallbackError ?? null,
    },
    storyInput: {
      hasCustomText: [
        order.lesson,
        order.occasion,
        order.giftMessage,
        order.characterNotes,
      ].some(hasText),
      hasTheme: hasText(order.theme),
      theme: cleanPreview(order.theme, 120),
      hasLesson: hasText(order.lesson),
      lesson: cleanPreview(order.lesson),
      hasOccasion: hasText(order.occasion),
      occasion: cleanPreview(order.occasion, 160),
      hasGiftMessage: hasText(order.giftMessage),
      giftMessagePreview: cleanPreview(order.giftMessage),
      hasCharacterNotes: hasText(order.characterNotes),
      characterNotesPreview: cleanPreview(order.characterNotes),
      hasVoiceOrUpload: Boolean(order.voiceFileName || order.voiceBlobPath || order.voiceTranscript),
      voiceSource: order.voiceSource ?? null,
      voiceFileName: order.voiceFileName ?? null,
      voiceBlobPath: order.voiceBlobPath ?? null,
      voiceConsentAt: order.voiceConsentAt ?? null,
      transcriptStatus: order.voiceTranscript?.error
        ? 'failed'
        : order.voiceTranscript
        ? 'stored'
        : 'none',
      transcriptModel: order.voiceTranscript?.model ?? null,
      transcriptChars: order.voiceTranscript?.transcript?.length ?? null,
      transcriptPreview: cleanPreview(order.voiceTranscript?.transcript),
      inspirationChars: order.voiceTranscript?.inspiration?.length ?? null,
      inspirationPreview: cleanPreview(order.voiceTranscript?.inspiration),
      transcriptError: cleanPreview(order.voiceTranscript?.error, 180),
    },
    artDirection: buildArtDirectionDiagnostics(order),
    artifacts: {
      storyArtifactUrl: order.storyArtifactUrl ?? null,
      pageArtifactCount: pages.length,
      pagesAccepted,
      pagesPending,
      pagesPhotoConditioned,
      pagesTextOnly,
      pagesUnknownConditioning,
      totalRegenerations,
      pagesWithoutImage,
      perPageConditioning: [...pages]
        .sort((a, b) => a.pageIndex - b.pageIndex)
        .map((p) => {
          const lastVersion = p.versionHistory[p.versionHistory.length - 1];
          return {
            pageIndex: p.pageIndex,
            provider: p.generationProvider ?? null,
            model: p.generationModel ?? null,
            conditioning: p.generationConditioning ?? null,
            hasReferencePhoto: Boolean(lastVersion?.referencePhotoUrl),
            hasImage: Boolean(p.currentImageUrl),
            regenerateCount: p.regenerateCount,
          };
        }),
    },
    review: {
      reviewStatus: order.reviewStatus ?? 'not_started',
      proofReviewedAt: order.proofReviewedAt ?? null,
      proofApprovalToken: order.proofApprovalToken ?? null,
      proofApprovedAt: order.proofApprovedAt ?? null,
      auditEventCount: auditEvents.length,
      recentEvents,
    },
    fulfillment: {
      fulfillmentStatus: fulfillment,
      orderStatus: order.status,
      attempts: order.fulfillmentAttempts ?? 0,
      lastError: order.fulfillmentLastError ?? null,
    },
    proofGate: {
      gated: proofGate.gated,
      allowed: proofGate.allowed,
      overrideApplied: proofGate.overrideApplied,
      reasons: proofGate.reasons.map((reason) => reason.code),
    },
    print: {
      printJobId: order.printJobId ?? null,
      printJobStatus: order.printJobStatus ?? null,
      trackingNumber: order.trackingNumber ?? null,
      trackingUrl: order.trackingUrl ?? null,
      shippedAt: order.shippedAt ?? null,
      hasShippingAddress: hasUsableShippingAddress(order),
    },
    flags: {
      isPaid,
      isFailed,
      needsCustomerAction: proofReady && !proofAcknowledged,
      proofReady,
      proofAcknowledged,
      approved,
      sentToPrint,
      shipped,
      paidWithoutArtifact: Boolean(paidOrderOpsIssue),
      paidArtifactNeedsAttention: Boolean(paidOrderOpsIssue && paidOrderOpsIssue.severity !== 'info'),
    },
    paidOrderOpsIssue,
    evidence: evaluateArtifactEvidence(order),
    checks: [],
  };

  diag.checks = buildChecks(order, diag);
  return diag;
}

function buildChecks(order: OrderRecord, d: OrderDiagnostics): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];
  const isPrint = d.identity.isPrint;

  // Payment
  checks.push(
    d.payment.status === 'paid'
      ? { id: 'payment', label: 'Payment confirmed', severity: 'ok', detail: `Stripe session ${d.payment.stripeSessionId ?? '(no session id stored)'}` }
      : d.payment.status === 'failed'
      ? { id: 'payment', label: 'Payment failed', severity: 'fail', detail: 'Stripe reported a failed payment.' }
      : { id: 'payment', label: 'Payment pending', severity: 'warn', detail: 'No paid status — webhook may not have arrived yet.' },
  );

  // Stripe session presence — paid w/o a session ID is the classic "webhook fired before persist" smell
  if (d.payment.status === 'paid' && !d.payment.stripeSessionId) {
    checks.push({ id: 'stripe-session', label: 'Stripe session id missing', severity: 'warn', detail: 'Order is paid but no stripeSessionId is stored. Recovery may be needed.' });
  }

  // Story source observability
  if (
    d.story.source === 'openai_chat' ||
    d.story.source === 'openai_page_prose' ||
    d.story.source === 'ollama_page_prose' ||
    d.story.source === 'gemini_page_prose'
  ) {
    checks.push({ id: 'story-source', label: `Story source: ${d.story.source} (${d.story.model ?? 'unknown'})`, severity: 'ok', detail: 'Model-generated story.' });
  } else if (d.story.source === 'template') {
    checks.push({ id: 'story-source', label: `Story source: template (${d.story.model ?? 'unknown'})`, severity: 'info', detail: 'Deterministic template fallback (no OPENAI_API_KEY or template-only path).' });
  } else if (d.story.source === 'template_after_openai_failure') {
    checks.push({
      id: 'story-source',
      label: 'Story source: template_after_openai_failure',
      severity: 'warn',
      detail: `OpenAI story call failed; template fallback ran. ${d.story.fallbackError ? `Error: ${d.story.fallbackError}` : ''}`,
    });
  } else if (d.flags.isPaid && d.artifacts.pageArtifactCount > 0) {
    // Paid order with pages but no recorded story source = legacy / observability gap.
    checks.push({ id: 'story-source', label: 'Story source: unknown (legacy order)', severity: 'info', detail: 'storyMeta not persisted. Order created before generation observability landed.' });
  }

  // Art direction packet visibility. Read-only: this does not gate
  // fulfillment/proof state in T6 admin visibility.
  if (d.artDirection.status === 'absent') {
    checks.push({
      id: 'art-direction',
      label: 'Art direction packet not generated',
      severity: 'info',
      detail: 'No style bible / character sheet / storyboard packet is stored on this order yet.',
    });
  } else if (d.artDirection.status === 'invalid') {
    checks.push({
      id: 'art-direction',
      label: 'Art direction packet invalid',
      severity: 'warn',
      detail: `${d.artDirection.schemaErrors.length} schema issue(s) shown; storyboard status=${d.artDirection.storyboard.validationStatus}.`,
    });
  } else {
    checks.push({
      id: 'art-direction',
      label: `Art direction packet present (${d.artDirection.storyboard.validationStatus})`,
      severity: d.artDirection.storyboard.validationStatus === 'complete' ? 'ok' : 'warn',
      detail: `${d.artDirection.characterSheets.count} character sheet(s), ${d.artDirection.styleBible?.continuityMotifCount ?? 0} continuity motif(s), ${d.artDirection.continuity.uniqueRecurringObjectCount} unique recurring object(s).`,
    });
  }

  // Photo
  if (d.photo.hasBlobPath) {
    checks.push({ id: 'photo', label: 'Customer photo stored', severity: 'ok', detail: `Blob path: ${d.photo.blobPath}` });
  } else if (d.photo.hasFileName) {
    checks.push({ id: 'photo', label: 'Photo filename present, blob path missing', severity: 'warn', detail: 'Order recorded a filename but no durable blob path — photo may have been dropped.' });
  } else {
    checks.push({ id: 'photo', label: 'No customer photo', severity: 'info', detail: 'Order has no photoFileName/photoBlobPath. Expected only for photo-less SKUs.' });
  }

  // Page artifacts
  if (d.artifacts.pageArtifactCount === 0 && d.flags.isPaid) {
    checks.push({ id: 'pages', label: 'No page artifacts', severity: 'warn', detail: 'Paid order has zero page artifacts. Story/image generation may not have run.' });
  } else if (d.artifacts.pageArtifactCount > 0) {
    const sev: DiagnosticSeverity = d.artifacts.pagesWithoutImage > 0 ? 'warn' : 'ok';
    checks.push({
      id: 'pages',
      label: `Pages: ${d.artifacts.pagesAccepted}/${d.artifacts.pageArtifactCount} accepted, ${d.artifacts.pagesWithoutImage} missing image`,
      severity: sev,
      detail: `${d.artifacts.totalRegenerations} total regenerations across all pages.`,
    });

    // Conditioning observability — surface whether the customer's photo
    // actually drove generation or whether we fell back to text-only.
    const c = d.artifacts;
    if (c.pagesPhotoConditioned > 0) {
      checks.push({
        id: 'conditioning',
        label: `Conditioning: ${c.pagesPhotoConditioned} photo-edit · ${c.pagesTextOnly} text-only · ${c.pagesUnknownConditioning} unknown`,
        severity: 'ok',
        detail: 'At least one page used the customer photo as conditioning input.',
      });
    } else if (d.photo.hasBlobPath && c.pagesTextOnly === c.pageArtifactCount) {
      checks.push({
        id: 'conditioning',
        label: 'All pages text-only despite having a customer photo',
        severity: 'warn',
        detail: 'Photo-conditioned generation may have failed for every page (FAL_KEY missing, model error, or no public URL for the photo). Check fulfillment logs.',
      });
    }
  }

  // Proof presence
  if (d.proofGate.gated) {
    checks.push({
      id: 'proof-release-gate',
      label: d.proofGate.allowed
        ? d.proofGate.overrideApplied
          ? 'Proof release gate passed by recorded override'
          : 'Proof release gate passed'
        : 'Proof release gate blocked',
      severity: d.proofGate.allowed ? (d.proofGate.overrideApplied ? 'warn' : 'ok') : 'fail',
      detail: d.proofGate.reasons.length > 0
        ? `Reasons: ${d.proofGate.reasons.join(', ')}`
        : 'Custom-order story, storyboard, and art-direction checks passed.',
    });
  }
  if (d.paidOrderOpsIssue) {
    checks.push({
      id: 'paid-artifact',
      label: d.paidOrderOpsIssue.label,
      severity: d.paidOrderOpsIssue.severity,
      detail: d.paidOrderOpsIssue.detail,
    });
  }
  if (d.flags.proofReady) {
    checks.push({ id: 'proof', label: 'Proof PDF ready', severity: 'ok', detail: d.artifacts.storyArtifactUrl ?? '' });
  } else if (d.artifacts.storyArtifactUrl) {
    checks.push({ id: 'proof', label: 'Artifact URL present', severity: 'info', detail: `fulfillmentStatus=${d.fulfillment.fulfillmentStatus}.` });
  } else if (d.flags.isPaid) {
    checks.push({ id: 'proof', label: 'No proof PDF yet', severity: d.fulfillment.fulfillmentStatus === 'failed_manual_review' ? 'fail' : 'info', detail: `fulfillmentStatus=${d.fulfillment.fulfillmentStatus}.` });
  }

  // Acknowledgment + approval
  if (isPrint && d.flags.proofReady) {
    checks.push(
      d.flags.proofAcknowledged
        ? { id: 'proof-ack', label: 'Customer acknowledged proof', severity: 'ok', detail: `proofReviewedAt=${d.review.proofReviewedAt}` }
        : { id: 'proof-ack', label: 'Customer has not acknowledged proof', severity: 'warn', detail: 'approveWholeBook will 409 with proof_ack_missing until /api/order/<id>/acknowledge-proof is hit.' },
    );
  }
  if (isPrint) {
    checks.push(
      d.flags.approved
        ? { id: 'approval', label: 'Whole book approved', severity: 'ok', detail: `proofApprovedAt=${d.review.proofApprovedAt ?? '(not set, but reviewStatus=approved)'}` }
        : { id: 'approval', label: 'Whole book not approved', severity: 'info', detail: `reviewStatus=${d.review.reviewStatus}.` },
    );
  }

  // Print job + shipping (print only)
  if (isPrint) {
    if (d.print.printJobId) {
      checks.push({ id: 'print-job', label: `Print job ${d.print.printJobId}`, severity: 'ok', detail: `status=${d.print.printJobStatus ?? '—'}` });
    } else if (d.flags.approved) {
      checks.push({ id: 'print-job', label: 'Approved but no print job id', severity: 'warn', detail: 'submitToPrint may not have completed.' });
    }
    if (d.flags.shipped) {
      checks.push({ id: 'shipped', label: 'Shipped', severity: 'ok', detail: `tracking=${d.print.trackingNumber ?? '(none stored)'} at ${d.print.shippedAt}` });
    } else if (!d.print.hasShippingAddress) {
      checks.push({ id: 'shipping-address', label: 'No usable shipping address', severity: 'fail', detail: 'Print order is missing shippingAddress before proof release / print submission.' });
    }
  }

  // Failure
  if (d.flags.isFailed) {
    checks.push({ id: 'failure', label: 'Marked failed_manual_review', severity: 'fail', detail: d.fulfillment.lastError ?? '(no error message stored)' });
  } else if (d.fulfillment.lastError) {
    checks.push({ id: 'last-error', label: 'fulfillmentLastError set', severity: 'warn', detail: d.fulfillment.lastError });
  }

  // Audit trail sanity — paid + proof_ready but zero events is suspicious
  if (d.flags.isPaid && d.flags.proofReady && d.review.auditEventCount === 0) {
    checks.push({ id: 'audit', label: 'No audit events recorded', severity: 'warn', detail: 'Proof exists but no audit events were appended — older order or audit pipeline missed.' });
  }

  return checks;
}

/** Compact one-line escalation summary suitable for pasting into a support thread. */
export function formatDiagnosticsSummary(d: OrderDiagnostics): string {
  const lines: string[] = [];
  lines.push(`Order ${d.orderId} — ${d.identity.childName} <${d.identity.email}> · ${d.identity.formatLabel}`);
  lines.push(`Created ${d.identity.createdAt} · Updated ${d.identity.updatedAt}`);
  lines.push(`Payment: ${d.payment.status}${d.payment.stripeSessionId ? ` (${d.payment.stripeSessionId})` : ''}`);
  lines.push(`Fulfillment: ${d.fulfillment.fulfillmentStatus} · Order: ${d.fulfillment.orderStatus} · Attempts: ${d.fulfillment.attempts}${d.fulfillment.lastError ? ` · LastError: ${d.fulfillment.lastError}` : ''}`);
  lines.push(
    `Proof gate: gated=${d.proofGate.gated ? 'yes' : 'no'} allowed=${d.proofGate.allowed ? 'yes' : 'no'}` +
      ` override=${d.proofGate.overrideApplied ? 'yes' : 'no'}` +
      `${d.proofGate.reasons.length ? ` reasons=${d.proofGate.reasons.join(',')}` : ''}`,
  );
  lines.push(`Photo: blobPath=${d.photo.blobPath ?? 'none'} fileName=${d.photo.fileName ?? 'none'}`);
  lines.push(
    `Story: source=${d.story.source ?? 'unknown'} model=${d.story.model ?? 'unknown'}` +
      `${d.story.generatedAt ? ` generatedAt=${d.story.generatedAt}` : ''}` +
      `${d.story.fallbackError ? ` fallbackError="${d.story.fallbackError}"` : ''}`,
  );
  lines.push(
    `Story input: theme=${d.storyInput.theme ?? 'none'} lesson=${d.storyInput.lesson ?? 'none'}` +
      ` customText=${d.storyInput.hasCustomText ? 'yes' : 'no'}` +
      ` upload=${d.storyInput.hasVoiceOrUpload ? 'yes' : 'no'}` +
      `${d.storyInput.voiceSource ? ` source=${d.storyInput.voiceSource}` : ''}` +
      `${d.storyInput.voiceFileName ? ` file=${d.storyInput.voiceFileName}` : ''}` +
      ` transcript=${d.storyInput.transcriptStatus}`,
  );
  if (d.storyInput.inspirationPreview) {
    lines.push(`Story inspiration: ${d.storyInput.inspirationPreview}`);
  }
  lines.push(
    `Art direction: status=${d.artDirection.status}` +
      ` schema=${d.artDirection.schemaValid === null ? 'not_present' : d.artDirection.schemaValid ? 'valid' : 'invalid'}` +
      ` storyboard=${d.artDirection.storyboard.validationStatus}` +
      ` style=${d.artDirection.styleBible?.targetIllustrationStyle ?? 'none'}` +
      ` characters=${d.artDirection.characterSheets.approvedCount}/${d.artDirection.characterSheets.count} approved` +
      ` motifs=${d.artDirection.styleBible?.continuityMotifCount ?? 0}` +
      ` recurringObjects=${d.artDirection.continuity.uniqueRecurringObjectCount}` +
      ` errors=${d.artDirection.storyboard.errorCount}`,
  );
  if (d.artDirection.humanReviewStatus || d.artDirection.styleBible?.approvedBy) {
    lines.push(
      `Art direction review: status=${d.artDirection.humanReviewStatus ?? 'none'}` +
        ` styleApprovedBy=${d.artDirection.styleBible?.approvedBy ?? 'none'}` +
        ` styleApprovedAt=${d.artDirection.styleBible?.approvedAt ?? 'none'}`,
    );
  }
  for (const issue of [
    ...d.artDirection.schemaErrors,
    ...d.artDirection.storyboard.errors,
    ...d.artDirection.storyboard.warnings,
  ].slice(0, ART_DIRECTION_ISSUE_LIMIT)) {
    lines.push(`  art-direction ${issue.code} ${issue.path}: ${issue.message}`);
  }
  lines.push(`Pages: ${d.artifacts.pagesAccepted}/${d.artifacts.pageArtifactCount} accepted · ${d.artifacts.pagesWithoutImage} missing image · ${d.artifacts.totalRegenerations} regenerations`);
  lines.push(
    `Artifact evidence: ${d.evidence.severity.toUpperCase()} (ok=${d.evidence.ok ? 'yes' : 'no'}) · ${d.evidence.summary}`,
  );
  for (const r of d.evidence.reasons) {
    lines.push(`  evidence ${r.severity} ${r.code}: ${r.message}`);
  }
  lines.push(
    `Conditioning: ${d.artifacts.pagesPhotoConditioned} photo-edit · ${d.artifacts.pagesTextOnly} text-only · ${d.artifacts.pagesUnknownConditioning} unknown`,
  );
  if (d.artifacts.perPageConditioning.length > 0) {
    for (const p of d.artifacts.perPageConditioning) {
      lines.push(
        `  page ${p.pageIndex}: ${p.conditioning ?? '?'} · ${p.provider ?? '?'}/${p.model ?? '?'}` +
          ` · refPhoto=${p.hasReferencePhoto ? 'yes' : 'no'} · img=${p.hasImage ? 'yes' : 'no'} · regens=${p.regenerateCount}`,
      );
    }
  }
  lines.push(`Proof: ${d.artifacts.storyArtifactUrl ?? 'none'}`);
  lines.push(`Review: status=${d.review.reviewStatus} acknowledged=${d.review.proofReviewedAt ?? 'no'} approved=${d.review.proofApprovedAt ?? 'no'}`);
  if (d.identity.isPrint) {
    lines.push(`Print: shippingAddress=${d.print.hasShippingAddress ? 'yes' : 'no'} jobId=${d.print.printJobId ?? 'none'} jobStatus=${d.print.printJobStatus ?? 'none'} tracking=${d.print.trackingNumber ?? 'none'} shippedAt=${d.print.shippedAt ?? 'no'}`);
  }
  const failing = d.checks.filter((c) => c.severity === 'fail');
  const warning = d.checks.filter((c) => c.severity === 'warn');
  if (failing.length > 0) lines.push(`FAIL: ${failing.map((c) => c.label).join(' | ')}`);
  if (warning.length > 0) lines.push(`WARN: ${warning.map((c) => c.label).join(' | ')}`);
  return lines.join('\n');
}
