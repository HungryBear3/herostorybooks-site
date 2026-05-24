/**
 * @jest-environment node
 *
 * Pure-function coverage for the Father's Day countdown helper.
 * Pins business-rule constants and the four urgency tiers so a future
 * date arithmetic mistake can't ship a misleading badge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getFathersDayCountdown,
  FATHERS_DAY_2026,
  LAST_SAFE_ORDER_DATE_2026,
} from '../src/lib/fathers-day.ts';

function at(iso: string): Date {
  return new Date(iso + 'T12:00:00Z');
}

test('constants pinned: Father\'s Day 2026 + last-safe print order date', () => {
  assert.equal(FATHERS_DAY_2026, '2026-06-21');
  assert.equal(LAST_SAFE_ORDER_DATE_2026, '2026-06-05');
});

test('comfortable tier: well before the safe date', () => {
  const c = getFathersDayCountdown(at('2026-05-18'));
  assert.equal(c.tier, 'comfortable');
  assert.equal(c.daysUntilSafeOrderDate, 18);
  assert.equal(c.daysUntilFathersDay, 34);
  assert.match(c.badgeCopy, /Order by/);
  assert.match(c.badgeCopy, /best chance/);
  assert.doesNotMatch(c.badgeCopy, /guaranteed/i);
});

test('tightening tier: 4–9 days out', () => {
  const c = getFathersDayCountdown(at('2026-05-30'));
  assert.equal(c.tier, 'tightening');
  assert.equal(c.daysUntilSafeOrderDate, 6);
  assert.match(c.badgeCopy, /Order by/);
});

test('last-call tier: 1–3 days out', () => {
  const c = getFathersDayCountdown(at('2026-06-03'));
  assert.equal(c.tier, 'last-call');
  assert.equal(c.daysUntilSafeOrderDate, 2);
  assert.match(c.badgeCopy, /Last/);
  assert.match(c.badgeCopy, /best chance/);
});

test('final-hours tier: today is the safe date', () => {
  const c = getFathersDayCountdown(at('2026-06-05'));
  assert.equal(c.tier, 'final-hours');
  assert.equal(c.daysUntilSafeOrderDate, 0);
});

test('digital-only tier: past safe date, Father\'s Day not yet', () => {
  const c = getFathersDayCountdown(at('2026-06-10'));
  assert.equal(c.tier, 'digital-only');
  assert.match(c.badgeCopy, /Digital PDF/);
  assert.doesNotMatch(c.badgeCopy, /guaranteed/i);
});

test('past-event tier: after Father\'s Day, no badge copy', () => {
  const c = getFathersDayCountdown(at('2026-06-22'));
  assert.equal(c.tier, 'past-event');
  assert.equal(c.badgeCopy, '');
});

test('honest copy: never promises specific delivery', () => {
  for (const day of ['2026-05-18', '2026-05-30', '2026-06-03', '2026-06-05', '2026-06-10']) {
    const c = getFathersDayCountdown(at(day));
    assert.doesNotMatch(c.badgeCopy, /guaranteed|definitely|certain|promise/i);
  }
});
