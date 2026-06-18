import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { BlobNotFoundError, BlobPreconditionFailedError, del, get, head, list, put } from '@vercel/blob';

import type { FulfillmentStatus, OrderArtifactManifest, PageTextLayout, StorySource, VoiceTranscriptMeta } from './fulfillment-types.ts';
import type { GuidedReferencePhotoRecord } from './guided-photo-capture.ts';
import { ALLOWED_PHOTO_MIME_TYPES, getPhotoExtension, MAX_PHOTO_BYTES } from './photo-upload.ts';
import { sanitizeReferralCode } from './referral-code.ts';
export type { FulfillmentStatus, PageTextLayout, StorySource, VoiceTranscriptMeta };

export type OrderStatus = 'order_received' | 'preview_ready' | 'print_in_production' | 'shipped' | 'checkout_failed';
export type BookFormat = 'digital' | 'classic' | 'premium';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';
export type InternalOrderDisposition =
  | 'abandoned_internal_test'
  | 'superseded_internal_smoke';

export interface ShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface FamilyContributionInput {
  contributorName?: string | null;
  relationship?: string | null;
  dedication?: string | null;
  memory?: string | null;
  storyIdea?: string | null;
  supportingCharacterName?: string | null;
  supportingCharacterRelationship?: string | null;
  supportingCharacterNotes?: string | null;
  voiceFileName?: string | null;
  voiceBlobPath?: string | null;
  voiceBlobUrl?: string | null;
  voiceConsentAt?: string | null;
  photoFileName?: string | null;
  photoBlobPath?: string | null;
  photoBlobUrl?: string | null;
  photoConsentAt?: string | null;
}

export interface FamilyContribution {
  id: string;
  submittedAt: string;
  contributorName: string;
  relationship: string;
  dedication: string;
  memory: string;
  storyIdea: string;
  supportingCharacterName: string;
  supportingCharacterRelationship: string;
  supportingCharacterNotes: string;
  voiceFileName: string | null;
  voiceBlobPath: string | null;
  voiceBlobUrl: string | null;
  voiceConsentAt: string | null;
  photoFileName: string | null;
  photoBlobPath: string | null;
  photoBlobUrl: string | null;
  photoConsentAt: string | null;
}

export interface OrderInput {
  childName: string;
  childAge?: string;
  /** Optional customer-selected pronouns for prose generation. Legacy orders infer from notes. */
  childPronouns?: 'he/him' | 'she/her' | 'they/them' | string | null;
  theme?: string;
  lesson?: string;
  occasion?: string;
  giftMessage?: string;
  characterNotes?: string;
  familyCharacters?: FamilyCharacterInput[] | string | null;
  familyCharacterPhotoAssets?: SupportingCharacterPhotoAsset[] | null;
  appearanceOptions?: string;
  bookFormat: string;
  email: string;
  photoFileName?: string | null;
  photoBlobPath?: string | null;
  /**
   * Absolute, fetchable URL for the uploaded customer photo. Returned by
   * Vercel Blob's put() at upload time and persisted alongside photoBlobPath
   * so the FAL image-edit provider can use the photo as image_urls input
   * without needing to reconstruct a URL from HSB_PUBLIC_BLOB_BASE.
   *
   * Optional for backward compatibility with orders created before this
   * field was persisted — those still resolve via HSB_PUBLIC_BLOB_BASE.
   */
  photoBlobUrl?: string | null;
  // Optional child-voice-note beta (NEXT_PUBLIC_HSB_VOICE_BETA). The audio is
  // NOT used for voice cloning; it's stored as inspiration/source material for
  // later operator-reviewed story personalization.
  voiceFileName?: string | null;
  voiceBlobPath?: string | null;
  voiceBlobUrl?: string | null;
  voiceConsentAt?: string | null;
  voiceSource?: 'recorded' | 'uploaded' | null;
  /**
   * Transcription metadata for the optional consented voice note. Populated
   * during checkout only when HSB_VOICE_TRANSCRIPTION_ENABLED is on; null
   * otherwise. The audio is used for transcription + story inspiration ONLY,
   * never for voice cloning.
   */
  voiceTranscript?: VoiceTranscriptMeta | null;
  /**
   * Optional multi-angle guided reference photos (NEXT_PUBLIC_HSB_GUIDED_PHOTO_CAPTURE).
   * Still images only — never video. Persisted to durable storage BEFORE Stripe.
   * Used as additional illustrator reference material; not a face/biometric scan
   * and never used for voice/identity verification.
   */
  guidedReferencePhotos?: GuidedReferencePhotoRecord[] | null;
  referralCode?: string | null;
}

export type SupportingCharacterPhotoAsset = {
  characterId: string;
  assetId: string;
  filename?: string;
  contentType: string;
  sizeBytes: number;
  role?: string;
  name?: string;
  relationshipLabel?: string;
  consentConfirmed: boolean;
  referenceOnly: true;
  uploadedAt: string;
};

export type ReviewStatus =
  | 'not_started'
  | 'in_review'
  | 'customer_changes_requested'
  | 'approved';

export type CustomerPageReviewStatus =
  | 'pending'
  | 'approved'
  | 'changes_requested'
  | 'resolved';

export type ChangeLifecycleStatus =
  | 'triage'
  | 'illustrator'
  | 'qa'
  | 'ready_for_customer'
  | 'resolved';

export interface CustomerRequestedChange {
  requestedAt: string;
  note: string;
  lifecycleStatus: ChangeLifecycleStatus;
  updatedAt?: string | null;
}

export interface PageFeedbackEntry {
  createdAt: string;
  rawText: string;
  tags: string[];
  providerTried?: 'manual' | 'openai' | 'fal' | 'fal_edit' | 'gemini' | 'seedream' | 'seedream_edit' | null;
  resultImageUrl?: string | null;
  success: boolean;
}

export interface PageVersionEntry {
  createdAt: string;
  imageUrl: string | null;
  provider: 'manual' | 'openai' | 'fal' | 'fal_edit' | 'gemini' | 'seedream' | 'seedream_edit';
  model: string;
  promptUsed: string;
  /** Whether this version came from a text-only or photo-conditioned call.
   *  Optional for backward compatibility with versions written before the
   *  conditioning lane existed. */
  conditioning?: 'text_only' | 'photo_edit' | null;
  /** When conditioning='photo_edit', the customer photo URL passed to the
   *  provider. */
  referencePhotoUrl?: string | null;
}

export type ReviewAuditEventType =
  | 'route_decision_recorded'
  | 'proof_generated'
  | 'proof_rebuilt'
  | 'proof_release_blocked'
  | 'proof_release_override_recorded'
  | 'qa_pass_recorded'
  | 'proof_review_acknowledged'
  | 'page_regenerated'
  | 'page_accepted'
  | 'page_changes_requested'
  | 'whole_book_approved'
  | 'whole_book_approval_rejected'
  | 'refund_issued'
  | 'refund_refused'
  | 'internal_disposition_marked'
  // ── Manual Fulfillment Factory (additive) ─────────────────────────────────
  /** An operator registered an artifact (blob ref) into the order's manifest. */
  | 'manual_artifact_registered'
  /** An operator set/updated the manual QA report on the manifest. */
  | 'manual_qa_report_set'
  /** Manual order advanced to proof_ready_for_customer after the manifest gate
   *  (isManifestProofReady) passed. No customer email/release in this slice. */
  | 'manual_proof_ready_marked'
  /** Manual mark-proof-ready refused because the manifest gate failed. */
  | 'manual_proof_ready_blocked'
  // ── Generation Operating Policy (additive) ────────────────────────────────
  /** Recorded every time chooseGenerationRoute returns a decision for a paid
   *  order. Captures route + reason + authorizer/approver fields. */
  | 'route_decision_recorded'
  /** Recorded when a fallback (api or emergency) is attempted, regardless of
   *  whether the gate ultimately permitted it. */
  | 'route_fallback_attempted'
  /** Recorded when an emergency override (fal/Seedream on a paid order) is
   *  permitted; always accompanied by route_decision_recorded with the same
   *  route. */
  | 'emergency_override_recorded'
  /** Recorded when the QA gate evaluates a checklist + manifest decision —
   *  pass, fail, or blocked. */
  | 'qa_gate_evaluated'
  /** Recorded when releaseOrderAfterQa refuses to send the customer email
   *  because of a Generation Operating Policy guard failure. */
  | 'proof_release_failed'
  /** Recorded when the automated QA gate hard-fails closed before any proof is
   *  built — missing illustrations, or no usable image route (parked in
   *  awaiting_manual_art for the manual/subscription art workflow). */
  | 'qa_blocked'
  /** Recorded when print submission refuses to call submitPrintJob because
   *  the policy guard failed (missing customer approval, manifest invalid,
   *  lineage broken). */
  | 'print_submission_blocked'
  /** Recorded when `releaseOwnerPrintGoLock` clears a stuck owner-print-go
   *  intent lock. Meta captures the operator who released it, the prior
   *  fulfillment status, and the prior owner-go fields so the recovery
   *  has a permanent audit trail. Always emitted on success — never on
   *  refusal. */
  | 'owner_print_go_lock_released';

export interface ReviewAuditEvent {
  /** ISO timestamp the event was recorded. */
  at: string;
  type: ReviewAuditEventType;
  /** 0-indexed page (when applicable). */
  pageIndex?: number | null;
  /** Short stable reason code (e.g. 'pages_not_accepted', 'proof_ack_missing'). */
  reason?: string | null;
  /** Free-form, sanitized metadata. Keep small. */
  meta?: Record<string, string | number | boolean | null> | null;
}

export type GenerationRoute =
  | 'model_story'
  | 'api_disabled_template'
  | 'template_fallback'
  | 'manual_safe';

export interface GenerationRouteDecision {
  route: GenerationRoute;
  source: StorySource;
  model: string;
  decidedAt: string;
  /** False means the route is intentionally held for manual review. */
  releasable: boolean;
  fallbackError?: string | null;
  reason?: string | null;
}

export interface ProofReleaseOverride {
  /** ISO timestamp this override/spot-check was recorded. */
  recordedAt: string;
  /** Bounded internal operator identifier, not customer-facing. */
  recordedBy: string;
  /** Short reason explaining why automated checks were insufficient. */
  reason: string;
  /** Scope of the override. */
  scope:
    | 'story_source'
    | 'art_direction'
    | 'story_source_and_art_direction'
    | 'full_proof_release';
  /** Optional ISO expiry for temporary launch overrides. */
  expiresAt?: string | null;
}

export interface PageArtifact {
  pageIndex: number;
  storyText: string;
  basePrompt: string;
  /** Frozen story-level character description used as the first section of
   *  every page prompt (initial AND regenerate). This is the single anchor
   *  that keeps the same child visually consistent across all pages of one
   *  story. Set once at fulfillment time from StoryContent.characterDescription
   *  and never edited. Optional for backward compatibility with older orders. */
  characterAnchor?: string | null;
  currentImageUrl: string | null;
  acceptedImageUrl?: string | null;
  /** Generation Operating Policy: `'manual'` covers the Abby / OpenAI
   *  manual-subscription workflow that is the default paid route. Other
   *  values are recorded as observed; the release guard maps them to
   *  policy routes and refuses anything outside the allow-list. */
  generationProvider?: 'manual' | 'openai' | 'fal' | 'fal_edit' | 'gemini' | 'seedream' | 'seedream_edit' | null;
  generationModel?: string | null;
  /** Whether the CURRENT image on this page used text-only or photo-conditioned
   *  generation. Refreshed every regenerate. Null when no image yet. */
  generationConditioning?: 'text_only' | 'photo_edit' | null;
  regenerateCount: number;
  accepted: boolean;
  /** Customer-facing review state for this page/spread. Optional so older
   *  proof artifacts continue to load unchanged. */
  customerReviewStatus?: CustomerPageReviewStatus | null;
  /** Latest customer-requested change note. This records review intent only;
   *  it does not trigger image providers or fulfillment by itself. */
  customerRequestedChange?: CustomerRequestedChange | null;
  feedbackHistory: PageFeedbackEntry[];
  versionHistory: PageVersionEntry[];
  /** Optional picture-book text layout persisted on newer generated/rebuilt pages.
   *  Legacy orders may omit it, so scripts should provide a fallback when needed. */
  textLayout?: PageTextLayout | null;
  /** Internal-only flag set by an operator from the admin page-review grid
   *  to mark this page as needing a targeted regeneration in a later pass.
   *  Never surfaced to the customer. Optional for backward compatibility
   *  with orders created before the review grid existed. */
  targetedRegenNeeded?: boolean;
  /** Internal-only free-form note attached by an operator from the admin
   *  page-review grid. Capped at 500 characters by applyPageReviewPatch.
   *  Never surfaced to the customer. Optional for backward compatibility. */
  reviewerNotes?: string | null;
  /** ISO timestamp the operator last touched this page in the review
   *  grid. Helpful for spotting stale reviews. Optional. */
  reviewedAt?: string | null;
  // ── Generation Operating Policy per-page provenance (additive) ────────────
  /** Stable per-page identifier, defaults to `page_${pageIndex}`. Optional;
   *  derived at manifest build time when absent. */
  pageId?: string | null;
  /** Whether the current image came from a policy-fallback path. Distinct
   *  from `generationProvider` (which records which API was hit). Optional. */
  imageFallbackUsed?: boolean | null;
  /** Short, sanitized reason for the image fallback if one occurred. */
  imageFallbackReason?: string | null;
  /** Where the page asset originated. 'live' = real generation; 'fixture'/
   *  'sample'/'internal' = non-customer-facing content that MUST block
   *  proof release for paid/gifted/creator orders. Defaults to 'live' when
   *  absent (legacy orders predate this field). */
  assetSource?: 'live' | 'fixture' | 'sample' | 'internal' | string | null;
  /** Operator-set likeness rating or boolean flag — does the rendered child
   *  resemble the uploaded photo? Free-form for now; checklist items in the
   *  QA UI populate this. */
  likenessScoreOrFlag?: string | number | boolean | null;
}

export interface OrderRecord extends OrderInput {
  id: string;
  bookFormat: BookFormat;
  formatLabel: string;
  priceCents: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  stripeSessionId?: string | null;
  shippingAddress?: ShippingAddress | null;
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentAttempts?: number;
  fulfillmentLastError?: string | null;
  /** Manual Fulfillment Factory artifact ledger (blob-ref-only). Present only
   *  on orders managed through the manual admin path; absent on auto/legacy
   *  orders (which use storyArtifactUrl + generationRouteDecision). Its presence
   *  marks an order as manual-managed: the proof-release guard requires
   *  isManifestProofReady(this) before any customer-visible release. */
  artifactManifest?: OrderArtifactManifest | null;
  storyArtifactUrl?: string | null;
  /** How the story for this order was produced (template / openai_chat /
   *  template_after_openai_failure). Set once during fulfillment, never
   *  overwritten. Optional for backward compatibility with older orders. */
  storyMeta?: import('./fulfillment-types.ts').StoryMeta | null;
  /** Explicit G1 route/provenance decision recorded before proof artifacts can
   *  become customer-releasable. Required alongside a route_decision_recorded
   *  audit event for storyArtifactUrl/proofApprovalToken writes. */
  generationRouteDecision?: GenerationRouteDecision | null;
  /** Optional read-only art-direction packet persisted by the art-direction
   *  pipeline. Admin diagnostics may display bounded summaries from it, but
   *  fulfillment/proof state must not depend on this field until the gated
   *  state-machine work lands. */
  artDirectionPacket?: import('./art-direction-schemas.ts').ArtDirectionPacket | unknown | null;
  /** Optional persisted storyboard validation from the art-direction pipeline.
   *  Diagnostics recompute when absent so legacy orders remain readable. */
  artDirectionValidation?: import('./storyboard-validator.ts').StoryboardValidation | null;
  artDirectionGeneratedAt?: string | null;
  artDirectionHumanReviewStatus?: 'not_started' | 'needs_review' | 'approved' | 'rejected' | string | null;
  artDirectionHumanReviewNotes?: string | null;
  /** Internal-only proof release override. Honored only when accompanied by a
   * matching proof_release_override_recorded audit event. */
  proofReleaseOverride?: ProofReleaseOverride | null;
  printInteriorArtifactUrl?: string | null;
  printInteriorMd5?: string | null;
  printInteriorPageCount?: number | null;
  printCoverArtifactUrl?: string | null;
  printCoverMd5?: string | null;
  printTitle?: string | null;
  /** Positive internal human QA pass required before proof/digital delivery
   *  is sent to the customer. Set by a later admin-only QA route/UI. */
  qaPassAt?: string | null;
  /** Bounded internal operator identifier that recorded qaPassAt. */
  qaPassBy?: string | null;
  // ── Generation Operating Policy order-level fields (additive) ─────────────
  /** Three-valued QA state per policy §4. Mostly derived from qaPassAt /
   *  qaBlockedReason at read time; persisted only when an operator explicitly
   *  sets 'blocked' to surface a structural failure. */
  qaStatus?: 'pending' | 'passed' | 'blocked' | null;
  /** Bounded internal operator identifier that recorded qaStatus. Aliases
   *  qaPassBy when qaStatus='passed'. */
  qaReviewer?: string | null;
  /** When qaStatus='blocked', short sanitized reason for ops review. */
  qaBlockedReason?: string | null;
  /** ISO timestamp the customer-facing proof email was actually sent by
   *  releaseOrderAfterQa. Distinct from qaPassAt (the gate decision). */
  customerProofReleasedAt?: string | null;
  /** ISO timestamp customer approval was recorded; aliases proofApprovedAt
   *  for the print guard. Customer-approval timestamp is NOT sufficient on
   *  its own to authorize print submission — see ownerPrintGoAt. */
  printApprovedAt?: string | null;
  /** ISO timestamp print submission to Lulu succeeded. */
  printSubmittedAt?: string | null;
  /** ISO timestamp an operator/owner gave explicit print go/no-go go.
   *  Required by the print guard: customer approval alone MUST NOT cause
   *  submitPrint to be invoked. Per Rex G3 audit: "approved-without-
   *  owner-go is blocked." */
  ownerPrintGoAt?: string | null;
  /** Bounded operator identifier that recorded ownerPrintGoAt. */
  ownerPrintGoBy?: string | null;
  /** Per-attempt random nonce written at owner-go acquisition. Used as a
   *  CAS-via-readback signal: after writing the lock, the acquirer
   *  re-reads the record; only the request whose token survives the
   *  read holds the lock and is permitted to call submitPrint. This
   *  protects against two concurrent admin POSTs both reading pre-go
   *  state, both writing, and both proceeding to Lulu/RPI. */
  ownerPrintGoLockToken?: string | null;
  /** True when ops decided an order needs manual intervention before
   *  release. Set by operators; never auto-cleared. */
  manualInterventionRequired?: boolean | null;
  /** True when ops invoked the emergency fal/Seedream route. */
  emergencyOverrideUsed?: boolean | null;
  /** Bounded identifier of the person who approved the emergency override
   *  (per policy §2: must accompany any fal/Seedream paid-order route). */
  emergencyApprovedBy?: string | null;
  /** Short reference (ticket id / Slack permalink / RFC#) describing why
   *  the emergency override was authorized. */
  emergencyApprovalRef?: string | null;
  /** Bounded identifier of the person who authorized OPENAI_API fallback
   *  for this order (per policy §2: API fallback requires explicit
   *  authorization beyond the global apiFallbackEnabled flag). */
  apiAuthorizedBy?: string | null;
  /** ISO timestamp the API-fallback authorization was recorded. Release
   *  guard requires this when a page or story was produced via
   *  OPENAI_API. */
  apiAuthorizedAt?: string | null;
  /** Set to true at intake when a customer photo upload was persisted. */
  sourcePhotoPresent?: boolean | null;
  /** Set to true when personalization inputs (childName + theme/lesson/
   *  voice transcript) are present and sufficient. */
  personalizationInputsPresent?: boolean | null;
  /** Result of validateManifest at last release attempt — true iff every
   *  required field was present. */
  manifestComplete?: boolean | null;
  /** Optional deterministic hash of the canonical manifest fields. Computed
   *  at release time when feasible; left null otherwise (documented TODO). */
  manifestHash?: string | null;
  proofApprovalToken?: string | null;
  proofApprovedAt?: string | null;
  /** ISO timestamp the customer ticked the "I reviewed the full proof PDF"
   *  acknowledgment on /review. Required server-side before approveWholeBook. */
  proofReviewedAt?: string | null;
  printJobId?: string | null;
  printJobStatus?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippedAt?: string | null;
  deliveryExpectation: string;
  /** Per-page review state. Optional for backward compatibility with old orders. */
  reviewStatus?: ReviewStatus;
  /** Internal-only archival/disposition marker for stale smoke/test orders.
   *  This is deliberately separate from customer-facing order/payment state. */
  internalDisposition?: InternalOrderDisposition | null;
  internalDispositionNote?: string | null;
  internalDispositionAt?: string | null;
  pageArtifacts?: PageArtifact[];
  /** Influencer / partner attribution captured from ?ref= or hsb_ref cookie. */
  referralCode?: string | null;
  /** Bearer-style private link token for family memory/photo/story contributors. */
  familyContributionToken?: string | null;
  /** Append-only family-provided inspiration for the order. Never public by default. */
  familyContributions?: FamilyContribution[];
  /** Append-only audit log of review/approval events. Optional on legacy orders. */
  auditEvents?: ReviewAuditEvent[];
  /** Pre-print refund state. Set when admin issues a Stripe refund for an
   *  order that has not yet printed/shipped. Once set, no print operation
   *  may run on this order. */
  refundedAt?: string | null;
  refundReason?: string | null;
  /** Stripe refund id (re_...) when the refund was actually executed
   *  through the processor. Null on legacy orders or refunds that fell
   *  back to manual processing. */
  stripeRefundId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FamilyCharacterRole =
  | 'dad'
  | 'mom'
  | 'parent'
  | 'sibling'
  | 'grandparent'
  | 'pet'
  | 'whole-family'
  | 'other';

export interface FamilyCharacterInput {
  role?: FamilyCharacterRole | string | null;
  name?: string | null;
  relationshipLabel?: string | null;
  pronouns?: string | null;
  notes?: string | null;
  isGiftRecipient?: boolean | null;
  appearsInStory?: boolean | null;
  photoFileName?: string | null;
  photoBlobPath?: string | null;
  photoBlobUrl?: string | null;
  referencePhotos?: FamilyCharacterReferencePhoto[] | null;
}

export interface FamilyCharacterReferencePhoto {
  assetId?: string | null;
  label?: string | null;
  fileName: string | null;
  photoBlobPath: string | null;
  photoBlobUrl: string | null;
  source: 'upload' | 'guided_capture';
  consentAt: string;
}

export interface FamilyCharacter {
  role: FamilyCharacterRole;
  name: string;
  relationshipLabel: string;
  pronouns: string;
  notes: string;
  isGiftRecipient: boolean;
  appearsInStory: boolean;
  photoFileName: string | null;
  photoBlobPath: string | null;
  photoBlobUrl: string | null;
  referencePhotos?: FamilyCharacterReferencePhoto[] | null;
}

export function isPrintFormat(bookFormat: string): boolean {
  return bookFormat === 'classic' || bookFormat === 'premium';
}

/**
 * Single source of truth for the number of REAL illustrated story pages
 * a given book format gets (Plan slice 1 — print redesign).
 *
 * Distinct from `getMinimumTotalPages` in pdf-builder.ts: that one is
 * the Lulu-required interior minimum (story + filler + cover/back).
 * This helper is the *story-content* length the story generator and any
 * downstream renderer should target. Filler/keepsake logic is unaffected
 * for now — later slices will retire it.
 *
 *   digital  -> 24
 *   classic  -> 24
 *   premium  -> 32
 */
export function getStoryPageCount(bookFormat: string): number {
  if (bookFormat === 'digital') return 24;
  if (bookFormat === 'classic') return 24;
  if (bookFormat === 'premium') return 32;
  return 6;
}

const FAMILY_CHARACTER_MAX_COUNT = 4;
export const SUPPORTING_CHARACTER_PHOTO_LIMIT = 4;
const FAMILY_CHARACTER_MAX_FIELD = 80;
const FAMILY_CHARACTER_MAX_NOTES = 180;
const FAMILY_CHARACTER_ROLES = new Set<FamilyCharacterRole>([
  'dad',
  'mom',
  'parent',
  'sibling',
  'grandparent',
  'pet',
  'whole-family',
  'other',
]);

function cleanShortText(value: unknown, max = FAMILY_CHARACTER_MAX_FIELD): string {
  return String(value ?? '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function isMultiFamilyPhotoIntakeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NEXT_PUBLIC_HSB_MULTI_FAMILY_PHOTO_INTAKE === 'true';
}

function cleanOptionalShortText(value: unknown, max = FAMILY_CHARACTER_MAX_FIELD): string | undefined {
  const cleaned = cleanShortText(value, max);
  return cleaned || undefined;
}

export type FamilyCharacterPhotoValidationInput = {
  characterId: string;
  characterIndex: number;
  file: { name?: string; type?: string; size: number };
  consentConfirmed: boolean;
};

export type FamilyCharacterPhotoValidationResult =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

export function validateFamilyCharacterPhotoUploads(
  characters: readonly { id?: string | null }[],
  uploads: readonly FamilyCharacterPhotoValidationInput[],
): FamilyCharacterPhotoValidationResult {
  if (uploads.length === 0) return { ok: true };
  if (uploads.length > SUPPORTING_CHARACTER_PHOTO_LIMIT) {
    return {
      ok: false,
      status: 400,
      code: 'supporting_photo_limit_exceeded',
      error: `Please attach no more than ${SUPPORTING_CHARACTER_PHOTO_LIMIT} family or pet reference photos.`,
    };
  }

  const characterIds = new Set(
    characters.map((character, index) => cleanShortText(character.id || `family-character-${index + 1}`, 120)),
  );
  const seen = new Set<string>();
  for (const upload of uploads) {
    const characterId = cleanShortText(upload.characterId, 120);
    if (!characterId || !characterIds.has(characterId)) {
      return {
        ok: false,
        status: 400,
        code: 'supporting_photo_unknown_character',
        error: 'That family or pet reference photo does not match a supporting character. Please remove it and try again.',
      };
    }
    if (seen.has(characterId)) {
      return {
        ok: false,
        status: 400,
        code: 'supporting_photo_duplicate_character',
        error: 'Please attach only one reference photo per family member or pet for now.',
      };
    }
    seen.add(characterId);
    if (!upload.consentConfirmed) {
      return {
        ok: false,
        status: 400,
        code: 'supporting_photo_consent_required',
        error: 'Please confirm you have permission to share each family or pet reference photo for private book prep.',
      };
    }
    const type = cleanShortText(upload.file.type, 80).toLowerCase();
    const extension = getPhotoExtension(upload.file.name || '');
    const acceptedExtension = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(extension);
    if (!ALLOWED_PHOTO_MIME_TYPES.has(type) && !acceptedExtension) {
      return {
        ok: false,
        status: 400,
        code: 'supporting_photo_invalid_type',
        error: 'Family or pet reference photos must be JPG, PNG, WebP, HEIC, or HEIF images.',
      };
    }
    if (upload.file.size > MAX_PHOTO_BYTES) {
      return {
        ok: false,
        status: 400,
        code: 'supporting_photo_too_large',
        error: 'Family or pet reference photos must be 4 MB or smaller.',
      };
    }
  }
  return { ok: true };
}

export function buildSupportingCharacterPhotoAsset(input: {
  characterId: string;
  assetId: string;
  file: { name?: string; type?: string; size: number };
  role?: string | null;
  name?: string | null;
  relationshipLabel?: string | null;
  uploadedAt?: string;
}): SupportingCharacterPhotoAsset {
  return {
    characterId: cleanShortText(input.characterId, 120),
    assetId: cleanShortText(input.assetId, 500),
    filename: cleanOptionalShortText(input.file.name, 120),
    contentType: cleanShortText(input.file.type, 80).toLowerCase() || 'application/octet-stream',
    sizeBytes: Math.max(0, Math.floor(input.file.size)),
    role: cleanOptionalShortText(input.role, 40),
    name: cleanOptionalShortText(input.name, 80),
    relationshipLabel: cleanOptionalShortText(input.relationshipLabel, 80),
    consentConfirmed: true,
    referenceOnly: true,
    uploadedAt: input.uploadedAt || new Date().toISOString(),
  };
}

export function sanitizeSupportingCharacterPhotoAssets(
  input: OrderInput['familyCharacterPhotoAssets'],
): SupportingCharacterPhotoAsset[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, SUPPORTING_CHARACTER_PHOTO_LIMIT)
    .map((asset) => ({
      characterId: cleanShortText(asset?.characterId, 120),
      assetId: cleanShortText(asset?.assetId, 500),
      filename: cleanOptionalShortText(asset?.filename, 120),
      contentType: cleanShortText(asset?.contentType, 80).toLowerCase() || 'application/octet-stream',
      sizeBytes: Math.max(0, Math.floor(Number(asset?.sizeBytes) || 0)),
      role: cleanOptionalShortText(asset?.role, 40),
      name: cleanOptionalShortText(asset?.name, 80),
      relationshipLabel: cleanOptionalShortText(asset?.relationshipLabel, 80),
      consentConfirmed: asset?.consentConfirmed === true,
      referenceOnly: true as const,
      uploadedAt: cleanShortText(asset?.uploadedAt, 40),
    }))
    .filter((asset) => asset.characterId && asset.assetId && asset.consentConfirmed);
}

function normalizeFamilyRole(role: unknown): FamilyCharacterRole {
  const value = cleanShortText(role).toLowerCase();
  return FAMILY_CHARACTER_ROLES.has(value as FamilyCharacterRole)
    ? (value as FamilyCharacterRole)
    : 'other';
}

function parseFamilyCharacters(input: OrderInput['familyCharacters']): FamilyCharacterInput[] {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input !== 'string') return [];
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function sanitizeFamilyCharacters(input: OrderInput['familyCharacters']): FamilyCharacter[] {
  return parseFamilyCharacters(input)
    .slice(0, FAMILY_CHARACTER_MAX_COUNT)
    .map((character) => {
      const role = normalizeFamilyRole(character?.role);
      const name = cleanShortText(character?.name);
      const relationshipLabel =
        cleanShortText(character?.relationshipLabel) ||
        (role === 'whole-family' ? 'whole family' : role);
      const notes = cleanShortText(character?.notes, FAMILY_CHARACTER_MAX_NOTES);
      const pronouns = cleanShortText(character?.pronouns, 32);
      const referencePhotos = Array.isArray(character?.referencePhotos)
        ? character.referencePhotos.slice(0, 4).map((ref) => ({
            assetId: cleanShortText(ref?.assetId, 80) || null,
            label: cleanShortText(ref?.label, 80) || null,
            fileName: cleanShortText(ref?.fileName, 120) || null,
            photoBlobPath: cleanShortText(ref?.photoBlobPath, 500) || null,
            photoBlobUrl: cleanShortText(ref?.photoBlobUrl, 500) || null,
            source: ref?.source === 'guided_capture' ? 'guided_capture' as const : 'upload' as const,
            consentAt: cleanShortText(ref?.consentAt, 80) || new Date().toISOString(),
          })).filter((ref) => Boolean(ref.photoBlobPath || ref.photoBlobUrl))
        : [];
      return {
        role,
        name,
        relationshipLabel,
        pronouns,
        notes,
        isGiftRecipient: Boolean(character?.isGiftRecipient),
        appearsInStory: character?.appearsInStory === false ? false : true,
        photoFileName: cleanShortText(character?.photoFileName, 120) || null,
        photoBlobPath: cleanShortText(character?.photoBlobPath, 500) || null,
        photoBlobUrl: cleanShortText(character?.photoBlobUrl, 500) || null,
        referencePhotos: referencePhotos.length > 0 ? referencePhotos : null,
      };
    })
    .filter((character) =>
      Boolean(character.name || character.relationshipLabel || character.notes),
    );
}

export const PAGE_REVIEW_NOTES_MAX_LENGTH = 500;

export interface PageReviewPatch {
  targetedRegenNeeded?: boolean;
  reviewerNotes?: string | null;
}

export type ApplyPageReviewPatchResult =
  | { ok: true; order: OrderRecord; page: PageArtifact }
  | { ok: false; status: number; error: string };

/**
 * Pure: apply an internal-only review patch (targetedRegenNeeded /
 * reviewerNotes) to a single page on an OrderRecord and return a NEW
 * OrderRecord with the updated page. Bumps `updatedAt` on the order
 * and `reviewedAt` on the page whenever any field actually changes.
 *
 * Caller is responsible for persistence. Pure so it's trivially
 * testable without I/O.
 */
export function applyPageReviewPatch(
  order: OrderRecord,
  pageIndex: number,
  patch: PageReviewPatch,
  now: string,
): ApplyPageReviewPatchResult {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    return { ok: false, status: 400, error: 'pageIndex must be a non-negative integer' };
  }
  const artifacts = order.pageArtifacts ?? [];
  const idx = artifacts.findIndex((p) => p.pageIndex === pageIndex);
  if (idx === -1) {
    return { ok: false, status: 404, error: `no page artifact at index ${pageIndex}` };
  }

  const current = artifacts[idx];
  const next: PageArtifact = { ...current };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(patch, 'targetedRegenNeeded')) {
    const flag = Boolean(patch.targetedRegenNeeded);
    if (Boolean(current.targetedRegenNeeded) !== flag) {
      next.targetedRegenNeeded = flag;
      changed = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'reviewerNotes')) {
    const raw = patch.reviewerNotes;
    const normalized =
      raw === null || raw === undefined
        ? null
        : String(raw).trim().slice(0, PAGE_REVIEW_NOTES_MAX_LENGTH);
    const currentValue = current.reviewerNotes ?? null;
    const nextValue = normalized && normalized.length > 0 ? normalized : null;
    if (currentValue !== nextValue) {
      next.reviewerNotes = nextValue;
      changed = true;
    }
  }

  if (!changed) {
    return { ok: true, order, page: current };
  }

  next.reviewedAt = now;
  const nextArtifacts = [...artifacts];
  nextArtifacts[idx] = next;
  const nextOrder: OrderRecord = {
    ...order,
    pageArtifacts: nextArtifacts,
    updatedAt: now,
  };
  return { ok: true, order: nextOrder, page: next };
}

interface CreateOrderOptions {
  now?: string;
  id?: string;
}

const FORMAT_META: Record<BookFormat, { label: string; priceCents: number }> = {
  digital: { label: 'Digital PDF', priceCents: 1499 },
  classic: { label: 'Classic softcover', priceCents: 4499 },
  premium: { label: 'Premium hardcover', priceCents: 6499 },
};

/**
 * Vercel Blob access mode for order JSON + photo writes/reads.
 *
 * Defaults to `'public'` because that's how the production store is provisioned
 * (the prod token rejects `private` writes with `BlobError: Cannot use private
 * access on a public store`). Override with `HSB_BLOB_ACCESS_MODE=private`
 * once a private store is provisioned.
 *
 * Privacy note: when access is `public`, the blob URLs are unguessable
 * (orderId is a 16-char random hex; photo path is `orders/<id>/photo-...`)
 * but not authenticated. Treat URLs as bearer credentials — log them only
 * where appropriate. Do not embed them in public surfaces.
 */
export type BlobAccessMode = 'public' | 'private';
export function getBlobAccessMode(): BlobAccessMode {
  const env = process.env.HSB_BLOB_ACCESS_MODE;
  if (env === 'private') return 'private';
  if (env === 'public') return 'public';
  return 'public';
}

/**
 * Sanitize a Blob-related error message before persisting/logging it.
 *
 * Belt-and-suspenders against accidentally surfacing a token value in an
 * error string. `@vercel/blob` does not normally echo the token, but the
 * underlying `fetch` Response.statusText is operator-visible and we
 * persist parts of error messages into order records via
 * fulfillmentLastError. Strip anything that looks like a token before it
 * leaves this module.
 */
function sanitizeBlobErrorMessage(message: string): string {
  return message
    .replace(/(vercel_blob_rw|rw_)[A-Za-z0-9_-]{8,}/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key)=)[^\s&]+/gi, '$1[redacted]')
    .slice(0, 500);
}

/**
 * Read the text body of a single Blob.
 *
 * Strategy when `getBlobAccessMode() === 'public'`:
 *   1. If a public URL is available, try the unauthenticated `fetch` first
 *      (no SDK overhead, no list call).
 *   2. If that returns 404, the blob is genuinely absent — return null.
 *   3. If it returns ANY other non-OK status (notably 403, which the
 *      2026-05-15 Rex proof rerun hit mid-fulfillment) AND we have a
 *      blob token, fall back to the authenticated SDK `get()`. Vercel
 *      Blob's public-read can throttle / cache-miss / 403 transiently,
 *      and order-JSON reads must not fail in that window when we have
 *      a token that authoritatively can read the object.
 *   4. If `get()` itself fails or there is no token to retry with,
 *      surface a sanitized error so callers can decide (production
 *      callers re-throw; dev callers may fall back to filesystem).
 *
 * Private-access mode goes straight to the SDK `get()` as before.
 *
 * This function never logs the token.
 */
export async function readBlobText(input: {
  pathname: string;
  url?: string | null;
  token: string;
}): Promise<string | null> {
  const access = getBlobAccessMode();

  if (access === 'public') {
    const url = input.url;
    let publicFetchError: { status: number; statusText: string } | null = null;
    if (url) {
      const bust = `ts=${Date.now()}`;
      const separator = url.includes('?') ? '&' : '?';
      const response = await fetch(`${url}${separator}${bust}`, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (response.ok) {
        return await response.text();
      }
      publicFetchError = { status: response.status, statusText: response.statusText };
    }

    // Authenticated fallback: the public URL is unavailable, throttled, or
    // permission-denied. Use the SDK with the token. This is the path the
    // Rex 2026-05-15 rerun needed — the public blob returned 403 mid-run
    // even though the token-authenticated read would have worked.
    if (input.token) {
      try {
        const result = await get(input.pathname, {
          access: 'public',
          token: input.token,
          useCache: false,
        });
        if (!result || !result.stream) {
          // SDK returned no object — treat as 404 absence.
          return null;
        }
        return await new Response(result.stream).text();
      } catch (err) {
        const sdkMsg = err instanceof Error ? err.message : String(err);
        const sanitized = sanitizeBlobErrorMessage(sdkMsg);
        if (publicFetchError) {
          throw new Error(
            `Blob read failed: public fetch ${publicFetchError.status} ${publicFetchError.statusText.trim()}, authenticated fallback also failed: ${sanitized}`.trim(),
          );
        }
        throw new Error(`Authenticated blob fetch failed: ${sanitized}`.trim());
      }
    }

    // No token to retry with — surface the original public-fetch error.
    if (publicFetchError) {
      throw new Error(
        `Public blob fetch failed: ${publicFetchError.status} ${publicFetchError.statusText}`.trim(),
      );
    }
    return null;
  }

  // Private-access path: always SDK with token.
  try {
    const result = await get(input.pathname, {
      access,
      token: input.token,
      useCache: false,
    });
    if (!result || !result.stream) {
      return null;
    }
    return await new Response(result.stream).text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Private blob fetch failed: ${sanitizeBlobErrorMessage(msg)}`.trim());
  }
}

function normalizeFormat(bookFormat: string): BookFormat {
  if (bookFormat === 'digital' || bookFormat === 'classic' || bookFormat === 'premium') {
    return bookFormat;
  }

  return 'classic';
}

export function buildDeliveryExpectation(bookFormat: string): string {
  const format = normalizeFormat(bookFormat);

  if (format === 'digital') {
    return 'Digital proof usually ready within 2 business days; final PDF delivered after approval.';
  }

  if (format === 'premium') {
    return 'Hardcover ships 5–7 business days after proof approval — free shipping included. Digital preview arrives first so you can approve before it prints.';
  }

  return 'Softcover ships 5–7 business days after proof approval — free shipping included. Digital preview arrives first so you can approve before it prints.';
}

const FAMILY_CONTRIBUTION_TOKEN_BYTES = 16;
const FAMILY_CONTRIBUTION_SHORT_MAX = 120;
const FAMILY_CONTRIBUTION_LONG_MAX = 800;

export function createFamilyContributionToken(): string {
  return crypto.randomBytes(FAMILY_CONTRIBUTION_TOKEN_BYTES).toString('hex');
}

export function buildFamilyContributionUrl(baseUrl: string, token: string | null | undefined): string | null {
  const cleanToken = cleanShortText(token, 80);
  if (!cleanToken) return null;
  const url = new URL(`/family-contribute/${encodeURIComponent(cleanToken)}`, baseUrl);
  return url.toString();
}

export function sanitizeFamilyContributionInput(
  input: FamilyContributionInput,
  submittedAt = new Date().toISOString(),
): FamilyContribution {
  return {
    id: `fam_${crypto.createHash('sha256').update(`${submittedAt}:${JSON.stringify(input)}`).digest('hex').slice(0, 16)}`,
    submittedAt,
    contributorName: cleanShortText(input.contributorName, FAMILY_CONTRIBUTION_SHORT_MAX),
    relationship: cleanShortText(input.relationship, FAMILY_CONTRIBUTION_SHORT_MAX),
    dedication: cleanShortText(input.dedication, FAMILY_CONTRIBUTION_LONG_MAX),
    memory: cleanShortText(input.memory, FAMILY_CONTRIBUTION_LONG_MAX),
    storyIdea: cleanShortText(input.storyIdea, FAMILY_CONTRIBUTION_LONG_MAX),
    supportingCharacterName: cleanShortText(input.supportingCharacterName, FAMILY_CONTRIBUTION_SHORT_MAX),
    supportingCharacterRelationship: cleanShortText(input.supportingCharacterRelationship, FAMILY_CONTRIBUTION_SHORT_MAX),
    supportingCharacterNotes: cleanShortText(input.supportingCharacterNotes, FAMILY_CONTRIBUTION_LONG_MAX),
    voiceFileName: cleanShortText(input.voiceFileName, 160) || null,
    voiceBlobPath: cleanShortText(input.voiceBlobPath, 500) || null,
    voiceBlobUrl: cleanShortText(input.voiceBlobUrl, 500) || null,
    voiceConsentAt: cleanShortText(input.voiceConsentAt, 80) || null,
    photoFileName: cleanShortText(input.photoFileName, 160) || null,
    photoBlobPath: cleanShortText(input.photoBlobPath, 500) || null,
    photoBlobUrl: cleanShortText(input.photoBlobUrl, 500) || null,
    photoConsentAt: cleanShortText(input.photoConsentAt, 80) || null,
  };
}

export function appendFamilyContribution(
  order: OrderRecord,
  contribution: FamilyContribution,
): OrderRecord {
  return {
    ...order,
    familyContributions: [...(order.familyContributions ?? []), contribution],
    updatedAt: contribution.submittedAt,
  };
}

export function createOrderRecord(input: OrderInput, options: CreateOrderOptions = {}): OrderRecord {
  const format = normalizeFormat(input.bookFormat);
  const meta = FORMAT_META[format];
  const now = options.now ?? new Date().toISOString();

  return {
    id: options.id ?? `ord_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    childName: input.childName.trim(),
    childAge: input.childAge?.trim() || '',
    childPronouns: input.childPronouns?.trim() === 'he/him' || input.childPronouns?.trim() === 'she/her' || input.childPronouns?.trim() === 'they/them'
      ? input.childPronouns.trim() as 'he/him' | 'she/her' | 'they/them'
      : '',
    theme: input.theme?.trim() || '',
    lesson: input.lesson?.trim() || '',
    occasion: input.occasion?.trim() || '',
    giftMessage: input.giftMessage?.trim() || '',
    characterNotes: input.characterNotes?.trim() || '',
    familyCharacters: sanitizeFamilyCharacters(input.familyCharacters),
    familyCharacterPhotoAssets: sanitizeSupportingCharacterPhotoAssets(input.familyCharacterPhotoAssets),
    appearanceOptions: input.appearanceOptions?.trim() || '',
    bookFormat: format,
    formatLabel: meta.label,
    priceCents: meta.priceCents,
    email: input.email.trim().toLowerCase(),
    photoFileName: input.photoFileName?.trim() || null,
    photoBlobPath: input.photoBlobPath?.trim() || null,
    photoBlobUrl: input.photoBlobUrl?.trim() || null,
    voiceFileName: input.voiceFileName?.trim() || null,
    voiceBlobPath: input.voiceBlobPath?.trim() || null,
    voiceBlobUrl: input.voiceBlobUrl?.trim() || null,
    voiceConsentAt: input.voiceConsentAt?.trim() || null,
    voiceSource:
      input.voiceSource === 'recorded' || input.voiceSource === 'uploaded'
        ? input.voiceSource
        : null,
    // Transcription is produced after createOrderRecord (post voice-upload),
    // so this is normally null here and set later in the persist call. We
    // still pass it through when supplied so the field round-trips cleanly.
    voiceTranscript: input.voiceTranscript ?? null,
    guidedReferencePhotos:
      Array.isArray(input.guidedReferencePhotos) && input.guidedReferencePhotos.length > 0
        ? input.guidedReferencePhotos
        : null,
    referralCode: sanitizeReferralCode(input.referralCode),
    familyContributionToken: createFamilyContributionToken(),
    familyContributions: [],
    status: 'order_received',
    paymentStatus: 'pending',
    stripeSessionId: null,
    shippingAddress: null,
    deliveryExpectation: buildDeliveryExpectation(format),
    createdAt: now,
    updatedAt: now,
  };
}

function getBlobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN;
}

// ── Blob namespace isolation ─────────────────────────────────────────────────
//
// Without a namespace, every environment that shares BLOB_READ_WRITE_TOKEN
// (Production / Preview / Development) writes to the same flat `orders/...`
// keyspace and can read/mutate each other's records. To prevent Preview from
// touching real customer order data, we prepend an environment-derived prefix
// to every blob path used by this app.
//
// Required configuration:
//   - Production: HSB_BLOB_NAMESPACE unset (or empty) → flat paths (legacy
//     compatibility with already-stored orders).
//   - Preview:    HSB_BLOB_NAMESPACE must be set to a non-empty, non-"production"
//                 value (recommended: "preview"). Failing to set it on a Vercel
//                 Preview deployment is a hard error — we fail closed rather
//                 than silently target the production namespace.
//   - Development: HSB_BLOB_NAMESPACE optional; defaults to "development".
//
// Recommended belt+suspenders in Vercel:
//   1. Provision a separate Vercel Blob store for Preview/Development with its
//      own BLOB_READ_WRITE_TOKEN, and scope that token only to Preview +
//      Development.
//   2. ALSO set HSB_BLOB_NAMESPACE=preview on Preview (and "development" on
//      Development). The two together mean a token leak alone can't expose
//      production data, and a namespace misconfiguration alone can't either.
export class BlobNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobNamespaceError';
  }
}

export function getBlobNamespace(): string {
  const explicit = (process.env.HSB_BLOB_NAMESPACE ?? '').trim();
  // Vercel automatically sets VERCEL_ENV to one of 'production' | 'preview' |
  // 'development' on every deployment.
  const vercelEnv = process.env.VERCEL_ENV;

  if (vercelEnv === 'preview') {
    if (!explicit) {
      throw new BlobNamespaceError(
        "HSB_BLOB_NAMESPACE must be set on Vercel Preview deployments " +
          "to prevent reading/writing the production order namespace. " +
          "Set HSB_BLOB_NAMESPACE='preview' (or any non-empty value other " +
          "than 'production') on the Preview environment.",
      );
    }
    if (explicit === 'production') {
      throw new BlobNamespaceError(
        "HSB_BLOB_NAMESPACE='production' is forbidden on Vercel Preview — " +
          "it would target the production namespace. Use 'preview' instead.",
      );
    }
    return explicit;
  }

  if (vercelEnv === 'development') {
    return explicit || 'development';
  }

  // Production deployments OR non-Vercel runs (CI, local node, scripts):
  // respect an explicit namespace if provided, otherwise use flat paths.
  // Flat is required so that already-stored production blobs at `orders/...`
  // remain readable without a one-time migration.
  return explicit;
}

/**
 * Apply the configured namespace prefix to a blob path.
 *
 * Examples (with HSB_BLOB_NAMESPACE='preview'):
 *   withBlobNamespace('orders/abc.json') → 'preview/orders/abc.json'
 *   withBlobNamespace('orders/')         → 'preview/orders/'
 *
 * With no namespace (production default):
 *   withBlobNamespace('orders/abc.json') → 'orders/abc.json'  (unchanged)
 */
export function withBlobNamespace(path: string): string {
  const ns = getBlobNamespace();
  if (!ns) return path;
  // Strip any leading slashes from the input to keep the join clean.
  const cleaned = path.replace(/^\/+/, '');
  return `${ns}/${cleaned}`;
}

/**
 * Custom error thrown when an order cannot be durably persisted in a
 * production-like environment. Callers (notably /api/order) MUST treat this
 * as fatal and abort BEFORE creating a Stripe Checkout Session — otherwise
 * the customer pays for an order the system cannot find later.
 */
export class OrderPersistenceError extends Error {
  readonly orderId: string;
  readonly cause?: unknown;
  constructor(orderId: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'OrderPersistenceError';
    this.orderId = orderId;
    this.cause = cause;
  }
}

/**
 * Production-like = any environment where ephemeral tmpfs is unsafe for order
 * persistence: Vercel (always), explicit production NODE_ENV, or an explicit
 * opt-in via HSB_REQUIRE_DURABLE_PERSISTENCE.
 *
 * Tests can opt out by setting HSB_REQUIRE_DURABLE_PERSISTENCE=false.
 */
export function requiresDurablePersistence(): boolean {
  if (process.env.HSB_REQUIRE_DURABLE_PERSISTENCE === 'true') return true;
  if (process.env.HSB_REQUIRE_DURABLE_PERSISTENCE === 'false') return false;
  if (process.env.VERCEL) return true;
  if (process.env.NODE_ENV === 'production') return true;
  return false;
}

function getOrderStoreDir() {
  // Explicit override always wins (used by tests and the recovery script).
  if (process.env.HSB_ORDER_STORE_DIR) return process.env.HSB_ORDER_STORE_DIR;
  // Vercel still needs a writable scratch dir for the tiny number of legitimate
  // local-only call sites (e.g., the recovery script running during a one-off
  // job). Live persistence MUST go through blob — see persistOrder().
  // Static paths only. Dynamic FS roots (os.tmpdir(), process.cwd()) made
  // Turbopack's NFT pull the whole project into every function bundle and
  // exceed Vercel's deploy upload limit. On Vercel/Linux os.tmpdir() is always
  // '/tmp'; for local dev a relative path resolves against CWD at call time.
  if (process.env.VERCEL) return '/tmp/hsb/orders';
  return '.data/orders';
}

function getOrderBlobPath(orderId: string) {
  return withBlobNamespace(`orders/${orderId}.json`);
}

/**
 * Prefix used by listOrders/getOrder for blob list calls. Honors namespace
 * isolation, so a Preview deployment listing "orders/" actually lists
 * "preview/orders/" — guaranteeing Preview cannot see Production records.
 */
function getOrdersListPrefix() {
  return withBlobNamespace('orders/');
}

/**
 * Resolve the customer photo URL the FAL image-edit provider should fetch.
 *
 * Resolution order (first match wins):
 *   1. order.photoBlobUrl — the absolute URL Vercel Blob returned at upload
 *      time. Set on every order created after this field landed; durable.
 *   2. order.photoBlobPath if it is already an absolute URL (recovery flows
 *      sometimes store a full URL there).
 *   3. Reconstruct from process.env.HSB_PUBLIC_BLOB_BASE + photoBlobPath
 *      (legacy path for orders persisted before photoBlobUrl was added).
 *   4. Otherwise null — the orchestrator will fall through to text-only FAL.
 *
 * Returning null is by design: it signals "we cannot photo-condition this
 * order safely" rather than fabricating a URL the FAL provider would 404 on.
 */
export function getOrderPhotoUrl(
  order: Pick<OrderRecord, 'photoBlobPath' | 'photoBlobUrl'>,
): string | null {
  // 1. Persisted absolute URL — the durable, env-independent path.
  const persistedUrl = order.photoBlobUrl?.trim();
  if (persistedUrl) return persistedUrl;

  const blobPath = order.photoBlobPath?.trim();
  if (!blobPath) return null;

  // 2. photoBlobPath itself is absolute (recovery flows).
  if (/^https?:\/\//i.test(blobPath)) return blobPath;

  // 3. Legacy reconstruction via env override.
  const explicit = process.env.HSB_PUBLIC_BLOB_BASE?.replace(/\/$/, '');
  if (explicit) return `${explicit}/${blobPath}`;

  // 4. No way to resolve — caller falls back to text-only.
  return null;
}

/**
 * Result of uploadOrderPhoto. The `url` is the absolute, fetchable Vercel
 * Blob URL — persist it on OrderRecord.photoBlobUrl so downstream code
 * (FAL image-edit) does not need HSB_PUBLIC_BLOB_BASE to reconstruct it.
 */
export interface UploadedPhotoRef {
  pathname: string;
  url: string;
}

/** Maximum accepted size for an attached child-voice note, in bytes (15 MB). */
export const MAX_VOICE_BYTES = 15 * 1024 * 1024;

/** Result of uploadOrderVoice. Mirrors UploadedPhotoRef. */
export interface UploadedVoiceRef {
  pathname: string;
  url: string;
}

/**
 * Upload an attached child-voice audio file to durable blob storage. Mirrors
 * uploadOrderPhoto's fail-before-Stripe contract in production-like envs.
 */
async function uploadOrderVoiceAtPath(
  orderId: string,
  file: File,
  pathnameForSafeName: (safeName: string) => string,
): Promise<UploadedVoiceRef | null> {
  const token = getBlobToken();

  if (typeof file.arrayBuffer !== 'function') {
    return null;
  }

  if (!token) {
    if (requiresDurablePersistence()) {
      console.error(
        `[orders] uploadOrderVoice: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${orderId}). Refusing to drop customer voice note silently.`,
      );
      throw new OrderPersistenceError(
        orderId,
        'BLOB_READ_WRITE_TOKEN missing in production — cannot durably store customer voice note',
      );
    }
    return null;
  }

  const safeName = (file.name || 'voice')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'voice';

  const pathname = withBlobNamespace(pathnameForSafeName(safeName));
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const blob = await put(pathname, buffer, {
      access: getBlobAccessMode(),
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: file.type || 'application/octet-stream',
      token,
    });
    return { pathname: blob.pathname, url: blob.url };
  } catch (err) {
    if (requiresDurablePersistence()) {
      console.error(
        `[orders] uploadOrderVoice: blob put failed in production-like env (orderId=${orderId}, pathname=${pathname}):`,
        err,
      );
      throw new OrderPersistenceError(
        orderId,
        'Customer voice note upload to durable storage failed',
        err,
      );
    }
    console.warn(`[orders] uploadOrderVoice blob put failed in dev for ${orderId}:`, err);
    return null;
  }
}

export async function uploadOrderVoice(orderId: string, file: File): Promise<UploadedVoiceRef | null> {
  return uploadOrderVoiceAtPath(orderId, file, (safeName) => `orders/${orderId}/voice-${safeName}`);
}

export async function uploadFamilyContributionVoice(
  orderId: string,
  contributionId: string,
  file: File,
): Promise<UploadedVoiceRef | null> {
  const safeContributionId = cleanShortText(contributionId, 80) || 'contribution';
  return uploadOrderVoiceAtPath(
    orderId,
    file,
    (safeName) => `orders/${orderId}/family-contributions/${safeContributionId}/voice-${safeName}`,
  );
}

async function uploadOrderPhotoAtPath(
  orderId: string,
  file: File,
  pathnameForSafeName: (safeName: string) => string,
): Promise<UploadedPhotoRef | null> {
  const token = getBlobToken();

  if (typeof file.arrayBuffer !== 'function') {
    return null;
  }

  if (!token) {
    // In production-like envs, missing the blob token for an actual customer
    // photo upload is a hard failure — we'd otherwise drop the photo silently.
    if (requiresDurablePersistence()) {
      console.error(
        `[orders] uploadOrderPhoto: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${orderId}). Refusing to drop customer photo silently.`,
      );
      throw new OrderPersistenceError(
        orderId,
        'BLOB_READ_WRITE_TOKEN missing in production — cannot durably store customer photo',
      );
    }
    // Local dev with no blob token: explicit, expected behavior.
    return null;
  }

  const safeName = (file.name || 'photo')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'photo';

  const pathname = withBlobNamespace(pathnameForSafeName(safeName));
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const blob = await put(pathname, buffer, {
      access: getBlobAccessMode(),
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: file.type || 'application/octet-stream',
      token,
    });
    return { pathname: blob.pathname, url: blob.url };
  } catch (err) {
    if (requiresDurablePersistence()) {
      console.error(
        `[orders] uploadOrderPhoto: blob put failed in production-like env (orderId=${orderId}, pathname=${pathname}):`,
        err,
      );
      throw new OrderPersistenceError(
        orderId,
        'Customer photo upload to durable storage failed',
        err,
      );
    }
    // Local dev: surface the error without crashing checkout — caller decides.
    console.warn(`[orders] uploadOrderPhoto blob put failed in dev for ${orderId}:`, err);
    return null;
  }
}

export async function uploadOrderPhoto(orderId: string, file: File): Promise<UploadedPhotoRef | null> {
  return uploadOrderPhotoAtPath(orderId, file, (safeName) => `orders/${orderId}/photo-${safeName}`);
}

export async function uploadOrderSupportingPhoto(
  orderId: string,
  index: number,
  file: File,
): Promise<UploadedPhotoRef | null> {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index + 1 : 1;
  return uploadOrderPhotoAtPath(
    orderId,
    file,
    (safeName) => `orders/${orderId}/supporting-${safeIndex}-photo-${safeName}`,
  );
}

export async function uploadFamilyContributionPhoto(
  orderId: string,
  contributionId: string,
  file: File,
): Promise<UploadedPhotoRef | null> {
  const safeContributionId = cleanShortText(contributionId, 80) || 'contribution';
  return uploadOrderPhotoAtPath(
    orderId,
    file,
    (safeName) => `orders/${orderId}/family-contributions/${safeContributionId}/photo-${safeName}`,
  );
}

export async function uploadOrderGuidedPhoto(
  orderId: string,
  index: number,
  file: File,
): Promise<UploadedPhotoRef | null> {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index + 1 : 1;
  return uploadOrderPhotoAtPath(
    orderId,
    file,
    (safeName) => `orders/${orderId}/guided-${safeIndex}-photo-${safeName}`,
  );
}

function getOwnerPrintGoIntentLockBlobPath(orderId: string) {
  return withBlobNamespace(`orders/${orderId}/owner-print-go.lock`);
}

function getProofReleaseEmailLockHash(manifestHash: string | null | undefined) {
  return crypto
    .createHash('sha256')
    .update(manifestHash || 'missing-manifest-hash')
    .digest('hex');
}

function getProofReleaseEmailLockBlobPath(orderId: string, manifestHash: string | null | undefined) {
  return withBlobNamespace(`orders/${orderId}/proof-release-email-${getProofReleaseEmailLockHash(manifestHash)}.lock`);
}

function isCreateOnlyCollision(err: unknown): boolean {
  const anyErr = err as { code?: string; status?: number; message?: string };
  const msg = String(anyErr?.message ?? '').toLowerCase();
  return (
    anyErr?.code === 'EEXIST' ||
    anyErr?.status === 409 ||
    msg.includes('already exists') ||
    msg.includes('conflict') ||
    msg.includes('would overwrite')
  );
}

/**
 * Durable one-shot intent lock for owner print-go.
 *
 * Order JSON is last-write-wins, so writing ownerPrintGoLockToken and reading
 * it back is not enough to prevent an irreversible double submit: two writers
 * can both observe their own surviving token before the other write completes.
 * This lock uses create-only storage before any Lulu/RPI call:
 *  - Vercel Blob: `allowOverwrite: false` on a deterministic lock key.
 *  - Local/test FS: `flag: 'wx'` on a deterministic lock file.
 *
 * The lock is intentionally not deleted after success. It is an idempotency
 * marker that makes future owner-go attempts refuse before print submission.
 */
export async function acquireOwnerPrintGoIntentLock(
  orderId: string,
  lockToken: string,
  ownerBy: string,
  acquiredAt: string,
): Promise<{ acquired: boolean; error?: string }> {
  const payload = JSON.stringify({ orderId, lockToken, ownerBy, acquiredAt }, null, 2);
  const token = getBlobToken();
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      await put(getOwnerPrintGoIntentLockBlobPath(orderId), payload, {
        access: getBlobAccessMode(),
        allowOverwrite: false,
        addRandomSuffix: false,
        contentType: 'application/json',
        token,
      });
      return { acquired: true };
    } catch (err) {
      if (isCreateOnlyCollision(err)) return { acquired: false, error: 'owner print-go lock already exists' };
      if (requireDurable) throw err;
      console.warn(`[orders] owner print-go blob lock failed in dev for ${orderId}:`, err);
      // dev: fall through to filesystem lock below
    }
  } else if (requireDurable) {
    throw new OrderPersistenceError(
      orderId,
      'BLOB_READ_WRITE_TOKEN missing in production — cannot durably acquire owner print-go lock',
    );
  }

  const dir = `${getOrderStoreDir()}/${orderId}`;
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(`${dir}/owner-print-go.lock`, `${payload}\n`, { encoding: 'utf8', flag: 'wx' });
    return { acquired: true };
  } catch (err) {
    if (isCreateOnlyCollision(err)) return { acquired: false, error: 'owner print-go lock already exists' };
    throw err;
  }
}

/**
 * Recovery path for a stuck owner-print-go acquisition.
 *
 * Used by the operator-only recovery action when print submission failed
 * or the order is stuck in `submitting_to_print` / `failed_manual_review`
 * with no `printJobId`. Deletes both the blob and the FS lock if
 * present. ENOENT / 404 are treated as success (idempotent: clearing a
 * lock that does not exist is fine). All other errors propagate so the
 * caller surfaces a real failure.
 *
 * IMPORTANT: this function only releases the storage-level lock. It is
 * NOT a generic "undo owner-go" — the caller is responsible for
 * validating that no `printJobId` exists and that `order.status` is not
 * `print_in_production` / `shipped` before invoking. See
 * `releaseOwnerPrintGoLock` in admin-actions.ts.
 */
export async function releaseOwnerPrintGoIntentLock(
  orderId: string,
): Promise<{ released: boolean }> {
  const blobToken = getBlobToken();
  let touchedBlob = false;
  let touchedFs = false;

  if (blobToken) {
    try {
      await del(getOwnerPrintGoIntentLockBlobPath(orderId), { token: blobToken });
      touchedBlob = true;
    } catch (err) {
      // 404 / missing blob: nothing to release; that's fine.
      const anyErr = err as { status?: number; message?: string };
      const missing =
        anyErr?.status === 404 ||
        String(anyErr?.message ?? '').toLowerCase().includes('not found');
      if (!missing) throw err;
    }
  }

  const fsPath = `${getOrderStoreDir()}/${orderId}/owner-print-go.lock`;
  try {
    await unlink(fsPath);
    touchedFs = true;
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr?.code !== 'ENOENT') throw err;
  }

  return { released: touchedBlob || touchedFs };
}

/**
 * Durable one-shot idempotency lock for customer proof/digital release email.
 *
 * The key is deterministic per orderId + manifestHash, so concurrent admin
 * QA-release attempts for the same artifact cannot both send customer email.
 * The lock is intentionally not deleted; a new artifact/manifest gets a new
 * key, while retries for an already released artifact refuse before transport.
 */
export async function acquireProofReleaseEmailLock(
  orderId: string,
  manifestHash: string | null | undefined,
  lockToken: string,
  releasedBy: string,
  acquiredAt: string,
): Promise<{ acquired: boolean; error?: string }> {
  const payload = JSON.stringify({ orderId, manifestHash: manifestHash ?? null, lockToken, releasedBy, acquiredAt }, null, 2);
  const token = getBlobToken();
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      await put(getProofReleaseEmailLockBlobPath(orderId, manifestHash), payload, {
        access: getBlobAccessMode(),
        allowOverwrite: false,
        addRandomSuffix: false,
        contentType: 'application/json',
        token,
      });
      return { acquired: true };
    } catch (err) {
      if (isCreateOnlyCollision(err)) return { acquired: false, error: 'proof release email lock already exists' };
      if (requireDurable) throw err;
      console.warn(`[orders] proof release email blob lock failed in dev for ${orderId}:`, err);
      // dev: fall through to filesystem lock below
    }
  } else if (requireDurable) {
    throw new OrderPersistenceError(
      orderId,
      'BLOB_READ_WRITE_TOKEN missing in production — cannot durably acquire proof release email lock',
    );
  }

  const dir = `${getOrderStoreDir()}/${orderId}`;
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(`${dir}/proof-release-email-${getProofReleaseEmailLockHash(manifestHash)}.lock`, `${payload}\n`, { encoding: 'utf8', flag: 'wx' });
    return { acquired: true };
  } catch (err) {
    if (isCreateOnlyCollision(err)) return { acquired: false, error: 'proof release email lock already exists' };
    throw err;
  }
}

export async function persistOrder(order: OrderRecord) {
  const token = getBlobToken();
  const serialized = JSON.stringify(order, null, 2);
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      await put(getOrderBlobPath(order.id), serialized, {
        access: getBlobAccessMode(),
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token,
      });
      return order;
    } catch (err) {
      // In production-like envs we MUST NOT silently fall back to ephemeral
      // tmp filesystem — that's how a customer pays Stripe and the webhook
      // later cannot find the order. Fail loudly. Caller (the order route)
      // is responsible for aborting BEFORE Stripe Checkout Session creation.
      if (requireDurable) {
        console.error(
          `[orders] persistOrder: blob put failed in production-like env (orderId=${order.id}). ` +
            `Refusing silent tmp fallback. Cause:`,
          err,
        );
        throw new OrderPersistenceError(
          order.id,
          'Durable order persistence failed (blob put error)',
          err,
        );
      }
      // Local dev: fall through to filesystem fallback below.
      console.warn(`[orders] persistOrder blob put failed in dev for ${order.id}:`, err);
    }
  } else if (requireDurable) {
    // Production-like env with no blob token configured at all — hard fail.
    console.error(
      `[orders] persistOrder: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${order.id}). Refusing silent tmp fallback.`,
    );
    throw new OrderPersistenceError(
      order.id,
      'BLOB_READ_WRITE_TOKEN missing in production — cannot durably persist order',
    );
  }

  // Local-dev / explicit override path only.
  const dir = getOrderStoreDir();
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${order.id}.json`, `${serialized}\n`, 'utf8');
  return order;
}

export async function getOrder(orderId: string) {
  const token = getBlobToken();
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      if (getBlobAccessMode() === 'public') {
        const { blobs } = await list({ prefix: getOrderBlobPath(orderId), token });
        const blob = blobs.find((b) => b.pathname === getOrderBlobPath(orderId));
        if (!blob?.url) return null;
        const text = await readBlobText({ pathname: blob.pathname, url: blob.url, token });
        return text ? (JSON.parse(text) as OrderRecord) : null;
      }

      const text = await readBlobText({ pathname: getOrderBlobPath(orderId), token });
      return text ? (JSON.parse(text) as OrderRecord) : null;
    } catch (err) {
      if (requireDurable) {
        // In production, blob errors must NOT silently fall back to ephemeral
        // disk — that's how the webhook reads from a different store than
        // persistOrder() wrote to. Re-throw so the caller can log + 500.
        console.error(
          `[orders] getOrder: blob read failed in production-like env (orderId=${orderId}):`,
          err,
        );
        throw err;
      }
      console.warn(`[orders] getOrder blob read failed in dev for ${orderId}:`, err);
      // dev: fall through to filesystem
    }
  } else if (requireDurable) {
    console.error(
      `[orders] getOrder: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${orderId}).`,
    );
    throw new OrderPersistenceError(
      orderId,
      'BLOB_READ_WRITE_TOKEN missing in production — cannot read order',
    );
  }

  try {
    const file = await readFile(`${getOrderStoreDir()}/${orderId}.json`, 'utf8');
    return JSON.parse(file) as OrderRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function listOrders(): Promise<OrderRecord[]> {
  const token = getBlobToken();

  if (token) {
    try {
      const { blobs } = await list({ prefix: getOrdersListPrefix(), token });
      const orders: OrderRecord[] = [];
      for (const blob of blobs) {
        if (!blob.pathname.endsWith('.json')) continue;
        try {
          const text = await readBlobText({ pathname: blob.pathname, url: blob.url, token });
          if (!text) continue;
          orders.push(JSON.parse(text) as OrderRecord);
        } catch {
          // skip corrupt/unreadable blobs
        }
      }
      return orders;
    } catch {
      // fall through to filesystem fallback
    }
  }

  const dir = getOrderStoreDir();
  try {
    const files = await readdir(dir);
    const orders: OrderRecord[] = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const text = await readFile(`${dir}/${file}`, 'utf8');
        orders.push(JSON.parse(text) as OrderRecord);
      } catch {
        // skip corrupt files
      }
    }
    return orders;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function findOrderByFamilyContributionToken(token: string): Promise<OrderRecord | null> {
  const cleanToken = cleanShortText(token, 80);
  if (!cleanToken) return null;
  const orders = await listOrders();
  return orders.find((order) => order.familyContributionToken === cleanToken) ?? null;
}

export function isOrderStatus(value: string): value is OrderStatus {
  return ['order_received', 'preview_ready', 'print_in_production', 'shipped', 'checkout_failed'].includes(value);
}

export async function updateOrderStatus(orderId: string, status: OrderStatus) {
  const existing = await getOrder(orderId);
  if (!existing) {
    return null;
  }

  const updated: OrderRecord = {
    ...existing,
    status,
    updatedAt: new Date().toISOString(),
  };

  await persistOrder(updated);
  return updated;
}

type FulfillmentPatch = Partial<Pick<
  OrderRecord,
  | 'fulfillmentStatus'
  | 'fulfillmentAttempts'
  | 'fulfillmentLastError'
  | 'storyArtifactUrl'
  | 'storyMeta'
  | 'generationRouteDecision'
  | 'printInteriorArtifactUrl'
  | 'printInteriorMd5'
  | 'printInteriorPageCount'
  | 'printCoverArtifactUrl'
  | 'printCoverMd5'
  | 'printTitle'
  | 'qaPassAt'
  | 'qaPassBy'
  | 'qaStatus'
  | 'qaReviewer'
  | 'qaBlockedReason'
  | 'customerProofReleasedAt'
  | 'printApprovedAt'
  | 'printSubmittedAt'
  | 'ownerPrintGoAt'
  | 'ownerPrintGoBy'
  | 'ownerPrintGoLockToken'
  | 'manualInterventionRequired'
  | 'emergencyOverrideUsed'
  | 'emergencyApprovedBy'
  | 'emergencyApprovalRef'
  | 'apiAuthorizedBy'
  | 'apiAuthorizedAt'
  | 'sourcePhotoPresent'
  | 'personalizationInputsPresent'
  | 'manifestComplete'
  | 'manifestHash'
  | 'artifactManifest'
  | 'proofApprovalToken'
  | 'proofApprovedAt'
  | 'proofReviewedAt'
  | 'printJobId'
  | 'printJobStatus'
  | 'trackingNumber'
  | 'trackingUrl'
  | 'shippedAt'
  | 'status'
  | 'reviewStatus'
  | 'internalDisposition'
  | 'internalDispositionNote'
  | 'internalDispositionAt'
  | 'pageArtifacts'
  | 'auditEvents'
  | 'paymentStatus'
  | 'stripeSessionId'
  | 'shippingAddress'
  | 'refundedAt'
  | 'refundReason'
  | 'stripeRefundId'
>>;

const PAYMENT_GATED_FULFILLMENT_STATUSES: FulfillmentStatus[] = [
  'generating_story',
  'generating_images',
  'building_pdf',
  'awaiting_qa',
  'proof_ready',
  'proof_approved',
  'submitting_to_print',
  'complete',
  // delivery_email_failed implies artifacts already persisted under a
  // paid record. Treat any write to that status the same as the other
  // post-payment states.
  'delivery_email_failed',
];

function patchRequiresPaidOrder(patch: FulfillmentPatch): boolean {
  if (patch.storyArtifactUrl !== undefined) return true;
  if (patch.pageArtifacts !== undefined) return true;
  if (patch.printInteriorArtifactUrl !== undefined) return true;
  if (patch.printCoverArtifactUrl !== undefined) return true;
  if (patch.proofApprovalToken !== undefined) return true;
  if (patch.printJobId !== undefined) return true;
  if (patch.status === 'preview_ready' || patch.status === 'print_in_production' || patch.status === 'shipped') return true;
  if (patch.fulfillmentStatus && PAYMENT_GATED_FULFILLMENT_STATUSES.includes(patch.fulfillmentStatus)) return true;
  return false;
}

function hasMatchingRouteDecisionAudit(order: OrderRecord, decision: GenerationRouteDecision): boolean {
  return (order.auditEvents ?? []).some((event) =>
    event.type === 'route_decision_recorded' &&
    event.at === decision.decidedAt &&
    event.meta?.route === decision.route &&
    event.meta?.source === decision.source &&
    event.meta?.model === decision.model &&
    event.meta?.releasable === decision.releasable,
  );
}

function patchMakesProofArtifactReleasable(patch: FulfillmentPatch, updated: OrderRecord): boolean {
  if (patch.storyArtifactUrl !== undefined && Boolean(updated.storyArtifactUrl)) return true;
  if (patch.proofApprovalToken !== undefined && Boolean(updated.proofApprovalToken)) return true;
  if (patch.status === 'preview_ready' && Boolean(updated.storyArtifactUrl)) return true;
  if (
    (patch.fulfillmentStatus === 'complete' ||
      patch.fulfillmentStatus === 'proof_ready' ||
      patch.fulfillmentStatus === 'delivery_email_failed') &&
    Boolean(updated.storyArtifactUrl)
  ) return true;
  return false;
}

function assertRouteDecisionAllowsProofRelease(orderId: string, patch: FulfillmentPatch, updated: OrderRecord): void {
  if (!patchMakesProofArtifactReleasable(patch, updated)) return;

  const decision = updated.generationRouteDecision;
  if (!decision) {
    throw new Error(`[orders] Refusing proof artifact release for ${orderId}: generation route decision missing`);
  }
  if (!decision.releasable) {
    throw new Error(`[orders] Refusing proof artifact release for ${orderId}: generation route decision is not releasable`);
  }
  if (!hasMatchingRouteDecisionAudit(updated, decision)) {
    throw new Error(`[orders] Refusing proof artifact release for ${orderId}: route_decision_recorded audit missing`);
  }
}

// ── Per-order write serialization ─────────────────────────────────────────────
//
// Order persistence is last-writer-wins (blob `put`, no CAS/etag). Two concurrent
// read-modify-write requests on the same order can lose one write. This in-process
// lock serializes the read→modify→write critical section per orderId so the second
// caller re-reads the first caller's persisted result (combine with a re-read of
// the latest order INSIDE the locked section). NOTE: this protects concurrency
// within a single server instance; it is not a cross-instance distributed lock —
// the merge-at-write re-read narrows the remaining cross-instance window.
const orderWriteChains = new Map<string, Promise<unknown>>();

export async function withOrderWriteLock<T>(orderId: string, fn: () => Promise<T>): Promise<T> {
  const prev = orderWriteChains.get(orderId) ?? Promise.resolve();
  const result = prev.then(() => fn(), () => fn());
  const chain = result.then(() => undefined, () => undefined);
  orderWriteChains.set(orderId, chain);
  // Drop the map entry once this is the last queued writer, to avoid unbounded growth.
  void chain.then(() => {
    if (orderWriteChains.get(orderId) === chain) orderWriteChains.delete(orderId);
  });
  return result;
}

// ── Optimistic concurrency (Vercel Blob ETag CAS) for order JSON writes ───────
//
// Order blobs are last-writer-wins by default; two instances mutating the same
// order can clobber each other (a fulfillment write dropping a concurrent
// review write, or vice-versa). For UPDATES to an existing order we read the
// current body + ETag, mutate from that latest snapshot, and write with
// `ifMatch`. A precondition failure (a concurrent writer won the race) re-reads
// and re-applies, bounded. Order CREATION (persistOrder) is single-writer (the
// checkout request) and stays unchanged. The in-process withOrderWriteLock
// remains a same-instance safety floor at the call sites.
const ORDER_CAS_MAX_RETRIES = 5;

export interface OrderCasStore {
  /** Latest order body + its current ETag, or null if the blob does not exist. */
  read(): Promise<{ order: OrderRecord; etag: string } | null>;
  /** Conditional write — must reject (isPreconditionError) if etag no longer matches. */
  write(order: OrderRecord, ifMatch: string): Promise<void>;
  isPreconditionError(err: unknown): boolean;
}

// Single-shape result (this codebase compiles with tsconfig "strict": false,
// under which `!result.ok` does not narrow a true/false discriminant).
export interface CasMutateResult {
  ok: boolean;
  order?: OrderRecord;
  reason?: 'not_found' | 'precondition_exhausted';
  attempts: number;
  error?: unknown;
}

/**
 * Dependency-injected CAS read-modify-write loop. `build` is applied to the
 * freshest snapshot on every attempt, so a field changed by a concurrent writer
 * between attempts is preserved (the patch is re-merged onto the latest). Errors
 * other than precondition failures propagate (never silent success); exhausting
 * retries returns ok:false (caller surfaces it as a failure).
 */
export async function casMutateOrder(
  store: OrderCasStore,
  build: (latest: OrderRecord) => OrderRecord,
  maxRetries: number = ORDER_CAS_MAX_RETRIES,
): Promise<CasMutateResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const snapshot = await store.read();
    if (!snapshot) return { ok: false, reason: 'not_found', attempts: attempt };
    const updated = build(snapshot.order); // build() may throw (e.g. payment gate) → propagates, not retried
    try {
      await store.write(updated, snapshot.etag);
      return { ok: true, order: updated, attempts: attempt };
    } catch (err) {
      if (store.isPreconditionError(err)) {
        lastError = err;
        continue; // a concurrent writer committed first — re-read + re-apply
      }
      throw err; // genuine write failure — do NOT report success
    }
  }
  return { ok: false, reason: 'precondition_exhausted', attempts: maxRetries, error: lastError };
}

async function readOrderWithEtag(
  orderId: string,
  token: string,
): Promise<{ order: OrderRecord; etag: string } | null> {
  const pathname = getOrderBlobPath(orderId);
  let meta;
  try {
    meta = await head(pathname, { token });
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
  if (!meta?.etag) return null;

  // CAS must not pair a fresh ETag from head() with a possibly stale public-CDN
  // body. Read the object body through the authenticated SDK path with cache off,
  // then write with the ETag from head(). If another writer lands between this
  // read and our put(), ifMatch still fails and the outer loop retries.
  try {
    const text = await readBlobText({
      pathname,
      url: 'url' in meta ? meta.url : null,
      token,
    });
    if (!text) return null;
    return { order: JSON.parse(text) as OrderRecord, etag: meta.etag };
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

/** Build the live blob-backed CAS store for an order. */
function blobOrderCasStore(orderId: string, token: string): OrderCasStore {
  return {
    read: () => readOrderWithEtag(orderId, token),
    write: async (order, ifMatch) => {
      await put(getOrderBlobPath(order.id), JSON.stringify(order, null, 2), {
        access: getBlobAccessMode(),
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        token,
        ifMatch,
      });
    },
    isPreconditionError: (err) => err instanceof BlobPreconditionFailedError,
  };
}

/**
 * Read-modify-write an EXISTING order. Uses Blob ETag CAS in production
 * (token present); falls back to the prior read-then-persist behavior in
 * dev / no-token. `existingOrder` is the caller's fresh in-process snapshot,
 * used as the base only on the non-CAS path or when the blob is not yet
 * visible via head() (a just-created order). Returns null when the order does
 * not exist; throws (never silent success) on durable write failure.
 */
async function mutateOrderRecord(
  orderId: string,
  existingOrder: OrderRecord | undefined,
  build: (latest: OrderRecord) => OrderRecord,
): Promise<OrderRecord | null> {
  const token = getBlobToken();

  if (!token) {
    const existing = existingOrder?.id === orderId ? existingOrder : await getOrder(orderId);
    if (!existing) return null;
    const updated = build(existing);
    await persistOrder(updated);
    return updated;
  }

  const result = await casMutateOrder(blobOrderCasStore(orderId, token), build);
  if (result.ok) return result.order ?? null;

  if (result.reason === 'not_found') {
    // Not visible via head() yet. If the caller handed us a fresh snapshot for
    // THIS order (e.g. created earlier in the same request), persist from it;
    // otherwise the order genuinely does not exist.
    if (existingOrder?.id === orderId) {
      const updated = build(existingOrder);
      await persistOrder(updated);
      return updated;
    }
    return null;
  }

  // precondition_exhausted — surface as a hard failure; never report success.
  throw new OrderPersistenceError(
    orderId,
    `Durable order persistence failed: ETag precondition kept failing after ${ORDER_CAS_MAX_RETRIES} attempts`,
    result.error,
  );
}

export async function updateFulfillmentState(
  orderId: string,
  patch: FulfillmentPatch,
  existingOrder?: OrderRecord,
): Promise<OrderRecord | null> {
  // CAS-protected read-modify-write. The patch is applied to the FRESHEST blob
  // snapshot (re-read each attempt), so concurrent writes to other fields are
  // preserved rather than clobbered. existingOrder is the dev/no-token base.
  return mutateOrderRecord(orderId, existingOrder, (existing) => {
    const effectivePaymentStatus = patch.paymentStatus ?? existing.paymentStatus;
    if (patchRequiresPaidOrder(patch) && effectivePaymentStatus !== 'paid') {
      throw new Error(
        `[orders] Refusing fulfillment mutation for ${orderId}: paymentStatus=${effectivePaymentStatus}`,
      );
    }
    const updated: OrderRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    assertRouteDecisionAllowsProofRelease(orderId, patch, updated);
    return updated;
  });
}

/**
 * Append-only audit log helper. Every review/approval event flows through here
 * so the trail is in one place. Read-modify-write on the order record — same
 * pattern as updateFulfillmentState. Returns the updated order, or null if the
 * order does not exist (caller decides whether that's an error).
 */
export async function appendAuditEvent(
  orderId: string,
  event: Omit<ReviewAuditEvent, 'at'> & { at?: string },
  existingOrder?: OrderRecord,
): Promise<OrderRecord | null> {
  // Use the caller's already-written record when available for this order. A
  // fresh getOrder() here can return a stale blob snapshot and overwrite newer
  // pageArtifacts (the production regen-clobber bug: appendAuditEvent re-read
  // stale state after updateFulfillmentState had already persisted the regen'd
  // artifacts). Guard the exported helper against accidental cross-order reuse.
  const entry: ReviewAuditEvent = {
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    ...(event.pageIndex != null ? { pageIndex: event.pageIndex } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.meta ? { meta: event.meta } : {}),
  };
  // CAS-protected append: each attempt appends onto the FRESHEST auditEvents, so
  // concurrent appends/updates are not lost (no clobber of newer pageArtifacts).
  return mutateOrderRecord(orderId, existingOrder, (existing) => ({
    ...existing,
    auditEvents: [...(existing.auditEvents ?? []), entry],
    updatedAt: new Date().toISOString(),
  }));
}

export async function updateOrderPayment(
  orderId: string,
  paymentStatus: PaymentStatus,
  opts: { stripeSessionId?: string; shippingAddress?: ShippingAddress } = {},
) {
  const existing = await getOrder(orderId);
  if (!existing) return null;

  const updated: OrderRecord = {
    ...existing,
    paymentStatus,
    ...(opts.stripeSessionId != null ? { stripeSessionId: opts.stripeSessionId } : {}),
    ...(opts.shippingAddress != null ? { shippingAddress: opts.shippingAddress } : {}),
    updatedAt: new Date().toISOString(),
  };

  await persistOrder(updated);
  return updated;
}
