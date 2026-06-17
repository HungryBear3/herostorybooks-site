import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSupportingCharacterPhotoError,
  missingSupportingCharacterPhotoLabels,
  SUPPORTING_CHARACTER_PHOTO_REQUIRED_CODE,
} from '../src/lib/supporting-character-photo-gate.ts';
import type { FamilyCharacter } from '../src/lib/orders.ts';

function character(overrides: Partial<FamilyCharacter>): FamilyCharacter {
  return {
    role: 'dad',
    name: '',
    relationshipLabel: '',
    pronouns: '',
    notes: '',
    isGiftRecipient: false,
    appearsInStory: true,
    photoFileName: null,
    photoBlobPath: null,
    photoBlobUrl: null,
    referencePhotos: null,
    ...overrides,
  };
}

test('requires still reference photos for human supporting characters before payment', () => {
  const missing = missingSupportingCharacterPhotoLabels(
    [character({ role: 'dad', name: 'Dad' })],
    () => false,
  );

  assert.deepEqual(missing, ['Dad']);
});

test('does not require reference photos for pets', () => {
  const missing = missingSupportingCharacterPhotoLabels(
    [character({ role: 'pet', name: 'French Fry' })],
    () => false,
  );

  assert.deepEqual(missing, []);
});

test('accepts a current request upload for a human supporting character', () => {
  const missing = missingSupportingCharacterPhotoLabels(
    [character({ role: 'mom', name: 'Mom' })],
    (index) => index === 0,
  );

  assert.deepEqual(missing, []);
});

test('accepts persisted split-intake reference photos', () => {
  const missing = missingSupportingCharacterPhotoLabels(
    [
      character({
        role: 'grandparent',
        name: 'Grandma',
        referencePhotos: [
          {
            assetId: 'asset-grandma',
            label: 'Grandma',
            fileName: 'grandma.jpg',
            photoBlobPath: 'orders/order-1/family/grandma.jpg',
            photoBlobUrl: 'https://blob.example/grandma.jpg',
            source: 'upload',
            consentAt: '2026-06-17T00:00:00.000Z',
          },
        ],
      }),
    ],
    () => false,
  );

  assert.deepEqual(missing, []);
});

test('ignores characters intentionally excluded from story', () => {
  const missing = missingSupportingCharacterPhotoLabels(
    [character({ role: 'sibling', name: 'Sibling', appearsInStory: false })],
    () => false,
  );

  assert.deepEqual(missing, []);
});

test('builds the fail-closed API error payload', () => {
  assert.deepEqual(buildSupportingCharacterPhotoError(['Dad', 'Mom']), {
    error: 'Add a still reference photo for Dad, Mom before payment. No charge was made.',
    code: SUPPORTING_CHARACTER_PHOTO_REQUIRED_CODE,
  });
});
