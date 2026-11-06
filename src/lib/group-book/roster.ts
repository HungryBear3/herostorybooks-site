import { list } from '@vercel/blob';

import { groupBookInvitesStrict, type GroupBookInvite } from './config.ts';
import {
  CLASSROOM_ENROLLMENT_PREFIX,
  classroomCodesStrict,
  isClassroomEnrollmentPath,
  parseClassroomEnrollment,
  type ClassroomEnrollment,
} from './identity-access.ts';
import { discoverCohortFamilies } from './retention.ts';
import { readPrivateObject, requireToken } from './store.ts';

/**
 * Complete admission roster for one cohort: operator-provisioned legacy slots
 * plus every managed enrollment for that cohort, from private storage. Any
 * uncertainty makes the whole roster uncertain, never a silent omission:
 * malformed legacy or selector configuration, an incomplete or failing
 * enrollment listing, any unreadable or non-canonical enrollment record (in
 * any cohort, since an unparseable record cannot be attributed), an enrolled
 * family whose cohort has no configured selector, a legacy slot that collides
 * with a managed identity, or a stored family that is in neither set.
 * Read-only; no auth or provider call.
 */
export type ClassroomRoster =
  | { state: 'complete'; cohortId: string; invites: GroupBookInvite[] }
  | { state: 'uncertain'; cohortId: string; reason: ClassroomRosterUncertainty };

export type ClassroomRosterUncertainty =
  | 'legacy_config_malformed'
  | 'selector_config_malformed'
  | 'enrollment_listing_incomplete'
  | 'enrollment_invalid'
  | 'enrollment_duplicate'
  | 'enrollment_cohort_unconfigured'
  | 'legacy_managed_conflict'
  | 'family_discovery_unknown'
  | 'orphan_family';

/** Hard bounds on enrollment listing; exceeding any is incomplete scope. */
export const GROUP_BOOK_ENROLLMENT_LIST_MAX_PAGES = 50;
export const GROUP_BOOK_ENROLLMENT_LIST_PAGE_LIMIT = 1000;
export const GROUP_BOOK_ENROLLMENT_LIST_MAX_ITEMS = GROUP_BOOK_ENROLLMENT_LIST_MAX_PAGES * GROUP_BOOK_ENROLLMENT_LIST_PAGE_LIMIT;

class IncompleteListingError extends Error {}

/**
 * Complete enrollment pathnames, or a throw. Every page is validated at
 * runtime (object page, array of row objects, string pathnames, boolean
 * hasMore, nonempty never-seen continuation cursor, per-page/page/total
 * bounds) and every pathname must match the canonical enrollment grammar.
 * The whole listing completes before the caller performs any private read.
 */
async function listEnrollmentPaths(): Promise<string[]> {
  const out: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= GROUP_BOOK_ENROLLMENT_LIST_MAX_PAGES) throw new IncompleteListingError('list_page_bound');
    const result: unknown = await list({
      prefix: CLASSROOM_ENROLLMENT_PREFIX, token: requireToken(), cursor, limit: GROUP_BOOK_ENROLLMENT_LIST_PAGE_LIMIT,
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new IncompleteListingError('list_page_malformed');
    const { blobs, hasMore, cursor: next } = result as { blobs?: unknown; hasMore?: unknown; cursor?: unknown };
    if (!Array.isArray(blobs) || blobs.length > GROUP_BOOK_ENROLLMENT_LIST_PAGE_LIMIT) throw new IncompleteListingError('list_blobs_malformed');
    for (const row of blobs) {
      const pathname = row && typeof row === 'object' && !Array.isArray(row) ? (row as { pathname?: unknown }).pathname : undefined;
      if (!isClassroomEnrollmentPath(pathname)) throw new IncompleteListingError('list_path_noncanonical');
      out.push(pathname);
    }
    if (out.length > GROUP_BOOK_ENROLLMENT_LIST_MAX_ITEMS) throw new IncompleteListingError('list_item_bound');
    if (typeof hasMore !== 'boolean') throw new IncompleteListingError('list_has_more_malformed');
    if (!hasMore) return out;
    if (typeof next !== 'string' || next === '' || seenCursors.has(next)) throw new IncompleteListingError('list_cursor_invalid');
    seenCursors.add(next);
    cursor = next;
  }
}

const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function loadClassroomRoster(cohortId: string): Promise<ClassroomRoster> {
  const uncertain = (reason: ClassroomRosterUncertainty): ClassroomRoster => ({ state: 'uncertain', cohortId, reason });
  const legacyConfig = groupBookInvitesStrict();
  if (legacyConfig.state === 'malformed') return uncertain('legacy_config_malformed');
  const selectorConfig = classroomCodesStrict();
  if (selectorConfig.state === 'malformed') return uncertain('selector_config_malformed');
  const legacy = legacyConfig.state === 'valid' ? legacyConfig.invites : [];
  const selectors = selectorConfig.state === 'valid' ? selectorConfig.cohorts : [];

  let paths: string[];
  try {
    paths = await listEnrollmentPaths();
  } catch {
    return uncertain('enrollment_listing_incomplete');
  }
  const enrollments: ClassroomEnrollment[] = [];
  const seen = new Set<string>();
  for (const pathname of paths) {
    let read: Awaited<ReturnType<typeof readPrivateObject>>;
    try {
      read = await readPrivateObject(pathname);
    } catch {
      return uncertain('enrollment_invalid');
    }
    if (read.state !== 'found') return uncertain('enrollment_invalid');
    const enrollment = parseClassroomEnrollment(pathname, read.value);
    if (!enrollment) return uncertain('enrollment_invalid');
    const slot = `${enrollment.cohortId}\0${enrollment.familySlotId}`;
    if (seen.has(slot)) return uncertain('enrollment_duplicate');
    seen.add(slot);
    enrollments.push(enrollment);
  }

  const ownLegacy = legacy.filter((invite) => invite.cohortId === cohortId);
  const ownEnrollments = enrollments.filter((enrollment) => enrollment.cohortId === cohortId);
  const selector = selectors.find((row) => row.cohortId === cohortId);
  if (ownEnrollments.length > 0 && !selector) return uncertain('enrollment_cohort_unconfigured');
  const legacySlots = new Set(ownLegacy.map((invite) => invite.familySlotId));
  if (ownEnrollments.some((enrollment) => legacySlots.has(enrollment.familySlotId))) return uncertain('legacy_managed_conflict');

  const managed: GroupBookInvite[] = ownEnrollments.map((enrollment) => ({
    ...selector!,
    familySlotId: enrollment.familySlotId,
    owner: { issuer: enrollment.owner.issuer, subject: enrollment.owner.subject },
  }));
  const invites = [...ownLegacy, ...managed].sort((a, b) => codeUnit(a.familySlotId, b.familySlotId));

  // Reconcile against durable family storage: every stored family of this
  // cohort must be a rostered legacy slot or managed enrollment.
  const discovered = await discoverCohortFamilies(cohortId);
  if (!discovered) return uncertain('family_discovery_unknown');
  const rostered = new Set(invites.map((invite) => invite.familySlotId));
  if (discovered.some((family) => family.cohortId !== cohortId || !rostered.has(family.familySlotId))) return uncertain('orphan_family');

  return { state: 'complete', cohortId, invites };
}
