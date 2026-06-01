import test from 'node:test';
import assert from 'node:assert/strict';

import type { OrderRecord } from '../src/lib/orders.ts';
import {
  analyzeOrderQa,
  dailyCommandBoard,
  defaultMarketingGuardrail,
  evaluatePosture,
} from '../src/lib/qa-room.ts';

function baseOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord_test_qa_room',
    childName: 'Sam',
    bookFormat: 'classic',
    formatLabel: 'Classic softcover',
    priceCents: 4499,
    status: 'preview_ready',
    paymentStatus: 'paid',
    fulfillmentStatus: 'awaiting_qa',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofApprovalToken: 'tok_test',
    shippingAddress: {
      line1: '1 Main St',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      country: 'US',
    },
    pageArtifacts: [
      {
        pageIndex: 0,
        storyText: 'page 1',
        basePrompt: 'p1',
        currentImageUrl: 'https://example.com/p1.png',
        accepted: false,
        regenerateCount: 0,
        feedbackHistory: [],
        versionHistory: [],
        generationProvider: 'fal_edit',
        generationModel: 'fal-ai/bytedance/seedream/v4/edit',
        generationConditioning: 'photo_edit',
      },
    ],
    storyMeta: {
      source: 'openai_chat',
      model: 'gpt-4o-mini',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: null,
    },
    email: 'sam@example.com',
    deliveryExpectation: 'Print proof ready',
    createdAt: '2026-05-31T18:00:00.000Z',
    updatedAt: '2026-05-31T20:00:00.000Z',
    ...overrides,
  } as OrderRecord;
}

test('analyzeOrderQa: happy print order awaiting_qa with paid + artifact + shipping can pass QA', () => {
  const order = baseOrder();
  const a = analyzeOrderQa(order, { now: new Date('2026-05-31T20:10:00.000Z') });

  assert.equal(a.awaitingQa, true);
  assert.equal(a.qaPassed, false);
  assert.equal(a.hasArtifact, true);
  assert.equal(a.canQaPass, true);
  assert.equal(a.blockers.length, 0);
  assert.equal(a.printGoNoGoState, 'not_yet');
  assert.equal(a.printReady, false);
  assert.match(a.requiredAction, /Run QA checklist/);
  assert.equal(a.storyOrigin.isFallback, false);
  assert.equal(a.storyOrigin.isTemplate, false);
  assert.equal(a.imageLane.provider, 'fal_edit');
  assert.equal(a.imageLane.conditioning, 'photo_edit');
  assert.ok(a.slaAgeMinutes !== null && a.slaAgeMinutes >= 10);
});

test('analyzeOrderQa: template_after_openai_failure must block customer release', () => {
  const order = baseOrder({
    storyMeta: {
      source: 'template_after_openai_failure',
      model: 'template:Quest',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: 'fetch failed',
    },
  });
  const a = analyzeOrderQa(order);

  assert.equal(a.canQaPass, false);
  assert.ok(a.blockers.some((b) => b.code === 'template_after_openai_failure' && b.severity === 'block'));
  assert.ok(a.riskFlags.some((f) => f.code === 'story_provider_failed'));
  assert.ok(a.riskFlags.some((f) => f.code === 'template_fallback'));
  assert.match(a.requiredAction, /Resolve.*blocker/);
});

test('analyzeOrderQa: missing artifact while awaiting_qa is a hard blocker', () => {
  const order = baseOrder({ storyArtifactUrl: undefined });
  const a = analyzeOrderQa(order);
  assert.equal(a.hasArtifact, false);
  assert.equal(a.canQaPass, false);
  assert.ok(a.blockers.some((b) => b.code === 'missing_artifact'));
  assert.match(a.requiredAction, /Wait for artifact/);
});

test('analyzeOrderQa: print order missing shipping address blocks QA pass', () => {
  const order = baseOrder({ shippingAddress: null });
  const a = analyzeOrderQa(order);
  assert.equal(a.shippingPresentIfRequired, false);
  assert.equal(a.canQaPass, false);
  assert.ok(a.riskFlags.some((f) => f.code === 'shipping_problem'));
});

test('analyzeOrderQa: digital order does not require shipping', () => {
  const order = baseOrder({
    bookFormat: 'digital',
    formatLabel: 'Digital PDF',
    shippingAddress: null,
    storyArtifactUrl: 'https://example.com/digital.pdf',
  });
  const a = analyzeOrderQa(order);
  assert.equal(a.isPrint, false);
  assert.equal(a.shippingPresentIfRequired, true);
  assert.equal(a.canQaPass, true);
  assert.ok(!a.riskFlags.some((f) => f.code === 'shipping_problem'));
});

test('analyzeOrderQa: QA already passed — canQaPass is false because state is no longer awaiting_qa', () => {
  const order = baseOrder({
    fulfillmentStatus: 'proof_ready',
    qaPassAt: '2026-05-31T20:05:00.000Z',
    qaPassBy: 'operator-1',
  });
  const a = analyzeOrderQa(order);
  assert.equal(a.qaPassed, true);
  assert.equal(a.awaitingQa, false);
  assert.equal(a.canQaPass, false);
});

test('analyzeOrderQa: print go/no-go state advances with order state', () => {
  const a1 = analyzeOrderQa(baseOrder({ fulfillmentStatus: 'proof_approved' }));
  assert.equal(a1.printGoNoGoState, 'awaiting_print_go');
  assert.equal(a1.printReady, true);
  assert.match(a1.requiredAction, /print go\/no-go/i);

  const a2 = analyzeOrderQa(baseOrder({ fulfillmentStatus: 'submitting_to_print', printJobId: 'lulu_123' }));
  assert.equal(a2.printGoNoGoState, 'submitted');

  const a3 = analyzeOrderQa(baseOrder({ status: 'shipped', printJobId: 'lulu_123' }));
  assert.equal(a3.printGoNoGoState, 'shipped');
});

test('analyzeOrderQa: customer-visible status does not leak internal provider details', () => {
  const order = baseOrder({
    storyMeta: {
      source: 'template_after_openai_failure',
      model: 'template:Quest',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: 'fetch failed',
    },
  });
  const a = analyzeOrderQa(order);
  const text = `${a.customerVisibleHeadline} ${a.customerVisibleStatus}`.toLowerCase();
  assert.ok(!text.includes('openai'), `customer copy must not say OpenAI: ${text}`);
  assert.ok(!text.includes('fal'), `customer copy must not say fal: ${text}`);
  assert.ok(!text.includes('template'), `customer copy must not say template: ${text}`);
  assert.ok(!text.includes('fallback'));
  assert.ok(!text.includes('blocker'));
});

test('analyzeOrderQa: refunded order is blocked from release', () => {
  const order = baseOrder({ paymentStatus: 'refunded', refundedAt: '2026-05-31T19:00:00.000Z' });
  const a = analyzeOrderQa(order);
  assert.equal(a.canQaPass, false);
  assert.ok(a.blockers.some((b) => b.code === 'payment_not_confirmed' || b.code === 'refunded'));
});

test('evaluatePosture: gate-not-installed forces RED + gate down', () => {
  const p = evaluatePosture([baseOrder()], { gateBackendInstalled: false });
  assert.equal(p.level, 'RED');
  assert.equal(p.gateState, 'unknown');
  assert.equal(p.gateDown, true);
  assert.ok(p.rationale.join(' ').toLowerCase().includes('qa gate'));
});

test('evaluatePosture: clean fleet, gate installed → GREEN', () => {
  const order = baseOrder({ fulfillmentStatus: 'complete', qaPassAt: '2026-05-31T20:00:00.000Z' });
  const p = evaluatePosture([order], { gateBackendInstalled: true });
  assert.equal(p.level, 'GREEN');
  assert.equal(p.gateState, 'live');
  assert.equal(p.gateDown, false);
});

test('evaluatePosture: any template_after_openai_failure → YELLOW, three+ → RED', () => {
  const fallback = baseOrder({
    id: 'ord_y_1',
    storyMeta: {
      source: 'template_after_openai_failure',
      model: 'template:Quest',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: 'fetch failed',
    },
  });
  const py = evaluatePosture([fallback], { gateBackendInstalled: true });
  assert.equal(py.level, 'YELLOW');

  const pr = evaluatePosture([fallback, { ...fallback, id: 'ord_y_2' }, { ...fallback, id: 'ord_y_3' }], {
    gateBackendInstalled: true,
  });
  assert.equal(pr.level, 'RED');
});

test('evaluatePosture: stuck > 60min adds YELLOW', () => {
  const stuck = baseOrder({
    fulfillmentStatus: 'awaiting_qa',
    updatedAt: '2026-05-31T18:00:00.000Z',
  });
  const p = evaluatePosture([stuck], {
    gateBackendInstalled: true,
    now: new Date('2026-05-31T20:00:00.000Z'),
  });
  assert.equal(p.level, 'YELLOW');
  assert.ok(p.rationale.join(' ').includes('stuck'));
});

test('defaultMarketingGuardrail: hard-coded caps the operator expects to see', () => {
  const g = defaultMarketingGuardrail();
  assert.equal(g.paidBudgetUsd, 200);
  assert.equal(g.retargetingOnly, true);
  assert.equal(g.creatorsAcceptedCap, 5);
  assert.equal(g.giftedProductionDailyCap, 2);
  assert.ok(g.notes.some((n) => n.includes('No new traffic until QA gate is live')));
});

test('dailyCommandBoard: four buckets, non-empty', () => {
  const b = dailyCommandBoard();
  assert.ok(b.morning.length >= 3);
  assert.ok(b.midday.length >= 3);
  assert.ok(b.afternoon.length >= 3);
  assert.ok(b.endOfDay.length >= 3);
});
