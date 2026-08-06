import test from 'node:test';
import { padPageSet } from './support/full-page-set.ts';
import assert from 'node:assert/strict';

import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { ensureRecommendedTextLayout, NEW_PROOF_LAYOUT_VERSION, recommendedPageTextLayout } from '../src/lib/fulfillment-types.ts';
import {
  regeneratePage,
  approveWholeBook,
  getReviewSnapshot,
  saveTextChangeRequest,
} from '../src/lib/page-review.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-secondpass-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  process.env.HSB_ENABLE_OPENAI_IMAGE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_ENABLE_OPENAI_IMAGE;
}

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1} story`,
    basePrompt: `prompt for page ${i + 1}`,
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    textLayout: recommendedPageTextLayout(),
    ...overrides,
  };
}

async function seedOrder(
  overrides: Partial<OrderRecord> = {},
  id = 'ord_secondpass_test',
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id, now: '2026-04-26T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    pageArtifacts: padPageSet([pageFixture(0), pageFixture(1), pageFixture(2)]),
    reviewStatus: 'in_review',
    proofApprovalToken: 're_test_stub_token',
    ...overrides,
  };
  order.pageArtifacts = order.pageArtifacts?.map((artifact) => ({
    ...artifact,
    textLayout: ensureRecommendedTextLayout(artifact.textLayout),
  }));
  // Proof gates are revision-bound: a seeded proof URL without an
  // identity would (correctly) fail every one of them.
  if (order.storyArtifactUrl && !order.proofVersion) {
    order.proofSourceFingerprint = proofSourceFingerprint(order);
    order.proofVersion = 'pv_test';
  }
  if (order.proofReviewedAt && !order.proofReviewedVersion) {
    order.proofReviewedVersion = order.proofVersion ?? 'pv_test';
  }
  await persistOrder(order);
  return order;
}

const successProvider: ImageProvider = {
  name: 'openai',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.com/regenerated.png',
      provider: 'openai',
      model: 'gpt-image-1',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};

// ── Auto-rebuild after successful regenerate ────────────────────────────────

test('regeneratePage: auto-rebuilds proof on success and reports proofRefreshed:true', async () => {
  const dir = makeTmp();
  try {
    await seedOrder();
    let rebuildCalled = 0;
    const result = await regeneratePage(
      { orderId: 'ord_secondpass_test', pageIndex: 1, feedback: 'fix it' },
      {
        providers: [successProvider],
        buildProof: async (oid: string) => {
          rebuildCalled++;
          return {
            ok: true as const,
            proofUrl: 'https://example.com/refreshed.pdf',
            sourceFingerprint: proofSourceFingerprint((await getOrder(oid))!),
            proofVersion: 'pv_refreshed',
          };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.proofRefreshed, true);
    assert.equal(rebuildCalled, 1);
    assert.equal(result.snapshot?.storyArtifactUrl, 'https://example.com/refreshed.pdf');
    assert.equal(result.snapshot?.proofVersion, 'pv_refreshed');
    assert.deepEqual(
      result.snapshot,
      await getReviewSnapshot('ord_secondpass_test', { reviewToken: 're_test_stub_token' }),
    );
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: surfaces proof rebuild failure but still returns ok:true on regen success', async () => {
  const dir = makeTmp();
  try {
    await seedOrder();
    const result = await regeneratePage(
      { orderId: 'ord_secondpass_test', pageIndex: 1, feedback: 'fix it' },
      {
        providers: [successProvider],
        buildProof: async () => {
          const concurrent = await saveTextChangeRequest({
            orderId: 'ord_secondpass_test',
            pageIndex: 2,
            note: 'Synthetic concurrent wording during failed proof build',
            reviewToken: 're_test_stub_token',
          });
          assert.equal(concurrent.ok, true);
          return { ok: false as const, error: 'blob unreachable' };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.proofRefreshed, false);
    assert.equal(result.proofRefreshError, 'blob unreachable');
    const authoritative = await getReviewSnapshot('ord_secondpass_test', {
      reviewToken: 're_test_stub_token',
    });
    assert.deepEqual(result.snapshot, authoritative);
    assert.equal(
      result.snapshot?.pageArtifacts[2].customerRequestedChange?.note,
      'Synthetic concurrent wording during failed proof build',
    );
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: does NOT trigger proof rebuild when image generation failed', async () => {
  const dir = makeTmp();
  try {
    await seedOrder();
    let rebuildCalled = 0;
    const allFail: ImageProvider = {
      name: 'fal',
      async generate({ prompt }) {
        return { imageUrl: null, provider: 'fal', model: 'm', promptUsed: prompt, latencyMs: 0, error: 'all bad' };
      },
    };
    const r = await regeneratePage(
      { orderId: 'ord_secondpass_test', pageIndex: 0, feedback: '' },
      {
        providers: [allFail],
        buildProof: async () => {
          rebuildCalled++;
          return { ok: false as const, error: 'should not be called' };
        },
      },
    );
    assert.equal(r.ok, false);
    assert.equal(rebuildCalled, 0);
    assert.ok(r.snapshot, 'a committed provider failure must return authoritative state');
    const authoritative = await getReviewSnapshot('ord_secondpass_test', {
      reviewToken: 're_test_stub_token',
    });
    assert.deepEqual(r.snapshot, authoritative);
    const failureFeedback = r.snapshot?.pageArtifacts[0].feedbackHistory.at(-1);
    assert.equal(failureFeedback?.success, false);
    assert.equal(failureFeedback?.rawText, '');
    assert.equal(failureFeedback?.providerTried, 'fal');
  } finally {
    cleanup(dir);
  }
});

// ── Manual-review threshold alert (one-shot on transition) ──────────────────

test('regeneratePage: fires manual-review alert exactly once when crossing threshold', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      pageArtifacts: [pageFixture(0, { regenerateCount: 4 })], // next regen → 5
    });
    let alertCount = 0;
    let lastFeedback = '';
    let lastPageIndex = -1;
    let lastCount = 0;

    const r1 = await regeneratePage(
      { orderId: 'ord_secondpass_test', pageIndex: 0, feedback: 'one more please' },
      {
        providers: [successProvider],
        skipProofRebuild: true,
        sendManualReviewAlert: async (_order, args) => {
          alertCount++;
          lastFeedback = args.latestFeedback;
          lastPageIndex = args.pageIndex;
          lastCount = args.regenerateCount;
          return { skipped: false as const, id: 'alert-1' };
        },
      },
    );
    assert.equal(r1.warning, 'regen_manual_review_threshold');

    // Give the fire-and-forget alert a tick to settle.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(alertCount, 1);
    assert.equal(lastPageIndex, 0);
    assert.equal(lastCount, 5);
    assert.match(lastFeedback, /one more please/);

    // Subsequent regen at >=threshold must NOT fire again.
    await regeneratePage(
      { orderId: 'ord_secondpass_test', pageIndex: 0, feedback: 'another' },
      {
        providers: [successProvider],
        skipProofRebuild: true,
        sendManualReviewAlert: async () => {
          alertCount++;
          return { skipped: false as const, id: 'alert-2' };
        },
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(alertCount, 1, 'alert must only fire on the threshold-crossing regen');
  } finally {
    cleanup(dir);
  }
});

test('regeneratePage: warning at 3 regens does NOT trigger manual-review alert', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      pageArtifacts: [pageFixture(0, { regenerateCount: 2 })],
    });
    let alertCount = 0;
    const r = await regeneratePage(
      { orderId: 'ord_secondpass_test', pageIndex: 0, feedback: 'change' },
      {
        providers: [successProvider],
        skipProofRebuild: true,
        sendManualReviewAlert: async () => {
          alertCount++;
          return { skipped: false as const, id: null };
        },
      },
    );
    assert.equal(r.warning, 'regen_threshold_warning');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(alertCount, 0);
  } finally {
    cleanup(dir);
  }
});

// ── approveWholeBook ────────────────────────────────────────────────────────

test('approveWholeBook: rejects when not all pages accepted', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1), // not accepted
      ],
    });
    const r = await approveWholeBook('ord_secondpass_test');
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error ?? '', /All pages must be accepted/);
  } finally {
    cleanup(dir);
  }
});





// ── Customer approval is inert: review approval only ───────────────────────

test('approveWholeBook on a PRINT order performs no print handoff and no rebuild', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      bookFormat: 'classic',
      storyArtifactUrl: 'https://example.com/orders/x/proofs/pv_test.pdf',
      proofReviewedAt: '2026-04-27T09:00:00Z',
      pageArtifacts: padPageSet([
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      ]),
    });
    const before = await getOrder('ord_secondpass_test');

    const r = await approveWholeBook('ord_secondpass_test');
    assert.equal(r.ok, true, r.error);

    const after = await getOrder('ord_secondpass_test');
    assert.equal(after?.reviewStatus, 'approved');
    // Print release is a SEPARATE, separately authorized operator gate.
    assert.equal(after?.printJobId ?? null, null, 'no print job was created');
    assert.equal(after?.printJobStatus ?? null, null, 'no print job status');
    assert.equal(after?.proofApprovedAt ?? null, null, 'no print proof approval');
    // Nothing was rebuilt: the acknowledged artifact is byte-identical.
    assert.equal(after?.storyArtifactUrl, before?.storyArtifactUrl);
    assert.equal(after?.proofVersion, before?.proofVersion);
    // …and the result never claims a print handoff happened.
    assert.equal((r as { printApproved?: unknown }).printApproved, undefined);
  } finally { cleanup(dir); }
});
