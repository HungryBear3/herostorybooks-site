/*
 * F1 — finalization must be ONE operation.
 *
 * The rejected candidate exposed finalization as three steps a caller had to
 * compose: validate a snapshot, compute a fingerprint, reserve against a
 * SECOND read. Two independent reviews reproduced the same thing from that
 * shape:
 *
 *   - validate hero A → replace it with B → reserve using A's fingerprint.
 *     The reservation succeeded while the slot held B (`toctouAccepted=true`).
 *     Nothing linked the validated version to the reserved one.
 *   - the validator accepted an active asset while a REPLACEMENT for the same
 *     slot was still pending, so an order could be placed against a photo the
 *     buyer was in the middle of changing.
 *   - the fingerprint hashed media bindings only, while the family index was
 *     derived from the current form order. `[alice,bob]` and `[bob,alice]`
 *     produced the same fingerprint and different persisted indexes, so an
 *     "idempotent" replay could mean a different book.
 *   - a crashed checkout left a finalization reservation with no lease, no
 *     abort path, and no takeover, fencing the intake — and cleanup — forever.
 *
 * These probes drive the single entry point, so the composition itself is what
 * is under test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createIntake,
  INTAKE_FINALIZATION_LEASE_MS,
  IntakeError,
  markIntakeFinalized,
  readIntake,
} from '../src/lib/checkout-intake.ts';
import { completeSlotUpload, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';

test('finalization result type exposes only statuses the implementation can return', () => {
  const source = readFileSync(new URL('../src/lib/checkout-finalize.ts', import.meta.url), 'utf8');
  assert.equal(source.includes("'taken_over'"), false);
});
import {
  abortIntakeFinalization,
  finalizeIntakeSelection,
  type CheckoutFinalizeSelection,
} from '../src/lib/checkout-finalize.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const HERO = { category: 'primary_hero_photo' } as const;
const ALICE = { category: 'family_pet_reference', familyCharacterId: 'char-alice' } as const;
const BRUNO = { category: 'family_pet_reference', familyCharacterId: 'char-bruno' } as const;
const ATTEMPT = 'a'.repeat(32);

function testOrderId(hexDigit: string): string {
  return `ord_${hexDigit.repeat(16)}`;
}

function emptySelection(): CheckoutFinalizeSelection {
  return {
    primaryHeroPhotoAssetId: null,
    familyCharacterAssets: [],
    guidedStillAssetIds: [],
    voiceAssetId: null,
    documentAssetId: null,
  };
}

function code(error: unknown): string {
  assert.ok(error instanceof IntakeError, `expected IntakeError, got ${String(error)}`);
  return error.code;
}

async function newSession(store: MemoryIntakeStore) {
  return createIntake(store, { mediaAuthorizedAt: '2026-09-02T12:00:00.000Z' });
}

async function reserve(
  store: MemoryIntakeStore,
  session: { intakeId: string; capability: string },
  slot: Parameters<typeof reserveSlotUpload>[1]['slot'],
  size = 1024,
) {
  return reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot,
    mimeType: 'image/jpeg',
    size,
  });
}

async function upload(
  store: MemoryIntakeStore,
  session: { intakeId: string; capability: string },
  slot: Parameters<typeof reserveSlotUpload>[1]['slot'],
  size = 1024,
) {
  const reservation = await reserve(store, session, slot, size);
  const etag = `etag-${reservation.assetId}`;
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size, etag });
  await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size, etag },
  });
  return reservation;
}

// ---------------------------------------------------------------------------
// Probe 1 — validate A, replace with B, reserve using A
// ---------------------------------------------------------------------------

test('a replacement landing mid-finalization makes the finalization fail', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const heroA = await upload(store, session, HERO);

  // Between the read that validates the selection and the write that reserves
  // it, hero B lands. Under the split API the reservation still succeeded.
  store.interleaveBeforeNextCas(async () => {
    const heroB = await reserve(store, session, HERO, 2048);
    store.putAsset({ pathname: heroB.pathname, mimeType: 'image/jpeg', size: 2048, etag: 'etag-b' });
    await completeSlotUpload(store, {
      tokenPayload: heroB.tokenPayload,
      blob: { pathname: heroB.pathname, contentType: 'image/jpeg', size: 2048, etag: 'etag-b' },
    });
  });

  await assert.rejects(
    finalizeIntakeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: ATTEMPT,
      orderId: testOrderId('1'),
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: heroA.assetId },
    }),
    (error) => code(error) === 'intake_finalization_conflict',
  );

  const stored = store.records.get(session.intakeId)!.record;
  assert.equal(stored.finalization, null, 'nothing was reserved against the stale selection');
});

// ---------------------------------------------------------------------------
// Probe 2 — pending replacement blocks finalization
// ---------------------------------------------------------------------------

test('finalization is refused while any slot has a pending replacement', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const heroA = await upload(store, session, HERO);
  // Hero B is reserved but has not landed. A is deliberately still active.
  await reserve(store, session, HERO, 2048);

  await assert.rejects(
    finalizeIntakeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: ATTEMPT,
      orderId: testOrderId('1'),
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: heroA.assetId },
    }),
    (error) => code(error) === 'intake_replacement_pending',
  );
});

test('a pending upload in an UNSELECTED slot also blocks finalization', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  // The buyer is still uploading a family photo they have not selected.
  await reserve(store, session, ALICE, 2048);

  await assert.rejects(
    finalizeIntakeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: ATTEMPT,
      orderId: testOrderId('1'),
      familyCharacterIds: ['char-alice'],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
    }),
    (error) => code(error) === 'intake_replacement_pending',
  );
});

// ---------------------------------------------------------------------------
// Probe 3 — family order is part of the order's identity
// ---------------------------------------------------------------------------

test('the same media in a different family order is a DIFFERENT finalization', async () => {
  const build = async (familyCharacterIds: string[]) => {
    const store = createMemoryIntakeStore();
    const session = await newSession(store);
    const alice = await upload(store, session, ALICE);
    const bruno = await upload(store, session, BRUNO, 2048);
    const result = await finalizeIntakeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: ATTEMPT,
      orderId: testOrderId('1'),
      familyCharacterIds,
      selection: {
        ...emptySelection(),
        familyCharacterAssets: [
          { assetId: alice.assetId, familyCharacterId: 'char-alice' },
          { assetId: bruno.assetId, familyCharacterId: 'char-bruno' },
        ],
      },
    });
    return result.finalization;
  };

  const forward = await build(['char-alice', 'char-bruno']);
  const reversed = await build(['char-bruno', 'char-alice']);

  assert.notEqual(
    forward.fingerprint,
    reversed.fingerprint,
    'a different derived index order is a different book',
  );
  const indexOf = (f: typeof forward, id: string) =>
    f.selection.find((entry) => entry.familyCharacterId === id)?.familyCharacterIndex;
  assert.equal(indexOf(forward, 'char-alice'), 0);
  assert.equal(indexOf(reversed, 'char-alice'), 1);
});

test('the exact selected media tuple is persisted, not just a fingerprint', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);

  const result = await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: testOrderId('1'),
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  });

  const stored = store.records.get(session.intakeId)!.record.finalization!;
  assert.equal(stored.selection.length, 1);
  const entry = stored.selection[0]!;
  assert.equal(entry.assetId, hero.assetId);
  assert.equal(entry.pathname, hero.pathname);
  assert.equal(entry.mimeType, 'image/jpeg');
  assert.equal(entry.size, 1024);
  assert.equal(entry.etag, `etag-${hero.assetId}`);
  assert.equal(entry.slotKey, 'primary_hero_photo');
  assert.equal(entry.generation, 1);
  assert.equal(result.finalization.fingerprint.length, 64);
});

test('a multi-asset finalization round-trips through the strict durable parser', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const alice = await upload(store, session, ALICE);

  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: testOrderId('3'),
    familyCharacterIds: ['char-alice'],
    selection: {
      ...emptySelection(),
      primaryHeroPhotoAssetId: hero.assetId,
      familyCharacterAssets: [{ assetId: alice.assetId, familyCharacterId: 'char-alice' }],
    },
  });

  await assert.doesNotReject(readIntake(store, session.intakeId));
});

test('a caller cannot supply the fingerprint', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);

  const result = await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: testOrderId('1'),
    familyCharacterIds: [],
    // A hostile extra field must have no effect on the stored identity.
    fingerprint: 'f'.repeat(64),
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  } as never);

  assert.notEqual(result.finalization.fingerprint, 'f'.repeat(64));
});

// ---------------------------------------------------------------------------
// Idempotency and conflict
// ---------------------------------------------------------------------------

test('the same attempt and the same selection is idempotent', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const params = {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: testOrderId('1'),
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  };

  const first = await finalizeIntakeSelection(store, params);
  const second = await finalizeIntakeSelection(store, params);
  assert.equal(first.status, 'reserved');
  assert.equal(second.status, 'idempotent');
  assert.equal(second.finalization.fingerprint, first.finalization.fingerprint);
});

test('the same attempt with a different order is a conflict', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const base = {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  };

  await finalizeIntakeSelection(store, { ...base, orderId: testOrderId('1') });
  await assert.rejects(
    finalizeIntakeSelection(store, { ...base, orderId: testOrderId('2') }),
    (error) => code(error) === 'intake_finalization_conflict',
  );
});

// ---------------------------------------------------------------------------
// Probe 4 — a crashed finalization recovers deterministically
// ---------------------------------------------------------------------------

test('an expired finalization lease requires reconciliation and cannot be taken over', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const at = new Date('2026-09-02T12:05:00.000Z');
  const base = {
    intakeId: session.intakeId,
    capability: session.capability,
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  };

  const crashed = await finalizeIntakeSelection(
    store,
    { ...base, checkoutAttemptId: ATTEMPT, orderId: testOrderId('4') },
    at,
  );
  assert.equal(crashed.status, 'reserved');

  // While the lease is live nobody else may finalize.
  await assert.rejects(
    finalizeIntakeSelection(
      store,
      { ...base, checkoutAttemptId: 'b'.repeat(32), orderId: testOrderId('5') },
      new Date(at.getTime() + 60_000),
    ),
    (error) => code(error) === 'intake_finalization_conflict',
  );

  // Expiry is not evidence that the first consequential order was never
  // created. A fresh attempt must stop for reconciliation rather than create a
  // second order.
  const persistedLease = store.records.get(session.intakeId)!.record.finalization!.leaseExpiresAt;
  const after = new Date(Date.parse(persistedLease) + 1000);
  await assert.rejects(
    finalizeIntakeSelection(
      store,
      { ...base, checkoutAttemptId: 'b'.repeat(32), orderId: testOrderId('5') },
      after,
    ),
    (error) => code(error) === 'intake_finalization_reconciliation_required',
  );

  // The recorded order can still reconcile after response loss, even though
  // its lease elapsed. No replacement reservation was written.
  await assert.doesNotReject(markIntakeFinalized(
    store,
    { intakeId: session.intakeId, capability: session.capability, orderId: testOrderId('4') },
    after,
  ));
  assert.equal(store.records.get(session.intakeId)!.record.finalizedOrderId, testOrderId('4'));
});

test('only the owning attempt may explicitly abort an expired reservation', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const at = new Date('2026-09-02T12:05:00.000Z');
  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: testOrderId('6'),
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  }, at);

  const after = new Date(at.getTime() + INTAKE_FINALIZATION_LEASE_MS + 1000);
  await assert.rejects(
    abortIntakeFinalization(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: 'b'.repeat(32),
    }, after),
    (error) => code(error) === 'intake_finalization_conflict',
  );
  assert.ok(store.records.get(session.intakeId)!.record.finalization);
});

test('an abandoned finalization can be explicitly aborted before its lease expires', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const base = {
    intakeId: session.intakeId,
    capability: session.capability,
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  };

  await finalizeIntakeSelection(store, { ...base, checkoutAttemptId: ATTEMPT, orderId: testOrderId('1') });

  // A different attempt cannot abort someone else's reservation.
  await assert.rejects(
    abortIntakeFinalization(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: 'c'.repeat(32),
    }),
    (error) => code(error) === 'intake_finalization_conflict',
  );

  await abortIntakeFinalization(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
  });
  assert.equal(store.records.get(session.intakeId)!.record.finalization, null);

  // The intake is usable again: uploads resume and a new order can finalize.
  await assert.doesNotReject(reserve(store, session, ALICE, 2048));
});

test('a finalized intake is closed to further finalization and further uploads', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const base = {
    intakeId: session.intakeId,
    capability: session.capability,
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  };

  await finalizeIntakeSelection(store, { ...base, checkoutAttemptId: ATTEMPT, orderId: testOrderId('1') });
  await markIntakeFinalized(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    orderId: testOrderId('1'),
  });

  await assert.rejects(
    finalizeIntakeSelection(store, { ...base, checkoutAttemptId: 'd'.repeat(32), orderId: testOrderId('2') }),
    (error) => code(error) === 'intake_already_finalized',
  );
  await assert.rejects(
    reserve(store, session, ALICE, 2048),
    (error) => code(error) === 'intake_already_finalized',
  );
  // Replaying the winning order stays idempotent.
  const replay = await finalizeIntakeSelection(store, { ...base, checkoutAttemptId: ATTEMPT, orderId: testOrderId('1') });
  assert.equal(replay.status, 'idempotent');
});

test('malformed or omitted optional selection values fail closed', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const base = { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId };
  for (const selection of [
    { ...base, primaryHeroPhotoAssetId: '' },
    { ...base, voiceAssetId: '' },
    { ...base, documentAssetId: undefined },
    { ...base, unexpected: null },
  ]) {
    await assert.rejects(
      finalizeIntakeSelection(store, {
        intakeId: session.intakeId, capability: session.capability,
        checkoutAttemptId: 'd'.repeat(32), orderId: `ord_${'d'.repeat(16)}`,
        familyCharacterIds: [], selection: selection as never,
      }),
      (error) => code(error) === 'asset_selection_invalid',
    );
  }
});

test('the finalization writer refuses an oversized or noncanonical order identity', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  await assert.rejects(
    finalizeIntakeSelection(store, {
      intakeId: session.intakeId, capability: session.capability,
      checkoutAttemptId: 'e'.repeat(32), orderId: `ord_${'e'.repeat(300_000)}`,
      familyCharacterIds: [], selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
    }),
    (error) => code(error) === 'order_reference_invalid',
  );
});

test('an expired but unresolved finalization still fences new upload reservations', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const startedAt = new Date('2026-09-02T12:30:00.000Z');
  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: testOrderId('1'),
    familyCharacterIds: [],
    selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
  }, startedAt);
  await assert.rejects(
    reserveSlotUpload(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      slot: ALICE,
      mimeType: 'image/jpeg',
      size: 1024,
    }, new Date(startedAt.getTime() + INTAKE_FINALIZATION_LEASE_MS + 1)),
    (error) => code(error) === 'intake_finalization_started',
  );
});

test('duplicate stable family character ids are rejected before index construction', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const alice = await upload(store, session, ALICE);
  await assert.rejects(
    finalizeIntakeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      checkoutAttemptId: ATTEMPT,
      orderId: testOrderId('2'),
      familyCharacterIds: ['char-alice', 'char-alice'],
      selection: {
        ...emptySelection(),
        familyCharacterAssets: [{ familyCharacterId: 'char-alice', assetId: alice.assetId }],
      },
    }),
    (error) => code(error) === 'family_character_identity_duplicate',
  );
});
