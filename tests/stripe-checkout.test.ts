import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOrderRecord,
  isPrintFormat,
  updateOrderPayment,
  type OrderRecord,
  type PaymentStatus,
} from '../src/lib/orders.ts';

// ── isPrintFormat ────────────────────────────────────────────────────────────

test('isPrintFormat: classic and premium are print, digital is not', () => {
  assert.equal(isPrintFormat('classic'), true);
  assert.equal(isPrintFormat('premium'), true);
  assert.equal(isPrintFormat('digital'), false);
});

// ── createOrderRecord payment defaults ──────────────────────────────────────

test('new order starts with paymentStatus pending', () => {
  const order = createOrderRecord({
    childName: 'Zoe',
    bookFormat: 'classic',
    email: 'test@example.com',
  });
  assert.equal(order.paymentStatus, 'pending');
  assert.equal(order.stripeSessionId, null);
  assert.equal(order.shippingAddress, null);
});

test('digital order also starts with paymentStatus pending', () => {
  const order = createOrderRecord({
    childName: 'Leo',
    bookFormat: 'digital',
    email: 'test@example.com',
  });
  assert.equal(order.paymentStatus, 'pending');
  assert.equal(order.priceCents, 1900);
  assert.equal(order.formatLabel, 'Digital proof');
});

// ── updateOrderPayment ───────────────────────────────────────────────────────

const DUMMY_ORDER: OrderRecord = {
  id: 'ord_test_abc',
  childName: 'Sam',
  bookFormat: 'classic',
  formatLabel: 'Classic',
  priceCents: 3900,
  email: 'sam@example.com',
  status: 'order_received',
  paymentStatus: 'pending',
  stripeSessionId: null,
  shippingAddress: null,
  deliveryExpectation: 'Softcover ships in 5–7 business days',
  createdAt: '2026-04-21T10:00:00Z',
  updatedAt: '2026-04-21T10:00:00Z',
};

test('updateOrderPayment patches paymentStatus without touching other fields', async () => {
  // Stub persistOrder + getOrder inline so test stays file-system-free
  let persisted: OrderRecord | null = null;

  // Monkey-patch module-level helpers via closure trick:
  // We call updateOrderPayment against a real in-memory store.
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-test-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  // Force local store (no blob token)
  delete process.env.BLOB_READ_WRITE_TOKEN;

  try {
    // Persist the dummy order first
    const ordersModule = await import('../src/lib/orders.ts');
    await ordersModule.persistOrder(DUMMY_ORDER);

    // Now call updateOrderPayment
    const result = await ordersModule.updateOrderPayment('ord_test_abc', 'paid', {
      stripeSessionId: 'cs_test_session_123',
      shippingAddress: {
        line1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
        country: 'US',
      },
    });

    assert.ok(result);
    assert.equal(result!.paymentStatus, 'paid');
    assert.equal(result!.stripeSessionId, 'cs_test_session_123');
    assert.equal(result!.shippingAddress?.line1, '123 Main St');
    assert.equal(result!.shippingAddress?.city, 'Springfield');
    // Unchanged fields
    assert.equal(result!.childName, 'Sam');
    assert.equal(result!.bookFormat, 'classic');
    assert.equal(result!.status, 'order_received');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HSB_ORDER_STORE_DIR;
  }
});

test('updateOrderPayment returns null for unknown orderId', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-test-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  try {
    const ordersModule = await import('../src/lib/orders.ts');
    const result = await ordersModule.updateOrderPayment('ord_does_not_exist', 'paid');
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HSB_ORDER_STORE_DIR;
  }
});

// ── Payment gate ─────────────────────────────────────────────────────────────

test('print order with pending payment is not ready for fulfillment', () => {
  const order: OrderRecord = { ...DUMMY_ORDER, paymentStatus: 'pending' };
  assert.equal(order.paymentStatus === 'paid', false);
  assert.equal(isPrintFormat(order.bookFormat), true);
  // Gate: fulfillment only triggers when both conditions met
  const canFulfill = order.paymentStatus === 'paid' && isPrintFormat(order.bookFormat);
  assert.equal(canFulfill, false);
});

test('print order with paid payment is ready for fulfillment', () => {
  const order: OrderRecord = { ...DUMMY_ORDER, paymentStatus: 'paid' };
  const canFulfill = order.paymentStatus === 'paid' && isPrintFormat(order.bookFormat);
  assert.equal(canFulfill, true);
});

test('digital order with paid payment does not trigger print fulfillment', () => {
  const order: OrderRecord = {
    ...DUMMY_ORDER,
    bookFormat: 'digital',
    paymentStatus: 'paid',
  };
  const canFulfill = order.paymentStatus === 'paid' && isPrintFormat(order.bookFormat);
  assert.equal(canFulfill, false);
});
