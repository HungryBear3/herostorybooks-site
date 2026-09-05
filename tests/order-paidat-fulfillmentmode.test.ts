/**
 * paidAt + fulfillmentMode schema behavior (local-store, deterministic).
 *
 *  - fulfillmentMode is explicit pass-through at creation, never defaulted.
 *  - paidAt is written authoritatively + idempotently ONLY on the webhook's
 *    transition to paymentStatus='paid', preserved across replay and later
 *    updates, and never derived from updatedAt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  persistOrder,
  getOrder,
  updateOrderPayment,
  updateFulfillmentState,
} from '../src/lib/orders.ts';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function localStore<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-paidat-'));
  return withEnv(
    { HSB_REQUIRE_DURABLE_PERSISTENCE: 'false', BLOB_READ_WRITE_TOKEN: undefined, HSB_ORDER_STORE_DIR: dir, VERCEL: undefined, NODE_ENV: 'development' },
    fn,
  ).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ── fulfillmentMode: explicit pass-through, no default ──────────────────────────

test('createOrderRecord: fulfillmentMode is explicit pass-through, undefined by default', () => {
  const base = { childName: 'Mia', bookFormat: 'digital' as const, email: 'a@b.com' };
  assert.equal(createOrderRecord(base, { id: 'o1' }).fulfillmentMode, undefined);
  assert.equal(createOrderRecord(base, { id: 'o2', fulfillmentMode: 'auto' }).fulfillmentMode, 'auto');
  assert.equal(createOrderRecord(base, { id: 'o3', fulfillmentMode: 'manual_hold' }).fulfillmentMode, 'manual_hold');
  // Not paid at creation ⇒ no paidAt.
  assert.equal(createOrderRecord(base, { id: 'o4' }).paidAt, undefined);
});

// ── paidAt authoritative on the paid transition ────────────────────────────────

test('paidAt is written on the authoritative paid webhook transition', async () => {
  await localStore(async () => {
    const order = createOrderRecord({ childName: 'Mia', bookFormat: 'digital', email: 'a@b.com' }, { id: 'ord_paid', fulfillmentMode: 'auto' });
    assert.equal(order.paidAt, undefined);
    await persistOrder({ ...order, stripeSessionId: 'cs_test_1' });
    const before = Date.now();
    const updated = await updateOrderPayment('ord_paid', 'paid', { stripeSessionId: 'cs_test_1' });
    const after = Date.now();
    assert.ok(updated?.paidAt, 'paidAt set on paid');
    const paidMs = Date.parse(updated!.paidAt!);
    assert.ok(paidMs >= before && paidMs <= after, 'paidAt is the transition time');
    assert.equal(updated!.paymentStatus, 'paid');
    // Durable read agrees.
    const read = await getOrder('ord_paid');
    assert.equal(read?.paidAt, updated!.paidAt);
  });
});

test('webhook replay preserves the original paidAt (idempotent)', async () => {
  await localStore(async () => {
    const order = createOrderRecord({ childName: 'Mia', bookFormat: 'digital', email: 'a@b.com' }, { id: 'ord_replay', fulfillmentMode: 'auto' });
    await persistOrder({ ...order, stripeSessionId: 'cs_1' });
    const first = await updateOrderPayment('ord_replay', 'paid', { stripeSessionId: 'cs_1' });
    const originalPaidAt = first!.paidAt;
    await new Promise((r) => setTimeout(r, 5)); // ensure clock would differ
    const second = await updateOrderPayment('ord_replay', 'paid', { stripeSessionId: 'cs_1' });
    assert.equal(second!.paidAt, originalPaidAt, 'replay must not overwrite paidAt');
    assert.notEqual(second!.updatedAt, originalPaidAt, 'updatedAt still moves, paidAt does not');
  });
});

test('paidAt is NOT set on a non-paid transition', async () => {
  await localStore(async () => {
    const order = createOrderRecord({ childName: 'Mia', bookFormat: 'digital', email: 'a@b.com' }, { id: 'ord_refund' });
    await persistOrder(order);
    const updated = await updateOrderPayment('ord_refund', 'refunded', {});
    assert.equal(updated!.paidAt ?? null, null, 'refund transition must not stamp paidAt');
  });
});

// ── later non-payment updates preserve mode + paidAt ───────────────────────────

test('later fulfillment update preserves fulfillmentMode and paidAt', async () => {
  await localStore(async () => {
    const order = createOrderRecord({ childName: 'Mia', bookFormat: 'digital', email: 'a@b.com' }, { id: 'ord_keep', fulfillmentMode: 'auto' });
    await persistOrder({ ...order, stripeSessionId: 'cs_2' });
    const paid = await updateOrderPayment('ord_keep', 'paid', { stripeSessionId: 'cs_2' });
    const paidAt = paid!.paidAt;
    // A later, unrelated fulfillment-state write (paid order) must not drop either field.
    await updateFulfillmentState('ord_keep', { fulfillmentStatus: 'generating_story' });
    const read = await getOrder('ord_keep');
    assert.equal(read?.fulfillmentMode, 'auto', 'fulfillmentMode preserved');
    assert.equal(read?.paidAt, paidAt, 'paidAt preserved');
  });
});
