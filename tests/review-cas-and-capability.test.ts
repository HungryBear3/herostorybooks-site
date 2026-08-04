/**
 * Capability, order-state and CAS-concurrency contract for customer review.
 *
 * Concurrency model under test: the order-record ETag/ifMatch compare-and-swap
 * is the ONLY correctness boundary. There is no distributed lock in this
 * feature path — no generation list, no lease, nothing whose mutual exclusion
 * could split-brain. Every mutation is: fresh versioned read → recompute the
 * whole mutation → conditional commit → bounded retry from a fresh record.
 * Slow work (image generation, PDF render) runs strictly outside the
 * transaction.
 *
 * Synthetic fixtures only; provider keys stripped from the environment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OrderVersionConflictError,
  applyFulfillmentPatchTo,
  createOrderRecord,
  getOrder,
  persistOrder,
  withOrderTransaction,
  __setOrderStoreAdapterFactoryForTests,
  __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord, OrderStoreAdapter, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import {
  acceptPage,
  acknowledgeProofReview,
  approveWholeBook,
  customerReviewActor,
  evaluateReviewMutationEligibility,
  prepareCustomerReviewLink,
  regeneratePage,
  saveTextChangeRequest,
} from '../src/lib/page-review.ts';

const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'cd34'.repeat(12);
const ROTATED = 'ef56'.repeat(12);

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
  const pages = [page(0), page(1)];
  return {
    ...createOrderRecord(
      { childName: 'Testkid', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id, now: NOW },
    ),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://example.invalid/orders/x/proofs/v1.pdf',
    proofSourceFingerprint: proofSourceFingerprint(pages),
    proofVersion: 'v1',
    proofReviewedAt: NOW,
    proofReviewedVersion: 'v1',
    proofApprovalToken: TOKEN,
    pageArtifacts: pages,
    auditEvents: [],
    ...o,
  };
}

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-cas-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  for (const k of [
    'OPENAI_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY', 'RESEND_API_KEY',
    'LULU_CLIENT_KEY', 'CLOUDPRINTER_API_KEY', 'HSB_STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY',
  ]) delete process.env[k];
  return dir;
}
function cleanup(dir: string) {
  __resetOrderStoreAdapterFactoryForTests();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

const stubProvider: ImageProvider = {
  name: 'fal',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.invalid/regen.png',
      provider: 'fal', model: 'stub', promptUsed: prompt, latencyMs: 1, error: null,
    };
  },
};
const goodBuild = async (oid: string) => {
  const at = await getOrder(oid);
  return {
    ok: true as const,
    proofUrl: `https://example.invalid/orders/${oid}/proofs/v2.pdf`,
    sourceFingerprint: proofSourceFingerprint(at?.pageArtifacts ?? []),
    proofVersion: 'v2',
  };
};

// ── 12: capability rotation at every interleaving fails closed ──────────────

test('REQ12: capability rotated BEFORE the call — every mutation refuses', async () => {
  const dir = makeTmp();
  try {
    const cases: Array<{ name: string; run: (id: string) => Promise<{ ok: boolean; error?: string }> }> = [
      { name: 'accept', run: (id) => acceptPage({ orderId: id, pageIndex: 1, actor: customerReviewActor(TOKEN) }) },
      { name: 'regenerate', run: (id) => regeneratePage(
          { orderId: id, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
          { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) }) },
      { name: 'acknowledge', run: (id) => acknowledgeProofReview(id, {
          proofVersion: 'v1', actor: customerReviewActor(TOKEN), now: new Date(NOW) }) },
      { name: 'approve', run: (id) => approveWholeBook(id, { actor: customerReviewActor(TOKEN) }) },
      { name: 'textChange', run: (id) => saveTextChangeRequest(
          { orderId: id, pageIndex: 0, note: 'x', reviewToken: TOKEN }, { now: () => new Date(NOW) }) },
    ];
    for (const c of cases) {
      const orderId = `ord_rot_${c.name}`;
      await persistOrder(makeOrder(orderId, { proofApprovalToken: ROTATED }));
      const res = await c.run(orderId);
      assert.equal(res.ok, false, `${c.name} must refuse a rotated capability`);
      assert.equal(res.error, 'invalid_or_missing_token', `${c.name} error`);
      const after = await getOrder(orderId);
      assert.equal(after?.reviewStatus, 'in_review', `${c.name} changed no state`);
      assert.equal((after?.auditEvents ?? []).length, 0, `${c.name} wrote no audit row`);
    }
  } finally {
    cleanup(dir);
  }
});

test('REQ12: capability rotated DURING the provider call — regeneration refuses at the commit', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_rot_midprovider';
    await persistOrder(makeOrder(orderId));

    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const gated: ImageProvider = {
      name: 'fal',
      async generate({ prompt }) {
        started();
        await wait;
        return { imageUrl: 'https://example.invalid/regen.png', provider: 'fal', model: 'stub', promptUsed: prompt, latencyMs: 1, error: null };
      },
    };

    const inflight = regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      { providers: [gated], skipProofRebuild: true, now: () => new Date(NOW) },
    );
    await hasStarted;
    const cur = await getOrder(orderId);
    await persistOrder({ ...cur!, proofApprovalToken: ROTATED });
    release();

    const res = await inflight;
    assert.equal(res.ok, false, 'a revoked capability must not persist');
    assert.equal(res.error, 'invalid_or_missing_token');
    const after = await getOrder(orderId);
    assert.equal(after?.pageArtifacts?.[1].regenerateCount, 0);
  } finally {
    cleanup(dir);
  }
});

test('REQ12: capability rotated DURING the proof render — the proof is not published', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_rot_midrender';
    await persistOrder(makeOrder(orderId));

    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });

    const inflight = regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      {
        providers: [stubProvider], now: () => new Date(NOW),
        buildProof: async (oid: string) => {
          const at = await getOrder(oid);
          const fp = proofSourceFingerprint(at?.pageArtifacts ?? []);
          started();
          await wait;
          return { ok: true as const, proofUrl: `https://example.invalid/orders/${oid}/proofs/v2.pdf`, sourceFingerprint: fp, proofVersion: 'v2' };
        },
      },
    );
    await hasStarted;
    const cur = await getOrder(orderId);
    await persistOrder({ ...cur!, proofApprovalToken: ROTATED });
    release();

    const res = await inflight;
    assert.equal(res.proofRefreshed, false, 'a revoked capability must not publish a proof');
    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, null, 'nothing advertised');
  } finally {
    cleanup(dir);
  }
});

// ── 13: refunded / unpaid state fails closed everywhere ────────────────────

const TERMINAL: Array<{ label: string; patch: Partial<OrderRecord>; expect: string }> = [
  { label: 'unpaid', patch: { paymentStatus: 'pending' }, expect: 'order_not_eligible' },
  { label: 'failed payment', patch: { paymentStatus: 'failed' }, expect: 'order_not_eligible' },
  { label: 'refunded status', patch: { paymentStatus: 'refunded' }, expect: 'order_not_eligible' },
  { label: 'refund recorded while still paid', patch: { refundedAt: NOW, stripeRefundId: 're_synthetic' }, expect: 'order_refunded' },
];

for (const s of TERMINAL) {
  test(`REQ13: no review mutation touches an order that is ${s.label}`, async () => {
    const dir = makeTmp();
    try {
      const orderId = 'ord_terminal';
      await persistOrder(makeOrder(orderId, s.patch));
      const before = JSON.stringify(await getOrder(orderId));

      let providerCalls = 0;
      let buildCalls = 0;
      const results = [
        await acceptPage({ orderId, pageIndex: 1, actor: customerReviewActor(TOKEN) }),
        await regeneratePage(
          { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
          {
            providers: [{ name: 'fal', async generate(a) { providerCalls += 1; return stubProvider.generate(a); } }],
            now: () => new Date(NOW),
            buildProof: async (oid: string) => { buildCalls += 1; return goodBuild(oid); },
          },
        ),
        await acknowledgeProofReview(orderId, { proofVersion: 'v1', actor: customerReviewActor(TOKEN), now: new Date(NOW) }),
        await approveWholeBook(orderId, { actor: customerReviewActor(TOKEN) }),
        await saveTextChangeRequest({ orderId, pageIndex: 0, note: 'x', reviewToken: TOKEN }, { now: () => new Date(NOW) }),
        await prepareCustomerReviewLink(orderId, { tokenFactory: () => 'z'.repeat(48) }),
      ];
      for (const r of results) assert.equal(r.ok, false, `must refuse: ${JSON.stringify(r)}`);
      for (const r of results.slice(0, 5)) assert.equal(r.error, s.expect);

      assert.equal(providerCalls, 0, 'no image-provider call');
      assert.equal(buildCalls, 0, 'no proof build');
      assert.equal(JSON.stringify(await getOrder(orderId)), before, 'record byte-identical');
    } finally {
      cleanup(dir);
    }
  });
}

test('REQ13: a refund landing mid-provider-call stops the regeneration persisting', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_refund_midflight';
    await persistOrder(makeOrder(orderId));
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const gated: ImageProvider = {
      name: 'fal',
      async generate({ prompt }) { started(); await wait; return { imageUrl: 'https://example.invalid/r.png', provider: 'fal', model: 'stub', promptUsed: prompt, latencyMs: 1, error: null }; },
    };

    const inflight = regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      { providers: [gated], skipProofRebuild: true, now: () => new Date(NOW) },
    );
    await hasStarted;
    const cur = await getOrder(orderId);
    await persistOrder({ ...cur!, refundedAt: NOW, stripeRefundId: 're_synth' });
    release();

    const res = await inflight;
    assert.equal(res.ok, false);
    assert.equal(res.error, 'order_refunded');
    assert.equal((await getOrder(orderId))?.pageArtifacts?.[1].regenerateCount, 0);
  } finally {
    cleanup(dir);
  }
});

// ── 14: CAS conflict retries from the fresh record, preserving other fields ─

class FakeVersionedStore {
  readonly keys = new Map<string, { body: string; version: string }>();
  readonly ops: string[] = [];
  private seq = 0;
  mirrorDir: string | null = null;
  beforeReplace: () => Promise<void> = async () => {};
  private next() { this.seq += 1; return `"etag-${this.seq}"`; }
  private mirror(p: string, body: string) {
    if (!this.mirrorDir) return;
    writeFileSync(path.join(this.mirrorDir, p.slice(p.lastIndexOf('/') + 1)), body, 'utf8');
  }
  seed(p: string, o: OrderRecord) {
    const body = JSON.stringify(o, null, 2);
    this.keys.set(p, { body, version: this.next() });
    this.mirror(p, body);
  }
  current(p: string): OrderRecord { return JSON.parse(this.keys.get(p)!.body) as OrderRecord; }
  adapter(): OrderStoreAdapter {
    const store = this;
    return {
      kind: 'fake-versioned',
      async readVersioned(pathname) {
        const e = store.keys.get(pathname);
        return e ? { body: e.body, version: e.version } : null;
      },
      async createIfAbsent(pathname, body) {
        if (store.keys.has(pathname)) return { ok: false, reason: 'exists' };
        const version = store.next();
        store.keys.set(pathname, { body, version });
        store.mirror(pathname, body);
        return { ok: true, version };
      },
      async replaceIfVersion(pathname, body, expected) {
        await store.beforeReplace();
        const e = store.keys.get(pathname);
        // Compare-and-set with no await between: the same atomicity the store
        // provides server-side for ifMatch.
        if (!e || e.version !== expected) {
          store.ops.push(`rejected:${expected}`);
          return { ok: false, reason: 'version_conflict' };
        }
        const version = store.next();
        store.keys.set(pathname, { body, version });
        store.mirror(pathname, body);
        store.ops.push(`replaced:${expected}->${version}`);
        return { ok: true, version };
      },
    };
  }
}
const orderPath = (id: string) => `orders/${id}.json`;

test('REQ14: a version conflict retries from the fresh record and preserves unrelated fields', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_cas_retry';
    const store = new FakeVersionedStore();
    store.mirrorDir = dir;
    store.seed(orderPath(orderId), makeOrder(orderId));
    __setOrderStoreAdapterFactoryForTests(() => store.adapter());

    // Land ONE unrelated concurrent change between read and write.
    let fired = false;
    store.beforeReplace = async () => {
      if (fired) return;
      fired = true;
      const e = store.keys.get(orderPath(orderId))!;
      const o = JSON.parse(e.body) as OrderRecord;
      const body = JSON.stringify({ ...o, childAge: 'CONCURRENT-MARKER' }, null, 2);
      store.keys.set(orderPath(orderId), { body, version: '"etag-interposed"' });
      writeFileSync(path.join(dir, `${orderId}.json`), body, 'utf8');
    };

    const res = await acceptPage({
      orderId, pageIndex: 1, actor: customerReviewActor(TOKEN),
    });
    assert.equal(res.ok, true, 'mutation still succeeds after the conflict retry');
    assert.equal(fired, true, 'a conflict was actually forced');
    assert.ok(store.ops.some((o) => o.startsWith('rejected:')), 'the conditional commit was rejected once');

    const final = store.current(orderPath(orderId));
    assert.equal(final.childAge, 'CONCURRENT-MARKER', 'unrelated concurrent change preserved');
    assert.equal(final.pageArtifacts?.[1].accepted, true, "the mutation's own effect landed");
  } finally {
    cleanup(dir);
  }
});

test('REQ14: a permanently conflicting store exhausts the bounded retry and writes nothing', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_cas_exhaust';
    const store = new FakeVersionedStore();
    store.mirrorDir = dir;
    store.seed(orderPath(orderId), makeOrder(orderId, { childAge: 'stable' }));
    __setOrderStoreAdapterFactoryForTests(() => store.adapter());
    store.beforeReplace = async () => {
      const e = store.keys.get(orderPath(orderId))!;
      store.keys.set(orderPath(orderId), { body: e.body, version: `"etag-moved-${store.ops.length}"` });
    };

    let attempts = 0;
    await assert.rejects(
      () => withOrderTransaction<string>(
        orderId,
        (order) => { attempts += 1; return { commit: applyFulfillmentPatchTo(order, { reviewStatus: 'approved' }), result: 'x' }; },
        { maxAttempts: 3 },
      ),
      OrderVersionConflictError,
    );
    assert.equal(attempts, 3, 'retry budget honoured');
    assert.equal(store.current(orderPath(orderId)).reviewStatus, 'in_review', 'no stale write landed');
  } finally {
    cleanup(dir);
  }
});

// ── 15: the unsafe generation-list lock is absent from this feature path ────

test('REQ15: no generation-list lock exists in the review feature path', async () => {
  const { readFileSync } = await import('node:fs');
  const repo = process.cwd();
  for (const rel of ['src/lib/orders.ts', 'src/lib/page-review.ts', 'src/lib/fulfillment.ts']) {
    const text = readFileSync(path.join(repo, rel), 'utf8');
    assert.doesNotMatch(
      text, /withOrderMutationLock/,
      `${rel}: the generation-list lock must not exist — it can split-brain when generation 1 ` +
        'is cleaned, generation 2 is live, an eventually-consistent list hides generation 2, and ' +
        'a contender recreates generation 1. Correctness rests on order-record CAS instead.',
    );
    assert.doesNotMatch(text, /order-mutation-locks/, `${rel}: no lock key namespace`);
    assert.doesNotMatch(text, /OrderLockHandle|assertHeld/, `${rel}: no lock handle/fencing shim`);
  }
});

test('REQ15: concurrent mutations on distinct pages both land under CAS alone', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_concurrent_pages';
    await persistOrder(makeOrder(orderId, {
      pageArtifacts: [page(0, { accepted: false, acceptedImageUrl: null }), page(1, { accepted: false, acceptedImageUrl: null })],
    }));
    const [a, b] = await Promise.all([
      acceptPage({ orderId, pageIndex: 0, actor: customerReviewActor(TOKEN) }),
      acceptPage({ orderId, pageIndex: 1, actor: customerReviewActor(TOKEN) }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const after = await getOrder(orderId);
    assert.equal(after?.pageArtifacts?.[0].accepted, true, 'page 0 accept survived');
    assert.equal(after?.pageArtifacts?.[1].accepted, true, 'page 1 accept survived');
  } finally {
    cleanup(dir);
  }
});

// ── eligibility unit contract ──────────────────────────────────────────────

test('eligibility: customer token, paid and non-refunded are all required', async () => {
  const dir = makeTmp();
  try {
    const paid = makeOrder('ord_e');
    assert.equal(evaluateReviewMutationEligibility(paid, customerReviewActor(TOKEN)), null);
    assert.deepEqual(evaluateReviewMutationEligibility(paid, customerReviewActor(ROTATED)),
      { status: 403, error: 'invalid_or_missing_token' });
    assert.deepEqual(evaluateReviewMutationEligibility(paid, customerReviewActor(null)),
      { status: 403, error: 'invalid_or_missing_token' });
    assert.deepEqual(
      evaluateReviewMutationEligibility(makeOrder('o', { paymentStatus: 'pending' }), customerReviewActor(TOKEN)),
      { status: 403, error: 'order_not_eligible' });
    assert.deepEqual(
      evaluateReviewMutationEligibility(makeOrder('o', { refundedAt: NOW }), customerReviewActor(TOKEN)),
      { status: 403, error: 'order_refunded' });
  } finally {
    cleanup(dir);
  }
});
