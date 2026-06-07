/**
 * Durability of the review/regenerate/approve flow against clobber:
 *   C1 — admin full-retry must refuse to re-seed an order that carries customer
 *        review work (would wipe accepted/regenerated pages + approved proof).
 *   C2 — concurrent per-page mutations must not clobber each other (per-order
 *        write lock + merge-at-write on the freshest order).
 *
 * Offline: local blob-less order store, injected generators, no email/print/live.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { acceptPage, regeneratePage, requestPageChanges, approveWholeBook } from '../src/lib/page-review.ts';
import { retryOrderFulfillment, describeCustomerReviewWork } from '../src/lib/admin-actions.ts';
import type { GeneratedImageResult } from '../src/lib/image-generator.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-durab-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}
function cleanup(dir: string) { rmSync(dir, { recursive: true, force: true }); delete process.env.HSB_ORDER_STORE_DIR; }

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i, storyText: `Page ${i + 1}`, basePrompt: `p${i}`,
    currentImageUrl: `https://img/p${i}.png`, acceptedImageUrl: null,
    generationProvider: null, generationModel: null, regenerateCount: 0,
    accepted: false, feedbackHistory: [], versionHistory: [{ createdAt: '2026-04-26T10:00:00Z', imageUrl: `https://img/p${i}.png`, provider: 'gemini', model: 'm', promptUsed: 'p', conditioning: 'text_only', referencePhotoUrl: null }],
    ...o,
  };
}
async function seed(id: string, o: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const base = createOrderRecord({ childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' }, { id, now: '2026-04-26T10:00:00Z' });
  const order: OrderRecord = { ...base, paymentStatus: 'paid', reviewStatus: 'in_review', pageArtifacts: [page(0), page(1), page(2)], ...o };
  await persistOrder(order);
  return order;
}
function gatedGen(url: string, gate: Promise<void>) {
  return (async (input: { prompt: string }): Promise<GeneratedImageResult> => {
    await gate;
    return { imageUrl: url, provider: 'gemini', model: 'm', promptUsed: input.prompt, conditioning: 'text_only', referencePhotoUrl: null, latencyMs: 1, error: null };
  }) as unknown as Parameters<typeof regeneratePage>[1]['generatePageImage'];
}

// ── C1: retry guard ────────────────────────────────────────────────────────────

test('describeCustomerReviewWork: detects review states + accepted/feedback/regenerated pages; null when clean', () => {
  assert.equal(describeCustomerReviewWork({ reviewStatus: 'approved', pageArtifacts: [] } as unknown as OrderRecord) !== null, true);
  assert.equal(describeCustomerReviewWork({ reviewStatus: 'in_review', pageArtifacts: [] } as unknown as OrderRecord) !== null, true);
  assert.equal(describeCustomerReviewWork({ reviewStatus: 'customer_changes_requested', pageArtifacts: [] } as unknown as OrderRecord) !== null, true);
  assert.equal(describeCustomerReviewWork({ pageArtifacts: [page(0, { accepted: true })] } as unknown as OrderRecord) !== null, true);
  assert.equal(describeCustomerReviewWork({ pageArtifacts: [page(0, { feedbackHistory: [{ createdAt: 'x', rawText: 'fix', tags: [] }] })] } as unknown as OrderRecord) !== null, true);
  assert.equal(describeCustomerReviewWork({ pageArtifacts: [page(0, { versionHistory: [{} as never, {} as never] })] } as unknown as OrderRecord) !== null, true);
  // Clean failed order (no review work) must NOT be flagged → retry stays allowed.
  assert.equal(describeCustomerReviewWork({ reviewStatus: 'not_started', pageArtifacts: [page(0)] } as unknown as OrderRecord), null);
});

for (const rs of ['approved', 'in_review', 'customer_changes_requested'] as const) {
  test(`retryOrderFulfillment refuses full re-seed for reviewStatus=${rs}`, async (t) => {
    const dir = makeTmp(); t.after(() => cleanup(dir));
    await seed(`ord_retry_${rs}`, {
      fulfillmentStatus: 'failed_manual_review',
      reviewStatus: rs,
      storyArtifactUrl: 'https://cdn/proof.pdf',
      pageArtifacts: [page(0, { accepted: true, acceptedImageUrl: 'https://img/p0.png' }), page(1), page(2)],
    });
    const res = await retryOrderFulfillment(`ord_retry_${rs}`);
    assert.equal(res.ok, false);
    assert.equal((res as { status: number }).status, 409);
    assert.match((res as { error: string }).error, /customer review work/i);
    // State untouched — NOT reset to not_started, pageArtifacts preserved.
    const after = await getOrder(`ord_retry_${rs}`);
    assert.equal(after!.fulfillmentStatus, 'failed_manual_review');
    assert.equal(after!.reviewStatus, rs);
    assert.equal(after!.pageArtifacts!.find((p) => p.pageIndex === 0)!.accepted, true);
  });
}

// ── C2: concurrency ─────────────────────────────────────────────────────────────

test('C2.1 slow regenerate(X) + accept(Y) before regen resolves → both persist', async (t) => {
  const dir = makeTmp(); t.after(() => cleanup(dir));
  await seed('ord_c2_1');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const pRegen = regeneratePage(
    { orderId: 'ord_c2_1', pageIndex: 0, feedback: 'brighten' },
    { generatePageImage: gatedGen('https://img/regen0.png', gate), skipProofRebuild: true },
  );
  await new Promise((r) => setTimeout(r, 20)); // let regen pass entry read + reach the gated generate
  const accY = await acceptPage({ orderId: 'ord_c2_1', pageIndex: 1 });
  assert.equal(accY.ok, true);
  release();
  const r = await pRegen;
  assert.equal(r.ok, true);

  const after = await getOrder('ord_c2_1');
  const p0 = after!.pageArtifacts!.find((p) => p.pageIndex === 0)!;
  const p1 = after!.pageArtifacts!.find((p) => p.pageIndex === 1)!;
  assert.equal(p0.currentImageUrl, 'https://img/regen0.png', 'page 0 regenerated image persisted');
  assert.equal(p0.regenerateCount, 1);
  assert.equal(p1.accepted, true, 'page 1 accept was NOT clobbered by the later regen write');
});

test('C2.2 parallel accept(A) + accept(B) → both persist', async (t) => {
  const dir = makeTmp(); t.after(() => cleanup(dir));
  await seed('ord_c2_2');
  const [a, b] = await Promise.all([
    acceptPage({ orderId: 'ord_c2_2', pageIndex: 0 }),
    acceptPage({ orderId: 'ord_c2_2', pageIndex: 1 }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const after = await getOrder('ord_c2_2');
  assert.equal(after!.pageArtifacts!.find((p) => p.pageIndex === 0)!.accepted, true);
  assert.equal(after!.pageArtifacts!.find((p) => p.pageIndex === 1)!.accepted, true);
  assert.equal(after!.pageArtifacts!.filter((p) => p.accepted).length, 2);
});

test('C2.3 same-page double accept is idempotent', async (t) => {
  const dir = makeTmp(); t.after(() => cleanup(dir));
  await seed('ord_c2_3');
  await acceptPage({ orderId: 'ord_c2_3', pageIndex: 0 });
  await acceptPage({ orderId: 'ord_c2_3', pageIndex: 0 });
  const after = await getOrder('ord_c2_3');
  assert.equal(after!.pageArtifacts!.find((p) => p.pageIndex === 0)!.accepted, true);
  assert.equal(after!.pageArtifacts!.filter((p) => p.accepted).length, 1);
});

test('C2.4 regenerate → approveWholeBook proof reflects the regenerated image', async (t) => {
  const dir = makeTmp(); t.after(() => cleanup(dir));
  await seed('ord_c2_4');
  // Regenerate page 0.
  const open = Promise.resolve();
  const r = await regeneratePage(
    { orderId: 'ord_c2_4', pageIndex: 0, feedback: 'brighten' },
    { generatePageImage: gatedGen('https://img/regen0.png', open), skipProofRebuild: true },
  );
  assert.equal(r.ok, true);
  // Accept all three pages so acceptedImageUrl is set (page 0 → regen url).
  for (const i of [0, 1, 2]) {
    const acc = await acceptPage({ orderId: 'ord_c2_4', pageIndex: i });
    assert.equal(acc.ok, true);
  }
  // Set the proof preconditions (artifact + ack) directly in the store.
  const pre = await getOrder('ord_c2_4');
  await persistOrder({ ...pre!, storyArtifactUrl: 'https://cdn/proof.pdf', proofReviewedAt: '2026-04-26T11:00:00Z' });

  let proofSawRegen = false;
  const res = await approveWholeBook('ord_c2_4', {
    rebuildProof: (async (orderId: string, _deps: unknown, existingOrder?: OrderRecord) => {
      const o = existingOrder ?? (await getOrder(orderId))!;
      const p0 = o.pageArtifacts!.find((p) => p.pageIndex === 0)!;
      proofSawRegen = (p0.acceptedImageUrl ?? p0.currentImageUrl) === 'https://img/regen0.png';
      return { ok: true, proofUrl: 'https://cdn/proof-rebuilt.pdf', updatedOrder: o };
    }) as unknown as Parameters<typeof approveWholeBook>[1]['rebuildProof'],
  });
  assert.equal(res.ok, true, (res as { error?: string }).error);
  assert.equal(proofSawRegen, true, 'proof rebuild used the regenerated image for page 0');
});

test('C2.5 stale approved state inside lock rejects late regenerate/request-changes/accept', async (t) => {
  const dir = makeTmp(); t.after(() => cleanup(dir));
  await seed('ord_c2_5');

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const regen = regeneratePage(
    { orderId: 'ord_c2_5', pageIndex: 0, feedback: 'brighten' },
    { generatePageImage: gatedGen('https://img/regen-after-approve.png', gate), skipProofRebuild: true },
  );
  await new Promise((r) => setTimeout(r, 20));

  const pre = await getOrder('ord_c2_5');
  await persistOrder({ ...pre!, reviewStatus: 'approved' });
  release();

  const regenResult = await regen;
  assert.equal(regenResult.ok, false);
  assert.equal(regenResult.status, 409);
  const afterRegen = await getOrder('ord_c2_5');
  assert.equal(afterRegen!.reviewStatus, 'approved');
  assert.notEqual(afterRegen!.pageArtifacts!.find((p) => p.pageIndex === 0)!.currentImageUrl, 'https://img/regen-after-approve.png');

  const changeResult = await requestPageChanges({ orderId: 'ord_c2_5', pageIndex: 1, note: 'change this' });
  assert.equal(changeResult.ok, false);
  assert.equal(changeResult.status, 409);
  const afterChange = await getOrder('ord_c2_5');
  assert.equal(afterChange!.reviewStatus, 'approved');
  assert.equal(afterChange!.pageArtifacts!.find((p) => p.pageIndex === 1)!.customerRequestedChange, undefined);

  const acceptResult = await acceptPage({ orderId: 'ord_c2_5', pageIndex: 2 });
  assert.equal(acceptResult.ok, false);
  assert.equal(acceptResult.status, 409);
  const afterAccept = await getOrder('ord_c2_5');
  assert.equal(afterAccept!.reviewStatus, 'approved');
  assert.equal(afterAccept!.pageArtifacts!.find((p) => p.pageIndex === 2)!.accepted, false);
});

test('C2.6 approveWholeBook lock blocks concurrent regenerate from changing approved proof state', async (t) => {
  const dir = makeTmp(); t.after(() => cleanup(dir));
  await seed('ord_c2_6');
  for (const i of [0, 1, 2]) {
    const acc = await acceptPage({ orderId: 'ord_c2_6', pageIndex: i });
    assert.equal(acc.ok, true);
  }
  const pre = await getOrder('ord_c2_6');
  await persistOrder({ ...pre!, storyArtifactUrl: 'https://cdn/proof.pdf', proofReviewedAt: '2026-04-26T11:00:00Z' });

  let releaseRebuild!: () => void;
  const rebuildGate = new Promise<void>((r) => { releaseRebuild = r; });
  const approve = approveWholeBook('ord_c2_6', {
    rebuildProof: (async (orderId: string, _deps: unknown, existingOrder?: OrderRecord) => {
      await rebuildGate;
      const o = existingOrder ?? (await getOrder(orderId))!;
      return { ok: true, proofUrl: 'https://cdn/proof-rebuilt.pdf', updatedOrder: o };
    }) as unknown as Parameters<typeof approveWholeBook>[1]['rebuildProof'],
  });
  await new Promise((r) => setTimeout(r, 20));

  const regen = regeneratePage(
    { orderId: 'ord_c2_6', pageIndex: 0, feedback: 'change after approve started' },
    { generatePageImage: gatedGen('https://img/regen-after-approve-started.png', Promise.resolve()), skipProofRebuild: true },
  );
  await new Promise((r) => setTimeout(r, 20));
  releaseRebuild();

  const approveResult = await approve;
  assert.equal(approveResult.ok, true, (approveResult as { error?: string }).error);
  const regenResult = await regen;
  assert.equal(regenResult.ok, false);
  assert.equal(regenResult.status, 409);

  const after = await getOrder('ord_c2_6');
  assert.equal(after!.reviewStatus, 'approved');
  const p0 = after!.pageArtifacts!.find((p) => p.pageIndex === 0)!;
  assert.equal(p0.accepted, true, 'approved order kept accepted page state');
  assert.notEqual(p0.currentImageUrl, 'https://img/regen-after-approve-started.png');
});
