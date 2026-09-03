/*
 * Checkout abuse guard — separation of concerns and fail-closed durable state.
 *
 * Regressions for four findings against the rejected candidate:
 *
 *  1. The browser same-origin check was fused into the same function that
 *     consumed the budget, and the upload route called it on EVERY POST. The
 *     Vercel Blob completion callback is a server-to-server request with no
 *     `Origin` and no `Sec-Fetch-Site`, so in production every completion was
 *     rejected with 403 `origin_required` before its signature was ever
 *     verified. Browser guarding and budget accounting are now two separate
 *     exports and the origin check is never reachable from the budget path.
 *
 *  2. A read failure was swallowed and treated as an absent bucket, so an
 *     unavailable store ALLOWED unlimited traffic. It now fails closed.
 *
 *  3. Stored records were used without validation, so a seeded
 *     `requestCount: "x"` produced `"x1"`, `"x11"`, ... and every comparison
 *     against the limit was `NaN > n` — false, forever. Records are now schema
 *     validated and anything that does not validate fails closed.
 *
 *  4. Counters must bound global cost without trusting a forwarded client
 *     identity, so the bucket a request lands in cannot depend on a spoofable
 *     header.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { IntakeError } from '../src/lib/checkout-intake.ts';
import {
  assertBrowserMutationRequest,
  CHECKOUT_GUARD_TOKEN_ENV,
  consumeCheckoutBudget,
  createMemoryCheckoutGuardStore,
  enforceCheckoutBudget,
  guardBucketPath,
  parseGuardBucket,
  type CheckoutGuardStore,
} from '../src/lib/checkout-request-guard.ts';

const NOW = Date.parse('2026-09-02T12:00:30.000Z');
const BUCKET_START = Date.parse('2026-09-02T12:00:00.000Z');

const LIMITS = {
  requestLimit: 3,
  intakeCreationLimit: 2,
  uploadReservationLimit: 2,
  uploadByteLimit: 4096,
  finalizationLimit: 1,
  replacementLimit: 2,
};

function browserRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://herostorybooks.com/api/checkout/intake', {
    method: 'POST',
    headers: {
      origin: 'https://herostorybooks.com',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
  });
}

/** What Vercel Blob sends: no Origin, no Sec-Fetch-Site, signature instead. */
function callbackRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://herostorybooks.com/api/checkout/intake/upload', {
    method: 'POST',
    headers: { 'x-vercel-signature': 'deadbeef', ...headers },
  });
}

function code(error: unknown): string {
  assert.ok(error instanceof IntakeError, `expected IntakeError, got ${String(error)}`);
  return error.code;
}

// ---------------------------------------------------------------------------
// 1. Browser guard and budget accounting are separate
// ---------------------------------------------------------------------------

test('browser mutation guard accepts a same-origin browser request', () => {
  assert.doesNotThrow(() => assertBrowserMutationRequest(browserRequest()));
});

test('browser mutation guard rejects cross-origin and header-less requests', () => {
  assert.throws(
    () => assertBrowserMutationRequest(callbackRequest()),
    (error) => code(error) === 'origin_required',
  );
  assert.throws(
    () => assertBrowserMutationRequest(browserRequest({ origin: 'https://evil.example' })),
    (error) => code(error) === 'origin_forbidden',
  );
  assert.throws(
    () => assertBrowserMutationRequest(browserRequest({ 'sec-fetch-site': 'cross-site' })),
    (error) => code(error) === 'origin_forbidden',
  );
});

test('the budget path never inspects browser headers', async () => {
  const store = createMemoryCheckoutGuardStore();
  // A Vercel completion callback carries neither Origin nor Sec-Fetch-Site.
  // Under the rejected candidate this threw 403 origin_required.
  await consumeCheckoutBudget(store, {
    scope: 'intake-upload-callback',
    now: NOW,
    limits: LIMITS,
    cost: { requestCount: 1 },
  });
  const bucket = await store.read(guardBucketPath('intake-upload-callback', BUCKET_START));
  assert.equal((bucket?.record as { requestCount: number }).requestCount, 1);
  // Nothing above took a Request at all; the header-bearing object is only
  // ever handed to assertBrowserMutationRequest.
  assert.equal(typeof assertBrowserMutationRequest, 'function');
  assert.throws(() => assertBrowserMutationRequest(callbackRequest()));
});

// ---------------------------------------------------------------------------
// 2. Unavailable store fails closed
// ---------------------------------------------------------------------------

test('an unavailable guard store fails closed and writes nothing', async () => {
  let writes = 0;
  const store: CheckoutGuardStore = {
    async read() {
      throw new Error('blob get failed');
    },
    async write() {
      writes += 1;
      return true;
    },
  };

  await assert.rejects(
    consumeCheckoutBudget(store, { scope: 'intake-create', now: NOW, limits: LIMITS, cost: {} }),
    (error) => code(error) === 'abuse_guard_unavailable' && (error as IntakeError).status === 503,
  );
  assert.equal(writes, 0, 'a failed read must not fall through to a fresh write');
});

test('a failing guard write fails closed', async () => {
  const store: CheckoutGuardStore = {
    async read() {
      return null;
    },
    async write() {
      throw new Error('blob put failed');
    },
  };
  await assert.rejects(
    consumeCheckoutBudget(store, { scope: 'intake-create', now: NOW, limits: LIMITS, cost: {} }),
    (error) => code(error) === 'abuse_guard_unavailable',
  );
});

// ---------------------------------------------------------------------------
// 3. Malformed / conflicting durable state fails closed
// ---------------------------------------------------------------------------

test('parseGuardBucket rejects non-numeric, negative and fractional counters', () => {
  const base = {
    scope: 'intake-create',
    bucketStart: BUCKET_START,
    requestCount: 0,
    intakeCreations: 0,
    uploadReservations: 0,
    uploadBytes: 0,
    finalizations: 0,
    replacementCount: 0,
    updatedAt: '2026-09-02T12:00:00.000Z',
  };
  const expect = { scope: 'intake-create', bucketStart: BUCKET_START };

  assert.doesNotThrow(() => parseGuardBucket(base, expect));
  for (const bad of ['x', '1', null, undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => parseGuardBucket({ ...base, requestCount: bad }, expect),
      (error) => code(error) === 'abuse_guard_state_invalid',
      `requestCount=${String(bad)} must fail closed`,
    );
  }
  assert.throws(
    () => parseGuardBucket({ ...base, scope: 'other' }, expect),
    (error) => code(error) === 'abuse_guard_state_invalid',
  );
  assert.throws(
    () => parseGuardBucket({ ...base, bucketStart: BUCKET_START - 60_000 }, expect),
    (error) => code(error) === 'abuse_guard_state_invalid',
  );
  assert.throws(
    () => parseGuardBucket('not-an-object', expect),
    (error) => code(error) === 'abuse_guard_state_invalid',
  );
});

test('a malformed stored counter cannot bypass the limit', async () => {
  const pathname = guardBucketPath('intake-create', BUCKET_START);
  const store: CheckoutGuardStore = {
    async read(path) {
      assert.equal(path, pathname);
      // Exactly the probe that passed 3/3 against the rejected candidate.
      return { record: { scope: 'intake-create', bucketStart: BUCKET_START, requestCount: 'x' }, etag: 'e1' };
    },
    async write() {
      throw new Error('must not write over unvalidated state');
    },
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      consumeCheckoutBudget(store, {
        scope: 'intake-create',
        now: NOW,
        limits: { ...LIMITS, requestLimit: 1 },
        cost: {},
      }),
      (error) => code(error) === 'abuse_guard_state_invalid' && (error as IntakeError).status === 503,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Race-safe accounting and real bounds
// ---------------------------------------------------------------------------

test('a lost CAS race is retried, never applied as a last-writer-wins update', async () => {
  const store = createMemoryCheckoutGuardStore();
  const pathname = guardBucketPath('intake-upload', BUCKET_START);

  // Writer B slips its increment in between writer A's read and A's write.
  let interleaved = false;
  const racing: CheckoutGuardStore = {
    read: (path) => store.read(path),
    async write(path, record, options) {
      if (!interleaved) {
        interleaved = true;
        await consumeCheckoutBudget(store, {
          scope: 'intake-upload',
          now: NOW,
          limits: LIMITS,
          cost: { requestCount: 1 },
        });
      }
      return store.write(path, record, options);
    },
  };

  await consumeCheckoutBudget(racing, {
    scope: 'intake-upload',
    now: NOW,
    limits: LIMITS,
    cost: { requestCount: 1 },
  });

  const bucket = await store.read(pathname);
  assert.equal(
    (bucket?.record as { requestCount: number }).requestCount,
    2,
    'both increments survive',
  );
});

test('each counter bounds its own dimension', async () => {
  const store = createMemoryCheckoutGuardStore();
  const spend = (cost: Record<string, number>) => consumeCheckoutBudget(store, {
    scope: 'intake-upload',
    now: NOW,
    limits: LIMITS,
    cost,
  });

  await spend({ requestCount: 1, uploadBytes: 2048, uploadReservations: 1 });
  await spend({ requestCount: 1, uploadBytes: 2048, uploadReservations: 1 });
  // Byte budget is now exactly spent; the next reservation exceeds it even
  // though the request and reservation counts still have room.
  await assert.rejects(
    spend({ requestCount: 1, uploadBytes: 1 }),
    (error) => code(error) === 'rate_limited' && (error as IntakeError).status === 429,
  );

  const bucket = await store.read(guardBucketPath('intake-upload', BUCKET_START));
  assert.equal((bucket?.record as { uploadBytes: number }).uploadBytes, 4096, 'a refused spend is not banked');
});

test('replacement churn and finalization have their own budgets', async () => {
  const store = createMemoryCheckoutGuardStore();
  await consumeCheckoutBudget(store, {
    scope: 'finalize',
    now: NOW,
    limits: LIMITS,
    cost: { finalizations: 1 },
  });
  await assert.rejects(
    consumeCheckoutBudget(store, {
      scope: 'finalize',
      now: NOW,
      limits: LIMITS,
      cost: { finalizations: 1 },
    }),
    (error) => code(error) === 'rate_limited',
  );

  const churn = createMemoryCheckoutGuardStore();
  await consumeCheckoutBudget(churn, {
    scope: 'intake-upload',
    now: NOW,
    limits: LIMITS,
    cost: { replacementCount: 2 },
  });
  await assert.rejects(
    consumeCheckoutBudget(churn, {
      scope: 'intake-upload',
      now: NOW,
      limits: LIMITS,
      cost: { replacementCount: 1 },
    }),
    (error) => code(error) === 'rate_limited',
  );
});

test('bucket identity is global and cannot be shifted by a forwarded address', () => {
  const a = guardBucketPath('intake-upload', BUCKET_START);
  const b = guardBucketPath('intake-upload', BUCKET_START);
  assert.equal(a, b);
  assert.match(a, /^guard\/intake-upload\/1[0-9]+\.json$/);
  assert.equal(a.includes('.'), true);
  // The path is a pure function of (scope, bucketStart). There is no request
  // argument it could derive an identity from.
  assert.equal(guardBucketPath.length, 2);
});

test('a scope with path separators is refused rather than escaping its prefix', () => {
  assert.throws(
    () => guardBucketPath('../orders', BUCKET_START),
    (error) => code(error) === 'abuse_guard_scope_invalid',
  );
});

// ---------------------------------------------------------------------------
// 5. Environment resolution fails closed
// ---------------------------------------------------------------------------

test('production without a durable guard configured fails closed', async () => {
  await assert.rejects(
    enforceCheckoutBudget({
      scope: 'intake-create',
      now: NOW,
      env: { VERCEL_ENV: 'production', HSB_CHECKOUT_ALLOW_PROCESS_LOCAL_GUARD: 'true' } as NodeJS.ProcessEnv,
    }),
    (error) => code(error) === 'abuse_guard_unavailable',
  );
});

test('the durable guard refuses to share a credential with orders or intake', async () => {
  await assert.rejects(
    enforceCheckoutBudget({
      scope: 'intake-create',
      now: NOW,
      env: {
        VERCEL_ENV: 'production',
        HSB_CHECKOUT_GUARD_MODE: 'durable',
        [CHECKOUT_GUARD_TOKEN_ENV]: 'shared-token',
        BLOB_READ_WRITE_TOKEN: 'shared-token',
      } as NodeJS.ProcessEnv,
    }),
    (error) => code(error) === 'abuse_guard_unavailable',
  );
});
