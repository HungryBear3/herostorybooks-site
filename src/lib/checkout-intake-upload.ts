/**
 * The upload half of the checkout intake state machine: reserve a slot
 * generation, accept exactly one completion for it, and fence everything else.
 *
 * Three operations and one rule.
 *
 *   reserveSlotUpload  bumps the slot's generation, replaces its single
 *                      pending reservation, and issues an upload token that
 *                      names that generation.
 *   completeSlotUpload accepts the Vercel Blob completion callback.
 *   releaseSlot        cancels/removes, by bumping the generation.
 *
 * THE RULE: a completion may only change slot state while the generation it
 * was issued for is still the slot's current generation AND the slot's pending
 * reservation is still the one it was issued against. Everything else returns
 * `stale` — never an error the client has to interpret, never a write that can
 * resurrect a selection the buyer has already replaced or removed.
 *
 * Note what is deliberately absent: there is no path that overwrites bytes.
 * Each generation reserves a fresh random asset id and therefore a fresh
 * pathname, so the client token can always be issued with
 * `allowOverwrite: false`, and reconciling a lost upload response
 * (`resolveSlotUpload`) is an exact comparison of pathname, MIME and size
 * against the reservation rather than a blind re-put.
 */
import {
  assertCapability,
  assertIntakeUsable,
  assertUploadPolicy,
  INTAKE_CATEGORY_POLICY,
  INTAKE_MAX_SLOT_GENERATION,
  INTAKE_MAX_SLOTS,
  INTAKE_MAX_SUPERSEDED,
  INTAKE_MAX_TOTAL_GENERATIONS,
  IntakeError,
  intakeAssetPath,
  mutateIntake,
  newAssetId,
  newReservationId,
  normalizeSlotRef,
  readIntake,
  readIntakeWithTransientRetry,
  touch,
  type IntakeAsset,
  type IntakeRecord,
  type IntakeReservation,
  type IntakeSlot,
  type IntakeStore,
  type MutateIntakeIo,
  type SlotRef,
} from './checkout-intake.ts';

export const UPLOAD_TOKEN_PAYLOAD_VERSION = 2;
/** Vercel caps `clientPayload`/`tokenPayload`; stay well inside it. */
export const UPLOAD_TOKEN_PAYLOAD_MAX_BYTES = 2048;

export interface UploadTokenPayload {
  v: typeof UPLOAD_TOKEN_PAYLOAD_VERSION;
  intakeId: string;
  capabilityHash: string;
  slotKey: string;
  generation: number;
  reservationId: string;
  assetId: string;
  consentAt: string;
  voiceSource: 'recorded' | 'uploaded' | null;
}

export interface SlotUploadReservation {
  slotKey: string;
  generation: number;
  reservationId: string;
  assetId: string;
  pathname: string;
  /** The canonical MIME the reservation holds; the upload must use exactly this. */
  mimeType: string;
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  /** Opaque payload echoed back by Vercel on the completion callback. */
  tokenPayload: string;
}

export type SlotCompletionStatus = 'activated' | 'idempotent' | 'stale';

export interface SlotCompletionResult {
  status: SlotCompletionStatus;
  asset: IntakeAsset | null;
  /** Set on `stale`, for logs. Never surfaced to the buyer as an error. */
  staleReason?: string;
}

export interface CompletedBlob {
  pathname: string;
  contentType: string;
  size: number;
  etag: string;
}

function buildTokenPayload(payload: UploadTokenPayload): string {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, 'utf8') > UPLOAD_TOKEN_PAYLOAD_MAX_BYTES) {
    throw new IntakeError('upload_token_payload_too_large');
  }
  return encoded;
}

export function parseUploadTokenPayload(raw: unknown): UploadTokenPayload {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > UPLOAD_TOKEN_PAYLOAD_MAX_BYTES) {
    throw new IntakeError('upload_token_payload_invalid', 403);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IntakeError('upload_token_payload_invalid', 403);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IntakeError('upload_token_payload_invalid', 403);
  }
  const value = parsed as Record<string, unknown>;
  const tokenKeys = [
    'v', 'intakeId', 'capabilityHash', 'slotKey', 'generation',
    'reservationId', 'assetId', 'consentAt', 'voiceSource',
  ];
  if (Object.keys(value).length !== tokenKeys.length
    || tokenKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !tokenKeys.includes(key))
    || value.v !== UPLOAD_TOKEN_PAYLOAD_VERSION
    || typeof value.intakeId !== 'string'
    || typeof value.capabilityHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.capabilityHash)
    || typeof value.slotKey !== 'string'
    || !value.slotKey
    || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || typeof value.reservationId !== 'string'
    || !/^res_[a-f0-9]{32}$/.test(value.reservationId)
    || typeof value.assetId !== 'string'
    || !/^asset_[a-f0-9]{32}$/.test(value.assetId)
    || typeof value.consentAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.consentAt)
    || !Number.isFinite(Date.parse(value.consentAt))
    || (value.voiceSource !== null && value.voiceSource !== 'recorded' && value.voiceSource !== 'uploaded')) {
    throw new IntakeError('upload_token_payload_invalid', 403);
  }
  return {
    v: UPLOAD_TOKEN_PAYLOAD_VERSION,
    intakeId: value.intakeId,
    capabilityHash: value.capabilityHash,
    slotKey: value.slotKey,
    generation: value.generation as number,
    reservationId: value.reservationId,
    assetId: value.assetId,
    consentAt: value.consentAt,
    voiceSource: value.voiceSource as 'recorded' | 'uploaded' | null,
  };
}

function emptySlot(ref: ReturnType<typeof normalizeSlotRef>): IntakeSlot {
  return {
    slotKey: ref.slotKey,
    category: ref.category,
    familyCharacterId: ref.familyCharacterId,
    guidedStillIndex: ref.guidedStillIndex,
    generation: 0,
    pending: null,
    active: null,
  };
}

function slotOccupied(slot: IntakeSlot | undefined): boolean {
  return Boolean(slot && (slot.active || slot.pending));
}

/**
 * Total reservations this intake has ever issued.
 *
 * Generations are the real churn measure. Counting `superseded` entries only
 * bounds the audit list: an upload that is reserved and then abandoned never
 * completes, so it never becomes a superseded asset, and an intake could
 * previously issue reservations forever while that list stayed empty. Slot
 * TOMBSTONES have the same problem — a removed family character leaves an
 * empty slot that is neither occupied nor superseded.
 */
function totalGenerations(record: IntakeRecord): number {
  return Object.values(record.slots).reduce((sum, slot) => sum + slot.generation, 0);
}

/**
 * Records an asset as no longer bound to a slot.
 *
 * The list is an audit trail and a churn bound, not the cleanup index: cleanup
 * sweeps by storage prefix, so bytes are reclaimed even if this list never saw
 * them. Duplicate entries are ignored so a replayed callback cannot inflate
 * the churn counter.
 */
function withSuperseded(
  record: IntakeRecord,
  asset: IntakeAsset,
  supersededAt: string,
  reason: IntakeAsset['supersededReason'],
): IntakeAsset[] {
  if (record.superseded.some((entry) => entry.assetId === asset.assetId)) return record.superseded;
  return [...record.superseded, { ...asset, supersededAt, supersededReason: reason }];
}

export interface ReserveSlotUploadInput {
  intakeId: string;
  capability: string;
  slot: SlotRef;
  mimeType: string;
  size: number;
}

/**
 * Read-only authorization and policy validation used before spending upload
 * capacity. The mutation repeats these checks against its own CAS snapshot;
 * this first pass ensures forged capabilities and impossible reservations can
 * never consume the expensive byte/reservation counters.
 */
export async function preflightSlotUploadReservation(
  store: IntakeStore,
  input: ReserveSlotUploadInput,
  now = new Date(),
): Promise<void> {
  const ref = normalizeSlotRef(input.slot);
  const { record } = await readIntake(store, input.intakeId);
  assertCapability(record, input.capability);
  assertIntakeUsable(record, now.getTime());
  assertUploadPolicy({
    category: ref.category,
    mimeType: input.mimeType,
    size: input.size,
    consent: record.consent,
  });
  if (record.superseded.length >= INTAKE_MAX_SUPERSEDED) {
    throw new IntakeError('intake_replacement_limit', 429);
  }
  const current = record.slots[ref.slotKey];
  if (!current && Object.keys(record.slots).length >= INTAKE_MAX_SLOTS) {
    throw new IntakeError('intake_slot_limit_exceeded', 429);
  }
  if (!slotOccupied(current)) {
    const occupiedInCategory = Object.values(record.slots)
      .filter((slot) => slot.category === ref.category && slotOccupied(slot)).length;
    if (occupiedInCategory >= INTAKE_CATEGORY_POLICY[ref.category].maxSlots) {
      throw new IntakeError('asset_slot_limit_exceeded', 409);
    }
  }
  const generation = (current?.generation ?? 0) + 1;
  if (generation > INTAKE_MAX_SLOT_GENERATION) {
    throw new IntakeError('intake_slot_churn_exceeded', 429);
  }
  if (totalGenerations(record) + 1 > INTAKE_MAX_TOTAL_GENERATIONS) {
    throw new IntakeError('intake_churn_exceeded', 429);
  }
}

/**
 * Claims the next generation of a slot and issues an upload authorization for
 * it.
 *
 * Bumping the generation is what makes reselection work: whatever was in
 * flight for the previous generation is superseded here and now, so a lost or
 * slow callback can never hold the slot hostage. The previous COMPLETED asset
 * is deliberately left in place until this upload actually lands, so a failed
 * replacement does not lose the photo the buyer already had.
 */
export async function reserveSlotUpload(
  store: IntakeStore,
  input: ReserveSlotUploadInput,
  now = new Date(),
): Promise<SlotUploadReservation> {
  const ref = normalizeSlotRef(input.slot);
  return mutateIntake(store, input.intakeId, (record) => {
    assertCapability(record, input.capability);
    assertIntakeUsable(record, now.getTime());
    const { consentAt, mimeType } = assertUploadPolicy({
      category: ref.category,
      mimeType: input.mimeType,
      size: input.size,
      consent: record.consent,
    });
    if (record.superseded.length >= INTAKE_MAX_SUPERSEDED) {
      throw new IntakeError('intake_replacement_limit', 429);
    }

    const current = record.slots[ref.slotKey];
    if (!current && Object.keys(record.slots).length >= INTAKE_MAX_SLOTS) {
      // Includes tombstones: a removed family character keeps its slot entry
      // so its generation counter survives, and that entry is not free.
      throw new IntakeError('intake_slot_limit_exceeded', 429);
    }
    if (!slotOccupied(current)) {
      const occupiedInCategory = Object.values(record.slots)
        .filter((slot) => slot.category === ref.category && slotOccupied(slot)).length;
      if (occupiedInCategory >= INTAKE_CATEGORY_POLICY[ref.category].maxSlots) {
        throw new IntakeError('asset_slot_limit_exceeded', 409);
      }
    }

    const base = current ?? emptySlot(ref);
    const generation = base.generation + 1;
    if (generation > INTAKE_MAX_SLOT_GENERATION) {
      throw new IntakeError('intake_slot_churn_exceeded', 429);
    }
    if (totalGenerations(record) + 1 > INTAKE_MAX_TOTAL_GENERATIONS) {
      throw new IntakeError('intake_churn_exceeded', 429);
    }
    const assetId = newAssetId();
    const reservedAt = new Date(Math.max(now.getTime(), Date.parse(record.updatedAt))).toISOString();
    const reservation: IntakeReservation = {
      reservationId: newReservationId(),
      assetId,
      generation,
      pathname: intakeAssetPath(record.intakeId, assetId),
      mimeType,
      size: input.size,
      consentAt,
      voiceSource: ref.category === 'voice_inspiration' ? record.consent.voiceSource! : null,
      reservedAt,
    };
    const next: IntakeRecord = {
      ...touch(record, now),
      slots: {
        ...record.slots,
        [ref.slotKey]: { ...base, ...ref, generation, pending: reservation },
      },
    };
    const result: SlotUploadReservation = {
      slotKey: ref.slotKey,
      generation,
      reservationId: reservation.reservationId,
      assetId,
      pathname: reservation.pathname,
      mimeType: reservation.mimeType,
      allowedContentTypes: [...INTAKE_CATEGORY_POLICY[ref.category].allowedMimeTypes],
      maximumSizeInBytes: INTAKE_CATEGORY_POLICY[ref.category].maxBytes,
      tokenPayload: buildTokenPayload({
        v: UPLOAD_TOKEN_PAYLOAD_VERSION,
        intakeId: record.intakeId,
        capabilityHash: record.capabilityHash,
        slotKey: ref.slotKey,
        generation,
        reservationId: reservation.reservationId,
        assetId,
        consentAt: reservation.consentAt,
        voiceSource: reservation.voiceSource,
      }),
    };
    return { next, result };
  });
}

/**
 * Activates the slot from a completed upload, if and only if the completion
 * still belongs to the current generation.
 *
 * Shared by the Vercel completion callback and by `resolveSlotUpload`, so the
 * "lost callback" recovery path cannot diverge from the callback path.
 */
async function applyCompletion(
  store: IntakeStore,
  payload: UploadTokenPayload,
  blob: CompletedBlob,
  now: Date,
  io: MutateIntakeIo = {},
): Promise<SlotCompletionResult> {
  // The destination is derived, never taken from the callback: a completion
  // for one asset id can only ever write that asset id's own path.
  const expectedPath = intakeAssetPath(payload.intakeId, payload.assetId);
  if (blob.pathname !== expectedPath) throw new IntakeError('asset_prefix_mismatch', 403);

  return mutateIntake(store, payload.intakeId, (record) => {
    if (record.capabilityHash !== payload.capabilityHash) {
      throw new IntakeError('upload_callback_invalid', 403);
    }

    // A record that has moved on (finalized, finalizing, expired, or being
    // cleaned up) is never written by a late callback. The bytes become an
    // orphan and the prefix sweep reclaims them.
    if (record.finalizedOrderId) return staleResult('intake_finalized');
    if (record.finalization) return staleResult('intake_finalization_started');
    if (record.cleanupClaim) return staleResult('intake_cleanup_in_progress');
    if (Date.parse(record.expiresAt) <= now.getTime()) return staleResult('intake_expired');

    const slot = record.slots[payload.slotKey];
    if (!slot) return staleResult('slot_missing');

    // Replay of the callback that already won.
    if (slot.active && slot.active.assetId === payload.assetId) {
      const active = slot.active;
      if (active.pathname !== blob.pathname
        || active.mimeType !== blob.contentType
        || active.size !== blob.size
        || active.etag !== blob.etag) {
        throw new IntakeError('asset_metadata_mismatch', 409);
      }
      return { next: null, result: { status: 'idempotent' as const, asset: active } };
    }

    if (slot.generation !== payload.generation) return staleResult('generation_superseded');
    const pending = slot.pending;
    if (!pending) return staleResult('reservation_released');
    if (pending.reservationId !== payload.reservationId) return staleResult('reservation_superseded');

    // Exact convergence check. Anything that does not match the reservation
    // byte-for-byte is refused rather than adopted.
    if (blob.pathname !== pending.pathname
      || blob.contentType !== pending.mimeType
      || blob.size !== pending.size
      || typeof blob.etag !== 'string'
      || !blob.etag) {
      throw new IntakeError('asset_metadata_mismatch', 409);
    }

    const completedAt = new Date(Math.max(
      now.getTime(), Date.parse(record.updatedAt), Date.parse(pending.reservedAt),
    )).toISOString();
    const asset: IntakeAsset = {
      assetId: pending.assetId,
      slotKey: slot.slotKey,
      category: slot.category,
      familyCharacterId: slot.familyCharacterId,
      guidedStillIndex: slot.guidedStillIndex,
      generation: pending.generation,
      pathname: pending.pathname,
      mimeType: pending.mimeType,
      size: pending.size,
      etag: blob.etag,
      consentAt: pending.consentAt,
      voiceSource: pending.voiceSource,
      completedAt,
      supersededAt: null,
      supersededReason: null,
    };
    const superseded = slot.active
      ? withSuperseded(record, slot.active, completedAt, 'replaced')
      : record.superseded;
    const next: IntakeRecord = {
      ...touch(record, now),
      slots: { ...record.slots, [slot.slotKey]: { ...slot, pending: null, active: asset } },
      superseded,
    };
    return { next, result: { status: 'activated' as const, asset } };

    /**
     * A stale completion records the orphaned bytes for audit and returns
     * without touching slot state. It never throws: Vercel would retry a
     * throw, and there is nothing to retry.
     */
    function staleResult(reason: string): { next: IntakeRecord | null; result: SlotCompletionResult } {
      const orphanCategory = record.slots[payload.slotKey]?.category ?? 'primary_hero_photo';
      const orphan: IntakeAsset = {
        assetId: payload.assetId,
        slotKey: payload.slotKey,
        category: orphanCategory,
        familyCharacterId: record.slots[payload.slotKey]?.familyCharacterId ?? null,
        guidedStillIndex: record.slots[payload.slotKey]?.guidedStillIndex ?? null,
        generation: payload.generation,
        pathname: blob.pathname,
        mimeType: blob.contentType,
        size: blob.size,
        etag: blob.etag || 'unknown',
        consentAt: payload.consentAt,
        voiceSource: payload.voiceSource,
        completedAt: new Date(Math.max(now.getTime(), Date.parse(record.updatedAt))).toISOString(),
      };
      const result: SlotCompletionResult = { status: 'stale', asset: null, staleReason: reason };
      // Do not write to a record that has been finalized or claimed for
      // cleanup; the prefix sweep still reclaims the bytes.
      const writable = !record.finalizedOrderId
        && !record.finalization
        && !record.cleanupClaim
        && Date.parse(record.expiresAt) > now.getTime()
        && record.superseded.length < INTAKE_MAX_SUPERSEDED;
      if (!writable) return { next: null, result };
      const orphanedAt = new Date(Math.max(now.getTime(), Date.parse(record.updatedAt))).toISOString();
      const superseded = withSuperseded(record, orphan, orphanedAt, 'stale_callback');
      if (superseded === record.superseded) return { next: null, result };
      return { next: { ...touch(record, now), superseded }, result };
    }
  }, io);
}

export async function completeSlotUpload(
  store: IntakeStore,
  input: { tokenPayload: unknown; blob: CompletedBlob },
  now = new Date(),
  io: MutateIntakeIo = {},
): Promise<SlotCompletionResult> {
  const payload = parseUploadTokenPayload(input.tokenPayload);
  return applyCompletion(store, payload, input.blob, now, io);
}

/**
 * Cancels whatever is in flight for a slot and clears its completed asset.
 *
 * Used for Remove and for the cancel half of Change/reselect. The slot ENTRY
 * survives with its bumped generation even though it now holds nothing —
 * deleting it would reset the counter to zero and let a stale callback for
 * generation 1 win a second time.
 */
export async function releaseSlot(
  store: IntakeStore,
  params: { intakeId: string; capability: string; slot: SlotRef },
  now = new Date(),
): Promise<{ slotKey: string; generation: number }> {
  const ref = normalizeSlotRef(params.slot);
  return mutateIntake(store, params.intakeId, (record) => {
    assertCapability(record, params.capability);
    assertIntakeUsable(record, now.getTime());
    const slot = record.slots[ref.slotKey];
    if (!slot) return { next: null, result: { slotKey: ref.slotKey, generation: 0 } };
    if (!slot.active && !slot.pending) {
      return { next: null, result: { slotKey: ref.slotKey, generation: slot.generation } };
    }
    const removedAt = new Date(Math.max(now.getTime(), Date.parse(record.updatedAt))).toISOString();
    // Removal bumps the generation as belt-and-braces, but only while that
    // stays inside the churn bounds. It is never refused for being over them:
    // a buyer must always be able to take their photo back out, and clearing
    // `pending` is on its own enough to fence an in-flight callback (see
    // `applyCompletion`, which treats a released reservation as stale).
    const withinChurn = slot.generation + 1 <= INTAKE_MAX_SLOT_GENERATION
      && totalGenerations(record) + 1 <= INTAKE_MAX_TOTAL_GENERATIONS;
    const generation = withinChurn ? slot.generation + 1 : slot.generation;
    const superseded = slot.active && record.superseded.length < INTAKE_MAX_SUPERSEDED
      ? withSuperseded(record, slot.active, removedAt, 'removed')
      : record.superseded;
    const next: IntakeRecord = {
      ...touch(record, now),
      slots: {
        ...record.slots,
        [ref.slotKey]: { ...slot, generation, pending: null, active: null },
      },
      superseded,
    };
    return { next, result: { slotKey: ref.slotKey, generation } };
  });
}

export type SlotResolutionStatus = SlotCompletionStatus | 'pending';

/**
 * Reconciles a slot whose upload response or completion callback was lost.
 *
 * This is the ONLY recovery path, and it converges only on exact agreement:
 * the slot must still be at the generation the caller names, a reservation
 * must still be pending for it, and the object in storage must match that
 * reservation's pathname, MIME type and size. Anything else is `pending`,
 * `stale`, or a conflict — never an overwrite.
 */
export async function resolveSlotUpload(
  store: IntakeStore,
  params: { intakeId: string; capability: string; slot: SlotRef; generation: number },
  now = new Date(),
  io: MutateIntakeIo = {},
): Promise<{ status: SlotResolutionStatus; asset: IntakeAsset | null }> {
  const ref = normalizeSlotRef(params.slot);
  const { record } = await readIntakeWithTransientRetry(store, params.intakeId, io);
  assertCapability(record, params.capability);
  if (Date.parse(record.expiresAt) <= now.getTime()) throw new IntakeError('intake_expired', 410);

  const slot = record.slots[ref.slotKey];
  if (!slot) return { status: 'stale', asset: null };
  if (slot.active && slot.active.generation === params.generation) {
    return { status: 'idempotent', asset: slot.active };
  }
  if (slot.generation !== params.generation) return { status: 'stale', asset: null };
  const pending = slot.pending;
  if (!pending) return { status: 'stale', asset: null };

  const object = await store.headAsset(pending.pathname);
  if (!object) return { status: 'pending', asset: null };
  if (object.pathname !== pending.pathname
    || object.mimeType !== pending.mimeType
    || object.size !== pending.size
    || !object.etag) {
    throw new IntakeError('asset_metadata_mismatch', 409);
  }

  return applyCompletion(
    store,
    {
      v: UPLOAD_TOKEN_PAYLOAD_VERSION,
      intakeId: record.intakeId,
      capabilityHash: record.capabilityHash,
      slotKey: slot.slotKey,
      generation: pending.generation,
      reservationId: pending.reservationId,
      assetId: pending.assetId,
      consentAt: pending.consentAt,
      voiceSource: pending.voiceSource,
    },
    {
      pathname: object.pathname,
      contentType: object.mimeType,
      size: object.size,
      etag: object.etag,
    },
    now,
    io,
  );
}

export interface ReservedUploadAuthorization {
  pathname: string;
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
  tokenPayload: string;
}

/**
 * Authorizes a client upload token for a reservation that ALREADY exists.
 *
 * The browser reserves the slot on the intake route first and is told the
 * exact pathname to upload to; this step only confirms that the reservation is
 * still current and hands Vercel a token pinned to it. Splitting it that way
 * is what lets the token be issued with `allowOverwrite: false` and an
 * allow-list of exactly one content type and one size: there is nothing to
 * negotiate here, only to verify.
 */
export async function authorizeReservedUpload(
  store: IntakeStore,
  params: {
    intakeId: string;
    capability: string;
    slotKey: string;
    generation: number;
    reservationId: string;
    pathname: string;
  },
  now = new Date(),
): Promise<ReservedUploadAuthorization> {
  const { record } = await readIntake(store, params.intakeId);
  assertCapability(record, params.capability);
  assertIntakeUsable(record, now.getTime());

  const slot = record.slots[params.slotKey];
  if (!slot) throw new IntakeError('upload_reservation_missing', 409);
  if (slot.generation !== params.generation) throw new IntakeError('upload_generation_superseded', 409);
  const pending = slot.pending;
  if (!pending || pending.reservationId !== params.reservationId) {
    throw new IntakeError('upload_reservation_missing', 409);
  }
  if (params.pathname !== pending.pathname) throw new IntakeError('asset_prefix_mismatch', 403);

  return {
    pathname: pending.pathname,
    // Exactly what was reserved — not the whole category allow-list.
    allowedContentTypes: [pending.mimeType],
    maximumSizeInBytes: pending.size,
    tokenPayload: buildTokenPayload({
      v: UPLOAD_TOKEN_PAYLOAD_VERSION,
      intakeId: record.intakeId,
      capabilityHash: record.capabilityHash,
      slotKey: slot.slotKey,
      generation: pending.generation,
      reservationId: pending.reservationId,
      assetId: pending.assetId,
      consentAt: pending.consentAt,
      voiceSource: pending.voiceSource,
    }),
  };
}
