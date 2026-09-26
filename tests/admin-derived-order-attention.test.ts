import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toAdminOrderListItem } from '../src/lib/admin-order-dto.ts';
import { deriveOrderAttention, deriveOrderStage } from '../src/lib/order-stage.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';

function src(path: string): string {
  return readFileSync(path, 'utf8');
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Mia', bookFormat: 'digital', email: 'mia@example.invalid' },
    { id: 'ord_attention01', now: '2026-09-20T12:00:00.000Z' },
  );
  return { ...base, ...overrides } as OrderRecord;
}

test('admin orders page uses derived attention for paid attention stat', () => {
  const page = src('src/app/admin/orders/page.tsx');
  assert.match(page, /deriveOrderAttention/);
  assert.match(page, /paidIssue\.severity !== 'none'/);
});

/*
 * L-4 Slice A3-1 moved both derivations to the server.
 *
 * Before A3-1 the grid called `deriveOrderStage` and `deriveOrderAttention` in
 * the browser, which is why the whole `OrderRecord` had to be serialized into
 * the client payload: those functions read `shippingAddress`, `auditEvents`,
 * `proofApprovalToken` and the print/QA internals. The derivations now run in
 * `toAdminOrderListItem` and only their results cross, so the assertions below
 * pin the contract that replaced the client-side calls rather than the calls
 * themselves. What the operator sees is unchanged: the same stage pill, the
 * same severity pill, and the same `reason · queue · owner:` line.
 */
test('admin orders grid renders server-derived stage and the full attention detail', () => {
  const client = src('src/app/admin/orders/ops-client.tsx');

  // The derivations no longer happen in the browser.
  assert.doesNotMatch(client, /deriveOrderStage/);
  assert.doesNotMatch(client, /deriveOrderAttention/);
  // They arrive already computed.
  assert.match(client, /const derivedStage = order\.stage;/);
  assert.match(client, /const attention = order\.attention;/);

  // And every rendered member of the attention contract is still rendered.
  assert.match(client, /Derived stage/);
  assert.match(client, /\{attention\.severity\}/);
  assert.match(client, /\{attention\.reason\}/);
  assert.match(client, /\{attention\.queue\}/);
  assert.match(client, /owner: \{attention\.nextActionOwner\}/);
});

test('the projected stage and attention equal what the client used to compute itself', () => {
  const fixtures: OrderRecord[] = [
    order(),
    order({ paymentStatus: 'paid', paidAt: '2026-09-20T12:05:00.000Z' }),
    order({ paymentStatus: 'paid', fulfillmentStatus: 'failed_manual_review' }),
    order({ paymentStatus: 'paid', fulfillmentStatus: 'proof_ready', storyArtifactUrl: 'https://example.invalid/p.pdf' }),
    order({ paymentStatus: 'paid', refundedAt: '2026-09-21T12:00:00.000Z' }),
    order({ paymentStatus: 'paid', internalDisposition: 'abandoned_internal_test' }),
    order({ paymentStatus: 'paid', status: 'shipped', shippedAt: '2026-09-22T12:00:00.000Z' }),
  ];

  for (const record of fixtures) {
    const item = toAdminOrderListItem(record);
    assert.equal(item.stage, deriveOrderStage(record));
    const derived = deriveOrderAttention(record);
    assert.equal(item.attention.severity, derived.severity);
    assert.equal(item.attention.reason, derived.reason);
    assert.equal(item.attention.queue, derived.queue);
    assert.equal(item.attention.nextActionOwner, derived.nextActionOwner);
    // The shorthand `{ severity, queue, label }` would have dropped these two.
    assert.deepEqual(
      Object.keys(item.attention).sort(),
      ['nextActionOwner', 'queue', 'reason', 'severity'],
    );
  }
});

test('the paid-attention filter and counter still key off severity', () => {
  const client = src('src/app/admin/orders/ops-client.tsx');
  assert.match(client, /case 'paid_attention': return o\.attention\.severity !== 'none';/);
  assert.match(client, /o\.attention\.severity !== 'none'\)\.length/);

  // And the projected severity is the one those two read.
  const flagged = toAdminOrderListItem(order({ paymentStatus: 'paid', fulfillmentStatus: 'failed_manual_review' }));
  assert.notEqual(flagged.attention.severity, 'none');
  const quiet = toAdminOrderListItem(order());
  assert.equal(quiet.attention.severity, deriveOrderAttention(order()).severity);
});
