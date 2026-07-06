/**
 * Regression coverage for buyer-facing promo-code guidance in checkout.
 *
 * Background:
 *   HSB checkout hands off to Stripe Checkout, which is where promo codes
 *   are actually entered (the session sets allow_promotion_codes: true in
 *   src/app/api/order/route.ts). A buyer entered a code expecting a discount
 *   and paid full price because the code has to be applied on Stripe's page,
 *   not this app's form. To prevent that confusion, the checkout flow must
 *   carry clear copy telling buyers where/when to apply a promo code and to
 *   stop if the discount is not visible before paying.
 *
 *   These tests assert the guidance exists in the shared copy constant AND
 *   that the checkout form actually renders it, so the callout cannot be
 *   silently dropped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROMO_CODE_HELP } from '../src/lib/checkout-flow.ts';

const repoRoot = join(import.meta.dirname, '..');
const checkoutForm = readFileSync(
  join(repoRoot, 'src/app/checkout/checkout-form.tsx'),
  'utf8',
);

test('PROMO_CODE_HELP names Stripe as where the code is applied', () => {
  assert.match(PROMO_CODE_HELP, /promo code/i);
  assert.match(PROMO_CODE_HELP, /Stripe/);
});

test('PROMO_CODE_HELP tells buyers to Apply the code before paying', () => {
  assert.match(PROMO_CODE_HELP, /Apply/);
  assert.match(PROMO_CODE_HELP, /before paying/i);
});

test('PROMO_CODE_HELP gives a stop-and-contact-support path if no discount shows', () => {
  assert.match(PROMO_CODE_HELP, /stop/i);
  assert.match(PROMO_CODE_HELP, /support@herostorybooks\.com/);
});

test('PROMO_CODE_HELP does not name an active/public promo code (avoid overpromising)', () => {
  // Guidance stays general — naming a live code implies public availability.
  assert.doesNotMatch(PROMO_CODE_HELP, /ERIC50/i);
});

test('checkout form imports and renders the promo-code guidance', () => {
  assert.match(checkoutForm, /PROMO_CODE_HELP/);
  assert.match(checkoutForm, /\{PROMO_CODE_HELP\}/);
});
