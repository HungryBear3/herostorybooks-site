import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('finalize route voids persisted pending order and reopens draft when Stripe session creation fails', () => {
  const route = readFileSync('src/app/api/order/finalize/route.ts', 'utf8');
  const orders = readFileSync('src/lib/orders.ts', 'utf8');

  assert.match(route, /voidCheckoutFailedOrder/);
  assert.match(route, /familyContributionToken:\s*null/);
  assert.match(route, /paymentStatus:\s*'failed'/);
  assert.match(route, /status:\s*'checkout_failed'/);
  assert.match(route, /status:\s*'assets_uploaded'/);
  assert.match(route, /orderId:\s*null/);
  assert.match(orders, /checkout_failed/);
});
