/**
 * Proof-turnaround consistency (Alexy authoritative decision 2026-07-26):
 * proofs are usually ready in "2–3 business days" EVERYWHERE — checkout, public
 * pages, gift pages, thank-you, order records, confirmation email, and status.
 * Do NOT tighten the customer commitment to 2 days.
 *
 * Behavioral coverage (real function calls, not just source text) for order
 * creation + confirmation email, plus a bounded source regression that catches
 * active public surfaces drifting back to a 2-day promise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildDeliveryExpectation, createOrderRecord } from '../src/lib/orders.ts';
import { buildOrderConfirmationEmail } from '../src/lib/order-email.ts';
import { PROOF_TURNAROUND_WINDOW, PROOF_TURNAROUND_PHRASE } from '../src/lib/proof-turnaround.ts';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const TWO_THREE = /2–3 business days/;
const TWO_DAY_PROMISE = /(within|in)\s+2 business days/i; // the disallowed tightened promise

test('authoritative constant is the 2–3 business day window', () => {
  assert.equal(PROOF_TURNAROUND_WINDOW, '2–3 business days');
  assert.match(PROOF_TURNAROUND_PHRASE, /usually ready in 2–3 business days/);
});

// ── Behavioral: order record + delivery expectation ──────────────────────────
test('buildDeliveryExpectation uses 2–3 business days for every format, never a 2-day promise', () => {
  for (const format of ['digital', 'classic', 'premium']) {
    const v = buildDeliveryExpectation(format);
    assert.match(v, TWO_THREE, `${format} must say 2–3 business days`);
    assert.doesNotMatch(v, TWO_DAY_PROMISE, `${format} must not tighten to 2 days`);
  }
  // Exact digital contract preserved.
  assert.equal(buildDeliveryExpectation('digital'), 'Digital proof usually ready in 2–3 business days; final PDF delivered after approval.');
});

test('createOrderRecord persists the 2–3 business day expectation', () => {
  for (const bookFormat of ['digital', 'classic', 'premium']) {
    const rec = createOrderRecord({ childName: 'Milo', bookFormat, email: 'p@example.com' }, { id: `ord_${bookFormat}` });
    assert.match(rec.deliveryExpectation, TWO_THREE);
    assert.doesNotMatch(rec.deliveryExpectation, TWO_DAY_PROMISE);
  }
});

// ── Behavioral: confirmation email HTML + text ───────────────────────────────
test('buildOrderConfirmationEmail HTML and text carry 2–3 business days, never a 2-day promise', () => {
  for (const bookFormat of ['digital', 'classic', 'premium']) {
    const order = createOrderRecord({ childName: 'Ava', bookFormat, email: 'a@example.com' }, { id: `ord_email_${bookFormat}` });
    const email = buildOrderConfirmationEmail(order);
    assert.match(email.html, TWO_THREE, `${bookFormat} email HTML must say 2–3 business days`);
    assert.match(email.text, TWO_THREE, `${bookFormat} email text must say 2–3 business days`);
    assert.doesNotMatch(email.html, TWO_DAY_PROMISE, `${bookFormat} email HTML must not tighten to 2 days`);
    assert.doesNotMatch(email.text, TWO_DAY_PROMISE, `${bookFormat} email text must not tighten to 2 days`);
    // The persisted expectation is the source of truth surfaced in the email.
    assert.ok(email.html.includes(order.deliveryExpectation));
    assert.ok(email.text.includes(order.deliveryExpectation));
  }
});

// ── Behavioral: status output preserves the persisted expectation ────────────
test('customer status output echoes the persisted delivery expectation (no hardcoded 2-day promise)', () => {
  const statusSrc = read('src/app/status/[orderId]/page.tsx');
  assert.match(statusSrc, /order\.deliveryExpectation/, 'status must render the persisted expectation');
  assert.doesNotMatch(statusSrc, TWO_DAY_PROMISE, 'status must not hardcode a 2-day promise');
});

// ── Source regression: active public surfaces must not promise 2 days ─────────
const PUBLIC_SURFACES: Array<[string, string]> = [
  ['home/editorial', 'src/components/editorial-site.tsx'],
  ['landing pricing', 'src/components/landing/Pricing.tsx'],
  ['landing FAQ', 'src/components/landing/FAQ.tsx'],
  ['checkout', 'src/app/checkout/checkout-form.tsx'],
  ['gift detail', 'src/app/gifts/[occasion]/page.tsx'],
  ['gift index', 'src/app/gifts/page.tsx'],
  ['thank-you', 'src/app/thank-you/page.tsx'],
  ["father's day", 'src/lib/fathers-day.ts'],
  ['pricing lib', 'src/lib/pricing.ts'],
];

test('no active public surface promises "within 2 business days" (anti-tighten regression)', () => {
  for (const [label, path] of PUBLIC_SURFACES) {
    assert.doesNotMatch(read(path), TWO_DAY_PROMISE, `${label} (${path}) must not promise a 2-day proof window`);
  }
});

test('the lib delivery/email layer is single-sourced through the shared constant', () => {
  // Drift-proofing: the authoritative behavioral strings derive from the constant.
  assert.match(read('src/lib/orders.ts'), /PROOF_TURNAROUND/);
  assert.match(read('src/lib/order-email.ts'), /PROOF_TURNAROUND/);
});
