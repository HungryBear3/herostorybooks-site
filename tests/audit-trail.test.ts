/**
 * Server-side audit trail for /review activity.
 * Locks every event-emit point that ops needs to reconstruct what happened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import { padPageSet } from './support/full-page-set.ts';
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
  process.env.HSB_ENABLE_OPENAI_IMAGE = 'true';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
  return dir;
}
function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
  delete process.env.HSB_ENABLE_OPENAI_IMAGE;
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
    pageArtifacts: padPageSet([
      pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
      pageFixture(1, { accepted: true, acceptedImageUrl: 'https://x/1.png' }),
      pageFixture(2, { accepted: true, acceptedImageUrl: 'https://x/2.png' }),
    ]),
    reviewStatus: 'in_review',
    auditEvents: [],
    ...overrides,
  };
  // Proof gates are revision-bound: a seeded proof URL without an
  // identity would (correctly) fail every one of them.
  if (order.storyArtifactUrl && !order.proofVersion) {
    order.proofSourceFingerprint = proofSourceFingerprint(order);
    order.proofVersion = 'pv_test';
  }
  if (order.proofReviewedAt && !order.proofReviewedVersion) {
    order.proofReviewedVersion = order.proofVersion ?? 'pv_test';
  }
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
      pageArtifacts: padPageSet([pageFixture(0), pageFixture(1)]),
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
      pageArtifacts: padPageSet([pageFixture(0), pageFixture(1)]),
    });
    await regeneratePage(
      { orderId: 'ord_audit_test', pageIndex: 0, feedback: '' },
      {
        providers: [successProvider],
        buildProof: async (oid: string) => {
          const proofVersion = `pv_${Math.random().toString(36).slice(2)}`;
          const sourceOrder = (await getOrder(oid))!;
          const printTitle = sourceOrder.printTitle ?? `${sourceOrder.childName}'s Hero Story Book`;
          return {
            ok: true as const,
            proofUrl: 'https://x/refreshed.pdf',
            sourceFingerprint: proofSourceFingerprint(sourceOrder),
            proofVersion,
            printInteriorArtifactUrl: 'https://x/refreshed-interior.pdf',
            printInteriorMd5: 'refreshed-interior-md5',
            printInteriorPageCount: 32,
            printInteriorProofVersion: proofVersion,
            printTitle,
          };
        },
      },
    );
    const after = await getOrder('ord_audit_test');
    const types = eventTypes(after?.auditEvents);
    assert.ok(types.includes('page_regenerated'));
    assert.ok(types.includes('proof_published'));
    // The publish event names the revision it published; a regeneration also
    // records that the previous proof was invalidated.
    const published = after!.auditEvents!.find((e) => e.type === 'proof_published');
    assert.ok((published!.meta as Record<string, unknown>).proofVersion);
    assert.ok(types.includes('proof_invalidated'));
  } finally { cleanup(dir); }
});

// ── page_accepted ────────────────────────────────────────────────────────────

test('acceptPage writes a page_accepted audit event with counts', async () => {
  const dir = makeTmp();
  try {
    await seed({
      pageArtifacts: padPageSet([
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1),
        pageFixture(2),
      ]),
    });
    const r = await acceptPage({ orderId: 'ord_audit_test', pageIndex: 1 });
    assert.equal(r.ok, true);
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'page_accepted');
    assert.ok(evt);
    assert.equal(evt!.pageIndex, 1);
    // Padded to the 24-page contract: page 2 remains unaccepted → 23 accepted.
    assert.equal((evt!.meta as Record<string, unknown>).acceptedCount, 23);
    assert.equal((evt!.meta as Record<string, unknown>).totalPages, 24);
  } finally { cleanup(dir); }
});

// ── proof_review_acknowledged ───────────────────────────────────────────────

test('acknowledgeProofReview writes a proof_review_acknowledged event', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: null });
    const r = await acknowledgeProofReview('ord_audit_test', { proofVersion: 'pv_test', now: new Date('2026-04-27T11:00:00Z') });
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
    await acknowledgeProofReview('ord_audit_test', { proofVersion: 'pv_test', now: new Date('2026-04-27T11:00:00Z') });
    await acknowledgeProofReview('ord_audit_test', { proofVersion: 'pv_test', now: new Date('2026-04-27T12:00:00Z') });
    const after = await getOrder('ord_audit_test');
    const acks = after!.auditEvents!.filter((e) => e.type === 'proof_review_acknowledged');
    assert.equal(acks.length, 1);
  } finally { cleanup(dir); }
});

// ── whole_book_approved (happy path) ────────────────────────────────────────


// ── whole_book_approval_rejected (every gate) ───────────────────────────────

test('approveWholeBook rejected → audit event with reason=already_approved', async () => {
  const dir = makeTmp();
  try {
    await seed({ reviewStatus: 'approved', proofReviewedAt: '2026-04-26T00:00:00Z' });
    await approveWholeBook('ord_audit_test');
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
      pageArtifacts: padPageSet([
        pageFixture(0, { accepted: true, acceptedImageUrl: 'https://x/0.png' }),
        pageFixture(1, { accepted: false }), // not accepted
      ]),
    });
    await approveWholeBook('ord_audit_test');
    const after = await getOrder('ord_audit_test');
    const evt = after!.auditEvents!.find((e) => e.type === 'whole_book_approval_rejected');
    assert.ok(evt);
    assert.equal(evt!.reason, 'pages_not_accepted');
    // Padded to the 24-page contract: only page 1 is unaccepted → 23 accepted.
    assert.equal((evt!.meta as Record<string, unknown>).acceptedCount, 23);
    assert.equal((evt!.meta as Record<string, unknown>).totalPages, 24);
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


// ── Chronological accumulation ──────────────────────────────────────────────

test('audit trail accumulates events in append order', async () => {
  // Direct helper-driven append ordering check (kept for clarity).
  const dir = makeTmp();
  try {
    await seed({ auditEvents: [] });
    await appendAuditEvent('ord_audit_test', { type: 'proof_generated' });
    await appendAuditEvent('ord_audit_test', { type: 'page_regenerated', pageIndex: 0 });
    await appendAuditEvent('ord_audit_test', { type: 'proof_published' });
    await appendAuditEvent('ord_audit_test', { type: 'page_accepted', pageIndex: 0 });
    await appendAuditEvent('ord_audit_test', { type: 'proof_review_acknowledged' });
    await appendAuditEvent('ord_audit_test', { type: 'whole_book_approved' });
    const after = await getOrder('ord_audit_test');
    assert.deepEqual(eventTypes(after?.auditEvents), [
      'proof_generated',
      'page_regenerated',
      'proof_published',
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
      pageArtifacts: padPageSet([pageFixture(0), pageFixture(1)]),
      proofReviewedAt: null,
    });
    // A regeneration invalidates the published proof, so the sequence must
    // publish a NEW revision and acknowledge THAT one before approving.
    await regeneratePage(
      { orderId: 'ord_audit_test', pageIndex: 0, feedback: 'fix' },
      {
        providers: [successProvider],
        buildProof: async (oid: string) => {
          const sourceOrder = (await getOrder(oid))!;
          const printTitle = sourceOrder.printTitle ?? `${sourceOrder.childName}'s Hero Story Book`;
          return {
            ok: true as const,
            proofUrl: 'https://example.com/re-proof.pdf',
            sourceFingerprint: proofSourceFingerprint(sourceOrder),
            proofVersion: 'pv_second',
            printInteriorArtifactUrl: 'https://example.com/re-interior.pdf',
            printInteriorMd5: 're-interior-md5',
            printInteriorPageCount: 32,
            printInteriorProofVersion: 'pv_second',
            printTitle,
          };
        },
      },
    );
    await acceptPage({ orderId: 'ord_audit_test', pageIndex: 0 });
    await acceptPage({ orderId: 'ord_audit_test', pageIndex: 1 });
    const live = await getOrder('ord_audit_test');
    await acknowledgeProofReview('ord_audit_test', { proofVersion: live!.proofVersion! });
    const r = await approveWholeBook('ord_audit_test');
    assert.equal(r.ok, true, r.error);
    const after = await getOrder('ord_audit_test');
    assert.deepEqual(eventTypes(after?.auditEvents), [
      'page_regenerated',
      'proof_invalidated',
      'proof_published',
      'page_accepted',
      'page_accepted',
      'proof_review_acknowledged',
      // NOTE: no publish event here — approval neither rebuilds nor publishes.
      'whole_book_approved',
    ]);
    assert.equal(after?.reviewStatus, 'approved');
  } finally { cleanup(dir); }
});

test('approveWholeBook writes whole_book_approved ONLY — it publishes no proof', async () => {
  const dir = makeTmp();
  try {
    await seed({ proofReviewedAt: '2026-04-27T09:00:00Z' });
    const r = await approveWholeBook('ord_audit_test');
    assert.equal(r.ok, true, r.error);
    const after = await getOrder('ord_audit_test');
    const types = (after?.auditEvents ?? []).map((e) => e.type);
    assert.ok(types.includes('whole_book_approved'));
    // Customer approval and print release are separate gates: approval neither
    // rebuilds nor publishes a proof, so no publish event may appear.
    assert.equal(types.includes('proof_published'), false);
  } finally { cleanup(dir); }
});
