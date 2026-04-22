import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord } from '../src/lib/orders.ts';

test('createOrderRecord maps legacy printed checkout selections to the classic format', () => {
  const order = createOrderRecord({
    childName: 'Ava',
    email: 'parent@example.com',
    bookFormat: 'printed',
  });

  assert.equal(order.bookFormat, 'classic');
  assert.equal(order.formatLabel, 'Classic');
  assert.equal(order.priceCents, 4999);
});

test('createOrderRecord maps legacy bundle checkout selections to the premium format', () => {
  const order = createOrderRecord({
    childName: 'Ava',
    email: 'parent@example.com',
    bookFormat: 'bundle',
  });

  assert.equal(order.bookFormat, 'premium');
  assert.equal(order.formatLabel, 'Premium');
  assert.equal(order.priceCents, 7999);
});
