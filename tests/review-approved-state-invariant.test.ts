/**
 * Approved-state invariant for customer review mutations.
 *
 * Once reviewStatus === 'approved' the book is frozen: the approved proof may
 * already have been handed to the print pipeline. No customer review mutation
 * may reopen or downgrade that state.
 *
 * The dangerous case is regenerate. Its provider call deliberately runs OUTSIDE
 * the order mutation lock (it can take many seconds), so the book can be
 * approved during that window. The persistence phase therefore has to re-read
 * the order under the lock and fail closed — otherwise it would write
 * reviewStatus back to 'customer_changes_requested' and replace an accepted
 * page's image on an already-approved book.
 *
 * The interleaving test below is driven by explicit promise gates, not by
 * timing, so the ordering (provider work starts BEFORE approval, persistence
 * happens AFTER approval) is deterministic on every run.
 *
 * Synthetic order ids and stub providers only — no real orders, no provider
 * network calls, no fulfillment/print/email side effects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, getOrder, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';
import { acceptPage, approveWholeBook, regeneratePage } from '../src/lib/page-review.ts';

const NOW = '2026-08-03T12:00:00.000Z';
const TOKEN = 'c3d4'.repeat(12);
const REGEN_URL = 'https://example.com/regenerated-after-approval.png';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-approved-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    characterAnchor: 'a',
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: `https://example.com/p${i}.png`,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...o,
  };
}

async function seed(id: string, o: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Testkid', bookFormat: 'digital', email: 'a@b.com' }, { id, now: NOW }),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: NOW,
    proofApprovalToken: TOKEN,
    pageArtifacts: [page(0), page(1)],
    ...o,
  };
  await persistOrder(order);
  return order;
}

const stubRebuild = async () => ({ ok: true as const, proofUrl: 'https://example.com/rebuilt.pdf' });

const instantProvider: ImageProvider = {
  name: 'fal',
  async generate({ prompt }) {
    return {
      imageUrl: REGEN_URL,
      provider: 'fal',
      model: 'stub',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};

// ── Accept on an approved book ──────────────────────────────────────────────

test('acceptPage on an APPROVED order is rejected (409) and mutates nothing', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_acc_approved', {
      reviewStatus: 'approved',
      pageArtifacts: [page(0), page(1, { accepted: false, acceptedImageUrl: null })],
    });

    const res = await acceptPage({ orderId: 'ord_acc_approved', pageIndex: 1 });

    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.error, 'already_approved');

    const after = await getOrder('ord_acc_approved');
    assert.equal(after?.reviewStatus, 'approved', 'approval must survive');
    assert.equal(after?.pageArtifacts?.[1].accepted, false, 'page must not have been accepted');
    assert.equal(after?.pageArtifacts?.[1].acceptedImageUrl, null);

    const audit = after?.auditEvents ?? [];
    assert.ok(
      audit.some((e) => e.type === 'page_accept_rejected' && e.reason === 'already_approved'),
      'the rejection must be auditable',
    );
    assert.equal(
      audit.some((e) => e.type === 'page_accepted'),
      false,
      'no page_accepted event may be recorded',
    );
  } finally {
    cleanup(dir);
  }
});

// ── Regenerate on an approved book ──────────────────────────────────────────

test('regeneratePage on an APPROVED order is rejected (409) and never downgrades reviewStatus', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_regen_approved', { reviewStatus: 'approved' });

    // An order that is ALREADY approved when the request arrives is rejected at
    // pre-flight, so no provider work is done at all. (The locked re-read is
    // what covers the harder case where approval lands mid-provider-call — see
    // the deterministic interleaving test below.)
    let providerCalls = 0;
    const countingProvider: ImageProvider = {
      name: 'fal',
      async generate(args) {
        providerCalls += 1;
        return instantProvider.generate(args);
      },
    };

    const res = await regeneratePage(
      { orderId: 'ord_regen_approved', pageIndex: 1, feedback: 'make it bluer' },
      { providers: [countingProvider], skipProofRebuild: true, now: () => new Date(NOW) },
    );

    assert.equal(providerCalls, 0, 'an already-approved book must not burn a provider call');

    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.error, 'already_approved');

    const after = await getOrder('ord_regen_approved');
    assert.equal(after?.reviewStatus, 'approved', 'approved must NOT be downgraded');
    assert.equal(after?.pageArtifacts?.[1].regenerateCount, 0, 'no regeneration was recorded');
    assert.equal(
      after?.pageArtifacts?.[1].currentImageUrl,
      'https://example.com/p1.png',
      'the approved image must be untouched',
    );
    assert.equal(after?.pageArtifacts?.[1].acceptedImageUrl, 'https://example.com/p1.png');
    assert.equal(after?.pageArtifacts?.[1].feedbackHistory.length, 0);
    assert.equal(after?.pageArtifacts?.[1].versionHistory.length, 0);

    const audit = after?.auditEvents ?? [];
    assert.equal(
      audit.some((e) => e.type === 'page_regenerated'),
      false,
      'no page_regenerated event may be recorded',
    );
  } finally {
    cleanup(dir);
  }
});

// ── The deterministic approve-vs-regenerate interleaving ────────────────────

test(
  'DETERMINISTIC interleaving: provider work starts BEFORE approval, persistence lands AFTER — ' +
    'approval stands and regeneration persistence fails closed',
  async () => {
    const dir = makeTmp();
    try {
      await seed('ord_interleave');

      // Gates that pin the interleaving exactly, with no reliance on timing.
      let providerStarted!: () => void;
      const providerHasStarted = new Promise<void>((r) => { providerStarted = r; });
      let releaseProvider!: () => void;
      const providerMayFinish = new Promise<void>((r) => { releaseProvider = r; });

      const gatedProvider: ImageProvider = {
        name: 'fal',
        async generate({ prompt }) {
          providerStarted();          // (1) provider work has begun
          await providerMayFinish;    // (3) ...held here while approval happens
          return {
            imageUrl: REGEN_URL,
            provider: 'fal',
            model: 'stub',
            promptUsed: prompt,
            latencyMs: 1,
            error: null,
          };
        },
      };

      // Start the regeneration. It does its pre-flight read (order is still
      // 'in_review') and then blocks inside the provider call, OUTSIDE the lock.
      const regenPromise = regeneratePage(
        { orderId: 'ord_interleave', pageIndex: 1, feedback: 'brighter please' },
        { providers: [gatedProvider], skipProofRebuild: true, now: () => new Date(NOW) },
      );

      await providerHasStarted;

      // (2) Approval runs to completion while the provider call is in flight.
      const approval = await approveWholeBook('ord_interleave', { rebuildProof: stubRebuild });
      assert.equal(approval.ok, true, 'approval must succeed while regeneration is mid-provider');
      assert.equal((await getOrder('ord_interleave'))?.reviewStatus, 'approved');

      // (4) Now let the provider return, so regeneration reaches its
      //     persistence phase strictly AFTER the book was approved.
      releaseProvider();
      const regen = await regenPromise;

      // Regeneration persistence must fail closed.
      assert.equal(regen.ok, false, 'regeneration persistence must fail after approval');
      assert.equal(regen.status, 409);
      assert.equal(regen.error, 'already_approved');

      // Approval stands, and nothing about the approved book changed.
      const after = await getOrder('ord_interleave');
      assert.equal(after?.reviewStatus, 'approved', 'approval must REMAIN approved');
      assert.equal(after?.pageArtifacts?.[1].regenerateCount, 0);
      assert.equal(after?.pageArtifacts?.[1].accepted, true);
      assert.equal(after?.pageArtifacts?.[1].currentImageUrl, 'https://example.com/p1.png');
      assert.notEqual(
        String(after?.pageArtifacts?.[1].currentImageUrl),
        REGEN_URL,
        'the post-approval provider result must never be persisted',
      );
      assert.equal(after?.pageArtifacts?.[1].versionHistory.length, 0);
      assert.equal(after?.pageArtifacts?.[1].feedbackHistory.length, 0);

      // The whole-book approval is intact in the audit trail, and the discarded
      // regeneration is recorded.
      const audit = after?.auditEvents ?? [];
      assert.ok(audit.some((e) => e.type === 'whole_book_approved'));
      assert.ok(
        audit.some((e) => e.type === 'page_regenerate_rejected' && e.reason === 'already_approved'),
      );
      assert.equal(audit.some((e) => e.type === 'page_regenerated'), false);
    } finally {
      cleanup(dir);
    }
  },
);

test(
  'DETERMINISTIC interleaving: accept that starts before approval cannot re-open the approved book',
  async () => {
    const dir = makeTmp();
    try {
      await seed('ord_interleave_accept', {
        pageArtifacts: [page(0), page(1)],
      });

      // Approve first, then let a late accept (as a stale browser tab would
      // send) arrive. It must be rejected rather than rewriting artifacts.
      const approval = await approveWholeBook('ord_interleave_accept', { rebuildProof: stubRebuild });
      assert.equal(approval.ok, true);

      const late = await acceptPage({ orderId: 'ord_interleave_accept', pageIndex: 0 });
      assert.equal(late.ok, false);
      assert.equal(late.status, 409);
      assert.equal(late.error, 'already_approved');

      const after = await getOrder('ord_interleave_accept');
      assert.equal(after?.reviewStatus, 'approved');
    } finally {
      cleanup(dir);
    }
  },
);

// ── No leakage of the review token through the rejection paths ──────────────

test('approved-state rejections leak no token into audit trail or persisted order', async () => {
  const dir = makeTmp();
  try {
    await seed('ord_leak_check', { reviewStatus: 'approved' });

    await acceptPage({ orderId: 'ord_leak_check', pageIndex: 1 });
    await regeneratePage(
      { orderId: 'ord_leak_check', pageIndex: 1, feedback: 'secret customer note text' },
      { providers: [instantProvider], skipProofRebuild: true, now: () => new Date(NOW) },
    );

    const after = await getOrder('ord_leak_check');
    const auditJson = JSON.stringify(after?.auditEvents ?? []);
    assert.equal(auditJson.includes(TOKEN), false, 'the review token must never reach the audit trail');
    assert.equal(
      auditJson.includes('secret customer note text'),
      false,
      'raw customer feedback text must never reach the audit trail',
    );
  } finally {
    cleanup(dir);
  }
});
