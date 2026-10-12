import { del, get, put } from '@vercel/blob';
// Namespace import so the SDK error classes are looked up, not required: the
// test fakes export only get/put/del.
import * as blobSdk from '@vercel/blob';
import { randomBytes } from 'node:crypto';

import {
  familyStorageKey,
  groupBookBlobToken,
  groupBookBlobTokenProblem,
  type GroupBookInvite,
} from './config.ts';

export type GroupBookAgeRange = '2-3' | '3-4' | '5-6' | '7-8' | '9-10' | '10+';

export interface GroupBookPhotoAsset {
  assetId: string;
  pathname: string;
  mime: string;
  size: number;
  uploadedAt: string;
  storage: 'private';
}

export interface GroupBookSubmission {
  schemaVersion: 1;
  id: string;
  familyStorageKey: string;
  cohort: { id: string; label: string; familySlotId: string };
  parent: { name: string; email: string };
  child: {
    firstName: string;
    ageRange: GroupBookAgeRange;
    characterNotes: string;
  };
  consent: {
    version: 'group-book-v1';
    agreedAt: string;
    guardianAuthority: true;
    sharedWithParticipatingFamilies: true;
    sourcePhotosRemainPrivate: true;
    schoolApprovalNotRepresentedOrImplied: true;
  };
  photos: GroupBookPhotoAsset[];
  status: 'submitted';
  omitFromProofAndPrint: false;
  receivedAt: string;
}

export interface GroupBookWithdrawal {
  schemaVersion: 1;
  familyStorageKey: string;
  requestedAt: string;
  omitFromProofAndPrint: true;
  reason: 'parent_requested';
}

export interface EffectiveGroupBookSubmission extends GroupBookSubmission {
  // 'withdrawal_unverified': the marker read was uncertain (non-404 status,
  // missing stream, corrupt or foreign content). Treated as omitted, never as
  // eligible, until a clean read settles it.
  effectiveStatus: 'submitted' | 'withdrawal_requested' | 'withdrawal_unverified';
  effectiveOmitFromProofAndPrint: boolean;
  withdrawalRequestedAt?: string;
}

/** A private-store object read that could not be classified as present or absent. */
export class GroupBookStoreReadError extends Error {
  constructor(message = 'group_book_store_read_uncertain') {
    super(message);
    this.name = 'GroupBookStoreReadError';
  }
}

type PrivateRead =
  | { state: 'found'; value: unknown }
  | { state: 'absent' }
  | { state: 'unreadable' };

export type GroupBookCreateOutcome =
  | { outcome: 'created' }
  | { outcome: 'committed' }
  | { outcome: 'conflict'; winner: GroupBookSubmission }
  | { outcome: 'unconfirmed' };

function requireToken(): string {
  const token = groupBookBlobToken();
  if (!token) throw new Error(groupBookBlobTokenProblem() ?? 'group_book_storage_disabled');
  return token;
}

export function groupBookStorageReady(): boolean {
  return groupBookBlobTokenProblem() === null;
}

export function groupBookRecordPath(invite: GroupBookInvite): string {
  return `group-book/families/${familyStorageKey(invite)}.json`;
}

export function groupBookWithdrawalPath(invite: GroupBookInvite): string {
  return `group-book/withdrawals/${familyStorageKey(invite)}.json`;
}

export function groupBookPhotoPath(invite: GroupBookInvite, assetId: string, ext: string): string {
  return `group-book/photos/${familyStorageKey(invite)}/${assetId}.${ext}`;
}

function newOpaqueId(prefix: string, bytes = 16): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

/**
 * Proven absence from a thrown error, by SDK class identity only, following
 * src/lib/confirmation-envelope-store.ts. A vanished STORE proves nothing about
 * an object in it. A name, message or same-named foreign class is not proof,
 * and the real SDK's throw-vs-404 behaviour for private reads is unverified
 * here, so every other thrown error propagates.
 */
function isProvenAbsence(error: unknown): boolean {
  const sdk = blobSdk as unknown as Record<string, unknown>;
  const notFound = sdk.BlobNotFoundError;
  const storeNotFound = sdk.BlobStoreNotFoundError;
  try {
    if (typeof notFound !== 'function' || !(error instanceof notFound)) return false;
    return !(typeof storeNotFound === 'function' && error instanceof storeNotFound);
  } catch {
    return false;
  }
}

/**
 * Only a 404 (or an empty result, as confirmation-envelope-store.ts treats it)
 * or the SDK's not-found error is absence. Any other status, a missing stream
 * or an unparseable body is 'unreadable'. Transport exceptions are rethrown.
 */
async function readPrivateObject(pathname: string): Promise<PrivateRead> {
  let result: Awaited<ReturnType<typeof get>>;
  try {
    result = await get(pathname, {
      access: 'private',
      token: requireToken(),
      useCache: false,
    });
  } catch (err) {
    if (isProvenAbsence(err)) return { state: 'absent' };
    throw err;
  }
  if (!result) return { state: 'absent' };
  const statusCode: number = result.statusCode;
  if (statusCode === 404) return { state: 'absent' };
  if (statusCode !== 200 || !result.stream) return { state: 'unreadable' };
  try {
    return { state: 'found', value: JSON.parse(await new Response(result.stream).text()) as unknown };
  } catch {
    return { state: 'unreadable' };
  }
}

const AGE_RANGES: ReadonlySet<string> = new Set(['2-3', '3-4', '5-6', '7-8', '9-10', '10+']);

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePhoto(value: unknown, key: string): GroupBookPhotoAsset | null {
  if (!isObject(value)) return null;
  if (!isText(value.assetId) || !/^gbp_[A-Za-z0-9_-]+$/.test(value.assetId)) return null;
  if (!isText(value.pathname) || !value.pathname.startsWith(`group-book/photos/${key}/`)) return null;
  if (!isText(value.mime) || !value.mime.startsWith('image/')) return null;
  if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size <= 0) return null;
  if (!isTimestamp(value.uploadedAt) || value.storage !== 'private') return null;
  return value as unknown as GroupBookPhotoAsset;
}

/**
 * Runtime validation at the private-store read boundary; identity included.
 * The stored key AND the stored cohort/family identifiers must all be the
 * requested invite's: a matching key with contradictory identifiers is
 * corrupt, never a proven record.
 */
function parseSubmission(value: unknown, invite: GroupBookInvite): GroupBookSubmission | null {
  const key = familyStorageKey(invite);
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  if (!isText(value.id) || !/^gbs_[A-Za-z0-9_-]+$/.test(value.id)) return null;
  if (value.familyStorageKey !== key) return null;
  const { cohort, parent, child, consent, photos } = value;
  if (!isObject(cohort) || !isText(cohort.id) || !isText(cohort.label) || !isText(cohort.familySlotId)) return null;
  if (cohort.id !== invite.cohortId || cohort.familySlotId !== invite.familySlotId) return null;
  if (familyStorageKey({ cohortId: cohort.id, familySlotId: cohort.familySlotId }) !== key) return null;
  if (!isObject(parent) || !isText(parent.name) || !isText(parent.email)) return null;
  if (!isObject(child) || !isText(child.firstName) || !isText(child.characterNotes)) return null;
  if (!isText(child.ageRange) || !AGE_RANGES.has(child.ageRange)) return null;
  if (
    !isObject(consent) || consent.version !== 'group-book-v1' || !isTimestamp(consent.agreedAt) ||
    consent.guardianAuthority !== true || consent.sharedWithParticipatingFamilies !== true ||
    consent.sourcePhotosRemainPrivate !== true || consent.schoolApprovalNotRepresentedOrImplied !== true
  ) {
    return null;
  }
  if (!Array.isArray(photos) || photos.length < 1 || photos.some((photo) => !parsePhoto(photo, key))) return null;
  if (value.status !== 'submitted' || value.omitFromProofAndPrint !== false || !isTimestamp(value.receivedAt)) {
    return null;
  }
  return value as unknown as GroupBookSubmission;
}

function parseWithdrawal(value: unknown, key: string): GroupBookWithdrawal | null {
  if (!isObject(value) || value.schemaVersion !== 1 || value.familyStorageKey !== key) return null;
  if (!isTimestamp(value.requestedAt) || value.omitFromProofAndPrint !== true) return null;
  if (value.reason !== 'parent_requested') return null;
  return value as unknown as GroupBookWithdrawal;
}

async function readGroupBookSubmissionState(
  invite: GroupBookInvite,
): Promise<{ state: 'found'; record: GroupBookSubmission } | { state: 'absent' } | { state: 'unreadable' }> {
  const read = await readPrivateObject(groupBookRecordPath(invite));
  if (read.state !== 'found') return read;
  const record = parseSubmission(read.value, invite);
  return record ? { state: 'found', record } : { state: 'unreadable' };
}

/**
 * null means proven absence only. An uncertain or corrupt record throws
 * GroupBookStoreReadError; transport exceptions propagate unchanged.
 */
export async function findGroupBookSubmission(
  invite: GroupBookInvite,
): Promise<GroupBookSubmission | null> {
  const read = await readGroupBookSubmissionState(invite);
  if (read.state === 'unreadable') throw new GroupBookStoreReadError();
  return read.state === 'found' ? read.record : null;
}

export async function loadEffectiveGroupBookSubmission(
  invite: GroupBookInvite,
): Promise<EffectiveGroupBookSubmission | null> {
  const record = await findGroupBookSubmission(invite);
  if (!record) return null;
  const read = await readPrivateObject(groupBookWithdrawalPath(invite));
  if (read.state === 'absent') {
    return { ...record, effectiveStatus: 'submitted', effectiveOmitFromProofAndPrint: false };
  }
  const withdrawal = read.state === 'found' ? parseWithdrawal(read.value, record.familyStorageKey) : null;
  if (withdrawal) {
    return {
      ...record,
      effectiveStatus: 'withdrawal_requested',
      effectiveOmitFromProofAndPrint: true,
      withdrawalRequestedAt: withdrawal.requestedAt,
    };
  }
  // A marker that may exist but cannot be verified must never read as eligible.
  return { ...record, effectiveStatus: 'withdrawal_unverified', effectiveOmitFromProofAndPrint: true };
}

export async function uploadGroupBookPhoto(args: {
  invite: GroupBookInvite;
  bytes: Buffer;
  mime: string;
  ext: string;
}): Promise<GroupBookPhotoAsset> {
  const assetId = newOpaqueId('gbp', 12);
  const pathname = groupBookPhotoPath(args.invite, assetId, args.ext);
  const result = await put(pathname, args.bytes, {
    access: 'private',
    token: requireToken(),
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 0,
    contentType: args.mime,
  });
  return {
    assetId,
    pathname: result.pathname ?? pathname,
    mime: args.mime,
    size: args.bytes.byteLength,
    uploadedAt: new Date().toISOString(),
    storage: 'private',
  };
}

export async function deleteGroupBookPhotos(photos: GroupBookPhotoAsset[]): Promise<void> {
  if (photos.length === 0) return;
  try {
    await del(photos.map((photo) => photo.pathname), { token: requireToken() });
  } catch (err) {
    console.error('[group-book] orphan photo cleanup failed:', err instanceof Error ? err.name : 'unknown');
  }
}

export function buildGroupBookSubmission(args: {
  invite: GroupBookInvite;
  parentName: string;
  parentEmail: string;
  childFirstName: string;
  ageRange: GroupBookAgeRange;
  characterNotes: string;
  photos: GroupBookPhotoAsset[];
  now?: Date;
}): GroupBookSubmission {
  const at = (args.now ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    id: newOpaqueId('gbs'),
    familyStorageKey: familyStorageKey(args.invite),
    cohort: {
      id: args.invite.cohortId,
      label: args.invite.cohortLabel,
      familySlotId: args.invite.familySlotId,
    },
    parent: { name: args.parentName, email: args.parentEmail.toLowerCase() },
    child: {
      firstName: args.childFirstName,
      ageRange: args.ageRange,
      characterNotes: args.characterNotes,
    },
    consent: {
      version: 'group-book-v1',
      agreedAt: at,
      guardianAuthority: true,
      sharedWithParticipatingFamilies: true,
      sourcePhotosRemainPrivate: true,
      schoolApprovalNotRepresentedOrImplied: true,
    },
    photos: args.photos,
    status: 'submitted',
    omitFromProofAndPrint: false,
    receivedAt: at,
  };
}

/**
 * true only when this call's create-only put was acknowledged. false does NOT
 * prove the record was not written: a put can commit and still lose its
 * response. Callers that clean up must use createOrReconcileGroupBookSubmission.
 */
export async function createGroupBookSubmission(record: GroupBookSubmission): Promise<boolean> {
  try {
    await put(`group-book/families/${record.familyStorageKey}.json`, JSON.stringify(record), {
      access: 'private',
      token: requireToken(),
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 0,
      contentType: 'application/json',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the family record, then reconcile an unacknowledged create against
 * the authoritative record before anyone may delete assets:
 * - 'committed': the stored record is this submission; all its photos stay.
 * - 'conflict': a different valid submission owns the family record; only
 *   this request's photos not referenced by the winner may be cleaned up.
 * - 'unconfirmed': durability is unknown (reread absent, unreadable, corrupt
 *   or thrown); nothing may be deleted and the caller must not report success.
 * Never throws.
 */
export async function createOrReconcileGroupBookSubmission(
  invite: GroupBookInvite,
  record: GroupBookSubmission,
): Promise<GroupBookCreateOutcome> {
  if (await createGroupBookSubmission(record)) return { outcome: 'created' };
  let current: Awaited<ReturnType<typeof readGroupBookSubmissionState>>;
  try {
    current = await readGroupBookSubmissionState(invite);
  } catch {
    return { outcome: 'unconfirmed' };
  }
  if (current.state !== 'found') return { outcome: 'unconfirmed' };
  if (current.record.id === record.id) return { outcome: 'committed' };
  return { outcome: 'conflict', winner: current.record };
}

export async function requestGroupBookWithdrawal(
  invite: GroupBookInvite,
  now = new Date(),
): Promise<{ requestedAt: string; created: boolean }> {
  const key = familyStorageKey(invite);
  // Thrown read errors propagate. An unreadable marker falls through to the
  // create-only put, which can never overwrite an existing marker.
  const existingRead = await readPrivateObject(groupBookWithdrawalPath(invite));
  const existing = existingRead.state === 'found' ? parseWithdrawal(existingRead.value, key) : null;
  if (existing) {
    return { requestedAt: existing.requestedAt, created: false };
  }
  const marker: GroupBookWithdrawal = {
    schemaVersion: 1,
    familyStorageKey: key,
    requestedAt: now.toISOString(),
    omitFromProofAndPrint: true,
    reason: 'parent_requested',
  };
  try {
    await put(groupBookWithdrawalPath(invite), JSON.stringify(marker), {
      access: 'private',
      token: requireToken(),
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 0,
      contentType: 'application/json',
    });
    return { requestedAt: marker.requestedAt, created: true };
  } catch {
    const winnerRead = await readPrivateObject(groupBookWithdrawalPath(invite));
    const winner = winnerRead.state === 'found' ? parseWithdrawal(winnerRead.value, key) : null;
    if (winner) {
      return { requestedAt: winner.requestedAt, created: false };
    }
    throw new Error('withdrawal_write_failed');
  }
}
