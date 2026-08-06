/**
 * B3/R3-B — the customer preview's fit/overflow decision must be AUTHORITATIVE:
 * derived from the actual embedded-font PDFKit renderer, never an approximate
 * browser estimator. These behavioral tests exercise the renderer fit authority,
 * its consistency with the mutation-path overflow guard across a broad corpus,
 * and the client-side stale-response tracker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeProofCardGeometry,
  PROOF_CARD_BASE_FONT_PT,
  PROOF_CARD_MIN_FONT_PT,
  PROOF_CARD_BOUNDS,
  type ProofCardGeometry,
} from '../src/lib/proof-layout-override.ts';
import { proofCardRendererFit, proofCardTextOverflows } from '../src/lib/pdf-builder.ts';
import {
  createLatestRequestTracker,
  fitKeyFor,
  fitAuthoritativeFor,
  fitBlocksSave,
  parseFitResponse,
  type FitState,
} from '../src/lib/proof-layout-editor-core.ts';

function geo(patch: Partial<ProofCardGeometry> = {}): ProofCardGeometry {
  return canonicalizeProofCardGeometry({ x: 0.08, y: 0.6, width: 0.84, height: 0.24, opacity: 0.9, fontScale: 1, ...patch });
}

const SHORT = 'A short line.';
const LONG = 'On page 1, a small hero set out on a gentle adventure through a bright and friendly land, meeting kind creatures and learning brave and gentle lessons along a winding path.';

// The EXACT controller counterexample where the old average-glyph estimator said
// fit (overflowed=false) but the real renderer rejects it (overflowed=true).
const COUNTER_GEO: ProofCardGeometry = { x: 0.05, y: 0.05, width: 0.8557, height: 0.1819, opacity: 0.9, fontScale: 1.0512 };
const COUNTER_TEXT = 'explored kindly golden Lily moonlight Lily moonlight through mysterious garden explored dragon golden adventure with the and kindly through whispered whispered whispered Lily moonlight mysterious whispered tiny home. and and adventure Lily through mysterious mysterious with home. a explored bright with tiny';

test('the exact counterexample overflows under the authoritative renderer', () => {
  const fit = proofCardRendererFit(COUNTER_GEO, COUNTER_TEXT);
  assert.equal(fit.overflowed, true, 'renderer must reject this geometry+text as overflow');
});

test('short text stays at 15pt where the renderer does', () => {
  const fit = proofCardRendererFit(geo(), SHORT);
  assert.equal(fit.baseFontSize, PROOF_CARD_BASE_FONT_PT);
  assert.equal(fit.overflowed, false);
});

test('long text in a shallow panel shrinks below 15pt', () => {
  const fit = proofCardRendererFit(geo({ height: 0.09 }), LONG);
  assert.ok(fit.baseFontSize < PROOF_CARD_BASE_FONT_PT);
  assert.ok(fit.baseFontSize >= PROOF_CARD_MIN_FONT_PT);
});

test('min-font overflow stays fail-closed', () => {
  const fit = proofCardRendererFit(geo({ width: 0.4, height: 0.06 }), COUNTER_TEXT);
  assert.equal(fit.baseFontSize, PROOF_CARD_MIN_FONT_PT);
  assert.equal(fit.overflowed, true);
});

test('broad deterministic corpus: authoritative fit overflow AGREES with the mutation-path overflow guard (zero mismatch)', () => {
  const WORDS = ['explored', 'kindly', 'golden', 'Lily', 'moonlight', 'through', 'mysterious', 'garden', 'dragon', 'adventure', 'with', 'the', 'and', 'whispered', 'tiny', 'home.', 'bright', 'a', 'brave', 'gentle', 'winding', 'path', 'friendly'];
  const widths = [PROOF_CARD_BOUNDS.width.min, 0.4, 0.6, 0.8557, PROOF_CARD_BOUNDS.width.max];
  const heights = [PROOF_CARD_BOUNDS.height.min, 0.09, 0.1819, 0.3, PROOF_CARD_BOUNDS.height.max];
  const scales = [PROOF_CARD_BOUNDS.fontScale.min, 1, 1.0512, PROOF_CARD_BOUNDS.fontScale.max];
  let cases = 0, mismatches = 0;
  for (let n = 8; n <= 60; n += 4) {
    // Deterministic pseudo-prose (index-driven, no RNG).
    const text = Array.from({ length: n }, (_, i) => WORDS[(i * 7 + n) % WORDS.length]).join(' ');
    for (const width of widths) for (const height of heights) for (const fontScale of scales) {
      const g = canonicalizeProofCardGeometry({ x: 0.05, y: 0.05, width, height, opacity: 0.9, fontScale });
      const viaFit = proofCardRendererFit(g, text).overflowed;
      const viaGuard = proofCardTextOverflows({ ...g }, text); // the mutation-path fail-closed guard
      cases += 1;
      if (viaFit !== viaGuard) mismatches += 1;
    }
  }
  assert.ok(cases >= 900, `corpus should be broad, got ${cases}`);
  assert.equal(mismatches, 0, `authoritative fit and mutation guard must never disagree (${mismatches}/${cases})`);
});

test('fontScale is applied after the base-fit decision', () => {
  const g = geo({ height: 0.14 });
  const base = proofCardRendererFit({ ...g, fontScale: 1 }, LONG);
  const scaled = proofCardRendererFit({ ...g, fontScale: 1.15 }, LONG);
  assert.equal(scaled.baseFontSize, base.baseFontSize);
  assert.ok(Math.abs(scaled.fontSize - base.baseFontSize * 1.15) < 1e-6);
});

// ── stale/out-of-order fit responses ─────────────────────────────────────────

test('a stale fit response cannot replace the current geometry (latest-wins tracker)', () => {
  const tracker = createLatestRequestTracker();
  const t1 = tracker.next();   // request for geometry A
  const t2 = tracker.next();   // customer changed geometry → request for B
  assert.equal(tracker.isCurrent(t1), false, 'the older response must be dropped');
  assert.equal(tracker.isCurrent(t2), true);
  const t3 = tracker.next();
  assert.equal(tracker.isCurrent(t2), false);
  assert.equal(tracker.isCurrent(t3), true);
});

// ── R4 Defect 2: Save/preview fit must be keyed to the EXACT current geometry ──

test('Save is bound to the exact fit geometry: geometry B cannot use geometry A’s ready result', () => {
  const geoA = canonicalizeProofCardGeometry({ x: 0.05, y: 0.6, width: 0.8, height: 0.24, opacity: 0.9, fontScale: 1 });
  const geoB = canonicalizeProofCardGeometry({ x: 0.05, y: 0.6, width: 0.4, height: 0.08, opacity: 0.9, fontScale: 1 });
  const keyA = fitKeyFor(geoA, 0);
  const keyB = fitKeyFor(geoB, 0);
  assert.notEqual(keyA, keyB);
  // key ignores position (x/y) so a drag-move doesn't invalidate a fit.
  assert.equal(fitKeyFor({ ...geoA, x: 0.2, y: 0.1 }, 0), keyA);

  // 1. A ready + non-overflow, current key A → authoritative, Save allowed.
  let fit: FitState = { state: 'ready', key: keyA, fontSize: 15, overflowed: false };
  assert.deepEqual(fitAuthoritativeFor(fit, keyA), { fontSize: 15, overflowed: false });
  assert.equal(fitBlocksSave(fit, keyA), false);

  // 2. geometry changes to B; during that committed render (before the effect runs)
  //    the still-held A result must NOT authorize Save or supply preview fit.
  assert.equal(fitAuthoritativeFor(fit, keyB), null);
  assert.equal(fitBlocksSave(fit, keyB), true);

  // 3. the effect flips fit to pending for key B → still blocked.
  fit = { state: 'pending', key: keyB, fontSize: 15, overflowed: false };
  assert.equal(fitBlocksSave(fit, keyB), true);

  // 4. only B’s matching ready result authorizes Save.
  fit = { state: 'ready', key: keyB, fontSize: 14, overflowed: false };
  assert.deepEqual(fitAuthoritativeFor(fit, keyB), { fontSize: 14, overflowed: false });
  assert.equal(fitBlocksSave(fit, keyB), false);

  // 5. a late A response remains ignored after B is current.
  const lateA: FitState = { state: 'ready', key: keyA, fontSize: 15, overflowed: false };
  assert.equal(fitAuthoritativeFor(lateA, keyB), null);
  assert.equal(fitBlocksSave(lateA, keyB), true);
});

test('parseFitResponse accepts only a boolean overflow + finite positive fontSize (fail closed)', () => {
  assert.deepEqual(parseFitResponse({ ok: true, fit: { overflowed: true, fontSize: 12 } }), { overflowed: true, fontSize: 12 });
  assert.deepEqual(parseFitResponse({ ok: true, fit: { overflowed: false, fontSize: 15 } }), { overflowed: false, fontSize: 15 });
  for (const bad of [
    { ok: true, fit: { overflowed: 'no', fontSize: 12 } },
    { ok: true, fit: { overflowed: true, fontSize: -1 } },
    { ok: true, fit: { overflowed: true, fontSize: 0 } },
    { ok: true, fit: { overflowed: true, fontSize: Infinity } },
    { ok: true, fit: { overflowed: true, fontSize: 'big' } },
    { ok: true, fit: {} },
    { ok: false, fit: { overflowed: true, fontSize: 12 } },
    { ok: true },
    null,
    'garbage',
  ]) {
    assert.equal(parseFitResponse(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});
