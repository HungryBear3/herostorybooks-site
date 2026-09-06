/**
 * Referrer containment for order-bearer customer surfaces.
 *
 * The defect these lock down:
 *
 *   `/thank-you?orderId=…&sessionId=…` carries operational identifiers
 *   in its URL, and `/status/<orderId>` treats the orderId in its path
 *   as bearer authority — it will render order status, book format,
 *   delivery expectation, tracking number/link, and customer actions to
 *   anyone holding the URL. Both received `X-Robots-Tag: noindex` and
 *   nothing else. noindex keeps a crawler from listing the URL; it does
 *   not stop the browser from putting that same URL in the `Referer`
 *   header of every outbound request the page makes, nor in
 *   `document.referrer` of anything the customer clicks through to.
 *   That is the leak, and `Referrer-Policy: no-referrer` is what closes
 *   it.
 *
 * Unlike the existing middleware tests, these assert the actual headers
 * the real middleware puts on a real request (see
 * tests/helpers/middleware-harness.mjs) rather than grepping the source,
 * because the question here is which pathname gets which header value.
 *
 * Everything is synthetic: fake order ids, no network, no store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { headersFor } from './helpers/middleware-harness.mjs';

const NOINDEX = 'noindex, nofollow, noarchive, nosnippet';
const PRIVATE_HEADERS = [
  'referrer-policy',
  'cache-control',
  'x-content-type-options',
  'x-robots-tag',
  'content-security-policy',
  'permissions-policy',
  'x-frame-options',
] as const;

/* ── 1. The two order-bearer customer documents ────────────────────── */

test('thank-you carrying orderId + sessionId is referrer-contained', () => {
  const h = headersFor('/thank-you?orderId=ord_synthetic1234&sessionId=cs_test_synthetic');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['x-robots-tag'], NOINDEX, 'existing noindex must survive');
});

test('bare thank-you is referrer-contained too', () => {
  const h = headersFor('/thank-you');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['x-robots-tag'], NOINDEX);
});

test('status page whose orderId is bearer authority is referrer-contained', () => {
  const h = headersFor('/status/ord_synthetic1234');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['x-robots-tag'], NOINDEX, 'existing noindex must survive');
});

/* ── 2. Hostile marker intent in the URL cannot shake containment ──── */

test('containment keys on the pathname, not on attacker-supplied markers', () => {
  const hostile = [
    '/status/ord_synthetic1234?utm_source=evil&ref=https%3A%2F%2Fattacker.example',
    '/status/ord_synthetic1234#/../../samples',
    '/thank-you?orderId=ord_synthetic1234#fragment-marker',
    '/thank-you?orderId=ord_synthetic1234&next=https%3A%2F%2Fattacker.example',
    '/status/ord_synthetic1234/',
  ];
  for (const url of hostile) {
    assert.equal(
      headersFor(url)['referrer-policy'],
      'no-referrer',
      `${url} must still be referrer-contained`,
    );
  }
});

test('a query string mentioning a contained path cannot contain a public page', () => {
  const h = headersFor('/samples?next=/status/ord_synthetic1234');
  assert.equal(h['referrer-policy'], undefined);
  assert.equal(h['x-robots-tag'], undefined);
});

test('containment stops at the path segment boundary', () => {
  for (const url of ['/status-updates', '/thank-you-notes']) {
    const h = headersFor(url);
    assert.equal(h['referrer-policy'], undefined, `${url} is not an order-bearer surface`);
    assert.equal(h['x-robots-tag'], undefined, `${url} is not an order-bearer surface`);
  }
});

/* ── 3. The stricter existing review privacy sets are preserved ────── */

test('customer review keeps its full, stricter private header set', () => {
  const h = headersFor('/review/ord_synthetic1234');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['x-robots-tag'], NOINDEX);
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['cache-control'], 'private, no-store, max-age=0');
});

test('order review APIs keep their full, stricter private header set', () => {
  for (const url of [
    '/api/order/ord_synthetic1234/review',
    '/api/order/ord_synthetic1234/review-session',
    '/api/order/ord_synthetic1234/review-asset/asset_synthetic',
  ]) {
    const h = headersFor(url);
    assert.equal(h['referrer-policy'], 'no-referrer', url);
    assert.equal(h['x-robots-tag'], NOINDEX, url);
    assert.equal(h['x-content-type-options'], 'nosniff', url);
    assert.equal(h['cache-control'], 'private, no-store, max-age=0', url);
  }
});

test('family review keeps its full, stricter private header set', () => {
  for (const url of [
    '/family-review/review/tok_synthetic',
    '/api/family-review/review/tok_synthetic',
  ]) {
    const h = headersFor(url);
    assert.equal(h['referrer-policy'], 'no-referrer', url);
    assert.equal(h['x-robots-tag'], NOINDEX, url);
    assert.equal(h['x-content-type-options'], 'nosniff', url);
    assert.equal(h['x-frame-options'], 'DENY', url);
    assert.equal(h['cache-control'], 'private, no-store, max-age=0', url);
    assert.match(h['permissions-policy'] ?? '', /camera=\(\)/, url);
    assert.match(h['content-security-policy'] ?? '', /frame-ancestors 'none'/, url);
  }
});

/* ── 4. Public routes stay public ──────────────────────────────────── */

test('public marketing routes are not noindexed, privatised, or no-stored', () => {
  for (const url of ['/', '/samples', '/about', '/gifts', '/gifts/birthdays', '/pricing', '/privacy', '/terms']) {
    const h = headersFor(url);
    for (const header of PRIVATE_HEADERS) {
      assert.equal(h[header], undefined, `${url} must not receive ${header}`);
    }
  }
});

test('containing thank-you and status does not add no-store or a CSP to them', () => {
  for (const url of ['/thank-you?orderId=ord_synthetic1234', '/status/ord_synthetic1234']) {
    const h = headersFor(url);
    assert.equal(h['cache-control'], undefined, `${url} caching behaviour must be unchanged`);
    assert.equal(h['content-security-policy'], undefined, `${url} must not gain a CSP`);
    assert.equal(h['x-frame-options'], undefined, `${url} framing behaviour must be unchanged`);
  }
});
