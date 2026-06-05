import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scanProofArtifacts,
  containsPlaceholder,
  PROOF_PLACEHOLDER_TEXT,
} from '../src/lib/qa-artifact-scanner.ts';
import {
  QA_FAIL_REASON_TAGS,
  QA_FAIL_REASON_LABELS,
  isQaFailReasonTag,
  canEmailCustomer,
  canRenderColophon,
  isCustomerVisible,
  deriveInternalQaState,
  CUSTOMER_BLOCKED_MESSAGE,
} from '../src/lib/qa-lifecycle.ts';

function pages(n: number, withImage: boolean) {
  return Array.from({ length: n }, (_, i) => ({
    pageNumber: i + 1,
    storyText: `page ${i + 1} text`,
    currentImageUrl: withImage ? `https://blob/img-${i + 1}.png` : null,
    acceptedImageUrl: null,
  }));
}
const order = (over: Record<string, unknown> = {}): any => ({ qaStatus: null, fulfillmentStatus: 'awaiting_qa', pageArtifacts: pages(24, true), ...over });

// ── scanner ────────────────────────────────────────────────────────────────

test('scanner: full 24 images → ok', () => {
  const s = scanProofArtifacts(order());
  assert.equal(s.ok, true);
  assert.equal(s.pagesWithImage, 24);
  assert.deepEqual(s.missingImagePages, []);
  assert.deepEqual(s.blockingReasonTags, []);
});

test('scanner: missing images → blocked with missing_illustrations + page list', () => {
  const arts = pages(24, true);
  arts[5].currentImageUrl = null;
  arts[17].currentImageUrl = '   ';
  const s = scanProofArtifacts(order({ pageArtifacts: arts }));
  assert.equal(s.ok, false);
  assert.deepEqual(s.missingImagePages, [6, 18]);
  assert.ok(s.blockingReasonTags.includes('missing_illustrations'));
});

test('scanner: zero artifacts → blocked', () => {
  const s = scanProofArtifacts(order({ pageArtifacts: [] }));
  assert.equal(s.ok, false);
  assert.equal(s.pagesWithImage, 0);
  assert.deepEqual(s.missingImagePages.length, 24);
  assert.ok(s.blocking.some((b) => /no page artifacts/.test(b)));
});

test('scanner: accepted image counts; placeholder string is a failure', () => {
  const arts = pages(24, false).map((p) => ({ ...p, acceptedImageUrl: 'https://blob/a.png' }));
  assert.equal(scanProofArtifacts(order({ pageArtifacts: arts })).ok, true);
  // placeholder embedded in text → detected + blocked
  const arts2 = pages(24, true);
  arts2[0].storyText = `oops ${PROOF_PLACEHOLDER_TEXT}`;
  const s = scanProofArtifacts(order({ pageArtifacts: arts2 }));
  assert.equal(s.placeholderDetected, true);
  assert.equal(s.ok, false);
});

test('containsPlaceholder', () => {
  assert.equal(containsPlaceholder(`x ${PROOF_PLACEHOLDER_TEXT} y`), true);
  assert.equal(containsPlaceholder('clean'), false);
  assert.equal(containsPlaceholder(null), false);
});

// ── email gate ───────────────────────────────────────────────────────────────

test('canEmailCustomer: only when qa passed', () => {
  assert.equal(canEmailCustomer(order({ qaStatus: 'passed' })).allowed, true);
  for (const q of [null, 'pending', 'blocked']) {
    assert.equal(canEmailCustomer(order({ qaStatus: q })).allowed, false, `qaStatus=${q}`);
  }
});

// ── colophon gate ─────────────────────────────────────────────────────────────

test('canRenderColophon: art present AND qa passed', () => {
  assert.equal(canRenderColophon(order({ qaStatus: 'passed', pageArtifacts: pages(24, true) })), true);
  assert.equal(canRenderColophon(order({ qaStatus: 'pending', pageArtifacts: pages(24, true) })), false, 'not passed');
  assert.equal(canRenderColophon(order({ qaStatus: 'passed', pageArtifacts: pages(24, false) })), false, 'no art');
  assert.equal(canRenderColophon(order({ qaStatus: 'passed', pageArtifacts: [] })), false, 'empty');
});

// ── customer visibility + state ──────────────────────────────────────────────

test('isCustomerVisible: only when qa passed', () => {
  assert.equal(isCustomerVisible(order({ qaStatus: 'passed' })), true);
  assert.equal(isCustomerVisible(order({ qaStatus: 'pending' })), false);
  assert.equal(isCustomerVisible(order({ qaStatus: null })), false);
});

test('deriveInternalQaState maps lifecycle', () => {
  assert.equal(deriveInternalQaState({ qaStatus: 'passed', fulfillmentStatus: 'awaiting_qa' }), 'qa_passed');
  assert.equal(deriveInternalQaState({ qaStatus: 'blocked', fulfillmentStatus: 'qa_blocked' }), 'qa_failed');
  assert.equal(deriveInternalQaState({ qaStatus: null, fulfillmentStatus: 'awaiting_qa' }), 'in_qa');
  assert.equal(deriveInternalQaState({ qaStatus: null, fulfillmentStatus: 'generating_images' }), 'generated');
  assert.equal(deriveInternalQaState({ qaStatus: null, fulfillmentStatus: 'needs_rebuild' as any }), 'needs_rebuild');
});

// ── reason tags + copy ────────────────────────────────────────────────────────

test('reason tags: the six CD tags with labels', () => {
  assert.deepEqual([...QA_FAIL_REASON_TAGS], [
    'missing_illustrations', 'grammar', 'repetition', 'layout', 'wrong_personalization', 'inaccurate_colophon',
  ]);
  assert.equal(QA_FAIL_REASON_LABELS.missing_illustrations, 'Missing illustrations');
  assert.equal(isQaFailReasonTag('grammar'), true);
  assert.equal(isQaFailReasonTag('nope'), false);
});

test('customer blocked message matches CD wording', () => {
  assert.match(CUSTOMER_BLOCKED_MESSAGE, /still being finished and quality-checked by our team/);
  assert.match(CUSTOMER_BLOCKED_MESSAGE, /email you as soon as your proof is ready to review/);
});
