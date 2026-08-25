// Order diagnostics — single read-only summary of the critical state
// support/ops needs to triage a live order. Pure over OrderRecord so it can
// power the admin page, the support API endpoint, and the CLI script with
// identical semantics.

import type { OrderRecord, ReviewAuditEvent } from './orders.ts';
import { isPrintFormat } from './orders.ts';
import { isPrintSubmissionAmbiguous } from './order-incident.ts';

export type DiagnosticSeverity = 'ok' | 'info' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: string;
  label: string;
  severity: DiagnosticSeverity;
  detail: string;
}

export type PaidOrderOpsIssueKind =
  /** Irreversible print submission with no provider job identity. Reported even
   *  when a story/proof artifact exists — that is precisely the case the
   *  artifact early-return used to hide. */
  | 'paid_print_submission_ambiguous'
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
  /** How the story was produced (template / openai_chat / fallback). Null
   *  when storyMeta wasn't persisted (legacy orders before observability). */
  story: {
    source: string | null;
    model: string | null;
    generatedAt: string | null;
    fallbackError: string | null;
  };
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
  /** Ordered list of named checks — the ones that fail are what to escalate on. */
  checks: DiagnosticCheck[];
}

export const PAID_ARTIFACT_STALE_AFTER_MS = 15 * 60 * 1000;

/** The subset of issue kinds that really do mean "no customer artifact exists".
 *  `paid_print_submission_ambiguous` is deliberately excluded: those orders
 *  normally DO have an artifact, and the summary flags must stay truthful. */
const MISSING_ARTIFACT_ISSUE_KINDS: ReadonlySet<PaidOrderOpsIssueKind> = new Set([
  'paid_no_artifact_not_started',
  'paid_no_artifact_failed',
  'paid_no_artifact_stale_in_progress',
  'paid_no_artifact_terminal',
  'paid_no_artifact_waiting',
]);

/** Preserve the historical `opsIssue=paid_artifact` query contract. Ambiguous
 * print is a high-severity ops issue, but it normally has an artifact and must
 * be surfaced through attention/diagnostics rather than this named filter. */
export function isPaidArtifactOpsIssue(issue: PaidOrderOpsIssue | null): boolean {
  return Boolean(
    issue && issue.severity !== 'info' && MISSING_ARTIFACT_ISSUE_KINDS.has(issue.kind),
  );
}

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
  if (order.paymentStatus !== 'paid') return null;

  const fulfillment = order.fulfillmentStatus ?? 'not_started';
  const updatedAt = Date.parse(order.updatedAt ?? order.createdAt ?? '');
  const minutesSinceUpdate = Number.isFinite(updatedAt)
    ? Math.max(0, Math.floor((now.getTime() - updatedAt) / 60_000))
    : null;
  const ageMs = minutesSinceUpdate == null ? Number.POSITIVE_INFINITY : minutesSinceUpdate * 60_000;

  // Checked BEFORE the artifact early-return. An ambiguous print submission is
  // the one paid-order emergency that normally coexists with a finished proof,
  // so gating on a missing artifact hid it from ops entirely. Shared with the
  // incident scan and the admin attention queue. See src/lib/order-incident.ts.
  if (isPrintSubmissionAmbiguous(order)) {
    return {
      kind: 'paid_print_submission_ambiguous',
      severity: 'fail',
      label: 'Print submission unreconciled — a physical job may exist',
      detail: 'The irreversible print submission was attempted and no provider job id came back. Do NOT retry: a retry can create a second physical book. Reconcile against the print provider, then record the outcome on the order.',
      minutesSinceUpdate,
    };
  }

  if (order.storyArtifactUrl) return null;

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

export function buildOrderDiagnostics(order: OrderRecord): OrderDiagnostics {
  const isPrint = isPrintFormat(order.bookFormat);
  const fulfillment = order.fulfillmentStatus ?? 'not_started';
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
    print: {
      printJobId: order.printJobId ?? null,
      printJobStatus: order.printJobStatus ?? null,
      trackingNumber: order.trackingNumber ?? null,
      trackingUrl: order.trackingUrl ?? null,
      shippedAt: order.shippedAt ?? null,
      hasShippingAddress: Boolean(order.shippingAddress),
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
      paidWithoutArtifact: Boolean(paidOrderOpsIssue && MISSING_ARTIFACT_ISSUE_KINDS.has(paidOrderOpsIssue.kind)),
      paidArtifactNeedsAttention: Boolean(
        paidOrderOpsIssue
        && MISSING_ARTIFACT_ISSUE_KINDS.has(paidOrderOpsIssue.kind)
        && paidOrderOpsIssue.severity !== 'info',
      ),
    },
    paidOrderOpsIssue,
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
  if (d.story.source === 'openai_chat') {
    checks.push({ id: 'story-source', label: `Story source: openai_chat (${d.story.model ?? 'unknown'})`, severity: 'ok', detail: 'Model-generated story.' });
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
  if (d.paidOrderOpsIssue) {
    checks.push({
      // The ambiguous-print issue is not an artifact-presence problem, so it
      // gets its own check id rather than masquerading as one.
      id: d.paidOrderOpsIssue.kind === 'paid_print_submission_ambiguous'
        ? 'print-submission-ambiguous'
        : 'paid-artifact',
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
    } else if (d.flags.approved && !d.print.hasShippingAddress) {
      checks.push({ id: 'shipping-address', label: 'No shipping address', severity: 'fail', detail: 'Approved print order with no shippingAddress — will block fulfillment.' });
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
  lines.push(`Photo: blobPath=${d.photo.blobPath ?? 'none'} fileName=${d.photo.fileName ?? 'none'}`);
  lines.push(
    `Story: source=${d.story.source ?? 'unknown'} model=${d.story.model ?? 'unknown'}` +
      `${d.story.generatedAt ? ` generatedAt=${d.story.generatedAt}` : ''}` +
      `${d.story.fallbackError ? ` fallbackError="${d.story.fallbackError}"` : ''}`,
  );
  lines.push(`Pages: ${d.artifacts.pagesAccepted}/${d.artifacts.pageArtifactCount} accepted · ${d.artifacts.pagesWithoutImage} missing image · ${d.artifacts.totalRegenerations} regenerations`);
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
    lines.push(`Print: jobId=${d.print.printJobId ?? 'none'} jobStatus=${d.print.printJobStatus ?? 'none'} tracking=${d.print.trackingNumber ?? 'none'} shippedAt=${d.print.shippedAt ?? 'no'}`);
  }
  const failing = d.checks.filter((c) => c.severity === 'fail');
  const warning = d.checks.filter((c) => c.severity === 'warn');
  if (failing.length > 0) lines.push(`FAIL: ${failing.map((c) => c.label).join(' | ')}`);
  if (warning.length > 0) lines.push(`WARN: ${warning.map((c) => c.label).join(' | ')}`);
  return lines.join('\n');
}
