import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import { buildPaidOrderExceptionsReport } from '../scripts/paid-order-exceptions.ts';

function order(overrides: Partial<OrderRecord>): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: overrides.bookFormat ?? 'digital', email: 'luna@example.com' },
    { id: overrides.id ?? 'ord_exc', now: overrides.createdAt ?? '2026-07-02T12:00:00.000Z' },
  );
  return { ...base, ...overrides };
}

const NOW = '2026-07-02T13:00:00.000Z';

test('buildPaidOrderExceptionsReport: surfaces a paid order stuck with no artifact', () => {
  const stuck = order({ id: 'ord_stuck', paymentStatus: 'paid', fulfillmentStatus: 'not_started', updatedAt: '2026-07-02T12:00:00.000Z' });
  const report = buildPaidOrderExceptionsReport([stuck], { now: NOW });

  assert.equal(report.paidOrders, 1);
  assert.equal(report.exceptions.length, 1);
  assert.equal(report.exceptions[0].orderId, 'ord_stuck');
  assert.equal(report.exceptions[0].reason, 'paid_no_artifact');
  assert.equal(report.exceptions[0].severity, 'blocked');
  assert.equal(report.exceptions[0].queue, 'fulfillment_recovery');
});

test('buildPaidOrderExceptionsReport: a cleanly delivered paid order is not an exception', () => {
  const clean = order({
    id: 'ord_clean',
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    status: 'preview_ready',
    storyArtifactUrl: 'https://blob.example/proof.pdf',
    customerProofReleasedAt: '2026-07-02T12:10:00.000Z',
  });
  const report = buildPaidOrderExceptionsReport([clean], { now: NOW });

  assert.equal(report.paidOrders, 1);
  assert.equal(report.exceptions.length, 0);
});

test('buildPaidOrderExceptionsReport: unpaid drafts are ignored', () => {
  const draft = order({ id: 'ord_draft', paymentStatus: 'pending' });
  const report = buildPaidOrderExceptionsReport([draft], { now: NOW });

  assert.equal(report.totalOrders, 1);
  assert.equal(report.paidOrders, 0);
  assert.equal(report.exceptions.length, 0);
});

test('buildPaidOrderExceptionsReport: markdown renders header and per-exception detail', () => {
  const stuck = order({ id: 'ord_md', paymentStatus: 'paid', fulfillmentStatus: 'not_started', updatedAt: '2026-07-02T12:00:00.000Z' });
  const md = buildPaidOrderExceptionsReport([stuck], { now: NOW }).toMarkdown();

  assert.match(md, /# HSB paid-order exceptions/);
  assert.match(md, /BLOCKED ord_md: paid_no_artifact/);
  assert.match(md, /queue: fulfillment_recovery/);
});
