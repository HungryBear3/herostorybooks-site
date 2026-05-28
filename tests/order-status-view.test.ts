import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOrderStatusView } from '../src/lib/order-status-view.ts';
import { createOrderRecord } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id: 'ord_status_test', now: '2026-04-23T10:00:00Z' },
  );
  return { ...base, ...overrides };
}

// ── Pending / unpaid ──────────────────────────────────────────────────────────

test('pending payment shows neutral tone and payment active step', () => {
  const view = buildOrderStatusView(makeOrder({ paymentStatus: 'pending' }));
  assert.equal(view.tone, 'neutral');
  assert.ok(view.headline.includes('Finishing'));
  const payment = view.timeline.find(s => s.id === 'payment');
  assert.equal(payment?.state, 'active');
  assert.equal(view.primaryAction, undefined);
});

// ── Digital paths ─────────────────────────────────────────────────────────────

test('digital order: paid but not started → confirmed headline', () => {
  const view = buildOrderStatusView(
    makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }),
  );
  assert.equal(view.isPrint, false);
  assert.ok(view.headline.includes('confirmed'));
  assert.equal(view.primaryAction, undefined);
});

test('digital order: complete with artifact → download CTA + success tone', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'digital',
      fulfillmentStatus: 'complete',
      storyArtifactUrl: 'https://cdn.example.com/luna-storybook.pdf',
    }),
  );
  assert.equal(view.tone, 'success');
  assert.equal(view.primaryAction?.kind, 'download');
  assert.equal(view.primaryAction?.href, 'https://cdn.example.com/luna-storybook.pdf');
  const ready = view.timeline.find(s => s.id === 'ready');
  assert.equal(ready?.state, 'done');
});

test('digital order in-progress: generating_images → active creating step', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'digital',
      fulfillmentStatus: 'generating_images',
    }),
  );
  assert.equal(view.tone, 'neutral');
  assert.ok(view.headline.toLowerCase().includes('illustrat'));
  const creating = view.timeline.find(s => s.id === 'creating');
  assert.equal(creating?.state, 'active');
});

test('digital timeline has exactly 4 steps', () => {
  const view = buildOrderStatusView(
    makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }),
  );
  assert.equal(view.timeline.length, 4);
});

// ── Print paths ───────────────────────────────────────────────────────────────

test('print order: proof_ready with artifact → view CTA + action tone', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/luna-proof.pdf',
    }),
  );
  assert.equal(view.isPrint, true);
  assert.equal(view.tone, 'action');
  assert.equal(view.needsAction, true);
  assert.equal(view.primaryAction?.kind, 'view');
  const proof = view.timeline.find(s => s.id === 'proof');
  assert.equal(proof?.state, 'active');
});

test('print order: proof_ready with token → review approval CTA, not bare PDF', () => {
  const view = buildOrderStatusView(
    makeOrder({
      id: 'ord_review_cta',
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/luna-proof.pdf',
      proofApprovalToken: 'tok_review_123',
    }),
  );
  assert.equal(view.needsAction, true);
  assert.equal(view.primaryAction?.kind, 'approve');
  assert.equal(view.primaryAction?.href, '/review/ord_review_cta?token=tok_review_123');
  assert.match(view.primaryAction?.label ?? '', /review/i);
  assert.equal(view.secondaryAction?.href, 'https://cdn.example.com/luna-proof.pdf');
});

test('print order: in production → success tone, proof done, production active', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'premium',
      fulfillmentStatus: 'complete',
      status: 'print_in_production',
      printJobId: 'lulu-1234',
    }),
  );
  assert.equal(view.tone, 'success');
  assert.ok(view.headline.includes('production'));
  const proof = view.timeline.find(s => s.id === 'proof');
  const production = view.timeline.find(s => s.id === 'production');
  assert.equal(proof?.state, 'done');
  assert.equal(production?.state, 'active');
});

test('print order: shipped → shipped step done', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'complete',
      status: 'shipped',
    }),
  );
  assert.equal(view.tone, 'success');
  assert.ok(view.headline.toLowerCase().includes('shipped'));
  const shipped = view.timeline.find(s => s.id === 'shipped');
  assert.equal(shipped?.state, 'done');
});

test('print timeline has exactly 6 steps', () => {
  const view = buildOrderStatusView(
    makeOrder({ paymentStatus: 'paid', bookFormat: 'classic' }),
  );
  assert.equal(view.timeline.length, 6);
});

// ── Failed / manual review ────────────────────────────────────────────────────

test('failed_manual_review: failure tone, support language, no CTA', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentLastError: 'OpenAI rate limit',
    }),
  );
  assert.equal(view.tone, 'failure');
  assert.equal(view.isFailed, true);
  assert.equal(view.primaryAction, undefined);
  assert.ok(view.headline.toLowerCase().includes('snag'));
  assert.ok(view.supportBlurb.includes('ord_status_test'));
});

test('failed order keeps timeline shape for print format', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'failed_manual_review',
    }),
  );
  assert.equal(view.timeline.length, 6);
});

// ── Tracking surface ──────────────────────────────────────────────────────────

test('shipped order with tracking surfaces tracking block + carrier CTA', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'complete',
      status: 'shipped',
      trackingNumber: '9400111XXXX',
      trackingUrl: 'https://tools.usps.com/track/9400',
      shippedAt: '2026-04-25T12:00:00Z',
    }),
  );
  assert.equal(view.tracking?.number, '9400111XXXX');
  assert.equal(view.tracking?.url, 'https://tools.usps.com/track/9400');
  assert.equal(view.primaryAction?.kind, 'view');
  assert.ok(view.primaryAction?.href?.includes('usps.com'));
});

test('shipped order without tracking still shows shipped tone, no CTA', () => {
  const view = buildOrderStatusView(
    makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      status: 'shipped',
      fulfillmentStatus: 'complete',
    }),
  );
  assert.equal(view.tracking, undefined);
  assert.equal(view.primaryAction, undefined);
  assert.ok(view.headline.toLowerCase().includes('shipped'));
});

// ── Support blurb always includes order id ────────────────────────────────────

test('support blurb always includes order id', () => {
  const view = buildOrderStatusView(makeOrder({ paymentStatus: 'paid' }));
  assert.ok(view.supportBlurb.includes('ord_status_test'));
});
