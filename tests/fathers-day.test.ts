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
  SOFTCOVER_BEST_CHANCE_DATE_2026,
  DIGITAL_SAFE_CUTOFF_DATE_2026,
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

test('offer copy avoids hard delivery promises and likeness promises', () => {
  // Per the 2026-06-01 ops update, the per-format timing block is
  // ALLOWED to mention the softcover Jun 5 best-chance window and the
  // digital Jun 18 safe-delivery cutoff explicitly. The fields below
  // are the headline/lead/print-positioning/proof fields — they must
  // continue to avoid hard delivery promises. The dedicated timing
  // fields are checked separately and are permitted to surface dates
  // in a non-promising "best chance" framing.
  const fields = [
    FATHERS_DAY_OFFER.headline,
    FATHERS_DAY_OFFER.digitalLead,
    FATHERS_DAY_OFFER.printOptional,
    FATHERS_DAY_OFFER.proofNote,
  ];
  for (const f of fields) {
    // Bare "guarantee" is allowed only in negation copy
    // ("not guarantees"); these prose fields must still not contain
    // the promise-sounding word at all.
    assert.doesNotMatch(f, /guarantee|guaranteed|definitely|certain/i);
    assert.doesNotMatch(f, /exact likeness|perfect likeness|looks exactly like/i);
    // Specific forbidden phrases. Jun 5 / Jun 18 alone are NOT
    // forbidden — those land in the per-format timing fields below —
    // but a generic "Order by Jun 5" line that conflates hardcover is.
    assert.doesNotMatch(f, /order by jun 5|order by june 5/i);
    assert.doesNotMatch(f, /guaranteed by Father.?s Day/i);
  }
});

test('per-format timing fields exist with correct date framing', () => {
  // Dates are pinned as exported constants so the timing copy and any
  // future tier-change logic agree on the same source-of-truth.
  assert.equal(SOFTCOVER_BEST_CHANCE_DATE_2026, '2026-06-05');
  assert.equal(DIGITAL_SAFE_CUTOFF_DATE_2026, '2026-06-18');

  // Digital: explicit safe-delivery cutoff is acceptable as a date
  // ("by Jun 18") because there is no shipping step after approval.
  assert.match(FATHERS_DAY_OFFER.digitalTiming, /digital/i);
  assert.match(FATHERS_DAY_OFFER.digitalTiming, /jun 18|june 18/i);
  assert.doesNotMatch(FATHERS_DAY_OFFER.digitalTiming, /guaranteed/i);

  // Softcover: Jun 5 must be framed as a best-chance window, never as
  // a deadline / order-by promise / guarantee.
  assert.match(FATHERS_DAY_OFFER.softcoverTiming, /softcover/i);
  assert.match(FATHERS_DAY_OFFER.softcoverTiming, /jun 5|june 5/i);
  assert.match(FATHERS_DAY_OFFER.softcoverTiming, /best chance|best-chance/i);
  assert.doesNotMatch(FATHERS_DAY_OFFER.softcoverTiming, /order by jun 5|order by june 5/i);
  // Forbid affirmative deadline / guarantee phrasings only. Negation
  // copy like "Not a deadline" or "no guarantee" is required and must
  // pass.
  assert.doesNotMatch(FATHERS_DAY_OFFER.softcoverTiming, /hard deadline|is the deadline|deadline of jun|guaranteed by/i);

  // Hardcover: framed as a follow-up / post-holiday keepsake. Must NOT
  // appear in any "order by Jun 5" / "order by date" copy.
  assert.match(FATHERS_DAY_OFFER.hardcoverTiming, /hardcover/i);
  assert.match(FATHERS_DAY_OFFER.hardcoverTiming, /post-holiday|after Father.?s Day|follow-up keepsake/i);
  assert.doesNotMatch(FATHERS_DAY_OFFER.hardcoverTiming, /jun 5|june 5/i);
  assert.doesNotMatch(FATHERS_DAY_OFFER.hardcoverTiming, /guaranteed/i);
});

test('shipping-estimates disclaimer + proof-before-print disclaimer are present', () => {
  // Required by ops — every surface that shows per-format timing must
  // also carry these two disclaimers.
  assert.match(FATHERS_DAY_OFFER.shippingDisclaimer, /shipping dates are estimates/i);
  assert.match(FATHERS_DAY_OFFER.shippingDisclaimer, /not guarantees/i);
  assert.match(FATHERS_DAY_OFFER.proofBeforePrint, /proof/i);
  assert.match(FATHERS_DAY_OFFER.proofBeforePrint, /approve/i);
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

  // Best-chance language is now delegated to FATHERS_DAY_OFFER fields
  // (softcoverTiming) rather than baked inline. The per-format trio
  // test asserts that checkout renders those fields; that's the
  // stronger guarantee.
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
  // Specific forbidden phrasings only. Jun 5 / Jun 18 alone are
  // ALLOWED in the per-format timing block (softcover best chance /
  // digital safe cutoff); the bare "order by" framing is forbidden
  // because it implies a hardcover-applicable deadline.
  assert.doesNotMatch(source, /order-by date|order by jun 5|order by june 5/i);
  assert.doesNotMatch(source, /guaranteed by Father.?s Day/i);
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
    // Bare "Jun 5" is now permitted in the softcover best-chance
    // timing copy. Only the "Order by Jun 5" / "Order by June 5"
    // framings remain forbidden because they imply a deadline that
    // would apply to hardcover too.
    assert.doesNotMatch(source, /Order by Jun 5|Order by June 5/i);
    assert.doesNotMatch(source, /guaranteed by Father.?s Day/i);
  }
});

test('editorial-site, checkout, pricing surfaces all carry the per-format timing trio (digital Jun 18 / softcover best-chance / hardcover post-holiday) + shipping-estimates disclaimer', () => {
  // The four routes the operator update covers (/, /checkout,
  // /pricing, /fathers-day) all render through these three files.
  // EditorialHomePage, EditorialPricingPage, and EditorialFathersDayPage
  // share SeasonalCallout — checking the SeasonalCallout source covers
  // all three landing/marketing routes. The checkout-form file covers
  // /checkout.
  const editorial = readFileSync('src/components/editorial-site.tsx', 'utf8');
  const checkout = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

  for (const [name, source] of [['editorial-site', editorial], ['checkout-form', checkout]] as const) {
    // Per-format trio must all surface.
    assert.match(source, /digitalTiming/, `${name}: must render FATHERS_DAY_OFFER.digitalTiming`);
    assert.match(source, /softcoverTiming/, `${name}: must render FATHERS_DAY_OFFER.softcoverTiming`);
    assert.match(source, /hardcoverTiming/, `${name}: must render FATHERS_DAY_OFFER.hardcoverTiming`);
    // Shipping-estimates disclaimer is required wherever per-format
    // timing surfaces, so the operator promise stays calibrated.
    assert.match(source, /shippingDisclaimer/, `${name}: must render FATHERS_DAY_OFFER.shippingDisclaimer`);
    // Hardcover must NOT appear in any "Order by Jun 5" line.
    assert.doesNotMatch(source, /Order by Jun 5[^.]*hardcover/i, `${name}: hardcover must not be folded into an order-by-Jun-5 line`);
  }
});

test('pricing-card subtitles (lib/pricing.ts + landing/Pricing.tsx) do not bake in stale FD timing promises', () => {
  // The pricing tier lists must not carry their own competing
  // FD-timing claims — the SeasonalCallout block is the single source
  // of truth. The Pricing component / lib copy is permitted to say
  // "Safest late-window Father's Day option" (existing approved copy)
  // because that frames timing relative to the safest cutoff without
  // promising delivery on any specific date.
  const pricingLib = readFileSync('src/lib/pricing.ts', 'utf8');
  const pricingComp = readFileSync('src/components/landing/Pricing.tsx', 'utf8');
  for (const src of [pricingLib, pricingComp]) {
    assert.doesNotMatch(src, /guaranteed by Father.?s Day/i);
    assert.doesNotMatch(src, /order by jun 5|order by june 5/i);
    assert.doesNotMatch(src, /Hardcover arrives by Father.?s Day/i);
  }
});
