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
  /**
   * The caller's cancellation fence, consulted after every await and
   * immediately before every transport call.
   *
   * Checking only around this function is not enough. The reserve → upload →
   * reconcile sequence contains the longest awaits in the whole flow, and a
   * buyer pressing Start over while the reservation is outstanding must not
   * have their bytes sent to the intake they just discarded. The fence has to
   * reach in here, or "cancelled" means "cancelled between files".
   */
  cancelled?: () => boolean;
}

/** The one code every cancelled path reports, inside this module and out. */
const PREPARATION_CANCELLED = 'direct_upload_preparation_cancelled';

const DEFAULT_RESOLVE = { attempts: 6, delayMs: 400 };

/**
 * A thrown upload gets a SHORTER chase than a resolved one.
 *
 * A resolved upload is waiting on a callback that is known to be coming. A
 * thrown one is asking a different question — did anything land at all? — and
 * the reserved path answers it immediately or not at all. Two looks is enough
 * to cover a callback that is committing as we ask; more would just make every
 * genuine failure slower to report.
 */
const RECONCILE_ON_THROW_ATTEMPTS = 2;

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

type ReservedSlotResolution =
  | { status: 'saved'; assetId: string }
  | { status: 'stale' }
  | { status: 'pending' }
  | { status: 'cancelled' }
  | { status: 'error'; code: string };

/**
 * Asks the server what is actually on one reserved path.
 *
 * The reservation pins an immutable pathname, MIME and size, and the server
 * re-verifies all three against the stored object before it will activate
 * anything. So this is a QUESTION, never an instruction: the worst a lost or
 * partial write can produce here is `pending` or a refusal, and neither is a
 * saved photo.
 */
async function reconcileReservedSlot(
  transport: IntakeClientTransport,
  params: { session: CheckoutIntakeSession; slot: DirectSlotRef },
  generation: number,
  plan: { attempts: number; delayMs: number },
  isCancelled: () => boolean,
): Promise<ReservedSlotResolution> {
  for (let attempt = 0; attempt < Math.max(1, plan.attempts); attempt += 1) {
    if (attempt > 0) await sleep(plan.delayMs);
    // Covers both the sleep above and the previous pass's await: this is a
    // retry loop, so a reset landing anywhere in it would otherwise be
    // answered by up to five more requests to a discarded capability.
    if (isCancelled()) return { status: 'cancelled' };
    const resolved = await transport.intake({
      action: 'resolve-upload',
      intakeId: params.session.intakeId,
      capability: params.session.capability,
      slot: params.slot,
      generation,
    });
    if (isCancelled()) return { status: 'cancelled' };
    if (!resolved.ok) return { status: 'error', code: errorCode(resolved, 'upload_not_reconciled') };
    const status = resolved.body.status;
    if (status === 'stale') return { status: 'stale' };
    if (status === 'activated' || status === 'idempotent') {
      const asset = resolved.body.asset as { assetId?: unknown } | null;
      if (!asset || typeof asset.assetId !== 'string') return { status: 'error', code: 'upload_not_reconciled' };
      return { status: 'saved', assetId: asset.assetId };
    }
  }
  return { status: 'pending' };
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

  const isCancelled = params.cancelled ?? (() => false);

  const begun = beginSlotUpload(state.get(), slotKey);
  state.set(begun.state);
  const ticket = begun.ticket;

  const fail = (code: string): SlotUploadOutcome => {
    const failed = failSlotUpload(state.get(), ticket);
    state.set(failed.state);
    return { status: 'failed', code };
  };

  // A cancelled slot is a FAILED slot, not a superseded one: the ticket is
  // released so a store this run is sharing cannot be left showing an upload
  // that will never finish, and the caller — which re-checks its own fence the
  // moment this returns — reports the cancellation rather than this code.
  const cancel = (): SlotUploadOutcome => fail(PREPARATION_CANCELLED);

  if (isCancelled()) return cancel();
  const reservation = await transport.intake({
    action: 'reserve-upload',
    intakeId: params.session.intakeId,
    capability: params.session.capability,
    slot: params.slot,
    mimeType: params.mimeType,
    size: params.size,
  });
  // The gap this whole fence exists for. The reservation is now a real,
  // authorized pathname on an intake the buyer may have discarded while we
  // waited for it, and the next statement but one moves the bytes.
  if (isCancelled()) return cancel();
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
    // Cancellation outranks supersession, and its release below would be one
    // more request to a capability the page has already thrown away.
    if (isCancelled()) return cancel();
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

  const plan = params.resolve ?? DEFAULT_RESOLVE;
  let assetId: string | null = null;

  try {
    if (isCancelled()) return cancel();
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
    if (isCancelled()) return cancel();
    if (!slotTicketIsCurrent(state.get(), ticket)) return superseded();
    // A thrown upload is not evidence that nothing landed. A lost RESPONSE and
    // a lost REQUEST look identical from here, and on a phone the lost
    // response is the common one — the bytes arrived, the callback committed,
    // and the connection died before the browser heard about it. Re-sending
    // those bytes is the expensive wrong answer, so ask the reserved path
    // first. It is immutable and already authorized: nothing about this can
    // turn a failed upload into a saved one.
    const recovered = await reconcileReservedSlot(transport, params, generation, {
      attempts: Math.min(RECONCILE_ON_THROW_ATTEMPTS, Math.max(1, plan.attempts)),
      delayMs: plan.delayMs,
    }, isCancelled);
    if (recovered.status === 'cancelled') return cancel();
    if (recovered.status === 'stale') return superseded();
    if (recovered.status !== 'saved') {
      if (!slotTicketIsCurrent(state.get(), ticket)) return superseded();
      // Absent, unreadable, or mismatched. The upload failed, and the buyer is
      // told so — the same closed answer as before this recovery existed.
      return fail('upload_failed');
    }
    assetId = recovered.assetId;
  }

  if (assetId === null) {
    // The upload resolved, which is the other long await this run owns.
    if (isCancelled()) return cancel();
    const resolution = await reconcileReservedSlot(transport, params, generation, plan, isCancelled);
    if (resolution.status === 'cancelled') return cancel();
    if (resolution.status === 'stale') return superseded();
    if (resolution.status !== 'saved') {
      if (!slotTicketIsCurrent(state.get(), ticket)) return superseded();
      return fail(resolution.status === 'error' ? resolution.code : 'upload_not_reconciled');
    }
    assetId = resolution.assetId;
  }

  // Nothing a cancelled run proved may be written back as a saved photo.
  if (isCancelled()) return cancel();
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
 *
 * Given a `preparation`, a batch that dies part-way is RESUMABLE: the intake,
 * the capability and every server-confirmed slot stay in memory, and a later
 * attempt with the same files re-sends only what is not already saved. Without
 * one the behaviour is exactly what it was — one intake, every file uploaded.
 */
export async function prepareDirectIntakeSubmission(
  params: PrepareDirectIntakeSubmissionParams,
  preparation?: DirectIntakePreparation | null,
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

  // A partial preparation is resumable only if it belongs to EXACTLY this
  // media. Anything else — one swapped photo, one renamed character — and the
  // whole thing is dropped and started again, because a partially-reused
  // intake is a book assembled from two different selections.
  const resumable = preparation != null
    && preparation.session != null
    && preparation.media != null
    && mediaSelectionMatches(preparation.media, params);
  // A RESTART, not a discard. The buyer still wants to check out; they want to
  // check out something else. `reset()` is the other thing — the page throwing
  // the whole attempt away — and the two must stay distinguishable, or a buyer
  // changing a photo twice in a row would have the second change cancelled as
  // though they had pressed Start over. See `attempt` on the preparation.
  if (preparation && !resumable) restartPreparationState(preparation);

  // The cancellation fence for everything below.
  //
  // Captured AFTER the invalidating reset above, so this run owns exactly the
  // state that reset left behind. Every LATER reset — Start over, a cleared
  // photo, the hand-off to Stripe — moves the generation, and from that instant
  // this run may not write to the preparation, may not send another byte to its
  // intake, and may not return a submission. Without it, a reset that lands
  // while this is parked on an await is undone the moment the await resolves:
  // the session is written back, saved slots reappear, and the page is handed
  // an order payload built on a capability the buyer already discarded.
  const runGeneration = preparation?.generation ?? 0;
  const isCancelled = (): boolean => preparation != null && preparation.generation !== runGeneration;
  const abortIfCancelled = (): void => {
    if (isCancelled()) throw new DirectIntakePreparationError(PREPARATION_CANCELLED);
  };

  let session: CheckoutIntakeSession;
  let state: SlotStateStore;
  if (resumable) {
    session = preparation!.session!;
    state = preparation!.slots;
  } else {
    session = await createCheckoutIntakeSession(params.transport, {
      mediaAuthorized: true,
      documentAuthorized: Boolean(params.document),
      childVoiceAuthorized: Boolean(params.voice),
      voiceSource: params.voice?.source ?? null,
    });
    // Checked BEFORE the session is recorded. An intake created into a reset
    // preparation is simply abandoned to its expiry; writing it back would
    // resurrect the exact capability the reset existed to drop.
    abortIfCancelled();
    state = preparation ? preparation.slots : createSlotStateStore();
    if (preparation) {
      // Recorded BEFORE the first byte moves. A batch that dies on its first
      // upload is still a batch worth resuming.
      preparation.session = session;
      preparation.media = snapshotMediaSelection(params);
    }
  }
  const expected: ExpectedSlot[] = [];

  for (const { slot, file, label, mimeType } of plan) {
    // Not one more reservation, and not one more byte, to an intake the page
    // has already thrown away.
    abortIfCancelled();
    const slotKey = directSlotKey(slot);
    expected.push({ slotKey, label });
    const alreadySaved = preparation?.saved.get(slotKey);
    if (alreadySaved && savedSlotIsReusable(alreadySaved, { slot, file, mimeType }, state)) continue;
    preparation?.saved.delete(slotKey);
    const outcome = await uploadSlotFile(params.transport, state, {
      session,
      slot,
      file,
      mimeType,
      size: file.size,
      // The same fence, reaching inside the reserve → upload → reconcile
      // sequence. Checking only on either side of this call would leave the
      // longest awaits in the flow unguarded.
      cancelled: isCancelled,
    });
    // The buyer may have reset while these bytes were moving. Nothing that just
    // happened may be remembered as saved, whatever the server did with it.
    abortIfCancelled();
    if (outcome.status !== 'saved') {
      throw new DirectIntakePreparationError(
        outcome.status === 'failed' ? outcome.code : 'upload_superseded',
        label,
      );
    }
    const live = state.get().slots[slotKey];
    // Recorded only from what the reducers actually committed, so a slot the
    // fencing dropped can never be remembered as saved.
    if (preparation && live && live.state === 'saved' && live.assetId === outcome.assetId) {
      preparation.saved.set(slotKey, {
        slotKey,
        category: slot.category,
        familyCharacterId: slot.familyCharacterId ?? null,
        guidedStillIndex: slot.guidedStillIndex ?? null,
        file,
        mimeType,
        size: file.size,
        assetId: outcome.assetId,
        clientGeneration: live.clientGeneration,
      });
    }
  }

  const blockers = directUploadBlockers(state.get(), expected);
  if (blockers.length > 0) throw new DirectIntakePreparationError('direct_upload_unsettled');
  const built = buildDirectIntakeSelection(state.get(), familyCharacterIds);
  if (built.unmapped.length > 0) throw new DirectIntakePreparationError('direct_upload_identity_unmapped');
  // The last fence. A submission is an instruction to charge someone for these
  // exact assets; it may not be assembled out of a preparation the page has
  // already discarded.
  abortIfCancelled();
  return { session, selection: built.selection, familyCharacterIds };
}

/** The exact media a preparation belongs to, compared by object identity. */
export interface DirectIntakeMediaSnapshot {
  heroPhoto: Blob | null;
  familyCharacterIds: readonly string[];
  familyPhotos: ReadonlyArray<{ familyCharacterId: string; file: Blob }>;
  guidedStills: readonly Blob[];
  voice: { file: Blob; source: 'recorded' | 'uploaded'; consent: boolean } | null;
  document: { file: Blob; consent: boolean } | null;
}

export interface DirectIntakeSubmissionCache extends DirectIntakeMediaSnapshot {
  submission: DirectIntakeSubmission;
  /**
   * The authority this frozen batch was built under: the controller instance
   * and the generation, or `null`/`null` when it was built without a
   * controller at all.
   *
   * A cache is a capability plus a list of asset ids. Once the page has thrown
   * that capability away the whole thing is dead, and re-stamping it with the
   * page's CURRENT generation — which is what "reuse the cache" used to do —
   * launders a discarded attempt into a live order. Carried on the cache
   * itself rather than inferred from the page's refs, so a page that forgets
   * to clear a ref cannot resurrect it.
   */
  preparationId: number | null;
  preparationGeneration: number | null;
}

/**
 * Is a frozen batch still the property of the controller in front of us?
 *
 * Both halves matter. The generation catches the reset; the id catches the
 * cache being presented to a DIFFERENT controller that happens to sit on the
 * same number.
 */
function directIntakeAuthorityIsCurrent(
  stamp: { preparationId: number | null; preparationGeneration: number | null },
  preparation: DirectIntakePreparation | null,
): boolean {
  if (stamp.preparationId === null && stamp.preparationGeneration === null) return true;
  return preparation != null
    && preparation.id === stamp.preparationId
    && preparation.generation === stamp.preparationGeneration;
}

/**
 * One slot the server has CONFIRMED it holds, with everything needed to prove
 * a later attempt is asking for the same thing.
 *
 * Every field is part of the match. Dropping any one of them turns "the same
 * file" into "a file that looks similar", and a supporting photo bound to the
 * wrong person is the exact defect the stable slot key exists to prevent.
 */
interface SavedSlotRecord {
  slotKey: string;
  category: DirectIntakeCategory;
  familyCharacterId: string | null;
  guidedStillIndex: number | null;
  /** Identity, not contents: the same `File` the buyer is still holding. */
  file: Blob;
  mimeType: string;
  size: number;
  /** Returned by the server's own activation, never invented here. */
  assetId: string;
  clientGeneration: number;
}

/**
 * The page's in-memory preparation state for ONE checkout attempt.
 *
 * It exists so that a batch which dies on its fifth file does not throw away
 * the four the server already holds. It is deliberately an explicit object the
 * page owns — not a module-level cache — so its lifetime is the page's, it can
 * be dropped on demand, and two pages could never share one.
 *
 * `toJSON` narrows ONE leak, and only that one. The capability hangs off
 * `session`, so `JSON.stringify(preparation)` — the shape most error reporters
 * and structured loggers build their payload with — sees the redacted summary
 * instead of the live object. It does NOT protect a `console.error(preparation)`
 * or a devtools inspection: both read the object itself, `session.capability`
 * included. What actually keeps the capability secret is that nothing in this
 * module logs, persists, or serializes the session at all, and that the page
 * holds this in a ref it drops at the hand-off. `toJSON` is the last line of
 * that defence, not the defence.
 */
export interface DirectIntakePreparation {
  /**
   * Which controller this is. Unique per instance and never reused.
   *
   * Generations are per-controller counters, so two controllers sitting on the
   * same number are indistinguishable by number alone — and a frozen batch
   * belongs to the capability ONE of them is holding. The id is what stops a
   * cache built by one controller from being presented to another.
   */
  readonly id: number;
  /** Set the moment an intake exists — long before the batch finishes. */
  session: CheckoutIntakeSession | null;
  slots: SlotStateStore;
  saved: Map<string, SavedSlotRecord>;
  media: DirectIntakeMediaSnapshot | null;
  inFlight: Promise<PreparedDirectIntake | null> | null;
  inFlightMedia: DirectIntakeMediaSnapshot | null;
  /**
   * Bumped by every `reset()`, and by nothing else.
   *
   * This is what makes a reset mean something to work already under way.
   * Clearing the fields alone cannot: a run parked on an await holds the old
   * session and the old store in local variables, and wakes up ready to write
   * both back. A run captures this number when it starts and re-reads it at
   * every await; a run whose number has moved is cancelled.
   */
  generation: number;
  /**
   * Which ATTEMPT the page is on. Bumped by `reset()` and by nothing else.
   *
   * `generation` answers "may this run still write?" and moves for any reason
   * the state was replaced, an ordinary changed-selection restart included.
   * This answers the different question a QUEUED caller has to ask: "is the
   * attempt I joined the queue for still the attempt this page is making?"
   *
   * They have to be separate numbers. A waiter bound to `generation` would be
   * cancelled by the restart another waiter legitimately performed ahead of it
   * — a buyer swapping two photos in quick succession — while a waiter bound
   * to nothing survives the reset that cancelled the run it was waiting on and
   * quietly starts a second intake the buyer never asked for.
   */
  attempt: number;
  /**
   * Drops the capability and every saved slot, AND cancels every run currently
   * using them, AND ends the attempt for everything queued behind them. Not
   * undoable, by design.
   */
  reset(): void;
  toJSON(): { hasSession: boolean; savedSlots: string[] };
}

/**
 * Drops every piece of state a preparation is holding and cancels every run
 * using it, WITHOUT ending the attempt.
 *
 * This is what a run does when the media it was handed does not belong to the
 * partial state already there. `reset()` is this plus the attempt bump.
 */
function restartPreparationState(preparation: DirectIntakePreparation): void {
  preparation.generation += 1;
  preparation.session = null;
  preparation.slots = createSlotStateStore();
  preparation.saved.clear();
  preparation.media = null;
  preparation.inFlight = null;
  preparation.inFlightMedia = null;
}

let preparationInstances = 0;

export function createDirectIntakePreparation(): DirectIntakePreparation {
  preparationInstances += 1;
  const preparation: DirectIntakePreparation = {
    id: preparationInstances,
    session: null,
    slots: createSlotStateStore(),
    saved: new Map(),
    media: null,
    inFlight: null,
    inFlightMedia: null,
    generation: 0,
    attempt: 0,
    reset() {
      preparation.attempt += 1;
      restartPreparationState(preparation);
    },
    toJSON() {
      return {
        hasSession: preparation.session !== null,
        savedSlots: [...preparation.saved.keys()].sort(),
      };
    },
  };
  return preparation;
}

/**
 * The two in-memory authorities a checkout page holds over a direct intake.
 *
 * Refs rather than values: the boundary below has to act on what the page holds
 * at the instant a buyer changes their media, not on whatever was read when a
 * handler closure was created.
 */
export interface DirectIntakeAuthorityRefs {
  /** The frozen, completed batch: a capability plus a list of asset ids. */
  completed: { current: DirectIntakeSubmissionCache | null };
  /** The partial state: the live intake, its capability, its saved slots. */
  preparation: { current: DirectIntakePreparation | null };
}

/**
 * THE invalidation a page performs when a COMMITTED direct-intake media
 * selection changes — a photo added, replaced or removed, a voice note or
 * document attached or cleared, a supporting character saved or deleted.
 *
 * Why it is one function and not two lines at each call site: the two
 * authorities die together or not at all. Dropping the frozen batch while the
 * preparation keeps its generation leaves a reserve-upload already in flight
 * for the DISCARDED file fully current — it uploads, it passes the hand-off
 * guard, and `/api/order` binds an order to media the buyer removed on screen.
 * Dropping the preparation while the frozen batch survives is the mirror image.
 *
 * Synchronous and total by construction: it awaits nothing, it cannot fail, and
 * it is safe to call when there is nothing to invalidate. That is what lets a
 * caller run it BEFORE the UI state mutation it guards, with no window in
 * between for a parked run to wake up in.
 */
export function invalidateDirectIntakeMediaSelection(refs: DirectIntakeAuthorityRefs): void {
  refs.completed.current = null;
  refs.preparation.current?.reset();
}

/** The preparation attempt a submit owned before any attempt-resolution await. */
export interface DirectIntakeAttemptAuthority {
  preparationId: number;
  attempt: number;
}

export function captureDirectIntakeAttemptAuthority(
  preparation: DirectIntakePreparation | null,
): DirectIntakeAttemptAuthority {
  if (!preparation) throw new DirectIntakePreparationError(PREPARATION_CANCELLED);
  return { preparationId: preparation.id, attempt: preparation.attempt };
}

/** Refuses a submit whose media authority was reset while it awaited other work. */
export function assertDirectIntakeAttemptAuthorityIsCurrent(
  authority: DirectIntakeAttemptAuthority,
  preparation: DirectIntakePreparation | null,
): void {
  if (!preparation
    || preparation.id !== authority.preparationId
    || preparation.attempt !== authority.attempt) {
    throw new DirectIntakePreparationError(PREPARATION_CANCELLED);
  }
}

function snapshotMediaSelection(params: PrepareDirectIntakeSubmissionParams): DirectIntakeMediaSnapshot {
  return {
    heroPhoto: params.heroPhoto,
    familyCharacterIds: [...(params.familyCharacterIds
      ?? params.familyPhotos.map((entry) => entry.familyCharacterId))],
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
}

/**
 * Is a saved slot still the thing the current plan is asking for?
 *
 * The file is compared by IDENTITY. Two different photos of the same size and
 * type are not the same photo, and no cheap digest the browser can compute
 * would make them distinguishable here — so the only safe comparison is "this
 * is literally the object the buyer is still holding".
 */
function savedSlotIsReusable(
  record: SavedSlotRecord,
  planned: { slot: DirectSlotRef; file: Blob; mimeType: string },
  state: SlotStateStore,
): boolean {
  const live = state.get().slots[record.slotKey];
  return record.file === planned.file
    && record.mimeType === planned.mimeType
    && record.size === planned.file.size
    && record.category === planned.slot.category
    && record.familyCharacterId === (planned.slot.familyCharacterId ?? null)
    && record.guidedStillIndex === (planned.slot.guidedStillIndex ?? null)
    && live !== undefined
    && live.state === 'saved'
    && live.assetId === record.assetId
    && live.clientGeneration === record.clientGeneration;
}

function sameBlobList(left: readonly Blob[], right: readonly Blob[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

/** Identity comparison of a remembered media selection against a fresh one. */
function mediaSelectionMatches(
  snapshot: DirectIntakeMediaSnapshot,
  params: PrepareDirectIntakeSubmissionParams,
): boolean {
  const familyCharacterIds = params.familyCharacterIds
    ?? params.familyPhotos.map((entry) => entry.familyCharacterId);
  return snapshot.heroPhoto === params.heroPhoto
    && snapshot.familyCharacterIds.length === familyCharacterIds.length
    && snapshot.familyCharacterIds.every((id, index) => id === familyCharacterIds[index])
    && snapshot.familyPhotos.length === params.familyPhotos.length
    && snapshot.familyPhotos.every((entry, index) => {
      const candidate = params.familyPhotos[index];
      return candidate?.familyCharacterId === entry.familyCharacterId && candidate.file === entry.file;
    })
    && sameBlobList(snapshot.guidedStills, params.guidedStills.map((entry) => entry.file))
    && ((snapshot.voice === null && params.voice === null)
      || (snapshot.voice !== null && params.voice !== null
        && snapshot.voice.file === params.voice.file
        && snapshot.voice.source === params.voice.source
        && snapshot.voice.consent === params.voice.consent))
    && ((snapshot.document === null && !params.document)
      || (snapshot.document !== null && params.document != null
        && snapshot.document.file === params.document.file
        && snapshot.document.consent === params.document.consent));
}

export type PreparedDirectIntake = {
  submission: DirectIntakeSubmission;
  cache: DirectIntakeSubmissionCache;
  /**
   * The controller instance this result belongs to, or `null` when the caller
   * supplied no preparation for it to belong to.
   */
  preparationId: number | null;
  /**
   * The preparation generation this result belongs to, or `null` when the
   * caller supplied no preparation for it to belong to. Carried so the caller
   * can refuse a result the page invalidated after it was handed over.
   */
  preparationGeneration: number | null;
};

async function runDirectIntakePreparation(
  params: PrepareDirectIntakeSubmissionParams,
  preparation: DirectIntakePreparation | null,
): Promise<PreparedDirectIntake | null> {
  const submission = await prepareDirectIntakeSubmission(params, preparation);
  if (!submission) return null;
  // Safe to read here: the run's own last fence has just proved this is still
  // the generation it started under. The same stamp goes on the cache, so a
  // frozen batch carries its own authority for the rest of its life.
  const preparationId = preparation ? preparation.id : null;
  const preparationGeneration = preparation ? preparation.generation : null;
  return {
    submission,
    cache: { submission, ...snapshotMediaSelection(params), preparationId, preparationGeneration },
    preparationId,
    preparationGeneration,
  };
}

/**
 * Refuses a preparation result the page has already thrown away.
 *
 * The flow fences itself at every await it owns, but it cannot fence the gap
 * between its own resolution and the caller's next statement — and a buyer can
 * press Start over in exactly that window. Posting the result anyway would bind
 * an order to a capability this page has dropped. This is the caller's half of
 * the fence, and it belongs before anything is built or sent.
 */
export function assertDirectIntakeResultIsCurrent(
  prepared: PreparedDirectIntake | null,
  preparation: DirectIntakePreparation | null,
): void {
  if (!prepared) return;
  if (!directIntakeAuthorityIsCurrent(prepared, preparation)) {
    throw new DirectIntakePreparationError(PREPARATION_CANCELLED);
  }
}

/**
 * Reuses the exact private selection after a lost/refused order response.
 * Once an intake is fully prepared for a checkout attempt, changing any media
 * must start a fresh page/attempt rather than silently binding the deterministic
 * order id to a second intake.
 *
 * `options.preparation` adds the step BEFORE that one: an attempt that never
 * reached a complete submission keeps its intake and its saved slots, so a
 * second Continue re-sends only the files that are not already on the server.
 * It also coalesces a double Continue onto one preparation, because two
 * simultaneous intakes for one page is two of everything — sessions, uploads
 * and bytes — and only one of them could ever be paid for.
 */
export async function prepareOrReuseDirectIntakeSubmission(
  params: PrepareDirectIntakeSubmissionParams,
  cache: DirectIntakeSubmissionCache | null,
  options?: { preparation?: DirectIntakePreparation | null },
): Promise<PreparedDirectIntake | null> {
  if (!params.enabled) return null;
  // Bound at ENTRY, to the controller instance AND the attempt it was on.
  // Everything below that waits is judged against these two, never against
  // whatever the page happens to hold when the wait ends.
  const preparation = options?.preparation ?? null;
  const entryAttempt = preparation ? preparation.attempt : 0;
  const abortIfAttemptEnded = (): void => {
    if (preparation && preparation.attempt !== entryAttempt) {
      throw new DirectIntakePreparationError(PREPARATION_CANCELLED);
    }
  };
  if (cache) {
    // Judged BEFORE the media is even compared. A batch frozen under an
    // authority the page no longer holds is not a batch with a media problem;
    // it is a dead capability, and the only honest answer is that this attempt
    // is over.
    if (!directIntakeAuthorityIsCurrent(cache, preparation)) {
      throw new DirectIntakePreparationError(PREPARATION_CANCELLED);
    }
    if (!mediaSelectionMatches(cache, params)) {
      throw new DirectIntakePreparationError('direct_upload_selection_changed_reload_required');
    }
    // Handed back with the stamp it was BUILT with, never re-stamped with
    // whatever the page holds now — that re-stamp is what let a pre-reset batch
    // pass the hand-off guard.
    return {
      submission: cache.submission,
      cache,
      preparationId: cache.preparationId,
      preparationGeneration: cache.preparationGeneration,
    };
  }
  if (!preparation) return runDirectIntakePreparation(params, null);

  // Single flight, RE-ACQUIRED after every wait.
  //
  // A waiter may not decide it owns the next preparation at the moment it
  // started waiting. While it was parked, another waiter for the same changed
  // selection can have woken first and begun exactly the run it wants — so
  // checking once, before the wait, lets Continue-A / Continue-B / Continue-B
  // become TWO B preparations: two intakes, two uploads of the same bytes, two
  // runs trampling one slot store, and only one of them ever payable. Every
  // wake-up therefore re-reads the flight and either joins it or claims it.
  for (;;) {
    const pending = preparation.inFlight;
    if (!pending) break;
    // The same selection rides the run already under way. A DIFFERENT one
    // waits for it to settle rather than racing it, and is then judged by the
    // ordinary rules — which discard the partial state it no longer matches.
    if (preparation.inFlightMedia && mediaSelectionMatches(preparation.inFlightMedia, params)) {
      return pending;
    }
    await pending.catch(() => {});
    // A wait is a window, and Start over lands in it. Waking up to find the
    // flight empty is not permission to fill it: the run this caller was
    // queued behind may have been CANCELLED rather than finished, and starting
    // a fresh intake here would swallow that cancellation and hand the page an
    // accepted result for an attempt the buyer ended. Refused before anything
    // is claimed, created, or uploaded.
    abortIfAttemptEnded();
    if (preparation.inFlight === pending) {
      // A settled run that has not released the flight yet. Release it here
      // rather than looping on it; the owner's own release is identity-guarded
      // and will simply find nothing of its own left to clear.
      preparation.inFlight = null;
      preparation.inFlightMedia = null;
    }
  }

  const run = runDirectIntakePreparation(params, preparation);
  preparation.inFlight = run;
  preparation.inFlightMedia = snapshotMediaSelection(params);
  void run.catch(() => {}).then(() => {
    if (preparation.inFlight === run) {
      preparation.inFlight = null;
      preparation.inFlightMedia = null;
    }
  });
  return run;
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
