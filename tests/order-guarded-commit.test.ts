/**
 * Guarded-commit (optimistic CAS) contract for every editable-review mutation.
 *
 * THE BLOCKER THIS CLOSES
 * -----------------------
 * The generation lock has atomic acquisition, but a lock cannot fence a durable
 * write: generation-1 holder A can pause past its lease, generation-2 holder B
 * can acquire and commit, and A can then resume and overwrite B.
 * `assertHeld()` followed by a separate unconditional write is a check→write
 * TOCTOU window — it is NOT fencing.
 *
 * The fix under test: the durable commit itself is conditional. Every mutation
 * reads the order together with a version token and writes back only if the
 * stored version is still exactly that token
 * (`put(..., { ifMatch: etag })` on Vercel Blob). A's stale-version write is
 * rejected BY THE STORE, after B has already advanced the record.
 *
 * FIDELITY
 * --------
 * The store below is a faithful model of the exact primitive the production
 * adapter uses, not an in-memory mutex:
 *   - a read returns the body AND the version that describes those bytes;
 *   - `replaceIfVersion` compares the stored version and writes in ONE step
 *     with no await in between (which is what the real store guarantees
 *     server-side), reporting 'version_conflict' on mismatch.
 * `production primitive is present` below asserts the real @vercel/blob package
 * still exposes that primitive, so a dependency bump cannot silently turn this
 * whole design back into a last-write-wins race.
 *
 * The order-mutation lock underneath is the REAL local-filesystem adapter
 * (exclusive link()-based generation keys), not a stub.
 *
 * Synthetic order ids and throwaway temp stores only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OrderMutationLockError,
  OrderVersionConflictError,
  appendAuditEventTo,
  applyFulfillmentPatchTo,
  createOrderRecord,
  getOrder,
  withOrderMutationLock,
  withOrderTransaction,
  __setOrderStoreAdapterFactoryForTests,
  __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord, OrderStoreAdapter, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import {
  acceptPage,
  acknowledgeProofReview,
  approveWholeBook,
  prepareCustomerReviewLink,
  regeneratePage,
  saveTextChangeRequest,
} from '../src/lib/page-review.ts';

const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'e5f6'.repeat(12);

// ── A faithful versioned store modelling Vercel Blob ETag / ifMatch ──────────

class FakeVersionedOrderStore {
  readonly keys = new Map<string, { body: string; version: string }>();
  readonly ops: string[] = [];
  private seq = 0;

  /** Runs immediately before a conditional replace resolves — lets a test pause
   *  a worker at exactly the "about to durably commit" instant. */
  beforeReplace: (caller: string, pathname: string) => Promise<void> = async () => {};

  /** Mirror directory so legacy readers (getOrder) observe the same records. */
  mirrorDir: string | null = null;

  private nextVersion() {
    this.seq += 1;
    return `"etag-${this.seq}"`;
  }

  private mirror(pathname: string, body: string) {
    if (!this.mirrorDir) return;
    const base = pathname.slice(pathname.lastIndexOf('/') + 1);
    writeFileSync(path.join(this.mirrorDir, base), body, 'utf8');
  }

  seed(pathname: string, order: OrderRecord) {
    const body = JSON.stringify(order, null, 2);
    this.keys.set(pathname, { body, version: this.nextVersion() });
    this.mirror(pathname, body);
  }

  currentOrder(pathname: string): OrderRecord {
    const e = this.keys.get(pathname);
    assert.ok(e, `no record at ${pathname}`);
    return JSON.parse(e.body) as OrderRecord;
  }

  adapterFor(caller: string): OrderStoreAdapter {
    const store = this;
    return {
      kind: 'blob-versioned-fake',

      async readVersioned(pathname) {
        const e = store.keys.get(pathname);
        if (!e) return null;
        store.ops.push(`read:${caller}:${e.version}`);
        // Body and version come from the same snapshot, exactly as get() does.
        return { body: e.body, version: e.version };
      },

      async createIfAbsent(pathname, body) {
        if (store.keys.has(pathname)) return { ok: false, reason: 'exists' };
        const version = store.nextVersion();
        store.keys.set(pathname, { body, version });
        store.mirror(pathname, body);
        store.ops.push(`create:${caller}:${version}`);
        return { ok: true, version };
      },

      async replaceIfVersion(pathname, body, expectedVersion) {
        await store.beforeReplace(caller, pathname);
        const e = store.keys.get(pathname);
        // The comparison and the write happen together with no await between
        // them — the same atomicity the store provides server-side for ifMatch.
        if (!e || e.version !== expectedVersion) {
          store.ops.push(`replace-rejected:${caller}:${expectedVersion}`);
          return { ok: false, reason: 'version_conflict' };
        }
        const version = store.nextVersion();
        store.keys.set(pathname, { body, version });
        store.mirror(pathname, body);
        store.ops.push(`replace:${caller}:${expectedVersion}->${version}`);
        return { ok: true, version };
      },
    };
  }
}

/**
 * Test marker on an arbitrary, review-irrelevant field. Built directly rather
 * than through applyFulfillmentPatchTo — FulfillmentPatch is deliberately
 * restricted to fulfillment fields and must not be widened for a test.
 */
function markOrder(order: OrderRecord, marker: string): OrderRecord {
  return { ...order, childAge: marker, updatedAt: NOW };
}

function orderPath(orderId: string) {
  return `orders/${orderId}.json`;
}

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    characterAnchor: 'a',
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

function makeOrder(id: string, o: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord({ childName: 'Testkid', bookFormat: 'digital', email: 'a@b.invalid' }, { id, now: NOW }),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://example.invalid/proof.pdf',
    proofReviewedAt: NOW,
    proofApprovalToken: TOKEN,
    pageArtifacts: [page(0), page(1)],
    auditEvents: [],
    ...o,
  };
}

interface Harness {
  store: FakeVersionedOrderStore;
  dir: string;
  setCaller: (name: string) => void;
}

function setup(): Harness {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-cas-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  const store = new FakeVersionedOrderStore();
  store.mirrorDir = dir;
  let caller = 'default';
  __setOrderStoreAdapterFactoryForTests(() => store.adapterFor(caller));
  return { store, dir, setCaller: (n) => { caller = n; } };
}

function teardown(h: Harness) {
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(h.dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_ORDER_LOCK_LEASE_MS;
  delete process.env.HSB_ORDER_LOCK_TIMEOUT_MS;
}

// ── The production primitive must actually exist ────────────────────────────

test('production primitive is present: @vercel/blob exposes ifMatch + a precondition error', async () => {
  const blob = await import('@vercel/blob');
  assert.ok(
    typeof blob.BlobPreconditionFailedError === 'function',
    'BlobPreconditionFailedError must exist — it is how a failed CAS is surfaced',
  );
  // The option is compile-time only, so assert on the shipped types + the
  // runtime header mapping. If a dependency bump drops either, this whole design
  // silently degrades to last-write-wins and this test must fail loudly.
  const distDir = 'node_modules/@vercel/blob/dist';
  const declaresIfMatch = readdirSync(distDir)
    .filter((f) => f.endsWith('.d.ts'))
    .some((f) => /ifMatch\?: string/.test(readFileSync(path.join(distDir, f), 'utf8')));
  assert.ok(declaresIfMatch, 'put/create options must still accept ifMatch');

  const runtime = readFileSync(path.join(distDir, 'index.js'), 'utf8');
  assert.match(runtime, /if-match/i, 'the SDK must still send an if-match header');
});

// ══ THE HEADLINE CASE ═══════════════════════════════════════════════════════
//
//   A acquires generation 1, pauses immediately before its durable commit.
//   B acquires generation 2, writes, completes.
//   A resumes → A's durable write MUST fail and MUST NOT overwrite B.

test(
  'expired generation-1 holder pauses before commit, generation-2 holder commits, ' +
    "then holder A's durable write is REJECTED BY THE STORE and does not overwrite B",
  async () => {
    const h = setup();
    try {
      const orderId = 'ord_fence_ab';
      h.store.seed(orderPath(orderId), makeOrder(orderId, { childAge: 'original' }));

      // A short lease so A's generation-1 lease genuinely lapses while paused.
      process.env.HSB_ORDER_LOCK_LEASE_MS = '60';
      process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '4000';

      let releaseA!: () => void;
      const aMayCommit = new Promise<void>((r) => { releaseA = r; });
      let aIsPaused!: () => void;
      const aHasPaused = new Promise<void>((r) => { aIsPaused = r; });

      h.store.beforeReplace = async (caller) => {
        if (caller !== 'A') return;
        aIsPaused();          // A is now at the exact instant before its commit
        await aMayCommit;     // ...and stays there while B does its work
      };

      let aGeneration = 0;
      let bGeneration = 0;

      // ── Worker A ────────────────────────────────────────────────────────
      const workerA = (async () => {
        h.setCaller('A');
        try {
          return await withOrderMutationLock(orderId, async (lock) => {
            aGeneration = lock.generation;
            return await withOrderTransaction<string>(
              orderId,
              (order) => ({
                commit: markOrder(order, 'WRITTEN-BY-A'),
                result: 'A committed',
              }),
              { lock },
            );
          });
        } catch (err) {
          assert.ok(
            err instanceof OrderMutationLockError || err instanceof OrderVersionConflictError,
            `A must fail closed, got: ${String(err)}`,
          );
          return `A failed: ${err instanceof Error ? err.name : 'unknown'}`;
        }
      })();

      await aHasPaused;

      // A's lease lapses while it is parked before its commit.
      await new Promise((r) => setTimeout(r, 120));

      // ── Worker B ────────────────────────────────────────────────────────
      h.setCaller('B');
      const bResult = await withOrderMutationLock(orderId, async (lock) => {
        bGeneration = lock.generation;
        return await withOrderTransaction<string>(
          orderId,
          (order) => ({
            commit: markOrder(order, 'WRITTEN-BY-B'),
            result: 'B committed',
          }),
          { lock },
        );
      });
      assert.equal(bResult, 'B committed');
      assert.ok(bGeneration > aGeneration, `B must hold a newer generation (A=${aGeneration}, B=${bGeneration})`);

      // ── A resumes ───────────────────────────────────────────────────────
      h.setCaller('A');
      releaseA();
      const aOutcome = await workerA;

      // 1. A did not succeed.
      assert.notEqual(aOutcome, 'A committed', 'the stale holder must never commit');
      assert.match(aOutcome, /^A failed:/);

      // 2. B's write is intact — A did not overwrite it.
      const finalOrder = h.store.currentOrder(orderPath(orderId));
      assert.equal(finalOrder.childAge, 'WRITTEN-BY-B', "B's committed value must survive");

      // 3. THE POINT: A was stopped by the DURABLE COMMIT itself, not by a
      //    preceding ownership check. The store rejected A's conditional write.
      assert.ok(
        h.store.ops.some((o) => o.startsWith('replace-rejected:A:')),
        'A must have attempted a conditional commit and been rejected by the store',
      );
      // And B's replace succeeded from the very version A was holding.
      assert.ok(h.store.ops.some((o) => o.startsWith('replace:B:')));
    } finally {
      teardown(h);
    }
  },
);

test('the rejection is produced by the commit, not by a pre-commit check (no assertHeld involved)', async () => {
  const h = setup();
  try {
    const orderId = 'ord_commit_rejects';
    h.store.seed(orderPath(orderId), makeOrder(orderId, { childAge: 'v0' }));

    // Read a version, let someone else advance the record, then attempt to
    // commit on the stale version WITHOUT any lock or ownership check at all.
    h.setCaller('reader');
    const adapter = h.store.adapterFor('reader');
    const first = await adapter.readVersioned(orderPath(orderId));
    assert.ok(first);

    h.setCaller('other');
    const other = h.store.adapterFor('other');
    const advanced = await other.replaceIfVersion(
      orderPath(orderId),
      JSON.stringify({ ...JSON.parse(first.body), childAge: 'v1' }, null, 2),
      first.version,
    );
    assert.equal(advanced.ok, true);

    // The stale write is refused purely by the version precondition.
    const stale = await adapter.replaceIfVersion(
      orderPath(orderId),
      JSON.stringify({ ...JSON.parse(first.body), childAge: 'CLOBBER' }, null, 2),
      first.version,
    );
    assert.equal(stale.ok, false);
    assert.equal((stale as { reason: string }).reason, 'version_conflict');
    assert.equal(h.store.currentOrder(orderPath(orderId)).childAge, 'v1', 'no clobber');
  } finally {
    teardown(h);
  }
});

test('a superseded holder whose commit conflicts is refused the RETRY — it cannot loop until it wins', async () => {
  const h = setup();
  try {
    const orderId = 'ord_no_loop';
    h.store.seed(orderPath(orderId), makeOrder(orderId, { childAge: 'base' }));
    process.env.HSB_ORDER_LOCK_LEASE_MS = '60';
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '4000';

    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((r) => { releaseA = r; });
    let aIsPaused!: () => void;
    const aHasPaused = new Promise<void>((r) => { aIsPaused = r; });
    h.store.beforeReplace = async (caller) => {
      if (caller !== 'A') return;
      aIsPaused();
      await aMayCommit;
    };

    let attempts = 0;
    h.setCaller('A');
    // A reads at the CURRENT version, then parks before its commit, so when it
    // resumes its version is genuinely stale and the commit must conflict.
    const workerA = withOrderMutationLock(orderId, async (lock) =>
      withOrderTransaction<string>(
        orderId,
        (order) => {
          attempts += 1;
          return {
            commit: markOrder(order, 'A-clobber'),
            result: 'A committed',
          };
        },
        { lock },
      ),
    );

    await aHasPaused;
    await new Promise((r) => setTimeout(r, 120)); // A's lease lapses

    h.setCaller('B');
    await withOrderMutationLock(orderId, async (bLock) =>
      withOrderTransaction<string>(
        orderId,
        (order) => ({
          commit: markOrder(order, 'B-owns-this'),
          result: 'ok',
        }),
        { lock: bLock },
      ),
    );

    h.setCaller('A');
    releaseA();
    await assert.rejects(
      () => workerA,
      OrderMutationLockError,
      'the superseded holder must be refused the retry, not allowed to loop to success',
    );

    assert.equal(attempts, 1, 'exactly one attempt — no retry loop for a superseded holder');
    assert.equal(h.store.currentOrder(orderPath(orderId)).childAge, 'B-owns-this');
    assert.ok(h.store.ops.some((o) => o.startsWith('replace-rejected:A:')));
  } finally {
    teardown(h);
  }
});

test('bounded retry: a permanently-conflicting store yields OrderVersionConflictError, never a stale write', async () => {
  const h = setup();
  try {
    const orderId = 'ord_bounded';
    h.store.seed(orderPath(orderId), makeOrder(orderId, { childAge: 'stable' }));

    // Advance the record on every single commit attempt, so no attempt can win.
    h.store.beforeReplace = async (caller) => {
      if (caller !== 'A') return;
      const e = h.store.keys.get(orderPath(orderId));
      if (!e) return;
      h.store.keys.set(orderPath(orderId), { body: e.body, version: `"etag-moved-${Math.random()}"` });
    };

    h.setCaller('A');
    let attempts = 0;
    await assert.rejects(
      () =>
        withOrderTransaction<string>(
          orderId,
          (order) => {
            attempts += 1;
            return { commit: markOrder(order, 'never'), result: 'x' };
          },
          { maxAttempts: 3 },
        ),
      OrderVersionConflictError,
    );
    assert.equal(attempts, 3, 'retry budget is bounded and honoured');
    assert.equal(h.store.currentOrder(orderPath(orderId)).childAge, 'stable', 'no stale write landed');
  } finally {
    teardown(h);
  }
});

// ── Conflict/retry preserves unrelated concurrent changes ───────────────────

/**
 * Forces exactly ONE version conflict on the given caller's first commit
 * attempt, by landing an unrelated concurrent change (childAge marker) in
 * between the read and the write.
 */
function interposeOneUnrelatedCommit(h: Harness, orderId: string, marker: string) {
  let fired = false;
  h.store.beforeReplace = async () => {
    if (fired) return;
    fired = true;
    const e = h.store.keys.get(orderPath(orderId));
    if (!e) return;
    const order = JSON.parse(e.body) as OrderRecord;
    const body = JSON.stringify({ ...order, childAge: marker }, null, 2);
    h.store.keys.set(orderPath(orderId), { body, version: `"etag-interposed-${marker}"` });
    if (h.store.mirrorDir) {
      writeFileSync(path.join(h.store.mirrorDir, `${orderId}.json`), body, 'utf8');
    }
  };
  return () => fired;
}

const stubProvider: ImageProvider = {
  name: 'fal',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.invalid/regen.png',
      provider: 'fal',
      model: 'stub',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};
const stubRebuild = async () => ({ ok: true as const, proofUrl: 'https://example.invalid/rebuilt.pdf' });

// Every editable-review mutation's guarded commit path.
const MUTATIONS: Array<{
  name: string;
  seed: (orderId: string) => OrderRecord;
  run: (orderId: string) => Promise<{ ok: boolean }>;
  verify: (order: OrderRecord) => void;
}> = [
  {
    name: 'acceptPage',
    seed: (id) => makeOrder(id, { pageArtifacts: [page(0), page(1, { accepted: false, acceptedImageUrl: null })] }),
    run: (id) => acceptPage({ orderId: id, pageIndex: 1 }),
    verify: (o) => assert.equal(o.pageArtifacts?.[1].accepted, true, 'accept landed'),
  },
  {
    name: 'regeneratePage',
    seed: (id) => makeOrder(id),
    run: (id) =>
      regeneratePage(
        { orderId: id, pageIndex: 1, feedback: 'brighter' },
        { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) },
      ),
    verify: (o) => assert.equal(o.pageArtifacts?.[1].regenerateCount, 1, 'regenerate landed'),
  },
  {
    name: 'acknowledgeProofReview',
    seed: (id) => makeOrder(id, { proofReviewedAt: null }),
    run: (id) => acknowledgeProofReview(id, new Date(NOW)),
    verify: (o) => assert.equal(o.proofReviewedAt, NOW, 'ack landed'),
  },
  {
    name: 'saveTextChangeRequest',
    seed: (id) => makeOrder(id),
    run: (id) =>
      saveTextChangeRequest(
        { orderId: id, pageIndex: 0, note: 'please reword', reviewToken: TOKEN },
        { now: () => new Date(NOW) },
      ),
    verify: (o) =>
      assert.equal(o.pageArtifacts?.[0].customerReviewStatus, 'changes_requested', 'wording request landed'),
  },
  {
    name: 'approveWholeBook',
    seed: (id) => makeOrder(id),
    run: (id) => approveWholeBook(id, { rebuildProof: stubRebuild, approvePrint: async () => ({ ok: true }) }),
    verify: (o) => assert.equal(o.reviewStatus, 'approved', 'approval landed'),
  },
  {
    name: 'prepareCustomerReviewLink',
    seed: (id) => makeOrder(id, { proofApprovalToken: null }),
    run: (id) => prepareCustomerReviewLink(id, { tokenFactory: () => 'a'.repeat(48) }),
    verify: (o) => assert.equal(o.proofApprovalToken, 'a'.repeat(48), 'link preparation landed'),
  },
];

for (const m of MUTATIONS) {
  test(`${m.name}: a version conflict retries from the latest record and PRESERVES the unrelated change`, async () => {
    const h = setup();
    try {
      const orderId = `ord_cas_${m.name.toLowerCase()}`;
      h.store.seed(orderPath(orderId), m.seed(orderId));
      const marker = `CONCURRENT-${m.name}`;
      const fired = interposeOneUnrelatedCommit(h, orderId, marker);
      h.setCaller('mutator');

      const res = await m.run(orderId);
      assert.equal(res.ok, true, `${m.name} must still succeed after a conflict retry`);
      assert.equal(fired(), true, 'the test must actually have forced a conflict');

      const final = h.store.currentOrder(orderPath(orderId));
      // The unrelated concurrent change was NOT clobbered by the retry...
      assert.equal(final.childAge, marker, 'unrelated concurrent change must survive');
      // ...and the mutation's own effect still landed.
      m.verify(final);
      // The conflict really went through the conditional-commit path.
      assert.ok(
        h.store.ops.some((o) => o.startsWith('replace-rejected:')),
        'a conditional commit must have been rejected at least once',
      );
    } finally {
      teardown(h);
    }
  });
}

// ── Approval can never be downgraded through the retry path ─────────────────

test('regenerate that conflicts with a concurrent APPROVAL fails closed on retry — approval is not downgraded', async () => {
  const h = setup();
  try {
    const orderId = 'ord_cas_approval_wins';
    h.store.seed(orderPath(orderId), makeOrder(orderId));

    // While regenerate is committing, an approval lands. Regenerate's retry must
    // re-read, observe reviewStatus='approved', and refuse to persist.
    let fired = false;
    h.store.beforeReplace = async () => {
      if (fired) return;
      fired = true;
      const e = h.store.keys.get(orderPath(orderId));
      if (!e) return;
      const order = JSON.parse(e.body) as OrderRecord;
      const approved = appendAuditEventTo(
        applyFulfillmentPatchTo(order, { reviewStatus: 'approved' }),
        { type: 'whole_book_approved', meta: { bookFormat: order.bookFormat, proofUrl: null } },
      );
      const body = JSON.stringify(approved, null, 2);
      h.store.keys.set(orderPath(orderId), { body, version: '"etag-approved"' });
      if (h.store.mirrorDir) {
        writeFileSync(path.join(h.store.mirrorDir, `${orderId}.json`), body, 'utf8');
      }
    };

    h.setCaller('regen');
    const res = await regeneratePage(
      { orderId, pageIndex: 1, feedback: 'brighter' },
      { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) },
    );

    assert.equal(res.ok, false, 'regeneration must not persist onto an approved book');
    assert.equal(res.status, 409);
    assert.equal(res.error, 'already_approved');

    const final = h.store.currentOrder(orderPath(orderId));
    assert.equal(final.reviewStatus, 'approved', 'approval must NOT be downgraded');
    assert.equal(final.pageArtifacts?.[1].regenerateCount, 0, 'no regeneration recorded');
    assert.equal(
      final.pageArtifacts?.[1].currentImageUrl,
      'https://example.invalid/p1.png',
      'the approved image is untouched',
    );
    assert.ok(final.auditEvents?.some((e) => e.type === 'whole_book_approved'));
    assert.equal(final.auditEvents?.some((e) => e.type === 'page_regenerated'), false);
  } finally {
    teardown(h);
  }
});

test('accept that conflicts with a concurrent APPROVAL fails closed on retry', async () => {
  const h = setup();
  try {
    const orderId = 'ord_cas_accept_vs_approve';
    h.store.seed(orderPath(orderId), makeOrder(orderId, {
      pageArtifacts: [page(0), page(1, { accepted: false, acceptedImageUrl: null })],
    }));

    let fired = false;
    h.store.beforeReplace = async () => {
      if (fired) return;
      fired = true;
      const e = h.store.keys.get(orderPath(orderId));
      if (!e) return;
      const order = JSON.parse(e.body) as OrderRecord;
      const body = JSON.stringify(applyFulfillmentPatchTo(order, { reviewStatus: 'approved' }), null, 2);
      h.store.keys.set(orderPath(orderId), { body, version: '"etag-approved-2"' });
      if (h.store.mirrorDir) {
        writeFileSync(path.join(h.store.mirrorDir, `${orderId}.json`), body, 'utf8');
      }
    };

    h.setCaller('acceptor');
    const res = await acceptPage({ orderId, pageIndex: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.error, 'already_approved');

    const final = h.store.currentOrder(orderPath(orderId));
    assert.equal(final.reviewStatus, 'approved');
    assert.equal(final.pageArtifacts?.[1].accepted, false, 'accept must not have landed');
  } finally {
    teardown(h);
  }
});

test('wording request that conflicts with a concurrent APPROVAL fails closed on retry', async () => {
  const h = setup();
  try {
    const orderId = 'ord_cas_save_vs_approve';
    h.store.seed(orderPath(orderId), makeOrder(orderId));

    let fired = false;
    h.store.beforeReplace = async () => {
      if (fired) return;
      fired = true;
      const e = h.store.keys.get(orderPath(orderId));
      if (!e) return;
      const order = JSON.parse(e.body) as OrderRecord;
      const body = JSON.stringify(applyFulfillmentPatchTo(order, { reviewStatus: 'approved' }), null, 2);
      h.store.keys.set(orderPath(orderId), { body, version: '"etag-approved-3"' });
      if (h.store.mirrorDir) {
        writeFileSync(path.join(h.store.mirrorDir, `${orderId}.json`), body, 'utf8');
      }
    };

    h.setCaller('saver');
    const res = await saveTextChangeRequest(
      { orderId, pageIndex: 0, note: 'reword', reviewToken: TOKEN },
      { now: () => new Date(NOW) },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, 'already_approved');

    const final = h.store.currentOrder(orderPath(orderId));
    assert.equal(final.reviewStatus, 'approved', 'approval must not be downgraded');
    assert.notEqual(final.pageArtifacts?.[0].customerReviewStatus, 'changes_requested');
  } finally {
    teardown(h);
  }
});

test('prepare-review-link that conflicts never rotates a token another writer just prepared', async () => {
  const h = setup();
  try {
    const orderId = 'ord_cas_token';
    h.store.seed(orderPath(orderId), makeOrder(orderId, { proofApprovalToken: null }));
    const winner = 'w'.repeat(48);

    let fired = false;
    h.store.beforeReplace = async () => {
      if (fired) return;
      fired = true;
      const e = h.store.keys.get(orderPath(orderId));
      if (!e) return;
      const order = JSON.parse(e.body) as OrderRecord;
      const body = JSON.stringify({ ...order, proofApprovalToken: winner }, null, 2);
      h.store.keys.set(orderPath(orderId), { body, version: '"etag-token"' });
      if (h.store.mirrorDir) {
        writeFileSync(path.join(h.store.mirrorDir, `${orderId}.json`), body, 'utf8');
      }
    };

    h.setCaller('preparer');
    const res = await prepareCustomerReviewLink(orderId, { tokenFactory: () => 'z'.repeat(48) });
    assert.equal(res.ok, true);
    assert.equal(res.alreadyPrepared, true, 'the retry must observe the other writer’s token');
    assert.equal(res.token, winner);
    assert.equal(h.store.currentOrder(orderPath(orderId)).proofApprovalToken, winner, 'token not rotated');
  } finally {
    teardown(h);
  }
});

// ── Leakage ─────────────────────────────────────────────────────────────────

test('guarded-commit paths leak no review token into audit events', async () => {
  const h = setup();
  try {
    const orderId = 'ord_cas_leak';
    h.store.seed(orderPath(orderId), makeOrder(orderId));
    h.setCaller('leaker');
    await saveTextChangeRequest(
      { orderId, pageIndex: 0, note: 'super secret wording note', reviewToken: TOKEN },
      { now: () => new Date(NOW) },
    );
    const final = h.store.currentOrder(orderPath(orderId));
    const audit = JSON.stringify(final.auditEvents ?? []);
    assert.equal(audit.includes(TOKEN), false, 'review token must never reach the audit trail');
    assert.equal(audit.includes('super secret wording note'), false, 'note text must never reach the audit trail');
    const opsAndVersions = h.store.ops.join('\n');
    assert.equal(opsAndVersions.includes(TOKEN), false);
  } finally {
    teardown(h);
  }
});

// ── The legacy reader still observes guarded commits ────────────────────────

test('records written through the guarded commit are readable by getOrder', async () => {
  const h = setup();
  try {
    const orderId = 'ord_cas_readback';
    h.store.seed(orderPath(orderId), makeOrder(orderId, { proofReviewedAt: null }));
    h.setCaller('acker');
    const res = await acknowledgeProofReview(orderId, new Date(NOW));
    assert.equal(res.ok, true);
    const viaLegacy = await getOrder(orderId);
    assert.equal(viaLegacy?.proofReviewedAt, NOW);
  } finally {
    teardown(h);
  }
});
