import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  triggerFulfillment,
  approvePrintProof,
  backoffMs,
  MAX_RETRIES,
  type FulfillmentDeps,
} from '../src/lib/fulfillment.ts';
import { createOrderRecord, persistOrder, getOrder, updateFulfillmentState } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import type { StoryContent, StoryMeta } from '../src/lib/fulfillment-types.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';

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

const FALLBACK_STORY_META: StoryMeta = {
  source: 'template_after_openai_failure',
  model: 'template:Adventure',
  generatedAt: '2026-05-28T15:20:00.000Z',
  fallbackError: 'fetch failed',
};

const PASS_DEPS: FulfillmentDeps = {
  generateStory: async () => MOCK_STORY,
  // Returns plausible per-page URLs. Returning null here used to be the
  // historical placeholder (the PDF builder silently substituted blanks),
  // but after the 2026-05-15 partial-image-failure patch, any null URL
  // in image results is correctly classified as a generation failure and
  // halts at failed_manual_review — the very behavior change Rex's proof
  // rerun motivated. Orchestration assertions in this suite still hold;
  // only the fixture URLs changed.
  generateImages: async (prompts) => prompts.map((_p, i) => `https://cdn.example.com/p${i}.png`),
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
  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
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

test('source-level: fulfillment artifact uploads allow overwrite for retries/rebuilds', () => {
  const src = readFileSync(new URL('../src/lib/fulfillment.ts', import.meta.url), 'utf8');
  assert.match(src, /allowOverwrite:\s*true/);
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

test('updateFulfillmentState: refuses fulfillment/artifact advancement for unpaid orders', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'pending', bookFormat: 'digital' }, dir);

    await assert.rejects(
      () => updateFulfillmentState(order.id, {
        fulfillmentStatus: 'complete',
        status: 'preview_ready',
        storyArtifactUrl: 'https://cdn.example.com/unpaid.pdf',
      }),
      /Refusing fulfillment mutation.*paymentStatus=pending/,
    );

    const after = await getOrder(order.id);
    assert.equal(after?.paymentStatus, 'pending');
    assert.ok(!after?.storyArtifactUrl, 'unpaid order must not persist a story artifact');
    assert.notEqual(after?.fulfillmentStatus, 'complete');
  } finally { cleanupTmpDir(dir); }
});

test('updateFulfillmentState: paid webhook stamp is preserved with fulfillment writes', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'pending', bookFormat: 'digital' }, dir);

    await updateFulfillmentState(order.id, {
      paymentStatus: 'paid',
      stripeSessionId: 'cs_test_paid_preserved',
      fulfillmentStatus: 'complete',
      status: 'preview_ready',
      storyArtifactUrl: 'https://cdn.example.com/paid.pdf',
    });

    const after = await getOrder(order.id);
    assert.equal(after?.paymentStatus, 'paid');
    assert.equal(after?.stripeSessionId, 'cs_test_paid_preserved');
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.status, 'preview_ready');
  } finally { cleanupTmpDir(dir); }
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

test('custom voice/story print order with template_after_openai_failure fails closed before proof_ready', async () => {
  const dir = makeTmpDir();
  try {
    let buildPdfCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStoryWithMeta: async () => ({ story: MOCK_STORY, meta: FALLBACK_STORY_META }),
      buildPdf: async () => {
        buildPdfCalls += 1;
        return MOCK_PDF;
      },
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      theme: 'custom-voice-story',
      voiceFileName: 'family-story.txt',
      voiceBlobPath: 'orders/test/voice-family-story.txt',
      voiceConsentAt: '2026-05-28T15:00:00.000Z',
      voiceSource: 'uploaded',
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.equal(after?.status, 'order_received');
    assert.equal(after?.storyMeta?.source, 'template_after_openai_failure');
    assert.match(after?.fulfillmentLastError ?? '', /manual review required/);
    assert.ok(!after?.proofApprovalToken, 'fallback-blocked print order must not expose approval token');
    assert.ok(!after?.storyArtifactUrl, 'fallback-blocked print order must not persist proof PDF');
    assert.equal(buildPdfCalls, 0, 'fallback-blocked print order must stop before PDF build');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('custom story digital order with template_after_openai_failure fails closed before preview_ready', async () => {
  const dir = makeTmpDir();
  try {
    let buildPdfCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStoryWithMeta: async () => ({ story: MOCK_STORY, meta: FALLBACK_STORY_META }),
      buildPdf: async () => {
        buildPdfCalls += 1;
        return MOCK_PDF;
      },
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'digital',
      theme: 'custom-voice-story',
      lesson: 'Dad always comes home',
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.equal(after?.status, 'order_received');
    assert.equal(after?.storyMeta?.fallbackError, 'fetch failed');
    assert.ok(!after?.storyArtifactUrl, 'fallback-blocked digital order must not persist customer PDF');
    assert.equal(buildPdfCalls, 0, 'fallback-blocked digital order must stop before PDF build');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('template-only print order may still reach proof_ready after template_after_openai_failure', async () => {
  const dir = makeTmpDir();
  try {
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStoryWithMeta: async () => ({ story: MOCK_STORY, meta: FALLBACK_STORY_META }),
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      theme: 'dinosaur-discovery',
      lesson: 'courage',
      occasion: 'birthday',
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.status, 'preview_ready');
    assert.equal(after?.storyMeta?.source, 'template_after_openai_failure');
    assert.ok(after?.proofApprovalToken);
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('custom print order with model story and complete art-direction passes proof release gate', async () => {
  const dir = makeTmpDir();
  try {
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStoryWithMeta: async () => ({
        story: MOCK_STORY,
        meta: {
          source: 'openai_page_prose',
          model: 'gpt-4o-mini',
          generatedAt: '2026-05-28T20:00:00.000Z',
          fallbackError: null,
        },
      }),
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      theme: 'custom-voice-story',
      lesson: 'Dad always comes home',
      artDirectionPacket: lukasDinoArtDirectionFixture,
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.status, 'preview_ready');
    assert.ok(after?.proofApprovalToken);
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('custom print order with model story but missing art-direction blocks proof_ready', async () => {
  const dir = makeTmpDir();
  try {
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStoryWithMeta: async () => ({
        story: MOCK_STORY,
        meta: {
          source: 'openai_page_prose',
          model: 'gpt-4o-mini',
          generatedAt: '2026-05-28T20:00:00.000Z',
          fallbackError: null,
        },
      }),
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      theme: 'custom-voice-story',
      lesson: 'Dad always comes home',
      artDirectionPacket: null,
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.equal(after?.status, 'order_received');
    assert.ok(!after?.proofApprovalToken, 'gate-blocked order must not expose proof token');
    assert.ok(!after?.storyArtifactUrl, 'gate-blocked order must not expose proof PDF');
    assert.match(after?.fulfillmentLastError ?? '', /art_direction_packet_missing/);
    assert.ok(after?.auditEvents?.some((event) => event.type === 'proof_release_blocked'));
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

// ── 2026-05-08 retest regressions ────────────────────────────────────────────
//
// Required behavior after the retest failure:
//   1. Webhook response does not await long fulfillment.
//   2. paymentStatus=pending cannot produce complete fulfillment.
//   3. paid + stripeSessionId persisted → fulfillment kicks off.
//   4. No Lulu/print-job for digital, ever.
//
// (1) is pinned by source-level assertions in
//     tests/stripe-webhook-refund-replay.test.ts.
// (2)–(4) below.

test('payment pending cannot produce complete fulfillment (readback gate)', async () => {
  const dir = makeTmpDir();
  try {
    let storyCalls = 0;
    let imageCalls = 0;
    let pdfCalls = 0;
    let submitPrintCalls = 0;
    const counting: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStory: async () => { storyCalls++; return MOCK_STORY; },
      // Plausible URLs — see PASS_DEPS comment re: 2026-05-15 partial-image-failure patch.
      generateImages: async (prompts) => { imageCalls++; return prompts.map((_p, i) => `https://cdn.example.com/p${i}.png`); },
      buildPdf: async () => { pdfCalls++; return MOCK_PDF; },
      submitPrint: async () => { submitPrintCalls++; return { jobId: 'never' }; },
      sleep: async () => {}, // make readback retries instant in tests
    };
    // Persisted state shows pending — this is the 2026-05-08 retest shape.
    await makeOrder({ paymentStatus: 'pending', bookFormat: 'digital' }, dir);
    const id = (await getOrder('ord_does_not_matter_we_use_real_id'))?.id; // no-op probe

    const real = await makeOrder({ paymentStatus: 'pending', bookFormat: 'digital' }, dir);
    await triggerFulfillment(real.id, counting, { readbackMaxAttempts: 3, readbackInitialDelayMs: 0 });

    // Fulfillment must NOT have run.
    assert.equal(storyCalls, 0, 'story must not run on pending payment');
    assert.equal(imageCalls, 0, 'images must not run on pending payment');
    assert.equal(pdfCalls, 0, 'PDF must not build on pending payment');
    assert.equal(submitPrintCalls, 0, 'Lulu must never be called on pending payment');

    const after = await getOrder(real.id);
    assert.equal(after?.paymentStatus, 'pending', 'paymentStatus must remain pending');
    assert.ok(
      !after?.fulfillmentStatus || after.fulfillmentStatus === 'not_started',
      `fulfillmentStatus must NOT advance from pending payment (got ${after?.fulfillmentStatus})`,
    );
    assert.ok(!after?.storyArtifactUrl, 'no PDF should be uploaded for pending payment');
    void id;
  } finally { cleanupTmpDir(dir); }
});

test('paid update + queued kickoff: confirmed-paid persistence drives fulfillment to complete', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder(
      { paymentStatus: 'paid', stripeSessionId: 'cs_test_paid_kickoff', bookFormat: 'digital' },
      dir,
    );
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.paymentStatus, 'paid', 'paymentStatus must remain paid through fulfillment');
    assert.equal(after?.stripeSessionId, 'cs_test_paid_kickoff', 'stripeSessionId must persist through fulfillment');
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
  } finally { cleanupTmpDir(dir); }
});

test('digital fulfillment never calls submitPrint — Lulu must not be triggered for digital', async () => {
  const dir = makeTmpDir();
  try {
    let submitPrintCalls = 0;
    const luluTrap: FulfillmentDeps = {
      ...PASS_DEPS,
      submitPrint: async () => {
        submitPrintCalls++;
        return { jobId: 'should-not-happen' };
      },
    };
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    await triggerFulfillment(order.id, luluTrap);
    assert.equal(submitPrintCalls, 0, 'submitPrint must NOT be called for digital orders');
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.ok(!after?.printJobId, 'digital order must not carry a print job id');
  } finally { cleanupTmpDir(dir); }
});

test('digital fulfillment: duplicate triggerFulfillment is idempotent (no double-generation, no Lulu call)', async () => {
  const dir = makeTmpDir();
  try {
    let storyCalls = 0;
    let imageCalls = 0;
    let pdfCalls = 0;
    let submitPrintCalls = 0;
    const counting: FulfillmentDeps = {
      ...PASS_DEPS,
      generateStory: async () => { storyCalls++; return MOCK_STORY; },
      // Plausible URLs — see PASS_DEPS comment re: 2026-05-15 partial-image-failure patch.
      generateImages: async (prompts) => { imageCalls++; return prompts.map((_p, i) => `https://cdn.example.com/p${i}.png`); },
      buildPdf: async () => { pdfCalls++; return MOCK_PDF; },
      submitPrint: async () => { submitPrintCalls++; return { jobId: 'never' }; },
    };
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);

    // First call — should kick off and complete.
    await triggerFulfillment(order.id, counting);
    assert.equal(storyCalls, 1);
    assert.equal(imageCalls, 1);
    assert.equal(pdfCalls, 1);

    // Replay — fulfillmentStatus is now 'complete'; trigger must skip.
    await triggerFulfillment(order.id, counting);
    assert.equal(storyCalls, 1, 'story generation must not run twice');
    assert.equal(imageCalls, 1, 'image generation must not run twice');
    assert.equal(pdfCalls, 1, 'PDF build must not run twice');
    assert.equal(submitPrintCalls, 0, 'Lulu must never be called for digital');
  } finally { cleanupTmpDir(dir); }
});

test('source-level: triggerFulfillment uses readback-until-paid gate + structured TriggerResult', () => {
  const src = readFileSync(new URL('../src/lib/fulfillment.ts', import.meta.url), 'utf8');
  // The fail-closed gate must exist.
  assert.match(src, /readbackUntilPaid/);
  assert.match(src, /paymentStatus !== 'paid'/);
  // The previous shortcut must NOT exist (it bypassed the gate).
  assert.doesNotMatch(src, /preloadedOrder/);
  // The structured TriggerResult union must exist so the kickoff helper
  // can distinguish "refused once, may retry" from "really done".
  assert.match(src, /export type TriggerResult/);
  assert.match(src, /'started'/);
  assert.match(src, /'not_paid_yet'/);
  assert.match(src, /'skipped_already_complete'/);
  assert.match(src, /'skipped_already_running'/);
  // Triggers no longer return void.
  assert.match(src, /Promise<TriggerResult>/);
});

test('triggerFulfillment returns not_paid_yet on a pending order (caller-controlled retry)', async () => {
  const dir = makeTmpDir();
  try {
    const real = await makeOrder({ paymentStatus: 'pending', bookFormat: 'digital' }, dir);
    const result = await triggerFulfillment(real.id, { ...PASS_DEPS, sleep: async () => {} }, {
      readbackMaxAttempts: 2,
      readbackInitialDelayMs: 0,
    });
    assert.equal(result.status, 'not_paid_yet');
    assert.ok(
      typeof (result as { attempts: number }).attempts === 'number'
        && (result as { attempts: number }).attempts >= 1,
      'not_paid_yet must include readback attempts count',
    );
  } finally { cleanupTmpDir(dir); }
});

test('triggerFulfillment returns started on a paid order', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    const result = await triggerFulfillment(order.id, PASS_DEPS);
    assert.equal(result.status, 'started');
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'complete');
  } finally { cleanupTmpDir(dir); }
});

test('triggerFulfillment returns skipped_already_complete on replay against complete order', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder(
      { paymentStatus: 'paid', bookFormat: 'digital', fulfillmentStatus: 'complete' },
      dir,
    );
    const result = await triggerFulfillment(order.id, PASS_DEPS);
    assert.equal(result.status, 'skipped_already_complete');
  } finally { cleanupTmpDir(dir); }
});

test('triggerFulfillment returns skipped_already_running on a mid-flight order', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder(
      { paymentStatus: 'paid', bookFormat: 'digital', fulfillmentStatus: 'generating_story' },
      dir,
    );
    const result = await triggerFulfillment(order.id, PASS_DEPS);
    assert.equal(result.status, 'skipped_already_running');
  } finally { cleanupTmpDir(dir); }
});

test('triggerFulfillment returns not_found for a missing order', async () => {
  const dir = makeTmpDir();
  try {
    const result = await triggerFulfillment('ord_does_not_exist', { ...PASS_DEPS, sleep: async () => {} }, {
      readbackMaxAttempts: 1,
      readbackInitialDelayMs: 0,
    });
    assert.equal(result.status, 'not_found');
  } finally { cleanupTmpDir(dir); }
});
