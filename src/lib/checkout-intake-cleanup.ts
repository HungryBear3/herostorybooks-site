/**
 * Reclaims checkout intake storage.
 *
 * Three things this has to get right, each of which was reproduced wrong
 * before.
 *
 * 1. IT MUST NOT RACE FINALIZATION.
 *    Read the record, see it is unfinalized, delete — and in between, the
 *    buyer pays. A probe doing exactly that deleted the record AND the hero
 *    photo of a paid order. The fix is a conditional CLAIM: cleanup CAS-writes
 *    a `cleanupClaim` against the exact version it read, and finalization
 *    refuses while a live claim exists. Finalization first → the record moved
 *    → the claim CAS fails on the stale etag. Claim first → finalization is
 *    refused with `intake_cleanup_in_progress`. There is no interleaving in
 *    which both succeed.
 *
 * 2. THE PLAN MUST BE BUILT UNDER THE CLAIM, NOT BEFORE IT.
 *    A global prefix scan is only a list of intakes to visit. Building the
 *    DELETION plan from it is unsound: an upload reserved earlier can land
 *    between that scan and the deletion, so its bytes are absent from the plan
 *    while the record is deleted anyway — leaving an object with no record,
 *    which the next run cannot explain and which aborted every subsequent
 *    sweep. So the per-intake plan comes from a listing taken AFTER the claim,
 *    and the record is only deleted once a re-listing shows nothing left.
 *
 * 3. FINALIZED MEDIA IS RETAINED SELECTIVELY, NOT FOREVER.
 *    Skipping finalized intakes entirely meant every photo a buyer uploaded
 *    but did NOT order was kept indefinitely with nothing referencing it. The
 *    finalized record now carries the exact selected tuple, so the retention
 *    rule can be exact: keep what the order bound, reclaim everything else,
 *    keep the record as the binding evidence.
 *
 * Anything the listing cannot explain — a repeated cursor, an object under an
 * intake id with no record — aborts the run. Deleting storage we do not
 * understand is not a recovery strategy.
 */
import crypto from 'node:crypto';
import { del, list } from '@vercel/blob';

import {
  assertIntakeRecordWritable,
  cleanupClaimActive,
  createVercelIntakeStore,
  getRequiredIntakeBlobToken,
  INTAKE_CLEANUP_CLAIM_TTL_MS,
  INTAKE_UPLOAD_TOKEN_TTL_MS,
  intakeListPrefix,
  intakeRecordPath,
  readIntake,
  touch,
  type IntakeRecord,
  type IntakeStore,
} from './checkout-intake.ts';
import { getBlobNamespace } from './blob-namespace.ts';
import {
  CHECKOUT_INTAKE_MEDIA_ABANDONMENT_MS,
  claimCheckoutIntakeMediaCleanup,
  getOrderAuthoritative,
  markCheckoutIntakeMediaReclaimed,
  type CheckoutIntakeMediaCleanupClaimResult,
  type CheckoutIntakeMediaReclaimResult,
  type OrderRecord,
} from './orders.ts';

/** How many delete/relist passes before we give up and keep the record. */
const MAX_DELETE_PASSES = 3;
export const INTAKE_CLEANUP_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;
export const INTAKE_FINALIZATION_ABANDONMENT_MS = CHECKOUT_INTAKE_MEDIA_ABANDONMENT_MS;

export type FinalizationOrderReconciliation = 'exact' | 'absent' | 'conflict' | 'unknown';

export function reconcileFinalizationOrderRecord(
  order: OrderRecord | null,
  params: { orderId: string; intakeId: string; checkoutAttemptId: string; fingerprint: string },
): FinalizationOrderReconciliation {
  if (!order) return 'absent';
  return order.id === params.orderId
    && order.checkoutAttemptId === params.checkoutAttemptId
    && order.checkoutIntake?.intakeId === params.intakeId
    && order.checkoutIntake.fingerprint === params.fingerprint
    && order.checkoutIntakeMediaRetention?.status === 'active'
    ? 'exact'
    : 'conflict';
}

function isTerminalCleanupTombstone(record: IntakeRecord): boolean {
  return !record.finalizedOrderId
    && !record.finalization
    && !record.cleanupClaim
    && Object.keys(record.slots).length === 0
    && record.superseded.length === 0
    && Date.parse(record.updatedAt) >= Date.parse(record.expiresAt);
}

export interface CheckoutIntakeCleanupDeps {
  store: IntakeStore;
  list(options: { prefix: string; cursor?: string }): Promise<{
    blobs: Array<{ pathname: string }>;
    hasMore?: boolean;
    cursor?: string;
  }>;
  del(pathname: string): Promise<void>;
  newClaimId(): string;
  /** Exact binding may be promoted; conflict/unknown preserve; absent may clear. */
  reconcileFinalizationOrder(params: {
    orderId: string;
    intakeId: string;
    checkoutAttemptId: string;
    fingerprint: string;
  }): Promise<FinalizationOrderReconciliation>;
  claimFinalizedOrderMedia(
    orderId: string,
    intakeId: string,
    now: Date,
  ): Promise<CheckoutIntakeMediaCleanupClaimResult>;
  markFinalizedOrderMediaReclaimed(
    orderId: string,
    intakeId: string,
    now: Date,
  ): Promise<CheckoutIntakeMediaReclaimResult>;
}

export interface CheckoutIntakeCleanupResult {
  ok: true;
  dryRun: boolean;
  scanned: number;
  deletedRecords: string[];
  deletedAssets: string[];
  /** Finalized intakes whose unselected media was reclaimed; record kept. */
  retainedFinalized: number;
  /** Finalized unpaid intakes fully reclaimed and tombstoned this run. */
  reclaimedFinalized: number;
  /** Order claim/final-mark operations that failed closed. */
  orderFenceFailures: number;
  /** Final intake tombstone CAS operations that did not commit. */
  intakeTombstoneFailures: number;
  /** Intakes with a LIVE finalization lease. */
  skippedFinalizing: number;
  /** Someone else wrote to the intake, or already holds a claim. */
  skippedClaimContested: number;
  /** Objects the provider refused to delete this run. */
  deleteFailures: number;
  /** Records kept because objects remained that we could not reclaim. */
  deferredRecords: number;
  /** Claims we could not hand back; they lapse with the lease. */
  claimReleaseFailures: number;
}

class AmbiguousListingError extends Error {
  constructor(detail: string) {
    super(`checkout intake cleanup listing ambiguous: ${detail}`);
    this.name = 'AmbiguousListingError';
  }
}

export function buildDefaultCheckoutIntakeCleanupDeps(
  env: NodeJS.ProcessEnv = process.env,
): CheckoutIntakeCleanupDeps {
  const token = getRequiredIntakeBlobToken(env);
  return {
    store: createVercelIntakeStore(token, env),
    list: (options) => list({ ...options, token }),
    del: async (pathname) => { await del(pathname, { token }); },
    newClaimId: () => crypto.randomBytes(16).toString('hex'),
    async reconcileFinalizationOrder(params) {
      let order;
      try {
        order = await getOrderAuthoritative(params.orderId);
      } catch {
        return 'unknown';
      }
      return reconcileFinalizationOrderRecord(order, params);
    },
    claimFinalizedOrderMedia: (orderId, intakeId, now) =>
      claimCheckoutIntakeMediaCleanup(orderId, intakeId, { now }),
    markFinalizedOrderMediaReclaimed: (orderId, intakeId, now) =>
      markCheckoutIntakeMediaReclaimed(orderId, intakeId, { now }),
  };
}

function recordPattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}(intake_[a-f0-9]{32})\\.json$`);
}

function assetPattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}(intake_[a-f0-9]{32})/assets/asset_[a-f0-9]{32}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Objects the record currently depends on: active assets and live reservations. */
function boundPathnames(record: IntakeRecord): Set<string> {
  const bound = new Set<string>();
  for (const slot of Object.values(record.slots)) {
    if (slot.active) bound.add(slot.active.pathname);
    if (slot.pending) bound.add(slot.pending.pathname);
  }
  return bound;
}

/** Exactly the objects a finalized order bound. Everything else is reclaimable. */
function orderedPathnames(record: IntakeRecord): Set<string> {
  return new Set((record.finalization?.selection ?? []).map((entry) => entry.pathname));
}

/**
 * Lists under `prefix`, but classifies against the ROOT prefix.
 *
 * The per-intake listing narrows to one intake's objects; their pathnames are
 * still rooted at the namespace prefix, so the patterns must be built from
 * that root rather than from whatever narrower prefix was listed.
 */
async function listIntakeObjects(
  deps: CheckoutIntakeCleanupDeps,
  prefix: string,
  rootPrefix: string = prefix,
): Promise<{ recordIds: Set<string>; assets: Set<string> }> {
  const recordIds = new Set<string>();
  const assets = new Set<string>();
  const isRecord = recordPattern(rootPrefix);
  const isAsset = assetPattern(rootPrefix);
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const page = await deps.list({ prefix, cursor });
    for (const blob of page.blobs) {
      const recordMatch = isRecord.exec(blob.pathname);
      if (recordMatch) {
        recordIds.add(recordMatch[1]!);
        continue;
      }
      if (!isAsset.test(blob.pathname)) {
        throw new AmbiguousListingError(`unrecognised object ${blob.pathname}`);
      }
      assets.add(blob.pathname);
    }
    if (!page.hasMore) break;
    if (!page.cursor || seenCursors.has(page.cursor)) {
      throw new AmbiguousListingError('listing did not advance');
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
  return { recordIds, assets };
}

export async function runCheckoutIntakeCleanup(
  deps: CheckoutIntakeCleanupDeps,
  options: { now?: Date; dryRun?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<CheckoutIntakeCleanupResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const namespace = getBlobNamespace(options.env ?? process.env);
  const rootPrefix = intakeListPrefix(namespace);

  // The global scan enumerates intakes and proves the store is explicable. It
  // is NOT the deletion plan — see the header.
  const scan = await listIntakeObjects(deps, rootPrefix);
  for (const pathname of scan.assets) {
    const intakeId = assetPattern(rootPrefix).exec(pathname)?.[1];
    if (!intakeId || !scan.recordIds.has(intakeId)) {
      throw new AmbiguousListingError(`objects for ${intakeId ?? pathname} have no record`);
    }
  }

  const result: CheckoutIntakeCleanupResult = {
    ok: true,
    dryRun,
    scanned: scan.recordIds.size,
    deletedRecords: [],
    deletedAssets: [],
    retainedFinalized: 0,
    reclaimedFinalized: 0,
    orderFenceFailures: 0,
    intakeTombstoneFailures: 0,
    skippedFinalizing: 0,
    skippedClaimContested: 0,
    deleteFailures: 0,
    deferredRecords: 0,
    claimReleaseFailures: 0,
  };

  for (const intakeId of [...scan.recordIds].sort()) {
    const intakePrefix = `${rootPrefix}${intakeId}/assets/`;
    let snapshot = await readIntake(deps.store, intakeId);
    let record = snapshot.record;

    // Terminal tombstones are immutable within the state machine. They are
    // retained long enough to fence stale cleanup owners, then deleted without
    // another claim/CAS cycle because no legitimate writer can mutate them.
    if (isTerminalCleanupTombstone(record)) {
      const deletionDue = Date.parse(record.updatedAt) + INTAKE_CLEANUP_TOMBSTONE_RETENTION_MS <= now.getTime();
      if (deletionDue) {
        const pathname = intakeRecordPath(intakeId, namespace);
        if (dryRun || await tryDelete(deps, pathname, result)) result.deletedRecords.push(pathname);
      }
      continue;
    }

    // Recover the exact "order committed, intake mark response lost" state.
    // Existence alone is insufficient: only a strict authoritative binding may
    // promote the intake. Conflict and uncertainty preserve all private media.
    if (!record.finalizedOrderId && record.finalization) {
      const reconciliationDue = Date.parse(record.finalization.leaseExpiresAt)
        + INTAKE_FINALIZATION_ABANDONMENT_MS <= now.getTime();
      if (!reconciliationDue || dryRun) {
        result.skippedFinalizing += 1;
        continue;
      }
      let reconciliation: FinalizationOrderReconciliation;
      try {
        reconciliation = await deps.reconcileFinalizationOrder({
          orderId: record.finalization.orderId,
          intakeId,
          checkoutAttemptId: record.finalization.checkoutAttemptId,
          fingerprint: record.finalization.fingerprint,
        });
      } catch {
        reconciliation = 'unknown';
      }
      if (reconciliation === 'exact') {
        const reconciled = { ...record, finalizedOrderId: record.finalization.orderId };
        assertIntakeRecordWritable(reconciled);
        if (!await deps.store.compareAndSwap(intakeId, snapshot.etag, reconciled)) {
          result.skippedClaimContested += 1;
          continue;
        }
        snapshot = await readIntake(deps.store, intakeId);
        record = snapshot.record;
      } else if (reconciliation === 'absent') {
        const reconciled = { ...touch(record, now), finalization: null };
        assertIntakeRecordWritable(reconciled);
        if (!await deps.store.compareAndSwap(intakeId, snapshot.etag, reconciled)) {
          result.skippedClaimContested += 1;
          continue;
        }
        snapshot = await readIntake(deps.store, intakeId);
        record = snapshot.record;
      } else {
        result.skippedFinalizing += 1;
        continue;
      }
    }

    // ── Finalized: selective retention, then bounded unpaid reclamation ────
    if (record.finalizedOrderId) {
      const finalizedOrderId = record.finalizedOrderId;
      const keep = orderedPathnames(record);
      const objects = (await listIntakeObjects(deps, intakePrefix, rootPrefix)).assets;
      const reclaimable = [...objects].filter((pathname) => !keep.has(pathname)).sort();
      const abandonmentDue = Date.parse(record.finalization?.reservedAt ?? record.updatedAt)
        + INTAKE_FINALIZATION_ABANDONMENT_MS <= now.getTime();

      if (!abandonmentDue || dryRun) {
        if (dryRun) {
          result.deletedAssets.push(...reclaimable);
        } else {
          for (const pathname of reclaimable) {
            if (await tryDelete(deps, pathname, result)) result.deletedAssets.push(pathname);
          }
        }
        result.retainedFinalized += 1;
        continue;
      }

      let orderClaim: CheckoutIntakeMediaCleanupClaimResult;
      try {
        orderClaim = await deps.claimFinalizedOrderMedia(finalizedOrderId, intakeId, now);
      } catch {
        result.orderFenceFailures += 1;
        result.retainedFinalized += 1;
        continue;
      }
      if (orderClaim.status === 'retained') {
        // The order remains authoritative, but unselected media is still not
        // part of its exact binding and may be reclaimed selectively.
        for (const pathname of reclaimable) {
          if (await tryDelete(deps, pathname, result)) result.deletedAssets.push(pathname);
        }
        result.retainedFinalized += 1;
        continue;
      }

      let failedHere = false;
      let remaining: string[] = [];
      for (let pass = 0; pass < MAX_DELETE_PASSES; pass += 1) {
        const currentObjects = (await listIntakeObjects(deps, intakePrefix, rootPrefix)).assets;
        if (currentObjects.size === 0) break;
        for (const pathname of [...currentObjects].sort()) {
          if (await tryDelete(deps, pathname, result)) {
            result.deletedAssets.push(pathname);
          } else {
            failedHere = true;
          }
        }
        if (failedHere) break;
      }
      remaining = [...(await listIntakeObjects(deps, intakePrefix, rootPrefix)).assets].sort();
      if (failedHere || remaining.length > 0) {
        result.deferredRecords += 1;
        continue;
      }

      let orderMarked: CheckoutIntakeMediaReclaimResult;
      try {
        orderMarked = await deps.markFinalizedOrderMediaReclaimed(finalizedOrderId, intakeId, now);
      } catch {
        result.orderFenceFailures += 1;
        result.deferredRecords += 1;
        continue;
      }
      if (orderMarked.status === 'not_claimed') {
        result.orderFenceFailures += 1;
        result.deferredRecords += 1;
        continue;
      }

      const tombstoneSnapshot = await readIntake(deps.store, intakeId);
      if (tombstoneSnapshot.record.finalizedOrderId !== finalizedOrderId) {
        result.intakeTombstoneFailures += 1;
        result.deferredRecords += 1;
        continue;
      }
      const tombstone = {
        ...touch(tombstoneSnapshot.record, now),
        finalizedOrderId: null,
        finalization: null,
        slots: {},
        superseded: [],
        cleanupClaim: null,
      };
      assertIntakeRecordWritable(tombstone);
      if (!await deps.store.compareAndSwap(intakeId, tombstoneSnapshot.etag, tombstone)) {
        result.intakeTombstoneFailures += 1;
        result.deferredRecords += 1;
        continue;
      }
      result.reclaimedFinalized += 1;
      continue;
    }

    if (cleanupClaimActive(record, now.getTime())) {
      result.skippedClaimContested += 1;
      continue;
    }

    if (dryRun) {
      // Plan only, from the global scan; a dry run takes no claim and so has
      // no authoritative view. Reported as an estimate.
      const expired = Date.parse(record.expiresAt) + INTAKE_UPLOAD_TOKEN_TTL_MS <= now.getTime();
      const bound = boundPathnames(record);
      const objects = [...scan.assets].filter((pathname) => pathname.startsWith(intakePrefix));
      result.deletedAssets.push(...objects.filter((pathname) => expired || !bound.has(pathname)).sort());
      continue;
    }

    // ── Claim, against the exact version we read ──────────────────────────
    // One attempt on purpose: if anything changed, this intake is someone
    // else's business right now.
    const claimId = deps.newClaimId();
    const claimedAtMs = Math.max(now.getTime(), Date.parse(record.updatedAt));
    const claimedRecord = {
      ...touch(record, now),
      cleanupClaim: {
        claimId,
        claimedAt: new Date(claimedAtMs).toISOString(),
        expiresAt: new Date(claimedAtMs + INTAKE_CLEANUP_CLAIM_TTL_MS).toISOString(),
      },
    };
    assertIntakeRecordWritable(claimedRecord);
    const claimed = await deps.store.compareAndSwap(intakeId, snapshot.etag, claimedRecord);
    if (!claimed) {
      result.skippedClaimContested += 1;
      continue;
    }

    const confirmed = await readIntake(deps.store, intakeId);
    if (confirmed.record.cleanupClaim?.claimId !== claimId
      || confirmed.record.finalizedOrderId
      || confirmed.record.finalization) {
      result.skippedClaimContested += 1;
      continue;
    }

    const expired = Date.parse(confirmed.record.expiresAt) + INTAKE_UPLOAD_TOKEN_TTL_MS <= now.getTime();
    const bound = boundPathnames(confirmed.record);
    let failedHere = false;
    let claimLost = false;

    // ── Delete, then re-list, until storage agrees or we give up ──────────
    let remaining: string[] = [];
    for (let pass = 0; pass < MAX_DELETE_PASSES; pass += 1) {
      const objects = (await listIntakeObjects(deps, intakePrefix, rootPrefix)).assets;
      const doomed = [...objects].filter((pathname) => expired || !bound.has(pathname)).sort();
      if (doomed.length === 0) break;
      for (const pathname of doomed) {
        if (!await cleanupClaimOwned(deps, intakeId, claimId)) {
          claimLost = true;
          break;
        }
        if (await tryDelete(deps, pathname, result)) {
          result.deletedAssets.push(pathname);
        } else {
          failedHere = true;
        }
      }
      if (failedHere || claimLost) break;
    }

    // A list computed before deletion cannot prove nothing landed during that
    // delete. The final post-delete listing is mandatory.
    if (!claimLost) {
      remaining = [...(await listIntakeObjects(deps, intakePrefix, rootPrefix)).assets].sort();
    }

    if (expired && !failedHere && !claimLost && remaining.length === 0) {
      // Blob has no conditional delete. Retain a compact tombstone via CAS so
      // a paused, expired owner cannot delete after another runner takes over.
      const tombstoneSnapshot = await readIntake(deps.store, intakeId);
      if (tombstoneSnapshot.record.cleanupClaim?.claimId !== claimId
        || tombstoneSnapshot.record.finalization
        || tombstoneSnapshot.record.finalizedOrderId) {
        result.claimReleaseFailures += 1;
        continue;
      }
      const tombstone = {
        ...touch(tombstoneSnapshot.record, now),
        slots: {},
        superseded: [],
        cleanupClaim: null,
      };
      assertIntakeRecordWritable(tombstone);
      const retained = await deps.store.compareAndSwap(intakeId, tombstoneSnapshot.etag, tombstone);
      if (!retained) result.claimReleaseFailures += 1;
      continue;
    } else if (expired) {
      result.deferredRecords += 1;
    }

    // ── Hand the claim back. Never erase ambiguous finalization authority. ──
    const releaseSnapshot = await readIntake(deps.store, intakeId);
    if (releaseSnapshot.record.cleanupClaim?.claimId !== claimId) {
      result.claimReleaseFailures += 1;
      continue;
    }
    const releasedRecord = {
      ...touch(releaseSnapshot.record, now),
      superseded: releaseSnapshot.record.superseded.filter(
        (asset) => !result.deletedAssets.includes(asset.pathname),
      ),
      cleanupClaim: null,
    };
    assertIntakeRecordWritable(releasedRecord);
    const released = await deps.store.compareAndSwap(intakeId, releaseSnapshot.etag, releasedRecord);
    if (!released) result.claimReleaseFailures += 1;
  }

  return result;
}

async function cleanupClaimOwned(
  deps: CheckoutIntakeCleanupDeps,
  intakeId: string,
  claimId: string,
): Promise<boolean> {
  const snapshot = await readIntake(deps.store, intakeId);
  return snapshot.record.cleanupClaim?.claimId === claimId
    && !snapshot.record.finalizedOrderId
    && !snapshot.record.finalization;
}

/**
 * A delete that reports rather than aborts.
 *
 * One object the provider refuses must not strand the rest of the sweep, and
 * must not be mistaken for a successful reclaim — the record is kept so the
 * object stays explained and a later run can finish the job.
 */
async function tryDelete(
  deps: CheckoutIntakeCleanupDeps,
  pathname: string,
  result: CheckoutIntakeCleanupResult,
): Promise<boolean> {
  try {
    await deps.del(pathname);
    return true;
  } catch (error) {
    result.deleteFailures += 1;
    console.error(`[checkout-intake-cleanup] delete failed for ${pathname}:`, error);
    return false;
  }
}
