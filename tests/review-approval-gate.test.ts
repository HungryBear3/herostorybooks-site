/**
 * Approval-gate contract for /review/[orderId].
 *
 * Customers must not approve the printed book based on the 6 illustrated story
 * thumbnails alone. The gate requires:
 *   1. every illustrated page accepted
 *   2. assembled proof PDF exists (storyArtifactUrl)
 *   3. customer ticks the "I reviewed the full proof PDF" acknowledgment
 *   4. order not already approved
 *
 * Plus snapshot wiring: getReviewSnapshot must surface storyArtifactUrl + an
 * isPrint flag so the UI can render print-vs-digital copy honestly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, getOrder, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import {
  evaluateApproveGate,
  getReviewSnapshot,
  hasReviewAccess,
  requestPageChanges,
  shouldPauseCustomerReviewNudges,
} from '../src/lib/page-review.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-approval-gate-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

function pageFixture(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1}`,
    basePrompt: 'p',
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: null,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

const BASE_ARGS = {
  pageArtifacts: [
    pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
    pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
  ],
  reviewStatus: 'in_review' as NonNullable<OrderRecord['reviewStatus']>,
  storyArtifactUrl: 'https://example.com/proof.pdf',
  proofAcknowledged: true,
};

// ── evaluateApproveGate ──────────────────────────────────────────────────────

test('approve gate: all conditions met → null (allow)', () => {
  assert.equal(evaluateApproveGate(BASE_ARGS), null);
});

test('approve gate: any unaccepted page → pages_not_accepted', () => {
  const r = evaluateApproveGate({
    ...BASE_ARGS,
    pageArtifacts: [
      pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      pageFixture(1), // not accepted
    ],
  });
  assert.equal(r, 'pages_not_accepted');
});

test('approve gate: empty artifacts → pages_not_accepted', () => {
  const r = evaluateApproveGate({ ...BASE_ARGS, pageArtifacts: [] });
  assert.equal(r, 'pages_not_accepted');
});

test('approve gate: storyArtifactUrl missing → proof_not_ready', () => {
  const r = evaluateApproveGate({ ...BASE_ARGS, storyArtifactUrl: null });
  assert.equal(r, 'proof_not_ready');
});

test('approve gate: ack unchecked → proof_ack_missing', () => {
  const r = evaluateApproveGate({ ...BASE_ARGS, proofAcknowledged: false });
  assert.equal(r, 'proof_ack_missing');
});

test('approve gate: already approved → already_approved', () => {
  const r = evaluateApproveGate({ ...BASE_ARGS, reviewStatus: 'approved' });
  assert.equal(r, 'already_approved');
});

test('approve gate: enforces ordering — pages first, then proof, then ack', () => {
  // No pages accepted, no proof, no ack: pages takes precedence
  const r1 = evaluateApproveGate({
    pageArtifacts: [pageFixture(0)],
    reviewStatus: 'in_review',
    storyArtifactUrl: null,
    proofAcknowledged: false,
  });
  assert.equal(r1, 'pages_not_accepted');

  // Pages accepted, no proof, no ack: proof takes precedence over ack
  const r2 = evaluateApproveGate({
    pageArtifacts: [pageFixture(0, { accepted: true, acceptedImageUrl: 'u' })],
    reviewStatus: 'in_review',
    storyArtifactUrl: null,
    proofAcknowledged: false,
  });
  assert.equal(r2, 'proof_not_ready');

  // Pages accepted, proof present, no ack: ack required
  const r3 = evaluateApproveGate({
    pageArtifacts: [pageFixture(0, { accepted: true, acceptedImageUrl: 'u' })],
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://x/proof.pdf',
    proofAcknowledged: false,
  });
  assert.equal(r3, 'proof_ack_missing');
});

// ── getReviewSnapshot wiring ─────────────────────────────────────────────────

async function seedOrder(
  bookFormat: 'digital' | 'classic' | 'premium',
  storyArtifactUrl: string | null,
): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat, email: 'a@b.com' },
    { id: `ord_review_gate_${bookFormat}`, now: '2026-04-27T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    storyArtifactUrl,
    pageArtifacts: [pageFixture(0), pageFixture(1)],
    reviewStatus: 'in_review',
  };
  await persistOrder(order);
  return order;
}

test('getReviewSnapshot: surfaces storyArtifactUrl when present', async () => {
  const dir = makeTmp();
  try {
    await seedOrder('classic', 'https://example.com/proof.pdf');
    const snap = await getReviewSnapshot('ord_review_gate_classic');
    assert.ok(snap);
    assert.equal(snap!.storyArtifactUrl, 'https://example.com/proof.pdf');
  } finally {
    cleanup(dir);
  }
});

test('getReviewSnapshot: print orders → isPrint=true', async () => {
  const dir = makeTmp();
  try {
    await seedOrder('classic', 'https://x/proof.pdf');
    const snap = await getReviewSnapshot('ord_review_gate_classic');
    assert.equal(snap!.isPrint, true);
    assert.equal(snap!.bookFormat, 'classic');
  } finally {
    cleanup(dir);
  }
});

test('getReviewSnapshot: digital orders → isPrint=false', async () => {
  const dir = makeTmp();
  try {
    await seedOrder('digital', 'https://x/proof.pdf');
    const snap = await getReviewSnapshot('ord_review_gate_digital');
    assert.equal(snap!.isPrint, false);
    assert.equal(snap!.bookFormat, 'digital');
  } finally {
    cleanup(dir);
  }
});

test('getReviewSnapshot: premium orders → isPrint=true', async () => {
  const dir = makeTmp();
  try {
    await seedOrder('premium', 'https://x/proof.pdf');
    const snap = await getReviewSnapshot('ord_review_gate_premium');
    assert.equal(snap!.isPrint, true);
  } finally {
    cleanup(dir);
  }
});

test('getReviewSnapshot: storyArtifactUrl null when proof not yet built', async () => {
  const dir = makeTmp();
  try {
    await seedOrder('classic', null);
    const snap = await getReviewSnapshot('ord_review_gate_classic');
    assert.equal(snap!.storyArtifactUrl, null);
    // Gate should block: proof_not_ready
    assert.equal(
      evaluateApproveGate({
        pageArtifacts: snap!.pageArtifacts.map((p) => ({
          ...p,
          accepted: true,
          acceptedImageUrl: p.currentImageUrl,
        })),
        reviewStatus: snap!.reviewStatus,
        storyArtifactUrl: snap!.storyArtifactUrl,
        proofAcknowledged: true,
      }),
      'proof_not_ready',
    );
  } finally {
    cleanup(dir);
  }
});

test('requestPageChanges: persists customer note/status without generating a new image', async () => {
  const dir = makeTmp();
  try {
    await seedOrder('classic', 'https://example.com/proof.pdf');
    const before = await getReviewSnapshot('ord_review_gate_classic');
    const imageBefore = before!.pageArtifacts[0].currentImageUrl;

    const result = await requestPageChanges(
      {
        orderId: 'ord_review_gate_classic',
        pageIndex: 0,
        note: 'Please make the dinosaur smaller and keep Luna smiling.',
      },
      new Date('2026-05-28T22:00:00Z'),
    );

    assert.equal(result.ok, true);
    assert.equal(result.page!.customerReviewStatus, 'changes_requested');
    assert.equal(result.page!.customerRequestedChange?.note, 'Please make the dinosaur smaller and keep Luna smiling.');
    assert.equal(result.page!.customerRequestedChange?.lifecycleStatus, 'triage');
    assert.equal(result.page!.currentImageUrl, imageBefore);
    assert.equal(result.page!.regenerateCount, 0);
    assert.equal(result.page!.accepted, false);

    const order = await getOrder('ord_review_gate_classic');
    assert.equal(order!.reviewStatus, 'customer_changes_requested');
    assert.equal(order!.proofReviewedAt ?? null, null);
    assert.equal(order!.auditEvents?.at(-1)?.type, 'page_changes_requested');
  } finally {
    cleanup(dir);
  }
});

test('getReviewSnapshot: exposes open requested changes and pauses customer nudges', async () => {
  const dir = makeTmp();
  try {
    await seedOrder('classic', 'https://example.com/proof.pdf');
    await requestPageChanges(
      { orderId: 'ord_review_gate_classic', pageIndex: 1, note: 'Face should match the photo more closely.' },
      new Date('2026-05-28T22:05:00Z'),
    );

    const snap = await getReviewSnapshot('ord_review_gate_classic');
    assert.equal(snap!.openRequestedChangesCount, 1);
    assert.equal(snap!.customerNudgesPaused, true);
    assert.equal(snap!.trustCopy, 'Nothing is sent to print until you give the final go-ahead.');
    assert.equal(shouldPauseCustomerReviewNudges({
      reviewStatus: snap!.reviewStatus,
      pageArtifacts: snap!.pageArtifacts,
    }), true);
  } finally {
    cleanup(dir);
  }
});


test('review access: print order with proof token requires matching token', () => {
  const order = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id: 'ord_review_token_gate', now: '2026-04-27T10:00:00Z' },
  );
  const withToken: OrderRecord = { ...order, proofApprovalToken: 'tok_secret' };
  assert.equal(hasReviewAccess(withToken, { reviewToken: null }), false);
  assert.equal(hasReviewAccess(withToken, { reviewToken: 'wrong' }), false);
  assert.equal(hasReviewAccess(withToken, { reviewToken: 'tok_secret' }), true);
});

test('review access: digital orders and legacy print orders remain visible without a token', () => {
  const digital = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: 'a@b.com' },
    { id: 'ord_review_token_digital', now: '2026-04-27T10:00:00Z' },
  );
  const legacyPrint = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id: 'ord_review_token_legacy', now: '2026-04-27T10:00:00Z' },
  );
  assert.equal(hasReviewAccess(digital, { reviewToken: null }), true);
  assert.equal(hasReviewAccess(legacyPrint, { reviewToken: null }), true);
});

// ── Source-level guards on the review client ────────────────────────────────

test('review client renders the full-proof CTA + scope banner + ack checkbox', () => {
  const src = readFileSync('src/app/review/[orderId]/review-client.tsx', 'utf8');
  assert.match(src, /data-testid="full-proof-cta"/);
  assert.match(src, /data-testid="review-scope-banner"/);
  assert.match(src, /data-testid="proof-ack-checkbox"/);
  assert.match(src, /data-testid="approve-whole-book"/);
  assert.match(src, /data-testid="delivery-trust-copy"/);
  assert.match(src, /data-testid="request-page-changes"/);
  assert.match(src, /data-testid="open-change-hold"/);
});

test('review client gates approve button on proofAck + storyArtifactUrl + allAccepted', () => {
  const src = readFileSync('src/app/review/[orderId]/review-client.tsx', 'utf8');
  // Static guard: the disabled prop on the approve button must reference all three signals.
  const approveSection = src.slice(src.indexOf('data-testid="approve-whole-book"'));
  assert.match(approveSection.slice(0, 600).split('').reverse().join(''), /^[\s\S]*$/); // touch
  // Walk back from the testid to the disabled={ ... } block.
  const upTo = src.indexOf('data-testid="approve-whole-book"');
  const before = src.slice(0, upTo);
  // Most recent disabled={...}
  const disabledStart = before.lastIndexOf('disabled={');
  const disabledBlock = before.slice(disabledStart, upTo);
  assert.match(disabledBlock, /!allAccepted/);
  assert.match(disabledBlock, /!proofAck/);
  assert.match(disabledBlock, /!snapshot\.storyArtifactUrl/);
});

test('review client uses isPrint to switch print-vs-digital copy', () => {
  const src = readFileSync('src/app/review/[orderId]/review-client.tsx', 'utf8');
  assert.match(src, /snapshot\.isPrint/);
  assert.match(src, /full proof PDF/i);
  // Print copy must call out the keepsake/printed book explicitly somewhere.
  assert.match(src, /printed book|keepsake pages/i);
});
