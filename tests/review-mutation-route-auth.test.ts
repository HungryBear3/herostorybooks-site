/**
 * Route-level authorization for every customer review mutation.
 *
 * Route handlers pull `next/server` and can't run in the plain node test
 * runner, so these tests exercise the exact composition each route uses —
 * the shared server-side `authorizeCustomerReviewWrite` gate followed by the
 * service function — with real `Request` objects. The live HTTP routes are
 * additionally smoke-tested against `next dev` during verification.
 *
 * Proven for accept / regenerate / acknowledge / request-wording-change /
 * approve: a missing or invalid token is rejected (403) and no order state is
 * mutated; a valid token reaches the normal operation-specific behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, getOrder, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { authorizeCustomerReviewWrite } from '../src/lib/review-route-auth.ts';
import {
  acceptPage,
  regeneratePage,
  acknowledgeProofReview,
  approveWholeBook,
  saveTextChangeRequest,
} from '../src/lib/page-review.ts';

const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'a1b2'.repeat(12); // 48 hex chars — shape-valid stand-in
const BAD_TOKEN = 'f9e8'.repeat(12);

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-route-auth-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    characterAnchor: 'a',
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: `https://example.com/p${i}.png`,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...o,
  };
}

async function seed(id: string, o: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Testkid', bookFormat: 'digital', email: 'a@b.com' }, { id, now: NOW }),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: null,
    proofApprovalToken: TOKEN,
    pageArtifacts: [page(0), page(1)],
    ...o,
  };
  await persistOrder(order);
  return order;
}

function req(orderId: string, token?: string): Request {
  const qs = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
  return new Request(`http://test.local/api/order/${orderId}/mutation${qs}`, { method: 'POST' });
}

// Route composition: authorize first, then run the service (mirrors every route).
async function routed<T>(
  orderId: string,
  token: string | undefined,
  service: () => Promise<T>,
): Promise<{ status: number; error?: string } | T> {
  const auth = await authorizeCustomerReviewWrite(req(orderId, token), orderId);
  if (!auth.ok) return { status: auth.status ?? 403, error: auth.error };
  return service();
}

// ── The authorizer itself ────────────────────────────────────────────────────

test('authorizer: bare id / missing / invalid token rejected; valid accepted; missing order 404', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_auth');
    assert.equal((await authorizeCustomerReviewWrite(req('ord_auth', undefined), 'ord_auth')).status, 403);
    assert.equal((await authorizeCustomerReviewWrite(req('ord_auth', ''), 'ord_auth')).status, 403);
    assert.equal((await authorizeCustomerReviewWrite(req('ord_auth', BAD_TOKEN), 'ord_auth')).status, 403);
    assert.equal((await authorizeCustomerReviewWrite(req('ord_auth', TOKEN), 'ord_auth')).ok, true);
    assert.equal((await authorizeCustomerReviewWrite(req('ord_missing', TOKEN), 'ord_missing')).status, 404);

    // An order with no prepared token cannot be customer-written even with a token value.
    await seed('ord_untokened', { proofApprovalToken: null });
    assert.equal((await authorizeCustomerReviewWrite(req('ord_untokened', TOKEN), 'ord_untokened')).status, 403);
  } finally {
    cleanup(dir);
  }
});

// ── Per-mutation: reject without/with-bad token (no mutation), accept with valid ──

test('accept-page: token-gated; no mutation on rejection; valid token accepts', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_accept', { pageArtifacts: [page(0, { accepted: false }), page(1)] });
    for (const t of [undefined, BAD_TOKEN]) {
      const r = await routed('ord_accept', t, () => acceptPage({ orderId: 'ord_accept', pageIndex: 0 }));
      assert.equal((r as { status: number }).status, 403);
    }
    const after = await getOrder('ord_accept');
    assert.equal(after?.pageArtifacts?.[0].accepted, false, 'rejected accept must not persist');

    const ok = await routed('ord_accept', TOKEN, () => acceptPage({ orderId: 'ord_accept', pageIndex: 0 }));
    assert.equal((ok as { ok: boolean }).ok, true);
    assert.equal((await getOrder('ord_accept'))?.pageArtifacts?.[0].accepted, true);
  } finally {
    cleanup(dir);
  }
});

test('request-text-change: token-gated; no mutation on rejection; valid token records', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_rtc');
    for (const t of [undefined, BAD_TOKEN]) {
      const r = await routed('ord_rtc', t, () =>
        saveTextChangeRequest({ orderId: 'ord_rtc', pageIndex: 0, note: 'hi', reviewToken: t }));
      assert.equal((r as { status: number }).status, 403);
    }
    const after = await getOrder('ord_rtc');
    assert.equal(after?.pageArtifacts?.[0].customerRequestedChange ?? null, null, 'rejected save must not persist');

    const ok = await routed('ord_rtc', TOKEN, () =>
      saveTextChangeRequest({ orderId: 'ord_rtc', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) }));
    assert.equal((ok as { ok: boolean }).ok, true);
    assert.equal((await getOrder('ord_rtc'))?.pageArtifacts?.[0].customerReviewStatus, 'changes_requested');
  } finally {
    cleanup(dir);
  }
});

test('acknowledge-proof: token-gated; no mutation on rejection; valid token acks', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_ack');
    for (const t of [undefined, BAD_TOKEN]) {
      const r = await routed('ord_ack', t, () => acknowledgeProofReview('ord_ack', new Date(NOW)));
      assert.equal((r as { status: number }).status, 403);
    }
    assert.equal((await getOrder('ord_ack'))?.proofReviewedAt ?? null, null, 'rejected ack must not persist');

    const ok = await routed('ord_ack', TOKEN, () => acknowledgeProofReview('ord_ack', new Date(NOW)));
    assert.equal((ok as { ok: boolean }).ok, true);
    assert.equal((await getOrder('ord_ack'))?.proofReviewedAt, NOW);
  } finally {
    cleanup(dir);
  }
});

test('approve-whole-book: token-gated; no mutation on rejection; valid token reaches gate', async () => {
  const dir = makeTmp();
  try {
    // proofReviewedAt null → approve reaches the proof_ack_missing gate (no rebuild).
    await seed('ord_apr', { proofReviewedAt: null });
    for (const t of [undefined, BAD_TOKEN]) {
      const r = await routed('ord_apr', t, () => approveWholeBook('ord_apr'));
      assert.equal((r as { status: number }).status, 403);
    }
    assert.notEqual((await getOrder('ord_apr'))?.reviewStatus, 'approved');

    const gated = await routed('ord_apr', TOKEN, () => approveWholeBook('ord_apr'));
    assert.equal((gated as { ok: boolean }).ok, false);
    assert.equal((gated as { status: number }).status, 409); // proof_ack_missing — auth passed
    assert.notEqual((await getOrder('ord_apr'))?.reviewStatus, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('regenerate-page: token-gated; no mutation on rejection; valid token reaches validation', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_regen');
    for (const t of [undefined, BAD_TOKEN]) {
      const r = await routed('ord_regen', t, () => regeneratePage({ orderId: 'ord_regen', pageIndex: 0, feedback: 'x' }));
      assert.equal((r as { status: number }).status, 403);
    }
    const after = await getOrder('ord_regen');
    assert.equal(after?.pageArtifacts?.[0].regenerateCount, 0, 'rejected regen must not persist');

    // Valid token + invalid page index → 400 from the service's pre-flight,
    // BEFORE any image provider is invoked (proves auth passed, offline).
    const reached = await routed('ord_regen', TOKEN, () => regeneratePage({ orderId: 'ord_regen', pageIndex: 999, feedback: 'x' }));
    assert.equal((reached as { ok: boolean }).ok, false);
    assert.equal((reached as { status: number }).status, 400);
  } finally {
    cleanup(dir);
  }
});
