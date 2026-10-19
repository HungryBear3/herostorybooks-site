import { createHash } from 'node:crypto';

import { familyStorageKey, groupBookInvites, type GroupBookInvite } from './config.ts';
import { groupBookPolicyState } from './release.ts';
import { groupBookEditionState } from './retention.ts';
import { loadEffectiveGroupBookSubmission, type GroupBookPolicyConsent } from './store.ts';

/**
 * Operator assembly handoff for one cohort. Reads the CURRENT effective state
 * of every configured family slot from the private store and admits only
 * provably eligible participants. Any uncertainty blocks the whole cohort:
 * an unreadable record or withdrawal marker, an unverified withdrawal, an
 * unstamped (legacy) or mismatched policy consent, or a revoked capability
 * that still has a submission.
 */
export type FamilyAdmissionStatus =
  | 'eligible'
  | 'not_submitted'
  | 'withdrawn'
  | 'invite_revoked'
  | 'invite_revoked_with_submission'
  | 'unreadable'
  | 'withdrawal_unverified'
  | 'policy_unstamped'
  | 'policy_mismatch'
  | 'edition_already_released';

const EXCLUDED: ReadonlySet<FamilyAdmissionStatus> = new Set(['not_submitted', 'withdrawn', 'invite_revoked']);

export interface AdmittedParticipant {
  familySlotId: string;
  familyStorageKey: string;
  submissionId: string;
  photoPaths: string[];
  policyDigest: string;
}

export interface GroupBookAdmissionResult {
  state: 'ready' | 'uncertain';
  cohortId: string;
  families: { familySlotId: string; status: FamilyAdmissionStatus }[];
  eligible: AdmittedParticipant[];
}

export interface GroupBookExportSnapshot {
  cohortId: string;
  participants: AdmittedParticipant[];
  digest: string;
}

export type GroupBookPublisher = (snapshot: GroupBookExportSnapshot) => Promise<{ published: true }>;

export type GroupBookAssemblyOutcome =
  | { state: 'published'; snapshot: GroupBookExportSnapshot }
  | { state: 'hold'; reason: 'no_group_book_artifact_producer'; admission: GroupBookAdmissionResult }
  | {
    state: 'refused';
    reason: 'admission_uncertain' | 'no_eligible_participants' | 'participation_changed' | 'publisher_failed';
    admission: GroupBookAdmissionResult;
  };

async function classify(invite: GroupBookInvite, adoptedDigests: Map<string, string> | null): Promise<{
  status: FamilyAdmissionStatus;
  participant?: AdmittedParticipant;
}> {
  let effective: Awaited<ReturnType<typeof loadEffectiveGroupBookSubmission>>;
  try {
    effective = await loadEffectiveGroupBookSubmission(invite);
  } catch {
    return { status: 'unreadable' };
  }
  const revoked = invite.revokedAt !== undefined && Date.parse(invite.revokedAt) <= Date.now();
  if (!effective) return { status: revoked ? 'invite_revoked' : 'not_submitted' };
  if (revoked) return { status: 'invite_revoked_with_submission' };
  if (effective.effectiveStatus === 'withdrawal_requested') return { status: 'withdrawn' };
  if (effective.effectiveStatus !== 'submitted' || effective.effectiveOmitFromProofAndPrint) {
    return { status: 'withdrawal_unverified' };
  }
  if (effective.schemaVersion !== 2 || effective.consent.version !== 'group-book-v2') return { status: 'policy_unstamped' };
  const stamped = (effective.consent as GroupBookPolicyConsent).policy;
  if (!adoptedDigests || adoptedDigests.get(stamped.version) !== stamped.digest) return { status: 'policy_mismatch' };
  return {
    status: 'eligible',
    participant: {
      familySlotId: invite.familySlotId,
      familyStorageKey: familyStorageKey(invite),
      submissionId: effective.id,
      photoPaths: effective.photos.map((photo) => photo.pathname),
      policyDigest: stamped.digest,
    },
  };
}

export async function loadGroupBookAdmission(cohortId: string): Promise<GroupBookAdmissionResult> {
  const policy = groupBookPolicyState();
  const adopted = policy.state === 'adopted'
    ? new Map([...policy.byVersion].map(([version, row]) => [version, row.digest]))
    : null;
  const invites = groupBookInvites()
    .filter((invite) => invite.cohortId === cohortId)
    .sort((a, b) => a.familySlotId.localeCompare(b.familySlotId));
  const families: GroupBookAdmissionResult['families'] = [];
  const eligible: AdmittedParticipant[] = [];
  // A recorded first final release (or delivery), or an unreadable one, means
  // the edition is released or uncertain: no further assembly is admitted.
  const edition = await groupBookEditionState(cohortId);
  // Sequential reads: each family's state is read once per admission pass.
  for (const invite of invites) {
    const result = await classify(invite, adopted);
    const status: FamilyAdmissionStatus = result.status === 'eligible' && edition !== 'open'
      ? (edition === 'released' ? 'edition_already_released' : 'unreadable')
      : result.status;
    families.push({ familySlotId: invite.familySlotId, status });
    if (result.participant && status === 'eligible') eligible.push(result.participant);
  }
  const uncertain = invites.length === 0 || families.some((family) => family.status !== 'eligible' && !EXCLUDED.has(family.status));
  return { state: uncertain ? 'uncertain' : 'ready', cohortId, families, eligible: uncertain ? [] : eligible };
}

function snapshotOf(admission: GroupBookAdmissionResult): GroupBookExportSnapshot {
  const participants = admission.eligible;
  const digest = createHash('sha256').update(JSON.stringify([admission.cohortId, participants]), 'utf8').digest('hex');
  return { cohortId: admission.cohortId, participants, digest };
}

/**
 * Snapshot eligible inputs, then re-read and require the exact same
 * participation immediately before handing the snapshot to a publisher.
 *
 * The recheck narrows but does NOT close the race: the private Blob store has
 * no multi-object transaction or compare-and-set, so a withdrawal landing
 * between the recheck and the publisher's own write is still possible. No
 * group-book artifact producer exists in this codebase, so production callers
 * pass publisher: null and receive an explicit HOLD.
 */
export async function assembleGroupBookExport(args: {
  cohortId: string;
  publisher: GroupBookPublisher | null;
  /** Test seam: runs between snapshot and recheck. */
  afterSnapshot?: () => Promise<void>;
}): Promise<GroupBookAssemblyOutcome> {
  const admission = await loadGroupBookAdmission(args.cohortId);
  if (admission.state !== 'ready') return { state: 'refused', reason: 'admission_uncertain', admission };
  if (admission.eligible.length === 0) return { state: 'refused', reason: 'no_eligible_participants', admission };
  if (!args.publisher) return { state: 'hold', reason: 'no_group_book_artifact_producer', admission };
  const snapshot = snapshotOf(admission);
  await args.afterSnapshot?.();
  const recheck = await loadGroupBookAdmission(args.cohortId);
  if (recheck.state !== 'ready' || snapshotOf(recheck).digest !== snapshot.digest) {
    return { state: 'refused', reason: 'participation_changed', admission: recheck };
  }
  try {
    await args.publisher(snapshot);
  } catch {
    return { state: 'refused', reason: 'publisher_failed', admission: recheck };
  }
  return { state: 'published', snapshot };
}

/** Operator-facing projection: no names, contact details, photo paths or tokens. */
export function adminAdmissionView(admission: GroupBookAdmissionResult) {
  return {
    state: admission.state,
    cohortId: admission.cohortId,
    families: admission.families,
    eligible: admission.eligible.map((participant) => ({
      familySlotId: participant.familySlotId,
      submissionId: participant.submissionId,
      photoCount: participant.photoPaths.length,
    })),
  };
}
