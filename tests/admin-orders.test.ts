import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrderRecord, persistOrder, listOrders } from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import { isAdminAuthedFromRequest } from '../src/lib/admin-auth.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-admin-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function seed(overrides: Partial<OrderRecord>, id: string): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: overrides.childName ?? 'Luna', bookFormat: overrides.bookFormat ?? 'digital', email: 'luna@example.com' },
    { id, now: overrides.createdAt ?? '2026-04-23T10:00:00Z' },
  );
  const order: OrderRecord = { ...base, ...overrides };
  await persistOrder(order);
  return order;
}

// ── listOrders ────────────────────────────────────────────────────────────────

test('listOrders returns empty array when store is empty', async () => {
  const dir = makeTmp();
  try {
    const orders = await listOrders();
    assert.deepEqual(orders, []);
  } finally { cleanup(dir); }
});

test('listOrders returns all persisted orders', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'paid' }, 'ord_list_a');
    await seed({ paymentStatus: 'pending' }, 'ord_list_b');
    await seed({ paymentStatus: 'paid', fulfillmentStatus: 'failed_manual_review' }, 'ord_list_c');

    const orders = await listOrders();
    assert.equal(orders.length, 3);
    const ids = orders.map(o => o.id).sort();
    assert.deepEqual(ids, ['ord_list_a', 'ord_list_b', 'ord_list_c']);
  } finally { cleanup(dir); }
});

test('listOrders skips non-JSON files silently', async () => {
  const dir = makeTmp();
  try {
    await seed({}, 'ord_list_valid');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'readme.txt'), 'not an order');

    const orders = await listOrders();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, 'ord_list_valid');
  } finally { cleanup(dir); }
});

// ── isAdminAuthedFromRequest ──────────────────────────────────────────────────

test('admin auth: no key configured → always false', () => {
  delete process.env.HSB_ORDER_ADMIN_KEY;
  const req = new Request('https://example.com', {
    headers: { 'x-hsb-order-admin-key': 'whatever' },
  });
  assert.equal(isAdminAuthedFromRequest(req), false);
});

test('admin auth: correct header key → true', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { 'x-hsb-order-admin-key': 'secret-key-abc' },
    });
    assert.equal(isAdminAuthedFromRequest(req), true);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: wrong header key → false', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { 'x-hsb-order-admin-key': 'wrong' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: correct cookie → true', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'other=1; hsb-ops-key=secret-key-abc; foo=bar' },
    });
    assert.equal(isAdminAuthedFromRequest(req), true);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: wrong cookie → false', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'hsb-ops-key=wrong-key' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: no header and no cookie → false', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com');
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

// ── retryOrderFulfillment ─────────────────────────────────────────────────────

test('retryOrderFulfillment: unknown order → 404', async () => {
  const dir = makeTmp();
  try {
    const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
    const result = await retryOrderFulfillment('ord_ghost');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 404);
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: unpaid order → 400, no state change', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'pending' }, 'ord_retry_unpaid');
    const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
    const result = await retryOrderFulfillment('ord_retry_unpaid');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 400);

    const { getOrder } = await import('../src/lib/orders.ts');
    const after = await getOrder('ord_retry_unpaid');
    assert.equal(after?.paymentStatus, 'pending');
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment uses the transactional retry preparation helper instead of a blind state reset', () => {
  const source = readFileSync(
    new URL('../src/lib/admin-actions.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /await prepareOrderForAdminFulfillmentRetry\(orderId\)/);
  assert.doesNotMatch(source, /await updateFulfillmentState\(orderId,\s*\{\s*fulfillmentStatus:\s*['"]not_started['"]/);
});

test('retryOrderFulfillment: provider failure stays failed and returns an honest 502', async () => {
  const dir = makeTmp();
  try {
    await seed({
      paymentStatus: 'paid',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentAttempts: 3,
      fulfillmentLastError: 'OpenAI rate limit',
    }, 'ord_retry_failed');

    const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
    const result = await retryOrderFulfillment('ord_retry_failed', {
      generateImages: async (prompts) => prompts.map(() => null),
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.error, /image_generation_incomplete/);

    const { getOrder } = await import('../src/lib/orders.ts');
    const after = await getOrder('ord_retry_failed');
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.notEqual(after?.fulfillmentLastError, 'OpenAI rate limit');
    assert.match(after?.fulfillmentLastError ?? '', /image_generation_incomplete/);
  } finally { cleanup(dir); }
});
