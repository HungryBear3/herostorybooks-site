/*
 * Checkout intake cleanup — it must never race finalization.
 *
 * The rejected candidate read a snapshot, checked `finalizedOrderId` once, and
 * then deleted unconditionally. A probe that finalized the intake AFTER that
 * read but BEFORE the deletes still lost both the record and the asset:
 *
 *   {"finalizedOrderIdAfterRace":"ord_paid",
 *    "deleted":["intakes/….json","intakes/…/assets/asset_…"],
 *    "skippedFinalized":0}
 *
 * That is a paid order losing its hero photo. The fix is a conditional CLAIM:
 * cleanup CAS-writes a claim against the exact version it read, and
 * finalization refuses to proceed while a live claim exists. Whichever write
 * lands first, the other is refused — there is no interleaving where both
 * succeed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntake,
  intakeRecordPath,
  markIntakeFinalized,
  type IntakeRecord,
} from '../src/lib/checkout-intake.ts';
import { finalizeIntakeSelection as finalizeIntakeSelectionAt } from '../src/lib/checkout-finalize.ts';
import {
  completeSlotUpload as completeSlotUploadAt,
  releaseSlot as releaseSlotAt,
  reserveSlotUpload as reserveSlotUploadAt,
} from '../src/lib/checkout-intake-upload.ts';
import {
  runCheckoutIntakeCleanup,
  type CheckoutIntakeCleanupDeps,
} from '../src/lib/checkout-intake-cleanup.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const MEDIA_AUTHORIZED_AT = '2026-09-02T12:00:00.000Z';
const NOW = new Date('2026-09-02T12:30:00.000Z');
const AFTER_EXPIRY = new Date('2026-09-04T12:30:00.000Z');
const HERO = { category: 'primary_hero_photo' } as const;
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
const releaseSlot = (
  store: Parameters<typeof releaseSlotAt>[0],
  input: Parameters<typeof releaseSlotAt>[1],
  now = NOW,
) => releaseSlotAt(store, input, now);
const finalizeIntakeSelection = (
  store: Parameters<typeof finalizeIntakeSelectionAt>[0],
  input: Parameters<typeof finalizeIntakeSelectionAt>[1],
  now = NOW,
) => finalizeIntakeSelectionAt(store, input, now);

function testOrderId(hexDigit: string): string {
  return `ord_${hexDigit.repeat(16)}`;
}

function cleanupDeps(store: MemoryIntakeStore, deleted: string[]): CheckoutIntakeCleanupDeps {
  let claims = 0;
  return {
    store,
    async list({ prefix, cursor }) {
      assert.equal(cursor, undefined, 'the fake store returns a single page');
      const blobs = [
        ...[...store.records.keys()].map((intakeId) => ({ pathname: intakeRecordPath(intakeId) })),
        ...[...store.assets.keys()].map((pathname) => ({ pathname })),
      ].filter((blob) => blob.pathname.startsWith(prefix));
      return { blobs, hasMore: false };
    },
    async del(pathname) {
      deleted.push(pathname);
      store.assets.delete(pathname);
      const match = /^intakes\/(intake_[a-f0-9]{32})\.json$/.exec(pathname);
      if (match) store.records.delete(match[1]!);
    },
    newClaimId() {
      claims += 1;
      return claims.toString(16).padStart(32, '0');
    },
    reconcileFinalizationOrder: async () => 'unknown',
    claimFinalizedOrderMedia: async () => ({ status: 'retained' }),
    markFinalizedOrderMediaReclaimed: async () => ({ status: 'not_claimed' }),
  };
}

async function intakeWithHeroPhoto(store: MemoryIntakeStore) {
  const session = await createIntake(store, { mediaAuthorizedAt: MEDIA_AUTHORIZED_AT }, NOW);
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  }, NOW);
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 1024, etag: 'etag-a' });
  await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 1024, etag: 'etag-a' },
  }, NOW);
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

function currentRecord(store: MemoryIntakeStore, intakeId: string): IntakeRecord {
  return store.records.get(intakeId)!.record;
}

test('media belonging to a finalized order is never deleted', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHeroPhoto(store);
  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: 'a'.repeat(32),
    orderId: testOrderId('8'),
    familyCharacterIds: [],
    selection: heroSelection(reservation.assetId),
  });
  await markIntakeFinalized(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    orderId: testOrderId('8'),
  });

  const deleted: string[] = [];
  // Well past expiry: an expired-but-finalized intake is still off limits.
  const result = await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: AFTER_EXPIRY });

  assert.deepEqual(deleted, [], 'nothing the order bound is deleted');
  // The intake is not skipped any more — it is retained SELECTIVELY. Here the
  // ordered photo is the only object, so nothing is reclaimable.
  assert.equal(result.retainedFinalized, 1);
  assert.ok(store.assets.has(reservation.pathname), 'the paid order still has its photo');
});

test('a finalization that lands between the cleanup read and its claim wins', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHeroPhoto(store);
  const deleted: string[] = [];

  // Exactly the probe that broke the rejected candidate: finalize after
  // cleanup has read the record, before it deletes anything.
  store.interleaveBeforeNextCas(async () => {
    await finalizeIntakeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: 'b'.repeat(32),
      orderId: testOrderId('8'),
      familyCharacterIds: [],
      selection: heroSelection(reservation.assetId),
    });
    await markIntakeFinalized(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      orderId: testOrderId('8'),
    });
  });

  const result = await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: AFTER_EXPIRY });

  assert.deepEqual(deleted, [], 'nothing was deleted out from under the finalized order');
  assert.equal(currentRecord(store, session.intakeId).finalizedOrderId, testOrderId('8'));
  assert.ok(store.assets.has(reservation.pathname));
  assert.equal(result.skippedClaimContested, 1);
});

test('finalization is refused while a cleanup claim is live', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHeroPhoto(store);
  const deleted: string[] = [];

  let finalizeError: unknown = null;
  // Now the other interleaving: cleanup claims first, and the finalization
  // attempt arrives afterwards.
  const deps = cleanupDeps(store, deleted);
  const withFinalizeAttempt: CheckoutIntakeCleanupDeps = {
    ...deps,
    async del(pathname) {
      if (!finalizeError) {
        finalizeError = await finalizeIntakeSelection(store, {
          intakeId: session.intakeId,
          capability: session.capability,
          checkoutAttemptId: 'c'.repeat(32),
          orderId: testOrderId('a'),
          familyCharacterIds: [],
          selection: heroSelection(reservation.assetId),
        }, AFTER_EXPIRY).then(() => null, (error) => error);
      }
      return deps.del(pathname);
    },
  };

  await runCheckoutIntakeCleanup(withFinalizeAttempt, { now: AFTER_EXPIRY });

  assert.ok(finalizeError, 'the finalization attempt was refused');
  assert.equal((finalizeError as { code?: string }).code, 'intake_cleanup_in_progress');
  assert.ok(deleted.length > 0, 'cleanup proceeded once it held the claim');
});

test('an expired intake loses every object and retains a fenced tombstone record', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHeroPhoto(store);
  const deleted: string[] = [];

  await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: AFTER_EXPIRY });

  assert.ok(deleted.includes(reservation.pathname));
  assert.equal(deleted.includes(intakeRecordPath(session.intakeId)), false);
  assert.equal(store.records.has(session.intakeId), true);
  assert.deepEqual(currentRecord(store, session.intakeId).slots, {});
  assert.equal(currentRecord(store, session.intakeId).cleanupClaim, null);
});

test('a live intake keeps its active asset and loses only orphaned bytes', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation: kept } = await intakeWithHeroPhoto(store);

  // A stale-callback orphan: bytes landed for a generation that was already
  // superseded, so they belong to no slot.
  const orphan = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 2048,
  });
  store.putAsset({ pathname: orphan.pathname, mimeType: 'image/jpeg', size: 2048, etag: 'etag-b' });
  await releaseSlot(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
  });
  // Re-add the photo so the slot is occupied again by something current.
  const current = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 4096,
  });
  store.putAsset({ pathname: current.pathname, mimeType: 'image/jpeg', size: 4096, etag: 'etag-c' });
  await completeSlotUpload(store, {
    tokenPayload: current.tokenPayload,
    blob: { pathname: current.pathname, contentType: 'image/jpeg', size: 4096, etag: 'etag-c' },
  });

  const deleted: string[] = [];
  await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: NOW });

  assert.ok(store.assets.has(current.pathname), 'the current selection survives');
  assert.equal(store.assets.has(orphan.pathname), false, 'the orphan is reclaimed');
  assert.equal(store.assets.has(kept.pathname), false, 'the replaced photo is reclaimed');
  assert.ok(store.records.has(session.intakeId), 'a live intake keeps its record');
});

test('a live intake has its cleanup claim released afterwards', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHeroPhoto(store);
  await runCheckoutIntakeCleanup(cleanupDeps(store, []), { now: NOW });

  assert.equal(currentRecord(store, session.intakeId).cleanupClaim, null);
  // And finalization works again.
  await assert.doesNotReject(finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: 'd'.repeat(32),
    orderId: testOrderId('b'),
    familyCharacterIds: [],
    selection: heroSelection(reservation.assetId),
  }));
});

test('an intake being finalized is left alone', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHeroPhoto(store);
  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: 'e'.repeat(32),
    orderId: testOrderId('c'),
    familyCharacterIds: [],
    selection: heroSelection(reservation.assetId),
  });

  const deleted: string[] = [];
  const result = await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), { now: NOW });

  assert.deepEqual(deleted, []);
  assert.equal(result.skippedFinalizing, 1);
  assert.ok(store.assets.has(reservation.pathname));
});

test('dryRun reports the plan without deleting anything', async () => {
  const store = createMemoryIntakeStore();
  const { session, reservation } = await intakeWithHeroPhoto(store);
  const deleted: string[] = [];

  const result = await runCheckoutIntakeCleanup(cleanupDeps(store, deleted), {
    now: AFTER_EXPIRY,
    dryRun: true,
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(deleted, []);
  assert.ok(result.deletedAssets.includes(reservation.pathname));
  assert.ok(store.records.has(session.intakeId));
  assert.equal(currentRecord(store, session.intakeId).cleanupClaim, null, 'a dry run leaves no claim behind');
});

test('an ambiguous listing aborts instead of guessing', async () => {
  const store = createMemoryIntakeStore();
  await intakeWithHeroPhoto(store);
  const base = cleanupDeps(store, []);

  // A provider that keeps handing back the same cursor would otherwise loop
  // forever or silently truncate the plan.
  await assert.rejects(
    runCheckoutIntakeCleanup(
      { ...base, list: async () => ({ blobs: [], hasMore: true, cursor: 'same' }) },
      { now: NOW },
    ),
    /ambiguous/,
  );

  // An asset with no record at all is unexplained state, not junk to delete.
  store.putAsset({
    pathname: `intakes/intake_${'f'.repeat(32)}/assets/asset_${'0'.repeat(32)}`,
    mimeType: 'image/jpeg',
    size: 10,
    etag: 'e',
  });
  await assert.rejects(runCheckoutIntakeCleanup(base, { now: NOW }), /ambiguous/);
});
