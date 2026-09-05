/*
 * F4 — cleanup must be correct against a moving store, and must not keep
 * private media forever.
 *
 * Reproduced against the previous version:
 *
 *  - The deletion plan came from a prefix listing taken BEFORE the per-intake
 *    claim. An upload issued earlier could land between that scan and the
 *    record deletion; its bytes were not in the plan, the record was deleted
 *    anyway, and the NEXT run aborted globally with
 *    "objects for <intake> have no record" — one late upload poisoning every
 *    subsequent sweep.
 *
 *  - A finalized intake was skipped forever, and finalized state stored only
 *    an opaque fingerprint. Private media the buyer uploaded but did NOT
 *    select was therefore retained indefinitely with nothing referencing it.
 *
 *  - A crashed finalization had no lease, so it fenced its intake — and
 *    cleanup — permanently.
 *
 *  - Failure of the CAS that releases a live claim was ignored.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntake,
  INTAKE_FINALIZATION_LEASE_MS,
  intakeRecordPath,
  markIntakeFinalized,
} from '../src/lib/checkout-intake.ts';
import {
  completeSlotUpload as completeSlotUploadAt,
  reserveSlotUpload as reserveSlotUploadAt,
} from '../src/lib/checkout-intake-upload.ts';
import { finalizeIntakeSelection as finalizeIntakeSelectionAt } from '../src/lib/checkout-finalize.ts';
import {
  runCheckoutIntakeCleanup,
  type CheckoutIntakeCleanupDeps,
} from '../src/lib/checkout-intake-cleanup.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const MEDIA_AUTHORIZED_AT = '2026-09-02T12:00:00.000Z';
const NOW = new Date('2026-09-02T12:30:00.000Z');
const AFTER_EXPIRY = new Date('2026-09-04T12:30:00.000Z');
const TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;
const HERO = { category: 'primary_hero_photo' } as const;
const ALICE = { category: 'family_pet_reference', familyCharacterId: 'char-alice' } as const;
const reserveSlotUpload = (
  store: Parameters<typeof reserveSlotUploadAt>[0],
  input: Parameters<typeof reserveSlotUploadAt>[1],
  now = NOW,
) => reserveSlotUploadAt(store, input, now);
const completeSlotUpload = (
  store: Parameters<typeof completeSlotUploadAt>[0],
  input: Parameters<typeof completeSlotUploadAt>[1],
  now = NOW,
) => completeSlotUploadAt(store, input, now);
const finalizeIntakeSelection = (
  store: Parameters<typeof finalizeIntakeSelectionAt>[0],
  input: Parameters<typeof finalizeIntakeSelectionAt>[1],
  now = NOW,
) => finalizeIntakeSelectionAt(store, input, now);

function testOrderId(hexDigit: string): string {
  return `ord_${hexDigit.repeat(16)}`;
}

interface DepOverrides {
  del?: (pathname: string, fallback: () => Promise<void>) => Promise<void>;
  reconcileFinalizationOrder?: CheckoutIntakeCleanupDeps['reconcileFinalizationOrder'];
}

function cleanupDeps(
  store: MemoryIntakeStore,
  deleted: string[],
  overrides: DepOverrides = {},
): CheckoutIntakeCleanupDeps {
  let claims = 0;
  const baseDelete = async (pathname: string) => {
    deleted.push(pathname);
    store.assets.delete(pathname);
    const match = /^intakes\/(intake_[a-f0-9]{32})\.json$/.exec(pathname);
    if (match) store.records.delete(match[1]!);
  };
  return {
    store,
    async list({ prefix }) {
      const blobs = [
        ...[...store.records.keys()].map((intakeId) => ({ pathname: intakeRecordPath(intakeId) })),
        ...[...store.assets.keys()].map((pathname) => ({ pathname })),
      ].filter((blob) => blob.pathname.startsWith(prefix));
      return { blobs, hasMore: false };
    },
    del: (pathname) => (overrides.del
      ? overrides.del(pathname, () => baseDelete(pathname))
      : baseDelete(pathname)),
    newClaimId() {
      claims += 1;
      return claims.toString(16).padStart(32, '0');
    },
    reconcileFinalizationOrder: overrides.reconcileFinalizationOrder ?? (async () => 'unknown'),
    claimFinalizedOrderMedia: async () => ({ status: 'retained' }),
    markFinalizedOrderMediaReclaimed: async () => ({ status: 'not_claimed' }),
  };
}

async function upload(
  store: MemoryIntakeStore,
  session: { intakeId: string; capability: string },
  slot: Parameters<typeof reserveSlotUpload>[1]['slot'],
  size = 1024,
) {
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot,
    mimeType: 'image/jpeg',
    size,
  }, NOW);
  const etag = `etag-${reservation.assetId}`;
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size, etag });
  await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size, etag },
  }, NOW);
  return reservation;
}

async function intakeWithHero(store: MemoryIntakeStore) {
  const session = await createIntake(store, { mediaAuthorizedAt: MEDIA_AUTHORIZED_AT }, NOW);
  const reservation = await upload(store, session, HERO);
  return { session, reservation };
}

function heroSelection(assetId: string) {
  return {
    primaryHeroPhotoAssetId: assetId,
    familyCharacterAssets: [],
    guidedStillAssetIds: [],
    voiceAssetId: null,
    documentAssetId: null,
  };
}

test('cleanup waits through the last possible upload-token lifetime after intake expiry', async () => {
  const store = createMemoryIntakeStore();
  const { session } = await intakeWithHero(store);
  const record = store.records.get(session.intakeId);
  assert.ok(record);
  const beforeTokenExpiry = new Date(Date.parse(record.record.expiresAt) + 2 * 60_000);
  const deleted: string[] = [];

  const result = await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: beforeTokenExpiry });

  assert.equal(store.records.has(session.intakeId), true);
  assert.equal(store.assets.size, 1);
  assert.deepEqual(result.deletedRecords, []);
  assert.deepEqual(result.deletedAssets, []);
});

test('an upload landing after the initial scan does not orphan bytes or poison the next run', async () => {
  const store = createMemoryIntakeStore();
  const { session } = await intakeWithHero(store);
  const deleted: string[] = [];

  // A reservation issued before this sweep whose bytes land mid-sweep — after
  // the global listing, before the record would be deleted.
  const late = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: ALICE,
    mimeType: 'image/jpeg',
    size: 4096,
  });

  let landed = false;
  const deps = cleanupDeps(store, deleted, {
    async del(pathname, fallback) {
      if (!landed) {
        landed = true;
        store.putAsset({ pathname: late.pathname, mimeType: 'image/jpeg', size: 4096, etag: 'etag-late' });
      }
      return fallback();
    },
  });

  await runCheckoutIntakeCleanup(deps, { now: AFTER_EXPIRY });

  const orphans = [...store.assets.keys()].filter(
    (pathname) => !store.records.has(/^intakes\/(intake_[a-f0-9]{32})\//.exec(pathname)?.[1] ?? ''),
  );
  assert.deepEqual(orphans, [], 'no object may be left without a record');

  // And the next global run must still be able to proceed.
  await assert.doesNotReject(
    runCheckoutIntakeCleanup(cleanupDeps(store, []), { now: AFTER_EXPIRY }),
  );
});

test('an object landing during every delete pass keeps the record after the final relist', async () => {
  const store = createMemoryIntakeStore();
  const { session } = await intakeWithHero(store);
  const deleted: string[] = [];
  let injected = 0;
  const deps = cleanupDeps(store, deleted, {
    async del(pathname, fallback) {
      if (pathname.includes('/assets/')) {
        injected += 1;
        const assetId = `asset_${String(injected).padStart(32, '0')}`;
        const latePath = `intakes/${session.intakeId}/assets/${assetId}`;
        store.putAsset({ pathname: latePath, mimeType: 'image/jpeg', size: 10, etag: `late-${injected}` });
      }
      return fallback();
    },
  });

  await runCheckoutIntakeCleanup(deps, { now: AFTER_EXPIRY });
  assert.ok(store.records.has(session.intakeId), 'record must explain the final late object');
  assert.ok(store.assets.size > 0, 'the final relist observed an object and deferred the record');
});

test('finalization cannot succeed merely because a cleanup claim lease elapsed mid-delete', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHero(store);
  const deleted: string[] = [];
  let finalizeError: unknown = null;
  const deps = cleanupDeps(store, deleted, {
    async del(pathname, fallback) {
      if (!finalizeError && pathname.includes('/assets/')) {
        const record = store.records.get(session.intakeId)!.record;
        const afterClaimExpiry = new Date(Date.parse(record.cleanupClaim!.expiresAt) + 1);
        finalizeError = await finalizeIntakeSelection(store, {
          intakeId: session.intakeId,
          capability: session.capability,
          checkoutAttemptId: 'f'.repeat(32),
          orderId: testOrderId('7'),
          familyCharacterIds: [],
          selection: heroSelection(reservation.assetId),
        }, afterClaimExpiry).then(() => null, (error) => error);
      }
      return fallback();
    },
  });

  await runCheckoutIntakeCleanup(deps, { now: AFTER_EXPIRY });
  assert.equal((finalizeError as { code?: string })?.code, 'intake_cleanup_in_progress');
});

test('a finalized order keeps exactly its selected media and reclaims the rest', async () => {
  const store = createMemoryIntakeStore();
  const session = await createIntake(store, { mediaAuthorizedAt: MEDIA_AUTHORIZED_AT }, NOW);
  const hero = await upload(store, session, HERO);
  // Uploaded but deliberately NOT selected for the order.
  const unselected = await upload(store, session, ALICE, 2048);

  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: 'a'.repeat(32),
    orderId: testOrderId('8'),
    familyCharacterIds: ['char-alice'],
    selection: heroSelection(hero.assetId),
  });
  await markIntakeFinalized(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    orderId: testOrderId('8'),
  });

  const deleted: string[] = [];
  const result = await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: AFTER_EXPIRY });

  assert.ok(store.assets.has(hero.pathname), 'the ordered photo is retained');
  assert.equal(store.assets.has(unselected.pathname), false, 'unselected private media is reclaimed');
  assert.ok(store.records.has(session.intakeId), 'the binding record is retained');
  assert.equal(result.retainedFinalized, 1);
});

test('an expired finalization remains fenced until explicit reconciliation', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHero(store);
  const at = new Date('2026-09-02T12:05:00.000Z');
  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: 'b'.repeat(32),
    orderId: testOrderId('9'),
    familyCharacterIds: [],
    selection: heroSelection(reservation.assetId),
  }, at);

  // While the lease is live the intake is left alone.
  const during = await runCheckoutIntakeCleanup(
    cleanupDeps(store, []),
    { now: new Date(at.getTime() + 60_000) },
  );
  assert.equal(during.skippedFinalizing, 1);

  // Once it lapses, cleanup still cannot infer that no order was created.
  const deleted: string[] = [];
  const after = await runCheckoutIntakeCleanup(
    cleanupDeps(store, deleted),
    { now: new Date(at.getTime() + INTAKE_FINALIZATION_LEASE_MS + 60_000) },
  );
  assert.equal(after.skippedFinalizing, 1);
  assert.equal(store.records.get(session.intakeId)!.record.finalization?.orderId, testOrderId('9'));
  assert.deepEqual(deleted, []);
});

test('a partial deletion failure keeps the record and is reported', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHero(store);
  const deleted: string[] = [];

  const result = await runCheckoutIntakeCleanup(
    cleanupDeps(store, deleted, {
      async del(pathname, fallback) {
        if (pathname === reservation.pathname) throw new Error('provider refused');
        return fallback();
      },
    }),
    { now: AFTER_EXPIRY },
  );

  assert.equal(result.deleteFailures, 1);
  assert.ok(store.records.has(session.intakeId), 'the record survives so the object stays explained');
  assert.ok(store.assets.has(reservation.pathname));

  // A later run with the provider healthy finishes the job.
  await runCheckoutIntakeCleanup(cleanupDeps(store, []), { now: AFTER_EXPIRY });
  assert.equal(store.records.has(session.intakeId), true, 'cleanup retains a CAS-fenced tombstone');
  assert.equal(store.assets.has(reservation.pathname), false);
  assert.deepEqual(store.records.get(session.intakeId)!.record.slots, {});
});

test('a failed claim release is surfaced rather than swallowed', async () => {
  const store = createMemoryIntakeStore();
  const session = await createIntake(store, { mediaAuthorizedAt: MEDIA_AUTHORIZED_AT }, NOW);
  const first = await upload(store, session, HERO);
  // Replace it so there is an orphan to reclaim on a LIVE intake, which is the
  // path that has to release its claim afterwards.
  await upload(store, session, HERO, 2048);

  let releaseAttempted = false;
  const failingRelease: MemoryIntakeStore = {
    ...store,
    async compareAndSwap(intakeId, etag, record) {
      if (record.cleanupClaim === null && !releaseAttempted) {
        releaseAttempted = true;
        return false;
      }
      return store.compareAndSwap(intakeId, etag, record);
    },
  };

  const result = await runCheckoutIntakeCleanup(
    cleanupDeps(failingRelease, []),
    { now: NOW },
  );

  assert.ok(releaseAttempted, 'the release was attempted');
  assert.equal(result.claimReleaseFailures, 1);
  assert.equal(store.assets.has(first.pathname), false, 'the orphan was still reclaimed');
});

test('a live cleanup claim from another runner is not stolen', async () => {
  const store = createMemoryIntakeStore();
  const { session } = await intakeWithHero(store);
  const snapshot = store.records.get(session.intakeId)!;
  const claimedAt = new Date(Math.max(NOW.getTime(), Date.parse(snapshot.record.updatedAt)));
  store.records.set(session.intakeId, {
    record: {
      ...snapshot.record,
      cleanupClaim: {
        claimId: 'f'.repeat(32),
        claimedAt: claimedAt.toISOString(),
        expiresAt: new Date(claimedAt.getTime() + 60_000).toISOString(),
      },
    },
    etag: snapshot.etag,
  });

  const deleted: string[] = [];
  const result = await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: NOW });
  assert.equal(result.skippedClaimContested, 1);
  assert.deepEqual(deleted, []);
});

test('cleanup retains a fenced tombstone instead of unconditionally deleting the record', async () => {
  const store = createMemoryIntakeStore();
  const { session } = await intakeWithHero(store);
  const deleted: string[] = [];
  let recordDeleteAttempted = false;
  const deps = cleanupDeps(store, deleted, {
    async del(pathname, fallback) {
      if (pathname === intakeRecordPath(session.intakeId)) recordDeleteAttempted = true;
      return fallback();
    },
  });
  await runCheckoutIntakeCleanup(deps, { now: AFTER_EXPIRY });
  assert.equal(recordDeleteAttempted, false);
  assert.equal(store.records.has(session.intakeId), true);
  const tombstone = store.records.get(session.intakeId)!.record;
  assert.deepEqual(tombstone.slots, {});
  assert.deepEqual(tombstone.superseded, []);
  assert.equal(tombstone.cleanupClaim, null);
});

test('a terminal cleanup tombstone is not rewritten and is deleted after bounded retention', async () => {
  const store = createMemoryIntakeStore();
  const { session } = await intakeWithHero(store);
  const deleted: string[] = [];
  await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: AFTER_EXPIRY });
  const firstUpdatedAt = store.records.get(session.intakeId)!.record.updatedAt;
  await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), {
    now: new Date(AFTER_EXPIRY.getTime() + TOMBSTONE_RETENTION_MS - 1),
  });
  assert.equal(store.records.get(session.intakeId)!.record.updatedAt, firstUpdatedAt);
  await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), {
    now: new Date(AFTER_EXPIRY.getTime() + TOMBSTONE_RETENTION_MS + 1),
  });
  assert.equal(store.records.has(session.intakeId), false);
  assert.ok(deleted.includes(intakeRecordPath(session.intakeId)));
});

test('an abandoned finalization is reclaimed only after authoritative order absence', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHero(store);
  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: 'a'.repeat(32),
    orderId: testOrderId('8'),
    familyCharacterIds: [],
    selection: {
      primaryHeroPhotoAssetId: reservation.assetId,
      familyCharacterAssets: [], guidedStillAssetIds: [], voiceAssetId: null, documentAssetId: null,
    },
  }, new Date('2026-09-02T12:30:00.000Z'));
  const deleted: string[] = [];
  await runCheckoutIntakeCleanup(cleanupDeps(store, deleted, {
    reconcileFinalizationOrder: async () => 'absent',
  }), { now: new Date('2026-11-02T12:30:00.000Z') });
  assert.equal(store.assets.has(reservation.pathname), false);
  assert.equal(store.records.get(session.intakeId)!.record.finalization, null);
});
