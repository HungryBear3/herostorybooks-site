import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_SECTION_ORDER,
  PRINT_PREVIEW_PROMISE,
  PHOTO_UPLOAD_HELP,
  canSubmitCheckoutForm,
  currentCheckoutStep,
  likenessIntentForPhoto,
  missingFieldPrompt,
  missingRequiredField,
  selectAdventureValue,
} from '../src/lib/checkout-flow.ts';

const CHECKOUT_FORM_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

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

test('photo upload help explains the photo-or-description path', () => {
  assert.match(PHOTO_UPLOAD_HELP, /look like them/i);
  assert.match(PHOTO_UPLOAD_HELP, /without a photo/i);
  assert.match(PHOTO_UPLOAD_HELP, /description/i);
  assert.match(PHOTO_UPLOAD_HELP, /automatically reduced/i);
  assert.doesNotMatch(PHOTO_UPLOAD_HELP, /required before production starts/i);
});

test('likeness intent is derived from photo presence', () => {
  assert.equal(likenessIntentForPhoto(true), 'match');
  assert.equal(likenessIntentForPhoto(false), 'storybook');
});

const FULL = {
  theme: 'brave-explorer',
  childName: 'Emma',
  email: 'a@b.com',
  appearanceDescription: 'warm brown skin and short curly dark hair',
  photoReady: false,
};

test('canSubmitCheckoutForm: blocks submit when no adventure is selected', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, theme: '' }), false);
});

test('canSubmitCheckoutForm: blocks submit when childName or email is missing', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, childName: '' }), false);
  assert.equal(canSubmitCheckoutForm({ ...FULL, email: '' }), false);
});

test('canSubmitCheckoutForm: no-photo hero requires a written appearance description', () => {
  assert.equal(canSubmitCheckoutForm({ ...FULL, appearanceDescription: '' }), false);
  assert.equal(canSubmitCheckoutForm({ ...FULL, appearanceDescription: '   ' }), false);
});

test('canSubmitCheckoutForm: a hero photo satisfies the appearance gate without written details', () => {
  assert.equal(canSubmitCheckoutForm({
    ...FULL,
    appearanceDescription: '',
    photoReady: true,
  }), true);
});

test('canSubmitCheckoutForm: does not require hero pronouns', () => {
  assert.equal(canSubmitCheckoutForm(FULL), true);
});

test('checkout buyer UI does not ask for pronouns', () => {
  assert.doesNotMatch(CHECKOUT_FORM_SRC, />\s*Pronouns\s*</i);
  assert.doesNotMatch(CHECKOUT_FORM_SRC, /Select pronouns/i);
  assert.doesNotMatch(CHECKOUT_FORM_SRC, /childPronouns/i);
});

test('canSubmitCheckoutForm: allows submit only when every required field is present', () => {
  assert.equal(canSubmitCheckoutForm(FULL), true);
});

test('missingRequiredField: reports the first gap for the disabled-state label', () => {
  assert.equal(missingRequiredField({ ...FULL, theme: '' }), 'adventure');
  assert.equal(missingRequiredField({ ...FULL, childName: '' }), 'name');
  assert.equal(missingRequiredField({ ...FULL, email: '' }), 'email');
  assert.equal(missingRequiredField({ ...FULL, appearanceDescription: '' }), 'appearance_description');
  assert.equal(missingRequiredField({
    ...FULL,
    appearanceDescription: '',
    photoReady: true,
  }), null);
  assert.equal(missingRequiredField(FULL), null);
});

test('missingFieldPrompt: gives clear next-action copy for the checkout CTA/help text', () => {
  assert.match(missingFieldPrompt('adventure'), /choose an adventure/i);
  assert.match(missingFieldPrompt('name'), /enter.*child.?s name/i);
  assert.match(missingFieldPrompt('email'), /enter.*email/i);
  assert.match(missingFieldPrompt('appearance_description'), /describe.*hero/i);
  assert.equal(missingFieldPrompt(null), null);
});

test('currentCheckoutStep: surfaces the current step and completed count clearly', () => {
  assert.deepEqual(currentCheckoutStep({
    theme: '', childName: '', email: '', appearanceDescription: '', photoReady: false,
  }), { current: 'Adventure', completedCount: 0, totalCount: 5 });

  assert.deepEqual(currentCheckoutStep({
    theme: 'brave-explorer', childName: '', email: '', appearanceDescription: '', photoReady: false,
  }), { current: 'Hero', completedCount: 1, totalCount: 5 });

  assert.deepEqual(currentCheckoutStep({
    theme: 'brave-explorer', childName: 'Emma', email: 'a@b.com', appearanceDescription: 'short curly dark hair', photoReady: false,
  }), { current: 'Photo', completedCount: 4, totalCount: 5 });

  assert.deepEqual(currentCheckoutStep({
    theme: 'brave-explorer', childName: 'Emma', email: 'a@b.com', appearanceDescription: '', photoReady: true,
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
