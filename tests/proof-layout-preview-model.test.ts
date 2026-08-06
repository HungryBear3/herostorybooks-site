/**
 * B2 — customer preview must be structurally faithful to the PDF proof renderer.
 * These are pure/behavioral tests of the shared preview model. The CSS visual
 * match is proven separately in real compiled-browser evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proofCardPreviewModel,
  PROOF_PAGE_WIDTH_PT,
  PROOF_PAGE_HEIGHT_PT,
  PROOF_ART_FRAME_HEIGHT_PT,
  PROOF_ART_FRAME_FRACTION,
  PROOF_CARD_TEXT_INSET_PT,
  PROOF_CARD_VERTICAL_INSET_PT,
  PROOF_CARD_BASE_FONT_PT,
  resolveProofTextColor,
  canonicalizeProofCardGeometry,
  type ProofCardGeometry,
} from '../src/lib/proof-layout-override.ts';

const GEO: ProofCardGeometry = canonicalizeProofCardGeometry({
  x: 0.1, y: 0.65, width: 0.8, height: 0.2, opacity: 0.6, fontScale: 1,
});

test('art-frame fraction matches the 650 / 841.89 renderer contract', () => {
  assert.equal(PROOF_ART_FRAME_HEIGHT_PT, 650);
  assert.equal(PROOF_PAGE_HEIGHT_PT, 841.89);
  assert.equal(PROOF_PAGE_WIDTH_PT, 595.28);
  const expected = 650 / 841.89;
  assert.ok(Math.abs(PROOF_ART_FRAME_FRACTION - expected) < 1e-9);
  const m = proofCardPreviewModel(GEO);
  assert.ok(Math.abs(m.artFrameFraction - expected) < 1e-9);
  // Page aspect ratio (width/height) drives the frame box.
  assert.ok(Math.abs(m.page.aspectRatio - PROOF_PAGE_WIDTH_PT / PROOF_PAGE_HEIGHT_PT) < 1e-9);
});

test('panel opacity applies to the panel background only; text stays fully opaque', () => {
  const m = proofCardPreviewModel(GEO);
  assert.equal(m.panelOpacity, GEO.opacity);
  // The text sub-model carries no opacity channel — it renders at full opacity.
  assert.equal((m.text as unknown as Record<string, unknown>).opacity, undefined);
  assert.equal(m.textOpacity ?? 1, 1);
});

test('preview font uses the AUTHORITATIVE fit font size when supplied; else base fallback', () => {
  // Fallback (no authoritative fit yet) → base 15pt × fontScale.
  const base = proofCardPreviewModel(canonicalizeProofCardGeometry({ ...GEO, fontScale: 1 }));
  const expectedBasePct = (PROOF_CARD_BASE_FONT_PT * 1) / PROOF_PAGE_HEIGHT_PT * 100;
  assert.ok(Math.abs(base.text.fontSizePctOfFrameHeight - expectedBasePct) < 1e-6);
  assert.equal(base.overflowed, false);
  // With an authoritative fit (e.g. renderer shrank to 12pt and flagged overflow),
  // the preview font and overflow follow the renderer decision — not a guess.
  const authoritative = proofCardPreviewModel(GEO, undefined, { fontSize: 12, overflowed: true });
  assert.ok(Math.abs(authoritative.text.fontSizePctOfFrameHeight - (12 / PROOF_PAGE_HEIGHT_PT) * 100) < 1e-6);
  assert.equal(authoritative.overflowed, true);
});

test('text zone uses the renderer normalized insets and centers vertically', () => {
  const m = proofCardPreviewModel(GEO);
  const insetX = PROOF_CARD_TEXT_INSET_PT / PROOF_PAGE_WIDTH_PT;
  const insetY = PROOF_CARD_VERTICAL_INSET_PT / PROOF_PAGE_HEIGHT_PT;
  assert.ok(Math.abs(m.text.xPct - (GEO.x + insetX) * 100) < 1e-6);
  assert.ok(Math.abs(m.text.widthPct - (GEO.width - 2 * insetX) * 100) < 1e-6);
  assert.ok(Math.abs(m.text.yPct - (GEO.y + insetY) * 100) < 1e-6);
  assert.ok(Math.abs(m.text.heightPct - (GEO.height - 2 * insetY) * 100) < 1e-6);
  assert.equal(m.text.centered, true);
});

test('panel rect is the normalized geometry; colors come from the shared palette', () => {
  const m = proofCardPreviewModel(GEO, 'cream');
  assert.ok(Math.abs(m.panel.xPct - GEO.x * 100) < 1e-6);
  assert.ok(Math.abs(m.panel.yPct - GEO.y * 100) < 1e-6);
  assert.ok(Math.abs(m.panel.widthPct - GEO.width * 100) < 1e-6);
  assert.ok(Math.abs(m.panel.heightPct - GEO.height * 100) < 1e-6);
  const resolved = resolveProofTextColor('cream');
  assert.equal(m.panelFill, resolved.fill);
  assert.equal(m.text.fill, resolved.text);
});
