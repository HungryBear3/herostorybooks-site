/**
 * Editable-review workflow contract: capture a customer's text-change request on
 * a single page/spread SEPARATELY from canonical book content.
 *
 * This is the narrowest local support for the private editable review described
 * in the Peter/Benny (ord_217450cb153f4543) review package. It deliberately does
 * NOT reach into the existing proof-release / approval / fulfillment machinery.
 *
 * Boundaries (enforced by pure construction here, exercised by
 * tests/customer-text-change-request.test.ts):
 *
 *   1. Canonical content is never mutated. `storyText`, `basePrompt`,
 *      `characterAnchor`, `acceptedImageUrl`, `currentImageUrl`, `accepted`,
 *      `versionHistory`, `feedbackHistory` and `regenerateCount` are copied
 *      through untouched. A text-change request records review INTENT only.
 *   2. No approval. `customerReviewStatus` moves to 'changes_requested' — never
 *      'approved'. Whole-book approval stays exclusively in `approveWholeBook`
 *      (page-review.ts) behind its existing proof-token + ack gates, which this
 *      module never calls.
 *   3. No side effects. Pure function: no image providers, no order-state
 *      advance, no fulfillment, no email, no printer release, no token/URL
 *      creation, no I/O.
 *   4. Privacy. Only the customer's own note text is stored; callers must not
 *      pass photos, addresses, emails, tokens or raw order JSON into `note`.
 */
import type {
  CustomerRequestedChange,
  ChangeLifecycleStatus,
  PageArtifact,
} from './orders.ts';

/** Customer notes are capped to keep review artifacts small and bounded. */
export const CUSTOMER_CHANGE_NOTE_MAX_LEN = 1000;

export interface RecordCustomerTextChangeInput {
  /** The customer's requested wording change / comment for this page. */
  note: string;
  /** ISO timestamp the request was captured (caller-supplied for determinism). */
  at: string;
  /** Initial triage lane; defaults to 'triage'. Never an approval state. */
  lifecycleStatus?: ChangeLifecycleStatus;
}

function sanitizeNote(note: string): string {
  const trimmed = note.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    throw new Error('customer text-change note must be non-empty');
  }
  return trimmed.slice(0, CUSTOMER_CHANGE_NOTE_MAX_LEN);
}

/**
 * Pure transform: return a new PageArtifact carrying the customer's text-change
 * request. The input artifact is not mutated and no canonical field changes.
 */
export function recordCustomerTextChangeRequest(
  page: PageArtifact,
  input: RecordCustomerTextChangeInput,
): PageArtifact {
  const requested: CustomerRequestedChange = {
    requestedAt: input.at,
    note: sanitizeNote(input.note),
    lifecycleStatus: input.lifecycleStatus ?? 'triage',
    updatedAt: input.at,
  };

  return {
    ...page,
    // Review-intent fields only — everything else is copied through untouched.
    customerReviewStatus: 'changes_requested',
    customerRequestedChange: requested,
  };
}

/**
 * Pure transform: mark a previously captured request resolved (e.g. after an
 * operator has actioned it in a later, separately-authorized pass). Still no
 * approval and no canonical mutation.
 */
export function resolveCustomerTextChangeRequest(
  page: PageArtifact,
  at: string,
): PageArtifact {
  if (!page.customerRequestedChange) {
    return page;
  }
  return {
    ...page,
    customerReviewStatus: 'resolved',
    customerRequestedChange: {
      ...page.customerRequestedChange,
      lifecycleStatus: 'resolved',
      updatedAt: at,
    },
  };
}

/**
 * Explicit contract marker: recording/saving a text-change request is NEVER an
 * approval action. Approval lives only in approveWholeBook. Exposed so callers
 * and tests can assert the separation.
 */
export function isApprovalAction(): false {
  return false;
}

/** Canonical fields that a text-change request must never alter. Used by tests. */
export const CANONICAL_PAGE_FIELDS = [
  'pageIndex',
  'storyText',
  'basePrompt',
  'characterAnchor',
  'currentImageUrl',
  'acceptedImageUrl',
  'accepted',
  'regenerateCount',
  'versionHistory',
  'feedbackHistory',
] as const;
