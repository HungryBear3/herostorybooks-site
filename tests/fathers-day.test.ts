/**
 * @jest-environment node
 *
 * Pure-function coverage for the Father's Day countdown helper.
 * Pins business-rule constants and the four urgency tiers so a future
 * date arithmetic mistake can't ship a misleading badge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  getFathersDayCountdown,
  FATHERS_DAY_2026,
  LAST_SAFE_ORDER_DATE_2026,
  FATHERS_DAY_OFFER,
} from '../src/lib/fathers-day.ts';

function at(iso: string): Date {
  return new Date(iso + 'T12:00:00Z');
}

test('constants pinned: Father\'s Day 2026 + conservative internal print cutoff', () => {
  assert.equal(FATHERS_DAY_2026, '2026-06-21');
  assert.equal(LAST_SAFE_ORDER_DATE_2026, '2026-06-01');
});

test('comfortable tier: well before the safe date', () => {
  const c = getFathersDayCountdown(at('2026-05-18'));
  assert.equal(c.tier, 'comfortable');
  assert.equal(c.daysUntilSafeOrderDate, 14);
  assert.equal(c.daysUntilFathersDay, 34);
  assert.doesNotMatch(c.badgeCopy, /Order by|Jun 5|June 5/i);
  assert.match(c.badgeCopy, /best chance/);
  assert.match(c.badgeCopy, /Digital PDF/i);
  assert.doesNotMatch(c.badgeCopy, /guaranteed/i);
});

test('tightening tier: 4–9 days out', () => {
  const c = getFathersDayCountdown(at('2026-05-24'));
  assert.equal(c.tier, 'tightening');
  assert.equal(c.daysUntilSafeOrderDate, 8);
  assert.doesNotMatch(c.badgeCopy, /Order by|Jun 5|June 5/i);
  assert.match(c.badgeCopy, /Digital PDF/i);
});

test('last-call tier: 1–3 days out', () => {
  const c = getFathersDayCountdown(at('2026-05-30'));
  assert.equal(c.tier, 'last-call');
  assert.equal(c.daysUntilSafeOrderDate, 2);
  assert.match(c.badgeCopy, /tight/i);
  assert.match(c.badgeCopy, /follow-up keepsake/i);
  assert.doesNotMatch(c.badgeCopy, /Order by|Jun 5|June 5/i);
});

test('final-hours tier: today is the safe date', () => {
  const c = getFathersDayCountdown(at('2026-06-01'));
  assert.equal(c.tier, 'final-hours');
  assert.equal(c.daysUntilSafeOrderDate, 0);
});

test('digital-only tier: past safe date, Father\'s Day not yet', () => {
  const c = getFathersDayCountdown(at('2026-06-10'));
  assert.equal(c.tier, 'digital-only');
  assert.match(c.badgeCopy, /Digital PDF/);
  assert.match(c.badgeCopy, /printed books can follow/i);
  assert.doesNotMatch(c.badgeCopy, /guaranteed/i);
});

test('past-event tier: after Father\'s Day, no badge copy', () => {
  const c = getFathersDayCountdown(at('2026-06-22'));
  assert.equal(c.tier, 'past-event');
  assert.equal(c.badgeCopy, '');
});

test('honest copy: never promises specific delivery or public cutoff dates', () => {
  for (const day of ['2026-05-18', '2026-05-30', '2026-06-01', '2026-06-05', '2026-06-10']) {
    const c = getFathersDayCountdown(at(day));
    assert.doesNotMatch(c.badgeCopy, /guaranteed|definitely|certain|promise/i);
    assert.doesNotMatch(c.badgeCopy, /Order by|Jun 5|June 5|June 1|Jun 1/i);
  }
});

test('offer copy leads proof-first keepsake positioning', () => {
  // Print remains the keepsake hero while the safe order window is open.
  assert.match(FATHERS_DAY_OFFER.headline, /story only your family/i);
  assert.match(FATHERS_DAY_OFFER.digitalLead, /personalized proof book/i);
  assert.match(FATHERS_DAY_OFFER.digitalLead, /proof/i);
  assert.match(FATHERS_DAY_OFFER.ctaHref, /checkout/);
});

test('offer frames digital as safest on-day gift and print as best-chance follow-up', () => {
  assert.match(FATHERS_DAY_OFFER.printOptional, /Digital/i);
  assert.match(FATHERS_DAY_OFFER.printOptional, /safest/i);
  assert.match(FATHERS_DAY_OFFER.printOptional, /best-chance/i);
  assert.match(FATHERS_DAY_OFFER.printOptional, /hardcover.*follow-up keepsake/i);
  assert.match(FATHERS_DAY_OFFER.printOptional, /digital/i);
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
    assert.doesNotMatch(f, /Jun 5|June 5|Order by/i);
  }
});

test('public Father\'s Day page metadata stays proof-first', () => {
  const source = readFileSync('src/app/fathers-day/page.tsx', 'utf8');

  assert.match(source, /proof book/i);
  assert.match(source, /Review every page first/i);
  assert.doesNotMatch(source, /Digital PDF is the safest Father.s Day route/i);
  assert.doesNotMatch(source, /guaranteed|same-day/i);
});

test('checkout Father\'s Day and photo copy avoids speed and AI marketing language', () => {
  const source = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

  assert.match(source, /Printed books are best chance only/i);
  assert.match(source, /Used only for your order/i);
  assert.doesNotMatch(source, /\$29\.99|\$49\.99|\$79\.99/i);
  assert.doesNotMatch(source, /15 minutes|~15/i);
  assert.doesNotMatch(source, /Digital PDF included/i);
  assert.doesNotMatch(source, /Mother.s Day Memory Book/i);
  assert.doesNotMatch(source, /same-day/i);
  assert.doesNotMatch(source, /AI places|Real AI output/i);
  assert.doesNotMatch(source, /AI-assisted illustration/i);
  assert.doesNotMatch(source, /satisfaction guarantee/i);
  assert.doesNotMatch(source, /train AI/i);
  assert.doesNotMatch(source, /order-by date|Jun 5|June 5/i);
});

test('public print pricing avoids unsupported included-digital promise', () => {
  const pricing = readFileSync('src/lib/pricing.ts', 'utf8');
  const landingPricing = readFileSync('src/components/landing/Pricing.tsx', 'utf8');
  const editorial = readFileSync('src/components/editorial-site.tsx', 'utf8');
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const landingFaq = readFileSync('src/components/landing/FAQ.tsx', 'utf8');
  const valueProp = readFileSync('src/components/landing/ValueProposition.tsx', 'utf8');
  const howItWorks = readFileSync('src/components/landing/HowItWorks.tsx', 'utf8');

  for (const source of [pricing, landingPricing, editorial, checkout, landingFaq, valueProp, howItWorks]) {
    assert.doesNotMatch(source, /Digital PDF included/i);
    assert.doesNotMatch(source, /included digital edition/i);
    assert.doesNotMatch(source, /PDF by email|15 minutes|just 10 minutes/i);
    assert.doesNotMatch(source, /satisfaction guarantee|7-day satisfaction/i);
    assert.doesNotMatch(source, /Ready for magic|magical story/i);
    assert.doesNotMatch(source, /best chance to arrive/i);
    assert.doesNotMatch(source, /Order by Jun 5|Jun 5/i);
  }
});
