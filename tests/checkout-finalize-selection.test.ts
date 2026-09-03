/*
 * Finalization binds an order to media, so it is the last place a stale or
 * foreign asset can still do damage.
 *
 * Against the rejected candidate, `validateFinalizeAssetSelection` accepted a
 * resurrected old photo (`STALE_LATE_ASSET_FINALIZE_VALIDATED asset_aaaa…`)
 * because it validated the asset's CATEGORY and stable character id and both
 * were still legitimate. Here selection is resolved through the slot: an asset
 * id is only acceptable if it is the asset the slot currently holds, so
 * "superseded" and "selectable" cannot overlap by construction.
 *
 * The stored object is also re-verified immediately before binding, so an
 * order is never built on metadata that has changed underneath the record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntake,
  IntakeError,
  listIntakeSlots,
  refreshIntakeConsent,
} from '../src/lib/checkout-intake.ts';
import { completeSlotUpload, releaseSlot, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import {
  validateFinalizeSelection,
  type CheckoutFinalizeSelection,
} from '../src/lib/checkout-finalize.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const HERO = { category: 'primary_hero_photo' } as const;

function emptySelection(): CheckoutFinalizeSelection {
  return {
    primaryHeroPhotoAssetId: null,
    familyCharacterAssets: [],
    guidedStillAssetIds: [],
    voiceAssetId: null,
    documentAssetId: null,
  };
}

async function newSession(store: MemoryIntakeStore) {
  return createIntake(store, {
    mediaAuthorizedAt: '2026-09-02T12:00:00.000Z',
    childVoiceAuthorizedAt: '2026-09-02T12:00:05.000Z',
    voiceSource: 'recorded',
  }, new Date('2026-09-02T12:00:05.000Z'));
}

async function upload(
  store: MemoryIntakeStore,
  session: { intakeId: string; capability: string },
  slot: Parameters<typeof reserveSlotUpload>[1]['slot'],
  overrides: { mimeType?: string; size?: number } = {},
) {
  const mimeType = overrides.mimeType ?? 'image/jpeg';
  const size = overrides.size ?? 1024;
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot,
    mimeType,
    size,
  });
  const etag = `etag-${reservation.assetId}`;
  store.putAsset({ pathname: reservation.pathname, mimeType, size, etag });
  await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: mimeType, size, etag },
  });
  return reservation;
}

function code(error: unknown): string {
  assert.ok(error instanceof IntakeError, `expected IntakeError, got ${String(error)}`);
  return error.code;
}

test('a valid selection resolves every asset through its slot', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const alice = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-alice' });
  const still = await upload(store, session, { category: 'guided_still', guidedStillIndex: 1 });
  const voice = await upload(store, session, { category: 'voice_inspiration' }, { mimeType: 'audio/mp4', size: 4096 });

  const resolved = await validateFinalizeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    familyCharacterIds: ['char-alice'],
    selection: {
      ...emptySelection(),
      primaryHeroPhotoAssetId: hero.assetId,
      familyCharacterAssets: [{ assetId: alice.assetId, familyCharacterId: 'char-alice' }],
      guidedStillAssetIds: [still.assetId],
      voiceAssetId: voice.assetId,
    },
  });

  assert.equal(resolved.primaryHeroPhoto?.assetId, hero.assetId);
  assert.equal(resolved.primaryHeroPhoto?.pathname, hero.pathname);
  assert.equal(resolved.familyCharacters[0]?.familyCharacterIndex, 0);
  assert.equal(resolved.familyCharacters[0]?.asset.assetId, alice.assetId);
  assert.equal(resolved.guidedStills[0]?.asset.assetId, still.assetId);
  assert.equal(resolved.voiceAsset?.assetId, voice.assetId);
  const voiceEntry = resolved.entries.find((entry) => entry.category === 'voice_inspiration') as unknown as Record<string, unknown>;
  assert.equal(voiceEntry.consentAt, '2026-09-02T12:00:05.000Z');
  assert.equal(voiceEntry.voiceSource, 'recorded');
  assert.equal(resolved.documentAsset, null);
});

test('an occupied voice slot cannot be retroactively relabeled to another source', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  await upload(store, session, { category: 'voice_inspiration' }, { mimeType: 'audio/mp4', size: 4096 });

  await assert.rejects(
    refreshIntakeConsent(store, {
      ...session,
      consent: {
        childVoiceAuthorizedAt: '2026-09-02T12:03:00.000Z',
        voiceSource: 'uploaded',
      },
    }, new Date('2026-09-02T12:03:00.000Z')),
    (error) => code(error) === 'voice_source_change_requires_release',
  );
});

test('a superseded asset id cannot be finalized', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const first = await upload(store, session, HERO);
  await upload(store, session, HERO, { size: 2048 });

  // Exactly the rejected candidate's failure: the old asset is still a real
  // hero photo with valid consent, and it is still refused.
  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: first.assetId },
    }),
    (error) => code(error) === 'asset_not_current',
  );
});

test('a removed asset cannot be finalized', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  await releaseSlot(store, { intakeId: session.intakeId, capability: session.capability, slot: HERO });

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
    }),
    (error) => code(error) === 'asset_not_current',
  );
});

test('an asset from another intake is refused', async () => {
  const store = createMemoryIntakeStore();
  const mine = await newSession(store);
  const theirs = await newSession(store);
  const foreign = await upload(store, theirs, HERO);

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: mine.intakeId,
      capability: mine.capability,
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: foreign.assetId },
    }),
    (error) => code(error) === 'asset_not_current',
  );
});

test('an asset cannot be presented in a slot it does not belong to', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const alice = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-alice' });

  // The family photo offered as the hero photo.
  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: ['char-alice'],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: alice.assetId },
    }),
    (error) => code(error) === 'asset_not_current',
  );

  // Alice's photo offered as Bruno's.
  await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-bruno' });
  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: ['char-alice', 'char-bruno'],
      selection: {
        ...emptySelection(),
        familyCharacterAssets: [{ assetId: alice.assetId, familyCharacterId: 'char-bruno' }],
      },
    }),
    (error) => code(error) === 'asset_not_current',
  );
});

test('family indexes come from the current character order, not from upload order', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const alice = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-alice' });
  const bruno = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-bruno' });

  // The buyer reorders the family list after uploading.
  const resolved = await validateFinalizeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    familyCharacterIds: ['char-bruno', 'char-alice'],
    selection: {
      ...emptySelection(),
      familyCharacterAssets: [
        { assetId: alice.assetId, familyCharacterId: 'char-alice' },
        { assetId: bruno.assetId, familyCharacterId: 'char-bruno' },
      ],
    },
  });

  const byId = new Map(resolved.familyCharacters.map((entry) => [entry.familyCharacterId, entry.familyCharacterIndex]));
  assert.equal(byId.get('char-bruno'), 0);
  assert.equal(byId.get('char-alice'), 1);
});

test('a family character that is no longer in the form is refused', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const alice = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-alice' });

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: ['char-bruno'],
      selection: {
        ...emptySelection(),
        familyCharacterAssets: [{ assetId: alice.assetId, familyCharacterId: 'char-alice' }],
      },
    }),
    (error) => code(error) === 'family_character_unknown',
  );
});

test('duplicate references and a duplicated character are refused', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  const alice = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-alice' });

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: ['char-alice'],
      selection: {
        ...emptySelection(),
        primaryHeroPhotoAssetId: hero.assetId,
        guidedStillAssetIds: [hero.assetId],
      },
    }),
    (error) => code(error) === 'asset_reference_duplicate',
  );

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: ['char-alice'],
      selection: {
        ...emptySelection(),
        familyCharacterAssets: [
          { assetId: alice.assetId, familyCharacterId: 'char-alice' },
          { assetId: alice.assetId, familyCharacterId: 'char-alice' },
        ],
      },
    }),
    (error) => code(error) === 'asset_reference_duplicate',
  );
});

test('a voice note and an inspiration document cannot both be the story source', async () => {
  const store = createMemoryIntakeStore();
  const session = await createIntake(store, {
    mediaAuthorizedAt: '2026-09-02T12:00:00.000Z',
    childVoiceAuthorizedAt: '2026-09-02T12:00:05.000Z',
    voiceSource: 'uploaded',
    documentAuthorizedAt: '2026-09-02T12:00:06.000Z',
  });
  const voice = await upload(store, session, { category: 'voice_inspiration' }, { mimeType: 'audio/mp4', size: 2048 });
  const doc = await upload(store, session, { category: 'document_inspiration' }, { mimeType: 'application/pdf', size: 2048 });

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: [],
      selection: { ...emptySelection(), voiceAssetId: voice.assetId, documentAssetId: doc.assetId },
    }),
    (error) => code(error) === 'story_source_conflict',
  );
});

test('an object that changed in storage is not bound to an order', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  // Someone or something replaced the bytes behind the record's back.
  store.putAsset({ pathname: hero.pathname, mimeType: 'image/jpeg', size: 9999, etag: 'etag-different' });

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
    }),
    (error) => code(error) === 'asset_metadata_changed',
  );
});

test('an object missing from storage is not bound to an order', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);
  store.assets.delete(hero.pathname);

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
    }),
    (error) => code(error) === 'asset_metadata_changed',
  );
});

test('a wrong capability cannot finalize someone else’s intake', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const hero = await upload(store, session, HERO);

  await assert.rejects(
    validateFinalizeSelection(store, {
      intakeId: session.intakeId,
      capability: 'wrong-capability',
      familyCharacterIds: [],
      selection: { ...emptySelection(), primaryHeroPhotoAssetId: hero.assetId },
    }),
    (error) => code(error) === 'intake_forbidden',
  );
});

test('the fingerprint is order-independent but index- and media-sensitive', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const alice = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-alice' });
  const bruno = await upload(store, session, { category: 'family_pet_reference', familyCharacterId: 'char-bruno' });

  const fingerprintFor = async (
    familyCharacterAssets: Array<{ assetId: string; familyCharacterId: string }>,
    familyCharacterIds: string[],
  ) => (await validateFinalizeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    familyCharacterIds,
    selection: { ...emptySelection(), familyCharacterAssets },
  })).fingerprint;

  const forward = [
    { assetId: alice.assetId, familyCharacterId: 'char-alice' },
    { assetId: bruno.assetId, familyCharacterId: 'char-bruno' },
  ];
  const reversedArray = [...forward].reverse();

  assert.equal(
    await fingerprintFor(forward, ['char-alice', 'char-bruno']),
    await fingerprintFor(reversedArray, ['char-alice', 'char-bruno']),
    'the same media listed in a different ARRAY order is the same selection',
  );

  // ...but the derived index order is part of what gets printed, so it is part
  // of the identity. This is the distinction the rejected candidate collapsed.
  assert.notEqual(
    await fingerprintFor(forward, ['char-alice', 'char-bruno']),
    await fingerprintFor(forward, ['char-bruno', 'char-alice']),
    'a different family ORDER is a different book',
  );

  // Dropping a photo changes it too.
  assert.notEqual(
    await fingerprintFor(forward, ['char-alice', 'char-bruno']),
    await fingerprintFor([forward[0]!], ['char-alice', 'char-bruno']),
  );
});

test('an empty selection is valid — media is optional at checkout', async () => {
  const store = createMemoryIntakeStore();
  const session = await newSession(store);
  const resolved = await validateFinalizeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    familyCharacterIds: [],
    selection: emptySelection(),
  });
  assert.equal(resolved.primaryHeroPhoto, null);
  assert.deepEqual(resolved.familyCharacters, []);
  const { slots } = await listIntakeSlots(store, session);
  assert.deepEqual(slots, []);
});
