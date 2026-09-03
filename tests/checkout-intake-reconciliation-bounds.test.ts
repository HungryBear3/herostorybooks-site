/**
 * Closes the two non-blocking coverage advisories left open on the foundation
 * review of the unpaid-media reclamation path.
 *
 * Both are about the ONE decision that can destroy a buyer's private media
 * before their order exists: promoting an unresolved finalization to
 * "reclaimable". The reviewed rule is that only an authoritative `exact` or
 * `absent` answer may move the record, and that the question is only asked
 * after the abandonment bound. Neither the throwing-lookup arm nor the
 * before-the-bound arm had a shipped regression, so a refactor could have
 * turned an outage into deletion, or moved the clock, without any test noticing.
 *
 * These tests assert the media, the record, and the reservation all survive —
 * not just a counter — because the counter is what a refactor would keep.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntake,
  intakeRecordPath,
  type IntakeStore,
} from '../src/lib/checkout-intake.ts';
import { finalizeIntakeSelection } from '../src/lib/checkout-finalize.ts';
import { completeSlotUpload, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import {
  INTAKE_FINALIZATION_ABANDONMENT_MS,
  runCheckoutIntakeCleanup,
  type CheckoutIntakeCleanupDeps,
} from '../src/lib/checkout-intake-cleanup.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ORDER_ID = ['ord', '0123456789abcdef'].join('_');
const ATTEMPT = 'b'.repeat(32);
const RESERVED_AT = new Date('2026-01-01T00:00:00.000Z');

/**
 * An intake that reserved a finalization and never got its `markIntakeFinalized`
 * acknowledgement — the exact state whose resolution needs an authoritative
 * order lookup. It holds one real object so "preserved" can be asserted on
 * bytes rather than on a flag.
 */
async function markPendingIntakeWithMedia() {
  const store = createMemoryIntakeStore();
  const session = await createIntake(store, { mediaAuthorizedAt: RESERVED_AT.toISOString() }, RESERVED_AT);
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: { category: 'primary_hero_photo' },
    mimeType: 'image/jpeg',
    size: 2048,
  }, RESERVED_AT);
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 2048, etag: 'hero-etag' });
  await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 2048, etag: 'hero-etag' },
  }, RESERVED_AT);
  const finalized = await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: ORDER_ID,
    familyCharacterIds: [],
    selection: {
      primaryHeroPhotoAssetId: reservation.assetId,
      familyCharacterAssets: [],
      guidedStillAssetIds: [],
      voiceAssetId: null,
      documentAssetId: null,
    },
  }, RESERVED_AT);
  return { store, session, reservation, finalization: finalized.finalization };
}

interface ReconcileProbe {
  deps: CheckoutIntakeCleanupDeps;
  calls: number;
}

function cleanupDeps(
  store: MemoryIntakeStore,
  reconcile: CheckoutIntakeCleanupDeps['reconcileFinalizationOrder'],
): ReconcileProbe {
  const probe = {
    calls: 0,
    deps: {
      store: store as IntakeStore,
      async list({ prefix }: { prefix: string }) {
        return {
          blobs: [
            ...[...store.records.keys()].map((id) => ({ pathname: intakeRecordPath(id) })),
            ...[...store.assets.keys()].map((pathname) => ({ pathname })),
          ].filter((blob) => blob.pathname.startsWith(prefix)),
          hasMore: false,
        };
      },
      async del(pathname: string) {
        store.assets.delete(pathname);
        const match = /^intakes\/(intake_[a-f0-9]{32})\.json$/.exec(pathname);
        if (match) store.records.delete(match[1]!);
      },
      newClaimId: () => 'f'.repeat(32),
      async reconcileFinalizationOrder(params) {
        probe.calls += 1;
        return reconcile(params);
      },
      async claimFinalizedOrderMedia() {
        throw new Error('the order store must not be touched on an unresolved finalization');
      },
      async markFinalizedOrderMediaReclaimed() {
        throw new Error('the order store must not be touched on an unresolved finalization');
      },
    } as CheckoutIntakeCleanupDeps,
  };
  return probe;
}

test('a throwing authoritative order lookup is treated as unknown and preserves the media past the bound', async () => {
  const { store, session, reservation, finalization } = await markPendingIntakeWithMedia();
  const probe = cleanupDeps(store, async () => {
    throw new Error('order store unavailable');
  });
  const wellPastTheBound = new Date(
    Date.parse(finalization.leaseExpiresAt) + INTAKE_FINALIZATION_ABANDONMENT_MS + 60_000,
  );

  const result = await runCheckoutIntakeCleanup(probe.deps, { now: wellPastTheBound });

  // The question WAS asked — otherwise this would be testing the not-due arm.
  assert.equal(probe.calls, 1, 'reconciliation must be attempted past the bound');
  assert.equal(result.skippedFinalizing, 1);
  assert.deepEqual(result.deletedAssets, []);
  assert.deepEqual(result.deletedRecords, []);

  const stored = store.records.get(session.intakeId)?.record;
  assert.equal(store.assets.has(reservation.pathname), true, 'private media must survive an unreadable order store');
  assert.equal(stored?.finalizedOrderId, null, 'an unreadable lookup may not promote the binding');
  assert.equal(stored?.finalization?.orderId, ORDER_ID, 'an unreadable lookup may not clear the reservation');
  assert.equal(stored?.finalization?.fingerprint, finalization.fingerprint);
  assert.equal(stored?.slots.primary_hero_photo?.active?.assetId, reservation.assetId);
});

test('a finalization that has not reached the abandonment bound is preserved without any order lookup', async () => {
  const { store, session, reservation, finalization } = await markPendingIntakeWithMedia();
  const probe = cleanupDeps(store, async () => 'absent');
  // The last instant at which reclamation is still refused. `absent` above is
  // the one answer that WOULD clear the reservation, so reaching the lookup at
  // all would be visible here.
  const oneMsBeforeTheBound = new Date(
    Date.parse(finalization.leaseExpiresAt) + INTAKE_FINALIZATION_ABANDONMENT_MS - 1,
  );

  const result = await runCheckoutIntakeCleanup(probe.deps, { now: oneMsBeforeTheBound });

  assert.equal(probe.calls, 0, 'the order store must not be consulted before the bound');
  assert.equal(result.skippedFinalizing, 1);
  assert.deepEqual(result.deletedAssets, []);
  assert.deepEqual(result.deletedRecords, []);

  const stored = store.records.get(session.intakeId)?.record;
  assert.equal(store.assets.has(reservation.pathname), true);
  assert.equal(stored?.finalizedOrderId, null);
  assert.equal(stored?.finalization?.orderId, ORDER_ID);
  assert.equal(stored?.finalization?.reservedAt, finalization.reservedAt);
});
