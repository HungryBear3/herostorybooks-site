/**
 * Vercel Blob ETag CAS for order JSON writes.
 *
 * The CAS read-modify-write loop (casMutateOrder) is dependency-injected, so we
 * exercise the concurrency semantics deterministically with an in-memory ETag
 * store — no live blob. Plus a dev/no-token regression on updateFulfillmentState
 * to prove the non-CAS fallback behavior is preserved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import {
  casMutateOrder,
  createOrderRecord,
  persistOrder,
  getOrder,
  updateFulfillmentState,
  appendAuditEvent,
  type OrderCasStore,
  type OrderRecord,
} from '../src/lib/orders.ts';

function baseOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.com' },
      { id: 'ord_cas_test', now: '2026-06-08T00:00:00Z' },
    ),
    paymentStatus: 'paid',
    ...overrides,
  };
}

class FakePreconditionError extends Error {}

/**
 * In-memory CAS store. `write` enforces ifMatch against the current etag and
 * bumps it on success. `queueExternalCommit` injects a concurrent writer that
 * lands right before the NEXT write attempt (so that write sees a stale etag).
 */
function memCasStore(initial: OrderRecord) {
  let current = structuredClone(initial);
  let version = 1;
  const etag = () => `etag-v${version}`;
  let externalQueue: Array<(o: OrderRecord) => OrderRecord> = [];
  let reads = 0;
  let writes = 0;

  const store: OrderCasStore = {
    read: async () => {
      reads += 1;
      return { order: structuredClone(current), etag: etag() };
    },
    write: async (order, ifMatch) => {
      writes += 1;
      // A queued concurrent writer commits first, invalidating the caller's etag.
      const ext = externalQueue.shift();
      if (ext) {
        current = ext(structuredClone(current));
        version += 1;
      }
      if (ifMatch !== etag()) throw new FakePreconditionError('etag mismatch');
      current = structuredClone(order);
      version += 1;
    },
    isPreconditionError: (err) => err instanceof FakePreconditionError,
  };

  return {
    store,
    queueExternalCommit(fn: (o: OrderRecord) => OrderRecord) { externalQueue.push(fn); },
    get current() { return current; },
    get reads() { return reads; },
    get writes() { return writes; },
  };
}

// ── concurrent updates do not clobber each other ──────────────────────────────

test('concurrent writer between read and write → CAS retries and preserves BOTH changes', async () => {
  const mem = memCasStore(baseOrder({ fulfillmentStatus: 'generating_images', auditEvents: [] }));
  // A concurrent writer appends an audit event right before our first write.
  mem.queueExternalCommit((o) => ({ ...o, auditEvents: [...(o.auditEvents ?? []), { at: 'x', type: 'page_accepted' }] }));

  const res = await casMutateOrder(mem.store, (latest) => ({ ...latest, fulfillmentStatus: 'complete' }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.ok(res.attempts >= 2, 'should retry after the precondition failure');
  // Our change landed AND the concurrent audit event survived.
  assert.equal(mem.current.fulfillmentStatus, 'complete');
  assert.equal(mem.current.auditEvents?.length, 1);
  assert.equal(mem.current.auditEvents?.[0]?.type, 'page_accepted');
});

// ── stale write retries safely ────────────────────────────────────────────────

test('stale write (one precondition failure) retries and then succeeds', async () => {
  const mem = memCasStore(baseOrder({ reviewStatus: 'in_review' }));
  mem.queueExternalCommit((o) => ({ ...o, reviewStatus: 'customer_changes_requested' }));
  const res = await casMutateOrder(mem.store, (latest) => ({ ...latest, fulfillmentStatus: 'proof_ready' }));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.attempts, 2);
  // Re-applied onto the latest snapshot: concurrent reviewStatus preserved.
  assert.equal(mem.current.reviewStatus, 'customer_changes_requested');
  assert.equal(mem.current.fulfillmentStatus, 'proof_ready');
});

// ── payment / proof / fulfillment fields are not lost ─────────────────────────

test('CAS retry preserves payment, proof artifact, and pageArtifacts set by a concurrent writer', async () => {
  const mem = memCasStore(baseOrder({
    paymentStatus: 'paid',
    storyArtifactUrl: 'https://cdn/proof.pdf',
    pageArtifacts: [],
  }));
  // Concurrent writer flips reviewStatus to approved before our write.
  mem.queueExternalCommit((o) => ({ ...o, reviewStatus: 'approved' }));
  const res = await casMutateOrder(mem.store, (latest) => ({ ...latest, fulfillmentStatus: 'complete' }));
  assert.equal(res.ok, true);
  assert.equal(mem.current.paymentStatus, 'paid', 'payment not lost');
  assert.equal(mem.current.storyArtifactUrl, 'https://cdn/proof.pdf', 'proof artifact not lost');
  assert.equal(mem.current.reviewStatus, 'approved', 'concurrent review state not lost');
  assert.equal(mem.current.fulfillmentStatus, 'complete', 'our fulfillment change applied');
});

// ── failure path does not silently mark success ───────────────────────────────

test('exhausted preconditions → ok:false (never silent success), order unchanged', async () => {
  const mem = memCasStore(baseOrder({ fulfillmentStatus: 'generating_images' }));
  // Every write attempt is preceded by a concurrent commit → always stale.
  for (let i = 0; i < 10; i += 1) mem.queueExternalCommit((o) => ({ ...o, fulfillmentAttempts: (o.fulfillmentAttempts ?? 0) + 1 }));
  const res = await casMutateOrder(mem.store, (latest) => ({ ...latest, fulfillmentStatus: 'complete' }), 3);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'precondition_exhausted');
  assert.equal(res.attempts, 3);
  assert.notEqual(mem.current.fulfillmentStatus, 'complete', 'failed write must NOT have applied');
});

test('non-precondition write error propagates (not swallowed, not success)', async () => {
  const store: OrderCasStore = {
    read: async () => ({ order: baseOrder(), etag: 'e1' }),
    write: async () => { throw new Error('blob 500'); },
    isPreconditionError: () => false,
  };
  await assert.rejects(
    () => casMutateOrder(store, (o) => ({ ...o, fulfillmentStatus: 'complete' })),
    /blob 500/,
  );
});

test('missing order → ok:false not_found (no write attempted)', async () => {
  let writes = 0;
  const store: OrderCasStore = {
    read: async () => null,
    write: async () => { writes += 1; },
    isPreconditionError: () => false,
  };
  const res = await casMutateOrder(store, (o) => o);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not_found');
  assert.equal(writes, 0);
});

test('build() error (e.g. payment gate) propagates and is not retried', async () => {
  const mem = memCasStore(baseOrder());
  await assert.rejects(
    () => casMutateOrder(mem.store, () => { throw new Error('payment gate'); }),
    /payment gate/,
  );
  assert.equal(mem.reads, 1, 'must not retry a build() failure');
  assert.equal(mem.writes, 0);
});

// ── live blob CAS read path source guard ─────────────────────────────────────

test('live CAS read uses authenticated no-cache SDK body, not public URL readBlobText', () => {
  const thisFile = fileURLToPath(import.meta.url);
  const ordersSource = readFileSync(path.resolve(path.dirname(thisFile), '../src/lib/orders.ts'), 'utf8');
  const match = ordersSource.match(/async function readOrderWithEtag[\s\S]*?^}/m);
  assert.ok(match, 'readOrderWithEtag source should be present');
  const block = match?.[0] ?? '';
  assert.match(block, /await head\(pathname, \{ token \}\)/);
  assert.match(block, /await get\(pathname, \{/);
  assert.match(block, /useCache: false/);
  assert.doesNotMatch(block, /readBlobText\(/);
});

// ── dev / no-token fallback preserves prior behavior ──────────────────────────

test('updateFulfillmentState (no blob token) still persists + preserves fields; payment gate intact', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-cas-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await persistOrder(baseOrder({ paymentStatus: 'paid', storyArtifactUrl: 'https://cdn/x.pdf', pageArtifacts: [] }));
    // Benign patch (not a proof-release transition, which a separate policy gate
    // governs): proves the no-token read-modify-write persists + preserves fields.
    const updated = await updateFulfillmentState('ord_cas_test', { fulfillmentLastError: 'retry-note' });
    assert.equal(updated?.fulfillmentLastError, 'retry-note');
    const after = await getOrder('ord_cas_test');
    assert.equal(after?.fulfillmentLastError, 'retry-note');
    assert.equal(after?.paymentStatus, 'paid');
    assert.equal(after?.storyArtifactUrl, 'https://cdn/x.pdf');

    // append audit event persists onto latest
    await appendAuditEvent('ord_cas_test', { type: 'proof_generated' });
    const after2 = await getOrder('ord_cas_test');
    assert.equal(after2?.auditEvents?.length, 1);

    // Payment gate still refuses a paid-only mutation on an unpaid order.
    await persistOrder(baseOrder({ id: 'ord_unpaid', paymentStatus: 'pending' }));
    await assert.rejects(
      () => updateFulfillmentState('ord_unpaid', { fulfillmentStatus: 'complete' }),
      /Refusing fulfillment mutation/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HSB_ORDER_STORE_DIR;
  }
});
