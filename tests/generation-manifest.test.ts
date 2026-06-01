/**
 * Tests for the Generation Operating Policy manifest + release/print guards.
 *
 * Covers Section 10 required tests:
 *  4. Paid order with template story fallback → release rejected
 *  5. Proof with one page imageProvider=null → release rejected MISSING_LINEAGE
 *  6. Proof with one page assetSource=fixture → release rejected
 *  7. Proof with complete manifest but qaStatus !== passed → rejected QA_NOT_PASSED
 *  8. Proof with qaStatus=passed but missing qaReviewer → rejected
 *  9. Print submission without customer approval timestamp → rejected
 * 10. Print submission with customer approval but invalid manifest/lineage → rejected
 *
 * The release-guard tests work against the synthesized guardOrder shape;
 * the corresponding tests in admin-shipping-proof.test.ts exercise the
 * full releaseOrderAfterQa boundary including persistence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import {
  buildManifest,
  evaluatePrintGuard,
  evaluateReleaseGuard,
  validateManifest,
} from '../src/lib/generation-manifest.ts';

function baseOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: 'ord_manifest_test',
    childName: 'Luna',
    theme: 'dinosaur-discovery',
    bookFormat: 'classic',
    formatLabel: 'Classic softcover',
    priceCents: 4499,
    status: 'preview_ready',
    paymentStatus: 'paid',
    fulfillmentStatus: 'awaiting_qa',
    storyArtifactUrl: 'https://cdn.example.com/proof.pdf',
    photoBlobUrl: 'https://example.com/luna.jpg',
    photoBlobPath: 'orders/test/photo.jpg',
    photoFileName: 'luna.jpg',
    shippingAddress: {
      line1: '1 Main St',
      city: 'Chicago',
      state: 'IL',
      zip: '60601',
      country: 'US',
    },
    storyMeta: {
      source: 'openai_chat',
      model: 'gpt-4o-mini',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: null,
    },
    pageArtifacts: [makePage()],
    qaPassAt: '2026-05-31T20:30:00.000Z',
    qaPassBy: 'ops',
    qaStatus: 'passed',
    qaReviewer: 'ops',
    email: 'luna@example.com',
    deliveryExpectation: 'proof ready',
    createdAt: '2026-05-31T19:00:00.000Z',
    updatedAt: '2026-05-31T20:30:00.000Z',
    ...overrides,
  } as OrderRecord;
}

function makePage(overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: 0,
    storyText: 'Once upon a time…',
    basePrompt: 'p1',
    currentImageUrl: 'https://example.com/p1.png',
    generationProvider: 'openai',
    generationModel: 'gpt-image-1',
    generationConditioning: 'photo_edit',
    regenerateCount: 0,
    accepted: false,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

// ── buildManifest ───────────────────────────────────────────────────────────
test('buildManifest: happy paid order → complete=true, qaStatus passed', () => {
  const m = buildManifest(baseOrder());
  assert.equal(m.paid, true);
  assert.equal(m.qaStatus, 'passed');
  assert.equal(m.qaReviewer, 'ops');
  assert.equal(m.sourcePhotoPresent, true);
  assert.equal(m.personalizationInputsPresent, true);
  assert.equal(m.complete, true);
  assert.equal(m.story.routeAllowed, true);
  assert.equal(m.pages[0]!.routeAllowed, true);
  assert.ok(m.manifestHash, 'manifestHash should be computed');
});

test('buildManifest: refunded order is treated as not paid for policy purposes', () => {
  const m = buildManifest(baseOrder({ paymentStatus: 'refunded', refundedAt: '2026-05-31T21:00Z' }));
  assert.equal(m.paid, false);
});

// ── Required test 5: missing lineage ────────────────────────────────────────
test('release guard: page with imageProvider=null → MISSING_LINEAGE', () => {
  const order = baseOrder({
    pageArtifacts: [makePage({ generationProvider: null })],
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'MISSING_LINEAGE');
});

// ── Required test 6: fixture asset ──────────────────────────────────────────
test('release guard: page with assetSource=fixture → FIXTURE_ASSET_BLOCKED', () => {
  const order = baseOrder({
    pageArtifacts: [makePage({ assetSource: 'fixture' })],
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'FIXTURE_ASSET_BLOCKED');
});

test('release guard: page with assetSource=sample → FIXTURE_ASSET_BLOCKED', () => {
  const order = baseOrder({ pageArtifacts: [makePage({ assetSource: 'sample' })] });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'FIXTURE_ASSET_BLOCKED');
});

test('release guard: page with assetSource=internal → FIXTURE_ASSET_BLOCKED', () => {
  const order = baseOrder({ pageArtifacts: [makePage({ assetSource: 'internal' })] });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'FIXTURE_ASSET_BLOCKED');
});

// ── Required test 7: qaStatus !== passed ────────────────────────────────────
test('release guard: complete manifest but qaStatus=pending → QA_NOT_PASSED', () => {
  const order = baseOrder({
    qaPassAt: null,
    qaStatus: 'pending',
    qaReviewer: null,
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'QA_NOT_PASSED');
});

test('release guard: qaStatus=blocked → QA_NOT_PASSED', () => {
  const order = baseOrder({
    qaPassAt: null,
    qaStatus: 'blocked',
    qaReviewer: 'ops',
    qaBlockedReason: 'family details wrong',
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'QA_NOT_PASSED');
});

// ── Required test 8: qaStatus=passed but missing qaReviewer ─────────────────
test('release guard: qaStatus=passed but qaReviewer empty → QA_NOT_PASSED', () => {
  const order = baseOrder({ qaStatus: 'passed', qaReviewer: '', qaPassBy: '' });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'QA_NOT_PASSED');
});

// ── Required test 4: template story fallback ────────────────────────────────
test('release guard: storyMeta.source=template_after_openai_failure → TEMPLATE_STORY_BLOCKED', () => {
  const order = baseOrder({
    storyMeta: {
      source: 'template_after_openai_failure',
      model: 'template:Quest',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: 'fetch failed',
    },
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'TEMPLATE_STORY_BLOCKED');
});

test('release guard: storyMeta.source=template (no fallback) → TEMPLATE_STORY_BLOCKED', () => {
  const order = baseOrder({
    storyMeta: {
      source: 'template',
      model: 'template:Adventure',
      generatedAt: '2026-05-31T20:00:00.000Z',
      fallbackError: null,
    },
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'TEMPLATE_STORY_BLOCKED');
});

// ── Emergency provider on a page without order-level approval ───────────────
test('release guard: page with generationProvider=fal_edit and no emergency approval → EMERGENCY_APPROVAL_MISSING', () => {
  const order = baseOrder({
    pageArtifacts: [makePage({ generationProvider: 'fal_edit' })],
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'EMERGENCY_APPROVAL_MISSING');
});

test('release guard: page with fal_edit AND order-level emergency approval → permitted', () => {
  const order = baseOrder({
    pageArtifacts: [makePage({ generationProvider: 'fal_edit' })],
    emergencyOverrideUsed: true,
    emergencyApprovedBy: 'alexy',
    emergencyApprovalRef: 'fd-emergency-2026-06-19',
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, true);
});

// ── Personalization / source-photo enforcement ──────────────────────────────
test('release guard: paid order missing source photo → MANIFEST_INCOMPLETE', () => {
  const order = baseOrder({
    photoBlobUrl: null,
    photoBlobPath: null,
    photoFileName: null,
    sourcePhotoPresent: false,
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'MANIFEST_INCOMPLETE');
});

test('release guard: paid order with explicit sourcePhotoPresent=true overrides absence inference', () => {
  const order = baseOrder({
    photoBlobUrl: null,
    photoBlobPath: null,
    photoFileName: null,
    sourcePhotoPresent: true,
  });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, true);
});

// ── Refunded order ──────────────────────────────────────────────────────────
test('release guard: refunded order → PAYMENT_NOT_CONFIRMED', () => {
  const order = baseOrder({ paymentStatus: 'refunded', refundedAt: '2026-05-31T21:00:00.000Z' });
  const r = evaluateReleaseGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'PAYMENT_NOT_CONFIRMED');
});

// ── validateManifest pure ───────────────────────────────────────────────────
test('validateManifest: happy paid order is complete', () => {
  const m = buildManifest(baseOrder());
  const v = validateManifest(m);
  assert.equal(v.complete, true);
  assert.equal(v.issues.length, 0);
});

test('validateManifest: empty pageArtifacts reports specific issue', () => {
  const m = buildManifest(baseOrder({ pageArtifacts: [] }));
  const v = validateManifest(m);
  assert.equal(v.complete, false);
  assert.ok(v.issues.some((i) => i.includes('no page artifacts')));
});

// ── Required test 9: print without customer approval ────────────────────────
test('print guard: missing proofApprovedAt → CUSTOMER_APPROVAL_REQUIRED', () => {
  const order = baseOrder({
    fulfillmentStatus: 'proof_approved',
    proofApprovedAt: null,
    printApprovedAt: null,
  });
  const r = evaluatePrintGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'CUSTOMER_APPROVAL_REQUIRED');
});

// ── Required test 10: print with approval but invalid lineage ──────────────
test('print guard: customer approved but page has fixture asset → PRINT_LINEAGE_INVALID', () => {
  const order = baseOrder({
    fulfillmentStatus: 'proof_approved',
    proofApprovedAt: '2026-05-31T22:00:00.000Z',
    printApprovedAt: '2026-05-31T22:00:00.000Z',
    pageArtifacts: [makePage({ assetSource: 'fixture' })],
  });
  const r = evaluatePrintGuard(order);
  assert.equal(r.ok, false);
  assert.notEqual(r.failureCode, 'CUSTOMER_APPROVAL_REQUIRED');
  assert.equal(r.underlyingReleaseFailure, 'FIXTURE_ASSET_BLOCKED');
});

test('print guard: customer approved but page missing lineage → PRINT_LINEAGE_INVALID', () => {
  const order = baseOrder({
    fulfillmentStatus: 'proof_approved',
    proofApprovedAt: '2026-05-31T22:00:00.000Z',
    printApprovedAt: '2026-05-31T22:00:00.000Z',
    pageArtifacts: [makePage({ generationProvider: null })],
  });
  const r = evaluatePrintGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'PRINT_LINEAGE_INVALID');
  assert.equal(r.underlyingReleaseFailure, 'MISSING_LINEAGE');
});

test('print guard: customer approved but qaStatus=blocked → PRINT_QA_GUARD_FAILED', () => {
  const order = baseOrder({
    fulfillmentStatus: 'proof_approved',
    proofApprovedAt: '2026-05-31T22:00:00.000Z',
    printApprovedAt: '2026-05-31T22:00:00.000Z',
    qaStatus: 'blocked',
    qaReviewer: 'ops',
    qaPassAt: null,
  });
  const r = evaluatePrintGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'PRINT_QA_GUARD_FAILED');
});

test('print guard: happy path → ok', () => {
  const order = baseOrder({
    fulfillmentStatus: 'proof_approved',
    proofApprovedAt: '2026-05-31T22:00:00.000Z',
    printApprovedAt: '2026-05-31T22:00:00.000Z',
  });
  const r = evaluatePrintGuard(order);
  assert.equal(r.ok, true, r.message ?? '');
});

test('print guard: wrong fulfillmentStatus → PRINT_STATE_INVALID', () => {
  const order = baseOrder({
    fulfillmentStatus: 'awaiting_qa',
    proofApprovedAt: '2026-05-31T22:00:00.000Z',
    printApprovedAt: '2026-05-31T22:00:00.000Z',
  });
  const r = evaluatePrintGuard(order);
  assert.equal(r.ok, false);
  assert.equal(r.failureCode, 'PRINT_STATE_INVALID');
});
