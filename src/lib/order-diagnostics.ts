// Order diagnostics — single read-only summary of the critical state
// support/ops needs to triage a live order. Pure over OrderRecord so it can
// power the admin page, the support API endpoint, and the CLI script with
// identical semantics.

import type { OrderRecord, ReviewAuditEvent } from './orders.ts';
import { isPrintFormat } from './orders.ts';

export type DiagnosticSeverity = 'ok' | 'info' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: string;
  label: string;
  severity: DiagnosticSeverity;
  detail: string;
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
  };
  /** Ordered list of named checks — the ones that fail are what to escalate on. */
  checks: DiagnosticCheck[];
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
    },
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
  lines.push(`Pages: ${d.artifacts.pagesAccepted}/${d.artifacts.pageArtifactCount} accepted · ${d.artifacts.pagesWithoutImage} missing image · ${d.artifacts.totalRegenerations} regenerations`);
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
