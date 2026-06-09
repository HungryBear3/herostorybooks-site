/**
 * Unit tests for the constrained proof text layout validation/clamping.
 * These pin the server-side gate that runs on every untrusted layout patch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  clampTextPosition,
  sanitizeTextLayoutPatch,
  TEXT_POSITION_BOUNDS,
  MAX_RIGHT_EDGE_PCT,
} from '../src/lib/proof-text-layout.ts';
import type { PageTextLayout } from '../src/lib/fulfillment-types.ts';

test('clamp pins values to range and coerces non-finite to min', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(clamp(Number.NaN, 2, 10), 2);
  // Non-finite inputs are treated as garbage and coerced to the safe minimum.
  assert.equal(clamp(Infinity, 2, 10), 2);
});

test('clampTextPosition clamps out-of-bounds x/y into the safe zone', () => {
  const pos = clampTextPosition({ xPct: -50, yPct: 999 });
  assert.ok(pos);
  assert.equal(pos!.xPct, TEXT_POSITION_BOUNDS.xPct.min);
  assert.equal(pos!.yPct, TEXT_POSITION_BOUNDS.yPct.max);
});

test('clampTextPosition returns null when x/y are missing or non-numeric', () => {
  assert.equal(clampTextPosition({}), null);
  assert.equal(clampTextPosition({ xPct: 'a', yPct: 'b' }), null);
  assert.equal(clampTextPosition(null), null);
  assert.equal(clampTextPosition(undefined), null);
});

test('clampTextPosition keeps the block right edge inside the safe margin', () => {
  // Far right + very wide → width must shrink so x + width <= MAX_RIGHT_EDGE_PCT.
  const pos = clampTextPosition({ xPct: 75, yPct: 50, widthPct: 90 });
  assert.ok(pos);
  assert.ok(pos!.widthPct !== undefined);
  assert.ok(pos!.xPct + pos!.widthPct! <= MAX_RIGHT_EDGE_PCT + 0.01, 'right edge within margin');
});

test('clampTextPosition floors width at the minimum even when squeezed', () => {
  const pos = clampTextPosition({ xPct: TEXT_POSITION_BOUNDS.xPct.max, yPct: 50, widthPct: 90 });
  assert.ok(pos);
  assert.ok((pos!.widthPct ?? 0) >= TEXT_POSITION_BOUNDS.widthPct.min);
});

test('sanitizeTextLayoutPatch: legacy layout without new fields validates unchanged', () => {
  const legacy: PageTextLayout = { zone: 'bottom_band', colorMode: 'dark', panelStyle: 'translucent_cream' };
  const out = sanitizeTextLayoutPatch({}, legacy);
  assert.equal(out.zone, 'bottom_band');
  assert.equal(out.colorMode, 'dark');
  assert.equal(out.panelStyle, 'translucent_cream');
  assert.equal(out.position, undefined);
  assert.equal(out.sizePreset, undefined);
});

test('sanitizeTextLayoutPatch: invalid enums fall back to safe defaults', () => {
  const out = sanitizeTextLayoutPatch({ colorMode: 'rainbow', sizePreset: 'huge' });
  assert.equal(out.colorMode, 'auto');
  assert.equal(out.sizePreset, undefined); // invalid preset dropped, no base to inherit
  assert.equal(out.panelStyle, 'translucent_cream');
});

test('sanitizeTextLayoutPatch: valid patch is accepted and clamped', () => {
  const out = sanitizeTextLayoutPatch({
    colorMode: 'light',
    sizePreset: 'large',
    position: { xPct: 200, yPct: -5, widthPct: 80 },
  });
  assert.equal(out.colorMode, 'light');
  assert.equal(out.sizePreset, 'large');
  assert.ok(out.position);
  assert.equal(out.position!.xPct, TEXT_POSITION_BOUNDS.xPct.max);
  assert.equal(out.position!.yPct, TEXT_POSITION_BOUNDS.yPct.min);
});

test('sanitizeTextLayoutPatch: explicit position null clears a prior override (reset)', () => {
  const base: PageTextLayout = {
    zone: 'natural',
    colorMode: 'auto',
    panelStyle: 'translucent_cream',
    position: { xPct: 20, yPct: 40 },
    sizePreset: 'large',
  };
  const out = sanitizeTextLayoutPatch({ position: null, sizePreset: 'medium' }, base);
  assert.equal(out.position, null);
  assert.equal(out.sizePreset, 'medium');
});

test('sanitizeTextLayoutPatch: undefined position preserves the base override', () => {
  const base: PageTextLayout = {
    zone: 'natural',
    colorMode: 'auto',
    panelStyle: 'translucent_cream',
    position: { xPct: 22, yPct: 44 },
  };
  const out = sanitizeTextLayoutPatch({ colorMode: 'dark' }, base);
  assert.ok(out.position);
  assert.equal(out.position!.xPct, 22);
  assert.equal(out.position!.yPct, 44);
});
