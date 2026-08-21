/**
 * Read-time normalization of persisted `deliveryExpectation`.
 *
 * `buildDeliveryExpectation` is copied onto every order at creation, so orders
 * created before the digital-timing repair still carry text we now know is
 * false. Rex flagged this (HSB-PERSIST-1): status and the confirmation email
 * echo that stored field, so old customers would keep seeing — and resending —
 * the old promise.
 *
 * The contract here is deliberately the smallest thing that fixes it:
 *   - stored bytes are never rewritten, and nothing writes to any store;
 *   - only the exact deprecated digital strings are swapped, and that set is
 *     proven from this file's own git history;
 *   - current values, print values, and anything unrecognized pass through;
 *   - missing/invalid input yields '' so a surface says nothing rather than
 *     guessing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildDeliveryExpectation,
  createOrderRecord,
  renderDeliveryExpectation,
  type OrderRecord,
} from '../src/lib/orders.ts';
import { buildOrderConfirmationEmail } from '../src/lib/order-email.ts';

/** The two values this codebase has actually persisted and since retired. */
const LEGACY_AFTER_APPROVAL = 'Digital proof usually ready in 2–3 business days; final PDF delivered after approval.';
const LEGACY_FIFTEEN_MINUTES = 'PDF by email in ~15 minutes';

const CURRENT_DIGITAL = buildDeliveryExpectation('digital');

// ── The contract ────────────────────────────────────────────────────────────

test('legacy digital expectations normalize to the current truthful value', () => {
  for (const legacy of [LEGACY_AFTER_APPROVAL, LEGACY_FIFTEEN_MINUTES]) {
    assert.equal(renderDeliveryExpectation(legacy), CURRENT_DIGITAL, `must normalize: ${legacy}`);
    assert.doesNotMatch(renderDeliveryExpectation(legacy), /after approval/i);
    assert.doesNotMatch(renderDeliveryExpectation(legacy), /15 minutes/i);
  }
});

test('surrounding whitespace does not defeat normalization', () => {
  assert.equal(renderDeliveryExpectation(`  ${LEGACY_AFTER_APPROVAL}  `), CURRENT_DIGITAL);
});

test('current digital, classic, and premium values pass through byte-identical', () => {
  for (const format of ['digital', 'classic', 'premium']) {
    const current = buildDeliveryExpectation(format);
    assert.equal(renderDeliveryExpectation(current), current, `${format} must pass through unchanged`);
  }
});

test('print expectations are never rewritten, even mentioning approval', () => {
  for (const format of ['classic', 'premium']) {
    const value = buildDeliveryExpectation(format);
    assert.match(value, /After approval,[^.]*ships/i, `${format} legitimately ties shipping to approval`);
    assert.equal(renderDeliveryExpectation(value), value);
  }
});

test('unknown or custom values pass through untouched', () => {
  for (const custom of [
    'Concierge timeline agreed by email.',
    'Digital proof usually ready in 2-3 business days; final PDF delivered after approval.', // hyphen, not en dash
    'final PDF delivered after approval.',
    'anything at all',
  ]) {
    assert.equal(renderDeliveryExpectation(custom), custom, `must not touch: ${custom}`);
  }
});

test('missing or invalid values fail closed to an empty string', () => {
  for (const missing of [null, undefined, 42 as unknown as string, {} as unknown as string]) {
    assert.equal(renderDeliveryExpectation(missing), '', 'must render nothing rather than invent copy');
  }
});

// ── It does not mutate the record ───────────────────────────────────────────

test('normalizing does not rewrite the stored record', () => {
  const order = {
    ...createOrderRecord({ childName: 'Ada', bookFormat: 'digital', email: 'ada@example.com' }, { id: 'ord_legacy' }),
    deliveryExpectation: LEGACY_AFTER_APPROVAL,
  } as OrderRecord;
  const before = JSON.stringify(order);
  const rendered = renderDeliveryExpectation(order.deliveryExpectation);

  assert.equal(rendered, CURRENT_DIGITAL, 'the rendered value is corrected');
  assert.equal(order.deliveryExpectation, LEGACY_AFTER_APPROVAL, 'the stored field is untouched');
  assert.equal(JSON.stringify(order), before, 'no field of the record changed');
});

// ── The customer-rendered surfaces use it ───────────────────────────────────

test('the confirmation email renders the normalized value in HTML and text', () => {
  const order = {
    ...createOrderRecord({ childName: 'Nia', bookFormat: 'digital', email: 'nia@example.com' }, { id: 'ord_legacy_email' }),
    deliveryExpectation: LEGACY_AFTER_APPROVAL,
  } as OrderRecord;
  const email = buildOrderConfirmationEmail(order, { supportEmail: 'support@herostorybooks.com' });

  for (const channel of [email.html, email.text] as const) {
    assert.ok(channel.includes(CURRENT_DIGITAL), 'must show the corrected expectation');
    assert.ok(!channel.includes('final PDF delivered after approval'), 'must not resend the old promise');
  }
  assert.equal(order.deliveryExpectation, LEGACY_AFTER_APPROVAL, 'still no mutation');
});

test('the status page renders through the normalizer', () => {
  const src = readFileSync('src/app/status/[orderId]/page.tsx', 'utf8');
  assert.match(src, /renderDeliveryExpectation\(order\.deliveryExpectation\)/);
});

test('internal admin/diagnostic exports keep the raw stored bytes', () => {
  // /api/order/[orderId] is gated on x-hsb-order-admin-key: it is evidence, not
  // customer copy, so it must NOT be silently normalized.
  const src = readFileSync('src/app/api/order/[orderId]/route.ts', 'utf8');
  assert.match(src, /x-hsb-order-admin-key/, 'route is admin-gated');
  assert.match(src, /deliveryExpectation: order\.deliveryExpectation/, 'admin export stays raw');
  assert.doesNotMatch(src, /renderDeliveryExpectation/, 'admin export must not normalize');
});

test('nothing in the normalizer path writes to a store', () => {
  const src = readFileSync('src/lib/orders.ts', 'utf8');
  const fn = src.slice(src.indexOf('export function renderDeliveryExpectation'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  for (const writer of ['persistOrder', 'writeFile', 'withOrderTransaction', 'put(', 'await ']) {
    assert.ok(!body.includes(writer), `normalizer must be pure — found ${writer}`);
  }
});
