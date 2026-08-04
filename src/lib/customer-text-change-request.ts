/**
 * Editable-review workflow contract: capture a customer's text-change request
 * on a single page SEPARATELY from canonical book content.
 *
 * The narrowest local support for the tokenized customer review flow. It
 * deliberately does NOT reach into the proof-release / approval / fulfillment
 * machinery.
 *
 * Boundaries, enforced by pure construction here and exercised by
 * tests/customer-text-change-request.test.ts:
 *
 *   1. Canonical content is never mutated. `storyText`, `basePrompt`,
 *      `characterAnchor`, `acceptedImageUrl`, `currentImageUrl`, `accepted`,
 *      `versionHistory`, `feedbackHistory` and `regenerateCount` are copied
 *      through untouched. A request records review INTENT only.
 *   2. No approval. `customerReviewStatus` moves to 'changes_requested' — never
 *      'approved'. Whole-book approval stays exclusively in `approveWholeBook`.
 *   3. No side effects. Pure function: no image providers, no order-state
 *      writes, no email, no print. Persisting is the caller's job.
 */

import type { PageArtifact } from './orders.ts';

export interface RecordCustomerTextChangeInput {
  /** The customer's requested wording change. Trimmed; must be non-empty. */
  note: string;
  /** ISO timestamp for the request. */
  at: string;
}

/** Maximum stored note length. Longer input is rejected, never silently cut. */
export const MAX_TEXT_CHANGE_NOTE_CHARS = 2000;

/**
 * Return a copy of `page` carrying the customer's text-change request.
 *
 * Throws on an empty/whitespace-only or over-long note so the caller can answer
 * 400 rather than persisting a meaningless request.
 */
export function recordCustomerTextChangeRequest(
  page: PageArtifact,
  input: RecordCustomerTextChangeInput,
): PageArtifact {
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (!note) throw new Error('empty_or_invalid_note');
  if (note.length > MAX_TEXT_CHANGE_NOTE_CHARS) throw new Error('note_too_long');

  return {
    ...page,
    customerReviewStatus: 'changes_requested',
    customerRequestedChange: {
      note,
      requestedAt: input.at,
      // Enters the existing operator lifecycle at triage; only that
      // lifecycle may move it to 'resolved'.
      lifecycleStatus: 'triage',
    },
  };
}
