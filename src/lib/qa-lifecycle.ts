/**
 * Proof QA lifecycle (CD recommendations).
 *
 * Core invariants enforced here:
 *   - "Generation complete" ≠ "customer-visible / preview_ready". A proof is
 *     only customer-visible AFTER an explicit QA pass.
 *   - Customer emails (digital delivery, proof-ready) are REFUSED unless
 *     qaStatus === 'passed'.
 *   - The AI-assistance colophon line renders only when art is actually present
 *     AND QA has passed/reviewed.
 *
 * Pure: no I/O. The fulfillment / email / pdf layers call these gates.
 */
import type { OrderRecord } from './orders.ts';
import { scanProofArtifacts, type ProofArtifactScan, type QaFailReasonTag } from './qa-artifact-scanner.ts';

export type { QaFailReasonTag } from './qa-artifact-scanner.ts';

/** Operator-facing reason tags for QA Fail / Block. */
export const QA_FAIL_REASON_TAGS = Object.freeze([
  'missing_illustrations',
  'grammar',
  'repetition',
  'layout',
  'wrong_personalization',
  'inaccurate_colophon',
] as const);

export const QA_FAIL_REASON_LABELS: Record<QaFailReasonTag, string> = {
  missing_illustrations: 'Missing illustrations',
  grammar: 'Grammar',
  repetition: 'Repetition',
  layout: 'Layout',
  wrong_personalization: 'Wrong personalization',
  inaccurate_colophon: 'Inaccurate colophon',
};

export function isQaFailReasonTag(value: unknown): value is QaFailReasonTag {
  return typeof value === 'string' && (QA_FAIL_REASON_TAGS as readonly string[]).includes(value);
}

/** Internal-only proof QA states layered over the existing fulfillment model. */
export type InternalQaState =
  | 'generated'      // artifacts built, not yet in QA
  | 'in_qa'          // queued / awaiting human QA
  | 'qa_passed'      // operator passed QA — customer-visible allowed
  | 'qa_failed'      // operator failed/blocked QA with reasons
  | 'needs_rebuild'; // operator sent back for regeneration

/** Customer-facing copy shown while a proof is not yet QA-passed. */
export const CUSTOMER_BLOCKED_MESSAGE =
  "Your book is still being finished and quality-checked by our team. " +
  "We'll email you as soon as your proof is ready to review.";

/**
 * Map persisted order state to the internal QA lifecycle state. `generated`
 * artifacts sit in `in_qa` until an operator acts — they are never auto-visible.
 */
export function deriveInternalQaState(order: Pick<OrderRecord, 'qaStatus' | 'fulfillmentStatus'>): InternalQaState {
  if (order.qaStatus === 'passed') return 'qa_passed';
  if (order.qaStatus === 'blocked') return 'qa_failed';
  if (order.fulfillmentStatus === 'needs_rebuild') return 'needs_rebuild';
  const fs = order.fulfillmentStatus;
  if (fs === 'awaiting_qa' || fs === 'qa_blocked') return 'in_qa';
  if (fs === 'building_pdf' || fs === 'generating_images' || fs === 'generating_story') return 'generated';
  return 'in_qa';
}

/** A proof is customer-visible (preview_ready to the buyer) ONLY after QA pass. */
export function isCustomerVisible(order: Pick<OrderRecord, 'qaStatus'>): boolean {
  return order.qaStatus === 'passed';
}

/**
 * Email gate. No customer email (digital delivery, proof-ready) may be sent
 * unless QA has explicitly passed. Returns a refusal reason when blocked.
 */
export function canEmailCustomer(order: Pick<OrderRecord, 'qaStatus'>): { allowed: boolean; reason: string } {
  if (order.qaStatus === 'passed') return { allowed: true, reason: 'qa passed' };
  return { allowed: false, reason: `qaStatus=${order.qaStatus ?? 'pending'} — customer email refused until QA passes` };
}

/**
 * Colophon gate. The "Illustrations generated with AI assistance and reviewed
 * before printing" line may render ONLY when real art is present AND QA has
 * passed/reviewed. Pass a precomputed scan to avoid rescanning.
 */
export function canRenderColophon(
  order: Pick<OrderRecord, 'qaStatus' | 'pageArtifacts'>,
  scan?: ProofArtifactScan,
): boolean {
  const artScan = scan ?? scanProofArtifacts(order);
  const artPresent = artScan.ok && artScan.pagesWithImage > 0;
  return artPresent && order.qaStatus === 'passed';
}
