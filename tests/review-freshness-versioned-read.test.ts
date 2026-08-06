/**
 * Authoritative-vs-stale review freshness (spec area 5 / defect 4) and the
 * "no partial book can be approved" gate (spec areas 1-2 at the approval
 * choke point).
 *
 * getReviewSnapshot must read the versioned authoritative record
 * (readOrderVersioned → readPublicOrderBlobVersioned, #127), NOT the
 * unversioned `getOrder` whose public/CDN copy can lag an authoritative
 * update and render a known-stale proof. Mutation proof: the test asserts the
 * unversioned `getOrder` path returns null in this setup while getReviewSnapshot
 * returns the authoritative record — so a revert to `getOrder` fails the test.
 *
 * Synthetic fixtures only; provider + blob credentials stripped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  getOrder,
  __setOrderStoreAdapterFactoryForTests,
  __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord, OrderStoreAdapter, PageArtifact } from '../src/lib/orders.ts';
import { getReviewSnapshot, approveWholeBook, customerReviewActor } from '../src/lib/page-review.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';

const NOW = '2026-08-05T00:00:00.000Z';
const TOKEN = 'abcd'.repeat(12);
const ORDER_ID = 'ord_freshness';

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    currentImageUrl: `https://example.invalid/p${i}.png`,
    acceptedImageUrl: `https://example.invalid/p${i}.png`,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...o,
  };
}

function makeOrder(o: Partial<OrderRecord> = {}): OrderRecord {
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Testkid', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id: ORDER_ID, now: NOW },
    ),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://example.invalid/orders/x/proofs/v1.pdf',
    proofVersion: 'v1',
    proofReviewedAt: NOW,
    proofReviewedVersion: 'v1',
    proofApprovalToken: TOKEN,
    pageArtifacts: [page(0), page(1)],
    auditEvents: [],
    ...o,
  };
  order.proofSourceFingerprint = proofSourceFingerprint(order);
  return order;
}

/** Minimal in-memory versioned store — the authoritative source. `getOrder`
 *  does NOT consult it (it reads the public blob/FS), which is exactly the
 *  contrast the freshness fix relies on. */
class VersionedStore {
  private rec: { body: string; version: string } | null = null;
  private seq = 0;
  private next() { this.seq += 1; return `etag-${this.seq}`; }
  set(order: OrderRecord) { this.rec = { body: JSON.stringify(order), version: this.next() }; }
  adapter(): OrderStoreAdapter {
    const s = this;
    return {
      kind: 'versioned-fake',
      async readVersioned() { return s.rec ? { body: s.rec.body, version: s.rec.version } : null; },
      async createIfAbsent(_p, body) {
        if (s.rec) return { ok: false, reason: 'exists' };
        const version = s.next(); s.rec = { body, version }; return { ok: true, version };
      },
      async replaceIfVersion(_p, body, expected) {
        if (!s.rec || s.rec.version !== expected) return { ok: false, reason: 'version_conflict' };
        const version = s.next(); s.rec = { body, version }; return { ok: true, version };
      },
    };
  }
}

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-fresh-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function teardown(dir: string) {
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

test('getReviewSnapshot reads the authoritative versioned record, not the stale getOrder path', async () => {
  const dir = setup();
  try {
    const store = new VersionedStore();
    store.set(makeOrder({ proofVersion: 'v1' }));
    __setOrderStoreAdapterFactoryForTests(() => store.adapter());

    // The unversioned path finds nothing here — so a snapshot MUST have come
    // from the versioned read (mutation proof against a revert to getOrder).
    assert.equal(await getOrder(ORDER_ID), null);

    const snap = await getReviewSnapshot(ORDER_ID, { reviewToken: TOKEN });
    assert.ok(snap, 'snapshot resolved from the authoritative versioned read');
    assert.equal(snap!.proofVersion, 'v1');
  } finally {
    teardown(dir);
  }
});

test('review reads converge on the authoritative record after an update (no stale proof)', async () => {
  const dir = setup();
  try {
    const store = new VersionedStore();
    store.set(makeOrder({ proofVersion: 'v1' }));
    __setOrderStoreAdapterFactoryForTests(() => store.adapter());

    const first = await getReviewSnapshot(ORDER_ID, { reviewToken: TOKEN });
    assert.equal(first!.proofVersion, 'v1');

    // Authoritative order update (e.g. a proof rebuild).
    store.set(makeOrder({ proofVersion: 'v2', proofReviewedVersion: 'v1' }));

    const second = await getReviewSnapshot(ORDER_ID, { reviewToken: TOKEN });
    assert.equal(second!.proofVersion, 'v2', 'review converged on the authoritative current revision');
  } finally {
    teardown(dir);
  }
});

test('getReviewSnapshot still fails closed on a wrong review token', async () => {
  const dir = setup();
  try {
    const store = new VersionedStore();
    store.set(makeOrder());
    __setOrderStoreAdapterFactoryForTests(() => store.adapter());
    assert.equal(await getReviewSnapshot(ORDER_ID, { reviewToken: 'wrong' }), null);
  } finally {
    teardown(dir);
  }
});

test('approveWholeBook fails closed for an undersized (partial) book — no advance to approved', async () => {
  const dir = setup();
  try {
    const store = new VersionedStore();
    // Only 6 accepted story pages for a 24-page digital book.
    store.set(makeOrder({ pageArtifacts: Array.from({ length: 6 }, (_, i) => page(i)) }));
    __setOrderStoreAdapterFactoryForTests(() => store.adapter());

    const res = await approveWholeBook(ORDER_ID, { actor: customerReviewActor(TOKEN) });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'incomplete_page_set');
  } finally {
    teardown(dir);
  }
});

test('approveWholeBook still passes the contract gate for a full 24-page book', async () => {
  const dir = setup();
  try {
    const store = new VersionedStore();
    const full = makeOrder({ pageArtifacts: Array.from({ length: 24 }, (_, i) => page(i)) });
    // Keep the acknowledged revision aligned so only the contract gate is exercised.
    store.set(full);
    __setOrderStoreAdapterFactoryForTests(() => store.adapter());

    const res = await approveWholeBook(ORDER_ID, { actor: customerReviewActor(TOKEN) });
    // Not asserting ok:true (other proof-identity gates may apply); only that
    // the contract gate did NOT reject a full book.
    assert.notEqual(res.error, 'incomplete_page_set');
  } finally {
    teardown(dir);
  }
});
