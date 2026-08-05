/**
 * Unit contract for the pure proof-layout-override module: bounds clamping,
 * idempotent canonicalization, the fixed color palette + enum validation,
 * deterministic WCAG contrast, and the fingerprint projection. No I/O.
 * Ported from the reviewed PR #125 module, re-homed for the customer editor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROOF_CARD_BOUNDS,
  PROOF_CARD_SAFE_MARGIN,
  PROOF_CARD_FOLIO_RESERVE,
  clampProofCardGeometry,
  canonicalizeProofCardGeometry,
  resolveProofTextColor,
  isProofTextColor,
  LEGACY_DEFAULT_TEXT_COLOR,
  PROOF_TEXT_COLORS,
  evaluateProofTextContrast,
  proofCardGeometryForFingerprint,
  proofTextColorForFingerprint,
  contrastRatio,
} from '../src/lib/proof-layout-override.ts';

const MID = { x: 0.2, y: 0.2, width: 0.5, height: 0.2, opacity: 0.7, fontScale: 1 };

// ── bounds + clamp ───────────────────────────────────────────────────────────

test('clamp snaps each control into its bounds', () => {
  const g = clampProofCardGeometry({ x: -5, y: -5, width: 5, height: 5, opacity: 5, fontScale: 5 });
  assert.equal(g.width, PROOF_CARD_BOUNDS.width.max);
  assert.equal(g.height, PROOF_CARD_BOUNDS.height.max);
  assert.equal(g.opacity, PROOF_CARD_BOUNDS.opacity.max);
  assert.equal(g.fontScale, PROOF_CARD_BOUNDS.fontScale.max);
  const g2 = clampProofCardGeometry({ x: -5, y: -5, width: -5, height: -5, opacity: -5, fontScale: -5 });
  assert.equal(g2.width, PROOF_CARD_BOUNDS.width.min);
  assert.equal(g2.opacity, PROOF_CARD_BOUNDS.opacity.min);
  assert.equal(g2.x, PROOF_CARD_SAFE_MARGIN);
  assert.equal(g2.y, PROOF_CARD_SAFE_MARGIN);
});

test('a card can never leave the page or intersect the bottom folio strip', () => {
  const g = clampProofCardGeometry({ x: 1, y: 1, width: 0.9, height: 0.5, opacity: 0.9, fontScale: 1 });
  assert.ok(g.x + g.width <= 1 - PROOF_CARD_SAFE_MARGIN + 1e-9);
  assert.ok(g.y + g.height <= 1 - PROOF_CARD_FOLIO_RESERVE + 1e-9);
});

test('NaN / non-finite inputs never produce NaN', () => {
  const g = clampProofCardGeometry({ x: NaN, y: Infinity, width: NaN, height: -Infinity, opacity: NaN, fontScale: NaN });
  for (const v of Object.values(g)) assert.ok(Number.isFinite(v));
});

// ── canonicalization is a fixed point ────────────────────────────────────────

test('canonicalize is idempotent across messy/boundary inputs', () => {
  const inputs = [
    { x: 0.123456789, y: 0.98765, width: 0.44444, height: 0.3333, opacity: 0.711111, fontScale: 1.02222 },
    { x: -1, y: 2, width: 3, height: -3, opacity: 9, fontScale: 0 },
    MID,
  ];
  for (const input of inputs) {
    const once = canonicalizeProofCardGeometry(input);
    const twice = canonicalizeProofCardGeometry(once);
    assert.deepEqual(twice, once, `not a fixed point for ${JSON.stringify(input)}`);
  }
});

test('fingerprint geometry projection equals canonical geometry (4-dp), no operational metadata', () => {
  const proj = proofCardGeometryForFingerprint(MID);
  assert.deepEqual(proj, canonicalizeProofCardGeometry(MID));
  assert.equal(Object.prototype.hasOwnProperty.call(proj, 'appliedAt'), false);
});

// ── color palette + enum validation ──────────────────────────────────────────

test('only the three enum colors are accepted; anything else is legacy default', () => {
  assert.ok(isProofTextColor('dark_brown'));
  assert.ok(isProofTextColor('cream'));
  assert.ok(isProofTextColor('charcoal'));
  for (const bad of ['#123456', 'red', 'BROWN', '', null, undefined, 'legacy_default', 'rgb(0,0,0)']) {
    assert.equal(isProofTextColor(bad), false, `${String(bad)} must be rejected`);
  }
  // Absence / invalid resolves to the exact legacy default (blue on cream), never brown.
  assert.deepEqual(resolveProofTextColor(undefined), LEGACY_DEFAULT_TEXT_COLOR);
  assert.deepEqual(resolveProofTextColor(null), LEGACY_DEFAULT_TEXT_COLOR);
  assert.notEqual(LEGACY_DEFAULT_TEXT_COLOR.text, PROOF_TEXT_COLORS.dark_brown.text);
  assert.deepEqual(resolveProofTextColor('dark_brown'), PROOF_TEXT_COLORS.dark_brown);
});

test('fingerprint color projection is RGB-distinct: no-color !== dark_brown', () => {
  const none = proofTextColorForFingerprint(undefined);
  const brown = proofTextColorForFingerprint('dark_brown');
  assert.notDeepEqual(none, brown);
});

// ── deterministic contrast ───────────────────────────────────────────────────

test('every approved color passes the 4.5:1 policy at a legible (high) opacity', () => {
  // At full in-bounds opacity the card scrim dominates the worst-case backdrop,
  // so each approved color (and the legacy default) is legible.
  for (const color of ['dark_brown', 'cream', 'charcoal', undefined] as const) {
    const r = evaluateProofTextContrast(color, PROOF_CARD_BOUNDS.opacity.max);
    assert.ok(r.ok, `${String(color)} @ max opacity failed contrast (${r.ratio})`);
    assert.equal(r.threshold, 4.5);
  }
});

test('the contrast gate FAILS CLOSED for a too-transparent (illegible) card at any color', () => {
  // At the minimum in-bounds opacity the card is too see-through: the worst-case
  // backdrop shows through and the text is rejected regardless of color. This is
  // the deterministic, artwork-agnostic legibility floor.
  for (const color of ['dark_brown', 'cream', 'charcoal', undefined] as const) {
    const r = evaluateProofTextContrast(color, PROOF_CARD_BOUNDS.opacity.min);
    assert.equal(r.ok, false, `expected ${String(color)} @ min opacity to fail; ratio=${r.ratio}`);
  }
});

test('contrastRatio is symmetric and bounded 1..21', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#FFFFFF') - 21) < 0.01);
  assert.equal(contrastRatio('#123456', '#123456'), 1);
});
