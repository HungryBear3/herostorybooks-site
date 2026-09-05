import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  bindOrderCheckoutSession,
  checkoutIntakeOrderContractDigest,
  claimCheckoutIntakeMediaCleanup,
  createOrderRecord,
  readOrderVersioned,
  markCheckoutIntakeMediaReclaimed,
  persistNewOrder,
  persistOrResumeCheckoutOrder,
  recordCheckoutSessionCandidate,
  renewCheckoutLease,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';
import {
  createIntake,
  finalizationFingerprint,
  intakeRecordPath,
  markIntakeFinalized,
} from '../src/lib/checkout-intake.ts';
import { finalizeIntakeSelection } from '../src/lib/checkout-finalize.ts';
import { completeSlotUpload, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import {
  INTAKE_FINALIZATION_ABANDONMENT_MS,
  reconcileFinalizationOrderRecord,
  runCheckoutIntakeCleanup,
  type CheckoutIntakeCleanupDeps,
} from '../src/lib/checkout-intake-cleanup.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ORDER_ID = ['ord', '0123456789abcdef'].join('_');
const INTAKE_ID = 'intake_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ATTEMPT = 'b'.repeat(32);
const FINGERPRINT = 'c'.repeat(64);
const LEASE_ID = '11111111-1111-4111-8111-111111111111';
const FINALIZED_AT = new Date('2026-01-01T00:00:00.000Z');
const TEN_YEARS_LATER = new Date('2036-01-01T00:00:00.000Z');

type Cell = { body: string; version: number };

function memoryOrderAdapter(seed: OrderRecord[] = []): { adapter: OrderStoreAdapter; cells: Map<string, Cell> } {
  const cells = new Map<string, Cell>();
  for (const order of seed) cells.set(`orders/${order.id}.json`, { body: JSON.stringify(order), version: 1 });
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
  return { adapter, cells };
}

function order(overrides: Partial<OrderRecord> = {}, intakeId = INTAKE_ID): OrderRecord {
  const value = createOrderRecord({
    childName: 'Mina',
    bookFormat: 'digital',
    email: 'buyer@example.com',
  }, {
    id: ORDER_ID,
    now: FINALIZED_AT.toISOString(),
    fulfillmentMode: 'manual_hold',
  });
  const bound: OrderRecord = {
    ...value,
    checkoutAttemptId: ATTEMPT,
    checkoutFingerprint: FINGERPRINT,
    checkoutLeaseId: LEASE_ID,
    checkoutLeaseExpiresAt: new Date(FINALIZED_AT.getTime() - 1).toISOString(),
    checkoutIntake: {
      intakeId,
      fingerprint: finalizationFingerprint(intakeId, []),
      orderContractDigest: '',
      selection: [],
    },
    checkoutIntakeMediaRetention: {
      status: 'active',
      activatedAt: FINALIZED_AT.toISOString(),
    },
    ...overrides,
  };
  const digest = checkoutIntakeOrderContractDigest(bound);
  assert.ok(digest);
  bound.checkoutIntake!.orderContractDigest = digest;
  return bound;
}

afterEach(() => __resetOrderStoreAdapterFactoryForTests());

async function installOrder(orderRecord?: OrderRecord) {
  const memory = memoryOrderAdapter();
  __setOrderStoreAdapterFactoryForTests(() => memory.adapter);
  if (orderRecord) await persistNewOrder(orderRecord);
  return memory;
}

async function storedOrder(): Promise<OrderRecord | null> {
  return (await readOrderVersioned(ORDER_ID, { preferRecentCommit: true }))?.order ?? null;
}

async function finalizedIntake() {
  const store = createMemoryIntakeStore();
  const created = await createIntake(store, { mediaAuthorizedAt: FINALIZED_AT.toISOString() }, FINALIZED_AT);
  const snapshot = store.records.get(created.intakeId)!;
  store.records.delete(created.intakeId);
  snapshot.record.intakeId = INTAKE_ID;
  store.records.set(INTAKE_ID, snapshot);
  const session = { ...created, intakeId: INTAKE_ID };
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: { category: 'primary_hero_photo' },
    mimeType: 'image/jpeg',
    size: 1024,
  }, FINALIZED_AT);
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 1024, etag: 'hero-etag' });
  await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 1024, etag: 'hero-etag' },
  }, FINALIZED_AT);
  await finalizeIntakeSelection(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: ORDER_ID,
    familyCharacterIds: [],
    selection: {
      primaryHeroPhotoAssetId: reservation.assetId,
      familyCharacterAssets: [], guidedStillAssetIds: [], voiceAssetId: null, documentAssetId: null,
    },
  }, FINALIZED_AT);
  await markIntakeFinalized(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    orderId: ORDER_ID,
  }, FINALIZED_AT);
  return { store, session, reservation };
}

async function markPendingIntake() {
  const store = createMemoryIntakeStore();
  const created = await createIntake(store, { mediaAuthorizedAt: FINALIZED_AT.toISOString() }, FINALIZED_AT);
  const snapshot = store.records.get(created.intakeId)!;
  store.records.delete(created.intakeId);
  snapshot.record.intakeId = INTAKE_ID;
  store.records.set(INTAKE_ID, snapshot);
  const session = { ...created, intakeId: INTAKE_ID };
  await finalizeIntakeSelection(store, {
    intakeId: INTAKE_ID,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    orderId: ORDER_ID,
    familyCharacterIds: [],
    selection: {
      primaryHeroPhotoAssetId: null,
      familyCharacterAssets: [], guidedStillAssetIds: [], voiceAssetId: null, documentAssetId: null,
    },
  }, FINALIZED_AT);
  return { store, session };
}

function cleanupDeps(store: MemoryIntakeStore, hooks: {
  failDeleteOnce?: boolean;
  failMarkOnce?: boolean;
  failTombstoneOnce?: boolean;
} = {}): CheckoutIntakeCleanupDeps {
  let deleteFailed = false;
  let markFailed = false;
  let tombstoneFailed = false;
  const baseStore = store;
  const cleanupStore: MemoryIntakeStore = hooks.failTombstoneOnce ? {
    ...store,
    async compareAndSwap(intakeId, etag, record) {
      if (!tombstoneFailed && record.finalizedOrderId === null && Object.keys(record.slots).length === 0) {
        tombstoneFailed = true;
        return false;
      }
      return baseStore.compareAndSwap(intakeId, etag, record);
    },
  } : store;
  return {
    store: cleanupStore,
    async list({ prefix }) {
      return {
        blobs: [
          ...[...store.records.keys()].map((id) => ({ pathname: intakeRecordPath(id) })),
          ...[...store.assets.keys()].map((pathname) => ({ pathname })),
        ].filter((blob) => blob.pathname.startsWith(prefix)),
        hasMore: false,
      };
    },
    async del(pathname) {
      if (hooks.failDeleteOnce && !deleteFailed && pathname.includes('/assets/')) {
        deleteFailed = true;
        throw new Error('delete failed once');
      }
      store.assets.delete(pathname);
      const match = /^intakes\/(intake_[a-f0-9]{32})\.json$/.exec(pathname);
      if (match) store.records.delete(match[1]!);
    },
    newClaimId: () => 'f'.repeat(32),
    reconcileFinalizationOrder: async () => 'unknown',
    claimFinalizedOrderMedia: (orderId, intakeId, now) =>
      claimCheckoutIntakeMediaCleanup(orderId, intakeId, { now }),
    async markFinalizedOrderMediaReclaimed(orderId, intakeId, now) {
      if (hooks.failMarkOnce && !markFailed) {
        markFailed = true;
        throw new Error('mark failed once');
      }
      return markCheckoutIntakeMediaReclaimed(orderId, intakeId, { now });
    },
  };
}

test('ten-year finalized pending order is atomically claimed, reclaimed, and tombstoned', async () => {
  await installOrder(order());
  const { store, session, reservation } = await finalizedIntake();

  const result = await runCheckoutIntakeCleanup(cleanupDeps(store), { now: TEN_YEARS_LATER });

  assert.equal(store.assets.has(reservation.pathname), false);
  const persisted = await storedOrder();
  assert.equal(persisted?.checkoutIntakeMediaRetention?.status, 'reclaimed');
  assert.equal(store.records.get(session.intakeId)?.record.finalizedOrderId, null);
  assert.deepEqual(store.records.get(session.intakeId)?.record.slots, {});
  assert.equal(result.reclaimedFinalized, 1);
});

test('an exact durable order recovers a failed intake mark and remains reclaimable after thirty days', async () => {
  await installOrder(order());
  const { store } = await markPendingIntake();
  const deps = cleanupDeps(store);
  deps.reconcileFinalizationOrder = async () => 'exact';

  const result = await runCheckoutIntakeCleanup(deps, { now: TEN_YEARS_LATER });

  assert.equal(result.reclaimedFinalized, 1);
  assert.equal((await storedOrder())?.checkoutIntakeMediaRetention?.status, 'reclaimed');
  assert.equal(store.records.get(INTAKE_ID)?.record.finalizedOrderId, null);
  assert.equal(store.records.get(INTAKE_ID)?.record.finalization, null);
});

test('finalization reconciliation promotes only the exact authoritative order binding', () => {
  const exact = order();
  const params = {
    orderId: ORDER_ID,
    intakeId: INTAKE_ID,
    checkoutAttemptId: ATTEMPT,
    fingerprint: finalizationFingerprint(INTAKE_ID, []),
  };
  assert.equal(reconcileFinalizationOrderRecord(exact, params), 'exact');
  assert.equal(reconcileFinalizationOrderRecord(null, params), 'absent');

  const mutations: Array<(candidate: OrderRecord) => void> = [
    (candidate) => { candidate.id = ['ord', 'ffffffffffffffff'].join('_'); },
    (candidate) => { candidate.checkoutAttemptId = 'd'.repeat(32); },
    (candidate) => { candidate.checkoutIntake = { ...candidate.checkoutIntake!, intakeId: 'intake_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }; },
    (candidate) => { candidate.checkoutIntake = { ...candidate.checkoutIntake!, fingerprint: 'e'.repeat(64) }; },
    (candidate) => { candidate.checkoutIntakeMediaRetention = { ...candidate.checkoutIntakeMediaRetention!, status: 'cleanup_claimed' }; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(exact);
    mutate(candidate);
    assert.equal(reconcileFinalizationOrderRecord(candidate, params), 'conflict');
  }
});

test('unknown and conflicting orders preserve mark-pending media beyond the abandonment bound', async () => {
  for (const reconciliation of ['unknown', 'conflict'] as const) {
    const { store } = await markPendingIntake();
    const deps = cleanupDeps(store);
    deps.reconcileFinalizationOrder = async () => reconciliation;

    const result = await runCheckoutIntakeCleanup(deps, { now: TEN_YEARS_LATER });

    assert.equal(result.skippedFinalizing, 1);
    assert.equal(store.records.get(INTAKE_ID)?.record.finalizedOrderId, null);
    assert.equal(store.records.get(INTAKE_ID)?.record.finalization?.orderId, ORDER_ID);
  }
});

test('immutable order digest directly binds customer email', () => {
  const original = order();
  const changed = structuredClone(original);
  changed.email = 'foreign@example.com';
  assert.notEqual(
    checkoutIntakeOrderContractDigest(changed),
    original.checkoutIntake?.orderContractDigest,
  );
});

test('finalized cleanup retains paid, session-bound, active-lease, mismatched, absent, and unknown orders', async (t) => {
  const cases: Array<[string, OrderRecord | null, (adapter: OrderStoreAdapter) => OrderStoreAdapter | null]> = [
    ['paid', order({ paymentStatus: 'paid' }), (adapter) => adapter],
    ['partially refunded', order({ paymentStatus: 'partially_refunded' }), (adapter) => adapter],
    ['refunded', order({ paymentStatus: 'refunded' }), (adapter) => adapter],
    ['session-bound', order({ stripeSessionId: 'cs_bound' }), (adapter) => adapter],
    ['active lease', order({ checkoutLeaseExpiresAt: new Date(TEN_YEARS_LATER.getTime() + 60_000).toISOString() }), (adapter) => adapter],
    ['mismatched intake', order({ checkoutIntake: { ...order().checkoutIntake!, intakeId: 'intake_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } }), (adapter) => adapter],
    ['absent', null, (adapter) => adapter],
    ['unknown', order(), (adapter) => ({ ...adapter, readVersioned: async () => { throw new Error('unknown'); } })],
  ];
  for (const [name, candidate, wrap] of cases) {
    await t.test(name, async () => {
      __resetOrderStoreAdapterFactoryForTests();
      const memory = memoryOrderAdapter();
      const adapter = wrap(memory.adapter)!;
      __setOrderStoreAdapterFactoryForTests(() => adapter);
      if (candidate) await memory.adapter.createIfAbsent(`orders/${ORDER_ID}.json`, JSON.stringify(candidate));
      const { store, reservation } = await finalizedIntake();
      await runCheckoutIntakeCleanup(cleanupDeps(store), { now: TEN_YEARS_LATER });
      assert.equal(store.assets.has(reservation.pathname), true);
      assert.ok(store.records.has(INTAKE_ID));
    });
  }
});

test('claim versus checkout-session binding has exactly one atomic winner', async () => {
  await installOrder(order());
  const [claim, binding] = await Promise.all([
    claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER }),
    bindOrderCheckoutSession(ORDER_ID, 'cs_race'),
  ]);
  assert.equal((claim.status === 'claimed') !== Boolean(binding), true);
  const stored = await storedOrder();
  assert.equal(
    stored?.checkoutIntakeMediaRetention?.status === 'cleanup_claimed',
    stored?.stripeSessionId !== 'cs_race',
  );
});

test('stale renew and expired-lease takeover are blocked after cleanup claim', async () => {
  const original = order();
  await installOrder(original);
  assert.equal((await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER })).status, 'claimed');
  assert.equal(await renewCheckoutLease(ORDER_ID, LEASE_ID, FINGERPRINT, { now: TEN_YEARS_LATER }), null);
  const takeover = { ...original, checkoutLeaseId: '22222222-2222-4222-8222-222222222222' };
  await assert.rejects(persistOrResumeCheckoutOrder(takeover, { now: TEN_YEARS_LATER }));
});

test('partial deletion and final order mark failures preserve durable retry state', async () => {
  await installOrder(order());
  const { store, reservation } = await finalizedIntake();
  const first = await runCheckoutIntakeCleanup(cleanupDeps(store, { failDeleteOnce: true }), { now: TEN_YEARS_LATER });
  assert.equal(first.reclaimedFinalized, 0);
  assert.equal(store.assets.has(reservation.pathname), true);
  assert.equal((await storedOrder())?.checkoutIntakeMediaRetention?.status, 'cleanup_claimed');

  const second = await runCheckoutIntakeCleanup(cleanupDeps(store, { failMarkOnce: true }), { now: TEN_YEARS_LATER });
  assert.equal(second.reclaimedFinalized, 0);
  assert.equal(store.assets.size, 0);
  assert.equal((await storedOrder())?.checkoutIntakeMediaRetention?.status, 'cleanup_claimed');
  assert.equal(store.records.get(INTAKE_ID)?.record.finalizedOrderId, ORDER_ID);

  const third = await runCheckoutIntakeCleanup(cleanupDeps(store), { now: TEN_YEARS_LATER });
  assert.equal(third.reclaimedFinalized, 1);
  assert.equal((await storedOrder())?.checkoutIntakeMediaRetention?.status, 'reclaimed');
});

test('intake tombstone CAS failure retries from already-reclaimed order idempotently', async () => {
  await installOrder(order());
  const { store } = await finalizedIntake();
  const first = await runCheckoutIntakeCleanup(cleanupDeps(store, { failTombstoneOnce: true }), { now: TEN_YEARS_LATER });
  assert.equal(first.reclaimedFinalized, 0);
  assert.equal((await storedOrder())?.checkoutIntakeMediaRetention?.status, 'reclaimed');
  assert.equal(store.records.get(INTAKE_ID)?.record.finalizedOrderId, ORDER_ID);

  const second = await runCheckoutIntakeCleanup(cleanupDeps(store), { now: TEN_YEARS_LATER });
  assert.equal(second.reclaimedFinalized, 1);
  assert.equal(store.records.get(INTAKE_ID)?.record.finalizedOrderId, null);
});

test('already claimed and already reclaimed exact-intake transitions are idempotent', async () => {
  await installOrder(order());
  assert.equal((await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER })).status, 'claimed');
  assert.equal((await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER })).status, 'already_claimed');
  assert.equal((await markCheckoutIntakeMediaReclaimed(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER })).status, 'reclaimed');
  assert.equal((await markCheckoutIntakeMediaReclaimed(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER })).status, 'already_reclaimed');
});

test('the atomic order claim enforces abandonment age even when called directly', async () => {
  await installOrder(order());
  const tooEarly = new Date(FINALIZED_AT.getTime() + 24 * 60 * 60 * 1000);
  assert.equal(
    (await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: tooEarly })).status,
    'retained',
  );
  assert.equal((await storedOrder())?.checkoutIntakeMediaRetention?.status, 'active');
});

test('an abandoned failed-payment order is reclaimable even with its dead session binding', async () => {
  await installOrder(order({ paymentStatus: 'failed', stripeSessionId: 'cs_failed' }));
  assert.equal(
    (await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER })).status,
    'claimed',
  );
});

test('durable order parsing rejects malformed intake bindings and retention state', async () => {
  const mutations: Array<(value: Record<string, any>) => void> = [
    (value) => { value.checkoutIntake.unknownAuthority = 'forbidden'; },
    (value) => { value.checkoutIntake.fingerprint = 'f'.repeat(64); },
    (value) => { value.primaryHeroIntakeMedia = { injected: true }; },
    (value) => { value.checkoutIntakeMediaRetention.cleanupClaimedAt = FINALIZED_AT.toISOString(); },
    (value) => { value.checkoutIntakeMediaRetention.activatedAt = TEN_YEARS_LATER.toISOString(); },
  ];

  for (const mutate of mutations) {
    const memory = memoryOrderAdapter();
    __setOrderStoreAdapterFactoryForTests(() => memory.adapter);
    await persistNewOrder(order());
    const [path, cell] = [...memory.cells.entries()][0]!;
    const malformed = JSON.parse(cell.body) as Record<string, any>;
    mutate(malformed);
    memory.cells.set(path, { body: JSON.stringify(malformed), version: cell.version + 1 });
    await assert.rejects(() => readOrderVersioned(ORDER_ID));
    __resetOrderStoreAdapterFactoryForTests();
  }
});

test('create-only persistence rejects forged immutable order-contract evidence', async () => {
  await installOrder();
  const forged = order();
  forged.checkoutIntake!.orderContractDigest = 'e'.repeat(64);
  await assert.rejects(() => persistNewOrder(forged));
});

// Boundary sanity: this suite's finalized timestamps are well beyond the required wait.
test('ten-year test clock exceeds finalization abandonment bound', () => {
  assert.ok(TEN_YEARS_LATER.getTime() - FINALIZED_AT.getTime() >= INTAKE_FINALIZATION_ABANDONMENT_MS);
});

// ---------------------------------------------------------------------------
// A durable unbound-Session candidate is deletion-blocking evidence
//
// Cleanup's whole premise is "this order can never be paid, so its private
// media is safe to delete". A `checkoutSessionCandidate` falsifies that
// premise: a Stripe Checkout Session provably EXISTS for this order and is
// still reconcilable. Classifying such an order as unpayable — as it did while
// only `stripeSessionId` was consulted — deletes the buyer's photos out from
// under a live payable Session.
// ---------------------------------------------------------------------------

const CANDIDATE = {
  stripeSessionId: 'cs_candidate',
  checkoutAttemptId: ATTEMPT,
  checkoutFingerprint: FINGERPRINT,
  recordedAt: FINALIZED_AT.toISOString(),
};

test('an abandoned, lease-expired order carrying a candidate is RETAINED, not claimed', async () => {
  await installOrder(order({ checkoutSessionCandidate: CANDIDATE }));

  // Every other precondition for deletion is satisfied: pending, no bound
  // session, abandonment age reached, lease long expired.
  const claim = await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER });

  assert.deepEqual(claim, { status: 'retained' });
  const stored = await storedOrder();
  assert.equal(stored?.checkoutIntakeMediaRetention?.status, 'active');
  assert.equal(stored?.checkoutSessionCandidate?.stripeSessionId, 'cs_candidate');
});

test('the whole cleanup sweep leaves candidate-bearing media in place', async () => {
  const memory = memoryOrderAdapter();
  __setOrderStoreAdapterFactoryForTests(() => memory.adapter);
  await memory.adapter.createIfAbsent(
    `orders/${ORDER_ID}.json`,
    JSON.stringify(order({ checkoutSessionCandidate: CANDIDATE })),
  );
  const { store, reservation } = await finalizedIntake();

  await runCheckoutIntakeCleanup(cleanupDeps(store), { now: TEN_YEARS_LATER });

  assert.equal(store.assets.has(reservation.pathname), true, 'media backing a live Session must survive');
  assert.ok(store.records.has(INTAKE_ID));
});

test('a cleanup claim that wins the race makes candidate persistence fail closed', async () => {
  await installOrder(order());
  // Cleanup claims while a provider create is in flight. The claim moves
  // retention off `active`, which is the same fence candidate persistence and
  // session binding are already gated on.
  assert.equal(
    (await claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER })).status,
    'claimed',
  );

  const recorded = await recordCheckoutSessionCandidate(ORDER_ID, 'cs_inflight', {
    checkoutAttemptId: ATTEMPT,
    fingerprint: FINGERPRINT,
    now: TEN_YEARS_LATER,
  });

  assert.equal(recorded, null, 'a claimed order may not accept new Session evidence');
  assert.equal(
    await bindOrderCheckoutSession(ORDER_ID, 'cs_inflight', {
      leaseId: LEASE_ID, fingerprint: FINGERPRINT, now: TEN_YEARS_LATER,
    }),
    null,
    'and it may certainly not be bound',
  );
  const stored = await storedOrder();
  assert.equal(stored?.checkoutSessionCandidate ?? null, null);
  assert.equal(stored?.stripeSessionId ?? null, null);
});

test('candidate persistence and cleanup claim have exactly one atomic winner', async () => {
  await installOrder(order());
  const [claim, recorded] = await Promise.all([
    claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER }),
    recordCheckoutSessionCandidate(ORDER_ID, 'cs_race', {
      checkoutAttemptId: ATTEMPT, fingerprint: FINGERPRINT, now: TEN_YEARS_LATER,
    }),
  ]);

  assert.equal((claim.status === 'claimed') !== Boolean(recorded), true, 'exactly one may win');
  const stored = await storedOrder();
  assert.equal(
    stored?.checkoutIntakeMediaRetention?.status === 'cleanup_claimed',
    (stored?.checkoutSessionCandidate ?? null) === null,
    'a claimed order never carries a candidate, and a candidate-bearing order is never claimed',
  );
});

test('a malformed candidate makes the stored record unreadable rather than absent', async () => {
  const memory = memoryOrderAdapter();
  __setOrderStoreAdapterFactoryForTests(() => memory.adapter);
  // Corruption arrives in the STORE, not through a writer, so the parser is
  // the only thing standing between it and a wrong deletion decision.
  for (const malformed of [
    { stripeSessionId: 'not-a-session-id', checkoutAttemptId: ATTEMPT, checkoutFingerprint: FINGERPRINT, recordedAt: FINALIZED_AT.toISOString() },
    { stripeSessionId: 'cs_x' },
    { stripeSessionId: 'cs_x', checkoutAttemptId: 'd'.repeat(32), checkoutFingerprint: FINGERPRINT, recordedAt: FINALIZED_AT.toISOString() },
    'cs_x',
    42,
  ]) {
    memory.cells.set(`orders/${ORDER_ID}.json`, {
      body: JSON.stringify({ ...order(), checkoutSessionCandidate: malformed }),
      version: 1,
    });
    __resetOrderStoreAdapterFactoryForTests();
    __setOrderStoreAdapterFactoryForTests(() => memory.adapter);

    await assert.rejects(
      readOrderVersioned(ORDER_ID),
      `a malformed candidate must fail closed, not read as absent: ${JSON.stringify(malformed)}`,
    );
    // And the unreadable record cannot be used to authorise deletion.
    await assert.rejects(claimCheckoutIntakeMediaCleanup(ORDER_ID, INTAKE_ID, { now: TEN_YEARS_LATER }));
  }
});

test('a record carrying BOTH a bound session and a candidate is unreadable', async () => {
  const memory = memoryOrderAdapter();
  __setOrderStoreAdapterFactoryForTests(() => memory.adapter);
  for (const candidate of [
    CANDIDATE,
    { ...CANDIDATE, stripeSessionId: 'cs_bound' },
  ]) {
    memory.cells.set(`orders/${ORDER_ID}.json`, {
      body: JSON.stringify({ ...order(), stripeSessionId: 'cs_bound', checkoutSessionCandidate: candidate }),
      version: 1,
    });
    __resetOrderStoreAdapterFactoryForTests();
    __setOrderStoreAdapterFactoryForTests(() => memory.adapter);

    await assert.rejects(
      readOrderVersioned(ORDER_ID),
      'binding clears the candidate in the same commit, so both together is impossible state',
    );
  }
});
