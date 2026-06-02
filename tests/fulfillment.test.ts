import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  triggerFulfillment,
  approvePrintProof,
  submitPrintAfterOwnerGo,
  backoffMs,
  MAX_RETRIES,
  type FulfillmentDeps,
} from '../src/lib/fulfillment.ts';
import { createOrderRecord, persistOrder, getOrder, updateFulfillmentState } from '../src/lib/orders.ts';
import { updateKillSwitch } from '../src/lib/ops-kill-switches.ts';
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
  process.env.HSB_KILL_SWITCH_STATE_PATH = path.join(dir, 'kill-switches.json');
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  return dir;
}

function cleanupTmpDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_KILL_SWITCH_STATE_PATH;
}

async function makeOrder(
  overrides: Partial<OrderRecord> = {},
  dir: string,
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id: `ord_${Math.random().toString(36).slice(2, 10)}`, now: '2026-04-23T10:00:00Z' },
  );
  const routeSeed = overrides.storyArtifactUrl && !overrides.generationRouteDecision
    ? {
        generationRouteDecision: {
          route: 'manual_safe' as const,
          source: 'manual' as const,
          model: 'abby:manual-subscription',
          decidedAt: '2026-05-31T19:00:00.000Z',
          releasable: true,
          fallbackError: null,
          reason: null,
        },
        auditEvents: [
          {
            at: '2026-05-31T19:00:00.000Z',
            type: 'route_decision_recorded' as const,
            meta: {
              route: 'manual_safe',
              source: 'manual',
              model: 'abby:manual-subscription',
              releasable: true,
              fallbackError: null,
              reason: null,
            },
          },
        ],
      }
    : {};
  const order: OrderRecord = {
    ...base,
    theme: 'dinosaur-discovery',
    shippingAddress: {
      line1: '100 Test St',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      country: 'US',
    },
    // Generation Operating Policy §5 defaults: the post-QA auto-send
    // guard re-runs evaluateReleaseGuard, which requires non-template
    // storyMeta, per-page lineage, source photo, personalization.
    // Tests can override any of these to exercise the failure paths.
    photoBlobUrl: 'https://example.com/photos/luna.jpg',
    photoBlobPath: 'orders/test/photo.jpg',
    photoFileName: 'luna.jpg',
    storyMeta: {
      source: 'manual',
      model: 'abby:manual-subscription',
      generatedAt: '2026-05-31T19:00:00.000Z',
      fallbackError: null,
    },
    pageArtifacts: [
      {
        pageIndex: 0,
        storyText: 'Once upon a time…',
        basePrompt: 'p1',
        currentImageUrl: 'https://example.com/p1.png',
        generationProvider: 'manual',
        generationModel: 'abby:manual-subscription',
        generationConditioning: 'photo_edit',
        regenerateCount: 0,
        accepted: false,
        feedbackHistory: [],
        versionHistory: [],
      },
    ],
    ...routeSeed,
    ...overrides,
  };
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

test('G1 gate: releasable proof artifact writes require persisted route decision and route_decision_recorded audit', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);

    await assert.rejects(
      () => updateFulfillmentState(order.id, {
        fulfillmentStatus: 'complete',
        status: 'preview_ready',
        storyArtifactUrl: 'https://cdn.example.com/no-route.pdf',
      }),
      /route decision/i,
    );

    await assert.rejects(
      () => updateFulfillmentState(order.id, {
        fulfillmentStatus: 'complete',
        status: 'preview_ready',
        storyArtifactUrl: 'https://cdn.example.com/no-route-audit.pdf',
        generationRouteDecision: {
          route: 'api_disabled_template',
          source: 'template',
          model: 'template:Adventure',
          decidedAt: '2026-06-01T12:00:00.000Z',
          releasable: true,
        },
      } as Partial<OrderRecord>),
      /route_decision_recorded/i,
    );

    const updated = await updateFulfillmentState(order.id, {
      fulfillmentStatus: 'complete',
      status: 'preview_ready',
      storyArtifactUrl: 'https://cdn.example.com/recorded-route.pdf',
      generationRouteDecision: {
        route: 'api_disabled_template',
        source: 'template',
        model: 'template:Adventure',
        decidedAt: '2026-06-01T12:00:00.000Z',
        releasable: true,
      },
      auditEvents: [
        {
          at: '2026-06-01T12:00:00.000Z',
          type: 'route_decision_recorded',
          meta: { route: 'api_disabled_template', source: 'template', model: 'template:Adventure', releasable: true },
        },
      ],
    } as Partial<OrderRecord>);

    assert.equal(updated?.storyArtifactUrl, 'https://cdn.example.com/recorded-route.pdf');
    assert.equal((updated as OrderRecord & { generationRouteDecision?: { route?: string } })?.generationRouteDecision?.route, 'api_disabled_template');
  } finally { cleanupTmpDir(dir); }
});

test('G1 gate: fulfillment persists route decision before artifact upload can make proof releasable', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      uploadArtifact: async (orderId, _buffer, filename) => {
        const beforeUpload = await getOrder(orderId);
        assert.equal((beforeUpload as OrderRecord & { generationRouteDecision?: { route?: string } })?.generationRouteDecision?.route, 'model_story');
        assert.ok(beforeUpload?.auditEvents?.some((event) => event.type === 'route_decision_recorded'), 'route_decision_recorded audit must exist before artifact upload');
        return `https://cdn.example.com/${orderId}/${filename}`;
      },
    };

    await triggerFulfillment(order.id, deps);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.equal((after as OrderRecord & { generationRouteDecision?: { route?: string } })?.generationRouteDecision?.route, 'model_story');
    assert.ok(after?.auditEvents?.some((event) => event.type === 'route_decision_recorded'));
    assert.ok(after?.auditEvents?.some((event) => event.type === 'proof_generated'));
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
      generationRouteDecision: {
        route: 'api_disabled_template',
        source: 'template',
        model: 'template:Adventure',
        decidedAt: '2026-06-01T12:00:00.000Z',
        releasable: true,
      },
      auditEvents: [
        {
          at: '2026-06-01T12:00:00.000Z',
          type: 'route_decision_recorded',
          meta: { route: 'api_disabled_template', source: 'template', model: 'template:Adventure', releasable: true },
        },
      ],
    });

    const after = await getOrder(order.id);
    assert.equal(after?.paymentStatus, 'paid');
    assert.equal(after?.stripeSessionId, 'cs_test_paid_preserved');
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.status, 'preview_ready');
  } finally { cleanupTmpDir(dir); }
});

// ── Digital fulfillment ───────────────────────────────────────────────────────

test('paid digital order reaches awaiting_qa with storyArtifactUrl set', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital' }, dir);
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.equal(after?.status, 'preview_ready');
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('paid digital order without qaPassAt does not send digital delivery email', async () => {
  const dir = makeTmpDir();
  try {
    let emailCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      sendDigitalDeliveryEmail: async () => { emailCalls += 1; },
    };
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'digital', qaPassAt: null }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.equal(emailCalls, 0, 'digital delivery email must not send without QA pass');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('paid digital order with qaPassAt sends digital delivery email after artifact persistence', async () => {
  const dir = makeTmpDir();
  try {
    let emailCalls = 0;
    let emailedPdfUrl = '';
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      sendDigitalDeliveryEmail: async (_order, options) => {
        emailCalls += 1;
        emailedPdfUrl = options.pdfUrl;
      },
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'digital',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'qa-operator',
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.status, 'preview_ready');
    assert.equal(emailCalls, 1, 'digital delivery email should send after QA pass');
    assert.equal(emailedPdfUrl, after?.storyArtifactUrl);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('proof release hold blocks qa-passed digital auto-send before customer email', async () => {
  const dir = makeTmpDir();
  try {
    let emailCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      sendDigitalDeliveryEmail: async () => { emailCalls += 1; },
    };
    await updateKillSwitch({
      id: 'proof_release_hold',
      active: true,
      reason: 'pause customer emails during launch gate',
      updatedBy: 'test-operator',
      now: '2026-06-02T12:00:00.000Z',
    });
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'digital',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'qa-operator',
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(emailCalls, 0, 'proof_release_hold must stop digital auto-send before email transport');
    assert.equal(after?.fulfillmentStatus, 'delivery_email_failed');
    assert.match(after?.fulfillmentLastError ?? '', /KILL_SWITCH_ACTIVE:proof_release_hold/);
    assert.ok(after?.auditEvents?.some((e) => e.type === 'proof_release_failed' && e.reason === 'PROOF_RELEASE_HELD'));
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
    const proofEvent = after?.auditEvents?.find((e) => e.type === 'proof_generated');
    assert.equal(proofEvent?.meta?.pageCount, MOCK_STORY.pages.length);
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

test('source-level: automatic fulfillment does not send customer emails before QA release', () => {
  const src = readFileSync(new URL('../src/lib/fulfillment.ts', import.meta.url), 'utf8');
  assert.match(src, /hasQaPass\(order\)/);
  assert.match(src, /if \(!qaPassed\)/);
  assert.match(src, /awaiting_qa/);
  assert.match(src, /sendDigitalDeliveryEmail/);
  assert.match(src, /sendProofReadyEmail/);
  assert.match(src, /fulfillmentStatus:\s*qaPassed\s*\?\s*'complete'\s*:\s*'awaiting_qa'/);
  assert.match(src, /fulfillmentStatus:\s*qaPassed\s*\?\s*'proof_ready'\s*:\s*'awaiting_qa'/);
});

// ── Print fulfillment — proof flow ────────────────────────────────────────────

test('paid print order reaches awaiting_qa without proofApprovalToken', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'classic' }, dir);
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.equal(after?.status, 'preview_ready');
    assert.ok(!after?.proofApprovalToken, 'print order must not expose a proof token before QA release');
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
    assert.ok(after?.printInteriorArtifactUrl?.includes('-interior.pdf'));
    assert.equal(after?.printInteriorMd5, '9438d3bf30c74a06e6be381d2632a06e');
    assert.equal(after?.printInteriorPageCount, 32);
    assert.equal(after?.printTitle, MOCK_STORY.title);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('paid print order without qaPassAt does not send proof-ready email', async () => {
  const dir = makeTmpDir();
  try {
    let emailCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      sendProofReadyEmail: async () => { emailCalls += 1; },
    };
    const order = await makeOrder({ paymentStatus: 'paid', bookFormat: 'classic', qaPassAt: null }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.ok(!after?.proofApprovalToken);
    assert.equal(emailCalls, 0, 'proof-ready email must not send without QA pass');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('paid print order with qaPassAt reaches proof_ready and sends proof-ready email', async () => {
  const dir = makeTmpDir();
  try {
    let emailCalls = 0;
    let emailedReviewUrl = '';
    let emailedProofUrl = '';
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      sendProofReadyEmail: async (_order, options) => {
        emailCalls += 1;
        emailedReviewUrl = options.reviewUrl;
        emailedProofUrl = options.proofUrl;
      },
    };
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'qa-operator',
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
    assert.equal(after?.status, 'preview_ready');
    assert.ok(after?.proofApprovalToken, 'QA-passed print proof should expose review token');
    assert.equal(emailCalls, 1, 'proof-ready email should send after QA pass');
    assert.match(emailedReviewUrl, new RegExp(`/review/${order.id}\\?token=`));
    assert.equal(emailedProofUrl, after?.storyArtifactUrl);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('proof release hold blocks qa-passed print proof auto-send before customer email', async () => {
  const dir = makeTmpDir();
  try {
    let emailCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      sendProofReadyEmail: async () => { emailCalls += 1; },
    };
    await updateKillSwitch({
      id: 'proof_release_hold',
      active: true,
      reason: 'pause customer emails during launch gate',
      updatedBy: 'test-operator',
      now: '2026-06-02T12:00:00.000Z',
    });
    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'classic',
      qaPassAt: '2026-05-31T20:00:00.000Z',
      qaPassBy: 'qa-operator',
    }, dir);

    await triggerFulfillment(order.id, deps);

    const after = await getOrder(order.id);
    assert.equal(emailCalls, 0, 'proof_release_hold must stop proof-ready auto-send before email transport');
    assert.equal(after?.fulfillmentStatus, 'delivery_email_failed');
    assert.match(after?.fulfillmentLastError ?? '', /KILL_SWITCH_ACTIVE:proof_release_hold/);
    assert.ok(after?.auditEvents?.some((e) => e.type === 'proof_release_failed' && e.reason === 'PROOF_RELEASE_HELD'));
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

test('template-only print order may still generate artifacts but waits for QA after template_after_openai_failure', async () => {
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
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.equal(after?.status, 'preview_ready');
    assert.equal(after?.storyMeta?.source, 'template_after_openai_failure');
    assert.ok(!after?.proofApprovalToken);
    assert.ok(after?.storyArtifactUrl?.startsWith('https://'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('custom print order with model story and complete art-direction generates artifacts and waits for QA', async () => {
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
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
    assert.equal(after?.status, 'preview_ready');
    assert.ok(!after?.proofApprovalToken);
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
      generationRouteDecision: {
        route: 'api_disabled_template',
        source: 'template',
        model: 'template:Adventure',
        decidedAt: '2026-06-01T12:00:00.000Z',
        releasable: true,
      },
      auditEvents: [
        {
          at: '2026-06-01T12:00:00.000Z',
          type: 'route_decision_recorded',
          meta: { route: 'api_disabled_template', source: 'template', model: 'template:Adventure', releasable: true },
        },
      ],
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

test('Rex G3: valid customer token approves proof but does NOT submit to print (owner go required)', async () => {
  // Rex G3 requirement: customer approval alone must not invoke
  // submitPrint. After approvePrintProof, the order is at proof_approved
  // with timestamps recorded; no print job is created.
  const dir = makeTmpDir();
  try {
    let submitPrintCalls = 0;
    const depsWithCountedPrint: FulfillmentDeps = {
      ...PASS_DEPS,
      submitPrint: async () => {
        submitPrintCalls += 1;
        return { jobId: 'lulu-should-not-fire' };
      },
    };

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
      theme: 'dinosaur-discovery',
      photoBlobUrl: 'https://example.com/photos/luna.jpg',
      photoBlobPath: 'orders/test/photo.jpg',
      photoFileName: 'luna.jpg',
      storyMeta: {
        source: 'manual',
        model: 'abby:manual-subscription',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: null,
      },
      pageArtifacts: [
        {
          pageIndex: 0,
          storyText: 'Once upon a time…',
          basePrompt: 'p1',
          currentImageUrl: 'https://example.com/p1.png',
          generationProvider: 'manual',
          generationModel: 'abby:manual-subscription',
          generationConditioning: 'photo_edit',
          regenerateCount: 0,
          accepted: false,
          feedbackHistory: [],
          versionHistory: [],
        },
      ],
      qaPassAt: '2026-05-31T20:30:00.000Z',
      qaPassBy: 'ops',
      generationRouteDecision: {
        route: 'api_disabled_template',
        source: 'template',
        model: 'template:Adventure',
        decidedAt: '2026-06-01T12:00:00.000Z',
        releasable: true,
      },
      auditEvents: [
        {
          at: '2026-06-01T12:00:00.000Z',
          type: 'route_decision_recorded',
          meta: { route: 'api_disabled_template', source: 'template', model: 'template:Adventure', releasable: true },
        },
      ],
    }, dir);

    const result = await approvePrintProof(order.id, 'valid-token-abc', depsWithCountedPrint);
    assert.equal(result.ok, true, result.error);

    const after = await getOrder(order.id);
    // Customer approval recorded:
    assert.equal(after?.fulfillmentStatus, 'proof_approved');
    assert.ok(after?.proofApprovedAt, 'proofApprovedAt should be set after customer approval');
    assert.ok(after?.printApprovedAt, 'printApprovedAt should be set after customer approval');
    // But owner-go NOT recorded and print NOT submitted:
    assert.equal(after?.ownerPrintGoAt, undefined, 'ownerPrintGoAt must NOT be set by customer approval');
    assert.equal(after?.printJobId, undefined, 'printJobId must NOT be set before owner go');
    assert.equal(after?.status, 'preview_ready', 'order.status must not advance to print_in_production');
    assert.equal(submitPrintCalls, 0, 'submitPrint must not be invoked by customer approval alone');
    assert.equal(after?.printCoverArtifactUrl ?? null, null, 'print cover must not be generated before owner go');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('Rex G3: owner go AFTER customer approval submits to print (two-phase happy path)', async () => {
  // Customer approval → owner records explicit go → print submission
  // fires through the standard runPrintProduction path.
  const dir = makeTmpDir();
  try {
    let submitPrintCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      submitPrint: async () => {
        submitPrintCalls += 1;
        return { jobId: 'lulu-job-go-001' };
      },
    };

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
      proofApprovalToken: 'valid-token-go',
      theme: 'dinosaur-discovery',
      photoBlobUrl: 'https://example.com/photos/luna.jpg',
      photoBlobPath: 'orders/test/photo.jpg',
      photoFileName: 'luna.jpg',
      storyMeta: {
        source: 'manual',
        model: 'abby:manual-subscription',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: null,
      },
      pageArtifacts: [
        {
          pageIndex: 0,
          storyText: 'Once upon a time…',
          basePrompt: 'p1',
          currentImageUrl: 'https://example.com/p1.png',
          generationProvider: 'manual',
          generationModel: 'abby:manual-subscription',
          generationConditioning: 'photo_edit',
          regenerateCount: 0,
          accepted: false,
          feedbackHistory: [],
          versionHistory: [],
        },
      ],
      qaPassAt: '2026-05-31T20:30:00.000Z',
      qaPassBy: 'ops',
    }, dir);

    // Phase 1: customer approves → no print.
    const customerApprove = await approvePrintProof(order.id, 'valid-token-go', deps);
    assert.equal(customerApprove.ok, true);
    assert.equal(submitPrintCalls, 0, 'no submitPrint after customer approval');

    // Phase 2: operator records owner go → print fires.
    const ownerGo = await submitPrintAfterOwnerGo(order.id, 'ops@example.com', deps);
    assert.equal(ownerGo.ok, true, ownerGo.error);
    assert.equal(submitPrintCalls, 1, 'submitPrint must fire exactly once after owner go');

    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'complete');
    assert.equal(after?.status, 'print_in_production');
    assert.ok(after?.ownerPrintGoAt, 'ownerPrintGoAt must be persisted');
    assert.equal(after?.ownerPrintGoBy, 'ops@example.com');
    assert.ok(after?.printJobId, 'printJobId set after submission');
    assert.ok(after?.printCoverArtifactUrl?.includes('-cover.pdf'));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('Rex G3: submitPrintAfterOwnerGo refuses without prior customer approval', async () => {
  const dir = makeTmpDir();
  try {
    let submitPrintCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      submitPrint: async () => { submitPrintCalls += 1; return { jobId: 'should-not-run' }; },
    };

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
      proofApprovalToken: 'tok-no-approval',
      qaPassAt: '2026-05-31T20:30:00.000Z',
      qaPassBy: 'ops',
    }, dir);

    // Operator tries to record owner-go without the customer having
    // approved. Must refuse.
    const r = await submitPrintAfterOwnerGo(order.id, 'ops@example.com', deps);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /customer approval|proof_approved|state/i);
    assert.equal(submitPrintCalls, 0);

    const after = await getOrder(order.id);
    assert.equal(after?.ownerPrintGoAt, undefined);
    assert.equal(after?.printJobId, undefined);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('Rex G3: print path uses mocked submitPrint only — no unmocked HTTP escapes', async (t) => {
  // Belt-and-suspenders: assert no fetch call escapes the mocked
  // submitPrint dep during the two-phase happy path. If any HTTP request
  // tries to leave the test (toward Lulu/RPI/anywhere), the stub counts
  // it and the test fails.
  const originalFetch = globalThis.fetch;
  let unmockedFetchCalls = 0;
  globalThis.fetch = (async () => {
    unmockedFetchCalls += 1;
    return new Response('blocked', { status: 599 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const dir = makeTmpDir();
  try {
    let submitPrintCalls = 0;
    const deps: FulfillmentDeps = {
      ...PASS_DEPS,
      submitPrint: async () => { submitPrintCalls += 1; return { jobId: 'lulu-mocked-only' }; },
    };

    const order = await makeOrder({
      paymentStatus: 'paid',
      bookFormat: 'premium',
      fulfillmentStatus: 'proof_ready',
      status: 'preview_ready',
      storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
      printInteriorArtifactUrl: 'https://cdn.example.com/interior.pdf',
      printInteriorMd5: 'INTERIORMD5',
      printInteriorPageCount: 32,
      printTitle: MOCK_STORY.title,
      proofApprovalToken: 'tok-no-net',
      theme: 'dinosaur-discovery',
      photoBlobUrl: 'https://example.com/photos/luna.jpg',
      photoBlobPath: 'orders/test/photo.jpg',
      photoFileName: 'luna.jpg',
      storyMeta: {
        source: 'manual',
        model: 'abby:manual-subscription',
        generatedAt: '2026-05-31T20:00:00.000Z',
        fallbackError: null,
      },
      pageArtifacts: [
        {
          pageIndex: 0,
          storyText: 'Once upon a time…',
          basePrompt: 'p1',
          currentImageUrl: 'https://example.com/p1.png',
          generationProvider: 'manual',
          generationModel: 'abby:manual-subscription',
          generationConditioning: 'photo_edit',
          regenerateCount: 0,
          accepted: false,
          feedbackHistory: [],
          versionHistory: [],
        },
      ],
      qaPassAt: '2026-05-31T20:30:00.000Z',
      qaPassBy: 'ops',
    }, dir);

    await approvePrintProof(order.id, 'tok-no-net', deps);
    await submitPrintAfterOwnerGo(order.id, 'ops@example.com', deps);

    assert.equal(submitPrintCalls, 1, 'mocked submitPrint must be called exactly once');
    assert.equal(unmockedFetchCalls, 0, 'no unmocked HTTP transport may escape the test');
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
    // With only 1 failure, retry should succeed and hold for QA.
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
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

test('paid update + queued kickoff: confirmed-paid persistence drives fulfillment to awaiting_qa', async () => {
  const dir = makeTmpDir();
  try {
    const order = await makeOrder(
      { paymentStatus: 'paid', stripeSessionId: 'cs_test_paid_kickoff', bookFormat: 'digital' },
      dir,
    );
    await triggerFulfillment(order.id, PASS_DEPS);
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
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
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
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

    // First call — should kick off and generate artifacts awaiting QA.
    await triggerFulfillment(order.id, counting);
    assert.equal(storyCalls, 1);
    assert.equal(imageCalls, 1);
    assert.equal(pdfCalls, 1);

    // Replay — fulfillmentStatus is now 'awaiting_qa'; trigger must skip.
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
    assert.equal(after?.fulfillmentStatus, 'awaiting_qa');
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
