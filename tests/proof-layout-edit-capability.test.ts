/**
 * B1 — the editor must be gated by a SERVER-DERIVED, fail-closed layout-edit
 * capability in the ReviewSnapshot, not a duplicated partial client status list.
 * These are behavioral tests of the pure derivation + the client gate default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord } from '../src/lib/orders.ts';
import type { OrderRecord, PageArtifact } from '../src/lib/orders.ts';
import { proofSourceFingerprint } from '../src/lib/fulfillment.ts';
import { evaluateProofLayoutEditCapability, reviewSnapshotFromOrder } from '../src/lib/page-review.ts';
import { canOfferCustomerLayoutEditing } from '../src/lib/proof-layout-editor-core.ts';

const NOW = '2026-08-06T00:00:00.000Z';

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i, storyText: `Short page ${i + 1}.`, basePrompt: 'p',
    currentImageUrl: `https://example.invalid/p${i}.png`, acceptedImageUrl: `https://example.invalid/p${i}.png`,
    generationProvider: null, generationModel: null, regenerateCount: 0,
    accepted: true, feedbackHistory: [], versionHistory: [], ...o,
  };
}

function seed(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Kid', bookFormat: 'digital', email: 'r@example.invalid' }, { id: 'ord_cap', now: NOW }),
    paymentStatus: 'paid', reviewStatus: 'in_review', fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.invalid/proof.pdf', proofVersion: 'pv_1',
    proofReviewedAt: null, proofReviewedVersion: null,
    pageArtifacts: [page(0), page(1)], auditEvents: [], ...overrides,
  };
  order.proofSourceFingerprint = proofSourceFingerprint(order);
  return order;
}

test('proof-ready editable order → allowed, reason available', () => {
  const cap = evaluateProofLayoutEditCapability(seed());
  assert.deepEqual(cap, { allowed: true, reason: 'available' });
});

test('approved review → not allowed, reason review_approved', () => {
  const cap = evaluateProofLayoutEditCapability(seed({ reviewStatus: 'approved' }));
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'review_approved');
});

test('fulfillment complete → not allowed, reason lifecycle_closed', () => {
  const cap = evaluateProofLayoutEditCapability(seed({ fulfillmentStatus: 'complete' }));
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'lifecycle_closed');
});

test('print submitted → not allowed, lifecycle_closed', () => {
  const cap = evaluateProofLayoutEditCapability(seed({ printSubmittedAt: NOW }));
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'lifecycle_closed');
});

test('print in production → not allowed, lifecycle_closed', () => {
  const cap = evaluateProofLayoutEditCapability(seed({ status: 'print_in_production' }));
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'lifecycle_closed');
});

test('shipped → not allowed, lifecycle_closed', () => {
  const cap = evaluateProofLayoutEditCapability(seed({ status: 'shipped', shippedAt: NOW }));
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'lifecycle_closed');
});

test('refunded → not allowed, lifecycle_closed', () => {
  const cap = evaluateProofLayoutEditCapability(seed({ refundedAt: NOW }));
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'lifecycle_closed');
});

test('stale proof (fingerprint no longer matches pages) → proof_not_ready', () => {
  const order = seed();
  // Change page text WITHOUT recomputing the stored fingerprint → stale proof.
  order.pageArtifacts![0].storyText = 'A different, longer story sentence that changes the source hash.';
  const cap = evaluateProofLayoutEditCapability(order);
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'proof_not_ready');
});

test('missing proof binding → proof_not_ready', () => {
  const cap = evaluateProofLayoutEditCapability(seed({ proofVersion: null }));
  assert.equal(cap.allowed, false);
  assert.equal(cap.reason, 'proof_not_ready');
});

test('reviewSnapshotFromOrder carries the capability', () => {
  const snap = reviewSnapshotFromOrder(seed());
  assert.deepEqual(snap.proofLayoutEditing, { allowed: true, reason: 'available' });
});

test('client gate defaults to false on missing/malformed capability', () => {
  // Editable capability offered.
  assert.equal(canOfferCustomerLayoutEditing({ proofLayoutEditing: { allowed: true, reason: 'available' } } as never), true);
  // Explicitly not allowed.
  assert.equal(canOfferCustomerLayoutEditing({ proofLayoutEditing: { allowed: false, reason: 'lifecycle_closed' } } as never), false);
  // Missing field → fail closed.
  assert.equal(canOfferCustomerLayoutEditing({} as never), false);
  // Malformed (allowed not boolean) → fail closed.
  assert.equal(canOfferCustomerLayoutEditing({ proofLayoutEditing: { allowed: 'yes' } } as never), false);
  // Null → fail closed.
  assert.equal(canOfferCustomerLayoutEditing(null as never), false);
});
