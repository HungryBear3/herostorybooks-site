import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function src(path: string): string {
  return readFileSync(path, 'utf8');
}

test('admin orders page uses derived attention for paid attention stat', () => {
  const page = src('src/app/admin/orders/page.tsx');
  assert.match(page, /deriveOrderAttention/);
  assert.match(page, /paidIssue\.severity !== 'none'/);
});

test('admin orders grid shows derived stage and attention details', () => {
  const client = src('src/app/admin/orders/ops-client.tsx');
  assert.match(client, /deriveOrderStage/);
  assert.match(client, /deriveOrderAttention/);
  assert.match(client, /Derived stage/);
  assert.match(client, /owner: \{attention\.nextActionOwner\}/);
});
