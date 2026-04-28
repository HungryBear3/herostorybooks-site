import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrderRecord } from '../src/lib/orders.ts';

test('createOrderRecord preserves manual character appearance notes for fulfillment', () => {
  const record = createOrderRecord(
    {
      childName: 'Milo',
      bookFormat: 'classic',
      email: 'parent@example.com',
      characterNotes: 'Wears glasses and has curly dark hair',
      appearanceOptions: JSON.stringify({ glasses: true, hair: 'curly', skinTone: 'deep' }),
    },
    { id: 'ord_attr', now: '2026-04-22T18:00:00.000Z' },
  );

  assert.equal(record.characterNotes, 'Wears glasses and has curly dark hair');
  assert.equal(record.appearanceOptions, JSON.stringify({ glasses: true, hair: 'curly', skinTone: 'deep' }));
});
