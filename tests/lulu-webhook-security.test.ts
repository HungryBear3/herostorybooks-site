import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Lulu webhook fails closed without configured HMAC secret', () => {
  const source = readFileSync(new URL('../src/app/api/webhooks/lulu/route.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(!secret\)/);
  assert.match(source, /status: 503/);
  assert.match(source, /verifyHmac\(body, sig, secret\)/);
});

test('Lulu webhook acknowledges only unknown objects and retries transient conflicts', () => {
  const source = readFileSync(new URL('../src/app/api/webhooks/lulu/route.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(result\.status === 404\)/);
  assert.match(source, /status: result\.status/);
});
