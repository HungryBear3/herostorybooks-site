import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPaidOrderExceptionsReport } from '../scripts/paid-order-exceptions.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';

function order(overrides: Partial<OrderRecord>): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: overrides.bookFormat ?? 'digital', email: 'luna@example.com' },
    { id: overrides.id ?? 'ord_exception', now: overrides.createdAt ?? '2026-07-02T12:00:00.000Z' },
  );
  return { ...base, ...overrides };
}

test('paid-order exceptions report surfaces paid recovery blockers and omits clean/unpaid orders', () => {
  const report = buildPaidOrderExceptionsReport([
    order({ id: 'ord_unpaid', paymentStatus: 'pending' }),
    order({ id: 'ord_stuck', paymentStatus: 'paid', fulfillmentStatus: 'not_started', updatedAt: '2026-07-02T12:00:00.000Z' }),
    order({ id: 'ord_email', paymentStatus: 'paid', fulfillmentStatus: 'delivery_email_failed', storyArtifactUrl: 'https://blob.example/book.pdf' }),
    order({ id: 'ord_clean', paymentStatus: 'paid', fulfillmentStatus: 'complete', status: 'preview_ready', storyArtifactUrl: 'https://blob.example/book.pdf', customerProofReleasedAt: '2026-07-02T12:10:00.000Z' }),
  ], { now: '2026-07-02T12:30:00.000Z' });

  assert.equal(report.totalOrders, 4);
  assert.equal(report.paidOrders, 3);
  assert.deepEqual(report.exceptions.map((e) => e.orderId).sort(), ['ord_email', 'ord_stuck']);
  assert.equal(report.exceptions.find((e) => e.orderId === 'ord_stuck')?.reason, 'paid_no_artifact');
  assert.equal(report.exceptions.find((e) => e.orderId === 'ord_email')?.reason, 'email_delivery_fail');
});

test('paid-order exceptions report markdown is metadata-safe', () => {
  const report = buildPaidOrderExceptionsReport([
    order({ id: 'ord_stuck', email: 'private@example.com', childName: 'Private Kid', paymentStatus: 'paid', fulfillmentStatus: 'not_started', updatedAt: '2026-07-02T12:00:00.000Z' }),
  ], { now: '2026-07-02T12:30:00.000Z' });

  const markdown = report.toMarkdown();
  assert.match(markdown, /ord_stuck/);
  assert.doesNotMatch(markdown, /private@example.com|Private Kid/);
});
