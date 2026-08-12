import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getRequiredStripeProductId } from '../src/lib/stripe-products.ts';

const PRODUCT_ENV = {
  digital: 'STRIPE_PRODUCT_DIGITAL_ID',
  classic: 'STRIPE_PRODUCT_CLASSIC_ID',
  premium: 'STRIPE_PRODUCT_PREMIUM_ID',
} as const;

async function withProductEnv(
  values: Partial<Record<(typeof PRODUCT_ENV)[keyof typeof PRODUCT_ENV], string | undefined>>,
  run: () => void | Promise<void>,
) {
  const previous = Object.fromEntries(
    Object.values(PRODUCT_ENV).map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of Object.values(PRODUCT_ENV)) delete process.env[name];
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) process.env[name] = value;
    }
    await run();
  } finally {
    for (const name of Object.values(PRODUCT_ENV)) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('each book format resolves to its dedicated stable Stripe Product', async () => {
  await withProductEnv(
    {
      STRIPE_PRODUCT_DIGITAL_ID: '  prod_digital123\n',
      STRIPE_PRODUCT_CLASSIC_ID: 'prod_classic123',
      STRIPE_PRODUCT_PREMIUM_ID: 'prod_premium123',
    },
    () => {
      assert.equal(getRequiredStripeProductId('digital'), 'prod_digital123');
      assert.equal(getRequiredStripeProductId('classic'), 'prod_classic123');
      assert.equal(getRequiredStripeProductId('premium'), 'prod_premium123');
    },
  );
});

test('missing Product binding fails closed with the exact format and env name', async () => {
  await withProductEnv({}, () => {
    assert.throws(
      () => getRequiredStripeProductId('digital'),
      /Missing stable Stripe Product binding for digital: STRIPE_PRODUCT_DIGITAL_ID/,
    );
  });
});

test('malformed Product binding fails closed instead of accepting a Price or arbitrary value', async () => {
  await withProductEnv({ STRIPE_PRODUCT_DIGITAL_ID: 'price_wrong_object' }, () => {
    assert.throws(
      () => getRequiredStripeProductId('digital'),
      /Invalid Stripe Product ID for digital: STRIPE_PRODUCT_DIGITAL_ID/,
    );
  });
});

test('primary checkout binds price_data to a stable Product and allows promotion codes', () => {
  const src = readFileSync('src/app/api/order/route.ts', 'utf8');
  const bindingIdx = src.indexOf('getRequiredStripeProductId(draftOrder.bookFormat)');
  const createIdx = src.indexOf('stripe.checkout.sessions.create');

  assert.ok(bindingIdx > -1, 'route must resolve the stable Product binding');
  assert.ok(createIdx > bindingIdx, 'Product binding must resolve before Stripe Session creation');
  assert.match(src, /allow_promotion_codes:\s*true/);
  assert.match(src, /price_data:\s*\{[\s\S]*?product:\s*stripeProductId/);
  assert.doesNotMatch(src, /price_data:\s*\{[\s\S]*?product_data:\s*\{/);
});
