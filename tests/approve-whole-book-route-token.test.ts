import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROUTE_SRC = readFileSync('src/app/api/order/[orderId]/approve-whole-book/route.ts', 'utf8');
const REVIEW_CLIENT_SRC = readFileSync('src/app/review/[orderId]/review-client.tsx', 'utf8');

test('approve-whole-book route requires an order-bound review token before calling approveWholeBook', () => {
  assert.match(ROUTE_SRC, /getOrder|hasReviewAccess|proofApprovalToken|reviewToken|timingSafeEqual/, 'route must load/verify the order-bound proof token');
  assert.match(ROUTE_SRC, /request\.json\(|searchParams|get\('x-hsb-proof-token'\)/, 'route must read a token from body, query, or header');
  assert.match(ROUTE_SRC, /401|403/, 'route must return an auth-style refusal for missing/wrong token');
  assert.ok(
    ROUTE_SRC.indexOf('approveWholeBook(orderId)') === -1 || ROUTE_SRC.indexOf('approveWholeBook(orderId)') > ROUTE_SRC.indexOf('hasReviewAccess'),
    'route must not call approveWholeBook(orderId) directly before access validation',
  );
});

test('review client sends the current proof token when approving the whole book', () => {
  assert.match(REVIEW_CLIENT_SRC, /URLSearchParams\(window\.location\.search\)|window\.location\.search/, 'client must read token from the review URL');
  assert.match(REVIEW_CLIENT_SRC, /reviewToken|proofToken|token/, 'client must include token in approval request');
  assert.match(REVIEW_CLIENT_SRC, /JSON\.stringify|headers:\s*\{[^}]*Content-Type/s, 'client should send token in a structured POST body');
});
