/**
 * Stale-ack invalidation: any successful proof rebuild clears proofReviewedAt.
 * Customers must acknowledge the new proof before approveWholeBook will run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import { padPageSet } from './support/full-page-set.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  persistOrder,
  getOrder,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';
import {
  buildProofArtifactFromPageArtifacts,
  rebuildProofFromPageArtifacts,
} from '../src/lib/fulfillment.ts';
import {
  acknowledgeProofReview,
  approveWholeBook,
  regeneratePage,
} from '../src/lib/page-review.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-ack-invalidation-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  process.env.HSB_ENABLE_OPENAI_IMAGE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
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
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    currentImageUrl: `https://example.com/p${i}.png`,
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

async function seed(overrides: Partial<OrderRecord> = {}, id = 'ord_ack_inv'): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id, now: '2026-04-27T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    proofApprovalToken: 'tok_xyz',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof-v1.pdf',
    pageArtifacts: padPageSet([
      pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
    ]),
    reviewStatus: 'in_review',
    auditEvents: [],
    ...overrides,
  };
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
      imageUrl: 'https://example.com/regen.png',
      provider: 'openai',
      model: 'gpt-image-1',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};

// ── rebuildProofFromPageArtifacts clears the ack ────────────────────────────

test('rebuildProofFromPageArtifacts clears proofReviewedAt on success', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: '2026-04-27T09:00:00Z' });
    const r = await rebuildProofFromPageArtifacts('ord_ack_inv', {
      buildPdf: async () => Buffer.from('%PDF rebuilt'),
      uploadArtifact: async (orderId, _buf, name) => `https://cdn.example.com/${orderId}/${name}`,
    });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_ack_inv');
    assert.equal(after?.proofReviewedAt, null);
    // Proofs land at an IMMUTABLE, version-keyed path.
    assert.match(after?.storyArtifactUrl ?? '', /\/proofs\/pv_[a-z0-9_]+\.pdf$/);
  } finally { cleanup(dir); }
});

test('media-backed Custom Stories never build, upload, or persist automated proofs', async () => {
  const dir = makeTmp();
  try {
    await seed({
      theme: 'custom-voice-story',
      fulfillmentMode: 'manual_hold',
      documentBlobPath: 'orders/ord_ack_inv/story-source/document.pdf',
      documentConsentAt: '2026-04-27T09:00:00Z',
    });
    const before = await getOrder('ord_ack_inv');
    let pdfBuildCalls = 0;
    let proofUploadCalls = 0;
    const deps = {
      buildPdf: async () => {
        pdfBuildCalls += 1;
        return Buffer.from('%PDF forbidden');
      },
      uploadArtifact: async () => {
        proofUploadCalls += 1;
        return 'https://example.invalid/forbidden.pdf';
      },
    };

    const built = await buildProofArtifactFromPageArtifacts('ord_ack_inv', deps);
    assert.deepEqual(built, { ok: false, error: 'media_story_manual_review_required' });
    const rebuilt = await rebuildProofFromPageArtifacts('ord_ack_inv', deps);
    assert.deepEqual(rebuilt, { ok: false, error: 'media_story_manual_review_required' });
    assert.equal(pdfBuildCalls, 0);
    assert.equal(proofUploadCalls, 0);
    assert.deepEqual(await getOrder('ord_ack_inv'), before);
  } finally { cleanup(dir); }
});

test('proof build refuses upload when media evidence appears during rendering', async () => {
  const dir = makeTmp();
  try {
    await seed({ theme: 'custom-voice-story', fulfillmentMode: 'manual_hold' });
    const before = await getOrder('ord_ack_inv');
    let uploadCalls = 0;
    const built = await buildProofArtifactFromPageArtifacts('ord_ack_inv', {
      buildPdf: async () => {
        const current = await getOrder('ord_ack_inv');
        assert.ok(current);
        await persistOrder({
          ...current,
          documentBlobPath: 'orders/ord_ack_inv/story-source/document.pdf',
          documentConsentAt: '2026-04-27T09:00:00Z',
        });
        return Buffer.from('%PDF discard');
      },
      uploadArtifact: async () => {
        uploadCalls += 1;
        return 'https://example.invalid/must-not-upload.pdf';
      },
    });
    assert.deepEqual(built, { ok: false, error: 'media_story_manual_review_required' });
    assert.equal(uploadCalls, 0);
    const after = await getOrder('ord_ack_inv');
    assert.equal(after?.storyArtifactUrl, before?.storyArtifactUrl);
    assert.equal(after?.proofVersion, before?.proofVersion);
  } finally { cleanup(dir); }
});

// ── Regenerate auto-rebuild path clears the ack ─────────────────────────────

test('regenerate auto-rebuild clears proofReviewedAt; approve then 409s with proof_ack_missing', async () => {
  const dir = makeTmp();
  try {
    await seed({
      proofReviewedAt: '2026-04-27T09:00:00Z',
      pageArtifacts: padPageSet([
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      ]),
    });
    // Regenerate page 0; auto-rebuild fires after the regen. Inject the rebuilder
    // so we don't need a full PDF builder pipeline in the test.
    const r = await regeneratePage(
      { orderId: 'ord_ack_inv', pageIndex: 0, feedback: 'fix' },
      {
        providers: [successProvider],
        // The build step persists NOTHING; publication is a guarded,
        // fingerprint-checked commit inside the service. The regeneration has
        // already invalidated the previous proof and its acknowledgment.
        buildProof: async (oid: string) => ({
          ok: true as const,
          proofUrl: 'https://example.com/orders/x/proofs/pv_v2.pdf',
          sourceFingerprint: proofSourceFingerprint((await getOrder(oid))!),
          proofVersion: 'pv_v2',
        }),
      },
    );
    assert.equal(r.ok, true);
    const after = await getOrder('ord_ack_inv');
    assert.equal(after?.proofReviewedAt, null);

    // Re-accept the regenerated page so we don't hit pages_not_accepted first.
    const { acceptPage } = await import('../src/lib/page-review.ts');
    await acceptPage({ orderId: 'ord_ack_inv', pageIndex: 0 });

    const approve = await approveWholeBook('ord_ack_inv');
    assert.equal(approve.ok, false);
    assert.equal(approve.status, 409);
    // A regeneration invalidates the proof ARTIFACT, so approval is blocked at
    // the proof gate before it ever reaches the acknowledgment gate.
    assert.match(approve.error ?? '', /proof pdf is not ready|acknowledgment required/i);
  } finally { cleanup(dir); }
});

// ── End-to-end: ack → rebuild → re-ack → approve happy path ─────────────────


// ── Unchanged happy path still works ────────────────────────────────────────

test('happy path: ack → approveWholeBook works without an intervening rebuild', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const ack = await acknowledgeProofReview('ord_ack_inv', { proofVersion: 'pv_test' });
    assert.equal(ack.ok, true);
    const r = await approveWholeBook('ord_ack_inv');
    assert.equal(r.ok, true);
  } finally { cleanup(dir); }
});

// ── Approve's own internal rebuild does not break the approval in flight ────


test('approval does NOT rebuild, so it cannot invalidate its own acknowledgment', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: '2026-04-27T09:00:00Z' });
    const before = await getOrder('ord_ack_inv');
    const r = await approveWholeBook('ord_ack_inv');
    assert.equal(r.ok, true, r.error);
    const after = await getOrder('ord_ack_inv');
    assert.equal(after?.reviewStatus, 'approved');
    // The acknowledged revision is still in place and untouched: nothing was
    // rebuilt, so nothing could invalidate it mid-approval.
    assert.equal(after?.storyArtifactUrl, before?.storyArtifactUrl);
    assert.equal(after?.proofVersion, before?.proofVersion);
    assert.equal(after?.proofReviewedAt, before?.proofReviewedAt);
    assert.equal(after?.proofReviewedVersion, after?.proofVersion);
  } finally { cleanup(dir); }
});
