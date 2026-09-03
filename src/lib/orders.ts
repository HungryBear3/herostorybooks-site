import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';

import { BlobNamespaceError, getBlobNamespace, withBlobNamespace } from './blob-namespace.ts';
import {
  BlobNotFoundError,
  BlobPreconditionFailedError,
  del,
  get,
  list,
  put,
} from '@vercel/blob';

import type { CheckoutTracking } from './checkout-tracking.ts';
import type { CustomerQueueStatus } from './order-queue.ts';
import type { FulfillmentStatus, LayoutVersion, PageTextLayout, ProofCardOverride, VoiceTranscriptMeta } from './fulfillment-types.ts';
import type { GuidedReferencePhotoRecord } from './guided-photo-capture.ts';
import type { CustomStoryBrief, ValidationResult } from './custom-story/index.ts';
import { finalizationFingerprint, parseSelectionEntry, type FinalizedSelectionEntry } from './checkout-intake.ts';
import { validateOrderPhotoFile } from './photo-file-validation.ts';
import { PROOF_TURNAROUND_PHRASE } from './proof-turnaround.ts';
export type { FulfillmentStatus, LayoutVersion, PageTextLayout, VoiceTranscriptMeta };

export type OrderStatus = 'order_received' | 'preview_ready' | 'print_in_production' | 'shipped';
export type BookFormat = 'digital' | 'classic' | 'premium';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'partially_refunded' | 'refunded';
export type InternalOrderDisposition =
  | 'abandoned_internal_test'
  | 'superseded_internal_smoke';

/**
 * Durable authority for private checkout-intake media selected by an order.
 * The upload capability is intentionally absent: it is authentication material,
 * not part of the order contract.
 */
export interface CheckoutIntakeBinding {
  intakeId: string;
  fingerprint: string;
  /** SHA-256 of the canonical immutable durable order projection. */
  orderContractDigest: string;
  selection: FinalizedSelectionEntry[];
}

/** Durable deletion authority for media selected from a checkout intake. */
export interface CheckoutIntakeMediaRetention {
  status: 'active' | 'cleanup_claimed' | 'reclaimed';
  activatedAt: string;
  cleanupClaimedAt?: string | null;
  reclaimedAt?: string | null;
}

export const CHECKOUT_INTAKE_MEDIA_ABANDONMENT_MS = 30 * 24 * 60 * 60 * 1000;

export interface ShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface OrderInput {
  childName: string;
  childAge?: string;
  /** Optional customer-selected pronouns for prose generation. Legacy orders infer from notes. */
  childPronouns?: 'he/him' | 'she/her' | 'they/them' | string | null;
  // ── Fully-custom hero contract (Phase A, additive + backward compatible) ────
  //
  // These optional fields let checkout describe WHO the book is about beyond a
  // single child. They are groundwork: `childName` remains the authoritative
  // legacy hero field and is always populated (derived from `heroName` when a
  // caller only sends the new shape). Downstream story/admin/email paths keep
  // reading `childName` unchanged. Non-child hero TYPES are NOT enabled in the
  // Phase-A checkout UI — the story generator still frames the hero as a child
  // — so `heroType` defaults to 'child'. See heroDisplayName()/heroDescriptor()
  // in story-generator.ts and docs/plans/2026-07-06-fully-custom-checkout.md.
  /** Canonical hero display name. Falls back to childName when absent. */
  heroName?: string | null;
  /** Hero kind. Phase A only ships 'child'; other values are schema groundwork. */
  heroType?: 'child' | 'parent' | 'grandparent' | 'sibling' | 'pet' | 'whole-family' | 'other' | string | null;
  /** Free-text life stage, e.g. "6 years old", "grandpa", "adult", "family dog". */
  heroAgeOrStage?: string | null;
  /** Who the finished book is for (may differ from the hero). */
  recipientName?: string | null;
  /** Relationship of hero to recipient, e.g. "Grandpa to Emma". */
  recipientRelationship?: string | null;
  /** Narrative stance groundwork: 'hero' (default) / 'recipient' / 'family'. */
  storyPerspective?: string | null;
  /** Multi-person disambiguation for the MAIN hero photo (text MVP). */
  heroPhotoFocusLabel?: string | null;
  /** Where the hero is in a multi-person photo, e.g. "center", "left". */
  heroPhotoCropHint?: string | null;
  theme?: string;
  lesson?: string;
  occasion?: string;
  giftMessage?: string;
  characterNotes?: string;
  familyCharacters?: FamilyCharacterInput[] | string | null;
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
  /** Optional parent-approved child/hero guided still reference photos. */
  guidedReferencePhotos?: GuidedReferencePhotoRecord[];
  // Optional child-voice-note beta (NEXT_PUBLIC_HSB_VOICE_BETA). The audio is
  // NOT used for voice cloning; it's stored as inspiration/source material for
  // later operator-reviewed story personalization.
  // The original client filename is intentionally neither accepted nor
  // persisted: recording-app filenames can contain names, dates, and places.
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
  /** Sanitized, operator-approved custom-story brief. Never raw transcript/audio. */
  customStoryBrief?: CustomStoryBrief | null;
  /** Latest fail-closed validation result for the sanitized custom-story brief. */
  customStoryValidation?: ValidationResult | null;
  /** Sanitized private tester/source tracking from normal checkout URL params. */
  checkoutTracking?: CheckoutTracking | null;
  /** Lossless binding to the exact private intake tuple committed with this order. */
  checkoutIntake?: CheckoutIntakeBinding | null;
  /** Private intake references are not fetchable/public Blob URLs. */
  primaryHeroIntakeMedia?: FinalizedSelectionEntry | null;
  guidedStillIntakeMedia?: FinalizedSelectionEntry[];
  voiceIntakeMedia?: FinalizedSelectionEntry | null;
  documentIntakeMedia?: FinalizedSelectionEntry | null;
}

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
  providerTried?: 'openai' | 'fal' | 'fal_edit' | 'gemini' | null;
  resultImageUrl?: string | null;
  success: boolean;
}

export interface PageVersionEntry {
  createdAt: string;
  imageUrl: string | null;
  provider: 'openai' | 'fal' | 'fal_edit' | 'gemini';
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
  | 'page_accept_rejected'
  | 'page_regenerate_rejected'
  | 'customer_text_change_requested'
  | 'customer_text_change_resolved'
  | 'review_link_prepared'
  | 'proof_invalidated'
  | 'proof_published'
  | 'proof_generated'
  | 'proof_rebuilt'
  | 'proof_release_blocked'
  | 'proof_release_override_recorded'
  | 'proof_review_acknowledged'
  | 'page_regenerated'
  | 'page_accepted'
  | 'page_changes_requested'
  | 'whole_book_approved'
  | 'whole_book_approval_rejected'
  | 'print_upgrade_paid'
  | 'print_upgrade_settlement_conflict'
  | 'payment_settlement_conflict'
  | 'payment_terminal_state_recorded'
  | 'refund_issued'
  | 'refund_refused'
  | 'internal_disposition_marked'
  | 'page_layout_override_applied'
  | 'page_layout_override_reset'
  | 'layout_help_requested';

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

export interface PrivateArtifactRetentionMetadata {
  createdAt: string;
  retentionUntil: string;
  deletionRequestedAt?: string | null;
}

export interface PrivateArtifactMetadata extends PrivateArtifactRetentionMetadata {
  pathname: string;
  sha256: string;
  contentType: string;
  bytes: number;
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
  /** PDF-rendered story heading, persisted so proof identity is recomputable. */
  sceneTitle?: string;
  /** Frozen story-level character description used as the first section of
   *  every page prompt (initial AND regenerate). This is the single anchor
   *  that keeps the same child visually consistent across all pages of one
   *  story. Set once at fulfillment time from StoryContent.characterDescription
   *  and never edited. Optional for backward compatibility with older orders. */
  characterAnchor?: string | null;
  currentImageUrl: string | null;
  acceptedImageUrl?: string | null;
  generationProvider?: 'openai' | 'fal' | 'fal_edit' | 'gemini' | null;
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
  /** Proof-only positioned text-card override authored via the customer layout
   *  editor. When present the customer-review PDF draws an over-art card for
   *  this page; the print master ignores it. Its geometry + resolved color fold
   *  into the proof fingerprint, so setting/clearing it invalidates any cached
   *  proof. Optional for backward compatibility. */
  proofCardOverride?: ProofCardOverride | null;
  /** Optional server-only private-review artifact backing the tokenless proxy URL. */
  privateReviewAsset?: PrivateArtifactMetadata | null;

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
}

/**
 * Fulfillment routing intent. Set EXPLICITLY by the creating workflow — never
 * defaulted, never inferred from product type or payment state. `'auto'` = the
 * order is expected to auto-fulfill after the paid webhook (and is therefore a
 * candidate for stranded-order detection); `'manual_hold'` = produced on the
 * manual path and must never be treated as stranded. Legacy orders (and any
 * order whose workflow did not set this) are `undefined` and MUST fail closed.
 */
export type FulfillmentMode = 'auto' | 'manual_hold';

export interface OrderRecord extends OrderInput {
  id: string;
  checkoutAttemptId?: string | null;
  checkoutFingerprint?: string | null;
  checkoutLeaseId?: string | null;
  checkoutLeaseExpiresAt?: string | null;
  /** Bounded retention lifecycle for media referenced by checkoutIntake. */
  checkoutIntakeMediaRetention?: CheckoutIntakeMediaRetention | null;
  /** Non-PII compatibility signal derived while reading retired legacy data. */
  legacyVoiceUploadPresent?: boolean;
  bookFormat: BookFormat;
  formatLabel: string;
  priceCents: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  /**
   * Authoritative ISO timestamp of the Stripe webhook's transition to
   * paymentStatus='paid'. Written once, idempotently, only by updateOrderPayment
   * on that transition; preserved across replays and later updates. Never derived
   * from updatedAt or any scan clock. Absent on legacy/unpaid orders.
   */
  paidAt?: string | null;
  /** Exact Stripe Checkout amount_total accepted for the original order. */
  settledAmountCents?: number | null;
  /** Fulfillment routing intent — see FulfillmentMode. Undefined = fail closed. */
  fulfillmentMode?: FulfillmentMode;
  stripeSessionId?: string | null;
  /** Exact Stripe PaymentIntent accepted with the bound Checkout Session. */
  stripePaymentIntentId?: string | null;
  shippingAddress?: ShippingAddress | null;
  fulfillmentStatus?: FulfillmentStatus;
  /** Durable kickoff-claim timestamp for fulfillment start dedupe/recovery. */
  fulfillmentKickoffAt?: string | null;
  /** Opaque kickoff-claim ownership token paired with fulfillmentKickoffAt. */
  fulfillmentKickoffId?: string | null;
  fulfillmentAttempts?: number;
  fulfillmentLastError?: string | null;
  storyArtifactUrl?: string | null;
  privateStoryArtifact?: PrivateArtifactMetadata | null;
  /** Persisted record of how the story was generated (template/openai/etc).
   *  Recorded by fulfillment once; optional for backward compatibility with older orders. */
  storyMeta?: import('./fulfillment-types.ts').StoryMeta | null;
  /** Optional read-only art-direction packet persisted by the art-direction
   *  pipeline. Admin diagnostics may display bounded summaries from it, but
   *  fulfillment/proof state must not depend on this field until the gated
   *  state-machine work lands. */
  artDirectionPacket?: unknown | null;
  /** Optional persisted storyboard validation from the art-direction pipeline.
   *  Diagnostics recompute when absent so legacy orders remain readable. */
  artDirectionValidation?: unknown | null;
  artDirectionGeneratedAt?: string | null;
  artDirectionHumanReviewStatus?: 'not_started' | 'needs_review' | 'approved' | 'rejected' | string | null;
  artDirectionHumanReviewNotes?: string | null;
  /** Internal-only proof release override. Honored only when accompanied by a
   * matching proof_release_override_recorded audit event. */
  proofReleaseOverride?: ProofReleaseOverride | null;
  printInteriorArtifactUrl?: string | null;
  printInteriorMd5?: string | null;
  printInteriorPageCount?: number | null;
  /** Exact proof revision whose accepted pages produced the print interior. */
  printInteriorProofVersion?: string | null;
  printCoverArtifactUrl?: string | null;
  printCoverMd5?: string | null;
  printTitle?: string | null;
  proofApprovalToken?: string | null;
  proofApprovalTokenHash?: string | null;
  proofApprovalTokenExpiresAt?: string | null;
  proofApprovedAt?: string | null;
  /** ISO timestamp print was approved for production; optional for legacy/ops records. */
  printApprovedAt?: string | null;
  /** ISO timestamp print handoff was submitted; optional for legacy/ops records. */
  printSubmittedAt?: string | null;
  /** ISO timestamp QA passed the order for customer proof/release; optional for legacy/ops records. */
  qaPassAt?: string | null;
  /** Current QA state for ops dashboards; optional for legacy/ops records. */
  qaStatus?: string | null;
  /** Manual intervention flag used by recovery dashboards; optional for legacy/ops records. */
  manualInterventionRequired?: boolean | null;
  /** Short QA/manual-review blocker reason; optional for legacy/ops records. */
  qaBlockedReason?: string | null;
  /** ISO timestamp a proof email/release was sent or manually overridden. Optional for legacy orders. */
  customerProofReleasedAt?: string | null;
  /** ISO timestamp the customer ticked the "I reviewed the full proof PDF"
   *  acknowledgment on /review. Required server-side before approveWholeBook. */
  proofReviewedAt?: string | null;
  /**
   * Identity of the exact proof artifact currently persisted at
   * `storyArtifactUrl`. All three move together, and a rendered-content
   * mutation clears them together with the acknowledgment.
   *
   * `proofSourceFingerprint` is the fingerprint of the page set the PDF was
   * rendered from; `proofVersion` names the immutable artifact.
   * `proofReviewedVersion` records WHICH revision the customer acknowledged, so
   * an acknowledgment of revision X can never approve revision Y.
   *
   * Nullable for backward compatibility with records written before this
   * existed; a null fingerprint or version fails closed at every gate.
   */
  proofSourceFingerprint?: string | null;
  proofVersion?: string | null;
  proofReviewedVersion?: string | null;
  /**
   * How this book's story pages are laid out/rendered. Explicit and durable:
   * new/regenerated proofs set it; absence marks an unmarked historical order
   * treated as legacy at read time (never rewritten). Modern books fail closed
   * on missing/invalid per-page layout metadata; legacy books do not.
   */
  layoutVersion?: LayoutVersion | null;
  printJobId?: string | null;
  printJobStatus?: string | null;
  /** Durable pre-POST fence. Once set, ordinary retry is forbidden until the
   * provider is reconciled because the first response may have been lost. */
  printSubmissionAttemptedAt?: string | null;
  printSubmissionProofVersion?: string | null;
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
  /** Private F&F/pilot checkout tracking captured from ?cohort= and ?invite=. */
  checkoutTracking?: CheckoutTracking | null;
  /** Internal manual-queue + customer-status tracking for F&F/concierge orders.
   *  All additive + optional; legacy AND new orders default to null. Populated by
   *  ops tooling only — never by automated fulfillment. See lib/order-queue.ts. */
  manualQueueEnteredAt?: string | null;
  customerQueueStatus?: CustomerQueueStatus | null;
  lastQueueStatusUpdateAt?: string | null;
  /** Internal-only free-text note for ops; not shown to customers. */
  queueStatusNote?: string | null;
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
  /** Cumulative amount Stripe reports refunded for partial/full refund events. */
  stripeRefundedAmountCents?: number | null;
  /** Durable single-flight owner for an operator-triggered customer email. */
  emailResendClaimId?: string | null;
  emailResendClaimKind?: 'digital_delivery' | 'proof_ready' | 'shipped' | 'order_confirmation' | null;
  emailResendClaimArtifact?: string | null;
  emailResendClaimAt?: string | null;
  /** Durable receipt that the shipped lifecycle email was accepted by Resend. */
  shippedEmailSentAt?: string | null;
  /** Durable receipt that the initial paid-order confirmation was accepted. */
  confirmationEmailSentAt?: string | null;
  /** Durable pre-provider refund fence and reconciliation identity. */
  refundClaimId?: string | null;
  refundClaimAt?: string | null;
  refundPaymentIntent?: string | null;
  /** Optional digital-to-print upgrade state. Admin/internal-only until a
   *  customer explicitly pays a separate upgrade checkout; never by itself
   *  releases a proof or submits a print job. */
  printUpgradeStatus?: PrintUpgradeStatus | null;
  printUpgradeSourceFormat?: BookFormat | null;
  printUpgradeTargetFormat?: BookFormat | null;
  printUpgradeAmountCents?: number | null;
  printUpgradeStripeSessionId?: string | null;
  printUpgradePaidAt?: string | null;
  printUpgradeOfferedAt?: string | null;
  printUpgradePrintProvider?: 'rpi' | 'lulu' | string | null;
  createdAt: string;
  updatedAt: string;
}

export type PrintUpgradeStatus =
  | 'pending'
  | 'cancelled'
  | 'offered'
  | 'checkout_open'
  | 'paid'
  | 'proof_required'
  | 'print_pending'
  | 'declined'
  | 'expired';

export type FamilyCharacterRole =
  | 'co-hero'
  | 'dad'
  | 'mom'
  | 'parent'
  | 'sibling'
  | 'grandparent'
  | 'pet'
  | 'whole-family'
  | 'other';

export type CharacterLikenessIntent = 'reference' | 'storybook';
export type CharacterMustInclude =
  | 'glasses'
  | 'hearing-aid'
  | 'wheelchair'
  | 'head-covering'
  | 'braces'
  | 'custom-detail';

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
  likenessIntent?: CharacterLikenessIntent | string | null;
  mustInclude?: CharacterMustInclude[] | string[] | null;
  mustIncludeOther?: string | null;
  /** Phase-A photo-assignment MVP: who to use from a multi-person photo. */
  focusPersonLabel?: string | null;
  /** Where that person sits in the photo, e.g. "center", "top-left". */
  cropHint?: string | null;
  /** Exact private intake tuple entry; never reinterpret pathname as a URL. */
  checkoutIntakeMedia?: FinalizedSelectionEntry | null;
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
  likenessIntent: CharacterLikenessIntent;
  mustInclude: CharacterMustInclude[];
  mustIncludeOther: string;
  focusPersonLabel: string | null;
  cropHint: string | null;
  /** Exact private intake tuple entry; never reinterpret pathname as a URL. */
  checkoutIntakeMedia?: FinalizedSelectionEntry | null;
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
const FAMILY_CHARACTER_MAX_FIELD = 80;
const FAMILY_CHARACTER_MAX_NOTES = 180;
const FAMILY_CHARACTER_ROLES = new Set<FamilyCharacterRole>([
  'co-hero',
  'dad',
  'mom',
  'parent',
  'sibling',
  'grandparent',
  'pet',
  'whole-family',
  'other',
]);
const CHARACTER_MUST_INCLUDE = new Set<CharacterMustInclude>([
  'glasses',
  'hearing-aid',
  'wheelchair',
  'head-covering',
  'braces',
  'custom-detail',
]);

function sanitizeMustInclude(value: unknown): CharacterMustInclude[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => cleanShortText(item, 40).toLowerCase())
        .filter((item): item is CharacterMustInclude =>
          CHARACTER_MUST_INCLUDE.has(item as CharacterMustInclude),
        ),
    ),
  ).slice(0, CHARACTER_MUST_INCLUDE.size);
}

function cleanShortText(value: unknown, max = FAMILY_CHARACTER_MAX_FIELD): string {
  return String(value ?? '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
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
      const photoFileName = cleanShortText(character?.photoFileName, 120) || null;
      const photoBlobPath = cleanShortText(character?.photoBlobPath, 500) || null;
      const photoBlobUrl = cleanShortText(character?.photoBlobUrl, 500) || null;
      const likenessIntent: CharacterLikenessIntent =
        photoFileName || photoBlobPath || photoBlobUrl ? 'reference' : 'storybook';
      return {
        role,
        name,
        relationshipLabel,
        pronouns,
        notes,
        isGiftRecipient: Boolean(character?.isGiftRecipient),
        appearsInStory: character?.appearsInStory === false ? false : true,
        photoFileName,
        photoBlobPath,
        photoBlobUrl,
        likenessIntent,
        mustInclude: sanitizeMustInclude(character?.mustInclude),
        mustIncludeOther: cleanShortText(character?.mustIncludeOther, 80),
        focusPersonLabel: cleanShortText(character?.focusPersonLabel, 120) || null,
        cropHint: cleanShortText(character?.cropHint, 40) || null,
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
  /**
   * Fulfillment routing intent, supplied by the creating WORKFLOW (not the
   * customer form). Pass-through only: when omitted the order's fulfillmentMode
   * stays undefined and fails closed. Current authorized creation workflows
   * explicitly pass `manual_hold`; any future `auto` workflow requires a
   * separate product/policy decision.
   */
  fulfillmentMode?: FulfillmentMode;
}

const FORMAT_META: Record<BookFormat, { label: string; priceCents: number }> = {
  digital: { label: 'Digital proof', priceCents: 1900 },
  classic: { label: 'Classic softcover', priceCents: 3900 },
  premium: { label: 'Premium hardcover', priceCents: 6400 },
};

export function getBookFormatMeta(bookFormat: BookFormat): { label: string; priceCents: number } {
  return FORMAT_META[bookFormat];
}

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
    return `Digital proof ${PROOF_TURNAROUND_PHRASE}; the full high-resolution PDF comes with it, and you approve when it is right.`;
  }

  if (format === 'premium') {
    return `Digital proof ${PROOF_TURNAROUND_PHRASE}. After approval, hardcover ships in 5–7 business days — free shipping included.`;
  }

  return `Digital proof ${PROOF_TURNAROUND_PHRASE}. After approval, softcover ships in 5–7 business days — free shipping included.`;
}

/**
 * Digital delivery expectations this codebase has persisted onto order records
 * and no longer tells the truth about. Both are proven from the history of
 * `buildDeliveryExpectation` in this file:
 *
 *   - "…final PDF delivered after approval." — 21 commits. False: the digital
 *     path emails the PDF once the build completes, before approval.
 *   - "PDF by email in ~15 minutes" — 15 commits. False: a minutes-scale SLA
 *     that no longer reflects the queue and was never re-approved.
 *
 * `PROOF_TURNAROUND_WINDOW` has only ever been "2–3 business days", so the
 * templated and literal forms of the first string resolve identically and this
 * set is exhaustive for the digital branch.
 */
const DEPRECATED_DIGITAL_EXPECTATIONS: ReadonlySet<string> = new Set([
  'Digital proof usually ready in 2–3 business days; final PDF delivered after approval.',
  'PDF by email in ~15 minutes',
]);

/**
 * Read-time normalization for `order.deliveryExpectation`.
 *
 * Old records keep their stored bytes — nothing here writes, and there is no
 * backfill — but a customer-rendered surface must not repeat a promise we now
 * know is false. Only the exact deprecated digital strings above are replaced;
 * every current value, every print-format value, and anything unrecognized is
 * passed through untouched. A missing or non-string value yields '' so a
 * surface renders nothing rather than inventing an expectation.
 *
 * Use this on customer-rendered paths only (status page, customer order route,
 * confirmation email). Internal diagnostics and audit exports keep raw bytes.
 */
export function renderDeliveryExpectation(stored: string | null | undefined): string {
  if (typeof stored !== 'string') return '';
  if (DEPRECATED_DIGITAL_EXPECTATIONS.has(stored.trim())) return buildDeliveryExpectation('digital');
  return stored;
}

export function createOrderRecord(input: OrderInput, options: CreateOrderOptions = {}): OrderRecord {
  const format = normalizeFormat(input.bookFormat);
  const meta = FORMAT_META[format];
  const now = options.now ?? new Date().toISOString();

  // Fully-custom hero contract (backward compatible). childName stays the
  // authoritative legacy field: derive it from heroName only when a caller
  // sends the new shape without childName, and always keep heroName populated
  // (defaulting to childName) so downstream code can read either.
  const heroNameInput = (input.heroName ?? '').trim();
  const childNameInput = (input.childName ?? '').trim();
  const resolvedChildName = childNameInput || heroNameInput;
  const resolvedHeroName = heroNameInput || childNameInput;
  const heroType = (input.heroType ?? '').trim() || 'child';

  return {
    id: options.id ?? `ord_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    childName: resolvedChildName,
    heroName: resolvedHeroName || null,
    heroType,
    heroAgeOrStage: input.heroAgeOrStage?.trim() || null,
    recipientName: input.recipientName?.trim() || null,
    recipientRelationship: input.recipientRelationship?.trim() || null,
    storyPerspective: input.storyPerspective?.trim() || null,
    heroPhotoFocusLabel: input.heroPhotoFocusLabel?.trim() || null,
    heroPhotoCropHint: input.heroPhotoCropHint?.trim() || null,
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
    appearanceOptions: input.appearanceOptions?.trim() || '',
    bookFormat: format,
    formatLabel: meta.label,
    priceCents: meta.priceCents,
    email: input.email.trim().toLowerCase(),
    photoFileName: input.photoFileName?.trim() || null,
    photoBlobPath: input.photoBlobPath?.trim() || null,
    photoBlobUrl: input.photoBlobUrl?.trim() || null,
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
    customStoryBrief: input.customStoryBrief ?? null,
    customStoryValidation: input.customStoryValidation ?? null,
    checkoutTracking: input.checkoutTracking ?? null,
    // Internal queue/status tracking starts empty; ops tooling populates it later.
    manualQueueEnteredAt: null,
    customerQueueStatus: null,
    lastQueueStatusUpdateAt: null,
    queueStatusNote: null,
    status: 'order_received',
    paymentStatus: 'pending',
    // Explicit workflow intent only; no default. Undefined ⇒ fail closed.
    ...(options.fulfillmentMode ? { fulfillmentMode: options.fulfillmentMode } : {}),
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
// Moved to ./blob-namespace.ts so subsystems that must not import this module
// (checkout intake, the checkout abuse guard) can share the SAME primitive
// rather than reimplementing it. Re-exported here because every existing
// caller imports it from `orders.ts`.
// Imported (not just re-exported) because this module calls it internally: a
// bare `export ... from` does not bind the name in this scope.
export { BlobNamespaceError, getBlobNamespace, withBlobNamespace };

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
 *   4. Otherwise null — the orchestrator decides whether this is an explicit
 *      storybook lane or a missing-reference failure from persisted order intent.
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

  // 4. No way to resolve — caller must consult orderRequiresReferenceImage.
  return null;
}

/** True when the persisted order contract says customer-photo conditioning is required. */
export function orderRequiresReferenceImage(
  order: Pick<OrderRecord, 'photoFileName' | 'photoBlobPath' | 'photoBlobUrl'>,
): boolean {
  return Boolean(
    order.photoFileName?.trim() ||
      order.photoBlobPath?.trim() ||
      order.photoBlobUrl?.trim(),
  );
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

function voiceExtForMime(mime: string): string {
  const normalized = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized === 'audio/webm') return 'webm';
  if (normalized === 'audio/ogg') return 'ogg';
  if (normalized === 'audio/mp4' || normalized === 'audio/x-m4a') return 'm4a';
  if (normalized === 'audio/aac') return 'aac';
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  if (normalized === 'text/plain') return 'txt';
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized === 'application/msword') return 'doc';
  if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  return 'bin';
}

/**
 * Upload an attached child-voice audio file to durable blob storage. Mirrors
 * uploadOrderPhoto's fail-before-Stripe contract in production-like envs.
 */
export async function uploadOrderVoice(
  orderId: string,
  file: File,
  checkoutLeaseId?: string,
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

  // Never derive durable identifiers from the caller-controlled filename.
  const assetId = crypto.randomBytes(12).toString('base64url');
  const scope = checkoutMediaScope(checkoutLeaseId);
  const pathname = withBlobNamespace(`orders/${orderId}/${scope}voice-${assetId}.${voiceExtForMime(file.type)}`);
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

  const validation = await validateOrderPhotoFile(file);
  if (!validation.ok) return null;

  // Never reuse caller-controlled bytes, filename, or content type in public
  // Blob storage. Validation above fully decodes and re-encodes one canonical
  // metadata-free JPEG before returning these bytes.
  const safeName = `upload.${validation.extension}`;

  const pathname = withBlobNamespace(pathnameForSafeName(safeName));
  const buffer = validation.normalizedBytes;

  try {
    const blob = await put(pathname, buffer, {
      access: getBlobAccessMode(),
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: validation.contentType,
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

function checkoutMediaScope(checkoutLeaseId?: string): string {
  if (!checkoutLeaseId) return '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkoutLeaseId)) {
    throw new OrderPersistenceError('unknown', 'invalid_checkout_media_scope');
  }
  return `checkout-${checkoutLeaseId}/`;
}

export async function uploadOrderPhoto(
  orderId: string,
  file: File,
  checkoutLeaseId?: string,
): Promise<UploadedPhotoRef | null> {
  const scope = checkoutMediaScope(checkoutLeaseId);
  return uploadOrderPhotoAtPath(orderId, file, (safeName) => `orders/${orderId}/${scope}photo-${safeName}`);
}

export async function uploadOrderSupportingPhoto(
  orderId: string,
  index: number,
  file: File,
  checkoutLeaseId?: string,
): Promise<UploadedPhotoRef | null> {
  const safeIndex = Number.isInteger(index) && index >= 0 ? index + 1 : 1;
  const scope = checkoutMediaScope(checkoutLeaseId);
  return uploadOrderPhotoAtPath(
    orderId,
    file,
    (safeName) => `orders/${orderId}/${scope}supporting-${safeIndex}-photo-${safeName}`,
  );
}

export interface OrderMediaRollbackDeps {
  deleteBlob?: (pathname: string) => Promise<void>;
}

/**
 * Delete media uploaded during a checkout that failed before its final order
 * record was persisted. Paths are constrained to the deterministic namespace
 * for this order so a caller can never turn cleanup into arbitrary Blob
 * deletion. Each object gets one retry before the failure is surfaced.
 */
export async function rollbackOrderMediaUploads(
  orderId: string,
  pathnames: readonly string[],
  checkoutLeaseId?: string,
  deps: OrderMediaRollbackDeps = {},
): Promise<number> {
  const uniquePaths = [...new Set(pathnames.filter(Boolean))];
  if (uniquePaths.length === 0) return 0;

  const scope = checkoutMediaScope(checkoutLeaseId);
  const expectedPrefix = withBlobNamespace(`orders/${orderId}/${scope}`);
  for (const pathname of uniquePaths) {
    const relative = pathname.slice(expectedPrefix.length);
    if (!pathname.startsWith(expectedPrefix)
      || !relative
      || relative.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new OrderPersistenceError(
        orderId,
        `Refusing checkout-media rollback outside the order namespace: ${pathname}`,
      );
    }
  }

  const token = getBlobToken();
  const deleteBlob = deps.deleteBlob ?? (token
    ? async (pathname: string) => { await del(pathname, { token }); }
    : null);
  if (!deleteBlob) {
    if (requiresDurablePersistence()) {
      throw new OrderPersistenceError(
        orderId,
        'BLOB_READ_WRITE_TOKEN missing in production — cannot roll back uploaded customer media',
      );
    }
    return 0;
  }

  const failures: Array<{ pathname: string; cause: unknown }> = [];
  for (const pathname of uniquePaths) {
    let deleted = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2 && !deleted; attempt += 1) {
      try {
        await deleteBlob(pathname);
        deleted = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!deleted) failures.push({ pathname, cause: lastError });
  }

  if (failures.length > 0) {
    throw new OrderPersistenceError(
      orderId,
      `Customer media rollback failed for ${failures.length} Blob object(s)`,
      failures,
    );
  }
  return uniquePaths.length;
}

function scrubRetiredPrivateFields(order: OrderRecord): OrderRecord {
  const sanitized = { ...order } as OrderRecord & Record<string, unknown>;
  // Legacy records can still carry the removed original voice filename. Derive
  // only a non-PII presence signal, then delete the value before generic order
  // code can copy, log, render, or persist it again.
  const retiredVoiceName = sanitized['voiceFileName'];
  if (typeof retiredVoiceName === 'string' && retiredVoiceName.trim()) {
    sanitized.legacyVoiceUploadPresent = true;
  }
  delete sanitized['voiceFileName'];
  return sanitized;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

export function checkoutIntakeOrderContractDigest(order: OrderRecord): string | null {
  try {
    // Explicit immutable allowlist. Payment, checkout lease, fulfillment,
    // review, email, refund, and print lifecycle fields are CAS-controlled and
    // intentionally absent so the digest remains valid after legitimate state
    // transitions.
    const projection = JSON.parse(JSON.stringify({
      id: order.id,
      checkoutAttemptId: order.checkoutAttemptId,
      checkoutFingerprint: order.checkoutFingerprint,
      createdAt: order.createdAt,
      fulfillmentMode: order.fulfillmentMode,
      childName: order.childName,
      childAge: order.childAge,
      childPronouns: order.childPronouns,
      heroName: order.heroName,
      heroType: order.heroType,
      heroAgeOrStage: order.heroAgeOrStage,
      recipientName: order.recipientName,
      recipientRelationship: order.recipientRelationship,
      storyPerspective: order.storyPerspective,
      heroPhotoFocusLabel: order.heroPhotoFocusLabel,
      heroPhotoCropHint: order.heroPhotoCropHint,
      theme: order.theme,
      lesson: order.lesson,
      occasion: order.occasion,
      giftMessage: order.giftMessage,
      characterNotes: order.characterNotes,
      familyCharacters: order.familyCharacters,
      appearanceOptions: order.appearanceOptions,
      bookFormat: order.bookFormat,
      formatLabel: order.formatLabel,
      priceCents: order.priceCents,
      email: order.email,
      photoFileName: order.photoFileName,
      photoBlobPath: order.photoBlobPath,
      photoBlobUrl: order.photoBlobUrl,
      guidedReferencePhotos: order.guidedReferencePhotos,
      voiceBlobPath: order.voiceBlobPath,
      voiceBlobUrl: order.voiceBlobUrl,
      voiceConsentAt: order.voiceConsentAt,
      voiceSource: order.voiceSource,
      voiceTranscript: order.voiceTranscript,
      customStoryBrief: order.customStoryBrief,
      customStoryValidation: order.customStoryValidation,
      checkoutTracking: order.checkoutTracking,
      checkoutIntake: order.checkoutIntake,
      primaryHeroIntakeMedia: order.primaryHeroIntakeMedia,
      guidedStillIntakeMedia: order.guidedStillIntakeMedia,
      voiceIntakeMedia: order.voiceIntakeMedia,
      documentIntakeMedia: order.documentIntakeMedia,
      deliveryExpectation: order.deliveryExpectation,
    })) as Record<string, unknown>;
    if (projection.checkoutIntake && typeof projection.checkoutIntake === 'object'
      && !Array.isArray(projection.checkoutIntake)) {
      delete (projection.checkoutIntake as Record<string, unknown>).orderContractDigest;
    }
    return crypto.createHash('sha256').update(stableJson(projection)).digest('hex');
  } catch {
    return null;
  }
}

function assertCheckoutIntakeOrderContract(order: OrderRecord): void {
  const binding = order.checkoutIntake;
  const retention = order.checkoutIntakeMediaRetention;
  const familyCharacters = Array.isArray(order.familyCharacters) ? order.familyCharacters : [];
  const projected = [
    order.primaryHeroIntakeMedia,
    order.guidedStillIntakeMedia,
    order.voiceIntakeMedia,
    order.documentIntakeMedia,
    ...familyCharacters.map((character) => character.checkoutIntakeMedia),
  ].some((value) => value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0));

  if (binding == null) {
    if (retention != null || projected) throw new Error('invalid checkout intake order contract');
    return;
  }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || !exactObjectKeys(binding as unknown as Record<string, unknown>, [
      'intakeId', 'fingerprint', 'orderContractDigest', 'selection',
    ])
    || !/^intake_[a-f0-9]{32}$/.test(binding.intakeId)
    || !/^[a-f0-9]{64}$/.test(binding.fingerprint)
    || !/^[a-f0-9]{64}$/.test(binding.orderContractDigest)
    || !Array.isArray(binding.selection)
    || binding.selection.length > 16) throw new Error('invalid checkout intake order contract');

  const namespace = getBlobNamespace();
  const selection = binding.selection.map((entry) => parseSelectionEntry(entry, binding.intakeId, namespace));
  const slots = new Set<string>();
  const assets = new Set<string>();
  const familyIndexes = new Set<number>();
  for (const entry of selection) {
    if (slots.has(entry.slotKey) || assets.has(entry.assetId)) throw new Error('invalid checkout intake order contract');
    slots.add(entry.slotKey);
    assets.add(entry.assetId);
    if (entry.familyCharacterIndex !== null) {
      if (familyIndexes.has(entry.familyCharacterIndex)) throw new Error('invalid checkout intake order contract');
      familyIndexes.add(entry.familyCharacterIndex);
    }
  }
  if (binding.fingerprint !== finalizationFingerprint(binding.intakeId, selection)) {
    throw new Error('invalid checkout intake order contract');
  }
  if (checkoutIntakeOrderContractDigest(order) !== binding.orderContractDigest) {
    throw new Error('invalid checkout intake order contract');
  }

  const byCategory = (category: FinalizedSelectionEntry['category']) =>
    selection.filter((entry) => entry.category === category);
  const primary = byCategory('primary_hero_photo');
  const family = byCategory('family_pet_reference');
  const guided = byCategory('guided_still').sort((a, b) => (a.guidedStillIndex ?? -1) - (b.guidedStillIndex ?? -1));
  const voice = byCategory('voice_inspiration');
  const document = byCategory('document_inspiration');
  if (primary.length > 1 || voice.length > 1 || document.length > 1
    || (voice.length > 0 && document.length > 0)
    || !sameJson(order.primaryHeroIntakeMedia ?? null, primary[0] ?? null)
    || !sameJson(order.guidedStillIntakeMedia ?? [], guided)
    || !sameJson(order.voiceIntakeMedia ?? null, voice[0] ?? null)
    || !sameJson(order.documentIntakeMedia ?? null, document[0] ?? null)
    || order.photoBlobPath != null || order.photoBlobUrl != null
    || order.voiceBlobPath != null || order.voiceBlobUrl != null) {
    throw new Error('invalid checkout intake order contract');
  }

  const familyProjected = familyCharacters
    .map((character) => character.checkoutIntakeMedia ?? null)
    .filter((entry): entry is FinalizedSelectionEntry => entry !== null);
  if (familyProjected.length !== family.length) throw new Error('invalid checkout intake order contract');
  for (const entry of family) {
    if (entry.familyCharacterIndex === null
      || !sameJson(familyCharacters[entry.familyCharacterIndex]?.checkoutIntakeMedia ?? null, entry)) {
      throw new Error('invalid checkout intake order contract');
    }
  }

  if (!retention || typeof retention !== 'object' || Array.isArray(retention)
    || !canonicalIso(retention.activatedAt)) throw new Error('invalid checkout intake media retention');
  const retentionKeys = retention.status === 'active'
    ? ['status', 'activatedAt']
    : retention.status === 'cleanup_claimed'
      ? ['status', 'activatedAt', 'cleanupClaimedAt']
      : retention.status === 'reclaimed'
        ? ['status', 'activatedAt', 'cleanupClaimedAt', 'reclaimedAt']
        : [];
  if (retentionKeys.length === 0
    || !exactObjectKeys(retention as unknown as Record<string, unknown>, retentionKeys)
    || (retention.status !== 'active' && !canonicalIso(retention.cleanupClaimedAt))
    || (retention.status === 'reclaimed' && !canonicalIso(retention.reclaimedAt))
    || Date.parse(retention.activatedAt) > Date.parse(order.updatedAt)
    || (retention.cleanupClaimedAt && Date.parse(retention.cleanupClaimedAt) < Date.parse(retention.activatedAt))
    || (retention.reclaimedAt && Date.parse(retention.reclaimedAt) < Date.parse(retention.cleanupClaimedAt ?? ''))) {
    throw new Error('invalid checkout intake media retention');
  }
  order.checkoutIntake = { ...binding, selection };
}

function parseOrderRecord(serialized: string): OrderRecord {
  const order = scrubRetiredPrivateFields(JSON.parse(serialized) as OrderRecord);
  assertCheckoutIntakeOrderContract(order);
  return order;
}

export async function persistOrder(order: OrderRecord) {
  // Claim the newest generation up front so any commit already in flight loses
  // its right to publish, then evict unconditionally in the `finally` below.
  // A throwing write does NOT imply nothing was stored — a timeout or reset on
  // the RESPONSE can leave the record written — so success-only invalidation
  // would re-create the exact staleness this guards against. Reading through is
  // always safe; keeping a possibly-superseded entry is not.
  beginOrderWrite(order.id);
  try {
    return await persistOrderUnsafe(order);
  } finally {
    // Bump AGAIN on completion. The generation orders write STARTS, not write
    // LANDINGS; an unconditional write carries no version token, so a commit
    // that started later but landed earlier would otherwise still hold the
    // newest generation and publish a record this write has just superseded.
    // Re-claiming here strips that right from anything still in flight.
    forgetRecentConditionalCommit(order.id, beginOrderWrite(order.id));
  }
}

async function persistOrderUnsafe(order: OrderRecord) {
  const token = getBlobToken();
  const sanitized = scrubRetiredPrivateFields(order);
  assertCheckoutIntakeOrderContract(sanitized);
  const serialized = JSON.stringify(sanitized, null, 2);
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      await put(getOrderBlobPath(order.id), serialized, {
        access: getBlobAccessMode(),
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
        // Mutable CAS record: forbid CDN caching so a later read-after-write
        // (or guarded commit) never observes an overwritten record as stale.
        cacheControlMaxAge: 0,
        token,
      });
      return sanitized;
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
  return sanitized;
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
        return text ? parseOrderRecord(text) : null;
      }

      const text = await readBlobText({ pathname: getOrderBlobPath(orderId), token });
      return text ? parseOrderRecord(text) : null;
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
    return parseOrderRecord(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function getOrderAuthoritative(
  orderId: string,
  deps: PublicVersionedReadDeps = {},
) {
  const token = getBlobToken();
  const requireDurable = requiresDurablePersistence();

  if (token) {
    try {
      if (getBlobAccessMode() === 'public') {
        const raw = await readAuthoritativeOrderBlobVersioned(getOrderBlobPath(orderId), token, deps);
        return raw ? parseOrderRecord(raw.body) : null;
      }
      const versioned = await readOrderVersioned(orderId);
      return versioned?.order ?? null;
    } catch (err) {
      if (requireDurable) {
        console.error(
          `[orders] getOrderAuthoritative: blob read failed in production-like env (orderId=${orderId}):`,
          err,
        );
        throw err;
      }
      console.warn(`[orders] getOrderAuthoritative blob read failed in dev for ${orderId}:`, err);
    }
  } else if (requireDurable) {
    console.error(
      `[orders] getOrderAuthoritative: BLOB_READ_WRITE_TOKEN is not set in a production-like environment (orderId=${orderId}).`,
    );
    throw new OrderPersistenceError(
      orderId,
      'BLOB_READ_WRITE_TOKEN missing in production — cannot read order authoritatively',
    );
  }

  try {
    const file = await readFile(`${getOrderStoreDir()}/${orderId}.json`, 'utf8');
    return parseOrderRecord(file);
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
          orders.push(parseOrderRecord(text));
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
        orders.push(parseOrderRecord(text));
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

/** Strict durable enumeration for recovery/cron paths.
 * Never falls back to ephemeral storage in production-like environments and
 * re-reads every listed order through the authoritative version-bound path. */
export async function listOrdersAuthoritative(deps: {
  listImpl?: typeof list;
  getOrderImpl?: typeof getOrderAuthoritative;
} = {}): Promise<OrderRecord[]> {
  const token = getBlobToken();
  if (!token) {
    if (requiresDurablePersistence()) {
      throw new OrderPersistenceError(
        'fulfillment-sweep',
        'BLOB_READ_WRITE_TOKEN missing in production — cannot enumerate orders authoritatively',
      );
    }
    return listOrders();
  }

  const listImpl = deps.listImpl ?? list;
  const getOrderImpl = deps.getOrderImpl ?? getOrderAuthoritative;
  const orders: OrderRecord[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await listImpl({
      prefix: getOrdersListPrefix(),
      token,
      ...(cursor ? { cursor } : {}),
    });
    for (const blob of page.blobs) {
      if (!blob.pathname.endsWith('.json')) continue;
      const orderId = blob.pathname.slice(getOrdersListPrefix().length, -'.json'.length);
      if (!orderId || orderId.includes('/')) continue;
      const order = await getOrderImpl(orderId);
      if (order) orders.push(order);
    }
    cursor = page.hasMore ? page.cursor : undefined;
    if (page.hasMore && !cursor) {
      throw new OrderPersistenceError(
        'fulfillment-sweep',
        'Blob listing reported hasMore without a cursor',
      );
    }
    if (cursor && seenCursors.has(cursor)) {
      throw new OrderPersistenceError(
        'fulfillment-sweep',
        'Blob listing repeated a cursor',
      );
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return orders;
}

export function isOrderStatus(value: string): value is OrderStatus {
  return ['order_received', 'preview_ready', 'print_in_production', 'shipped'].includes(value);
}

export async function updateOrderStatus(orderId: string, status: OrderStatus) {
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      const updated: OrderRecord = {
        ...current,
        status,
        updatedAt: new Date().toISOString(),
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}

type FulfillmentPatch = Partial<Pick<
  OrderRecord,
  | 'fulfillmentStatus'
  | 'fulfillmentKickoffAt'
  | 'fulfillmentKickoffId'
  | 'fulfillmentAttempts'
  | 'fulfillmentLastError'
  | 'storyArtifactUrl'
  | 'privateStoryArtifact'
  | 'layoutVersion'
  | 'storyMeta'
  | 'printInteriorArtifactUrl'
  | 'printInteriorMd5'
  | 'printInteriorPageCount'
  | 'printInteriorProofVersion'
  | 'printCoverArtifactUrl'
  | 'printCoverMd5'
  | 'printSubmissionAttemptedAt'
  | 'printSubmissionProofVersion'
  | 'printTitle'
  | 'proofApprovalToken'
  | 'proofApprovalTokenHash'
  | 'proofApprovalTokenExpiresAt'
  | 'proofApprovedAt'
  | 'customerProofReleasedAt'
  | 'proofReviewedAt'
  | 'proofSourceFingerprint'
  | 'proofVersion'
  | 'proofReviewedVersion'
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
  | 'emailResendClaimId'
  | 'emailResendClaimKind'
  | 'emailResendClaimArtifact'
  | 'emailResendClaimAt'
  | 'refundClaimId'
  | 'refundClaimAt'
  | 'refundPaymentIntent'
>>;

const PAYMENT_GATED_FULFILLMENT_STATUSES: FulfillmentStatus[] = [
  'generating_story',
  'generating_images',
  'building_pdf',
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
  if (patch.privateStoryArtifact !== undefined) return true;
  if (patch.pageArtifacts !== undefined) return true;
  if (patch.printInteriorArtifactUrl !== undefined) return true;
  if (patch.printCoverArtifactUrl !== undefined) return true;
  if (patch.proofApprovalToken !== undefined) return true;
  if (patch.proofApprovalTokenHash !== undefined) return true;
  if (patch.proofApprovalTokenExpiresAt !== undefined) return true;
  if (patch.customerProofReleasedAt !== undefined) return true;
  if (patch.printJobId !== undefined) return true;
  if (patch.status === 'preview_ready' || patch.status === 'print_in_production' || patch.status === 'shipped') return true;
  if (patch.fulfillmentStatus && PAYMENT_GATED_FULFILLMENT_STATUSES.includes(patch.fulfillmentStatus)) return true;
  return false;
}

export async function updateFulfillmentState(
  orderId: string,
  patch: FulfillmentPatch,
  existingOrder?: OrderRecord,
): Promise<OrderRecord | null> {
  // Fulfillment and customer review share one order record. Every merge must
  // therefore use the same versioned transaction boundary; an unconditional
  // read-merge-persist can overwrite a concurrent accept/regenerate/wording CAS.
  // `existingOrder` remains in the public signature for compatibility, but is
  // intentionally not trusted as a commit base because it may already be stale.
  void existingOrder;
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (
        current.refundClaimId
        && patch.refundedAt === undefined
        && patch.stripeRefundId === undefined
      ) {
        return { abort: null };
      }
      if (
        current.emailResendClaimId
        && (patch.internalDisposition !== undefined || patch.refundedAt !== undefined || patch.stripeRefundId !== undefined)
      ) {
        return { abort: null };
      }
      const effectivePaymentStatus = patch.paymentStatus ?? current.paymentStatus;
      if (patchRequiresPaidOrder(patch) && effectivePaymentStatus !== 'paid') {
        throw new Error(
          `[orders] Refusing fulfillment mutation for ${orderId}: paymentStatus=${effectivePaymentStatus}`,
        );
      }
      const updated: OrderRecord = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}

/** Explicit operator transition from a paid, undisposed order back to auto. */
export async function prepareOrderForAdminFulfillmentRetry(
  orderId: string,
): Promise<OrderRecord | null> {
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (current.paymentStatus !== 'paid' || current.refundedAt || current.stripeRefundId) {
        return { abort: null };
      }
      if (current.internalDisposition != null) return { abort: null };
      const status = current.fulfillmentStatus ?? 'not_started';
      if (!['not_started', 'failed_manual_review'].includes(status)) return { abort: null };
      if (
        current.fulfillmentKickoffId
        || current.printSubmissionAttemptedAt
        || current.printJobId
        || current.status === 'print_in_production'
        || current.status === 'shipped'
      ) return { abort: null };
      const updated: OrderRecord = {
        ...current,
        fulfillmentMode: 'auto',
        fulfillmentStatus: 'not_started',
        fulfillmentKickoffAt: null,
        fulfillmentKickoffId: null,
        fulfillmentAttempts: 0,
        fulfillmentLastError: null,
        updatedAt: new Date().toISOString(),
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
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
  // A caller-held record can already be stale even when its id matches. Append
  // against the versioned current record so audit writes cannot erase review CAS.
  void existingOrder;
  const entry: ReviewAuditEvent = {
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    ...(event.pageIndex != null ? { pageIndex: event.pageIndex } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.meta ? { meta: event.meta } : {}),
  };
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      const updated: OrderRecord = {
        ...current,
        auditEvents: [...(current.auditEvents ?? []), entry],
        updatedAt: new Date().toISOString(),
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}


// ── Guarded commit: optimistic CAS on the order record ──────────────────────
//
// CONCURRENCY MODEL
// -----------------
// The order-record ETag/ifMatch compare-and-swap is the ONLY correctness
// boundary for customer review mutations. There is deliberately no distributed
// lock: a list-derived generation lock can split-brain (generation 1 cleaned,
// generation 2 live, an eventually-consistent list hides generation 2, a
// contender recreates generation 1), and a lock cannot fence a durable write
// anyway — a holder can pause past its lease and resume after someone else
// committed.
//
// Instead every mutation is: read the order WITH its version → recompute the
// entire mutation against that record → write back only if the stored version
// is still exactly that token → on conflict, retry from a fresh read (bounded).
//
//   * Vercel Blob : put(..., { ifMatch: <etag> }); get() returns body + etag in
//                   ONE call, so the version always describes the bytes read.
//   * local FS    : an exclusive link()-claim keyed on the expected version plus
//                   a re-verify of the on-disk content hash, then atomic rename.
//
// Slow work (image generation, PDF rendering) runs strictly OUTSIDE the
// transaction and is bound to the state it was computed from by an explicit
// fingerprint, never by holding anything.

export class OrderVersionConflictError extends Error {
  readonly orderId: string;
  readonly attempts: number;
  constructor(orderId: string, attempts: number) {
    super(`Order ${orderId} was modified concurrently; gave up after ${attempts} attempt(s)`);
    this.name = 'OrderVersionConflictError';
    this.orderId = orderId;
    this.attempts = attempts;
  }
}

/** An order read together with the opaque version token needed to commit it. */
export interface VersionedOrder {
  order: OrderRecord;
  version: string;
}

export type ConditionalCommitResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'version_conflict' };

/**
 * Storage seam for versioned reads and conditional commits.
 *
 * `replaceIfVersion` MUST compare and write as ONE store-side operation. An
 * implementation that reads, compares in application code, then writes
 * unconditionally reintroduces the exact TOCTOU gap this exists to close.
 */
export interface OrderStoreAdapter {
  readonly kind: string;
  readVersioned(pathname: string): Promise<{ body: string; version: string } | null>;
  createIfAbsent(
    pathname: string,
    body: string,
  ): Promise<ConditionalCommitResult | { ok: false; reason: 'exists' }>;
  replaceIfVersion(
    pathname: string,
    body: string,
    expectedVersion: string,
  ): Promise<ConditionalCommitResult>;
}

function isPreconditionFailure(error: unknown): boolean {
  if (error instanceof BlobPreconditionFailedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /precondition|412|if-match|ifMatch/i.test(message);
}

function isBlobAlreadyExistsError(message: string): boolean {
  return /already exists|blob.*exist|409|conflict/i.test(message);
}

function isBlobNotFoundError(message: string): boolean {
  return /not ?found|404|BlobNotFound/i.test(message);
}

/**
 * Canonicalize an HTTP ETag validator so the SAME underlying version compares
 * equal across subsystems that decorate it differently. The Blob metadata API
 * (`list`) and the public CDN edge do not guarantee byte-identical ETag
 * representations for identical bytes — one may return a strong quoted value
 * (`"abc"`) while the other returns a weak (`W/"abc"`) or unquoted (`abc`)
 * form. Comparing the raw strings then reads an equivalent validator as a
 * foreign change and fails every CAS read (the production 503). We strip the
 * optional weak prefix, surrounding quotes, and whitespace before comparing.
 * Returns null for an absent/empty validator.
 */
export function normalizeEtag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (/^W\//i.test(value)) value = value.slice(2).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
  }
  return value.length ? value : null;
}

type PublicVersionedReadDeps = {
  listImpl?: (options: { prefix: string; token: string }) => Promise<{
    blobs: Array<{ pathname: string; url: string; downloadUrl?: string; etag: string }>;
  }>;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

const PUBLIC_VERSIONED_READ_MAX_ATTEMPTS = 3;

/**
 * Read a public-store order record together with the exact ETag of the bytes.
 *
 * `@vercel/blob#get(pathname, { access: 'public' })` sends an Authorization
 * header to the public Blob URL. The production public store rejects that
 * request with HTTP 400, so public order reads must use the URL returned by
 * `list()` and an unauthenticated fetch.
 *
 * The authoritative version is the ETag from `list()` (the Blob metadata API,
 * which is strongly consistent). The public CDN URL is used ONLY to retrieve
 * the bytes: per-attempt cache-busting plus `no-store` defeat any stale edge
 * copy, and order records are written with `cacheControlMaxAge: 0` so the CDN
 * revalidates rather than serving an overwritten record from cache.
 *
 * The fetched bytes are bound to that authoritative version by comparing the
 * CDN's own validator MODULO HTTP ETag decoration (weak/quoting) — never by raw
 * string identity, which reads an equivalent validator as a foreign change and
 * was the production defect. When the CDN omits a usable validator, coherence
 * is confirmed by re-listing and requiring the authoritative ETag to be
 * unchanged across the read (stable evidence). A genuine overwrite racing the
 * read moves the authoritative ETag and is retried, so a real competing writer
 * still fails closed rather than yielding stale bytes.
 */
export async function readPublicOrderBlobVersioned(
  pathname: string,
  token: string,
  deps: PublicVersionedReadDeps = {},
): Promise<{ body: string; version: string } | null> {
  const listImpl = deps.listImpl ?? ((options) => list(options));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleepImpl = deps.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const findBlob = (blobs: Array<{ pathname: string; url: string; downloadUrl?: string; etag: string }>) =>
    blobs.find((candidate) => candidate.pathname === pathname);

  for (let attempt = 1; attempt <= PUBLIC_VERSIONED_READ_MAX_ATTEMPTS; attempt += 1) {
    const { blobs } = await listImpl({ prefix: pathname, token });
    const blob = findBlob(blobs);
    if (!blob) return null;
    if (!blob.etag) {
      throw new Error('Public Blob list response omitted the order ETag');
    }
    const listVersion = normalizeEtag(blob.etag);

    // Use the download URL when available. Vercel's normal public URL can keep
    // serving the previous overwritten object for its fixed CDN max-age even
    // with a cache-busting query and `cache: no-store` (observed on a paid-order
    // kickoff immediately after the retry-state write). The download URL is a
    // separate, freshly revalidated representation of the same object; its ETag
    // is still bound to the authoritative metadata ETag below.
    const url = new URL(blob.downloadUrl ?? blob.url);
    url.searchParams.set('hsb-cas-read', `${Date.now()}-${attempt}`);
    const response = await fetchImpl(url, { cache: 'no-store' });

    if (response.status === 404 || response.status === 412) {
      await sleepImpl(500 * attempt);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Public Blob fetch failed: ${response.status} ${response.statusText}`.trim());
    }

    const body = await response.text();
    const responseVersion = normalizeEtag(response.headers.get('etag'));

    if (responseVersion) {
      // The CDN gave a validator: accept iff it matches the authoritative
      // version modulo decoration; otherwise the bytes are stale/advanced.
      if (responseVersion !== listVersion) {
        await sleepImpl(500 * attempt);
        continue;
      }
      return { body, version: blob.etag };
    }

    // No usable CDN validator: confirm the authoritative record did not advance
    // while we read it, so the bytes still correspond to `listVersion`.
    const confirm = await listImpl({ prefix: pathname, token });
    const confirmBlob = findBlob(confirm.blobs);
    if (!confirmBlob || normalizeEtag(confirmBlob.etag) !== listVersion) {
      await sleepImpl(500 * attempt);
      continue;
    }
    return { body, version: blob.etag };
  }

  throw new Error(
    `Public Blob changed during ${PUBLIC_VERSIONED_READ_MAX_ATTEMPTS} versioned read attempt(s)`,
  );
}

/**
 * Authoritative public-store read for payment/fulfillment safety boundaries.
 *
 * This binds the bytes to the strongly-consistent `list()` metadata record but
 * retrieves the body from the exact listed `downloadUrl`, avoiding stale public
 * CDN bytes immediately after an overwrite. Ordinary public read-only paths
 * stay on `blob.url`; this helper is intentionally narrow.
 */
export async function readAuthoritativeOrderBlobVersioned(
  pathname: string,
  token: string,
  deps: PublicVersionedReadDeps = {},
): Promise<{ body: string; version: string } | null> {
  const listImpl = deps.listImpl ?? ((options) => list(options));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const findBlob = (blobs: Array<{ pathname: string; url: string; etag: string; downloadUrl?: string }>) =>
    blobs.find((candidate) => candidate.pathname === pathname);

  for (let attempt = 1; attempt <= PUBLIC_VERSIONED_READ_MAX_ATTEMPTS; attempt += 1) {
    const { blobs } = await listImpl({ prefix: pathname, token });
    const blob = findBlob(blobs);
    if (!blob) return null;
    if (!blob.etag) {
      throw new Error('Authoritative Blob list response omitted the order ETag');
    }
    const listedVersion = normalizeEtag(blob.etag);
    const url = new URL(
      blob.downloadUrl || `${blob.url}${blob.url.includes('?') ? '&' : '?'}download=1`,
    );
    url.searchParams.set('hsb-authoritative-read', `${Date.now()}-${attempt}`);

    const response = await fetchImpl(url, { cache: 'no-store' });
    if (response.status === 404 || response.status === 412) continue;
    if (!response.ok) {
      throw new Error(`Authoritative Blob fetch failed: ${response.status} ${response.statusText}`.trim());
    }

    const body = await response.text();
    const responseVersion = normalizeEtag(response.headers.get('etag'));
    if (!responseVersion || responseVersion !== listedVersion) continue;
    return { body, version: blob.etag };
  }

  throw new Error(
    `Authoritative Blob changed during ${PUBLIC_VERSIONED_READ_MAX_ATTEMPTS} versioned read attempt(s)`,
  );
}

function blobOrderStoreAdapter(token: string): OrderStoreAdapter {
  return {
    kind: 'blob',
    async readVersioned(pathname) {
      try {
        if (getBlobAccessMode() === 'public') {
          return await readPublicOrderBlobVersioned(pathname, token);
        }
        const access = getBlobAccessMode();
        // get() returns the body stream AND the etag in a single call, so the
        // version token always describes exactly the bytes we read. This SDK
        // path is private-store only; public-store reads use the helper above.
        const result = await get(pathname, {
          access,
          token,
          useCache: false,
        });
        if (!result || !result.stream) return null;
        const body = await new Response(result.stream).text();
        return { body, version: result.blob.etag };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof BlobNotFoundError || isBlobNotFoundError(message)) return null;
        throw new OrderPersistenceError(
          pathname,
          `Versioned order read failed: ${sanitizeBlobErrorMessage(message)}`,
          error,
        );
      }
    },
    async createIfAbsent(pathname, body) {
      try {
        const res = await put(pathname, body, {
          access: getBlobAccessMode(),
          token,
          allowOverwrite: false,
          addRandomSuffix: false,
          contentType: 'application/json',
          // Mutable CAS record — never serve an overwritten copy from CDN cache.
          cacheControlMaxAge: 0,
        });
        return { ok: true, version: res.etag };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isBlobAlreadyExistsError(message)) return { ok: false, reason: 'exists' };
        throw error;
      }
    },
    async replaceIfVersion(pathname, body, expectedVersion) {
      try {
        // THE atomic primitive: the store compares the stored ETag with
        // `ifMatch` and performs the write only if they are equal.
        const res = await put(pathname, body, {
          access: getBlobAccessMode(),
          token,
          allowOverwrite: true,
          addRandomSuffix: false,
          contentType: 'application/json',
          // Mutable CAS record — never serve an overwritten copy from CDN cache.
          cacheControlMaxAge: 0,
          ifMatch: expectedVersion,
        });
        return { ok: true, version: res.etag };
      } catch (error) {
        if (isPreconditionFailure(error)) return { ok: false, reason: 'version_conflict' };
        throw error;
      }
    },
  };
}

function orderVersionOf(body: string): string {
  return `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
}

function parentDirOf(p: string) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}

function localOrderStoreAdapter(): OrderStoreAdapter {
  // MUST mirror the layout persistOrder()/getOrder() use for the local store:
  // the blob pathname is `<namespace>/orders/<id>.json`, and on disk that same
  // record lives at `<storeDir>/<id>.json`.
  const basenameOf = (pathname: string) => pathname.slice(pathname.lastIndexOf('/') + 1);
  const fileFor = (pathname: string) => `${getOrderStoreDir()}/${basenameOf(pathname)}`;
  const claimFor = (pathname: string, version: string) =>
    `${getOrderStoreDir()}/.cas/${basenameOf(pathname)}.${version.replace(/[^a-z0-9]/gi, '')}.claim`;

  const readRaw = async (file: string): Promise<string | null> => {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  return {
    kind: 'local',
    async readVersioned(pathname) {
      const body = await readRaw(fileFor(pathname));
      if (body === null) return null;
      return { body, version: orderVersionOf(body) };
    },
    async createIfAbsent(pathname, body) {
      const file = fileFor(pathname);
      await mkdir(parentDirOf(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      await writeFile(tmp, body, 'utf8');
      try {
        await link(tmp, file); // atomic exclusive create
        return { ok: true, version: orderVersionOf(body) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'exists' };
        throw error;
      } finally {
        await unlink(tmp).catch(() => {});
      }
    },
    async replaceIfVersion(pathname, body, expectedVersion) {
      const file = fileFor(pathname);
      const claim = claimFor(pathname, expectedVersion);
      await mkdir(parentDirOf(claim), { recursive: true });
      await mkdir(parentDirOf(file), { recursive: true });

      // Exclusively claim the right to advance FROM `expectedVersion`. Two
      // writers holding the same expected version cannot both claim it.
      const claimTmp = `${claim}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      await writeFile(claimTmp, expectedVersion, 'utf8');
      let claimed = false;
      try {
        try {
          await link(claimTmp, claim);
          claimed = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return { ok: false, reason: 'version_conflict' };
          }
          throw error;
        }
        const current = await readRaw(file);
        if (current === null || orderVersionOf(current) !== expectedVersion) {
          return { ok: false, reason: 'version_conflict' };
        }
        const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, file);
        return { ok: true, version: orderVersionOf(body) };
      } finally {
        await unlink(claimTmp).catch(() => {});
        if (claimed) await unlink(claim).catch(() => {});
      }
    },
  };
}

let orderStoreAdapterFactoryOverride: ((token: string | undefined) => OrderStoreAdapter) | null = null;

/** Test seam: substitute the versioned store to exercise exact CAS semantics. */
export function __setOrderStoreAdapterFactoryForTests(
  factory: ((token: string | undefined) => OrderStoreAdapter) | null,
): void {
  orderStoreAdapterFactoryOverride = factory;
}

export function __resetOrderStoreAdapterFactoryForTests(): void {
  orderStoreAdapterFactoryOverride = null;
  recentConditionalCommits.clear();
  orderWriteGeneration.clear();
  retractedOrderWrites.clear();
}

function resolveOrderStoreAdapter(): OrderStoreAdapter {
  const token = getBlobToken();
  if (orderStoreAdapterFactoryOverride) return orderStoreAdapterFactoryOverride(token);
  if (token) return blobOrderStoreAdapter(token);
  if (requiresDurablePersistence()) {
    throw new OrderPersistenceError(
      'unknown',
      'BLOB_READ_WRITE_TOKEN missing in production — cannot perform a guarded order commit',
    );
  }
  return localOrderStoreAdapter();
}

/** A cached commit, tagged with the write generation that published it. */
interface CachedCommit extends VersionedOrder {
  generation: number;
}

const recentConditionalCommits = new Map<string, CachedCommit>();

/**
 * Monotonic per-order write generation.
 *
 * Every writer bumps this SYNCHRONOUSLY before it starts, and may only publish
 * a cache entry afterwards if its own generation is still the newest. Without
 * it, `recentConditionalCommits.set` runs after an `await` with no
 * happens-before relation to any other writer, so a slow acknowledgement can
 * re-insert a record the store has already moved past — resurrecting the very
 * staleness the cache eviction is meant to prevent. That is reachable from two
 * ordinary concurrent `withOrderTransaction` calls, with no direct write
 * involved at all.
 *
 * UNBOUNDED, deliberately — as is `recentConditionalCommits`, which predates
 * this and holds whole order records rather than a number. Serverless instances
 * recycle. If a TTL/LRU is ever added, it MUST prune all three structures
 * (cache, generations, retractions) together
 * and MUST NOT lower a per-order counter while a cache entry for that order
 * survives: a reset counter reissues a generation the surviving entry already
 * claims, after which nothing can publish or evict for that order again.
 */
const orderWriteGeneration = new Map<string, number>();

/**
 * Proven-no-write generations awaiting fold-down, keyed by order id.
 *
 * An entry strands permanently when the generation above it belongs to a writer
 * that published, since publishers never retract — so for a hot order this set
 * grows with the number of lost CAS attempts. Bounded by the same recycling
 * argument as the other two maps, and covered by the pruning warning above.
 */
const retractedOrderWrites = new Map<string, Set<number>>();

/** Claim the newest write generation for this order. Synchronous by contract. */
function beginOrderWrite(orderId: string): number {
  const next = (orderWriteGeneration.get(orderId) ?? 0) + 1;
  orderWriteGeneration.set(orderId, next);
  return next;
}

/** True when no newer write has started since `generation` was claimed. */
function isNewestOrderWrite(orderId: string, generation: number): boolean {
  return orderWriteGeneration.get(orderId) === generation;
}

/**
 * Give a claim back when the write PROVABLY did not happen.
 *
 * A claim exists to say "I may have written, so nothing older than me may
 * publish". A writer that is proven not to have written — a lost CAS, or a
 * create that lost to an existing record — makes no such claim truthfully, and
 * leaving it standing silently strips the publish right from the writer that
 * actually won. That costs a cache entry, and a missing entry pushes the next
 * guarded read onto the fail-closed public-blob path.
 *
 * Retractions must fold in ANY completion order, not just newest-first. Two
 * concurrent no-writers that finish oldest-first would otherwise strand the
 * counter on a value no live writer holds — and a stranded counter suppresses
 * the publish of the writer that actually won, emptying the cache and pushing
 * the next guarded read onto the fail-closed path. So a retraction that is not
 * currently the top is remembered, and the counter is unwound as far as the
 * recorded retractions allow.
 *
 * This can never lower the counter past a live writer: only proven no-writers
 * are ever recorded, and a proven no-writer never publishes. Generations are
 * therefore reusable, but only by writers that have provably written nothing.
 */
function retractOrderWrite(orderId: string, generation: number): void {
  const retracted = retractedOrderWrites.get(orderId) ?? new Set<number>();
  retracted.add(generation);
  retractedOrderWrites.set(orderId, retracted);

  let top = orderWriteGeneration.get(orderId) ?? 0;
  while (retracted.delete(top)) top -= 1;

  if (top <= 0) orderWriteGeneration.delete(orderId);
  else orderWriteGeneration.set(orderId, top);
  if (retracted.size === 0) retractedOrderWrites.delete(orderId);
}

/**
 * Drop this order's read-your-own-writes entry — but NEVER one published by a
 * newer write than `generation`.
 *
 * Evicting is not free. `getBlobAccessMode()` defaults to `'public'`, so a
 * guarded read that misses the cache goes through `readPublicOrderBlobVersioned`,
 * which FAILS CLOSED by throwing when the CDN validator moves under it. The
 * cache is therefore not a latency optimisation — it is what lets a follow-up
 * mutation skip a read that can hard-fail. Every unnecessary eviction converts a
 * guaranteed-correct cache hit into a possible 5xx (the shape PR #137 fixed).
 *
 * So a writer may only clear what it has authority over: its own record, or one
 * older than it. Omitting `generation` means "clear unconditionally", which is
 * only for the test reset hook.
 */
function forgetRecentConditionalCommit(orderId: string, generation?: number): void {
  if (generation !== undefined) {
    const existing = recentConditionalCommits.get(orderId);
    if (existing && existing.generation > generation) return; // a newer write owns it
  }
  recentConditionalCommits.delete(orderId);
}

/**
 * Publish the record a commit just wrote.
 *
 * Two guards, both necessary:
 *  - if a newer write began while this one was in flight, this record may
 *    already be superseded, so it must not be published;
 *  - if a newer write already published, its entry must not be clobbered.
 *
 * A superseded writer clears only entries not newer than its own, so it can
 * tidy up after itself without destroying a fresher writer's correct entry.
 */
function publishConditionalCommit(
  order: OrderRecord,
  version: string,
  generation: number,
): void {
  if (!isNewestOrderWrite(order.id, generation)) {
    forgetRecentConditionalCommit(order.id, generation);
    return;
  }
  // Defence in depth. Unreachable today — but NOT because generations are
  // unique; retraction hands numbers back, so they are reused. It holds because
  // the counter can never fall below a surviving entry's generation: only
  // proven no-writers retract, and a proven no-writer never publishes.
  const existing = recentConditionalCommits.get(order.id);
  if (existing && existing.generation > generation) return;
  recentConditionalCommits.set(order.id, {
    order: scrubRetiredPrivateFields(order),
    version,
    generation,
  });
}

/** Read an order together with its CAS version token. */
export async function readOrderVersioned(
  orderId: string,
  opts: { preferRecentCommit?: boolean } = {},
): Promise<VersionedOrder | null> {
  if (opts.preferRecentCommit) {
    const recent = recentConditionalCommits.get(orderId);
    if (recent) return recent;
  }
  const adapter = resolveOrderStoreAdapter();
  const raw = await adapter.readVersioned(getOrderBlobPath(orderId));
  if (!raw) return null;
  let parsed: OrderRecord;
  try {
    parsed = parseOrderRecord(raw.body);
  } catch (error) {
    throw new OrderPersistenceError(orderId, 'Stored order record is not valid JSON', error);
  }
  return { order: parsed, version: raw.version };
}

/** Create a new order only when its deterministic record path is absent. */
export async function persistNewOrder(order: OrderRecord): Promise<OrderRecord> {
  const sanitized = scrubRetiredPrivateFields(order);
  assertCheckoutIntakeOrderContract(sanitized);
  const adapter = resolveOrderStoreAdapter();
  // NO up-front generation claim here, unlike persistOrder. A create that loses
  // to an existing record is a provable no-write, and an up-front claim would
  // suppress the publish of a commit already in flight — destroying a valid
  // entry by a second route, which is exactly what this function must not do.
  // The claim in the `finally` dominates anyway: it runs strictly after the
  // write, so it still invalidates anything published mid-flight.
  //
  // A `reason: 'exists'` result is a PROVABLE no-write in both adapters (blob
  // rejects with BlobAlreadyExists under allowOverwrite:false; the local store
  // gets EEXIST from link() and unlinks its temp file; a `put` retry that
  // re-reports AlreadyExists for our own earlier write is equally harmless,
  // since no cache entry can exist for an order whose record was absent).
  // Such a call has
  // authority over nothing, so evicting would destroy another writer's valid
  // entry and push the next guarded read onto the fail-closed public-blob path.
  // A THROW, by contrast, stays ambiguous and must still evict.
  let mayHaveWritten = true;
  try {
    const created = await adapter.createIfAbsent(
      getOrderBlobPath(order.id),
      JSON.stringify(sanitized, null, 2),
    );
    if (!created.ok) {
      // ONLY `exists` is provable. The adapter type permits other failure
      // reasons, and a test double may return one; anything else stays
      // ambiguous and must still evict.
      if ('reason' in created && created.reason === 'exists') mayHaveWritten = false;
      throw new OrderPersistenceError(order.id, 'Refusing to overwrite an existing order during creation');
    }
    return sanitized;
  } finally {
    // Same reasoning as persistOrder: re-claim on completion.
    if (mayHaveWritten) forgetRecentConditionalCommit(order.id, beginOrderWrite(order.id));
  }
}

export async function persistOrResumeCheckoutOrder(
  order: OrderRecord,
  opts: { now?: Date } = {},
): Promise<OrderRecord> {
  try {
    return await persistNewOrder(order);
  } catch (error) {
    const existing = await getOrderAuthoritative(order.id);
    if (!(error instanceof OrderPersistenceError)
      || existing?.paymentStatus !== 'pending'
      || (existing.checkoutIntakeMediaRetention?.status !== undefined
        && existing.checkoutIntakeMediaRetention.status !== 'active')
      || !order.checkoutFingerprint
      || existing.checkoutAttemptId !== order.checkoutAttemptId
      || existing.checkoutFingerprint !== order.checkoutFingerprint) throw error;

    // A completed create-before-bind retry may immediately resume the exact
    // already-bound Session. No media or order mutation is needed in that path.
    if (existing.stripeSessionId) return existing;

    const now = opts.now ?? new Date();
    const leaseExpiresAt = Date.parse(existing.checkoutLeaseExpiresAt ?? '');
    if (existing.checkoutLeaseId && Number.isFinite(leaseExpiresAt) && leaseExpiresAt > now.getTime()) {
      throw new OrderPersistenceError(order.id, 'checkout_attempt_in_progress');
    }

    const claimed = await withOrderTransaction<OrderRecord | null>(order.id, (current) => {
      if (current.paymentStatus !== 'pending'
        || (current.checkoutIntakeMediaRetention?.status !== undefined
          && current.checkoutIntakeMediaRetention.status !== 'active')
        || current.stripeSessionId
        || current.checkoutAttemptId !== order.checkoutAttemptId
        || current.checkoutFingerprint !== order.checkoutFingerprint) {
        return { abort: null };
      }
      const currentExpiry = Date.parse(current.checkoutLeaseExpiresAt ?? '');
      if (current.checkoutLeaseId && Number.isFinite(currentExpiry) && currentExpiry > now.getTime()) {
        return { abort: null };
      }
      const updated = {
        ...current,
        checkoutLeaseId: order.checkoutLeaseId,
        checkoutLeaseExpiresAt: order.checkoutLeaseExpiresAt,
      };
      return { commit: updated, result: updated };
    });
    if (claimed) return claimed;
    throw error;
  }
}

/** Atomically verify ownership and extend the checkout lease before a slow side effect. */
export async function renewCheckoutLease(
  orderId: string,
  checkoutLeaseId: string,
  checkoutFingerprint: string,
  opts: { now?: Date; leaseMs?: number } = {},
): Promise<OrderRecord | null> {
  const now = opts.now ?? new Date();
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  return withOrderTransaction<OrderRecord | null>(orderId, (current) => {
    if (current.paymentStatus !== 'pending'
      || (current.checkoutIntakeMediaRetention?.status !== undefined
        && current.checkoutIntakeMediaRetention.status !== 'active')
      || current.stripeSessionId
      || current.checkoutLeaseId !== checkoutLeaseId
      || current.checkoutFingerprint !== checkoutFingerprint) {
      return { abort: null };
    }
    const updated = {
      ...current,
      checkoutLeaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    };
    return { commit: updated, result: updated };
  });
}

/**
 * Commit an order record only if the stored version is still `expectedVersion`.
 *
 * This function OWNS the `recentConditionalCommits` invariant. It is exported
 * and called directly outside `withOrderTransaction` (e.g. the print rebuild in
 * rebuild-print-order.ts), so cache maintenance lives here rather than in the
 * transaction helper — otherwise every such caller silently advances the store
 * while leaving a stale entry behind, and the next guarded transaction decides
 * against superseded state.
 */
export async function commitOrderConditional(
  order: OrderRecord,
  expectedVersion: string,
): Promise<ConditionalCommitResult> {
  const adapter = resolveOrderStoreAdapter();
  // Claimed synchronously, before any await, so a concurrent writer cannot
  // interleave between the claim and the write.
  const generation = beginOrderWrite(order.id);
  let result: ConditionalCommitResult;
  try {
    const sanitized = scrubRetiredPrivateFields(order);
    assertCheckoutIntakeOrderContract(sanitized);
    result = await adapter.replaceIfVersion(
      getOrderBlobPath(order.id),
      JSON.stringify(sanitized, null, 2),
      expectedVersion,
    );
  } catch (error) {
    // Ambiguous: the write may or may not have landed, so anything this write
    // or an older one published is suspect. A newer writer's entry is not.
    forgetRecentConditionalCommit(order.id, generation);
    throw error;
  }
  if (result.ok) {
    publishConditionalCommit(order, result.version, generation);
  }
  // A LOST CAS deliberately evicts nothing. This write did not land, so it
  // learned nothing about current truth — and the entry it would have evicted
  // belongs to the writer that WON and is still correct. Evicting here is what
  // reopens the fail-closed public-blob read (see forgetRecentConditionalCommit).
  // The transaction retry does not need it either: attempt 2+ reads with
  // preferRecentCommit: false and so always re-reads authoritative state.
  //
  // It must also give its CLAIM back. A lost CAS is a provable no-write, so
  // holding the newest generation can suppress the publish of the writer that
  // actually won — the same lost cache entry, reached a different way.
  //
  // This closes the case where the retraction happens BEFORE the winner's
  // acknowledgement resolves. The reverse ordering — a loser that claims before
  // the winner publishes and retracts after — still costs that publish, because
  // the winner has already given up by then. That is a cache MISS, not a wrong
  // answer: the read path retries with backoff and the store is authoritative.
  // Recovering it would mean stashing the suppressed record and replaying it on
  // fold-down, which is a fourth structure; deliberately not built here.
  else retractOrderWrite(order.id, generation);
  return result;
}

// ── Pure record transforms (compose a whole mutation before committing) ─────

/** Pure equivalent of updateFulfillmentState's merge. Performs no I/O. */
export function applyFulfillmentPatchTo(
  existing: OrderRecord,
  patch: FulfillmentPatch,
  now: string = new Date().toISOString(),
): OrderRecord {
  const effectivePaymentStatus = patch.paymentStatus ?? existing.paymentStatus;
  if (patchRequiresPaidOrder(patch) && effectivePaymentStatus !== 'paid') {
    throw new Error(
      `[orders] Refusing fulfillment mutation for ${existing.id}: paymentStatus=${effectivePaymentStatus}`,
    );
  }
  return { ...existing, ...patch, updatedAt: now };
}

/** Pure equivalent of appendAuditEvent's append. Performs no I/O. */
export function appendAuditEventTo(
  existing: OrderRecord,
  event: Omit<ReviewAuditEvent, 'at'> & { at?: string },
  now: string = new Date().toISOString(),
): OrderRecord {
  const entry: ReviewAuditEvent = {
    at: event.at ?? now,
    type: event.type,
    ...(event.pageIndex != null ? { pageIndex: event.pageIndex } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.meta ? { meta: event.meta } : {}),
  };
  return { ...existing, auditEvents: [...(existing.auditEvents ?? []), entry], updatedAt: now };
}

// ── The guarded transaction ────────────────────────────────────────────────

export type OrderTransactionOutcome<T> =
  | { commit: OrderRecord; result: T }
  | { abort: T };

export const ORDER_TRANSACTION_MAX_ATTEMPTS = 5;

/**
 * Whole-mutation optimistic CAS with bounded retry.
 *
 * On every attempt the order is re-read WITH its version, the caller recomputes
 * the entire intended mutation against that fresh record (so all approval,
 * capability and payment invariants are re-evaluated on the latest state, and
 * unrelated concurrent changes are carried forward rather than clobbered), and
 * the result is committed conditionally on that version.
 */
export async function withOrderTransaction<T>(
  orderId: string,
  mutate: (order: OrderRecord) => Promise<OrderTransactionOutcome<T>> | OrderTransactionOutcome<T>,
  opts: { maxAttempts?: number; notFound?: () => T } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? ORDER_TRANSACTION_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await readOrderVersioned(orderId, { preferRecentCommit: attempt === 1 });
    if (!current) {
      if (opts.notFound) return opts.notFound();
      throw new OrderPersistenceError(orderId, 'Order not found for guarded commit');
    }
    const outcome = await mutate(current.order);
    if ('abort' in outcome) return outcome.abort;
    // commitOrderConditional owns the cache: it publishes the committed record
    // when this write is still the newest, and evicts otherwise. Doing it here
    // as well would re-introduce an unguarded `set` after the await.
    const committed = await commitOrderConditional(outcome.commit, current.version);
    if (committed.ok) return outcome.result;
  }
  throw new OrderVersionConflictError(orderId, maxAttempts);
}

export async function updateOrderPayment(
  orderId: string,
  paymentStatus: PaymentStatus,
  opts: {
    stripeSessionId?: string;
    stripePaymentIntentId?: string;
    shippingAddress?: ShippingAddress;
    settledAmountCents?: number;
  } = {},
) {
  const now = new Date().toISOString();
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (paymentStatus === 'paid') {
        if (
          current.paymentStatus === 'paid'
          && (!opts.stripeSessionId || current.stripeSessionId === opts.stripeSessionId)
          && (!opts.stripePaymentIntentId
            || !current.stripePaymentIntentId
            || current.stripePaymentIntentId === opts.stripePaymentIntentId)
          && !current.refundedAt
          && !current.stripeRefundId
          && !current.refundClaimId
        ) {
          const replay = {
            ...current,
            ...(current.settledAmountCents == null && opts.settledAmountCents != null
              ? { settledAmountCents: opts.settledAmountCents }
              : {}),
            ...(current.stripePaymentIntentId == null && opts.stripePaymentIntentId != null
              ? { stripePaymentIntentId: opts.stripePaymentIntentId }
              : {}),
            updatedAt: now,
          };
          return { commit: replay, result: replay };
        }
        if (
          current.paymentStatus !== 'pending'
          || current.refundedAt
          || current.stripeRefundId
          || current.refundClaimId
          || !opts.stripeSessionId
          || current.stripeSessionId !== opts.stripeSessionId
        ) return { abort: null };
      }
      const updated: OrderRecord = {
        ...current,
        paymentStatus,
        ...(opts.stripeSessionId != null ? { stripeSessionId: opts.stripeSessionId } : {}),
        ...(opts.stripePaymentIntentId != null ? { stripePaymentIntentId: opts.stripePaymentIntentId } : {}),
        ...(opts.shippingAddress != null ? { shippingAddress: opts.shippingAddress } : {}),
        ...(paymentStatus === 'paid' && opts.settledAmountCents != null
          ? { settledAmountCents: opts.settledAmountCents }
          : {}),
        ...(paymentStatus === 'paid' && !current.paidAt ? { paidAt: now } : {}),
        updatedAt: now,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}

export type StripeTerminalPaymentEventType =
  | 'charge.refunded'
  | 'charge.dispute.created'
  | 'checkout.session.async_payment_failed';

export interface StripeTerminalPaymentStateInput {
  stripeEventId: string;
  eventType: StripeTerminalPaymentEventType;
  providerObjectId: string;
  stripeSessionId?: string | null;
  paymentIntentId?: string | null;
  identitySource?: 'payment_intent_index' | 'event_metadata' | null;
  refundKind?: 'full' | 'partial' | null;
  refundedAmountCents?: number | null;
  reversalId?: string | null;
  occurredAt: string;
}

export type StripeTerminalPaymentStateResult =
  | { outcome: 'converged'; order: OrderRecord }
  | { outcome: 'already_terminal'; order: OrderRecord }
  | { outcome: 'identity_mismatch'; order: OrderRecord };

/** Atomically record a terminal state from an already verified Stripe event. */
export async function recordStripeTerminalPaymentState(
  orderId: string,
  input: StripeTerminalPaymentStateInput,
): Promise<StripeTerminalPaymentStateResult | null> {
  const now = new Date().toISOString();
  return withOrderTransaction<StripeTerminalPaymentStateResult | null>(
    orderId,
    (current) => {
      const priorEvent = (current.auditEvents ?? []).some((event) =>
        event.type === 'payment_terminal_state_recorded'
        && event.meta?.stripeEventId === input.stripeEventId,
      );
      if (priorEvent) return { abort: { outcome: 'already_terminal', order: current } };

      const isAsyncFailure = input.eventType === 'checkout.session.async_payment_failed';
      if (isAsyncFailure) {
        if (!input.stripeSessionId || current.stripeSessionId !== input.stripeSessionId) {
          return { abort: { outcome: 'identity_mismatch', order: current } };
        }
      } else if (!input.paymentIntentId || !current.stripeSessionId) {
        return { abort: { outcome: 'identity_mismatch', order: current } };
      } else if (
        current.stripePaymentIntentId
        && current.stripePaymentIntentId !== input.paymentIntentId
      ) {
        return { abort: { outcome: 'identity_mismatch', order: current } };
      } else if (!current.stripePaymentIntentId && input.identitySource !== 'event_metadata') {
        return { abort: { outcome: 'identity_mismatch', order: current } };
      } else if (input.eventType === 'charge.refunded' && !input.refundKind) {
        return { abort: { outcome: 'identity_mismatch', order: current } };
      }

      const auditEvent: ReviewAuditEvent = {
        at: now,
        type: 'payment_terminal_state_recorded',
        reason: input.eventType,
        meta: {
          source: 'stripe_webhook',
          stripeEventId: input.stripeEventId,
          stripeEventType: input.eventType,
          providerObjectId: input.providerObjectId,
          stripeSessionId: input.stripeSessionId ?? null,
          paymentIntentId: input.paymentIntentId ?? null,
          identitySource: input.identitySource ?? null,
          refundKind: input.refundKind ?? null,
          refundedAmountCents: input.refundedAmountCents ?? null,
        },
      };

      if (isAsyncFailure) {
        // A delayed failure must never downgrade paid/refunded state.
        if (current.paymentStatus !== 'pending') {
          return { abort: { outcome: 'already_terminal', order: current } };
        }
        const updated: OrderRecord = {
          ...current,
          paymentStatus: 'failed',
          fulfillmentLastError: 'stripe_async_payment_failed',
          auditEvents: [...(current.auditEvents ?? []), auditEvent],
          updatedAt: now,
        };
        return { commit: updated, result: { outcome: 'converged', order: updated } };
      }

      const isPartialRefund = input.eventType === 'charge.refunded' && input.refundKind === 'partial';
      if (isPartialRefund && (current.paymentStatus === 'refunded' || current.refundedAt)) {
        return { abort: { outcome: 'already_terminal', order: current } };
      }
      const targetStatus: PaymentStatus = isPartialRefund ? 'partially_refunded' : 'refunded';
      const alreadyReversed = current.paymentStatus === targetStatus
        && (!isPartialRefund || (current.stripeRefundedAmountCents ?? 0) >= (input.refundedAmountCents ?? 0));
      const reason = input.eventType === 'charge.dispute.created'
        ? 'stripe_dispute_created'
        : isPartialRefund ? 'stripe_partial_refund' : 'stripe_charge_refunded';
      const updated: OrderRecord = {
        ...current,
        paymentStatus: targetStatus,
        stripePaymentIntentId: current.stripePaymentIntentId ?? input.paymentIntentId ?? null,
        refundedAt: isPartialRefund ? current.refundedAt ?? null : current.refundedAt ?? input.occurredAt,
        refundReason: isPartialRefund ? current.refundReason ?? reason : reason,
        stripeRefundId: input.reversalId ?? current.stripeRefundId ?? input.providerObjectId,
        stripeRefundedAmountCents: Math.max(
          current.stripeRefundedAmountCents ?? 0,
          input.refundedAmountCents ?? 0,
        ),
        refundClaimId: null,
        refundClaimAt: null,
        refundPaymentIntent: null,
        fulfillmentStatus: 'failed_manual_review',
        fulfillmentLastError: `${reason}: ${input.providerObjectId}`,
        auditEvents: [...(current.auditEvents ?? []), auditEvent],
        updatedAt: now,
      };
      return {
        commit: updated,
        result: { outcome: alreadyReversed ? 'already_terminal' : 'converged', order: updated },
      };
    },
    { notFound: () => null },
  );
}

export type CheckoutIntakeMediaCleanupClaimResult = {
  status: 'claimed' | 'already_claimed' | 'already_reclaimed' | 'retained';
};

/**
 * Atomically gives cleanup deletion authority over one exact intake binding.
 * Payment/session/lease decisions are evaluated inside the same order CAS that
 * records the claim, so checkout-session binding and cleanup cannot both win.
 */
export async function claimCheckoutIntakeMediaCleanup(
  orderId: string,
  intakeId: string,
  opts: { now?: Date } = {},
): Promise<CheckoutIntakeMediaCleanupClaimResult> {
  const now = opts.now ?? new Date();
  return withOrderTransaction<CheckoutIntakeMediaCleanupClaimResult>(
    orderId,
    (current) => {
      if (current.checkoutIntake?.intakeId !== intakeId) return { abort: { status: 'retained' } };
      const retention = current.checkoutIntakeMediaRetention;
      if (retention?.status === 'reclaimed') return { abort: { status: 'already_reclaimed' } };
      if (retention?.status === 'cleanup_claimed') return { abort: { status: 'already_claimed' } };
      const activatedAt = Date.parse(retention?.activatedAt ?? '');
      const abandoned = Number.isFinite(activatedAt)
        && activatedAt + CHECKOUT_INTAKE_MEDIA_ABANDONMENT_MS <= now.getTime();
      const unpaidAndUnpayable = current.paymentStatus === 'failed'
        || (current.paymentStatus === 'pending'
          && (current.stripeSessionId === null || current.stripeSessionId === undefined));
      if (retention?.status !== 'active' || !abandoned || !unpaidAndUnpayable) {
        return { abort: { status: 'retained' } };
      }
      if (current.checkoutLeaseId) {
        const leaseExpiresAt = Date.parse(current.checkoutLeaseExpiresAt ?? '');
        if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > now.getTime()) {
          return { abort: { status: 'retained' } };
        }
      }
      const updated: OrderRecord = {
        ...current,
        checkoutIntakeMediaRetention: {
          ...retention,
          status: 'cleanup_claimed',
          cleanupClaimedAt: now.toISOString(),
        },
        updatedAt: now.toISOString(),
      };
      return { commit: updated, result: { status: 'claimed' } };
    },
    { notFound: () => ({ status: 'retained' }) },
  );
}

export type CheckoutIntakeMediaReclaimResult = {
  status: 'reclaimed' | 'already_reclaimed' | 'not_claimed';
};

/** Mark deletion complete only from an exact, durable cleanup claim. */
export async function markCheckoutIntakeMediaReclaimed(
  orderId: string,
  intakeId: string,
  opts: { now?: Date } = {},
): Promise<CheckoutIntakeMediaReclaimResult> {
  const now = opts.now ?? new Date();
  return withOrderTransaction<CheckoutIntakeMediaReclaimResult>(
    orderId,
    (current) => {
      if (current.checkoutIntake?.intakeId !== intakeId) return { abort: { status: 'not_claimed' } };
      const retention = current.checkoutIntakeMediaRetention;
      if (retention?.status === 'reclaimed') return { abort: { status: 'already_reclaimed' } };
      if (retention?.status !== 'cleanup_claimed') return { abort: { status: 'not_claimed' } };
      const updated: OrderRecord = {
        ...current,
        checkoutIntakeMediaRetention: {
          ...retention,
          status: 'reclaimed',
          reclaimedAt: now.toISOString(),
        },
        updatedAt: now.toISOString(),
      };
      return { commit: updated, result: { status: 'reclaimed' } };
    },
    { notFound: () => ({ status: 'not_claimed' }) },
  );
}

export async function bindOrderCheckoutSession(
  orderId: string,
  stripeSessionId: string,
  checkout?: { leaseId: string; fingerprint: string; now?: Date },
): Promise<OrderRecord | null> {
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (current.paymentStatus !== 'pending'
        || (current.checkoutIntakeMediaRetention?.status !== undefined
          && current.checkoutIntakeMediaRetention.status !== 'active')) return { abort: null };
      if (checkout) {
        const leaseExpiresAt = Date.parse(current.checkoutLeaseExpiresAt ?? '');
        const nowMs = (checkout.now ?? new Date()).getTime();
        if (current.checkoutLeaseId !== checkout.leaseId
          || current.checkoutFingerprint !== checkout.fingerprint
          || !Number.isFinite(leaseExpiresAt)
          || leaseExpiresAt <= nowMs) return { abort: null };
      }
      if (current.stripeSessionId && current.stripeSessionId !== stripeSessionId) return { abort: null };
      const updated = { ...current, stripeSessionId, updatedAt: new Date().toISOString() };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}

export async function recordPaymentSettlementConflict(
  orderId: string,
  input: { stripeSessionId: string; amountSubtotalCents: number | null; amountTotalCents: number | null; reason: string },
): Promise<OrderRecord | null> {
  const now = new Date().toISOString();
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      const duplicate = (current.auditEvents ?? []).some((event) =>
        event.type === 'payment_settlement_conflict'
        && event.meta?.stripeSessionId === input.stripeSessionId,
      );
      if (duplicate) return { abort: current };
      const updated: OrderRecord = {
        ...current,
        auditEvents: [...(current.auditEvents ?? []), {
          at: now,
          type: 'payment_settlement_conflict',
          meta: input,
        }],
        updatedAt: now,
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}

export async function updatePrintUpgradePayment(
  orderId: string,
  opts: {
    stripeSessionId: string;
    targetFormat: Extract<BookFormat, 'classic' | 'premium'>;
    shippingAddress?: ShippingAddress;
    paidAt?: string;
  },
) {
  return withOrderTransaction<OrderRecord | null>(
    orderId,
    (current) => {
      if (current.printUpgradeStatus === 'paid') return { abort: current };
      const updated: OrderRecord = {
        ...current,
        printUpgradeStatus: 'paid',
        printUpgradeStripeSessionId: opts.stripeSessionId,
        printUpgradeTargetFormat: opts.targetFormat,
        printUpgradePaidAt: opts.paidAt ?? new Date().toISOString(),
        ...(opts.shippingAddress != null ? { shippingAddress: opts.shippingAddress } : {}),
        updatedAt: new Date().toISOString(),
      };
      return { commit: updated, result: updated };
    },
    { notFound: () => null },
  );
}
