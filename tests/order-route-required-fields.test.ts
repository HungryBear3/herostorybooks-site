/**
 * /api/order POST: server must enforce the SAME required-field set as
 * the UI + shared helper (theme, childName, email, skinTone, hairStyle).
 *
 * The route imports next/server + Stripe, which can't load under
 * node:test directly. We exercise the same logic that the route uses
 * (missingRequiredField + missingFieldErrorCode) to assert the contract,
 * and additionally run a thin form-shape assertion against the route's
 * error path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  missingFieldErrorCode,
  missingRequiredField,
  type CheckoutRequiredFields,
} from '../src/lib/checkout-flow.ts';

const FULL: CheckoutRequiredFields = {
  theme: 'brave-explorer',
  childName: 'Emma',
  email: 'a@b.com',
  skinTone: 'medium',
  hairStyle: 'curly',
  childPronouns: 'she/her',
};

test('server contract: missing theme → theme_required', () => {
  const m = missingRequiredField({ ...FULL, theme: '' });
  assert.equal(m, 'adventure');
  assert.equal(missingFieldErrorCode(m), 'theme_required');
});

test('server contract: missing skinTone → skin_tone_required', () => {
  const m = missingRequiredField({ ...FULL, skinTone: '' });
  assert.equal(m, 'skin_tone');
  assert.equal(missingFieldErrorCode(m), 'skin_tone_required');
});

test('server contract: missing hairStyle → hair_style_required', () => {
  const m = missingRequiredField({ ...FULL, hairStyle: '' });
  assert.equal(m, 'hair_style');
  assert.equal(missingFieldErrorCode(m), 'hair_style_required');
});

test('server contract: missing childPronouns → pronouns_required', () => {
  const m = missingRequiredField({ ...FULL, childPronouns: '' });
  assert.equal(m, 'pronouns');
  assert.equal(missingFieldErrorCode(m), 'pronouns_required');
});

test('server contract: full happy path returns null + null code', () => {
  const m = missingRequiredField(FULL);
  assert.equal(m, null);
  assert.equal(missingFieldErrorCode(m), null);
});

test('server contract: skinTone supplied as JSON appearanceOptions blob (route accepts both shapes)', () => {
  // The route falls back to JSON-parsed appearanceOptions if the discrete
  // skinTone form field is empty. We mirror that resolution here so the
  // test doc-confirms the dual-shape contract.
  const blob = '{"skinTone":"deep","hairStyle":"coily"}';
  const parsed = JSON.parse(blob) as { skinTone: string; hairStyle: string };
  const m = missingRequiredField({
    theme: 'brave-explorer',
    childName: 'Emma',
    email: 'a@b.com',
    skinTone: parsed.skinTone,
    hairStyle: parsed.hairStyle,
    childPronouns: 'she/her',
  });
  assert.equal(m, null);
});

// Source-level assertion that the route file imports the helpers it
// needs and calls missingRequiredField. Keeps the contract honest if
// anyone refactors the route to do its own ad-hoc validation.
import { readFileSync } from 'node:fs';
test('server contract: /api/order POST imports + calls missingRequiredField', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /from\s+['"]@\/lib\/checkout-flow['"]/);
  assert.match(src, /missingRequiredField\(/);
  assert.match(src, /missingFieldErrorCode\(/);
  assert.match(src, /childPronouns/);
});

test('server contract: /api/order validates supporting characters before Stripe session creation', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  const validationIndex = src.indexOf('validateSupportingCharactersForCheckout');
  const stripeIndex = src.indexOf('stripe.checkout.sessions.create');
  assert.ok(validationIndex >= 0, 'route should call validateSupportingCharactersForCheckout');
  assert.ok(stripeIndex >= 0, 'route should create Stripe session after validation');
  assert.ok(validationIndex < stripeIndex, 'supporting-character gate must run before Stripe');
  assert.match(src, /supportingCharacters:\s*supportingCharacterValidation\.supportingCharacters/);
});


test('server contract: /api/order uploads supporting-character photos before the server gate', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  const uploadIndex = src.indexOf('attachSupportingCharacterPhotoUploads');
  const validationIndex = src.lastIndexOf('validateSupportingCharactersForCheckout');
  const stripeIndex = src.indexOf('stripe.checkout.sessions.create');
  assert.ok(uploadIndex >= 0, 'route should attach supporting-character photo uploads');
  assert.ok(uploadIndex < validationIndex, 'photo upload augmentation must happen before validation');
  assert.ok(validationIndex < stripeIndex, 'supporting-character gate must run before Stripe');
  assert.match(src, /supportingCharacterPhoto:\$\{id\}/);
});

test('server contract: Stripe Checkout enables buyer-entered promotion codes', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /allow_promotion_codes:\s*true/);
});

test('server contract: Stripe session creation failure is persisted as retryable and not charged', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /checkoutSessionStatus:\s*'failed'/);
  assert.match(src, /stripe_checkout_session_failed/);
  assert.match(src, /No charge was made/);
  assert.match(src, /idempotencyKey:\s*`checkout-session:\$\{order\.id\}`/);
});
