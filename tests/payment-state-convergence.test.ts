import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { triggerFulfillment, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import {
  createOrderRecord,
  getOrder,
  persistOrder,
  updateOrderPayment,
  type OrderRecord,
} from '../src/lib/orders.ts';
import type { StoryContent } from '../src/lib/fulfillment-types.ts';

const STORY: StoryContent = {
  title: 'Payment boundary story',
  dedication: 'For the test.',
  characterDescription: 'A brave child.',
  pages: Array.from({ length: 24 }, (_, index) => ({
    pageNum: index + 1,
    sceneTitle: `Scene ${index + 1}`,
    story: `Story page ${index + 1}.`,
    imagePrompt: `Image ${index + 1}`,
  })),
};

type TerminalEvent = {
  id: string;
  type: 'charge.refunded' | 'charge.dispute.created' | 'checkout.session.async_payment_failed';
  created?: number;
  data: { object: Record<string, unknown> };
};

type ConvergenceResult = {
  acknowledged: true;
  outcome: 'converged' | 'already_terminal' | 'unresolved';
  orderId: string | null;
};

type ProcessTerminalEvent = (event: TerminalEvent) => Promise<ConvergenceResult>;

async function processor(): Promise<ProcessTerminalEvent> {
  const paymentRecovery = await import('../src/lib/payment-recovery.ts') as Record<string, unknown>;
  const candidate = paymentRecovery.processStripePaymentTerminalEvent;
  assert.equal(typeof candidate, 'function', 'payment terminal-event processor must exist');
  return candidate as ProcessTerminalEvent;
}

function setupStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-payment-convergence-'));
  const orders = path.join(root, 'orders');
  const recovery = path.join(root, 'recovery');
  process.env.HSB_ORDER_STORE_DIR = orders;
  process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = recovery;
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  delete process.env.VERCEL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return { root, recovery };
}

function cleanupStore(root: string) {
  rmSync(root, { recursive: true, force: true });
  for (const key of ['HSB_ORDER_STORE_DIR', 'HSB_PAYMENT_RECOVERY_STORE_DIR', 'HSB_REQUIRE_DURABLE_PERSISTENCE']) {
    delete process.env[key];
  }
}

async function seed(id: string, overrides: Partial<OrderRecord> = {}) {
  const order = {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'digital', email: 'buyer@example.com' },
      { id, now: '2026-08-23T12:00:00.000Z', fulfillmentMode: 'auto' },
    ),
    stripeSessionId: `cs_${id}`,
    stripePaymentIntentId: `pi_${id}`,
    ...overrides,
  } satisfies OrderRecord;
  await persistOrder(order);
  return order;
}

function chargeEvent(
  type: 'charge.refunded' | 'charge.dispute.created',
  orderId: string | null,
  eventId: string,
): TerminalEvent {
  const providerObjectId = type === 'charge.refunded' ? `ch_${eventId}` : `dp_${eventId}`;
  return {
    id: eventId,
    type,
    created: 1_777_000_000,
    data: {
      object: {
        id: providerObjectId,
        payment_intent: `pi_${orderId ?? 'unknown'}`,
        metadata: orderId ? { orderId } : {},
        ...(type === 'charge.refunded' ? {
          amount: 10_000,
          amount_refunded: 10_000,
          refunded: true,
          refunds: { data: [{ id: `re_${eventId}` }] },
        } : {}),
      },
    },
  };
}

function noSpendDeps(calls: Record<string, number>): FulfillmentDeps {
  return {
    generateStory: async () => { calls.story += 1; return STORY; },
    generateImages: async (prompts) => { calls.images += 1; return prompts.map(() => 'https://example.test/page.jpg'); },
    buildPdf: async () => { calls.pdf += 1; return Buffer.from('%PDF'); },
    uploadArtifact: async () => { calls.upload += 1; return 'https://example.test/proof.pdf'; },
    submitPrint: async () => { calls.print += 1; return { jobId: 'never' }; },
    sleep: async () => {},
  };
}

test('A1 charge.refunded converges atomically, audits stripe_webhook, stops spend, and cannot be replayed paid', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_charge_refund', { paymentStatus: 'paid', paidAt: '2026-08-23T12:01:00.000Z' });
    const processEvent = await processor();
    const result = await processEvent(chargeEvent('charge.refunded', order.id, 'evt_refund_1'));
    assert.deepEqual(result, { acknowledged: true, outcome: 'converged', orderId: order.id });

    const reversed = await getOrder(order.id);
    assert.equal(reversed?.paymentStatus, 'refunded');
    assert.ok(reversed?.refundedAt);
    assert.equal(reversed?.stripeRefundId, 're_evt_refund_1');
    assert.equal(reversed?.fulfillmentStatus, 'failed_manual_review');
    const audit = reversed?.auditEvents?.find((entry) => entry.type === 'payment_terminal_state_recorded');
    assert.equal(audit?.meta?.source, 'stripe_webhook');
    assert.equal(audit?.meta?.stripeEventId, 'evt_refund_1');

    const calls = { story: 0, images: 0, pdf: 0, upload: 0, print: 0 };
    const fulfillment = await triggerFulfillment(order.id, noSpendDeps(calls), {
      readbackMaxAttempts: 1,
      readbackInitialDelayMs: 0,
    });
    assert.equal(fulfillment.status, 'not_paid_yet');
    assert.deepEqual(calls, { story: 0, images: 0, pdf: 0, upload: 0, print: 0 });

    assert.equal(await updateOrderPayment(order.id, 'paid', { stripeSessionId: order.stripeSessionId! }), null);
    assert.equal((await getOrder(order.id))?.paymentStatus, 'refunded');
  } finally { cleanupStore(root); }
});

test('A2 charge.dispute.created converges to terminal refunded markers and refuses fulfillment', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_dispute', { paymentStatus: 'paid' });
    const processEvent = await processor();
    assert.equal((await processEvent(chargeEvent('charge.dispute.created', order.id, 'evt_dispute_1'))).outcome, 'converged');
    const disputed = await getOrder(order.id);
    assert.equal(disputed?.paymentStatus, 'refunded');
    assert.ok(disputed?.refundedAt);
    assert.equal(disputed?.stripeRefundId, 'dp_evt_dispute_1');
    assert.equal(disputed?.refundReason, 'stripe_dispute_created');
    assert.equal(disputed?.auditEvents?.at(-1)?.meta?.source, 'stripe_webhook');

    const calls = { story: 0, images: 0, pdf: 0, upload: 0, print: 0 };
    await triggerFulfillment(order.id, noSpendDeps(calls), { readbackMaxAttempts: 1, readbackInitialDelayMs: 0 });
    assert.deepEqual(calls, { story: 0, images: 0, pdf: 0, upload: 0, print: 0 });
  } finally { cleanupStore(root); }
});

test('A3 checkout.session.async_payment_failed marks only the exact bound pending order failed with no kickoff', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_async_failed', { paymentStatus: 'pending' });
    const processEvent = await processor();
    const result = await processEvent({
      id: 'evt_async_failed_1',
      type: 'checkout.session.async_payment_failed',
      created: 1_777_000_000,
      data: { object: {
        id: order.stripeSessionId,
        client_reference_id: order.id,
        metadata: { orderId: order.id },
        payment_intent: 'pi_async_failed_1',
      } },
    });
    assert.equal(result.outcome, 'converged');
    const failed = await getOrder(order.id);
    assert.equal(failed?.paymentStatus, 'failed');
    assert.equal(failed?.refundedAt ?? null, null);
    assert.equal(failed?.auditEvents?.at(-1)?.meta?.source, 'stripe_webhook');

    const calls = { story: 0, images: 0, pdf: 0, upload: 0, print: 0 };
    await triggerFulfillment(order.id, noSpendDeps(calls), { readbackMaxAttempts: 1, readbackInitialDelayMs: 0 });
    assert.deepEqual(calls, { story: 0, images: 0, pdf: 0, upload: 0, print: 0 });
  } finally { cleanupStore(root); }
});

test('partial refund is classified distinctly, blocks fulfillment, and does not claim full refund', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_partial_refund', { paymentStatus: 'paid' });
    const processEvent = await processor();
    const event = chargeEvent('charge.refunded', order.id, 'evt_partial_refund');
    Object.assign(event.data.object, { refunded: false, amount: 10_000, amount_refunded: 100 });
    const result = await processEvent(event);
    assert.equal(result.outcome, 'converged');
    const updated = await getOrder(order.id);
    assert.equal(updated?.paymentStatus, 'partially_refunded');
    assert.equal(updated?.refundedAt ?? null, null);
    assert.equal(updated?.stripeRefundedAmountCents, 100);
    assert.equal(updated?.refundReason, 'stripe_partial_refund');
    assert.equal(updated?.fulfillmentStatus, 'failed_manual_review');
    const calls = { story: 0, images: 0, pdf: 0, upload: 0, print: 0 };
    await triggerFulfillment(order.id, noSpendDeps(calls), { readbackMaxAttempts: 1, readbackInitialDelayMs: 0 });
    assert.deepEqual(calls, { story: 0, images: 0, pdf: 0, upload: 0, print: 0 });
  } finally { cleanupStore(root); }
});

test('later full refund upgrades a partial refund to fully refunded', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_partial_then_full', { paymentStatus: 'paid' });
    const processEvent = await processor();
    const partial = chargeEvent('charge.refunded', order.id, 'evt_partial_first');
    Object.assign(partial.data.object, { refunded: false, amount: 10_000, amount_refunded: 100 });
    assert.equal((await processEvent(partial)).outcome, 'converged');
    const full = chargeEvent('charge.refunded', order.id, 'evt_full_later');
    Object.assign(full.data.object, { refunded: true, amount: 10_000, amount_refunded: 10_000 });
    assert.equal((await processEvent(full)).outcome, 'converged');
    const updated = await getOrder(order.id);
    assert.equal(updated?.paymentStatus, 'refunded');
    assert.ok(updated?.refundedAt);
    assert.equal(updated?.stripeRefundedAmountCents, 10_000);
    assert.equal(updated?.refundReason, 'stripe_charge_refunded');
  } finally { cleanupStore(root); }
});

test('inconsistent charge refund fields record recovery and do not mutate payment state', async () => {
  const { root, recovery } = setupStore();
  try {
    const order = await seed('ord_invalid_refund_shape', { paymentStatus: 'paid' });
    const processEvent = await processor();
    const event = chargeEvent('charge.refunded', order.id, 'evt_invalid_refund_shape');
    Object.assign(event.data.object, { refunded: false, amount: 10_000, amount_refunded: 10_000 });
    const result = await processEvent(event);
    assert.equal(result.outcome, 'unresolved');
    assert.equal((await getOrder(order.id))?.paymentStatus, 'paid');
    assert.equal(readdirSync(recovery).length, 1);
  } finally { cleanupStore(root); }
});

test('unresolved signed terminal event records payment-recovery evidence and is acknowledged', async () => {
  const { root, recovery } = setupStore();
  try {
    const processEvent = await processor();
    const result = await processEvent(chargeEvent('charge.refunded', null, 'evt_unresolved_1'));
    assert.deepEqual(result, { acknowledged: true, outcome: 'unresolved', orderId: null });
    assert.equal(readdirSync(recovery).length, 1);
  } finally { cleanupStore(root); }
});

test('conflicting metadata and PaymentIntent records recovery without mutating either order', async () => {
  const { root, recovery } = setupStore();
  try {
    const target = await seed('ord_pi_target', { paymentStatus: 'paid' });
    const other = await seed('ord_wrong_metadata', { paymentStatus: 'paid' });
    const processEvent = await processor();
    const event = chargeEvent('charge.refunded', other.id, 'evt_conflicting_identity');
    event.data.object.payment_intent = target.stripePaymentIntentId;
    const result = await processEvent(event);
    assert.deepEqual(result, { acknowledged: true, outcome: 'unresolved', orderId: null });
    assert.equal((await getOrder(target.id))?.paymentStatus, 'paid');
    assert.equal((await getOrder(other.id))?.paymentStatus, 'paid');
    assert.equal(readdirSync(recovery).length, 1);
  } finally { cleanupStore(root); }
});

test('legacy order binds its first PaymentIntent only from matching signed event metadata', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_legacy_pi', { paymentStatus: 'paid', stripePaymentIntentId: null });
    const processEvent = await processor();
    const result = await processEvent(chargeEvent('charge.refunded', order.id, 'evt_legacy_pi'));
    assert.equal(result.outcome, 'converged');
    const updated = await getOrder(order.id);
    assert.equal(updated?.stripePaymentIntentId, `pi_${order.id}`);
    assert.equal(updated?.paymentStatus, 'refunded');
  } finally { cleanupStore(root); }
});

test('dispute without order metadata resolves only through the exact stored PaymentIntent', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_dispute_by_pi', { paymentStatus: 'paid' });
    const processEvent = await processor();
    const event = chargeEvent('charge.dispute.created', null, 'evt_dispute_by_pi');
    event.data.object.payment_intent = order.stripePaymentIntentId;
    const result = await processEvent(event);
    assert.deepEqual(result, { acknowledged: true, outcome: 'converged', orderId: order.id });
    assert.equal((await getOrder(order.id))?.paymentStatus, 'refunded');
  } finally { cleanupStore(root); }
});

test('paid settlement persists the exact PaymentIntent used by later terminal events', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_bind_pi', { paymentStatus: 'pending', stripePaymentIntentId: null });
    const updated = await updateOrderPayment(order.id, 'paid', {
      stripeSessionId: order.stripeSessionId!,
      stripePaymentIntentId: 'pi_bound_exact',
      settledAmountCents: order.priceCents,
    });
    assert.equal(updated?.stripePaymentIntentId, 'pi_bound_exact');
    assert.equal((await getOrder(order.id))?.stripePaymentIntentId, 'pi_bound_exact');
  } finally { cleanupStore(root); }
});

test('F1 refund during story generation stops before image-provider spend', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_refund_during_story', { paymentStatus: 'paid' });
    const processEvent = await processor();
    let releaseStory!: () => void;
    let storyStarted!: () => void;
    const started = new Promise<void>((resolve) => { storyStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseStory = resolve; });
    let imageCalls = 0;
    const run = triggerFulfillment(order.id, {
      ...noSpendDeps({ story: 0, images: 0, pdf: 0, upload: 0, print: 0 }),
      generateStory: async () => { storyStarted(); await release; return STORY; },
      generateImages: async (prompts) => { imageCalls += 1; return prompts.map(() => 'https://example.test/page.jpg'); },
    });
    await started;
    await processEvent(chargeEvent('charge.refunded', order.id, 'evt_refund_story'));
    releaseStory();
    await run;
    assert.equal(imageCalls, 0);
  } finally { cleanupStore(root); }
});

test('F2 refund during image generation stops at the next boundary before PDF/upload/provider work', async () => {
  const { root } = setupStore();
  try {
    const order = await seed('ord_refund_during_images', { paymentStatus: 'paid' });
    const processEvent = await processor();
    let releaseImages!: () => void;
    let imagesStarted!: () => void;
    const started = new Promise<void>((resolve) => { imagesStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseImages = resolve; });
    let imageCalls = 0;
    let pdfCalls = 0;
    let uploadCalls = 0;
    const run = triggerFulfillment(order.id, {
      ...noSpendDeps({ story: 0, images: 0, pdf: 0, upload: 0, print: 0 }),
      generateStory: async () => STORY,
      generateImages: async (prompts) => {
        imageCalls += 1;
        imagesStarted();
        await release;
        return prompts.map(() => 'https://example.test/page.jpg');
      },
      buildPdf: async () => { pdfCalls += 1; return Buffer.from('%PDF'); },
      uploadArtifact: async () => { uploadCalls += 1; return 'https://example.test/proof.pdf'; },
    });
    await started;
    await processEvent(chargeEvent('charge.refunded', order.id, 'evt_refund_images'));
    releaseImages();
    await run;
    assert.equal(imageCalls, 1, 'the already in-flight image batch cannot be recalled');
    assert.equal(pdfCalls, 0);
    assert.equal(uploadCalls, 0);
  } finally { cleanupStore(root); }
});
