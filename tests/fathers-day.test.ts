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
  DIGITAL_ORDER_CUTOFF_2026,
  FATHERS_DAY_OFFER,
} from '../src/lib/fathers-day.ts';

function at(iso: string): Date {
  return new Date(iso + 'T12:00:00Z');
}

test('constants pinned: conservative last-safe print date + digital cutoff', () => {
  assert.equal(FATHERS_DAY_2026, '2026-06-21');
  // Conservative, defensible print cut — NOT the indefensible Jun 5.
  assert.equal(LAST_SAFE_ORDER_DATE_2026, '2026-06-01');
  assert.equal(DIGITAL_ORDER_CUTOFF_2026, '2026-06-17');
});

test('comfortable tier: well before the safe date', () => {
  const c = getFathersDayCountdown(at('2026-05-18'));
  assert.equal(c.tier, 'comfortable');
  assert.equal(c.daysUntilSafeOrderDate, 14);
  assert.equal(c.daysUntilFathersDay, 34);
  assert.match(c.badgeCopy, /Order by/);
  assert.match(c.badgeCopy, /best chance/);
  assert.doesNotMatch(c.badgeCopy, /guaranteed/i);
});

test('tightening tier: 4–9 days out', () => {
  const c = getFathersDayCountdown(at('2026-05-26'));
  assert.equal(c.tier, 'tightening');
  assert.equal(c.daysUntilSafeOrderDate, 6);
  assert.match(c.badgeCopy, /Order by/);
});

test('last-call tier: 1–3 days out', () => {
  const c = getFathersDayCountdown(at('2026-05-30'));
  assert.equal(c.tier, 'last-call');
  assert.equal(c.daysUntilSafeOrderDate, 2);
  assert.match(c.badgeCopy, /Last/);
  assert.match(c.badgeCopy, /best chance/);
});

test('final-hours tier: today is the safe date', () => {
  const c = getFathersDayCountdown(at('2026-06-01'));
  assert.equal(c.tier, 'final-hours');
  assert.equal(c.daysUntilSafeOrderDate, 0);
});

test('today (2026-06-02) is already digital-only: no print-by-FD implication', () => {
  // Live trust-safe state: conservative print cut has passed, so the badge
  // must pivot to digital and never imply a printed book still makes it.
  const c = getFathersDayCountdown(at('2026-06-02'));
  assert.equal(c.tier, 'digital-only');
  assert.doesNotMatch(c.badgeCopy, /Order by .*best chance/);
});

test('digital-only tier: past safe date, Father\'s Day not yet', () => {
  const c = getFathersDayCountdown(at('2026-06-10'));
  assert.equal(c.tier, 'digital-only');
  assert.match(c.badgeCopy, /Digital PDF/);
  // Surfaces the digital order-by date (Jun 17), not a print promise.
  assert.match(c.badgeCopy, /Jun 17/);
  assert.equal(c.digitalOrderByLabel, 'Wed, Jun 17');
  assert.doesNotMatch(c.badgeCopy, /guaranteed/i);
});

test('past-event tier: after Father\'s Day, no badge copy', () => {
  const c = getFathersDayCountdown(at('2026-06-22'));
  assert.equal(c.tier, 'past-event');
  assert.equal(c.badgeCopy, '');
});

test('honest copy: never promises specific delivery', () => {
  for (const day of ['2026-05-18', '2026-05-26', '2026-05-30', '2026-06-01', '2026-06-02', '2026-06-10']) {
    const c = getFathersDayCountdown(at(day));
    assert.doesNotMatch(c.badgeCopy, /guaranteed|definitely|certain|promise/i);
  }
});

test('offer copy leads digital-first', () => {
  // Digital must be the lead pick, framed as same-day-after-approval / no shipping risk.
  assert.match(FATHERS_DAY_OFFER.digitalLead, /Digital PDF/);
  assert.match(FATHERS_DAY_OFFER.digitalLead, /no printing or shipping/i);
  assert.match(FATHERS_DAY_OFFER.digitalLead, /no carrier timing risk/i);
  // CTA routes straight to the digital format at checkout.
  assert.match(FATHERS_DAY_OFFER.ctaHref, /format=digital/);
});

test('offer frames print as optional and never promised by Father\'s Day', () => {
  assert.match(FATHERS_DAY_OFFER.printOptional, /optional/i);
  // Must explicitly decline to promise a printed book by the holiday.
  assert.match(FATHERS_DAY_OFFER.printOptional, /don'?t promise/i);
});

test('offer copy avoids guarantees and likeness promises', () => {
  const fields = [
    FATHERS_DAY_OFFER.headline,
    FATHERS_DAY_OFFER.digitalLead,
    FATHERS_DAY_OFFER.printOptional,
    FATHERS_DAY_OFFER.proofNote,
  ];
  for (const f of fields) {
    assert.doesNotMatch(f, /guarantee|guaranteed|definitely|certain/i);
    assert.doesNotMatch(f, /exact likeness|perfect likeness|looks exactly like/i);
  }
});
