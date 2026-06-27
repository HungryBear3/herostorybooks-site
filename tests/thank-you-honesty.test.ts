import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('thank-you page is honest for pending, failed, and checkout-session failure states', () => {
  const src = readFileSync('src/app/thank-you/page.tsx', 'utf8');
  assert.match(src, /paymentStatus === 'paid'/);
  assert.match(src, /paymentStatus === 'failed'/);
  assert.match(src, /checkoutSessionStatus === 'failed'/);
  assert.match(src, /Checkout did not start/);
  assert.match(src, /No charge was made/);
  assert.match(src, /Confirming your payment/);
});
