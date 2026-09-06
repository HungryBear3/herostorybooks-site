/*
 * Durable intake state is schema-validated and fails closed.
 *
 * An intake record we cannot read or cannot trust must stop the flow. The
 * failure mode being guarded against is the quiet one: coercing a malformed
 * record into a "reasonable" default, which silently discards a buyer's
 * uploads or, worse, presents an empty slot set that a limit check then finds
 * plenty of room in.
 *
 * `read` returning null (absent) and `read` throwing (unavailable) are also
 * kept distinct — conflating them is what let the request guard treat an
 * unreachable store as a store with nothing in it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertIntakeRecordWritable,
  createIntakeRecord,
  IntakeError,
  parseIntakeRecord,
  readIntake,
  type IntakeRecord,
} from '../src/lib/checkout-intake.ts';
import { completeSlotUpload, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import { createMemoryIntakeStore, forceRecord } from './support/checkout-intake-memory-store.ts';

const CONSENT = { mediaAuthorizedAt: '2026-09-02T12:00:00.000Z' };

function code(error: unknown): string {
  assert.ok(error instanceof IntakeError, `expected IntakeError, got ${String(error)}`);
  return error.code;
}

/** A record with one completed hero photo, built by the real state machine. */
async function realRecord(): Promise<IntakeRecord> {
  const store = createMemoryIntakeStore();
  const session = await createIntakeSession(store);
  return store.records.get(session.intakeId)!.record;

  async function createIntakeSession(memoryStore: ReturnType<typeof createMemoryIntakeStore>) {
    const { record, capability } = createIntakeRecord(CONSENT);
    await memoryStore.create(record);
    const reservation = await reserveSlotUpload(memoryStore, {
      intakeId: record.intakeId,
      capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 1024,
    });
    memoryStore.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 1024, etag: 'e1' });
    await completeSlotUpload(memoryStore, {
      tokenPayload: reservation.tokenPayload,
      blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 1024, etag: 'e1' },
    });
    return { intakeId: record.intakeId, capability };
  }
}

test('a record the state machine wrote validates and round-trips', async () => {
  const record = await realRecord();
  const parsed = parseIntakeRecord(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(parsed, record);
});

test('writer validation rejects required nullable fields that disappear from JSON bytes', async () => {
  const record = await realRecord();
  const poisoned = structuredClone(record);
  poisoned.consent.documentAuthorizedAt = undefined as never;
  assert.throws(
    () => assertIntakeRecordWritable(poisoned),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('an unsupported record version is refused, not migrated', async () => {
  const record = await realRecord();
  assert.throws(
    () => parseIntakeRecord({ ...record, version: 1 }),
    (error) => code(error) === 'intake_record_version_unsupported'
      && (error as IntakeError).status === 503,
  );
});

test('structurally broken records fail closed', async () => {
  const record = await realRecord();
  const mutations: Array<[string, unknown]> = [
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['missing intakeId', { ...record, intakeId: 'intake_short' }],
    ['a bad capability hash', { ...record, capabilityHash: 'zz' }],
    ['a non-date expiry', { ...record, expiresAt: 'soon' }],
    ['missing consent', { ...record, consent: {} }],
    ['slots as an array', { ...record, slots: [] }],
    ['superseded as an object', { ...record, superseded: {} }],
    ['a non-string finalizedOrderId', { ...record, finalizedOrderId: 7 }],
    ['a half-built finalization', { ...record, finalization: { orderId: 'ord_1' } }],
    ['a half-built cleanup claim', { ...record, cleanupClaim: { claimId: 'c' } }],
  ];
  for (const [label, mutated] of mutations) {
    assert.throws(
      () => parseIntakeRecord(mutated),
      (error) => code(error) === 'intake_record_invalid' && (error as IntakeError).status === 503,
      label,
    );
  }
});

test('a slot whose key does not match its own record fails closed', async () => {
  const record = await realRecord();
  const slot = record.slots.primary_hero_photo!;
  assert.throws(
    () => parseIntakeRecord({ ...record, slots: { other_key: slot } }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('a slot generation of zero is impossible and fails closed', async () => {
  const record = await realRecord();
  const slot = record.slots.primary_hero_photo!;
  assert.throws(
    () => parseIntakeRecord({ ...record, slots: { primary_hero_photo: { ...slot, generation: 0 } } }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('a pending reservation at the wrong generation is a contradiction and fails closed', async () => {
  const record = await realRecord();
  const slot = record.slots.primary_hero_photo!;
  const contradiction = {
    ...record,
    slots: {
      primary_hero_photo: {
        ...slot,
        generation: 5,
        pending: {
          reservationId: `res_${'a'.repeat(32)}`,
          assetId: `asset_${'b'.repeat(32)}`,
          // The state machine can never produce a reservation for a
          // generation the slot has already moved past.
          generation: 4,
          pathname: `intakes/${record.intakeId}/assets/asset_${'b'.repeat(32)}`,
          mimeType: 'image/jpeg',
          size: 10,
          consentAt: CONSENT.mediaAuthorizedAt,
          reservedAt: CONSENT.mediaAuthorizedAt,
        },
      },
    },
  };
  assert.throws(
    () => parseIntakeRecord(contradiction),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('an active asset marked superseded is a contradiction and fails closed', async () => {
  const record = await realRecord();
  const slot = record.slots.primary_hero_photo!;
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: {
        primary_hero_photo: {
          ...slot,
          active: { ...slot.active!, supersededAt: '2026-09-02T13:00:00.000Z', supersededReason: 'removed' },
        },
      },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('an unavailable store is not an empty intake', async () => {
  const store = createMemoryIntakeStore();
  const { record } = createIntakeRecord(CONSENT);
  await store.create(record);

  store.failNextRead();
  await assert.rejects(
    readIntake(store, record.intakeId),
    (error) => code(error) === 'intake_store_unavailable' && (error as IntakeError).status === 503,
  );
});

test('an absent intake is a 404, distinct from an unavailable store', async () => {
  const store = createMemoryIntakeStore();
  await assert.rejects(
    readIntake(store, `intake_${'0'.repeat(32)}`),
    (error) => code(error) === 'intake_not_found' && (error as IntakeError).status === 404,
  );
});

test('a corrupted stored record stops the flow instead of resetting it', async () => {
  const store = createMemoryIntakeStore();
  const { record, capability } = createIntakeRecord(CONSENT);
  await store.create(record);
  // Corruption that a defaulting parser would silently read as "no uploads".
  forceRecord(store, { ...record, slots: null as never });

  await assert.rejects(
    reserveSlotUpload(store, {
      intakeId: record.intakeId,
      capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 1024,
    }),
    (error) => code(error) === 'intake_record_invalid' && (error as IntakeError).status === 503,
  );
});

test('a write that keeps losing its race is a conflict, never a blind overwrite', async () => {
  const store = createMemoryIntakeStore();
  const { record, capability } = createIntakeRecord(CONSENT);
  await store.create(record);
  store.failNextCas(10);

  await assert.rejects(
    reserveSlotUpload(store, {
      intakeId: record.intakeId,
      capability,
      slot: { category: 'primary_hero_photo' },
      mimeType: 'image/jpeg',
      size: 1024,
    }),
    (error) => code(error) === 'intake_write_conflict' && (error as IntakeError).status === 409,
  );
  assert.deepEqual(store.records.get(record.intakeId)!.record.slots, {}, 'nothing was written');
});
