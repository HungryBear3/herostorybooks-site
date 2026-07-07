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

// P1: Stripe shipping must match the site's US-only fulfillment copy
// ("Free shipping included for US orders" / "Shipping (US)"). Allowing
// CA/GB/AU/NZ let non-US buyers complete a print order we don't promise
// to ship. Pin the allow-list to US so checkout can't outrun the copy.
test('server contract: print shipping is restricted to US only', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /allowed_countries:\s*\[\s*['"]US['"]\s*\]/);
  assert.doesNotMatch(src, /allowed_countries:[^\]]*['"](?:CA|GB|AU|NZ)['"]/);
});

// P2: receipts + the thank-you handoff must name the hero, not assume the
// legacy childName field. heroName is always populated (falls back to
// childName in createOrderRecord), so this is correct today and stays
// correct once a non-child primary hero can make heroName != childName.
test('server contract: Stripe product name + success param use heroName ?? childName', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /childName:\s*order\.heroName\s*\?\?\s*order\.childName/);
  assert.match(src, /HeroStoryBook — \$\{order\.heroName \?\? order\.childName\}/);
  assert.doesNotMatch(src, /HeroStoryBook — \$\{order\.childName\}/);
});
