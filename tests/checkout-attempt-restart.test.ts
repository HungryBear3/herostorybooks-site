import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  checkoutOrderIdForAttempt,
  resolveCheckoutAttemptRestart,
} from '../src/lib/checkout-attempt-restart.ts';

const ATTEMPT = 'a'.repeat(32);
const ORDER_ID = checkoutOrderIdForAttempt(ATTEMPT);

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    checkoutAttemptId: ATTEMPT,
    paymentStatus: 'pending',
    stripeSessionId: 'cs_live_old',
    ...overrides,
  } as never;
}

test('derives the same deterministic order-id shape as checkout creation', () => {
  assert.match(ORDER_ID, /^ord_[a-f0-9]{16}$/);
  assert.equal(ORDER_ID, checkoutOrderIdForAttempt(ATTEMPT));
});

test('allows a new attempt only after Stripe proves the old session expired unpaid without a PaymentIntent', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order(),
    retrieveSession: async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: null }),
    retireExpiredAttempt: async () => true,
  });
  assert.deepEqual(result, { status: 'restart_allowed', reason: 'expired_unpaid' });
});

test('already-retired expired attempts remain restartable after a partial browser cleanup', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order({
      paymentStatus: 'failed',
      fulfillmentLastError: 'stripe_session_expired_unpaid',
    }),
    retrieveSession: async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: null }),
    retireExpiredAttempt: async () => { throw new Error('already retired must not mutate again'); },
  });
  assert.deepEqual(result, { status: 'restart_allowed', reason: 'expired_unpaid' });
});

test('allows a new attempt after a completed paid session because the old session cannot be paid again', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order({ paymentStatus: 'paid' }),
    retrieveSession: async () => ({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_123' }),
    retireExpiredAttempt: async () => { throw new Error('must not retire a paid order'); },
  });
  assert.deepEqual(result, { status: 'restart_allowed', reason: 'completed_paid' });
});

test('requires exact resume for an open session', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order(),
    retrieveSession: async () => ({ status: 'open', payment_status: 'unpaid', payment_intent: null }),
    retireExpiredAttempt: async () => { throw new Error('must not retire an open session'); },
  });
  assert.deepEqual(result, { status: 'resume_required', reason: 'session_open' });
});

test('fails closed for invalid identity, mismatched order ownership, ambiguous provider states, and provider failure', async () => {
  const retrieve = async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: null });
  const retire = async () => true;
  assert.deepEqual(
    await resolveCheckoutAttemptRestart('bad', {
      getOrder: async () => null, retrieveSession: retrieve, retireExpiredAttempt: retire,
    }),
    { status: 'unknown', reason: 'invalid_attempt' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order({ checkoutAttemptId: 'b'.repeat(32) }),
      retrieveSession: retrieve,
      retireExpiredAttempt: retire,
    }),
    { status: 'unknown', reason: 'identity_mismatch' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order(),
      retrieveSession: async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: 'pi_unknown' }),
      retireExpiredAttempt: retire,
    }),
    { status: 'unknown', reason: 'provider_ambiguous' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order(),
      retrieveSession: async () => { throw new Error('provider down'); },
      retireExpiredAttempt: retire,
    }),
    { status: 'unknown', reason: 'provider_unavailable' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order(),
      retrieveSession: retrieve,
      retireExpiredAttempt: async () => false,
    }),
    { status: 'unknown', reason: 'provider_ambiguous' },
  );
});

test('production wiring checks an old sent marker before uploads, clears only on verified restart, and retries with a new id', () => {
  const root = process.cwd();
  const form = fs.readFileSync(path.join(root, 'src/app/checkout/checkout-form.tsx'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'src/app/api/order/attempt-restart/route.ts'), 'utf8');

  const preflightAt = form.indexOf('resolveStoredCheckoutAttemptForNewPurchase');
  const uploadAt = form.indexOf('prepareOrReuseDirectIntakeSubmission');
  assert.ok(preflightAt >= 0, 'checkout must run the restart preflight');
  assert.ok(uploadAt >= 0 && preflightAt < uploadAt, 'restart preflight must happen before any private upload');
  assert.match(form, /restartStatus === ['"]restart_allowed['"][\s\S]{0,700}clearCheckoutAttemptStorage\(checkoutAttemptStorage\(\), checkoutAttemptId\)/);
  assert.match(form, /clearCheckoutAttemptStorage\(checkoutAttemptStorage\(\), checkoutAttemptId\)[\s\S]{0,700}newCheckoutAttemptId\(\)/);
  assert.match(route, /resolveCheckoutAttemptRestart/);
  assert.match(route, /getOrderAuthoritative/);
  assert.match(route, /retireExpiredCheckoutAttempt/);
  assert.match(route, /getRequiredStripeSecretKey/);
  assert.match(route, /Cache-Control['"]:\s*['"]no-store/);
});
