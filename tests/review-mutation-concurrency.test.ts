/**
 * Concurrency + durability contract for the single per-order mutation lock.
 *
 * Every customer review mutation (accept / regenerate / acknowledge / wording
 * save / approve) and review-link preparation runs under one shared
 * withOrderMutationLock. These tests prove: no lost updates when two mutations
 * race, the unresolved-change approval block cannot be bypassed by an
 * interleaving, a crashed holder's stale lease is recovered, acquisition is
 * bounded, and release is ownership-safe. Interleaving is driven by the lock
 * itself (which imposes a total order), not by timing, so results are stable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, getOrder, persistOrder, withOrderMutationLock, OrderMutationLockError } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import {
  acceptPage,
  acknowledgeProofReview,
  approveWholeBook,
  regeneratePage,
  saveTextChangeRequest,
  hasUnresolvedChangeRequests,
} from '../src/lib/page-review.ts';

const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'a1b2'.repeat(12);

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-concurrency-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_ORDER_LOCK_TIMEOUT_MS;
}

// Lock layout: one immutable key per generation. Reclaiming a stale lease
// creates the NEXT generation; it never overwrites or deletes the incumbent's
// key. See the atomicity invariant in src/lib/orders.ts.
function lockDir(storeDir: string, orderId: string) {
  return path.join(storeDir, '.mutation-locks', 'order-mutation-locks', orderId);
}
function lockGenFile(storeDir: string, orderId: string, generation: number) {
  return path.join(lockDir(storeDir, orderId), `${String(generation).padStart(12, '0')}.lock`);
}
function writeLockGen(
  storeDir: string,
  orderId: string,
  generation: number,
  rec: { owner: string; expiresAt: number },
) {
  mkdirSync(lockDir(storeDir, orderId), { recursive: true });
  writeFileSync(
    lockGenFile(storeDir, orderId, generation),
    JSON.stringify({ owner: rec.owner, generation, acquiredAt: NOW, expiresAt: rec.expiresAt }),
  );
}
function lockGenerations(storeDir: string, orderId: string): number[] {
  try {
    return readdirSync(lockDir(storeDir, orderId))
      .map((n) => /^(\d{12})\.lock$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i, storyText: `Page ${i + 1}`, basePrompt: 'p', characterAnchor: 'a',
    currentImageUrl: `https://example.com/p${i}.png`, acceptedImageUrl: `https://example.com/p${i}.png`,
    generationProvider: null, generationModel: null, regenerateCount: 0, accepted: true,
    feedbackHistory: [], versionHistory: [], ...o,
  };
}

async function seed(id: string, o: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Testkid', bookFormat: 'digital', email: 'a@b.com' }, { id, now: NOW }),
    paymentStatus: 'paid', reviewStatus: 'in_review', storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: null, proofApprovalToken: TOKEN, pageArtifacts: [page(0), page(1)], ...o,
  };
  await persistOrder(order);
  return order;
}

const stubProvider: ImageProvider = {
  name: 'fal',
  async generate({ prompt }) {
    return { imageUrl: 'https://example.com/regen.png', provider: 'fal', model: 'stub', promptUsed: prompt, latencyMs: 1, error: null };
  },
};
const stubRebuild = async () => ({ ok: true as const, proofUrl: 'https://example.com/rebuilt.pdf' });

// ── Approve-gate cannot be bypassed under interleaving ──────────────────────

test('save then approve: pending request blocks approval (409, not approved)', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_sa', { proofReviewedAt: NOW });
    await saveTextChangeRequest({ orderId: 'ord_sa', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) });
    const apr = await approveWholeBook('ord_sa', { rebuildProof: stubRebuild });
    assert.equal(apr.ok, false);
    assert.equal(apr.status, 409);
    assert.notEqual((await getOrder('ord_sa'))?.reviewStatus, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('approve then save: an approved book rejects a new wording request (no downgrade)', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_as', { proofReviewedAt: NOW });
    const apr = await approveWholeBook('ord_as', { rebuildProof: stubRebuild });
    assert.equal(apr.ok, true);
    assert.equal((await getOrder('ord_as'))?.reviewStatus, 'approved');
    const sav = await saveTextChangeRequest({ orderId: 'ord_as', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) });
    assert.equal(sav.ok, false);
    assert.equal(sav.error, 'already_approved');
    assert.equal((await getOrder('ord_as'))?.reviewStatus, 'approved'); // not downgraded
  } finally {
    cleanup(dir);
  }
});

test('concurrent approve vs save: invariant holds regardless of who wins the lock', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_race', { proofReviewedAt: NOW });
    const [apr, sav] = await Promise.all([
      approveWholeBook('ord_race', { rebuildProof: stubRebuild }),
      saveTextChangeRequest({ orderId: 'ord_race', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) }),
    ]);
    const final = await getOrder('ord_race');
    if (final?.reviewStatus === 'approved') {
      // Approve won: save must have been rejected and no request lingers.
      assert.equal(apr.ok, true);
      assert.equal(sav.ok, false);
      assert.equal(hasUnresolvedChangeRequests(final.pageArtifacts ?? []), false);
    } else {
      // Save won: approval was blocked by the unresolved request.
      assert.equal(sav.ok, true);
      assert.equal(apr.ok, false);
      assert.equal(hasUnresolvedChangeRequests(final?.pageArtifacts ?? []), true);
    }
  } finally {
    cleanup(dir);
  }
});

// ── No lost updates across independent mutations ────────────────────────────

test('concurrent save (p0) vs accept (p1): both land, neither lost', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_sacc', { pageArtifacts: [page(0), page(1, { accepted: false })] });
    await Promise.all([
      saveTextChangeRequest({ orderId: 'ord_sacc', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) }),
      acceptPage({ orderId: 'ord_sacc', pageIndex: 1 }),
    ]);
    const o = await getOrder('ord_sacc');
    assert.equal(o?.pageArtifacts?.[0].customerReviewStatus, 'changes_requested');
    assert.equal(o?.pageArtifacts?.[1].accepted, true);
  } finally {
    cleanup(dir);
  }
});

test('concurrent save (p0) vs regenerate (p1): both land, neither lost', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_sreg');
    await Promise.all([
      saveTextChangeRequest({ orderId: 'ord_sreg', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) }),
      regeneratePage({ orderId: 'ord_sreg', pageIndex: 1, feedback: 'x' }, { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) }),
    ]);
    const o = await getOrder('ord_sreg');
    assert.equal(o?.pageArtifacts?.[0].customerRequestedChange?.note, 'reword');
    assert.equal(o?.pageArtifacts?.[1].regenerateCount, 1);
    assert.equal(o?.pageArtifacts?.[1].currentImageUrl, 'https://example.com/regen.png');
  } finally {
    cleanup(dir);
  }
});

test('concurrent save (p0) vs acknowledge-proof: both land, neither lost', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_sack');
    await Promise.all([
      saveTextChangeRequest({ orderId: 'ord_sack', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) }),
      acknowledgeProofReview('ord_sack', new Date(NOW)),
    ]);
    const o = await getOrder('ord_sack');
    assert.equal(o?.pageArtifacts?.[0].customerReviewStatus, 'changes_requested');
    assert.equal(o?.proofReviewedAt, NOW);
  } finally {
    cleanup(dir);
  }
});

// ── Lease durability: stale recovery, bounded acquisition, ownership-safe release ──

test('stale lease is recovered: a crashed holder never permanently strands the lock', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_stale');
    // A crashed holder's expired lease at generation 1.
    writeLockGen(dir, 'ord_stale', 1, { owner: 'ghost', expiresAt: Date.now() - 5_000 });
    const r = await saveTextChangeRequest({ orderId: 'ord_stale', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) });
    assert.equal(r.ok, true, 'stale lock must be reclaimed');
    assert.equal((await getOrder('ord_stale'))?.pageArtifacts?.[0].customerReviewStatus, 'changes_requested');
    // Reclaim advanced the generation (gen 2) instead of overwriting the
    // ghost's key. The reclaimer then garbage-collected the ghost's
    // provably-expired gen 1 and released its own gen 2, leaving nothing
    // stranded behind.
    assert.deepEqual(
      lockGenerations(dir, 'ord_stale'),
      [],
      'no lock key survives: gen 2 released, the ghost gen 1 garbage-collected',
    );
  } finally {
    cleanup(dir);
  }
});

test('bounded acquisition: a fresh (live) lock yields order_mutation_busy, not a hang', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_busy');
    process.env.HSB_ORDER_LOCK_TIMEOUT_MS = '250';
    // A live holder whose lease is far in the future.
    writeLockGen(dir, 'ord_busy', 1, { owner: 'holder', expiresAt: Date.now() + 60_000 });
    const started = Date.now();
    const r = await saveTextChangeRequest({ orderId: 'ord_busy', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) });
    const elapsed = Date.now() - started;
    assert.equal(r.ok, false);
    assert.equal(r.error, 'order_mutation_busy');
    assert.ok(elapsed < 5_000, `acquisition must be bounded (took ${elapsed}ms)`);
    // The live holder's lock was not touched, and no contender generation was
    // created behind its back.
    assert.equal(JSON.parse(readFileSync(lockGenFile(dir, 'ord_busy', 1), 'utf8')).owner, 'holder');
    assert.deepEqual(lockGenerations(dir, 'ord_busy'), [1]);
  } finally {
    cleanup(dir);
  }
});

test('ownership-safe release: a holder never deletes a lock reclaimed by another owner', async () => {
  const dir = makeTmp();
  try {
    mkdirSync(path.join(dir, '.mutation-locks'), { recursive: true });
    await withOrderMutationLock('ord_own', async (lock) => {
      // Simulate another worker reclaiming mid-operation. A reclaim always
      // creates the NEXT generation; it never touches ours.
      writeLockGen(dir, 'ord_own', lock.generation + 1, {
        owner: 'other-worker',
        expiresAt: Date.now() + 60_000,
      });
    });
    // Our release deleted only our own generation. The other worker's lock,
    // which we never proved ownership of, must survive.
    const survivor = lockGenFile(dir, 'ord_own', 2);
    assert.ok(existsSync(survivor), 'other owner lock must survive our release');
    assert.equal(JSON.parse(readFileSync(survivor, 'utf8')).owner, 'other-worker');
    assert.deepEqual(lockGenerations(dir, 'ord_own'), [2], 'our gen 1 released, their gen 2 intact');
  } finally {
    cleanup(dir);
  }
});

test('lock error surfaces as order_mutation_busy for invalid order ids (fail closed)', async () => {
  const dir = makeTmp();
  try {
    // An id the lock rejects (regex) makes withOrderMutationLock throw; the
    // service must translate it to a safe busy response, never proceed unlocked.
    const r = await saveTextChangeRequest({ orderId: 'bad id!', pageIndex: 0, note: 'x', reviewToken: TOKEN });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'order_mutation_busy');
    assert.ok(OrderMutationLockError);
  } finally {
    cleanup(dir);
  }
});
