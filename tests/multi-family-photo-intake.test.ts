/**
 * Multi-family guided photo intake guardrails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSupportingCharacterPhotoAsset,
  createOrderRecord,
  isMultiFamilyPhotoIntakeEnabled,
  validateFamilyCharacterPhotoUploads,
} from '../src/lib/orders.ts';
import { familyCharacterReferencesBlock } from '../src/lib/story-generator.ts';

const characters = [{ id: 'dad-1' }, { id: 'dog-1' }, { id: 'sibling-1' }, { id: 'mom-1' }];
const jpg = { name: 'family.jpg', type: 'image/jpeg', size: 128_000 };

test('multi-family photo flag defaults off and enables only with preview env flag', () => {
  assert.equal(isMultiFamilyPhotoIntakeEnabled({}), false);
  assert.equal(isMultiFamilyPhotoIntakeEnabled({ NEXT_PUBLIC_HSB_MULTI_FAMILY_PHOTO_INTAKE: 'false' }), false);
  assert.equal(isMultiFamilyPhotoIntakeEnabled({ NEXT_PUBLIC_HSB_MULTI_FAMILY_PHOTO_INTAKE: 'true' }), true);
});

test('supporting character with no photo validates and remains optional', () => {
  assert.deepEqual(validateFamilyCharacterPhotoUploads(characters, []), { ok: true });
});

test('supporting character photo metadata is reference-only and consent-confirmed', () => {
  const asset = buildSupportingCharacterPhotoAsset({
    characterId: 'dad-1',
    assetId: 'preview/orders/ord_test/supporting-1-photo-family.jpg',
    file: jpg,
    role: 'dad',
    name: 'Alex',
    relationshipLabel: 'Dad',
    uploadedAt: '2026-06-16T12:00:00.000Z',
  });

  assert.equal(asset.referenceOnly, true);
  assert.equal(asset.consentConfirmed, true);
  assert.equal(asset.characterId, 'dad-1');
  assert.equal(asset.contentType, 'image/jpeg');
  assert.equal(asset.sizeBytes, 128_000);
});

test('order record persists familyCharacterPhotoAssets as backward-compatible optional metadata', () => {
  const asset = buildSupportingCharacterPhotoAsset({
    characterId: 'dog-1',
    assetId: 'preview/orders/ord_test/supporting-2-photo-dog.webp',
    file: { name: 'dog.webp', type: 'image/webp', size: 456 },
    role: 'pet',
    name: 'Brody',
    relationshipLabel: 'family dog',
    uploadedAt: '2026-06-16T12:00:00.000Z',
  });
  const order = createOrderRecord(
    {
      childName: 'Lina',
      bookFormat: 'digital',
      email: 'parent@example.test',
      familyCharacters: [{ role: 'pet', name: 'Brody', relationshipLabel: 'family dog' }],
      familyCharacterPhotoAssets: [asset],
    },
    { id: 'ord_test', now: '2026-06-16T12:00:00.000Z' },
  );

  assert.equal(order.familyCharacterPhotoAssets?.length, 1);
  assert.equal(order.familyCharacterPhotoAssets?.[0]?.referenceOnly, true);
});

test('rejects unsupported family reference photo type', () => {
  const result = validateFamilyCharacterPhotoUploads(characters, [
    { characterId: 'dad-1', characterIndex: 0, file: { name: 'notes.pdf', type: 'application/pdf', size: 10 }, consentConfirmed: true },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'supporting_photo_invalid_type');
});

test('rejects oversized family reference photo', () => {
  const result = validateFamilyCharacterPhotoUploads(characters, [
    { characterId: 'dad-1', characterIndex: 0, file: { name: 'large.jpg', type: 'image/jpeg', size: 4 * 1024 * 1024 + 1 }, consentConfirmed: true },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'supporting_photo_too_large');
});

test('rejects photo for unknown supporting character id', () => {
  const result = validateFamilyCharacterPhotoUploads(characters, [
    { characterId: 'stranger-1', characterIndex: 0, file: jpg, consentConfirmed: true },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'supporting_photo_unknown_character');
});

test('rejects more than one photo for same supporting character', () => {
  const result = validateFamilyCharacterPhotoUploads(characters, [
    { characterId: 'dad-1', characterIndex: 0, file: jpg, consentConfirmed: true },
    { characterId: 'dad-1', characterIndex: 0, file: { ...jpg, name: 'dad-2.jpg' }, consentConfirmed: true },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'supporting_photo_duplicate_character');
});

test('rejects more than four supporting-character photos', () => {
  const result = validateFamilyCharacterPhotoUploads(
    [...characters, { id: 'grandma-1' }],
    ['dad-1', 'dog-1', 'sibling-1', 'mom-1', 'grandma-1'].map((characterId, characterIndex) => ({
      characterId,
      characterIndex,
      file: { ...jpg, name: `${characterId}.jpg` },
      consentConfirmed: true,
    })),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'supporting_photo_limit_exceeded');
});

test('rejects family reference photo without permission confirmation', () => {
  const result = validateFamilyCharacterPhotoUploads(characters, [
    { characterId: 'dad-1', characterIndex: 0, file: jpg, consentConfirmed: false },
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'supporting_photo_consent_required');
});

test('story/art-direction helper uses safe reference-only language', () => {
  const block = familyCharacterReferencesBlock({
    familyCharacterPhotoAssets: [
      {
        characterId: 'dad-1',
        assetId: 'private/path',
        contentType: 'image/jpeg',
        sizeBytes: 123,
        role: 'dad',
        name: 'Alex',
        relationshipLabel: 'Dad',
        consentConfirmed: true,
        referenceOnly: true,
        uploadedAt: '2026-06-16T12:00:00.000Z',
      },
    ],
  } as never);

  assert.match(block, /private reference photo uploaded for reviewer guidance only/i);
  assert.match(block, /do not promise exact likeness/i);
  assert.doesNotMatch(block, /biometric|face scan|Face ID|public\/social reuse/i);
});

test('checkout source copy contains required safety promises and excludes unsafe claims', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('src/app/checkout/checkout-form.tsx', 'utf8'));

  assert.match(source, /private book prep/i);
  assert.match(source, /permission to share this photo/i);
  assert.match(source, /child(?:&apos;|')s photo remains the main visual reference/i);
  assert.match(source, /Reference-only, not an exact-likeness guarantee/i);
  assert.doesNotMatch(source, /biometric|face scan|Face ID|public\/social reuse/i);
});
