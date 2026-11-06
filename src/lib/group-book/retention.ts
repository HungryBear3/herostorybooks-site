import { del, list, put } from '@vercel/blob';
import { fullbookLifecyclePurposeGate, groupBookPilotState, loadGroupBookCohortPurpose, loadGroupBookPilotCloseState, pilotStampMatches } from './pilot-retention.ts';
import { randomUUID } from 'node:crypto';

import { familyStorageKey, groupBookInvitesStrict, type GroupBookInvite } from './config.ts';
import { classroomCodesStrict } from './identity-access.ts';
import {
  findGroupBookSubmission,
  parseSubmission,
  probePrivateObject,
  readPrivateObject,
  requireToken,
  type GroupBookFamilyIdentity,
} from './store.ts';

/**
 * Adopted policy hsb-classroom-submission-policy-2026-10-19-v1: source photos
 * are deleted 90 days after the authoritatively recorded FINAL DELIVERY of the
 * cohort's book. The anchor is only an operator-recorded delivery record; no
 * upload, preview, payment or print timestamp is ever used, and with no
 * recorded delivery there is no due date and nothing is deleted.
 *
 * Scope is exactly the family-owned canonical photo objects
 * `group-book/photos/<familyKey>/gbp_*.jpg` (the only stored source-photo form;
 * originals are never stored). Submission summaries, consent, withdrawal
 * markers, attempt records and delivery/receipt records are preserved.
 * Provider-side backups are outside this code and are not claimed erased.
 */
export const GROUP_BOOK_SOURCE_PHOTO_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Actor binding for operator transitions: the server can only prove that the
 * shared admin credential was presented. Operator-entered names are kept as
 * unverified attribution, never as proven personal identity.
 */
export const GROUP_BOOK_OPERATOR_ACTOR = 'shared_admin_session' as const;

export interface GroupBookDeliveryRecord {
  schemaVersion: 1;
  cohortId: string;
  deliveredAt: string;
  recordedAt: string;
  recordedVia: typeof GROUP_BOOK_OPERATOR_ACTOR;
  /** Operator-entered attribution; not a proven identity. */
  recordedBy: string;
  evidence: string;
  retentionDays: 90;
  dueAt: string;
}

export type GroupBookDeliveryState =
  | { state: 'none' }
  | { state: 'recorded'; record: GroupBookDeliveryRecord }
  | { state: 'unknown' };

export function groupBookDeliveryPath(cohortId: string): string {
  return `group-book/deliveries/${cohortId}.json`;
}

function receiptPath(cohortId: string, key: string): string {
  return `group-book/retention/${cohortId}/${key}.json`;
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseDelivery(value: unknown, cohortId: string): GroupBookDeliveryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.cohortId !== cohortId || row.retentionDays !== 90) return null;
  if (row.recordedVia !== GROUP_BOOK_OPERATOR_ACTOR) return null;
  if (!isIso(row.deliveredAt) || !isIso(row.recordedAt) || !isIso(row.dueAt)) return null;
  if (typeof row.recordedBy !== 'string' || typeof row.evidence !== 'string') return null;
  // Server-authoritative times only (DESIGN I1): a record whose delivery time
  // is not its server recording time is not trusted as an anchor.
  if (Date.parse(row.deliveredAt) !== Date.parse(row.recordedAt)) return null;
  if (Date.parse(row.dueAt) !== Date.parse(row.deliveredAt) + 90 * DAY_MS) return null;
  return row as unknown as GroupBookDeliveryRecord;
}

export async function loadGroupBookDeliveryState(cohortId: string): Promise<GroupBookDeliveryState> {
  try {
    const read = await readPrivateObject(groupBookDeliveryPath(cohortId));
    if (read.state === 'absent') return { state: 'none' };
    const record = read.state === 'found' ? parseDelivery(read.value, cohortId) : null;
    return record ? { state: 'recorded', record } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

export type DeliveryOutcome =
  | { outcome: 'recorded' | 'replayed'; record: GroupBookDeliveryRecord }
  | { outcome: 'conflict'; record: GroupBookDeliveryRecord }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'release_not_recorded' }
  | { outcome: 'unconfirmed' };

const sameDelivery = (a: GroupBookDeliveryRecord, b: Pick<GroupBookDeliveryRecord, 'recordedBy' | 'evidence'>) =>
  a.recordedBy === b.recordedBy && a.evidence === b.evidence;

/**
 * Lifecycle times are the server clock at recording (DESIGN I1). A caller-
 * supplied time is refused, never silently replaced, so no operator can
 * believe a backdated (or any other) time was honored.
 */
const CALLER_TIME_FIELDS = ['releasedAt', 'deliveredAt', 'recordedAt', 'dueAt', 'closedAt', 'pilotClosedAt', 'deadlineAt', 'cleanupEligibleAt', 'registeredAt'] as const;
export function hasCallerLifecycleTime(input: Record<string, unknown>): boolean {
  return CALLER_TIME_FIELDS.some((field) => input[field] !== undefined);
}

/**
 * Operator-entered, immutable final-delivery transition for one cohort.
 * Create-only; an identical replay returns the stored record, a different one
 * is a conflict. An unacknowledged write is reconciled by reread, never by a
 * second write.
 */
export async function recordGroupBookFinalDelivery(args: {
  cohortId: unknown;
  recordedBy: unknown;
  evidence: unknown;
  now: number;
}): Promise<DeliveryOutcome> {
  const { cohortId } = args;
  // Lifecycle recognition is independent of selector expiry/auth activation:
  // families still need the existing retention anchor after intake closes.
  // The same strict registry policy roster and trusted-input use: malformed,
  // non-array, duplicate, owner-bearing or legacy-overlapping configuration
  // establishes no cohort at all, a valid legacy cohort included. Expiry and
  // revocation are deliberately not consulted: the retention anchor outlives
  // intake. Absent configuration contributes nothing.
  const legacyConfig = groupBookInvitesStrict();
  const selectorConfig = classroomCodesStrict();
  if (legacyConfig.state === 'malformed' || selectorConfig.state === 'malformed') {
    return { outcome: 'invalid', error: 'unknown_cohort' };
  }
  const legacy: GroupBookInvite[] = legacyConfig.state === 'valid' ? legacyConfig.invites : [];
  const classroomCohorts = selectorConfig.state === 'valid' ? selectorConfig.cohorts : [];
  if (typeof cohortId !== 'string' || ![...legacy, ...classroomCohorts].some((invite) => invite.cohortId === cohortId)) {
    return { outcome: 'invalid', error: 'unknown_cohort' };
  }
  const recordedBy = typeof args.recordedBy === 'string' ? args.recordedBy.trim() : '';
  const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
  if (!recordedBy || recordedBy.length > 100) return { outcome: 'invalid', error: 'invalid_recorded_by' };
  if (!evidence || evidence.length > 500) return { outcome: 'invalid', error: 'invalid_evidence' };
  const deliveredMs = args.now;
  const wanted = { recordedBy, evidence };
  // Delivery follows the first final release; it is never the cutoff itself.
  const released = await loadGroupBookReleaseState(cohortId);
  if (released.state === 'unknown') return { outcome: 'unconfirmed' };
  if (released.state === 'none') return { outcome: 'release_not_recorded' };
  if (deliveredMs < Date.parse(released.record.releasedAt)) return { outcome: 'invalid', error: 'delivered_before_release' };

  const existing = await loadGroupBookDeliveryState(cohortId);
  if (existing.state === 'unknown') return { outcome: 'unconfirmed' };
  if (existing.state === 'recorded') {
    return sameDelivery(existing.record, wanted)
      ? { outcome: 'replayed', record: existing.record }
      : { outcome: 'conflict', record: existing.record };
  }
  const purposeGate = await fullbookLifecyclePurposeGate(cohortId, args.now);
  if (purposeGate === 'unknown') return { outcome: 'unconfirmed' };
  if (purposeGate === 'pilot') return { outcome: 'invalid', error: 'pilot_cohort_not_fullbook' };
  const record: GroupBookDeliveryRecord = {
    schemaVersion: 1,
    cohortId,
    ...wanted,
    deliveredAt: new Date(deliveredMs).toISOString(),
    recordedAt: new Date(deliveredMs).toISOString(),
    recordedVia: GROUP_BOOK_OPERATOR_ACTOR,
    retentionDays: 90,
    dueAt: new Date(deliveredMs + GROUP_BOOK_SOURCE_PHOTO_RETENTION_DAYS * DAY_MS).toISOString(),
  };
  try {
    await put(groupBookDeliveryPath(cohortId), JSON.stringify(record), {
      access: 'private',
      token: requireToken(),
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 0,
      contentType: 'application/json',
    });
    return { outcome: 'recorded', record };
  } catch {
    const reread = await loadGroupBookDeliveryState(cohortId);
    if (reread.state !== 'recorded') return { outcome: 'unconfirmed' };
    return sameDelivery(reread.record, wanted)
      ? { outcome: 'recorded', record: reread.record }
      : { outcome: 'conflict', record: reread.record };
  }
}

// ---------------------------------------------------------------------------
// First final release (printing OR distribution, whichever comes first).
// This, not delivery, is the adopted withdrawal cutoff. It is an operator-
// recorded out-of-band fact: no upstream release path exists in this code, and
// recording it does not print, distribute or publish anything. The record is
// create-only, so the first release wins and any other is a conflict.
// ---------------------------------------------------------------------------

export type GroupBookReleaseChannel = 'printing' | 'distribution';

export interface GroupBookReleaseRecord {
  schemaVersion: 1;
  cohortId: string;
  channel: GroupBookReleaseChannel;
  releasedAt: string;
  recordedAt: string;
  recordedVia: typeof GROUP_BOOK_OPERATOR_ACTOR;
  attributionUnverified: string;
  evidence: string;
}

export type GroupBookReleaseState =
  | { state: 'none' }
  | { state: 'recorded'; record: GroupBookReleaseRecord }
  | { state: 'unknown' };

export function groupBookReleasePath(cohortId: string): string {
  return `group-book/releases/${cohortId}.json`;
}

function parseRelease(value: unknown, cohortId: string): GroupBookReleaseRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || row.cohortId !== cohortId || row.recordedVia !== GROUP_BOOK_OPERATOR_ACTOR) return null;
  if (row.channel !== 'printing' && row.channel !== 'distribution') return null;
  if (!isIso(row.releasedAt) || !isIso(row.recordedAt)) return null;
  if (Date.parse(row.releasedAt) !== Date.parse(row.recordedAt)) return null; // server time only (I1)
  if (typeof row.attributionUnverified !== 'string' || typeof row.evidence !== 'string') return null;
  return row as unknown as GroupBookReleaseRecord;
}

export async function loadGroupBookReleaseState(cohortId: string): Promise<GroupBookReleaseState> {
  try {
    const read = await readPrivateObject(groupBookReleasePath(cohortId));
    if (read.state === 'absent') return { state: 'none' };
    const record = read.state === 'found' ? parseRelease(read.value, cohortId) : null;
    return record ? { state: 'recorded', record } : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

/** Edition state for new intake / withdrawal: released if a release OR delivery exists; unknown fails closed. */
export async function groupBookEditionState(cohortId: string): Promise<'open' | 'released' | 'unknown'> {
  const pilot = await groupBookPilotState(cohortId, Date.now());
  if (pilot !== 'open') return pilot === 'closed' ? 'released' : 'unknown';
  const [release, delivery] = await Promise.all([loadGroupBookReleaseState(cohortId), loadGroupBookDeliveryState(cohortId)]);
  if (release.state === 'unknown' || delivery.state === 'unknown') return 'unknown';
  return release.state === 'recorded' || delivery.state === 'recorded' ? 'released' : 'open';
}

export type ReleaseOutcome =
  | { outcome: 'recorded' | 'replayed' | 'conflict'; record: GroupBookReleaseRecord }
  | { outcome: 'invalid'; error: string }
  | { outcome: 'unconfirmed' };

export async function recordGroupBookFinalRelease(args: {
  cohortId: unknown;
  channel: unknown;
  attribution: unknown;
  evidence: unknown;
  now: number;
}): Promise<ReleaseOutcome> {
  const { cohortId } = args;
  if (typeof cohortId !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(cohortId)) return { outcome: 'invalid', error: 'invalid_cohort' };
  if (args.channel !== 'printing' && args.channel !== 'distribution') return { outcome: 'invalid', error: 'invalid_channel' };
  const attribution = typeof args.attribution === 'string' ? args.attribution.trim() : '';
  const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : '';
  if (!attribution || attribution.length > 100) return { outcome: 'invalid', error: 'invalid_attribution' };
  if (!evidence || evidence.length > 500) return { outcome: 'invalid', error: 'invalid_evidence' };
  const wanted = {
    channel: args.channel as GroupBookReleaseChannel,
    attributionUnverified: attribution,
    evidence,
  };
  const same = (r: GroupBookReleaseRecord) => r.channel === wanted.channel &&
    r.attributionUnverified === wanted.attributionUnverified && r.evidence === wanted.evidence;
  const purposeGate = await fullbookLifecyclePurposeGate(cohortId, args.now);
  if (purposeGate === 'unknown') return { outcome: 'unconfirmed' };
  if (purposeGate === 'pilot') return { outcome: 'invalid', error: 'pilot_cohort_not_fullbook' };
  const existing = await loadGroupBookReleaseState(cohortId);
  if (existing.state === 'unknown') return { outcome: 'unconfirmed' };
  if (existing.state === 'recorded') return { outcome: same(existing.record) ? 'replayed' : 'conflict', record: existing.record };
  const record: GroupBookReleaseRecord = {
    schemaVersion: 1, cohortId, ...wanted,
    releasedAt: new Date(args.now).toISOString(), recordedAt: new Date(args.now).toISOString(), recordedVia: GROUP_BOOK_OPERATOR_ACTOR,
  };
  try {
    await put(groupBookReleasePath(cohortId), JSON.stringify(record), {
      access: 'private', token: requireToken(), addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 0, contentType: 'application/json',
    });
    return { outcome: 'recorded', record };
  } catch {
    const reread = await loadGroupBookReleaseState(cohortId);
    if (reread.state !== 'recorded') return { outcome: 'unconfirmed' };
    return { outcome: same(reread.record) ? 'recorded' : 'conflict', record: reread.record };
  }
}

export type PhotoAvailability =
  | { state: 'no_delivery_recorded' }
  | { state: 'retained'; dueAt: string }
  | { state: 'expired'; dueAt: string }
  | { state: 'unknown' };

export async function groupBookPhotoAvailability(cohortId: string, now: number): Promise<PhotoAvailability> {
  const pilot = await loadGroupBookPilotCloseState(cohortId);
  if (pilot.state === 'unknown') return { state: 'unknown' };
  if (pilot.state === 'closed') return { state: 'expired', dueAt: pilot.record.deadlineAt };
  const delivery = await loadGroupBookDeliveryState(cohortId);
  if (delivery.state === 'unknown') return { state: 'unknown' };
  if (delivery.state === 'none') return { state: 'no_delivery_recorded' };
  const due = Date.parse(delivery.record.dueAt);
  return now >= due ? { state: 'expired', dueAt: delivery.record.dueAt } : { state: 'retained', dueAt: delivery.record.dueAt };
}

/**
 * The only source-photo read accessor. Fails closed at the due time even if
 * deletion has not run yet, and on any uncertainty about the anchor.
 */
export async function openGroupBookSourcePhoto(
  invite: GroupBookInvite,
  assetId: string,
  now: number,
): Promise<{ state: 'ok'; bytes: Buffer; mime: string } | { state: 'expired' | 'unknown' | 'not_found' }> {
  const availability = await groupBookPhotoAvailability(invite.cohortId, now);
  if (availability.state === 'unknown') return { state: 'unknown' };
  if (availability.state === 'expired') return { state: 'expired' };
  let record: Awaited<ReturnType<typeof findGroupBookSubmission>>;
  try {
    record = await findGroupBookSubmission(invite);
  } catch {
    return { state: 'unknown' };
  }
  const photo = record?.photos.find((row) => row.assetId === assetId);
  if (!photo) return { state: 'not_found' };
  const probe = await probePrivateObject(photo.pathname);
  if (probe.state === 'present') return { state: 'ok', bytes: probe.bytes, mime: photo.mime };
  return { state: probe.state === 'absent' ? 'not_found' : 'unknown' };
}

export type FamilyCleanupStatus = 'complete' | 'already_complete' | 'partial' | 'unverified';

export interface CleanupResult {
  outcome: 'no_delivery_recorded' | 'delivery_unknown' | 'not_due' | 'scope_unknown' | 'complete' | 'partial';
  dueAt?: string;
  families: { familySlotId: string; status: FamilyCleanupStatus; deleted: number; remaining: number }[];
}

/** Hard bound on listing; exceeding it is incomplete scope, never "done". */
export const GROUP_BOOK_LIST_MAX_PAGES = 50;

class IncompleteScopeError extends Error {}

/**
 * Complete listing of one prefix, or a throw. Each page is validated at
 * runtime: object page, array of row objects with in-prefix string pathnames,
 * at most pageLimit rows, boolean hasMore, and a nonempty never-seen
 * continuation cursor; page and total-item bounds make it finite.
 */
async function listPaths(prefix: string): Promise<string[]> {
  const pageLimit = 1000;
  const out: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= GROUP_BOOK_LIST_MAX_PAGES) throw new IncompleteScopeError('list_page_bound');
    const result: unknown = await list({ prefix, token: requireToken(), cursor, limit: pageLimit });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new IncompleteScopeError('list_page_malformed');
    const { blobs, hasMore, cursor: next } = result as { blobs?: unknown; hasMore?: unknown; cursor?: unknown };
    if (!Array.isArray(blobs) || blobs.length > pageLimit) throw new IncompleteScopeError('list_blobs_malformed');
    for (const row of blobs) {
      const pathname = row && typeof row === 'object' && !Array.isArray(row) ? (row as { pathname?: unknown }).pathname : undefined;
      if (typeof pathname !== 'string' || !pathname.startsWith(prefix)) throw new IncompleteScopeError('list_row_malformed');
      out.push(pathname);
    }
    if (out.length > GROUP_BOOK_LIST_MAX_PAGES * pageLimit) throw new IncompleteScopeError('list_item_bound');
    if (typeof hasMore !== 'boolean') throw new IncompleteScopeError('list_has_more_malformed');
    if (!hasMore) return out;
    if (typeof next !== 'string' || next === '' || seenCursors.has(next)) throw new IncompleteScopeError('list_cursor_invalid');
    seenCursors.add(next);
    cursor = next;
  }
}

const KEY_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * Durable cleanup roster for a cohort, from private storage only (never the
 * mutable invite config). Every family record, attempt (owner) record and
 * photo prefix in the store must resolve to an exact cohort/family identity
 * whose sha256 equals its storage key. Anything unreadable, malformed,
 * unowned or beyond the listing bound makes the scope unknown.
 */
export async function discoverCohortFamilies(cohortId: string): Promise<GroupBookFamilyIdentity[] | null> {
  try {
    const owners = new Map<string, GroupBookFamilyIdentity>();
    const claim = (key: string, identity: GroupBookFamilyIdentity): boolean => {
      if (!ID_RE.test(identity.cohortId) || !ID_RE.test(identity.familySlotId)) return false;
      if (familyStorageKey(identity) !== key) return false;
      const prior = owners.get(key);
      if (prior && (prior.cohortId !== identity.cohortId || prior.familySlotId !== identity.familySlotId)) return false;
      owners.set(key, identity);
      return true;
    };
    for (const path of await listPaths('group-book/families/')) {
      const key = path.match(/^group-book\/families\/([0-9a-f]{64})\.json$/)?.[1];
      if (!key) return null;
      const read = await readPrivateObject(path);
      if (read.state !== 'found') return null;
      const cohort = (read.value as { cohort?: { id?: unknown; familySlotId?: unknown } })?.cohort;
      if (typeof cohort?.id !== 'string' || typeof cohort.familySlotId !== 'string') return null;
      const identity = { cohortId: cohort.id, familySlotId: cohort.familySlotId };
      if (!parseSubmission(read.value, identity) || !claim(key, identity)) return null;
    }
    for (const path of await listPaths('group-book/attempts/')) {
      const key = path.match(/^group-book\/attempts\/([0-9a-f]{64})\/gba_[A-Za-z0-9_-]+\.json$/)?.[1];
      if (!key) return null;
      const read = await readPrivateObject(path);
      if (read.state !== 'found') return null;
      const row = read.value as Record<string, unknown> | null;
      if (!row || row.schemaVersion !== 1 || row.familyStorageKey !== key) return null;
      if (typeof row.cohortId === 'string' && typeof row.familySlotId === 'string') {
        if (!claim(key, { cohortId: row.cohortId, familySlotId: row.familySlotId })) return null;
      } else if (!owners.has(key)) {
        return null; // legacy attempt without identity and no owning record
      }
    }
    for (const path of await listPaths('group-book/photos/')) {
      const key = path.split('/')[2];
      if (!key || !KEY_RE.test(key) || !owners.has(key)) return null; // unowned photo
    }
    return [...owners.values()]
      .filter((identity) => identity.cohortId === cohortId)
      .sort((a, b) => a.familySlotId.localeCompare(b.familySlotId));
  } catch {
    return null;
  }
}

/** Canonical source-photo paths declared by validated family/attempt owners. */
async function familyPhotoCandidates(invite: GroupBookFamilyIdentity, pilot?: PilotAnchorBinding): Promise<string[] | null> {
  const key = familyStorageKey(invite);
  const canonical = new RegExp(`^group-book/photos/${key}/gbp_[A-Za-z0-9_-]+\\.jpg$`);
  const paths = new Set<string>();
  try {
    const record = await findGroupBookSubmission(invite);
    if (record && pilot && !pilotStampMatches(record.pilot, pilot.registrationId)) return null;
    for (const photo of record?.photos ?? []) paths.add(photo.pathname);
    const declared = new Set<string>();
    for (const attemptPath of await listPaths(`group-book/attempts/${key}/`)) {
      const read = await readPrivateObject(attemptPath);
      if (read.state === 'unreadable') return null;
      const value = read.state === 'found' ? (read.value as Record<string, unknown> | null) : null;
      if (!value || value.schemaVersion !== 1 || value.familyStorageKey !== key || !Array.isArray(value.photoPaths) || typeof value.attemptId !== 'string' || !/^gba_[A-Za-z0-9_-]+$/.test(value.attemptId) || attemptPath !== `group-book/attempts/${key}/${value.attemptId}.json`) return null;
      if (!pilot && ((value.cohortId !== undefined && value.cohortId !== invite.cohortId) || (value.familySlotId !== undefined && value.familySlotId !== invite.familySlotId) || (!record && (value.cohortId !== invite.cohortId || value.familySlotId !== invite.familySlotId)))) return null;
      if (pilot && (value.schemaVersion !== 1 || value.cohortId !== invite.cohortId || value.familySlotId !== invite.familySlotId || typeof value.attemptId !== 'string' || !/^gba_[A-Za-z0-9_-]+$/.test(value.attemptId) || attemptPath !== `group-book/attempts/${key}/${value.attemptId}.json` || !pilotStampMatches({ purpose: value.purpose, registrationId: value.registrationId }, pilot.registrationId) || !value.photoPaths.every((p) => typeof p === 'string' && canonical.test(p)))) return null;
      for (const path of value.photoPaths) if (typeof path === 'string') { paths.add(path); declared.add(path); }
    }
    if (pilot && (record?.photos ?? []).some((photo) => !declared.has(photo.pathname))) return null;
  } catch {
    return null;
  }
  // Foreign, look-alike, nested or non-canonical paths are never candidates.
  return [...paths].filter((path) => canonical.test(path)).sort();
}

export interface PilotAnchorBinding { registrationId: string }
/** Cleanup anchor: fullbook delivery (dueAt = deliveredAt + 90d) or pilot close (dueAt = deadlineAt = pilotClosedAt + 7d, bound to its registration/roster). */
export type CleanupAnchor = Pick<GroupBookDeliveryRecord, 'cohortId' | 'dueAt'> & { pilot?: PilotAnchorBinding };

/**
 * Pilot anchor for cleanup: eligible from cleanupEligibleAt (close + writer
 * window); `dueAt` carries the 7-day deadline for receipts/reporting. The
 * close must be bound to the durable pilot registration. Its roster remains
 * an audit snapshot; matching stamped canonical ownership governs cleanup.
 */
async function loadPilotAnchor(cohortId: string): Promise<{ state: 'none' } | { state: 'unknown' } | { state: 'closed'; eligibleAt: number; anchor: CleanupAnchor }> {
  const pilot = await loadGroupBookPilotCloseState(cohortId);
  if (pilot.state !== 'closed') return pilot;
  const purpose = await loadGroupBookCohortPurpose(cohortId);
  if (purpose.state !== 'registered' || purpose.record.purpose !== 'pilot_test_only') return { state: 'unknown' };
  if (purpose.record.registrationId !== pilot.record.registrationId) return { state: 'unknown' };
  return {
    state: 'closed',
    eligibleAt: Date.parse(pilot.record.cleanupEligibleAt),
    anchor: { cohortId, dueAt: pilot.record.deadlineAt, pilot: { registrationId: pilot.record.registrationId } },
  };
}

async function cleanupFamily(invite: GroupBookFamilyIdentity, record: CleanupAnchor, now: number, deleteAllowed = true) {
  const key = familyStorageKey(invite);
  const base = { familySlotId: invite.familySlotId, deleted: 0, remaining: 0 };
  // Close's roster is an audit snapshot, not exclusion authority: enrollment
  // may finish while close is awaiting its create-only put. Exact canonical
  // ownership and matching immutable registration stamps below govern deletion.
  const candidates = await familyPhotoCandidates(invite, record.pilot);
  if (!candidates) return { ...base, status: 'unverified' as const };
  let unsettled = false;
  if (record.pilot) {
    try {
      for (const path of await listPaths(`group-book/attempts/${key}/`)) {
        const attemptId = path.match(/\/(gba_[A-Za-z0-9_-]+)\.json$/)?.[1];
        if (!attemptId) { unsettled = true; continue; }
        const read = await readPrivateObject(`group-book/attempt-settled/${key}/${attemptId}.json`);
        const row = read.state === 'found' ? read.value as Record<string, unknown> : null;
        if (!row || row.schemaVersion !== 1 || row.attemptId !== attemptId || row.familyStorageKey !== key || !isIso(row.settledAt)) unsettled = true;
      }
    } catch { unsettled = true; }
  }
  // PILOT exact-family enumeration: every object under this family's own photo
  // prefix that is not a stamped-owner candidate (undeclared look-alike,
  // malformed or non-canonical pathname) is UNKNOWN. It is never deleted, and
  // while any such object is present the family is truthfully partial, never
  // complete, so retained bytes surface as attention instead of a false green.
  // Fullbook also requires an inventory declaration. Noncanonical fullbook
  // objects remain outside its historical source-photo scope.
  let retainedUnknown = 0;
  try {
    const known = new Set(candidates);
    const canonical = new RegExp(`^group-book/photos/${key}/gbp_[A-Za-z0-9_-]+\\.jpg$`);
    const strangers = (await listPaths(`group-book/photos/${key}/`)).filter((path) => !known.has(path) && (record.pilot || canonical.test(path)));
    const probes = await Promise.all(strangers.map((path) => probePrivateObject(path)));
    if (probes.some((probe) => probe.state === 'unknown')) return { ...base, remaining: probes.length, status: 'unverified' as const };
    retainedUnknown = probes.filter((probe) => probe.state === 'present').length;
  } catch {
    return { ...base, status: 'unverified' as const };
  }
  const before = await Promise.all(candidates.map(async (path) => ({ path, probe: await probePrivateObject(path) })));
  const toDelete = before.filter((row) => row.probe.state !== 'absent').map((row) => row.path);
  // Verification outside the action budget cannot race a late commit into an
  // unaccounted deletion. The next scheduled pass will allocate its action.
  if (toDelete.length && !deleteAllowed) return { ...base, remaining: toDelete.length + retainedUnknown, status: 'unverified' as const };
  const priorReceipt = await probePrivateObject(receiptPath(record.cohortId, key));
  if (toDelete.length === 0 && retainedUnknown === 0 && !unsettled && priorReceipt.state === 'present') return { ...base, status: 'already_complete' as const };
  if (toDelete.length > 0) {
    try {
      await del(toDelete, { token: requireToken() });
    } catch (err) {
      // Partial or ambiguous: the reread below decides, never this error.
      console.error('[group-book/retention] delete call failed; verifying by reread:', err instanceof Error ? err.name : 'unknown');
    }
  }
  const after = await Promise.all(toDelete.map((path) => probePrivateObject(path)));
  const remaining = after.filter((probe) => probe.state === 'present').length;
  const unknown = after.filter((probe) => probe.state === 'unknown').length;
  const deleted = after.filter((probe) => probe.state === 'absent').length;
  if (unsettled) return { ...base, deleted, remaining: remaining + unknown + retainedUnknown, status: 'unverified' as const };
  if (unknown > 0) return { ...base, deleted, remaining: remaining + unknown + retainedUnknown, status: 'unverified' as const };
  if (remaining + retainedUnknown > 0) return { ...base, deleted, remaining: remaining + retainedUnknown, status: 'partial' as const };
  if (priorReceipt.state !== 'present') {
    try {
      await put(receiptPath(record.cohortId, key), JSON.stringify({
        schemaVersion: 1,
        cohortId: record.cohortId,
        familyStorageKey: key,
        dueAt: record.dueAt,
        verifiedAt: new Date(now).toISOString(),
        verifiedAbsentCount: candidates.length,
      }), {
        access: 'private', token: requireToken(), addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 0, contentType: 'application/json',
      });
    } catch {
      // A receipt that may exist is reconciled on replay; deletion itself is verified.
      if ((await probePrivateObject(receiptPath(record.cohortId, key))).state !== 'present') {
        return { ...base, deleted, status: 'unverified' as const };
      }
    }
  }
  return { ...base, deleted, status: 'complete' as const };
}

/** Idempotent operator cleanup; safe to replay after any partial or ambiguous run. */
export async function runGroupBookRetentionCleanup(args: { cohortId: string; now: number }): Promise<CleanupResult> {
  const [delivery, pilot] = await Promise.all([loadGroupBookDeliveryState(args.cohortId), loadPilotAnchor(args.cohortId)]);
  if (delivery.state === 'unknown' || pilot.state === 'unknown') return { outcome: 'delivery_unknown', families: [] };
  let anchor: CleanupAnchor;
  if (delivery.state === 'recorded') {
    anchor = delivery.record;
    if (args.now < Date.parse(anchor.dueAt)) return { outcome: 'not_due', dueAt: anchor.dueAt, families: [] };
  } else if (pilot.state === 'closed') {
    anchor = pilot.anchor;
    if (args.now < pilot.eligibleAt) return { outcome: 'not_due', dueAt: anchor.dueAt, families: [] };
  } else {
    return { outcome: 'no_delivery_recorded', families: [] };
  }
  // Scope from durable storage only; unknown scope is never reported complete.
  const roster = await discoverCohortFamilies(args.cohortId);
  if (!roster) return { outcome: 'scope_unknown', dueAt: anchor.dueAt, families: [] };
  const families: CleanupResult['families'] = [];
  // Pilot: exact matching registration/ownership stamps are checked per family,
  // including an acknowledged enrollment racing the close audit snapshot.
  for (const identity of roster) families.push(await cleanupFamily(identity, anchor, args.now));
  const done = families.every((family) => family.status === 'complete' || family.status === 'already_complete');
  return { outcome: done ? 'complete' : 'partial', dueAt: anchor.dueAt, families };
}


// ---------------------------------------------------------------------------
// Scheduled dispatch (ops successor DESIGN O1-O5).
// ---------------------------------------------------------------------------

/** Exactly one Vercel cron schedule (vercel.json): 05:41 UTC daily. */
export const GROUP_BOOK_RETENTION_SCHEDULE = '41 5 * * *';
export const GROUP_BOOK_SWEEP_FAMILY_BUDGET_DEFAULT = 100;

export function groupBookDispatchSlotPath(day: string): string {
  return `group-book/ops/retention-dispatch/${day}.json`;
}
export function groupBookHeartbeatPath(day: string): string {
  return `group-book/ops/retention-heartbeat/${day}.json`;
}
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function familyBudget(): number {
  const raw = Number(process.env.GROUP_BOOK_SWEEP_FAMILY_BUDGET);
  return Number.isInteger(raw) && raw >= 1 && raw <= 1000 ? raw : GROUP_BOOK_SWEEP_FAMILY_BUDGET_DEFAULT;
}

export type RetentionAttention =
  | 'discovery_unavailable'
  | 'held_unknown_scope'
  | 'delivery_unknown'
  | 'partial_or_unverified'
  | 'incomplete_budget'
  | 'dispatch_slot_unconfirmed'
  | 'heartbeat_unconfirmed'
  | 'dispatch_unconfirmed'
  | 'service_history_continuation'
  | 'overdue_owned_work';

export interface RetentionSweepCounts {
  cohortsDue: number;
  cohortsNotDue: number;
  deliveryUnknown: number;
  families: number;
  complete: number;
  incomplete: number;
  deferred: number;
  held: number;
  unrecognized: number;
  deleted: number;
}

/** Sanitized: codes, counts and timestamps only. No cohort/family ids, names, keys, paths or URLs. */
export interface RetentionDispatchSummary {
  ok: boolean;
  status: 'ok' | 'attention' | 'duplicate_suppressed';
  startedAt: string;
  attention: RetentionAttention[];
  counts: RetentionSweepCounts;
}

const zeroCounts = (): RetentionSweepCounts => ({
  cohortsDue: 0, cohortsNotDue: 0, deliveryUnknown: 0, families: 0, complete: 0, incomplete: 0, deferred: 0, held: 0, unrecognized: 0, deleted: 0,
});

/**
 * Per-key isolated discovery for the scheduled sweep (O1). A storage key whose
 * family/attempt record is unreadable, malformed or identity-mismatched, or a
 * photo prefix with no owner, is HELD: excluded from cleanup and counted, never
 * deleted by guess. Other keys stay eligible. A listing failure throws (global
 * halt). The operator route keeps the strict whole-scope discovery above.
 */
async function discoverIsolated(): Promise<{ families: GroupBookFamilyIdentity[]; held: number; unrecognized: number }> {
  const owners = new Map<string, GroupBookFamilyIdentity>();
  const held = new Set<string>();
  let unrecognized = 0;
  const claim = (key: string, identity: GroupBookFamilyIdentity) => {
    if (held.has(key)) return;
    const prior = owners.get(key);
    if (!ID_RE.test(identity.cohortId) || !ID_RE.test(identity.familySlotId) || familyStorageKey(identity) !== key ||
      (prior && (prior.cohortId !== identity.cohortId || prior.familySlotId !== identity.familySlotId))) {
      held.add(key);
      return;
    }
    owners.set(key, identity);
  };
  const safeRead = async (path: string) => {
    try { return await readPrivateObject(path); } catch { return { state: 'unreadable' as const }; }
  };
  const [familyPaths, attemptPaths, photoPaths] = [
    await listPaths('group-book/families/'), await listPaths('group-book/attempts/'), await listPaths('group-book/photos/'),
  ];
  for (const path of familyPaths) {
    const key = path.match(/^group-book\/families\/([0-9a-f]{64})\.json$/)?.[1];
    if (!key) { unrecognized += 1; continue; }
    const read = await safeRead(path);
    const cohort = read.state === 'found' ? (read.value as { cohort?: { id?: unknown; familySlotId?: unknown } })?.cohort : undefined;
    if (typeof cohort?.id !== 'string' || typeof cohort.familySlotId !== 'string') { held.add(key); continue; }
    const identity = { cohortId: cohort.id, familySlotId: cohort.familySlotId };
    if (read.state !== 'found' || !parseSubmission(read.value, identity)) { held.add(key); continue; }
    claim(key, identity);
  }
  for (const path of attemptPaths) {
    const segment = path.split('/')[2];
    const key = path.match(/^group-book\/attempts\/([0-9a-f]{64})\/gba_[A-Za-z0-9_-]+\.json$/)?.[1];
    if (!key) {
      if (segment && KEY_RE.test(segment)) held.add(segment); else unrecognized += 1;
      continue;
    }
    if (held.has(key)) continue;
    const read = await safeRead(path);
    const row = read.state === 'found' ? (read.value as Record<string, unknown> | null) : null;
    if (!row || row.schemaVersion !== 1 || row.familyStorageKey !== key) { held.add(key); continue; }
    if (typeof row.cohortId === 'string' && typeof row.familySlotId === 'string') claim(key, { cohortId: row.cohortId, familySlotId: row.familySlotId });
    else if (!owners.has(key)) held.add(key); // legacy attempt without identity and no owning record
  }
  for (const path of photoPaths) {
    const key = path.split('/')[2];
    if (!key || !KEY_RE.test(key)) { unrecognized += 1; continue; }
    if (!owners.has(key)) held.add(key); // unowned photo prefix: retained
    else if (!new RegExp(`^group-book/photos/${key}/gbp_[A-Za-z0-9_-]+\\.jpg$`).test(path)) unrecognized += 1;
  }
  const families = [...owners.entries()].filter(([key]) => !held.has(key)).map(([, identity]) => identity)
    .sort((a, b) => a.cohortId.localeCompare(b.cohortId) || a.familySlotId.localeCompare(b.familySlotId));
  return { families, held: held.size, unrecognized };
}

const SERVICE_PREFIX = 'group-book/ops/retention-service/';
/** Append-only queue accounting. Enqueue and service both move a key to the
 * tail. New arrivals cannot jump ahead of existing pending work. A service
 * record is durable BEFORE cleanup, so failures/crashes advance fairly too.
 * The daily dispatch slot supplies normal cross-instance exclusion; a direct
 * concurrent sweep collides on the next create-only ordinal and stops unless
 * reread proves that exact reservation belongs to it. No overwrite/CAS assumed.
 */
async function serviceQueue() {
  const turns = new Map<string, number>();
  let sequence = 0;
  const blockSize = 256;
  const checkpointPrefix = 'group-book/ops/retention-service-checkpoints/';
  const checkpointPath = (block: number) => `${checkpointPrefix}${String(block).padStart(16, '0')}.json`;
  const checkpoint = async (block: number) => {
    const read = await readPrivateObject(checkpointPath(block));
    if (read.state === 'absent') return null;
    const row = read.state === 'found' ? read.value as Record<string, unknown> : null;
    if (!row || row.schemaVersion !== 1 || row.sequence !== block * blockSize || !row.turns || typeof row.turns !== 'object' || Array.isArray(row.turns) || Object.entries(row.turns).some(([key, turn]) => !KEY_RE.test(key) || !Number.isSafeInteger(turn) || Number(turn) < 1 || Number(turn) > Number(row.sequence))) throw new IncompleteScopeError('service_checkpoint_unknown');
    return row as {schemaVersion:1;sequence:number;turns:Record<string,number>};
  };
  // Checkpoints are contiguous create-only blocks. Exact exponential/binary
  // probes find the newest one in logarithmic reads, without listing history.
  let low = 0, high = 1;
  while (await checkpoint(high)) {
    low = high; high *= 2;
    if (!Number.isSafeInteger(high * blockSize)) throw new IncompleteScopeError('service_sequence_bound');
  }
  while (high - low > 1) {
    const mid = Math.floor((high + low) / 2);
    if (await checkpoint(mid)) low = mid; else high = mid;
  }
  if (low) {
    const saved = (await checkpoint(low))!;
    sequence = saved.sequence;
    for (const [key, turn] of Object.entries(saved.turns)) turns.set(key, turn);
  }
  let continuation = false;
  for (let scanned = 0; scanned <= 512; scanned++) {
    const turn = sequence + 1;
    const path = `${SERVICE_PREFIX}${String(turn).padStart(16, '0')}.json`;
    const read = await readPrivateObject(path);
    if (read.state === 'absent') break;
    if (scanned === 512) { continuation = true; break; }
    const row = read.state === 'found' ? read.value as Record<string, unknown> : null;
    if (!row || row.schemaVersion !== 1 || !Number.isSafeInteger(turn) || row.turn !== turn || typeof row.familyStorageKey !== 'string' || !KEY_RE.test(row.familyStorageKey) || typeof row.reservation !== 'string') throw new IncompleteScopeError('service_history_unknown');
    sequence = turn;
    turns.set(row.familyStorageKey, turn);
    if (sequence % blockSize === 0) {
      const snapshot = {schemaVersion:1, sequence, turns:Object.fromEntries(turns)};
      try {
        await put(checkpointPath(sequence / blockSize), JSON.stringify(snapshot), {access:'private',token:requireToken(),addRandomSuffix:false,allowOverwrite:false,cacheControlMaxAge:0,contentType:'application/json'});
      } catch {
        const existing = await checkpoint(sequence / blockSize);
        if (!existing || existing.sequence !== sequence || JSON.stringify(existing.turns) !== JSON.stringify(snapshot.turns)) throw new IncompleteScopeError('service_checkpoint_unconfirmed');
      }
    }
  }
  const advance = async (key: string) => {
    const turn = sequence + 1;
    if (!Number.isSafeInteger(turn)) throw new IncompleteScopeError('service_sequence_bound');
    const reservation = randomUUID();
    const path = `${SERVICE_PREFIX}${String(turn).padStart(16, '0')}.json`;
    try {
      await put(path, JSON.stringify({schemaVersion:1, turn, familyStorageKey:key, reservation}), {
        access:'private', token:requireToken(), addRandomSuffix:false, allowOverwrite:false, cacheControlMaxAge:0, contentType:'application/json',
      });
    } catch {
      const read = await readPrivateObject(path);
      const row = read.state === 'found' ? read.value as Record<string, unknown> : null;
      if (!row || row.reservation !== reservation || row.turn !== turn || row.familyStorageKey !== key) throw new IncompleteScopeError('service_reservation_unknown');
    }
    sequence = turn;
    turns.set(key, turn);
  };
  return {turns, advance, continuation};
}

/**
 * One scheduled pass (DESIGN I5 + O1/O2): every cohort with a durable delivery
 * record gets every eligible family rechecked on every run (late commits are
 * removed by the next run). Held/unknown keys are retained with attention;
 * a family budget bounds work and reports the remainder as deferred.
 */
export async function runGroupBookRetentionSweep(now: number): Promise<{ attention: RetentionAttention[]; counts: RetentionSweepCounts }> {
  const counts = zeroCounts();
  const attention = new Set<RetentionAttention>();
  let deliveryPaths: string[];
  let pilotPaths: string[];
  let discovered: Awaited<ReturnType<typeof discoverIsolated>>;
  try {
    deliveryPaths = await listPaths('group-book/deliveries/');
    pilotPaths = await listPaths('group-book/pilot-closes/');
    discovered = await discoverIsolated();
  } catch {
    return { attention: ['discovery_unavailable'], counts };
  }
  counts.held = discovered.held;
  counts.unrecognized = discovered.unrecognized;
  const dueRecords: CleanupAnchor[] = [];
  // Pilot (test-only) closes: eligible from close + writer window, deadline close + 7d.
  for (const path of pilotPaths) {
    const cohortId = path.match(/^group-book\/pilot-closes\/([A-Za-z0-9_-]{3,64})\.json$/)?.[1];
    if (!cohortId) { counts.unrecognized += 1; continue; }
    const pilot = await loadPilotAnchor(cohortId);
    if (pilot.state !== 'closed') { counts.deliveryUnknown += 1; continue; }
    if (now < pilot.eligibleAt) { counts.cohortsNotDue += 1; continue; }
    counts.cohortsDue += 1;
    dueRecords.push(pilot.anchor);
  }
  for (const path of deliveryPaths) {
    const cohortId = path.match(/^group-book\/deliveries\/([A-Za-z0-9_-]{3,64})\.json$/)?.[1];
    if (!cohortId) { counts.unrecognized += 1; continue; }
    const delivery = await loadGroupBookDeliveryState(cohortId);
    if (delivery.state !== 'recorded') { counts.deliveryUnknown += 1; continue; }
    if (now < Date.parse(delivery.record.dueAt)) { counts.cohortsNotDue += 1; continue; }
    counts.cohortsDue += 1;
    dueRecords.push(delivery.record);
  }
  const byCohort = new Map(dueRecords.map((record) => [record.cohortId, record]));
  const eligible: GroupBookFamilyIdentity[] = [];
  const work: GroupBookFamilyIdentity[] = [];
  const overdueCandidates: string[][] = [];
  for (const family of discovered.families) {
    const record = byCohort.get(family.cohortId);
    if (!record) continue;
    const candidates = await familyPhotoCandidates(family, record.pilot);
    if (candidates === null) { counts.held += 1; continue; }
    eligible.push(family);
    const probes = await Promise.all(candidates.map(path => probePrivateObject(path)));
    if (probes.some(probe => probe.state !== 'absent')) {
      work.push(family);
      if (now >= Date.parse(record.dueAt)) overdueCandidates.push(candidates);
    } else {
      // No known deletion work: still verify settlement, strangers and receipt.
      const result = await cleanupFamily(family, record, now, false);
      if (result.status === 'complete' || result.status === 'already_complete') counts.complete += 1;
      else counts.incomplete += 1;
    }
  }
  const budget = Math.min(familyBudget(), work.length);
  // Legacy count: due families not selected for a deletion action, including
  // verified empty families. Budget attention below concerns actual work only.
  counts.deferred = Math.max(0, eligible.length - budget);
  let queue: Awaited<ReturnType<typeof serviceQueue>> | undefined;
  try {
    if (work.length) {
      queue = await serviceQueue();
      if (queue.continuation) attention.add('service_history_continuation');
      else {
        for (const family of work) if (!queue.turns.has(familyStorageKey(family))) await queue.advance(familyStorageKey(family));
        work.sort((a,b) => queue!.turns.get(familyStorageKey(a))! - queue!.turns.get(familyStorageKey(b))!);
      }
    }
  } catch { attention.add('dispatch_unconfirmed'); }
  for (let i = 0; i < budget && !attention.has('dispatch_unconfirmed') && !queue?.continuation; i += 1) {
    const identity = work[i];
    const record = byCohort.get(identity.cohortId)!;
    try { await queue!.advance(familyStorageKey(identity)); }
    catch { attention.add('dispatch_unconfirmed'); break; }
    {
      counts.families += 1;
      let result: { status: FamilyCleanupStatus; deleted: number };
      try {
        result = await cleanupFamily(identity, record, now);
      } catch {
        result = { status: 'unverified', deleted: 0 };
      }
      counts.deleted += result.deleted;
      if (result.status === 'complete' || result.status === 'already_complete') counts.complete += 1;
      else counts.incomplete += 1;
    }
  }
  if (counts.held > 0 || counts.unrecognized > 0) attention.add('held_unknown_scope');
  if (counts.deliveryUnknown > 0) attention.add('delivery_unknown');
  if (counts.incomplete > 0) attention.add('partial_or_unverified');
  if (work.length > counts.families) attention.add('incomplete_budget');
  for (const candidates of overdueCandidates) {
    if ((await Promise.all(candidates.map(path => probePrivateObject(path)))).some(probe => probe.state !== 'absent')) attention.add('overdue_owned_work');
  }
  return { attention: [...attention].sort(), counts };
}

type SlotRead = { state: 'ours' } | { state: 'other' } | { state: 'unknown' };

/**
 * Durable cross-instance single-flight (O3): a create-only slot per UTC day,
 * written BEFORE any provider cleanup. Blob is append-only here: the slot is
 * never overwritten or deleted, so it keeps suppressing duplicates for that
 * day. No compare-and-swap is claimed beyond create-only put semantics; an
 * ambiguous write is decided by reread, and anything uncertain does no cleanup.
 */
async function reserveDispatchSlot(day: string, runId: string, startedAt: string): Promise<SlotRead> {
  const path = groupBookDispatchSlotPath(day);
  try {
    await put(path, JSON.stringify({ schemaVersion: 1, runId, startedAt }), {
      access: 'private', token: requireToken(), addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 0, contentType: 'application/json',
    });
    return { state: 'ours' };
  } catch {
    try {
      const read = await readPrivateObject(path);
      if (read.state !== 'found') return { state: 'unknown' };
      return (read.value as { runId?: unknown })?.runId === runId ? { state: 'ours' } : { state: 'other' };
    } catch {
      return { state: 'unknown' };
    }
  }
}

/**
 * A suppressed duplicate reports the day's stored sanitized result, so it can
 * never mask an attention run as healthy; with no heartbeat yet (in progress,
 * crashed or unconfirmed) it is incomplete attention, never ok.
 */
async function duplicateSummary(day: string, startedAt: string): Promise<RetentionDispatchSummary> {
  const unconfirmed: RetentionDispatchSummary = { ok: false, status: 'duplicate_suppressed', startedAt, attention: ['dispatch_unconfirmed'], counts: zeroCounts() };
  try {
    const read = await readPrivateObject(groupBookHeartbeatPath(day));
    if (read.state !== 'found') return unconfirmed;
    const v = read.value as { status?: unknown; attention?: unknown; counts?: unknown };
    if ((v?.status !== 'ok' && v?.status !== 'attention') || !Array.isArray(v.attention) || !v.counts || typeof v.counts !== 'object') return unconfirmed;
    const counts = zeroCounts();
    for (const key of Object.keys(counts) as (keyof RetentionSweepCounts)[]) {
      const n = (v.counts as Record<string, unknown>)[key];
      if (typeof n === 'number' && Number.isInteger(n) && n >= 0) counts[key] = n;
    }
    const attention = v.attention.filter((a): a is RetentionAttention => typeof a === 'string' && ATTENTION_CODES.has(a as RetentionAttention));
    const ok = v.status === 'ok' && attention.length === 0;
    return { ok, status: 'duplicate_suppressed', startedAt, attention: ok ? [] : (attention.length ? attention : ['dispatch_unconfirmed']), counts };
  } catch {
    return unconfirmed;
  }
}

const ATTENTION_CODES = new Set<RetentionAttention>([
  'discovery_unavailable', 'held_unknown_scope', 'delivery_unknown', 'partial_or_unverified', 'incomplete_budget',
  'dispatch_slot_unconfirmed', 'heartbeat_unconfirmed', 'dispatch_unconfirmed',
  'overdue_owned_work',
  'service_history_continuation',
]);

/** Authenticated scheduler entry: single-flight slot, sweep, then sanitized durable heartbeat. */
export async function runGroupBookRetentionDispatch(now: number): Promise<RetentionDispatchSummary> {
  const startedAt = new Date(now).toISOString();
  const day = utcDay(now);
  const runId = `gbr_${randomUUID()}`;
  const slot = await reserveDispatchSlot(day, runId, startedAt);
  if (slot.state === 'other') return duplicateSummary(day, startedAt);
  if (slot.state === 'unknown') return { ok: false, status: 'attention', startedAt, attention: ['dispatch_slot_unconfirmed'], counts: zeroCounts() };
  const { attention, counts } = await runGroupBookRetentionSweep(now);
  const status = attention.length === 0 ? 'ok' as const : 'attention' as const;
  try {
    await put(groupBookHeartbeatPath(day), JSON.stringify({
      schemaVersion: 1, day, runId, startedAt, finishedAt: new Date(Date.now()).toISOString(), status, attention, counts,
    }), { access: 'private', token: requireToken(), addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 0, contentType: 'application/json' });
  } catch (err) {
    // Never a false green: the durable record is unconfirmed (the monitor also
    // sees stale_in_progress if it is truly absent).
    console.error('[group-book/retention] heartbeat write failed:', err instanceof Error ? err.name : 'unknown');
    return { ok: false, status: 'attention', startedAt, attention: [...new Set([...attention, 'heartbeat_unconfirmed' as const])].sort(), counts };
  }
  return { ok: status === 'ok', status, startedAt, attention, counts };
}
