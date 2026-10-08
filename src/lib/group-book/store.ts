import { del, get, put } from '@vercel/blob';
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
  effectiveStatus: 'submitted' | 'withdrawal_requested';
  effectiveOmitFromProofAndPrint: boolean;
  withdrawalRequestedAt?: string;
}

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

async function readPrivateJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, {
    access: 'private',
    token: requireToken(),
    useCache: false,
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  try {
    return JSON.parse(await new Response(result.stream).text()) as T;
  } catch {
    return null;
  }
}

export async function findGroupBookSubmission(
  invite: GroupBookInvite,
): Promise<GroupBookSubmission | null> {
  const record = await readPrivateJson<GroupBookSubmission>(groupBookRecordPath(invite));
  if (!record || record.schemaVersion !== 1) return null;
  if (record.familyStorageKey !== familyStorageKey(invite)) return null;
  return record;
}

export async function loadEffectiveGroupBookSubmission(
  invite: GroupBookInvite,
): Promise<EffectiveGroupBookSubmission | null> {
  const record = await findGroupBookSubmission(invite);
  if (!record) return null;
  const withdrawal = await readPrivateJson<GroupBookWithdrawal>(groupBookWithdrawalPath(invite));
  const withdrawn = Boolean(
    withdrawal &&
    withdrawal.schemaVersion === 1 &&
    withdrawal.familyStorageKey === record.familyStorageKey &&
    withdrawal.omitFromProofAndPrint === true,
  );
  return {
    ...record,
    effectiveStatus: withdrawn ? 'withdrawal_requested' : 'submitted',
    effectiveOmitFromProofAndPrint: withdrawn,
    ...(withdrawn ? { withdrawalRequestedAt: withdrawal!.requestedAt } : {}),
  };
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

export async function requestGroupBookWithdrawal(
  invite: GroupBookInvite,
  now = new Date(),
): Promise<{ requestedAt: string; created: boolean }> {
  const existing = await readPrivateJson<GroupBookWithdrawal>(groupBookWithdrawalPath(invite));
  if (existing?.omitFromProofAndPrint === true) {
    return { requestedAt: existing.requestedAt, created: false };
  }
  const marker: GroupBookWithdrawal = {
    schemaVersion: 1,
    familyStorageKey: familyStorageKey(invite),
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
    const winner = await readPrivateJson<GroupBookWithdrawal>(groupBookWithdrawalPath(invite));
    if (winner?.omitFromProofAndPrint === true) {
      return { requestedAt: winner.requestedAt, created: false };
    }
    throw new Error('withdrawal_write_failed');
  }
}
