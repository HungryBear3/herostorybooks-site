/**
 * Production order-mutation-lock contract — exercised against the ACTUAL Blob
 * adapter code path (BLOB_READ_WRITE_TOKEN set, durable persistence required),
 * with the underlying Blob store replaced by a fake that faithfully models the
 * only guarantees Vercel Blob actually gives us:
 *
 *   1. put(..., allowOverwrite: false) is an ATOMIC exclusive create. Exactly
 *      one concurrent caller can create a given key; everyone else gets a
 *      409/"already exists".
 *   2. list() is EVENTUALLY CONSISTENT. A worker may see a stale view that is
 *      missing keys another worker already created.
 *   3. Reads can fail transiently (403/throttle/network), and a stored record
 *      can be truncated or otherwise unparseable.
 *
 * The design under test never overwrites and never deletes-then-recreates a
 * contended key. Ownership is a monotonically increasing generation, each at
 * its own immutable key, and mutual exclusion is decided ONLY by the atomic
 * create. These tests prove that a stale list, a lost race, or a failed read
 * can never admit two simultaneous holders.
 *
 * Everything here uses synthetic order ids and a throwaway in-memory store. No
 * network, no real Blob store, no order records, no provider calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OrderMutationLockError,
  withOrderMutationLock,
  __setOrderLockAdapterFactoryForTests,
  __resetOrderLockAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderLockStoreAdapter } from '../src/lib/orders.ts';

const FAKE_TOKEN = 'vercel_blob_rw_FAKETESTTOKEN000000000000';

// ── A fake Blob store with production-faithful semantics ────────────────────

class FakeBlobStore {
  /** pathname → body. The ONLY way a key is created is createIfAbsent. */
  readonly keys = new Map<string, string>();

  /** Every mutating call, for asserting "we never overwrite". */
  readonly ops: string[] = [];

  /** Keys whose read must throw (transient 403 / network). */
  readonly failReads = new Set<string>();

  /** Keys hidden from list() for a given caller — models list lag. */
  hideFromList: (caller: string, pathname: string) => boolean = () => false;

  /** Called just before each createIfAbsent resolves; lets tests interleave. */
  beforeCreate: (caller: string, pathname: string) => Promise<void> = async () => {};

  createdCount(pathname: string) {
    return this.ops.filter((o) => o === `create:${pathname}`).length;
  }

  adapterFor(caller: string): OrderLockStoreAdapter {
    const store = this;
    return {
      kind: 'blob-fake',

      async createIfAbsent(pathname, body) {
        await store.beforeCreate(caller, pathname);
        // Atomic exclusive create. This single check-and-set is the real
        // store's server-side guarantee; JS single-threaded execution between
        // the has() and the set() models it exactly (no await in between).
        if (store.keys.has(pathname)) {
          store.ops.push(`create-rejected:${pathname}`);
          return 'exists';
        }
        store.keys.set(pathname, body);
        store.ops.push(`create:${pathname}`);
        return 'created';
      },

      async readText(pathname) {
        if (store.failReads.has(pathname)) {
          throw new Error(`Blob read failed: public fetch 403 Forbidden (${caller})`);
        }
        return store.keys.has(pathname) ? (store.keys.get(pathname) as string) : null;
      },

      async listLockPaths(prefix) {
        return [...store.keys.keys()].filter(
          (k) => k.startsWith(prefix) && !store.hideFromList(caller, k),
        );
      },

      async remove(pathname) {
        store.keys.delete(pathname);
        store.ops.push(`remove:${pathname}`);
      },
    };
  }
}

function prefixFor(orderId: string) {
  return `order-mutation-locks/${orderId}/`;
}
function genKey(orderId: string, generation: number) {
  return `${prefixFor(orderId)}${String(generation).padStart(12, '0')}.lock`;
}
function lockBody(owner: string, generation: number, expiresAt: number) {
  return JSON.stringify({
    owner,
    generation,
    acquiredAt: '2026-08-03T12:00:00.000Z',
    expiresAt,
  });
}

/**
 * Run `fn` in the production lock configuration: a Blob token is present and
 * durable persistence is required, so withOrderMutationLock takes the Blob
 * branch — never the local-filesystem one.
 */
async function withProductionLockEnv(
  store: FakeBlobStore,
  callerFor: () => string,
  fn: () => Promise<void>,
) {
  const before = {
    token: process.env.BLOB_READ_WRITE_TOKEN,
    durable: process.env.HSB_REQUIRE_DURABLE_PERSISTENCE,
    timeout: process.env.HSB_ORDER_LOCK_TIMEOUT_MS,
    lease: process.env.HSB_ORDER_LOCK_LEASE_MS,
  };
  process.env.BLOB_READ_WRITE_TOKEN = FAKE_TOKEN;
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  __setOrderLockAdapterFactoryForTests((token) => {
    assert.equal(token, FAKE_TOKEN, 'blob adapter must receive the blob token');
    return store.adapterFor(callerFor());
  });
  try {
    await fn();
  } finally {
    __resetOrderLockAdapterFactoryForTests();
    for (const [k, v] of Object.entries({
      BLOB_READ_WRITE_TOKEN: before.token,
      HSB_REQUIRE_DURABLE_PERSISTENCE: before.durable,
      HSB_ORDER_LOCK_TIMEOUT_MS: before.timeout,
      HSB_ORDER_LOCK_LEASE_MS: before.lease,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const EXPIRED = () => Date.now() - 5_000;
const LIVE = () => Date.now() + 60_000;

// ── The headline case: two stale-lock contenders cannot both enter ──────────

test('two contenders racing the SAME stale lock: exactly one enters, the other is rejected by the atomic create', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_two_contenders';
  // A crashed holder left an expired lease at generation 1.
  store.keys.set(genKey(orderId, 1), lockBody('ghost', 1, EXPIRED()));

  let caller = 'unset';
  await withProductionLockEnv(store, () => caller, async () => {
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '400';

    // Release both contenders into createIfAbsent at the same instant, so they
    // have both already read the expired generation-1 record and both computed
    // generation 2 as their target. This is precisely the interleaving the old
    // overwrite + read-back takeover could not survive.
    let waiting = 0;
    let openBarrier: (() => void) | null = null;
    const barrier = new Promise<void>((resolve) => { openBarrier = resolve; });
    store.beforeCreate = async (_c, pathname) => {
      if (pathname !== genKey(orderId, 2)) return;
      waiting += 1;
      if (waiting >= 2) openBarrier?.();
      else await barrier;
    };

    let inside = 0;
    let maxInside = 0;
    const entered: string[] = [];

    const worker = async (name: string) => {
      caller = name;
      try {
        return await withOrderMutationLock(orderId, async () => {
          entered.push(name);
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 20));
          inside -= 1;
          return name;
        });
      } catch (err) {
        assert.ok(err instanceof OrderMutationLockError, `unexpected error: ${String(err)}`);
        return null;
      }
    };

    const results = await Promise.all([worker('A'), worker('B')]);

    // THE invariant: never two holders at once.
    assert.equal(maxInside, 1, 'two workers must never be inside the lock simultaneously');

    // Exactly one of the two simultaneous attempts on generation 2 won; the
    // other was rejected by the store's atomic create, NOT by its own reasoning
    // about what it read. That is the whole safety argument.
    assert.ok(
      store.ops.includes(`create-rejected:${genKey(orderId, 2)}`),
      'the losing contender must have been rejected by the atomic create',
    );
    const raceOps = store.ops.slice(0, 2);
    assert.deepEqual(
      raceOps.sort(),
      [`create-rejected:${genKey(orderId, 2)}`, `create:${genKey(orderId, 2)}`].sort(),
      'the simultaneous race produced exactly one winner and one rejection',
    );

    // The loser either retried into a later generation (after the winner
    // released) or timed out — both safe. What must NOT happen is both at once.
    const succeeded = results.filter((r) => r !== null);
    assert.ok(succeeded.length >= 1, 'at least one worker must make progress');
    assert.equal(new Set(entered).size, entered.length, 'no worker entered twice');
  });
});

test('the lock NEVER overwrites: a key is only ever created into empty space', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_no_overwrite';
  store.keys.set(genKey(orderId, 1), lockBody('ghost', 1, EXPIRED()));

  // Fail the test if the adapter ever writes over a key that already exists.
  const originalAdapterFor = store.adapterFor.bind(store);
  store.adapterFor = (caller: string) => {
    const inner = originalAdapterFor(caller);
    return {
      ...inner,
      async createIfAbsent(pathname, body) {
        const existedBefore = store.keys.has(pathname);
        const result = await inner.createIfAbsent(pathname, body);
        if (existedBefore) {
          assert.equal(result, 'exists', `overwrite attempted on an occupied key: ${pathname}`);
        }
        return result;
      },
    };
  };

  await withProductionLockEnv(store, () => 'solo', async () => {
    await withOrderMutationLock(orderId, async () => 'ok');
    await withOrderMutationLock(orderId, async () => 'ok');
    await withOrderMutationLock(orderId, async () => 'ok');
  });

  // Sequential acquisitions may REUSE a generation number once the previous
  // holder released and the key is free again — that is safe precisely because
  // the atomic create is the arbiter. What must never happen is a write landing
  // on an occupied key (asserted above) or a stale key surviving forever.
  assert.equal(store.keys.size, 0, 'no lock keys leak once every holder has released');
  assert.ok(
    store.ops.includes(`remove:${genKey(orderId, 1)}`),
    "the crashed holder's provably-expired key is garbage-collected, not left forever",
  );
});

test('an eventually-consistent list cannot admit a second holder', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_stale_list';
  store.keys.set(genKey(orderId, 1), lockBody('ghost', 1, EXPIRED()));

  let caller = 'unset';
  await withProductionLockEnv(store, () => caller, async () => {
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '300';

    // Worker A acquires generation 2 for real.
    caller = 'A';
    const adapterA = store.adapterFor('A');
    const created = await adapterA.createIfAbsent(
      genKey(orderId, 2),
      lockBody('worker-a', 2, LIVE()),
    );
    assert.equal(created, 'created');

    // Worker B's list is stale: it cannot see generation 2 at all, so it will
    // compute generation 2 as the next free slot — the exact hazard.
    store.hideFromList = (c, pathname) => c === 'B' && pathname === genKey(orderId, 2);

    caller = 'B';
    await assert.rejects(
      () => withOrderMutationLock(orderId, async () => 'B entered'),
      OrderMutationLockError,
      'B must never enter while A holds a live generation 2',
    );

    // B's create attempt was rejected by the store, not by B's own reasoning.
    assert.ok(store.ops.includes(`create-rejected:${genKey(orderId, 2)}`));
    assert.equal(store.createdCount(genKey(orderId, 2)), 1);
    assert.equal(JSON.parse(store.keys.get(genKey(orderId, 2)) as string).owner, 'worker-a');
  });
});

test('a live lease blocks entry and is never reclaimed or overwritten', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_live_holder';
  store.keys.set(genKey(orderId, 7), lockBody('live-holder', 7, LIVE()));

  await withProductionLockEnv(store, () => 'contender', async () => {
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '250';
    const started = Date.now();
    await assert.rejects(
      () => withOrderMutationLock(orderId, async () => 'entered'),
      OrderMutationLockError,
    );
    assert.ok(Date.now() - started < 5_000, 'acquisition must stay bounded');
    // Untouched: no overwrite, no delete, no higher generation created.
    assert.deepEqual([...store.keys.keys()], [genKey(orderId, 7)]);
    assert.equal(JSON.parse(store.keys.get(genKey(orderId, 7)) as string).owner, 'live-holder');
    assert.equal(store.ops.filter((o) => o.startsWith('create:')).length, 0);
  });
});

test('an UNREADABLE incumbent fails closed — no takeover on a read error', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_unreadable';
  store.keys.set(genKey(orderId, 3), lockBody('mystery', 3, EXPIRED()));
  // We cannot prove the incumbent is dead, so we must not contend.
  store.failReads.add(genKey(orderId, 3));

  await withProductionLockEnv(store, () => 'contender', async () => {
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '250';
    await assert.rejects(
      () => withOrderMutationLock(orderId, async () => 'entered'),
      OrderMutationLockError,
      'an unreadable incumbent must never be reclaimed',
    );
    assert.equal(store.ops.filter((o) => o.startsWith('create:')).length, 0);
    assert.deepEqual([...store.keys.keys()], [genKey(orderId, 3)]);
  });
});

test('a MALFORMED incumbent record fails closed — no takeover on unparseable data', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_malformed_incumbent';
  store.keys.set(genKey(orderId, 2), '{"owner":"trunc');

  await withProductionLockEnv(store, () => 'contender', async () => {
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '250';
    await assert.rejects(
      () => withOrderMutationLock(orderId, async () => 'entered'),
      OrderMutationLockError,
    );
    assert.equal(store.ops.filter((o) => o.startsWith('create:')).length, 0);
  });
});

test('mutual exclusion under 12 concurrent workers on the real Blob code path', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_fanout';

  await withProductionLockEnv(store, () => 'w', async () => {
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '5000';
    let inside = 0;
    let maxInside = 0;
    let completed = 0;

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withOrderMutationLock(orderId, async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await new Promise((r) => setTimeout(r, 5));
          inside -= 1;
          completed += 1;
          return i;
        }).catch((err) => {
          assert.ok(err instanceof OrderMutationLockError);
          return null;
        }),
      ),
    );

    assert.equal(maxInside, 1, 'the lock must serialize every worker');
    assert.ok(completed > 0);
    // Every entry into the critical section was bought by exactly one winning
    // atomic create — no worker entered on the strength of a read.
    const creates = store.ops.filter((o) => o.startsWith('create:')).length;
    assert.equal(creates, completed, 'one successful atomic create per entry');
    assert.equal(store.keys.size, 0, 'every holder released its own key');
  });
});

// ── Ownership-safe release (blocker 3) ──────────────────────────────────────
//
// Release must delete ONLY after a positive, successful, parsed ownership read
// whose owner token matches ours. A read failure, a storage failure, or
// malformed data must never be collapsed to "nobody owns this" and must never
// cause a deletion.

test('release: MATCHING owner → the lock is deleted', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_rel_match';

  await withProductionLockEnv(store, () => 'w', async () => {
    let outcome: string | undefined;
    await withOrderMutationLock(orderId, async (lock) => {
      outcome = await lock.release();
    });
    assert.equal(outcome, 'released');
    assert.equal(store.keys.has(genKey(orderId, 1)), false, 'our own lock is removed');
    assert.ok(store.ops.includes(`remove:${genKey(orderId, 1)}`));
  });
});

test('release: READ FAILURE → no delete (fail closed, never collapsed to null)', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_rel_readfail';

  await withProductionLockEnv(store, () => 'w', async () => {
    let outcome: string | undefined;
    await withOrderMutationLock(orderId, async (lock) => {
      store.failReads.add(genKey(orderId, lock.generation));
      outcome = await lock.release();
    });
    assert.equal(outcome, 'read_failed');
    assert.equal(
      store.ops.filter((o) => o.startsWith('remove:')).length,
      0,
      'a failed ownership read must NEVER delete a lock',
    );
    assert.ok(store.keys.has(genKey(orderId, 1)), 'the lock key survives the failed release');
  });
});

test('release: MALFORMED lock data → no delete (fail closed)', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_rel_malformed';

  await withProductionLockEnv(store, () => 'w', async () => {
    let outcome: string | undefined;
    await withOrderMutationLock(orderId, async (lock) => {
      // Truncated/corrupt record — unparseable, so ownership is unprovable.
      store.keys.set(genKey(orderId, lock.generation), '{"owner":"w","gener');
      outcome = await lock.release();
    });
    assert.equal(outcome, 'malformed');
    assert.equal(
      store.ops.filter((o) => o.startsWith('remove:')).length,
      0,
      'unparseable lock data must NEVER cause a deletion',
    );
    assert.ok(store.keys.has(genKey(orderId, 1)));
  });
});

test('release: lock data of the RIGHT shape but the WRONG owner → no delete', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_rel_changed_owner';

  await withProductionLockEnv(store, () => 'w', async () => {
    let outcome: string | undefined;
    await withOrderMutationLock(orderId, async (lock) => {
      store.keys.set(genKey(orderId, lock.generation), lockBody('someone-else', lock.generation, LIVE()));
      outcome = await lock.release();
    });
    assert.equal(outcome, 'not_owner');
    assert.equal(store.ops.filter((o) => o.startsWith('remove:')).length, 0);
    assert.equal(
      JSON.parse(store.keys.get(genKey(orderId, 1)) as string).owner,
      'someone-else',
      "another owner's lock must survive our release",
    );
  });
});

test('release: EXPIRED-and-RECLAIMED → deletes only our own generation, never the reclaimer\'s', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_rel_reclaimed';

  await withProductionLockEnv(store, () => 'w', async () => {
    process.env.HSB_ORDER_LOCK_LEASE_MS = '30';
    let outcome: string | undefined;
    let ourGen = 0;

    await withOrderMutationLock(orderId, async (lock) => {
      ourGen = lock.generation;
      // Let our own lease lapse...
      await new Promise((r) => setTimeout(r, 60));
      // ...and let another worker reclaim by creating the NEXT generation.
      store.keys.set(genKey(orderId, lock.generation + 1), lockBody('reclaimer', lock.generation + 1, LIVE()));

      // Fencing: a holder whose lease lapsed and who has been superseded must
      // not be able to prove it still holds the lock.
      await assert.rejects(() => lock.assertHeld(), OrderMutationLockError);

      outcome = await lock.release();
    });

    assert.equal(outcome, 'superseded');
    assert.equal(store.keys.has(genKey(orderId, ourGen)), false, 'our own generation is cleaned up');
    assert.ok(
      store.keys.has(genKey(orderId, ourGen + 1)),
      "the reclaimer's lock must survive — we may only ever delete our own key",
    );
    assert.equal(
      JSON.parse(store.keys.get(genKey(orderId, ourGen + 1)) as string).owner,
      'reclaimer',
    );
    assert.deepEqual(
      store.ops.filter((o) => o.startsWith('remove:')),
      [`remove:${genKey(orderId, ourGen)}`],
      'exactly one removal, and it was our own generation',
    );
  });
});

test('release: key already gone → reported absent, nothing deleted', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_rel_absent';

  await withProductionLockEnv(store, () => 'w', async () => {
    let outcome: string | undefined;
    await withOrderMutationLock(orderId, async (lock) => {
      store.keys.delete(genKey(orderId, lock.generation));
      outcome = await lock.release();
    });
    assert.equal(outcome, 'absent');
    assert.equal(store.ops.filter((o) => o.startsWith('remove:')).length, 0);
  });
});

// ── Fencing (assertHeld) ────────────────────────────────────────────────────

test('assertHeld: succeeds while genuinely held', async () => {
  const store = new FakeBlobStore();
  await withProductionLockEnv(store, () => 'w', async () => {
    await withOrderMutationLock('ord_fence_ok', async (lock) => {
      await lock.assertHeld(); // must not throw
    });
  });
});

test('assertHeld: fails closed when the lock key vanished', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_fence_gone';
  await withProductionLockEnv(store, () => 'w', async () => {
    await withOrderMutationLock(orderId, async (lock) => {
      store.keys.delete(genKey(orderId, lock.generation));
      await assert.rejects(() => lock.assertHeld(), OrderMutationLockError);
    });
  });
});

test('assertHeld: fails closed when the owner changed underneath us', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_fence_owner';
  await withProductionLockEnv(store, () => 'w', async () => {
    await withOrderMutationLock(orderId, async (lock) => {
      store.keys.set(genKey(orderId, lock.generation), lockBody('intruder', lock.generation, LIVE()));
      await assert.rejects(() => lock.assertHeld(), OrderMutationLockError);
    });
  });
});

test('assertHeld: fails closed when a read error makes ownership unprovable', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_fence_readfail';
  await withProductionLockEnv(store, () => 'w', async () => {
    await withOrderMutationLock(orderId, async (lock) => {
      store.failReads.add(genKey(orderId, lock.generation));
      await assert.rejects(() => lock.assertHeld(), OrderMutationLockError);
    });
  });
});

test('durable persistence without a Blob token fails closed (never an unlocked mutation)', async () => {
  const before = {
    token: process.env.BLOB_READ_WRITE_TOKEN,
    durable: process.env.HSB_REQUIRE_DURABLE_PERSISTENCE,
  };
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  try {
    let ran = false;
    await assert.rejects(
      () => withOrderMutationLock('ord_no_token', async () => { ran = true; return 1; }),
      OrderMutationLockError,
    );
    assert.equal(ran, false, 'the critical section must never run unlocked');
  } finally {
    if (before.token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = before.token;
    if (before.durable === undefined) delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
    else process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = before.durable;
  }
});

test('no lock record, audit line, or warning ever contains the blob token', async () => {
  const store = new FakeBlobStore();
  const orderId = 'ord_leak';
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await withProductionLockEnv(store, () => 'w', async () => {
      await withOrderMutationLock(orderId, async (lock) => {
        store.failReads.add(genKey(orderId, lock.generation)); // force a warn path
      });
    });
  } finally {
    console.warn = originalWarn;
  }
  const everything = [...store.keys.values(), ...store.ops, ...warnings].join('\n');
  assert.equal(everything.includes(FAKE_TOKEN), false, 'blob token must never be persisted or logged');
  assert.equal(/vercel_blob_rw_[A-Za-z0-9]/.test(everything), false);
  assert.ok(warnings.some((w) => w.includes('read_failed')), 'the fail-closed release is observable');
});
