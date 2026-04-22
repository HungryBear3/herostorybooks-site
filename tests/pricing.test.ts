import test from 'node:test';
import assert from 'node:assert/strict';

import { PUBLIC_PRICING_PLANS } from '../src/lib/pricing.ts';

test('public pricing plans match live checkout tiers and published route', () => {
  assert.deepEqual(
    PUBLIC_PRICING_PLANS.map((plan) => [plan.id, plan.price]),
    [
      ['digital', '$29.99'],
      ['classic', '$49.99'],
      ['premium', '$79.99'],
    ],
  );
});

test('print plans promise preview approval before printing', () => {
  const printPlans = PUBLIC_PRICING_PLANS.filter((plan) => plan.id !== 'digital');
  assert.equal(printPlans.length, 2);
  for (const plan of printPlans) {
    assert.match(plan.promise, /preview/i);
    assert.match(plan.promise, /before it prints/i);
  }
});
