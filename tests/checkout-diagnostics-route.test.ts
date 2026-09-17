/*
 * `POST /api/checkout/diagnostics` — the sanitized checkout failure event sink.
 *
 * This endpoint exists so the 2026-09-17 iPhone Safari failure has a trace: the
 * buyer's submit stopped before `/api/order`, and the only production evidence
 * was a single `/api/recovery` 200 — the authoritative two-hour scans found no
 * new orders and no Stripe Checkout Sessions to correlate against.
 *
 * It is NOT a log endpoint. It accepts exactly four closed fields, refuses
 * everything else fail-closed, and writes one fixed-label record. These tests
 * are the fence: anything that could turn it into a place to park attacker text
 * — an extra key, a longer string, a value off the enum — must be a 400 that
 * logs nothing at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKOUT_DIAGNOSTIC_GUARD_SCOPE,
  CHECKOUT_DIAGNOSTIC_LOG_LABEL,
  CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES,
  handleCheckoutDiagnosticsRequest,
  type CheckoutDiagnosticsRouteDeps,
} from '../src/lib/checkout-diagnostics-route.ts';
import {
  CHECKOUT_DIAGNOSTIC_CODES,
  CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE,
} from '../src/lib/checkout-submit-diagnostics.ts';
import {
  createMemoryCheckoutGuardStore,
  guardBucketPath,
} from '../src/lib/checkout-request-guard.ts';
import { processEnv } from './support/process-env.ts';

const ORIGIN = 'https://herostorybooks.com';
const URL_ = `${ORIGIN}/api/checkout/diagnostics`;
const REFERENCE = 'A1B2C3D4E5F6';

function recorder() {
  const records: Array<{ label: string; record: unknown }> = [];
  const deps: CheckoutDiagnosticsRouteDeps = {
    env: processEnv({}),
    guardStore: createMemoryCheckoutGuardStore(),
    log: (label, record) => records.push({ label, record }),
  };
  return { records, deps };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = {
  code: 'attempt_storage_unavailable',
  phase: 'attempt',
  reference: REFERENCE,
  serverCode: null,
};

// ── 1. The happy path logs exactly one closed record ────────────────────────

test('a valid event is accepted, stored nowhere, and logged once under a fixed label', async () => {
  const { records, deps } = recorder();
  const response = await handleCheckoutDiagnosticsRequest(post(VALID), deps);

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(records.length, 1);
  assert.equal(records[0].label, CHECKOUT_DIAGNOSTIC_LOG_LABEL);
  assert.deepEqual(records[0].record, {
    code: 'attempt_storage_unavailable',
    phase: 'attempt',
    reference: REFERENCE,
    serverCode: null,
  });
});

test('the logged record is matchable by the reference the buyer was shown', async () => {
  const { records, deps } = recorder();
  await handleCheckoutDiagnosticsRequest(post(VALID), deps);
  const serialized = `${records[0].label} ${JSON.stringify(records[0].record)}`;
  assert.ok(serialized.includes(CHECKOUT_DIAGNOSTIC_LOG_LABEL));
  assert.ok(serialized.includes(REFERENCE), 'the reference must be greppable in Vercel logs');
});

test('every code in the closed vocabulary is accepted with its canonical phase', async () => {
  for (const code of CHECKOUT_DIAGNOSTIC_CODES) {
    const { records, deps } = recorder();
    const response = await handleCheckoutDiagnosticsRequest(
      post({ code, phase: CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE[code], reference: REFERENCE, serverCode: null }),
      deps,
    );
    assert.equal(response.status, 204, code);
    assert.equal(records.length, 1, code);
  }
});

test('an allowlisted order refusal code survives; anything else must already be `other`', async () => {
  const { records, deps } = recorder();
  await handleCheckoutDiagnosticsRequest(
    post({ code: 'order_request_refused', phase: 'order', reference: REFERENCE, serverCode: 'photo_missing' }),
    deps,
  );
  assert.equal((records[0].record as { serverCode: string }).serverCode, 'photo_missing');

  const { records: rejected, deps: strict } = recorder();
  const response = await handleCheckoutDiagnosticsRequest(
    post({ code: 'order_request_refused', phase: 'order', reference: REFERENCE, serverCode: 'brand_new_code' }),
    strict,
  );
  assert.equal(response.status, 400, 'an unbounded server code is a refusal, not a sanitization');
  assert.equal(rejected.length, 0);
});

// ── 2. Fail-closed validation. A refusal logs NOTHING. ──────────────────────

const INVALID_BODIES: Array<[string, unknown]> = [
  ['an unknown key', { ...VALID, note: 'Ada could not upload her photo' }],
  ['a nested object', { ...VALID, serverCode: { toString: 'x' } }],
  ['free text in code', { ...VALID, code: 'ada@example.invalid' }],
  ['an out-of-vocabulary code', { ...VALID, code: 'made_up_code' }],
  ['a mismatched phase', { ...VALID, phase: 'handoff' }],
  ['an out-of-vocabulary phase', { ...VALID, phase: 'checkout' }],
  ['a lowercase reference', { ...VALID, reference: 'a1b2c3d4e5f6' }],
  ['a short reference', { ...VALID, reference: 'A1B2C3' }],
  ['an email-shaped reference', { ...VALID, reference: 'ada@example.invalid' }],
  ['a 32-hex attempt id as the reference', { ...VALID, reference: 'F'.repeat(32) }],
  ['a missing code', { phase: 'attempt', reference: REFERENCE, serverCode: null }],
  ['a missing reference', { code: 'attempt_storage_unavailable', phase: 'attempt', serverCode: null }],
  ['a missing phase', { code: 'attempt_storage_unavailable', reference: REFERENCE, serverCode: null }],
  ['a missing serverCode', { code: 'attempt_storage_unavailable', phase: 'attempt', reference: REFERENCE }],
  ['an array', [VALID]],
  ['a bare string', '"attempt_storage_unavailable"'],
  ['null', 'null'],
  ['a non-JSON body', 'code=attempt_storage_unavailable'],
  ['an empty body', ''],
];

for (const [label, body] of INVALID_BODIES) {
  test(`${label} is refused fail-closed and never logged`, async () => {
    const { records, deps } = recorder();
    const response = await handleCheckoutDiagnosticsRequest(post(body), deps);
    assert.equal(response.status, 400, label);
    assert.equal(response.headers.get('cache-control'), 'no-store', label);
    assert.equal(records.length, 0, `${label} must not reach the log`);
  });
}

test('a refusal body echoes no part of the rejected input', async () => {
  const { deps } = recorder();
  const response = await handleCheckoutDiagnosticsRequest(
    post({ ...VALID, reference: 'ada@example.invalid', note: 'ada-birthday.heic' }),
    deps,
  );
  const text = await response.text();
  for (const forbidden of ['ada@example.invalid', 'ada-birthday', 'heic', 'note']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} was echoed back`);
  }
});

// ── 3. Bounded size and fields ──────────────────────────────────────────────

test('the accepted body is bounded to a few hundred bytes', () => {
  assert.ok(CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES > 0);
  assert.ok(
    CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES <= 1024,
    'a diagnostics sink with a kilobyte-plus budget is a log amplifier',
  );
  assert.ok(
    JSON.stringify(VALID).length < CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES,
    'a real event must fit comfortably',
  );
});

test('an oversized body is refused before it is parsed or logged', async () => {
  const { records, deps } = recorder();
  const padded = JSON.stringify({ ...VALID, code: 'x'.repeat(CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES) });
  const response = await handleCheckoutDiagnosticsRequest(post(padded), deps);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(records.length, 0);
});

test('a lying content-length cannot smuggle an oversized body past the cap', async () => {
  const { records, deps } = recorder();
  const padded = JSON.stringify({ ...VALID, code: 'x'.repeat(CHECKOUT_DIAGNOSTIC_MAX_BODY_BYTES) });
  const request = post(padded, { 'content-length': '40' });
  const response = await handleCheckoutDiagnosticsRequest(request, deps);
  assert.ok(response.status === 413 || response.status === 400, `got ${response.status}`);
  assert.equal(records.length, 0);
});

test('an unknown-length oversized stream is cancelled as soon as the byte cap is crossed', async () => {
  const { records, deps } = recorder();
  let emittedChunks = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emittedChunks >= 256) {
        controller.close();
        return;
      }
      emittedChunks += 1;
      controller.enqueue(new Uint8Array(256));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const response = await handleCheckoutDiagnosticsRequest(request, deps);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(cancelled, true, 'the unread remainder must be cancelled');
  assert.ok(emittedChunks <= 3, `read ${emittedChunks * 256} bytes before refusing`);
  assert.equal(records.length, 0);
});

test('a throwing log sink cannot reject the endpoint or alter its no-store response', async () => {
  const { deps } = recorder();
  const response = await handleCheckoutDiagnosticsRequest(post(VALID), {
    ...deps,
    log: () => {
      throw new Error('sink unavailable');
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

// ── 4. Same-origin only ─────────────────────────────────────────────────────

test('a cross-site post is refused and never logged', async () => {
  for (const headers of [
    { origin: 'https://attacker.example' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: '' },
  ]) {
    const { records, deps } = recorder();
    const response = await handleCheckoutDiagnosticsRequest(post(VALID, headers), deps);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(records.length, 0);
  }
});

test('a non-JSON content type is refused', async () => {
  const { records, deps } = recorder();
  const response = await handleCheckoutDiagnosticsRequest(
    post(VALID, { 'content-type': 'text/plain' }),
    deps,
  );
  assert.equal(response.status, 415);
  assert.equal(records.length, 0);
});

// ── 5. Bounded volume, on its own budget ────────────────────────────────────

test('diagnostics spend a budget of their own, never checkout intake capacity', async () => {
  // Starving real uploads to make room for telemetry would be a checkout
  // regression. A dedicated scope keeps the two buckets disjoint.
  assert.equal(CHECKOUT_DIAGNOSTIC_GUARD_SCOPE, 'diagnostics');
  const { deps } = recorder();
  const now = Date.now();
  await handleCheckoutDiagnosticsRequest(post(VALID), { ...deps, now: () => now });
  const bucketStart = now - (now % 60_000);
  assert.notEqual(
    await deps.guardStore!.read(guardBucketPath(CHECKOUT_DIAGNOSTIC_GUARD_SCOPE, bucketStart)),
    null,
    'the diagnostics bucket must record the spend',
  );
  assert.equal(
    await deps.guardStore!.read(guardBucketPath('intake', bucketStart)),
    null,
    'the intake budget must be untouched',
  );
});

test('exhausting the diagnostics budget fails closed without logging', async () => {
  const { records, deps } = recorder();
  const now = Date.now();
  const bounded = { ...deps, now: () => now, requestLimit: 1 };
  const first = await handleCheckoutDiagnosticsRequest(post(VALID), bounded);
  assert.equal(first.status, 204);
  const second = await handleCheckoutDiagnosticsRequest(post(VALID), bounded);
  assert.ok(second.status === 429 || second.status === 503, `got ${second.status}`);
  assert.equal(second.headers.get('cache-control'), 'no-store');
  assert.equal(records.length, 1, 'a refused request logs no diagnostic record');
});

// ── 6. The Next route shell ─────────────────────────────────────────────────

test('the exported route shell delegates to the audited handler', async () => {
  // Imported dynamically so the rest of this suite still runs if the shell is
  // missing. Relative `.ts` imports keep the shell testable at all — the `@/…`
  // alias is unresolvable under the node runner (see checkout-intake-route-shells).
  const { POST } = await import('../src/app/api/checkout/diagnostics/route.ts');
  const response = await POST(post(VALID));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const refused = await POST(post({ ...VALID, note: 'free text' }));
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get('cache-control'), 'no-store');
});

// ── 7. The budget degrades to a per-instance cap, never to nothing ───────────
//
// `resolveCheckoutGuardStore` fails closed with 503 when no durable store is
// configured, which is right for intake: that budget rations scarce upload
// capacity, and an unenforceable ration must refuse. Diagnostics ration only
// LOG VOLUME, which is already a per-instance resource — so a per-instance
// counter bounds exactly the thing at risk. Failing closed here would instead
// mean the endpoint silently records nothing in any environment without the
// durable guard, which is the outage this whole change exists to end.

test('an unconfigured guard store still records, under a per-instance cap', async () => {
  const records: Array<{ label: string; record: unknown }> = [];
  const response = await handleCheckoutDiagnosticsRequest(post(VALID), {
    env: processEnv({}),
    log: (label, record) => records.push({ label, record }),
  });
  assert.equal(response.status, 204, 'diagnostics must not require durable guard config');
  assert.equal(records.length, 1);
});

test('the per-instance fallback is still a bound, not an open door', async () => {
  const records: Array<{ label: string; record: unknown }> = [];
  const now = Date.now();
  const deps: CheckoutDiagnosticsRouteDeps = {
    env: processEnv({}),
    now: () => now,
    requestLimit: 2,
    log: (label, record) => records.push({ label, record }),
  };
  const statuses: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    statuses.push((await handleCheckoutDiagnosticsRequest(post(VALID), deps)).status);
  }
  assert.ok(statuses.includes(429), `expected a refusal among ${statuses.join(',')}`);
  assert.ok(records.length <= 2, `the cap must hold; logged ${records.length}`);
});

test('the fallback counter is never the intake budget', async () => {
  // Sharing one process-local store across scopes would let diagnostics eat
  // intake capacity on any instance using the fallback.
  const store = createMemoryCheckoutGuardStore();
  const now = Date.now();
  await handleCheckoutDiagnosticsRequest(post(VALID), {
    env: processEnv({}),
    guardStore: store,
    now: () => now,
    log: () => {},
  });
  const bucketStart = now - (now % 60_000);
  assert.equal(await store.read(guardBucketPath('intake', bucketStart)), null);
});
