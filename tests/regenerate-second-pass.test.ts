import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import {
  regeneratePage,
  approveWholeBook,
} from '../src/lib/page-review.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-secondpass-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
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
    shippingAddress: {
      line1: '100 Test St',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      country: 'US',
    },
    pageArtifacts: [pageFixture(0), pageFixture(1), pageFixture(2)],
    reviewStatus: 'in_review',
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const successProvider: ImageProvider = {
  name: 'gemini',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.com/regenerated.png',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image-preview',
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
        rebuildProof: async () => {
          rebuildCalled++;
          return { ok: true, proofUrl: 'https://example.com/refreshed.pdf' };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.proofRefreshed, true);
    assert.equal(rebuildCalled, 1);
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
        rebuildProof: async () => ({ ok: false, error: 'blob unreachable' }),
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.proofRefreshed, false);
    assert.equal(result.proofRefreshError, 'blob unreachable');
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
        rebuildProof: async () => {
          rebuildCalled++;
          return { ok: true, proofUrl: 'should not be called' };
        },
      },
    );
    assert.equal(r.ok, false);
    assert.equal(rebuildCalled, 0);
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

test('approveWholeBook: digital order → rebuilds proof, sets reviewStatus=approved, no print handoff', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      bookFormat: 'digital',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      proofReviewedAt: '2026-04-27T10:00:00Z',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      ],
    });
    let printApprovalCalled = false;
    const r = await approveWholeBook('ord_secondpass_test', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'https://example.com/final.pdf' }),
      approvePrint: async () => {
        printApprovalCalled = true;
        return { ok: true };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.proofUrl, 'https://example.com/final.pdf');
    assert.equal(r.printApproved, false);
    assert.equal(printApprovalCalled, false);
    const after = await getOrder('ord_secondpass_test');
    assert.equal(after?.reviewStatus, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('approveWholeBook: print order with proofApprovalToken hands off to approvePrint', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      bookFormat: 'classic',
      proofApprovalToken: 'tok_abc',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://example.com/proof.pdf',
      proofReviewedAt: '2026-04-27T10:00:00Z',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      ],
    });
    let receivedToken: string | null = null;
    const r = await approveWholeBook('ord_secondpass_test', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'https://example.com/proof.pdf' }),
      approvePrint: async (_orderId, token) => {
        receivedToken = token;
        return { ok: true };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.printApproved, true);
    assert.equal(receivedToken, 'tok_abc');
  } finally {
    cleanup(dir);
  }
});

test('approveWholeBook: rebuild failure → 502', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      storyArtifactUrl: 'https://example.com/proof.pdf',
      proofReviewedAt: '2026-04-27T10:00:00Z',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      ],
    });
    const r = await approveWholeBook('ord_secondpass_test', {
      rebuildProof: async () => ({ ok: false, error: 'pdf builder threw' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 502);
    assert.match(r.error ?? '', /pdf builder threw/);
  } finally {
    cleanup(dir);
  }
});

test('approveWholeBook: print handoff failure → ok:true with warning + printApproved:false', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({
      bookFormat: 'premium',
      proofApprovalToken: 'tok_xyz',
      fulfillmentStatus: 'proof_ready',
      storyArtifactUrl: 'https://x/proof.pdf',
      proofReviewedAt: '2026-04-27T10:00:00Z',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      ],
    });
    const r = await approveWholeBook('ord_secondpass_test', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'https://x/proof.pdf' }),
      approvePrint: async () => ({ ok: false, error: 'token expired' }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.printApproved, false);
    assert.match(r.error ?? '', /token expired/);
  } finally {
    cleanup(dir);
  }
});
