/*
 * F7 — the guard's own state and configuration must fail closed.
 *
 * Two reproduced gaps in the abuse guard, both of the same shape: something
 * unreadable was quietly replaced with something permissive.
 *
 *  - `parseGuardBucket` validated the counters but accepted a missing or
 *    nonsense `updatedAt`, and silently dropped unknown fields. A record we
 *    only partly understand is not a record we can enforce a limit from.
 *
 *  - `resolveGuardLimits` replaced a malformed or negative configured limit
 *    with its permissive default. Someone typing `O` for `0`, or `-1`, or
 *    `1_000` therefore did not get the tight limit they were configuring —
 *    they got 120 MiB/minute, and no signal that they had not.
 *
 * An explicitly configured zero is the case that matters most: it must survive
 * as zero, because "allow nothing" is a real thing an operator asks for during
 * an incident.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { IntakeError } from '../src/lib/checkout-intake.ts';
import {
  parseGuardBucket,
  resolveCallbackRequestLimit,
  resolveGuardLimits,
} from '../src/lib/checkout-request-guard.ts';

const BUCKET_START = Date.parse('2026-09-02T12:00:00.000Z');
const EXPECT = { scope: 'intake', bucketStart: BUCKET_START };

function validBucket(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'intake',
    bucketStart: BUCKET_START,
    updatedAt: '2026-09-02T12:00:30.000Z',
    requestCount: 1,
    intakeCreations: 0,
    uploadReservations: 0,
    uploadBytes: 0,
    finalizations: 0,
    replacementCount: 0,
    ...overrides,
  };
}

function code(error: unknown): string {
  assert.ok(error instanceof IntakeError, `expected IntakeError, got ${String(error)}`);
  return error.code;
}

test('a guard bucket must carry a real updatedAt', () => {
  assert.doesNotThrow(() => parseGuardBucket(validBucket(), EXPECT));
  for (const bad of [undefined, null, '', 'yesterday', 42, {}]) {
    assert.throws(
      () => parseGuardBucket(validBucket({ updatedAt: bad }), EXPECT),
      (error) => code(error) === 'abuse_guard_state_invalid',
      `updatedAt=${String(bad)} must fail closed`,
    );
  }
});

test('unknown fields in a guard bucket are refused, not dropped', () => {
  assert.throws(
    () => parseGuardBucket(validBucket({ requestCountOverride: 0 }), EXPECT),
    (error) => code(error) === 'abuse_guard_state_invalid',
  );
});

test('a malformed configured limit fails closed instead of defaulting', () => {
  for (const bad of ['O', '-1', '1_000', '12.5', 'unlimited', 'NaN']) {
    assert.throws(
      () => resolveGuardLimits({ HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: bad } as NodeJS.ProcessEnv),
      (error) => code(error) === 'abuse_guard_config_invalid',
      `HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE=${bad} must fail closed`,
    );
  }
  assert.throws(
    () => resolveGuardLimits({ HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: '-5' } as NodeJS.ProcessEnv),
    (error) => code(error) === 'abuse_guard_config_invalid',
  );
  assert.throws(
    () => resolveCallbackRequestLimit({ HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: 'many' } as NodeJS.ProcessEnv),
    (error) => code(error) === 'abuse_guard_config_invalid',
  );
});

test('an explicitly configured zero is preserved as zero', () => {
  const limits = resolveGuardLimits({
    HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: '0',
    HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: '0',
  } as NodeJS.ProcessEnv);
  assert.equal(limits.uploadByteLimit, 0, 'a deliberate stop must not be widened to the default');
  assert.equal(limits.intakeCreationLimit, 0);
  assert.equal(resolveCallbackRequestLimit({ HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE: '0' } as NodeJS.ProcessEnv), 0);
});

test('an unset or empty limit uses the documented default', () => {
  const limits = resolveGuardLimits({} as NodeJS.ProcessEnv);
  assert.equal(limits.uploadByteLimit, 120 * 1024 * 1024);
  assert.equal(limits.intakeCreationLimit, 12);
  assert.equal(
    resolveGuardLimits({ HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE: '' } as NodeJS.ProcessEnv).intakeCreationLimit,
    12,
  );
});

test('a valid configured limit is used exactly', () => {
  const limits = resolveGuardLimits({
    HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE: '1048576',
    HSB_CHECKOUT_GUARD_MAX_REPLACEMENTS_PER_MINUTE: '3',
  } as NodeJS.ProcessEnv, 7);
  assert.equal(limits.uploadByteLimit, 1048576);
  assert.equal(limits.replacementLimit, 3);
  assert.equal(limits.requestLimit, 7);
});
