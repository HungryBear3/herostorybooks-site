/**
 * Focused boundary tests for the editable-review workflow contract
 * (src/lib/customer-text-change-request.ts).
 *
 * These pin the guarantees the private editable review depends on: a customer's
 * text-change request records review intent ONLY. It never rewrites canonical
 * content, never approves, and never advances order/fulfillment state. No real
 * customer data is used in fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  recordCustomerTextChangeRequest,
  resolveCustomerTextChangeRequest,
  isApprovalAction,
  CANONICAL_PAGE_FIELDS,
  CUSTOMER_CHANGE_NOTE_MAX_LEN,
} from '../src/lib/customer-text-change-request.ts';
import { createOrderRecord, type OrderRecord, type PageArtifact } from '../src/lib/orders.ts';

const NOW = '2026-07-31T12:00:00.000Z';
const LATER = '2026-07-31T13:00:00.000Z';

function makePage(overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: 0,
    storyText: 'The hero found an enormous footprint.',
    basePrompt: 'frozen-base-prompt',
    characterAnchor: 'frozen-character-anchor',
    currentImageUrl: 'blob://current',
    acceptedImageUrl: 'blob://accepted',
    regenerateCount: 2,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

test('records the request as review intent only, without mutating canonical fields', () => {
  const page = makePage();
  const snapshot = JSON.parse(JSON.stringify(page));
  const next = recordCustomerTextChangeRequest(page, {
    note: 'Please change "giant track" to "dinosaur track".',
    at: NOW,
  });

  assert.equal(next.customerReviewStatus, 'changes_requested');
  assert.equal(next.customerRequestedChange?.note, 'Please change "giant track" to "dinosaur track".');
  assert.equal(next.customerRequestedChange?.lifecycleStatus, 'triage');
  assert.equal(next.customerRequestedChange?.requestedAt, NOW);

  // Every canonical field is untouched on the returned artifact.
  for (const field of CANONICAL_PAGE_FIELDS) {
    assert.deepEqual((next as unknown as Record<string, unknown>)[field], (snapshot as unknown as Record<string, unknown>)[field],
      `canonical field ${field} must not change`);
  }
  // Input artifact is not mutated (pure).
  assert.deepEqual(page, snapshot);
});

test('never sets an approval state and is explicitly not an approval action', () => {
  const next = recordCustomerTextChangeRequest(makePage(), { note: 'tweak wording', at: NOW });
  assert.notEqual(next.customerReviewStatus, 'approved');
  assert.equal(isApprovalAction(), false);
});

test('does not advance order review/fulfillment state', () => {
  const order: OrderRecord = {
    ...createOrderRecord({ childName: 'Testkid', bookFormat: 'digital', email: 'a@b.com' },
      { id: 'ord_contract_test', now: NOW }),
    reviewStatus: 'in_review',
    pageArtifacts: [makePage()],
  };
  const patchedPage = recordCustomerTextChangeRequest(order.pageArtifacts![0], { note: 'x', at: NOW });
  const nextOrder: OrderRecord = { ...order, pageArtifacts: [patchedPage] };

  // Order-level review status is unchanged by the page-level capture: advancing
  // it is a separate, deliberately-gated step this contract never performs.
  assert.equal(nextOrder.reviewStatus, 'in_review');
  assert.equal(nextOrder.fulfillmentStatus, order.fulfillmentStatus);
  assert.equal(nextOrder.proofApprovalToken, order.proofApprovalToken);
  assert.equal(nextOrder.customerProofReleasedAt, order.customerProofReleasedAt);
});

test('sanitizes + caps the note and rejects empty notes', () => {
  const next = recordCustomerTextChangeRequest(makePage(), { note: '  keep   spaces tidy  ', at: NOW });
  assert.equal(next.customerRequestedChange?.note, 'keep spaces tidy');

  const long = 'a'.repeat(CUSTOMER_CHANGE_NOTE_MAX_LEN + 500);
  const capped = recordCustomerTextChangeRequest(makePage(), { note: long, at: NOW });
  assert.equal(capped.customerRequestedChange?.note.length, CUSTOMER_CHANGE_NOTE_MAX_LEN);

  assert.throws(() => recordCustomerTextChangeRequest(makePage(), { note: '   ', at: NOW }));
});

test('resolve marks resolved without approving or touching canonical content', () => {
  const requested = recordCustomerTextChangeRequest(makePage(), { note: 'change it', at: NOW });
  const snapshot = JSON.parse(JSON.stringify(requested));
  const resolved = resolveCustomerTextChangeRequest(requested, LATER);

  assert.equal(resolved.customerReviewStatus, 'resolved');
  assert.equal(resolved.customerRequestedChange?.lifecycleStatus, 'resolved');
  assert.equal(resolved.customerRequestedChange?.updatedAt, LATER);
  assert.notEqual(resolved.customerReviewStatus, 'approved');
  for (const field of CANONICAL_PAGE_FIELDS) {
    assert.deepEqual((resolved as unknown as Record<string, unknown>)[field], (snapshot as unknown as Record<string, unknown>)[field]);
  }
});

test('resolve is a no-op when there is no captured request', () => {
  const page = makePage();
  assert.deepEqual(resolveCustomerTextChangeRequest(page, LATER), page);
});
