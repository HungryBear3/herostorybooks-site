import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_SECTION_ORDER,
  PRINT_PREVIEW_PROMISE,
  PHOTO_UPLOAD_HELP,
  canSubmitCheckoutForm,
  selectAdventureValue,
  missingRequiredField,
  missingFieldPrompt,
  currentCheckoutStep,
  defaultGiftRecipientName,
} from '../src/lib/checkout-flow.ts';

test('checkout flow leads with story and hero details before photo upload', () => {
  assert.deepEqual(CHECKOUT_SECTION_ORDER, [
    'theme',
    'child-details',
    'format',
    'email',
    'photo',
    'order-summary',
  ]);
});

test('print preview promise clearly says approval happens before printing', () => {
  assert.match(PRINT_PREVIEW_PROMISE, /approve/i);
  assert.match(PRINT_PREVIEW_PROMISE, /before it prints/i);
});

test('photo upload help supports gift buyers who want to start before finding a photo', () => {
  assert.match(PHOTO_UPLOAD_HELP, /start now/i);
  assert.match(PHOTO_UPLOAD_HELP, /add a photo later/i);
  assert.match(PHOTO_UPLOAD_HELP, /automatically reduced/i);
});

// ── Required adventure + submit gating ───────────────────────────────────────

const FULL = {
  theme: 'brave-explorer',
  childName: 'Emma',
  email: 'a@b.com',
  skinTone: 'medium',
  hairStyle: 'curly',
  childPronouns: 'she/her',
};

test('canSubmitCheckoutForm: blocks submit when no adventure is selected', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, theme: '' }), false);
});

test('canSubmitCheckoutForm: blocks submit when childName or email is missing', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, childName: '' }), false);
  assert.equal(canSubmitCheckoutForm({ ...FULL, email: '' }), false);
});

test('canSubmitCheckoutForm: blocks submit when skinTone is missing (launch spec requires explicit value)', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, skinTone: '' }), false);
  assert.equal(canSubmitCheckoutForm({ ...FULL, skinTone: '   ' }), false);
});

test('canSubmitCheckoutForm: blocks submit when hairStyle is missing', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, hairStyle: '' }), false);
  assert.equal(canSubmitCheckoutForm({ ...FULL, hairStyle: '   ' }), false);
});

test('canSubmitCheckoutForm: blocks submit when hero pronouns are missing', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, childPronouns: '' }), false);
  assert.equal(canSubmitCheckoutForm({ ...FULL, childPronouns: '   ' }), false);
});

test('canSubmitCheckoutForm: allows submit only when every required field is present', () => {
  assert.equal(canSubmitCheckoutForm(FULL), true);
});

test('missingRequiredField: reports the first gap for the disabled-state label', () => {
  assert.equal(missingRequiredField({ ...FULL, theme: '' }), 'adventure');
  assert.equal(missingRequiredField({ ...FULL, childName: '' }), 'name');
  assert.equal(missingRequiredField({ ...FULL, email: '' }), 'email');
  assert.equal(missingRequiredField({ ...FULL, skinTone: '' }), 'skin_tone');
  assert.equal(missingRequiredField({ ...FULL, hairStyle: '' }), 'hair_style');
  assert.equal(missingRequiredField({ ...FULL, childPronouns: '' }), 'pronouns');
  assert.equal(missingRequiredField(FULL), null);
});

test('missingFieldPrompt: gives clear next-action copy for the checkout CTA/help text', () => {
  assert.match(missingFieldPrompt('adventure'), /choose an adventure/i);
  assert.match(missingFieldPrompt('name'), /enter.*child.?s name/i);
  assert.match(missingFieldPrompt('email'), /enter.*email/i);
  assert.match(missingFieldPrompt('skin_tone'), /select.*skin tone/i);
  assert.match(missingFieldPrompt('hair_style'), /select.*hair/i);
  assert.match(missingFieldPrompt('pronouns'), /select.*boy|select.*girl|pronouns/i);
  assert.equal(missingFieldPrompt(null), null);
});

test('currentCheckoutStep: surfaces the current step and completed count clearly', () => {
  assert.deepEqual(currentCheckoutStep({
    theme: '', childName: '', email: '', skinTone: '', hairStyle: '', childPronouns: '', photoReady: false,
  }), { current: 'Adventure', completedCount: 0, totalCount: 5 });

  assert.deepEqual(currentCheckoutStep({
    theme: 'brave-explorer', childName: '', email: '', skinTone: '', hairStyle: '', childPronouns: '', photoReady: false,
  }), { current: 'Hero', completedCount: 1, totalCount: 5 });

  assert.deepEqual(currentCheckoutStep({
    theme: 'brave-explorer', childName: 'Emma', email: 'a@b.com', skinTone: 'medium', hairStyle: 'curly', childPronouns: 'she/her', photoReady: false,
  }), { current: 'Photo', completedCount: 4, totalCount: 5 });

  assert.deepEqual(currentCheckoutStep({
    theme: 'brave-explorer', childName: 'Emma', email: 'a@b.com', skinTone: 'medium', hairStyle: 'curly', childPronouns: 'she/her', photoReady: true,
  }), { current: 'Ready to checkout', completedCount: 5, totalCount: 5 });
});

test('selectAdventureValue: radio-style — clicking the same card again keeps it selected', () => {
  assert.equal(selectAdventureValue('brave-explorer', 'brave-explorer'), 'brave-explorer');
});

test('selectAdventureValue: switching between cards updates selection', () => {
  assert.equal(selectAdventureValue('space-voyager', 'brave-explorer'), 'space-voyager');
});

test('selectAdventureValue: selecting from empty state sets the adventure', () => {
  assert.equal(selectAdventureValue('brave-explorer', ''), 'brave-explorer');
});


test('defaultGiftRecipientName: Dad/Father supporting character is not auto-selected as gift recipient', () => {
  assert.equal(defaultGiftRecipientName({
    childName: 'Emma',
    occasion: 'fathers-day',
    supportingCharacters: [{ name: 'Dad', relationship: 'father', role: 'supporting character' }],
  }), 'Emma');
});

test('defaultGiftRecipientName: explicit recipient overrides the child default', () => {
  assert.equal(defaultGiftRecipientName({
    childName: 'Emma',
    supportingCharacters: [{ name: 'Dad', relationship: 'father' }],
    explicitGiftRecipientName: 'Grandpa',
  }), 'Grandpa');
});

test('defaultGiftRecipientName: when no child name exists, Dad/Father still does not become the default', () => {
  assert.equal(defaultGiftRecipientName({
    childName: '',
    supportingCharacters: [{ name: 'Papa', relationship: 'dad' }],
  }), '');
});


test('checkout UI: supporting human characters require their own photo before submit', () => {
  const src = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.match(src, /Family, friends, or pets in the story/);
  assert.match(src, /Person — photo required/);
  assert.match(src, /Pet — photo optional/);
  assert.match(src, /missingSupportingHumanPhotos\.length > 0/);
  assert.match(src, /supportingCharacterPhoto:\$\{character\.id\}/);
});
