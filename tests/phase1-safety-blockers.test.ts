import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  approvePrintProof,
  buildProofArtifactFromPageArtifacts,
  proofSourceFingerprint,
  type FulfillmentDeps,
} from '../src/lib/fulfillment.ts';
import { getPictureBookStoryLayout, UnknownLayoutVersionError } from '../src/lib/pdf-builder.ts';
import { ensureRecommendedTextLayout, NEW_PROOF_LAYOUT_VERSION } from '../src/lib/fulfillment-types.ts';
import { createOrderRecord, getOrder, persistOrder, type OrderRecord, type PageArtifact } from '../src/lib/orders.ts';
import { publishProofGuarded } from '../src/lib/page-review.ts';
import { retryOrderFulfillment } from '../src/lib/admin-actions.ts';
import { validateStoryPageSet } from '../src/lib/story-page-contract.ts';
import { fillerPage, padPageSet } from './support/full-page-set.ts';

const TOKEN = 'synthetic-proof-token';
const NOW = '2026-08-05T12:00:00.000Z';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-phase1-safety-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  for (const key of ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'RESEND_API_KEY', 'HSB_RESEND_API_KEY']) {
    delete process.env[key];
  }
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function completePages(overrides: Partial<PageArtifact> = {}): PageArtifact[] {
  return padPageSet([fillerPage(0, overrides)]).map((page) => ({
    ...page,
    textLayout: ensureRecommendedTextLayout(page.textLayout),
  }));
}

function printOrder(id: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  const pages = completePages();
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Synthetic Hero', bookFormat: 'classic', email: 'synthetic@example.invalid' },
      { id, now: NOW },
    ),
    paymentStatus: 'paid',
    status: 'preview_ready',
    fulfillmentStatus: 'proof_ready',
    reviewStatus: 'approved',
    layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    pageArtifacts: pages,
    storyArtifactUrl: `https://example.invalid/${id}/proof.pdf`,
    proofVersion: 'proof-v1',
    proofSourceFingerprint: null,
    proofReviewedAt: NOW,
    proofReviewedVersion: 'proof-v1',
    proofApprovalToken: TOKEN,
    printInteriorArtifactUrl: `https://example.invalid/${id}/interior.pdf`,
    printInteriorMd5: 'synthetic-interior-md5',
    printInteriorPageCount: 32,
    printInteriorProofVersion: 'proof-v1',
    printTitle: 'Synthetic Hero Story',
    ...overrides,
  };
  if (overrides.proofSourceFingerprint === undefined) {
    order.proofSourceFingerprint = proofSourceFingerprint(order);
  }
  return order;
}

function printDeps(onSubmit?: () => Promise<{ jobId: string }>): FulfillmentDeps {
  return {
    calculateCoverDimensions: async () => ({ widthPt: 1200, heightPt: 650 }),
    buildPrintCoverPdf: () => Buffer.from('%PDF synthetic cover'),
    uploadArtifact: async (id, _buffer, filename) => `https://example.invalid/${id}/${filename}`,
    submitPrint: onSubmit ?? (async () => ({ jobId: 'synthetic-print-job' })),
    sleep: async () => {},
  };
}

test('story contract validates the exact image selected by the renderer', () => {
  const pages = completePages({
    accepted: false,
    acceptedImageUrl: 'https://example.invalid/stale-accepted.png',
    currentImageUrl: null,
  });
  assert.equal(
    validateStoryPageSet(pages, 'classic', 'legacy_bottom_band')?.code,
    'missing_illustration',
  );
});

test('unknown non-null layout versions fail closed in validation and rendering', () => {
  const unknown = 'future_unrecognized_layout' as never;
  assert.equal(validateStoryPageSet(completePages(), 'classic', unknown)?.code, 'unknown_layout_version');
  assert.throws(
    () => getPictureBookStoryLayout('proof', undefined, unknown, 0),
    UnknownLayoutVersionError,
  );
});

test('proof identity changes when the renderer layout version changes', () => {
  const order = printOrder('ord_synthetic_fingerprint');
  const legacy = proofSourceFingerprint({ ...order, layoutVersion: 'legacy_bottom_band' });
  const modern = proofSourceFingerprint({ ...order, layoutVersion: 'modern_full_bleed' });
  assert.notEqual(legacy, modern);
});

test('proof builder refuses a partial book before renderer or upload', async () => {
  const dir = makeTmp();
  let renderCalls = 0;
  let uploadCalls = 0;
  try {
    const order = printOrder('ord_synthetic_partial_build', { pageArtifacts: completePages().slice(0, 23) });
    await persistOrder(order);
    const result = await buildProofArtifactFromPageArtifacts(order.id, {
      buildPdf: async () => { renderCalls += 1; return Buffer.from('%PDF'); },
      uploadArtifact: async () => { uploadCalls += 1; return 'https://example.invalid/partial.pdf'; },
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error, 'incomplete_page_set');
    assert.equal(renderCalls, 0);
    assert.equal(uploadCalls, 0);
  } finally {
    cleanup(dir);
  }
});

test('proof publication refuses a partial authoritative book', async () => {
  const dir = makeTmp();
  try {
    const order = printOrder('ord_synthetic_partial_publish', {
      reviewStatus: 'in_review',
      pageArtifacts: completePages().slice(0, 23),
      storyArtifactUrl: null,
      proofVersion: null,
      proofSourceFingerprint: null,
      proofReviewedAt: null,
      proofReviewedVersion: null,
    });
    await persistOrder(order);
    const result = await publishProofGuarded(order.id, {
      ok: true,
      proofUrl: 'https://example.invalid/new-proof.pdf',
      sourceFingerprint: proofSourceFingerprint(order) ?? 'synthetic-partial-fingerprint',
      proofVersion: 'proof-v2',
    });
    assert.equal(result.refreshed, false);
    assert.equal(result.error, 'incomplete_page_set');
    assert.equal((await getOrder(order.id))?.storyArtifactUrl, null);
  } finally {
    cleanup(dir);
  }
});

test('proof publication refuses when authoritative order becomes media-backed', async () => {
  const dir = makeTmp();
  try {
    const order = printOrder('ord_synthetic_media_publish', {
      reviewStatus: 'in_review',
      storyArtifactUrl: null,
      proofVersion: null,
      proofSourceFingerprint: null,
      proofReviewedAt: null,
      proofReviewedVersion: null,
      voiceBlobPath: 'orders/ord_synthetic_media_publish/story-source.webm',
    });
    await persistOrder(order);
    const before = await getOrder(order.id);
    const result = await publishProofGuarded(order.id, {
      ok: true,
      proofUrl: 'https://example.invalid/must-not-publish.pdf',
      sourceFingerprint: proofSourceFingerprint(order),
      proofVersion: 'proof-media-race',
      printInteriorArtifactUrl: 'https://example.invalid/must-not-publish-interior.pdf',
      printInteriorMd5: '0123456789abcdef0123456789abcdef',
      printInteriorPageCount: 24,
      printInteriorProofVersion: 'proof-media-race',
      printTitle: 'Must not publish',
    });
    assert.equal(result.refreshed, false);
    assert.equal(result.error, 'media_story_manual_review_required');
    assert.deepEqual(await getOrder(order.id), before);
  } finally {
    cleanup(dir);
  }
});

test('rebuilt print proof renders and persists a same-revision print interior', async () => {
  const dir = makeTmp();
  let renderedLayout: OrderRecord['layoutVersion'];
  let interiorRendered = false;
  try {
    const order = printOrder('ord_synthetic_layout_persist', {
      reviewStatus: 'in_review',
      layoutVersion: null,
      storyArtifactUrl: null,
      proofVersion: null,
      proofSourceFingerprint: null,
      proofReviewedAt: null,
      proofReviewedVersion: null,
      printInteriorArtifactUrl: null,
      printInteriorMd5: null,
      printInteriorProofVersion: null,
    });
    await persistOrder(order);
    const built = await buildProofArtifactFromPageArtifacts(order.id, {
      buildPdf: async (_story, rendererOrder) => {
        renderedLayout = rendererOrder.layoutVersion;
        return Buffer.from('%PDF synthetic');
      },
      buildPrintInteriorPdf: async () => {
        interiorRendered = true;
        return Buffer.from('%PDF synthetic interior');
      },
      uploadArtifact: async (_id, _buffer, filename) => `https://example.invalid/${filename}`,
    });
    assert.equal(built.ok, true);
    const published = await publishProofGuarded(order.id, built);
    assert.equal(published.refreshed, true, published.error);
    assert.equal(renderedLayout, NEW_PROOF_LAYOUT_VERSION);
    assert.equal(interiorRendered, true);
    const after = await getOrder(order.id);
    assert.equal(after?.layoutVersion, NEW_PROOF_LAYOUT_VERSION);
    assert.equal(after?.printInteriorProofVersion, after?.proofVersion);
    assert.match(after?.printInteriorArtifactUrl ?? '', /\/interiors\/pv_[a-z0-9_]+\.pdf$/);
  } finally {
    cleanup(dir);
  }
});

for (const [name, overrides, expected] of [
  ['unapproved whole-book review', { reviewStatus: 'in_review' }, 'whole_book_not_approved'],
  ['stale proof fingerprint', { proofSourceFingerprint: 'pf_stale' }, 'proof_stale'],
  ['missing current-proof acknowledgment', { proofReviewedAt: null }, 'proof_ack_missing'],
  ['wrong acknowledged proof revision', { proofReviewedVersion: 'proof-old' }, 'proof_ack_stale'],
  ['partial page set', { pageArtifacts: completePages().slice(0, 23) }, 'incomplete_page_set'],
  ['unaccepted page', { pageArtifacts: completePages({ accepted: false }) }, 'pages_not_accepted'],
  ['refunded order', { refundedAt: NOW }, 'order_refunded'],
  ['stale print interior', { printInteriorProofVersion: 'proof-old' }, 'print_interior_stale'],
] as const) {
  test(`print release refuses ${name} without provider submission`, async () => {
    const dir = makeTmp();
    let submitCalls = 0;
    try {
      const order = printOrder(`ord_synthetic_gate_${expected}`, overrides);
      await persistOrder(order);
      const result = await approvePrintProof(order.id, TOKEN, printDeps(async () => {
        submitCalls += 1;
        return { jobId: 'must-not-submit' };
      }));
      assert.equal(result.ok, false);
      assert.equal(result.error, expected);
      assert.equal(submitCalls, 0);
    } finally {
      cleanup(dir);
    }
  });
}

test('concurrent print release acquires one durable claim and submits at most once', async () => {
  const dir = makeTmp();
  let submitCalls = 0;
  let releaseSubmit!: () => void;
  let signalSubmitStarted!: () => void;
  const submitWait = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  const submitStarted = new Promise<void>((resolve) => { signalSubmitStarted = resolve; });
  try {
    const order = printOrder('ord_synthetic_single_flight');
    await persistOrder(order);
    const deps = printDeps(async () => {
      submitCalls += 1;
      signalSubmitStarted();
      await submitWait;
      return { jobId: 'synthetic-single-job' };
    });
    const first = approvePrintProof(order.id, TOKEN, deps);
    const second = approvePrintProof(order.id, TOKEN, deps);
    await Promise.race([
      submitStarted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('submit did not start')), 2_000)),
    ]);
    assert.equal(submitCalls, 1);
    releaseSubmit();
    const results = await Promise.all([first, second]);
    assert.equal(results.filter((result) => result.ok).length, 2);
    assert.equal(submitCalls, 1);
    assert.equal((await getOrder(order.id))?.printJobId, 'synthetic-single-job');
  } finally {
    cleanup(dir);
  }
});

test('ambiguous provider failure keeps durable claim and ordinary admin retry fails closed', async () => {
  const dir = makeTmp();
  let submitCalls = 0;
  try {
    const order = printOrder('ord_synthetic_ambiguous_submit');
    await persistOrder(order);
    const first = await approvePrintProof(order.id, TOKEN, printDeps(async () => {
      submitCalls += 1;
      throw new Error('synthetic response lost after provider acceptance');
    }));
    assert.equal(first.ok, false);
    assert.equal(first.error, 'print_submission_ambiguous');
    const after = await getOrder(order.id);
    assert.equal(after?.fulfillmentStatus, 'submitting_to_print');
    assert.ok(after?.printSubmissionAttemptedAt);
    assert.equal(after?.printSubmissionProofVersion, after?.proofVersion);

    const retry = await retryOrderFulfillment(order.id, printDeps(async () => {
      submitCalls += 1;
      return { jobId: 'must-not-submit-twice' };
    }));
    assert.equal(retry.ok, false);
    assert.equal(!retry.ok && retry.status, 409);
    assert.equal(submitCalls, 1);
  } finally {
    cleanup(dir);
  }
});
