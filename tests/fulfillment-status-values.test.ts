/**
 * Manual Fulfillment Factory — FulfillmentStatus is extended, not replaced.
 *
 * The new manual-queue states must be valid type assignments, and every
 * production status the existing pipeline depends on must still exist. A
 * removed/renamed legacy value would silently strand in-flight production
 * orders, so this guards backward compatibility at the type level.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { FulfillmentStatus } from '../src/lib/fulfillment-types.ts';

const NEW_STATUSES: FulfillmentStatus[] = [
  'manual_generation_required',
  'generation_in_progress',
  'proof_ready_for_internal_qa',
  'proof_ready_for_customer',
  'owner_print_go_required',
  'submitted_to_print',
];

const EXISTING_STATUSES: FulfillmentStatus[] = [
  'not_started',
  'failed_manual_review',
  'proof_ready',
  'proof_approved',
  'complete',
  'delivery_email_failed',
];

test('all six new manual-queue statuses are valid FulfillmentStatus literals', () => {
  assert.equal(NEW_STATUSES.length, 6);
  // The fact that NEW_STATUSES typechecks as FulfillmentStatus[] is the real
  // assertion (compile-time). Runtime sanity: all present and distinct.
  assert.equal(new Set(NEW_STATUSES).size, 6);
});

test('all required pre-existing statuses still exist (no replacement/rename)', () => {
  assert.equal(EXISTING_STATUSES.length, 6);
  assert.equal(new Set(EXISTING_STATUSES).size, 6);
});

test('new and existing status sets do not collide', () => {
  const overlap = NEW_STATUSES.filter((s) => (EXISTING_STATUSES as string[]).includes(s));
  assert.deepEqual(overlap, []);
});

test('submitted_to_print is distinct from the legacy submitting_to_print', () => {
  const submittedToPrint: FulfillmentStatus = 'submitted_to_print';
  const submittingToPrint: FulfillmentStatus = 'submitting_to_print';
  assert.notEqual(submittedToPrint, submittingToPrint);
});
