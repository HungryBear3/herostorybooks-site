import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CHECKOUT_ATTEMPT_LEASE_COOKIE,
  checkoutAttemptLeaseCookieFromHeader,
  checkoutAttemptLeaseHeaderMatchesCookie,
  resolveCheckoutAttemptLease,
} from '../src/lib/checkout-attempt-lease.ts';
import { resolveServerCheckoutAttemptLease } from '../src/lib/checkout-attempt-restart-client.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';

const ATTEMPT = 'a'.repeat(32);
const NEXT = 'b'.repeat(32);

/**
 * A REAL durable order, differing only in which attempt owns it.
 *
 * The lease decides on `checkoutAttemptId`, so the fixture is built by the
 * production constructor: a hand-shaped partial asserted past the compiler
 * would let that field drift without a single test noticing.
 */
function orderOwnedBy(
  checkoutAttemptId: string,
  id: string = ['ord', '0'.repeat(16)].join('_'),
): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'classic', email: 'buyer@example.com' },
      { id, now: '2026-09-12T12:00:00.000Z' },
    ),
    checkoutAttemptId,
  };
}

const matchingOrder = orderOwnedBy(ATTEMPT);

test('mints a server lease when no valid cookie exists', async () => {
  const result = await resolveCheckoutAttemptLease(null, {
    mintAttemptId: () => NEXT,
    getOrder: async () => null,
    resolveExistingAttempt: async () => 'unknown',
  });
  assert.deepEqual(result, { status: 'ready', attemptId: NEXT, setCookie: true });
});

test('reuses the exact cookie attempt when no order exists, including an in-flight race', async () => {
  let decisions = 0;
  const result = await resolveCheckoutAttemptLease(ATTEMPT, {
    mintAttemptId: () => NEXT,
    getOrder: async () => null,
    resolveExistingAttempt: async () => { decisions += 1; return 'restart_allowed'; },
  });
  assert.deepEqual(result, { status: 'ready', attemptId: ATTEMPT, setCookie: false });
  assert.equal(decisions, 0, 'absence must reuse rather than rotate away from an in-flight attempt');
});

test('an indexed losing cookie attempt resolves and rotates its canonical order', async () => {
  const canonicalOrderId = ['ord', '1111111111111111'].join('_');
  let requestedOrderId = '';
  let decisions = 0;
  const result = await resolveCheckoutAttemptLease(ATTEMPT, {
    mintAttemptId: () => NEXT,
    resolveOrderId: async () => canonicalOrderId,
    getOrder: async (orderId) => {
      requestedOrderId = orderId;
      return orderOwnedBy('c'.repeat(32), canonicalOrderId);
    },
    resolveExistingAttempt: async () => { decisions += 1; return 'restart_allowed'; },
  });

  assert.equal(requestedOrderId, canonicalOrderId);
  assert.equal(decisions, 1);
  assert.deepEqual(result, { status: 'ready', attemptId: NEXT, setCookie: true });
});

test('reuses the exact attempt when authoritative provider state is open or ambiguous', async () => {
  for (const decision of ['resume_required', 'unknown'] as const) {
    const result = await resolveCheckoutAttemptLease(ATTEMPT, {
      mintAttemptId: () => NEXT,
      getOrder: async () => matchingOrder,
      resolveExistingAttempt: async () => decision,
    });
    assert.deepEqual(result, { status: 'ready', attemptId: ATTEMPT, setCookie: false });
  }
});

test('rotates only after authoritative restart approval', async () => {
  const result = await resolveCheckoutAttemptLease(ATTEMPT, {
    mintAttemptId: () => NEXT,
    getOrder: async () => matchingOrder,
    resolveExistingAttempt: async () => 'restart_allowed',
  });
  assert.deepEqual(result, { status: 'ready', attemptId: NEXT, setCookie: true });
});

test('blocks a mismatched durable order identity', async () => {
  const result = await resolveCheckoutAttemptLease(ATTEMPT, {
    mintAttemptId: () => NEXT,
    getOrder: async () => orderOwnedBy('c'.repeat(32)),
    resolveExistingAttempt: async () => 'restart_allowed',
  });
  assert.deepEqual(result, { status: 'blocked' });
});

test('serializes concurrent browser lease calls so tabs converge on the cookie winner', async () => {
  let cookie: string | null = null;
  let minted = 0;
  let queue = Promise.resolve();
  const locks = {
    request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      const result = queue.then(callback, callback);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  const fetchImpl = async () => {
    const observed = cookie;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const attemptId = observed ?? String(++minted).padStart(32, '0');
    cookie = attemptId;
    return new Response(JSON.stringify({
      status: 'ready',
      attemptId,
      provenance: observed ? 'reused' : 'fresh',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const [first, second] = await Promise.all([
    resolveServerCheckoutAttemptLease(fetchImpl as typeof fetch, locks),
    resolveServerCheckoutAttemptLease(fetchImpl as typeof fetch, locks),
  ]);
  assert.deepEqual(first, { status: 'ready', attemptId: cookie, provenance: 'fresh' });
  assert.deepEqual(second, { status: 'ready', attemptId: cookie, provenance: 'reused' });
  assert.equal(minted, 1);
});

test('requests a server lease when Safari blocks the Web Locks getter', async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let fetches = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: Object.defineProperty({}, 'locks', {
      get() { throw new DOMException('Access denied', 'SecurityError'); },
    }),
  });
  try {
    const fetchImpl = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ status: 'ready', attemptId: ATTEMPT, provenance: 'fresh' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    assert.deepEqual(
      await resolveServerCheckoutAttemptLease(fetchImpl),
      { status: 'ready', attemptId: ATTEMPT, provenance: 'fresh' },
    );
    assert.equal(fetches, 1);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});

test('requests one server lease when Safari rejects lock acquisition before the callback starts', async () => {
  let fetches = 0;
  const deniedLocks = {
    async request<T>(): Promise<T> {
      throw new DOMException('Access denied', 'SecurityError');
    },
  };
  const fetchImpl = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ status: 'ready', attemptId: ATTEMPT, provenance: 'fresh' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  assert.deepEqual(
    await resolveServerCheckoutAttemptLease(fetchImpl, deniedLocks),
    { status: 'ready', attemptId: ATTEMPT, provenance: 'fresh' },
  );
  assert.equal(fetches, 1);
});

test('does not retry when the lock callback started and the lease response was lost', async () => {
  let fetches = 0;
  const locks = {
    request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
      return callback();
    },
  };
  const fetchImpl = (async () => {
    fetches += 1;
    throw new TypeError('response lost');
  }) as typeof fetch;

  assert.deepEqual(await resolveServerCheckoutAttemptLease(fetchImpl, locks), { status: 'unavailable' });
  assert.equal(fetches, 1);
});

test('server lease cookie fences stale browser attempt headers', () => {
  assert.equal(checkoutAttemptLeaseHeaderMatchesCookie(null, null), true);
  assert.equal(checkoutAttemptLeaseHeaderMatchesCookie(null, ATTEMPT), false);
  assert.equal(checkoutAttemptLeaseHeaderMatchesCookie(ATTEMPT, ATTEMPT), true);
  assert.equal(checkoutAttemptLeaseHeaderMatchesCookie(ATTEMPT, NEXT), false);
  assert.equal(checkoutAttemptLeaseHeaderMatchesCookie(ATTEMPT, null), true);
  assert.equal(
    checkoutAttemptLeaseCookieFromHeader(`other=x; ${CHECKOUT_ATTEMPT_LEASE_COOKIE}=${ATTEMPT}; another=y`),
    ATTEMPT,
  );
  assert.equal(checkoutAttemptLeaseCookieFromHeader(`${CHECKOUT_ATTEMPT_LEASE_COOKIE}=invalid`), null);
});

test('production route sets a secure HttpOnly same-site cookie and checkout uses the lease before uploads', () => {
  const root = process.cwd();
  const route = fs.readFileSync(path.join(root, 'src/app/api/order/attempt-lease/route.ts'), 'utf8');
  const form = fs.readFileSync(path.join(root, 'src/app/checkout/checkout-form.tsx'), 'utf8');

  assert.equal(CHECKOUT_ATTEMPT_LEASE_COOKIE.startsWith('__Host-'), true);
  assert.match(route, /httpOnly:\s*true/);
  assert.match(route, /secure:\s*true/);
  assert.match(route, /sameSite:\s*['"]strict['"]/);
  assert.match(route, /path:\s*['"]\/['"]/);
  assert.match(route, /sec-fetch-site/);
  assert.match(route, /requestOrigin !== publicOrigin/);
  assert.match(route, /contentType !== ['"]application\/json['"]/);
  assert.match(route, /resolveCheckoutOrderIdForAttempt/);
  assert.match(route, /releaseCheckoutIntentOrderId/);
  assert.match(route, /releaseIntentClaim/);
  const orderHandler = fs.readFileSync(path.join(root, 'src/lib/checkout-order-route-handler.ts'), 'utf8');
  assert.match(orderHandler, /checkoutAttemptLeaseHeaderMatchesCookie/);
  assert.match(form, /['"]x-hsb-checkout-attempt['"]:\s*checkoutAttemptId/);
  const leaseAt = form.indexOf('resolveCheckoutAttemptSubmitLease({');
  const uploadAt = form.indexOf('prepareOrReuseDirectIntakeSubmission(');
  assert.ok(leaseAt >= 0 && uploadAt > leaseAt, 'server lease must be resolved before private uploads');
});
