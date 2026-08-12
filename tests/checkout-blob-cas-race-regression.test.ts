/*
 * Regression coverage for the production checkout draft-to-final Blob CAS race.
 *
 * Symptom: after the draft order was saved but before Stripe, the guarded final
 * save reported the public Blob "changed on all three retries" and returned 503
 * with NO concurrent writer. Root cause: the versioned read required the public
 * CDN's ETag to be byte-identical to the `list()` metadata ETag and gated the
 * CDN GET on `If-Match`. The two subsystems do not guarantee identical ETag
 * decoration (weak/quoting), so an equivalent validator was read as a foreign
 * change on every attempt.
 *
 * These tests drive the REAL `readPublicOrderBlobVersioned` (the authoritative
 * read/version path) through an in-memory public-Blob simulation, so the draft
 * create + guarded final save exercise exactly the fixed code. Removing
 * `normalizeEtag` (raw comparison) makes the draft-to-final test throw again —
 * the mutation proof for the fix.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readPublicOrderBlobVersioned,
  persistNewOrder,
  withOrderTransaction,
  OrderVersionConflictError,
  __setOrderStoreAdapterFactoryForTests,
  __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord, OrderStoreAdapter } from '../src/lib/orders.ts';

const ORDER_ID = 'ord_cas_regression';
const orderPath = (id: string) => `orders/${id}.json`;

function draftOrder(id: string): OrderRecord {
  return {
    id,
    email: 'buyer@example.com',
    childName: 'Nova',
    theme: 'custom-voice-story',
    bookFormat: 'digital',
    paymentStatus: 'unpaid',
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
  } as unknown as OrderRecord;
}

/**
 * Authoritative store (mirrors Vercel Blob): `list()` returns the strongly
 * consistent ETag; the public CDN GET returns the current bytes, decorated by
 * `cdnDecorate` to model weak/quoting differences and staleness.
 */
class PublicBlobSim {
  readonly keys = new Map<string, { body: string; listEtag: string }>();
  private seq = 0;
  /** How the CDN decorates the validator for the CURRENT bytes (null = omit). */
  cdnDecorate: (listEtag: string) => string | null = (e) => e;
  /** Optional hook fired inside replaceIfVersion to inject a concurrent writer. */
  beforeReplace: () => void = () => {};

  private next(): string {
    this.seq += 1;
    return `"etag-${this.seq}"`;
  }
  seed(pathname: string, order: OrderRecord): void {
    this.keys.set(pathname, { body: JSON.stringify(order, null, 2), listEtag: this.next() });
  }
  current(pathname: string): OrderRecord {
    return JSON.parse(this.keys.get(pathname)!.body) as OrderRecord;
  }
  forceConcurrentField(pathname: string, patch: Record<string, unknown>): void {
    const e = this.keys.get(pathname)!;
    const body = JSON.stringify({ ...JSON.parse(e.body), ...patch }, null, 2);
    this.keys.set(pathname, { body, listEtag: this.next() });
  }

  private listImpl = async ({ prefix }: { prefix: string; token: string }) => {
    const e = this.keys.get(prefix);
    return {
      blobs: e
        ? [{ pathname: prefix, url: `https://sim.public.blob.vercel-storage.com/${prefix}`, etag: e.listEtag }]
        : [],
    };
  };
  private fetchImpl = async (input: URL | RequestInfo): Promise<Response> => {
    const pathname = new URL(String(input)).pathname.replace(/^\//, '');
    const e = this.keys.get(pathname);
    if (!e) return new Response(null, { status: 404 });
    const etag = this.cdnDecorate(e.listEtag);
    return new Response(e.body, { status: 200, headers: etag ? { etag } : {} });
  };

  adapter(): OrderStoreAdapter {
    const sim = this;
    return {
      kind: 'public-blob-sim',
      async readVersioned(pathname) {
        return readPublicOrderBlobVersioned(pathname, 'sim-token', {
          listImpl: sim.listImpl,
          fetchImpl: sim.fetchImpl,
          sleepImpl: async () => {},
        });
      },
      async createIfAbsent(pathname, body) {
        if (sim.keys.has(pathname)) return { ok: false, reason: 'exists' };
        const listEtag = sim.next();
        sim.keys.set(pathname, { body, listEtag });
        return { ok: true, version: listEtag };
      },
      async replaceIfVersion(pathname, body, expected) {
        sim.beforeReplace();
        const e = sim.keys.get(pathname);
        if (!e || e.listEtag !== expected) return { ok: false, reason: 'version_conflict' };
        const listEtag = sim.next();
        sim.keys.set(pathname, { body, listEtag });
        return { ok: true, version: listEtag };
      },
    };
  }
}

test.afterEach(() => __resetOrderStoreAdapterFactoryForTests());

test('draft create then immediate guarded final save converges when the CDN weakens/requotes the ETag', async () => {
  const sim = new PublicBlobSim();
  // The public CDN returns the SAME validator, weakened — the production shape.
  sim.cdnDecorate = (listEtag) => `W/${listEtag}`;
  __setOrderStoreAdapterFactoryForTests(() => sim.adapter());

  await persistNewOrder(draftOrder(ORDER_ID));

  const result = await withOrderTransaction<OrderRecord>(ORDER_ID, (current) => {
    const committed = { ...current, voiceBlobPath: `orders/${ORDER_ID}/voice.webm` } as OrderRecord;
    return { commit: committed, result: committed };
  });

  assert.equal((result as unknown as { voiceBlobPath: string }).voiceBlobPath, `orders/${ORDER_ID}/voice.webm`);
  assert.equal(
    (sim.current(orderPath(ORDER_ID)) as unknown as { voiceBlobPath: string }).voiceBlobPath,
    `orders/${ORDER_ID}/voice.webm`,
    'the media reference committed to the final record',
  );
});

test('re-reading through the public path does not treat the writer\'s own commit as a foreign conflict', async () => {
  const sim = new PublicBlobSim();
  sim.cdnDecorate = (listEtag) => listEtag.replace(/"/g, ''); // unquoted CDN validator
  __setOrderStoreAdapterFactoryForTests(() => sim.adapter());

  await persistNewOrder(draftOrder(ORDER_ID));
  // Two sequential guarded saves: the second re-reads the record the first just
  // committed (new authoritative ETag) and must still converge, not 503.
  await withOrderTransaction(ORDER_ID, (o) => ({ commit: { ...o, childName: 'A' } as OrderRecord, result: 1 }));
  await withOrderTransaction(ORDER_ID, (o) => ({ commit: { ...o, childName: 'B' } as OrderRecord, result: 1 }));

  assert.equal((sim.current(orderPath(ORDER_ID)) as unknown as { childName: string }).childName, 'B');
});

test('a genuine competing writer through the public path is not overwritten (fail-closed retry)', async () => {
  const sim = new PublicBlobSim();
  sim.cdnDecorate = (listEtag) => `W/${listEtag}`;
  __setOrderStoreAdapterFactoryForTests(() => sim.adapter());
  sim.seed(orderPath(ORDER_ID), draftOrder(ORDER_ID));

  // Land exactly one unrelated concurrent change between read and commit.
  let fired = false;
  sim.beforeReplace = () => {
    if (fired) return;
    fired = true;
    sim.forceConcurrentField(orderPath(ORDER_ID), { recipientName: 'CONCURRENT' });
  };

  await withOrderTransaction(ORDER_ID, (o) => ({ commit: { ...o, childName: 'MINE' } as OrderRecord, result: 1 }));

  const final = sim.current(orderPath(ORDER_ID)) as unknown as { childName: string; recipientName: string };
  assert.equal(fired, true, 'a real conflict was forced');
  assert.equal(final.recipientName, 'CONCURRENT', 'the competing write was preserved, not clobbered');
  assert.equal(final.childName, 'MINE', "the mutation's own effect landed on the fresh record");
});

test('permanent public-read instability fails closed rather than committing stale bytes', async () => {
  const sim = new PublicBlobSim();
  // CDN keeps serving a validator that never matches the authoritative version.
  sim.cdnDecorate = () => '"permanently-different"';
  __setOrderStoreAdapterFactoryForTests(() => sim.adapter());
  sim.seed(orderPath(ORDER_ID), draftOrder(ORDER_ID));

  await assert.rejects(
    withOrderTransaction(ORDER_ID, (o) => ({ commit: o, result: 1 })),
    /Public Blob changed during 3 versioned read attempt/,
  );
});

test('duplicate submission cannot create a second payable order at the create boundary', async () => {
  const sim = new PublicBlobSim();
  __setOrderStoreAdapterFactoryForTests(() => sim.adapter());

  await persistNewOrder(draftOrder(ORDER_ID));
  await assert.rejects(
    persistNewOrder(draftOrder(ORDER_ID)),
    /Refusing to overwrite an existing order during creation/,
  );
  // exactly one record exists for this id.
  assert.equal(sim.keys.size, 1);
});

void OrderVersionConflictError;
