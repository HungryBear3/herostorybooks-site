/*
 * L-4 A3-5 — the frozen-dispatch classification table (plan §4), as pure rows.
 *
 * The one property everything else rests on: nothing reaches
 * `PROVABLY_PRE_DISPATCH_FAILED` — the only state the model retries
 * automatically — unless our own code proved the request was never handed to
 * the provider SDK, or the provider error is on the proven-rejection list. That
 * list ships empty (RL-1), so every provider-returned error is a hold.
 *
 * Pure: no store, no order record, no transport, no environment.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONFIRMATION_DISPATCH_DEADLINE_MS,
  CONFIRMATION_DISPATCH_PROVEN_PROVIDER_REJECTIONS,
  classifyFrozenDispatchResult,
} from '../src/lib/confirmation-email-dispatch.ts';
import { CONFIRMATION_EMAIL_CLAIM_STALE_MS } from '../src/lib/confirmation-email-delivery.ts';
import { evaluateConfirmationEmailTransition } from '../src/lib/confirmation-email-state.ts';
import type { FrozenDispatchTransportResult } from '../src/lib/order-email.ts';

const MESSAGE_ID = 'd1b2c3a4-0000-4000-8000-00000000abcd';

// ── CL-1: every row of §4 ───────────────────────────────────────────────────

const ROWS: Array<[string, unknown, unknown]> = [
  ['accepted', { kind: 'accepted', id: MESSAGE_ID }, { event: 'provider_accepted', providerMessageId: MESSAGE_ID }],
  ['not_submitted missing key', { kind: 'not_submitted', cause: 'missing_resend_api_key' },
    { event: 'pre_dispatch_failure_proven', attemptOutcome: 'pre_dispatch_failed', errorClass: 'missing_resend_api_key', statusCode: null }],
  ['not_submitted client', { kind: 'not_submitted', cause: 'client_construction' },
    { event: 'pre_dispatch_failure_proven', attemptOutcome: 'pre_dispatch_failed', errorClass: 'client_construction', statusCode: null }],
  ['not_submitted argument', { kind: 'not_submitted', cause: 'argument_invalid' },
    { event: 'pre_dispatch_failure_proven', attemptOutcome: 'pre_dispatch_failed', errorClass: 'argument_invalid', statusCode: null }],
  ['409 body conflict', { kind: 'provider_error', statusCode: 409, providerErrorClass: 'invalid_idempotent_request' },
    { event: 'ambiguous_outcome', holdReason: 'provider_body_conflict', providerErrorClass: 'invalid_idempotent_request', statusCode: 409 }],
  ['409 concurrent', { kind: 'provider_error', statusCode: 409, providerErrorClass: 'concurrent_idempotent_requests' },
    { event: 'ambiguous_outcome', holdReason: 'provider_concurrent_request', providerErrorClass: 'concurrent_idempotent_requests', statusCode: 409 }],
  ['429', { kind: 'provider_error', statusCode: 429, providerErrorClass: 'rate_limit_exceeded' },
    { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'rate_limit_exceeded', statusCode: 429 }],
  ['500', { kind: 'provider_error', statusCode: 500, providerErrorClass: 'internal_server_error' },
    { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'internal_server_error', statusCode: 500 }],
  ['422 validation', { kind: 'provider_error', statusCode: 422, providerErrorClass: 'validation_error' },
    { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'validation_error', statusCode: 422 }],
  ['null status application_error', { kind: 'provider_error', statusCode: null, providerErrorClass: 'application_error' },
    { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'application_error', statusCode: null }],
  ['409 on another name', { kind: 'provider_error', statusCode: 409, providerErrorClass: 'validation_error' },
    { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'validation_error', statusCode: 409 }],
  ['submit_threw', { kind: 'submit_threw', errorClass: 'TypeError' },
    { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'TypeError', statusCode: null }],
  ['no_message_id', { kind: 'no_message_id' },
    { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'no_message_id', statusCode: null }],
];

for (const [label, input, expected] of ROWS) {
  test(`CL-1: ${label}`, () => {
    assert.deepEqual(classifyFrozenDispatchResult(input as FrozenDispatchTransportResult), expected);
  });
}

test('CL-1: an unrecognized or malformed result is ambiguous, never pre-dispatch', () => {
  for (const input of [null, undefined, 42, 'accepted', {}, { kind: 'nonsense' }, { kind: 'not_submitted', cause: 'other' },
    { kind: 'not_submitted' }, { kind: 'provider_error' }, { kind: '__proto__' }]) {
    const out = classifyFrozenDispatchResult(input as unknown as FrozenDispatchTransportResult);
    assert.equal(out.event, 'ambiguous_outcome', JSON.stringify(input));
    assert.equal((out as { holdReason: string }).holdReason, 'ambiguous_dispatch');
  }
});

test('CL-1: a provider class that is not name-shaped never crosses as text', () => {
  const out = classifyFrozenDispatchResult({
    kind: 'provider_error',
    statusCode: 400,
    providerErrorClass: 'buyer@example.invalid rejected <html>',
  } as FrozenDispatchTransportResult);
  assert.deepEqual(out, { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'unknown', statusCode: 400 });
  const thrown = classifyFrozenDispatchResult({ kind: 'submit_threw', errorClass: 'a b@c' } as FrozenDispatchTransportResult);
  assert.equal((thrown as { providerErrorClass: string }).providerErrorClass, 'unknown');
});

test('CL-1: every classified event is a modelled transition out of DISPATCH_INTENT_RECORDED', () => {
  for (const [, input] of ROWS) {
    const out = classifyFrozenDispatchResult(input as FrozenDispatchTransportResult);
    const decision = evaluateConfirmationEmailTransition({
      from: 'DISPATCH_INTENT_RECORDED',
      event: out.event,
      actor: 'worker',
      holdReason: out.event === 'ambiguous_outcome' ? out.holdReason : null,
    });
    assert.equal(decision.allowed, true, JSON.stringify(out));
    assert.equal(decision.allowed === true && decision.permitsProviderCall, false);
  }
});

// ── CL-2: fuzz — nothing but a proven local failure reaches PPDF ───────────

test('CL-2: no provider error, at any status and under any name, is ever pre-dispatch (RL-1)', () => {
  assert.deepEqual([...CONFIRMATION_DISPATCH_PROVEN_PROVIDER_REJECTIONS], [], 'RL-1: the proven list ships empty');
  assert.equal(Object.isFrozen(CONFIRMATION_DISPATCH_PROVEN_PROVIDER_REJECTIONS), true);
  const names: unknown[] = [
    'invalid_idempotent_request', 'concurrent_idempotent_requests', 'validation_error', 'invalid_from_address',
    'missing_required_field', 'invalid_parameter', 'missing_api_key', 'invalid_api_key', 'restricted_api_key',
    'application_error', 'internal_server_error', 'rate_limit_exceeded', 'not_found', 'unknown_future_code',
    '', 7, null, undefined, {}, ['x'],
  ];
  let rows = 0;
  for (let status = 100; status <= 599; status += 1) {
    for (const statusCode of [status, null]) {
      for (const name of names) {
        rows += 1;
        const out = classifyFrozenDispatchResult({ kind: 'provider_error', statusCode, providerErrorClass: name } as FrozenDispatchTransportResult);
        assert.equal(out.event, 'ambiguous_outcome', `${statusCode}/${String(name)}`);
      }
    }
  }
  assert.ok(rows > 19_000);
  for (const errorClass of ['TypeError', 'AbortError', 'TimeoutError', '', 'x y']) {
    assert.equal(classifyFrozenDispatchResult({ kind: 'submit_threw', errorClass } as FrozenDispatchTransportResult).event, 'ambiguous_outcome');
  }
});

// ── CL-3: a message id that cannot be recorded is not an acceptance ─────────

test('CL-3: an accepted result whose id is not record-safe is ambiguous, not accepted', () => {
  for (const id of ['', ' ', 'a b', 'id@example.invalid', 'x'.repeat(129), '<script>', 'é', 42, null, undefined, {}]) {
    const out = classifyFrozenDispatchResult({ kind: 'accepted', id } as unknown as FrozenDispatchTransportResult);
    assert.deepEqual(out, { event: 'ambiguous_outcome', holdReason: 'ambiguous_dispatch', providerErrorClass: 'no_message_id', statusCode: null }, String(id));
  }
  assert.equal(classifyFrozenDispatchResult({ kind: 'accepted', id: 'x'.repeat(128) }).event, 'provider_accepted');
});

// ── CL-4: the dispatch deadline sits inside the stale-claim window ─────────

test('CL-4: the dispatch deadline is shorter than the stale-claim window', () => {
  assert.equal(CONFIRMATION_DISPATCH_DEADLINE_MS, 90_000);
  assert.ok(CONFIRMATION_DISPATCH_DEADLINE_MS < CONFIRMATION_EMAIL_CLAIM_STALE_MS);
});
