/**
 * Tests for the durable fulfillment backlog selector — the core of the fix for
 * dropped paid->fulfillment kickoffs (ord_d4b46e9123c147ac repro).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFulfillmentOpsDigest, findFulfillmentBacklog } from '../src/lib/fulfillment-backlog.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const OLD = '2026-06-04T11:00:00.000Z'; // 1h ago — past the 90s grace
const FRESH = '2026-06-04T11:59:30.000Z'; // 30s ago — inside the grace

function order(p: Partial<OrderRecord>): OrderRecord {
  return {
    id: 'ord_x',
    childName: 'Test',
    bookFormat: 'digital',
    email: 'owner@example.com',
    paymentStatus: 'paid',
    createdAt: OLD,
    updatedAt: OLD,
    ...p,
  } as OrderRecord;
}

test('selects a paid, not_started order that is past the grace window', () => {
  const r = findFulfillmentBacklog([order({ id: 'ord_a', fulfillmentStatus: 'not_started' })], { now: NOW });
  assert.deepEqual(r.map((o) => o.id), ['ord_a']);
});

test('treats unset fulfillmentStatus as not_started (eligible)', () => {
  const r = findFulfillmentBacklog([order({ id: 'ord_unset', fulfillmentStatus: undefined })], { now: NOW });
  assert.deepEqual(r.map((o) => o.id), ['ord_unset']);
});

test('excludes orders inside the grace window (let the in-request kickoff try first)', () => {
  const r = findFulfillmentBacklog([order({ id: 'ord_fresh', fulfillmentStatus: 'not_started', updatedAt: FRESH, createdAt: FRESH })], { now: NOW });
  assert.equal(r.length, 0);
});

test('excludes in-progress, awaiting_qa, complete, delivery_email_failed, failed_manual_review', () => {
  const states = ['generating_story', 'generating_images', 'building_pdf', 'proof_ready', 'awaiting_qa', 'complete', 'delivery_email_failed', 'failed_manual_review', 'submitting_to_print', 'print_in_production'];
  const orders = states.map((s, i) => order({ id: `ord_${i}`, fulfillmentStatus: s as OrderRecord['fulfillmentStatus'] }));
  assert.equal(findFulfillmentBacklog(orders, { now: NOW }).length, 0);
});

test('excludes unpaid and refunded orders', () => {
  const orders = [
    order({ id: 'ord_pending', paymentStatus: 'pending', fulfillmentStatus: 'not_started' }),
    order({ id: 'ord_refunded', fulfillmentStatus: 'not_started', refundedAt: OLD }),
  ];
  assert.equal(findFulfillmentBacklog(orders, { now: NOW }).length, 0);
});

test('honors the exclude set (preserved repro artifact is never auto-swept)', () => {
  const orders = [order({ id: 'ord_repro', fulfillmentStatus: 'not_started' }), order({ id: 'ord_ok', fulfillmentStatus: 'not_started' })];
  const r = findFulfillmentBacklog(orders, { now: NOW, excludeOrderIds: new Set(['ord_repro']) });
  assert.deepEqual(r.map((o) => o.id), ['ord_ok']);
});

test('ignores orders older than maxAge (escalate to human, do not auto-run)', () => {
  const ancient = '2026-05-01T00:00:00.000Z';
  const r = findFulfillmentBacklog([order({ id: 'ord_ancient', fulfillmentStatus: 'not_started', createdAt: ancient, updatedAt: ancient })], { now: NOW });
  assert.equal(r.length, 0);
});

test('FIFO oldest-first and respects limit', () => {
  const mk = (id: string, c: string) => order({ id, fulfillmentStatus: 'not_started', createdAt: c, updatedAt: c });
  const orders = [
    mk('ord_new', '2026-06-04T11:50:00.000Z'),
    mk('ord_oldest', '2026-06-04T09:00:00.000Z'),
    mk('ord_mid', '2026-06-04T10:00:00.000Z'),
  ];
  const r = findFulfillmentBacklog(orders, { now: NOW, limit: 2 });
  assert.deepEqual(r.map((o) => o.id), ['ord_oldest', 'ord_mid']);
});

test('ops digest summarizes actionable paid fulfillment buckets for dashboard/cron hooks', () => {
  const digest = buildFulfillmentOpsDigest([
    order({ id: 'ord_paid_stuck', fulfillmentStatus: 'not_started' }),
    order({ id: 'ord_manual', fulfillmentStatus: 'failed_manual_review' }),
    order({ id: 'ord_email', fulfillmentStatus: 'delivery_email_failed' }),
    order({ id: 'ord_complete', fulfillmentStatus: 'complete' }),
    order({ id: 'ord_unpaid_manual', paymentStatus: 'pending', fulfillmentStatus: 'failed_manual_review' }),
  ], { now: NOW });

  assert.deepEqual(digest, {
    paidStuck: 1,
    failedManualReview: 1,
    deliveryEmailFailed: 1,
    orderIds: {
      paidStuck: ['ord_paid_stuck'],
      failedManualReview: ['ord_manual'],
      deliveryEmailFailed: ['ord_email'],
    },
  });
});
