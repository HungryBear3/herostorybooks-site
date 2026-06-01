/**
 * Stale-ack invalidation: any successful proof rebuild clears proofReviewedAt.
 * Customers must acknowledge the new proof before approveWholeBook will run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
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
import { rebuildProofFromPageArtifacts } from '../src/lib/fulfillment.ts';
import {
  acknowledgeProofReview,
  approveWholeBook,
  regeneratePage,
} from '../src/lib/page-review.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-ack-invalidation-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
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
    shippingAddress: {
      line1: '100 Test St',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      country: 'US',
    },
    pageArtifacts: [
      pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
    ],
    reviewStatus: 'in_review',
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
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const successProvider: ImageProvider = {
  name: 'gemini',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.com/regen.png',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image-preview',
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
    assert.match(after?.storyArtifactUrl ?? '', /proof\.pdf$/);
  } finally { cleanup(dir); }
});

// ── Regenerate auto-rebuild path clears the ack ─────────────────────────────

test('regenerate auto-rebuild clears proofReviewedAt; approve then 409s with proof_ack_missing', async () => {
  const dir = makeTmp();
  try {
    await seed({
      proofReviewedAt: '2026-04-27T09:00:00Z',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      ],
    });
    // Regenerate page 0; auto-rebuild fires after the regen. Inject the rebuilder
    // so we don't need a full PDF builder pipeline in the test.
    const r = await regeneratePage(
      { orderId: 'ord_ack_inv', pageIndex: 0, feedback: 'fix' },
      {
        providers: [successProvider],
        rebuildProof: async () => {
          // Simulate the real rebuild: write a new proof URL AND clear the ack
          // (the production rebuilder calls updateFulfillmentState with both).
          const { updateFulfillmentState } = await import('../src/lib/orders.ts');
          await updateFulfillmentState('ord_ack_inv', {
            storyArtifactUrl: 'https://example.com/proof-v2.pdf',
            proofReviewedAt: null,
          });
          return { ok: true, proofUrl: 'https://example.com/proof-v2.pdf' };
        },
      },
    );
    assert.equal(r.ok, true);
    const after = await getOrder('ord_ack_inv');
    assert.equal(after?.proofReviewedAt, null);

    // Re-accept the regenerated page so we don't hit pages_not_accepted first.
    const { acceptPage } = await import('../src/lib/page-review.ts');
    await acceptPage({ orderId: 'ord_ack_inv', pageIndex: 0 });

    const approve = await approveWholeBook('ord_ack_inv', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'x' }),
      approvePrint: async () => ({ ok: true }),
    });
    assert.equal(approve.ok, false);
    assert.equal(approve.status, 409);
    assert.match(approve.error ?? '', /acknowledgment required/i);
  } finally { cleanup(dir); }
});

// ── End-to-end: ack → rebuild → re-ack → approve happy path ─────────────────

test('approve-rebuild-approve cycle requires a fresh ack between rebuilds', async () => {
  const dir = makeTmp();
  try {
    await seed({
      proofReviewedAt: '2026-04-27T09:00:00Z',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      ],
    });
    // Real rebuilder simulation that clears the ack (matches production wiring).
    const fakeRebuild = async () => {
      const { updateFulfillmentState } = await import('../src/lib/orders.ts');
      await updateFulfillmentState('ord_ack_inv', {
        storyArtifactUrl: 'https://example.com/proof-vN.pdf',
        proofReviewedAt: null,
      });
      return { ok: true as const, proofUrl: 'https://example.com/proof-vN.pdf' };
    };

    // Try to approve without a fresh ack (the seed had one but the rebuild we
    // simulate via the regen path will clear it). First, regenerate to invalidate.
    await regeneratePage(
      { orderId: 'ord_ack_inv', pageIndex: 0, feedback: 'fix' },
      { providers: [successProvider], rebuildProof: fakeRebuild },
    );
    const { acceptPage } = await import('../src/lib/page-review.ts');
    await acceptPage({ orderId: 'ord_ack_inv', pageIndex: 0 });

    const blocked = await approveWholeBook('ord_ack_inv', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'x' }),
      approvePrint: async () => ({ ok: true }),
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 409);
    assert.match(blocked.error ?? '', /acknowledgment required/i);

    // Customer re-acks the new proof.
    const ack2 = await acknowledgeProofReview('ord_ack_inv');
    assert.equal(ack2.ok, true);

    // Now approve succeeds.
    const ok = await approveWholeBook('ord_ack_inv', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'https://final.pdf' }),
      approvePrint: async () => ({ ok: true }),
    });
    assert.equal(ok.ok, true);
    const after = await getOrder('ord_ack_inv');
    assert.equal(after?.reviewStatus, 'approved');
  } finally { cleanup(dir); }
});

// ── Unchanged happy path still works ────────────────────────────────────────

test('happy path: ack → approveWholeBook works without an intervening rebuild', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const ack = await acknowledgeProofReview('ord_ack_inv');
    assert.equal(ack.ok, true);
    const r = await approveWholeBook('ord_ack_inv', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'https://final.pdf' }),
      approvePrint: async () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
  } finally { cleanup(dir); }
});

// ── Approve's own internal rebuild does not break the approval in flight ────

test('approveWholeBook: the rebuild it triggers internally does not invalidate its own gate check', async () => {
  // This is a regression test against the "clear-during-approve" race I called
  // out: approveWholeBook reads proofReviewedAt BEFORE its own rebuild call, so
  // the clear can't undermine that single in-flight approval. After the call,
  // the order has reviewStatus='approved' and proofReviewedAt=null — both correct.
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: '2026-04-27T09:00:00Z' });
    const r = await approveWholeBook('ord_ack_inv', {
      rebuildProof: async () => {
        // Production rebuilder clears the ack as part of its update.
        const { updateFulfillmentState } = await import('../src/lib/orders.ts');
        await updateFulfillmentState('ord_ack_inv', {
          storyArtifactUrl: 'https://example.com/final-proof.pdf',
          proofReviewedAt: null,
        });
        return { ok: true, proofUrl: 'https://example.com/final-proof.pdf' };
      },
      approvePrint: async () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_ack_inv');
    assert.equal(after?.reviewStatus, 'approved');
    assert.equal(after?.proofReviewedAt, null);
  } finally { cleanup(dir); }
});
