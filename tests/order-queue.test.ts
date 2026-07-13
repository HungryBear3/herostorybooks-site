import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';
import {
  beginManualQueue,
  setCustomerQueueStatus,
  normalizeCustomerQueueStatus,
  deriveQueueView,
  pendingManualQueue,
  CUSTOMER_QUEUE_STATUS_LABELS,
} from '../src/lib/order-queue.ts';
import { parseFfQueueArgs, filterQueue, formatQueueText } from '../scripts/ff-queue-status.ts';

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord(
    { childName: 'Mia', bookFormat: overrides.bookFormat ?? 'digital', email: 'mia@example.com' },
    { id: overrides.id ?? 'ord_q', now: overrides.createdAt ?? '2026-07-13T12:00:00.000Z' },
  );
  return { ...base, ...overrides };
}

// 1. Additive / backward compatible ------------------------------------------
test('new order defaults the queue fields to null (safe, no queue implied)', () => {
  const o = createOrderRecord(
    { childName: 'Mia', bookFormat: 'digital', email: 'mia@example.com' },
    { id: 'ord_defaults', now: '2026-07-13T12:00:00.000Z' },
  );
  assert.equal(o.manualQueueEnteredAt, null);
  assert.equal(o.customerQueueStatus, null);
  assert.equal(o.lastQueueStatusUpdateAt, null);
  assert.equal(o.queueStatusNote, null);
});

test('legacy order missing the queue fields entirely still works (optional/back-compat)', () => {
  const legacy = order({ paymentStatus: 'paid', status: 'order_received' });
  delete (legacy as Partial<OrderRecord>).manualQueueEnteredAt;
  delete (legacy as Partial<OrderRecord>).customerQueueStatus;
  delete (legacy as Partial<OrderRecord>).lastQueueStatusUpdateAt;
  delete (legacy as Partial<OrderRecord>).queueStatusNote;

  const view = deriveQueueView(legacy);
  assert.equal(view.inManualQueue, true);
  assert.equal(view.status, null);
  assert.equal(view.enteredAt, null);
  assert.deepEqual(pendingManualQueue([legacy]).length, 1);
});

// 2. Pure helpers -------------------------------------------------------------
test('beginManualQueue is idempotent on enteredAt and defaults status to queued', () => {
  const patch = beginManualQueue({ manualQueueEnteredAt: null, customerQueueStatus: null }, '2026-07-13T13:00:00.000Z');
  assert.deepEqual(patch, {
    manualQueueEnteredAt: '2026-07-13T13:00:00.000Z',
    customerQueueStatus: 'queued',
    lastQueueStatusUpdateAt: '2026-07-13T13:00:00.000Z',
  });
  // Does not clobber an existing entry time or status.
  const patch2 = beginManualQueue(
    { manualQueueEnteredAt: '2026-07-13T09:00:00.000Z', customerQueueStatus: 'in_review' },
    '2026-07-13T13:00:00.000Z',
  );
  assert.equal(patch2.manualQueueEnteredAt, '2026-07-13T09:00:00.000Z');
  assert.equal(patch2.customerQueueStatus, 'in_review');
});

test('setCustomerQueueStatus produces a status + timestamp patch, note optional', () => {
  assert.deepEqual(setCustomerQueueStatus('in_progress', '2026-07-13T14:00:00.000Z'), {
    customerQueueStatus: 'in_progress',
    lastQueueStatusUpdateAt: '2026-07-13T14:00:00.000Z',
  });
  assert.deepEqual(setCustomerQueueStatus('ready', '2026-07-13T14:00:00.000Z', 'proof emailed manually by ops'), {
    customerQueueStatus: 'ready',
    lastQueueStatusUpdateAt: '2026-07-13T14:00:00.000Z',
    queueStatusNote: 'proof emailed manually by ops',
  });
});

test('normalizeCustomerQueueStatus rejects unknown values', () => {
  assert.equal(normalizeCustomerQueueStatus('queued'), 'queued');
  assert.equal(normalizeCustomerQueueStatus('shipped'), null);
  assert.equal(normalizeCustomerQueueStatus(''), null);
  assert.equal(normalizeCustomerQueueStatus(null), null);
  assert.equal(normalizeCustomerQueueStatus(42), null);
  for (const s of ['queued', 'in_review', 'in_progress', 'ready'] as const) {
    assert.ok(CUSTOMER_QUEUE_STATUS_LABELS[s].length > 0);
  }
});

// 3. Derivation ---------------------------------------------------------------
test('deriveQueueView: paid+order_received is in queue; refunded/dispositioned is not', () => {
  assert.equal(deriveQueueView(order({ paymentStatus: 'paid', status: 'order_received' })).inManualQueue, true);
  assert.equal(deriveQueueView(order({ paymentStatus: 'pending', status: 'order_received' })).inManualQueue, false);
  assert.equal(deriveQueueView(order({ paymentStatus: 'paid', status: 'preview_ready' })).inManualQueue, false);
  assert.equal(deriveQueueView(order({ paymentStatus: 'paid', status: 'order_received', refundedAt: '2026-07-13T15:00:00.000Z' })).inManualQueue, false);
  const withStatus = deriveQueueView(order({ paymentStatus: 'paid', status: 'order_received', customerQueueStatus: 'in_review' }));
  assert.equal(withStatus.status, 'in_review');
  assert.equal(withStatus.statusLabel, 'Being reviewed');
});

test('pendingManualQueue sorts oldest-first, positions, annotates cohort/invite, excludes non-queue', () => {
  const a = order({ id: 'ord_a', createdAt: '2026-07-13T10:00:00.000Z', paymentStatus: 'paid', status: 'order_received', checkoutTracking: { cohort: 'ff-beta', invite: 'alexfriend01' } });
  const b = order({ id: 'ord_b', createdAt: '2026-07-13T08:00:00.000Z', paymentStatus: 'paid', status: 'order_received', checkoutTracking: { cohort: 'ff-beta' } });
  const unpaid = order({ id: 'ord_u', createdAt: '2026-07-13T07:00:00.000Z', paymentStatus: 'pending', status: 'order_received' });
  const shipped = order({ id: 'ord_s', createdAt: '2026-07-13T06:00:00.000Z', paymentStatus: 'paid', status: 'shipped' });

  const rows = pendingManualQueue([a, b, unpaid, shipped]);
  assert.deepEqual(rows.map((r) => r.orderId), ['ord_b', 'ord_a']); // oldest first
  assert.deepEqual(rows.map((r) => r.position), [1, 2]);
  assert.equal(rows[1].cohort, 'ff-beta');
  assert.equal(rows[1].invite, 'alexfriend01');
  assert.equal(rows[0].invite, null);
});

// 4. Read-only script ---------------------------------------------------------
test('ff-queue-status arg parsing + cohort filter + text formatting', () => {
  assert.deepEqual(parseFfQueueArgs(['--json', '--cohort=FF-Beta']), { json: true, cohort: 'ff-beta' });
  const rows = pendingManualQueue([
    order({ id: 'ord_a', createdAt: '2026-07-13T08:00:00.000Z', paymentStatus: 'paid', status: 'order_received', checkoutTracking: { cohort: 'ff-beta' } }),
    order({ id: 'ord_b', createdAt: '2026-07-13T09:00:00.000Z', paymentStatus: 'paid', status: 'order_received', checkoutTracking: { cohort: 'other' } }),
  ]);
  assert.equal(filterQueue(rows, 'ff-beta').length, 1);
  assert.match(formatQueueText(rows), /pending manual-review queue — 2 order/);
  assert.match(formatQueueText([]), /No paid orders are waiting/);
});

test('ff-queue-status script is read-only (no stripe/email/mutation/fetch)', () => {
  const code = readFileSync('scripts/ff-queue-status.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.match(code, /listOrders/);
  assert.match(code, /pendingManualQueue/);
  assert.doesNotMatch(code, /\bstripe\b/i);
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.doesNotMatch(code, /resend|nodemailer|sendEmail|sendMail/i);
  assert.doesNotMatch(code, /persistOrder|updateOrder|saveOrder|writeFile|put\s*\(/);
});

// 5. Admin surfaces expose the queue fields -----------------------------------
test('admin order detail exposes the queue fields', () => {
  const src = readFileSync('src/app/admin/orders/[orderId]/page.tsx', 'utf8');
  assert.match(src, /Queue status/);
  assert.match(src, /order\.customerQueueStatus/);
  assert.match(src, /order\.manualQueueEnteredAt/);
  assert.match(src, /order\.queueStatusNote/);
});

test('admin orders list makes F&F cohort/invite + queue status scannable', () => {
  const src = readFileSync('src/app/admin/orders/ops-client.tsx', 'utf8');
  assert.match(src, /F&amp;F \/ Queue/);
  assert.match(src, /order\.checkoutTracking\?\.cohort/);
  assert.match(src, /order\.customerQueueStatus/);
});
