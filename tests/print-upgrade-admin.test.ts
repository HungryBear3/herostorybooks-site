import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createOrderRecord,
  getOrder,
  persistOrder,
  type OrderRecord,
} from '../src/lib/orders.ts';
import {
  calculatePrintUpgrade,
  recordPrintUpgradePayment,
} from '../src/lib/print-upgrades.ts';

function makeDigitalOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Dog City', bookFormat: 'digital', email: 'alexy@example.com' },
      { id: 'ord_dog_city_upgrade', now: '2026-07-07T12:00:00Z' },
    ),
    paymentStatus: 'paid',
    stripeSessionId: 'cs_original_digital',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://example.com/proof.pdf',
    ...overrides,
  };
}

test('calculatePrintUpgrade: paid digital to premium charges only hardcover delta', () => {
  const order = makeDigitalOrder();
  const result = calculatePrintUpgrade(order, 'premium');

  assert.equal(result.ok, true);
  assert.equal(result.amountCents, 4500);
  assert.equal(result.sourceFormat, 'digital');
  assert.equal(result.targetFormat, 'premium');
  assert.match(result.description, /Digital proof/i);
  assert.match(result.description, /Premium hardcover/i);
});

test('calculatePrintUpgrade: refuses unpaid, already-print, and non-upgrade targets', () => {
  assert.deepEqual(calculatePrintUpgrade(makeDigitalOrder({ paymentStatus: 'pending' }), 'premium'), {
    ok: false,
    status: 409,
    error: 'original_order_not_paid',
  });
  assert.deepEqual(calculatePrintUpgrade(makeDigitalOrder({ bookFormat: 'classic', formatLabel: 'Classic softcover', priceCents: 3900 }), 'premium'), {
    ok: false,
    status: 409,
    error: 'already_print_order',
  });
  assert.deepEqual(calculatePrintUpgrade(makeDigitalOrder(), 'digital'), {
    ok: false,
    status: 400,
    error: 'target_must_be_print_format',
  });
});

test('recordPrintUpgradePayment: records upgrade payment without starting fulfillment or print submission', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-upgrade-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  try {
    await persistOrder(makeDigitalOrder());

    const updated = await recordPrintUpgradePayment('ord_dog_city_upgrade', {
      stripeSessionId: 'cs_upgrade_premium',
      amountCents: 4500,
      targetFormat: 'premium',
      printProvider: 'rpi',
      shippingAddress: {
        line1: '123 Dog City Ave',
        line2: null,
        city: 'Chicago',
        state: 'IL',
        zip: '60601',
        country: 'US',
      },
      paidAt: '2026-07-07T13:00:00Z',
    });

    assert.ok(updated);
    assert.equal(updated!.bookFormat, 'premium');
    assert.equal(updated!.formatLabel, 'Premium hardcover');
    assert.equal(updated!.priceCents, 6400);
    assert.equal(updated!.printUpgradeStatus, 'paid');
    assert.equal(updated!.printUpgradeSourceFormat, 'digital');
    assert.equal(updated!.printUpgradeTargetFormat, 'premium');
    assert.equal(updated!.printUpgradeAmountCents, 4500);
    assert.equal(updated!.printUpgradeStripeSessionId, 'cs_upgrade_premium');
    assert.equal(updated!.printUpgradePrintProvider, 'rpi');
    assert.equal(updated!.shippingAddress?.line1, '123 Dog City Ave');
    assert.equal(updated!.fulfillmentStatus, 'proof_ready');
    assert.equal(updated!.printJobId ?? null, null);
    assert.equal(updated!.printJobStatus ?? null, null);

    const reloaded = await getOrder('ord_dog_city_upgrade');
    assert.equal(reloaded?.printUpgradeStatus, 'paid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HSB_ORDER_STORE_DIR;
  }
});

test('admin print-upgrade route: defaults to preview and double-confirms Stripe checkout', () => {
  const src = readFileSync('src/app/api/admin/orders/[orderId]/print-upgrade/route.ts', 'utf8');

  assert.match(src, /isAdminAuthedFromRequest\(request\)/);
  assert.match(src, /body\.createCheckout === true && body\.confirmCreateCheckout === true/);
  assert.match(src, /dryRun: true/);
  assert.match(src, /No Stripe Checkout Session, email, print job, or provider action was created/);
  assert.match(src, /allow_promotion_codes:\s*true/);
  assert.match(src, /shipping_address_collection/);
  assert.match(src, /kind:\s*'print_upgrade'/);
  assert.match(src, /targetFormat/);
  assert.match(src, /cancel_url:.*\/thank-you\?/);
  assert.doesNotMatch(src, /cancel_url:.*\/admin\//);
  assert.doesNotMatch(src, /scheduleFulfillmentKickoff|triggerFulfillment|submitPrintJob/);
});

test('stripe webhook route: print upgrade sessions record payment but do not kick off fulfillment', () => {
  const src = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');

  assert.match(src, /kind\s*===\s*'print_upgrade'/);
  assert.match(src, /recordPrintUpgradePayment/);
  const upgradeBranch = src.slice(src.indexOf("kind === 'print_upgrade'"), src.indexOf('const orderId', src.indexOf("kind === 'print_upgrade'")));
  assert.doesNotMatch(upgradeBranch, /scheduleFulfillmentKickoff|sendOrderConfirmationEmail|updateOrderPayment/);
});
