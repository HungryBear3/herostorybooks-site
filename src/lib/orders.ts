import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
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
import type { FulfillmentStatus, PageTextLayout, VoiceTranscriptMeta } from './fulfillment-types.ts';
import type { GuidedReferencePhotoRecord } from './guided-photo-capture.ts';
import type { CustomStoryBrief, ValidationResult } from './custom-story/index.ts';
import { validateOrderPhotoFile } from './photo-file-validation.ts';
import { PROOF_TURNAROUND_PHRASE } from './proof-turnaround.ts';
export type { FulfillmentStatus, PageTextLayout, VoiceTranscriptMeta };

export type OrderStatus = 'order_received' | 'preview_ready' | 'print_in_production' | 'shipped';
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
  /** Sanitized, operator-approved custom-story brief. Never raw transcript/audio. */
  customStoryBrief?: CustomStoryBrief | null;
  /** Latest fail-closed validation result for the sanitized custom-story brief. */
  customStoryValidation?: ValidationResult | null;
  /** Sanitized private tester/source tracking from normal checkout URL params. */
  checkoutTracking?: CheckoutTracking | null;
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
  | 'proof_generated'
  | 'proof_rebuilt'
  | 'proof_release_blocked'
  | 'proof_release_override_recorded'
  | 'proof_review_acknowledged'
  | 'page_regenerated'
  | 'page_regenerate_rejected'
  | 'page_accepted'
  | 'page_accept_rejected'
  | 'page_changes_requested'
  | 'customer_text_change_requested'
  | 'review_link_prepared'
  | 'whole_book_approved'
  | 'whole_book_approval_rejected'
  | 'print_upgrade_paid'
  | 'refund_issued'
  | 'refund_refused'
  | 'internal_disposition_marked';

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
  /** Fulfillment routing intent — see FulfillmentMode. Undefined = fail closed. */
  fulfillmentMode?: FulfillmentMode;
  stripeSessionId?: string | null;
  shippingAddress?: ShippingAddress | null;
  fulfillmentStatus?: FulfillmentStatus;
  fulfillmentAttempts?: number;
  fulfillmentLastError?: string | null;
  storyArtifactUrl?: string | null;
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
  printCoverArtifactUrl?: string | null;
  printCoverMd5?: string | null;
  printTitle?: string | null;
  proofApprovalToken?: string | null;
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
    return `Digital proof ${PROOF_TURNAROUND_PHRASE}; final PDF delivered after approval.`;
  }

  if (format === 'premium') {
    return `Digital proof ${PROOF_TURNAROUND_PHRASE}. After approval, hardcover ships in 5–7 business days — free shipping included.`;
  }

  return `Digital proof ${PROOF_TURNAROUND_PHRASE}. After approval, softcover ships in 5–7 business days — free shipping included.`;
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

export class OrderMutationLockError extends Error {
  readonly orderId: string;

  constructor(orderId: string, message = 'Order mutation is already in progress', cause?: unknown) {
    super(message);
    this.name = 'OrderMutationLockError';
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

// ── Order mutation lock: generation-based atomic ownership ───────────────────
//
// ATOMICITY INVARIANT
// -------------------
// The ONLY atomic primitive this project has is an exclusive create:
//   * Vercel Blob : put(..., allowOverwrite: false) — the store rejects the
//                   write with a 409/"already exists" if the key is taken.
//   * local FS    : link(tmp, target) — POSIX link() is atomic and fails
//                   EEXIST if the target exists. The record body is fully
//                   written to `tmp` BEFORE the link, so the key becomes
//                   visible already carrying its complete contents (no
//                   create-then-fill window a racing reader could observe).
//
// There is NO compare-and-swap and NO conditional overwrite. Therefore the lock
// NEVER overwrites and NEVER deletes-then-recreates a contended key. Instead,
// lock ownership is expressed as a monotonically increasing *generation*, each
// living at its own immutable key:
//
//     order-mutation-locks/<orderId>/000000000001.lock
//     order-mutation-locks/<orderId>/000000000002.lock   ← reclaim after expiry
//
// To acquire, a worker reads the highest existing generation G and then
// exclusively creates generation G+1. Exactly one worker can win that create;
// every other contender gets 'exists' and backs off. Mutual exclusion is
// therefore decided by the store's atomic create, never by a read.
//
// This is what makes the design correct under an eventually-consistent list:
// a stale list can only make a worker guess a generation that is already taken,
// and that guess is rejected by the atomic create. A stale list can cause extra
// retries; it can NEVER admit two winners.
//
// The previous implementation overwrote the single lock key and then re-read it
// after a delay to "confirm" ownership. That is not mutual exclusion: read-back
// is not CAS, and under read-after-write lag two contenders could each observe
// their own write and both enter. That path is removed entirely.
//
// FENCING
// -------
// A generation is valid only while its lease is unexpired AND no higher
// generation exists. OrderLockHandle.assertHeld() re-verifies both immediately
// before a critical section commits, so a holder whose lease lapsed (and was
// reclaimed at a higher generation) fails closed instead of writing. This
// bounds the unsafe window to the gap between assertHeld() and the write rather
// than the whole critical section. See the qa-report for the residual limit.

const LOCK_GENERATION_DIGITS = 12;

function getOrderMutationLockPrefix(orderId: string) {
  return withBlobNamespace(`order-mutation-locks/${orderId}/`);
}

function getOrderMutationLockBlobPath(orderId: string, generation: number) {
  const padded = String(generation).padStart(LOCK_GENERATION_DIGITS, '0');
  return `${getOrderMutationLockPrefix(orderId)}${padded}.lock`;
}

function parseLockGeneration(pathname: string): number | null {
  const match = /(\d{12})\.lock$/.exec(pathname);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function highestGeneration(pathnames: string[]): number {
  let highest = 0;
  for (const p of pathnames) {
    const g = parseLockGeneration(p);
    if (g !== null && g > highest) highest = g;
  }
  return highest;
}

// Bounded acquisition + a bounded lease so a crashed holder cannot strand the
// lock forever.
//
// INVARIANT: the lease (LEASE_MS) must comfortably exceed the longest critical
// section ever run under the lock, so a still-live holder is never mistaken for
// a crashed one and reclaimed underneath itself. The longest critical section is
// approveWholeBook's proof-PDF rebuild; the slow provider call (regenerate) and
// the slow print handoff (approve) are deliberately kept OUTSIDE the lock. 60s is
// well above the rebuild, and acquisition is bounded to TIMEOUT_MS.
const ORDER_MUTATION_LOCK_WAIT_MS = 25;
const ORDER_MUTATION_LOCK_TIMEOUT_MS = 10_000;
const ORDER_MUTATION_LOCK_LEASE_MS = 60_000;

// Timings are overridable via env (read at call time) so tests can exercise
// bounded acquisition and lease expiry deterministically without long waits.
function lockTimeoutMs(): number {
  return Number(process.env.HSB_ORDER_LOCK_TIMEOUT_MS) || ORDER_MUTATION_LOCK_TIMEOUT_MS;
}
function lockLeaseMs(): number {
  return Number(process.env.HSB_ORDER_LOCK_LEASE_MS) || ORDER_MUTATION_LOCK_LEASE_MS;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface OrderLockRecord {
  owner: string;
  generation: number;
  acquiredAt: string;
  expiresAt: number;
}

function isOrderLockRecord(value: unknown): value is OrderLockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.owner === 'string' &&
    v.owner.length > 0 &&
    typeof v.generation === 'number' &&
    Number.isSafeInteger(v.generation) &&
    v.generation > 0 &&
    typeof v.acquiredAt === 'string' &&
    typeof v.expiresAt === 'number' &&
    Number.isFinite(v.expiresAt)
  );
}

/**
 * The result of reading a lock key.
 *
 * CRITICAL: 'absent' and 'unreadable' are distinct and must never be collapsed
 * into a single nullish value. The previous implementation returned `null` for
 * "missing", "I/O error" and "unparseable" alike, which let a transient read
 * failure be read as "nobody owns this" — and release then deleted a lock it
 * had not proven it owned. Every consumer here fails closed on 'unreadable'.
 */
export type OrderLockReadOutcome =
  | { state: 'present'; record: OrderLockRecord }
  | { state: 'absent' }
  | { state: 'unreadable'; reason: 'io_error' | 'malformed'; detail: string };

/** Why a release did (or deliberately did not) delete the lock key. */
export type OrderLockReleaseOutcome =
  | 'released'      // positive read, owner matched → deleted
  | 'superseded'    // owner matched but our lease had lapsed and a newer generation exists
  | 'not_owner'     // positive read, different owner → NOT deleted
  | 'absent'        // key already gone → nothing deleted
  | 'read_failed'   // read threw → NOT deleted (fail closed)
  | 'malformed'     // unparseable/invalid record → NOT deleted (fail closed)
  | 'delete_failed';

export interface OrderLockHandle {
  readonly orderId: string;
  readonly owner: string;
  readonly generation: number;
  /**
   * Re-prove ownership. Throws OrderMutationLockError unless the lock key is
   * positively readable, still carries OUR owner token, the lease has not
   * lapsed, and no higher generation has superseded us. Call this immediately
   * before a critical section commits.
   */
  assertHeld(): Promise<void>;
  release(): Promise<OrderLockReleaseOutcome>;
}

/**
 * Storage seam for the lock. Two adapters ship: Vercel Blob (production) and
 * local filesystem (dev/test). `createIfAbsent` MUST be atomic and MUST report
 * 'exists' rather than overwriting — that single guarantee is what the whole
 * mutual-exclusion argument rests on.
 */
export interface OrderLockStoreAdapter {
  readonly kind: string;
  /** Atomic exclusive create. Never overwrites. */
  createIfAbsent(pathname: string, body: string): Promise<'created' | 'exists'>;
  /** Returns null ONLY for a genuinely absent key; throws on I/O failure. */
  readText(pathname: string): Promise<string | null>;
  listLockPaths(prefix: string): Promise<string[]>;
  remove(pathname: string): Promise<void>;
}

function isBlobAlreadyExistsError(message: string): boolean {
  return /already exists|blob.*exist|409|conflict/i.test(message);
}

function isBlobNotFoundError(message: string): boolean {
  return /not ?found|404|BlobNotFound/i.test(message);
}

function blobLockAdapter(token: string): OrderLockStoreAdapter {
  return {
    kind: 'blob',
    async createIfAbsent(pathname, body) {
      try {
        await put(pathname, body, {
          access: getBlobAccessMode(),
          token,
          allowOverwrite: false, // ← the atomic primitive; do not relax
          addRandomSuffix: false,
          contentType: 'application/json',
        });
        return 'created';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isBlobAlreadyExistsError(message)) return 'exists';
        throw error;
      }
    },
    async readText(pathname) {
      try {
        // No `url` is passed, so this goes straight to the authenticated,
        // uncached SDK read — the authoritative view of the key.
        return await readBlobText({ pathname, token });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isBlobNotFoundError(message)) return null;
        throw error;
      }
    },
    async listLockPaths(prefix) {
      const result = await list({ prefix, token, limit: 1000 });
      return result.blobs.map((b) => b.pathname);
    },
    async remove(pathname) {
      await del(pathname, { token });
    },
  };
}

function localLockRoot() {
  return `${getOrderStoreDir()}/.mutation-locks`;
}

function localLockFsPath(pathname: string) {
  return `${localLockRoot()}/${pathname}`;
}

function parentDirOf(p: string) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i);
}

function localLockAdapter(): OrderLockStoreAdapter {
  return {
    kind: 'local',
    async createIfAbsent(pathname, body) {
      const target = localLockFsPath(pathname);
      await mkdir(parentDirOf(target), { recursive: true });
      // Write the full body to a private temp file FIRST, then link() it into
      // place. link() is atomic and fails EEXIST when taken, so the lock key
      // never exists in a half-written state a racing reader could misread.
      const tmp = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      await writeFile(tmp, body, 'utf8');
      try {
        await link(tmp, target);
        return 'created';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        throw error;
      } finally {
        await unlink(tmp).catch(() => { /* temp already gone */ });
      }
    },
    async readText(pathname) {
      try {
        return await readFile(localLockFsPath(pathname), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error; // EACCES/EIO etc. must surface, never masquerade as absent
      }
    },
    async listLockPaths(prefix) {
      try {
        const entries = await readdir(localLockFsPath(prefix));
        return entries.map((name) => `${prefix}${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
    async remove(pathname) {
      try {
        await unlink(localLockFsPath(pathname));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

let orderLockAdapterFactoryOverride:
  | ((token: string | undefined) => OrderLockStoreAdapter)
  | null = null;

/**
 * Test seam: substitute the lock's storage adapter so the production Blob
 * semantics (atomic create-only put, eventually-consistent list, read failures)
 * can be exercised deterministically without a live Blob store.
 */
export function __setOrderLockAdapterFactoryForTests(
  factory: ((token: string | undefined) => OrderLockStoreAdapter) | null,
): void {
  orderLockAdapterFactoryOverride = factory;
}

export function __resetOrderLockAdapterFactoryForTests(): void {
  orderLockAdapterFactoryOverride = null;
}

function resolveOrderLockAdapter(token: string | undefined): OrderLockStoreAdapter {
  if (orderLockAdapterFactoryOverride) return orderLockAdapterFactoryOverride(token);
  if (token) return blobLockAdapter(token);
  return localLockAdapter();
}

async function readLockRecord(
  adapter: OrderLockStoreAdapter,
  pathname: string,
): Promise<OrderLockReadOutcome> {
  let text: string | null;
  try {
    text = await adapter.readText(pathname);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: 'unreadable', reason: 'io_error', detail: sanitizeBlobErrorMessage(message) };
  }
  if (text === null) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'unreadable', reason: 'malformed', detail: 'lock record is not valid JSON' };
  }
  if (!isOrderLockRecord(parsed)) {
    return { state: 'unreadable', reason: 'malformed', detail: 'lock record shape is invalid' };
  }
  return { state: 'present', record: parsed };
}

function makeOrderLockHandle(
  orderId: string,
  owner: string,
  record: OrderLockRecord,
  adapter: OrderLockStoreAdapter,
): OrderLockHandle {
  const prefix = getOrderMutationLockPrefix(orderId);
  const pathname = getOrderMutationLockBlobPath(orderId, record.generation);

  return {
    orderId,
    owner,
    generation: record.generation,

    async assertHeld() {
      const outcome = await readLockRecord(adapter, pathname);
      if (outcome.state !== 'present') {
        const detail = outcome.state === 'absent' ? 'lock key is gone' : outcome.detail;
        throw new OrderMutationLockError(
          orderId,
          `Order lock ownership could not be confirmed (${detail})`,
        );
      }
      if (outcome.record.owner !== owner) {
        throw new OrderMutationLockError(orderId, 'Order lock ownership lost (owner changed)');
      }
      if (outcome.record.expiresAt <= Date.now()) {
        throw new OrderMutationLockError(orderId, 'Order lock lease expired mid-transaction');
      }
      // A higher generation means someone reclaimed the lock from under us.
      let paths: string[];
      try {
        paths = await adapter.listLockPaths(prefix);
      } catch (error) {
        throw new OrderMutationLockError(
          orderId,
          'Order lock ownership could not be confirmed (generation list failed)',
          error,
        );
      }
      if (highestGeneration(paths) > record.generation) {
        throw new OrderMutationLockError(
          orderId,
          'Order lock superseded by a newer generation',
        );
      }
    },

    async release() {
      // Delete ONLY after a positive, successful, parsed ownership read whose
      // owner token is ours. Absent / I/O failure / malformed all fail closed
      // WITHOUT deleting — the lease is what guarantees eventual reclaim.
      const outcome = await readLockRecord(adapter, pathname);
      if (outcome.state === 'absent') return 'absent';
      if (outcome.state === 'unreadable') {
        return outcome.reason === 'malformed' ? 'malformed' : 'read_failed';
      }
      if (outcome.record.owner !== owner) return 'not_owner';

      // Positively ours. Deleting our OWN generation key can never remove
      // another holder's lock: reclaim always creates a NEW generation key and
      // leaves ours untouched, and this owner token is unique to this
      // acquisition.
      let superseded = false;
      if (outcome.record.expiresAt <= Date.now()) {
        try {
          superseded = highestGeneration(await adapter.listLockPaths(prefix)) > record.generation;
        } catch {
          // Best-effort classification only; it does not gate the delete.
        }
      }
      try {
        await adapter.remove(pathname);
      } catch {
        return 'delete_failed';
      }
      return superseded ? 'superseded' : 'released';
    },
  };
}

async function tryAcquireOrderLock(
  orderId: string,
  owner: string,
  adapter: OrderLockStoreAdapter,
): Promise<OrderLockHandle | null> {
  const prefix = getOrderMutationLockPrefix(orderId);

  let paths: string[];
  try {
    paths = await adapter.listLockPaths(prefix);
  } catch (error) {
    throw new OrderMutationLockError(orderId, 'Order lock store unavailable (list failed)', error);
  }
  const highest = highestGeneration(paths);

  if (highest > 0) {
    const incumbent = await readLockRecord(adapter, getOrderMutationLockBlobPath(orderId, highest));
    if (incumbent.state === 'unreadable') {
      // We cannot PROVE the incumbent is dead, so we must not contend for the
      // next generation. Back off and retry; acquisition stays bounded.
      return null;
    }
    if (incumbent.state === 'present' && incumbent.record.expiresAt > Date.now()) {
      return null; // live holder — wait
    }
    // 'absent' (deleted between list and read) or an expired lease: contend.
  }

  const generation = highest + 1;
  const record: OrderLockRecord = {
    owner,
    generation,
    acquiredAt: new Date().toISOString(),
    expiresAt: Date.now() + lockLeaseMs(),
  };

  let created: 'created' | 'exists';
  try {
    created = await adapter.createIfAbsent(
      getOrderMutationLockBlobPath(orderId, generation),
      JSON.stringify(record),
    );
  } catch (error) {
    throw new OrderMutationLockError(orderId, 'Order lock store unavailable (create failed)', error);
  }
  // 'exists' means another contender won this generation — including the case
  // where our list was stale. Back off and retry; we never overwrite.
  if (created === 'exists') return null;

  // Hygiene: every generation BELOW the one we just won is provably expired. A
  // generation is only ever created once the one before it has lapsed, and a
  // lease is never renewed — so no key below `generation` can belong to a live
  // holder. Removing them keeps the per-order prefix from growing without bound
  // after crashes. Best-effort and never fatal: a stale holder that finds its
  // key gone fails closed at assertHeld()/release() either way.
  for (const stale of paths) {
    const g = parseLockGeneration(stale);
    if (g !== null && g < generation) {
      try {
        await adapter.remove(stale);
      } catch {
        /* hygiene only — never blocks acquisition */
      }
    }
  }

  return makeOrderLockHandle(orderId, owner, record, adapter);
}

/**
 * Run one read-modify-write transaction for an order at a time.
 *
 * Mutual exclusion comes from an atomic exclusive create of a per-generation
 * lock key (create-only Blob put / POSIX link) — never from an overwrite and
 * never from a read-back "confirmation". A bounded lease means a crashed holder
 * cannot strand the lock forever; a new holder reclaims by creating the NEXT
 * generation rather than by deleting or overwriting the incumbent's key.
 *
 * The operation receives an OrderLockHandle; call `assertHeld()` right before
 * committing anything durable in a long or provider-interleaved critical
 * section. Acquisition is bounded, and unexpected storage errors fail closed
 * (never an unlocked mutation), surfacing as OrderMutationLockError.
 */
export async function withOrderMutationLock<T>(
  orderId: string,
  operation: (lock: OrderLockHandle) => Promise<T>,
): Promise<T> {
  if (!/^[A-Za-z0-9_-]+$/.test(orderId)) {
    throw new OrderMutationLockError(orderId, 'Invalid order id for mutation lock');
  }

  const token = getBlobToken();
  if (!token && requiresDurablePersistence()) {
    throw new OrderMutationLockError(
      orderId,
      'Durable order lock unavailable: BLOB_READ_WRITE_TOKEN missing',
    );
  }

  const adapter = resolveOrderLockAdapter(token);
  const owner = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + lockTimeoutMs();
  let handle: OrderLockHandle | null = null;

  while (!handle && Date.now() < deadline) {
    handle = await tryAcquireOrderLock(orderId, owner, adapter);
    if (!handle) await sleep(ORDER_MUTATION_LOCK_WAIT_MS);
  }

  if (!handle) {
    throw new OrderMutationLockError(orderId, 'Timed out acquiring order mutation lock');
  }

  try {
    return await operation(handle);
  } finally {
    // Ownership-safe release. Anything other than 'released' means we
    // deliberately did NOT delete a key we could not prove was ours; the lease
    // guarantees it is still reclaimable.
    try {
      const outcome = await handle.release();
      if (outcome !== 'released') {
        console.warn(
          `[orders] mutation lock for ${orderId} not deleted on release (outcome=${outcome}); lease expiry will reclaim it`,
        );
      }
    } catch (err) {
      console.warn(`[orders] mutation lock release failed for ${orderId}:`, err);
    }
  }
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

/**
 * Upload an attached child-voice audio file to durable blob storage. Mirrors
 * uploadOrderPhoto's fail-before-Stripe contract in production-like envs.
 */
export async function uploadOrderVoice(orderId: string, file: File): Promise<UploadedVoiceRef | null> {
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

  const pathname = withBlobNamespace(`orders/${orderId}/voice-${safeName}`);
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
  deps: OrderMediaRollbackDeps = {},
): Promise<number> {
  const uniquePaths = [...new Set(pathnames.filter(Boolean))];
  if (uniquePaths.length === 0) return 0;

  const expectedPrefix = withBlobNamespace(`orders/${orderId}/`);
  for (const pathname of uniquePaths) {
    if (!pathname.startsWith(expectedPrefix)) {
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

export function isOrderStatus(value: string): value is OrderStatus {
  return ['order_received', 'preview_ready', 'print_in_production', 'shipped'].includes(value);
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
  | 'printInteriorArtifactUrl'
  | 'printInteriorMd5'
  | 'printInteriorPageCount'
  | 'printCoverArtifactUrl'
  | 'printCoverMd5'
  | 'printTitle'
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

export async function updateFulfillmentState(
  orderId: string,
  patch: FulfillmentPatch,
  existingOrder?: OrderRecord,
): Promise<OrderRecord | null> {
  // If the caller already holds a freshly-written record for this order, use it
  // directly. A second getOrder() here can return a stale blob snapshot and
  // spread it over fields that were just written (e.g. pageArtifacts after
  // regen). Guard the exported helper against accidental cross-order reuse.
  const existing = existingOrder?.id === orderId ? existingOrder : await getOrder(orderId);
  if (!existing) return null;

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

  await persistOrder(updated);
  return updated;
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
  const existing = existingOrder?.id === orderId ? existingOrder : await getOrder(orderId);
  if (!existing) return null;
  const entry: ReviewAuditEvent = {
    at: event.at ?? new Date().toISOString(),
    type: event.type,
    ...(event.pageIndex != null ? { pageIndex: event.pageIndex } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.meta ? { meta: event.meta } : {}),
  };
  const updated: OrderRecord = {
    ...existing,
    auditEvents: [...(existing.auditEvents ?? []), entry],
    updatedAt: new Date().toISOString(),
  };
  await persistOrder(updated);
  return updated;
}

// ── Guarded commit: optimistic CAS on the order record ──────────────────────
//
// THE CONCURRENCY INVARIANT
// -------------------------
// The order-mutation lock gives ATOMIC ACQUISITION, but a lock alone cannot
// fence a durable write: a holder can pause past its lease, a newer generation
// can acquire and commit, and the paused holder can then resume and clobber it.
// `assertHeld()` before a separate unconditional write is a check→write TOCTOU
// window — it is NOT fencing and must never be described as such.
//
// The fix is that the DURABLE COMMIT ITSELF is conditional. Every editable-
// review mutation reads the order together with an opaque version token and
// writes back only if the stored version is still exactly that token:
//
//   * Vercel Blob : put(..., { ifMatch: <etag> }) — the store compares the ETag
//                   server-side and throws BlobPreconditionFailedError on
//                   mismatch. get() returns body + etag in ONE operation, so
//                   the version always corresponds to the bytes we read.
//   * local FS    : an exclusive link()-claim keyed on the expected version,
//                   plus a re-verify of the on-disk content hash under that
//                   claim, then an atomic rename.
//
// WHY A STALE HOLDER CANNOT COMMIT AFTER A NEWER ONE
// ---------------------------------------------------
// Let A hold generation 1 and read the order at version V0. A pauses past its
// lease. B acquires generation 2, reads V0, and commits — the store advances
// the record to V1. A now resumes and attempts its commit with ifMatch=V0.
// The stored version is V1, so the STORE rejects the write. A never overwrites
// B, and the rejection is produced by the commit itself, not by any check A
// performed beforehand. There is no window between A's decision and A's write
// in which the outcome could change, because the comparison and the write are
// one server-side operation.
//
// On conflict, `withOrderTransaction` re-verifies lock ownership BEFORE
// retrying. A live holder that merely lost a benign race re-reads the latest
// record, recomputes its mutation against it (so unrelated concurrent changes
// are preserved and every approval/security invariant is re-evaluated on fresh
// state), and retries. A stale holder fails `assertHeld()` and is refused the
// retry, so it can neither clobber nor loop.

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
  /** Opaque CAS token (Blob ETag / local content hash). */
  version: string;
}

export type ConditionalCommitResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'version_conflict' };

/**
 * Storage seam for versioned order reads and conditional commits.
 *
 * `replaceIfVersion` MUST perform the comparison and the write as ONE atomic
 * store-side operation. An implementation that reads, compares in application
 * code, and then writes unconditionally reintroduces the exact TOCTOU gap this
 * design exists to close.
 */
export interface OrderStoreAdapter {
  readonly kind: string;
  readVersioned(pathname: string): Promise<{ body: string; version: string } | null>;
  createIfAbsent(pathname: string, body: string): Promise<ConditionalCommitResult | { ok: false; reason: 'exists' }>;
  replaceIfVersion(pathname: string, body: string, expectedVersion: string): Promise<ConditionalCommitResult>;
}

function isPreconditionFailure(error: unknown): boolean {
  if (error instanceof BlobPreconditionFailedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /precondition|412|if-match|ifMatch/i.test(message);
}

function blobOrderStoreAdapter(token: string): OrderStoreAdapter {
  return {
    kind: 'blob',
    async readVersioned(pathname) {
      try {
        // get() returns the body stream AND the etag in a single call, so the
        // version token always describes exactly the bytes we just read.
        const result = await get(pathname, {
          access: getBlobAccessMode(),
          token,
          useCache: false,
        });
        if (!result || !result.stream) return null;
        const body = await new Response(result.stream).text();
        // The ETag lives on result.blob (GetBlobResultBlobBase), not on the
        // envelope. It describes exactly the bytes streamed above.
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
          allowOverwrite: false, // atomic exclusive create
          addRandomSuffix: false,
          contentType: 'application/json',
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

function localOrderStoreAdapter(): OrderStoreAdapter {
  // MUST mirror the layout persistOrder()/getOrder() use for the local store:
  // the blob pathname is `<namespace>/orders/<id>.json`, and on disk that same
  // record lives at `<storeDir>/<id>.json`. Using a different mapping here would
  // silently CAS against a file nobody else reads.
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
      // writers holding the same expected version cannot both claim it, so at
      // most one of them can proceed to the verify+rename below.
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

        // Under the claim, confirm the stored record is still exactly the
        // version we based our mutation on. Any writer that advanced it holds a
        // different version and therefore a different claim.
        const current = await readRaw(file);
        if (current === null || orderVersionOf(current) !== expectedVersion) {
          return { ok: false, reason: 'version_conflict' };
        }

        const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, file); // atomic replace
        return { ok: true, version: orderVersionOf(body) };
      } finally {
        await unlink(claimTmp).catch(() => {});
        if (claimed) await unlink(claim).catch(() => {});
      }
    },
  };
}

let orderStoreAdapterFactoryOverride:
  | ((token: string | undefined) => OrderStoreAdapter)
  | null = null;

/**
 * Test seam: substitute the versioned order store so the exact conditional-write
 * semantics (ETag returned on read, ifMatch compared server-side, precondition
 * failure on mismatch) can be exercised deterministically.
 */
export function __setOrderStoreAdapterFactoryForTests(
  factory: ((token: string | undefined) => OrderStoreAdapter) | null,
): void {
  orderStoreAdapterFactoryOverride = factory;
}

export function __resetOrderStoreAdapterFactoryForTests(): void {
  orderStoreAdapterFactoryOverride = null;
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

/** Read an order together with its CAS version token. */
export async function readOrderVersioned(orderId: string): Promise<VersionedOrder | null> {
  const adapter = resolveOrderStoreAdapter();
  const raw = await adapter.readVersioned(getOrderBlobPath(orderId));
  if (!raw) return null;
  let parsed: OrderRecord;
  try {
    parsed = JSON.parse(raw.body) as OrderRecord;
  } catch (error) {
    throw new OrderPersistenceError(orderId, 'Stored order record is not valid JSON', error);
  }
  return { order: parsed, version: raw.version };
}

/** Commit an order record only if the stored version is still `expectedVersion`. */
export async function commitOrderConditional(
  order: OrderRecord,
  expectedVersion: string,
): Promise<ConditionalCommitResult> {
  const adapter = resolveOrderStoreAdapter();
  return adapter.replaceIfVersion(
    getOrderBlobPath(order.id),
    JSON.stringify(order, null, 2),
    expectedVersion,
  );
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
  return {
    ...existing,
    auditEvents: [...(existing.auditEvents ?? []), entry],
    updatedAt: now,
  };
}

// ── The guarded transaction ─────────────────────────────────────────────────

export type OrderTransactionOutcome<T> =
  | { commit: OrderRecord; result: T }
  | { abort: T };

export const ORDER_TRANSACTION_MAX_ATTEMPTS = 5;

/**
 * Whole-mutation optimistic CAS with bounded retry.
 *
 * On every attempt the order is re-read WITH its version, the caller recomputes
 * the entire intended mutation against that fresh record (so all approval,
 * ownership and security invariants are re-evaluated on the latest state, and
 * unrelated concurrent changes are carried forward rather than clobbered), and
 * the result is committed conditionally on that version.
 *
 * `lock` is optional but strongly recommended: on a version conflict its
 * ownership is re-proved BEFORE retrying, so a holder whose lease has lapsed
 * and been superseded is refused the retry instead of looping until it wins.
 *
 * Returns whatever the mutator returns. `notFound` is returned when the order
 * does not exist.
 */
export async function withOrderTransaction<T>(
  orderId: string,
  mutate: (order: OrderRecord) => Promise<OrderTransactionOutcome<T>> | OrderTransactionOutcome<T>,
  opts: { lock?: OrderLockHandle; maxAttempts?: number; notFound?: () => T } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? ORDER_TRANSACTION_MAX_ATTEMPTS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await readOrderVersioned(orderId);
    if (!current) {
      if (opts.notFound) return opts.notFound();
      throw new OrderPersistenceError(orderId, 'Order not found for guarded commit');
    }

    const outcome = await mutate(current.order);
    if ('abort' in outcome) return outcome.abort;

    const committed = await commitOrderConditional(outcome.commit, current.version);
    if (committed.ok) return outcome.result;

    // Someone else advanced the record. Before retrying, PROVE we still hold
    // the lock. A stale/superseded holder throws here and can never commit.
    if (opts.lock) await opts.lock.assertHeld();
  }

  throw new OrderVersionConflictError(orderId, maxAttempts);
}

export async function updateOrderPayment(
  orderId: string,
  paymentStatus: PaymentStatus,
  opts: { stripeSessionId?: string; shippingAddress?: ShippingAddress } = {},
) {
  const existing = await getOrder(orderId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const updated: OrderRecord = {
    ...existing,
    paymentStatus,
    ...(opts.stripeSessionId != null ? { stripeSessionId: opts.stripeSessionId } : {}),
    ...(opts.shippingAddress != null ? { shippingAddress: opts.shippingAddress } : {}),
    // Authoritative + idempotent paidAt: stamped ONLY on the transition to
    // 'paid', and ONLY if not already set. `...existing` above preserves an
    // existing paidAt across replays / later updates; we never overwrite it and
    // never derive it from updatedAt or a scan clock.
    ...(paymentStatus === 'paid' && !existing.paidAt ? { paidAt: now } : {}),
    updatedAt: now,
  };

  await persistOrder(updated);
  return updated;
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
  const existing = await getOrder(orderId);
  if (!existing) return null;

  if (existing.printUpgradeStatus === 'paid') {
    return existing;
  }

  const updated: OrderRecord = {
    ...existing,
    printUpgradeStatus: 'paid',
    printUpgradeStripeSessionId: opts.stripeSessionId,
    printUpgradeTargetFormat: opts.targetFormat,
    printUpgradePaidAt: opts.paidAt ?? new Date().toISOString(),
    ...(opts.shippingAddress != null ? { shippingAddress: opts.shippingAddress } : {}),
    updatedAt: new Date().toISOString(),
  };

  await persistOrder(updated);
  return updated;
}
