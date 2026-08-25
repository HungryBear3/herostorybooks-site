import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import { deriveOrderAttention, deriveOrderStage } from '../src/lib/order-stage.ts';

function order(overrides: Partial<OrderRecord>): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: overrides.bookFormat ?? 'digital', email: 'luna@example.com' },
    { id: overrides.id ?? 'ord_stage', now: overrides.createdAt ?? '2026-07-02T12:00:00.000Z' },
  );
  return { ...base, ...overrides };
}

test('deriveOrderStage: paid without artifacts stays paid and attention flags after threshold', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'not_started',
    updatedAt: '2026-07-02T12:00:00.000Z',
  });

  assert.equal(deriveOrderStage(o), 'paid');
  assert.deepEqual(deriveOrderAttention(o, { now: '2026-07-02T12:20:00.000Z' }), {
    severity: 'blocked',
    reason: 'paid_no_artifact',
    queue: 'fulfillment_recovery',
    nextActionOwner: 'ops',
  });
});

test('deriveOrderStage: pageArtifacts alone are not a released customer artifact', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'not_started',
    updatedAt: '2026-07-02T12:00:00.000Z',
    pageArtifacts: [
      {
        pageIndex: 0,
        imageUrl: 'https://blob.example/internal-page.png',
        prompt: 'internal generation work in progress',
      },
    ],
  });

  assert.equal(deriveOrderStage(o), 'paid');
  assert.deepEqual(deriveOrderAttention(o, { now: '2026-07-02T12:20:00.000Z' }), {
    severity: 'blocked',
    reason: 'paid_no_artifact',
    queue: 'fulfillment_recovery',
    nextActionOwner: 'ops',
  });
});

test('deriveOrderStage: proof PDF without proof email ledger is not proof_sent', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    status: 'preview_ready',
    storyArtifactUrl: 'https://blob.example/proof.pdf',
    proofApprovalToken: 'tok_test',
    qaPassAt: '2026-07-02T12:05:00.000Z',
    customerProofReleasedAt: null,
  });

  assert.equal(deriveOrderStage(o), 'qa_passed');
  assert.equal(deriveOrderAttention(o).severity, 'warn');
  assert.equal(deriveOrderAttention(o).reason, 'proof_ready_not_sent');
});

test('deriveOrderStage: released proof email clears proof-ready warning', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    status: 'preview_ready',
    storyArtifactUrl: 'https://blob.example/proof.pdf',
    proofApprovalToken: 'tok_test',
    qaPassAt: '2026-07-02T12:05:00.000Z',
    customerProofReleasedAt: '2026-07-02T12:10:00.000Z',
  });

  assert.equal(deriveOrderStage(o), 'proof_sent');
  assert.deepEqual(deriveOrderAttention(o), {
    severity: 'none',
    reason: 'none',
    queue: 'none',
    nextActionOwner: 'none',
  });
});

test('deriveOrderStage: delivery email failure is attention queue and does not advance stage', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'delivery_email_failed',
    status: 'preview_ready',
    storyArtifactUrl: 'https://blob.example/book.pdf',
  });

  assert.equal(deriveOrderStage(o), 'awaiting_qa');
  assert.deepEqual(deriveOrderAttention(o), {
    severity: 'blocked',
    reason: 'email_delivery_fail',
    queue: 'email_recovery',
    nextActionOwner: 'ops',
  });
});

test('deriveOrderStage: refund terminal beats replayed paid/session state', () => {
  const o = order({
    paymentStatus: 'paid',
    stripeSessionId: 'cs_live_replayed',
    refundedAt: '2026-07-02T12:10:00.000Z',
    stripeRefundId: 're_test',
  });

  assert.equal(deriveOrderStage(o), 'refunded');
  assert.equal(deriveOrderAttention(o).severity, 'none');
});

test('deriveOrderAttention: print order paid without shipping is blocked', () => {
  const o = order({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    shippingAddress: null,
  });

  assert.equal(deriveOrderStage(o), 'paid');
  assert.deepEqual(deriveOrderAttention(o), {
    severity: 'blocked',
    reason: 'missing_shipping',
    queue: 'ops_recovery',
    nextActionOwner: 'ops',
  });
});

test('deriveOrderStage: delivered provider status wins over earlier shipped timestamp', () => {
  const o = order({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    shippingAddress: { line1: '1 Test St', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    shippedAt: '2026-07-02T12:10:00.000Z',
    printJobStatus: 'delivered',
  });

  assert.equal(deriveOrderStage(o), 'delivered');
});

test('deriveOrderAttention: terminal print order without legacy shipping is not blocked', () => {
  const o = order({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    shippingAddress: null,
    shippedAt: '2026-07-02T12:10:00.000Z',
    printJobStatus: 'delivered',
  });

  assert.equal(deriveOrderStage(o), 'delivered');
  assert.deepEqual(deriveOrderAttention(o), {
    severity: 'none',
    reason: 'none',
    queue: 'none',
    nextActionOwner: 'none',
  });
});

test('deriveOrderStage: active print provider status wins over submitted marker', () => {
  const o = order({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    shippingAddress: { line1: '1 Test St', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    printJobId: 'print_job_123',
    printSubmittedAt: '2026-07-02T12:10:00.000Z',
    printJobStatus: 'in_production',
  });

  assert.equal(deriveOrderStage(o), 'in_print_production');
});

// ── Ambiguous print submission must reach the admin attention queue ───────────
// An ambiguous provider response is the highest-severity operator incident:
// a physical book may already exist. It must never be hidden by a released
// story/proof artifact, by a missing shipping address, or by a refund.

test('deriveOrderAttention: ambiguous print submission is blocked print_ops even with a proof artifact', () => {
  const o = order({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    printInteriorArtifactUrl: 'https://example.com/interior.pdf',
    printSubmissionAttemptedAt: '2026-07-02T11:00:00.000Z',
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
    proofApprovedAt: '2026-07-02T10:00:00.000Z',
    shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    updatedAt: '2026-07-02T11:00:00.000Z',
  });
  assert.deepEqual(deriveOrderAttention(o, { now: '2026-07-02T12:00:00.000Z' }), {
    severity: 'blocked',
    reason: 'print_submission_ambiguous',
    queue: 'print_ops',
    nextActionOwner: 'print_ops',
  });
});

test('deriveOrderAttention: ambiguous print outranks the missing-shipping blocker', () => {
  const o = order({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    printSubmissionAttemptedAt: '2026-07-02T11:00:00.000Z',
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
    shippingAddress: null,
    updatedAt: '2026-07-02T11:00:00.000Z',
  });
  assert.equal(deriveOrderAttention(o, { now: '2026-07-02T12:00:00.000Z' }).reason, 'print_submission_ambiguous');
});

test('deriveOrderAttention: a refund does not hide an unreconciled print submission', () => {
  const o = order({
    paymentStatus: 'refunded',
    refundedAt: '2026-07-02T11:30:00.000Z',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    printSubmissionAttemptedAt: '2026-07-02T11:00:00.000Z',
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
    updatedAt: '2026-07-02T11:30:00.000Z',
  });
  assert.equal(deriveOrderAttention(o, { now: '2026-07-02T12:00:00.000Z' }).reason, 'print_submission_ambiguous');
});

test('deriveOrderAttention: a reconciled print job id restores ordinary terminal quiet', () => {
  const o = order({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    fulfillmentStatus: 'submitting_to_print',
    printJobId: 'PJ-123',
    printSubmissionAttemptedAt: '2026-07-02T11:00:00.000Z',
    fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
    shippingAddress: { line1: '1 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    updatedAt: '2026-07-02T11:00:00.000Z',
  });
  assert.equal(deriveOrderAttention(o, { now: '2026-07-02T12:00:00.000Z' }).reason, 'none');
});
