/**
 * order-watchdog — pure classifier that flags PAID orders stuck before
 * customer delivery/fulfillment. Healthy orders and orders inside their
 * normal window must NOT be flagged; every risky state must be.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import {
  classifyStuckOrder,
  buildStuckOrderReport,
  formatStuckOrderReport,
  WATCHDOG_DEFAULT_THRESHOLDS,
} from '../src/lib/order-watchdog.ts';

const NOW = new Date('2026-05-23T12:00:00Z');

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    {
      childName: 'Luna',
      bookFormat: (overrides.bookFormat as string) ?? 'classic',
      email: 'a@b.com',
    },
    { id: overrides.id ?? 'ord_wd_1', now: '2026-05-23T10:00:00Z' },
  );
  return { ...base, ...overrides };
}

/** ISO timestamp `minutes` before NOW. */
function ago(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

const classify = (o: OrderRecord) => classifyStuckOrder(o, { now: NOW });

// ── Healthy / not-at-risk: must return null ──────────────────────────────────

test('healthy: unpaid order is not watched', () => {
  assert.equal(classify(makeOrder({ paymentStatus: 'pending' })), null);
});

test('healthy: refunded order is ignored', () => {
  assert.equal(
    classify(makeOrder({ paymentStatus: 'paid', refundedAt: ago(10), fulfillmentStatus: 'not_started' })),
    null,
  );
});

test('healthy: internal test/smoke disposition is ignored', () => {
  assert.equal(
    classify(
      makeOrder({
        paymentStatus: 'paid',
        fulfillmentStatus: 'not_started',
        internalDisposition: 'abandoned_internal_test',
      }),
    ),
    null,
  );
});

test('healthy: delivered digital order (complete + artifact) is not stuck', () => {
  assert.equal(
    classify(
      makeOrder({
        bookFormat: 'digital',
        paymentStatus: 'paid',
        fulfillmentStatus: 'complete',
        status: 'preview_ready',
        storyArtifactUrl: 'https://example.com/book.pdf',
      }),
    ),
    null,
  );
});

test('healthy: shipped print order is not stuck', () => {
  assert.equal(
    classify(
      makeOrder({
        paymentStatus: 'paid',
        fulfillmentStatus: 'complete',
        status: 'shipped',
        storyArtifactUrl: 'https://example.com/proof.pdf',
        printJobId: 'PJ1',
        trackingNumber: '1Z999',
        shippedAt: ago(60),
      }),
    ),
    null,
  );
});

test('healthy: paid order still inside the generation window is not flagged', () => {
  assert.equal(
    classify(
      makeOrder({
        paymentStatus: 'paid',
        fulfillmentStatus: 'generating_images',
        storyArtifactUrl: null,
        updatedAt: ago(5),
      }),
    ),
    null,
  );
});

test('healthy: fresh print proof (within approval window) is not flagged', () => {
  assert.equal(
    classify(
      makeOrder({
        paymentStatus: 'paid',
        fulfillmentStatus: 'proof_ready',
        storyArtifactUrl: 'https://example.com/proof.pdf',
        reviewStatus: 'in_review',
        updatedAt: ago(60), // 1h < 72h
      }),
    ),
    null,
  );
});

test('healthy: print job in production within ship window is not flagged', () => {
  assert.equal(
    classify(
      makeOrder({
        paymentStatus: 'paid',
        fulfillmentStatus: 'complete',
        status: 'print_in_production',
        storyArtifactUrl: 'https://example.com/proof.pdf',
        reviewStatus: 'approved',
        printJobId: 'PJ42',
        printJobStatus: 'IN_PRODUCTION',
        updatedAt: ago(60 * 24 * 3), // 3 days < 14 days
      }),
    ),
    null,
  );
});

// ── Pre-artifact stage (delegated to classifyPaidOrderOpsIssue) ──────────────

test('stuck: paid but fulfillment not_started → fail', () => {
  const f = classify(
    makeOrder({ paymentStatus: 'paid', fulfillmentStatus: 'not_started', storyArtifactUrl: null }),
  );
  assert.equal(f?.reason, 'paid_no_artifact_not_started');
  assert.equal(f?.severity, 'fail');
});

test('stuck: paid + failed_manual_review before artifact → fail with error', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'failed_manual_review',
      storyArtifactUrl: null,
      fulfillmentLastError: 'OpenAI rate limit',
    }),
  );
  assert.equal(f?.reason, 'paid_no_artifact_failed');
  assert.equal(f?.severity, 'fail');
});

test('stuck: paid + in-progress stale beyond threshold → fail', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'building_pdf',
      storyArtifactUrl: null,
      updatedAt: ago(20), // > 15 min
    }),
  );
  assert.equal(f?.reason, 'paid_no_artifact_stale_in_progress');
  assert.equal(f?.severity, 'fail');
});

// ── Delivery stage ───────────────────────────────────────────────────────────

test('stuck: digital delivery_email_failed (artifact exists) → fail', () => {
  const f = classify(
    makeOrder({
      bookFormat: 'digital',
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://example.com/book.pdf',
      fulfillmentLastError: 'delivery_email_failed: Resend domain not verified',
    }),
  );
  assert.equal(f?.reason, 'delivery_email_failed');
  assert.equal(f?.severity, 'fail');
  assert.match(f?.suggestedAction ?? '', /resend/i);
});

test('stuck: print proof-email failed → fail', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'delivery_email_failed',
      storyArtifactUrl: 'https://example.com/proof.pdf',
    }),
  );
  assert.equal(f?.reason, 'delivery_email_failed');
});

// ── Print follow-up stages ───────────────────────────────────────────────────

test('stuck: paid print proof un-approved beyond the stale window → warn', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      reviewStatus: 'in_review',
      updatedAt: ago(60 * 24 * 4), // 4 days > 3 days
    }),
  );
  assert.equal(f?.reason, 'print_proof_awaiting_customer_stale');
  assert.equal(f?.severity, 'warn');
});

test('stuck: approved print order with no print job id → fail', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_approved',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      reviewStatus: 'approved',
      proofApprovedAt: ago(120),
      printJobId: null,
      updatedAt: ago(120), // > 30 min
    }),
  );
  assert.equal(f?.reason, 'print_approved_not_submitted');
  assert.equal(f?.severity, 'fail');
});

test('stuck: submitting_to_print with no print job id, aged → fail (stalled)', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'submitting_to_print',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      reviewStatus: 'approved',
      printJobId: null,
      updatedAt: ago(45), // > 30 min
    }),
  );
  assert.equal(f?.reason, 'print_submit_stalled');
  assert.equal(f?.severity, 'fail');
});

test('not-yet-stuck: just-approved print order is inside the submit grace window', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_approved',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      reviewStatus: 'approved',
      printJobId: null,
      updatedAt: ago(5), // < 30 min
    }),
  );
  assert.equal(f, null);
});

test('stuck: print job submitted but never shipped beyond ship window → warn', () => {
  const f = classify(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'complete',
      status: 'print_in_production',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      reviewStatus: 'approved',
      printJobId: 'PJ77',
      printJobStatus: 'CREATED',
      updatedAt: ago(60 * 24 * 20), // 20 days > 14 days
    }),
  );
  assert.equal(f?.reason, 'print_submitted_no_shipment_stale');
  assert.equal(f?.severity, 'warn');
});

// ── Report builder + formatter ───────────────────────────────────────────────

test('report: counts, severity tallies, and fail-first ordering', () => {
  const orders: OrderRecord[] = [
    makeOrder({ id: 'ord_ok', bookFormat: 'digital', paymentStatus: 'paid', fulfillmentStatus: 'complete', storyArtifactUrl: 'u' }),
    makeOrder({ id: 'ord_pending', paymentStatus: 'pending' }),
    makeOrder({ id: 'ord_warn', paymentStatus: 'paid', fulfillmentStatus: 'proof_ready', storyArtifactUrl: 'u', reviewStatus: 'in_review', updatedAt: ago(60 * 24 * 5) }),
    makeOrder({ id: 'ord_fail', paymentStatus: 'paid', fulfillmentStatus: 'not_started', storyArtifactUrl: null }),
  ];

  const report = buildStuckOrderReport(orders, { now: NOW });
  assert.equal(report.scanned, 4);
  assert.equal(report.paidScanned, 3);
  assert.equal(report.stuck, 2);
  assert.deepEqual(report.bySeverity, { fail: 1, warn: 1 });
  // fail sorts before warn
  assert.equal(report.findings[0].orderId, 'ord_fail');
  assert.equal(report.findings[0].severity, 'fail');
  assert.equal(report.findings[1].orderId, 'ord_warn');
});

test('report: all-healthy store produces zero findings', () => {
  const report = buildStuckOrderReport(
    [
      makeOrder({ id: 'a', bookFormat: 'digital', paymentStatus: 'paid', fulfillmentStatus: 'complete', storyArtifactUrl: 'u' }),
      makeOrder({ id: 'b', paymentStatus: 'paid', status: 'shipped', fulfillmentStatus: 'complete', storyArtifactUrl: 'u', printJobId: 'p', shippedAt: ago(10) }),
    ],
    { now: NOW },
  );
  assert.equal(report.stuck, 0);
  assert.match(formatStuckOrderReport(report), /No stuck paid orders detected/);
});

test('formatter: includes id, reason, action and severity tag', () => {
  const report = buildStuckOrderReport(
    [makeOrder({ id: 'ord_fmt', paymentStatus: 'paid', fulfillmentStatus: 'not_started', storyArtifactUrl: null })],
    { now: NOW },
  );
  const text = formatStuckOrderReport(report);
  assert.match(text, /\[FAIL\]/);
  assert.match(text, /ord_fmt/);
  assert.match(text, /paid_no_artifact_not_started/);
  assert.match(text, /action:/);
});

test('thresholds: defaults are exported and overridable', () => {
  assert.equal(WATCHDOG_DEFAULT_THRESHOLDS.printSubmitStaleMs, 30 * 60 * 1000);
  // A 5-minute-old approved order with a tiny override threshold IS stuck.
  const f = classifyStuckOrder(
    makeOrder({
      paymentStatus: 'paid',
      fulfillmentStatus: 'proof_approved',
      storyArtifactUrl: 'u',
      reviewStatus: 'approved',
      printJobId: null,
      updatedAt: ago(5),
    }),
    { now: NOW, printSubmitStaleMs: 60 * 1000 },
  );
  assert.equal(f?.reason, 'print_approved_not_submitted');
});
