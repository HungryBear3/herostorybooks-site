import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getOptionalStripeSecretKey,
  getRequiredStripeSecretKey,
  getOptionalStripeWebhookSecret,
  getRequiredStripeWebhookSecret,
} from '../src/lib/stripe-env.ts';

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    prev.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const restore = () => {
    for (const [key, value] of prev.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const done = Promise.resolve().then(fn);
  return done.finally(restore);
}

test('getRequiredStripeSecretKey trims surrounding whitespace and newlines', async () => {
  await withEnv(
    { STRIPE_SECRET_KEY: '  fake_secret_with_newline\n' },
    async () => {
      assert.equal(getRequiredStripeSecretKey(), 'fake_secret_with_newline');
    },
  );
});

test('getOptionalStripeSecretKey returns null when env is blank after trimming', async () => {
  await withEnv(
    { STRIPE_SECRET_KEY: ' \n\t  ' },
    async () => {
      assert.equal(getOptionalStripeSecretKey(), null);
    },
  );
});

test('getRequiredStripeSecretKey removes accidental literal escaped newlines', async () => {
  await withEnv(
    { STRIPE_SECRET_KEY: 'fake_secret_with_literal_newline\\n' },
    async () => {
      assert.equal(getRequiredStripeSecretKey(), 'fake_secret_with_literal_newline');
    },
  );
});

test('getRequiredStripeWebhookSecret trims surrounding whitespace and newlines', async () => {
  await withEnv(
    { STRIPE_WEBHOOK_SECRET: '  fake_webhook_secret_with_newline\n' },
    async () => {
      assert.equal(getRequiredStripeWebhookSecret(), 'fake_webhook_secret_with_newline');
    },
  );
});

test('getOptionalStripeWebhookSecret returns null when env is blank after trimming', async () => {
  await withEnv(
    { STRIPE_WEBHOOK_SECRET: ' \n\t  ' },
    async () => {
      assert.equal(getOptionalStripeWebhookSecret(), null);
    },
  );
});

test('stripe callsites use shared sanitized env helpers', () => {
  const orderRoute = readFileSync('src/lib/checkout-order-route-handler.ts', 'utf8') + readFileSync('src/app/api/order/route.ts', 'utf8');
  const webhookRoute = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  const adminActions = readFileSync('src/lib/admin-actions.ts', 'utf8');

  assert.match(orderRoute, /getRequiredStripeSecretKey/);
  assert.match(webhookRoute, /getRequiredStripeSecretKey/);
  assert.match(webhookRoute, /getRequiredStripeWebhookSecret/);
  assert.match(adminActions, /getOptionalStripeSecretKey/);
});
