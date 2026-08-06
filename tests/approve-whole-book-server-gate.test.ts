/**
 * Server-side enforcement of the whole-book approval gate. Mirrors the client
 * UX gate but cannot be bypassed by anyone hitting the API directly.
 *
 * Required server-side conditions before approveWholeBook will run:
 *   1. order exists
 *   2. order not already approved
 *   3. all illustrated pages accepted
 *   4. full proof PDF exists (storyArtifactUrl)
 *   5. proofReviewedAt is persisted (acknowledgment endpoint was hit)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, getOrder } from '../src/lib/orders.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { padPageSet } from './support/full-page-set.ts';
import {
  acceptPage,
  acknowledgeProofReview,
  approveWholeBook,
} from '../src/lib/page-review.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-approve-server-gate-'));
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

async function seed(
  overrides: Partial<OrderRecord>,
  id = 'ord_gate_test',
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id, now: '2026-04-27T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    proofApprovalToken: 'tok_xyz',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: null,
    pageArtifacts: padPageSet([
      pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
    ]),
    reviewStatus: 'in_review',
    ...overrides,
  };
  // Proof identity consistent with the seeded pages. Acknowledgment and
  // approval are revision-bound, so a seeded proof URL without an identity
  // would (correctly) fail every gate.
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


// ── 404 / 409 paths ──────────────────────────────────────────────────────────

test('approveWholeBook: rejects unknown order with 404', async () => {
  const dir = makeTmp();
  try {
    const r = await approveWholeBook('ord_does_not_exist');
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally { cleanup(dir); }
});

test('approveWholeBook: rejects when order is already approved (idempotency guard)', async () => {
  const dir = makeTmp();
  try {
    await seed({ reviewStatus: 'approved', proofReviewedAt: '2026-04-26T10:00:00Z' });
    const r = await approveWholeBook('ord_gate_test');
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error ?? '', /already approved/i);
  } finally { cleanup(dir); }
});

test('approveWholeBook: rejects when not all pages accepted', async () => {
  const dir = makeTmp();
  try {
    await seed({
      proofReviewedAt: '2026-04-27T10:00:00Z',
      pageArtifacts: padPageSet([
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: false }), // not accepted
      ]),
    });
    const r = await approveWholeBook('ord_gate_test');
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error ?? '', /All pages must be accepted/i);
  } finally { cleanup(dir); }
});

test('approveWholeBook: rejects when proof PDF is missing (storyArtifactUrl null)', async () => {
  const dir = makeTmp();
  try {
    await seed({
      storyArtifactUrl: null,
      proofReviewedAt: '2026-04-27T10:00:00Z',
    });
    const r = await approveWholeBook('ord_gate_test');
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error ?? '', /proof pdf is not ready/i);
  } finally { cleanup(dir); }
});

test('approveWholeBook: rejects when proof acknowledgment is missing', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const r = await approveWholeBook('ord_gate_test');
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.match(r.error ?? '', /acknowledgment required/i);
  } finally { cleanup(dir); }
});

// ── Happy path ──────────────────────────────────────────────────────────────

test('approveWholeBook: ok when all four conditions satisfied', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: '2026-04-27T10:00:00Z' });
    const r = await approveWholeBook('ord_gate_test');
    assert.equal(r.ok, true);
    // Approval no longer rebuilds: it returns the proof already persisted and
    // acknowledged, not a freshly produced one.
    assert.equal(r.proofUrl, 'https://example.com/proof.pdf');
    assert.equal(r.proofVersion, 'pv_test');
    const after = await getOrder('ord_gate_test');
    assert.equal(after?.reviewStatus, 'approved');
  } finally { cleanup(dir); }
});

// ── Acknowledgment endpoint ──────────────────────────────────────────────────

test('acknowledgeProofReview: persists proofReviewedAt and surfaces it via getOrder', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const r = await acknowledgeProofReview('ord_gate_test', { proofVersion: 'pv_test', now: new Date('2026-04-27T15:00:00Z') });
    assert.equal(r.ok, true);
    assert.equal(r.proofReviewedAt, '2026-04-27T15:00:00.000Z');
    const after = await getOrder('ord_gate_test');
    assert.equal(after?.proofReviewedAt, '2026-04-27T15:00:00.000Z');
  } finally { cleanup(dir); }
});

test('acknowledgeProofReview: idempotent — second call returns the original timestamp', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const r1 = await acknowledgeProofReview('ord_gate_test', { proofVersion: 'pv_test', now: new Date('2026-04-27T10:00:00Z') });
    const r2 = await acknowledgeProofReview('ord_gate_test', { proofVersion: 'pv_test', now: new Date('2026-04-27T11:00:00Z') });
    assert.equal(r1.proofReviewedAt, r2.proofReviewedAt);
  } finally { cleanup(dir); }
});

test('acknowledgeProofReview: 409 when proof PDF does not exist', async () => {
  const dir = makeTmp();
  try {
    await seed({ storyArtifactUrl: null });
    const r = await acknowledgeProofReview('ord_gate_test', { proofVersion: 'pv_test' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    // Acknowledgment now uses a stable code the client branches on:
    // there is no usable proof revision to acknowledge.
    assert.equal(r.error, 'proof_unavailable');
  } finally { cleanup(dir); }
});

test('acknowledgeProofReview: 409 when order already approved', async () => {
  const dir = makeTmp();
  try {
    await seed({ reviewStatus: 'approved', proofReviewedAt: '2026-04-26T00:00:00Z' });
    const r = await acknowledgeProofReview('ord_gate_test', { proofVersion: 'pv_test' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
  } finally { cleanup(dir); }
});

test('acknowledgeProofReview: 404 when order missing', async () => {
  const dir = makeTmp();
  try {
    const r = await acknowledgeProofReview('ord_does_not_exist', { proofVersion: 'pv_test' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  } finally { cleanup(dir); }
});

// ── Full handshake (ack → approve) ──────────────────────────────────────────

test('full handshake: approve fails before ack, succeeds after ack', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const before = await approveWholeBook('ord_gate_test');
    assert.equal(before.ok, false);
    assert.equal(before.status, 409);

    const ack = await acknowledgeProofReview('ord_gate_test', { proofVersion: 'pv_test' });
    assert.equal(ack.ok, true);

    const after = await approveWholeBook('ord_gate_test');
    assert.equal(after.ok, true);
  } finally { cleanup(dir); }
});

// ── Regression: only approveWholeBook can flip reviewStatus to 'approved' ───

test('acceptPage: never flips reviewStatus to approved, even when accepting the last page', async () => {
  const dir = makeTmp();
  try {
    await seed({
      reviewStatus: 'in_review',
      proofReviewedAt: null,
      pageArtifacts: padPageSet([
        { ...mkPage(0), accepted: true, acceptedImageUrl: 'https://x/0.png' },
        { ...mkPage(1), accepted: true, acceptedImageUrl: 'https://x/1.png' },
        mkPage(2),
      ]),
    });
    const r = await acceptPage({ orderId: 'ord_gate_test', pageIndex: 2 });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_gate_test');
    assert.notEqual(after!.reviewStatus, 'approved');
    assert.ok(after!.pageArtifacts!.every((p) => p.accepted));
  } finally { cleanup(dir); }
});

test('approveWholeBook is the only path that sets reviewStatus=approved', async () => {
  const dir = makeTmp();
  try {
    await seed({
      reviewStatus: 'in_review',
      proofReviewedAt: '2026-04-27T11:00:00Z',
      pageArtifacts: padPageSet([
        { ...mkPage(0), accepted: true, acceptedImageUrl: 'https://x/0.png' },
        { ...mkPage(1), accepted: true, acceptedImageUrl: 'https://x/1.png' },
        mkPage(2),
      ]),
    });
    // Accept the last page → must NOT flip to approved.
    await acceptPage({ orderId: 'ord_gate_test', pageIndex: 2 });
    let order = await getOrder('ord_gate_test');
    assert.notEqual(order!.reviewStatus, 'approved');

    // Then approveWholeBook IS allowed to flip it.
    const r = await approveWholeBook('ord_gate_test');
    assert.equal(r.ok, true);
    order = await getOrder('ord_gate_test');
    assert.equal(order!.reviewStatus, 'approved');
  } finally { cleanup(dir); }
});

function mkPage(i: number): PageArtifact {
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
  };
}
