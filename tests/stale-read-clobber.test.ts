/**
 * Regression tests for the stale blob read-modify-write clobber bug.
 *
 * Production incident (2026-05-28, ord_d8ba45c3169b456f):
 *   - regeneratePage() wrote new pageArtifacts (regenerateCount=1, new URL).
 *   - appendAuditEvent() called getOrder() internally → returned a stale
 *     blob snapshot → spread stale order → wrote back regenerateCount=0, old URL.
 *   - acceptPage() wrote accepted=true, then appendAuditEvent() read stale again
 *     → wrote back accepted=false.
 *
 * Fix: updateFulfillmentState, appendAuditEvent, and rebuildProofFromPageArtifacts
 * all accept an optional existingOrder param. regeneratePage/acceptPage thread the
 * just-written record through the call chain so no secondary getOrder() can clobber
 * the state that was just persisted. rebuildProofFromPageArtifacts also carries
 * pageArtifacts explicitly in its own updateFulfillmentState patch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendAuditEvent,
  createOrderRecord,
  getOrder,
  persistOrder,
  updateFulfillmentState,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';
import {
  acceptPage,
  applyAcceptPage,
  approveWholeBook,
  getReviewSnapshot,
  regeneratePage,
} from '../src/lib/page-review.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-staleclobber-'));
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
    storyText: `Page ${i + 1} story.`,
    basePrompt: `prompt for page ${i + 1}`,
    currentImageUrl: `https://example.com/old-${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [
      {
        createdAt: '2026-05-28T18:00:00Z',
        imageUrl: `https://example.com/old-${i}.png`,
        provider: 'gemini',
        model: 'gemini-2.5-flash-image-preview',
        promptUsed: `prompt for page ${i + 1}`,
      },
    ],
    ...overrides,
  };
}

async function seedOrder(id: string, overrides: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'luna@example.com' },
    { id, now: '2026-05-28T18:00:00Z' },
  );
  const generationRouteDecision = {
    route: 'api_disabled_template' as const,
    source: 'template' as const,
    model: 'template:Adventure',
    decidedAt: '2026-05-28T18:00:00Z',
    releasable: true,
    fallbackError: null,
    reason: null,
  };
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    pageArtifacts: [pageFixture(0), pageFixture(1), pageFixture(2)],
    generationRouteDecision,
    auditEvents: [
      {
        at: generationRouteDecision.decidedAt,
        type: 'route_decision_recorded',
        meta: {
          route: generationRouteDecision.route,
          source: generationRouteDecision.source,
          model: generationRouteDecision.model,
          releasable: generationRouteDecision.releasable,
        },
      },
    ],
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const regenProvider: ImageProvider = {
  name: 'gemini',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.com/regenerated-new.png',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image-preview',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};

// ── Main regression test: regen → proof rebuild → accept → reload ────────────

test('regen + proof rebuild + accept: pageArtifacts survive reload (no clobber)', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_clobber_e2e';
    await seedOrder(orderId);

    // Step 1: regenerate page 0
    const regenResult = await regeneratePage(
      { orderId, pageIndex: 0, feedback: 'fix the hands' },
      {
        providers: [regenProvider],
        rebuildProof: async () => ({
          ok: true,
          proofUrl: 'https://example.com/proof-rebuilt.pdf',
        }),
      },
    );
    assert.equal(regenResult.ok, true, 'regeneratePage should succeed');

    // Step 2: accept page 0 (now with the regenerated URL)
    const acceptResult = await acceptPage({ orderId, pageIndex: 0 });
    assert.equal(acceptResult.ok, true, 'acceptPage should succeed');

    // Step 3: fresh read (simulates refresh/reopen review)
    const snapshot = await getReviewSnapshot(orderId);
    assert.ok(snapshot, 'review snapshot should exist');

    const p0 = snapshot!.pageArtifacts.find((p) => p.pageIndex === 0)!;
    assert.ok(p0, 'page 0 should exist in snapshot');

    // Core assertions: regenerated state must survive after accept + reload
    assert.equal(
      p0.currentImageUrl,
      'https://example.com/regenerated-new.png',
      'currentImageUrl must be the regenerated URL, not the original',
    );
    assert.equal(p0.regenerateCount, 1, 'regenerateCount must be 1');
    assert.equal(p0.feedbackHistory.length, 1, 'feedbackHistory must have 1 entry');
    assert.equal(
      p0.versionHistory.length,
      2,
      'versionHistory must include both original and regenerated entries',
    );
    assert.equal(p0.accepted, true, 'page must be accepted');
    assert.equal(
      p0.acceptedImageUrl,
      'https://example.com/regenerated-new.png',
      'acceptedImageUrl must be the regenerated URL',
    );

    // Siblings must be untouched
    const p1 = snapshot!.pageArtifacts.find((p) => p.pageIndex === 1)!;
    assert.equal(p1.currentImageUrl, 'https://example.com/old-1.png');
    assert.equal(p1.regenerateCount, 0);
    assert.equal(p1.accepted, false);

    // Audit events must both be present
    const order = await getOrder(orderId);
    const eventTypes = (order?.auditEvents ?? []).map((e) => e.type);
    assert.ok(eventTypes.includes('page_regenerated'), 'page_regenerated audit event must be present');
    assert.ok(eventTypes.includes('proof_rebuilt'), 'proof_rebuilt audit event must be present');
    assert.ok(eventTypes.includes('page_accepted'), 'page_accepted audit event must be present');
  } finally {
    cleanup(dir);
  }
});

// ── accept-page durability after regenerate (preview QA: ord_rexgemini340967) ─
//
// Repro of the preview bug: regenerate page 0, then accept page 0. A fresh
// review/admin read must show accepted=true with the regenerated image — not a
// reverted accepted=false / stale acceptedImageUrl. Also covers double-accept
// (the QA repro accepted twice) and that regenerate evidence is not reset.

test('accept after regenerate is durable on fresh read; double-accept stays accepted', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_accept_durable';
    await seedOrder(orderId, { reviewStatus: 'customer_changes_requested' });

    // Regenerate page 0 → new image, regenerateCount=1, versionHistory gains an entry.
    const regen = await regeneratePage(
      { orderId, pageIndex: 0, feedback: 'fix the hands' },
      { providers: [regenProvider], rebuildProof: async () => ({ ok: true, proofUrl: 'https://example.com/proof-rebuilt.pdf' }) },
    );
    assert.equal(regen.ok, true);

    // Accept page 0 twice (the QA repro POSTed accept-page twice).
    assert.equal((await acceptPage({ orderId, pageIndex: 0 })).ok, true);
    assert.equal((await acceptPage({ orderId, pageIndex: 0 })).ok, true);

    // Fresh persisted read (review snapshot + raw order) must reflect the accept.
    const snap = await getReviewSnapshot(orderId);
    const p0 = snap!.pageArtifacts.find((p) => p.pageIndex === 0)!;
    assert.equal(p0.accepted, true, 'accepted must survive a fresh read (not revert to false)');
    assert.equal(p0.acceptedImageUrl, 'https://example.com/regenerated-new.png', 'acceptedImageUrl must equal the regenerated currentImageUrl');
    assert.equal(p0.acceptedImageUrl, p0.currentImageUrl, 'acceptedImageUrl must equal currentImageUrl');
    assert.equal(p0.regenerateCount, 1, 'regenerateCount must NOT be reset by accept');
    assert.equal(p0.versionHistory.length, 2, 'versionHistory must NOT be reset by accept');
    assert.equal(p0.feedbackHistory.length, 1, 'feedbackHistory preserved');

    // Audit append did not clobber pageArtifacts; the accept event is present.
    const order = await getOrder(orderId);
    assert.equal(order!.pageArtifacts![0].accepted, true, 'raw order read also shows accepted=true (audit append did not clobber)');
    assert.equal(order!.pageArtifacts![0].acceptedImageUrl, 'https://example.com/regenerated-new.png');
    assert.ok((order!.auditEvents ?? []).some((e) => e.type === 'page_accepted'), 'page_accepted audit event present');

    // Sibling page untouched.
    const p1 = snap!.pageArtifacts.find((p) => p.pageIndex === 1)!;
    assert.equal(p1.accepted, false);
    assert.equal(p1.currentImageUrl, 'https://example.com/old-1.png');
  } finally {
    cleanup(dir);
  }
});

// ── acceptPage/requestPageChanges must pass a fresh record into writes ────────
//
// Source-level guard: on a consistent test store the second getOrder() returns
// the same snapshot, so the stale-read fix is only observable under real blob
// lag. The cross-request hardening now re-reads `latest` inside an order lock;
// this assertion prevents dropping the existingOrder arg or lock by accident.

test('acceptPage threads latest locked order into updateFulfillmentState (no un-hinted re-read)', () => {
  const src = readFileSync(new URL('../src/lib/page-review.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function acceptPage'), src.indexOf('export async function requestPageChanges'));
  assert.ok(fn.length > 0, 'acceptPage body located');
  assert.match(fn, /withOrderWriteLock\(input\.orderId,\s*async \(\) =>/);
  // The accept persistence write must pass `latest` as existingOrder.
  assert.match(fn, /updateFulfillmentState\(\s*order\.id,\s*\{\s*pageArtifacts:\s*artifacts\s*\}\s*,\s*latest\s*\)/);
  // It must NOT use the un-hinted two-arg form that re-reads stale blob state.
  assert.doesNotMatch(fn, /updateFulfillmentState\(\s*order\.id,\s*\{\s*pageArtifacts:\s*artifacts\s*\}\s*\)/);
});

test('requestPageChanges threads latest locked order into updateFulfillmentState (no un-hinted re-read)', () => {
  const src = readFileSync(new URL('../src/lib/page-review.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function requestPageChanges'), src.indexOf('export async function', src.indexOf('export async function requestPageChanges') + 1));
  assert.ok(fn.length > 0, 'requestPageChanges body located');
  assert.match(fn, /withOrderWriteLock\(input\.orderId,\s*async \(\) =>/);
  // The change-request write must pass `latest` as existingOrder.
  assert.match(fn, /updateFulfillmentState\(\s*order\.id,\s*\{[\s\S]*?reviewStatus:\s*'customer_changes_requested',[\s\S]*?proofReviewedAt:\s*null,?\s*\}\s*,\s*latest\s*\)/);
  // It must NOT use the un-hinted form (no third arg) for that write.
  assert.doesNotMatch(fn, /updateFulfillmentState\(\s*order\.id,\s*\{[\s\S]*?proofReviewedAt:\s*null,?\s*\}\s*\)\s*;/);
});

// ── accept-page stale-read guard (fix-sensitive) ──────────────────────────────
//
// acceptPage now threads its fresh `order` into updateFulfillmentState so the
// helper does NOT do a second getOrder() that returns a stale blob snapshot.
// Mirrors the appendAuditEvent stale-read test below: we drive the exact accept
// persistence pattern and overwrite disk with a stale snapshot to prove the
// fixed (existingOrder) path keeps fresh state while the unfixed (no
// existingOrder) path is built from the stale re-read.

test('stale-read: acceptPage updateFulfillmentState with existingOrder ignores stale disk', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_accept_stale';
    const original = await seedOrder(orderId, { storyArtifactUrl: 'https://example.com/OLD-proof.pdf' });

    // Fresh post-regenerate snapshot (what acceptPage's top read returns).
    const fresh: OrderRecord = {
      ...original,
      storyArtifactUrl: 'https://example.com/REGEN-proof.pdf',
      reviewStatus: 'customer_changes_requested',
      pageArtifacts: [
        {
          ...original.pageArtifacts![0]!,
          currentImageUrl: 'https://example.com/regen.png',
          regenerateCount: 1,
          versionHistory: [
            ...original.pageArtifacts![0]!.versionHistory,
            { createdAt: '2026-06-05T12:00:00Z', imageUrl: 'https://example.com/regen.png', provider: 'gemini', model: 'm', promptUsed: 'regen' },
          ],
        },
        ...original.pageArtifacts!.slice(1),
      ],
    };
    await persistOrder(fresh);
    const { artifacts } = applyAcceptPage(fresh.pageArtifacts!, 0);

    // --- UNFIXED: no existingOrder → updateFulfillmentState re-reads stale disk ---
    await persistOrder({ ...original, storyArtifactUrl: 'https://example.com/OLD-proof.pdf' }); // stale blob
    const savedUnfixed = await updateFulfillmentState(orderId, { pageArtifacts: artifacts });
    assert.equal(
      savedUnfixed!.storyArtifactUrl,
      'https://example.com/OLD-proof.pdf',
      'UNFIXED: savedOrder built from stale re-read (regen proof URL clobbered) — demonstrates the bug class',
    );

    // --- FIXED: pass the fresh order → no stale re-read ---
    await persistOrder(fresh); // restore correct state
    await persistOrder({ ...original, storyArtifactUrl: 'https://example.com/OLD-proof.pdf' }); // stale blob again
    const savedFixed = await updateFulfillmentState(orderId, { pageArtifacts: artifacts }, fresh);
    assert.equal(
      savedFixed!.storyArtifactUrl,
      'https://example.com/REGEN-proof.pdf',
      'FIXED: existingOrder pins the fresh snapshot — regen proof URL preserved',
    );
    const fp0 = savedFixed!.pageArtifacts![0];
    assert.equal(fp0.accepted, true);
    assert.equal(fp0.acceptedImageUrl, 'https://example.com/regen.png');
    assert.equal(fp0.currentImageUrl, 'https://example.com/regen.png');
    assert.equal(fp0.regenerateCount, 1, 'regenerateCount preserved');
    assert.equal(fp0.versionHistory.length, 2, 'versionHistory preserved');
  } finally {
    cleanup(dir);
  }
});

// ── Stale-read simulation ─────────────────────────────────────────────────────
//
// In production, Vercel Blob can return a cached/stale snapshot on a read
// immediately after a write. We simulate this by:
//   1. Writing new pageArtifacts to disk (the regen write).
//   2. Then manually overwriting disk with the OLD (stale) snapshot (simulating
//      the blob cache returning the old version).
//   3. Calling appendAuditEvent WITHOUT existingOrder → it reads stale disk →
//      clobbers the new pageArtifacts (demonstrates the bug).
//   4. Reset, repeat step 1 and 2, but call WITH existingOrder (the fix) →
//      it uses the fresh record → pageArtifacts are preserved.

test('stale-read simulation: appendAuditEvent with existingOrder prevents clobber', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_stale_sim';
    const originalOrder = await seedOrder(orderId);
    const originalArtifacts = originalOrder.pageArtifacts!;

    // Write new pageArtifacts (simulating what regeneratePage's updateFulfillmentState does)
    const newArtifacts: PageArtifact[] = [
      {
        ...originalArtifacts[0]!,
        currentImageUrl: 'https://example.com/new-regen.png',
        regenerateCount: 1,
        feedbackHistory: [
          {
            createdAt: '2026-05-28T18:47:59Z',
            rawText: 'fix hands',
            tags: ['hands'],
            success: true,
          },
        ],
        versionHistory: [
          ...originalArtifacts[0]!.versionHistory,
          {
            createdAt: '2026-05-28T18:47:59Z',
            imageUrl: 'https://example.com/new-regen.png',
            provider: 'gemini',
            model: 'gemini-2.5-flash-image-preview',
            promptUsed: 'regen prompt',
          },
        ],
      },
      ...originalArtifacts.slice(1),
    ];
    const savedOrder = await updateFulfillmentState(orderId, { pageArtifacts: newArtifacts });
    assert.ok(savedOrder, 'updateFulfillmentState must return the updated order');
    assert.equal(
      savedOrder!.pageArtifacts![0].currentImageUrl,
      'https://example.com/new-regen.png',
      'savedOrder must reflect the new imageUrl',
    );

    // --- UNFIXED PATH SIMULATION ---
    // Simulate blob cache returning stale: overwrite disk with original state.
    await persistOrder({ ...originalOrder, auditEvents: [] });

    // appendAuditEvent without existingOrder: reads stale disk → clobbers new pageArtifacts.
    await appendAuditEvent(orderId, { type: 'page_regenerated', pageIndex: 0 });
    const afterUnfixed = await getOrder(orderId);
    // The stale snapshot had the old currentImageUrl → should be clobbered back
    assert.equal(
      afterUnfixed!.pageArtifacts![0].currentImageUrl,
      'https://example.com/old-0.png',
      'UNFIXED: stale read clobbers new imageUrl back to old (demonstrates the bug)',
    );
    assert.equal(
      afterUnfixed!.pageArtifacts![0].regenerateCount,
      0,
      'UNFIXED: stale read clobbers regenerateCount back to 0',
    );

    // --- FIXED PATH SIMULATION ---
    // Write the new state back to disk (restore correct state).
    await persistOrder({
      ...savedOrder!,
      auditEvents: [],
    });

    // Simulate blob cache returning stale again: overwrite disk with original state.
    await persistOrder({ ...originalOrder, auditEvents: [] });

    // appendAuditEvent WITH existingOrder (the fix): uses savedOrder, ignores stale disk.
    await appendAuditEvent(
      orderId,
      { type: 'page_regenerated', pageIndex: 0 },
      savedOrder ?? undefined, // <-- the fix: pass the fresh record
    );
    const afterFixed = await getOrder(orderId);
    // The fix must have used savedOrder's pageArtifacts, not the stale disk state
    assert.equal(
      afterFixed!.pageArtifacts![0].currentImageUrl,
      'https://example.com/new-regen.png',
      'FIXED: existingOrder prevents clobber — new imageUrl is preserved',
    );
    assert.equal(
      afterFixed!.pageArtifacts![0].regenerateCount,
      1,
      'FIXED: existingOrder prevents clobber — regenerateCount=1 is preserved',
    );
    assert.equal(
      afterFixed!.pageArtifacts![0].feedbackHistory.length,
      1,
      'FIXED: feedbackHistory preserved',
    );
  } finally {
    cleanup(dir);
  }
});

// ── rebuildProofFromPageArtifacts stale-read guard ────────────────────────────

test('rebuildProofFromPageArtifacts with existingOrder uses fresh pageArtifacts', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_rebuild_stale';
    const originalOrder = await seedOrder(orderId);
    const newArtifacts: PageArtifact[] = [
      {
        ...originalOrder.pageArtifacts![0]!,
        currentImageUrl: 'https://example.com/regen-for-rebuild.png',
        regenerateCount: 1,
      },
      ...originalOrder.pageArtifacts!.slice(1),
    ];
    const freshOrder: OrderRecord = {
      ...originalOrder,
      pageArtifacts: newArtifacts,
      reviewStatus: 'customer_changes_requested',
    };

    // Simulate blob cache stale: disk still has original state (getOrder() returns old)
    // but we pass freshOrder as existingOrder so the rebuild uses the correct artifacts.
    const { rebuildProofFromPageArtifacts } = await import('../src/lib/fulfillment.ts');

    let capturedUrls: (string | null)[] = [];
    const rb = await rebuildProofFromPageArtifacts(
      orderId,
      {
        buildPdf: async (_story, _order, urls) => {
          capturedUrls = urls;
          return Buffer.from('%PDF-1.4 rebuilt');
        },
        uploadArtifact: async (id, _buf, name) => `https://cdn.example.com/${id}/${name}`,
      },
      freshOrder, // existingOrder — the fix
    );
    assert.equal(rb.ok, true, 'rebuild must succeed');

    // Verify rebuild used the fresh (regen'd) URL, not the original stale one
    const regenUrl = 'https://example.com/regen-for-rebuild.png';
    assert.ok(
      capturedUrls.some((u) => u === regenUrl),
      `PDF builder must receive the regenerated URL (${regenUrl}), got: ${JSON.stringify(capturedUrls)}`,
    );

    // Verify persisted order retains the new pageArtifacts (not clobbered to original)
    const after = await getOrder(orderId);
    assert.equal(
      after!.pageArtifacts![0].currentImageUrl,
      regenUrl,
      'persisted pageArtifacts must reflect the fresh order, not the stale disk state',
    );
    assert.ok(after!.storyArtifactUrl?.includes('-proof.pdf'), 'proof URL must be written');
    assert.equal(after!.proofReviewedAt, null, 'proofReviewedAt must be cleared by rebuild');

    // updatedOrder in result should carry the final state
    assert.ok(rb.updatedOrder, 'result must include updatedOrder');
    assert.equal(rb.updatedOrder!.pageArtifacts![0].currentImageUrl, regenUrl);
  } finally {
    cleanup(dir);
  }
});

test('rebuildProofFromPageArtifacts ignores mismatched existingOrder ids', async () => {
  const dir = makeTmp();
  try {
    const targetId = 'ord_rebuild_target';
    const wrongId = 'ord_rebuild_wrong';
    const targetOrder = await seedOrder(targetId);
    const wrongOrder = await seedOrder(wrongId, {
      pageArtifacts: [pageFixture(0, { currentImageUrl: 'https://example.com/wrong-order.png' })],
    });
    const { rebuildProofFromPageArtifacts } = await import('../src/lib/fulfillment.ts');

    let capturedUrls: (string | null)[] = [];
    const rb = await rebuildProofFromPageArtifacts(
      targetId,
      {
        buildPdf: async (_story, _order, urls) => {
          capturedUrls = urls;
          return Buffer.from('%PDF-1.4 rebuilt');
        },
        uploadArtifact: async (id, _buf, name) => `https://cdn.example.com/${id}/${name}`,
      },
      wrongOrder,
    );

    assert.equal(rb.ok, true);
    assert.equal(capturedUrls[0], targetOrder.pageArtifacts![0]!.currentImageUrl);
    assert.notEqual(capturedUrls[0], wrongOrder.pageArtifacts![0]!.currentImageUrl);
    const afterTarget = await getOrder(targetId);
    const afterWrong = await getOrder(wrongId);
    assert.ok(afterTarget!.storyArtifactUrl?.includes(targetId));
    assert.equal(afterWrong!.storyArtifactUrl ?? null, null);
  } finally {
    cleanup(dir);
  }
});

// ── Rebuild failure path stale-read guard ─────────────────────────────────────

test('regen proof-rebuild exception path preserves regenerated artifacts under stale read', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_rebuild_throw_stale';
    const originalOrder = await seedOrder(orderId);

    const regenResult = await regeneratePage(
      { orderId, pageIndex: 0, feedback: 'fix the hands' },
      {
        providers: [regenProvider],
        rebuildProof: async () => {
          // Simulate blob cache staleness exactly before the catch-path audit write.
          await persistOrder({ ...originalOrder, auditEvents: [] });
          throw new Error('pdf builder down');
        },
      },
    );

    assert.equal(regenResult.ok, true, 'image regen still succeeds when proof rebuild throws');
    assert.equal(regenResult.proofRefreshed, false);
    assert.match(regenResult.proofRefreshError ?? '', /pdf builder down/);

    const after = await getOrder(orderId);
    const p0 = after!.pageArtifacts![0]!;
    assert.equal(p0.currentImageUrl, 'https://example.com/regenerated-new.png');
    assert.equal(p0.regenerateCount, 1);
    assert.equal(p0.feedbackHistory.length, 1);
    assert.ok((after!.auditEvents ?? []).some((e) => e.type === 'proof_rebuilt' && e.reason === 'pdf builder down'));
  } finally {
    cleanup(dir);
  }
});

// ── Whole-book approval stale-read guard ──────────────────────────────────────

test('approveWholeBook threads rebuilt proof state through audit + approved writes', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_approve_stale';
    const acceptedArtifacts = [0, 1, 2].map((i) =>
      pageFixture(i, {
        accepted: true,
        acceptedImageUrl: `https://example.com/accepted-${i}.png`,
        currentImageUrl: `https://example.com/accepted-${i}.png`,
      }),
    );
    const originalOrder = await seedOrder(orderId, {
      pageArtifacts: acceptedArtifacts,
      storyArtifactUrl: 'https://example.com/old-proof.pdf',
      proofReviewedAt: '2026-05-28T18:30:00Z',
    });

    const rebuiltProofUrl = 'https://example.com/rebuilt-proof.pdf';
    const approveResult = await approveWholeBook(orderId, {
      rebuildProof: async (_id, _deps, existingOrder) => {
        assert.equal(
          existingOrder?.id,
          orderId,
          'approveWholeBook must pass its already-gated fresh order into rebuildProof',
        );
        const rebuiltOrder = await updateFulfillmentState(
          orderId,
          {
            storyArtifactUrl: rebuiltProofUrl,
            proofReviewedAt: null,
            pageArtifacts: acceptedArtifacts,
          },
          originalOrder,
        );
        assert.ok(rebuiltOrder, 'test setup should write rebuilt proof state');
        // Simulate stale blob read between rebuild write and approval/audit writes.
        await persistOrder({ ...originalOrder, auditEvents: [] });
        return { ok: true, proofUrl: rebuiltProofUrl, updatedOrder: rebuiltOrder! };
      },
    });

    assert.equal(approveResult.ok, true);
    assert.equal(approveResult.proofUrl, rebuiltProofUrl);

    const after = await getOrder(orderId);
    assert.equal(after!.storyArtifactUrl, rebuiltProofUrl, 'rebuilt proof URL must survive stale reads');
    assert.equal(after!.proofReviewedAt, null, 'rebuilt proof ack invalidation must survive stale reads');
    assert.equal(after!.reviewStatus, 'approved');
    assert.equal(after!.pageArtifacts![0]!.acceptedImageUrl, 'https://example.com/accepted-0.png');
    const eventTypes = (after!.auditEvents ?? []).map((e) => e.type);
    assert.ok(eventTypes.includes('proof_rebuilt'));
    assert.ok(eventTypes.includes('whole_book_approved'));
  } finally {
    cleanup(dir);
  }
});

// ── Full sequence with real proof rebuild dep ─────────────────────────────────

test('regen → real-rebuild → accept: all state consistent after each step', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_full_sequence';
    await seedOrder(orderId, {
      storyArtifactUrl: 'https://example.com/original-proof.pdf',
      proofReviewedAt: '2026-05-28T18:00:00Z',
    });

    // Regen page 1 with auto-rebuild that writes a new proof URL
    const regenResult = await regeneratePage(
      { orderId, pageIndex: 1, feedback: 'brighter background' },
      {
        providers: [regenProvider],
        rebuildProof: async () => ({
          ok: true,
          proofUrl: 'https://example.com/proof-after-regen.pdf',
        }),
      },
    );
    assert.equal(regenResult.ok, true);
    assert.equal(regenResult.proofRefreshed, true);

    // Accept page 1
    const acceptResult = await acceptPage({ orderId, pageIndex: 1 });
    assert.equal(acceptResult.ok, true);

    // Final state check
    const order = await getOrder(orderId);
    const p1 = order!.pageArtifacts!.find((p) => p.pageIndex === 1)!;

    assert.equal(p1.currentImageUrl, 'https://example.com/regenerated-new.png');
    assert.equal(p1.regenerateCount, 1);
    assert.equal(p1.accepted, true);
    assert.equal(p1.acceptedImageUrl, 'https://example.com/regenerated-new.png');
    assert.equal(p1.feedbackHistory.length, 1);
    assert.equal(p1.versionHistory.length, 2, 'both original and regen entries in versionHistory');

    // Siblings untouched
    const p0 = order!.pageArtifacts!.find((p) => p.pageIndex === 0)!;
    assert.equal(p0.currentImageUrl, 'https://example.com/old-0.png');
    assert.equal(p0.regenerateCount, 0);
    assert.equal(p0.accepted, false);

    // Audit trail complete
    const eventTypes = (order!.auditEvents ?? []).map((e) => e.type);
    assert.ok(eventTypes.includes('page_regenerated'));
    assert.ok(eventTypes.includes('proof_rebuilt'));
    assert.ok(eventTypes.includes('page_accepted'));

    // reviewStatus correctly set by regen
    assert.equal(order!.reviewStatus, 'customer_changes_requested');
  } finally {
    cleanup(dir);
  }
});
