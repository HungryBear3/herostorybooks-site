import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OrderPersistenceError,
  rollbackOrderMediaUploads,
  withBlobNamespace,
} from '../src/lib/orders.ts';

test('checkout media rollback deletes unique order-scoped objects and retries transient failures', async () => {
  const orderId = 'ord_rollback';
  const hero = withBlobNamespace(`orders/${orderId}/photo-upload.jpg`);
  const supporting = withBlobNamespace(`orders/${orderId}/supporting-1-photo-upload.jpg`);
  const attempts = new Map<string, number>();

  const deleted = await rollbackOrderMediaUploads(
    orderId,
    [hero, supporting, hero],
    {
      async deleteBlob(pathname) {
        const count = (attempts.get(pathname) ?? 0) + 1;
        attempts.set(pathname, count);
        if (pathname === supporting && count === 1) throw new Error('transient');
      },
    },
  );

  assert.equal(deleted, 2);
  assert.equal(attempts.get(hero), 1);
  assert.equal(attempts.get(supporting), 2);
});

test('checkout media rollback refuses paths outside the owning order namespace', async () => {
  let calls = 0;
  await assert.rejects(
    rollbackOrderMediaUploads(
      'ord_owner',
      [withBlobNamespace('orders/ord_other/photo-upload.jpg')],
      { async deleteBlob() { calls += 1; } },
    ),
    OrderPersistenceError,
  );
  assert.equal(calls, 0);
});

test('checkout media rollback surfaces a permanent deletion failure after one retry', async () => {
  const orderId = 'ord_failure';
  const pathname = withBlobNamespace(`orders/${orderId}/photo-upload.jpg`);
  let calls = 0;
  await assert.rejects(
    rollbackOrderMediaUploads(orderId, [pathname], {
      async deleteBlob() {
        calls += 1;
        throw new Error('permanent');
      },
    }),
    (error: unknown) => error instanceof OrderPersistenceError && /rollback failed/.test(error.message),
  );
  assert.equal(calls, 2);
});
