import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { get, list, put } from '@vercel/blob';

import type { FulfillmentStatus, PageTextLayout, VoiceTranscriptMeta } from './fulfillment-types.ts';
import type { GuidedReferencePhotoRecord } from './guided-photo-capture.ts';
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
  | 'page_accepted'
  | 'page_changes_requested'
  | 'whole_book_approved'
  | 'whole_book_approval_rejected'
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
  /** Influencer / partner attribution captured from ?ref= or hsb_ref cookie. */
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
  printUpgradeTargetFormat?: BookFormat | null;
  printUpgradeStripeSessionId?: string | null;
  printUpgradePaidAt?: string | null;
  printUpgradeOfferedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PrintUpgradeStatus =
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
}

const FORMAT_META: Record<BookFormat, { label: string; priceCents: number }> = {
  digital: { label: 'Digital instant', priceCents: 1900 },
  classic: { label: 'Classic softcover', priceCents: 3900 },
  premium: { label: 'Premium hardcover', priceCents: 6400 },
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
    return 'PDF by email in ~15 minutes';
  }

  if (format === 'premium') {
    return 'Hardcover ships in 5–7 business days — free shipping included. Digital preview arrives first so you can approve before it prints.';
  }

  return 'Softcover ships in 5–7 business days — free shipping included. Digital preview arrives first so you can approve before it prints.';
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
