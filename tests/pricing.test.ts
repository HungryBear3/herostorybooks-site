import test from 'node:test';
import assert from 'node:assert/strict';

import { PUBLIC_PRICING_PLANS } from '../src/lib/pricing.ts';

test('public pricing plans match live checkout tiers and published route', () => {
  assert.deepEqual(
    PUBLIC_PRICING_PLANS.map((plan) => [plan.id, plan.price]),
    [
      ['digital', '$14.99'],
      ['classic', '$44.99'],
      ['premium', '$64.99'],
    ],
  );
});

test('print plans (Classic + Premium) clearly include free shipping', () => {
  const printPlans = PUBLIC_PRICING_PLANS.filter((plan) => plan.id !== 'digital');
  for (const plan of printPlans) {
    const hasFreeShippingFeature = plan.features.some((f) => /free shipping/i.test(f));
    const promiseSaysFreeShipping = /free shipping/i.test(plan.promise);
    assert.ok(
      hasFreeShippingFeature || promiseSaysFreeShipping,
      `${plan.id} must surface free shipping in features or promise`,
    );
  }
});

test('digital plan does NOT claim free shipping', () => {
  const digital = PUBLIC_PRICING_PLANS.find((plan) => plan.id === 'digital');
  assert.ok(digital);
  assert.equal(/free shipping/i.test(digital!.promise), false, 'digital promise must not mention shipping');
  assert.equal(
    digital!.features.some((f) => /shipping/i.test(f)),
    false,
    'digital features must not mention shipping',
  );
});

test('print plans promise preview approval before printing', () => {
  const printPlans = PUBLIC_PRICING_PLANS.filter((plan) => plan.id !== 'digital');
  assert.equal(printPlans.length, 2);
  for (const plan of printPlans) {
    assert.match(plan.promise, /proof/i);
    assert.match(plan.promise, /before (it )?prints/i);
  }
});

test('digital plan uses the current published launch price without stale discount anchoring', () => {
  const digital = PUBLIC_PRICING_PLANS.find((plan) => plan.id === 'digital');
  assert.ok(digital);
  assert.equal(digital!.price, '$14.99');
  assert.equal(digital!.anchorPrice, undefined);
});

test('premium plan is a hardcover keepsake edition without extra-copy bundle language', () => {
  const premium = PUBLIC_PRICING_PLANS.find((plan) => plan.id === 'premium');
  assert.ok(premium);
  assert.match(premium!.description, /hardcover keepsake edition/i);
  assert.ok(premium!.features.some((feature) => /hardcover printed book/i.test(feature)));
  assert.ok(premium!.features.some((feature) => /digital pdf included/i.test(feature)));
  assert.ok(premium!.features.some((feature) => /gifted keepsake/i.test(feature)));
  assert.ok(premium!.features.every((feature) => !/extra softcover copies|extra copies/i.test(feature)));
});
