import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOrderRecord, sanitizeFamilyCharacters } from '../src/lib/orders.ts';
import { familyCharactersBlock } from '../src/lib/story-generator.ts';

test('createOrderRecord preserves manual character appearance notes for fulfillment', () => {
  const record = createOrderRecord(
    {
      childName: 'Milo',
      bookFormat: 'classic',
      email: 'parent@example.com',
      characterNotes: 'Wears glasses and has curly dark hair',
      appearanceOptions: JSON.stringify({ glasses: true, hair: 'curly', skinTone: 'deep' }),
    },
    { id: 'ord_attr', now: '2026-04-22T18:00:00.000Z' },
  );

  assert.equal(record.characterNotes, 'Wears glasses and has curly dark hair');
  assert.equal(record.appearanceOptions, JSON.stringify({ glasses: true, hair: 'curly', skinTone: 'deep' }));
});

test('sanitizeFamilyCharacters bounds and preserves family / pet story details', () => {
  const characters = sanitizeFamilyCharacters(JSON.stringify([
    {
      role: 'dad',
      name: 'Alexy',
      relationshipLabel: 'Dad',
      pronouns: 'he/him',
      notes: 'Loves silly space adventures',
      isGiftRecipient: true,
    },
    {
      role: 'pet',
      name: 'Brody',
      relationshipLabel: 'family dog',
      pronouns: 'it/its',
      notes: 'small black dog with a white patch',
      photoFileName: 'brody.png',
      photoBlobPath: 'orders/ord_x/supporting-2-photo-brody.png',
      photoBlobUrl: 'https://blob.example.com/orders/ord_x/supporting-2-photo-brody.png',
    },
    { role: 'mom', name: 'Extra 1' },
    { role: 'sibling', name: 'Extra 2' },
    { role: 'grandparent', name: 'Extra 3 should be dropped' },
  ]));

  assert.equal(characters.length, 4);
  assert.equal(characters[0].role, 'dad');
  assert.equal(characters[0].isGiftRecipient, true);
  assert.equal(characters[1].role, 'pet');
  assert.match(characters[1].notes, /white patch/);
  assert.equal(characters[1].photoFileName, 'brody.png');
  assert.match(characters[1].photoBlobPath ?? '', /supporting-2-photo-brody/);
  assert.match(characters[1].photoBlobUrl ?? '', /^https:\/\/blob\.example\.com/);
});

test('familyCharactersBlock feeds supporting characters into story prompts without multi-photo claims', () => {
  const order = createOrderRecord({
    childName: 'Lukas',
    childAge: '5',
    childPronouns: 'he/him',
    theme: 'space-voyager',
    bookFormat: 'premium',
    email: 'parent@example.com',
    familyCharacters: [
      {
        role: 'dad',
        name: 'Alexy',
        relationshipLabel: 'Dad',
        pronouns: 'he/him',
        notes: 'gift recipient and rocket builder',
        isGiftRecipient: true,
      },
      {
        role: 'pet',
        name: 'Brody',
        relationshipLabel: 'family dog',
        pronouns: 'it/its',
        notes: 'small black dog',
        photoFileName: 'brody.png',
      },
    ],
  });

  const block = familyCharactersBlock(order);
  assert.match(block, /Alexy/);
  assert.match(block, /Brody/);
  assert.match(block, /Gift recipient/);
  assert.match(block, /Supporting reference photo attached/);
  assert.match(block, /uploaded child photo remains the visual identity anchor/);
});

test('checkout form sends per-character family photo attachments', () => {
  const src = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.match(src, /photoFile:\s*File \| null/);
  assert.match(src, /processSupportingCharacterPhoto/);
  assert.match(src, /familyCharacterPhoto_\$\{index\}/);
  assert.match(src, /photoFileName:\s*character\.photoFile\?\.name/);
});

test('checkout form keeps pet detail guidance as placeholder text, not submitted notes', () => {
  const src = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.match(src, /const PET_NOTES_PLACEHOLDER = "Breed, color, size, personality, or markings"/);
  assert.match(src, /notes: ""/);
  assert.match(src, /notes: character\.notes === PET_NOTES_PLACEHOLDER \? "" : character\.notes/);
  assert.match(src, /Reference photo/);
  assert.match(src, /for \$\{character\.name \|\| character\.relationshipLabel\}/);
});
