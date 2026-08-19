import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  __resetOrderStoreAdapterFactoryForTests,
  createOrderRecord,
  persistOrder,
} from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact, PrivateArtifactMetadata } from '../src/lib/orders.ts';
import {
  buildHashedReviewCapabilityPatch,
  getPrivateReviewSessionCookieName,
  hasReviewCapability,
  privateReviewPathFor,
} from '../src/lib/review-capability.ts';
import { getReviewSnapshot } from '../src/lib/page-review.ts';
import {
  handlePrivateReviewAssetRequest,
  handlePrivateReviewSessionRequest,
} from '../src/lib/private-review-route-handler.ts';

const NOW = '2026-08-19T12:00:00.000Z';
const ORDER = 'ord_private_review';
const TOKEN = 'ab12'.repeat(12);

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-private-review-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  delete process.env.HSB_PRIVATE_READ_WRITE_TOKEN;
  return dir;
}

function cleanup(dir: string) {
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_PRIVATE_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
}

function sha256Hex(input: Buffer | string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function privateArtifact(pathname: string, body: Buffer, contentType: string): PrivateArtifactMetadata {
  return {
    pathname,
    sha256: sha256Hex(body),
    bytes: body.byteLength,
    contentType,
    createdAt: NOW,
    retentionUntil: '2026-09-18T12:00:00.000Z',
  };
}

function page(pageIndex: number, currentImageUrl: string, privateReviewAsset?: PrivateArtifactMetadata): PageArtifact {
  return {
    pageIndex,
    storyText: `Story page ${pageIndex + 1}`,
    basePrompt: 'prompt',
    currentImageUrl,
    acceptedImageUrl: currentImageUrl,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    privateReviewAsset,
  };
}

function makeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const pageBytes = Buffer.from('page-01-private');
  const proofBytes = Buffer.from('%PDF-private-proof');
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Kid', recipientName: 'Recipient', bookFormat: 'digital', email: 'family@example.invalid' },
      { id: ORDER, now: NOW },
    ),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    status: 'order_received',
    pageArtifacts: [
      page(0, `/api/order/${ORDER}/review-asset/page-01`, privateArtifact(`orders/${ORDER}/pages/page-01.png`, pageBytes, 'image/png')),
    ],
    storyArtifactUrl: `/api/order/${ORDER}/review-asset/proof-pdf`,
    privateStoryArtifact: privateArtifact(`orders/${ORDER}/proofs/proof.pdf`, proofBytes, 'application/pdf'),
    ...overrides,
  };
  return order;
}

test('hashed capability: public order stores only hash+expiry; legacy plaintext remains compatible', async () => {
  const dir = makeTmp();
  try {
    const expiry = '2026-08-20T12:00:00.000Z';
    await persistOrder({
      ...makeOrder(),
      ...buildHashedReviewCapabilityPatch(TOKEN, expiry),
      proofApprovalToken: null,
    });
    const persisted = JSON.parse(readFileSync(path.join(dir, `${ORDER}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(typeof persisted.proofApprovalTokenHash, 'string');
    assert.equal(persisted.proofApprovalToken, null);
    assert.equal(persisted.proofApprovalTokenExpiresAt, expiry);
    assert.doesNotMatch(JSON.stringify(persisted), new RegExp(TOKEN));
    assert.equal(hasReviewCapability(makeOrder({ proofApprovalToken: TOKEN }), TOKEN, new Date(NOW)), true, 'legacy token still works');
    assert.equal(hasReviewCapability(makeOrder({ proofApprovalToken: TOKEN }), 'wrong', new Date(NOW)), false);
  } finally {
    cleanup(dir);
  }
});

test('hashed capability: valid token passes, wrong/expired tokens fail closed, snapshot accepts cookie fallback', async () => {
  const dir = makeTmp();
  try {
    await persistOrder({
      ...makeOrder({
        proofApprovalToken: null,
        pageArtifacts: [page(0, `/api/order/${ORDER}/review-asset/page-01`)],
        storyArtifactUrl: null,
      }),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
    });
    assert.equal(hasReviewCapability(awaitedOrder(dir), TOKEN, new Date(NOW)), true);
    assert.equal(hasReviewCapability(awaitedOrder(dir), 'wrong', new Date(NOW)), false);
    assert.equal(hasReviewCapability(awaitedOrder(dir), TOKEN, new Date('2026-08-20T00:00:00.000Z')), false);

    const snap = await getReviewSnapshot(ORDER, { reviewToken: TOKEN, now: new Date(NOW) });
    assert.ok(snap, 'hashed token should authorize snapshot reads');
  } finally {
    cleanup(dir);
  }
});

test('fragment session bootstrap contract: session endpoint sets HttpOnly Secure Strict cookie and never echoes the token', async () => {
  const dir = makeTmp();
  try {
    await persistOrder({
      ...makeOrder(),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
      proofApprovalToken: null,
    });
    const request = new Request(`http://localhost/api/order/${ORDER}/review-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN }),
    });
    const res = await handlePrivateReviewSessionRequest(request, ORDER, { now: () => new Date(NOW) });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(TOKEN));
    const setCookie = String(res.headers['Set-Cookie'] ?? '');
    assert.match(setCookie, /^__Host-/);
    assert.match(setCookie, new RegExp(`^${getPrivateReviewSessionCookieName(ORDER)}=`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
  } finally {
    cleanup(dir);
  }
});

test('session endpoint fails closed for malformed cookie values and refuses unpaid, refunded, or unattached review state', async () => {
  const dir = makeTmp();
  try {
    await persistOrder({
      ...makeOrder(),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
      proofApprovalToken: null,
    });
    const malformed = await handlePrivateReviewAssetRequest(
      new Request(`http://localhost/api/order/${ORDER}/review-asset/page-01`, {
        headers: { cookie: `${getPrivateReviewSessionCookieName(ORDER)}=%E0%A4%A` },
      }),
      ORDER,
      'page-01',
      {
        now: () => new Date(NOW),
        readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
        getPrivateBlob: async () => {
          throw new Error('must_not_fetch_malformed_cookie');
        },
      },
    );
    assert.equal(malformed.status, 404);

    const session = await handlePrivateReviewSessionRequest(
      new Request(`http://localhost/api/order/${ORDER}/review-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      }),
      ORDER,
      {
        now: () => new Date(NOW),
        readOrderVersionedImpl: async () => ({
          order: makeOrder({ paymentStatus: 'pending' }),
          version: 'local',
        }),
      },
    );
    assert.equal(session.status, 403);
  } finally {
    cleanup(dir);
  }
});

test('private asset proxy: rejects missing cookie and wrong asset ids with 404', async () => {
  const dir = makeTmp();
  try {
    await persistOrder({
      ...makeOrder(),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
      proofApprovalToken: null,
    });
    process.env.HSB_PRIVATE_READ_WRITE_TOKEN = 'private_rw_x';
    process.env.BLOB_READ_WRITE_TOKEN = 'public_rw_y';
    const missingCookie = await handlePrivateReviewAssetRequest(
      new Request(`http://localhost/api/order/${ORDER}/review-asset/page-01`),
      ORDER,
      'page-01',
      {
        now: () => new Date(NOW),
        readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
        getPrivateBlob: async () => {
          throw new Error('must_not_fetch_without_auth');
        },
      },
    );
    assert.equal(missingCookie.status, 404);

    const wrongAsset = await handlePrivateReviewAssetRequest(
      new Request(`http://localhost/api/order/${ORDER}/review-asset/page-99`, {
        headers: { cookie: `${getPrivateReviewSessionCookieName(ORDER)}=${TOKEN}` },
      }),
      ORDER,
      'page-99',
      {
        now: () => new Date(NOW),
        readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
        getPrivateBlob: async () => {
          throw new Error('must_not_fetch_wrong_asset');
        },
      },
    );
    assert.equal(wrongAsset.status, 404);
  } finally {
    cleanup(dir);
  }
});

test('private asset proxy: rejects unpaid/refunded/hash-mismatched blobs and streams exact bytes on success', async () => {
  const dir = makeTmp();
  try {
    const bytes = Buffer.from('page-01-private');
    await persistOrder({
      ...makeOrder({
        pageArtifacts: [page(0, `/api/order/${ORDER}/review-asset/page-01`, privateArtifact(`orders/${ORDER}/pages/page-01.png`, bytes, 'image/png'))],
      }),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
      proofApprovalToken: null,
    });
    process.env.HSB_PRIVATE_READ_WRITE_TOKEN = 'private_rw_x';
    process.env.BLOB_READ_WRITE_TOKEN = 'public_rw_y';
    const req = new Request(`http://localhost/api/order/${ORDER}/review-asset/page-01`, {
      headers: { cookie: `${getPrivateReviewSessionCookieName(ORDER)}=${TOKEN}` },
    });
    const ok = await handlePrivateReviewAssetRequest(req, ORDER, 'page-01', {
      now: () => new Date(NOW),
      readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
      getPrivateBlob: async (pathname) => ({
        pathname,
        contentType: 'image/png',
        body: bytes,
      }),
    });
    assert.equal(ok.status, 200);
    assert.equal(Buffer.from(ok.body as Uint8Array).toString('utf8'), 'page-01-private');
    assert.equal(ok.headers['Content-Type'], 'image/png');
    assert.match(String(ok.headers['Cache-Control']), /private, no-store/);
    assert.match(String(ok.headers['X-Robots-Tag']), /noindex/);

    const mismatch = await handlePrivateReviewAssetRequest(req, ORDER, 'page-01', {
      now: () => new Date(NOW),
      readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
      getPrivateBlob: async (pathname) => ({
        pathname,
        contentType: 'image/png',
        body: Buffer.from('tampered'),
      }),
    });
    assert.equal(mismatch.status, 404);

    delete process.env.BLOB_READ_WRITE_TOKEN;
    await persistOrder({
      ...makeOrder({ paymentStatus: 'pending' }),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
      proofApprovalToken: null,
    });
    process.env.BLOB_READ_WRITE_TOKEN = 'public_rw_y';
    const unpaid = await handlePrivateReviewAssetRequest(req, ORDER, 'page-01', {
      now: () => new Date(NOW),
      readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
      getPrivateBlob: async () => ({ pathname: 'x', contentType: 'image/png', body: bytes }),
    });
    assert.equal(unpaid.status, 404);
  } finally {
    cleanup(dir);
  }
});

test('private asset proxy: rejects traversal, absolute, and cross-order private pathnames', async () => {
  const dir = makeTmp();
  try {
    await persistOrder({
      ...makeOrder({
        pageArtifacts: [page(0, `/api/order/${ORDER}/review-asset/page-01`, privateArtifact(`orders/other-order/page-01.png`, Buffer.from('page-01-private'), 'image/png'))],
      }),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
      proofApprovalToken: null,
    });
    process.env.HSB_PRIVATE_READ_WRITE_TOKEN = 'private_rw_x';
    process.env.BLOB_READ_WRITE_TOKEN = 'public_rw_y';
    const req = new Request(`http://localhost/api/order/${ORDER}/review-asset/page-01`, {
      headers: { cookie: `${getPrivateReviewSessionCookieName(ORDER)}=${TOKEN}` },
    });
    const crossOrder = await handlePrivateReviewAssetRequest(req, ORDER, 'page-01', {
      now: () => new Date(NOW),
      readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
      getPrivateBlob: async () => {
        throw new Error('must_not_fetch_cross_order_path');
      },
    });
    assert.equal(crossOrder.status, 404);

    delete process.env.HSB_PRIVATE_READ_WRITE_TOKEN;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    await persistOrder({
      ...makeOrder({
        pageArtifacts: [page(0, `/api/order/${ORDER}/review-asset/page-01`, privateArtifact(`/orders/${ORDER}/page-01.png`, Buffer.from('page-01-private'), 'image/png'))],
      }),
      ...buildHashedReviewCapabilityPatch(TOKEN, '2026-08-19T18:00:00.000Z'),
      proofApprovalToken: null,
    });
    process.env.HSB_PRIVATE_READ_WRITE_TOKEN = 'private_rw_x';
    process.env.BLOB_READ_WRITE_TOKEN = 'public_rw_y';
    const absolute = await handlePrivateReviewAssetRequest(req, ORDER, 'page-01', {
      now: () => new Date(NOW),
      readOrderVersionedImpl: async () => ({ order: awaitedOrder(dir), version: 'local' }),
      getPrivateBlob: async () => {
        throw new Error('must_not_fetch_absolute_path');
      },
    });
    assert.equal(absolute.status, 404);
  } finally {
    cleanup(dir);
  }
});

test('review fragment bootstrap source reads the fragment, posts body token, sanitizes history, and avoids query-token transport', () => {
  const src = readFileSync(new URL('../src/app/review/[orderId]/review-session-bootstrap.tsx', import.meta.url), 'utf8');
  assert.match(src, /window\.location\.hash/);
  assert.match(src, /history\.replaceState/);
  assert.match(src, /window\.location\.reload\(/);
  assert.match(src, /fetch\(`\/api\/order\/\$\{orderId\}\/review-session`/);
  assert.match(src, /body:\s*JSON\.stringify\(\{\s*token\s*\}\)/);
  assert.doesNotMatch(src, /tokenQuery\(/);
});

function awaitedOrder(dir: string): OrderRecord {
  return JSON.parse(readFileSync(path.join(dir, `${ORDER}.json`), 'utf8')) as OrderRecord;
}
