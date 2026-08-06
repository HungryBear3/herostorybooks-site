import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  getOrder,
  persistNewOrder,
  persistOrder,
  withOrderTransaction,
  __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import {
  buildProofArtifactFromPageArtifacts,
  defaultUploadArtifact as fulfillmentDefaultUploadArtifact,
  proofSourceFingerprint,
  triggerFulfillment,
} from '../src/lib/fulfillment.ts';
import type { FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { acceptPage, customerReviewActor, regeneratePage } from '../src/lib/page-review.ts';
import { canonicalSourceHash, proofStoryFromPageArtifacts } from '../src/lib/review-source-identity.ts';
import { defaultUploadArtifact as rebuildDefaultUploadArtifact } from '../src/lib/rebuild-print-order.ts';
import { padPageSet } from './support/full-page-set.ts';

const NOW = '2026-08-03T20:10:00.000Z';
const TOKEN = 'ca55'.repeat(12);

function page(overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: 0,
    storyText: 'Synthetic story text',
    basePrompt: 'Synthetic illustration prompt',
    characterAnchor: 'Synthetic character anchor',
    currentImageUrl: 'https://example.invalid/page-0.png',
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

function order(id: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Synthetic Child', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id, now: NOW },
    ),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    proofApprovalToken: TOKEN,
    pageArtifacts: [page()],
    auditEvents: [],
    ...overrides,
  };
}

function withLocalStore(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-review-remediation-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return {
    dir,
    cleanup() {
      __resetOrderStoreAdapterFactoryForTests();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.HSB_ORDER_STORE_DIR;
    },
  };
}

test('new-order persistence is create-only and cannot overwrite an existing record', async () => {
  const store = withLocalStore();
  const orderId = 'ord_synthetic_create_only';
  try {
    await persistNewOrder(order(orderId, { childName: 'Synthetic Original' }));
    await assert.rejects(
      persistNewOrder(order(orderId, { childName: 'Synthetic Replacement' })),
      /Refusing to overwrite an existing order/,
    );
    assert.equal((await getOrder(orderId))?.childName, 'Synthetic Original');
  } finally {
    store.cleanup();
  }
});

test('production order writers do not use unconditional persistOrder for existing records', () => {
  const adminRoute = readFileSync(
    'src/app/api/admin/orders/[orderId]/page-review/route.ts',
    'utf8',
  );
  assert.match(adminRoute, /withOrderTransaction/);
  assert.doesNotMatch(adminRoute, /\bgetOrder\b|\bpersistOrder\b/);

  for (const rel of [
    'src/app/api/order/route.ts',
    'src/lib/admin-actions.ts',
    'src/lib/order-recovery.ts',
    'src/lib/print-upgrades.ts',
  ]) {
    const source = readFileSync(rel, 'utf8');
    assert.doesNotMatch(source, /await\s+persistOrder\s*\(/, `${rel} must use create-only or CAS persistence`);
  }
});

test('guarded CAS mutation scrubs a retired voice filename from committed bytes', async () => {
  const store = withLocalStore();
  const orderId = 'ord_synthetic_cas_privacy';
  const file = path.join(store.dir, `${orderId}.json`);
  try {
    const legacy = {
      ...order(orderId),
      voiceFileName: 'Synthetic Family Recording 2026.m4a',
    };
    writeFileSync(file, JSON.stringify(legacy, null, 2), 'utf8');

    const result = await acceptPage({
      orderId,
      pageIndex: 0,
      actor: customerReviewActor(TOKEN),
    });
    assert.equal(result.ok, true);

    const committed = readFileSync(file, 'utf8');
    assert.doesNotMatch(committed, /voiceFileName/);
    assert.doesNotMatch(committed, /Synthetic Family Recording/);
    const parsed = JSON.parse(committed) as Record<string, unknown>;
    assert.equal(parsed.legacyVoiceUploadPresent, true);
  } finally {
    store.cleanup();
  }
});

test('older same-page provider result cannot overwrite a newer regeneration', async () => {
  const store = withLocalStore();
  const orderId = 'ord_synthetic_same_page_race';
  try {
    await persistOrder(order(orderId));

    let releaseOlder!: () => void;
    const olderMayFinish = new Promise<void>((resolve) => { releaseOlder = resolve; });
    let markOlderStarted!: () => void;
    const olderStarted = new Promise<void>((resolve) => { markOlderStarted = resolve; });
    const olderProvider: ImageProvider = {
      name: 'fal',
      async generate({ prompt }) {
        markOlderStarted();
        await olderMayFinish;
        return {
          imageUrl: 'https://example.invalid/older-A.png',
          provider: 'fal', model: 'synthetic-A', promptUsed: prompt, latencyMs: 1, error: null,
        };
      },
    };
    const newerProvider: ImageProvider = {
      name: 'fal',
      async generate({ prompt }) {
        return {
          imageUrl: 'https://example.invalid/newer-B.png',
          provider: 'fal', model: 'synthetic-B', promptUsed: prompt, latencyMs: 1, error: null,
        };
      },
    };

    let olderProofBuildCalls = 0;
    const older = regeneratePage(
      { orderId, pageIndex: 0, feedback: 'older request A', actor: customerReviewActor(TOKEN) },
      {
        providers: [olderProvider],
        now: () => new Date(NOW),
        buildProof: async () => {
          olderProofBuildCalls += 1;
          return { ok: false as const, error: 'must_not_run' };
        },
      },
    );
    await olderStarted;

    const newer = await regeneratePage(
      { orderId, pageIndex: 0, feedback: 'newer request B', actor: customerReviewActor(TOKEN) },
      { providers: [newerProvider], skipProofRebuild: true, now: () => new Date(NOW) },
    );
    assert.equal(newer.ok, true);

    releaseOlder();
    const stale = await older;
    assert.equal(stale.ok, false);
    assert.equal(stale.status, 409);
    assert.equal(stale.error, 'page_changed_during_generation');
    assert.equal(olderProofBuildCalls, 0);

    const final = await getOrder(orderId);
    assert.equal(final?.pageArtifacts?.[0].currentImageUrl, 'https://example.invalid/newer-B.png');
    assert.equal(final?.pageArtifacts?.[0].regenerateCount, 1);
  } finally {
    store.cleanup();
  }
});

test('proof fingerprint changes when only the explicit child-name renderer input changes', () => {
  const base = order('ord_synthetic_proof_same', {
    childName: 'Synthetic Alpha',
    printTitle: 'Fixed Synthetic Print Title',
  });
  const changed = { ...base, childName: 'Synthetic Beta' };
  assert.equal(base.id, changed.id);
  assert.equal(base.printTitle, changed.printTitle);
  assert.deepEqual(base.pageArtifacts, changed.pageArtifacts);
  assert.equal(base.theme, changed.theme);
  assert.equal(base.bookFormat, changed.bookFormat);
  const alpha = proofSourceFingerprint(base);
  const beta = proofSourceFingerprint(changed);
  assert.ok(alpha);
  assert.ok(beta);
  assert.notEqual(alpha, beta, 'explicit childName projection must be load-bearing');

  const alphaStory = proofStoryFromPageArtifacts(base, base.pageArtifacts ?? []);
  const betaStory = proofStoryFromPageArtifacts(changed, changed.pageArtifacts ?? []);
  assert.deepEqual(alphaStory, betaStory, 'fixed printTitle holds derived renderer story constant');
  const imageUrls = (base.pageArtifacts ?? []).map((page) => page.acceptedImageUrl ?? page.currentImageUrl);
  const withoutExplicitChildName = (candidate: OrderRecord, story: unknown) => canonicalSourceHash({
    story,
    order: { id: candidate.id, bookFormat: candidate.bookFormat },
    imageUrls,
  });
  assert.equal(
    withoutExplicitChildName(base, alphaStory),
    withoutExplicitChildName(changed, betaStory),
    'mutation proof: removing explicit childName makes the fingerprints collide',
  );
});

test('initial digital proof URL is immutable and keyed by its persisted proof version', async () => {
  const store = withLocalStore();
  const orderId = 'ord_synthetic_initial_identity';
  try {
    await persistOrder(order(orderId, { fulfillmentStatus: 'not_started' }));
    const uploaded: string[] = [];
    const deps: FulfillmentDeps = {
      generateStory: async () => ({
        title: 'Synthetic Immutable Story',
        characterDescription: 'Synthetic character',
        // 24 story pages to satisfy the digital page-count contract; page 1
        // keeps its named scene + layout for the assertions below.
        pages: [
          {
            pageNum: 1,
            sceneTitle: 'Synthetic Scene',
            story: 'Synthetic story text',
            imagePrompt: 'Synthetic illustration prompt',
            textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const },
          },
          ...Array.from({ length: 23 }, (_, i) => ({
            pageNum: i + 2,
            sceneTitle: `Synthetic Scene ${i + 2}`,
            story: `Synthetic story text ${i + 2}`,
            imagePrompt: `Synthetic illustration prompt ${i + 2}`,
            textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const },
          })),
        ],
      }),
      generateImages: async (prompts) => prompts.map((_, i) => `https://example.invalid/generated-page-${i}.png`),
      buildPdf: async () => Buffer.from('%PDF synthetic immutable'),
      uploadArtifact: async (id, _buffer, filename) => {
        uploaded.push(filename);
        return `https://example.invalid/${id}/${filename}`;
      },
      sleep: async () => {},
    };

    const result = await triggerFulfillment(orderId, deps);
    assert.equal(result.status, 'started');
    const persisted = await getOrder(orderId);
    assert.ok(persisted?.proofVersion);
    assert.deepEqual(uploaded, [`proofs/${persisted.proofVersion}.pdf`]);
    assert.equal(
      persisted.storyArtifactUrl,
      `https://example.invalid/${orderId}/proofs/${persisted.proofVersion}.pdf`,
    );
    assert.equal(persisted.proofSourceFingerprint, proofSourceFingerprint(persisted));
    assert.equal(persisted.pageArtifacts?.[0].sceneTitle, 'Synthetic Scene');
    assert.deepEqual(
      persisted.pageArtifacts?.[0].textLayout,
      { zone: 'bottom_band', colorMode: 'dark', panelStyle: 'translucent_cream' },
    );
  } finally {
    store.cleanup();
  }
});

test('initial digital and print fulfillment never publish a proof from a stale render-affecting order snapshot', async () => {
  const store = withLocalStore();
  try {
    for (const format of ['digital', 'classic'] as const) {
      const orderId = `ord_synthetic_initial_stale_${format}`;
      const seeded = createOrderRecord(
        { childName: 'Synthetic Original', bookFormat: format, email: 'reviewer@example.invalid' },
        { id: orderId, now: NOW },
      );
      await persistOrder({ ...seeded, paymentStatus: 'paid', fulfillmentStatus: 'not_started' });
      const story = {
        title: 'Synthetic Concurrency Story',
        characterDescription: 'Synthetic character',
        pages: Array.from({ length: 24 }, (_, i) => ({
          pageNum: i + 1,
          sceneTitle: `Scene ${i + 1}`,
          story: `Story ${i + 1}`,
          imagePrompt: `Prompt ${i + 1}`,
          textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const },
        })),
      };
      let mutated = false;
      const deps: FulfillmentDeps = {
        generateStory: async () => story,
        generateImages: async (prompts) => prompts.map((_, i) => `https://example.invalid/${format}-${i}.png`),
        buildPdf: async () => {
          if (!mutated) {
            mutated = true;
            await withOrderTransaction(orderId, (current) => ({
              commit: { ...current, childName: 'Synthetic Concurrent Change' },
              result: undefined,
            }));
          }
          return Buffer.from('%PDF stale-source probe');
        },
        buildPrintInteriorPdf: async () => Buffer.from('%PDF stale-source interior'),
        uploadArtifact: async (id, _buffer, filename) => `https://example.invalid/${id}/${filename}`,
        sleep: async () => {},
      };
      await triggerFulfillment(orderId, deps);
      const after = await getOrder(orderId);
      assert.equal(after?.childName, 'Synthetic Concurrent Change');
      assert.equal(after?.storyArtifactUrl ?? null, null, `${format} must discard a stale proof`);
      assert.equal(after?.proofSourceFingerprint ?? null, null);
      assert.equal(after?.proofVersion ?? null, null);
    }

    const refundOrderId = 'ord_synthetic_initial_stale_refund';
    const refundSeed = createOrderRecord(
      { childName: 'Synthetic Refund Hero', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id: refundOrderId, now: NOW },
    );
    await persistOrder({ ...refundSeed, paymentStatus: 'paid', fulfillmentStatus: 'not_started' });
    const refundStory = {
      title: 'Synthetic Refund Story',
      characterDescription: 'Synthetic character',
      pages: Array.from({ length: 24 }, (_, i) => ({
        pageNum: i + 1,
        sceneTitle: `Refund Scene ${i + 1}`,
        story: `Refund Story ${i + 1}`,
        imagePrompt: `Refund Prompt ${i + 1}`,
        textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const },
      })),
    };
    let refunded = false;
    let refundPdfCalls = 0;
    await triggerFulfillment(refundOrderId, {
      generateStory: async () => {
        if (!refunded) {
          refunded = true;
          await withOrderTransaction(refundOrderId, (current) => ({
            commit: {
              ...current,
              paymentStatus: 'refunded',
              refundedAt: '2026-08-05T21:00:00.000Z',
              stripeRefundId: 're_synthetic_concurrent',
            },
            result: undefined,
          }));
        }
        return refundStory;
      },
      generateImages: async (prompts) => prompts.map((_, i) => `https://example.invalid/refund-${i}.png`),
      buildPdf: async () => {
        refundPdfCalls += 1;
        return Buffer.from('%PDF concurrent refund probe');
      },
      uploadArtifact: async (id, _buffer, filename) => `https://example.invalid/${id}/${filename}`,
      sleep: async () => {},
    });
    const afterRefund = await getOrder(refundOrderId);
    assert.equal(refundPdfCalls, 0, 'refund during story generation must stop before PDF build');
    assert.equal(afterRefund?.paymentStatus, 'refunded');
    assert.equal(afterRefund?.refundedAt, '2026-08-05T21:00:00.000Z');
    assert.equal(afterRefund?.stripeRefundId, 're_synthetic_concurrent');
    assert.equal(afterRefund?.fulfillmentAttempts, 1, 'refunded fulfillment must be terminal, not retried');
    assert.equal(afterRefund?.storyArtifactUrl ?? null, null);
    assert.equal(afterRefund?.proofSourceFingerprint ?? null, null);
    assert.equal(afterRefund?.proofVersion ?? null, null);
  } finally {
    store.cleanup();
  }
});

test('digital fulfillment stops before upload when refunded during proof rendering', async () => {
  const store = withLocalStore();
  const orderId = 'ord_synthetic_digital_refund_during_pdf';
  try {
    const seeded = createOrderRecord(
      { childName: 'Synthetic Digital Refund Hero', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id: orderId, now: NOW },
    );
    await persistOrder({ ...seeded, paymentStatus: 'paid', fulfillmentStatus: 'not_started' });
    const story = {
      title: 'Synthetic Digital Refund Story',
      characterDescription: 'Synthetic character',
      pages: Array.from({ length: 24 }, (_, i) => ({
        pageNum: i + 1,
        sceneTitle: `Digital Refund Scene ${i + 1}`,
        story: `Digital Refund Story ${i + 1}`,
        imagePrompt: `Digital Refund Prompt ${i + 1}`,
        textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const },
      })),
    };
    let uploadCalls = 0;
    await triggerFulfillment(orderId, {
      generateStory: async () => story,
      generateImages: async (prompts) => prompts.map((_, i) => `https://example.invalid/digital-refund-${i}.png`),
      buildPdf: async () => {
        await withOrderTransaction(orderId, (current) => ({
          commit: {
            ...current,
            paymentStatus: 'refunded',
            refundedAt: '2026-08-05T22:56:00.000Z',
            stripeRefundId: 're_synthetic_digital_pdf',
          },
          result: undefined,
        }));
        return Buffer.from('%PDF digital refund preview');
      },
      uploadArtifact: async (id, _buffer, filename) => {
        uploadCalls += 1;
        return `https://example.invalid/${id}/${filename}`;
      },
      sleep: async () => {},
    });
    const after = await getOrder(orderId);
    assert.equal(uploadCalls, 0, 'refund during digital PDF build must stop before upload');
    assert.equal(after?.paymentStatus, 'refunded');
    assert.equal(after?.fulfillmentAttempts, 1);
    assert.equal(after?.storyArtifactUrl ?? null, null);
    assert.equal(after?.proofSourceFingerprint ?? null, null);
    assert.equal(after?.proofVersion ?? null, null);
  } finally {
    store.cleanup();
  }
});

test('print fulfillment stops after a concurrent refund at every expensive artifact phase', async () => {
  const store = withLocalStore();
  try {
    const story = {
      title: 'Synthetic Print Refund Story',
      characterDescription: 'Synthetic character',
      pages: Array.from({ length: 24 }, (_, i) => ({
        pageNum: i + 1,
        sceneTitle: `Print Refund Scene ${i + 1}`,
        story: `Print Refund Story ${i + 1}`,
        imagePrompt: `Print Refund Prompt ${i + 1}`,
        textLayout: { zone: 'bottom_band' as const, colorMode: 'dark' as const, panelStyle: 'translucent_cream' as const },
      })),
    };

    for (const scenario of [
      { phase: 'preview' as const, expectedPreview: 1, expectedInterior: 0, expectedUploads: 0 },
      { phase: 'interior' as const, expectedPreview: 1, expectedInterior: 1, expectedUploads: 0 },
      { phase: 'first_upload' as const, expectedPreview: 1, expectedInterior: 1, expectedUploads: 1 },
    ]) {
      const orderId = `ord_synthetic_print_refund_${scenario.phase}`;
      const seeded = createOrderRecord(
        { childName: 'Synthetic Print Refund Hero', bookFormat: 'classic', email: 'reviewer@example.invalid' },
        { id: orderId, now: NOW },
      );
      await persistOrder({ ...seeded, paymentStatus: 'paid', fulfillmentStatus: 'not_started' });

      let previewCalls = 0;
      let interiorCalls = 0;
      let uploadCalls = 0;
      let refunded = false;
      const refund = async () => {
        if (refunded) return;
        refunded = true;
        await withOrderTransaction(orderId, (current) => ({
          commit: {
            ...current,
            paymentStatus: 'refunded',
            refundedAt: '2026-08-05T22:55:00.000Z',
            stripeRefundId: `re_synthetic_print_${scenario.phase}`,
          },
          result: undefined,
        }));
      };

      await triggerFulfillment(orderId, {
        generateStory: async () => story,
        generateImages: async (prompts) => prompts.map((_, i) => `https://example.invalid/print-refund-${i}.png`),
        buildPdf: async () => {
          previewCalls += 1;
          if (scenario.phase === 'preview') await refund();
          return Buffer.from('%PDF print refund preview');
        },
        buildPrintInteriorPdf: async () => {
          interiorCalls += 1;
          if (scenario.phase === 'interior') await refund();
          return Buffer.from('%PDF print refund interior');
        },
        uploadArtifact: async (id, _buffer, filename) => {
          uploadCalls += 1;
          if (scenario.phase === 'first_upload' && uploadCalls === 1) await refund();
          return `https://example.invalid/${id}/${filename}`;
        },
        sleep: async () => {},
      });

      const after = await getOrder(orderId);
      assert.equal(previewCalls, scenario.expectedPreview, `${scenario.phase}: preview calls`);
      assert.equal(interiorCalls, scenario.expectedInterior, `${scenario.phase}: interior calls`);
      assert.equal(uploadCalls, scenario.expectedUploads, `${scenario.phase}: upload calls`);
      assert.equal(after?.paymentStatus, 'refunded', `${scenario.phase}: payment state`);
      assert.equal(after?.refundedAt, '2026-08-05T22:55:00.000Z');
      assert.equal(after?.stripeRefundId, `re_synthetic_print_${scenario.phase}`);
      assert.equal(after?.fulfillmentAttempts, 1, `${scenario.phase}: refund must be terminal`);
      assert.equal(after?.storyArtifactUrl ?? null, null);
      assert.equal(after?.printInteriorArtifactUrl ?? null, null);
      assert.equal(after?.proofSourceFingerprint ?? null, null);
      assert.equal(after?.proofVersion ?? null, null);
    }
  } finally {
    store.cleanup();
  }
});

test('default proof uploader creates nested immutable local paths', async () => {
  const store = withLocalStore();
  const originalCwd = process.cwd();
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'hsb-immutable-artifact-'));
  const orderId = 'ord_synthetic_nested_proof';
  try {
    process.chdir(cwd);
    await persistOrder(order(orderId, { pageArtifacts: padPageSet([page()]) }));
    const built = await buildProofArtifactFromPageArtifacts(orderId, {
      buildPdf: async () => Buffer.from('%PDF nested path'),
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(
      existsSync(path.join(cwd, '.data', 'artifacts', orderId, 'proofs', `${built.proofVersion}.pdf`)),
      true,
      'nested proofs directory must be created before exclusive write',
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    store.cleanup();
  }
});

test('both local uploaders create nested parents and reject a second immutable write', async () => {
  const originalCwd = process.cwd();
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'hsb-exclusive-artifact-'));
  try {
    process.chdir(cwd);
    await fulfillmentDefaultUploadArtifact(
      'ord_fulfillment_exclusive',
      Buffer.from('first proof'),
      'proofs/pv_same.pdf',
    );
    await assert.rejects(
      () => fulfillmentDefaultUploadArtifact(
        'ord_fulfillment_exclusive',
        Buffer.from('replacement proof'),
        'proofs/pv_same.pdf',
      ),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );

    await rebuildDefaultUploadArtifact(
      'ord_rebuild_exclusive',
      Buffer.from('first interior'),
      'interiors/pv_same.pdf',
    );
    await assert.rejects(
      () => rebuildDefaultUploadArtifact(
        'ord_rebuild_exclusive',
        Buffer.from('replacement interior'),
        'interiors/pv_same.pdf',
      ),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('legacy rebuild default uploader cannot overwrite an immutable proof path', () => {
  const source = readFileSync(
    new URL('../src/lib/rebuild-print-order.ts', import.meta.url),
    'utf8',
  );
  const uploader = source.slice(source.indexOf('async function defaultUploadArtifact'));
  assert.match(uploader, /allowOverwrite:\s*false/);
  assert.doesNotMatch(uploader, /allowOverwrite:\s*true/);
  assert.match(uploader, /writeFile\([^;]+\{\s*flag:\s*'wx'\s*\}\)/);
});
