/**
 * End-to-end contract for the customer-editable review surface:
 * token-authorized text-change requests, the approve-gate block on unresolved
 * requests, and the admin/system review-link preparation. No real orders,
 * tokens, or PII are used; storage is a throwaway temp dir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, getOrder, persistOrder } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import {
  saveTextChangeRequest,
  prepareCustomerReviewLink,
  approveWholeBook,
  evaluateApproveGate,
  getReviewSnapshot,
  hasReviewAccess,
  hasReviewWriteAccess,
  hasUnresolvedChangeRequests,
  reviewPathFor,
} from '../src/lib/page-review.ts';

const NOW = '2026-07-31T12:00:00.000Z';
const TOKEN = 'b'.repeat(48); // shape-valid stand-in token (never a real token)

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-editable-review-'));
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
    storyText: `Canonical caption for page ${i + 1}.`,
    basePrompt: 'frozen-base-prompt',
    characterAnchor: 'frozen-anchor',
    currentImageUrl: `https://example.com/p${i}.png`,
    acceptedImageUrl: `https://example.com/p${i}-accepted.png`,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

async function seedOrder(overrides: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Benny', bookFormat: 'digital', email: 'a@b.com' },
      { id: `ord_${Math.abs(hashCode(JSON.stringify(overrides))).toString(16)}`, now: NOW }),
    paymentStatus: 'paid',
    reviewStatus: 'in_review',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofReviewedAt: null,
    pageArtifacts: [pageFixture(0), pageFixture(1)],
    ...overrides,
  };
  await persistOrder(order);
  return order;
}

// tiny stable id helper (no Math.random, deterministic per test)
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

// ── Text-change request: authorization ───────────────────────────────────────

test('valid token can submit a bounded page-specific request', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_valid_tok', proofApprovalToken: TOKEN });
    const res = await saveTextChangeRequest(
      { orderId: 'ord_valid_tok', pageIndex: 1, note: '  Please say "dinosaur track".  ', reviewToken: TOKEN },
      { now: () => new Date(NOW) },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.page?.pageIndex, 1);
    assert.equal(res.page?.customerReviewStatus, 'changes_requested');
    assert.equal(res.page?.customerRequestedChange?.note, 'Please say "dinosaur track".');
    // persisted
    const reloaded = await getOrder('ord_valid_tok');
    assert.equal(reloaded?.pageArtifacts?.[1].customerReviewStatus, 'changes_requested');
  } finally {
    cleanup(dir);
  }
});

test('missing, invalid, or mismatched token cannot write', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_tok_gate', proofApprovalToken: TOKEN });
    for (const bad of [null, undefined, '', 'short', 'c'.repeat(48)]) {
      const res = await saveTextChangeRequest(
        { orderId: 'ord_tok_gate', pageIndex: 0, note: 'change', reviewToken: bad as string | null | undefined },
      );
      assert.equal(res.ok, false, `token=${JSON.stringify(bad)} must be rejected`);
      assert.equal(res.status, 403);
      assert.equal(res.error, 'invalid_or_missing_token');
    }
    // A bare order id with no token on the order at all also cannot write.
    await seedOrder({ id: 'ord_no_tok', proofApprovalToken: null });
    const res = await saveTextChangeRequest({ orderId: 'ord_no_tok', pageIndex: 0, note: 'x', reviewToken: TOKEN });
    assert.equal(res.status, 403);
    assert.equal(hasReviewWriteAccess({ proofApprovalToken: null } as OrderRecord, { reviewToken: TOKEN }), false);
  } finally {
    cleanup(dir);
  }
});

test('prepared review reads require the matching token for digital and print orders', async () => {
  const dir = makeTmp();
  try {
    for (const bookFormat of ['digital', 'classic'] as const) {
      const id = `ord_read_${bookFormat}`;
      const order = await seedOrder({ id, bookFormat, proofApprovalToken: TOKEN });
      assert.equal(hasReviewAccess(order), false);
      assert.equal(hasReviewAccess(order, { reviewToken: 'c'.repeat(48) }), false);
      assert.equal(hasReviewAccess(order, { reviewToken: TOKEN }), true);
      assert.equal(await getReviewSnapshot(id), null, `${bookFormat}: bare id must not read`);
      assert.equal(await getReviewSnapshot(id, { reviewToken: 'c'.repeat(48) }), null);
      assert.equal((await getReviewSnapshot(id, { reviewToken: TOKEN }))?.orderId, id);
    }

    const legacy = await seedOrder({ id: 'ord_read_unprepared', proofApprovalToken: null });
    assert.equal(hasReviewAccess(legacy), true, 'unprepared legacy/operator read stays available');
  } finally {
    cleanup(dir);
  }
});

// ── Text-change request: safety invariants ───────────────────────────────────

test('save preserves canonical text, token, payment, acceptance, proof-ack, and does not approve', async () => {
  const dir = makeTmp();
  try {
    const seeded = await seedOrder({ id: 'ord_preserve', proofApprovalToken: TOKEN, proofReviewedAt: NOW });
    const before = await getOrder('ord_preserve');
    const res = await saveTextChangeRequest(
      { orderId: 'ord_preserve', pageIndex: 0, note: 'reword please', reviewToken: TOKEN },
      { now: () => new Date(NOW) },
    );
    assert.equal(res.ok, true);
    const after = await getOrder('ord_preserve');
    // canonical + safety fields unchanged
    assert.equal(after?.pageArtifacts?.[0].storyText, before?.pageArtifacts?.[0].storyText);
    assert.equal(after?.pageArtifacts?.[0].basePrompt, before?.pageArtifacts?.[0].basePrompt);
    assert.equal(after?.pageArtifacts?.[0].characterAnchor, before?.pageArtifacts?.[0].characterAnchor);
    assert.equal(after?.pageArtifacts?.[0].accepted, true);
    assert.equal(after?.pageArtifacts?.[0].acceptedImageUrl, before?.pageArtifacts?.[0].acceptedImageUrl);
    assert.equal(after?.proofApprovalToken, TOKEN);
    assert.equal(after?.paymentStatus, 'paid');
    assert.equal(after?.proofReviewedAt, NOW);
    assert.notEqual(after?.reviewStatus, 'approved');
    // no approval/fulfillment advance
    assert.equal(after?.proofApprovedAt, seeded.proofApprovedAt);
    assert.equal(after?.fulfillmentStatus, seeded.fulfillmentStatus);
    assert.equal(after?.storyArtifactUrl, before?.storyArtifactUrl);
  } finally {
    cleanup(dir);
  }
});

test('empty/oversized/malformed notes and invalid page identifiers fail safely', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_validate', proofApprovalToken: TOKEN });
    const empty = await saveTextChangeRequest({ orderId: 'ord_validate', pageIndex: 0, note: '   ', reviewToken: TOKEN });
    assert.equal(empty.status, 400);
    assert.equal(empty.error, 'empty_or_invalid_note');

    const notString = await saveTextChangeRequest(
      { orderId: 'ord_validate', pageIndex: 0, note: 123 as unknown as string, reviewToken: TOKEN });
    assert.equal(notString.status, 400);

    const badPage = await saveTextChangeRequest({ orderId: 'ord_validate', pageIndex: 99, note: 'x', reviewToken: TOKEN });
    assert.equal(badPage.status, 400);
    assert.equal(badPage.error, 'invalid_page');

    const negPage = await saveTextChangeRequest({ orderId: 'ord_validate', pageIndex: -1, note: 'x', reviewToken: TOKEN });
    assert.equal(negPage.status, 400);

    // Oversized note is accepted but capped by the pure contract (<= 1000 chars).
    const big = await saveTextChangeRequest(
      { orderId: 'ord_validate', pageIndex: 0, note: 'a'.repeat(5000), reviewToken: TOKEN },
      { now: () => new Date(NOW) });
    assert.equal(big.ok, true);
    assert.equal(big.page?.customerRequestedChange?.note.length, 1000);
  } finally {
    cleanup(dir);
  }
});

test('unpaid order cannot submit a text-change request', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_unpaid_write', proofApprovalToken: TOKEN, paymentStatus: 'pending' });
    const res = await saveTextChangeRequest({ orderId: 'ord_unpaid_write', pageIndex: 0, note: 'x', reviewToken: TOKEN });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'order_not_eligible');
  } finally {
    cleanup(dir);
  }
});

// ── Approve-gate block ───────────────────────────────────────────────────────

test('unresolved text requests block whole-book approval (server-side + pure gate)', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_block', proofApprovalToken: TOKEN, proofReviewedAt: NOW });
    await saveTextChangeRequest(
      { orderId: 'ord_block', pageIndex: 0, note: 'reword', reviewToken: TOKEN }, { now: () => new Date(NOW) });

    const reloaded = await getOrder('ord_block');
    assert.equal(hasUnresolvedChangeRequests(reloaded!.pageArtifacts!), true);
    assert.equal(
      evaluateApproveGate({
        pageArtifacts: reloaded!.pageArtifacts!,
        reviewStatus: reloaded!.reviewStatus!,
        storyArtifactUrl: reloaded!.storyArtifactUrl ?? null,
        proofAcknowledged: true,
      }),
      'unresolved_change_requests',
    );

    let rebuildCalled = false;
    const res = await approveWholeBook('ord_block', {
      rebuildProof: async () => { rebuildCalled = true; return { ok: true, proofUrl: 'x' }; },
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.match(res.error ?? '', /pending text-change/i);
    assert.equal(rebuildCalled, false, 'must fail closed before any proof rebuild');
    const still = await getOrder('ord_block');
    assert.notEqual(still?.reviewStatus, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('existing print approval gate behavior is unchanged when no change requests exist', () => {
  const base = {
    pageArtifacts: [pageFixture(0), pageFixture(1)],
    reviewStatus: 'in_review' as NonNullable<OrderRecord['reviewStatus']>,
    storyArtifactUrl: 'https://example.com/proof.pdf',
    proofAcknowledged: true,
  };
  assert.equal(evaluateApproveGate(base), null);
  assert.equal(evaluateApproveGate({ ...base, proofAcknowledged: false }), 'proof_ack_missing');
  assert.equal(evaluateApproveGate({ ...base, storyArtifactUrl: null }), 'proof_not_ready');
  assert.equal(evaluateApproveGate({
    ...base, pageArtifacts: [pageFixture(0, { accepted: false })],
  }), 'pages_not_accepted');
  assert.equal(evaluateApproveGate({ ...base, reviewStatus: 'approved' }), 'already_approved');
});

// ── Review-link preparation ──────────────────────────────────────────────────

test('eligible paid order link preparation is idempotent and mints a secure token', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_prep', proofApprovalToken: null });
    const first = await prepareCustomerReviewLink('ord_prep');
    assert.equal(first.ok, true);
    assert.match(first.token ?? '', /^[0-9a-f]{48}$/);
    assert.equal(first.alreadyPrepared, false);
    assert.equal(first.reviewPath, reviewPathFor('ord_prep', first.token!));

    // Idempotent: preserves the same token, never rotates.
    const second = await prepareCustomerReviewLink('ord_prep');
    assert.equal(second.ok, true);
    assert.equal(second.token, first.token);
    assert.equal(second.alreadyPrepared, true);

    const persisted = await getOrder('ord_prep');
    assert.equal(persisted?.proofApprovalToken, first.token);
    // No email/proof side effects: only a single review_link_prepared audit event.
    const prepEvents = (persisted?.auditEvents ?? []).filter((e) => e.type === 'review_link_prepared');
    assert.equal(prepEvents.length, 1);
    assert.equal(persisted?.fulfillmentStatus, undefined);
  } finally {
    cleanup(dir);
  }
});

test('unpaid, missing-artifact, or not-ready orders cannot get a prepared link', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_prep_unpaid', paymentStatus: 'pending', proofApprovalToken: null });
    assert.equal((await prepareCustomerReviewLink('ord_prep_unpaid')).error, 'order_not_paid');

    await seedOrder({ id: 'ord_prep_noart', storyArtifactUrl: null, proofApprovalToken: null });
    assert.equal((await prepareCustomerReviewLink('ord_prep_noart')).error, 'review_artifact_missing');

    await seedOrder({ id: 'ord_prep_nopages', pageArtifacts: [], proofApprovalToken: null });
    assert.equal((await prepareCustomerReviewLink('ord_prep_nopages')).error, 'review_not_ready');

    assert.equal((await prepareCustomerReviewLink('ord_missing')).error, 'order_not_found');
  } finally {
    cleanup(dir);
  }
});

// ── Concurrency + privacy ────────────────────────────────────────────────────

test('parallel saves to different pages serialize and do not lose either request', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_concurrent', proofApprovalToken: TOKEN });
    const results = await Promise.all([
      saveTextChangeRequest({ orderId: 'ord_concurrent', pageIndex: 0, note: 'change page 1', reviewToken: TOKEN },
        { now: () => new Date(NOW) }),
      saveTextChangeRequest({ orderId: 'ord_concurrent', pageIndex: 1, note: 'change page 2', reviewToken: TOKEN },
        { now: () => new Date('2026-07-31T12:05:00.000Z') }),
    ]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    const reloaded = await getOrder('ord_concurrent');
    // Both pages retain their independent requests — no lost update.
    assert.equal(reloaded?.pageArtifacts?.[0].customerRequestedChange?.note, 'change page 1');
    assert.equal(reloaded?.pageArtifacts?.[1].customerRequestedChange?.note, 'change page 2');
  } finally {
    cleanup(dir);
  }
});

test('parallel saves to the same page serialize without dropping either audit event', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_same_page', proofApprovalToken: TOKEN });
    const results = await Promise.all([
      saveTextChangeRequest({ orderId: 'ord_same_page', pageIndex: 0, note: 'first wording request', reviewToken: TOKEN },
        { now: () => new Date(NOW) }),
      saveTextChangeRequest({ orderId: 'ord_same_page', pageIndex: 0, note: 'second wording request', reviewToken: TOKEN },
        { now: () => new Date('2026-07-31T12:05:00.000Z') }),
    ]);
    assert.deepEqual(results.map((result) => result.status), [200, 200]);
    const reloaded = await getOrder('ord_same_page');
    assert.ok(
      ['first wording request', 'second wording request'].includes(
        reloaded?.pageArtifacts?.[0].customerRequestedChange?.note ?? '',
      ),
      'the serialized last writer wins without corrupting the page request',
    );
    assert.equal(
      (reloaded?.auditEvents ?? []).filter((event) => event.type === 'customer_text_change_requested').length,
      2,
    );
  } finally {
    cleanup(dir);
  }
});

test('parallel link preparation returns one stable persisted token', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_parallel_prep', proofApprovalToken: null });
    const [first, second] = await Promise.all([
      prepareCustomerReviewLink('ord_parallel_prep', { tokenFactory: () => 'a'.repeat(48) }),
      prepareCustomerReviewLink('ord_parallel_prep', { tokenFactory: () => 'b'.repeat(48) }),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.token, second.token);
    assert.equal((await getOrder('ord_parallel_prep'))?.proofApprovalToken, first.token);
    const events = (await getOrder('ord_parallel_prep'))?.auditEvents ?? [];
    assert.equal(events.filter((event) => event.type === 'review_link_prepared').length, 1);
  } finally {
    cleanup(dir);
  }
});

test('no token value, note text, or PII is written into audit metadata', async () => {
  const dir = makeTmp();
  try {
    await seedOrder({ id: 'ord_privacy', proofApprovalToken: null });
    await prepareCustomerReviewLink('ord_privacy');
    const withTok = await getOrder('ord_privacy');
    const token = withTok!.proofApprovalToken!;
    const secretNote = 'SENSITIVE change wording please';
    await saveTextChangeRequest({ orderId: 'ord_privacy', pageIndex: 0, note: secretNote, reviewToken: token },
      { now: () => new Date(NOW) });

    const persisted = await getOrder('ord_privacy');
    const auditJson = JSON.stringify(persisted?.auditEvents ?? []);
    // Token never appears in the audit trail.
    assert.equal(auditJson.includes(token), false, 'token must not be in audit metadata');
    // Note text never appears in the audit trail (only a length count).
    assert.equal(auditJson.includes(secretNote), false, 'note text must not be in audit metadata');
    const changeEvent = (persisted?.auditEvents ?? []).find((e) => e.type === 'customer_text_change_requested');
    assert.deepEqual(Object.keys(changeEvent?.meta ?? {}), ['noteChars']);
    assert.equal((changeEvent?.meta as { noteChars: number }).noteChars, secretNote.length);
    const prepEvent = (persisted?.auditEvents ?? []).find((e) => e.type === 'review_link_prepared');
    assert.equal(JSON.stringify(prepEvent?.meta ?? {}).includes(token), false);

    // Sanity: the on-disk order file also never leaks the token into audit events.
    const raw = readFileSync(path.join(dir, 'ord_privacy.json'), 'utf8');
    const parsed = JSON.parse(raw) as OrderRecord;
    assert.equal(JSON.stringify(parsed.auditEvents).includes(token), false);
  } finally {
    cleanup(dir);
  }
});
