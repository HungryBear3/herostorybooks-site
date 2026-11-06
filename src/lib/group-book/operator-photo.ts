import { groupBookInvitesStrict, invitePurpose, type GroupBookInvite } from './config.ts';
import { loadGroupBookAdmission, type GroupBookAdmissionResult } from './export.ts';
import { classroomCodesStrict } from './identity-access.ts';
import { sniffGroupBookImage } from './image-type.ts';
import { loadGroupBookCohortPurpose, pilotStampMatches } from './pilot-retention.ts';
import { groupBookEditionState, groupBookPhotoAvailability, openGroupBookSourcePhoto } from './retention.ts';
import { loadClassroomRoster } from './roster.ts';
import { groupBookPhotoPath, loadEffectiveGroupBookSubmission, type GroupBookPhotoAsset } from './store.ts';

/**
 * Operator per-asset photo preview, on top of the existing admission gate. A
 * photo is previewable only while its whole cohort settles 'ready', its family
 * is admitted as eligible, its invitation is unexpired, the durable purpose
 * agrees with configuration and the record's stamp, and the fullbook/pilot
 * anchor leaves the edition open. Nothing here deletes, exports or writes.
 */
export const OPERATOR_PHOTO_ASSET_RE = /^gbp_[A-Za-z0-9_-]{1,64}$/;
/** Canonical photos are JPEG only; this keeps a response below the 4.5 MB platform limit. */
export const MAX_OPERATOR_PHOTO_BYTES = 4_000_000;

export type ConfiguredCohort = Pick<GroupBookInvite, 'cohortId' | 'purpose'>;

/** Configured legacy + selector rows, or null when malformed. Only cohortId and purpose are ever used. */
export function configuredCohorts(): ConfiguredCohort[] | null {
  const legacy = groupBookInvitesStrict();
  const selectors = classroomCodesStrict();
  if (legacy.state === 'malformed' || selectors.state === 'malformed') return null;
  return [...(legacy.state === 'valid' ? legacy.invites : []), ...(selectors.state === 'valid' ? selectors.cohorts : [])];
}

interface PreviewFamily {
  invite: GroupBookInvite;
  assets: GroupBookPhotoAsset[];
}

export interface OperatorPhotoReview {
  admission: GroupBookAdmissionResult;
  /** Keyed by submission id. null: the cohort is uncertain and previews nothing. */
  previews: Map<string, PreviewFamily> | null;
}

/** The record's path must be the one derived from its own asset id; a repeated id proves nothing. */
function previewableAssets(invite: GroupBookInvite, photos: GroupBookPhotoAsset[]): GroupBookPhotoAsset[] {
  return photos.filter((photo) =>
    OPERATOR_PHOTO_ASSET_RE.test(photo.assetId) && photo.mime === 'image/jpeg' && photo.size <= MAX_OPERATOR_PHOTO_BYTES &&
    photo.pathname === groupBookPhotoPath(invite, photo.assetId, 'jpg') &&
    photos.filter((other) => other.assetId === photo.assetId).length === 1);
}

/**
 * Current admission plus the assets proven previewable. Reads private JSON
 * records only, never a photo object. Store uncertainty throws or yields null.
 */
export async function loadOperatorPhotoReview(cohortId: string, now: number): Promise<OperatorPhotoReview> {
  const roster = await loadClassroomRoster(cohortId);
  const admission = await loadGroupBookAdmission(cohortId, roster);
  if (roster.state !== 'complete' || admission.state !== 'ready') return { admission, previews: null };
  const [purpose, availability] = await Promise.all([loadGroupBookCohortPurpose(cohortId), groupBookPhotoAvailability(cohortId, now)]);
  if (purpose.state !== 'registered' || availability.state !== 'no_delivery_recorded') return { admission, previews: null };
  if (roster.invites.some((invite) => invitePurpose(invite) !== purpose.record.purpose)) return { admission, previews: null };
  const previews = new Map<string, PreviewFamily>();
  for (const participant of admission.eligible) {
    const invite = roster.invites.find((row) => row.familySlotId === participant.familySlotId);
    // Admission does not consult invitation expiry; access here does.
    if (!invite || Date.parse(invite.expiresAt) <= now) continue;
    const submission = await loadEffectiveGroupBookSubmission(invite);
    if (submission?.id !== participant.submissionId || submission.effectiveStatus !== 'submitted') continue;
    const stamped = purpose.record.purpose === 'pilot_test_only'
      ? pilotStampMatches(submission.pilot, purpose.record.registrationId)
      : submission.pilot === undefined;
    if (stamped) previews.set(submission.id, { invite, assets: previewableAssets(invite, submission.photos) });
  }
  return { admission, previews };
}

export type OperatorPhotoOutcome =
  | { state: 'ok'; bytes: Buffer; mime: 'image/jpeg' }
  | { state: 'unavailable' }
  | { state: 'held' };

/**
 * One asset for one authenticated operator request. Everything is rechecked
 * per call, and the object comes only from the verified current record. The
 * recheck after the read narrows, but cannot close, a race with a withdrawal:
 * the private store has no multi-object transaction.
 */
export async function openOperatorPhotoPreview(args: {
  cohortId: string;
  submissionId: string;
  assetId: string;
  now: number;
}): Promise<OperatorPhotoOutcome> {
  const { cohortId, submissionId, assetId, now } = args;
  const availability = await groupBookPhotoAvailability(cohortId, now);
  if (availability.state === 'expired') return { state: 'unavailable' };
  if (availability.state === 'unknown') return { state: 'held' };
  const { previews } = await loadOperatorPhotoReview(cohortId, now);
  if (!previews) return { state: 'held' };
  const family = previews.get(submissionId);
  const asset = family?.assets.find((row) => row.assetId === assetId);
  if (!family || !asset) return { state: 'unavailable' };

  const photo = await openGroupBookSourcePhoto(family.invite, assetId, now);
  if (photo.state === 'unknown') return { state: 'held' };
  if (photo.state !== 'ok') return { state: 'unavailable' };
  if (photo.mime !== 'image/jpeg' || photo.bytes.byteLength !== asset.size || sniffGroupBookImage(photo.bytes)?.mime !== 'image/jpeg') {
    return { state: 'held' };
  }

  const [after, edition] = [await loadEffectiveGroupBookSubmission(family.invite), await groupBookEditionState(cohortId)];
  if (edition === 'unknown') return { state: 'held' };
  if (edition !== 'open' || after?.id !== submissionId || after.effectiveStatus !== 'submitted') return { state: 'unavailable' };
  return { state: 'ok', bytes: photo.bytes, mime: 'image/jpeg' };
}
