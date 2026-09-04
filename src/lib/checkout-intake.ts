/**
 * Checkout direct-private-upload intake record — the durable state machine
 * behind "upload the photo straight to private storage instead of posting it
 * through the order request".
 *
 * WHY THIS EXISTS
 * ---------------
 * Checkout used to carry every photo, the voice note and the inspiration
 * document as multipart fields on the single `POST /api/order` that also
 * created the order. On Mobile Safari with Private Browsing that request is
 * the one that dies: the combined body is large, the tab is memory-starved,
 * and there is no durable place to stage the bytes between attempts. The fix
 * is to move the bytes out of the order request entirely — the browser uploads
 * each file directly to private Blob storage, and the order request carries
 * only opaque asset ids.
 *
 * THE SHAPE THAT MAKES THAT SAFE: SLOTS WITH GENERATIONS
 * ------------------------------------------------------
 * The previous attempt at this keyed state on a content-derived asset id and
 * let COMPLETION ORDER decide which upload won. That is unsound the moment a
 * callback is delayed, and it produced three separate ways for a photo the
 * buyer had already replaced or removed to come back to life.
 *
 * This module is organised around a different primitive:
 *
 *   A SLOT is a place in the checkout form that holds at most one file — the
 *   hero photo, one family/pet character (addressed by its stable id, never by
 *   list position), one guided still, the voice note, the document.
 *
 *   Each slot carries a server-authoritative MONOTONIC GENERATION. Reserving
 *   an upload bumps it and replaces the slot's single pending reservation.
 *   Every issued upload token names the generation it belongs to, and a
 *   completion is only allowed to touch slot state while that generation is
 *   still current.
 *
 * Everything that used to be a race falls out of that one rule:
 *
 *   - A late callback for a replaced or removed selection is fenced by
 *     generation. It cannot supersede, and it cannot resurrect.
 *   - An abandoned reservation cannot block a replacement, because reserving
 *     the replacement supersedes it rather than queueing behind it.
 *   - Each generation writes to its own pathname, so `allowOverwrite: false`
 *     always holds and a lost upload response can be reconciled by exact
 *     pathname/size/MIME comparison instead of a blind overwrite.
 *
 * FAIL-CLOSED READS
 * -----------------
 * A record that is missing, unreadable, or does not validate against the
 * schema is never treated as "empty". `read` distinguishes an absent record
 * (null) from an unavailable store (throws), and this module maps every
 * unreadable or malformed state to a 5xx `IntakeError` rather than continuing
 * with defaults.
 */
import crypto from 'node:crypto';
import { BlobNotFoundError, BlobPreconditionFailedError, get, head, put } from '@vercel/blob';

import { applyBlobNamespace, getBlobNamespace } from './blob-namespace.ts';
import { normalizeEtagForIfMatch } from './blob-etag.ts';
import { assertDistinctBlobStores, parseBlobToken } from './checkout-blob-identity.ts';
import {
  AUDIO_MIME_TYPES,
  DOCUMENT_MIME_TYPES,
  PHOTO_MIME_TYPES,
  canonicalAllowlistedMime,
  mediaClassForCategory,
} from './checkout-media-mime.ts';

/**
 * Dedicated Blob credential for checkout intake. Intentionally NOT
 * `BLOB_READ_WRITE_TOKEN`: buyer-supplied media staged before payment must not
 * live under the same credential as finished orders, and the two must never be
 * configured to the same value.
 */
export const INTAKE_TOKEN_ENV = 'HSB_INTAKE_BLOB_READ_WRITE_TOKEN';
export const INTAKE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const INTAKE_RECORD_VERSION = 2;

/** How long a cleanup claim fences finalization before it is considered dead. */
export const INTAKE_CLEANUP_CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * How long a finalization reservation fences the intake.
 *
 * Long enough to create an order and hand off to Stripe; short enough that a
 * crashed checkout does not fence this intake — or block cleanup from ever
 * reclaiming it — indefinitely.
 */
export const INTAKE_FINALIZATION_LEASE_MS = 15 * 60 * 1000;
/** Maximum lifetime of a client upload token issued for an intake reservation. */
export const INTAKE_UPLOAD_TOKEN_TTL_MS = 5 * 60_000;

export type IntakeAssetCategory =
  | 'primary_hero_photo'
  | 'family_pet_reference'
  | 'guided_still'
  | 'voice_inspiration'
  | 'document_inspiration';

export type IntakeVoiceSource = 'recorded' | 'uploaded';

export type SupersededReason = 'replaced' | 'removed' | 'stale_callback';

export interface IntakeConsent {
  mediaAuthorizedAt: string;
  documentAuthorizedAt?: string | null;
  childVoiceAuthorizedAt?: string | null;
  voiceSource?: IntakeVoiceSource | null;
}

/** Addresses one slot. Family characters use a stable id; stills use an index. */
export interface SlotRef {
  category: IntakeAssetCategory;
  familyCharacterId?: string | null;
  guidedStillIndex?: number | null;
}

export interface IntakeAsset {
  assetId: string;
  slotKey: string;
  category: IntakeAssetCategory;
  familyCharacterId: string | null;
  guidedStillIndex: number | null;
  /** The slot generation this asset was uploaded for. */
  generation: number;
  pathname: string;
  mimeType: string;
  size: number;
  etag: string;
  consentAt: string;
  voiceSource: IntakeVoiceSource | null;
  completedAt: string;
  supersededAt?: string | null;
  supersededReason?: SupersededReason | null;
}

export interface IntakeReservation {
  reservationId: string;
  assetId: string;
  generation: number;
  pathname: string;
  mimeType: string;
  size: number;
  consentAt: string;
  voiceSource: IntakeVoiceSource | null;
  reservedAt: string;
}

export interface IntakeSlot {
  slotKey: string;
  category: IntakeAssetCategory;
  familyCharacterId: string | null;
  guidedStillIndex: number | null;
  /** Monotonic; only ever increases, and only through `bumpSlotGeneration`. */
  generation: number;
  /** At most one, and always at `generation`. */
  pending: IntakeReservation | null;
  active: IntakeAsset | null;
}

/**
 * One entry of the exact media tuple an order is bound to.
 *
 * Storing the tuple — not just an opaque fingerprint — is what lets cleanup
 * answer "which of this intake's objects does a paid order actually need?"
 * instead of skipping the whole intake forever.
 */
export interface FinalizedSelectionEntry {
  slotKey: string;
  category: IntakeAssetCategory;
  familyCharacterId: string | null;
  /** Position in the family list AS FINALIZED. Part of the order's meaning. */
  familyCharacterIndex: number | null;
  guidedStillIndex: number | null;
  assetId: string;
  pathname: string;
  mimeType: string;
  size: number;
  etag: string;
  generation: number;
  consentAt: string;
  voiceSource: IntakeVoiceSource | null;
}

export interface IntakeFinalization {
  checkoutAttemptId: string;
  orderId: string;
  /** Computed by the server from the resolved selection. Never caller-supplied. */
  fingerprint: string;
  reservedAt: string;
  /**
   * A crashed checkout must not fence this intake forever. After the lease
   * expires the reservation can be taken over by a new attempt or reclaimed by
   * cleanup; before it expires nothing else may touch the intake.
   */
  leaseExpiresAt: string;
  selection: FinalizedSelectionEntry[];
}

/** Canonical identity shared by the writer and durable-record parser. */
export function finalizationFingerprint(
  intakeId: string,
  entries: readonly FinalizedSelectionEntry[],
): string {
  const canonical = entries
    .map((entry) => [
      entry.slotKey,
      entry.category,
      entry.familyCharacterId ?? '',
      entry.familyCharacterIndex ?? '',
      entry.guidedStillIndex ?? '',
      entry.assetId,
      entry.pathname,
      entry.mimeType,
      entry.size,
      entry.etag,
      entry.generation,
      entry.consentAt,
      entry.voiceSource ?? '',
    ].join('|'))
    .sort();
  return crypto.createHash('sha256')
    .update(JSON.stringify([intakeId, canonical]))
    .digest('hex');
}

export interface IntakeCleanupClaim {
  claimId: string;
  claimedAt: string;
  expiresAt: string;
}

export interface IntakeRecord {
  version: typeof INTAKE_RECORD_VERSION;
  intakeId: string;
  capabilityHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  consent: IntakeConsent;
  slots: Record<string, IntakeSlot>;
  /** Assets whose bytes are no longer bound to a slot; cleanup reclaims them. */
  superseded: IntakeAsset[];
  finalization: IntakeFinalization | null;
  finalizedOrderId: string | null;
  cleanupClaim: IntakeCleanupClaim | null;
}

export interface IntakeStoreSnapshot {
  record: IntakeRecord;
  etag: string;
}

export interface IntakeStore {
  create(record: IntakeRecord): Promise<void>;
  /** `null` for an absent record. THROWS when the store is unavailable. */
  read(intakeId: string): Promise<IntakeStoreSnapshot | null>;
  compareAndSwap(intakeId: string, etag: string, record: IntakeRecord): Promise<boolean>;
  headAsset(pathname: string): Promise<{ pathname: string; mimeType: string; size: number; etag: string } | null>;
}

export class IntakeError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = 'IntakeError';
    this.code = code;
    this.status = status;
  }
}

interface CategoryPolicy {
  /** How many distinct slots of this category may hold media at once. */
  maxSlots: number;
  maxBytes: number;
  allowedMimeTypes: readonly string[];
  requiresDocumentConsent?: boolean;
  requiresVoiceConsent?: boolean;
}

// The allowlists live in `checkout-media-mime.ts`, which the browser imports
// too. This file must never hold a private copy: the 2026-09-04 incident was a
// client-accepted `audio/x-m4a` refused here by a list the client never saw.
const IMAGE_MIME_TYPES = PHOTO_MIME_TYPES;

export const INTAKE_CATEGORY_POLICY: Readonly<Record<IntakeAssetCategory, CategoryPolicy>> = {
  primary_hero_photo: { maxSlots: 1, maxBytes: 15 * 1024 * 1024, allowedMimeTypes: IMAGE_MIME_TYPES },
  family_pet_reference: { maxSlots: 4, maxBytes: 15 * 1024 * 1024, allowedMimeTypes: IMAGE_MIME_TYPES },
  guided_still: { maxSlots: 5, maxBytes: 15 * 1024 * 1024, allowedMimeTypes: IMAGE_MIME_TYPES },
  voice_inspiration: {
    maxSlots: 1,
    maxBytes: 15 * 1024 * 1024,
    allowedMimeTypes: AUDIO_MIME_TYPES,
    requiresVoiceConsent: true,
  },
  document_inspiration: {
    maxSlots: 1,
    maxBytes: 10 * 1024 * 1024,
    allowedMimeTypes: DOCUMENT_MIME_TYPES,
    requiresDocumentConsent: true,
  },
};

// ── Cardinality bounds ───────────────────────────────────────────────────────
// Every one of these caps something an attacker (or a stuck client) would
// otherwise be able to grow without limit inside a single intake record.
/** Superseded audit entries retained per intake. */
export const INTAKE_MAX_SUPERSEDED = 32;
/** Slot entries per intake, INCLUDING empty tombstones left by removals. */
export const INTAKE_MAX_SLOTS = 24;
/** Reservations any one slot may ever issue. */
export const INTAKE_MAX_SLOT_GENERATION = 20;
/** Reservations the whole intake may ever issue, across all slots. */
export const INTAKE_MAX_TOTAL_GENERATIONS = 60;
/** Bytes a stored record may occupy before it is refused unread. */
export const INTAKE_MAX_RECORD_BYTES = 256 * 1024;

/**
 * Read a stored record as text, refusing as soon as it exceeds `maxBytes`.
 *
 * `new Response(stream).text()` buffers whatever the store hands back before
 * anything can judge it, so an oversized (or endless) object is fully
 * materialised in a function's memory before being rejected. This stops at the
 * cap and cancels the stream.
 */
export async function readJsonTextWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new IntakeError('intake_record_too_large', 503);
      chunks.push(value);
    }
  } finally {
    // Releasing before cancel would make cancel throw on a locked stream.
    try {
      await reader.cancel();
    } catch {
      // The stream was already closed or errored; nothing to release.
    }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

const CATEGORIES = Object.keys(INTAKE_CATEGORY_POLICY) as IntakeAssetCategory[];
const FAMILY_CHARACTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INTAKE_ID_RE = /^intake_[a-f0-9]{32}$/;
const ASSET_ID_RE = /^asset_[a-f0-9]{32}$/;
const RESERVATION_ID_RE = /^res_[a-f0-9]{32}$/;
export const CHECKOUT_ATTEMPT_ID_RE = /^[a-f0-9]{32}$/;
export const ORDER_ID_RE = /^ord_[a-f0-9]{16}$/;
export const CLEANUP_CLAIM_ID_RE = /^[a-f0-9]{32}$/;
const ETAG_RE = /^[\x21-\x7e]{1,256}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Ids and paths
// ---------------------------------------------------------------------------

export function newIntakeId(): string {
  return `intake_${crypto.randomBytes(16).toString('hex')}`;
}

export function newAssetId(): string {
  return `asset_${crypto.randomBytes(16).toString('hex')}`;
}

export function newReservationId(): string {
  return `res_${crypto.randomBytes(16).toString('hex')}`;
}

export function assertIntakeId(value: string): string {
  if (!INTAKE_ID_RE.test(value ?? '')) throw new IntakeError('intake_id_invalid');
  return value;
}

export function assertAssetId(value: string): string {
  if (!ASSET_ID_RE.test(value ?? '')) throw new IntakeError('asset_id_invalid');
  return value;
}

/**
 * Storage paths are namespaced with the SAME primitive the order store uses.
 *
 * Without this, a Preview deployment holding a production credential writes to
 * the flat production `intakes/` keyspace. `getBlobNamespace` fails closed on
 * Preview when `HSB_BLOB_NAMESPACE` is unset, so the default argument is a
 * guard rather than a convenience.
 */
export function intakeRecordPath(intakeId: string, namespace = getBlobNamespace()): string {
  return applyBlobNamespace(`intakes/${assertIntakeId(intakeId)}.json`, namespace);
}

export function intakeAssetPath(
  intakeId: string,
  assetId: string,
  namespace = getBlobNamespace(),
): string {
  return applyBlobNamespace(
    `intakes/${assertIntakeId(intakeId)}/assets/${assertAssetId(assetId)}`,
    namespace,
  );
}

/** Prefix every intake object of one namespace lives under. */
export function intakeListPrefix(namespace = getBlobNamespace()): string {
  return applyBlobNamespace('intakes/', namespace);
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * The stable address of a slot.
 *
 * Family/pet slots are keyed by the character's stable id and never by its
 * position in the form list: reordering or deleting an earlier character must
 * not silently re-point a photo at a different person.
 */
export function slotKeyFor(ref: SlotRef): string {
  const category = ref?.category;
  if (!category || !CATEGORIES.includes(category)) throw new IntakeError('asset_category_invalid');
  if (category === 'family_pet_reference') {
    const id = typeof ref.familyCharacterId === 'string' ? ref.familyCharacterId.trim() : '';
    if (!FAMILY_CHARACTER_ID_RE.test(id)) throw new IntakeError('family_character_id_invalid');
    return `family_pet_reference:${id}`;
  }
  if (category === 'guided_still') {
    const index = ref.guidedStillIndex;
    if (!Number.isInteger(index) || index! < 0 || index! >= INTAKE_CATEGORY_POLICY.guided_still.maxSlots) {
      throw new IntakeError('guided_still_index_invalid');
    }
    return `guided_still:${index}`;
  }
  return category;
}

/** Normalizes a caller-supplied slot reference into its canonical fields. */
export function normalizeSlotRef(ref: SlotRef): Required<SlotRef> & { slotKey: string } {
  const slotKey = slotKeyFor(ref);
  return {
    slotKey,
    category: ref.category,
    familyCharacterId: ref.category === 'family_pet_reference'
      ? String(ref.familyCharacterId).trim()
      : null,
    guidedStillIndex: ref.category === 'guided_still' ? Number(ref.guidedStillIndex) : null,
  };
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

export function hashCapability(capability: string): string {
  return crypto.createHash('sha256').update(capability, 'utf8').digest('hex');
}

export function capabilityMatches(capability: unknown, expectedHash: unknown): boolean {
  if (typeof capability !== 'string' || typeof expectedHash !== 'string') return false;
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashCapability(capability), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function assertCapability(record: IntakeRecord, capability: unknown): void {
  if (!capabilityMatches(capability, record.capabilityHash)) {
    throw new IntakeError('intake_forbidden', 403);
  }
}

// ---------------------------------------------------------------------------
// Consent + policy
// ---------------------------------------------------------------------------

/** Returns the timestamp of the consent that authorizes this category. */
export function consentTimestampFor(category: IntakeAssetCategory, consent: IntakeConsent): string {
  if (!consent?.mediaAuthorizedAt) throw new IntakeError('media_authorization_required');
  const policy = INTAKE_CATEGORY_POLICY[category];
  if (policy.requiresDocumentConsent) {
    if (!consent.documentAuthorizedAt) throw new IntakeError('document_authorization_required');
    return consent.documentAuthorizedAt;
  }
  if (policy.requiresVoiceConsent) {
    if (!consent.childVoiceAuthorizedAt) throw new IntakeError('child_voice_authorization_required');
    if (consent.voiceSource !== 'recorded' && consent.voiceSource !== 'uploaded') {
      throw new IntakeError('voice_source_required');
    }
    return consent.childVoiceAuthorizedAt;
  }
  return consent.mediaAuthorizedAt;
}

/**
 * Validates a reservation against the category policy and returns the exact
 * values the reservation must carry.
 *
 * The MIME string is CANONICALIZED through the shared contract before it is
 * judged (lowercased, parameters stripped, known browser aliases resolved) and
 * the canonical string — never the caller's — is what the reservation stores.
 * Everything after reservation (token allow-list, Blob head, active asset,
 * finalization) compares that one string by exact equality.
 */
export function assertUploadPolicy(params: {
  category: IntakeAssetCategory;
  mimeType: string;
  size: number;
  consent: IntakeConsent;
}): { consentAt: string; mimeType: string } {
  const policy = INTAKE_CATEGORY_POLICY[params.category];
  if (!policy) throw new IntakeError('asset_category_invalid');
  const mimeType = canonicalAllowlistedMime(params.mimeType, mediaClassForCategory(params.category));
  if (!mimeType || !policy.allowedMimeTypes.includes(mimeType)) {
    throw new IntakeError('asset_mime_invalid', 415);
  }
  if (!Number.isSafeInteger(params.size) || params.size <= 0) throw new IntakeError('asset_size_invalid');
  if (params.size > policy.maxBytes) throw new IntakeError('asset_too_large', 413);
  return { consentAt: consentTimestampFor(params.category, params.consent), mimeType };
}

// ---------------------------------------------------------------------------
// Record creation and schema validation
// ---------------------------------------------------------------------------

export function createIntakeRecord(consent: IntakeConsent, now = new Date()): {
  record: IntakeRecord;
  capability: string;
} {
  if (!consent?.mediaAuthorizedAt) throw new IntakeError('media_authorization_required');
  const capability = crypto.randomBytes(32).toString('base64url');
  const createdAt = now.toISOString();
  return {
    capability,
    record: {
      version: INTAKE_RECORD_VERSION,
      intakeId: newIntakeId(),
      capabilityHash: hashCapability(capability),
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(now.getTime() + INTAKE_RETENTION_MS).toISOString(),
      consent: {
        mediaAuthorizedAt: createdAt,
        documentAuthorizedAt: consent.documentAuthorizedAt ? createdAt : null,
        childVoiceAuthorizedAt: consent.childVoiceAuthorizedAt ? createdAt : null,
        voiceSource: consent.voiceSource ?? null,
      },
      slots: {},
      superseded: [],
      finalization: null,
      finalizedOrderId: null,
      cleanupClaim: null,
    },
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalid(): never {
  throw new IntakeError('intake_record_invalid', 503);
}

/**
 * Unknown keys are a refusal, not something to ignore.
 *
 * An ignored key is a place to hide state that contradicts the state we do
 * read — a second `active` under another name, a category override, a
 * shadow reservation. Since this record is the sole authority for which media
 * an order may bind, "we didn't look at that field" is not an acceptable
 * answer to "where did that asset come from".
 */
function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid();
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  assertOnlyKeys(value, expected);
  if (Object.keys(value).length !== expected.length) invalid();
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  }
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  return raw as Record<string, unknown>;
}

/**
 * The slot key is the canonical name of (category, reference). This proves the
 * three agree, in both directions:
 *
 *   - the key must be exactly what `slotKeyFor` derives from the fields, and
 *   - the fields a category does NOT use must be null.
 *
 * The second half matters as much as the first: `slotKeyFor` ignores
 * `familyCharacterId` for a hero slot, so without it a `primary_hero_photo`
 * slot could carry a family id (or a `guidedStillIndex` of 99) and still
 * derive the right key. Finalization resolves selection THROUGH the slot, so a
 * slot whose identity fields disagree with its key is a way to smuggle an
 * asset into a category it does not belong to.
 */
function assertCanonicalSlotIdentity(identity: {
  slotKey: string;
  category: IntakeAssetCategory;
  familyCharacterId: unknown;
  guidedStillIndex: unknown;
}): void {
  if (!CATEGORIES.includes(identity.category)) invalid();
  if (identity.category === 'family_pet_reference') {
    if (typeof identity.familyCharacterId !== 'string' || !identity.familyCharacterId) invalid();
  } else if (identity.familyCharacterId !== null && identity.familyCharacterId !== undefined) {
    invalid();
  }
  if (identity.category === 'guided_still') {
    if (!isNonNegativeInt(identity.guidedStillIndex)) invalid();
  } else if (identity.guidedStillIndex !== null && identity.guidedStillIndex !== undefined) {
    invalid();
  }
  let canonical: string;
  try {
    canonical = slotKeyFor({
      category: identity.category,
      familyCharacterId: (identity.familyCharacterId ?? null) as string | null,
      guidedStillIndex: (identity.guidedStillIndex ?? null) as number | null,
    });
  } catch {
    invalid();
  }
  if (canonical !== identity.slotKey) invalid();
}

const ASSET_KEYS = [
  'assetId', 'slotKey', 'category', 'familyCharacterId', 'guidedStillIndex', 'generation',
  'pathname', 'mimeType', 'size', 'etag', 'consentAt', 'voiceSource', 'completedAt',
  'supersededAt', 'supersededReason',
] as const;

const SUPERSEDED_REASONS: readonly SupersededReason[] = ['replaced', 'removed', 'stale_callback'];

interface AssetParseContext {
  intakeId: string;
  namespace: string;
  /** When present, the asset must agree with the slot that holds it. */
  slot?: { slotKey: string; category: IntakeAssetCategory; familyCharacterId: string | null; guidedStillIndex: number | null; generation: number };
  /** Superseded-list entries must carry their supersession; active assets must not. */
  supersession: 'required' | 'forbidden';
}

function parseAsset(raw: unknown, ctx: AssetParseContext): IntakeAsset {
  const value = asObject(raw);
  assertExactKeys(value, ASSET_KEYS);

  const assetId = value.assetId;
  if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) invalid();
  const category = value.category as IntakeAssetCategory;
  const slotKey = value.slotKey;
  if (typeof slotKey !== 'string' || !slotKey) invalid();
  assertCanonicalSlotIdentity({
    slotKey,
    category,
    familyCharacterId: value.familyCharacterId ?? null,
    guidedStillIndex: value.guidedStillIndex ?? null,
  });

  if (ctx.slot) {
    if (slotKey !== ctx.slot.slotKey
      || category !== ctx.slot.category
      || (value.familyCharacterId ?? null) !== ctx.slot.familyCharacterId
      || (value.guidedStillIndex ?? null) !== ctx.slot.guidedStillIndex) {
      invalid();
    }
  }

  const generation = value.generation;
  if (!isNonNegativeInt(generation) || generation === 0 || generation > INTAKE_MAX_SLOT_GENERATION) invalid();
  // An asset cannot belong to a generation its slot has not reached.
  if (ctx.slot && generation > ctx.slot.generation) invalid();

  // The destination is derived, so a stored pathname is only ever a mirror of
  // it. A pathname that is not the derived one is a pointer at somebody
  // else's bytes.
  if (value.pathname !== intakeAssetPath(ctx.intakeId, assetId, ctx.namespace)) invalid();

  const policy = INTAKE_CATEGORY_POLICY[category];
  if (typeof value.mimeType !== 'string' || !policy.allowedMimeTypes.includes(value.mimeType)) invalid();
  const size = value.size;
  if (!isNonNegativeInt(size) || size === 0 || size > policy.maxBytes) invalid();
  if (typeof value.etag !== 'string' || !ETAG_RE.test(value.etag)) invalid();
  if (!isIsoTimestamp(value.consentAt) || !isIsoTimestamp(value.completedAt)) invalid();
  const voiceSource = (value.voiceSource ?? null) as IntakeVoiceSource | null;
  if (category === 'voice_inspiration') {
    if (voiceSource !== 'recorded' && voiceSource !== 'uploaded') invalid();
  } else if (voiceSource !== null) invalid();

  const supersededAt = value.supersededAt ?? null;
  const supersededReason = (value.supersededReason ?? null) as SupersededReason | null;
  if (ctx.supersession === 'forbidden') {
    if (supersededAt !== null || supersededReason !== null) invalid();
  } else {
    if (!isIsoTimestamp(supersededAt)) invalid();
    if (!supersededReason || !SUPERSEDED_REASONS.includes(supersededReason)) invalid();
    // Superseded before completed is not a state this machine can reach.
    if (Date.parse(supersededAt as string) < Date.parse(value.completedAt as string)) invalid();
  }

  return {
    assetId,
    slotKey,
    category,
    familyCharacterId: (value.familyCharacterId ?? null) as string | null,
    guidedStillIndex: (value.guidedStillIndex ?? null) as number | null,
    generation,
    pathname: value.pathname as string,
    mimeType: value.mimeType,
    size,
    etag: value.etag,
    consentAt: value.consentAt as string,
    voiceSource,
    completedAt: value.completedAt as string,
    supersededAt: supersededAt as string | null,
    supersededReason,
  };
}

const RESERVATION_KEYS = [
  'reservationId', 'assetId', 'generation', 'pathname', 'mimeType', 'size', 'consentAt', 'voiceSource', 'reservedAt',
] as const;

function parseReservation(
  raw: unknown,
  ctx: { intakeId: string; namespace: string; slot: { slotKey: string; category: IntakeAssetCategory; generation: number } },
): IntakeReservation {
  const value = asObject(raw);
  assertExactKeys(value, RESERVATION_KEYS);
  if (typeof value.reservationId !== 'string' || !RESERVATION_ID_RE.test(value.reservationId)) invalid();
  const assetId = value.assetId;
  if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) invalid();
  // A pending reservation that is not at the slot's current generation is a
  // contradiction the state machine can never produce.
  if (value.generation !== ctx.slot.generation) invalid();
  if (value.pathname !== intakeAssetPath(ctx.intakeId, assetId, ctx.namespace)) invalid();
  const policy = INTAKE_CATEGORY_POLICY[ctx.slot.category];
  if (typeof value.mimeType !== 'string' || !policy.allowedMimeTypes.includes(value.mimeType)) invalid();
  const size = value.size;
  if (!isNonNegativeInt(size) || size === 0 || size > policy.maxBytes) invalid();
  if (!isIsoTimestamp(value.consentAt) || !isIsoTimestamp(value.reservedAt)) invalid();
  const voiceSource = (value.voiceSource ?? null) as IntakeVoiceSource | null;
  if (ctx.slot.category === 'voice_inspiration') {
    if (voiceSource !== 'recorded' && voiceSource !== 'uploaded') invalid();
  } else if (voiceSource !== null) invalid();
  return {
    reservationId: value.reservationId,
    assetId,
    generation: value.generation as number,
    pathname: value.pathname as string,
    mimeType: value.mimeType,
    size,
    consentAt: value.consentAt as string,
    voiceSource,
    reservedAt: value.reservedAt as string,
  };
}

const RECORD_KEYS = [
  'version', 'intakeId', 'capabilityHash', 'createdAt', 'updatedAt', 'expiresAt',
  'consent', 'slots', 'superseded', 'finalization', 'finalizedOrderId', 'cleanupClaim',
] as const;
const CONSENT_KEYS = [
  'mediaAuthorizedAt', 'documentAuthorizedAt', 'childVoiceAuthorizedAt', 'voiceSource',
] as const;
const SLOT_KEYS = [
  'slotKey', 'category', 'familyCharacterId', 'guidedStillIndex', 'generation', 'pending', 'active',
] as const;
const FINALIZATION_KEYS = [
  'checkoutAttemptId', 'orderId', 'fingerprint', 'reservedAt', 'leaseExpiresAt', 'selection',
] as const;
const SELECTION_KEYS = [
  'slotKey', 'category', 'familyCharacterId', 'familyCharacterIndex', 'guidedStillIndex',
  'assetId', 'pathname', 'mimeType', 'size', 'etag', 'generation', 'consentAt', 'voiceSource',
] as const;
const CLEANUP_CLAIM_KEYS = ['claimId', 'claimedAt', 'expiresAt'] as const;

/**
 * Fail-closed schema validation for a stored intake record.
 *
 * Anything that does not validate raises a 503 `intake_record_invalid` rather
 * than being coerced or defaulted: an intake whose durable state we cannot
 * trust must stop the flow, not silently reset a buyer's uploads or bypass a
 * limit. Cardinality is part of validity — a record that grew past what the
 * writer is allowed to produce is as untrustworthy as one with a bad field.
 */
export function parseIntakeRecord(
  raw: unknown,
  options: { namespace?: string } = {},
): IntakeRecord {
  const namespace = options.namespace ?? getBlobNamespace();
  const value = asObject(raw);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid();
  }
  if (Buffer.byteLength(serialized, 'utf8') > INTAKE_MAX_RECORD_BYTES) invalid();
  if (value.version !== INTAKE_RECORD_VERSION) {
    throw new IntakeError('intake_record_version_unsupported', 503);
  }
  assertExactKeys(value, RECORD_KEYS);
  const intakeId = value.intakeId;
  if (typeof intakeId !== 'string' || !INTAKE_ID_RE.test(intakeId)) invalid();
  if (typeof value.capabilityHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.capabilityHash)) invalid();
  if (!isIsoTimestamp(value.createdAt) || !isIsoTimestamp(value.updatedAt) || !isIsoTimestamp(value.expiresAt)) {
    invalid();
  }
  if (Date.parse(value.createdAt as string) > Date.parse(value.updatedAt as string)
    || Date.parse(value.createdAt as string) >= Date.parse(value.expiresAt as string)) invalid();

  const consentRaw = asObject(value.consent);
  assertExactKeys(consentRaw, CONSENT_KEYS);
  if (!isIsoTimestamp(consentRaw.mediaAuthorizedAt)) invalid();
  const optionalTimestamp = (rawValue: unknown): string | null => {
    if (rawValue == null) return null;
    if (!isIsoTimestamp(rawValue)) invalid();
    return rawValue as string;
  };
  const optionalVoiceSource = (rawValue: unknown): IntakeVoiceSource | null => {
    if (rawValue == null) return null;
    if (rawValue !== 'recorded' && rawValue !== 'uploaded') invalid();
    return rawValue;
  };
  const consent: IntakeConsent = {
    mediaAuthorizedAt: consentRaw.mediaAuthorizedAt,
    documentAuthorizedAt: optionalTimestamp(consentRaw.documentAuthorizedAt),
    childVoiceAuthorizedAt: optionalTimestamp(consentRaw.childVoiceAuthorizedAt),
    voiceSource: optionalVoiceSource(consentRaw.voiceSource),
  };
  const createdMs = Date.parse(value.createdAt as string);
  const updatedMs = Date.parse(value.updatedAt as string);
  for (const timestamp of [
    consent.mediaAuthorizedAt,
    consent.documentAuthorizedAt,
    consent.childVoiceAuthorizedAt,
  ]) {
    if (timestamp && (Date.parse(timestamp) < createdMs || Date.parse(timestamp) > updatedMs)) invalid();
  }

  const slotsRaw = asObject(value.slots);
  const slotEntries = Object.entries(slotsRaw);
  if (slotEntries.length > INTAKE_MAX_SLOTS) invalid();
  const slots: Record<string, IntakeSlot> = {};
  const durableAssetIds = new Set<string>();
  const durablePathnames = new Set<string>();
  const reservationIds = new Set<string>();
  const registerAssetIdentity = (asset: Pick<IntakeAsset, 'assetId' | 'pathname'>): void => {
    if (durableAssetIds.has(asset.assetId) || durablePathnames.has(asset.pathname)) invalid();
    durableAssetIds.add(asset.assetId);
    durablePathnames.add(asset.pathname);
  };
  const registerReservationIdentity = (reservation: IntakeReservation): void => {
    if (reservationIds.has(reservation.reservationId)) invalid();
    reservationIds.add(reservation.reservationId);
    registerAssetIdentity(reservation);
  };
  let totalGenerations = 0;
  for (const [slotKey, slotRaw] of slotEntries) {
    const slotValue = asObject(slotRaw);
    assertExactKeys(slotValue, SLOT_KEYS);
    if (slotValue.slotKey !== slotKey) invalid();
    const category = slotValue.category as IntakeAssetCategory;
    assertCanonicalSlotIdentity({
      slotKey,
      category,
      familyCharacterId: slotValue.familyCharacterId ?? null,
      guidedStillIndex: slotValue.guidedStillIndex ?? null,
    });
    const generation = slotValue.generation;
    if (!isNonNegativeInt(generation) || generation === 0 || generation > INTAKE_MAX_SLOT_GENERATION) invalid();
    totalGenerations += generation;

    const identity = {
      slotKey,
      category,
      familyCharacterId: (slotValue.familyCharacterId ?? null) as string | null,
      guidedStillIndex: (slotValue.guidedStillIndex ?? null) as number | null,
      generation,
    };
    const parsedSlot: IntakeSlot = {
      ...identity,
      pending: slotValue.pending == null
        ? null
        : parseReservation(slotValue.pending, { intakeId, namespace, slot: identity }),
      active: slotValue.active == null
        ? null
        : parseAsset(slotValue.active, { intakeId, namespace, slot: identity, supersession: 'forbidden' }),
    };
    if (parsedSlot.pending || parsedSlot.active) {
      let authoritativeConsentAt: string;
      try {
        authoritativeConsentAt = consentTimestampFor(category, consent);
      } catch {
        invalid();
      }
      for (const media of [parsedSlot.pending, parsedSlot.active]) {
        if (media && media.consentAt !== authoritativeConsentAt) invalid();
        if (media && category === 'voice_inspiration' && media.voiceSource !== consent.voiceSource) invalid();
      }
    }
    if (parsedSlot.pending) registerReservationIdentity(parsedSlot.pending);
    if (parsedSlot.active) registerAssetIdentity(parsedSlot.active);
    slots[slotKey] = parsedSlot;
  }
  for (const [category, policy] of Object.entries(INTAKE_CATEGORY_POLICY)) {
    const occupied = Object.values(slots).filter(
      (slot) => slot.category === category && Boolean(slot.pending || slot.active),
    ).length;
    if (occupied > policy.maxSlots) invalid();
  }
  if (totalGenerations > INTAKE_MAX_TOTAL_GENERATIONS) invalid();

  if (!Array.isArray(value.superseded)) invalid();
  if (value.superseded.length > INTAKE_MAX_SUPERSEDED) invalid();
  const superseded = value.superseded.map((entry) => parseAsset(entry, {
    intakeId,
    namespace,
    supersession: 'required',
  }));
  for (const asset of superseded) registerAssetIdentity(asset);

  const assertLifecycleTime = (timestamp: string): void => {
    const time = Date.parse(timestamp);
    if (time < createdMs || time > updatedMs) invalid();
  };
  for (const slot of Object.values(slots)) {
    if (slot.pending) {
      assertLifecycleTime(slot.pending.reservedAt);
      if (Date.parse(slot.pending.reservedAt) < Date.parse(slot.pending.consentAt)) invalid();
    }
    if (slot.active) {
      assertLifecycleTime(slot.active.completedAt);
      if (Date.parse(slot.active.completedAt) < Date.parse(slot.active.consentAt)) invalid();
    }
  }
  for (const asset of superseded) {
    assertLifecycleTime(asset.completedAt);
    assertLifecycleTime(asset.supersededAt!);
  }

  const finalizedOrderId = value.finalizedOrderId;
  if (finalizedOrderId !== null
    && (typeof finalizedOrderId !== 'string' || !ORDER_ID_RE.test(finalizedOrderId))) invalid();

  let finalization: IntakeFinalization | null = null;
  if (value.finalization !== null) {
    const f = asObject(value.finalization);
    assertExactKeys(f, FINALIZATION_KEYS);
    if (typeof f.checkoutAttemptId !== 'string' || !CHECKOUT_ATTEMPT_ID_RE.test(f.checkoutAttemptId)) invalid();
    if (typeof f.orderId !== 'string' || !ORDER_ID_RE.test(f.orderId)) invalid();
    if (typeof f.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(f.fingerprint)) invalid();
    if (!isIsoTimestamp(f.reservedAt) || !isIsoTimestamp(f.leaseExpiresAt)) invalid();
    if (Date.parse(f.leaseExpiresAt as string) < Date.parse(f.reservedAt as string)) invalid();
    if (Date.parse(f.reservedAt as string) < createdMs
      || Date.parse(f.reservedAt as string) > updatedMs) invalid();
    if (!Array.isArray(f.selection)) invalid();
    if (f.selection.length > INTAKE_MAX_SLOTS) invalid();
    const selection = f.selection.map((entry) => parseSelectionEntry(entry, intakeId, namespace));
    const seenSlots = new Set<string>();
    const seenAssets = new Set<string>();
    const seenFamilyIndexes = new Set<number>();
    for (const entry of selection) {
      if (seenSlots.has(entry.slotKey) || seenAssets.has(entry.assetId)) invalid();
      seenSlots.add(entry.slotKey);
      seenAssets.add(entry.assetId);
      if (entry.familyCharacterIndex !== null) {
        if (seenFamilyIndexes.has(entry.familyCharacterIndex)) invalid();
        seenFamilyIndexes.add(entry.familyCharacterIndex);
      }
      const active = slots[entry.slotKey]?.active;
      if (!active
        || active.assetId !== entry.assetId
        || active.pathname !== entry.pathname
        || active.category !== entry.category
        || active.familyCharacterId !== entry.familyCharacterId
        || active.guidedStillIndex !== entry.guidedStillIndex
        || active.mimeType !== entry.mimeType
        || active.size !== entry.size
        || active.etag !== entry.etag
        || active.generation !== entry.generation
        || active.consentAt !== entry.consentAt
        || active.voiceSource !== entry.voiceSource) invalid();
    }
    const canonicalSlotOrder = [...selection].sort((a, b) => a.slotKey.localeCompare(b.slotKey));
    if (selection.some((entry, index) => entry.slotKey !== canonicalSlotOrder[index]!.slotKey)) invalid();
    if (f.fingerprint !== finalizationFingerprint(intakeId, selection)) invalid();
    finalization = {
      checkoutAttemptId: f.checkoutAttemptId,
      orderId: f.orderId,
      fingerprint: f.fingerprint,
      reservedAt: f.reservedAt as string,
      leaseExpiresAt: f.leaseExpiresAt as string,
      selection,
    };
  }
  if (finalizedOrderId !== null && (!finalization || finalization.orderId !== finalizedOrderId)) invalid();

  let cleanupClaim: IntakeCleanupClaim | null = null;
  if (value.cleanupClaim !== null) {
    const c = asObject(value.cleanupClaim);
    assertExactKeys(c, CLEANUP_CLAIM_KEYS);
    if (typeof c.claimId !== 'string' || !CLEANUP_CLAIM_ID_RE.test(c.claimId)) invalid();
    if (!isIsoTimestamp(c.claimedAt) || !isIsoTimestamp(c.expiresAt)) invalid();
    if (Date.parse(c.expiresAt as string) < Date.parse(c.claimedAt as string)) invalid();
    if (Date.parse(c.claimedAt as string) < createdMs
      || Date.parse(c.claimedAt as string) > updatedMs) invalid();
    cleanupClaim = { claimId: c.claimId, claimedAt: c.claimedAt as string, expiresAt: c.expiresAt as string };
  }

  return {
    version: INTAKE_RECORD_VERSION,
    intakeId,
    capabilityHash: value.capabilityHash,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    expiresAt: value.expiresAt as string,
    consent,
    slots,
    superseded,
    finalization,
    finalizedOrderId: finalizedOrderId as string | null,
    cleanupClaim,
  };
}

/**
 * One entry of the exact media tuple an order is bound to.
 *
 * Persisted so that "what did this order actually take" is answerable from the
 * record alone — by cleanup deciding what it may reclaim, and by any later
 * audit. An opaque fingerprint cannot answer either question.
 */
export function parseSelectionEntry(
  raw: unknown,
  intakeId: string,
  namespace: string,
): FinalizedSelectionEntry {
  const value = asObject(raw);
  assertExactKeys(value, SELECTION_KEYS);
  const category = value.category as IntakeAssetCategory;
  const slotKey = value.slotKey;
  if (typeof slotKey !== 'string' || !slotKey) invalid();
  assertCanonicalSlotIdentity({
    slotKey,
    category,
    familyCharacterId: value.familyCharacterId ?? null,
    guidedStillIndex: value.guidedStillIndex ?? null,
  });
  const assetId = value.assetId;
  if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) invalid();
  if (value.pathname !== intakeAssetPath(intakeId, assetId, namespace)) invalid();
  const policy = INTAKE_CATEGORY_POLICY[category];
  if (typeof value.mimeType !== 'string' || !policy.allowedMimeTypes.includes(value.mimeType)) invalid();
  if (!isNonNegativeInt(value.size) || value.size === 0 || value.size > policy.maxBytes) invalid();
  if (typeof value.etag !== 'string' || !ETAG_RE.test(value.etag)) invalid();
  if (!isNonNegativeInt(value.generation) || value.generation === 0) invalid();
  if (!isIsoTimestamp(value.consentAt)) invalid();
  const voiceSource = (value.voiceSource ?? null) as IntakeVoiceSource | null;
  if (category === 'voice_inspiration') {
    if (voiceSource !== 'recorded' && voiceSource !== 'uploaded') invalid();
  } else if (voiceSource !== null) invalid();
  const familyCharacterIndex = value.familyCharacterIndex ?? null;
  if (category === 'family_pet_reference') {
    if (!isNonNegativeInt(familyCharacterIndex)
      || familyCharacterIndex >= INTAKE_CATEGORY_POLICY.family_pet_reference.maxSlots) invalid();
  } else if (familyCharacterIndex !== null) {
    invalid();
  }
  return {
    slotKey,
    category,
    familyCharacterId: (value.familyCharacterId ?? null) as string | null,
    familyCharacterIndex: familyCharacterIndex as number | null,
    guidedStillIndex: (value.guidedStillIndex ?? null) as number | null,
    assetId,
    pathname: value.pathname as string,
    mimeType: value.mimeType,
    size: value.size,
    etag: value.etag,
    generation: value.generation,
    consentAt: value.consentAt as string,
    voiceSource,
  };
}

// ---------------------------------------------------------------------------
// Guarded read / mutate
// ---------------------------------------------------------------------------

/**
 * Reads and validates an intake, mapping every unreadable state to a
 * fail-closed error. Never returns a defaulted record.
 */
export async function readIntake(store: IntakeStore, intakeId: string): Promise<IntakeStoreSnapshot> {
  assertIntakeId(intakeId);
  let snapshot: IntakeStoreSnapshot | null;
  try {
    snapshot = await store.read(intakeId);
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    throw new IntakeError('intake_store_unavailable', 503);
  }
  if (!snapshot) throw new IntakeError('intake_not_found', 404);
  const record = parseIntakeRecord(snapshot.record);
  if (record.intakeId !== intakeId) throw new IntakeError('intake_record_invalid', 503);
  return { record, etag: snapshot.etag };
  // parseIntakeRecord resolves the namespace itself; the store was constructed
  // from the same environment, so the two always agree.
}

export function assertIntakeUsable(record: IntakeRecord, now: number): void {
  if (record.finalizedOrderId) throw new IntakeError('intake_already_finalized', 409);
  if (record.finalization) throw new IntakeError('intake_finalization_started', 409);
  // Expiry of a cleanup claim is not proof that the deleter has stopped.
  if (record.cleanupClaim) throw new IntakeError('intake_cleanup_in_progress', 409);
  if (Date.parse(record.expiresAt) <= now) throw new IntakeError('intake_expired', 410);
}

export function cleanupClaimActive(record: IntakeRecord, now: number): boolean {
  const claim = record.cleanupClaim;
  return Boolean(claim && Date.parse(claim.expiresAt) > now);
}

/**
 * True while a finalization reservation still fences this intake.
 *
 * An EXPIRED lease deliberately does not fence anything: a checkout that
 * crashed between reserving and creating its order must not lock the intake —
 * or block cleanup from ever reclaiming it — for the rest of the retention
 * window. Takeover safety comes from `markIntakeFinalized` binding to whatever
 * reservation is present at the time, not from the lease.
 */
export function finalizationLeaseActive(record: IntakeRecord, now: number): boolean {
  const finalization = record.finalization;
  return Boolean(finalization && Date.parse(finalization.leaseExpiresAt) > now);
}

const MUTATE_ATTEMPTS = 5;

/**
 * Bounded, deterministic backoff between CAS retry attempts (ms), one entry
 * per retry — i.e. `MUTATE_ATTEMPTS - 1` entries.
 *
 * WHY THIS EXISTS
 * ----------------
 * A Preview checkout incident showed a completion callback and the browser's
 * resolve/final-intake reconciliation both hitting
 * `intake_write_conflict` within the same short window, and the durable slot
 * was left with the upload never activated. Root cause: this loop used to
 * re-read on every attempt with NO delay between them, so all five attempts
 * fired within microseconds of each other. Vercel Blob's cross-request `read`
 * can lag briefly behind a write a different request already committed
 * (`useCache: false` on our `get` call only disables OUR application cache,
 * not the storage backend's own propagation window) — and when every attempt
 * lands inside that lagging window, exhaustion reports a permanent conflict
 * for what is really a transient visibility gap that would have resolved a
 * few tens of milliseconds later.
 *
 * The schedule is fixed and increasing, never random: a genuine, permanent
 * conflict (another writer that keeps winning, not a lagging read) must still
 * exhaust in bounded, predictable time and fail closed — this is spacing for
 * visibility to catch up, not a promise that it will.
 */
export const MUTATE_RETRY_BACKOFF_MS: readonly number[] = [20, 40, 80, 160];

export interface MutateIntakeIo {
  /** Test seam: replaces the real inter-attempt delay. Never overridden in production. */
  wait?: (delayMs: number, attempt: number) => Promise<void>;
}

function defaultMutateWait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Bounded retry for the immediate read that follows a client Blob upload.
 *
 * The upload callback can commit the slot before the browser's reconciliation
 * request reaches another function instance. During that short propagation
 * window private Blob `get()` may transiently fail even though the committed
 * record is already durable. Retry only the store-unavailable class; missing,
 * invalid, expired, or unauthorized records still fail closed immediately.
 */
export async function readIntakeWithTransientRetry(
  store: IntakeStore,
  intakeId: string,
  io: MutateIntakeIo = {},
): Promise<IntakeStoreSnapshot> {
  const wait = io.wait ?? defaultMutateWait;
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(MUTATE_RETRY_BACKOFF_MS[attempt - 1]!, attempt);
    try {
      return await readIntake(store, intakeId);
    } catch (error) {
      const retryable = error instanceof IntakeError
        && error.code === 'intake_store_unavailable'
        && attempt < MUTATE_ATTEMPTS - 1;
      if (!retryable) throw error;
    }
  }
  throw new IntakeError('intake_store_unavailable', 503);
}

/**
 * Read-modify-CAS with bounded retries.
 *
 * `apply` returns `{ next, result }`; a null `next` means "nothing to write"
 * and short-circuits. Exhausting the attempts is a 409, never a silent
 * last-writer-wins.
 */
export async function mutateIntake<T>(
  store: IntakeStore,
  intakeId: string,
  apply: (record: IntakeRecord) => { next: IntakeRecord | null; result: T },
  io: MutateIntakeIo = {},
): Promise<T> {
  const wait = io.wait ?? defaultMutateWait;
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await wait(MUTATE_RETRY_BACKOFF_MS[attempt - 1]!, attempt);
    }
    const snapshot = await readIntake(store, intakeId);
    const { next, result } = apply(snapshot.record);
    if (!next) return result;
    assertIntakeRecordWritable(next);
    let swapped: boolean;
    try {
      swapped = await store.compareAndSwap(intakeId, snapshot.etag, next);
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      throw new IntakeError('intake_store_unavailable', 503);
    }
    if (swapped) return result;
  }
  throw new IntakeError('intake_write_conflict', 409);
}

export function touch(record: IntakeRecord, now: Date): IntakeRecord {
  const monotonic = Math.max(Date.parse(record.updatedAt), now.getTime());
  return { ...record, updatedAt: new Date(monotonic).toISOString() };
}

export function assertIntakeRecordWritable(record: IntakeRecord): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    invalid();
  }
  // Validate the exact bytes that the store writer will persist. Parsing the
  // in-memory object alone is insufficient because JSON.stringify omits
  // required properties whose value is undefined.
  parseIntakeRecord(JSON.parse(serialized));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function createIntake(
  store: IntakeStore,
  consent: IntakeConsent,
  now = new Date(),
): Promise<{ intakeId: string; capability: string; expiresAt: string }> {
  const { record, capability } = createIntakeRecord(consent, now);
  assertIntakeRecordWritable(record);
  await store.create(record);
  return { intakeId: record.intakeId, capability, expiresAt: record.expiresAt };
}

/**
 * Widens consent on an existing intake (adding voice or document permission).
 * Consent is only ever added, never revoked here — a revocation has to remove
 * the affected media, which is `releaseSlot`'s job.
 */
export async function refreshIntakeConsent(
  store: IntakeStore,
  params: { intakeId: string; capability: string; consent: Partial<IntakeConsent> },
  now = new Date(),
): Promise<IntakeConsent> {
  return mutateIntake(store, params.intakeId, (record) => {
    assertCapability(record, params.capability);
    assertIntakeUsable(record, now.getTime());
    const requestedVoiceSource = params.consent.voiceSource ?? null;
    const voiceOccupied = Object.values(record.slots).some(
      (slot) => slot.category === 'voice_inspiration' && Boolean(slot.pending || slot.active),
    );
    if (voiceOccupied && requestedVoiceSource && record.consent.voiceSource
      && requestedVoiceSource !== record.consent.voiceSource) {
      throw new IntakeError('voice_source_change_requires_release', 409);
    }
    const voiceSource = requestedVoiceSource || record.consent.voiceSource || null;
    const authorizationAt = new Date(Math.max(Date.parse(record.updatedAt), now.getTime())).toISOString();
    const childVoiceAuthorizedAt = record.consent.voiceSource === voiceSource
      ? record.consent.childVoiceAuthorizedAt || (params.consent.childVoiceAuthorizedAt ? authorizationAt : null)
      : params.consent.childVoiceAuthorizedAt ? authorizationAt : null;
    const consent: IntakeConsent = {
      mediaAuthorizedAt: record.consent.mediaAuthorizedAt,
      documentAuthorizedAt: record.consent.documentAuthorizedAt
        || (params.consent.documentAuthorizedAt ? authorizationAt : null),
      childVoiceAuthorizedAt,
      voiceSource,
    };
    const unchanged = consent.documentAuthorizedAt === record.consent.documentAuthorizedAt
      && consent.childVoiceAuthorizedAt === record.consent.childVoiceAuthorizedAt
      && consent.voiceSource === record.consent.voiceSource;
    if (unchanged) return { next: null, result: consent };
    return { next: { ...touch(record, now), consent }, result: consent };
  });
}

export interface IntakeSlotView {
  slotKey: string;
  category: IntakeAssetCategory;
  familyCharacterId: string | null;
  guidedStillIndex: number | null;
  generation: number;
  /** The generation of the in-flight reservation, or null when there is none. */
  pendingGeneration: number | null;
  asset: IntakeAsset | null;
}

/**
 * The buyer-visible view of an intake: one entry per slot that currently holds
 * media or has an upload in flight. Superseded assets are never listed.
 */
export async function listIntakeSlots(
  store: IntakeStore,
  params: { intakeId: string; capability: string },
  now = new Date(),
): Promise<{ slots: IntakeSlotView[]; expiresAt: string }> {
  const { record } = await readIntake(store, params.intakeId);
  assertCapability(record, params.capability);
  if (Date.parse(record.expiresAt) <= now.getTime()) throw new IntakeError('intake_expired', 410);
  const slots = Object.values(record.slots)
    .filter((slot) => slot.active || slot.pending)
    .map((slot) => ({
      slotKey: slot.slotKey,
      category: slot.category,
      familyCharacterId: slot.familyCharacterId,
      guidedStillIndex: slot.guidedStillIndex,
      generation: slot.generation,
      pendingGeneration: slot.pending ? slot.pending.generation : null,
      asset: slot.active,
    }))
    .sort((a, b) => a.slotKey.localeCompare(b.slotKey));
  return { slots, expiresAt: record.expiresAt };
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

/*
 * Reserving a finalization lives in `checkout-finalize.ts`, not here.
 *
 * It cannot be a standalone record mutation: reserving safely requires the
 * SAME read that validated the selection, so that the compare-and-swap is
 * against the exact version the validation judged. Exposing a reserve step
 * that re-reads the record is what produced the reproduced TOCTOU — a caller
 * composing validate-then-reserve had no way to link the two.
 */

/**
 * Records that the order this intake was reserved for actually exists.
 *
 * Binds to the reservation PRESENT AT THIS MOMENT. That is what makes lease
 * takeover safe: once another attempt has taken the reservation over, the
 * abandoned attempt's call lands on a reservation naming a different order and
 * is refused, so two orders can never both believe they own this media.
 *
 * Lease expiry alone does NOT block marking — an order that was really created
 * must still be able to claim its media, even if the request was slow.
 */
export async function markIntakeFinalized(
  store: IntakeStore,
  params: { intakeId: string; capability: string; orderId: string },
  now = new Date(),
): Promise<void> {
  return mutateIntake(store, params.intakeId, (record) => {
    assertCapability(record, params.capability);
    if (record.finalizedOrderId === params.orderId) return { next: null, result: undefined };
    if (record.finalizedOrderId) throw new IntakeError('intake_already_finalized', 409);
    if (record.cleanupClaim) throw new IntakeError('intake_cleanup_in_progress', 409);
    if (!record.finalization || record.finalization.orderId !== params.orderId) {
      throw new IntakeError('intake_finalization_not_reserved', 409);
    }
    return {
      next: { ...touch(record, now), finalizedOrderId: params.orderId },
      result: undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Vercel Blob store
// ---------------------------------------------------------------------------

/**
 * The dedicated intake credential.
 *
 * "Dedicated" is checked by Blob STORE ID, not by string inequality: two
 * different credentials issued for the same store are two different strings
 * addressing one keyspace, which is precisely the misconfiguration this is
 * meant to refuse.
 */
export function getRequiredIntakeBlobToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env[INTAKE_TOKEN_ENV]?.trim();
  if (!token) throw new IntakeError('intake_store_unavailable', 503);
  try {
    parseBlobToken(token, 'intake');
    assertDistinctBlobStores([
      { label: 'intake', token },
      { label: 'order', token: env.BLOB_READ_WRITE_TOKEN?.trim() },
      { label: 'guard', token: env.HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN?.trim() },
    ]);
  } catch {
    // The underlying error names the role but never the value; collapse it to
    // the fail-closed code the routes already handle.
    throw new IntakeError('intake_store_must_be_dedicated', 503);
  }
  return token;
}

/**
 * `io` is a narrow test seam for the provider calls whose FAILURE MODES matter
 * and cannot be produced any other way. Production passes nothing.
 */
export interface IntakeStoreIo {
  get?: typeof get;
  put?: typeof put;
  head?: typeof head;
}

/**
 * Matched by class where possible and by name otherwise: the SDK constructs
 * its errors internally, and a bundler that ends up with two copies of
 * `@vercel/blob` would break an `instanceof`-only check in the direction that
 * turns a missing object into a fake outage.
 */
function isBlobNotFound(error: unknown): boolean {
  if (error instanceof BlobNotFoundError) return true;
  return Boolean(error && typeof error === 'object' && (error as Error).name === 'BlobNotFoundError');
}

export function createVercelIntakeStore(
  token = getRequiredIntakeBlobToken(),
  env: NodeJS.ProcessEnv = process.env,
  io: IntakeStoreIo = {},
): IntakeStore {
  // Resolved once, at construction: a namespace misconfiguration must stop the
  // store from existing, not surface later as a path that silently went flat.
  const namespace = getBlobNamespace(env);
  const getImpl = io.get ?? get;
  const putImpl = io.put ?? put;
  return {
    async create(record) {
      assertIntakeRecordWritable(record);
      await putImpl(intakeRecordPath(record.intakeId, namespace), JSON.stringify(record), {
        access: 'private',
        token,
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'application/json',
      });
    },

    async read(intakeId) {
      // `useCache: false` is required: a cached read would let a stale record
      // win a CAS and silently drop a concurrent write.
      const result = await getImpl(intakeRecordPath(intakeId, namespace), { access: 'private', token, useCache: false });
      if (!result || !result.stream) return null;
      const text = await readJsonTextWithLimit(result.stream, INTAKE_MAX_RECORD_BYTES);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new IntakeError('intake_record_invalid', 503);
      }
      const etag = normalizeEtagForIfMatch(result.blob.etag);
      if (!etag) throw new IntakeError('intake_store_unavailable', 503);
      return { record: raw as IntakeRecord, etag };
    },

    async compareAndSwap(intakeId, etag, record) {
      try {
        if (record.intakeId !== intakeId) throw new IntakeError('intake_record_invalid', 503);
        assertIntakeRecordWritable(record);
        await putImpl(intakeRecordPath(intakeId, namespace), JSON.stringify(record), {
          access: 'private',
          token,
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: 'application/json',
          ifMatch: etag,
        });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false;
        throw error;
      }
    },

    /**
     * ABSENT and UNREADABLE are different answers.
     *
     * `null` means the object is genuinely not there — the normal "the upload
     * has not landed yet" case, which callers report as pending. A provider
     * failure means we cannot tell, and saying "not there" would turn an
     * outage into a silently stuck upload: the buyer waits, the retry logic
     * sees nothing wrong, and nobody is paged. So it fails closed and loudly,
     * as a retryable 503.
     */
    async headAsset(pathname) {
      try {
        const blob = await (io.head ?? head)(pathname, { token });
        return {
          pathname: blob.pathname,
          mimeType: blob.contentType,
          size: blob.size,
          etag: blob.etag,
        };
      } catch (error) {
        if (isBlobNotFound(error)) return null;
        throw new IntakeError('intake_store_unavailable', 503);
      }
    },
  };
}
