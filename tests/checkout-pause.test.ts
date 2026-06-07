import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHECKOUT_PAUSED_CODE,
  CHECKOUT_PAUSED_MESSAGE,
  isCheckoutCapacityFull,
  isCheckoutPaused,
  parsePublicCheckoutDailyPaidLimit,
} from '../src/lib/checkout-pause.ts';
import { DAILY_PAID_CEILING } from '../src/lib/capacity-dashboard.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

function paidOrder(id: string, createdAt = '2026-06-01T15:00:00.000Z'): OrderRecord {
  return {
    id,
    childName: 'Luna',
    bookFormat: 'classic',
    formatLabel: 'Classic softcover',
    priceCents: 4499,
    status: 'order_received',
    paymentStatus: 'paid',
    fulfillmentStatus: 'awaiting_qa',
    email: 'parent@example.com',
    deliveryExpectation: 'Proof first',
    createdAt,
    updatedAt: createdAt,
  } as OrderRecord;
}

test('isCheckoutPaused only enables for true, allowing Vercel env whitespace/case', () => {
  assert.equal(isCheckoutPaused('true'), true);
  assert.equal(isCheckoutPaused(' TRUE '), true);
  assert.equal(isCheckoutPaused('false'), false);
  assert.equal(isCheckoutPaused(''), false);
  assert.equal(isCheckoutPaused(undefined), false);
});

test('parsePublicCheckoutDailyPaidLimit accepts bounded integer caps and treats bad configured caps as closed', () => {
  assert.equal(parsePublicCheckoutDailyPaidLimit(undefined), null);
  assert.equal(parsePublicCheckoutDailyPaidLimit(''), null);
  assert.equal(parsePublicCheckoutDailyPaidLimit(' 2 '), 2);
  assert.equal(parsePublicCheckoutDailyPaidLimit('0'), 0);
  assert.equal(parsePublicCheckoutDailyPaidLimit('-1'), 0);
  assert.equal(parsePublicCheckoutDailyPaidLimit('many'), 0);
  assert.equal(parsePublicCheckoutDailyPaidLimit('101'), 0);
});

test('isCheckoutCapacityFull trips when the daily paid ceiling is already hit', () => {
  const nine = Array.from({ length: DAILY_PAID_CEILING - 1 }, (_, i) => paidOrder(`ord_nine_${i}`));
  const ten = Array.from({ length: DAILY_PAID_CEILING }, (_, i) => paidOrder(`ord_ten_${i}`));
  assert.equal(isCheckoutCapacityFull(nine, new Date('2026-06-01T22:00:00.000Z')), false);
  assert.equal(isCheckoutCapacityFull(ten, new Date('2026-06-01T22:00:00.000Z')), true);
});

test('isCheckoutCapacityFull honors HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT override', () => {
  const old = process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT;
  try {
    process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT = '1';
    const none: OrderRecord[] = [];
    const one = [paidOrder('ord_one')];
    assert.equal(isCheckoutCapacityFull(none, new Date('2026-06-01T22:00:00.000Z')), false);
    assert.equal(isCheckoutCapacityFull(one, new Date('2026-06-01T22:00:00.000Z')), true);

    process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT = 'invalid';
    assert.equal(isCheckoutCapacityFull(none, new Date('2026-06-01T22:00:00.000Z')), true);
  } finally {
    if (old === undefined) delete process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT;
    else process.env.HSB_PUBLIC_CHECKOUT_DAILY_PAID_LIMIT = old;
  }
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
  const capacityIdx = src.indexOf('if (isCheckoutCapacityFull(await listOrders()))');
  const formIdx = src.indexOf('await request.formData()');
  const stripeIdx = src.indexOf('stripe.checkout.sessions.create');

  assert.ok(pauseIdx > -1, 'route must check checkout pause flag');
  assert.ok(capacityIdx > -1, 'route must check system-side capacity pause');
  assert.ok(formIdx > -1, 'route must parse form data after pause check');
  assert.ok(stripeIdx > -1, 'route must create Stripe checkout after pause check');
  assert.ok(pauseIdx < formIdx, 'pause response must happen before form validation/parsing');
  assert.ok(pauseIdx < stripeIdx, 'pause response must happen before Stripe checkout');
  assert.ok(capacityIdx < formIdx, 'capacity pause response must happen before form validation/parsing');
  assert.ok(capacityIdx < stripeIdx, 'capacity pause response must happen before Stripe checkout');
  assert.match(src, /listOrders/);
  assert.match(src, /isCheckoutCapacityFull/);
  assert.match(src, /CHECKOUT_PAUSED_MESSAGE/);
  assert.match(src, /CHECKOUT_PAUSED_CODE/);
  assert.equal(CHECKOUT_PAUSED_CODE, 'checkout_paused');
  assert.match(CHECKOUT_PAUSED_MESSAGE, /proof-review queue is full/i);
  assert.match(CHECKOUT_PAUSED_MESSAGE, /check back tomorrow/i);
});
