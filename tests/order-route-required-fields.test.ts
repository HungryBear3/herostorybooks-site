/**
 * /api/order POST: server must enforce the SAME required-field set as
 * the UI + shared helper (theme, childName, email, and photo-or-description).
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
  appearanceDescription: 'medium skin and curly dark hair',
  photoReady: false,
};

test('server contract: missing theme → theme_required', () => {
  const m = missingRequiredField({ ...FULL, theme: '' });
  assert.equal(m, 'adventure');
  assert.equal(missingFieldErrorCode(m), 'theme_required');
});

test('server contract: missing hero photo and description → appearance_description_required', () => {
  const m = missingRequiredField({ ...FULL, appearanceDescription: '' });
  assert.equal(m, 'appearance_description');
  assert.equal(missingFieldErrorCode(m), 'appearance_description_required');
});

test('server contract: hero photo permits an empty appearance description', () => {
  const m = missingRequiredField({
    ...FULL,
    appearanceDescription: '',
    photoReady: true,
  });
  assert.equal(m, null);
});

test('server contract: pronouns are not required for checkout submit', () => {
  const m = missingRequiredField(FULL);
  assert.equal(m, null);
  assert.equal(missingFieldErrorCode(m), null);
});

test('server contract: full happy path returns null + null code', () => {
  const m = missingRequiredField(FULL);
  assert.equal(m, null);
  assert.equal(missingFieldErrorCode(m), null);
});

test('server contract: written appearance description satisfies the no-photo path', () => {
  const m = missingRequiredField({
    theme: 'brave-explorer',
    childName: 'Emma',
    email: 'a@b.com',
    appearanceDescription: 'deep skin, coily dark hair',
    photoReady: false,
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
  assert.doesNotMatch(src, /missingRequiredField\(\{[^}]*childPronouns/s);
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

test('checkout contract: simplified appearance UI removes stale single-select and suggestion copy', () => {
  const src = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.match(src, /How should the hero look\?/);
  assert.match(src, /Must include/);
  assert.match(src, /head-covering/);
  assert.match(src, /hero photo or description/);
  assert.doesNotMatch(src, /Glasses or aids/);
  assert.doesNotMatch(src, /Story wording/);
  assert.doesNotMatch(src, /hijab/i);
});

test('checkout contract: order route validates real photo bytes, derives intent, and fails closed on upload loss', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /const hasPhotoUpload = photo instanceof File && photo\.size > 0/);
  assert.match(src, /await validateOrderPhotoFile\(photo\)/);
  assert.match(src, /const photoReady = photoValidation\.ok === true/);
  assert.match(src, /likenessIntent: likenessIntentForPhoto\(photoReady\)/);
  assert.match(src, /clearUntrustedSupportingPhotoMetadata/);
  assert.match(src, /new Set\(supportingPhotoFiles\.keys\(\)\)/);
  assert.match(src, /await persistNewOrder\(draftOrder\)/);
  assert.match(src, /withOrderTransaction\(draftOrder\.id/);
  assert.ok(src.indexOf('await persistNewOrder(draftOrder)') < src.indexOf('await uploadOrderPhoto'));
  assert.match(src, /rollbackOrderMediaUploads/);
  assert.match(src, /rollbackUploadedMedia\('supporting photo persistence failure'\)/);
  assert.match(src, /rollbackUploadedMedia\('voice persistence failure'\)/);
  assert.match(src, /rollbackUploadedMedia\('final order persistence failure'\)/);
  assert.match(src, /ABORT BEFORE STRIPE: photo upload failed/);
  assert.match(src, /ABORT BEFORE STRIPE: supporting photo upload failed/);
  assert.doesNotMatch(src, /continuing without photo/);
  assert.doesNotMatch(src, /continuing without that photo/);
});

test('checkout contract advertises and accepts only deployed-runtime photo codecs', () => {
  const route = readFileSync('src/app/api/order/route.ts', 'utf8');
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const validator = readFileSync('src/lib/photo-file-validation.ts', 'utf8');
  for (const src of [route, checkout, validator]) {
    assert.doesNotMatch(src, /HEIC|HEIF|image\/heic|image\/heif/i);
  }
  assert.match(checkout, /image\/jpeg,image\/png,image\/webp/);
});
