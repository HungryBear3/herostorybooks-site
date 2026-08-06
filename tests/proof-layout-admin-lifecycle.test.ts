import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import { evaluateProofLayoutMutationLifecycle } from '../src/lib/page-review.ts';

function orderWith(patch: Partial<OrderRecord>): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Lifecycle', email: 'lifecycle@example.invalid', bookFormat: 'digital' },
      { id: 'ord_lifecycle_admin_layout', now: '2026-08-05T00:00:00.000Z' },
    ),
    paymentStatus: 'paid',
    ...patch,
  };
}

const cases: Array<{ name: string; patch: Partial<OrderRecord>; error: string }> = [
  { name: 'proof approved timestamp', patch: { proofApprovedAt: '2026-08-05T00:00:00.000Z' }, error: 'order_approved' },
  { name: 'print approved timestamp', patch: { printApprovedAt: '2026-08-05T00:00:00.000Z' }, error: 'order_approved' },
  { name: 'print submitted timestamp', patch: { printSubmittedAt: '2026-08-05T00:00:00.000Z' }, error: 'print_submitted' },
  { name: 'print submission attempted timestamp', patch: { printSubmissionAttemptedAt: '2026-08-05T00:00:00.000Z' }, error: 'print_submitted' },
  { name: 'shipped timestamp', patch: { shippedAt: '2026-08-05T00:00:00.000Z' }, error: 'order_shipped' },
  { name: 'internal disposition', patch: { internalDisposition: 'abandoned_internal_test' }, error: 'order_finalized' },
];

for (const scenario of cases) {
  test(`layout mutation lifecycle closes on ${scenario.name} without mutating the order`, () => {
    const order = orderWith(scenario.patch);
    const before = JSON.stringify(order);
    assert.deepEqual(evaluateProofLayoutMutationLifecycle(order), { status: 409, error: scenario.error });
    assert.equal(JSON.stringify(order), before);
  });
}
