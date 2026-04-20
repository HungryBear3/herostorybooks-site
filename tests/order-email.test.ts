import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOrderConfirmationEmail } from '../src/lib/order-email.ts';
import { createOrderRecord } from '../src/lib/orders.ts';

test('buildOrderConfirmationEmail includes the promised order details and support info', () => {
  const order = createOrderRecord(
    {
      childName: 'Ava',
      childAge: '6',
      theme: 'royal-adventure',
      lesson: 'kindness',
      occasion: 'mothers-day',
      giftMessage: 'You are magic',
      bookFormat: 'premium',
      email: 'ava.parent@example.com',
      photoFileName: 'ava.jpg',
    },
    {
      now: '2026-04-20T16:30:00.000Z',
      id: 'ord_test_email',
    },
  );

  const email = buildOrderConfirmationEmail(order, {
    supportEmail: 'hello@herostorybooks.com',
  });

  assert.match(email.subject, /Ava/i);
  assert.match(email.html, /Ava/);
  assert.match(email.html, /Premium/);
  assert.match(email.html, /hello@herostorybooks.com/);
  assert.match(email.html, /digital preview.*before it prints/i);
  assert.match(email.text, /Premium/);
  assert.match(email.text, /Hardcover ships in 5–7 business days/i);
  assert.match(email.text, /hello@herostorybooks.com/);
});
