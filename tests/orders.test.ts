import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDeliveryExpectation, createOrderRecord } from '../src/lib/orders.ts';

test('createOrderRecord builds a lean persisted order model with default status tracking', () => {
  const record = createOrderRecord(
    {
      childName: 'Milo',
      childAge: '5',
      theme: 'space-voyager',
      lesson: 'courage',
      occasion: 'birthday',
      giftMessage: 'Love you to the moon',
      bookFormat: 'classic',
      email: 'parent@example.com',
      photoFileName: 'milo.png',
    },
    {
      now: '2026-04-20T15:00:00.000Z',
      id: 'ord_test_123',
    },
  );

  assert.equal(record.id, 'ord_test_123');
  assert.equal(record.status, 'order_received');
  assert.equal(record.childName, 'Milo');
  assert.equal(record.bookFormat, 'classic');
  assert.equal(record.photoFileName, 'milo.png');
  assert.equal(record.email, 'parent@example.com');
  assert.equal(record.createdAt, '2026-04-20T15:00:00.000Z');
  assert.equal(record.updatedAt, '2026-04-20T15:00:00.000Z');
});

test('buildDeliveryExpectation keeps digital-first reassurance for print formats', () => {
  assert.equal(buildDeliveryExpectation('digital'), 'PDF by email in ~15 minutes');
  assert.match(
    buildDeliveryExpectation('classic'),
    /Softcover ships in 5–7 business days.*Digital preview arrives first/i,
  );
  assert.match(
    buildDeliveryExpectation('premium'),
    /Hardcover ships in 5–7 business days.*Digital preview arrives first/i,
  );
});
