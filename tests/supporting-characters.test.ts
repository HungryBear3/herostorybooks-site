import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySupportingCharacterKind,
  parseSupportingCharacters,
  validateSupportingCharactersForCheckout,
} from '../src/lib/supporting-characters.ts';

function formValue(value: unknown): FormDataEntryValue {
  return JSON.stringify(value) as FormDataEntryValue;
}

test('supporting character parser classifies Dad/Father as human story context', () => {
  assert.equal(classifySupportingCharacterKind({ name: 'Dad', relationship: 'father' }), 'human');
});

test('supporting character validation blocks human characters without photos before payment', () => {
  const result = validateSupportingCharactersForCheckout(formValue([
    { name: 'Dad', relationship: 'father' },
  ]));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'supporting_character_photo_required');
  assert.equal(result.status, 400);
  assert.equal(result.missingHumanPhotoCharacters[0]?.name, 'Dad');
});

test('supporting character validation allows human characters with reference photos', () => {
  const result = validateSupportingCharactersForCheckout(formValue([
    { name: 'Aunt Maya', relationship: 'aunt', referencePhotoUrl: 'https://example.test/aunt.jpg' },
  ]));

  assert.equal(result.ok, true);
  assert.equal(result.supportingCharacters[0]?.kind, 'human');
  assert.equal(result.supportingCharacters[0]?.hasReferencePhoto, true);
});

test('supporting character validation allows pet-only supporting characters without photos', () => {
  const result = validateSupportingCharactersForCheckout(formValue([
    { name: 'Pickles', relationship: 'pet dog', species: 'dog' },
    { name: 'Mittens', kind: 'pet', species: 'cat' },
  ]));

  assert.equal(result.ok, true);
  assert.equal(result.supportingCharacters.length, 2);
  assert.deepEqual(result.supportingCharacters.map((character) => character.kind), ['pet', 'pet']);
});

test('supporting character parser ignores malformed payloads safely', () => {
  assert.deepEqual(parseSupportingCharacters('not json' as FormDataEntryValue), []);
  assert.deepEqual(parseSupportingCharacters(null), []);
});
