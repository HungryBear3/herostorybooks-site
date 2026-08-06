/**
 * B3 — the customer preview must follow the PDF renderer's ACTUAL adaptive text
 * fit (base 15→12pt + line-gap reductions), not a fixed 15pt projection. These
 * behavioral parity tests compare the renderer's real PDFKit fit decision to the
 * browser-safe preview fit decision for representative fixtures.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proofCardPreviewFit,
  canonicalizeProofCardGeometry,
  PROOF_CARD_BASE_FONT_PT,
  PROOF_CARD_MIN_FONT_PT,
  type ProofCardGeometry,
} from '../src/lib/proof-layout-override.ts';
import { proofCardRendererFit } from '../src/lib/pdf-builder.ts';

function geo(patch: Partial<ProofCardGeometry> = {}): ProofCardGeometry {
  return canonicalizeProofCardGeometry({ x: 0.08, y: 0.6, width: 0.84, height: 0.24, opacity: 0.9, fontScale: 1, ...patch });
}

const SHORT = 'A short line.';
const LONG = 'On page 1, a small hero set out on a gentle adventure through a bright and friendly land, meeting kind creatures and learning brave and gentle lessons along a winding path.';
const VERY_LONG = new Array(14).fill('The hero walked onward through the wide and wondrous land, singing softly.').join(' ');

test('short text in a roomy panel stays at the 15pt base', () => {
  const fit = proofCardPreviewFit(geo(), SHORT);
  assert.equal(fit.baseFontSize, PROOF_CARD_BASE_FONT_PT);
  assert.equal(fit.overflowed, false);
});

test('long text in a shallow panel forces one or more fit reductions below 15pt', () => {
  const g = geo({ height: 0.09 });
  const fit = proofCardPreviewFit(g, LONG);
  assert.ok(fit.baseFontSize < PROOF_CARD_BASE_FONT_PT, `expected shrink, got ${fit.baseFontSize}`);
  assert.ok(fit.baseFontSize >= PROOF_CARD_MIN_FONT_PT);
  // The renderer makes the same shrink decision.
  assert.equal(proofCardRendererFit(g, LONG).baseFontSize, fit.baseFontSize);
});

test('a narrow/short panel reaches the 12pt / min-line-gap boundary', () => {
  const fit = proofCardPreviewFit(geo({ width: 0.4, height: 0.08 }), LONG);
  assert.equal(fit.baseFontSize, PROOF_CARD_MIN_FONT_PT);
});

test('fontScale is applied AFTER the base-fit decision', () => {
  const g = geo({ height: 0.14 });
  const base = proofCardPreviewFit({ ...g, fontScale: 1 }, LONG);
  const scaled = proofCardPreviewFit({ ...g, fontScale: 1.15 }, LONG);
  assert.equal(scaled.baseFontSize, base.baseFontSize); // same base decision
  assert.ok(Math.abs(scaled.fontSize - base.baseFontSize * 1.15) < 1e-6);
});

test('overflow stays fail-closed where the renderer would reject', () => {
  const fit = proofCardPreviewFit(geo({ width: 0.4, height: 0.06 }), VERY_LONG);
  assert.equal(fit.overflowed, true);
  // The renderer agrees it overflows.
  assert.equal(proofCardRendererFit(geo({ width: 0.4, height: 0.06 }), VERY_LONG).overflowed, true);
});

test('preview and renderer resolve the SAME fit decision for each fixture', () => {
  const fixtures: Array<[ProofCardGeometry, string]> = [
    [geo(), SHORT],
    [geo({ height: 0.14 }), LONG],
    [geo({ width: 0.6, height: 0.12 }), LONG],
    [geo({ height: 0.3 }), LONG],
    [geo({ fontScale: 1.15, height: 0.14 }), LONG],
  ];
  for (const [g, text] of fixtures) {
    const r = proofCardRendererFit(g, text);
    const p = proofCardPreviewFit(g, text);
    assert.equal(p.baseFontSize, r.baseFontSize, `baseFontSize for "${text.slice(0, 20)}" @ ${g.width}x${g.height}`);
    assert.equal(p.baseLineGap, r.baseLineGap, `baseLineGap for "${text.slice(0, 20)}"`);
    assert.equal(p.overflowed, r.overflowed, `overflow for "${text.slice(0, 20)}"`);
  }
});
