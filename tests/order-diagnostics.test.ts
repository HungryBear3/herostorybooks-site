/**
 * order-diagnostics — pure summary over OrderRecord. Used by the support
 * inspection endpoint, the admin detail page, and the CLI status script.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createOrderRecord, type OrderRecord, type PageArtifact } from '../src/lib/orders.ts';
import {
  buildOrderDiagnostics,
  classifyPaidOrderOpsIssue,
  formatDiagnosticsSummary,
  isPaidArtifactOpsIssue,
} from '../src/lib/order-diagnostics.ts';

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id: 'ord_diag_1', now: '2026-04-27T10:00:00Z' },
  );
  return { ...base, ...overrides };
}

test('diagnostics: payment pending → warn', () => {
  const d = buildOrderDiagnostics(makeOrder({ paymentStatus: 'pending' }));
  const c = d.checks.find((c) => c.id === 'payment');
  assert.equal(c?.severity, 'warn');
  assert.equal(d.flags.isPaid, false);
});

test('diagnostics: paid + proof ready + ack missing → warn on proof-ack', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: null,
    pageArtifacts: [pageFixture(0, { accepted: true }), pageFixture(1, { accepted: true })],
  }));
  assert.equal(d.flags.proofReady, true);
  assert.equal(d.flags.proofAcknowledged, false);
  assert.equal(d.flags.needsCustomerAction, true);
  const ack = d.checks.find((c) => c.id === 'proof-ack');
  assert.equal(ack?.severity, 'warn');
});

test('diagnostics: paid + proof ready + acknowledged → ok', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: '2026-04-27T11:00:00Z',
    pageArtifacts: [pageFixture(0, { accepted: true }), pageFixture(1, { accepted: true })],
  }));
  const ack = d.checks.find((c) => c.id === 'proof-ack');
  assert.equal(ack?.severity, 'ok');
  assert.equal(d.flags.proofAcknowledged, true);
});

test('diagnostics: failed_manual_review surfaces fail check with last error', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'failed_manual_review',
    fulfillmentLastError: 'OpenAI rate limit',
  }));
  const fail = d.checks.find((c) => c.id === 'failure');
  assert.equal(fail?.severity, 'fail');
  assert.match(fail?.detail ?? '', /rate limit/i);
  assert.equal(d.flags.isFailed, true);
});

test('diagnostics: paid + not_started + no artifact is an ops attention item', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'not_started',
    storyArtifactUrl: null,
  }));
  assert.equal(d.flags.paidWithoutArtifact, true);
  assert.equal(d.flags.paidArtifactNeedsAttention, true);
  assert.equal(d.paidOrderOpsIssue?.kind, 'paid_no_artifact_not_started');
  const c = d.checks.find((c) => c.id === 'paid-artifact');
  assert.equal(c?.severity, 'fail');
});

test('classifyPaidOrderOpsIssue: fresh in-progress paid order waits before alerting', () => {
  const order = makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'generating_images',
    storyArtifactUrl: null,
    updatedAt: '2026-04-27T10:10:00Z',
  });
  const issue = classifyPaidOrderOpsIssue(order, new Date('2026-04-27T10:20:00Z'));
  assert.equal(issue?.kind, 'paid_no_artifact_waiting');
  assert.equal(issue?.severity, 'info');
});

test('classifyPaidOrderOpsIssue: stale in-progress paid order alerts', () => {
  const order = makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'building_pdf',
    storyArtifactUrl: null,
    updatedAt: '2026-04-27T10:00:00Z',
  });
  const issue = classifyPaidOrderOpsIssue(order, new Date('2026-04-27T10:16:00Z'));
  assert.equal(issue?.kind, 'paid_no_artifact_stale_in_progress');
  assert.equal(issue?.severity, 'fail');
});

test('diagnostics: paid + missing photo blob path → warn when filename present', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    photoFileName: 'kid.jpg',
    photoBlobPath: null,
  }));
  const photo = d.checks.find((c) => c.id === 'photo');
  assert.equal(photo?.severity, 'warn');
});

test('diagnostics: paid + no stripeSessionId → warn (recovery candidate)', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    stripeSessionId: null,
  }));
  const c = d.checks.find((c) => c.id === 'stripe-session');
  assert.equal(c?.severity, 'warn');
});

test('diagnostics: print order approved with no print job id → warn', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    fulfillmentStatus: 'proof_approved',
    reviewStatus: 'approved',
    proofReviewedAt: '2026-04-27T11:00:00Z',
    proofApprovedAt: '2026-04-27T12:00:00Z',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    printJobId: null,
  }));
  const c = d.checks.find((c) => c.id === 'print-job');
  assert.equal(c?.severity, 'warn');
  assert.equal(d.flags.approved, true);
});

test('diagnostics: shipped order is happy-path ok', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    fulfillmentStatus: 'complete',
    reviewStatus: 'approved',
    status: 'shipped',
    proofReviewedAt: '2026-04-27T11:00:00Z',
    proofApprovedAt: '2026-04-27T12:00:00Z',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    printJobId: 'PJ123',
    printJobStatus: 'SHIPPED',
    trackingNumber: '1Z999',
    shippedAt: '2026-04-30T10:00:00Z',
    shippingAddress: { line1: '123 Main', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
  }));
  assert.equal(d.flags.shipped, true);
  const failing = d.checks.filter((c) => c.severity === 'fail');
  assert.equal(failing.length, 0);
  const shipped = d.checks.find((c) => c.id === 'shipped');
  assert.equal(shipped?.severity, 'ok');
});

test('formatDiagnosticsSummary: produces multi-line escalation block including ids and statuses', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    pageArtifacts: [pageFixture(0, { accepted: true })],
  }));
  const text = formatDiagnosticsSummary(d);
  assert.match(text, /Order ord_diag_1/);
  assert.match(text, /Payment: paid/);
  assert.match(text, /Fulfillment: proof_ready/);
});

// ── Ambiguous print submission must reach paid-order diagnostics ──────────────
// `classifyPaidOrderOpsIssue` historically returned null the moment a story
// artifact existed. An unreconciled print submission is exactly the case where
// the artifact exists AND the order is in trouble, so it must survive that gate.

const ambiguousPrintOrder = (overrides: Partial<OrderRecord> = {}) => makeOrder({
  paymentStatus: 'paid',
  bookFormat: 'classic',
  fulfillmentStatus: 'submitting_to_print',
  storyArtifactUrl: 'https://example.com/proof.pdf',
  printInteriorArtifactUrl: 'https://example.com/interior.pdf',
  printSubmissionAttemptedAt: '2026-04-27T11:00:00Z',
  fulfillmentLastError: 'print_submission_ambiguous: upstream timeout',
  proofApprovedAt: '2026-04-27T10:30:00Z',
  reviewStatus: 'approved',
  proofReviewedAt: '2026-04-27T10:20:00Z',
  updatedAt: '2026-04-27T11:00:00Z',
  ...overrides,
});

test('classifyPaidOrderOpsIssue: ambiguous print survives the existing-artifact early return', () => {
  const issue = classifyPaidOrderOpsIssue(ambiguousPrintOrder(), new Date('2026-04-27T11:30:00Z'));
  assert.equal(issue?.kind, 'paid_print_submission_ambiguous');
  assert.equal(issue?.severity, 'fail');
});

test('paid_artifact filter semantics exclude ambiguous print orders that already have artifacts', () => {
  const ambiguous = classifyPaidOrderOpsIssue(
    ambiguousPrintOrder(),
    new Date('2026-04-27T11:30:00Z'),
  );
  const missing = classifyPaidOrderOpsIssue(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'not_started',
    storyArtifactUrl: null,
  }));
  assert.equal(isPaidArtifactOpsIssue(ambiguous), false);
  assert.equal(isPaidArtifactOpsIssue(missing), true);

  const route = readFileSync(
    fileURLToPath(new URL('../src/app/api/admin/orders/route.ts', import.meta.url)),
    'utf8',
  );
  assert.match(route, /isPaidArtifactOpsIssue\(issue\)/);
});

test('classifyPaidOrderOpsIssue: the durable pre-POST fence alone is enough', () => {
  const issue = classifyPaidOrderOpsIssue(
    ambiguousPrintOrder({ fulfillmentLastError: null }),
    new Date('2026-04-27T11:30:00Z'),
  );
  assert.equal(issue?.kind, 'paid_print_submission_ambiguous');
});

test('classifyPaidOrderOpsIssue: a reconciled print job id clears the ambiguity', () => {
  const issue = classifyPaidOrderOpsIssue(
    ambiguousPrintOrder({ printJobId: 'PJ-123' }),
    new Date('2026-04-27T11:30:00Z'),
  );
  assert.equal(issue, null);
});

test('diagnostics: ambiguous print raises its own check and does not claim a missing artifact', () => {
  const d = buildOrderDiagnostics(ambiguousPrintOrder());
  assert.equal(d.paidOrderOpsIssue?.kind, 'paid_print_submission_ambiguous');
  // The artifact exists — the flags must stay honest about that.
  assert.equal(d.flags.paidWithoutArtifact, false);
  const check = d.checks.find((c) => c.id === 'print-submission-ambiguous');
  assert.equal(check?.severity, 'fail');
  assert.equal(d.checks.some((c) => c.id === 'paid-artifact'), false);
});

test('diagnostics: an ambiguous-print issue never echoes the raw provider error', () => {
  const d = buildOrderDiagnostics(ambiguousPrintOrder({
    fulfillmentLastError: 'print_submission_ambiguous: lulu 502 for ch_LEAKY_ID',
  }));
  const check = d.checks.find((c) => c.id === 'print-submission-ambiguous');
  assert.equal((check?.detail ?? '').includes('ch_LEAKY_ID'), false);
});

test('diagnostics: existing paid-no-artifact flags are unchanged for ordinary orders', () => {
  const d = buildOrderDiagnostics(makeOrder({
    paymentStatus: 'paid',
    fulfillmentStatus: 'not_started',
    storyArtifactUrl: null,
  }));
  assert.equal(d.flags.paidWithoutArtifact, true);
  assert.equal(d.flags.paidArtifactNeedsAttention, true);
  assert.equal(d.paidOrderOpsIssue?.kind, 'paid_no_artifact_not_started');
});
