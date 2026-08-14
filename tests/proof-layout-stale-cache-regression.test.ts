/**
 * FOCUSED REGRESSION FOR A PRODUCT DEFECT — THIS FILE IS EXPECTED TO FAIL
 * until the defect below is fixed. It is committed deliberately, as the
 * demonstration of a bug found while building the customer text-editor
 * regression suite. It does NOT change any production rule.
 *
 * DEFECT
 * ------
 * `withOrderTransaction()` keeps an in-process read-your-own-writes cache
 * (`recentConditionalCommits` in src/lib/orders.ts). On its FIRST attempt it
 * returns the cached record outright:
 *
 *     const current = await readOrderVersioned(orderId, { preferRecentCommit: attempt === 1 });
 *
 * `persistOrder()` — a direct, non-conditional write — never invalidates that
 * cache. So after any persistOrder() to an order the process has previously
 * committed to, the next guarded transaction evaluates its gates against a
 * STALE record.
 *
 * WHY IT MATTERS HERE
 * -------------------
 * Mutations largely self-heal: the conditional commit is made against the stale
 * version, fails, the entry is evicted, and attempt 2 re-reads the store. But
 * decisions that ABORT never reach the commit, so they are final AND stale.
 * For this feature that includes proof-freshness and idempotency decisions —
 * e.g. request-help concludes "already recorded for this proof" using an
 * out-of-date fingerprint, so a customer's help request against a REBUILT proof
 * is silently swallowed as a no-op.
 *
 * REACHABLE IN PRODUCTION: src/lib/rebuild-print-order.ts:322 calls
 * persistOrder() directly (as do the operator scripts in scripts/), and the
 * customer review routes then run guarded transactions on the same order in
 * the same server process.
 *
 * BLAST RADIUS ON MAIN: this single root cause accounts for all 14 pre-existing
 * test failures on origin/main@b94a97d — including the already-committed
 * `tests/proof-layout-route.test.ts` case "request-help idempotency is scoped
 * to the current proof fingerprint". Adding one cache invalidation to
 * persistOrder() turns the whole suite green (1337 pass, 0 fail); that fix is
 * intentionally NOT applied here, because fixing production was out of scope
 * for this task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord, persistOrder, withOrderTransaction,
  __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const ORDER = 'ord_stale_cache_repro';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-stale-cache-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function seed(): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Kid', bookFormat: 'digital', email: 'synthetic@example.invalid' },
      { id: ORDER, now: '2026-08-05T00:00:00.000Z' },
    ),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
  } as OrderRecord;
}

test('a guarded transaction must not read a record made stale by persistOrder', async () => {
  const dir = makeTmp();
  try {
    await persistOrder(seed());

    // 1. A guarded commit — this is what warms the read-your-own-writes cache.
    await withOrderTransaction<null>(ORDER, (order) => ({
      commit: { ...order, childName: 'FIRST' },
      result: null,
    }));

    // 2. Another writer updates the SAME order through the direct persist path
    //    (exactly what rebuild-print-order.ts and the operator scripts do).
    const direct = { ...seed(), childName: 'SECOND' };
    await persistOrder(direct);

    // 3. The next guarded transaction must observe the authoritative store.
    const observed = await withOrderTransaction<string | undefined>(ORDER, (order) => ({
      abort: order.childName,
    }));

    assert.equal(
      observed,
      'SECOND',
      'guarded transaction read a stale cached order — persistOrder() does not '
      + 'invalidate recentConditionalCommits, so abort/no-op decisions are made '
      + 'against out-of-date state',
    );
  } finally {
    cleanup(dir);
  }
});
