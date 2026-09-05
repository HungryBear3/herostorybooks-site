/**
 * The legacy public checkout entrypoint — the actual control-flow boundary
 * `/api/order` delegates its whole pre-media decision to.
 *
 * The bug this pins: the route used to read `persistedDraft.stripeSessionId`
 * itself and answer from a local fast path — returning the stored Session's URL
 * when the provider called it open, and a permanent 409 otherwise. That fast
 * path ran BEFORE the shared provisioning machine and therefore had none of it:
 * no supersession of an expired Session, so a buyer whose Session lapsed could
 * never check out again; no candidate reconciliation, so a Session created but
 * never bound was invisible; and a categorical "already reached payment"
 * refusal for statuses that prove nothing of the sort.
 *
 * Every reachable resume — bound, candidate, provisioning marker — now enters
 * the same recovery the direct path uses. The route keeps no decision of its
 * own; see the source guard in checkout-direct-order-wiring.test.ts.
 *
 * Everything here runs the REAL order CAS and the REAL provisioning machine
 * against an in-memory store. Only the provider is a double.
 */
import assert from 'node:assert/strict';
import test, { afterEach, before, after } from 'node:test';

import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  beginCheckoutSessionProvisioning,
  bindOrderCheckoutSession,
  checkoutProviderIdempotencyKey,
  createOrderRecord,
  persistNewOrder,
  persistOrResumeCheckoutOrder,
  readOrderVersioned,
  recordCheckoutSessionCandidate,
  renewCheckoutLease,
  supersedeExpiredCheckoutSession,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';
import {
  resumeOrContinueLegacyCheckout,
  type LegacyCheckoutEntrypointResult,
} from '../src/lib/checkout-legacy-order.ts';
import {
  CHECKOUT_PAYMENT_MAY_BE_COMPLETE,
  type CheckoutSessionProvisionDeps,
  type ProviderCheckoutSession,
} from '../src/lib/checkout-session-provisioning.ts';

const ORDER_ID = ['ord', '0123456789abcdef'].join('_');
const ATTEMPT = 'b'.repeat(32);
const FINGERPRINT = 'c'.repeat(64);
const LEASE = '11111111-1111-4111-8111-111111111111';
const RETRY_LEASE = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-03-01T12:00:00.000Z');
const EXPIRED = new Date(NOW.getTime() - 60_000).toISOString();
const LIVE = new Date(NOW.getTime() + 5 * 60_000).toISOString();
/**
 * When the EARLIER request did its work — while the lease it now carries was
 * still live. Every durable write below is committed at this moment and read
 * back at NOW, by which time that lease has lapsed. That is the whole shape of
 * a retry: the record is real, its authority is not.
 */
const EARLIER = new Date(NOW.getTime() - 120_000);

const savedEnv: Record<string, string | undefined> = {};

before(() => {
  for (const key of ['BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_ACCESS_MODE', 'HSB_REQUIRE_DURABLE_PERSISTENCE']) {
    savedEnv[key] = process.env[key];
  }
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_testsecret';
  process.env.HSB_BLOB_ACCESS_MODE = 'private';
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterEach(() => __resetOrderStoreAdapterFactoryForTests());

function installMemoryOrderStore() {
  const cells = new Map<string, { body: string; version: number }>();
  const adapter: OrderStoreAdapter = {
    kind: 'test-memory',
    async readVersioned(pathname) {
      const cell = cells.get(pathname);
      return cell ? { body: cell.body, version: String(cell.version) } : null;
    },
    async createIfAbsent(pathname, body) {
      if (cells.has(pathname)) return { ok: false, reason: 'exists' };
      cells.set(pathname, { body, version: 1 });
      return { ok: true, version: '1' };
    },
    async replaceIfVersion(pathname, body, expectedVersion) {
      const cell = cells.get(pathname);
      if (!cell || String(cell.version) !== expectedVersion) return { ok: false, reason: 'version_conflict' };
      cell.body = body;
      cell.version += 1;
      return { ok: true, version: String(cell.version) };
    },
  };
  __setOrderStoreAdapterFactoryForTests(() => adapter);
  return cells;
}

/** The in-memory draft the route builds for every legacy request. */
function legacyDraft(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord({
    childName: 'Mina', bookFormat: 'digital', email: 'buyer@example.com',
  }, { id: ORDER_ID, now: NOW.toISOString(), fulfillmentMode: 'manual_hold' });
  return {
    ...base,
    checkoutAttemptId: ATTEMPT,
    checkoutFingerprint: FINGERPRINT,
    checkoutLeaseId: LEASE,
    checkoutLeaseExpiresAt: LIVE,
    ...overrides,
  };
}

interface Harness {
  deps: Parameters<typeof resumeOrContinueLegacyCheckout>[1];
  calls: string[];
  minted: Map<string, ProviderCheckoutSession>;
  byKey: Map<string, ProviderCheckoutSession>;
}

function harness(overrides: Partial<CheckoutSessionProvisionDeps> = {}): Harness {
  const calls: string[] = [];
  const minted = new Map<string, ProviderCheckoutSession>();
  const byKey = new Map<string, ProviderCheckoutSession>();
  let next = 1;
  return {
    calls,
    minted,
    byKey,
    deps: {
      persistOrResumeCheckoutOrder: (order) => persistOrResumeCheckoutOrder(order, { now: NOW }),
      async createCheckoutSession({ order, idempotencyKey }) {
        calls.push(`create:${idempotencyKey}`);
        const existing = byKey.get(idempotencyKey);
        if (existing) return existing;
        const session: ProviderCheckoutSession = {
          id: `cs_${next++}`,
          url: `https://checkout.stripe.test/${order.id}/${next - 1}`,
          status: 'open',
        };
        byKey.set(idempotencyKey, session);
        minted.set(session.id, session);
        return session;
      },
      async retrieveCheckoutSession(sessionId) {
        calls.push(`retrieve:${sessionId}`);
        const found = minted.get(sessionId);
        if (!found) throw new Error('session unavailable');
        return found;
      },
      async renewCheckoutLease(orderId, leaseId, fingerprint) {
        calls.push('renew');
        return renewCheckoutLease(orderId, leaseId, fingerprint, { now: NOW });
      },
      async beginCheckoutSessionProvisioning(orderId, checkout) {
        calls.push('provisioning');
        return beginCheckoutSessionProvisioning(orderId, { ...checkout, now: NOW });
      },
      async recordCheckoutSessionCandidate(orderId, sessionId, checkout) {
        calls.push('record');
        return recordCheckoutSessionCandidate(orderId, sessionId, { ...checkout, now: NOW });
      },
      async supersedeCheckoutSession(orderId, expiredSessionId, checkout) {
        calls.push(`supersede:${expiredSessionId}`);
        return supersedeExpiredCheckoutSession(orderId, expiredSessionId, { ...checkout, now: NOW });
      },
      async bindCheckoutSession(orderId, sessionId, checkout) {
        calls.push('bind');
        return bindOrderCheckoutSession(orderId, sessionId, { ...checkout, now: NOW });
      },
      ...overrides,
    },
  };
}

function run(h: Harness, draft = legacyDraft({ checkoutLeaseId: RETRY_LEASE })) {
  return resumeOrContinueLegacyCheckout({
    draftOrder: draft,
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);
}

async function stored(): Promise<OrderRecord | null> {
  return (await readOrderVersioned(ORDER_ID, { preferRecentCommit: true }))?.order ?? null;
}

const creates = (h: Harness) => h.calls.filter((call) => call.startsWith('create:'));

// ---------------------------------------------------------------------------
// A fresh request still does its media work before anything provider-shaped
// ---------------------------------------------------------------------------

test('a first request continues to the media/order steps and touches no provider', async () => {
  installMemoryOrderStore();
  const h = harness();

  const result = await run(h, legacyDraft());

  assert.equal(result.status, 'continue');
  assert.equal(result.status === 'continue' && result.order.id, ORDER_ID);
  assert.deepEqual(h.calls, [], 'the provider is not reachable before uploads and the final order CAS');
});

test('a durable persistence failure refuses before any provider attempt, and may say so', async () => {
  installMemoryOrderStore();
  const h = harness({});
  h.deps.persistOrResumeCheckoutOrder = async () => { throw new Error('store unavailable'); };

  const result = await run(h);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.httpStatus, 503);
  assert.match(result.status === 'refused' ? result.message : '', /No charge was made/);
  assert.deepEqual(h.calls, []);
});

// ---------------------------------------------------------------------------
// Every reachable resume enters the SHARED recovery — no local fast path
// ---------------------------------------------------------------------------

test('an EXPIRED bound Session supersedes durably and creates exactly one replacement', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyDraft({ checkoutLeaseExpiresAt: EXPIRED }));
  const h = harness();
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_old', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: EARLIER,
  }));
  h.minted.set('cs_old', { id: 'cs_old', url: 'https://checkout.stripe.test/old', status: 'expired' });

  const result = await run(h);

  // The old behaviour was a flat 409 here, forever, for this buyer.
  const outcome: LegacyCheckoutEntrypointResult['status'] = result.status;
  assert.notEqual(outcome, 'continue', 'a resumable order must never fall through to re-upload');
  assert.equal(result.status, 'released', JSON.stringify(result));
  assert.ok(h.calls.indexOf('supersede:cs_old') > -1, 'the dead Session must be explicitly retired');
  assert.ok(
    h.calls.indexOf(`create:${checkoutProviderIdempotencyKey(ORDER_ID, 1)}`) > h.calls.indexOf('supersede:cs_old'),
    'no replacement may be created before supersession commits',
  );
  assert.equal(creates(h).length, 1, 'exactly one replacement');
  const durable = await stored();
  assert.equal(durable?.stripeSessionId, 'cs_1');
  assert.deepEqual(durable?.supersededCheckoutSessionIds, ['cs_old']);
  assert.equal(durable?.checkoutSessionAttempt, 1);
});

test('an OPEN bound Session is reused verbatim, and nothing is created', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyDraft({ checkoutLeaseExpiresAt: EXPIRED }));
  const h = harness();
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_live', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: EARLIER,
  }));
  h.minted.set('cs_live', { id: 'cs_live', url: 'https://checkout.stripe.test/live', status: 'open' });

  const result = await run(h);

  assert.equal(result.status, 'released');
  assert.equal(result.status === 'released' && result.url, 'https://checkout.stripe.test/live');
  assert.equal(creates(h).length, 0);
  assert.equal((await stored())?.stripeSessionId, 'cs_live');
});

test('a COMPLETE bound Session refuses truthfully — never replaced, never denied', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyDraft({ checkoutLeaseExpiresAt: EXPIRED }));
  const h = harness();
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_paid', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: EARLIER,
  }));
  h.minted.set('cs_paid', { id: 'cs_paid', url: 'https://checkout.stripe.test/paid', status: 'complete' });

  const result = await run(h);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.httpStatus, 409);
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_complete');
  assert.equal(result.status === 'refused' && result.message, CHECKOUT_PAYMENT_MAY_BE_COMPLETE);
  assert.equal(creates(h).length, 0);
  assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false);
});

test('an UNKNOWN bound Session fails closed on the provider outage instead of 409-ing forever', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyDraft({ checkoutLeaseExpiresAt: EXPIRED }));
  const h = harness();
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_gone', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: EARLIER,
  }));

  const result = await run(h);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.httpStatus, 503);
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_retrieve_failed');
  assert.doesNotMatch(result.status === 'refused' ? result.message : '', /no charge/i);
  assert.equal(creates(h).length, 0);
});

test('an unbound CANDIDATE is reconciled by the shared machine, not re-created', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyDraft({ checkoutLeaseExpiresAt: EXPIRED }));
  const h = harness();
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_lost', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));
  h.minted.set('cs_lost', { id: 'cs_lost', url: 'https://checkout.stripe.test/lost', status: 'open' });

  const result = await run(h);

  assert.equal(result.status, 'released', JSON.stringify(result));
  assert.equal(result.status === 'released' && result.url, 'https://checkout.stripe.test/lost');
  assert.equal(creates(h).length, 0, 'the durable candidate is resumed, never replaced');
  const durable = await stored();
  assert.equal(durable?.stripeSessionId, 'cs_lost');
  assert.equal(durable?.checkoutSessionCandidate ?? null, null);
});

test('a bare provisioning marker enters recovery rather than falling through to re-upload', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyDraft({ checkoutLeaseExpiresAt: EXPIRED }));
  const h = harness();
  assert.ok(await beginCheckoutSessionProvisioning(ORDER_ID, {
    leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now: EARLIER,
  }));

  const result = await run(h);

  assert.notEqual(result.status, 'continue', 'evidence of an earlier provider call must reach the shared machine');
  // Same deterministic key as the interrupted attempt, so the provider itself
  // collapses the retry onto whatever it already minted.
  assert.deepEqual(creates(h), [`create:${checkoutProviderIdempotencyKey(ORDER_ID, 0)}`]);
});
