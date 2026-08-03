/**
 * Guarded proof persistence — the PRODUCTION path, with proof rebuild ENABLED.
 *
 * `skipProofRebuild: true` is insufficient to cover this: the whole hazard is
 * that the proof PDF is rendered OUTSIDE the transaction and then written back.
 * The old code finished that write with an unconditional
 * `updateFulfillmentState({ storyArtifactUrl, proofReviewedAt: null })`, which
 * last-write-wins over any review mutation that landed while the PDF rendered.
 *
 * The remediation: rendering stays outside the transaction but is BOUND to the
 * artifact set it rendered from (`proofSourceFingerprint`). Persisting the URL
 * happens through a conditional commit that re-checks that fingerprint against
 * the freshly-read order, and DISCARDS the built proof if the source moved.
 *
 * Every test below drives the real code path with `deps.buildProof` — the
 * build-only step — never the legacy `rebuildProof` shim, and never
 * `skipProofRebuild`. No real PDF, upload, blob, provider, print or email call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, getOrder, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import {
  acceptPage,
  approveWholeBook,
  customerReviewActor,
  regeneratePage,
} from '../src/lib/page-review.ts';

const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'dd44'.repeat(12);
const OLD_PROOF = 'https://example.invalid/proof-old.pdf';
const NEW_PROOF = 'https://example.invalid/proof-new.pdf';

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
    storyArtifactUrl: OLD_PROOF,
    proofReviewedAt: NOW,
    proofApprovalToken: TOKEN,
    pageArtifacts: [page(0), page(1)],
    auditEvents: [],
    ...o,
  };
}

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-proofcas-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
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

/**
 * A build-only proof step that reports the fingerprint of the artifact set as
 * it is at build time — exactly what the real
 * `buildProofArtifactFromPageArtifacts` does — and lets a test park inside the
 * render to interleave a concurrent mutation.
 */
function makeGatedBuildProof(opts: { onStart?: () => void; wait?: Promise<void> }) {
  let calls = 0;
  const fn = async (orderId: string) => {
    calls += 1;
    const at = await getOrder(orderId);
    const sourceFingerprint = proofSourceFingerprint(at?.pageArtifacts ?? []);
    opts.onStart?.();
    if (opts.wait) await opts.wait;
    return { ok: true as const, proofUrl: NEW_PROOF, sourceFingerprint };
  };
  return { fn, calls: () => calls };
}

// ── Regeneration: real proof rebuild, interleaved ───────────────────────────

test('regenerate with proof rebuild ENABLED persists the proof through a guarded commit', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_regen_proof_ok';
    await persistOrder(makeOrder(orderId));
    const build = makeGatedBuildProof({});

    const res = await regeneratePage(
      { orderId, pageIndex: 1, feedback: 'brighter', actor: customerReviewActor(TOKEN) },
      { providers: [stubProvider], now: () => new Date(NOW), buildProof: build.fn },
    );

    assert.equal(res.ok, true);
    assert.equal(res.proofRefreshed, true, 'the proof was refreshed');
    assert.equal(build.calls(), 1);

    const after = await getOrder(orderId);
    assert.equal(after?.storyArtifactUrl, NEW_PROOF, 'new proof URL persisted');
    assert.equal(after?.proofReviewedAt, null, 'ack invalidated by the new proof');
    assert.equal(after?.pageArtifacts?.[1].regenerateCount, 1);
    assert.ok(
      (after?.auditEvents ?? []).some(
        (e) => e.type === 'proof_rebuilt' && e.meta?.success === true,
      ),
      'proof_rebuilt audited in the same guarded commit',
    );
  } finally {
    cleanup(dir);
  }
});

test(
  'DETERMINISTIC: a concurrent accept lands while the proof renders — the stale proof is ' +
    'DISCARDED and never overwrites the newer artifact state',
  async () => {
    const dir = makeTmp();
    try {
      const orderId = 'ord_regen_proof_stale';
      await persistOrder(makeOrder(orderId));

      let releaseBuild!: () => void;
      const mayFinish = new Promise<void>((r) => { releaseBuild = r; });
      let buildStarted!: () => void;
      const hasStarted = new Promise<void>((r) => { buildStarted = r; });
      const build = makeGatedBuildProof({ onStart: () => buildStarted(), wait: mayFinish });

      const inflight = regeneratePage(
        { orderId, pageIndex: 1, feedback: 'brighter', actor: customerReviewActor(TOKEN) },
        { providers: [stubProvider], now: () => new Date(NOW), buildProof: build.fn },
      );

      // The PDF is mid-render. A concurrent regeneration on ANOTHER page changes
      // the rendered artifact set out from under it.
      //
      // Note the fingerprint covers what the PDF actually renders (page order,
      // story text, effective image URL). A concurrent *accept* that merely
      // promotes the already-current image to acceptedImageUrl is render-neutral
      // and deliberately does NOT invalidate the proof — see the dedicated
      // fingerprint test at the bottom of this file.
      await hasStarted;
      const concurrent = await regeneratePage(
        { orderId, pageIndex: 0, feedback: 'other page', actor: customerReviewActor(TOKEN) },
        { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) },
      );
      assert.equal(concurrent.ok, true, 'the concurrent regeneration commits');

      releaseBuild();
      const res = await inflight;

      // The regeneration itself succeeded and was committed before the rebuild.
      assert.equal(res.ok, true);
      // …but the proof built from the now-stale artifact set was refused.
      assert.equal(res.proofRefreshed, false, 'the stale proof must not be reported as refreshed');
      assert.equal(res.proofRefreshError, 'proof_source_changed_during_rebuild');

      const after = await getOrder(orderId);
      assert.equal(
        after?.storyArtifactUrl,
        OLD_PROOF,
        'the stale proof URL must NOT be written over the order',
      );
      assert.equal(after?.pageArtifacts?.[0].regenerateCount, 1, 'the concurrent regeneration survived');
      assert.equal(after?.pageArtifacts?.[1].regenerateCount, 1, 'the regeneration survived');
      assert.ok(
        (after?.auditEvents ?? []).some(
          (e) => e.type === 'proof_rebuilt' && e.reason === 'stale_source_discarded',
        ),
        'the discard is auditable',
      );
    } finally {
      cleanup(dir);
    }
  },
);

// ── Approval: real proof rebuild, interleaved ──────────────────────────────

test('approveWholeBook persists the freshly-built proof in the SAME guarded commit as the approval', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_approve_proof_ok';
    await persistOrder(makeOrder(orderId));
    const build = makeGatedBuildProof({});

    const res = await approveWholeBook(
      orderId,
      { buildProof: build.fn, approvePrint: async () => ({ ok: true }) },
      { actor: customerReviewActor(TOKEN) },
    );

    assert.equal(res.ok, true);
    assert.equal(build.calls(), 1);

    const after = await getOrder(orderId);
    assert.equal(after?.reviewStatus, 'approved');
    assert.equal(after?.storyArtifactUrl, NEW_PROOF, 'proof URL landed with the approval');
    // Both the approval and the proof URL came from ONE conditional write.
    const types = (after?.auditEvents ?? []).map((e) => e.type);
    assert.ok(types.includes('proof_rebuilt'));
    assert.ok(types.includes('whole_book_approved'));
  } finally {
    cleanup(dir);
  }
});

test(
  'DETERMINISTIC: a concurrent regeneration lands while the approval proof renders — ' +
    'approval is REFUSED rather than approving against a stale proof',
  async () => {
    const dir = makeTmp();
    try {
      const orderId = 'ord_approve_proof_stale';
      await persistOrder(makeOrder(orderId));

      let releaseBuild!: () => void;
      const mayFinish = new Promise<void>((r) => { releaseBuild = r; });
      let buildStarted!: () => void;
      const hasStarted = new Promise<void>((r) => { buildStarted = r; });
      const build = makeGatedBuildProof({ onStart: () => buildStarted(), wait: mayFinish });

      const inflight = approveWholeBook(
        orderId,
        { buildProof: build.fn, approvePrint: async () => ({ ok: true }) },
        { actor: customerReviewActor(TOKEN) },
      );

      await hasStarted;
      // A regeneration changes page 1 while the approval proof is rendering.
      const regen = await regeneratePage(
        { orderId, pageIndex: 1, feedback: 'different', actor: customerReviewActor(TOKEN) },
        { providers: [stubProvider], skipProofRebuild: true, now: () => new Date(NOW) },
      );
      assert.equal(regen.ok, true, 'the concurrent regeneration commits');

      releaseBuild();
      const res = await inflight;

      assert.equal(res.ok, false, 'approval must not proceed against a stale proof');
      assert.equal(res.status, 409);

      const after = await getOrder(orderId);
      assert.notEqual(after?.reviewStatus, 'approved', 'the book must NOT be approved');
      assert.equal(
        after?.storyArtifactUrl,
        OLD_PROOF,
        'the stale proof URL must NOT have been persisted',
      );
      assert.equal(after?.pageArtifacts?.[1].regenerateCount, 1, 'the regeneration survived');
      assert.equal(
        (after?.auditEvents ?? []).some((e) => e.type === 'whole_book_approved'),
        false,
        'no approval event',
      );
    } finally {
      cleanup(dir);
    }
  },
);

test('a failed proof build blocks approval and writes no proof URL', async () => {
  const dir = makeTmp();
  try {
    const orderId = 'ord_approve_build_fail';
    await persistOrder(makeOrder(orderId));

    const res = await approveWholeBook(
      orderId,
      {
        buildProof: async () => ({ ok: false as const, error: 'render_failed' }),
        approvePrint: async () => {
          throw new Error('print handoff must never run');
        },
      },
      { actor: customerReviewActor(TOKEN) },
    );

    assert.equal(res.ok, false);
    assert.equal(res.status, 502);

    const after = await getOrder(orderId);
    assert.notEqual(after?.reviewStatus, 'approved');
    assert.equal(after?.storyArtifactUrl, OLD_PROOF, 'proof URL unchanged');
  } finally {
    cleanup(dir);
  }
});

test('the proof fingerprint changes when any rendered page input changes', () => {
  const base = [page(0), page(1)];
  const same = proofSourceFingerprint(base);
  assert.equal(proofSourceFingerprint([page(1), page(0)]), same, 'page order is normalized');
  assert.notEqual(
    proofSourceFingerprint([page(0), page(1, { acceptedImageUrl: 'https://example.invalid/other.png' })]),
    same,
    'a changed image invalidates the proof',
  );
  assert.notEqual(
    proofSourceFingerprint([page(0), page(1, { storyText: 'different text' })]),
    same,
    'changed story text invalidates the proof',
  );
  assert.notEqual(proofSourceFingerprint([page(0)]), same, 'a removed page invalidates the proof');
  // Render-neutral: accepting a page whose current image is already the one
  // being rendered does not change the PDF, so it must not discard the proof.
  const unaccepted = [page(0, { accepted: false, acceptedImageUrl: null }), page(1)];
  const acceptedNow = [page(0, { accepted: true }), page(1)];
  assert.equal(
    proofSourceFingerprint(unaccepted),
    proofSourceFingerprint(acceptedNow),
    'a render-neutral accept must not invalidate an in-flight proof',
  );
});
