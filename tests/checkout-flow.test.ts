import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKOUT_SECTION_ORDER,
  PRINT_PREVIEW_PROMISE,
  PHOTO_UPLOAD_HELP,
  canSubmitCheckoutForm,
  selectAdventureValue,
  missingRequiredField,
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

test('canSubmitCheckoutForm: allows submit only when every required field is present', () => {
  assert.equal(canSubmitCheckoutForm(FULL), true);
});

test('missingRequiredField: reports the first gap for the disabled-state label', () => {
  assert.equal(missingRequiredField({ ...FULL, theme: '' }), 'adventure');
  assert.equal(missingRequiredField({ ...FULL, childName: '' }), 'name');
  assert.equal(missingRequiredField({ ...FULL, email: '' }), 'email');
  assert.equal(missingRequiredField({ ...FULL, skinTone: '' }), 'skin_tone');
  assert.equal(missingRequiredField({ ...FULL, hairStyle: '' }), 'hair_style');
  assert.equal(missingRequiredField(FULL), null);
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
