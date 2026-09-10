// Privacy-safe step telemetry for the five-step checkout.
//
// Three events make the funnel measurable before any mobile redesign:
//   checkout_step_view      a step became active (deduplicated per step per mount)
//   checkout_step_complete  the step's validation passed and the buyer advanced
//   checkout_step_blocked   client-side validation refused to advance or submit
//
// Every payload is built here so the allowed field set stays in one place:
// step_id, step_number, total_steps, selected_format, and (blocked only) a
// bounded reason code. Nothing typed by the buyer — names, email, appearance
// notes, memories, family details, photo identifiers, validation copy — is
// ever an input to these helpers' outputs. The analytics layer adds only its
// existing sanitized first-touch campaign fields and route template.
import type { CheckoutStepProgress } from './checkout-progressive.ts';

export const CHECKOUT_TELEMETRY_STEP_IDS = [
  'hero-details',
  'hero-appearance',
  'story',
  'people',
  'review',
] as const satisfies readonly CheckoutStepProgress['id'][];

export type CheckoutTelemetryStepId = (typeof CHECKOUT_TELEMETRY_STEP_IDS)[number];

export const CHECKOUT_TELEMETRY_TOTAL_STEPS = CHECKOUT_TELEMETRY_STEP_IDS.length;

/** Live format identifiers; anything else is reported as null, never echoed. */
const TELEMETRY_FORMAT_IDS = new Set(['digital', 'classic', 'premium']);

// A type alias (not an interface) so it is assignable to the analytics
// layer's `Record<string, …>` props parameter without an index signature.
export type CheckoutStepEventProps = {
  step_id: CheckoutTelemetryStepId;
  step_number: number;
  total_steps: number;
  selected_format: string | null;
};

export function checkoutStepEventProps(
  stepId: CheckoutTelemetryStepId,
  selectedFormat: string | null | undefined,
): CheckoutStepEventProps {
  return {
    step_id: stepId,
    step_number: CHECKOUT_TELEMETRY_STEP_IDS.indexOf(stepId) + 1,
    total_steps: CHECKOUT_TELEMETRY_TOTAL_STEPS,
    selected_format:
      typeof selectedFormat === 'string' && TELEMETRY_FORMAT_IDS.has(selectedFormat)
        ? selectedFormat
        : null,
  };
}

/**
 * One view per step per page flow. The checkout form keeps a single instance
 * for its mount lifetime, so re-renders, StrictMode effect replays, and
 * navigating back to an already-seen step do not re-emit.
 */
export function createCheckoutStepViewDeduper(): {
  shouldEmit: (stepId: CheckoutTelemetryStepId) => boolean;
} {
  const seen = new Set<CheckoutTelemetryStepId>();
  return {
    shouldEmit(stepId) {
      if (seen.has(stepId)) return false;
      seen.add(stepId);
      return true;
    },
  };
}

// ── Blocked reason codes ────────────────────────────────────────────────────
//
// Bounded, source-maintained. Codes are keyed on the step machine's own
// missing-field labels (src/lib/checkout-progressive.ts) so the label text —
// which is UI copy — is never sent. An unknown label degrades to `other`.

export const CHECKOUT_STEP_BLOCKED_REASONS = [
  'story_direction_required',
  'hero_name_required',
  'custom_story_source_required',
  'story_attachment_unsupported',
  'story_source_consent_required',
  'hero_appearance_required',
  'person_draft_open',
  'family_member_incomplete',
  'book_format_required',
  'email_required',
  'media_consent_required',
  'not_on_review_step',
  'other',
] as const;

export type CheckoutStepBlockedReason = (typeof CHECKOUT_STEP_BLOCKED_REASONS)[number];

const REASON_BY_MISSING_FIELD_LABEL: Record<string, CheckoutStepBlockedReason> = {
  'Story direction': 'story_direction_required',
  "Main hero's name": 'hero_name_required',
  'Custom Story source': 'custom_story_source_required',
  'Supported story attachment': 'story_attachment_unsupported',
  'Voice note consent': 'story_source_consent_required',
  'Document consent': 'story_source_consent_required',
  'Hero appearance details or photo': 'hero_appearance_required',
  'Open person draft': 'person_draft_open',
  'Incomplete family member details': 'family_member_incomplete',
  'Book format': 'book_format_required',
  'Email address': 'email_required',
};

// `status` is optional because the machine's `currentStep` summary omits it.
type BlockableStep = Pick<CheckoutStepProgress, 'id' | 'missingFields' | 'firstInvalidField'> &
  Partial<Pick<CheckoutStepProgress, 'status'>>;

/** Reason the step refuses to advance, or null when it is not blocked. */
export function checkoutStepBlockedReason(step: BlockableStep): CheckoutStepBlockedReason | null {
  const [firstMissing] = step.missingFields;
  if (firstMissing === undefined) {
    return step.status === 'needs_attention' ? 'other' : null;
  }
  return REASON_BY_MISSING_FIELD_LABEL[firstMissing] ?? 'other';
}

/** Reason the payment submit was refused client-side. */
export function checkoutSubmitBlockedReason(input: {
  currentStepId: string;
  blockingStep: BlockableStep;
  mediaConsentMissing: boolean;
}): CheckoutStepBlockedReason {
  if (input.currentStepId !== 'review') return 'not_on_review_step';
  const stepReason = checkoutStepBlockedReason(input.blockingStep);
  if (stepReason) return stepReason;
  if (input.mediaConsentMissing) return 'media_consent_required';
  return 'other';
}
