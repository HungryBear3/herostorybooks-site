import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import { deriveOrderEmailLedger, type CustomerEmailKind, type CustomerEmailState } from '../src/lib/order-email-ledger.ts';

function order(overrides: Partial<OrderRecord>): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: overrides.bookFormat ?? 'digital', email: 'luna@example.com' },
    { id: overrides.id ?? 'ord_ledger', now: overrides.createdAt ?? '2026-07-02T12:00:00.000Z' },
  );
  return { ...base, ...overrides };
}

function stateOf(order: OrderRecord, kind: CustomerEmailKind): CustomerEmailState {
  const found = deriveOrderEmailLedger(order).entries.find((e) => e.kind === kind);
  if (!found) throw new Error(`no ledger entry for ${kind}`);
  return found.state;
}

test('email ledger: unpaid draft has no sent emails', () => {
  const ledger = deriveOrderEmailLedger(order({ paymentStatus: 'pending' }));
  assert.equal(ledger.sentCount, 0);
  assert.equal(ledger.hasFailure, false);
  assert.equal(stateOf(order({ paymentStatus: 'pending' }), 'order_confirmation'), 'not_applicable');
});

test('email ledger: paid records confirmation as sent; proof pending until released', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://blob.example/proof.pdf',
  });
  assert.equal(stateOf(o, 'order_confirmation'), 'sent');
  assert.equal(stateOf(o, 'proof_ready'), 'pending');
});

test('email ledger: released proof email is recorded as sent from audit evidence', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'proof_ready',
    storyArtifactUrl: 'https://blob.example/proof.pdf',
    customerProofReleasedAt: '2026-07-02T12:10:00.000Z',
  });
  const entry = deriveOrderEmailLedger(o).entries.find((e) => e.kind === 'proof_ready');
  assert.equal(entry?.state, 'sent');
  assert.equal(entry?.at, '2026-07-02T12:10:00.000Z');
});

test('email ledger: delivery email failure flips hasFailure', () => {
  const o = order({
    paymentStatus: 'paid',
    fulfillmentStatus: 'delivery_email_failed',
    storyArtifactUrl: 'https://blob.example/book.pdf',
  });
  assert.equal(stateOf(o, 'digital_delivery'), 'failed');
  assert.equal(deriveOrderEmailLedger(o).hasFailure, true);
});

test('email ledger: shipped is not applicable for digital and pending for in-flight print', () => {
  assert.equal(stateOf(order({ paymentStatus: 'paid', bookFormat: 'digital' }), 'shipped'), 'not_applicable');

  const printInFlight = order({
    paymentStatus: 'paid',
    bookFormat: 'classic',
    proofApprovedAt: '2026-07-02T12:20:00.000Z',
    printJobId: 'print_job_1',
  });
  assert.equal(stateOf(printInFlight, 'shipped'), 'pending');

  const shipped = order({ paymentStatus: 'paid', bookFormat: 'classic', shippedAt: '2026-07-03T09:00:00.000Z' });
  assert.equal(stateOf(shipped, 'shipped'), 'sent');
});

test('email ledger performs no network / send (source scan)', () => {
  const code = readFileSync('src/lib/order-email-ledger.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.doesNotMatch(code, /\.(send|post|deliver|dispatch)\s*\(/i);
  assert.doesNotMatch(code, /resend|nodemailer|sendgrid|process\.env/i);
});
