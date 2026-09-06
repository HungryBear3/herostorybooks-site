/**
 * Read-only operator evidence for the one checkout state that is ambiguous
 * about the buyer's money.
 *
 * `provisionCheckoutSession` calls this state a DEAD END: a provisioning marker
 * with no candidate and no binding means a provider create was entered for the
 * current generation and nothing durable knows how it ended, so the provider may
 * be holding a payable Session right now. See the `checkout_session_
 * reconciliation_required` refusal in src/lib/checkout-session-provisioning.ts.
 *
 * `order-incident.ts` cannot see it — that taxonomy returns null for any order
 * whose `paymentStatus !== 'paid'`, and an order in this state has never been
 * confirmed paid. These tests pin the classifier that makes it visible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkoutProviderIdempotencyKey,
  createOrderRecord,
  type CheckoutSessionProvisioning,
  type OrderRecord,
} from '../src/lib/orders.ts';
import { readCheckoutProvisioningEvidence } from '../src/lib/checkout-provisioning-evidence.ts';

const ORDER_ID = 'ord_evidence_0001';
const ATTEMPT_ID = 'cka_evidence_0001';
const FINGERPRINT = 'fp_evidence_0001';
const STARTED_AT = '2026-09-06T10:00:00.000Z';

function marker(overrides: Partial<CheckoutSessionProvisioning> = {}): CheckoutSessionProvisioning {
  return {
    checkoutAttemptId: ATTEMPT_ID,
    checkoutFingerprint: FINGERPRINT,
    checkoutSessionAttempt: 0,
    idempotencyKey: checkoutProviderIdempotencyKey(ORDER_ID, 0),
    startedAt: STARTED_AT,
    ...overrides,
  };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id: ORDER_ID, now: '2026-09-06T09:00:00.000Z' },
  );
  return {
    ...base,
    checkoutAttemptId: ATTEMPT_ID,
    checkoutFingerprint: FINGERPRINT,
    ...overrides,
  };
}

test('the ambiguous state — an in-flight marker with no candidate and no binding — is reconciliation_required', () => {
  const evidence = readCheckoutProvisioningEvidence(order({ checkoutSessionProvisioning: marker() }));
  assert.equal(evidence.status, 'reconciliation_required');
  assert.equal(evidence.status === 'reconciliation_required' ? evidence.startedAt : null, STARTED_AT);
});

test('a durable candidate alongside the marker is NOT the ambiguous state', () => {
  const evidence = readCheckoutProvisioningEvidence(order({
    checkoutSessionProvisioning: marker(),
    checkoutSessionCandidate: {
      stripeSessionId: 'cs_test_candidate0001',
      checkoutAttemptId: ATTEMPT_ID,
      checkoutFingerprint: FINGERPRINT,
      checkoutSessionAttempt: 0,
      recordedAt: STARTED_AT,
    },
  }));
  assert.equal(evidence.status, 'none');
});

test('a bound Stripe session is NOT the ambiguous state', () => {
  const evidence = readCheckoutProvisioningEvidence(order({
    stripeSessionId: 'cs_test_bound0001',
    checkoutSessionProvisioning: marker(),
  }));
  assert.equal(evidence.status, 'none');
});

test('an order with no provisioning marker at all is NOT the ambiguous state', () => {
  assert.equal(readCheckoutProvisioningEvidence(order()).status, 'none');
});

test('a marker the parser cannot account for is NOT reported as the ambiguous state', () => {
  // Stale generation: the marker names attempt 0 while the order has moved on.
  const evidence = readCheckoutProvisioningEvidence(order({
    checkoutSessionAttempt: 1,
    supersededCheckoutSessionIds: ['cs_test_retired00001'],
    checkoutSessionProvisioning: marker(),
  }));
  assert.equal(evidence.status, 'none');
});

test('the evidence carries no marker token, nonce, or provider identifier', () => {
  const evidence = readCheckoutProvisioningEvidence(order({ checkoutSessionProvisioning: marker() }));
  assert.deepEqual(Object.keys(evidence).sort(), ['startedAt', 'status']);
  const serialized = JSON.stringify(evidence);
  for (const secret of [
    checkoutProviderIdempotencyKey(ORDER_ID, 0),
    ATTEMPT_ID,
    FINGERPRINT,
  ]) {
    assert.equal(serialized.includes(secret), false, `evidence leaked ${secret}`);
  }
});
