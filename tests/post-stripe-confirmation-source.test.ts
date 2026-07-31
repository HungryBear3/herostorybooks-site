import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const orderRoute = readFileSync('src/app/api/order/route.ts', 'utf8');
const webhookRoute = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
const thankYouPage = readFileSync('src/app/thank-you/page.tsx', 'utf8');
const orderEmail = readFileSync('src/lib/order-email.ts', 'utf8');

test('checkout success URL includes Stripe opaque session placeholder for server fallback', () => {
  assert.match(orderRoute, /sessionId=\{CHECKOUT_SESSION_ID\}/);
});

test('confirmation email uses deterministic per-order Resend idempotency keys', () => {
  assert.match(orderEmail, /idempotencyKey/);
  assert.match(orderEmail, /order-confirmation-\$\{order\.id\}-primary-v1/);
  assert.match(orderEmail, /order-confirmation-\$\{order\.id\}-fallback-v1/);
});

test('webhook durably writes payment but defers confirmation email and fulfillment', () => {
  assert.match(webhookRoute, /const\s+updated\s*=\s*await\s+updateOrderPayment\(/);
  assert.doesNotMatch(webhookRoute, /await\s+sendOrderConfirmationEmail\(updated\)/);
  assert.match(webhookRoute, /scheduleOrderConfirmationEmail\(updated,\s*\{\s*afterImpl:\s*after\s*\}\)/);
  assert.match(webhookRoute, /scheduleFulfillmentKickoff\(orderId,\s*\{\s*afterImpl:\s*after\s*\}\)/);
});

test('thank-you pending surface delegates to client polling and does not invite repayment', () => {
  assert.match(thankYouPage, /PendingConfirmation/);
  assert.match(thankYouPage, /sessionId/);
  assert.doesNotMatch(thankYouPage, /safely re-try checkout/i);
});

test('confirmation client has reassuring no-repay, order link, support timeout, and mobile-safe layout', () => {
  const client = readFileSync('src/app/thank-you/pending-confirmation.tsx', 'utf8');
  assert.match(client, /Do not submit another payment/i);
  assert.match(client, /support@herostorybooks\.com/);
  assert.match(client, /\/status\/\$\{orderId\}/);
  assert.match(client, /CONFIRMATION_POLL_INTERVAL_MS/);
  assert.match(client, /getConfirmationPollDecision/);
  assert.match(client, /flex flex-col sm:flex-row/);
  assert.match(client, /requestInFlight/);
  assert.match(client, /if \(requestInFlight\) return/);
  assert.doesNotMatch(client, /Try Checkout Again|retry checkout/i);
});

test('public confirmation route is read-only and leaves all durable side effects to the webhook', () => {
  const route = readFileSync('src/app/api/order/[orderId]/confirmation/route.ts', 'utf8');
  assert.match(route, /confirmCheckoutPayment/);
  assert.match(route, /stripe!?\.checkout\.sessions\.retrieve/);
  assert.doesNotMatch(route, /updateOrderPayment/);
  assert.doesNotMatch(route, /scheduleOrderConfirmationEmail/);
  assert.doesNotMatch(route, /scheduleFulfillmentKickoff/);
  assert.match(route, /['"]Cache-Control['"]:\s*['"]no-store/);
});

test('refunded thank-you state is terminal and never falls back into polling', () => {
  assert.match(thankYouPage, /paymentStatus === 'refunded'/);
  const client = readFileSync('src/app/thank-you/pending-confirmation.tsx', 'utf8');
  assert.match(client, /Payment confirmed/);
  assert.match(client, /setStripeConfirmed/);
});
