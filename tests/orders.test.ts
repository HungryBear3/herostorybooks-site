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
  assert.equal(buildDeliveryExpectation('digital'), 'Digital proof usually ready in 2–3 business days; final PDF delivered after approval.');
  assert.match(
    buildDeliveryExpectation('classic'),
    /Digital proof usually ready in 2–3 business days.*softcover ships in 5–7 business days/i,
  );
  assert.match(
    buildDeliveryExpectation('premium'),
    /Digital proof usually ready in 2–3 business days.*hardcover ships in 5–7 business days/i,
  );
});
