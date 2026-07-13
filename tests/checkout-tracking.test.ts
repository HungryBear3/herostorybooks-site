import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildCheckoutTracking,
  checkoutTrackingFromSearchParams,
  sanitizeCheckoutTrackingValue,
} from '../src/lib/checkout-tracking.ts';
import { createOrderRecord } from '../src/lib/orders.ts';

test('sanitizeCheckoutTrackingValue keeps short safe tester tokens', () => {
  assert.equal(sanitizeCheckoutTrackingValue(' FF-Beta '), 'ff-beta');
  assert.equal(sanitizeCheckoutTrackingValue('alex_friend01'), 'alex_friend01');
  assert.equal(sanitizeCheckoutTrackingValue('a'), 'a');
});

test('sanitizeCheckoutTrackingValue drops unsafe or overlong values', () => {
  assert.equal(sanitizeCheckoutTrackingValue(''), null);
  assert.equal(sanitizeCheckoutTrackingValue('ff beta'), null);
  assert.equal(sanitizeCheckoutTrackingValue('../secret'), null);
  assert.equal(sanitizeCheckoutTrackingValue('<script>alert(1)</script>'), null);
  assert.equal(sanitizeCheckoutTrackingValue('x'.repeat(41)), null);
});

test('checkoutTrackingFromSearchParams captures cohort and invite from normal checkout URLs', () => {
  const params = new URLSearchParams('cohort=FF-Beta&invite=AlexFriend01&ignored=value');
  assert.deepEqual(checkoutTrackingFromSearchParams(params), {
    cohort: 'ff-beta',
    invite: 'alexfriend01',
  });
});

test('buildCheckoutTracking returns null when nothing safe is present', () => {
  assert.equal(buildCheckoutTracking({ cohort: 'bad value', invite: 'x'.repeat(80) }), null);
});

test('createOrderRecord persists sanitized checkout tracking', () => {
  const order = createOrderRecord(
    {
      childName: 'Mia',
      bookFormat: 'digital',
      email: 'Parent@Example.com',
      checkoutTracking: { cohort: 'ff-beta', invite: 'alexfriend01' },
    },
    { id: 'ord_tracking', now: '2026-07-13T18:00:00Z' },
  );
  assert.deepEqual(order.checkoutTracking, { cohort: 'ff-beta', invite: 'alexfriend01' });
});

test('checkout client forwards tracking params to the normal order API payload', () => {
  const src = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  assert.match(src, /checkoutTrackingFromSearchParams/);
  assert.match(src, /payload\.set\("cohort", checkoutTracking\.cohort\)/);
  assert.match(src, /payload\.set\("invite", checkoutTracking\.invite\)/);
  assert.doesNotMatch(src, /create\/your-memory/, 'normal F&F tracking must not route through a redundant checkout');
});

test('order route sanitizes tracking before persistence and Stripe metadata', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  assert.match(src, /buildCheckoutTracking/);
  assert.match(src, /checkoutTracking,/);
  assert.match(src, /metadata:\s*{[\s\S]*orderId: order\.id[\s\S]*cohort: order\.checkoutTracking\.cohort[\s\S]*invite: order\.checkoutTracking\.invite[\s\S]*}/);
});
