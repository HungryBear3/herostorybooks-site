/**
 * Provider Checkout Session provisioning — the one state machine both the
 * direct private-intake path and the legacy public path go through.
 *
 * The invariant is narrow and absolute: **at most one PAYABLE provider Session
 * may exist per order attempt, and a replacement may be minted only after the
 * provider itself has proven the previous one dead and the durable order has
 * atomically superseded it.**
 *
 * Two failure modes this exists to prevent, both found in review:
 *
 *  - A Session that is created and then lost (bind failed, lease moved) has to
 *    stay recoverable FOREVER, not merely for as long as the provider honours
 *    an idempotency key. That is what `checkoutSessionCandidate` is for, and
 *    why abandoned-media cleanup may not delete under one.
 *
 *  - A Session that legitimately EXPIRES used to tombstone the attempt: both
 *    the candidate and already-bound paths returned `session_not_open` forever,
 *    while the browser deliberately keeps the same attempt id. The buyer could
 *    never check out again. Supersession fixes that without ever creating a
 *    second payable Session behind the first one's back.
 *
 * Everything here runs the REAL order CAS against an in-memory store. Only the
 * provider is a double.
 */
import assert from 'node:assert/strict';
import test, { afterEach, before, after } from 'node:test';

import * as orders from '../src/lib/orders.ts';
import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  bindOrderCheckoutSession,
  CHECKOUT_SESSION_SUPERSEDE_LIMIT,
  checkoutIntakeOrderContractDigest,
  checkoutProviderIdempotencyKey,
  claimCheckoutIntakeMediaCleanup,
  createOrderRecord,
  persistNewOrder,
  readOrderVersioned,
  recordCheckoutSessionCandidate,
  renewCheckoutLease,
  supersedeExpiredCheckoutSession,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';
import { finalizationFingerprint } from '../src/lib/checkout-intake.ts';
import {
  CHECKOUT_NO_CHARGE_RETRY,
  CHECKOUT_PAYMENT_MAY_BE_COMPLETE,
  CHECKOUT_RECONCILIATION_NO_CHARGE,
  CHECKOUT_RECONCILIATION_SUPPORT,
  provisionCheckoutSession,
  type CheckoutSessionProvisionDeps,
  type ProviderCheckoutSession,
} from '../src/lib/checkout-session-provisioning.ts';

const ORDER_ID = ['ord', '0123456789abcdef'].join('_');
const INTAKE_ID = 'intake_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ATTEMPT = 'b'.repeat(32);
const FINGERPRINT = 'c'.repeat(64);
const LEASE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_LEASE = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-03-01T12:00:00.000Z');

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

type Cell = { body: string; version: number };

function installMemoryOrderStore(): { cells: Map<string, Cell> } {
  const cells = new Map<string, Cell>();
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
  return { cells };
}

/** A direct-path order: carries an intake binding and active media retention. */
function intakeOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord({
    childName: 'Mina', bookFormat: 'digital', email: 'buyer@example.com',
  }, { id: ORDER_ID, now: NOW.toISOString(), fulfillmentMode: 'manual_hold' });
  const bound: OrderRecord = {
    ...base,
    checkoutAttemptId: ATTEMPT,
    checkoutFingerprint: FINGERPRINT,
    checkoutLeaseId: LEASE,
    checkoutLeaseExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    checkoutIntake: {
      intakeId: INTAKE_ID,
      fingerprint: finalizationFingerprint(INTAKE_ID, []),
      orderContractDigest: '',
      selection: [],
    },
    checkoutIntakeMediaRetention: { status: 'active', activatedAt: NOW.toISOString() },
    ...overrides,
  };
  const digest = checkoutIntakeOrderContractDigest(bound);
  assert.ok(digest);
  bound.checkoutIntake!.orderContractDigest = digest;
  return bound;
}

/** A legacy public-path order: no intake binding, no media retention. */
function legacyOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const base = createOrderRecord({
    childName: 'Mina', bookFormat: 'digital', email: 'buyer@example.com',
  }, { id: ORDER_ID, now: NOW.toISOString(), fulfillmentMode: 'manual_hold' });
  return {
    ...base,
    checkoutAttemptId: ATTEMPT,
    checkoutFingerprint: FINGERPRINT,
    checkoutLeaseId: LEASE,
    checkoutLeaseExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

interface Provider {
  deps: CheckoutSessionProvisionDeps;
  calls: string[];
  /** Every Session the provider has ever minted, by id. */
  minted: Map<string, ProviderCheckoutSession>;
  /** Idempotency key -> the Session it returned. */
  byKey: Map<string, ProviderCheckoutSession>;
  /** Statuses handed back on creation, consumed in order (default 'open'). */
  createStatuses: Array<'open' | 'complete' | 'expired' | null>;
}

function provider(
  overrides: Partial<CheckoutSessionProvisionDeps> = {},
  clock: { value: Date } = { value: NOW },
): Provider {
  const calls: string[] = [];
  const minted = new Map<string, ProviderCheckoutSession>();
  const byKey = new Map<string, ProviderCheckoutSession>();
  const createStatuses: Provider['createStatuses'] = [];
  let next = 1;
  const deps: CheckoutSessionProvisionDeps = {
    async createCheckoutSession({ order, idempotencyKey }) {
      calls.push(`create:${idempotencyKey}`);
      const existing = byKey.get(idempotencyKey);
      if (existing) return existing;
      const session: ProviderCheckoutSession = {
        id: `cs_${next++}`,
        url: `https://checkout.stripe.test/${order.id}/${next - 1}`,
        status: createStatuses.shift() ?? 'open',
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
      return renewCheckoutLease(orderId, leaseId, fingerprint, { now: clock.value });
    },
    async beginCheckoutSessionProvisioning(orderId, checkout) {
      calls.push('provisioning');
      return orders.beginCheckoutSessionProvisioning(orderId, { ...checkout, now: clock.value });
    },
    async recordCheckoutSessionCandidate(orderId, sessionId, checkout) {
      calls.push('record');
      return recordCheckoutSessionCandidate(orderId, sessionId, { ...checkout, now: clock.value });
    },
    async supersedeCheckoutSession(orderId, expiredSessionId, checkout) {
      calls.push(`supersede:${expiredSessionId}`);
      return supersedeExpiredCheckoutSession(orderId, expiredSessionId, { ...checkout, now: clock.value });
    },
    async bindCheckoutSession(orderId, sessionId, checkout) {
      calls.push('bind');
      return bindOrderCheckoutSession(orderId, sessionId, { ...checkout, now: clock.value });
    },
    ...overrides,
  };
  return { deps, calls, minted, byKey, createStatuses };
}

function provision(order: OrderRecord, deps: CheckoutSessionProvisionDeps) {
  return provisionCheckoutSession({
    order,
    leaseId: order.checkoutLeaseId!,
    fingerprint: order.checkoutFingerprint!,
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, deps);
}

async function stored(): Promise<OrderRecord | null> {
  return (await readOrderVersioned(ORDER_ID, { preferRecentCommit: true }))?.order ?? null;
}

const creates = (p: Provider) => p.calls.filter((c) => c.startsWith('create:'));

// ---------------------------------------------------------------------------
// Deterministic provider-attempt keys
// ---------------------------------------------------------------------------

test('the first provider attempt keeps the historical deterministic key', () => {
  assert.equal(checkoutProviderIdempotencyKey(ORDER_ID, 0), `hsb_checkout_${ORDER_ID}`);
  assert.equal(checkoutProviderIdempotencyKey(ORDER_ID, undefined), `hsb_checkout_${ORDER_ID}`);
  // Every supersession gets its OWN deterministic key: deterministic so
  // concurrent retries of the SAME attempt collapse onto one Session, distinct
  // so a replacement is not silently deduplicated onto the dead one.
  assert.equal(checkoutProviderIdempotencyKey(ORDER_ID, 1), `hsb_checkout_${ORDER_ID}_r1`);
  assert.equal(checkoutProviderIdempotencyKey(ORDER_ID, 2), `hsb_checkout_${ORDER_ID}_r2`);
  assert.notEqual(
    checkoutProviderIdempotencyKey(ORDER_ID, 1),
    checkoutProviderIdempotencyKey(ORDER_ID, 0),
  );
});

// ---------------------------------------------------------------------------
// The ordinary paths still hold
// ---------------------------------------------------------------------------

test('a fresh order creates exactly one Session, records it, binds it, releases it', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();

  const result = await provision(intakeOrder(), p.deps);

  assert.equal(result.status, 'released');
  assert.deepEqual(p.calls, [
    'renew', 'provisioning', `create:hsb_checkout_${ORDER_ID}`, 'record', 'bind',
  ], 'durable provisioning evidence is committed BEFORE the provider is asked to create');
  const durable = await stored();
  assert.equal(durable?.stripeSessionId, 'cs_1');
  assert.equal(durable?.checkoutSessionCandidate ?? null, null, 'the bind consumed the candidate');
  assert.equal(
    durable?.checkoutSessionProvisioning ?? null,
    null,
    'and the same bind retired the provisioning marker it authorised',
  );
  assert.equal(durable?.checkoutSessionAttempt ?? 0, 0);
});

test('an OPEN bound Session is reused verbatim — never superseded, never replaced', async () => {
  installMemoryOrderStore();
  const p = provider();
  await persistNewOrder(intakeOrder());
  assert.equal((await provision(intakeOrder(), p.deps)).status, 'released');
  const before = [...p.calls];

  const retry = await provision((await stored())!, p.deps);

  assert.equal(retry.status, 'released');
  assert.equal(retry.status === 'released' && retry.url, p.minted.get('cs_1')!.url);
  assert.equal(creates(p).length, 1, 'an open Session is never replaced');
  assert.equal(p.calls.filter((c) => c.startsWith('supersede:')).length, 0);
  assert.ok(p.calls.length > before.length);
  assert.equal((await stored())?.checkoutSessionAttempt ?? 0, 0);
});

// ---------------------------------------------------------------------------
// Expired Session recovery by explicit supersession
// ---------------------------------------------------------------------------

test('an expired CANDIDATE is superseded atomically, then exactly one replacement is created', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();
  // A Session was created and recorded but never bound; by the time the buyer
  // retries, the provider has expired it.
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_stale', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));
  p.minted.set('cs_stale', { id: 'cs_stale', url: 'https://checkout.stripe.test/stale', status: 'expired' });

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'released', JSON.stringify(result));
  // Supersession happens BEFORE the replacement is created, never after.
  const supersedeIdx = p.calls.indexOf('supersede:cs_stale');
  const replacementIdx = p.calls.indexOf(`create:hsb_checkout_${ORDER_ID}_r1`);
  assert.ok(supersedeIdx > -1, 'the dead Session must be explicitly superseded');
  assert.ok(replacementIdx > supersedeIdx, 'no replacement may be created before supersession commits');
  assert.equal(creates(p).length, 1, 'exactly one replacement');

  const durable = await stored();
  assert.equal(durable?.checkoutSessionAttempt, 1);
  assert.deepEqual(durable?.supersededCheckoutSessionIds, ['cs_stale']);
  assert.equal(durable?.stripeSessionId, 'cs_1');
  assert.equal(durable?.checkoutSessionCandidate ?? null, null);
  if (result.status === 'released') assert.equal(result.url, p.minted.get('cs_1')!.url);
});

test('an expired BOUND Session is recovered the same way, and the binding is cleared first', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_dead', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
  }));
  p.minted.set('cs_dead', { id: 'cs_dead', url: 'https://checkout.stripe.test/dead', status: 'expired' });

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'released', JSON.stringify(result));
  assert.ok(p.calls.indexOf('supersede:cs_dead') > -1);
  assert.ok(p.calls.indexOf(`create:hsb_checkout_${ORDER_ID}_r1`) > p.calls.indexOf('supersede:cs_dead'));
  const durable = await stored();
  assert.equal(durable?.stripeSessionId, 'cs_1', 'rebound to the replacement');
  assert.deepEqual(durable?.supersededCheckoutSessionIds, ['cs_dead']);
  assert.equal(durable?.checkoutSessionAttempt, 1);
});

test('concurrent retries against one expired Session converge on ONE replacement', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_stale', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));
  p.minted.set('cs_stale', { id: 'cs_stale', url: 'https://checkout.stripe.test/stale', status: 'expired' });
  const start = (await stored())!;

  const [a, b] = await Promise.all([provision(start, p.deps), provision(start, p.deps)]);

  assert.equal(a.status, 'released', JSON.stringify(a));
  assert.equal(b.status, 'released', JSON.stringify(b));
  if (a.status === 'released' && b.status === 'released') assert.equal(a.url, b.url);
  assert.equal(p.minted.size, 2, 'the dead Session plus exactly one replacement');
  const durable = await stored();
  assert.equal(durable?.checkoutSessionAttempt, 1, 'supersession is idempotent, not counted twice');
  assert.deepEqual(durable?.supersededCheckoutSessionIds, ['cs_stale']);
});

test('supersession is bounded — it can never mint payable Sessions without limit', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();
  // A pathological provider that expires everything the instant it is made.
  for (let i = 0; i <= CHECKOUT_SESSION_SUPERSEDE_LIMIT + 2; i += 1) p.createStatuses.push('expired');

  const result = await provision(intakeOrder(), p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_supersede_limit');
  assert.equal(
    creates(p).length,
    CHECKOUT_SESSION_SUPERSEDE_LIMIT + 1,
    'at most limit+1 Sessions may ever exist for one order',
  );
  assert.equal((await stored())?.checkoutSessionAttempt, CHECKOUT_SESSION_SUPERSEDE_LIMIT);
  // Four provider objects were created on this order. None was ever exposed,
  // but "no charge was made" is still more than this code can prove.
  assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
  assert.doesNotMatch(result.status === 'refused' ? result.message : '', /no charge/i);
});

// ---------------------------------------------------------------------------
// Never replace something that may have been paid
// ---------------------------------------------------------------------------

test('a COMPLETE Session is never superseded and never replaced, from either source', async () => {
  for (const source of ['candidate', 'bound'] as const) {
    __resetOrderStoreAdapterFactoryForTests();
    installMemoryOrderStore();
    await persistNewOrder(intakeOrder());
    const p = provider();
    if (source === 'candidate') {
      assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_paid', {
        checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
      }));
    } else {
      assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_paid', {
        leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
      }));
    }
    p.minted.set('cs_paid', { id: 'cs_paid', url: 'https://checkout.stripe.test/paid', status: 'complete' });

    const result = await provision((await stored())!, p.deps);

    assert.equal(result.status, 'refused', source);
    assert.equal(result.status === 'refused' && result.code, 'checkout_session_complete', source);
    assert.equal(creates(p).length, 0, `${source}: a complete Session must never be replaced`);
    assert.equal(p.calls.filter((c) => c.startsWith('supersede:')).length, 0, source);
    assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false, source);
    // Money may have moved. The copy must not deny it.
    assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged', source);
    assert.equal(result.status === 'refused' && result.message, CHECKOUT_PAYMENT_MAY_BE_COMPLETE, source);
  }
});

test('an unrecognised provider status fails closed without replacement', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_odd', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));
  p.minted.set('cs_odd', { id: 'cs_odd', url: null, status: null });

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_not_open');
  assert.equal(creates(p).length, 0);
  assert.equal(p.calls.filter((c) => c.startsWith('supersede:')).length, 0);
});

// ---------------------------------------------------------------------------
// Fail-closed edges
// ---------------------------------------------------------------------------

test('a retrieval outage fails closed: nothing superseded, nothing created', async () => {
  for (const source of ['candidate', 'bound'] as const) {
    __resetOrderStoreAdapterFactoryForTests();
    installMemoryOrderStore();
    await persistNewOrder(intakeOrder());
    const p = provider({ async retrieveCheckoutSession() { throw new Error('provider unavailable'); } });
    if (source === 'candidate') {
      assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_x', {
        checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
      }));
    } else {
      assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_x', {
        leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
      }));
    }

    const result = await provision((await stored())!, p.deps);

    assert.equal(result.status, 'refused', source);
    assert.equal(result.status === 'refused' && result.code, 'checkout_session_retrieve_failed', source);
    assert.equal(creates(p).length, 0, `${source}: an outage is not proof the Session is dead`);
    assert.equal(p.calls.filter((c) => c.startsWith('supersede:')).length, 0, source);
    const durable = await stored();
    assert.equal(
      source === 'candidate' ? durable?.checkoutSessionCandidate?.stripeSessionId : durable?.stripeSessionId,
      'cs_x',
      `${source}: the durable identity survives an outage`,
    );
  }
});

test('a provider that answers with the wrong Session id fails closed', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider({
    async retrieveCheckoutSession() {
      return { id: 'cs_somebody_else', url: 'https://checkout.stripe.test/other', status: 'open' };
    },
  });
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_mine', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_candidate_mismatch');
  assert.equal(creates(p).length, 0);
  assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false);
  assert.equal((await stored())?.checkoutSessionCandidate?.stripeSessionId, 'cs_mine');
});

test('supersession refused by the store never leads to a replacement', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider({ async supersedeCheckoutSession() { return null; } });
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_stale', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));
  p.minted.set('cs_stale', { id: 'cs_stale', url: null, status: 'expired' });

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_supersede_failed');
  assert.equal(creates(p).length, 0, 'without a committed supersession there is no authority to create');
  assert.equal((await stored())?.checkoutSessionCandidate?.stripeSessionId, 'cs_stale');
});

test('a foreign lease cannot supersede another attempt Session', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_stale', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));

  assert.equal(
    await supersedeExpiredCheckoutSession(ORDER_ID, 'cs_stale', {
      leaseId: FOREIGN_LEASE, fingerprint: FINGERPRINT, now: NOW,
    }),
    null,
  );
  assert.equal(
    await supersedeExpiredCheckoutSession(ORDER_ID, 'cs_stale', {
      leaseId: LEASE, fingerprint: 'd'.repeat(64), now: NOW,
    }),
    null,
  );
  // And an id that is not the one durably recorded is never superseded.
  assert.equal(
    await supersedeExpiredCheckoutSession(ORDER_ID, 'cs_not_ours', {
      leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
    }),
    null,
  );
  assert.equal((await stored())?.checkoutSessionCandidate?.stripeSessionId, 'cs_stale');
  assert.equal((await stored())?.checkoutSessionAttempt ?? 0, 0);
});

test('a settled payment is never superseded', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder({ paymentStatus: 'paid', stripeSessionId: 'cs_paid' }));

  assert.equal(
    await supersedeExpiredCheckoutSession(ORDER_ID, 'cs_paid', {
      leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
    }),
    null,
  );
});

test('a lease lost before the provider call creates nothing', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder({ checkoutLeaseId: FOREIGN_LEASE }));
  const p = provider();

  const result = await provision(intakeOrder(), p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_lease_lost');
  assert.equal(creates(p).length, 0);
  assert.equal(result.status === 'refused' && result.chargeRisk, 'not_charged');
});

// ---------------------------------------------------------------------------
// Cross-field impossible state (runtime gate, in addition to the parser)
// ---------------------------------------------------------------------------

test('a bound order that also carries a candidate never has its URL released', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();
  p.minted.set('cs_bound', { id: 'cs_bound', url: 'https://checkout.stripe.test/bound', status: 'open' });

  for (const candidateSessionId of ['cs_bound', 'cs_other']) {
    const impossible = intakeOrder({
      stripeSessionId: 'cs_bound',
      checkoutSessionCandidate: {
        stripeSessionId: candidateSessionId,
        checkoutAttemptId: ATTEMPT,
        checkoutFingerprint: FINGERPRINT,
        recordedAt: NOW.toISOString(),
      },
    });

    const result = await provision(impossible, p.deps);

    assert.equal(result.status, 'refused', candidateSessionId);
    assert.equal(
      result.status === 'refused' && result.code,
      'checkout_session_candidate_invalid',
      candidateSessionId,
    );
    assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false, candidateSessionId);
    assert.equal(creates(p).length, 0, candidateSessionId);
  }
});

// ---------------------------------------------------------------------------
// The legacy public path goes through exactly the same machine
// ---------------------------------------------------------------------------

test('legacy: provider success plus bind failure durably retains the exact Session id', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyOrder());
  const p = provider({ async bindCheckoutSession() { return null; } });

  const result = await provision(legacyOrder(), p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_bind_failed');
  assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false, 'no URL on a failed bind');
  const durable = await stored();
  assert.equal(
    durable?.checkoutSessionCandidate?.stripeSessionId,
    'cs_1',
    'the legacy path must persist provider identity before binding, exactly as the direct path does',
  );
  assert.equal(durable?.stripeSessionId ?? null, null);
});

test('legacy: a retry after provider idempotency retention lapses resumes, never re-creates', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyOrder());
  let bindWorks = false;
  const p = provider({
    async bindCheckoutSession(orderId, sessionId, checkout) {
      if (!bindWorks) return null;
      return bindOrderCheckoutSession(orderId, sessionId, { ...checkout, now: NOW });
    },
  });
  assert.equal((await provision(legacyOrder(), p.deps)).status, 'refused');

  // Retention lapses: the same idempotency key would now mint a SECOND Session.
  bindWorks = true;
  p.byKey.clear();

  const retry = await provision((await stored())!, p.deps);

  assert.equal(retry.status, 'released', JSON.stringify(retry));
  assert.equal(creates(p).length, 1, 'the durable candidate — not provider retention — is what prevents a second');
  assert.equal(p.minted.size, 1);
  assert.equal((await stored())?.stripeSessionId, 'cs_1');
  assert.equal((await stored())?.checkoutSessionCandidate ?? null, null);
});

test('legacy: an expired Session recovers without a second payable Session outstanding', async () => {
  installMemoryOrderStore();
  await persistNewOrder(legacyOrder());
  const p = provider();
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_old', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
  }));
  p.minted.set('cs_old', { id: 'cs_old', url: 'https://checkout.stripe.test/old', status: 'expired' });

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'released', JSON.stringify(result));
  assert.equal(creates(p).length, 1);
  const durable = await stored();
  assert.equal(durable?.stripeSessionId, 'cs_1');
  assert.deepEqual(durable?.supersededCheckoutSessionIds, ['cs_old']);
});

// ---------------------------------------------------------------------------
// Customer truth: "no charge" is a claim, not a decoration
// ---------------------------------------------------------------------------

test('copy: only proven-zero-exposure failures may categorically deny a charge', async () => {
  // The three no-charge sentences are the ONLY ones allowed to say so, and each
  // is used only where no checkout URL was ever handed to this buyer.
  for (const text of [CHECKOUT_NO_CHARGE_RETRY, CHECKOUT_RECONCILIATION_NO_CHARGE]) {
    assert.match(text, /no charge was made/i);
  }
  // The recovery/support sentences must NOT deny a charge, and must tell the
  // buyer not to pay again.
  for (const text of [CHECKOUT_RECONCILIATION_SUPPORT, CHECKOUT_PAYMENT_MAY_BE_COMPLETE]) {
    assert.doesNotMatch(text, /No charge was made/);
    assert.doesNotMatch(text, /no charge/i);
    assert.match(text, /support@herostorybooks\.com/);
    assert.match(text, /do not (pay|retry)/i);
  }
});

test('copy: a bound-Session retrieval failure never claims no charge was made', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider({ async retrieveCheckoutSession() { throw new Error('provider unavailable'); } });
  // A bound Session means a checkout URL was already released to this buyer in
  // an earlier request. They may have paid on it.
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_exposed', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
  }));

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
  assert.equal(result.status === 'refused' && result.message, CHECKOUT_RECONCILIATION_SUPPORT);
  assert.doesNotMatch(result.status === 'refused' ? result.message : '', /No charge was made/);
});

test('copy: a candidate persistence failure AFTER the provider create never denies a charge', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  // The provider was asked to create, and answered. Whether or not the id was
  // durably recorded, a provider object may now exist — "no charge was made" is
  // a claim about the buyer's money that this code cannot substantiate.
  const p = provider({ async recordCheckoutSessionCandidate() { return null; } });

  const result = await provision(intakeOrder(), p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_candidate_persist_failed');
  assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
  assert.equal(result.status === 'refused' && result.message, CHECKOUT_RECONCILIATION_SUPPORT);
  assert.doesNotMatch(result.status === 'refused' ? result.message : '', /no charge/i);
});

test('copy: no post-provider-attempt failure anywhere claims that no charge was made', async (t) => {
  // Every ambiguity that can arise once `createCheckoutSession` has been
  // ENTERED. The provider object may exist in all of them.
  const ambiguities: Array<[string, Partial<CheckoutSessionProvisionDeps>, string]> = [
    ['create throws', {
      async createCheckoutSession() { throw new Error('provider unavailable'); },
    }, 'checkout_session_create_failed'],
    ['candidate persistence refuses', {
      async recordCheckoutSessionCandidate() { return null; },
    }, 'checkout_session_candidate_persist_failed'],
    ['candidate persistence throws', {
      async recordCheckoutSessionCandidate() { throw new Error('store unavailable'); },
    }, 'checkout_session_candidate_persist_failed'],
    ['the bind refuses', {
      async bindCheckoutSession() { return null; },
    }, 'checkout_session_bind_failed'],
  ];
  for (const [name, override, code] of ambiguities) {
    await t.test(name, async () => {
      __resetOrderStoreAdapterFactoryForTests();
      installMemoryOrderStore();
      await persistNewOrder(intakeOrder());
      const p = provider(override);

      const result = await provision(intakeOrder(), p.deps);

      assert.equal(result.status, 'refused');
      assert.equal(result.status === 'refused' && result.code, code);
      assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
      assert.doesNotMatch(result.status === 'refused' ? result.message : '', /no charge/i);
      assert.match(result.status === 'refused' ? result.message : '', /support@herostorybooks\.com/);
    });
  }
});

test('copy: a URL-less created Session is ambiguous too, and says so', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider({
    async createCheckoutSession() {
      return { id: 'cs_nourl', url: null, status: 'open' as const };
    },
  });

  const result = await provision(intakeOrder(), p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_url_missing');
  assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
  assert.doesNotMatch(result.status === 'refused' ? result.message : '', /no charge/i);
});

test('copy: a durable provisioning marker from an EARLIER request already forbids no-charge copy', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  // A previous worker committed the marker and then vanished mid-create. This
  // request cannot know whether the provider minted anything.
  assert.ok(await orders.beginCheckoutSessionProvisioning(ORDER_ID, {
    leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now: NOW,
  }));
  const p = provider({ async renewCheckoutLease() { return null; } });

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_lease_lost');
  assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
  assert.doesNotMatch(result.status === 'refused' ? result.message : '', /no charge/i);
  assert.equal(creates(p).length, 0);
});

test('copy: failures proven to precede every provider attempt keep the no-charge sentence', async () => {
  for (const [name, override, code] of [
    ['lease lost', { async renewCheckoutLease() { return null; } }, 'checkout_lease_lost'],
    ['provisioning evidence refused', {
      async beginCheckoutSessionProvisioning() { return null; },
    }, 'checkout_session_provisioning_failed'],
  ] as Array<[string, Partial<CheckoutSessionProvisionDeps>, string]>) {
    __resetOrderStoreAdapterFactoryForTests();
    installMemoryOrderStore();
    await persistNewOrder(intakeOrder());
    const p = provider(override);

    const result = await provision(intakeOrder(), p.deps);

    assert.equal(result.status, 'refused', name);
    assert.equal(result.status === 'refused' && result.code, code, name);
    assert.equal(result.status === 'refused' && result.chargeRisk, 'not_charged', name);
    assert.match(result.status === 'refused' ? result.message : '', /no (new )?charge was made/i, name);
    assert.equal(creates(p).length, 0, name);
  }
});

// ---------------------------------------------------------------------------
// The in-flight barrier: a provider call that outlives its own lease
//
// This is the race the whole `checkoutSessionProvisioning` marker exists for.
// A worker renews its lease, asks the provider to create a Session, and the
// call takes longer than the lease. Abandoned-media cleanup wakes up, sees a
// pending order with no bound Session and no candidate — because the candidate
// cannot exist until the provider answers — and, before this marker, deleted
// the buyer's private media out from under a Session that was seconds from
// existing. The candidate write then failed closed against the claimed
// retention, and the Session was stranded, payable, with no media behind it.
// ---------------------------------------------------------------------------

test('a provider create in flight across lease expiry: media retained, exact Session recorded, stale worker cannot expose', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const clock = { value: NOW };
  let releaseCreate: () => void = () => {};
  const createEntered = Promise.withResolvers<void>();
  const created = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const p = provider({
    async createCheckoutSession({ order, idempotencyKey }) {
      p.calls.push(`create:${idempotencyKey}`);
      createEntered.resolve();
      await created;
      const session = {
        id: 'cs_inflight',
        url: `https://checkout.stripe.test/${order.id}/${idempotencyKey}`,
        status: 'open' as const,
      };
      // The Session now exists AT THE PROVIDER, whatever this worker manages to
      // do with it — which is the entire premise of the window under test.
      p.minted.set(session.id, session);
      p.byKey.set(idempotencyKey, session);
      return session;
    },
  }, clock);

  const inflight = provision(intakeOrder(), p.deps);
  await createEntered.promise;

  // ── Cleanup's takeover moment arrives while the provider call is open ──
  clock.value = new Date(NOW.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
  const claim = await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: clock.value });
  assert.deepEqual(claim, { status: 'retained' }, 'durable provisioning evidence blocks deletion');
  assert.equal((await stored())?.checkoutIntakeMediaRetention?.status, 'active');

  releaseCreate();
  const result = await inflight;

  // The stale worker records the exact Session for reconciliation …
  const durable = await stored();
  assert.equal(durable?.checkoutSessionCandidate?.stripeSessionId, 'cs_inflight');
  // … and may not bind or expose anything, because its lease is long gone.
  assert.equal(result.status, 'refused', JSON.stringify(result));
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_bind_failed');
  assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false, 'no URL after lease loss');
  assert.equal(durable?.stripeSessionId ?? null, null);
  assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
  assert.doesNotMatch(result.status === 'refused' ? result.message : '', /no charge/i);

  // ── The retry reconciles the SAME Session, and never mints a second ──
  p.byKey.clear();
  const retry = await provision((await stored())!, p.deps);

  assert.equal(retry.status, 'released', JSON.stringify(retry));
  assert.equal(creates(p).length, 1, 'the durable evidence, not provider retention, prevents a second Session');
  assert.equal(
    retry.status === 'released' && retry.url,
    `https://checkout.stripe.test/${ORDER_ID}/${checkoutProviderIdempotencyKey(ORDER_ID, 0)}`,
  );
  const settled = await stored();
  assert.equal(settled?.stripeSessionId, 'cs_inflight');
  assert.equal(settled?.checkoutSessionCandidate ?? null, null);
  assert.equal(settled?.checkoutSessionProvisioning ?? null, null);
  assert.equal(settled?.checkoutSessionAttempt ?? 0, 0, 'nothing was superseded; the same attempt converged');
});

test('the provisioning marker is written under the exact lease, attempt and fingerprint — or not at all', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());

  for (const [name, checkout] of [
    ['foreign lease', { leaseId: FOREIGN_LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0 }],
    ['foreign fingerprint', { leaseId: LEASE, fingerprint: 'd'.repeat(64), checkoutSessionAttempt: 0 }],
    ['wrong attempt', { leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 1 }],
  ] as Array<[string, { leaseId: string; fingerprint: string; checkoutSessionAttempt: number }]>) {
    assert.equal(
      await orders.beginCheckoutSessionProvisioning(ORDER_ID, { ...checkout, now: NOW }),
      null,
      name,
    );
    assert.equal((await stored())?.checkoutSessionProvisioning ?? null, null, name);
  }

  // An EXPIRED lease is liveness, not identity — but exposure authority has to
  // be live at the moment the provider is asked to mint something payable.
  assert.equal(
    await orders.beginCheckoutSessionProvisioning(ORDER_ID, {
      leaseId: LEASE,
      fingerprint: FINGERPRINT,
      checkoutSessionAttempt: 0,
      now: new Date(NOW.getTime() + 60 * 60_000),
    }),
    null,
    'an expired lease may not authorise a new provider create',
  );

  const written = await orders.beginCheckoutSessionProvisioning(ORDER_ID, {
    leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now: NOW,
  });
  assert.equal(written?.checkoutSessionProvisioning?.idempotencyKey, checkoutProviderIdempotencyKey(ORDER_ID, 0));
  // Idempotent for the same exact attempt, refused for any other.
  assert.ok(await orders.beginCheckoutSessionProvisioning(ORDER_ID, {
    leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now: NOW,
  }));
  assert.equal(
    await orders.beginCheckoutSessionProvisioning(ORDER_ID, {
      leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 2, now: NOW,
    }),
    null,
    'a marker naming a different attempt is conflicting evidence, not an update',
  );
});

test('supersession retires the provisioning marker with the attempt it belongs to', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider();
  assert.ok(await recordCheckoutSessionCandidate(ORDER_ID, 'cs_stale', {
    checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: NOW,
  }));
  assert.ok(await orders.beginCheckoutSessionProvisioning(ORDER_ID, {
    leaseId: LEASE, fingerprint: FINGERPRINT, checkoutSessionAttempt: 0, now: NOW,
  }));
  p.minted.set('cs_stale', { id: 'cs_stale', url: 'https://checkout.stripe.test/stale', status: 'expired' });

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'released', JSON.stringify(result));
  const durable = await stored();
  assert.equal(durable?.checkoutSessionAttempt, 1);
  assert.equal(durable?.checkoutSessionProvisioning ?? null, null, 'the replacement bind retired its own marker');
  assert.equal(durable?.stripeSessionId, 'cs_1');
});

test('copy: a bound-Session reconciliation mismatch does not deny a charge', async () => {
  installMemoryOrderStore();
  await persistNewOrder(intakeOrder());
  const p = provider({
    async retrieveCheckoutSession() {
      return { id: 'cs_exposed', url: null, status: 'open' };
    },
  });
  assert.ok(await bindOrderCheckoutSession(ORDER_ID, 'cs_exposed', {
    leaseId: LEASE, fingerprint: FINGERPRINT, now: NOW,
  }));

  const result = await provision((await stored())!, p.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'checkout_session_reconciliation_failed');
  assert.equal(result.status === 'refused' && result.chargeRisk, 'may_be_charged');
  assert.equal(result.status === 'refused' && result.message, CHECKOUT_RECONCILIATION_SUPPORT);
});
