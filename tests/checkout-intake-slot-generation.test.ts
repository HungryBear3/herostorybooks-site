/*
 * Slot generation fencing — the core invariant of the checkout upload state
 * machine.
 *
 * Every upload slot (hero photo, one family/pet character, one guided still,
 * the voice note, the inspiration document) carries a server-authoritative
 * monotonic generation. Reserving an upload bumps it. A completion callback
 * carries the generation it was issued for, and is only allowed to change slot
 * state when that generation is still current.
 *
 * These are regressions for three findings against the rejected candidate,
 * whose state machine was keyed on a content-derived asset id and ordered by
 * callback ARRIVAL:
 *
 *   - A late callback for a replaced photo resurrected the old selection and
 *     it was then listed active and accepted by finalization.
 *   - A lost hero callback left an unresolved reservation that counted against
 *     the single-hero limit, so Change/Remove/reselect could not save a
 *     replacement.
 *   - Removal only invalidated client-local state, so nothing on the server
 *     stopped an in-flight upload from landing afterwards.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntake,
  listIntakeSlots,
  parseIntakeRecord,
  refreshIntakeConsent,
} from '../src/lib/checkout-intake.ts';
import {
  completeSlotUpload,
  parseUploadTokenPayload,
  releaseSlot,
  reserveSlotUpload,
} from '../src/lib/checkout-intake-upload.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const MEDIA_AUTHORIZED_AT = '2026-09-02T12:00:00.000Z';
const HERO = { category: 'primary_hero_photo' } as const;

async function newIntake(store: MemoryIntakeStore) {
  return createIntake(store, { mediaAuthorizedAt: MEDIA_AUTHORIZED_AT });
}

test('upload token parser rejects unknown authority fields', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });
  const payload = JSON.parse(reservation.tokenPayload);
  assert.throws(
    () => parseUploadTokenPayload(JSON.stringify({ ...payload, unexpectedAuthority: true })),
    (error) => error instanceof Error && 'code' in error && error.code === 'upload_token_payload_invalid',
  );
});

/** Reserve, then land the bytes and fire the completion callback. */
async function reserveAndComplete(
  store: MemoryIntakeStore,
  session: { intakeId: string; capability: string },
  slot: Parameters<typeof reserveSlotUpload>[1]['slot'],
  overrides: { size?: number; mimeType?: string; etag?: string } = {},
) {
  const size = overrides.size ?? 1024;
  const mimeType = overrides.mimeType ?? 'image/jpeg';
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot,
    mimeType,
    size,
  });
  const etag = overrides.etag ?? `etag-${reservation.assetId}`;
  store.putAsset({ pathname: reservation.pathname, mimeType, size, etag });
  const completion = await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: mimeType, size, etag },
  });
  return { reservation, completion, etag };
}

test('slot generation increases monotonically across reservations', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const first = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });
  const second = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 2048,
  });
  const third = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/png',
    size: 4096,
  });

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(third.generation, 3);
  assert.equal(first.slotKey, 'primary_hero_photo');
  assert.equal(second.slotKey, 'primary_hero_photo');

  // Each generation gets its own destination, so a late upload can never
  // overwrite the bytes of a newer one.
  assert.notEqual(first.pathname, second.pathname);
  assert.notEqual(second.pathname, third.pathname);
});

test('lost hero callback does not block reselecting a replacement', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  // Hero A is reserved and its callback never arrives.
  const abandoned = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });

  // The buyer picks hero B. Under the rejected candidate this threw
  // `asset_count_exceeded` because the unresolved reservation still counted
  // against the single-hero limit.
  const replacement = await reserveAndComplete(store, session, HERO, { size: 2048 });

  assert.equal(replacement.completion.status, 'activated');
  assert.equal(replacement.reservation.generation, abandoned.generation + 1);

  const { slots } = await listIntakeSlots(store, session);
  const hero = slots.find((slot) => slot.slotKey === 'primary_hero_photo');
  assert.ok(hero, 'hero slot is present');
  assert.equal(hero.asset?.assetId, replacement.reservation.assetId);
  assert.equal(hero.pendingGeneration, null, 'the abandoned reservation is gone');
});

test('a late callback for a superseded generation never activates or resurrects', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  // Old selection reserved but its callback is still in flight.
  const old = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });
  store.putAsset({ pathname: old.pathname, mimeType: 'image/jpeg', size: 1024, etag: 'etag-old' });

  // New selection reserved and completed first.
  const fresh = await reserveAndComplete(store, session, HERO, { size: 2048 });
  assert.equal(fresh.completion.status, 'activated');

  // The old callback finally lands.
  const late = await completeSlotUpload(store, {
    tokenPayload: old.tokenPayload,
    blob: { pathname: old.pathname, contentType: 'image/jpeg', size: 1024, etag: 'etag-old' },
  });

  assert.equal(late.status, 'stale');
  assert.equal(late.asset, null);

  const { slots } = await listIntakeSlots(store, session);
  const hero = slots.find((slot) => slot.slotKey === 'primary_hero_photo');
  assert.equal(hero?.asset?.assetId, fresh.reservation.assetId, 'newer generation still wins');
  assert.equal(hero?.generation, fresh.reservation.generation);
  assert.equal(
    slots.some((slot) => slot.asset?.assetId === old.assetId),
    false,
    'the stale asset is never listed active',
  );

  // Its orphaned bytes are still tracked so cleanup can reclaim them.
  const record = store.records.get(session.intakeId)!.record;
  assert.ok(
    record.superseded.some((asset) => asset.pathname === old.pathname),
    'stale callback bytes are recorded for cleanup',
  );
});

test('removing a slot fences an in-flight callback for the removed generation', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const pending = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
    mimeType: 'image/jpeg',
    size: 1024,
  });
  store.putAsset({ pathname: pending.pathname, mimeType: 'image/jpeg', size: 1024, etag: 'etag-x' });

  const released = await releaseSlot(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
  });
  assert.equal(released.generation, pending.generation + 1);

  const late = await completeSlotUpload(store, {
    tokenPayload: pending.tokenPayload,
    blob: { pathname: pending.pathname, contentType: 'image/jpeg', size: 1024, etag: 'etag-x' },
  });
  assert.equal(late.status, 'stale');

  const { slots } = await listIntakeSlots(store, session);
  const hero = slots.find((slot) => slot.slotKey === 'primary_hero_photo');
  assert.equal(hero?.asset ?? null, null, 'removed slot stays empty');
});

test('a stale voice callback keeps the immutable reservation provenance after relabel', async () => {
  const store = createMemoryIntakeStore();
  const createdAt = new Date('2026-09-02T12:00:05.000Z');
  const session = await createIntake(store, {
    mediaAuthorizedAt: '2026-09-02T12:00:00.000Z',
    childVoiceAuthorizedAt: '2026-09-02T12:00:05.000Z',
    voiceSource: 'recorded',
  }, createdAt);
  const pending = await reserveSlotUpload(store, {
    ...session, slot: { category: 'voice_inspiration' }, mimeType: 'audio/mp4', size: 1024,
  }, new Date('2026-09-02T12:01:00.000Z'));
  await releaseSlot(store, {
    ...session, slot: { category: 'voice_inspiration' },
  }, new Date('2026-09-02T12:02:00.000Z'));
  await refreshIntakeConsent(store, {
    ...session,
    consent: { childVoiceAuthorizedAt: '2026-09-02T12:03:00.000Z', voiceSource: 'uploaded' },
  }, new Date('2026-09-02T12:03:00.000Z'));
  store.putAsset({ pathname: pending.pathname, mimeType: 'audio/mp4', size: 1024, etag: 'voice-old' });
  const late = await completeSlotUpload(store, {
    tokenPayload: pending.tokenPayload,
    blob: { pathname: pending.pathname, contentType: 'audio/mp4', size: 1024, etag: 'voice-old' },
  }, new Date('2026-09-02T12:04:00.000Z'));
  assert.equal(late.status, 'stale');
  const record = store.records.get(session.intakeId)!.record;
  const orphan = record.superseded.find((asset) => asset.assetId === pending.assetId)!;
  assert.equal(orphan.consentAt, '2026-09-02T12:00:05.000Z');
  assert.equal(orphan.voiceSource, 'recorded');
  assert.doesNotThrow(() => parseIntakeRecord(record));
});

test('removing a completed slot supersedes it and a repeat callback cannot restore it', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const saved = await reserveAndComplete(store, session, HERO);
  assert.equal(saved.completion.status, 'activated');

  await releaseSlot(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: HERO,
  });

  const replay = await completeSlotUpload(store, {
    tokenPayload: saved.reservation.tokenPayload,
    blob: {
      pathname: saved.reservation.pathname,
      contentType: 'image/jpeg',
      size: 1024,
      etag: saved.etag,
    },
  });
  assert.equal(replay.status, 'stale');

  const { slots } = await listIntakeSlots(store, session);
  const hero = slots.find((slot) => slot.slotKey === 'primary_hero_photo');
  assert.equal(hero?.asset ?? null, null);
});

test('a duplicate callback for the current generation is idempotent', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const saved = await reserveAndComplete(store, session, HERO);
  const repeat = await completeSlotUpload(store, {
    tokenPayload: saved.reservation.tokenPayload,
    blob: {
      pathname: saved.reservation.pathname,
      contentType: 'image/jpeg',
      size: 1024,
      etag: saved.etag,
    },
  });

  assert.equal(repeat.status, 'idempotent');
  assert.equal(repeat.asset?.assetId, saved.reservation.assetId);

  const record = store.records.get(session.intakeId)!.record;
  assert.equal(record.superseded.length, 0, 'a replay creates no orphan');
});

test('family slots are keyed by stable character id, not by list position', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const alice = { category: 'family_pet_reference', familyCharacterId: 'char-alice' } as const;
  const bruno = { category: 'family_pet_reference', familyCharacterId: 'char-bruno' } as const;

  const first = await reserveAndComplete(store, session, alice);
  const second = await reserveAndComplete(store, session, bruno, { size: 2048 });

  assert.equal(first.reservation.slotKey, 'family_pet_reference:char-alice');
  assert.equal(second.reservation.slotKey, 'family_pet_reference:char-bruno');
  // Independent slots each start at generation 1.
  assert.equal(first.reservation.generation, 1);
  assert.equal(second.reservation.generation, 1);

  // Replacing Alice's photo leaves Bruno's untouched.
  const aliceReplacement = await reserveAndComplete(store, session, alice, { size: 4096 });
  assert.equal(aliceReplacement.reservation.generation, 2);

  const { slots } = await listIntakeSlots(store, session);
  const brunoSlot = slots.find((slot) => slot.slotKey === 'family_pet_reference:char-bruno');
  assert.equal(brunoSlot?.asset?.assetId, second.reservation.assetId);
  assert.equal(brunoSlot?.generation, 1);
});

test('replacing a completed slot supersedes the previous asset exactly once', async () => {
  const store = createMemoryIntakeStore();
  const session = await newIntake(store);

  const first = await reserveAndComplete(store, session, HERO);
  const second = await reserveAndComplete(store, session, HERO, { size: 2048 });

  const record = store.records.get(session.intakeId)!.record;
  const superseded = record.superseded.filter(
    (asset) => asset.assetId === first.reservation.assetId,
  );
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0]?.supersededReason, 'replaced');

  const { slots } = await listIntakeSlots(store, session);
  const hero = slots.find((slot) => slot.slotKey === 'primary_hero_photo');
  assert.equal(hero?.asset?.assetId, second.reservation.assetId);
});
