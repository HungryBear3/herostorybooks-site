import { loadClassroomRoster } from './roster.ts';
import { classroomCodesStrict } from './identity-access.ts';
import { put } from '@vercel/blob';
import { randomBytes } from 'node:crypto';

import { groupBookInvites, invitePurpose, type GroupBookCohortPurpose, type GroupBookInvite } from './config.ts';
import { GROUP_BOOK_INTAKE_WRITE_WINDOW_MS } from './limits.ts';
import { discoverCohortFamilies, GROUP_BOOK_OPERATOR_ACTOR, loadGroupBookDeliveryState, loadGroupBookReleaseState } from './retention.ts';
import { parsePilotStamp, readPrivateObject, requireToken, type GroupBookPilotStamp } from './store.ts';

/**
 * PILOT (no-book, test-only) retention. Owner-adopted policy: test-only photos
 * are deleted within seven days after the pilot closes. The anchor is an
 * explicit, durable, operator-recorded `pilotClosedAt` (server clock at
 * recording), entirely separate from the fullbook `deliveredAt` anchor. No
 * upload, token-expiry, delivery or other time is ever inferred as a close.
 *
 * PURPOSE (durable, immutable, create-only, ONE shared path per cohort):
 * `group-book/purposes/<cohortId>.json` is claimed by the FIRST writer:
 *  - a NEW fullbook intake claims `fullbook` before its attempt/photo writes;
 *  - explicitly configured fresh pilot enrollment claims `pilot_test_only`
 *    before creating the enrollment. Legacy intake uses the same gate.
 * The real managed + legacy roster is frozen at actual pilot close.
 * The conflict is decided by the provider's create-only put, never by a
 * check-then-create on different keys. A cohort that already has any family/
 * attempt/photo objects without a marker is historical fullbook: it can never
 * be registered as a pilot. Purpose is never inferred from cohort naming, and a
 * mutable config flip cannot rewrite a durable marker.
 *
 * Deadline semantics: `deadlineAt = pilotClosedAt + 7d` is the latest permitted
 * deletion time, NOT a wait. Cleanup is eligible from
 * `cleanupEligibleAt = pilotClosedAt + intake writer window`. Writes that a
 * provider commits late (after an abort) are owner-attributed and removed by
 * the recurring sweep; nothing here claims an unbounded late network write is
 * prevented by AbortSignal, and provider-side backups are not claimed erased.
 */
export const GROUP_BOOK_PILOT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const GROUP_BOOK_PILOT_MODE = 'test_only' as const;
export const GROUP_BOOK_PILOT_PURPOSE = 'pilot_test_only' as const;
export const GROUP_BOOK_FULLBOOK_PURPOSE = 'fullbook' as const;
const INTAKE_ACTOR = 'intake_first_writer' as const;
const LIFECYCLE_ACTOR = 'fullbook_lifecycle_first_writer' as const;

const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const REGISTRATION_ID_RE = /^gbreg_[A-Za-z0-9_-]{8,64}$/;
const isIso = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isCanonicalIso = (value: unknown): value is string => isIso(value) && new Date(Date.parse(value)).toISOString() === value;
const sameRoster = (a: string[], b: string[]) => a.join('\0') === b.join('\0');
const PUT_OPTS = () => ({ access: 'private' as const, token: requireToken(), addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 0, contentType: 'application/json' });

// ---------------------------------------------------------------------------
// Cohort purpose marker
// ---------------------------------------------------------------------------

export interface GroupBookCohortPurposeRecord {
  schemaVersion: 1;
  kind: 'cohort_purpose';
  cohortId: string;
  purpose: GroupBookCohortPurpose;
  registrationId: string;
  /** Reserved registration roster; close freezes the actual enrollment roster. */
  familySlotIds: string[];
  registeredAt: string;
  recordedVia: typeof GROUP_BOOK_OPERATOR_ACTOR | typeof INTAKE_ACTOR | typeof LIFECYCLE_ACTOR;
  /** Operator-entered attribution (pilot); not a proven identity. */
  recordedBy: string;
  evidence: string;
}

export type GroupBookCohortPurposeState =
  | { state: 'none' }
  | { state: 'registered'; record: GroupBookCohortPurposeRecord }
  | { state: 'unknown' };

export function groupBookCohortPurposePath(cohortId: string): string {
  return `group-book/purposes/${cohortId}.json`;
}

function parsePurpose(value: unknown, cohortId: string): GroupBookCohortPurposeRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.kind !== 'cohort_purpose' || row.cohortId !== cohortId) return null;
  if (typeof row.registrationId !== 'string' || !REGISTRATION_ID_RE.test(row.registrationId)) return null;
  if (!isCanonicalIso(row.registeredAt)) return null;
  if (typeof row.recordedBy !== 'string' || typeof row.evidence !== 'string') return null;
  if (!Array.isArray(row.familySlotIds) || !row.familySlotIds.every((s) => typeof s === 'string' && ID_RE.test(s))) return null;
  const roster = row.familySlotIds as string[];
  if (new Set(roster).size !== roster.length || !sameRoster(roster, [...roster].sort())) return null;
  if (row.purpose === GROUP_BOOK_PILOT_PURPOSE) {
    if ((row.recordedVia !== GROUP_BOOK_OPERATOR_ACTOR && row.recordedVia !== INTAKE_ACTOR)) return null;
  } else if (row.purpose === GROUP_BOOK_FULLBOOK_PURPOSE) {
    if ((row.recordedVia !== INTAKE_ACTOR && row.recordedVia !== LIFECYCLE_ACTOR) || roster.length !== 0) return null;
  } else {
    return null;
  }
  return row as unknown as GroupBookCohortPurposeRecord;
}

export async function loadGroupBookCohortPurpose(cohortId: string): Promise<GroupBookCohortPurposeState> {
  try {
    const read = await readPrivateObject(groupBookCohortPurposePath(cohortId));
    if (read.state === 'absent') return { state: 'none' };
    const record = read.state === 'found' ? parsePurpose(read.value, cohortId) : null;
    return record ? { state: 'registered', record } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

const newRegistrationId = () => `gbreg_${randomBytes(12).toString('base64url')}`;

/** Create-only put; any failure is reconciled by reread by the caller. */
async function putCreateOnly(path: string, record: unknown): Promise<boolean> {
  try {
    await put(path, JSON.stringify(record), PUT_OPTS());
    return true;
  } catch {
    return false;
  }
}

/**
 * Fullbook first-writer claim (intake). Returns the durable purpose the cohort
 * holds after the claim. A registration that won the same create-only path is
 * reported as `pilot`, so the caller refuses before any attempt/photo write.
 */
export async function claimGroupBookFullbookPurpose(cohortId: string, now: number, actor: typeof INTAKE_ACTOR | typeof LIFECYCLE_ACTOR = INTAKE_ACTOR): Promise<GroupBookCohortPurposeState> {
  const existing = await loadGroupBookCohortPurpose(cohortId);
  if (existing.state !== 'none') return existing;
  const record: GroupBookCohortPurposeRecord = {
    schemaVersion: 1, kind: 'cohort_purpose', cohortId, purpose: GROUP_BOOK_FULLBOOK_PURPOSE, registrationId: newRegistrationId(),
    familySlotIds: [], registeredAt: new Date(now).toISOString(), recordedVia: actor, recordedBy: actor, evidence: actor === INTAKE_ACTOR ? 'first_fullbook_intake' : 'first_fullbook_lifecycle_transition',
  };
  if (await putCreateOnly(groupBookCohortPurposePath(cohortId), record)) return { state: 'registered', record };
  const reread = await loadGroupBookCohortPurpose(cohortId);
  return reread.state === 'none' ? { state: 'unknown' } : reread;
}

export type IntakePurposeAdmission =
  | { state: 'fullbook' }
  | { state: 'pilot'; stamp: GroupBookPilotStamp }
  | { state: 'refused'; error: 'pilot_not_registered' | 'purpose_conflict' | 'pilot_roster_mismatch' | 'pilot_closed'; status: 403 | 409 }
  | { state: 'unconfirmed' };

/** All new managed enrollments and legacy writers contend on one immutable cohort key.
 * A pilot may be configured only before ANY historical managed enrollment or
 * media owner exists. Existing unclassified enrollments stay fullbook/unknown.
 */
export async function bindGroupBookCohortPurpose(invite: Pick<GroupBookInvite, 'cohortId' | 'purpose'>, now: number): Promise<GroupBookCohortPurposeState> {
  const declared = invitePurpose(invite);
  let existing = await loadGroupBookCohortPurpose(invite.cohortId);
  if (existing.state !== 'none') return existing;
  if (declared === 'fullbook') return claimGroupBookFullbookPurpose(invite.cohortId, now);
  const [roster, history, release, delivery, close] = await Promise.all([
    loadClassroomRoster(invite.cohortId), discoverCohortFamilies(invite.cohortId),
    loadGroupBookReleaseState(invite.cohortId), loadGroupBookDeliveryState(invite.cohortId), loadGroupBookPilotCloseState(invite.cohortId),
  ]);
  if (roster.state !== 'complete' || history === null || release.state !== 'none' || delivery.state !== 'none' || close.state !== 'none') return {state:'unknown'};
  // Legacy configured slots alone are not historical enrollment. Managed rows are.
  if (history.length || roster.invites.some(i => i.owner || invitePurpose(i) !== 'pilot_test_only')) return {state:'unknown'};
  const record: GroupBookCohortPurposeRecord = {
    schemaVersion:1, kind:'cohort_purpose', cohortId:invite.cohortId, purpose:'pilot_test_only',
    registrationId:newRegistrationId(), familySlotIds:[], registeredAt:new Date(now).toISOString(),
    recordedVia:INTAKE_ACTOR, recordedBy:INTAKE_ACTOR, evidence:'explicit_fresh_pilot_configuration',
  };
  await putCreateOnly(groupBookCohortPurposePath(invite.cohortId), record);
  existing = await loadGroupBookCohortPurpose(invite.cohortId);
  return existing.state === 'none' ? {state:'unknown'} : existing;
}

export async function admitGroupBookIntakePurpose(invite: GroupBookInvite, now: number, claim = true): Promise<IntakePurposeAdmission> {
  const existing = claim ? await bindGroupBookCohortPurpose(invite, now) : await loadGroupBookCohortPurpose(invite.cohortId);
  if (existing.state !== 'registered') return {state:'unconfirmed'};
  if (existing.record.purpose !== invitePurpose(invite)) return {state:'refused',error:'purpose_conflict',status:409};
  const close = await loadGroupBookPilotCloseState(invite.cohortId);
  if (close.state === 'unknown') return {state:'unconfirmed'};
  if (close.state === 'closed') return {state:'refused',error:'pilot_closed',status:409};
  return existing.record.purpose === 'pilot_test_only'
    ? {state:'pilot',stamp:{purpose:'pilot_test_only',registrationId:existing.record.registrationId}}
    : {state:'fullbook'};
}

/** Fullbook lifecycle (release/delivery) gate: a registered pilot is never a fullbook cohort. */
export async function fullbookLifecyclePurposeGate(cohortId: string, now: number): Promise<'ok' | 'pilot' | 'unknown'> {
  // Transition and registration must contend on the SAME create-only marker.
  const purpose = await claimGroupBookFullbookPurpose(cohortId, now, LIFECYCLE_ACTOR);
  if (purpose.state === 'unknown') return 'unknown';
  return purpose.state === 'registered' && purpose.record.purpose === GROUP_BOOK_PILOT_PURPOSE ? 'pilot' : 'ok';
}

// ---------------------------------------------------------------------------
// Pilot registration (operator, create-only)
// ---------------------------------------------------------------------------

export type PilotRegisterOutcome =
  | { outcome: 'recorded' | 'replayed'; record: GroupBookCohortPurposeRecord }
  | { outcome: 'conflict'; record: GroupBookCohortPurposeRecord }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'unconfirmed' };

/**
 * Optional authenticated registration uses the same real lifecycle gate as
 * enrollment. It cannot classify a historical family or arbitrary cohort.
 */
export async function registerGroupBookPilot(args: {
  cohortId: unknown; purpose: unknown; familySlotIds: unknown; recordedBy: unknown; evidence: unknown; now: number;
}): Promise<PilotRegisterOutcome> {
  if (typeof args.cohortId !== 'string' || args.purpose !== 'pilot_test_only') return {outcome:'invalid',error:'invalid_purpose'};
  const config = classroomCodesStrict();
  if (config.state === 'malformed') return {outcome:'unconfirmed'};
  const configured = [...groupBookInvites(), ...(config.state === 'valid' ? config.cohorts : [])].filter(i=>i.cohortId===args.cohortId);
  if (!configured.length || configured.some(i=>invitePurpose(i)!=='pilot_test_only')) return {outcome:'invalid',error:'cohort_not_pilot_purpose'};
  const before = await loadGroupBookCohortPurpose(args.cohortId);
  const binding = await bindGroupBookCohortPurpose(configured[0],args.now);
  if (binding.state !== 'registered') return {outcome:'unconfirmed'};
  return binding.record.purpose === 'pilot_test_only' ? {outcome:before.state === 'none' ? 'recorded' : 'replayed',record:binding.record} : {outcome:'conflict',record:binding.record};
}

// ---------------------------------------------------------------------------
// Pilot close (operator, create-only)
// ---------------------------------------------------------------------------

export interface GroupBookPilotCloseRecord {
  schemaVersion: 1;
  kind: 'pilot_close';
  cohortId: string;
  /** Explicit purpose; never inferred from names. Only `test_only` exists. */
  mode: typeof GROUP_BOOK_PILOT_MODE;
  /** Durable registration this close is bound to. */
  registrationId: string;
  /** Exact registered roster at close (sorted). */
  familySlotIds: string[];
  /** Explicit pilot close anchor (server clock at recording). */
  pilotClosedAt: string;
  /** Compatibility alias; accepted only when equal to pilotClosedAt. */
  closedAt: string;
  recordedAt: string;
  recordedVia: typeof GROUP_BOOK_OPERATOR_ACTOR;
  /** Operator-entered attribution; not a proven identity. */
  recordedBy: string;
  evidence: string;
  retentionDays: 7;
  cleanupEligibleAt: string;
  deadlineAt: string;
}

export type GroupBookPilotCloseState =
  | { state: 'none' }
  | { state: 'closed'; record: GroupBookPilotCloseRecord }
  | { state: 'unknown' };

export function groupBookPilotClosePath(cohortId: string): string {
  return `group-book/pilot-closes/${cohortId}.json`;
}

function parsePilotClose(value: unknown, cohortId: string): GroupBookPilotCloseRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.kind !== 'pilot_close' || row.cohortId !== cohortId) return null;
  if (row.mode !== GROUP_BOOK_PILOT_MODE || row.retentionDays !== GROUP_BOOK_PILOT_RETENTION_DAYS) return null;
  if (row.recordedVia !== GROUP_BOOK_OPERATOR_ACTOR) return null;
  if (typeof row.registrationId !== 'string' || !REGISTRATION_ID_RE.test(row.registrationId)) return null;
  if (!Array.isArray(row.familySlotIds) || row.familySlotIds.length === 0 || !row.familySlotIds.every((s) => typeof s === 'string' && ID_RE.test(s))) return null;
  if (new Set(row.familySlotIds).size !== row.familySlotIds.length || !sameRoster(row.familySlotIds as string[], [...row.familySlotIds].sort() as string[])) return null;
  if (!isCanonicalIso(row.pilotClosedAt) || !isIso(row.recordedAt) || !isIso(row.cleanupEligibleAt) || !isIso(row.deadlineAt)) return null;
  if (typeof row.recordedBy !== 'string' || typeof row.evidence !== 'string') return null;
  // Strict canonical server timestamps only: close time is its recording time.
  const closed = Date.parse(row.pilotClosedAt);
  if (row.closedAt !== undefined && row.closedAt !== row.pilotClosedAt) return null;
  if (closed !== Date.parse(row.recordedAt)) return null;
  if (Date.parse(row.cleanupEligibleAt) !== closed + GROUP_BOOK_INTAKE_WRITE_WINDOW_MS) return null;
  if (Date.parse(row.deadlineAt) !== closed + GROUP_BOOK_PILOT_RETENTION_DAYS * DAY_MS) return null;
  return { ...(row as unknown as GroupBookPilotCloseRecord), closedAt: row.pilotClosedAt };
}

export async function loadGroupBookPilotCloseState(cohortId: string): Promise<GroupBookPilotCloseState> {
  try {
    const read = await readPrivateObject(groupBookPilotClosePath(cohortId));
    if (read.state === 'absent') return { state: 'none' };
    const record = read.state === 'found' ? parsePilotClose(read.value, cohortId) : null;
    return record ? { state: 'closed', record } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

export type PilotCloseOutcome =
  | { outcome: 'recorded' | 'replayed'; record: GroupBookPilotCloseRecord }
  | { outcome: 'conflict'; record: GroupBookPilotCloseRecord }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'unconfirmed' };

const sameClose = (a: GroupBookPilotCloseRecord, b: Pick<GroupBookPilotCloseRecord, 'recordedBy' | 'evidence' | 'familySlotIds'>) =>
  a.recordedBy === b.recordedBy && a.evidence === b.evidence && sameRoster(a.familySlotIds, b.familySlotIds);

/**
 * Operator-entered, immutable pilot-close transition. Requires a durable pilot
 * registration (not the mutable config, so replay works after invitations are
 * removed) whose roster exactly matches, explicit `test_only` mode, and no
 * fullbook lifecycle record: a real-family cohort is never reclassified.
 * Create-only; identical replay returns the stored record, a different one is
 * a conflict; an unacknowledged write is reconciled by reread, never rewritten.
 */
export async function recordGroupBookPilotClose(args: {
  cohortId: unknown;
  mode: unknown;
  familySlotIds: unknown;
  recordedBy: unknown;
  evidence: unknown;
  now: number;
}): Promise<PilotCloseOutcome> {
  const { cohortId } = args;
  if (typeof cohortId !== 'string' || !ID_RE.test(cohortId)) return { outcome: 'invalid', error: 'unknown_cohort' };
  if (args.mode !== GROUP_BOOK_PILOT_MODE) return { outcome: 'invalid', error: 'invalid_mode' };
  const priorClose = await loadGroupBookPilotCloseState(cohortId);
  if (priorClose.state === 'unknown') return {outcome:'unconfirmed'};
  const current = priorClose.state === 'closed' ? null : await loadClassroomRoster(cohortId);
  if (current && current.state !== 'complete') return {outcome:'unconfirmed'};
  const roster = priorClose.state === 'closed' ? priorClose.record.familySlotIds : current!.state === 'complete' ? current!.invites.map(i=>i.familySlotId).sort() : [];
  if (!roster.length) return {outcome:'invalid',error:'unknown_cohort'};
  if (args.familySlotIds !== undefined && (!Array.isArray(args.familySlotIds) || !args.familySlotIds.every(s=>typeof s==='string') || !sameRoster([...args.familySlotIds].sort(),roster))) return {outcome:'invalid',error:'roster_mismatch'};
  const recordedBy = typeof args.recordedBy === 'string' ? args.recordedBy.trim() : '';
  const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
  if (!recordedBy || recordedBy.length > 100) return { outcome: 'invalid', error: 'invalid_recorded_by' };
  if (!evidence || evidence.length > 500) return { outcome: 'invalid', error: 'invalid_evidence' };
  const registration = await loadGroupBookCohortPurpose(cohortId);
  if (registration.state === 'unknown') return { outcome: 'unconfirmed' };
  if (registration.state === 'none') {
    const configured = groupBookInvites().some((invite) => invite.cohortId === cohortId);
    return { outcome: 'invalid', error: configured ? 'pilot_not_registered' : 'unknown_cohort' };
  }
  if (registration.record.purpose !== GROUP_BOOK_PILOT_PURPOSE) return { outcome: 'invalid', error: 'fullbook_cohort_not_pilot' };
  const [release, delivery] = await Promise.all([loadGroupBookReleaseState(cohortId), loadGroupBookDeliveryState(cohortId)]);
  if (release.state === 'unknown' || delivery.state === 'unknown') return { outcome: 'unconfirmed' };
  if (release.state === 'recorded' || delivery.state === 'recorded') return { outcome: 'invalid', error: 'fullbook_cohort_not_pilot' };
  const wanted = { recordedBy, evidence, familySlotIds: roster };
  const existing = await loadGroupBookPilotCloseState(cohortId);
  if (existing.state === 'unknown') return { outcome: 'unconfirmed' };
  if (existing.state === 'closed') {
    return sameClose(existing.record, wanted) ? { outcome: 'replayed', record: existing.record } : { outcome: 'conflict', record: existing.record };
  }
  const closedAt = new Date(args.now).toISOString();
  const record: GroupBookPilotCloseRecord = {
    schemaVersion: 1,
    kind: 'pilot_close',
    cohortId,
    mode: GROUP_BOOK_PILOT_MODE,
    registrationId: registration.record.registrationId,
    familySlotIds: roster,
    pilotClosedAt: closedAt,
    closedAt,
    recordedAt: closedAt,
    recordedVia: GROUP_BOOK_OPERATOR_ACTOR,
    recordedBy,
    evidence,
    retentionDays: 7,
    cleanupEligibleAt: new Date(args.now + GROUP_BOOK_INTAKE_WRITE_WINDOW_MS).toISOString(),
    deadlineAt: new Date(args.now + GROUP_BOOK_PILOT_RETENTION_DAYS * DAY_MS).toISOString(),
  };
  // Exactly one put; failure before commit and lost response after commit are
  // both reconciled by reread, never by a retry.
  if (await putCreateOnly(groupBookPilotClosePath(cohortId), record)) return { outcome: 'recorded', record };
  const reread = await loadGroupBookPilotCloseState(cohortId);
  if (reread.state !== 'closed') return { outcome: 'unconfirmed' };
  return sameClose(reread.record, wanted) ? { outcome: 'recorded', record: reread.record } : { outcome: 'conflict', record: reread.record };
}

/** Pilot availability for reads/admission: closed from pilotClosedAt; unknown fails closed. */
export async function groupBookPilotState(cohortId: string, now: number): Promise<'open' | 'closed' | 'unknown'> {
  const state = await loadGroupBookPilotCloseState(cohortId);
  if (state.state === 'unknown') return 'unknown';
  if (state.state === 'none') return 'open';
  return 'closed'; // A persisted close cannot reopen on clock rollback.
}

/** Stamp check for cleanup: a stored pilot stamp must match the registration exactly. */
export function pilotStampMatches(value: unknown, registrationId: string): boolean {
  const stamp = parsePilotStamp(value);
  return stamp !== null && stamp.registrationId === registrationId;
}
