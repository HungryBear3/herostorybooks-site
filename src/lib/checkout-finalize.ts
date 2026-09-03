/**
 * Binding an order to media — ONE operation.
 *
 * WHY THIS IS NOT THREE FUNCTIONS
 * -------------------------------
 * The obvious API is "validate the selection", "compute its identity",
 * "reserve it". Composed by a caller, that is a time-of-check/time-of-use gap
 * with a durable record in the middle: validate hero A, the buyer replaces it
 * with B, reserve — and the reservation, reading the record a second time,
 * happily records A. Both independent reviews reproduced exactly that.
 *
 * So finalization here is a single call that reads the record ONCE and
 * compare-and-swaps against that exact version. If anything about the intake
 * changed in between, the CAS fails and the whole finalization fails; it is
 * never retried against a newer record, because a validation belongs to the
 * version it was performed on.
 *
 * WHAT THE IDENTITY COVERS
 * ------------------------
 * The fingerprint is computed HERE, from the resolved tuple; a caller cannot
 * supply one. It covers every order-affecting semantic: the slot, the
 * category, the stable family id AND the derived index the book is actually
 * printed in, the guided-still index, and the exact asset (id, pathname, MIME,
 * size, etag, generation). The previous fingerprint hashed media bindings
 * only, so `[alice, bob]` and `[bob, alice]` hashed identically while
 * persisting different indexes — an "idempotent" replay that meant a
 * different book.
 *
 * The resolved tuple is persisted alongside it, so "what did this order take"
 * is answerable from the record: cleanup uses it to know what it may reclaim.
 *
 * SELECTION IS RESOLVED THROUGH THE SLOT
 * --------------------------------------
 * An asset id is acceptable only if it is what its slot currently holds, so
 * "superseded" and "selectable" cannot overlap. And a slot with a PENDING
 * replacement blocks finalization outright: the previous active asset is
 * deliberately retained while a replacement uploads, and building a book from
 * the photo the buyer is in the middle of changing is not an acceptable
 * reading of that state.
 */
import {
  assertCapability,
  assertIntakeRecordWritable,
  CHECKOUT_ATTEMPT_ID_RE,
  finalizationFingerprint,
  finalizationLeaseActive,
  INTAKE_FINALIZATION_LEASE_MS,
  IntakeError,
  intakeAssetPath,
  mutateIntake,
  ORDER_ID_RE,
  readIntake,
  slotKeyFor,
  touch,
  type FinalizedSelectionEntry,
  type IntakeAsset,
  type IntakeFinalization,
  type IntakeRecord,
  type IntakeStore,
} from './checkout-intake.ts';

export { finalizationFingerprint } from './checkout-intake.ts';

const ASSET_ID_RE = /^asset_[a-f0-9]{32}$/;
const SELECTION_KEYS = [
  'primaryHeroPhotoAssetId', 'familyCharacterAssets', 'guidedStillAssetIds',
  'voiceAssetId', 'documentAssetId',
] as const;

export interface FamilyCharacterBinding {
  assetId: string;
  familyCharacterId: string;
}

export interface CheckoutFinalizeSelection {
  primaryHeroPhotoAssetId: string | null;
  familyCharacterAssets: FamilyCharacterBinding[];
  guidedStillAssetIds: string[];
  voiceAssetId: string | null;
  documentAssetId: string | null;
}

export interface ResolvedFamilyCharacterAsset {
  familyCharacterId: string;
  /** Position in the CURRENT form list, derived here. */
  familyCharacterIndex: number;
  asset: IntakeAsset;
}

export interface ResolvedGuidedStill {
  guidedStillIndex: number;
  asset: IntakeAsset;
}

export interface ResolvedFinalizeSelection {
  record: IntakeRecord;
  /** Server-computed identity of the resolved tuple. */
  fingerprint: string;
  /** The exact tuple, in canonical order. */
  entries: FinalizedSelectionEntry[];
  primaryHeroPhoto: IntakeAsset | null;
  familyCharacters: ResolvedFamilyCharacterAsset[];
  guidedStills: ResolvedGuidedStill[];
  voiceAsset: IntakeAsset | null;
  documentAsset: IntakeAsset | null;
}

function assertAssetIdShape(value: unknown): string {
  if (typeof value !== 'string' || !ASSET_ID_RE.test(value)) throw new IntakeError('asset_reference_invalid');
  return value;
}

/**
 * The identity of a finalized selection.
 *
 * Every field that changes what gets printed is in here, including the derived
 * family index. Entries are sorted so the ARRAY order a caller happened to use
 * is not part of the identity, while the derived index is.
 */
export interface ValidateFinalizeSelectionParams {
  intakeId: string;
  capability: string;
  selection: CheckoutFinalizeSelection;
  /** The stable ids of the family characters the form currently has, in order. */
  familyCharacterIds: readonly string[];
  /** Set when re-validating an attempt that already reserved finalization. */
  expectedOrderId?: string;
}

type ResolvedCore = Omit<ResolvedFinalizeSelection, 'record' | 'fingerprint' | 'entries'>;

/**
 * Resolves a selection against ONE already-read record. Pure: no I/O, so the
 * caller controls which version everything is judged against.
 */
function resolveAgainstRecord(
  record: IntakeRecord,
  params: Pick<ValidateFinalizeSelectionParams, 'selection' | 'familyCharacterIds'>,
): ResolvedCore {
  const selection = params.selection;
  if (!selection
    || typeof selection !== 'object'
    || Array.isArray(selection)
    || Object.keys(selection).length !== SELECTION_KEYS.length
    || SELECTION_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(selection, key))
    || Object.keys(selection).some((key) => !SELECTION_KEYS.includes(key as typeof SELECTION_KEYS[number]))
    || !Array.isArray(selection.familyCharacterAssets)
    || !Array.isArray(selection.guidedStillAssetIds)) {
    throw new IntakeError('asset_selection_invalid');
  }
  for (const value of [selection.primaryHeroPhotoAssetId, selection.voiceAssetId, selection.documentAssetId]) {
    if (value !== null && (typeof value !== 'string' || !ASSET_ID_RE.test(value))) {
      throw new IntakeError('asset_selection_invalid');
    }
  }
  if (selection.voiceAssetId && selection.documentAssetId) {
    throw new IntakeError('story_source_conflict');
  }

  const seenAssetIds = new Set<string>();
  const claim = (assetId: unknown): string => {
    const id = assertAssetIdShape(assetId);
    if (seenAssetIds.has(id)) throw new IntakeError('asset_reference_duplicate');
    seenAssetIds.add(id);
    return id;
  };

  /** The one rule: an id is acceptable only if it is what the slot holds now. */
  const currentAssetOf = (slotKey: string, assetId: string): IntakeAsset => {
    const active = record.slots[slotKey]?.active;
    if (!active || active.assetId !== assetId) throw new IntakeError('asset_not_current', 409);
    return active;
  };

  const primaryHeroPhoto = selection.primaryHeroPhotoAssetId !== null
    ? currentAssetOf('primary_hero_photo', claim(selection.primaryHeroPhotoAssetId))
    : null;

  const familyIndexById = new Map<string, number>();
  (params.familyCharacterIds ?? []).forEach((id, index) => {
    const trimmed = typeof id === 'string' ? id.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) {
      throw new IntakeError('family_character_identity_invalid');
    }
    if (familyIndexById.has(trimmed)) {
      throw new IntakeError('family_character_identity_duplicate');
    }
    familyIndexById.set(trimmed, index);
  });

  const seenFamilyIds = new Set<string>();
  const familyCharacters: ResolvedFamilyCharacterAsset[] = selection.familyCharacterAssets.map((binding) => {
    const assetId = claim(binding?.assetId);
    const familyCharacterId = typeof binding?.familyCharacterId === 'string' ? binding.familyCharacterId.trim() : '';
    if (!familyCharacterId) throw new IntakeError('family_character_binding_invalid');
    if (seenFamilyIds.has(familyCharacterId)) throw new IntakeError('asset_reference_duplicate');
    seenFamilyIds.add(familyCharacterId);
    const familyCharacterIndex = familyIndexById.get(familyCharacterId);
    if (familyCharacterIndex === undefined) throw new IntakeError('family_character_unknown');
    const slotKey = slotKeyFor({ category: 'family_pet_reference', familyCharacterId });
    return { familyCharacterId, familyCharacterIndex, asset: currentAssetOf(slotKey, assetId) };
  });

  const guidedStills: ResolvedGuidedStill[] = selection.guidedStillAssetIds.map((rawAssetId) => {
    const assetId = claim(rawAssetId);
    // Addressed by whichever guided-still slot holds it, never by a
    // client-supplied index.
    const slot = Object.values(record.slots).find(
      (candidate) => candidate.category === 'guided_still' && candidate.active?.assetId === assetId,
    );
    if (!slot || slot.guidedStillIndex === null) throw new IntakeError('asset_not_current', 409);
    return { guidedStillIndex: slot.guidedStillIndex, asset: currentAssetOf(slot.slotKey, assetId) };
  });
  guidedStills.sort((a, b) => a.guidedStillIndex - b.guidedStillIndex);

  const voiceAsset = selection.voiceAssetId !== null
    ? currentAssetOf('voice_inspiration', claim(selection.voiceAssetId))
    : null;
  const documentAsset = selection.documentAssetId !== null
    ? currentAssetOf('document_inspiration', claim(selection.documentAssetId))
    : null;

  return { primaryHeroPhoto, familyCharacters, guidedStills, voiceAsset, documentAsset };
}

function buildSelectionEntries(resolved: ResolvedCore): FinalizedSelectionEntry[] {
  const entry = (asset: IntakeAsset, familyCharacterIndex: number | null): FinalizedSelectionEntry => ({
    slotKey: asset.slotKey,
    category: asset.category,
    familyCharacterId: asset.familyCharacterId,
    familyCharacterIndex,
    guidedStillIndex: asset.guidedStillIndex,
    assetId: asset.assetId,
    pathname: asset.pathname,
    mimeType: asset.mimeType,
    size: asset.size,
    etag: asset.etag,
    generation: asset.generation,
    consentAt: asset.consentAt,
    voiceSource: asset.voiceSource,
  });
  const entries: FinalizedSelectionEntry[] = [];
  if (resolved.primaryHeroPhoto) entries.push(entry(resolved.primaryHeroPhoto, null));
  for (const family of resolved.familyCharacters) entries.push(entry(family.asset, family.familyCharacterIndex));
  for (const still of resolved.guidedStills) entries.push(entry(still.asset, null));
  if (resolved.voiceAsset) entries.push(entry(resolved.voiceAsset, null));
  if (resolved.documentAsset) entries.push(entry(resolved.documentAsset, null));
  entries.sort((a, b) => a.slotKey.localeCompare(b.slotKey));
  return entries;
}

/**
 * Re-reads every selected object from storage.
 *
 * The record says what we believe; this says what is actually there, and an
 * order is only ever bound to the intersection. An unreadable store is a
 * retryable outage rather than "the object changed" — `headAsset` throws for
 * that, and the throw propagates.
 */
async function verifyStoredObjects(
  store: IntakeStore,
  record: IntakeRecord,
  entries: readonly FinalizedSelectionEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.pathname !== intakeAssetPath(record.intakeId, entry.assetId)) {
      throw new IntakeError('asset_prefix_mismatch', 403);
    }
    const object = await store.headAsset(entry.pathname);
    if (!object
      || object.pathname !== entry.pathname
      || object.mimeType !== entry.mimeType
      || object.size !== entry.size
      || object.etag !== entry.etag) {
      throw new IntakeError('asset_metadata_changed', 409);
    }
  }
}

/**
 * Read-only validation of a selection.
 *
 * Useful for showing a buyer what would be ordered. It is NOT a step in
 * finalization: a validation performed here has no linkage to any later write,
 * which is exactly the gap `finalizeIntakeSelection` exists to close.
 */
export async function validateFinalizeSelection(
  store: IntakeStore,
  params: ValidateFinalizeSelectionParams,
  now = new Date(),
): Promise<ResolvedFinalizeSelection> {
  const { record } = await readIntake(store, params.intakeId);
  assertCapability(record, params.capability);
  if (record.cleanupClaim) throw new IntakeError('intake_cleanup_in_progress', 409);
  if (Date.parse(record.expiresAt) <= now.getTime()) throw new IntakeError('intake_expired', 410);
  if (record.finalizedOrderId && record.finalizedOrderId !== params.expectedOrderId) {
    throw new IntakeError('intake_already_finalized', 409);
  }
  const resolved = resolveAgainstRecord(record, params);
  const entries = buildSelectionEntries(resolved);
  await verifyStoredObjects(store, record, entries);
  return {
    record,
    entries,
    fingerprint: finalizationFingerprint(record.intakeId, entries),
    ...resolved,
  };
}

export interface FinalizeIntakeParams {
  intakeId: string;
  capability: string;
  checkoutAttemptId: string;
  orderId: string;
  selection: CheckoutFinalizeSelection;
  familyCharacterIds: readonly string[];
}

export interface FinalizeIntakeResult {
  status: 'reserved' | 'idempotent';
  finalization: IntakeFinalization;
  resolved: ResolvedFinalizeSelection;
}

/**
 * Freeze this intake against exactly one order, atomically.
 *
 * Reads the record once, judges everything against that version, and
 * compare-and-swaps the reservation onto it. A CAS failure means the record
 * moved while we were validating, so the validation is void — reported as a
 * conflict and never retried against a newer version.
 */
export async function finalizeIntakeSelection(
  store: IntakeStore,
  params: FinalizeIntakeParams,
  now = new Date(),
): Promise<FinalizeIntakeResult> {
  if (typeof params.checkoutAttemptId !== 'string' || !CHECKOUT_ATTEMPT_ID_RE.test(params.checkoutAttemptId)) {
    throw new IntakeError('checkout_attempt_invalid');
  }
  if (typeof params.orderId !== 'string' || !ORDER_ID_RE.test(params.orderId)) {
    throw new IntakeError('order_reference_invalid');
  }

  const snapshot = await readIntake(store, params.intakeId);
  const record = snapshot.record;

  assertCapability(record, params.capability);
  if (record.cleanupClaim) throw new IntakeError('intake_cleanup_in_progress', 409);
  if (Date.parse(record.expiresAt) <= now.getTime()) throw new IntakeError('intake_expired', 410);
  if (record.finalizedOrderId && record.finalizedOrderId !== params.orderId) {
    throw new IntakeError('intake_already_finalized', 409);
  }

  // Any slot mid-replacement means the buyer's selection is not settled. This
  // covers unselected slots too: an upload landing during checkout would
  // change the intake underneath an order that is already being placed.
  if (Object.values(record.slots).some((slot) => slot.pending)) {
    throw new IntakeError('intake_replacement_pending', 409);
  }

  const resolvedCore = resolveAgainstRecord(record, params);
  const entries = buildSelectionEntries(resolvedCore);
  await verifyStoredObjects(store, record, entries);
  const fingerprint = finalizationFingerprint(record.intakeId, entries);
  const resolved: ResolvedFinalizeSelection = { record, entries, fingerprint, ...resolvedCore };

  const existing = record.finalization;

  // Already paid for: only an exact replay of the winning attempt is allowed.
  if (record.finalizedOrderId) {
    if (!existing
      || existing.checkoutAttemptId !== params.checkoutAttemptId
      || existing.fingerprint !== fingerprint) {
      throw new IntakeError('intake_finalization_conflict', 409);
    }
    return { status: 'idempotent', finalization: existing, resolved };
  }

  if (existing) {
    if (finalizationLeaseActive(record, now.getTime())) {
      if (existing.checkoutAttemptId !== params.checkoutAttemptId
        || existing.orderId !== params.orderId
        || existing.fingerprint !== fingerprint) {
        throw new IntakeError('intake_finalization_conflict', 409);
      }
      return { status: 'idempotent', finalization: existing, resolved };
    }
    // Expiry is not evidence that the consequential order was never created.
    // Preserve the recorded authority until exact reconciliation marks that
    // order finalized or the owning attempt explicitly aborts it.
    throw new IntakeError('intake_finalization_reconciliation_required', 409);
  }

  const reservedAtMs = Math.max(now.getTime(), Date.parse(record.updatedAt));
  const finalization: IntakeFinalization = {
    checkoutAttemptId: params.checkoutAttemptId,
    orderId: params.orderId,
    fingerprint,
    reservedAt: new Date(reservedAtMs).toISOString(),
    leaseExpiresAt: new Date(reservedAtMs + INTAKE_FINALIZATION_LEASE_MS).toISOString(),
    selection: entries,
  };

  const next = {
    ...touch(record, now),
    finalization,
  };
  assertIntakeRecordWritable(next);
  const swapped = await store.compareAndSwap(params.intakeId, snapshot.etag, next);
  if (!swapped) {
    // The intake changed while we were validating it. Whatever we resolved
    // describes a version that no longer exists.
    throw new IntakeError('intake_finalization_conflict', 409);
  }

  return { status: 'reserved', finalization, resolved };
}

/**
 * Releases a finalization reservation this attempt owns.
 *
 * The explicit counterpart to lease expiry: a checkout that fails before
 * creating its order hands the intake straight back instead of fencing it for
 * the whole lease.
 */
export async function abortIntakeFinalization(
  store: IntakeStore,
  params: { intakeId: string; capability: string; checkoutAttemptId: string },
  now = new Date(),
): Promise<{ aborted: boolean }> {
  // Annotated because the two branches return different literal `result`
  // types; without it TypeScript infers a union `mutateIntake` cannot accept.
  return mutateIntake<{ aborted: boolean }>(store, params.intakeId, (
    record,
  ): { next: IntakeRecord | null; result: { aborted: boolean } } => {
    assertCapability(record, params.capability);
    if (record.finalizedOrderId) throw new IntakeError('intake_already_finalized', 409);
    const existing = record.finalization;
    if (!existing) return { next: null, result: { aborted: false } };
    // Someone else's live reservation is not ours to release.
    if (existing.checkoutAttemptId !== params.checkoutAttemptId) {
      throw new IntakeError('intake_finalization_conflict', 409);
    }
    return {
      next: { ...touch(record, now), finalization: null },
      result: { aborted: true },
    };
  });
}
