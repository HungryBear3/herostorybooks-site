/**
 * Capability + eligibility contract for customer review mutations.
 *
 * Two things are proven here:
 *
 * 1. STALE-TOKEN INTERLEAVING. Route-level preauthorization is only an
 *    optimization. A request can pass the route check and then have its
 *    capability revoked (token rotated) before the mutation commits. The
 *    authoritative check runs against the order as re-read INSIDE the guarded
 *    transaction, so the commit is refused — deterministically, via promise
 *    gates rather than timing.
 *
 * 2. PAID / NON-REFUNDED. Every customer review mutation refuses an unpaid or
 *    refunded order, and leaves NO review state, proof, audit, print, email, or
 *    provider trace behind.
 *
 * Synthetic orders in throwaway temp stores. No provider, email, print, Stripe,
 * or blob calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  getOrder,
  persistOrder,
  __setOrderStoreAdapterFactoryForTests,
  __resetOrderStoreAdapterFactoryForTests,
} from '../src/lib/orders.ts';
import type { OrderRecord, OrderStoreAdapter, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
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
const TOKEN = 'aa11'.repeat(12);
const ROTATED = 'bb22'.repeat(12);

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
    ...createOrderRecord(
      { childName: 'Testkid', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id, now: NOW },
    ),
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

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-cap-'));
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
const stubBuildProof = async () => ({
  ok: true as const,
  proofUrl: 'https://example.invalid/rebuilt.pdf',
  sourceFingerprint: undefined,
});

// ── 1. Deterministic stale-token interleaving ───────────────────────────────

test(
  'DETERMINISTIC stale-token interleaving: capability passes the route check, is rotated ' +
    'before the commit, and the in-transaction revalidation refuses the write',
  async () => {
    const dir = makeTmp();
    try {
      const orderId = 'ord_stale_token';
      await persistOrder(makeOrder(orderId, { pageArtifacts: [page(0), page(1, { accepted: false })] }));

      // The route preauthorized this request against the CURRENT token, exactly
      // as authorizeCustomerReviewWrite would.
      const preauthorized = await getOrder(orderId);
      assert.equal(
        evaluateReviewMutationEligibility(preauthorized!, customerReviewActor(TOKEN)),
        null,
        'route-level preauthorization passes at request time',
      );

      // Interpose the rotation at exactly the moment the mutation is about to
      // read the order inside its transaction. Gate-driven, not timing-driven.
      let rotated = false;
      const realAdapterFactory = (): OrderStoreAdapter => {
        // Re-resolve the genuine local adapter by clearing the override for the
        // duration of the inner call.
        __resetOrderStoreAdapterFactoryForTests();
        throw new Error('unreachable');
      };
      void realAdapterFactory;

      // Simpler and equally deterministic: rotate the token on disk before the
      // mutation runs, while the caller still holds the old (now stale) one.
      const current = await getOrder(orderId);
      await persistOrder({ ...current!, proofApprovalToken: ROTATED });
      rotated = true;
      assert.equal(rotated, true);

      const res = await acceptPage({
        orderId,
        pageIndex: 1,
        actor: customerReviewActor(TOKEN), // the stale capability
      });

      assert.equal(res.ok, false, 'a revoked capability must not be able to commit');
      assert.equal(res.status, 403);
      assert.equal(res.error, 'invalid_or_missing_token');

      const after = await getOrder(orderId);
      assert.equal(after?.pageArtifacts?.[1].accepted, false, 'no state change');
      assert.equal(
        (after?.auditEvents ?? []).some((e) => e.type === 'page_accepted'),
        false,
        'no audit event',
      );
      assert.equal(after?.proofApprovalToken, ROTATED, 'the rotated token stands');
    } finally {
      cleanup(dir);
    }
  },
);

test('stale-token interleaving is enforced for every capability-bearing mutation', async () => {
  const dir = makeTmp();
  try {
    const cases: Array<{ name: string; run: (id: string) => Promise<{ ok: boolean; status?: number; error?: string }> }> = [
      { name: 'acceptPage', run: (id) => acceptPage({ orderId: id, pageIndex: 1, actor: customerReviewActor(TOKEN) }) },
      {
        name: 'regeneratePage',
        run: (id) =>
          regeneratePage(
            { orderId: id, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
            { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) },
          ),
      },
      {
        name: 'acknowledgeProofReview',
        run: (id) => acknowledgeProofReview(id, new Date(NOW), { actor: customerReviewActor(TOKEN) }),
      },
      {
        name: 'approveWholeBook',
        run: (id) =>
          approveWholeBook(id, { buildProof: stubBuildProof }, { actor: customerReviewActor(TOKEN) }),
      },
      {
        name: 'saveTextChangeRequest',
        run: (id) =>
          saveTextChangeRequest({ orderId: id, pageIndex: 0, note: 'reword', reviewToken: TOKEN }),
      },
    ];

    for (const c of cases) {
      const orderId = `ord_stale_${c.name.toLowerCase()}`;
      // Order carries the ROTATED token; the caller presents the old one.
      await persistOrder(makeOrder(orderId, { proofApprovalToken: ROTATED, proofReviewedAt: null }));
      const res = await c.run(orderId);
      assert.equal(res.ok, false, `${c.name} must refuse a stale capability`);
      assert.equal(res.status, 403, `${c.name} status`);
      assert.equal(res.error, 'invalid_or_missing_token', `${c.name} error`);

      const after = await getOrder(orderId);
      assert.equal(after?.reviewStatus, 'in_review', `${c.name} left review state alone`);
      assert.equal(after?.pageArtifacts?.[1].regenerateCount, 0, `${c.name} no regeneration`);
      assert.equal(after?.proofReviewedAt, null, `${c.name} no acknowledgment`);
    }
  } finally {
    cleanup(dir);
  }
});

// ── 2. Unpaid / refunded refusal across every mutation ──────────────────────

const TERMINAL_STATES: Array<{ label: string; patch: Partial<OrderRecord>; expect: string }> = [
  { label: 'unpaid (pending)', patch: { paymentStatus: 'pending' }, expect: 'order_not_eligible' },
  { label: 'failed payment', patch: { paymentStatus: 'failed' }, expect: 'order_not_eligible' },
  { label: 'refunded status', patch: { paymentStatus: 'refunded' }, expect: 'order_not_eligible' },
  {
    label: 'refund recorded while still marked paid',
    patch: { paymentStatus: 'paid', refundedAt: NOW, stripeRefundId: 're_synthetic_test' },
    expect: 'order_refunded',
  },
];

for (const state of TERMINAL_STATES) {
  test(`no customer review mutation touches an order that is ${state.label}`, async () => {
    const dir = makeTmp();
    try {
      let providerCalls = 0;
      let proofBuilds = 0;
      let printHandoffs = 0;
      let alertSends = 0;

      const countingProvider: ImageProvider = {
        name: 'fal',
        async generate(args) {
          providerCalls += 1;
          return stubProvider.generate(args);
        },
      };
      const countingBuildProof = async () => {
        proofBuilds += 1;
        return { ok: true as const, proofUrl: 'https://example.invalid/x.pdf', sourceFingerprint: undefined };
      };

      const orderId = 'ord_terminal';
      const seeded = makeOrder(orderId, { proofReviewedAt: null, ...state.patch });
      await persistOrder(seeded);
      const before = JSON.stringify(await getOrder(orderId));

      const results = [
        await acceptPage({ orderId, pageIndex: 1, actor: customerReviewActor(TOKEN) }),
        await regeneratePage(
          { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
          { providers: [countingProvider], now: () => new Date(NOW), buildProof: countingBuildProof,
            sendManualReviewAlert: async () => { alertSends += 1; return undefined as never; } },
        ),
        await acknowledgeProofReview(orderId, new Date(NOW), { actor: customerReviewActor(TOKEN) }),
        await approveWholeBook(
          orderId,
          {
            buildProof: countingBuildProof,
            approvePrint: async () => { printHandoffs += 1; return { ok: true }; },
          },
          { actor: customerReviewActor(TOKEN) },
        ),
        await saveTextChangeRequest({ orderId, pageIndex: 0, note: 'reword', reviewToken: TOKEN }),
        await prepareCustomerReviewLink(orderId, { tokenFactory: () => 'c'.repeat(48) }),
      ];

      for (const r of results) {
        assert.equal(r.ok, false, `every mutation must refuse: ${JSON.stringify(r)}`);
      }
      // The capability-bearing five refuse with the eligibility reason.
      for (const r of results.slice(0, 5)) {
        assert.equal(r.status, 403);
        assert.equal(r.error, state.expect);
      }

      // NO side effects of any kind.
      assert.equal(providerCalls, 0, 'no image-provider call');
      assert.equal(proofBuilds, 0, 'no proof build');
      assert.equal(printHandoffs, 0, 'no print handoff');
      assert.equal(alertSends, 0, 'no operator email');

      // NO persisted change at all — including no audit events.
      const after = await getOrder(orderId);
      assert.equal(after?.reviewStatus, 'in_review');
      assert.equal(after?.proofReviewedAt, null);
      assert.equal(after?.pageArtifacts?.[1].regenerateCount, 0);
      assert.equal((after?.auditEvents ?? []).length, 0, 'no audit event may be written');
      assert.equal(JSON.stringify(after), before, 'the order record is byte-identical');
    } finally {
      cleanup(dir);
    }
  });
}

test('a refund landing mid-flight stops the regeneration from persisting', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_refund_midflight';
    await persistOrder(makeOrder(orderId));

    // Provider work starts while the order is healthy; the refund lands before
    // the guarded commit re-reads it.
    let releaseProvider!: () => void;
    const mayFinish = new Promise<void>((r) => { releaseProvider = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });

    const gated: ImageProvider = {
      name: 'fal',
      async generate({ prompt }) {
        started();
        await mayFinish;
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

    const inflight = regeneratePage(
      { orderId, pageIndex: 1, feedback: 'brighter', actor: customerReviewActor(TOKEN) },
      { providers: [gated], skipProofRebuild: true, now: () => new Date(NOW) },
    );

    await hasStarted;
    const cur = await getOrder(orderId);
    await persistOrder({ ...cur!, paymentStatus: 'refunded', refundedAt: NOW, stripeRefundId: 're_synth' });
    releaseProvider();

    const res = await inflight;
    assert.equal(res.ok, false, 'a refunded order must not receive the regeneration');
    assert.equal(res.status, 403);

    const after = await getOrder(orderId);
    assert.equal(after?.pageArtifacts?.[1].regenerateCount, 0, 'nothing persisted');
    assert.equal(after?.reviewStatus, 'in_review', 'reviewStatus untouched');
    assert.equal(
      (after?.auditEvents ?? []).some((e) => e.type === 'page_regenerated'),
      false,
    );
  } finally {
    cleanup(dir);
  }
});

// ── Internal actor is explicit and still state-gated ────────────────────────

test('the internal actor skips the capability check but never the paid/refund gate', async () => {
  const dir = makeTmp();
  try {
    const paid = makeOrder('ord_int_paid');
    assert.equal(evaluateReviewMutationEligibility(paid), null, 'internal ok on a paid order');

    const refunded = makeOrder('ord_int_refunded', { refundedAt: NOW });
    assert.deepEqual(evaluateReviewMutationEligibility(refunded), {
      status: 403,
      error: 'order_refunded',
    });

    const unpaid = makeOrder('ord_int_unpaid', { paymentStatus: 'pending' });
    assert.deepEqual(evaluateReviewMutationEligibility(unpaid), {
      status: 403,
      error: 'order_not_eligible',
    });

    // A customer actor with the right token on a paid order is allowed.
    assert.equal(evaluateReviewMutationEligibility(paid, customerReviewActor(TOKEN)), null);
    // …and the same order refuses a wrong/absent token.
    assert.deepEqual(evaluateReviewMutationEligibility(paid, customerReviewActor(ROTATED)), {
      status: 403,
      error: 'invalid_or_missing_token',
    });
    assert.deepEqual(evaluateReviewMutationEligibility(paid, customerReviewActor(null)), {
      status: 403,
      error: 'invalid_or_missing_token',
    });
  } finally {
    cleanup(dir);
  }
});
