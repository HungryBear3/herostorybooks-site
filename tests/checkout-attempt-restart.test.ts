import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  checkoutAttemptRestartDependencies,
  checkoutOrderIdForAttempt,
  resolveCheckoutAttemptRestart,
} from '../src/lib/checkout-attempt-restart.ts';

const ATTEMPT = 'a'.repeat(32);
const CANONICAL_OWNER_ATTEMPT = 'b'.repeat(32);
const ORDER_ID = checkoutOrderIdForAttempt(ATTEMPT);
const INDEXED_ORDER_ID = `ord_${'9'.repeat(16)}`;

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    checkoutAttemptId: ATTEMPT,
    checkoutIntentFingerprint: 'f'.repeat(64),
    paymentStatus: 'pending',
    stripeSessionId: 'cs_live_old',
    ...overrides,
  } as never;
}

test('derives the same deterministic order-id shape as checkout creation', () => {
  assert.match(ORDER_ID, /^ord_[a-f0-9]{16}$/);
  assert.equal(ORDER_ID, checkoutOrderIdForAttempt(ATTEMPT));
});

test('restart resolves the canonical order through the durable attempt index', async () => {
  let requestedOrderId = '';
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    resolveOrderId: async () => INDEXED_ORDER_ID,
    getOrder: async (orderId) => {
      requestedOrderId = orderId;
      return order({ id: INDEXED_ORDER_ID, checkoutAttemptId: CANONICAL_OWNER_ATTEMPT });
    },
    retrieveSession: async () => ({ status: 'open', payment_status: 'unpaid', payment_intent: null }),
    retireExpiredAttempt: async () => { throw new Error('must not retire an open session'); },
    releaseIntentClaim: async () => { throw new Error('must not release an open session'); },
  });
  assert.equal(requestedOrderId, INDEXED_ORDER_ID);
  assert.deepEqual(result, { status: 'resume_required', reason: 'session_open' });
});

test('allows a new attempt only after Stripe proves the old session expired unpaid without a PaymentIntent', async () => {
  let released = 0;
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order(),
    retrieveSession: async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: null }),
    retireExpiredAttempt: async () => true,
    releaseIntentClaim: async () => { released += 1; return true; },
  });
  assert.deepEqual(result, { status: 'restart_allowed', reason: 'expired_unpaid' });
  assert.equal(released, 1);
});

test('the concrete pre-claim legacy order with an expired lease retires and authorizes a fresh attempt', async () => {
  const legacy = order({
    id: 'ord_testfixture_legacy_expired',
    checkoutAttemptId: 'bcadde66dd4a436b994a229a7b817d7a',
    checkoutIntentFingerprint: undefined,
    checkoutIntentClaimGeneration: undefined,
    checkoutLeaseId: '11111111-1111-4111-8111-111111111111',
    checkoutLeaseExpiresAt: '2026-08-27T12:00:00.000Z',
    stripeSessionId: 'cs_legacy_expired',
  });
  let retired = 0;
  let claimReleases = 0;
  const deps = checkoutAttemptRestartDependencies({
    resolveOrderId: async () => null,
    getOrder: async () => legacy,
    retrieveSession: async () => ({
      status: 'expired',
      payment_status: 'unpaid',
      payment_intent: null,
    }),
    retireExpiredAttempt: async (observed) => {
      retired += 1;
      assert.equal(observed, legacy);
      return true;
    },
    releaseIntentClaim: async () => {
      claimReleases += 1;
      return true;
    },
  });

  assert.deepEqual(
    await resolveCheckoutAttemptRestart('bcadde66dd4a436b994a229a7b817d7a', deps),
    { status: 'restart_allowed', reason: 'expired_unpaid' },
  );
  assert.equal(retired, 1);
  assert.equal(claimReleases, 0, 'a pre-claim order has no semantic claim to release');
});

test('fails closed when an expired unpaid provider session omits payment_intent', async () => {
  let retired = 0;
  let released = 0;
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order(),
    retrieveSession: async () => ({ status: 'expired', payment_status: 'unpaid' }),
    retireExpiredAttempt: async () => { retired += 1; return true; },
    releaseIntentClaim: async () => { released += 1; return true; },
  });

  assert.deepEqual(result, { status: 'unknown', reason: 'provider_ambiguous' });
  assert.equal(retired, 0);
  assert.equal(released, 0);
});

test('already-retired expired attempts remain restartable after a partial browser cleanup', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order({
      paymentStatus: 'failed',
      fulfillmentLastError: 'stripe_session_expired_unpaid',
    }),
    retrieveSession: async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: null }),
    retireExpiredAttempt: async () => { throw new Error('already retired must not mutate again'); },
    releaseIntentClaim: async () => true,
  });
  assert.deepEqual(result, { status: 'restart_allowed', reason: 'expired_unpaid' });
});

test('allows a new attempt after a completed paid session because the old session cannot be paid again', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order({ paymentStatus: 'paid' }),
    retrieveSession: async () => ({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_123' }),
    retireExpiredAttempt: async () => { throw new Error('must not retire a paid order'); },
    releaseIntentClaim: async () => true,
  });
  assert.deepEqual(result, { status: 'restart_allowed', reason: 'completed_paid' });
});

test('requires exact resume for an open session', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order(),
    retrieveSession: async () => ({ status: 'open', payment_status: 'unpaid', payment_intent: null }),
    retireExpiredAttempt: async () => { throw new Error('must not retire an open session'); },
    releaseIntentClaim: async () => { throw new Error('must not release an open session'); },
  });
  assert.deepEqual(result, { status: 'resume_required', reason: 'session_open' });
});

test('fails closed when a terminal provider session cannot release its exact intent claim', async () => {
  const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order({ paymentStatus: 'paid' }),
    retrieveSession: async () => ({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_123' }),
    retireExpiredAttempt: async () => { throw new Error('must not retire a paid order'); },
    releaseIntentClaim: async () => false,
  });
  assert.deepEqual(result, { status: 'unknown', reason: 'provider_ambiguous' });
});

test('absence is never restart approval: a missing order or missing Session stays unknown', async () => {
  // The browser must not clear a sent marker because the server cannot see the
  // order yet. An earlier request may create that exact record microseconds
  // later, and a cleared marker is how a second payable Session gets started.
  for (const getOrder of [
    async () => null,
    async () => order({ stripeSessionId: null }),
    async () => order({ stripeSessionId: '' }),
  ]) {
    assert.deepEqual(
      await resolveCheckoutAttemptRestart(ATTEMPT, {
        getOrder,
        retrieveSession: async () => { throw new Error('must not reach the provider'); },
        retireExpiredAttempt: async () => { throw new Error('must not retire on absence'); },
        releaseIntentClaim: async () => { throw new Error('must not release on absence'); },
      }),
      { status: 'unknown', reason: 'provider_ambiguous' },
    );
  }
});

test('fails closed for invalid identity, mismatched order ownership, ambiguous provider states, and provider failure', async () => {
  const retrieve = async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: null });
  const retire = async () => true;
  assert.deepEqual(
    await resolveCheckoutAttemptRestart('bad', {
      getOrder: async () => null, retrieveSession: retrieve, retireExpiredAttempt: retire,
      releaseIntentClaim: async () => true,
    }),
    { status: 'unknown', reason: 'invalid_attempt' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order({ checkoutAttemptId: 'b'.repeat(32) }),
      retrieveSession: retrieve,
      retireExpiredAttempt: retire,
      releaseIntentClaim: async () => true,
    }),
    { status: 'unknown', reason: 'identity_mismatch' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order(),
      retrieveSession: async () => ({ status: 'expired', payment_status: 'unpaid', payment_intent: 'pi_unknown' }),
      retireExpiredAttempt: retire,
      releaseIntentClaim: async () => true,
    }),
    { status: 'unknown', reason: 'provider_ambiguous' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order(),
      retrieveSession: async () => { throw new Error('provider down'); },
      retireExpiredAttempt: retire,
      releaseIntentClaim: async () => true,
    }),
    { status: 'unknown', reason: 'provider_unavailable' },
  );
  assert.deepEqual(
    await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => order(),
      retrieveSession: retrieve,
      retireExpiredAttempt: async () => false,
      releaseIntentClaim: async () => true,
    }),
    { status: 'unknown', reason: 'provider_ambiguous' },
  );
});

test('all non-authoritative provider and record branches fail closed without retirement or claim release', async () => {
  const cases = [
    ['missing record / in-flight ambiguity', null, null],
    ['open session', order(), { status: 'open', payment_status: 'unpaid', payment_intent: null }],
    ['paid provider with pending local order', order(), { status: 'complete', payment_status: 'paid', payment_intent: 'pi_paid' }],
    ['complete but unpaid', order(), { status: 'complete', payment_status: 'unpaid', payment_intent: null }],
    ['expired with a PaymentIntent', order(), { status: 'expired', payment_status: 'unpaid', payment_intent: 'pi_unknown' }],
    ['unknown provider state', order(), { status: 'mystery', payment_status: 'unpaid', payment_intent: null }],
  ] as const;

  for (const [name, record, session] of cases) {
    let mutations = 0;
    const result = await resolveCheckoutAttemptRestart(ATTEMPT, {
      getOrder: async () => record as never,
      retrieveSession: async () => session as never,
      retireExpiredAttempt: async () => { mutations += 1; return true; },
      releaseIntentClaim: async () => { mutations += 1; return true; },
    });
    assert.notEqual(result.status, 'restart_allowed', name);
    assert.equal(mutations, 0, `${name} must not mutate retirement or claim state`);
  }

  let unavailableMutations = 0;
  assert.deepEqual(await resolveCheckoutAttemptRestart(ATTEMPT, {
    getOrder: async () => order(),
    retrieveSession: async () => { throw new Error('provider unavailable'); },
    retireExpiredAttempt: async () => { unavailableMutations += 1; return true; },
    releaseIntentClaim: async () => { unavailableMutations += 1; return true; },
  }), { status: 'unknown', reason: 'provider_unavailable' });
  assert.equal(unavailableMutations, 0);
});

test('production wiring checks an old sent marker before uploads, clears only on verified restart, and retries with a new id', () => {
  const root = process.cwd();
  const form = fs.readFileSync(path.join(root, 'src/app/checkout/checkout-form.tsx'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'src/app/api/order/attempt-restart/route.ts'), 'utf8');

  const preflightAt = form.indexOf('resolveStoredCheckoutAttemptForNewPurchase');
  const uploadAt = form.indexOf('prepareOrReuseDirectIntakeSubmission');
  assert.ok(preflightAt >= 0, 'checkout must run the restart preflight');
  assert.ok(uploadAt >= 0 && preflightAt < uploadAt, 'restart preflight must happen before any private upload');
  const decisionAt = form.indexOf('const continueDecision = decideCheckoutAttemptContinue({');
  const paidRecoveryAt = form.indexOf('continueDecision.action === "paid_confirmation_required"', decisionAt);
  const rotateAt = form.indexOf('continueDecision.action === "rotate_attempt"', decisionAt);
  const cleanupAt = form.indexOf(
    'clearCheckoutAttemptStorage(checkoutAttemptStorage(), checkoutAttemptId)',
    rotateAt,
  );
  const replacementAt = form.indexOf('checkoutAttemptId = newCheckoutAttemptId()', cleanupAt);
  assert.ok(decisionAt >= 0, 'the shared Continue decision must authorize every restart action');
  assert.ok(paidRecoveryAt > decisionAt && paidRecoveryAt < rotateAt, 'paid attempts must route to recovery before rotation is considered');
  assert.ok(cleanupAt > rotateAt, 'browser cleanup must run only inside the authorized rotation branch');
  assert.ok(replacementAt > cleanupAt, 'a replacement identity must be minted only after verified cleanup');
  // The restart REASON has to survive the hop to the browser: rotation is only
  // ever automatic for an authoritatively expired+unpaid attempt.
  assert.match(route, /\{ status: result\.status, reason: result\.reason \}/);
  assert.match(route, /resolveCheckoutAttemptRestart/);
  assert.match(route, /getOrderAuthoritative/);
  assert.match(route, /retireExpiredCheckoutAttempt/);
  assert.match(route, /releaseCheckoutIntentOrderId/);
  assert.match(route, /resolveCheckoutOrderIdForAttempt/);
  assert.match(route, /resolveOrderId/);
  assert.match(route, /releaseIntentClaim/);
  assert.match(route, /checkoutIntentFingerprint/);
  assert.match(route, /getRequiredStripeSecretKey/);
  assert.match(route, /Cache-Control['"]:\s*['"]no-store/);
});
