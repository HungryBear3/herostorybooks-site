import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  triggerFulfillment,
  approvePrintProof,
  backoffMs,
  MAX_RETRIES,
  type FulfillmentDeps,
} from '../src/lib/fulfillment.ts';
import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent } from '../src/lib/fulfillment-types.ts';

// ── Shared test fixtures ──────────────────────────────────────────────────────

const MOCK_STORY: StoryContent = {
  title: "Luna's Great Adventure",
  dedication: 'For Luna, with love.',
  characterDescription: 'A brave child named Luna.',
  pages: [
    { pageNum: 1, sceneTitle: 'The Beginning', story: 'Luna set off on her quest.', imagePrompt: 'Luna in a forest' },
    { pageNum: 2, sceneTitle: 'The Challenge', story: 'Luna faced a great challenge.', imagePrompt: 'Luna climbing' },
    { pageNum: 3, sceneTitle: 'The Victory', story: 'Luna triumphed and returned home.', imagePrompt: 'Luna cheering' },
  ],
};

const MOCK_PDF = Buffer.from('%PDF-1.4 mock');

const PASS_DEPS: FulfillmentDeps = {
  generateStory: async () => MOCK_STORY,
  generateImages: async (prompts) => prompts.map(() => null),
  buildPdf: async () => MOCK_PDF,
  buildPrintInteriorPdf: async () => Buffer.from('%PDF-1.4 mock-interior'),
  buildPrintCoverPdf: () => Buffer.from('%PDF-1.4 mock-cover'),
  calculateCoverDimensions: async () => ({ widthPt: 1200, heightPt: 650 }),
  uploadArtifact: async (orderId, _buffer, filename) => `https://cdn.example.com/${orderId}/${filename}`,
  submitPrint: async () => ({ jobId: 'lulu-job-001' }),
  sleep: async () => {},
  getBaseUrl: () => 'https://test.herostorybooks.com',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-fulfill-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanupTmpDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function makeOrder(
  overrides: Partial<OrderRecord> = {},
  dir: string,
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id: `ord_${Math.random().toString(36).slice(2, 10)}`, now: '2026-04-23T10:00:00Z' },
  );
  const order: OrderRecord = { ...base, ...overrides };
  await persistOrder(order);
  return order;
}

// ── backoffMs ─────────────────────────────────────────────────────────────────

test('backoffMs grows exponentially: 5s, 25s, 125s', () => {
  assert.equal(backoffMs(1), 5_000);
  assert.equal(backoffMs(2), 25_000);
  assert.equal(backoffMs(3), 125_000);
});

// ── Payment gate ──────────────────────────────────────────────────────────────

test('triggerFulfillment: unpaid order is skipped — no fulfillmentStatus set', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'pending' }, dir);
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    // fulfillmentStatus should remain unset (undefined/not_started)
    assert.ok(
      !after?.fulfillmentStatus || after.fulfillmentStatus === 'not_started',
      `Expected no fulfillment, got ${after?.fulfillmentStatus}`,
    );
  } finally {
    cleanupTmpDir(dir);
  }
});

test('triggerFulfillment: non-existent order is a no-op', async () => {
  const dir = makeTmpDir();
  try {
    await assert.doesNotReject(() => triggerFulfillment('ord_does_not_exist', PASS_DEPS));
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── Digital fulfillment ───────────────────────────────────────────────────────

test('paid digital order reaches complete with storyArtifactUrl set', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.status, 'preview_ready');
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('digital fulfillment final write preserves proof audit event and page artifacts together', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.equal(after?.pageArtifacts?.length, MOCK_STORY.pages.length);
    assert.equal(after?.auditEvents?.filter((e) => e.type === 'proof_generated').length, 1);
    assert.equal(after?.auditEvents?.[0]?.meta?.pageCount, MOCK_STORY.pages.length);
    assert.ok(after?.storyArtifactUrl?.includes('.pdf'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('digital fulfillment does not set proofApprovalToken', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.ok(!after?.proofApprovalToken, 'digital orders must not get a proof approval token');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── Print fulfillment — proof flow ────────────────────────────────────────────

test('paid print order reaches proof_ready and gets proofApprovalToken', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'classic' }, dir);
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.status, 'preview_ready');
    assert.ok(after?.proofApprovalToken, 'print order should have a proofApprovalToken');
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
    assert.ok(after?.printInteriorArtifactUrl?.includes('-interior.pdf'));
    assert.equal(after?.printInteriorMd5, '9438d3bf30c74a06e6be381d2632a06e');
    assert.equal(after?.printInteriorPageCount, 32);
    assert.equal(after?.printTitle, MOCK_STORY.title);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('print order cannot enter print_in_production without proof approval', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      proofApprovalToken: 'valid-token-abc',
    }, dir);

    // Attempting to approve with wrong token should fail
    const badResult = await approvePrintProof(order.id, 'wrong-token', PASS_DEPS);
    assert.equal(badResult.ok, false);
    assert.match(badResult.error ?? '', /Invalid approval token/i);

    // Status should still be proof_ready
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('valid token approves proof, creates cover artifact, and triggers print production', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      fulfillmentStatus: 'proof_ready',
      status: 'preview_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      printInteriorArtifactUrl: 'https://cdn.example.com/interior.pdf',
      printInteriorMd5: 'INTERIORMD5',
      printInteriorPageCount: 32,
      printTitle: MOCK_STORY.title,
      proofApprovalToken: 'valid-token-abc',
    }, dir);

    const result = await approvePrintProof(order.id, 'valid-token-abc', PASS_DEPS);
    assert.equal(result.ok, true, result.error);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.status, 'print_in_production');
    assert.ok(after?.printJobId, 'printJobId should be set after successful submission');
    assert.ok(after?.proofApprovedAt, 'proofApprovedAt should be set');
    assert.ok(after?.printCoverArtifactUrl?.includes('-cover.pdf'));
    assert.equal(after?.printCoverMd5, 'e274f158f3728fcf5ae211c63af31db8');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('approvePrintProof: rejects non-existent order', async () => {
  const dir = makeTmpDir();
  try {
    const result = await approvePrintProof('ord_ghost', 'any-token', PASS_DEPS);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /Order not found/i);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ── Failure + retry paths ─────────────────────────────────────────────────────

test('single failure followed by success resolves correctly', async () => {
  const dir = makeTmpDir();
  try {
    let callCount = 0;
    const flakyDeps: FulfillmentDeps = {
      ...PASS_DEPS,
      sleep: async () => {},
      generateStory: async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient network error');
        return MOCK_STORY;
      },
    };
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    await triggerFulfillment(order.id, flakyDeps);
    const after = await getOrder(order.id);
    // With only 1 failure, retry should succeed
    assert.equal(after?.fulfillmentStatus, 'complete');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('failures exhausting MAX_RETRIES move order to failed_manual_review', async () => {
  const dir = makeTmpDir();
  try {
    const alwaysFailDeps: FulfillmentDeps = {
      ...PASS_DEPS,
      sleep: async () => {},
      generateStory: async () => { throw new Error('persistent failure'); },
    };
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    await triggerFulfillment(order.id, alwaysFailDeps);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.equal(after?.fulfillmentAttempts, MAX_RETRIES);
    assert.match(after?.fulfillmentLastError ?? '', /persistent failure/);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('already-complete order is not re-processed', async () => {
  const dir = makeTmpDir();
  try {
    let callCount = 0;
    const countingDeps: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStory: async () => { callCount++; return MOCK_STORY; },
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'digital',
      fulfillmentStatus: 'complete',
    }, dir);
    await triggerFulfillment(order.id, countingDeps);
    assert.equal(callCount, 0, 'complete order should not be re-processed');
  } finally {
    cleanupTmpDir(dir);
  }
});
