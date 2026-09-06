/*
 * F2 — canonical durable schema and cardinality bounds.
 *
 * Reproduced against the rejected candidate:
 *
 *  - `parseIntakeRecord` copied `category`, `familyCharacterId` and
 *    `guidedStillIndex` straight off the stored object without ever proving
 *    they agree with `slotKeyFor`. A `primary_hero_photo` slot carrying
 *    `category: 'voice_inspiration'` and `guidedStillIndex: 99` was accepted.
 *    Since finalization resolves selection THROUGH the slot, a slot whose
 *    identity fields disagree with its key undermines the whole model.
 *
 *  - 100 reserve/release cycles produced 100 retained slot entries and zero
 *    superseded entries, because an empty tombstone is neither occupied nor
 *    superseded. `INTAKE_MAX_SUPERSEDED` bounded only the audit list, so
 *    generations and slot entries were effectively unbounded.
 *
 *  - The whole record was buffered before any size check, so an oversized
 *    stored object was read into memory in full before being rejected.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntakeRecord,
  INTAKE_MAX_RECORD_BYTES,
  INTAKE_MAX_SLOT_GENERATION,
  INTAKE_MAX_SLOTS,
  INTAKE_MAX_SUPERSEDED,
  INTAKE_MAX_TOTAL_GENERATIONS,
  IntakeError,
  intakeAssetPath,
  parseIntakeRecord,
  readIntake,
  readJsonTextWithLimit,
  type IntakeRecord,
} from '../src/lib/checkout-intake.ts';
import { finalizationFingerprint } from '../src/lib/checkout-finalize.ts';
import { releaseSlot, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import { createMemoryIntakeStore, forceRecord } from './support/checkout-intake-memory-store.ts';

const CONSENT = { mediaAuthorizedAt: '2026-09-02T12:00:00.000Z' };
// The cardinality tests below build their record at the consent instant, so the
// reserve/release cycles must run on the same fixture clock. Left on the wall
// clock they only prove the intake had expired, not that the caps hold.
const AT = new Date(CONSENT.mediaAuthorizedAt);

function testOrderId(hexDigit: string): string {
  return `ord_${hexDigit.repeat(16)}`;
}

function code(error: unknown): string {
  assert.ok(error instanceof IntakeError, `expected IntakeError, got ${String(error)}`);
  return error.code;
}

function baseRecord(): IntakeRecord {
  const record = createIntakeRecord(CONSENT, AT).record;
  return { ...record, updatedAt: '2026-09-02T12:30:00.000Z' };
}

test('initial media authorization is server-stamped at intake creation', () => {
  const createdAt = new Date('2026-09-02T12:00:00.000Z');
  const { record } = createIntakeRecord(
    { mediaAuthorizedAt: '1999-01-01T00:00:00.000Z' },
    createdAt,
  );
  assert.equal(record.consent.mediaAuthorizedAt, createdAt.toISOString());
});

function heroSlot(record: IntakeRecord, overrides: Record<string, unknown> = {}) {
  const assetId = `asset_${'b'.repeat(32)}`;
  return {
    slotKey: 'primary_hero_photo',
    category: 'primary_hero_photo',
    familyCharacterId: null,
    guidedStillIndex: null,
    generation: 1,
    pending: null,
    active: {
      assetId,
      slotKey: 'primary_hero_photo',
      category: 'primary_hero_photo',
      familyCharacterId: null,
      guidedStillIndex: null,
      generation: 1,
      pathname: intakeAssetPath(record.intakeId, assetId),
      mimeType: 'image/jpeg',
      size: 1024,
      etag: 'e1',
      consentAt: CONSENT.mediaAuthorizedAt,
      voiceSource: null,
      completedAt: '2026-09-02T12:01:00.000Z',
      supersededAt: null,
      supersededReason: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonical slot identity
// ---------------------------------------------------------------------------

test('a slot whose category disagrees with its key is refused', () => {
  const record = baseRecord();
  for (const category of ['voice_inspiration', 'document_inspiration', 'family_pet_reference', 'guided_still']) {
    const slot = heroSlot(record, { category });
    assert.throws(
      () => parseIntakeRecord({ ...record, slots: { primary_hero_photo: slot } }),
      (error) => code(error) === 'intake_record_invalid',
      `primary_hero_photo carrying category=${category} must be refused`,
    );
  }
});

test('a slot carrying reference fields its key does not imply is refused', () => {
  const record = baseRecord();
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: heroSlot(record, { guidedStillIndex: 99 }) },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: heroSlot(record, { familyCharacterId: 'char-alice' }) },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
  // And the family/guided keys must agree with their own reference fields.
  const alice = heroSlot(record);
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: {
        'family_pet_reference:char-alice': {
          ...alice,
          slotKey: 'family_pet_reference:char-alice',
          category: 'family_pet_reference',
          familyCharacterId: 'char-bruno',
          active: {
            ...alice.active,
            slotKey: 'family_pet_reference:char-alice',
            category: 'family_pet_reference',
            familyCharacterId: 'char-bruno',
          },
        },
      },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('an active asset whose identity disagrees with its slot is refused', () => {
  const record = baseRecord();
  const slot = heroSlot(record);
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: {
        primary_hero_photo: {
          ...slot,
          active: { ...slot.active, category: 'guided_still' },
        },
      },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
  // Generation ahead of the slot it lives in is impossible.
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: { ...slot, active: { ...slot.active, generation: 9 } } },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('an asset whose pathname is not its own derived path is refused', () => {
  const record = baseRecord();
  const slot = heroSlot(record);
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: {
        primary_hero_photo: {
          ...slot,
          active: { ...slot.active, pathname: `intakes/${record.intakeId}/assets/asset_${'9'.repeat(32)}` },
        },
      },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('an asset whose MIME or size is outside its category policy is refused', () => {
  const record = baseRecord();
  const slot = heroSlot(record);
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: { ...slot, active: { ...slot.active, mimeType: 'application/pdf' } } },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: { ...slot, active: { ...slot.active, size: 512 * 1024 * 1024 } } },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('unknown keys are refused rather than ignored', () => {
  const record = baseRecord();
  const slot = heroSlot(record);
  assert.throws(
    () => parseIntakeRecord({ ...record, somethingExtra: true }),
    (error) => code(error) === 'intake_record_invalid',
  );
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: { ...slot, shadowActive: slot.active } },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: { ...slot, active: { ...slot.active, overrideCategory: 'guided_still' } } },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('superseded reasons and timestamp ordering are validated', () => {
  const record = baseRecord();
  const slot = heroSlot(record);
  const supersededBase = {
    ...slot.active,
    supersededAt: '2026-09-02T12:02:00.000Z',
    supersededReason: 'replaced',
  };
  assert.doesNotThrow(() => parseIntakeRecord({ ...record, superseded: [supersededBase] }));

  assert.throws(
    () => parseIntakeRecord({ ...record, superseded: [{ ...supersededBase, supersededReason: 'vanished' }] }),
    (error) => code(error) === 'intake_record_invalid',
  );
  assert.throws(
    () => parseIntakeRecord({ ...record, superseded: [{ ...supersededBase, supersededAt: null }] }),
    (error) => code(error) === 'intake_record_invalid',
    'a superseded entry must actually carry its supersession time',
  );
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      superseded: [{ ...supersededBase, supersededAt: '2026-09-02T11:00:00.000Z' }],
    }),
    (error) => code(error) === 'intake_record_invalid',
    'superseded before completed is impossible',
  );
});

test('cleanup and finalization timestamp ordering is validated', () => {
  const record = baseRecord();
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      cleanupClaim: {
        claimId: 'c1',
        claimedAt: '2026-09-02T12:10:00.000Z',
        expiresAt: '2026-09-02T12:00:00.000Z',
      },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('malformed optional consent values are refused instead of canonicalized to null', () => {
  const record = baseRecord();
  for (const consent of [
    { ...record.consent, documentAuthorizedAt: 17 },
    { ...record.consent, childVoiceAuthorizedAt: 'not-a-date' },
    { ...record.consent, voiceSource: 'synthetic' },
  ]) {
    assert.throws(
      () => parseIntakeRecord({ ...record, consent }),
      (error) => code(error) === 'intake_record_invalid',
    );
  }
});

test('voice and document consent timestamps cannot predate intake creation', () => {
  const record = baseRecord();
  for (const consent of [
    { ...record.consent, mediaAuthorizedAt: '2026-09-02T11:59:59.000Z' },
    { ...record.consent, documentAuthorizedAt: '2026-09-02T11:59:59.000Z' },
    {
      ...record.consent,
      childVoiceAuthorizedAt: '2026-09-02T11:59:59.000Z',
      voiceSource: 'recorded',
    },
  ]) {
    assert.throws(
      () => parseIntakeRecord({ ...record, consent }),
      (error) => code(error) === 'intake_record_invalid',
    );
  }
});

test('active media consent provenance must match its category authority', () => {
  const record = baseRecord();
  const documentAuthorizedAt = '2026-09-02T12:00:10.000Z';
  const assetId = `asset_${'c'.repeat(32)}`;
  const documentSlot = {
    slotKey: 'document_inspiration', category: 'document_inspiration',
    familyCharacterId: null, guidedStillIndex: null, generation: 1, pending: null,
    active: {
      assetId, slotKey: 'document_inspiration', category: 'document_inspiration',
      familyCharacterId: null, guidedStillIndex: null, generation: 1,
      pathname: intakeAssetPath(record.intakeId, assetId), mimeType: 'application/pdf',
      size: 1024, etag: 'e2', consentAt: '2026-09-02T12:00:00.000Z', voiceSource: null,
      completedAt: '2026-09-02T12:01:00.000Z', supersededAt: null, supersededReason: null,
    },
  };
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      consent: { ...record.consent, documentAuthorizedAt },
      slots: { document_inspiration: documentSlot },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('finalized authority is recomputed and cross-validated against current slots', () => {
  const record = baseRecord();
  const slot = heroSlot(record);
  const entry = {
    slotKey: 'primary_hero_photo',
    category: 'primary_hero_photo',
    familyCharacterId: null,
    familyCharacterIndex: null,
    guidedStillIndex: null,
    assetId: slot.active.assetId,
    pathname: slot.active.pathname,
    mimeType: slot.active.mimeType,
    size: slot.active.size,
    etag: slot.active.etag,
    generation: slot.active.generation,
    consentAt: slot.active.consentAt,
    voiceSource: slot.active.voiceSource,
  } as const;
  const finalization = {
    checkoutAttemptId: 'a'.repeat(32),
    orderId: testOrderId('1'),
    fingerprint: finalizationFingerprint(record.intakeId, [entry]),
    reservedAt: '2026-09-02T12:02:00.000Z',
    leaseExpiresAt: '2026-09-02T12:17:00.000Z',
    selection: [entry],
  };
  const valid = { ...record, slots: { primary_hero_photo: slot }, finalization, finalizedOrderId: testOrderId('1') };
  assert.doesNotThrow(() => parseIntakeRecord(valid));

  for (const hostile of [
    { ...valid, finalizedOrderId: testOrderId('e') },
    { ...valid, finalization: { ...finalization, fingerprint: 'f'.repeat(64) } },
    { ...valid, finalization: { ...finalization, selection: [entry, entry] } },
    { ...valid, finalization: null },
    { ...valid, finalization: { ...finalization, selection: [{ ...entry, generation: 2 }] } },
    { ...valid, finalization: { ...finalization,
      reservedAt: '2026-09-02T11:00:00.000Z', leaseExpiresAt: '2026-09-02T11:15:00.000Z' } },
  ]) {
    assert.throws(
      () => parseIntakeRecord(hostile),
      (error) => code(error) === 'intake_record_invalid',
    );
  }
});

// ---------------------------------------------------------------------------
// Cardinality
// ---------------------------------------------------------------------------

const CARDINALITY_NOW = new Date('2026-09-02T12:01:00.000Z');

test('100 reserve/release cycles cannot retain 100 slots', async () => {
  const store = createMemoryIntakeStore();
  const { record, capability } = createIntakeRecord(CONSENT, AT);
  await store.create(record);

  let created = 0;
  let refusal: unknown = null;
  for (let i = 0; i < 100; i += 1) {
    const slot = { category: 'family_pet_reference', familyCharacterId: `char-${i}` } as const;
    try {
      await reserveSlotUpload(store, {
        intakeId: record.intakeId,
        capability,
        slot,
        mimeType: 'image/jpeg',
        size: 1024,
      }, CARDINALITY_NOW);
      await releaseSlot(store, { intakeId: record.intakeId, capability, slot }, CARDINALITY_NOW);
      created += 1;
    } catch (error) {
      refusal = error;
      break;
    }
  }

  assert.ok(refusal, 'the run must be refused, not absorbed');
  assert.equal(code(refusal), 'intake_slot_limit_exceeded');
  const stored = store.records.get(record.intakeId)!.record;
  assert.ok(
    Object.keys(stored.slots).length <= INTAKE_MAX_SLOTS,
    `retained ${Object.keys(stored.slots).length} slots, cap is ${INTAKE_MAX_SLOTS}`,
  );
  assert.ok(created < 100);
});

test('100 reserve/release cycles on ONE slot cannot produce unbounded generations', async () => {
  const store = createMemoryIntakeStore();
  const { record, capability } = createIntakeRecord(CONSENT, AT);
  await store.create(record);
  const slot = { category: 'primary_hero_photo' } as const;

  let refusal: unknown = null;
  for (let i = 0; i < 100; i += 1) {
    try {
      await reserveSlotUpload(store, {
        intakeId: record.intakeId,
        capability,
        slot,
        mimeType: 'image/jpeg',
        size: 1024,
      }, CARDINALITY_NOW);
      await releaseSlot(store, { intakeId: record.intakeId, capability, slot }, CARDINALITY_NOW);
    } catch (error) {
      refusal = error;
      break;
    }
  }

  assert.ok(refusal, 'abandoned generations must be bounded, not merely unrecorded');
  assert.equal(code(refusal), 'intake_slot_churn_exceeded');
  const stored = store.records.get(record.intakeId)!.record;
  assert.ok(
    stored.slots.primary_hero_photo!.generation <= INTAKE_MAX_SLOT_GENERATION,
    `generation reached ${stored.slots.primary_hero_photo!.generation}`,
  );
});

test('the parsed record enforces every cardinality cap it was written under', () => {
  const record = baseRecord();
  const slots: Record<string, unknown> = {};
  for (let i = 0; i < INTAKE_MAX_SLOTS + 1; i += 1) {
    const slotKey = `family_pet_reference:char-${i}`;
    slots[slotKey] = {
      slotKey,
      category: 'family_pet_reference',
      familyCharacterId: `char-${i}`,
      guidedStillIndex: null,
      generation: 1,
      pending: null,
      active: null,
    };
  }
  assert.throws(
    () => parseIntakeRecord({ ...record, slots }),
    (error) => code(error) === 'intake_record_invalid',
  );

  const slot = heroSlot(record);
  const superseded = Array.from({ length: INTAKE_MAX_SUPERSEDED + 1 }, (_, i) => ({
    ...slot.active,
    assetId: `asset_${String(i).padStart(32, '0')}`,
    pathname: intakeAssetPath(record.intakeId, `asset_${String(i).padStart(32, '0')}`),
    supersededAt: '2026-09-02T12:02:00.000Z',
    supersededReason: 'replaced',
  }));
  assert.throws(
    () => parseIntakeRecord({ ...record, superseded }),
    (error) => code(error) === 'intake_record_invalid',
  );

  assert.throws(
    () => parseIntakeRecord({
      ...record,
      slots: { primary_hero_photo: { ...slot, generation: INTAKE_MAX_SLOT_GENERATION + 1 } },
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('total churn across all slots is bounded, not just per slot', async () => {
  const store = createMemoryIntakeStore();
  const { record, capability } = createIntakeRecord(CONSENT, AT);
  await store.create(record);

  let refusal: unknown = null;
  let accepted = 0;
  outer: for (let round = 0; round < 40; round += 1) {
    for (let i = 0; i < 4; i += 1) {
      const slot = { category: 'family_pet_reference', familyCharacterId: `char-${i}` } as const;
      try {
        // The clock is an EXPLICIT input. Without it the intake is long expired
        // by the time this suite runs, every cycle is refused as
        // `intake_expired`, and a bare "some error was thrown" assertion passes
        // while proving nothing about the aggregate churn bound at all.
        await reserveSlotUpload(store, {
          intakeId: record.intakeId,
          capability,
          slot,
          mimeType: 'image/jpeg',
          size: 1024,
        }, CARDINALITY_NOW);
        await releaseSlot(store, { intakeId: record.intakeId, capability, slot }, CARDINALITY_NOW);
        accepted += 1;
      } catch (error) {
        refusal = error;
        break outer;
      }
    }
  }

  assert.ok(refusal, 'churn spread across several slots must still be bounded');
  // The refusal must be the AGGREGATE guard. Four slots stay under
  // INTAKE_MAX_SLOTS and round-robin churn reaches the total cap long before
  // any single slot reaches INTAKE_MAX_SLOT_GENERATION, so neither the slot
  // limit nor the per-slot churn guard may be what stopped the run. Naming the
  // code also keeps this from passing on any refusal at all — an
  // `intake_expired` here would mean the cap was never exercised.
  assert.equal(code(refusal), 'intake_churn_exceeded');
  const stored = store.records.get(record.intakeId)!.record;
  const generations = Object.values(stored.slots).map((slot) => slot.generation);
  const total = generations.reduce((sum, generation) => sum + generation, 0);
  assert.ok(accepted > 0, 'the run must perform real churn before it is refused');
  assert.equal(total, INTAKE_MAX_TOTAL_GENERATIONS, `total generations reached ${total}`);
  assert.ok(
    Math.max(...generations) < INTAKE_MAX_SLOT_GENERATION,
    'no single slot may have reached the per-slot cap first',
  );
  assert.ok(Object.keys(stored.slots).length <= INTAKE_MAX_SLOTS);
});

// ---------------------------------------------------------------------------
// Bounded reads
// ---------------------------------------------------------------------------

test('an oversized stored record is refused before it is fully buffered', async () => {
  let produced = 0;
  const huge = new ReadableStream<Uint8Array>({
    pull(controller) {
      // 64 KiB per pull, forever. A reader with no cap never returns.
      produced += 65536;
      controller.enqueue(new Uint8Array(65536));
      if (produced > INTAKE_MAX_RECORD_BYTES * 8) controller.close();
    },
  });

  await assert.rejects(
    readJsonTextWithLimit(huge, INTAKE_MAX_RECORD_BYTES),
    (error) => code(error) === 'intake_record_too_large',
  );
  assert.ok(
    produced <= INTAKE_MAX_RECORD_BYTES + 65536,
    `read ${produced} bytes before refusing; the cap is ${INTAKE_MAX_RECORD_BYTES}`,
  );
});

test('a record within the cap is read normally', async () => {
  const body = JSON.stringify({ ok: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  assert.equal(await readJsonTextWithLimit(stream, INTAKE_MAX_RECORD_BYTES), body);
});

test('durable identity fields are canonical, bounded, and explicitly present', () => {
  const record = baseRecord();
  for (const key of ['finalization', 'finalizedOrderId', 'cleanupClaim'] as const) {
    const malformed = { ...record } as Record<string, unknown>;
    delete malformed[key];
    assert.throws(() => parseIntakeRecord(malformed), (error) => code(error) === 'intake_record_invalid');
  }
  const slot = heroSlot(record);
  const entry = {
    slotKey: 'primary_hero_photo', category: 'primary_hero_photo', familyCharacterId: null,
    familyCharacterIndex: null, guidedStillIndex: null, assetId: slot.active.assetId,
    pathname: slot.active.pathname, mimeType: 'image/jpeg', size: 1024, etag: 'e1', generation: 1,
  };
  const finalization = {
    checkoutAttemptId: 'a'.repeat(32), orderId: `ord_${'1'.repeat(16)}`,
    fingerprint: finalizationFingerprint(record.intakeId, [entry]),
    reservedAt: '2026-09-02T12:02:00.000Z', leaseExpiresAt: '2026-09-02T12:17:00.000Z', selection: [entry],
  };
  for (const malformed of [
    { ...record, slots: { primary_hero_photo: slot }, finalization: { ...finalization, checkoutAttemptId: 'x'.repeat(300_000) } },
    { ...record, slots: { primary_hero_photo: slot }, finalization: { ...finalization, orderId: 'ord_not_canonical' } },
    { ...record, cleanupClaim: { claimId: 'claim-not-canonical', claimedAt: '2026-09-02T12:00:00.000Z', expiresAt: '2026-09-02T12:10:00.000Z' } },
    { ...record, slots: { primary_hero_photo: { ...slot, active: { ...slot.active, etag: 'e'.repeat(300_000) } } } },
  ]) {
    assert.throws(() => parseIntakeRecord(malformed), (error) => code(error) === 'intake_record_invalid');
  }
});

test('asset and pathname identity is globally unique across durable slot state', () => {
  const record = baseRecord();
  const hero = heroSlot(record);
  const duplicate = {
    ...hero, slotKey: 'guided_still:0', category: 'guided_still', guidedStillIndex: 0,
    active: { ...hero.active, slotKey: 'guided_still:0', category: 'guided_still', guidedStillIndex: 0 },
  };
  assert.throws(
    () => parseIntakeRecord({ ...record, slots: { primary_hero_photo: hero, 'guided_still:0': duplicate } }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('the parser enforces the per-category occupied-slot limit', () => {
  const record = baseRecord();
  const slots = Object.fromEntries(Array.from({ length: 5 }, (_, index) => {
    const familyCharacterId = `char-${index}`;
    const slotKey = `family_pet_reference:${familyCharacterId}`;
    const assetId = `asset_${String(index).repeat(32)}`;
    return [slotKey, {
      slotKey, category: 'family_pet_reference', familyCharacterId, guidedStillIndex: null,
      generation: 1, pending: null,
      active: {
        assetId, slotKey, category: 'family_pet_reference', familyCharacterId,
        guidedStillIndex: null, generation: 1,
        pathname: intakeAssetPath(record.intakeId, assetId), mimeType: 'image/jpeg',
        size: 1024, etag: `e${index}`, consentAt: CONSENT.mediaAuthorizedAt,
        completedAt: '2026-09-02T12:01:00.000Z', supersededAt: null, supersededReason: null,
      },
    }];
  }));
  assert.throws(() => parseIntakeRecord({ ...record, slots }), (error) => code(error) === 'intake_record_invalid');
});

test('readIntake binds the lookup key to the embedded intake identity', async () => {
  const store = createMemoryIntakeStore();
  const { record } = createIntakeRecord(CONSENT, AT);
  const lookupId = `intake_${'f'.repeat(32)}`;
  assert.notEqual(lookupId, record.intakeId);
  store.records.set(lookupId, { record, etag: 'e1' });
  await assert.rejects(readIntake(store, lookupId), (error) => code(error) === 'intake_record_invalid');
});

test('record-level timestamps cannot precede createdAt', () => {
  const record = baseRecord();
  assert.throws(
    () => parseIntakeRecord({
      ...record,
      createdAt: '2026-09-02T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
      expiresAt: '2026-09-01T12:00:00.000Z',
    }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('cleanup claims cannot precede intake creation', () => {
  const record = baseRecord();
  assert.throws(() => parseIntakeRecord({ ...record, cleanupClaim: {
    claimId: 'a'.repeat(32), claimedAt: '2026-09-02T11:00:00.000Z',
    expiresAt: '2026-09-02T11:15:00.000Z',
  } }), (error) => code(error) === 'intake_record_invalid');
});

test('nested asset timestamps cannot precede intake creation', () => {
  const record = baseRecord();
  const slot = heroSlot(record);
  const before = new Date(Date.parse(record.createdAt) - 60_000).toISOString();
  slot.active.completedAt = before;
  assert.throws(
    () => parseIntakeRecord({ ...record, slots: { primary_hero_photo: slot } }),
    (error) => code(error) === 'intake_record_invalid',
  );
});

test('an active voice asset requires durable voice consent and provenance', () => {
  const record = {
    ...baseRecord(),
    consent: {
      ...baseRecord().consent,
      childVoiceAuthorizedAt: '2026-09-02T12:10:00.000Z',
      voiceSource: 'recorded' as const,
    },
  };
  const assetId = `asset_${'c'.repeat(32)}`;
  const voice = {
    slotKey: 'voice_inspiration', category: 'voice_inspiration', familyCharacterId: null,
    guidedStillIndex: null, generation: 1, pending: null,
    active: {
      assetId, slotKey: 'voice_inspiration', category: 'voice_inspiration', familyCharacterId: null,
      guidedStillIndex: null, generation: 1, pathname: intakeAssetPath(record.intakeId, assetId),
      mimeType: 'audio/mp4', size: 1024, etag: 'voice-etag',
      consentAt: record.consent.childVoiceAuthorizedAt, voiceSource: record.consent.voiceSource,
      completedAt: record.updatedAt, supersededAt: null, supersededReason: null,
    },
  };
  assert.doesNotThrow(() => parseIntakeRecord({ ...record, slots: { voice_inspiration: voice } }));
  for (const active of [
    { ...voice.active, consentAt: '2026-09-02T12:09:00.000Z' },
    { ...voice.active, voiceSource: 'uploaded' },
  ]) {
    assert.throws(
      () => parseIntakeRecord({ ...record, slots: { voice_inspiration: { ...voice, active } } }),
      (error) => code(error) === 'intake_record_invalid',
    );
  }
});

test('release remains available when the superseded audit list is full', async () => {
  const store = createMemoryIntakeStore();
  const created = createIntakeRecord(CONSENT, new Date('2026-09-02T12:00:00.000Z'));
  await store.create(created.record);
  const activeSlot = heroSlot(created.record);
  const superseded = Array.from({ length: INTAKE_MAX_SUPERSEDED }, (_, index) => {
    const assetId = `asset_${index.toString(16).padStart(32, '0')}`;
    return { ...activeSlot.active, assetId, pathname: intakeAssetPath(created.record.intakeId, assetId),
      supersededAt: '2026-09-02T12:02:00.000Z', supersededReason: 'replaced' as const };
  });
  forceRecord(store, { ...created.record, updatedAt: '2026-09-02T12:02:00.000Z',
    slots: { primary_hero_photo: activeSlot }, superseded });
  await releaseSlot(store, { intakeId: created.record.intakeId, capability: created.capability,
    slot: { category: 'primary_hero_photo' } }, new Date('2026-09-02T12:03:00.000Z'));
  assert.equal(store.records.get(created.record.intakeId)!.record.slots.primary_hero_photo!.active, null);
  assert.equal(store.records.get(created.record.intakeId)!.record.superseded.length, INTAKE_MAX_SUPERSEDED);
});
