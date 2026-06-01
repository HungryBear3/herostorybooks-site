import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCapacityDashboardSummary,
  DAILY_PAID_CEILING,
  DAILY_PAID_TARGET,
} from '../src/lib/capacity-dashboard.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: overrides.id ?? 'ord_capacity_test',
    childName: 'Luna',
    bookFormat: 'classic',
    formatLabel: 'Classic softcover',
    priceCents: 4499,
    status: 'order_received',
    paymentStatus: 'paid',
    fulfillmentStatus: 'awaiting_qa',
    email: 'parent@example.com',
    deliveryExpectation: 'Proof first',
    createdAt: '2026-06-01T15:00:00.000Z',
    updatedAt: '2026-06-01T16:00:00.000Z',
    ...overrides,
  } as OrderRecord;
}

test('capacity summary counts paid orders today against target and ceiling', () => {
  const orders = Array.from({ length: DAILY_PAID_TARGET }, (_, i) =>
    order({
      id: `ord_today_${i}`,
      createdAt: `2026-06-01T1${i}:00:00.000Z`,
      fulfillmentStatus: 'complete',
    }),
  );
  orders.push(
    order({
      id: 'ord_yesterday',
      createdAt: '2026-05-31T15:00:00.000Z',
      updatedAt: '2026-05-31T16:00:00.000Z',
    }),
  );

  const summary = buildCapacityDashboardSummary(orders, {
    now: new Date('2026-06-01T20:00:00.000Z'),
  });

  assert.equal(summary.dailyPaidTarget, DAILY_PAID_TARGET);
  assert.equal(summary.dailyPaidCeiling, DAILY_PAID_CEILING);
  assert.equal(summary.paidOrdersToday, DAILY_PAID_TARGET);
  assert.equal(summary.recommendation.level, 'open');
  assert.equal(summary.recommendation.label, 'At daily target; monitor closely');
});

test('capacity summary recommends pause when the hard daily paid ceiling is hit', () => {
  const orders = Array.from({ length: DAILY_PAID_CEILING }, (_, i) =>
    order({ id: `ord_ceiling_${i}`, createdAt: `2026-06-01T${String(10 + i).padStart(2, '0')}:00:00.000Z` }),
  );

  const summary = buildCapacityDashboardSummary(orders, {
    now: new Date('2026-06-01T22:00:00.000Z'),
  });

  assert.equal(summary.paidOrdersToday, DAILY_PAID_CEILING);
  assert.equal(summary.recommendation.level, 'pause');
  assert.ok(summary.recommendation.reasons.some((reason) => reason.includes('paid-order ceiling')));
});

test('capacity summary reports QA in-flight and oldest proof age from awaiting_qa orders', () => {
  const summary = buildCapacityDashboardSummary(
    [
      order({
        id: 'ord_oldest',
        fulfillmentStatus: 'awaiting_qa',
        updatedAt: '2026-06-01T10:00:00.000Z',
      }),
      order({
        id: 'ord_newer',
        fulfillmentStatus: 'awaiting_qa',
        updatedAt: '2026-06-01T18:00:00.000Z',
      }),
      order({ id: 'ord_done', fulfillmentStatus: 'complete' }),
    ],
    { now: new Date('2026-06-01T22:00:00.000Z') },
  );

  assert.equal(summary.qaInFlight, 2);
  assert.equal(summary.oldestProofOrderId, 'ord_oldest');
  assert.equal(summary.oldestProofAgeHours, 12);
});

test('capacity summary computes median time-to-proof from qaPassAt when available', () => {
  const summary = buildCapacityDashboardSummary(
    [
      order({
        id: 'ord_fast',
        createdAt: '2026-06-01T10:00:00.000Z',
        qaPassAt: '2026-06-01T20:00:00.000Z',
        fulfillmentStatus: 'proof_ready',
      }),
      order({
        id: 'ord_slow',
        createdAt: '2026-05-30T10:00:00.000Z',
        qaPassAt: '2026-06-01T10:00:00.000Z',
        fulfillmentStatus: 'proof_ready',
      }),
      order({ id: 'ord_no_proof_time', fulfillmentStatus: 'awaiting_qa' }),
    ],
    { now: new Date('2026-06-01T22:00:00.000Z') },
  );

  assert.equal(summary.proofTimeSampleSize, 2);
  assert.equal(summary.medianProofTimeHours, 29);
});

test('capacity summary recommends slowdown when QA backlog or revision round-trips exceed trigger', () => {
  const orders = Array.from({ length: 7 }, (_, i) =>
    order({ id: `ord_queue_${i}`, fulfillmentStatus: 'awaiting_qa' }),
  );
  orders.push(
    order({
      id: 'ord_revision',
      pageArtifacts: [
        {
          pageIndex: 0,
          storyText: 'Page',
          basePrompt: 'Prompt',
          currentImageUrl: null,
          regenerateCount: 3,
          accepted: false,
          feedbackHistory: [],
          versionHistory: [],
        },
      ],
    }),
  );

  const summary = buildCapacityDashboardSummary(orders, {
    now: new Date('2026-06-01T22:00:00.000Z'),
  });

  assert.equal(summary.recommendation.level, 'slowdown');
  assert.equal(summary.qaInFlight, 8);
  assert.equal(summary.maxRevisionRoundTrips, 3);
  assert.equal(summary.maxRevisionOrderId, 'ord_revision');
});

test('capacity summary recommends pause on rolling-five QA defect rate above threshold', () => {
  const latestFive = Array.from({ length: 5 }, (_, i) =>
    order({
      id: `ord_latest_${i}`,
      createdAt: `2026-06-01T1${i}:00:00.000Z`,
      fulfillmentStatus: 'complete',
      ...(i === 0 || i === 1
        ? {
            pageArtifacts: [
              {
                pageIndex: 0,
                storyText: 'Page',
                basePrompt: 'Prompt',
                currentImageUrl: null,
                regenerateCount: 0,
                accepted: false,
                targetedRegenNeeded: true,
                feedbackHistory: [],
                versionHistory: [],
              },
            ],
          }
        : {}),
    }),
  );

  const summary = buildCapacityDashboardSummary(latestFive, {
    now: new Date('2026-06-01T22:00:00.000Z'),
  });

  assert.equal(summary.rollingFivePaidOrderCount, 5);
  assert.equal(summary.rollingFiveDefectOrderCount, 2);
  assert.equal(summary.rollingFiveQaDefectRatePercent, 40);
  assert.equal(summary.recommendation.level, 'pause');
});

test('capacity summary recommends pause when print acknowledgment is delayed over 24 hours', () => {
  const summary = buildCapacityDashboardSummary(
    [
      order({
        id: 'ord_print_ack_delayed',
        fulfillmentStatus: 'submitting_to_print',
        updatedAt: '2026-05-31T12:00:00.000Z',
        printJobStatus: null,
      }),
    ],
    { now: new Date('2026-06-01T20:00:00.000Z') },
  );

  assert.equal(summary.printAckDelayedCount, 1);
  assert.deepEqual(summary.printAckDelayedOrderIds, ['ord_print_ack_delayed']);
  assert.equal(summary.recommendation.level, 'pause');
});

test('capacity summary marks Stripe dispute signal unavailable instead of inventing a value', () => {
  const summary = buildCapacityDashboardSummary([], {
    now: new Date('2026-06-01T20:00:00.000Z'),
  });

  assert.equal(summary.stripeDisputeSignalAvailable, false);
  assert.equal(summary.stripeDisputeOpen, null);
  assert.ok(summary.recommendation.unavailableSignals.some((signal) => signal.includes('Stripe dispute')));
});
