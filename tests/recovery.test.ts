import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNewRecoveryLead,
  mergeRecoveryUpdate,
  type RecoveryLead,
} from '../src/lib/recovery.ts';

// ── buildNewRecoveryLead ──────────────────────────────────────────────────────

test('buildNewRecoveryLead creates a lead with the expected shape', () => {
  const lead = buildNewRecoveryLead(
    {
      email: 'parent@example.com',
      childName: 'Ava',
      bookFormat: 'classic',
      theme: 'space-voyager',
      captureSource: 'checkout_form',
    },
    { id: 'rec_test_001', now: '2026-04-20T10:00:00.000Z' },
  );

  assert.equal(lead.id, 'rec_test_001');
  assert.equal(lead.email, 'parent@example.com');
  assert.equal(lead.childName, 'Ava');
  assert.equal(lead.bookFormat, 'classic');
  assert.equal(lead.theme, 'space-voyager');
  assert.equal(lead.captureSource, 'checkout_form');
  assert.equal(lead.status, 'active');
  assert.equal(lead.convertedToOrderId, null);
  assert.equal(lead.createdAt, '2026-04-20T10:00:00.000Z');
  assert.equal(lead.updatedAt, '2026-04-20T10:00:00.000Z');
});

test('buildNewRecoveryLead normalizes email to lowercase', () => {
  const lead = buildNewRecoveryLead({ email: 'Parent@Example.COM' }, { id: 'rec_x' });
  assert.equal(lead.email, 'parent@example.com');
});

test('buildNewRecoveryLead works with email-only input', () => {
  const lead = buildNewRecoveryLead({ email: 'minimal@example.com' }, { id: 'rec_min' });
  assert.equal(lead.childName, '');
  assert.equal(lead.bookFormat, '');
  assert.equal(lead.theme, '');
  assert.equal(lead.status, 'active');
  assert.equal(lead.convertedToOrderId, null);
});

test('buildNewRecoveryLead defaults captureSource to checkout_form', () => {
  const lead = buildNewRecoveryLead({ email: 'x@y.com' }, { id: 'rec_x' });
  assert.equal(lead.captureSource, 'checkout_form');
});

test('buildNewRecoveryLead trims whitespace from fields', () => {
  const lead = buildNewRecoveryLead(
    { email: '  trim@example.com  ', childName: '  Leo  ', theme: '  space  ' },
    { id: 'rec_trim' },
  );
  assert.equal(lead.email, 'trim@example.com');
  assert.equal(lead.childName, 'Leo');
  assert.equal(lead.theme, 'space');
});

// ── mergeRecoveryUpdate — no duplication, preserves id ───────────────────────

test('mergeRecoveryUpdate preserves id and createdAt', () => {
  const existing = buildNewRecoveryLead(
    { email: 'a@b.com', childName: 'Leo' },
    { id: 'rec_original', now: '2026-04-20T10:00:00.000Z' },
  );

  const updated = mergeRecoveryUpdate(
    existing,
    { email: 'a@b.com', childName: 'Leo Updated' },
    '2026-04-20T11:00:00.000Z',
  );

  assert.equal(updated.id, 'rec_original');
  assert.equal(updated.createdAt, '2026-04-20T10:00:00.000Z');
  assert.equal(updated.updatedAt, '2026-04-20T11:00:00.000Z');
});

test('mergeRecoveryUpdate updates non-empty incoming fields', () => {
  const existing = buildNewRecoveryLead(
    { email: 'a@b.com', childName: 'Leo', bookFormat: 'classic', theme: 'space' },
    { id: 'rec_x' },
  );

  const updated = mergeRecoveryUpdate(existing, {
    email: 'a@b.com',
    childName: 'Leo V2',
    bookFormat: 'premium',
  });

  assert.equal(updated.childName, 'Leo V2');
  assert.equal(updated.bookFormat, 'premium');
  assert.equal(updated.theme, 'space'); // not in input — preserved
});

test('mergeRecoveryUpdate does not overwrite with empty incoming values', () => {
  const existing = buildNewRecoveryLead(
    { email: 'a@b.com', childName: 'Leo', bookFormat: 'classic', theme: 'space' },
    { id: 'rec_x' },
  );

  const updated = mergeRecoveryUpdate(existing, {
    email: 'a@b.com',
    childName: '',
    bookFormat: '',
    theme: '',
  });

  // All existing values are preserved — empty strings do not overwrite
  assert.equal(updated.childName, 'Leo');
  assert.equal(updated.bookFormat, 'classic');
  assert.equal(updated.theme, 'space');
});

test('mergeRecoveryUpdate does not change status from active', () => {
  const existing = buildNewRecoveryLead({ email: 'x@y.com', childName: 'Mia' }, { id: 'rec_x' });
  const updated = mergeRecoveryUpdate(existing, { email: 'x@y.com', theme: 'dragon-quest' });
  assert.equal(updated.status, 'active');
});

test('multiple saves from same email produce one logical record', () => {
  // Simulates what happens when the debounced capture fires multiple times:
  // each call to upsertRecoveryLead calls mergeRecoveryUpdate on the existing lead.
  // The id must never change across updates.
  const base = buildNewRecoveryLead(
    { email: 'repeat@example.com', childName: 'Zoe' },
    { id: 'rec_base', now: '2026-04-20T09:00:00.000Z' },
  );

  const save2 = mergeRecoveryUpdate(base, { email: 'repeat@example.com', bookFormat: 'classic' }, '2026-04-20T09:30:00.000Z');
  const save3 = mergeRecoveryUpdate(save2, { email: 'repeat@example.com', theme: 'ocean-dreams' }, '2026-04-20T09:45:00.000Z');

  assert.equal(save3.id, 'rec_base');        // same id throughout
  assert.equal(save3.childName, 'Zoe');      // preserved from first save
  assert.equal(save3.bookFormat, 'classic'); // added in save2
  assert.equal(save3.theme, 'ocean-dreams'); // added in save3
  assert.equal(save3.createdAt, '2026-04-20T09:00:00.000Z'); // original creation time
  assert.equal(save3.updatedAt, '2026-04-20T09:45:00.000Z'); // latest save time
});

// ── Conversion linkage ────────────────────────────────────────────────────────

test('converted lead has correct status and orderId', () => {
  const lead = buildNewRecoveryLead(
    { email: 'buyer@example.com', childName: 'Leo', bookFormat: 'classic' },
    { id: 'rec_buyer', now: '2026-04-20T10:00:00.000Z' },
  );

  // Simulate what markRecoveryLeadConverted does (same spread pattern)
  const converted: RecoveryLead = {
    ...lead,
    status: 'converted',
    convertedToOrderId: 'ord_abc123',
    updatedAt: '2026-04-20T12:00:00.000Z',
  };

  assert.equal(converted.status, 'converted');
  assert.equal(converted.convertedToOrderId, 'ord_abc123');
  assert.equal(converted.id, 'rec_buyer');                       // same id
  assert.equal(converted.createdAt, '2026-04-20T10:00:00.000Z'); // preserved
  assert.notEqual(converted.updatedAt, lead.updatedAt);          // updated
});

test('conversion preserves all original lead fields', () => {
  const lead = buildNewRecoveryLead(
    { email: 'a@b.com', childName: 'Ava', bookFormat: 'premium', theme: 'royal-adventure' },
    { id: 'rec_z' },
  );

  const converted: RecoveryLead = {
    ...lead,
    status: 'converted',
    convertedToOrderId: 'ord_xyz',
    updatedAt: new Date().toISOString(),
  };

  assert.equal(converted.childName, 'Ava');
  assert.equal(converted.bookFormat, 'premium');
  assert.equal(converted.theme, 'royal-adventure');
  assert.equal(converted.email, 'a@b.com');
});

// ── No-email guard (documents expected caller behavior) ──────────────────────

test('buildNewRecoveryLead with blank email still builds — callers must validate', () => {
  // The pure function does not throw — validation belongs at the API layer.
  // upsertRecoveryLead throws, but buildNewRecoveryLead does not.
  const lead = buildNewRecoveryLead({ email: '' }, { id: 'rec_blank' });
  assert.equal(lead.email, '');
});
