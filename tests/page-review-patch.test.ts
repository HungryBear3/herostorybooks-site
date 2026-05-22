/**
 * Focused tests for applyPageReviewPatch — the pure helper behind the
 * admin page-review grid. Persistence is handled by the API route; we
 * only pin the patch math here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPageReviewPatch,
  createOrderRecord,
  PAGE_REVIEW_NOTES_MAX_LENGTH,
  type OrderRecord,
  type PageArtifact,
} from '../src/lib/orders.ts';

const NOW = '2026-05-22T12:00:00.000Z';
const EARLIER = '2026-05-01T00:00:00.000Z';

function makePage(overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: 0,
    storyText: 'Luna found one star.',
    basePrompt: 'p',
    currentImageUrl: null,
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

function makeOrder(pages: PageArtifact[]): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'classic', email: 'a@b.com' },
    { id: 'ord_review_test', now: EARLIER },
  );
  return { ...base, pageArtifacts: pages };
}

test('applyPageReviewPatch: sets targetedRegenNeeded and bumps reviewedAt + updatedAt', () => {
  const order = makeOrder([makePage({ pageIndex: 0 })]);
  const result = applyPageReviewPatch(order, 0, { targetedRegenNeeded: true }, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.targetedRegenNeeded, true);
  assert.equal(result.page.reviewedAt, NOW);
  assert.equal(result.order.updatedAt, NOW);
  // Immutable: original order unchanged.
  assert.equal(order.pageArtifacts?.[0].targetedRegenNeeded, undefined);
  assert.equal(order.updatedAt, EARLIER);
});

test('applyPageReviewPatch: whitespace-only notes against an empty page is a no-op', () => {
  const order = makeOrder([makePage({ pageIndex: 0 })]);
  const result = applyPageReviewPatch(order, 0, { reviewerNotes: '   ' }, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // No prior note + whitespace-only patch → nothing changes, same reference back.
  assert.equal(result.order, order);
  assert.equal(result.page.reviewerNotes ?? null, null);
});

test('applyPageReviewPatch: trims surrounding whitespace before storing notes', () => {
  const order = makeOrder([makePage({ pageIndex: 0 })]);
  const result = applyPageReviewPatch(order, 0, { reviewerNotes: '  Lukas too old  ' }, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.reviewerNotes, 'Lukas too old');
});

test('applyPageReviewPatch: caps notes at PAGE_REVIEW_NOTES_MAX_LENGTH', () => {
  const order = makeOrder([makePage({ pageIndex: 0 })]);
  const long = 'x'.repeat(PAGE_REVIEW_NOTES_MAX_LENGTH + 100);
  const result = applyPageReviewPatch(order, 0, { reviewerNotes: long }, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.reviewerNotes?.length, PAGE_REVIEW_NOTES_MAX_LENGTH);
});

test('applyPageReviewPatch: no-op patch returns the same order reference + does not bump updatedAt', () => {
  const order = makeOrder([
    makePage({ pageIndex: 0, targetedRegenNeeded: true, reviewerNotes: 'Lukas looks older' }),
  ]);
  const result = applyPageReviewPatch(
    order,
    0,
    { targetedRegenNeeded: true, reviewerNotes: 'Lukas looks older' },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.order, order, 'no-op should return the SAME order reference');
  assert.equal(result.order.updatedAt, EARLIER);
});

test('applyPageReviewPatch: backward compatible with legacy PageArtifact missing review fields', () => {
  // Simulate an old persisted page that has no review fields at all.
  const legacyPage = makePage({ pageIndex: 7 });
  delete (legacyPage as { targetedRegenNeeded?: unknown }).targetedRegenNeeded;
  delete (legacyPage as { reviewerNotes?: unknown }).reviewerNotes;
  delete (legacyPage as { reviewedAt?: unknown }).reviewedAt;
  const order = makeOrder([legacyPage]);

  const result = applyPageReviewPatch(
    order,
    7,
    { targetedRegenNeeded: true, reviewerNotes: 'Re-render T-rex closer to ground plane' },
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.targetedRegenNeeded, true);
  assert.equal(result.page.reviewerNotes, 'Re-render T-rex closer to ground plane');
  assert.equal(result.page.reviewedAt, NOW);
});

test('applyPageReviewPatch: rejects out-of-range pageIndex with 404', () => {
  const order = makeOrder([makePage({ pageIndex: 0 })]);
  const result = applyPageReviewPatch(order, 99, { targetedRegenNeeded: true }, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test('applyPageReviewPatch: rejects negative or non-integer pageIndex with 400', () => {
  const order = makeOrder([makePage({ pageIndex: 0 })]);
  for (const bad of [-1, 1.5, Number.NaN]) {
    const result = applyPageReviewPatch(order, bad, { targetedRegenNeeded: true }, NOW);
    assert.equal(result.ok, false, `expected failure for pageIndex=${bad}`);
    if (result.ok) continue;
    assert.equal(result.status, 400);
  }
});

test('applyPageReviewPatch: clearing notes (null) removes the prior note and bumps reviewedAt', () => {
  const order = makeOrder([
    makePage({ pageIndex: 0, reviewerNotes: 'previous note', reviewedAt: EARLIER }),
  ]);
  const result = applyPageReviewPatch(order, 0, { reviewerNotes: null }, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.page.reviewerNotes, null);
  assert.equal(result.page.reviewedAt, NOW);
});
