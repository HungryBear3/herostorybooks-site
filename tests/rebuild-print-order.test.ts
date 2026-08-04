/**
 * Slice 3 of the print redesign — rebuild path for existing print
 * orders. Verifies the safety contract, the dry-run plan, and the
 * end-to-end rebuild's effect on persisted state. PDF builders and
 * image generation are dependency-injected so this test does not hit
 * the network or run pdfkit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  getOrder,
  persistOrder,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';
import {
  checkRebuildSafety,
  planRebuildPrintOrder,
  rebuildPrintOrder,
  type RebuildDeps,
} from '../src/lib/rebuild-print-order.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-rebuild-print-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function legacyPage(i: number): PageArtifact {
  return {
    pageIndex: i,
    storyText: `legacy page ${i + 1}`,
    basePrompt: `legacy prompt ${i}`,
    currentImageUrl: `https://example.com/legacy-${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
  };
}

async function seed(
  overrides: Partial<OrderRecord> = {},
  id = 'ord_rebuild_test',
): Promise<OrderRecord> {
  const base = createOrderRecord(
    {
      childName: 'Luna',
      bookFormat: overrides.bookFormat ?? 'classic',
      email: 'luna@example.com',
      theme: 'space-voyager',
    },
    { id, now: '2026-04-29T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/legacy-proof.pdf',
    printInteriorArtifactUrl: 'https://example.com/legacy-interior.pdf',
    printInteriorMd5: 'legacy-md5',
    printInteriorPageCount: 32,
    printTitle: 'Legacy Title',
    printCoverArtifactUrl: 'https://example.com/legacy-cover.pdf',
    printCoverMd5: 'legacy-cover-md5',
    proofApprovalToken: 'legacy-token',
    proofApprovedAt: null,
    proofReviewedAt: null,
    pageArtifacts: Array.from({ length: 6 }, (_, i) => legacyPage(i)),
    reviewStatus: 'in_review',
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

function fakeDeps(): RebuildDeps {
  return {
    generateStoryWithMeta: async (order) => ({
      story: {
        title: 'Rebuilt Title',
        dedication: `For ${order.childName}.`,
        characterDescription: 'A child.',
        pages: Array.from({ length: order.bookFormat === 'classic' ? 24 : 32 }, (_, i) => ({
          pageNum: i + 1,
          sceneTitle: `Scene ${i + 1}`,
          story: `Rebuilt story page ${i + 1}.`,
          imagePrompt: `prompt ${i}`,
        })),
      },
      meta: {
        source: 'template',
        model: 'template:Adventure',
        generatedAt: '2026-05-01T10:00:00.000Z',
      },
    }),
    generateImageResults: async (prompts) =>
      prompts.map((p) => ({
        imageUrl: `https://rebuilt.example/${p.length}.png`,
        provider: 'fal',
        model: 'fal-flux',
        promptUsed: p,
        latencyMs: 0,
        error: null,
      })),
    buildPdf: async () => Buffer.from('%PDF-1.4 mock-proof'),
    buildPrintInteriorPdf: async () => Buffer.from('%PDF-1.4 mock-interior'),
    uploadArtifact: async (orderId, _buffer, filename) =>
      `https://rebuilt.example/${orderId}/${filename}`,
    now: () => new Date('2026-05-01T10:00:00Z'),
  };
}

// ── Safety contract ──────────────────────────────────────────────────────────

test('checkRebuildSafety: paid + classic + proof_ready → null (allowed)', () => {
  assert.equal(checkRebuildSafety(({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    status: 'order_received',
    fulfillmentStatus: 'proof_ready',
  } as unknown) as OrderRecord), null);
});

test('checkRebuildSafety: digital order is refused with not_print_format', () => {
  const r = checkRebuildSafety(({ bookFormat: 'digital', paymentStatus: 'paid' } as unknown) as OrderRecord);
  assert.deepEqual(r?.reason, 'not_print_format');
});

test('checkRebuildSafety: unpaid order refused with not_paid', () => {
  const r = checkRebuildSafety(({ bookFormat: 'classic', paymentStatus: 'pending' } as unknown) as OrderRecord);
  assert.deepEqual(r?.reason, 'not_paid');
});

test('checkRebuildSafety: refunded order refused with order_refunded', () => {
  const r = checkRebuildSafety(({
    bookFormat: 'classic',
    paymentStatus: 'refunded',
    refundedAt: '2026-04-30T00:00:00Z',
  } as unknown) as OrderRecord);
  assert.deepEqual(r?.reason, 'order_refunded');
});

test('checkRebuildSafety: shipped order refused', () => {
  const r = checkRebuildSafety(({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    status: 'shipped',
  } as unknown) as OrderRecord);
  assert.deepEqual(r?.reason, 'already_shipped');
});

test('checkRebuildSafety: print_in_production refused', () => {
  const r = checkRebuildSafety(({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    status: 'print_in_production',
  } as unknown) as OrderRecord);
  assert.deepEqual(r?.reason, 'already_in_production');
});

test('checkRebuildSafety: order with printJobId refused with already_submitted_to_lulu', () => {
  const r = checkRebuildSafety(({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    status: 'order_received',
    printJobId: 'lulu-1234',
  } as unknown) as OrderRecord);
  assert.deepEqual(r?.reason, 'already_submitted_to_lulu');
});

test('checkRebuildSafety: fulfillmentStatus=submitting_to_print refused', () => {
  const r = checkRebuildSafety(({
    bookFormat: 'classic',
    paymentStatus: 'paid',
    status: 'order_received',
    fulfillmentStatus: 'submitting_to_print',
  } as unknown) as OrderRecord);
  assert.deepEqual(r?.reason, 'already_submitted_to_lulu');
});

// ── Plan / dry-run ───────────────────────────────────────────────────────────

test('planRebuildPrintOrder: classic plan targets 24 story pages and 32 interior pages', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'classic' });
    const order = (await getOrder('ord_rebuild_test'))!;
    const plan = planRebuildPrintOrder(order);
    assert.equal(plan.targetStoryPageCount, 24);
    assert.equal(plan.targetInteriorPageCount, 32);
    assert.equal(plan.currentPageArtifactCount, 6);
    assert.equal(plan.willClearPrintCover, true);
    assert.equal(plan.willGenerateNewProofApprovalToken, true);
    assert.equal(plan.willResetReviewState, true);
  } finally { cleanup(dir); }
});

test('planRebuildPrintOrder: premium plan targets 32 story pages and 38 interior pages', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'premium' });
    const order = (await getOrder('ord_rebuild_test'))!;
    const plan = planRebuildPrintOrder(order);
    assert.equal(plan.targetStoryPageCount, 32);
    assert.equal(plan.targetInteriorPageCount, 38);
  } finally { cleanup(dir); }
});

test('rebuildPrintOrder: dry-run does NOT mutate persisted state', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'classic' });
    const before = (await getOrder('ord_rebuild_test'))!;
    const result = await rebuildPrintOrder('ord_rebuild_test', { dryRun: true }, fakeDeps());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.dryRun, true);
    assert.equal(result.result, undefined);
    const after = (await getOrder('ord_rebuild_test'))!;
    // Every persisted field that the rebuild would touch must be untouched.
    assert.equal(after.printInteriorArtifactUrl, before.printInteriorArtifactUrl);
    assert.equal(after.printInteriorMd5, before.printInteriorMd5);
    assert.equal(after.printInteriorPageCount, before.printInteriorPageCount);
    assert.equal(after.printTitle, before.printTitle);
    assert.equal(after.printCoverArtifactUrl, before.printCoverArtifactUrl);
    assert.equal(after.proofApprovalToken, before.proofApprovalToken);
    assert.equal(after.pageArtifacts?.length, 6);
  } finally { cleanup(dir); }
});

test('rebuildPrintOrder: refuses with structured reason for unsafe states', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'classic', status: 'shipped' });
    const result = await rebuildPrintOrder('ord_rebuild_test', { dryRun: false }, fakeDeps());
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'already_shipped');
  } finally { cleanup(dir); }
});

test('rebuildPrintOrder: 404 reason when order is missing', async () => {
  const dir = makeTmp();
  try {
    const result = await rebuildPrintOrder('ord_does_not_exist', { dryRun: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'order_not_found');
  } finally { cleanup(dir); }
});

// ── Real rebuild ────────────────────────────────────────────────────────────

test('rebuildPrintOrder: classic full rebuild updates artifacts + resets review state + clears cover', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'classic' });
    const result = await rebuildPrintOrder('ord_rebuild_test', { dryRun: false }, fakeDeps());
    assert.equal(result.ok, true);
    if (!result.ok || !result.result) return;

    const after = (await getOrder('ord_rebuild_test'))!;

    // Page artifacts replaced with the new long-form story.
    assert.equal(after.pageArtifacts?.length, 24);
    // Print artifact metadata refreshed.
    assert.equal(after.printInteriorPageCount, 32);
    assert.match(String(after.printInteriorArtifactUrl), /\/interiors\/pv_[a-z0-9_]+\.pdf$/);
    assert.match(String(after.storyArtifactUrl), /\/proofs\/pv_[a-z0-9_]+\.pdf$/);
    assert.ok(after.proofVersion);
    assert.equal(after.storyArtifactUrl, `https://rebuilt.example/${after.id}/proofs/${after.proofVersion}.pdf`);
    assert.equal(after.printInteriorArtifactUrl, `https://rebuilt.example/${after.id}/interiors/${after.proofVersion}.pdf`);
    assert.equal(after.printTitle, 'Rebuilt Title');
    assert.notEqual(after.printInteriorMd5, 'legacy-md5');
    // Cover cleared so next print submission rebuilds the cover against
    // the new interior page count.
    assert.equal(after.printCoverArtifactUrl, null);
    assert.equal(after.printCoverMd5, null);
    // Review state reset; new approval token issued; old approvals cleared.
    assert.equal(after.reviewStatus, 'in_review');
    assert.equal(after.proofApprovedAt, null);
    assert.equal(after.proofReviewedAt, null);
    assert.notEqual(after.proofApprovalToken, 'legacy-token');
    assert.equal(typeof after.proofApprovalToken, 'string');
    // Fulfillment + status reset.
    assert.equal(after.fulfillmentStatus, 'proof_ready');
    assert.equal(after.status, 'preview_ready');
    // Identity preserved.
    assert.equal(after.id, 'ord_rebuild_test');
    assert.equal(after.email, 'luna@example.com');
    assert.equal(after.childName, 'Luna');
    assert.equal(after.paymentStatus, 'paid');
    // Audit event recorded.
    const audit = (after.auditEvents ?? []).filter((e) => e.type === 'proof_rebuilt');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, 'rebuild_print_order');
    assert.equal(audit[0].meta?.previousPageCount, 6);
    assert.equal(audit[0].meta?.newPageCount, 24);
  } finally { cleanup(dir); }
});

test('rebuildPrintOrder: missing generated image aborts before PDF/upload/persistence', async () => {
  const dir = makeTmp();
  let buildCalls = 0;
  let uploadCalls = 0;
  try {
    const before = await seed({
      bookFormat: 'classic',
      photoBlobPath: 'orders/ord_rebuild_test/photo-upload.jpg',
      photoBlobUrl: null,
    });
    const deps = fakeDeps();
    deps.generateImageResults = async (prompts) => prompts.map((prompt) => ({
      imageUrl: null,
      provider: 'fal_edit',
      model: 'missing-reference',
      promptUsed: prompt,
      latencyMs: 0,
      error: 'reference unavailable',
    }));
    deps.buildPdf = async () => {
      buildCalls += 1;
      return Buffer.from('%PDF should not build');
    };
    deps.buildPrintInteriorPdf = async () => {
      buildCalls += 1;
      return Buffer.from('%PDF should not build');
    };
    deps.uploadArtifact = async () => {
      uploadCalls += 1;
      return 'https://rebuilt.example/should-not-upload.pdf';
    };

    await assert.rejects(
      () => rebuildPrintOrder('ord_rebuild_test', { dryRun: false }, deps),
      /image_generation_incomplete:print_rebuild/,
    );
    const after = (await getOrder('ord_rebuild_test'))!;
    assert.equal(after.storyArtifactUrl, before.storyArtifactUrl);
    assert.equal(after.printInteriorArtifactUrl, before.printInteriorArtifactUrl);
    assert.equal(after.pageArtifacts?.length, 6);
    assert.equal(after.proofApprovalToken, 'legacy-token');
    assert.equal(buildCalls, 0);
    assert.equal(uploadCalls, 0);
  } finally { cleanup(dir); }
});

test('rebuildPrintOrder: premium full rebuild produces 32 story pages + 38 interior page count', async () => {
  const dir = makeTmp();
  try {
    await seed({ bookFormat: 'premium' });
    const result = await rebuildPrintOrder('ord_rebuild_test', { dryRun: false }, fakeDeps());
    assert.equal(result.ok, true);
    if (!result.ok || !result.result) return;
    assert.equal(result.result.pageCount, 32);
    assert.equal(result.result.interiorPageCount, 38);
  } finally { cleanup(dir); }
});

test('rebuildPrintOrder: discards stale legacy accepted images (clean rebuild contract)', async () => {
  const dir = makeTmp();
  try {
    // Seed with an accepted legacy page artifact — must be discarded.
    const accepted = legacyPage(2);
    accepted.accepted = true;
    accepted.acceptedImageUrl = 'https://example.com/legacy-accepted.png';
    await seed({
      bookFormat: 'classic',
      pageArtifacts: [...Array.from({ length: 6 }, (_, i) => legacyPage(i)).slice(0, 2), accepted, ...Array.from({ length: 3 }, (_, i) => legacyPage(i + 3))],
    });
    const result = await rebuildPrintOrder('ord_rebuild_test', { dryRun: false }, fakeDeps());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const after = (await getOrder('ord_rebuild_test'))!;
    for (const page of after.pageArtifacts ?? []) {
      assert.equal(page.accepted, false, `pageIndex ${page.pageIndex} should NOT carry over accepted state`);
      assert.equal(page.acceptedImageUrl, null);
      assert.notEqual(page.currentImageUrl, 'https://example.com/legacy-accepted.png');
    }
  } finally { cleanup(dir); }
});

test('rebuildPrintOrder: stale slow build cannot overwrite a newer order version', async () => {
  const dir = makeTmp();
  try {
    const before = await seed({ bookFormat: 'classic' });
    const deps = fakeDeps();
    let releaseBuild!: () => void;
    const mayFinish = new Promise<void>((resolve) => { releaseBuild = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    deps.buildPdf = async () => {
      markStarted();
      await mayFinish;
      return Buffer.from('%PDF stale proof');
    };

    const pending = rebuildPrintOrder(before.id, { dryRun: false }, deps);
    await started;
    const concurrent = (await getOrder(before.id))!;
    await persistOrder({ ...concurrent, queueStatusNote: 'newer concurrent state' });
    releaseBuild();

    const result = await pending;
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'order_changed_during_rebuild');
    const after = (await getOrder(before.id))!;
    assert.equal(after.queueStatusNote, 'newer concurrent state');
    assert.equal(after.storyArtifactUrl, before.storyArtifactUrl);
    assert.equal(after.proofVersion, before.proofVersion);
  } finally { cleanup(dir); }
});
