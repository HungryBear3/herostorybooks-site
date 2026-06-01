import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_PAUSED_CODE,
  CHECKOUT_PAUSED_MESSAGE,
  isCheckoutPaused,
} from '../src/lib/checkout-pause.ts';

test('isCheckoutPaused only enables for true, allowing Vercel env whitespace/case', () => {
  assert.equal(isCheckoutPaused('true'), true);
  assert.equal(isCheckoutPaused(' TRUE '), true);
  assert.equal(isCheckoutPaused('false'), false);
  assert.equal(isCheckoutPaused(''), false);
  assert.equal(isCheckoutPaused(undefined), false);
});

test('checkout page gates the active form behind the pause flag', () => {
  const src = readFileSync('src/app/checkout/page.tsx', 'utf8');
  assert.match(src, /isCheckoutPaused\(\)/);
  assert.match(src, /<CheckoutPaused \/>/);
  assert.match(src, /<CheckoutForm \/>/);
  assert.match(src, /No orders or payments can be started while checkout is paused/);
  assert.match(src, /export const dynamic = 'force-dynamic'/, 'checkout must read pause flag at request time, not static build time');
});

test('order route checks pause before parsing form data or creating Stripe checkout', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  const pauseIdx = src.indexOf('if (isCheckoutPaused())');
  const formIdx = src.indexOf('await request.formData()');
  const stripeIdx = src.indexOf('stripe.checkout.sessions.create');

  assert.ok(pauseIdx > -1, 'route must check checkout pause flag');
  assert.ok(formIdx > -1, 'route must parse form data after pause check');
  assert.ok(stripeIdx > -1, 'route must create Stripe checkout after pause check');
  assert.ok(pauseIdx < formIdx, 'pause response must happen before form validation/parsing');
  assert.ok(pauseIdx < stripeIdx, 'pause response must happen before Stripe checkout');
  assert.match(src, /CHECKOUT_PAUSED_MESSAGE/);
  assert.match(src, /CHECKOUT_PAUSED_CODE/);
  assert.equal(CHECKOUT_PAUSED_CODE, 'checkout_paused');
  assert.match(CHECKOUT_PAUSED_MESSAGE, /proof-review queue is full/i);
  assert.match(CHECKOUT_PAUSED_MESSAGE, /check back tomorrow/i);
});
