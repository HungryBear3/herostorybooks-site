/**
 * Tests for scripts/verify-paid-order-safety.ts.
 *
 * The Stripe/store I/O is hard to exercise hermetically, so we unit-test the
 * pure classifiers that decide GREEN/YELLOW/RED, redaction, stale-copy scan,
 * and custom-brief detection. The script guards its CLI entry behind an
 * import.meta check, so importing it here runs no network/store calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICT,
  rollupVerdict,
  redactId,
  scanStaleCopy,
  detectCustomStoryBrief,
  evaluatePaidOrderSafety,
  buildReport,
  formatReport,
  parseArgs,
  STALE_COPY_PATTERNS,
} from '../scripts/verify-paid-order-safety.ts';
import type { SafetyInputs, StripeFacts } from '../scripts/verify-paid-order-safety.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

// Baseline: the live Lukas order — paid, held, no artifacts, stale copy, no brief.
function heldPaidInputs(overrides: Partial<SafetyInputs> = {}): SafetyInputs {
  return {
    orderFound: true,
    bookFormat: 'digital',
    appPaymentStatus: 'paid',
    stripePaid: true,
    hasStoryArtifact: false,
    pageArtifactCount: 0,
    proofReady: false,
    printJobId: null,
    printInteriorArtifactUrl: null,
    printCoverArtifactUrl: null,
    fulfillmentStatus: 'not_started',
    customStoryBriefPresent: true,
    staleCopyHits: [],
    printGo: false,
    artifactsIntended: false,
    ...overrides,
  };
}

// ── rollupVerdict ──────────────────────────────────────────────────────────

test('rollupVerdict picks the most severe', () => {
  assert.equal(rollupVerdict([]), VERDICT.GREEN);
  assert.equal(rollupVerdict([VERDICT.GREEN, VERDICT.YELLOW]), VERDICT.YELLOW);
  assert.equal(rollupVerdict([VERDICT.YELLOW, VERDICT.RED, VERDICT.GREEN]), VERDICT.RED);
});

// ── redactId ───────────────────────────────────────────────────────────────

test('redactId keeps type prefix + suffix, hides the middle', () => {
  const out = redactId('cs_live_b1qlIgZ9H1LE5ffriQ5UsJDmhpyVWtJaCd51qEOZ13yT4IDq5dn6b0ehf4');
  assert.match(out, /^cs_live_…/);
  assert.match(out, /b0ehf4$/);
  assert.ok(!out.includes('mhpyVWtJa'), 'middle of the id must not be printed');
  assert.equal(redactId(null), '(none)');
  assert.equal(redactId(''), '(none)');
});

test('redactId handles ord_/pi_ ids', () => {
  assert.match(redactId('ord_2ecc3480df0044ba'), /^ord_…/);
  assert.match(redactId('pi_3AbCdEfghijkLMno'), /^pi_…/);
});

// ── scanStaleCopy ──────────────────────────────────────────────────────────

test('scanStaleCopy flags instant + 15-minute promises', () => {
  const hits = scanStaleCopy([
    { field: 'order.deliveryExpectation', value: 'PDF by email in ~15 minutes' },
    { field: 'stripe.lineItem.name', value: 'Digital instant HeroStoryBook' },
    { field: 'order.formatLabel', value: 'Classic Softcover' },
    { field: 'empty', value: null },
  ]);
  const fields = hits.map((h) => h.field);
  assert.ok(fields.includes('order.deliveryExpectation'));
  assert.ok(fields.includes('stripe.lineItem.name'));
  assert.ok(!fields.includes('order.formatLabel'), 'clean copy must not flag');
  assert.ok(!fields.includes('empty'));
});

test('current fulfillment copy is NOT flagged as stale', () => {
  const hits = scanStaleCopy([
    { field: 'order.deliveryExpectation', value: 'Digital proof usually ready within 2 business days; final PDF delivered after approval.' },
  ]);
  assert.equal(hits.length, 0);
});

test('STALE_COPY_PATTERNS are all valid regexes', () => {
  for (const p of STALE_COPY_PATTERNS) {
    assert.ok(p.re instanceof RegExp);
    assert.ok(p.id && p.note);
  }
});

// ── detectCustomStoryBrief ─────────────────────────────────────────────────

test('detectCustomStoryBrief: absent when field missing', () => {
  const order = { id: 'ord_x', childName: 'A' } as unknown as OrderRecord;
  const info = detectCustomStoryBrief(order);
  assert.equal(info.present, false);
  assert.equal(info.keys.length, 0);
});

test('detectCustomStoryBrief: present returns top-level keys only', () => {
  const order = {
    id: 'ord_x',
    customStoryBrief: { theme: 'secret private text here', memory: 'more private text', tone: 'warm' },
  } as unknown as OrderRecord;
  const info = detectCustomStoryBrief(order);
  assert.equal(info.present, true);
  assert.equal(info.source, 'customStoryBrief');
  assert.deepEqual(info.keys.sort(), ['memory', 'theme', 'tone']);
  // keys only — never the private values
  assert.ok(!JSON.stringify(info).includes('secret private text'));
});

// ── evaluatePaidOrderSafety ────────────────────────────────────────────────

test('paid + held + no artifacts + brief present + clean copy = YELLOW held', () => {
  const e = evaluatePaidOrderSafety(heldPaidInputs());
  assert.equal(e.verdict, VERDICT.YELLOW);
  assert.ok(e.labels.includes('controlled-payment-ok / fulfillment-held'));
  assert.equal(e.blockers.length, 0);
});

test('the live Lukas posture: stale copy + missing brief = YELLOW with both drift labels', () => {
  const e = evaluatePaidOrderSafety(
    heldPaidInputs({
      customStoryBriefPresent: false,
      staleCopyHits: [{ field: 'order.deliveryExpectation', patternId: '15-minutes', note: 'x', excerpt: 'y' }],
    }),
  );
  assert.equal(e.verdict, VERDICT.YELLOW);
  assert.ok(e.labels.includes('copy drift'));
  assert.ok(e.labels.includes('intake drift'));
  assert.equal(e.blockers.length, 0);
  assert.equal(e.followUps.length, 2);
});

test('missing app order but Stripe paid = RED', () => {
  const e = evaluatePaidOrderSafety(heldPaidInputs({ orderFound: false, stripePaid: true }));
  assert.equal(e.verdict, VERDICT.RED);
  assert.ok(e.blockers.some((b) => /no app order/i.test(b)));
});

test('order not found and Stripe unknown = RED (cannot verify)', () => {
  const e = evaluatePaidOrderSafety(heldPaidInputs({ orderFound: false, stripePaid: null }));
  assert.equal(e.verdict, VERDICT.RED);
  assert.ok(e.blockers.some((b) => /not found/i.test(b)));
});

test('unexpected proof/story/page artifacts = RED unsafe side effect', () => {
  const e = evaluatePaidOrderSafety(heldPaidInputs({ hasStoryArtifact: true, pageArtifactCount: 24, proofReady: true }));
  assert.equal(e.verdict, VERDICT.RED);
  assert.ok(e.unsafeSideEffects.length >= 1);
  assert.ok(e.labels.includes('unsafe-side-effects'));
});

test('artifactsIntended flag downgrades artifact side effects out of RED', () => {
  const e = evaluatePaidOrderSafety(
    heldPaidInputs({ hasStoryArtifact: true, pageArtifactCount: 24, artifactsIntended: true }),
  );
  assert.notEqual(e.verdict, VERDICT.RED);
});

test('print job present = RED unless print-go', () => {
  const red = evaluatePaidOrderSafety(heldPaidInputs({ printJobId: 'job_123' }));
  assert.equal(red.verdict, VERDICT.RED);
  assert.ok(red.unsafeSideEffects.some((s) => /print/i.test(s)));

  const ok = evaluatePaidOrderSafety(heldPaidInputs({ printJobId: 'job_123', printGo: true }));
  assert.notEqual(ok.verdict, VERDICT.RED);
});

test('Stripe paid but app not paid = RED mismatch', () => {
  const e = evaluatePaidOrderSafety(heldPaidInputs({ appPaymentStatus: 'pending', stripePaid: true }));
  assert.equal(e.verdict, VERDICT.RED);
  assert.ok(e.blockers.some((b) => /webhook/i.test(b)));
});

test('app not paid, stripe unknown = YELLOW payment-not-confirmed (not RED)', () => {
  const e = evaluatePaidOrderSafety(heldPaidInputs({ appPaymentStatus: 'pending', stripePaid: null }));
  assert.equal(e.verdict, VERDICT.YELLOW);
  assert.ok(e.labels.includes('payment-not-confirmed'));
});

// ── parseArgs ──────────────────────────────────────────────────────────────

test('parseArgs handles space and = forms', () => {
  assert.equal(parseArgs(['--order-id', 'ord_1']).orderId, 'ord_1');
  assert.equal(parseArgs(['--order-id=ord_2']).orderId, 'ord_2');
  assert.equal(parseArgs(['--email', 'A@B.com']).email, 'a@b.com');
  assert.equal(parseArgs(['--stripe-session', 'cs_live_x']).stripeSession, 'cs_live_x');
  assert.equal(parseArgs(['--json']).json, true);
  assert.equal(parseArgs(['--print-go']).printGo, true);
  assert.equal(parseArgs(['--artifacts-intended']).artifactsIntended, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('buildReport + formatReport include normal-checkout tracking without raw order dump', () => {
  const stripe: StripeFacts = {
    available: true,
    reason: null,
    sessionId: 'cs_live_trackingtest123456',
    sessionStatus: 'complete',
    paymentStatus: 'paid',
    amountTotal: 0,
    amountSubtotal: 1900,
    amountDiscount: 1900,
    currency: 'usd',
    promoEvidence: ['discount amount=1900 promo=promo_…abcdef'],
    paymentIntentId: 'pi_trackingtest123456',
    paymentIntentStatus: 'succeeded',
    chargePaid: true,
    amountCaptured: 0,
    lineItemDescriptions: [],
    metadataKeys: ['orderId', 'cohort', 'invite'],
    metadataTracking: { cohort: 'ff-beta', invite: 'alexfriend01' },
    webhook: null,
  };
  const report = buildReport(
    { orderId: 'ord_track', email: null, stripeSession: null, json: false, help: false, printGo: false, artifactsIntended: false },
    {
      matchedBy: 'order-id',
      candidates: 1,
      order: {
        id: 'ord_track',
        childName: 'Mia',
        email: 'mia@example.com',
        bookFormat: 'digital',
        formatLabel: 'Digital proof',
        priceCents: 1900,
        paymentStatus: 'paid',
        status: 'order_received',
        stripeSessionId: 'cs_live_trackingtest123456',
        checkoutTracking: { cohort: 'ff-beta', invite: 'alexfriend01' },
        createdAt: '2026-07-13T18:00:00Z',
        updatedAt: '2026-07-13T18:00:00Z',
      } as unknown as OrderRecord,
    },
    null,
    stripe,
  );

  assert.deepEqual(report.order.checkoutTracking, { cohort: 'ff-beta', invite: 'alexfriend01' });
  assert.deepEqual(report.stripe.metadataTracking, { cohort: 'ff-beta', invite: 'alexfriend01' });
  const text = formatReport(report);
  assert.match(text, /checkout track\s*: cohort=ff-beta invite=alexfriend01/);
  assert.match(text, /metadata track\s*: cohort=ff-beta invite=alexfriend01/);
});
