/**
 * Server-side audit trail for /review activity.
 * Locks every event-emit point that ops needs to reconstruct what happened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendAuditEvent,
  createOrderRecord,
  getOrder,
  persistOrder,
  type OrderRecord,
  type PageArtifact,
  type ReviewAuditEvent,
} from '../src/lib/orders.ts';
import {
  acceptPage,
  acknowledgeProofReview,
  approveWholeBook,
  regeneratePage,
} from '../src/lib/page-review.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-audit-'));
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

async function seed(overrides: Partial<OrderRecord> = {}, id = 'ord_audit_test'): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id, now: '2026-04-27T10:00:00Z' },
  );
  const order: OrderRecord = {
    ...base,
    paymentStatus: 'paid',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofApprovalToken: 'tok_xyz',
    fulfillmentStatus: 'proof_ready',
    pageArtifacts: [
      pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      pageFixture(2, { accepted: true, acceptedImageUrl: 'https://x/2.png' }),
    ],
    reviewStatus: 'in_review',
    auditEvents: [],
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

const successProvider: ImageProvider = {
  name: 'openai',
  async generate({ prompt }) {
    return {
      imageUrl: 'https://example.com/regen.png',
      provider: 'openai',
      model: 'gpt-image-1',
      promptUsed: prompt,
      latencyMs: 1,
      error: null,
    };
  },
};

function eventTypes(events: ReviewAuditEvent[] | undefined): string[] {
  return (events ?? []).map((e) => e.type);
}

// ── appendAuditEvent (helper) ────────────────────────────────────────────────

test('appendAuditEvent: appends in order, fills timestamp, persists', async () => {
  const dir = makeTmp();
  try {
    await seed({ auditEvents: [] });
    await appendAuditEvent('ord_audit_test', { type: 'proof_generated' });
    await appendAuditEvent('ord_audit_test', { type: 'page_accepted', pageIndex: 1 });
    const after = await getOrder('ord_audit_test');
    assert.equal(after?.auditEvents?.length, 2);
    assert.equal(after?.auditEvents?.[0].type, 'proof_generated');
    assert.equal(after?.auditEvents?.[1].type, 'page_accepted');
    assert.equal(after?.auditEvents?.[1].pageIndex, 1);
    assert.match(after?.auditEvents?.[0].at ?? '', /^\d{4}-/);
  } finally { cleanup(dir); }
});

test('appendAuditEvent: 404 (returns null) on unknown order, does not throw', async () => {
  const dir = makeTmp();
  try {
    const r = await appendAuditEvent('ord_does_not_exist', { type: 'proof_generated' });
    assert.equal(r, null);
  } finally { cleanup(dir); }
});

// ── page_regenerated ────────────────────────────────────────────────────────

test('regeneratePage writes a page_regenerated audit event with provider + page', async () => {
  const dir = makeTmp();
  try {
    await seed({
      pageArtifacts: [pageFixture(0), pageFixture(1)],
    });
    const r = await regeneratePage(
      { orderId: 'ord_audit_test', pageIndex: 1, feedback: 'fix the hands' },
      { providers: [successProvider], skipProofRebuild: true },
    );
    assert.equal(r.ok, true);
    const after = await getOrder('ord_audit_test');
    const events = after!.auditEvents!;
    const regen = events.find((e) => e.type === 'page_regenerated');
    assert.ok(regen, 'expected page_regenerated event');
    assert.equal(regen!.pageIndex, 1);
    assert.equal((regen!.meta as Record<string, unknown>).provider, 'openai');
    assert.equal((regen!.meta as Record<string, unknown>).success, true);
    assert.equal((regen!.meta as Record<string, unknown>).regenerateCount, 1);
  } finally { cleanup(dir); }
});

test('regeneratePage writes a proof_rebuilt event after auto-rebuild', async () => {
  const dir = makeTmp();
  try {
    await seed({
      pageArtifacts: [pageFixture(0), pageFixture(1)],
    });
    await regeneratePage(
      { orderId: 'ord_audit_test', pageIndex: 0, feedback: '' },
      {
        providers: [successProvider],
        rebuildProof: async () => ({ ok: true, proofUrl: 'https://x/refreshed.pdf' }),
      },
    );
    const after = await getOrder('ord_audit_test');
    const types = eventTypes(after?.auditEvents);
    assert.ok(types.includes('page_regenerated'));
    assert.ok(types.includes('proof_rebuilt'));
    const rebuilt = after!.auditEvents!.find((e) => e.type === 'proof_rebuilt');
    assert.equal((rebuilt!.meta as Record<string, unknown>).success, true);
    assert.equal((rebuilt!.meta as Record<string, unknown>).triggeredBy, 'page_regenerated');
  } finally { cleanup(dir); }
});

// ── page_accepted ────────────────────────────────────────────────────────────

test('acceptPage writes a page_accepted audit event with counts', async () => {
  const dir = makeTmp();
  try {
    await seed({
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1),
        pageFixture(2),
      ],
    });
    const r = await acceptPage({ orderId: 'ord_audit_test', pageIndex: 1 });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'page_accepted');
    assert.ok(evt);
    assert.equal(evt!.pageIndex, 1);
    assert.equal((evt!.meta as Record<string, unknown>).acceptedCount, 2);
    assert.equal((evt!.meta as Record<string, unknown>).totalPages, 3);
  } finally { cleanup(dir); }
});

// ── proof_review_acknowledged ───────────────────────────────────────────────

test('acknowledgeProofReview writes a proof_review_acknowledged event', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const r = await acknowledgeProofReview('ord_audit_test', new Date('2026-04-27T11:00:00Z'));
    assert.equal(r.ok, true);
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'proof_review_acknowledged');
    assert.ok(evt);
    // timestamp should match the deterministic clock we passed in
    assert.equal(evt!.at, '2026-04-27T11:00:00.000Z');
  } finally { cleanup(dir); }
});

test('acknowledgeProofReview is idempotent — no duplicate audit events on re-ack', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    await acknowledgeProofReview('ord_audit_test', new Date('2026-04-27T11:00:00Z'));
    await acknowledgeProofReview('ord_audit_test', new Date('2026-04-27T12:00:00Z'));
    const after = await getOrder('ord_audit_test');
    const acks = after!.auditEvents!.filter((e) => e.type === 'proof_review_acknowledged');
    assert.equal(acks.length, 1);
  } finally { cleanup(dir); }
});

// ── whole_book_approved (happy path) ────────────────────────────────────────

test('approveWholeBook writes whole_book_approved + proof_rebuilt on success', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: '2026-04-27T11:00:00Z' });
    const r = await approveWholeBook('ord_audit_test', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'https://x/final.pdf' }),
      approvePrint: async () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_audit_test');
    const types = eventTypes(after?.auditEvents);
    assert.ok(types.includes('proof_rebuilt'));
    assert.ok(types.includes('whole_book_approved'));
    const approved = after!.auditEvents!.find((e) => e.type === 'whole_book_approved');
    assert.equal((approved!.meta as Record<string, unknown>).bookFormat, 'classic');
    assert.equal((approved!.meta as Record<string, unknown>).proofUrl, 'https://x/final.pdf');
  } finally { cleanup(dir); }
});

// ── whole_book_approval_rejected (every gate) ───────────────────────────────

test('approveWholeBook rejected → audit event with reason=already_approved', async () => {
  const dir = makeTmp();
  try {
    await seed({ reviewStatus: 'approved', proofReviewedAt: '2026-04-26T00:00:00Z' });
    await approveWholeBook('ord_audit_test', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'x' }),
    });
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'whole_book_approval_rejected');
    assert.ok(evt);
    assert.equal(evt!.reason, 'already_approved');
  } finally { cleanup(dir); }
});

test('approveWholeBook rejected → audit event with reason=pages_not_accepted', async () => {
  const dir = makeTmp();
  try {
    await seed({
      proofReviewedAt: '2026-04-27T11:00:00Z',
      pageArtifacts: [
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1), // not accepted
      ],
    });
    await approveWholeBook('ord_audit_test', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'x' }),
    });
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'whole_book_approval_rejected');
    assert.ok(evt);
    assert.equal(evt!.reason, 'pages_not_accepted');
    assert.equal((evt!.meta as Record<string, unknown>).acceptedCount, 1);
    assert.equal((evt!.meta as Record<string, unknown>).totalPages, 2);
  } finally { cleanup(dir); }
});

test('approveWholeBook rejected → audit event with reason=proof_not_ready', async () => {
  const dir = makeTmp();
  try {
    await seed({ storyArtifactUrl: null, proofReviewedAt: '2026-04-27T11:00:00Z' });
    await approveWholeBook('ord_audit_test');
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'whole_book_approval_rejected');
    assert.equal(evt!.reason, 'proof_not_ready');
  } finally { cleanup(dir); }
});

test('approveWholeBook rejected → audit event with reason=proof_ack_missing', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    await approveWholeBook('ord_audit_test');
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'whole_book_approval_rejected');
    assert.equal(evt!.reason, 'proof_ack_missing');
  } finally { cleanup(dir); }
});

test('approveWholeBook rejected → audit event with reason=proof_rebuild_failed', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: '2026-04-27T11:00:00Z' });
    await approveWholeBook('ord_audit_test', {
      rebuildProof: async () => ({ ok: false, error: 'pdf builder threw' }),
    });
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'whole_book_approval_rejected');
    assert.equal(evt!.reason, 'proof_rebuild_failed');
  } finally { cleanup(dir); }
});

// ── Chronological accumulation ──────────────────────────────────────────────

test('audit trail accumulates events in append order', async () => {
  // Direct helper-driven append ordering check (kept for clarity).
  const dir = makeTmp();
  try {
    await seed({ auditEvents: [] });
    await appendAuditEvent('ord_audit_test', { type: 'proof_generated' });
    await appendAuditEvent('ord_audit_test', { type: 'page_regenerated', pageIndex: 0 });
    await appendAuditEvent('ord_audit_test', { type: 'proof_rebuilt' });
    await appendAuditEvent('ord_audit_test', { type: 'page_accepted', pageIndex: 0 });
    await appendAuditEvent('ord_audit_test', { type: 'proof_review_acknowledged' });
    await appendAuditEvent('ord_audit_test', { type: 'whole_book_approved' });
    const after = await getOrder('ord_audit_test');
    assert.deepEqual(eventTypes(after?.auditEvents), [
      'proof_generated',
      'page_regenerated',
      'proof_rebuilt',
      'page_accepted',
      'proof_review_acknowledged',
      'whole_book_approved',
    ]);
  } finally { cleanup(dir); }
});

test('end-to-end: full review→approve sequence is captured in chronological order', async () => {
  // Now possible since acceptPage no longer auto-approves: regen → accept(0) →
  // accept(1) → ack → approveWholeBook (auto-rebuild + approved).
  const dir = makeTmp();
  try {
    await seed({
      pageArtifacts: [pageFixture(0), pageFixture(1)],
      proofReviewedAt: null,
    });
    await regeneratePage(
      { orderId: 'ord_audit_test', pageIndex: 0, feedback: 'fix' },
      { providers: [successProvider], skipProofRebuild: true },
    );
    await acceptPage({ orderId: 'ord_audit_test', pageIndex: 0 });
    await acceptPage({ orderId: 'ord_audit_test', pageIndex: 1 });
    await acknowledgeProofReview('ord_audit_test');
    const r = await approveWholeBook('ord_audit_test', {
      rebuildProof: async () => ({ ok: true, proofUrl: 'https://x/final.pdf' }),
      approvePrint: async () => ({ ok: true }),
    });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_audit_test');
    assert.deepEqual(eventTypes(after?.auditEvents), [
      'page_regenerated',
      'page_accepted',
      'page_accepted',
      'proof_review_acknowledged',
      'proof_rebuilt',
      'whole_book_approved',
    ]);
    assert.equal(after?.reviewStatus, 'approved');
  } finally { cleanup(dir); }
});
