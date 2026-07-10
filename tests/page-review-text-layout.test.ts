/**
 * Tests for the proof text layout review service:
 *  - applyUpdateTextLayout (pure): saves a clamped layout without approving.
 *  - updatePageTextLayout (async): persists + refreshes proof, never approves.
 *
 * Local/read-only: order store is a temp dir; the proof rebuild is injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyUpdateTextLayout,
  updatePageTextLayout,
} from '../src/lib/page-review.ts';
import {
  createOrderRecord,
  persistOrder,
  getOrder,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';

function makePage(overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: 0,
    storyText: 'Luna found one star.',
    basePrompt: 'p',
    currentImageUrl: 'https://x/0.png',
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

// ── pure ─────────────────────────────────────────────────────────────────────

test('applyUpdateTextLayout: saves a clamped layout on the matching page', () => {
  const pages = [makePage({ pageIndex: 0 }), makePage({ pageIndex: 1 })];
  const { page, layout, error } = applyUpdateTextLayout(pages, 1, {
    colorMode: 'dark',
    sizePreset: 'large',
    position: { xPct: 999, yPct: 10, widthPct: 60 },
  });
  assert.equal(error, undefined);
  assert.ok(page && layout);
  assert.equal(page!.pageIndex, 1);
  assert.equal(page!.textLayout?.colorMode, 'dark');
  assert.equal(page!.textLayout?.sizePreset, 'large');
  assert.ok(page!.textLayout?.position && page!.textLayout.position.xPct <= 75, 'x clamped');
});

test('applyUpdateTextLayout: does NOT approve the page or change review status', () => {
  const pages = [makePage({ pageIndex: 0, accepted: false, customerReviewStatus: 'changes_requested' })];
  const { page } = applyUpdateTextLayout(pages, 0, { sizePreset: 'small' });
  assert.equal(page!.accepted, false);
  assert.equal(page!.customerReviewStatus, 'changes_requested');
});

test('applyUpdateTextLayout: unknown page index returns page_not_found and leaves input untouched', () => {
  const pages = [makePage({ pageIndex: 0 })];
  const { error, artifacts } = applyUpdateTextLayout(pages, 9, { sizePreset: 'large' });
  assert.equal(error, 'page_not_found');
  assert.equal(artifacts[0].textLayout, undefined);
});

test('applyUpdateTextLayout: is immutable — original array/page unchanged', () => {
  const pages = [makePage({ pageIndex: 0 })];
  applyUpdateTextLayout(pages, 0, { sizePreset: 'large' });
  assert.equal(pages[0].textLayout, undefined);
});

// ── async (with temp order store + injected rebuild) ─────────────────────────

function tmpStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-textlayout-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

let seq = 0;
async function seed(over: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'l@e.com' },
    { id: `ord_tl_${seq++}`, now: '2026-06-08T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    pageArtifacts: [makePage({ pageIndex: 0 }), makePage({ pageIndex: 1 })],
    ...over,
  };
  await persistOrder(order);
  return order;
}

test('updatePageTextLayout: persists the layout and reports proof refresh', async () => {
  const dir = tmpStore();
  try {
    const order = await seed();
    let rebuildCalled = false;
    const result = await updatePageTextLayout(
      { orderId: order.id, pageIndex: 1, textLayout: { sizePreset: 'large', position: { xPct: 30, yPct: 40 } } },
      {
        rebuildProof: async (id, _deps, existing) => {
          rebuildCalled = true;
          return { ok: true, proofUrl: 'https://x/proof.pdf', updatedOrder: existing };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.proofRefreshed, true);
    assert.ok(rebuildCalled);
    assert.equal(result.savedLayout?.sizePreset, 'large');

    const after = await getOrder(order.id);
    assert.equal(after?.pageArtifacts?.[1].textLayout?.sizePreset, 'large');
    // Untouched neighbor + no accidental approval.
    assert.equal(after?.pageArtifacts?.[0].textLayout ?? null, null);
    assert.equal(after?.pageArtifacts?.[1].accepted, false);
    assert.notEqual(after?.reviewStatus, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('updatePageTextLayout: surfaces a failed proof rebuild without failing the save', async () => {
  const dir = tmpStore();
  try {
    const order = await seed();
    const result = await updatePageTextLayout(
      { orderId: order.id, pageIndex: 0, textLayout: { sizePreset: 'small' } },
      { rebuildProof: async () => ({ ok: false, error: 'pdf_boom' }) },
    );
    assert.equal(result.ok, true);
    assert.equal(result.proofRefreshed, false);
    assert.equal(result.proofRefreshError, 'pdf_boom');
    const after = await getOrder(order.id);
    assert.equal(after?.pageArtifacts?.[0].textLayout?.sizePreset, 'small');
  } finally {
    cleanup(dir);
  }
});

test('updatePageTextLayout: refuses on an already-approved order', async () => {
  const dir = tmpStore();
  try {
    const order = await seed({ reviewStatus: 'approved' });
    const result = await updatePageTextLayout(
      { orderId: order.id, pageIndex: 0, textLayout: { sizePreset: 'large' } },
      { skipProofRebuild: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
  } finally {
    cleanup(dir);
  }
});

test('updatePageTextLayout: 404 for a missing order', async () => {
  const dir = tmpStore();
  try {
    const result = await updatePageTextLayout(
      { orderId: 'nope', pageIndex: 0, textLayout: {} },
      { skipProofRebuild: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  } finally {
    cleanup(dir);
  }
});
