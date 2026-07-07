import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  buildPrintUpgradeDraftEmail,
  buildPrintUpgradeOffer,
  calculatePrintUpgradeDeltaCents,
  getPrintUpgradeEligibility,
} from '../src/lib/print-upgrade.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const BASE_DIGITAL_ORDER: OrderRecord = {
  id: 'ord_upgrade_test',
  childName: 'Lukas',
  bookFormat: 'digital',
  formatLabel: 'Digital PDF',
  priceCents: 1900,
  email: 'buyer@example.com',
  status: 'preview_ready',
  paymentStatus: 'paid',
  stripeSessionId: 'cs_live_test',
  shippingAddress: null,
  deliveryExpectation: 'Digital proof usually ready within 2 business days',
  createdAt: '2026-06-24T12:00:00.000Z',
  updatedAt: '2026-06-24T12:00:00.000Z',
};

test('paid digital order is eligible for an internal print-upgrade offer', () => {
  assert.deepEqual(getPrintUpgradeEligibility(BASE_DIGITAL_ORDER), {
    eligible: true,
    reason: null,
  });
});

test('print or unpaid orders are not eligible for print-upgrade offer', () => {
  assert.equal(
    getPrintUpgradeEligibility({ ...BASE_DIGITAL_ORDER, bookFormat: 'classic' }).reason,
    'order is not a digital order',
  );
  assert.equal(
    getPrintUpgradeEligibility({ ...BASE_DIGITAL_ORDER, paymentStatus: 'pending' }).reason,
    'digital order is not paid',
  );
});

test('already-upgraded or print-fulfilled orders are ineligible', () => {
  assert.equal(
    getPrintUpgradeEligibility({ ...BASE_DIGITAL_ORDER, printUpgradeStatus: 'paid' }).reason,
    'print upgrade already paid, open, or pending print',
  );
  assert.equal(
    getPrintUpgradeEligibility({ ...BASE_DIGITAL_ORDER, printUpgradeStatus: 'checkout_open' }).reason,
    'print upgrade already paid, open, or pending print',
  );
  assert.equal(
    getPrintUpgradeEligibility({ ...BASE_DIGITAL_ORDER, printJobId: 'lulu_123' }).reason,
    'order already has print fulfillment state',
  );
});

test('upgrade offer calculates delta and uses print_upgrade Stripe metadata', () => {
  assert.equal(calculatePrintUpgradeDeltaCents('digital', 'classic'), 2000);
  assert.equal(calculatePrintUpgradeDeltaCents('digital', 'premium'), 4500);

  const offer = buildPrintUpgradeOffer(BASE_DIGITAL_ORDER, 'classic');
  assert.equal(offer.deltaCents, 2000);
  assert.deepEqual(offer.metadata, {
    kind: 'print_upgrade',
    orderId: 'ord_upgrade_test',
    sourceFormat: 'digital',
    targetFormat: 'classic',
  });
});

test('draft email copy preserves proof/QA/print-go gates and is not auto-send copy', () => {
  const offer = buildPrintUpgradeOffer(BASE_DIGITAL_ORDER, 'premium');
  const draft = buildPrintUpgradeDraftEmail(offer);
  assert.match(draft.text, /digital Hero Story Book.*stays valid/);
  assert.match(draft.text, /Nothing goes to print automatically/);
  assert.match(draft.text, /proof review, QA, and owner print-go gates/);
  assert.match(draft.text, /draft\/internal upgrade offer/);
});

test('admin print-upgrade API defaults to dry-run preview and requires explicit checkout confirmation', () => {
  const route = readFileSync('src/app/api/admin/print-upgrade/route.ts', 'utf8');
  assert.match(route, /isAdminAuthedFromRequest/);
  assert.match(route, /body\.createCheckout === true && body\.confirmCreateCheckout === true/);
  assert.match(route, /dryRun: true/);
  assert.match(route, /No order updated\. No Stripe Checkout Session created\. No email sent\. No print\/provider action triggered\./);
  assert.match(route, /stripe\.checkout\.sessions\.create/);
});

test('print-upgrade webhook records upgrade state without core fulfillment kickoff or customer email', () => {
  const webhook = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  const branchStart = webhook.indexOf("session.metadata?.kind === 'print_upgrade'");
  assert.ok(branchStart >= 0, 'print_upgrade webhook branch exists');
  const branchEnd = webhook.indexOf('try {', branchStart);
  const branch = webhook.slice(branchStart, branchEnd);
  assert.match(branch, /updatePrintUpgradePayment/);
  assert.match(branch, /proof\/QA\/owner print-go gates still required/);
  assert.doesNotMatch(branch, /scheduleFulfillmentKickoff/);
  assert.doesNotMatch(branch, /sendOrderConfirmationEmail/);
});
