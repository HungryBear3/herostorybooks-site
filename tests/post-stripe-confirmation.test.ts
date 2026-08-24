import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRMATION_POLL_INTERVAL_MS,
  getConfirmationPollDecision,
} from '../src/lib/confirmation-poll.ts';
import { confirmCheckoutPayment, isExactSettledCheckoutSession } from '../src/lib/checkout-session-confirmation.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';

test('confirmation polls every 1.5 seconds and waits five seconds before Stripe fallback', () => {
  assert.equal(CONFIRMATION_POLL_INTERVAL_MS, 1_500);
  assert.deepEqual(getConfirmationPollDecision(0), {
    shouldPoll: true,
    includeStripeSession: false,
    showSupportState: false,
  });
  assert.deepEqual(getConfirmationPollDecision(4_999), {
    shouldPoll: true,
    includeStripeSession: false,
    showSupportState: false,
  });
  assert.deepEqual(getConfirmationPollDecision(5_000), {
    shouldPoll: true,
    includeStripeSession: true,
    showSupportState: false,
  });
});

test('confirmation stops automatic polling at sixty seconds and shows support state', () => {
  assert.deepEqual(getConfirmationPollDecision(59_999), {
    shouldPoll: true,
    includeStripeSession: true,
    showSupportState: false,
  });
  assert.deepEqual(getConfirmationPollDecision(60_000), {
    shouldPoll: false,
    includeStripeSession: false,
    showSupportState: true,
  });
});

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'classic', email: 'buyer@example.com' },
      { id: 'ord_confirm_1', now: '2026-07-31T12:00:00.000Z' },
    ),
    ...overrides,
  };
}

test('already-paid confirmation returns immediately without retrieving Stripe or rewriting payment', async () => {
  let retrieveCalls = 0;
  let updateCalls = 0;
  const result = await confirmCheckoutPayment(
    { orderId: 'ord_confirm_1', stripeSessionId: 'cs_test_paid' },
    {
      getOrder: async () => makeOrder({ paymentStatus: 'paid', stripeSessionId: 'cs_test_paid' }),
      retrieveSession: async () => { retrieveCalls += 1; throw new Error('must not retrieve'); },
      updatePayment: async () => { updateCalls += 1; throw new Error('must not update'); },
    },
  );

  assert.equal(result.status, 'paid');
  assert.equal(result.verifiedViaStripe, false);
  assert.equal(retrieveCalls, 0);
  assert.equal(updateCalls, 0);
});

test('pending confirmation without a session id stays local-only', async () => {
  let retrieveCalls = 0;
  const result = await confirmCheckoutPayment(
    { orderId: 'ord_confirm_1', stripeSessionId: null },
    {
      getOrder: async () => makeOrder(),
      retrieveSession: async () => { retrieveCalls += 1; throw new Error('must not retrieve'); },
      updatePayment: async () => null,
    },
  );

  assert.equal(result.status, 'pending');
  assert.equal(result.verifiedViaStripe, false);
  assert.equal(retrieveCalls, 0);
});

test('paid exact-bound Stripe session confirms read-only without mutating payment state', async () => {
  const updates: Array<{ orderId: string; sessionId?: string; line1?: string }> = [];
  const result = await confirmCheckoutPayment(
    { orderId: 'ord_confirm_1', stripeSessionId: 'cs_test_exact' },
    {
      getOrder: async () => makeOrder(),
      retrieveSession: async () => ({
        id: 'cs_test_exact',
        mode: 'payment',
        payment_status: 'paid',
        amount_subtotal: 3_900,
        amount_total: 3_900,
        currency: 'usd',
        client_reference_id: 'ord_confirm_1',
        metadata: { orderId: 'ord_confirm_1' },
        collected_information: {
          shipping_details: {
            address: {
              line1: '1 Main St',
              line2: null,
              city: 'Chicago',
              state: 'IL',
              postal_code: '60601',
              country: 'US',
            },
          },
        },
      }),
      updatePayment: async (orderId, status, opts) => {
        updates.push({ orderId, sessionId: opts.stripeSessionId, line1: opts.shippingAddress?.line1 });
        return makeOrder({ paymentStatus: status, stripeSessionId: opts.stripeSessionId, shippingAddress: opts.shippingAddress });
      },
    },
  );

  assert.equal(result.status, 'paid');
  assert.equal(result.verifiedViaStripe, true);
  assert.deepEqual(updates, []);
});

test('paid discounted session validates list-price subtotal without writing payment state', async () => {
  let updates = 0;
  const result = await confirmCheckoutPayment(
    { orderId: 'ord_confirm_1', stripeSessionId: 'cs_test_discounted' },
    {
      getOrder: async () => makeOrder(),
      retrieveSession: async () => ({
        id: 'cs_test_discounted',
        mode: 'payment',
        payment_status: 'paid',
        amount_subtotal: 3_900,
        amount_total: 1_950,
        currency: 'usd',
        client_reference_id: 'ord_confirm_1',
        metadata: { orderId: 'ord_confirm_1' },
      } as never),
      updatePayment: async (_orderId, status, opts) => {
        updates += 1;
        return makeOrder({ paymentStatus: status, stripeSessionId: opts.stripeSessionId });
      },
    },
  );

  assert.equal(result.status, 'paid');
  assert.equal(result.verifiedViaStripe, true);
  assert.equal(updates, 0);
});

test('exact settlement predicate accepts MARK100 no-payment-required checkout only at zero total', () => {
  const order = makeOrder();
  const base = {
    id: 'cs_mark100',
    mode: 'payment',
    payment_status: 'no_payment_required',
    amount_subtotal: 3_900,
    amount_total: 0,
    currency: 'usd',
    client_reference_id: order.id,
    metadata: { orderId: order.id },
  };
  assert.equal(isExactSettledCheckoutSession(base, order, base.id), true);
  assert.equal(isExactSettledCheckoutSession({ ...base, amount_total: 1 }, order, base.id), false);
});

test('fallback refuses unpaid, mismatched-order, wrong-amount, and wrong-currency sessions', async () => {
  const baseSession = {
    id: 'cs_test_candidate',
    mode: 'payment' as const,
    payment_status: 'paid' as const,
    amount_subtotal: 3_900,
    amount_total: 3_900,
    currency: 'usd',
    client_reference_id: 'ord_confirm_1',
    metadata: { orderId: 'ord_confirm_1' },
  };
  const cases = [
    { name: 'unpaid', patch: { payment_status: 'unpaid' } },
    { name: 'mismatched order', patch: { client_reference_id: 'ord_other', metadata: { orderId: 'ord_other' } } },
    { name: 'wrong subtotal', patch: { amount_subtotal: 6_400, amount_total: 6_400 } },
    { name: 'wrong currency', patch: { currency: 'cad' } },
  ];

  for (const candidate of cases) {
    let updates = 0;
    const result = await confirmCheckoutPayment(
      { orderId: 'ord_confirm_1', stripeSessionId: 'cs_test_candidate' },
      {
        getOrder: async () => makeOrder(),
        retrieveSession: async () => ({ ...baseSession, ...candidate.patch }),
        updatePayment: async () => { updates += 1; return makeOrder({ paymentStatus: 'paid' }); },
      },
    );
    assert.equal(result.status, 'pending', candidate.name);
    assert.equal(result.verifiedViaStripe, false, candidate.name);
    assert.equal(updates, 0, candidate.name);
  }
});

test('fallback never resurrects failed, partially refunded, or fully refunded local payment state', async () => {
  for (const paymentStatus of ['failed', 'partially_refunded', 'refunded'] as const) {
    let retrieveCalls = 0;
    const result = await confirmCheckoutPayment(
      { orderId: 'ord_confirm_1', stripeSessionId: 'cs_test_paid' },
      {
        getOrder: async () => makeOrder({ paymentStatus }),
        retrieveSession: async () => { retrieveCalls += 1; throw new Error('must not retrieve'); },
        updatePayment: async () => null,
      },
    );
    assert.equal(result.status, 'failed');
    assert.equal(retrieveCalls, 0);
  }
});
