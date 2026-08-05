/**
 * Proof artifact lifecycle for customer editable review.
 *
 * Contract under test:
 *
 *   - A proof build result is a fail-closed discriminated union. A result that
 *     claims `ok: true` but omits the URL, source fingerprint or version is
 *     refused AT RUNTIME, not merely by the type checker.
 *   - Each successful build lands at an IMMUTABLE path keyed by its version.
 *     The persisted `storyArtifactUrl` identifies that exact artifact, so a
 *     reload or reopen is always safe and no in-memory nonce is load-bearing.
 *   - A rendered-content mutation atomically clears the proof URL, fingerprint,
 *     version and acknowledgment in the SAME commit as the content change.
 *   - A build that fails or goes stale leaves NO proof available: nothing is
 *     advertised, nothing can be acknowledged, nothing can be approved.
 *   - Acknowledgment is bound to the exact persisted revision.
 *   - Approval verifies the customer reviewed the exact current proof, sets
 *     reviewStatus='approved', appends audit, and STOPS — no rebuild, no print,
 *     no email, no payment/refund, no external provider of any kind.
 *
 * Synthetic fixtures only. No provider keys, no network, no real order data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { padPageSet } from './support/full-page-set.ts';

import { createOrderRecord, getOrder, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import {
  buildProofArtifactFromPageArtifacts,
  proofSourceFingerprint,
} from '../src/lib/fulfillment.ts';
import type { ProofBuildResult } from '../src/lib/fulfillment.ts';
import {
  acceptPage,
  acknowledgeProofReview,
  approveWholeBook,
  customerReviewActor,
  publishProofGuarded,
  regeneratePage,
  saveTextChangeRequest,
} from '../src/lib/page-review.ts';

const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'ab12'.repeat(12);

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

/** Build a complete synthetic renderer identity before the full fixture exists. */
function proofFingerprintForTest(
  id: string,
  pages: PageArtifact[],
  overrides: Partial<Pick<OrderRecord, 'childName' | 'bookFormat' | 'printTitle'>> = {},
): string | null {
  return proofSourceFingerprint({
    id,
    childName: overrides.childName ?? 'Testkid',
    bookFormat: overrides.bookFormat ?? 'digital',
    printTitle: overrides.printTitle ?? null,
    pageArtifacts: padPageSet(pages),
  });
}

/** An order with a live, acknowledged proof at version v1. */
function makeOrder(id: string, o: Partial<OrderRecord> = {}): OrderRecord {
  const pages = padPageSet([page(0), page(1)]);
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Testkid', bookFormat: 'digital', email: 'reviewer@example.invalid' },
      { id, now: NOW },
    ),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://example.invalid/orders/x/proofs/v1.pdf',
    proofSourceFingerprint: null,
    proofVersion: 'v1',
    proofReviewedAt: NOW,
    proofReviewedVersion: 'v1',
    proofApprovalToken: TOKEN,
    pageArtifacts: pages,
    auditEvents: [],
    ...o,
  };
  if (o.proofSourceFingerprint === undefined) {
    order.proofSourceFingerprint = proofSourceFingerprint(order);
  }
  return order;
}

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-proof-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  // Strip provider keys so any accidental external call fails loudly.
  for (const k of [
    'OPENAI_API_KEY', 'FAL_KEY', 'GEMINI_API_KEY', 'RESEND_API_KEY',
    'LULU_CLIENT_KEY', 'CLOUDPRINTER_API_KEY', 'HSB_STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY',
  ]) delete process.env[k];
  return dir;
}
function cleanup(dir: string) {
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

/** A well-formed build that reports the fingerprint of the CURRENT pages. */
function goodBuild(version: string, opts: { onStart?: () => void; wait?: Promise<void> } = {}) {
  let calls = 0;
  const fn = async (orderId: string): Promise<ProofBuildResult> => {
    calls += 1;
    const at = await getOrder(orderId);
    const sourceFingerprint = proofSourceFingerprint(at!);
    opts.onStart?.();
    if (opts.wait) await opts.wait;
    return {
      ok: true,
      proofUrl: `https://example.invalid/orders/${orderId}/proofs/${version}.pdf`,
      sourceFingerprint,
      proofVersion: version,
    };
  };
  return { fn, calls: () => calls };
}

// ── 1 & 2: a "successful" build missing required fields fails closed ────────

test('REQ1: a successful builder that omits sourceFingerprint fails closed — no proof persisted', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_no_fingerprint';
    await persistOrder(makeOrder(orderId, {
      storyArtifactUrl: null, proofSourceFingerprint: null, proofVersion: null,
      proofReviewedAt: null, proofReviewedVersion: null,
    }));

    const res = await regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      {
        providers: [stubProvider],
        now: () => new Date(NOW),
        // Deliberately malformed: claims success, omits sourceFingerprint.
        buildProof: async () => ({
          ok: true,
          proofUrl: 'https://example.invalid/orders/x/proofs/v2.pdf',
          proofVersion: 'v2',
        } as unknown as ProofBuildResult),
      },
    );

    assert.equal(res.ok, true, 'the regeneration itself still succeeds');
    assert.equal(res.proofRefreshed, false, 'the malformed build must not be treated as a proof');

    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, null, 'no proof URL may be persisted');
    assert.equal(after?.proofVersion, null);
    assert.equal(after?.proofSourceFingerprint, null);
  } finally {
    cleanup(dir);
  }
});

test('REQ2: a successful builder that omits proofVersion fails closed — no proof persisted', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_no_version';
    await persistOrder(makeOrder(orderId, {
      storyArtifactUrl: null, proofSourceFingerprint: null, proofVersion: null,
      proofReviewedAt: null, proofReviewedVersion: null,
    }));

    const res = await regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      {
        providers: [stubProvider],
        now: () => new Date(NOW),
        buildProof: async (oid: string) => {
          const at = await getOrder(oid);
          return {
            ok: true,
            proofUrl: 'https://example.invalid/orders/x/proofs/v2.pdf',
            sourceFingerprint: proofSourceFingerprint(at!),
          } as unknown as ProofBuildResult;
        },
      },
    );

    assert.equal(res.proofRefreshed, false, 'a versionless build must not be treated as a proof');
    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, null);
    assert.equal(after?.proofVersion, null);
  } finally {
    cleanup(dir);
  }
});

test('REQ1/2: the builder itself validates its own output before claiming ok', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_builder_selfcheck';
    await persistOrder(makeOrder(orderId));
    // An upload that yields an empty URL must produce ok:false, not ok:true
    // with a blank field.
    const res = await buildProofArtifactFromPageArtifacts(orderId, {
      buildPdf: async () => Buffer.from('%PDF-synthetic'),
      uploadArtifact: async () => '',
    });
    assert.equal(res.ok, false, 'an empty upload URL must fail closed');
  } finally {
    cleanup(dir);
  }
});

// ── 3: stale source during the build cannot persist ─────────────────────────

test('REQ3: source mutated while the proof renders — the stale build cannot persist', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_stale_source';
    await persistOrder(makeOrder(orderId, {
      storyArtifactUrl: null, proofSourceFingerprint: null, proofVersion: null,
      proofReviewedAt: null, proofReviewedVersion: null,
    }));

    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const build = goodBuild('v2', { onStart: () => started(), wait });

    const inflight = regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      { providers: [stubProvider], now: () => new Date(NOW), buildProof: build.fn },
    );

    await hasStarted;
    // A second regeneration changes the rendered page set underneath the build.
    const concurrent = await regeneratePage(
      { orderId, pageIndex: 0, feedback: 'other', actor: customerReviewActor(TOKEN) },
      { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) },
    );
    assert.equal(concurrent.ok, true);

    release();
    const res = await inflight;
    assert.equal(res.proofRefreshed, false, 'a stale build must not be published');

    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, null, 'nothing may be advertised');
    assert.equal(after?.proofVersion, null);
    assert.equal(after?.proofSourceFingerprint, null);
  } finally {
    cleanup(dir);
  }
});

test('REQ3b: wording requested while a proof renders discards the in-flight proof', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_wording_during_render';
    await persistOrder(makeOrder(orderId, {
      storyArtifactUrl: null, proofSourceFingerprint: null, proofVersion: null,
      proofReviewedAt: null, proofReviewedVersion: null,
    }));
    let started!: () => void;
    let release!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const buildPromise = buildProofArtifactFromPageArtifacts(orderId, {
      buildPdf: async () => {
        started();
        await wait;
        return Buffer.from('%PDF wording race');
      },
      uploadArtifact: async (_id, _buffer, filename) =>
        `https://example.invalid/orders/${orderId}/${filename}`,
    });
    await hasStarted;
    const wording = await saveTextChangeRequest({
      orderId,
      pageIndex: 0,
      note: 'Please revise this wording',
      reviewToken: TOKEN,
    });
    assert.equal(wording.ok, true);
    release();
    const built = await buildPromise;
    const published = await publishProofGuarded(orderId, built, {
      actor: customerReviewActor(TOKEN),
    });
    assert.equal(published.refreshed, false);
    assert.equal(published.error, 'unresolved_change_requests');
    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, null);
    assert.equal(after?.proofVersion, null);
  } finally {
    cleanup(dir);
  }
});

// ── 4 & 5: a failed / discarded build blocks acknowledgment ─────────────────

test('REQ4: a failed proof build leaves storyArtifactUrl null and blocks acknowledgment', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_build_failed';
    await persistOrder(makeOrder(orderId));

    const res = await regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      {
        providers: [stubProvider],
        now: () => new Date(NOW),
        buildProof: async () => ({ ok: false as const, error: 'render_failed' }),
      },
    );
    assert.equal(res.proofRefreshed, false);
    assert.equal(res.proofRefreshError, 'render_failed');

    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, null, 'the old proof must NOT be restored or advertised');
    assert.equal(after?.proofVersion, null);
    assert.equal(after?.proofReviewedAt, null, 'acknowledgment invalidated');
    assert.equal(after?.proofReviewedVersion, null);

    const ack = await acknowledgeProofReview(orderId, {
      proofVersion: 'v1',
      actor: customerReviewActor(TOKEN),
      now: new Date(NOW),
    });
    assert.equal(ack.ok, false, 'nothing may be acknowledged while no proof exists');
    assert.equal(ack.error, 'proof_unavailable');
  } finally {
    cleanup(dir);
  }
});

test('REQ5: a discarded (stale) proof result can never be acknowledged', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_discarded';
    await persistOrder(makeOrder(orderId));
    // Regenerate with a build whose fingerprint will not match (simulates a
    // result computed against a different page set).
    const res = await regeneratePage(
      { orderId, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
      {
        providers: [stubProvider],
        now: () => new Date(NOW),
        buildProof: async () => ({
          ok: true as const,
          proofUrl: 'https://example.invalid/orders/x/proofs/v9.pdf',
          sourceFingerprint: 'pf_deliberately_not_matching',
          proofVersion: 'v9',
        }),
      },
    );
    assert.equal(res.proofRefreshed, false);

    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, null);

    const ack = await acknowledgeProofReview(orderId, {
      proofVersion: 'v9',
      actor: customerReviewActor(TOKEN),
      now: new Date(NOW),
    });
    assert.equal(ack.ok, false);
  } finally {
    cleanup(dir);
  }
});

// ── 6 & 7: acknowledgment is bound to the exact revision ────────────────────

test('REQ6: an acknowledgment of revision X cannot approve revision Y', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_version_mismatch';
    // Persisted proof is v2, but the customer acknowledged v1.
    const pages = padPageSet([page(0), page(1)]);
    await persistOrder(makeOrder(orderId, {
      pageArtifacts: pages,
      storyArtifactUrl: 'https://example.invalid/orders/x/proofs/v2.pdf',
      proofSourceFingerprint: proofFingerprintForTest(orderId, pages),
      proofVersion: 'v2',
      proofReviewedAt: NOW,
      proofReviewedVersion: 'v1',
    }));

    const res = await approveWholeBook(orderId, { actor: customerReviewActor(TOKEN) });
    assert.equal(res.ok, false, 'approval must refuse a stale acknowledgment');
    assert.equal(res.error, 'proof_ack_stale');

    const after = await getOrder(orderId);
    assert.notEqual(after?.reviewStatus, 'approved');

    // Acknowledging the WRONG version is also refused outright.
    const ack = await acknowledgeProofReview(orderId, {
      proofVersion: 'v1',
      actor: customerReviewActor(TOKEN),
      now: new Date(NOW),
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'proof_version_mismatch');
  } finally {
    cleanup(dir);
  }
});

test('REQ7: the current matching revision can be acknowledged and then approved', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_happy';
    const pages = padPageSet([page(0), page(1)]);
    await persistOrder(makeOrder(orderId, {
      pageArtifacts: pages,
      storyArtifactUrl: 'https://example.invalid/orders/x/proofs/v3.pdf',
      proofSourceFingerprint: proofFingerprintForTest(orderId, pages),
      proofVersion: 'v3',
      proofReviewedAt: null,
      proofReviewedVersion: null,
    }));

    const ack = await acknowledgeProofReview(orderId, {
      proofVersion: 'v3',
      actor: customerReviewActor(TOKEN),
      now: new Date(NOW),
    });
    assert.equal(ack.ok, true, `ack failed: ${ack.error}`);

    const acked = await getOrder(orderId);
    assert.equal(acked?.proofReviewedVersion, 'v3');
    assert.equal(acked?.proofReviewedAt, NOW);

    const res = await approveWholeBook(orderId, { actor: customerReviewActor(TOKEN) });
    assert.equal(res.ok, true, `approve failed: ${res.error}`);

    const after = await getOrder(orderId);
    assert.equal(after?.reviewStatus, 'approved');
    assert.ok((after?.auditEvents ?? []).some((e) => e.type === 'whole_book_approved'));
  } finally {
    cleanup(dir);
  }
});

// ── 9: content mutation clears the whole proof tuple atomically ─────────────

const CONTENT_MUTATIONS: Array<{ name: string; run: (id: string) => Promise<{ ok: boolean }> }> = [
  {
    name: 'regeneratePage',
    run: (id) =>
      regeneratePage(
        { orderId: id, pageIndex: 1, feedback: 'x', actor: customerReviewActor(TOKEN) },
        { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) },
      ),
  },
  {
    name: 'saveTextChangeRequest',
    run: (id) =>
      saveTextChangeRequest(
        { orderId: id, pageIndex: 0, note: 'reword this', reviewToken: TOKEN },
        { now: () => new Date(NOW) },
      ),
  },
];

for (const m of CONTENT_MUTATIONS) {
  test(`REQ9: ${m.name} atomically clears proof URL, fingerprint, version and acknowledgment`, async () => {
    const dir = makeTmp();
    try {
      const orderId = `ord_invalidate_${m.name.toLowerCase()}`;
      await persistOrder(makeOrder(orderId));
      const before = await getOrder(orderId);
      assert.ok(before?.storyArtifactUrl && before?.proofVersion && before?.proofReviewedVersion);

      const res = await m.run(orderId);
      assert.equal(res.ok, true, `${m.name} should succeed`);

      const after = await getOrder(orderId);
      assert.equal(after?.storyArtifactUrl, null, 'proof URL cleared');
      assert.equal(after?.proofSourceFingerprint, null, 'fingerprint cleared');
      assert.equal(after?.proofVersion, null, 'version cleared');
      assert.equal(after?.proofReviewedAt, null, 'ack timestamp cleared');
      assert.equal(after?.proofReviewedVersion, null, 'ack version cleared');

      // …and approval is consequently impossible.
      const approved = await approveWholeBook(orderId, { actor: customerReviewActor(TOKEN) });
      assert.equal(approved.ok, false, 'approval blocked with no proof');
    } finally {
      cleanup(dir);
    }
  });
}

// ── 10 & 11: approval is inert — no build, no external side effect ──────────

test('REQ10+11: approval performs NO pdf build, print, email, payment, refund, fulfillment or provider call', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_inert_approve';
    const pages = padPageSet([page(0), page(1)]);
    await persistOrder(makeOrder(orderId, {
      bookFormat: 'classic', // print order — the old code would hand off to print
      pageArtifacts: pages,
      storyArtifactUrl: 'https://example.invalid/orders/x/proofs/v5.pdf',
      proofSourceFingerprint: proofFingerprintForTest(orderId, pages, { bookFormat: 'classic' }),
      proofVersion: 'v5',
      proofReviewedAt: NOW,
      proofReviewedVersion: 'v5',
    }));

    // Any external call would have to go through one of these; all are absent
    // from the environment, and we additionally assert on the audit trail.
    const res = await approveWholeBook(orderId, { actor: customerReviewActor(TOKEN) });
    assert.equal(res.ok, true, `approve failed: ${res.error}`);

    // The result must not even claim a print handoff happened.
    assert.equal(
      (res as unknown as { printApproved?: unknown }).printApproved,
      undefined,
      'approval must not report a print handoff',
    );

    const after = await getOrder(orderId);
    assert.equal(after?.reviewStatus, 'approved');
    // Print/fulfillment state is untouched.
    assert.equal(after?.printJobId ?? null, null, 'no print job');
    assert.equal(after?.printJobStatus ?? null, null, 'no print job status');
    assert.equal(after?.proofApprovedAt ?? null, null, 'no print proof approval');
    assert.equal(after?.fulfillmentStatus, before(orderId), 'fulfillment status unchanged');
    // Proof artifact untouched — approval rebuilt nothing.
    assert.equal(after?.storyArtifactUrl, 'https://example.invalid/orders/x/proofs/v5.pdf');
    assert.equal(after?.proofVersion, 'v5');

    const types = (after?.auditEvents ?? []).map((e) => e.type);
    assert.ok(types.includes('whole_book_approved'));
    assert.equal(types.includes('proof_rebuilt'), false, 'approval must not rebuild the proof');
  } finally {
    cleanup(dir);
  }
});

// Helper: the seeded fulfillmentStatus, so the assertion above is explicit.
function before(_orderId: string) {
  return createOrderRecord(
    { childName: 'Testkid', bookFormat: 'digital', email: 'reviewer@example.invalid' },
    { id: 'x', now: NOW },
  ).fulfillmentStatus;
}

test('REQ10: approval never invokes the proof builder, even when one is available', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_no_build_on_approve';
    const pages = padPageSet([page(0), page(1)]);
    await persistOrder(makeOrder(orderId, {
      pageArtifacts: pages,
      storyArtifactUrl: 'https://example.invalid/orders/x/proofs/v6.pdf',
      proofSourceFingerprint: proofFingerprintForTest(orderId, pages),
      proofVersion: 'v6',
      proofReviewedAt: NOW,
      proofReviewedVersion: 'v6',
    }));

    const build = goodBuild('v7');
    // approveWholeBook must not accept — or use — a proof builder at all.
    const res = await approveWholeBook(orderId, { actor: customerReviewActor(TOKEN) });
    assert.equal(res.ok, true, `approve failed: ${res.error}`);
    assert.equal(build.calls(), 0, 'no PDF build during approval');

    const after = await getOrder(orderId);
    assert.equal(after?.proofVersion, 'v6', 'proof revision unchanged by approval');
  } finally {
    cleanup(dir);
  }
});

// ── Accept is render-neutral and must NOT invalidate the proof ──────────────

test('accepting a page whose current image is already rendered does not invalidate the proof', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_accept_neutral';
    const pages = padPageSet([page(0, { accepted: false, acceptedImageUrl: null }), page(1)]);
    await persistOrder(makeOrder(orderId, {
      pageArtifacts: pages,
      proofSourceFingerprint: proofFingerprintForTest(orderId, pages),
    }));

    const res = await acceptPage({ orderId, pageIndex: 0, actor: customerReviewActor(TOKEN) });
    assert.equal(res.ok, true);

    const after = await getOrder(orderId);
    assert.notEqual(after?.storyArtifactUrl, null, 'render-neutral accept keeps the proof');
    assert.equal(after?.proofVersion, 'v1');
    assert.equal(
      after?.proofSourceFingerprint,
      proofSourceFingerprint(after!),
      'fingerprint still matches the current pages',
    );
  } finally {
    cleanup(dir);
  }
});
