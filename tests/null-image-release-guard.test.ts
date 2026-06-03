/**
 * Regression lock for the null/blank-image RELEASE guard.
 *
 * The codebase already refuses to release or print a book where any page has
 * a null currentImageUrl — via validateManifest() (`!p.hasImage` →
 * MANIFEST_INCOMPLETE), enforced by evaluateReleaseGuard() (customer proof/
 * digital release) and evaluatePrintGuard() (Lulu submission), and by
 * applyAcceptPage()/approveWholeBook() on the customer-approval path.
 *
 * That protection was NOT pinned by a test that specifically exercises a
 * null page image (the existing manifest test only covers a missing source
 * photo). These tests lock the behavior so a future refactor of the manifest
 * validator cannot silently let a blank-page book reach a paying customer or
 * a print job. Pure, store-free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import {
  evaluatePrintGuard,
  evaluateReleaseGuard,
  validateManifest,
  buildManifest,
} from '../src/lib/generation-manifest.ts';
import { applyAcceptPage } from '../src/lib/page-review.ts';

function makePage(overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: 0,
    storyText: 'Once upon a time…',
    basePrompt: 'p1',
    currentImageUrl: 'https://example.com/p1.png',
    generationProvider: 'manual',
    generationModel: 'abby:manual-subscription',
    generationConditioning: 'photo_edit',
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

/** A fully releasable paid order (control), then we knock out one image. */
function releasableOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord_nullimg_test',
    childName: 'Luna',
    theme: 'dinosaur-discovery',
    bookFormat: 'classic',
    formatLabel: 'Classic softcover',
    priceCents: 4499,
    status: 'preview_ready',
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_approved',
    storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
    printInteriorArtifactUrl: 'https://cdn.example.com/interior.pdf',
    printInteriorMd5: 'abc',
    printInteriorPageCount: 24,
    printTitle: "Luna's Tale",
    photoBlobUrl: 'https://example.com/luna.jpg',
    photoBlobPath: 'orders/test/photo.jpg',
    photoFileName: 'luna.jpg',
    shippingAddress: { line1: '1 Main St', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' },
    storyMeta: {
      source: 'manual',
      model: 'abby:manual-subscription',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: null,
    },
    pageArtifacts: [makePage({ pageIndex: 0 }), makePage({ pageIndex: 1, currentImageUrl: 'https://example.com/p2.png' })],
    qaPassAt: '2026-05-31T20:30:00.000Z',
    qaPassBy: 'ops',
    qaStatus: 'passed',
    qaReviewer: 'ops',
    proofApprovedAt: '2026-05-31T21:00:00.000Z',
    ownerPrintGoAt: '2026-05-31T21:05:00.000Z',
    email: 'luna@example.com',
    deliveryExpectation: 'proof ready',
    createdAt: '2026-05-31T19:00:00.000Z',
    updatedAt: '2026-05-31T21:05:00.000Z',
    ...overrides,
  } as OrderRecord;
}

// ── Control: a complete order IS releasable + printable ───────────────────────

test('control: fully-imaged paid order passes release + print guards', () => {
  const order = releasableOrder();
  assert.equal(evaluateReleaseGuard(order).ok, true);
  assert.equal(evaluatePrintGuard(order).ok, true);
});

// ── A null page image must block the manifest + both guards ────────────────────

test('validateManifest: a null currentImageUrl page → incomplete with a named issue', () => {
  const order = releasableOrder({
    pageArtifacts: [makePage({ pageIndex: 0 }), makePage({ pageIndex: 1, currentImageUrl: null })],
  });
  const manifest = buildManifest(order);
  const v = validateManifest(manifest);
  assert.equal(v.complete, false);
  assert.ok(
    v.issues.some((i) => /missing currentImageUrl/.test(i)),
    `expected a "missing currentImageUrl" issue, got: ${v.issues.join(' | ')}`,
  );
});

test('evaluateReleaseGuard: a null page image blocks customer release (MANIFEST_INCOMPLETE)', () => {
  const order = releasableOrder({
    pageArtifacts: [makePage({ pageIndex: 0 }), makePage({ pageIndex: 1, currentImageUrl: null })],
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'MANIFEST_INCOMPLETE');
});

test('evaluatePrintGuard: a null page image blocks Lulu submission', () => {
  const order = releasableOrder({
    pageArtifacts: [makePage({ pageIndex: 0 }), makePage({ pageIndex: 1, currentImageUrl: null })],
  });
  const r = evaluatePrintGuard(order);
  assert.equal(r.ok, false);
  // print guard re-runs the release guard; MANIFEST_INCOMPLETE maps to
  // PRINT_MANIFEST_INVALID and surfaces the underlying release code.
  assert.equal(r.failureCode, 'PRINT_MANIFEST_INVALID');
  assert.equal(r.underlyingReleaseFailure, 'MANIFEST_INCOMPLETE');
});

// ── Customer approval path cannot accept a null-image page ─────────────────────

test('applyAcceptPage: refuses to accept a page that has no image', () => {
  const artifacts = [makePage({ pageIndex: 0, currentImageUrl: null })];
  const result = applyAcceptPage(artifacts, 0);
  assert.equal(result.error, 'page_has_no_image_to_accept');
  assert.equal(result.page, undefined);
  assert.equal(result.artifacts[0]!.accepted, false);
});
