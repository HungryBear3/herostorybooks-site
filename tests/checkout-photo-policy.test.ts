import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearUntrustedSupportingPhotoMetadata,
  missingSupportingCharacterDescriptionLabels,
} from '../src/lib/checkout-photo-policy.ts';
import { sanitizeFamilyCharacters } from '../src/lib/orders.ts';

test('client-supplied supporting photo metadata is stripped and cannot spoof the description gate', () => {
  const parsed = sanitizeFamilyCharacters([
    {
      role: 'dad',
      relationshipLabel: 'Dad',
      notes: '',
      photoFileName: 'spoof.jpg',
      photoBlobPath: 'orders/spoof.jpg',
      photoBlobUrl: 'https://attacker.example/spoof.jpg',
      likenessIntent: 'reference',
    },
  ]);
  const cleared = clearUntrustedSupportingPhotoMetadata(parsed);

  assert.equal(cleared[0]?.photoFileName, null);
  assert.equal(cleared[0]?.photoBlobPath, null);
  assert.equal(cleared[0]?.photoBlobUrl, null);
  assert.equal(cleared[0]?.likenessIntent, 'storybook');
  assert.deepEqual(missingSupportingCharacterDescriptionLabels(cleared, new Set()), ['Dad']);
});

test('only an actual validated file index satisfies the supporting description gate', () => {
  const characters = clearUntrustedSupportingPhotoMetadata(
    sanitizeFamilyCharacters([{ role: 'dad', relationshipLabel: 'Dad', notes: '' }]),
  );
  assert.deepEqual(missingSupportingCharacterDescriptionLabels(characters, new Set([0])), []);
});

test('written details satisfy the no-photo supporting-character path', () => {
  const characters = clearUntrustedSupportingPhotoMetadata(
    sanitizeFamilyCharacters([
      { role: 'dad', relationshipLabel: 'Dad', notes: 'Tall, warm smile, round glasses' },
    ]),
  );
  assert.deepEqual(missingSupportingCharacterDescriptionLabels(characters, new Set()), []);
});
