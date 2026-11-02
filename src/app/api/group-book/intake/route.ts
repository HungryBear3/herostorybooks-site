import { NextResponse } from 'next/server';

import { extractGroupBookToken, inviteRefusal } from '@/lib/group-book/config';
import { resolveGroupBookSessionInvite, classroomOriginAllowed } from '@/lib/group-book/identity-access';
import { normalizeGroupBookImage } from '@/lib/group-book/image-type';
import {
  GROUP_BOOK_INTAKE_WRITE_WINDOW_MS,
  MAX_GROUP_BOOK_PHOTOS,
  MAX_INTAKE_REQUEST_BYTES,
  MAX_PREPARED_PHOTO_BYTES,
} from '@/lib/group-book/limits';
import { groupBookAdmission } from '@/lib/group-book/release';
import { groupBookEditionState } from '@/lib/group-book/retention';
import { GROUP_BOOK_PRIVATE_HEADERS, setGroupBookAccessCookie } from '@/lib/group-book/session';
import {
  buildGroupBookSubmission,
  createGroupBookAttempt,
  createOrReconcileGroupBookSubmission,
  deleteGroupBookPhotos,
  findGroupBookSubmission,
  groupBookStorageReady,
  newGroupBookSubmissionId,
  planGroupBookPhotos,
  writePlannedGroupBookPhoto,
  type GroupBookAgeRange,
  type GroupBookPhotoAsset,
} from '@/lib/group-book/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Platform-enforced invocation limit (must be a literal for Next; equals
// GROUP_BOOK_INTAKE_MAX_DURATION_S). Ends this invocation; it does not prove
// that a provider write already sent was not committed.
export const maxDuration = 60;

const AGE_RANGES = new Set<GroupBookAgeRange>(['2-3', '3-4', '5-6', '7-8', '9-10', '10+']);

function text(form: FormData, name: string, max: number): string | null {
  const value = form.get(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function emailLooksValid(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

class WriteWindowElapsed extends Error {}

function refuse(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status, headers: GROUP_BOOK_PRIVATE_HEADERS });
}

function success(token: string, expiresAt: string, alreadySubmitted: boolean) {
  const response = NextResponse.json(
    { ok: true, alreadySubmitted, accessUrl: '/group-book/family' },
    { status: 200, headers: GROUP_BOOK_PRIVATE_HEADERS },
  );
  setGroupBookAccessCookie(response, token, expiresAt);
  return response;
}

export async function POST(req: Request) {
  if (!classroomOriginAllowed(req)) return refuse('invalid_origin', 403);
  if (!groupBookStorageReady()) return refuse('storage_disabled', 503);
  // Writer lifetime starts at arrival on the server clock (DESIGN I2).
  const admittedAt = Date.now();
  const writeDeadline = admittedAt + GROUP_BOOK_INTAKE_WRITE_WINDOW_MS;
  const windowOpen = () => Date.now() < writeDeadline;
  // Truthful body cap, checked before parsing. The platform's own 4.5 MB limit
  // may answer first with a non-JSON 413; the client handles both.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_INTAKE_REQUEST_BYTES) return refuse('request_too_large', 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse('invalid_form', 400);
  }

  const token = extractGroupBookToken(text(form, 'invite', 200) ?? '');
  const resolved = token ? await resolveGroupBookSessionInvite(token, req.headers.get('cookie') ?? '', true) : { state: 'unknown' as const };
  if (!token || resolved.state !== 'active') return refuse(inviteRefusal(resolved.state), 403);
  const invite = resolved.invite;

  // Recovery of existing work is a read and is allowed while admission is closed.
  try {
    if (await findGroupBookSubmission(invite)) return success(token, invite.expiresAt, true);
  } catch (err) {
    console.error('[group-book/intake] private record read failed:', err instanceof Error ? err.name : 'unknown');
    return refuse('storage_unavailable', 503);
  }

  // Release switch and adopted policy gate every NEW persistence.
  const admission = groupBookAdmission();
  if (admission.open === false) return refuse(admission.refusal, 403);
  // No new persistence once the edition is released or delivered, or when
  // that cannot be established. Recovery above stays available.
  const edition = await groupBookEditionState(invite.cohortId);
  if (edition !== 'open') return refuse(edition === 'released' ? 'edition_already_released' : 'storage_unavailable', edition === 'released' ? 409 : 503);
  const policyVersion = text(form, 'policyVersion', 100);
  const policyDigest = text(form, 'policyDigest', 80);
  if (policyVersion !== admission.policy.record.version || policyDigest !== admission.policy.digest) {
    return refuse('policy_consent_stale', 409);
  }

  const parentName = text(form, 'parentName', 80);
  const parentEmail = text(form, 'parentEmail', 200);
  const childFirstName = text(form, 'childFirstName', 40);
  const ageRange = text(form, 'ageRange', 12) as GroupBookAgeRange | null;
  const characterNotes = text(form, 'characterNotes', 600) ?? '';
  const consentComplete =
    form.get('guardianAuthority') === 'true' &&
    form.get('sharedWithParticipatingFamilies') === 'true' &&
    form.get('sourcePhotosRemainPrivate') === 'true' &&
    form.get('schoolApprovalNotRepresentedOrImplied') === 'true';
  if (
    !parentName || !parentEmail || !emailLooksValid(parentEmail) ||
    !childFirstName || !ageRange || !AGE_RANGES.has(ageRange) || !consentComplete
  ) {
    return refuse('missing_or_invalid_fields', 422);
  }

  const files = form.getAll('photos').filter((value): value is File => value instanceof File);
  if (files.length < 1 || files.length > MAX_GROUP_BOOK_PHOTOS) return refuse('invalid_photo_count', 422);

  const prepared: { bytes: Buffer; mime: string; ext: string }[] = [];
  for (const file of files) {
    if (file.size > MAX_PREPARED_PHOTO_BYTES) return refuse('photo_too_large', 413);
    // Only server-decoded, re-encoded bytes are persisted; the original upload
    // (metadata, trailing payload, extra frames) is never stored.
    const image = await normalizeGroupBookImage(file);
    if (image.ok === false) return refuse(image.error, image.error === 'unsupported_image' ? 415 : 422);
    prepared.push({ bytes: image.bytes, mime: image.mime, ext: image.ext });
  }

  // Durable owner BEFORE any photo write: every path this attempt may write is
  // recorded under the family first, so no stored photo is ever unattributed.
  const submissionId = newGroupBookSubmissionId();
  const planned = planGroupBookPhotos(invite, prepared);
  if (!windowOpen()) return refuse('write_window_elapsed', 503);
  const owner = await createGroupBookAttempt(invite, submissionId, planned, { admittedAt, writeDeadline });
  if (!owner) {
    console.error('[group-book/intake] owner record unconfirmed; no photo written');
    return refuse('owner_record_unconfirmed', 503);
  }

  // The Blob SDK itself retries network/5xx failures (VERCEL_BLOB_RETRIES,
  // default 10). Create-only paths turn a retried committed write into an
  // error, never a second object; this handler adds no retry of its own.
  // Every put is aborted at the write deadline; an abort ends the SDK retry
  // loop locally but may still leave a remote commit, which stays owned by
  // the attempt record above and is removed by the scheduled retention pass.
  const uploaded: GroupBookPhotoAsset[] = [];
  try {
    for (const photo of planned) {
      if (!windowOpen()) throw new WriteWindowElapsed();
      uploaded.push(await writePlannedGroupBookPhoto(photo, AbortSignal.timeout(Math.max(1, writeDeadline - Date.now()))));
    }
  } catch (err) {
    // No family record references these random paths yet. Best-effort cleanup
    // only: a failed delete leaves them attributed by the owner record.
    await deleteGroupBookPhotos(planned.map((photo) => ({
      assetId: photo.assetId, pathname: photo.pathname, mime: photo.mime, size: 1, uploadedAt: '', storage: 'private',
    })));
    console.error('[group-book/intake] private upload failed:', err instanceof Error ? err.name : 'unknown');
    if (err instanceof WriteWindowElapsed || !windowOpen()) return refuse('write_window_elapsed', 503);
    return refuse('private_upload_failed', 502);
  }

  const record = buildGroupBookSubmission({
    invite,
    parentName,
    parentEmail,
    childFirstName,
    ageRange,
    characterNotes,
    photos: uploaded,
    policy: { version: admission.policy.record.version, digest: admission.policy.digest },
    id: submissionId,
  });
  // Recheck immediately before the family record commit: a release recorded
  // while photos were uploading refuses the commit. The photos stay owned by
  // the durable attempt record (with cohort/family identity), and the
  // scheduled retention pass deletes them. Not atomic: the fence against
  // cleanup is server-recorded lifecycle times (due >= release + 90d) plus
  // recurring re-verification of every declared key, not this check.
  const editionAtCommit = await groupBookEditionState(invite.cohortId);
  if (editionAtCommit !== 'open') {
    console.error('[group-book/intake] edition closed during upload; record not committed, photos remain owner-attributed');
    return refuse(editionAtCommit === 'released' ? 'edition_already_released' : 'storage_unavailable', editionAtCommit === 'released' ? 409 : 503);
  }
  if (!windowOpen()) {
    console.error('[group-book/intake] write window elapsed before commit; photos remain owner-attributed');
    return refuse('write_window_elapsed', 503);
  }
  const created = await createOrReconcileGroupBookSubmission(invite, record);
  if (created.outcome === 'created' || created.outcome === 'committed') return success(token, invite.expiresAt, false);

  if (created.outcome === 'conflict') {
    // A concurrent request provably won the create-only family record. Never
    // overwrite it; clean up only this request's random-path assets.
    const winnerPaths = new Set(created.winner.photos.map((photo) => photo.pathname));
    await deleteGroupBookPhotos(uploaded.filter((photo) => !winnerPaths.has(photo.pathname)));
    return success(token, invite.expiresAt, true);
  }

  // Durability unknown: the record may reference these photos, so keep them,
  // do not write again, and do not claim success. Re-entry reconciles.
  console.error('[group-book/intake] record persistence unconfirmed; photos retained');
  return refuse('record_persist_unconfirmed', 503);
}
