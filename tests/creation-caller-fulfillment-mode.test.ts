/**
 * Proves every currently-authorized order-creation workflow explicitly classifies
 * its orders as fulfillmentMode='manual_hold', that createOrderRecord has NO
 * implicit default, and that no real workflow passes 'auto'. No HSB workflow is
 * approved as automatic; the detector stays inert for all current workflows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createOrderRecord } from '../src/lib/orders.ts';
import { buildRecoveryOrderRecord } from '../src/lib/order-recovery.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ── recovery workflow (behavioral) ─────────────────────────────────────────────

test('recovery workflow produces manual_hold', () => {
  const rec = buildRecoveryOrderRecord({ id: 'ord_rec1', childName: 'Mia', bookFormat: 'digital', email: 'a@b.com' });
  assert.equal(rec.fulfillmentMode, 'manual_hold');
  assert.equal(rec.paymentStatus, 'paid'); // recovery marks paid, but mode is still manual_hold
});

// ── production checkout + sandbox utility (static: heavy routes) ────────────────

test('every authorized creation caller explicitly passes manual_hold', () => {
  const callers = {
    'production checkout (POST /api/order)': '../src/app/api/order/route.ts',

    'order recovery': '../src/lib/order-recovery.ts',
  };
  for (const [label, rel] of Object.entries(callers)) {
    const src = read(rel);
    assert.ok(src.includes("fulfillmentMode: 'manual_hold'"), `${label} must pass manual_hold`);
    assert.equal(src.includes("fulfillmentMode: 'auto'"), false, `${label} must NOT pass auto`);
  }
});

// ── no implicit default in createOrderRecord ───────────────────────────────────

test('createOrderRecord has no implicit fulfillmentMode default (pass-through only)', () => {
  const src = read('../src/lib/orders.ts');
  const start = src.indexOf('export function createOrderRecord');
  const nextExport = src.indexOf('\nexport ', start + 1);
  const body = src.slice(start, nextExport > start ? nextExport : start + 5000);
  // The only fulfillmentMode reference inside createOrderRecord is the guarded
  // pass-through of options.fulfillmentMode — never a hardcoded literal default.
  assert.ok(body.includes('options.fulfillmentMode ?'), 'expected guarded pass-through');
  assert.equal(body.includes("fulfillmentMode: 'auto'"), false);
  assert.equal(body.includes("fulfillmentMode: 'manual_hold'"), false);
  // Behavioral: omitting intent yields undefined (fail closed), not a default.
  assert.equal(createOrderRecord({ childName: 'X', bookFormat: 'digital', email: 'a@b.com' }, { id: 'z' }).fulfillmentMode, undefined);
});

// ── future workflows must DELIBERATELY pass auto ───────────────────────────────

test('future workflows must deliberately pass auto; nothing today does', () => {
  // A future 'auto' workflow is possible only by explicitly supplying it.
  assert.equal(createOrderRecord({ childName: 'X', bookFormat: 'digital', email: 'a@b.com' }, { id: 'z', fulfillmentMode: 'auto' }).fulfillmentMode, 'auto');
  // But NO current authorized caller supplies it (asserted statically above).
});
