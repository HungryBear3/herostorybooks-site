import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrderPersistenceError,
  rollbackOrderMediaUploads,
  uploadOrderPhoto,
  withBlobNamespace,
} from '../src/lib/orders.ts';

const LEASE_A = '11111111-1111-4111-8111-111111111111';
const LEASE_B = '22222222-2222-4222-8222-222222222222';

test('checkout media rollback deletes unique lease-scoped objects and retries transient failures', async () => {
  const orderId = 'ord_rollback';
  const hero = withBlobNamespace(`orders/${orderId}/checkout-${LEASE_A}/photo-upload.jpg`);
  const supporting = withBlobNamespace(`orders/${orderId}/checkout-${LEASE_A}/supporting-1-photo-upload.jpg`);
  const attempts = new Map<string, number>();

  const deleted = await rollbackOrderMediaUploads(orderId, [hero, supporting, hero], LEASE_A, {
    async deleteBlob(pathname) {
      const count = (attempts.get(pathname) ?? 0) + 1;
      attempts.set(pathname, count);
      if (pathname === supporting && count === 1) throw new Error('transient');
    },
  });

  assert.equal(deleted, 2);
  assert.equal(attempts.get(hero), 1);
  assert.equal(attempts.get(supporting), 2);
});

test('checkout media rollback refuses paths outside the owning lease namespace', async () => {
  let calls = 0;
  await assert.rejects(
    rollbackOrderMediaUploads(
      'ord_owner',
      [withBlobNamespace(`orders/ord_owner/checkout-${LEASE_B}/photo-upload.jpg`)],
      LEASE_A,
      { async deleteBlob() { calls += 1; } },
    ),
    OrderPersistenceError,
  );
  assert.equal(calls, 0);
});

test('checkout media rollback rejects traversal segments', async () => {
  let calls = 0;
  await assert.rejects(
    rollbackOrderMediaUploads(
      'ord_owner',
      [withBlobNamespace(`orders/ord_owner/checkout-${LEASE_A}/../other/photo.jpg`)],
      LEASE_A,
      { async deleteBlob() { calls += 1; } },
    ),
    OrderPersistenceError,
  );
  assert.equal(calls, 0);
});

test('checkout media rollback surfaces a permanent deletion failure after one retry', async () => {
  const orderId = 'ord_failure';
  const pathname = withBlobNamespace(`orders/${orderId}/checkout-${LEASE_A}/photo-upload.jpg`);
  let calls = 0;
  await assert.rejects(
    rollbackOrderMediaUploads(orderId, [pathname], LEASE_A, {
      async deleteBlob() {
        calls += 1;
        throw new Error('permanent');
      },
    }),
    (error: unknown) => error instanceof OrderPersistenceError && /rollback failed/.test(error.message),
  );
  assert.equal(calls, 2);
});

test('checkout media scope rejects malformed lease ids before upload', async () => {
  const file = new File([new Uint8Array([1])], 'x.jpg', { type: 'image/jpeg' });
  await assert.rejects(uploadOrderPhoto('ord_scope', file, '------------------------------------'), /invalid_checkout_media_scope/);
  await assert.rejects(uploadOrderPhoto('ord_scope', file, '123456789012345678901234567890123456'), /invalid_checkout_media_scope/);
});
