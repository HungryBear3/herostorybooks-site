import type { OrderRecord } from './orders.ts';
import { isPrintSubmissionAmbiguous } from './order-incident.ts';

function isPrintFormatForStage(bookFormat: string): boolean {
  return bookFormat === 'classic' || bookFormat === 'premium';
}

export type DerivedOrderStage =
  | 'payment_pending'
  | 'paid'
  | 'in_production'
  | 'awaiting_qa'
  | 'qa_passed'
  | 'proof_sent'
  | 'changes_requested'
  | 'proof_approved'
  | 'print_submitted'
  | 'in_print_production'
  | 'shipped'
  | 'delivered'
  | 'closed'
  | 'refunded'
  | 'cancelled';

export type OrderAttentionSeverity = 'none' | 'warn' | 'blocked';
export type OrderAttentionQueue =
  | 'none'
  | 'fulfillment_recovery'
  | 'email_recovery'
  | 'ops_recovery'
  | 'qa_review'
  | 'print_ops';

export interface DerivedOrderAttention {
  severity: OrderAttentionSeverity;
  reason: string;
  queue: OrderAttentionQueue;
  nextActionOwner: 'none' | 'ops' | 'qa' | 'customer' | 'print_ops';
}

export interface DeriveOrderStageOptions {
  now?: string | Date;
  paidNoArtifactGraceMinutes?: number;
}

const DEFAULT_PAID_NO_ARTIFACT_GRACE_MINUTES = 15;
const IN_PRODUCTION = new Set(['generating_story', 'generating_images', 'building_pdf', 'submitting_to_print']);
const FAILED_RECOVERABLE = new Set(['failed_manual_review', 'delivery_email_failed']);
const CHANGES = new Set(['customer_changes_requested', 'changes_requested']);

function hasCustomerArtifact(order: OrderRecord): boolean {
  // Page-level generation artifacts are internal work-in-progress until a proof/PDF
  // is released. Do not let pageArtifacts alone hide a paid order from recovery.
  return Boolean(order.storyArtifactUrl);
}

function hasReleasedProofEmail(order: OrderRecord): boolean {
  if (order.customerProofReleasedAt) return true;
  return (order.auditEvents ?? []).some((event) =>
    event.type === 'proof_release_override_recorded' ||
    (event.type === 'proof_review_acknowledged' && event.reason === 'customer_email_sent')
  );
}

function minutesSince(dateLike: string | null | undefined, now: string | Date): number | null {
  if (!dateLike) return null;
  const start = Date.parse(dateLike);
  const end = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 60_000));
}

export function deriveOrderStage(order: OrderRecord): DerivedOrderStage {
  if (order.refundedAt || order.paymentStatus === 'refunded') return 'refunded';
  if (order.internalDisposition) return 'cancelled';
  if (order.paymentStatus !== 'paid') return 'payment_pending';

  if (order.printJobStatus === 'delivered') return 'delivered';
  if (order.shippedAt || order.printJobStatus === 'shipped') return 'shipped';
  if (order.printJobStatus && !['created', 'queued', 'shipped', 'delivered'].includes(order.printJobStatus)) return 'in_print_production';
  if (order.printJobId || order.printSubmittedAt) return 'print_submitted';
  if (order.proofApprovedAt || order.printApprovedAt) return 'proof_approved';
  if (order.reviewStatus && CHANGES.has(order.reviewStatus)) return 'changes_requested';
  if (hasReleasedProofEmail(order)) return 'proof_sent';
  if (order.qaPassAt || order.qaStatus === 'passed') return 'qa_passed';

  const fulfillment = order.fulfillmentStatus ?? 'not_started';
  if (IN_PRODUCTION.has(fulfillment)) return 'in_production';
  if (hasCustomerArtifact(order) || fulfillment === 'complete' || fulfillment === 'proof_ready' || FAILED_RECOVERABLE.has(fulfillment)) {
    return 'awaiting_qa';
  }
  return 'paid';
}

export function deriveOrderAttention(order: OrderRecord, options: DeriveOrderStageOptions = {}): DerivedOrderAttention {
  // Highest-severity operator incident, checked FIRST and deliberately ahead of
  // the refund/disposition and missing-shipping branches. An ambiguous print
  // submission means the irreversible provider call may already have produced a
  // physical book, so it must not be masked by a released proof artifact, by a
  // missing shipping address, or by a refund. Shared with the incident scan and
  // paid-order diagnostics via `isPrintSubmissionAmbiguous` so the three
  // surfaces cannot drift. See src/lib/order-incident.ts.
  if (isPrintSubmissionAmbiguous(order)) {
    return {
      severity: 'blocked',
      reason: 'print_submission_ambiguous',
      queue: 'print_ops',
      nextActionOwner: 'print_ops',
    };
  }

  if (order.refundedAt || order.paymentStatus === 'refunded' || order.internalDisposition) {
    return { severity: 'none', reason: 'none', queue: 'none', nextActionOwner: 'none' };
  }

  const stage = deriveOrderStage(order);

  if (
    order.paymentStatus === 'paid' &&
    isPrintFormatForStage(order.bookFormat) &&
    !order.shippingAddress &&
    !['print_submitted', 'in_print_production', 'shipped', 'delivered', 'closed'].includes(stage)
  ) {
    return { severity: 'blocked', reason: 'missing_shipping', queue: 'ops_recovery', nextActionOwner: 'ops' };
  }

  if (stage === 'print_submitted' || stage === 'in_print_production' || stage === 'shipped' || stage === 'delivered' || stage === 'closed') {
    return { severity: 'none', reason: 'none', queue: 'none', nextActionOwner: 'none' };
  }

  if (order.fulfillmentStatus === 'delivery_email_failed') {
    return { severity: 'blocked', reason: 'email_delivery_fail', queue: 'email_recovery', nextActionOwner: 'ops' };
  }

  if (order.fulfillmentStatus === 'failed_manual_review' || order.manualInterventionRequired || order.qaStatus === 'blocked') {
    return { severity: 'blocked', reason: order.qaBlockedReason || 'manual_review_required', queue: 'qa_review', nextActionOwner: 'qa' };
  }

  if (order.paymentStatus === 'paid' && !hasCustomerArtifact(order)) {
    const grace = options.paidNoArtifactGraceMinutes ?? DEFAULT_PAID_NO_ARTIFACT_GRACE_MINUTES;
    const age = minutesSince(order.updatedAt ?? order.createdAt, options.now ?? new Date());
    if (age === null || age >= grace) {
      return { severity: 'blocked', reason: 'paid_no_artifact', queue: 'fulfillment_recovery', nextActionOwner: 'ops' };
    }
    return { severity: 'warn', reason: 'paid_artifact_grace_window', queue: 'fulfillment_recovery', nextActionOwner: 'ops' };
  }

  if (order.paymentStatus === 'paid' && (order.proofApprovalToken || order.storyArtifactUrl) && !hasReleasedProofEmail(order)) {
    return { severity: 'warn', reason: 'proof_ready_not_sent', queue: 'qa_review', nextActionOwner: 'qa' };
  }

  return { severity: 'none', reason: 'none', queue: 'none', nextActionOwner: 'none' };
}
