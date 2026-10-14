/**
 * Source guards for the customer chooser surface (/upgrade/[orderId]) and the
 * middleware privacy headers it inherits. The chooser is a bearer surface:
 * the token lives in the URL fragment, is lifted into memory and scrubbed
 * from the address bar, and is only ever sent in a JSON body. The done page
 * renders from the persisted record through the PII-free status view.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CHOOSER_PAGE = 'src/app/upgrade/[orderId]/page.tsx';
const CHOOSER_CLIENT = 'src/app/upgrade/[orderId]/upgrade-client.tsx';
const DONE_PAGE = 'src/app/upgrade/[orderId]/done/page.tsx';
const CANCELLED_PAGE = 'src/app/upgrade/[orderId]/cancelled/page.tsx';

test('chooser page is noindex, dynamic, and never reads the token server-side', () => {
  const page = readFileSync(CHOOSER_PAGE, 'utf8');
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /export const dynamic = 'force-dynamic'/);
  assert.doesNotMatch(page, /searchParams|getOrder|childName|email/);
});

test('chooser client lifts the token from the fragment, scrubs the URL, and posts it only in JSON bodies', () => {
  const client = readFileSync(CHOOSER_CLIENT, 'utf8');
  assert.match(client, /^'use client';/);
  assert.match(client, /window\.location\.hash/);
  assert.match(client, /history\.replaceState\(/);
  assert.doesNotMatch(client, /[?&]token=/);
  for (const endpoint of ['print-upgrade/offer', 'print-upgrade/quote', 'print-upgrade/checkout']) {
    assert.ok(client.includes(endpoint), `calls ${endpoint}`);
  }
  assert.match(client, /body: JSON\.stringify\(body\)/);
  assert.match(client, /\{ token: presented \}/);
  assert.match(client, /\{ token, quantity, shippingAddress/);
  assert.match(client, /\{ token, quoteId/);
  // Truthful copy: provider cost only, quoted live, no automatic print.
  assert.match(client, /no markup/i);
  assert.match(client, /quoted live/i);
  assert.match(client, /nothing is printed automatically/i);
  assert.match(client, /prepare the print files for the format you choose/i);
  assert.doesNotMatch(client, /free shipping/i);
  // Every denial is the same neutral message; no "order not found" leak.
  assert.doesNotMatch(client, /order not found/i);
});

test('done page renders only the PII-free status view keyed by session id, and is noindex', () => {
  const page = readFileSync(DONE_PAGE, 'utf8');
  assert.match(page, /printUpgradeCheckoutStatusView/);
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /export const dynamic = 'force-dynamic'/);
  assert.doesNotMatch(page, /childName|\.email|shippingAddress|printUpgradeOffer|tokenHash/);
  assert.match(page, /nothing is printed automatically/i);
  assert.doesNotMatch(page, /ships in \d/i);
  const cancelled = readFileSync(CANCELLED_PAGE, 'utf8');
  assert.match(cancelled, /robots: \{ index: false, follow: false \}/);
  assert.doesNotMatch(cancelled, /getOrder/);
});

test('middleware applies noindex + no-referrer to the chooser surface', () => {
  const middleware = readFileSync('middleware.ts', 'utf8');
  const noindex = middleware.match(/const OPERATIONAL_NOINDEX_PATH = (.*);/)?.[1] ?? '';
  const referrer = middleware.match(/const ORDER_BEARER_REFERRER_PATH = (.*);/)?.[1] ?? '';
  assert.match(noindex, /upgrade/);
  assert.match(referrer, /upgrade/);
});
