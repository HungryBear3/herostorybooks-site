/**
 * The sequence the checkout page runs against the private intake endpoint:
 * reserve a slot generation, upload the bytes straight to Blob, then reconcile.
 *
 * WHY THIS IS NOT IN THE COMPONENT
 * --------------------------------
 * The reviewed reducers in `checkout-intake-client.ts` prove that a stale
 * result cannot be merged. They cannot prove that the page ASKS them — and the
 * failure this whole lane exists to fix is a mobile browser losing a request
 * halfway. So the ordering lives here, as plain functions over an injected
 * transport, and is tested against the real endpoint handler.
 *
 * WHY IT IMPORTS NOTHING FROM THE SERVER STATE MACHINE
 * ----------------------------------------------------
 * `checkout-intake.ts` pulls in `node:crypto` and the Blob SDK. This module is
 * bundled into the browser, so it carries its own copy of the two things it
 * genuinely needs — the slot key derivation and the selection shape — and a
 * shipped test pins both to the server's definitions. A drifting copy is
 * caught by that test rather than by a buyer.
 *
 * THE CAPABILITY
 * --------------
 * It is a parameter on every call and a field on nothing. Nothing here writes
 * to storage, logs, or analytics; the session object is meant to live in React
 * state for exactly as long as the page does.
 */
import {
  beginSlotUpload,
  clearSlot,
  commitSlotUpload,
  createIntakeClientState,
  failSlotUpload,
  savedSlotAssets,
  slotTicketIsCurrent,
  type IntakeClientState,
} from './checkout-intake-client.ts';
import { canonicalMediaMime, mediaClassForCategory } from './checkout-media-mime.ts';
import { classifyStoryAttachment } from './story-attachment.ts';

export type DirectIntakeCategory =
  | 'primary_hero_photo'
  | 'family_pet_reference'
  | 'guided_still'
  | 'voice_inspiration'
  | 'document_inspiration';

export interface DirectSlotRef {
  category: DirectIntakeCategory;
  familyCharacterId?: string | null;
  guidedStillIndex?: number | null;
}

/** Structurally identical to the server's `CheckoutFinalizeSelection`. */
export interface DirectIntakeSelection {
  primaryHeroPhotoAssetId: string | null;
  familyCharacterAssets: Array<{ assetId: string; familyCharacterId: string }>;
  guidedStillAssetIds: string[];
  voiceAssetId: string | null;
  documentAssetId: string | null;
}

export interface IntakeApiResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export interface IntakeUploadRequest {
  pathname: string;
  file: Blob;
  contentType: string;
  /** The pointer the server re-verifies; never a request the server obeys. */
  clientPayload: string;
}

export interface IntakeClientTransport {
  intake(body: Record<string, unknown>): Promise<IntakeApiResponse>;
  upload(request: IntakeUploadRequest): Promise<unknown>;
}

export interface CheckoutIntakeSession {
  intakeId: string;
  /** In-memory only. Never localStorage, never a URL, never a log line. */
  capability: string;
  expiresAt: string;
}

export interface IntakeConsentInput {
  mediaAuthorized: true;
  documentAuthorized?: boolean;
  childVoiceAuthorized?: boolean;
  voiceSource?: 'recorded' | 'uploaded' | null;
}

export interface SlotStateStore {
  get(): IntakeClientState;
  set(next: IntakeClientState): void;
}

export type SlotUploadOutcome =
  | { status: 'saved'; assetId: string }
  | { status: 'superseded' }
  | { status: 'failed'; code: string };

export interface UploadSlotFileParams {
  session: CheckoutIntakeSession;
  slot: DirectSlotRef;
  file: Blob;
  mimeType: string;
  size: number;
  /** How hard to chase a completion callback that has not landed yet. */
  resolve?: { attempts: number; delayMs: number };
}

const DEFAULT_RESOLVE = { attempts: 6, delayMs: 400 };

const FAMILY_CHARACTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GUIDED_STILL_SLOTS = 5;

class DirectSlotError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'DirectSlotError';
    this.code = code;
  }
}

/**
 * The client's copy of `slotKeyFor`.
 *
 * Kept identical by `checkout-intake-client-flow.test.ts`, which compares it
 * against the server function for every category. Family slots are keyed by
 * the stable character id and never by list position, so reordering the family
 * cannot re-point a photo at a different person.
 */
export function directSlotKey(ref: DirectSlotRef): string {
  if (ref?.category === 'family_pet_reference') {
    const id = typeof ref.familyCharacterId === 'string' ? ref.familyCharacterId.trim() : '';
    if (!FAMILY_CHARACTER_ID_RE.test(id)) throw new DirectSlotError('family_character_id_invalid');
    return `family_pet_reference:${id}`;
  }
  if (ref?.category === 'guided_still') {
    const index = ref.guidedStillIndex;
    if (!Number.isInteger(index) || index! < 0 || index! >= GUIDED_STILL_SLOTS) {
      throw new DirectSlotError('guided_still_index_invalid');
    }
    return `guided_still:${index}`;
  }
  if (ref?.category === 'primary_hero_photo'
    || ref?.category === 'voice_inspiration'
    || ref?.category === 'document_inspiration') {
    return ref.category;
  }
  throw new DirectSlotError('asset_category_invalid');
}

export function createSlotStateStore(initial: IntakeClientState = createIntakeClientState()): SlotStateStore {
  let current = initial;
  return {
    get: () => current,
    set: (next) => { current = next; },
  };
}

function errorCode(response: IntakeApiResponse, fallback: string): string {
  const code = response.body?.error;
  return typeof code === 'string' && code ? code : fallback;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createCheckoutIntakeSession(
  transport: IntakeClientTransport,
  consent: IntakeConsentInput,
): Promise<CheckoutIntakeSession> {
  // Booleans only: the instant a person agreed to something is evidence, and
  // evidence the browser supplies is not evidence.
  const response = await transport.intake({
    action: 'create',
    consent: {
      mediaAuthorized: true,
      documentAuthorized: consent.documentAuthorized === true,
      childVoiceAuthorized: consent.childVoiceAuthorized === true,
      voiceSource: consent.voiceSource ?? null,
    },
  });
  if (!response.ok) throw new DirectSlotError(errorCode(response, 'intake_create_failed'));
  const { intakeId, capability, expiresAt } = response.body as Record<string, unknown>;
  if (typeof intakeId !== 'string' || typeof capability !== 'string' || typeof expiresAt !== 'string') {
    throw new DirectSlotError('intake_create_failed');
  }
  return { intakeId, capability, expiresAt };
}

export async function updateIntakeConsent(
  transport: IntakeClientTransport,
  session: CheckoutIntakeSession,
  consent: { documentAuthorized?: boolean; childVoiceAuthorized?: boolean; voiceSource?: 'recorded' | 'uploaded' | null },
): Promise<void> {
  const response = await transport.intake({
    action: 'consent',
    intakeId: session.intakeId,
    capability: session.capability,
    consent: {
      documentAuthorized: consent.documentAuthorized === true,
      childVoiceAuthorized: consent.childVoiceAuthorized === true,
      voiceSource: consent.voiceSource ?? null,
    },
  });
  if (!response.ok) throw new DirectSlotError(errorCode(response, 'intake_consent_failed'));
}

/** Empties a slot: the Remove button, and the cancel half of Change. */
export async function releaseSlotFile(
  transport: IntakeClientTransport,
  state: SlotStateStore,
  params: { session: CheckoutIntakeSession; slot: DirectSlotRef },
): Promise<{ ok: boolean; code?: string }> {
  const slotKey = directSlotKey(params.slot);
  // Bump FIRST. From this moment every in-flight result for this slot is
  // stale, whether or not the server call below succeeds.
  const cleared = clearSlot(state.get(), slotKey);
  state.set(cleared.state);
  const response = await transport.intake({
    action: 'release',
    intakeId: params.session.intakeId,
    capability: params.session.capability,
    slot: params.slot,
  });
  return response.ok ? { ok: true } : { ok: false, code: errorCode(response, 'intake_release_failed') };
}

/**
 * Reserve → upload → reconcile, for one file in one slot.
 *
 * The three refusals that matter:
 *   • a refused reservation never uploads anything;
 *   • an upload the buyer superseded is dropped, never merged;
 *   • an upload we cannot prove landed is a FAILURE, not a saved photo.
 *
 * A superseded upload is still reconciled rather than abandoned, so the server
 * never keeps a pending reservation nothing will ever fill; and if the buyer
 * emptied the slot in the meantime, the slot is released again so a later list
 * cannot repaint the photo they removed.
 */
export async function uploadSlotFile(
  transport: IntakeClientTransport,
  state: SlotStateStore,
  params: UploadSlotFileParams,
): Promise<SlotUploadOutcome> {
  let slotKey: string;
  try {
    slotKey = directSlotKey(params.slot);
  } catch (error) {
    return { status: 'failed', code: (error as DirectSlotError).code ?? 'asset_category_invalid' };
  }

  const begun = beginSlotUpload(state.get(), slotKey);
  state.set(begun.state);
  const ticket = begun.ticket;

  const fail = (code: string): SlotUploadOutcome => {
    const failed = failSlotUpload(state.get(), ticket);
    state.set(failed.state);
    return { status: 'failed', code };
  };

  const reservation = await transport.intake({
    action: 'reserve-upload',
    intakeId: params.session.intakeId,
    capability: params.session.capability,
    slot: params.slot,
    mimeType: params.mimeType,
    size: params.size,
  });
  if (!reservation.ok) return fail(errorCode(reservation, 'reservation_failed'));
  const pathname = reservation.body.pathname;
  const generation = reservation.body.generation;
  const reservationId = reservation.body.reservationId;
  if (typeof pathname !== 'string' || typeof reservationId !== 'string' || typeof generation !== 'number') {
    return fail('reservation_failed');
  }
  // The server echoes the exact MIME the reservation holds. The upload below
  // must be sent with that same string, or the token allow-list, the Blob
  // head, and the stored asset would disagree. A disagreement here means the
  // two sides' MIME contracts have drifted, which is a failure, not a retry.
  const reservedMime = reservation.body.mimeType;
  if (typeof reservedMime === 'string' && reservedMime !== params.mimeType) {
    return fail('reservation_failed');
  }

  const superseded = async (): Promise<SlotUploadOutcome> => {
    const current = state.get().slots[slotKey];
    // The buyer emptied this slot while we were uploading. Hand the slot back
    // so nothing the server still holds can be shown as saved later.
    if (current && current.state === 'empty' && current.assetId === null) {
      try {
        await transport.intake({
          action: 'release',
          intakeId: params.session.intakeId,
          capability: params.session.capability,
          slot: params.slot,
        });
      } catch {
        // Best effort: the local state is already authoritative for the page.
      }
    }
    return { status: 'superseded' };
  };

  try {
    await transport.upload({
      pathname,
      file: params.file,
      contentType: params.mimeType,
      clientPayload: JSON.stringify({
        intakeId: params.session.intakeId,
        capability: params.session.capability,
        slotKey,
        generation,
        reservationId,
      }),
    });
  } catch {
    if (!slotTicketIsCurrent(state.get(), ticket)) return superseded();
    return fail('upload_failed');
  }

  const plan = params.resolve ?? DEFAULT_RESOLVE;
  let assetId: string | null = null;
  for (let attempt = 0; attempt < Math.max(1, plan.attempts); attempt += 1) {
    if (attempt > 0) await sleep(plan.delayMs);
    const resolved = await transport.intake({
      action: 'resolve-upload',
      intakeId: params.session.intakeId,
      capability: params.session.capability,
      slot: params.slot,
      generation,
    });
    if (!resolved.ok) {
      if (!slotTicketIsCurrent(state.get(), ticket)) return superseded();
      return fail(errorCode(resolved, 'upload_not_reconciled'));
    }
    const status = resolved.body.status;
    if (status === 'stale') return superseded();
    if (status === 'activated' || status === 'idempotent') {
      const asset = resolved.body.asset as { assetId?: unknown } | null;
      if (!asset || typeof asset.assetId !== 'string') return fail('upload_not_reconciled');
      assetId = asset.assetId;
      break;
    }
  }
  if (!assetId) {
    if (!slotTicketIsCurrent(state.get(), ticket)) return superseded();
    return fail('upload_not_reconciled');
  }

  const committed = commitSlotUpload(state.get(), ticket, { assetId });
  if (!committed.committed) return superseded();
  state.set(committed.state);
  return { status: 'saved', assetId };
}

/**
 * Turns what the page currently holds into the exact selection the server
 * finalizer accepts.
 *
 * A saved slot that no longer corresponds to anything on the form — a family
 * character the buyer deleted — is REPORTED rather than dropped, because
 * silently omitting media the page is still showing is how a buyer ends up
 * ordering a different book than the one on screen.
 */
export function buildDirectIntakeSelection(
  state: IntakeClientState,
  familyCharacterIds: readonly string[],
): { selection: DirectIntakeSelection; unmapped: string[] } {
  const selection: DirectIntakeSelection = {
    primaryHeroPhotoAssetId: null,
    familyCharacterAssets: [],
    guidedStillAssetIds: [],
    voiceAssetId: null,
    documentAssetId: null,
  };
  const declared = new Set(familyCharacterIds);
  const unmapped: string[] = [];
  const guided: Array<{ index: number; assetId: string; slotKey: string }> = [];

  for (const { slotKey, assetId } of savedSlotAssets(state)) {
    if (slotKey === 'primary_hero_photo') {
      selection.primaryHeroPhotoAssetId = assetId;
      continue;
    }
    if (slotKey === 'voice_inspiration') {
      selection.voiceAssetId = assetId;
      continue;
    }
    if (slotKey === 'document_inspiration') {
      selection.documentAssetId = assetId;
      continue;
    }
    if (slotKey.startsWith('family_pet_reference:')) {
      const familyCharacterId = slotKey.slice('family_pet_reference:'.length);
      if (!declared.has(familyCharacterId)) {
        unmapped.push(slotKey);
        continue;
      }
      selection.familyCharacterAssets.push({ assetId, familyCharacterId });
      continue;
    }
    if (slotKey.startsWith('guided_still:')) {
      const rawIndex = slotKey.slice('guided_still:'.length);
      const index = Number(rawIndex);
      if (!/^(0|[1-9][0-9]*)$/.test(rawIndex)
        || !Number.isInteger(index)
        || index < 0
        || index >= GUIDED_STILL_SLOTS) {
        unmapped.push(slotKey);
        continue;
      }
      guided.push({ index, assetId, slotKey });
      continue;
    }
    unmapped.push(slotKey);
  }

  // Canonical order, so an identical page state always produces an identical
  // request — which is what makes an idempotent retry resumable.
  selection.familyCharacterAssets.sort((a, b) => a.familyCharacterId.localeCompare(b.familyCharacterId));
  guided.sort((a, b) => a.index - b.index);
  for (const [expectedIndex, entry] of guided.entries()) {
    if (entry.index !== expectedIndex) unmapped.push(entry.slotKey);
    else selection.guidedStillAssetIds.push(entry.assetId);
  }
  return { selection, unmapped };
}

export interface ExpectedSlot {
  slotKey: string;
  /** Buyer-facing name, used verbatim in the payment blocker message. */
  label: string;
}

/**
 * Why payment is not allowed yet.
 *
 * Two separate reasons, both blocking: a slot the buyer has chosen a file for
 * that is not saved (including one whose upload failed — the reducers return a
 * failed slot to `empty`, which is retryable but is NOT a photo), and any slot
 * still in flight.
 */
export function directUploadBlockers(
  state: IntakeClientState,
  expected: readonly ExpectedSlot[],
): string[] {
  const blockers: string[] = [];
  for (const slot of expected) {
    const entry = state.slots[slot.slotKey];
    if (!entry || entry.state !== 'saved' || !entry.assetId) blockers.push(slot.label);
  }
  for (const entry of Object.values(state.slots)) {
    if (entry.state !== 'uploading') continue;
    const known = expected.find((slot) => slot.slotKey === entry.slotKey);
    const label = known?.label ?? entry.slotKey;
    if (!blockers.includes(label)) blockers.push(label);
  }
  return blockers;
}

export interface DirectIntakeSubmission {
  session: CheckoutIntakeSession;
  selection: DirectIntakeSelection;
  familyCharacterIds: string[];
}

export interface DirectIntakeFile {
  file: Blob;
  mimeType?: string;
}

export interface PrepareDirectIntakeSubmissionParams {
  enabled: boolean;
  transport: IntakeClientTransport;
  heroPhoto: Blob | null;
  familyCharacterIds?: readonly string[];
  familyPhotos: Array<{ familyCharacterId: string; file: Blob; mimeType?: string }>;
  guidedStills: Array<{ file: Blob; mimeType?: string }>;
  voice: { file: Blob; source: 'recorded' | 'uploaded'; consent: boolean; mimeType?: string } | null;
  document?: { file: Blob; consent: boolean; mimeType?: string } | null;
}

export class DirectIntakePreparationError extends Error {
  readonly code: string;
  /** Buyer-facing name of the asset that failed, when the failure has one. */
  readonly label: string | null;
  constructor(code: string, label: string | null = null) {
    super(code);
    this.name = 'DirectIntakePreparationError';
    this.code = code;
    this.label = label;
  }
}

/**
 * The exact MIME string a file will be reserved, uploaded, and stored as.
 *
 * Judged through the shared contract the server uses, so an accepted result is
 * a string the server will accept byte-for-byte. `explicit` is the type the
 * page read off the browser `File`; it is normalized here, never trusted raw.
 */
function resolveMediaMime(
  category: DirectIntakeCategory,
  file: Blob,
  explicit?: string,
): ReturnType<typeof canonicalMediaMime> {
  const name = (file as Blob & { name?: string }).name;
  return canonicalMediaMime({ type: explicit || file.type, name }, mediaClassForCategory(category));
}

/**
 * Complete submit-time browser orchestration. With the flag off it returns
 * before touching the transport, preserving the legacy multipart path exactly.
 */
export async function prepareDirectIntakeSubmission(
  params: PrepareDirectIntakeSubmissionParams,
): Promise<DirectIntakeSubmission | null> {
  if (!params.enabled) return null;
  if (params.guidedStills.length > GUIDED_STILL_SLOTS) {
    throw new DirectIntakePreparationError('guided_still_count_invalid');
  }
  if (params.voice && !params.voice.consent) {
    throw new DirectIntakePreparationError('voice_consent_required');
  }
  if (params.document && !params.document.consent) {
    throw new DirectIntakePreparationError('document_consent_required');
  }
  const voiceClassification = params.voice
    ? classifyStoryAttachment(params.voice.file as Blob & { name?: string })
    : null;
  if (voiceClassification && voiceClassification.kind !== 'audio') {
    throw new DirectIntakePreparationError('voice_type_invalid');
  }
  const documentClassification = params.document
    ? classifyStoryAttachment(params.document.file as Blob & { name?: string })
    : null;
  if (documentClassification && documentClassification.kind !== 'document') {
    throw new DirectIntakePreparationError('document_type_invalid');
  }

  // Decide the exact MIME of EVERY file before any intake exists. A photo the
  // product cannot accept is refused here, by name, with nothing reserved and
  // nothing uploaded — not at the fifth upload after four already landed.
  const plan: Array<{ slot: DirectSlotRef; file: Blob; label: string; mimeType: string }> = [];
  const planPhoto = (slot: DirectSlotRef, file: Blob, label: string, explicit?: string) => {
    const resolved = resolveMediaMime(slot.category, file, explicit);
    if (!resolved.ok) throw new DirectIntakePreparationError('photo_type_unsupported', label);
    plan.push({ slot, file, label, mimeType: resolved.mimeType });
  };
  if (params.heroPhoto) planPhoto({ category: 'primary_hero_photo' }, params.heroPhoto, 'hero photo');
  for (const entry of params.familyPhotos) {
    planPhoto(
      { category: 'family_pet_reference', familyCharacterId: entry.familyCharacterId },
      entry.file,
      `photo for ${entry.familyCharacterId}`,
      entry.mimeType,
    );
  }
  for (const [index, entry] of params.guidedStills.entries()) {
    planPhoto({ category: 'guided_still', guidedStillIndex: index }, entry.file, `guided still ${index + 1}`, entry.mimeType);
  }
  if (params.voice) {
    // The classifier already emits the canonical string; this is the same
    // contract judging it once more, so the two cannot disagree silently.
    const resolved = resolveMediaMime(
      'voice_inspiration',
      params.voice.file,
      voiceClassification?.kind === 'audio' ? voiceClassification.mimeType : params.voice.mimeType,
    );
    if (!resolved.ok) throw new DirectIntakePreparationError('voice_type_invalid', 'voice note');
    plan.push({ slot: { category: 'voice_inspiration' }, file: params.voice.file, label: 'voice note', mimeType: resolved.mimeType });
  }
  if (params.document) {
    const resolved = resolveMediaMime(
      'document_inspiration',
      params.document.file,
      documentClassification?.kind === 'document' ? documentClassification.mimeType : params.document.mimeType,
    );
    if (!resolved.ok) throw new DirectIntakePreparationError('document_type_invalid', 'story document');
    plan.push({ slot: { category: 'document_inspiration' }, file: params.document.file, label: 'story document', mimeType: resolved.mimeType });
  }

  const familyCharacterIds = [...(params.familyCharacterIds
    ?? params.familyPhotos.map((entry) => entry.familyCharacterId))];
  const session = await createCheckoutIntakeSession(params.transport, {
    mediaAuthorized: true,
    documentAuthorized: Boolean(params.document),
    childVoiceAuthorized: Boolean(params.voice),
    voiceSource: params.voice?.source ?? null,
  });
  const state = createSlotStateStore();
  const expected: ExpectedSlot[] = [];

  for (const { slot, file, label, mimeType } of plan) {
    const slotKey = directSlotKey(slot);
    expected.push({ slotKey, label });
    const outcome = await uploadSlotFile(params.transport, state, {
      session,
      slot,
      file,
      mimeType,
      size: file.size,
    });
    if (outcome.status !== 'saved') {
      throw new DirectIntakePreparationError(
        outcome.status === 'failed' ? outcome.code : 'upload_superseded',
        label,
      );
    }
  }

  const blockers = directUploadBlockers(state.get(), expected);
  if (blockers.length > 0) throw new DirectIntakePreparationError('direct_upload_unsettled');
  const built = buildDirectIntakeSelection(state.get(), familyCharacterIds);
  if (built.unmapped.length > 0) throw new DirectIntakePreparationError('direct_upload_identity_unmapped');
  return { session, selection: built.selection, familyCharacterIds };
}

export interface DirectIntakeSubmissionCache {
  submission: DirectIntakeSubmission;
  heroPhoto: Blob | null;
  familyCharacterIds: readonly string[];
  familyPhotos: ReadonlyArray<{ familyCharacterId: string; file: Blob }>;
  guidedStills: readonly Blob[];
  voice: { file: Blob; source: 'recorded' | 'uploaded'; consent: boolean } | null;
  document: { file: Blob; consent: boolean } | null;
}

function sameBlobList(left: readonly Blob[], right: readonly Blob[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

function cacheMatches(
  cache: DirectIntakeSubmissionCache,
  params: PrepareDirectIntakeSubmissionParams,
): boolean {
  const familyCharacterIds = params.familyCharacterIds
    ?? params.familyPhotos.map((entry) => entry.familyCharacterId);
  return cache.heroPhoto === params.heroPhoto
    && cache.familyCharacterIds.length === familyCharacterIds.length
    && cache.familyCharacterIds.every((id, index) => id === familyCharacterIds[index])
    && cache.familyPhotos.length === params.familyPhotos.length
    && cache.familyPhotos.every((entry, index) => {
      const candidate = params.familyPhotos[index];
      return candidate?.familyCharacterId === entry.familyCharacterId && candidate.file === entry.file;
    })
    && sameBlobList(cache.guidedStills, params.guidedStills.map((entry) => entry.file))
    && ((cache.voice === null && params.voice === null)
      || (cache.voice !== null && params.voice !== null
        && cache.voice.file === params.voice.file
        && cache.voice.source === params.voice.source
        && cache.voice.consent === params.voice.consent))
    && ((cache.document === null && !params.document)
      || (cache.document !== null && params.document != null
        && cache.document.file === params.document.file
        && cache.document.consent === params.document.consent));
}

/**
 * Reuses the exact private selection after a lost/refused order response.
 * Once an intake is fully prepared for a checkout attempt, changing any media
 * must start a fresh page/attempt rather than silently binding the deterministic
 * order id to a second intake.
 */
export async function prepareOrReuseDirectIntakeSubmission(
  params: PrepareDirectIntakeSubmissionParams,
  cache: DirectIntakeSubmissionCache | null,
): Promise<{ submission: DirectIntakeSubmission; cache: DirectIntakeSubmissionCache } | null> {
  if (!params.enabled) return null;
  if (cache) {
    if (!cacheMatches(cache, params)) {
      throw new DirectIntakePreparationError('direct_upload_selection_changed_reload_required');
    }
    return { submission: cache.submission, cache };
  }
  const submission = await prepareDirectIntakeSubmission(params);
  if (!submission) return null;
  const nextCache: DirectIntakeSubmissionCache = {
    submission,
    heroPhoto: params.heroPhoto,
    familyCharacterIds: [...submission.familyCharacterIds],
    familyPhotos: params.familyPhotos.map((entry) => ({
      familyCharacterId: entry.familyCharacterId,
      file: entry.file,
    })),
    guidedStills: params.guidedStills.map((entry) => entry.file),
    voice: params.voice
      ? { file: params.voice.file, source: params.voice.source, consent: params.voice.consent }
      : null,
    document: params.document
      ? { file: params.document.file, consent: params.document.consent }
      : null,
  };
  return { submission, cache: nextCache };
}

/** Adds only the private-intake pointer/selection and its in-memory capability. */
export function applyDirectIntakeToOrderPayload(
  payload: { set(name: string, value: string): void },
  submission: DirectIntakeSubmission,
): void {
  payload.set('checkoutIntake', JSON.stringify({
    intakeId: submission.session.intakeId,
    selection: submission.selection,
    familyCharacterIds: submission.familyCharacterIds,
  }));
  payload.set('checkoutIntakeCapability', submission.session.capability);
}

/**
 * Owns the mutually-exclusive primary/supporting media payload shapes.
 * Direct checkout carries only the private-intake pointer; legacy checkout
 * keeps its existing multipart file fields.
 */
export function applyPrimaryAndSupportingMediaToOrderPayload(
  payload: { set(name: string, value: string | Blob): void },
  params: {
    directSubmission: DirectIntakeSubmission | null;
    heroPhoto: Blob | null;
    familyPhotos: readonly (Blob | null)[];
  },
): void {
  if (params.directSubmission) {
    applyDirectIntakeToOrderPayload(payload, params.directSubmission);
    return;
  }
  if (params.heroPhoto) payload.set('photo', params.heroPhoto);
  params.familyPhotos.forEach((file, index) => {
    if (file) payload.set(`familyCharacterPhoto_${index}`, file);
  });
}
