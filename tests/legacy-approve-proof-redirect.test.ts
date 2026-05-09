/**
 * Legacy /api/order/[orderId]/approve-proof endpoint is retired as a one-click
 * approval path. Stale customer emails that still hit it must redirect into
 * /review/<orderId>?token=... (the modern review surface) — no direct approval.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GET } from '../src/app/api/order/[orderId]/approve-proof/route.ts';
import {
  createOrderRecord,
  persistOrder,
  getOrder,
  type OrderRecord,
} from '../src/lib/orders.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-legacy-approve-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function seed(overrides: Partial<OrderRecord> = {}, id = 'ord_legacy_1'): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id, now: '2026-04-27T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    proofApprovalToken: 'tok_legacy',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof-v1.pdf',
    proofReviewedAt: null,
    reviewStatus: 'in_review',
    pageArtifacts: [
      { pageIndex: 0, storyText: 'P1', basePrompt: 'p', currentImageUrl: 'https://x/0.png', acceptedImageUrl: 'https://x/0.png', generationProvider: null, generationModel: null, regenerateCount: 0, accepted: true, feedbackHistory: [], versionHistory: [] },
    ],
    auditEvents: [],
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

function call(orderId: string, queryString: string) {
  const url = `https://hsb.example.com/api/order/${orderId}/approve-proof${queryString}`;
  const request = new Request(url);
  return GET(request, { params: Promise.resolve({ orderId }) });
}

test('legacy approve-proof: with token → 302 redirect to /review/<orderId>?token=<token>', async () => {
  const dir = makeTmp();
  try {
    process.env.NEXT_PUBLIC_URL = 'https://hsb.example.com';
    await seed();
    const res = await call('ord_legacy_1', '?token=tok_legacy');
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.equal(location, 'https://hsb.example.com/review/ord_legacy_1?token=tok_legacy');
  } finally {
    delete process.env.NEXT_PUBLIC_URL;
    cleanup(dir);
  }
});

test('legacy approve-proof: with token → does NOT approve the book (reviewStatus stays in_review)', async () => {
  const dir = makeTmp();
  try {
    await seed();
    const before = await getOrder('ord_legacy_1');
    assert.equal(before?.reviewStatus, 'in_review');

    await call('ord_legacy_1', '?token=tok_legacy');

    const after = await getOrder('ord_legacy_1');
    // The hardened gate must remain — no acknowledgment was given, no whole-
    // book approval call was made, so the order is still in_review.
    assert.equal(after?.reviewStatus, 'in_review');
    assert.equal(after?.proofReviewedAt, null);
    assert.equal(after?.proofApprovedAt ?? null, null);
    assert.equal(after?.fulfillmentStatus, 'proof_ready');
  } finally {
    cleanup(dir);
  }
});

test('legacy approve-proof: without token → 302 redirect to /review/<orderId> (no dead-end)', async () => {
  const dir = makeTmp();
  try {
    process.env.NEXT_PUBLIC_URL = 'https://hsb.example.com';
    await seed();
    const res = await call('ord_legacy_1', '');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://hsb.example.com/review/ord_legacy_1');
  } finally {
    delete process.env.NEXT_PUBLIC_URL;
    cleanup(dir);
  }
});

test('legacy approve-proof: token is URL-encoded so weird characters do not break the redirect', async () => {
  const dir = makeTmp();
  try {
    process.env.NEXT_PUBLIC_URL = 'https://hsb.example.com';
    await seed();
    const res = await call('ord_legacy_1', '?token=abc%20def%2Bghi');
    assert.equal(res.status, 302);
    // searchParams.get already decodes; the redirect re-encodes for safety.
    const location = res.headers.get('location') ?? '';
    assert.match(location, /\/review\/ord_legacy_1\?token=abc/);
  } finally {
    delete process.env.NEXT_PUBLIC_URL;
    cleanup(dir);
  }
});

test('legacy approve-proof: works for an order that does not exist (still redirects, no leakage)', async () => {
  const dir = makeTmp();
  try {
    process.env.NEXT_PUBLIC_URL = 'https://hsb.example.com';
    const res = await call('ord_does_not_exist', '?token=anything');
    // We deliberately don't 404 here — the review page handles the missing-
    // order case with a customer-friendly message and avoids leaking whether
    // an order id exists.
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location') ?? '', /\/review\/ord_does_not_exist\?token=anything/);
  } finally {
    delete process.env.NEXT_PUBLIC_URL;
    cleanup(dir);
  }
});
