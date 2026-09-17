/*
 * Checkout submit diagnostics.
 *
 * Incident (2026-09-17, iPhone Safari): a buyer's Continue press failed and the
 * banner said only that we couldn't start the order. Production evidence showed
 * one `/api/recovery` 200 and NO `/api/order` request at all; the authoritative
 * two-hour scans found zero new orders and zero Stripe Checkout Sessions. There
 * was nothing to correlate the buyer's report with, because the banner carried
 * no code and the browser emitted no event.
 *
 * These tests pin the fix: a closed diagnostic vocabulary, a buyer-shareable
 * per-occurrence reference, and a sanitized best-effort event. The privacy rule
 * is absolute — the only things that may leave the browser are closed enums and
 * the opaque reference.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKOUT_DIAGNOSTIC_CODES,
  CHECKOUT_DIAGNOSTIC_DISPLAY_CODES,
  CHECKOUT_DIAGNOSTIC_EVENT_KEYS,
  CHECKOUT_DIAGNOSTIC_PHASES,
  CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE,
  CHECKOUT_DIAGNOSTIC_REFERENCE,
  CHECKOUT_DIAGNOSTIC_REPORT_PATH,
  CHECKOUT_ORDER_REFUSAL_CODES,
  CheckoutSubmitDiagnosticError,
  checkoutDiagnosticReferenceLine,
  classifyCheckoutSubmitFailure,
  newCheckoutDiagnosticReference,
  reportCheckoutSubmitDiagnostic,
} from '../src/lib/checkout-submit-diagnostics.ts';
import { CHECKOUT_HANDOFF_UNCONFIRMED } from '../src/lib/checkout-handoff.ts';
import { DirectIntakePreparationError } from '../src/lib/checkout-intake-client-flow.ts';
import { LegacyCheckoutPayloadTooLargeError } from '../src/lib/checkout-legacy-payload-preflight.ts';

// ── 1. The vocabulary is closed and total ───────────────────────────────────

test('the diagnostic vocabulary is exactly the audited closed set', () => {
  assert.deepEqual([...CHECKOUT_DIAGNOSTIC_CODES].sort(), [
    'attempt_identity_conflict',
    'attempt_lease_unavailable',
    'attempt_storage_unavailable',
    'intake_preparation_failed',
    'network_unavailable',
    'order_request_refused',
    'previous_attempt_paid',
    'stripe_handoff_unconfirmed',
  ]);
  assert.deepEqual([...CHECKOUT_DIAGNOSTIC_PHASES], ['attempt', 'intake', 'order', 'handoff']);
});

test('every code has a short, unique, stable buyer-visible display code and a phase', () => {
  assert.deepEqual(CHECKOUT_DIAGNOSTIC_DISPLAY_CODES, {
    attempt_identity_conflict: 'CHK-01',
    attempt_storage_unavailable: 'CHK-02',
    attempt_lease_unavailable: 'CHK-03',
    intake_preparation_failed: 'CHK-04',
    order_request_refused: 'CHK-05',
    network_unavailable: 'CHK-06',
    stripe_handoff_unconfirmed: 'CHK-07',
    previous_attempt_paid: 'CHK-08',
  });
  const seen = new Set<string>();
  for (const code of CHECKOUT_DIAGNOSTIC_CODES) {
    const display = CHECKOUT_DIAGNOSTIC_DISPLAY_CODES[code];
    assert.match(display, /^CHK-\d{2}$/, `${code} must have a short stable display code`);
    assert.equal(seen.has(display), false, `${display} is used twice`);
    seen.add(display);
    assert.ok(
      CHECKOUT_DIAGNOSTIC_PHASES.includes(CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE[code]),
      `${code} must map to a closed phase`,
    );
  }
});

// ── 2. Closed mapping for every required failure class ──────────────────────

const CLASSES = [
  ['browser attempt identity conflict', 'attempt_identity_conflict', 'attempt'],
  ['browser storage reserve/readback failure', 'attempt_storage_unavailable', 'attempt'],
  ['attempt lease/reconciliation unavailable', 'attempt_lease_unavailable', 'attempt'],
  ['Stripe hand-off invalid/unconfirmed', 'stripe_handoff_unconfirmed', 'handoff'],
  ['an already-paid previous attempt', 'previous_attempt_paid', 'attempt'],
] as const;

for (const [label, code, phase] of CLASSES) {
  test(`${label} classifies as ${code}`, () => {
    const classified = classifyCheckoutSubmitFailure({
      error: new CheckoutSubmitDiagnosticError(code, 'buyer-facing sentence'),
    });
    assert.equal(classified.code, code);
    assert.equal(classified.phase, phase);
    assert.equal(classified.serverCode, null);
  });
}

test('a direct-intake preparation/upload failure classifies as intake_preparation_failed', () => {
  const classified = classifyCheckoutSubmitFailure({
    error: new DirectIntakePreparationError('upload_failed', 'hero photo'),
  });
  assert.equal(classified.code, 'intake_preparation_failed');
  assert.equal(classified.phase, 'intake');
  // The asset LABEL is buyer-supplied context. It must never reach the event.
  assert.equal(classified.serverCode, null);
});

test('an oversized legacy multipart payload classifies as local intake preparation, not network failure', () => {
  const classified = classifyCheckoutSubmitFailure({
    error: new LegacyCheckoutPayloadTooLargeError(4 * 1024 * 1024, 3.5 * 1024 * 1024),
  });
  assert.equal(classified.code, 'intake_preparation_failed');
  assert.equal(classified.phase, 'intake');
  assert.equal(classified.serverCode, null);
});

test('an order API refusal keeps its server code only when the closed allowlist holds it', () => {
  const known = classifyCheckoutSubmitFailure({
    error: new CheckoutSubmitDiagnosticError(
      'order_request_refused',
      'We could not confirm the status of your order.',
      'photo_missing',
    ),
  });
  assert.equal(known.code, 'order_request_refused');
  assert.equal(known.phase, 'order');
  assert.equal(known.serverCode, 'photo_missing');
  assert.ok(CHECKOUT_ORDER_REFUSAL_CODES.includes('photo_missing'));

  for (const unbounded of ['some_new_server_code', 'charlie@example.com', 'x'.repeat(400), '']) {
    const classified = classifyCheckoutSubmitFailure({
      error: new CheckoutSubmitDiagnosticError('order_request_refused', 'sentence', unbounded),
    });
    assert.equal(classified.code, 'order_request_refused');
    assert.equal(
      classified.serverCode,
      'other',
      'an unrecognized server code must degrade to the closed `other`, never be echoed',
    );
  }
});

test('an unrecognized or network failure classifies as network_unavailable', () => {
  for (const error of [
    new TypeError('Failed to fetch'),
    new Error('Load failed'),
    'not an error at all',
    null,
    undefined,
  ]) {
    const classified = classifyCheckoutSubmitFailure({ error });
    assert.equal(classified.code, 'network_unavailable');
    assert.equal(classified.phase, 'order');
    assert.equal(classified.serverCode, null);
  }
});

test('unknown failures use the actual submit phase instead of always claiming network/order', () => {
  assert.deepEqual(
    classifyCheckoutSubmitFailure({ error: new Error('cookie access denied'), fallbackPhase: 'intake' }),
    { code: 'intake_preparation_failed', phase: 'intake', serverCode: null },
  );
  assert.deepEqual(
    classifyCheckoutSubmitFailure({ error: new Error('local attempt failure'), fallbackPhase: 'attempt' }),
    { code: 'attempt_storage_unavailable', phase: 'attempt', serverCode: null },
  );
  assert.deepEqual(
    classifyCheckoutSubmitFailure({ error: new Error('fetch failed'), fallbackPhase: 'order' }),
    { code: 'network_unavailable', phase: 'order', serverCode: null },
  );
  assert.deepEqual(
    classifyCheckoutSubmitFailure({ error: new Error('navigation failed'), fallbackPhase: 'handoff' }),
    { code: 'stripe_handoff_unconfirmed', phase: 'handoff', serverCode: null },
  );
});

test('the shared unconfirmed hand-off sentence classifies as a hand-off failure', () => {
  // checkout-form throws this bare string for a 200 with no redirect target and
  // for a rejected redirect host; both are hand-off failures, not order ones.
  const classified = classifyCheckoutSubmitFailure({
    error: new CheckoutSubmitDiagnosticError(
      'stripe_handoff_unconfirmed',
      CHECKOUT_HANDOFF_UNCONFIRMED,
    ),
  });
  assert.equal(classified.code, 'stripe_handoff_unconfirmed');
  assert.equal(classified.phase, 'handoff');
});

test('classification never returns a code outside the closed vocabulary', () => {
  const rogue = new CheckoutSubmitDiagnosticError('attempt_storage_unavailable', 'x');
  // A tampered/garbage code on the error must not escape the vocabulary.
  (rogue as unknown as { diagnosticCode: string }).diagnosticCode = 'made_up_code';
  const classified = classifyCheckoutSubmitFailure({ error: rogue });
  assert.ok(
    CHECKOUT_DIAGNOSTIC_CODES.includes(classified.code),
    'an unknown code must degrade inside the vocabulary',
  );
  assert.equal(classified.code, 'network_unavailable');
});

// ── 3. The per-occurrence reference ─────────────────────────────────────────

test('references are per-occurrence, opaque, and shareable', () => {
  const first = newCheckoutDiagnosticReference();
  const second = newCheckoutDiagnosticReference();
  assert.match(first, CHECKOUT_DIAGNOSTIC_REFERENCE);
  assert.match(second, CHECKOUT_DIAGNOSTIC_REFERENCE);
  assert.notEqual(first, second, 'each occurrence needs its own reference');
  assert.equal(first.length, 12, 'short enough for a buyer to read out to support');
});

test('a reference is never derived from an attempt id', () => {
  // A 32-hex checkout attempt id must not be reconstructible from a reference.
  const attemptId = 'a'.repeat(32);
  for (let index = 0; index < 50; index += 1) {
    const reference = newCheckoutDiagnosticReference();
    assert.equal(attemptId.includes(reference.toLowerCase()), false);
  }
});

test('the buyer-visible reference line joins the display code to the occurrence reference', () => {
  const line = checkoutDiagnosticReferenceLine({
    code: 'attempt_lease_unavailable',
    reference: 'A1B2C3D4E5F6',
  });
  assert.equal(line, 'Support reference: CHK-03-A1B2C3D4E5F6');
});

test('the reference line refuses an out-of-vocabulary code rather than echoing it', () => {
  const line = checkoutDiagnosticReferenceLine({
    code: 'made_up_code' as never,
    reference: 'A1B2C3D4E5F6',
  });
  assert.doesNotMatch(line, /made_up_code/);
  assert.equal(line, 'Support reference: CHK-06-A1B2C3D4E5F6');
});

// ── 4. Best-effort, sanitized reporting ─────────────────────────────────────

function capturingFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('the reported event carries only the closed diagnostic fields', async () => {
  const { calls, fetchImpl } = capturingFetch();
  await reportCheckoutSubmitDiagnostic(
    { code: 'order_request_refused', phase: 'order', serverCode: 'photo_missing' },
    { reference: 'A1B2C3D4E5F6', fetchImpl },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CHECKOUT_DIAGNOSTIC_REPORT_PATH);
  assert.equal(calls[0].url.startsWith('/'), true, 'same-origin relative path only');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(calls[0].init.keepalive, true, 'the page may navigate away mid-report');

  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(Object.keys(body).sort(), [...CHECKOUT_DIAGNOSTIC_EVENT_KEYS].sort());
  assert.deepEqual(body, {
    code: 'order_request_refused',
    phase: 'order',
    reference: 'A1B2C3D4E5F6',
    serverCode: 'photo_missing',
  });
});

test('the reported event carries no buyer data under any input', async () => {
  const { calls, fetchImpl } = capturingFetch();
  await reportCheckoutSubmitDiagnostic(
    {
      code: 'intake_preparation_failed',
      phase: 'intake',
      // Everything below is hostile input the caller must not be able to smuggle.
      serverCode: 'ada@example.invalid',
      message: 'Ada could not upload ada-birthday.heic',
      label: 'hero photo',
      email: 'ada@example.invalid',
      attemptId: 'f'.repeat(32),
      userAgent: 'Mozilla/5.0 (iPhone)',
    } as never,
    { reference: 'A1B2C3D4E5F6', fetchImpl },
  );
  const serialized = String(calls[0].init.body);
  for (const forbidden of ['Ada', 'ada@example.invalid', 'heic', 'hero photo', 'Mozilla', 'f'.repeat(32)]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must never be reported`);
  }
  assert.deepEqual(JSON.parse(serialized), {
    code: 'intake_preparation_failed',
    phase: 'intake',
    reference: 'A1B2C3D4E5F6',
    serverCode: 'other',
  });
});

test('reporting never throws, whatever the transport does', async () => {
  const rejecting = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  await assert.doesNotReject(reportCheckoutSubmitDiagnostic(
    { code: 'network_unavailable', phase: 'order' },
    { reference: 'A1B2C3D4E5F6', fetchImpl: rejecting },
  ));

  const refusing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  await assert.doesNotReject(reportCheckoutSubmitDiagnostic(
    { code: 'network_unavailable', phase: 'order' },
    { reference: 'A1B2C3D4E5F6', fetchImpl: refusing },
  ));

  const throwingSync = (() => {
    throw new Error('transport exploded synchronously');
  }) as unknown as typeof fetch;
  await assert.doesNotReject(reportCheckoutSubmitDiagnostic(
    { code: 'network_unavailable', phase: 'order' },
    { reference: 'A1B2C3D4E5F6', fetchImpl: throwingSync },
  ));
});

test('reporting mutates no attempt, risk, or storage state', async () => {
  // The reporter is given no storage and no attempt identity at all, by design:
  // there is no parameter through which it could clear or rotate an attempt.
  const { calls, fetchImpl } = capturingFetch();
  await reportCheckoutSubmitDiagnostic(
    { code: 'attempt_storage_unavailable', phase: 'attempt' },
    { reference: 'A1B2C3D4E5F6', fetchImpl },
  );
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(String(calls[0].init.body)).serverCode, null);
});
