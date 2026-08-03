import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const orderRoute = readFileSync('src/app/api/order/route.ts', 'utf8');
const webhookRoute = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
const thankYouPage = readFileSync('src/app/thank-you/page.tsx', 'utf8');
const pendingConfirmation = readFileSync('src/app/thank-you/pending-confirmation.tsx', 'utf8');
const proofTurnaround = readFileSync('src/lib/proof-turnaround.ts', 'utf8');
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

test('confirmation client prioritizes waiting, duplicate-charge prevention, and actionable support', () => {
  assert.match(pendingConfirmation, /Checking your payment/);
  assert.doesNotMatch(pendingConfirmation, /Confirming your payment/);
  assert.match(pendingConfirmation, /duplicate charge/);
  assert.match(pendingConfirmation, /border-l-4 border-amber-600 bg-amber-50/);
  assert.match(pendingConfirmation, /animate-spin/);
  assert.match(pendingConfirmation, /Email Us About This Order/);
  assert.match(pendingConfirmation, /text-sm text-center text-gray-700/);
  assert.match(pendingConfirmation, /support@herostorybooks\.com/);
  assert.match(pendingConfirmation, /\/status\/\$\{orderId\}/);
  assert.match(pendingConfirmation, /CONFIRMATION_POLL_INTERVAL_MS/);
  assert.match(pendingConfirmation, /getConfirmationPollDecision/);
  assert.match(pendingConfirmation, /flex flex-col sm:flex-row/);
  assert.match(pendingConfirmation, /requestInFlight/);
  assert.match(pendingConfirmation, /if \(requestInFlight\) return/);
  assert.doesNotMatch(pendingConfirmation, /Try Checkout Again|retry checkout/i);
});

test('terminal thank-you states use distinct headings and render the real proof window', () => {
  assert.match(thankYouPage, /Your payment didn&apos;t go through/);
  assert.doesNotMatch(thankYouPage, /We couldn&apos;t confirm your payment/);
  assert.match(thankYouPage, /PROOF_TURNAROUND_WINDOW/);
  assert.match(proofTurnaround, /PROOF_TURNAROUND_WINDOW = '2–3 business days'/);
  assert.doesNotMatch(thankYouPage, /configured proof-turnaround window/);
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
