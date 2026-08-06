/**
 * Behavioural contract for the shared, framework-free proof-layout editor core
 * (Slice 3). Covers keyboard/pointer geometry math, eligibility + binding, the
 * customer request shaping (customer endpoint only, token never in body, never
 * appliedBy), remount identity, and honest error copy. No React / DOM needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_STEP, KEY_STEP_LARGE,
  defaultCardGeometry, geometryFromOverride, colorChoiceFromOverride,
  applyPointerMove, applyPointerResize, applyKeyboardGeometry, isEditorArrowKey,
  layoutBinding, canOfferCustomerLayoutEditing,
  customerProofLayoutUrl, customerRequestHelpUrl,
  buildLayoutApplyBody, buildLayoutResetBody,
  editorIdentityKey, customerLayoutErrorMessage,
} from '../src/lib/proof-layout-editor-core.ts';
import { canonicalizeProofCardGeometry } from '../src/lib/proof-layout-override.ts';
import type { ProofCardOverride } from '../src/lib/fulfillment-types.ts';
import type { ReviewSnapshot } from '../src/lib/page-review.ts';

const MID = canonicalizeProofCardGeometry({ x: 0.3, y: 0.3, width: 0.5, height: 0.2, opacity: 0.9, fontScale: 1 });

function override(patch: Partial<ProofCardOverride> = {}): ProofCardOverride {
  return {
    x: 0.2, y: 0.2, width: 0.5, height: 0.2, opacity: 0.9, fontScale: 1,
    textColor: 'dark_brown', authoredAgainstProofVersion: 'pv_1', authoredAgainstFingerprint: 'pf_1',
    appliedAt: '2026-08-06T00:00:00.000Z', appliedBy: 'customer', ...patch,
  };
}
function snap(patch: Partial<ReviewSnapshot> = {}): ReviewSnapshot {
  return {
    orderId: 'ord_x', childName: 'Kid', reviewStatus: 'in_review', pageArtifacts: [],
    storyArtifactUrl: 'https://example.invalid/p.pdf', proofVersion: 'pv_1', proofSourceFingerprint: 'pf_1',
    proofReviewedVersion: null, proofReviewedAt: null, proofAvailable: true, proofFresh: true,
    isPrint: false, bookFormat: 'digital', ...patch,
  };
}

// ── keyboard ─────────────────────────────────────────────────────────────────

test('arrow keys move by the base step; Shift uses the large step', () => {
  assert.equal(applyKeyboardGeometry(MID, 'ArrowLeft')!.x, canonicalizeProofCardGeometry({ ...MID, x: MID.x - KEY_STEP }).x);
  assert.equal(applyKeyboardGeometry(MID, 'ArrowRight', { shift: true })!.x, canonicalizeProofCardGeometry({ ...MID, x: MID.x + KEY_STEP_LARGE }).x);
  assert.equal(applyKeyboardGeometry(MID, 'ArrowUp')!.y, canonicalizeProofCardGeometry({ ...MID, y: MID.y - KEY_STEP }).y);
});

test('Alt+arrow resizes instead of moving', () => {
  const grown = applyKeyboardGeometry(MID, 'ArrowRight', { alt: true })!;
  assert.equal(grown.width, canonicalizeProofCardGeometry({ ...MID, width: MID.width + KEY_STEP }).width);
  assert.equal(grown.x, MID.x, 'position unchanged when resizing');
  const taller = applyKeyboardGeometry(MID, 'ArrowDown', { alt: true })!;
  assert.equal(taller.height, canonicalizeProofCardGeometry({ ...MID, height: MID.height + KEY_STEP }).height);
});

test('non-arrow keys are not handled (null) and isEditorArrowKey agrees', () => {
  for (const k of ['Enter', 'a', 'Tab', ' ', 'Escape']) {
    assert.equal(applyKeyboardGeometry(MID, k), null);
    assert.equal(isEditorArrowKey(k), false);
  }
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) assert.equal(isEditorArrowKey(k), true);
});

test('keyboard output is always canonical/clamped (fixed point, in-bounds)', () => {
  // Nudge far past the edge repeatedly; must clamp, never exceed bounds.
  let g = MID;
  for (let i = 0; i < 200; i += 1) g = applyKeyboardGeometry(g, 'ArrowLeft', { shift: true })!;
  assert.deepEqual(g, canonicalizeProofCardGeometry(g), 'stays a canonical fixed point');
  assert.ok(g.x >= 0.05 - 1e-9, 'clamped to the safe margin');
});

// ── pointer ──────────────────────────────────────────────────────────────────

test('pointer move/resize apply normalized deltas and canonicalize', () => {
  assert.deepEqual(applyPointerMove(MID, 0.1, -0.05), canonicalizeProofCardGeometry({ ...MID, x: MID.x + 0.1, y: MID.y - 0.05 }));
  assert.deepEqual(applyPointerResize(MID, 0.1, 0.05), canonicalizeProofCardGeometry({ ...MID, width: MID.width + 0.1, height: MID.height + 0.05 }));
});

// ── initial state helpers ────────────────────────────────────────────────────

test('geometry/color initialize from the persisted override, else defaults', () => {
  assert.deepEqual(geometryFromOverride(null), defaultCardGeometry());
  assert.equal(colorChoiceFromOverride(null), 'legacy_default');
  const ov = override({ textColor: 'charcoal' });
  assert.deepEqual(geometryFromOverride(ov), canonicalizeProofCardGeometry(ov));
  assert.equal(colorChoiceFromOverride(ov), 'charcoal');
  assert.equal(colorChoiceFromOverride(override({ textColor: undefined })), 'legacy_default');
});

// ── eligibility + binding ────────────────────────────────────────────────────

test('editing is offered only with a fresh proof binding on an editable order', () => {
  assert.equal(canOfferCustomerLayoutEditing(snap()), true);
  assert.equal(canOfferCustomerLayoutEditing(snap({ reviewStatus: 'approved' })), false);
  assert.equal(canOfferCustomerLayoutEditing(snap({ proofFresh: false })), false);
  assert.equal(canOfferCustomerLayoutEditing(snap({ proofVersion: null })), false);
  assert.equal(canOfferCustomerLayoutEditing(snap({ proofSourceFingerprint: null })), false);
});

test('layoutBinding is null unless both version and fingerprint are present', () => {
  assert.deepEqual(layoutBinding(snap()), { authoredAgainstProofVersion: 'pv_1', authoredAgainstFingerprint: 'pf_1' });
  assert.equal(layoutBinding(snap({ proofVersion: null })), null);
  assert.equal(layoutBinding(snap({ proofSourceFingerprint: null })), null);
});

// ── request shaping ──────────────────────────────────────────────────────────

test('customer URLs target the tokenized customer route, never admin', () => {
  const url = customerProofLayoutUrl('ord_x', 'tok123');
  assert.equal(url, '/api/order/ord_x/proof-layout?token=tok123');
  assert.doesNotMatch(url, /admin/);
  assert.match(customerRequestHelpUrl('ord_x', 'tok123'), /^\/api\/order\/ord_x\/request-help\?token=tok123$/);
});

test('apply body carries exact index, canonical geometry, binding, optional color — never token/appliedBy', () => {
  const binding = layoutBinding(snap())!;
  const body = buildLayoutApplyBody(3, MID, 'dark_brown', binding);
  assert.equal(body.pageIndex, 3);
  assert.deepEqual(body.geometry, canonicalizeProofCardGeometry(MID));
  assert.equal(body.textColor, 'dark_brown');
  assert.equal(body.authoredAgainstProofVersion, 'pv_1');
  assert.equal(body.authoredAgainstFingerprint, 'pf_1');
  assert.equal('appliedBy' in body, false, 'never sends appliedBy');
  assert.equal('token' in body, false, 'never sends token in body');
  // legacy_default omits textColor entirely.
  assert.equal('textColor' in buildLayoutApplyBody(0, MID, 'legacy_default', binding), false);
});

test('reset body sends geometry:null with the same binding', () => {
  const binding = layoutBinding(snap())!;
  const body = buildLayoutResetBody(2, binding);
  assert.equal(body.pageIndex, 2);
  assert.equal(body.geometry, null);
  assert.equal(body.authoredAgainstProofVersion, 'pv_1');
  assert.equal(body.authoredAgainstFingerprint, 'pf_1');
  assert.equal('appliedBy' in body, false);
});

// ── remount identity ─────────────────────────────────────────────────────────

test('editor identity changes on page/version/fingerprint/override change; stable otherwise', () => {
  const base = editorIdentityKey('ord_x', 0, snap(), null);
  assert.equal(editorIdentityKey('ord_x', 0, snap(), null), base, 'stable for identical inputs');
  assert.notEqual(editorIdentityKey('ord_x', 1, snap(), null), base, 'page change');
  assert.notEqual(editorIdentityKey('ord_x', 0, snap({ proofVersion: 'pv_2' }), null), base, 'revision change');
  assert.notEqual(editorIdentityKey('ord_x', 0, snap({ proofSourceFingerprint: 'pf_2' }), null), base, 'fingerprint change');
  assert.notEqual(editorIdentityKey('ord_x', 0, snap(), override()), base, 'override change');
});

// ── honest error copy ────────────────────────────────────────────────────────

test('error copy is specific, honest, jargon-free, and never implies success', () => {
  const cases: [string | undefined, number, RegExp][] = [
    ['text_overflow', 422, /too large/i],
    ['insufficient_contrast', 422, /hard to read|legible/i],
    ['stale_revision', 409, /earlier proof|reload/i],
    ['stale_fingerprint', 409, /earlier proof|reload/i],
    ['order_approved', 409, /finalis/i],
    ['invalid_or_missing_token', 403, /review link/i],
    [undefined, 0, /couldn’t reach|connection/i],
    [undefined, 500, /went wrong/i],
  ];
  for (const [err, status, re] of cases) {
    const msg = customerLayoutErrorMessage(err, status);
    assert.match(msg, re, `"${err}"@${status} → ${msg}`);
    assert.doesNotMatch(msg, /fingerprint|proofVersion|authoredAgainst|CAS|409|422|null/i, 'no internal jargon');
    assert.doesNotMatch(msg, /saved|success|approved!/i, 'never implies success on failure');
  }
});
