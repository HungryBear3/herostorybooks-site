import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('generic authenticated order status PATCH is retired and cannot mutate or email', () => {
  const source = readFileSync(new URL('../src/app/api/order/[orderId]/route.ts', import.meta.url), 'utf8');
  assert.match(source, /status: 410/);
  assert.doesNotMatch(source, /updateOrderStatus/);
  assert.doesNotMatch(source, /sendLifecycleEmail/);
  assert.match(source, /dedicated guarded admin actions/);
});
