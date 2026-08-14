/**
 * Cache-coherency contract for the order store.
 *
 * `withOrderTransaction()` keeps an in-process read-your-own-writes cache
 * (`recentConditionalCommits`) and trusts it outright on its first attempt:
 *
 *     const current = await readOrderVersioned(orderId, { preferRecentCommit: attempt === 1 });
 *
 * Anything that advances the store must therefore leave that cache either
 * correct or empty. Two distinct hazards are covered here:
 *
 *   1. A writer that bypasses `withOrderTransaction` — notably
 *      `commitOrderConditional()` called directly, which is what the print
 *      rebuild does (src/lib/rebuild-print-order.ts) — advancing the store
 *      while a stale entry survives.
 *   2. A slow acknowledgement re-inserting a superseded record AFTER a newer
 *      writer already moved on. This needs no direct write at all: two ordinary
 *      concurrent guarded transactions are enough.
 *
 * Why it matters: mutations largely self-heal, because the conditional commit
 * is made against the stale version, fails, and the retry re-reads the store.
 * But decisions that ABORT never reach the commit, so they are final AND stale
 * — e.g. proof-freshness and idempotency checks silently no-opping a customer's
 * request against a REBUILT proof.
 *
 * Two harnesses are used, because the writers do not share one path. The
 * commit/race cases drive the adapter seam — the SAME code path the Blob
 * adapter uses in production — and can hold a write's acknowledgement open.
 * `persistOrder()`/`persistNewOrder()` write to blob or the local file store
 * WITHOUT going through that adapter, so their cases run against a real
 * temp-dir store instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord, withOrderTransaction, commitOrderConditional,
  readOrderVersioned, persistOrder, persistNewOrder, getOrder,
  __setOrderStoreAdapterFactoryForTests, __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const ID = 'ord_cache_coherency';

/**
 * Versioned in-memory store standing in for the Blob adapter, with a hook to
 * hold one write's ACKNOWLEDGEMENT open after the write itself has landed —
 * the shape of a slow `put()` round trip.
 */
function makeStore() {
  let record: { body: string; version: string } | null = null;
  let seq = 0;
  let holdAckFor: string | null = null;
  let release: (() => void) | null = null;
  let readCount = 0;

  const marker = (body: string) => (JSON.parse(body) as OrderRecord).childName;

  __setOrderStoreAdapterFactoryForTests(() => ({
    kind: 'coherency-test',
    async readVersioned() {
      readCount += 1;
      return record ? { ...record } : null;
    },
    async createIfAbsent(_p: string, body: string) {
      if (record) return { ok: false as const, reason: 'exists' as const };
      record = { body, version: `v${++seq}` };
      return { ok: true as const, version: record.version };
    },
    async replaceIfVersion(_p: string, body: string, expected: string) {
      if (!record || record.version !== expected) {
        return { ok: false as const, reason: 'version_conflict' as const };
      }
      record = { body, version: `v${++seq}` }; // the write lands here…
      const result = { ok: true as const, version: record.version };
      if (holdAckFor === marker(body)) {       // …but the caller waits
        holdAckFor = null;
        await new Promise<void>((r) => { release = r; });
      }
      return result;
    },
  }));

  return {
    reads: () => readCount,
    resetReads() { readCount = 0; },
    seed(childName = 'BASE') {
      record = { body: JSON.stringify(order(childName)), version: `v${++seq}` };
    },
    stored: () => (record ? (JSON.parse(record.body) as OrderRecord) : null),
    version: () => record?.version ?? null,
    holdAckFor(m: string) { holdAckFor = m; },
    releaseAck() { release?.(); release = null; },
    cleanup: __resetOrderStoreAdapterFactoryForTests,
  };
}

function order(childName: string): OrderRecord {
  return {
    ...createOrderRecord(
      { childName, bookFormat: 'digital', email: 'synthetic@example.invalid' },
      { id: ID, now: '2026-08-05T00:00:00.000Z' },
    ),
    childName,
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
  } as OrderRecord;
}

/** Commit through the guarded helper, tagging the record so we can identify it. */
const commitVia = (childName: string) =>
  withOrderTransaction<null>(ID, (o) => ({ commit: { ...o, childName }, result: null }));

/** What the NEXT guarded transaction actually sees, without committing. */
const observedByGuardedRead = () =>
  withOrderTransaction<string | undefined>(ID, (o) => ({ abort: o.childName }));

// ── hazard 1: writers that bypass withOrderTransaction ───────────────────────

test('commitOrderConditional called directly is visible to the next guarded transaction', async () => {
  const store = makeStore();
  try {
    store.seed();
    await commitVia('FIRST');

    // Verbatim shape of the print rebuild: read the version, then commit
    // conditionally OUTSIDE withOrderTransaction.
    const current = (await readOrderVersioned(ID))!;
    const rebuilt = { ...current.order, childName: 'REBUILT' } as OrderRecord;
    const committed = await commitOrderConditional(rebuilt, current.version);
    assert.equal(committed.ok, true);

    assert.equal(
      await observedByGuardedRead(),
      'REBUILT',
      'a direct commitOrderConditional advanced the store but the guarded path '
      + 'still saw the pre-rebuild record',
    );
  } finally {
    store.cleanup();
  }
});

test('a direct commit while another is in flight wins, and the loser cannot publish', async () => {
  const store = makeStore();
  try {
    store.seed();
    store.holdAckFor('T1');
    const t1 = commitVia('T1');
    await new Promise((r) => setTimeout(r, 20));

    // A direct commitOrderConditional (the rebuild shape) lands on top.
    const current = (await readOrderVersioned(ID))!;
    await commitOrderConditional(
      { ...current.order, childName: 'DIRECT_NEWEST' } as OrderRecord,
      current.version,
    );

    store.releaseAck();
    await t1;

    assert.equal(await observedByGuardedRead(), 'DIRECT_NEWEST');
  } finally {
    store.cleanup();
  }
});

// ── hazard 2: stale re-insertion after a slow acknowledgement ────────────────

test('a slow commit cannot re-insert its record after a newer transaction wins', async () => {
  const store = makeStore();
  try {
    store.seed();

    // T1's write lands, but its acknowledgement is held open.
    store.holdAckFor('T1');
    const t1 = commitVia('T1');
    await new Promise((r) => setTimeout(r, 20));

    // T2 reads the already-updated store, commits on top, and caches its record.
    await commitVia('T2_NEWEST');

    // Only now does T1's stale acknowledgement resolve.
    store.releaseAck();
    await t1;

    assert.equal(store.stored()?.childName, 'T2_NEWEST');
    assert.equal(
      await observedByGuardedRead(),
      'T2_NEWEST',
      'a superseded commit re-inserted itself into the read-your-own-writes cache',
    );
  } finally {
    store.cleanup();
  }
});

// ── the cache must still do its job ──────────────────────────────────────────

test('a committed record is served from cache, without touching the store', async () => {
  const store = makeStore();
  try {
    store.seed();
    await commitVia('ONLY_WRITER');

    // Asserting the VALUE alone is vacuous — the store holds the same record, so
    // a "never cache anything" implementation would pass. Assert the read never
    // reaches the adapter. This matters because getBlobAccessMode() defaults to
    // 'public', where a store read can fail closed and throw.
    store.resetReads();
    assert.equal(await observedByGuardedRead(), 'ONLY_WRITER');
    assert.equal(store.reads(), 0, 'guarded read fell through to the store instead of the cache');
  } finally {
    store.cleanup();
  }
});

test('an unrelated LOSING commit must not evict the winner\'s cache entry', async () => {
  const store = makeStore();
  try {
    store.seed();

    // A stale holder (e.g. the print rebuild, which reads its version, spends
    // minutes rendering, then loses the CAS by design).
    const stale = (await readOrderVersioned(ID))!;

    // The winner commits and publishes a correct entry.
    await commitVia('WINNER');

    const lost = await commitOrderConditional(
      { ...stale.order, childName: 'LOSER' } as OrderRecord,
      stale.version,
    );
    assert.equal(lost.ok, false, 'the stale commit must lose');

    // The loser learned nothing about current truth and its write did not land,
    // so the winner's entry must survive. Evicting it forces the next guarded
    // mutation through a read that can hard-fail.
    store.resetReads();
    assert.equal(await observedByGuardedRead(), 'WINNER');
    assert.equal(store.reads(), 0, 'a losing commit evicted the winner\'s still-correct entry');
  } finally {
    store.cleanup();
  }
});

test('a superseded slow commit does not evict the newer winner\'s entry', async () => {
  const store = makeStore();
  try {
    store.seed();
    store.holdAckFor('T1');
    const t1 = commitVia('T1');
    await new Promise((r) => setTimeout(r, 20));

    await commitVia('T2_NEWEST');
    store.releaseAck();
    await t1;

    // T1 is superseded, so it must not publish — but it must also not destroy
    // T2's correct entry on its way out.
    store.resetReads();
    assert.equal(await observedByGuardedRead(), 'T2_NEWEST');
    assert.equal(store.reads(), 0, 'a superseded commit evicted the newer correct entry');
  } finally {
    store.cleanup();
  }
});

// ── failure paths must never leave a pre-write record cached ─────────────────

test('a throwing write does not leave a pre-write record cached', async () => {
  const store = makeStore();
  try {
    store.seed();
    await commitVia('FIRST');

    // A write that rejects AFTER the record landed — a response timeout or
    // connection reset. The cache must not keep claiming the old record.
    let record = store.stored();
    __setOrderStoreAdapterFactoryForTests(() => ({
      kind: 'throwing',
      async readVersioned() {
        return { body: JSON.stringify({ ...record, childName: 'LANDED' }), version: 'v99' };
      },
      async createIfAbsent() { return { ok: false as const, reason: 'exists' as const }; },
      async replaceIfVersion() { throw new Error('socket hang up after the write landed'); },
    }));

    await assert.rejects(() => commitVia('NEVER_ACKED'));
    assert.equal(
      await observedByGuardedRead(),
      'LANDED',
      'after an ambiguous write failure the cache must be empty, not stale',
    );
  } finally {
    __resetOrderStoreAdapterFactoryForTests();
  }
});

test('a losing conditional commit never caches its own attempt', async () => {
  const store = makeStore();
  try {
    store.seed();
    await commitVia('FIRST');

    const stale = (await readOrderVersioned(ID))!;
    await commitVia('WINNER');

    const lost = await commitOrderConditional(
      { ...stale.order, childName: 'LOSER' } as OrderRecord,
      stale.version,
    );
    assert.equal(lost.ok, false);
    assert.equal(await observedByGuardedRead(), 'WINNER', 'the loser must never be observable');
  } finally {
    store.cleanup();
  }
});

// ── the direct-persist writers, against the REAL local store ─────────────────
//
// persistOrder()/persistNewOrder() write to blob or the local file store and do
// NOT go through the adapter seam, so these run against a real temp-dir store.

function localStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-cache-coherency-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return {
    dir,
    cleanup() {
      __resetOrderStoreAdapterFactoryForTests();
      rmSync(dir, { recursive: true, force: true });
      delete process.env.HSB_ORDER_STORE_DIR;
    },
  };
}

test('persistOrder is visible to the next guarded transaction', async () => {
  const store = localStore();
  try {
    await persistOrder(order('BASE'));
    await commitVia('FIRST');
    await persistOrder(order('DIRECT'));
    assert.equal(
      await observedByGuardedRead(),
      'DIRECT',
      'persistOrder advanced the store but the guarded path saw the cached record',
    );
  } finally {
    store.cleanup();
  }
});

test('a guarded commit after a direct persist builds on the persisted record', async () => {
  const store = localStore();
  try {
    await persistOrder(order('BASE'));
    await commitVia('FIRST');
    await persistOrder(order('DIRECT'));

    await withOrderTransaction<null>(ID, (o) => ({
      commit: { ...o, reviewStatus: 'approved' } as OrderRecord,
      result: null,
    }));

    const after = await getOrder(ID);
    assert.equal(after?.childName, 'DIRECT', 'the direct write must not be clobbered');
    assert.equal(after?.reviewStatus, 'approved');
  } finally {
    store.cleanup();
  }
});

test('persistNewOrder does not let a previous incarnation of an id linger', async () => {
  const store = localStore();
  try {
    await persistOrder(order('BASE'));
    await commitVia('FIRST');

    rmSync(path.join(store.dir, `${ID}.json`), { force: true });
    await persistNewOrder(order('RECREATED'));

    assert.equal(await observedByGuardedRead(), 'RECREATED');
  } finally {
    store.cleanup();
  }
});
