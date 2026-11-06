import type { OrderRecord } from './orders.ts';
import { canonicalSourceHash } from './review-source-identity.ts';
import { hasMediaBackedCustomStorySource } from './story-generator.ts';
/** Conservative source projection: all unknown/new fields remain bound. Only
 * operational delivery state, modification timestamp and supplemental payment
 * reference are excluded. Format, shipping, all intake, payment status/revenue,
 * character identity/decision and release/print state remain bound. */
export function manualProofSourceHash(order: OrderRecord): string {
  const { workOutbox: _outbox, updatedAt: _updated, stripePaymentIntentId: _intent, ...source } = order;
  return canonicalSourceHash(source);
}
export function assertPreparationOrder(order: OrderRecord) {
  if (!order || typeof order.id !== 'string' || !/^ord_[a-zA-Z0-9_-]+$/.test(order.id)) throw new Error('invalid_order');
  if (order.paymentStatus !== 'paid' || order.fulfillmentMode !== 'manual_hold') throw new Error('paid_manual_hold_required');
  if (order.fulfillmentStatus && !['not_started', 'failed_manual_review', 'media_story_manual_review_required'].includes(String(order.fulfillmentStatus))) throw new Error('active_fulfillment_refused');
  if (order.characterReview && order.characterReview.status !== 'approved') throw new Error('character_approval_required');
  if (!hasMediaBackedCustomStorySource(order)) throw new Error('media_source_required');
  if (order.status !== 'order_received' || order.fulfillmentKickoffId || order.printJobId || order.printSubmissionAttemptedAt
    || order.printSubmittedAt || order.customerProofReleasedAt || order.proofApprovedAt || order.printApprovedAt
    || order.proofReleaseOverride || order.proofReviewedAt || order.proofReviewedVersion || order.printJobStatus || order.privateStoryArtifact || order.reviewStatus || order.refundedAt || order.refundClaimId || order.stripeRefundId || order.printInteriorArtifactUrl || order.printCoverArtifactUrl || order.storyArtifactUrl || order.proofVersion || order.proofApprovalToken || order.proofApprovalTokenHash
    || (order.pageArtifacts?.length ?? 0) > 0) throw new Error('initial_unreleased_order_required');
  if (!['digital', 'classic', 'premium'].includes(order.bookFormat)) throw new Error('invalid_book_format');
}
export function assertSnapshotCurrent(order: OrderRecord, expectedHash: string) {
  assertPreparationOrder(order);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || manualProofSourceHash(order) !== expectedHash) throw new Error('order_snapshot_changed');
}
