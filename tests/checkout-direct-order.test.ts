/**
 * `/api/order` on the direct private-intake path.
 *
 * The single property every test here is really about: **a Stripe Checkout
 * Session must not exist until the exact order the buyer will pay for is
 * durable and reconciled.** Legacy checkout learned this the hard way; the
 * direct path adds a second commit point (the intake finalization) and
 * therefore two more ways to get it wrong — a finalized intake with no order,
 * and an order whose media binding is not the one that was finalized.
 *
 * These run the REAL saga, the REAL finalization state machine, and the REAL
 * create-only order persistence against in-memory adapters. Only Stripe and
 * the lead-conversion side effect are doubles, because those are the two
 * things that must never be reached out of order.
 */
import assert from 'node:assert/strict';
import test, { afterEach, before, after } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  bindOrderCheckoutSession,
  createOrderRecord,
  readOrderVersioned,
  recordCheckoutSessionCandidate,
  renewCheckoutLease,
  supersedeExpiredCheckoutSession,
  withOrderTransaction,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';
import { createIntake, markIntakeFinalized } from '../src/lib/checkout-intake.ts';
import { completeSlotUpload, releaseSlot, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import {
  buildDirectIntakeBindingDependencies,
  runDirectIntakeCheckout,
  type DirectIntakeCheckoutDeps,
} from '../src/lib/checkout-direct-order.ts';
import {
  CHECKOUT_PAYMENT_MAY_BE_COMPLETE,
  CHECKOUT_RECONCILIATION_SUPPORT,
} from '../src/lib/checkout-session-provisioning.ts';
import type { DirectIntakeOrderRequest } from '../src/lib/checkout-direct-order-request.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ATTEMPT = 'b'.repeat(32);
const ORDER_ID = ['ord', '0123456789abcdef'].join('_');
const NOW = new Date('2026-03-01T12:00:00.000Z');
const FAMILY_A = 'supporting-character-aaaa';
const FAMILY_B = 'supporting-character-bbbb';
const LEASE = '11111111-1111-4111-8111-111111111111';
const FOREIGN_LEASE = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = `hsb_checkout_${ORDER_ID}`;
const ROUTE = readFileSync('src/app/api/order/route.ts', 'utf8');

const savedEnv: Record<string, string | undefined> = {};

before(() => {
  // `getOrderAuthoritative` — the saga's authoritative reader — routes through
  // the injected adapter only in private access mode with a token present.
  // In-process only; nothing is written to any env file and no real store is
  // addressed, because the adapter factory is overridden below.
  // `HSB_REQUIRE_DURABLE_PERSISTENCE` makes the suite production-like, which is
  // the only environment the direct path is ever served in.
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

/**
 * One adapter instance per test. The factory is called on every store access,
 * so handing back a fresh store each time would silently make every write
 * invisible to the next read.
 */
function installMemoryOrderStore(): { cells: Map<string, Cell>; adapter: OrderStoreAdapter } {
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
  return { cells, adapter };
}

function installUnavailableOrderStore(read: 'absent' | 'throws'): void {
  const adapter: OrderStoreAdapter = {
    kind: 'test-memory',
    async readVersioned() {
      if (read === 'throws') throw new Error('order store unavailable');
      return null;
    },
    async createIfAbsent() { return { ok: false, reason: 'unavailable' }; },
    async replaceIfVersion() { return { ok: false, reason: 'version_conflict' }; },
  };
  __setOrderStoreAdapterFactoryForTests(() => adapter);
}

/** A checkout intake holding real uploaded objects in the requested slots. */
async function intakeWithMedia(options: {
  hero?: boolean;
  family?: string[];
  voice?: 'recorded' | 'uploaded' | null;
} = {}) {
  const store = createMemoryIntakeStore();
  const session = await createIntake(store, {
    mediaAuthorizedAt: NOW.toISOString(),
    childVoiceAuthorizedAt: options.voice ? NOW.toISOString() : null,
    voiceSource: options.voice ?? null,
  }, NOW);
  const assets: Record<string, string> = {};

  const put = async (slot: Parameters<typeof reserveSlotUpload>[1]['slot'], mimeType: string, key: string) => {
    const reservation = await reserveSlotUpload(store, {
      intakeId: session.intakeId,
      capability: session.capability,
      slot,
      mimeType,
      size: 4096,
    }, NOW);
    store.putAsset({ pathname: reservation.pathname, mimeType, size: 4096, etag: `etag-${key}` });
    await completeSlotUpload(store, {
      tokenPayload: reservation.tokenPayload,
      blob: { pathname: reservation.pathname, contentType: mimeType, size: 4096, etag: `etag-${key}` },
    }, NOW);
    assets[key] = reservation.assetId;
    return reservation;
  };

  if (options.hero !== false) await put({ category: 'primary_hero_photo' }, 'image/jpeg', 'hero');
  for (const familyCharacterId of options.family ?? []) {
    await put({ category: 'family_pet_reference', familyCharacterId }, 'image/png', familyCharacterId);
  }
  if (options.voice) await put({ category: 'voice_inspiration' }, 'audio/mpeg', 'voice');

  return { store, session, assets };
}

function draftOrder(familyCharacterIds: string[] = [], overrides: Partial<OrderRecord> = {}): OrderRecord {
  const order = createOrderRecord({
    childName: 'Mina',
    bookFormat: 'digital',
    email: 'buyer@example.com',
    theme: 'brave-explorer',
    familyCharacters: JSON.stringify(familyCharacterIds.map((id, index) => ({
      role: 'sibling',
      name: `Person ${index}`,
      relationshipLabel: 'sibling',
      notes: `stable id ${id}`,
    }))),
  }, { id: ORDER_ID, now: NOW.toISOString(), fulfillmentMode: 'manual_hold' });
  order.checkoutAttemptId = ATTEMPT;
  order.checkoutFingerprint = 'f'.repeat(64);
  order.checkoutLeaseId = LEASE;
  order.checkoutLeaseExpiresAt = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  return { ...order, ...overrides };
}

/**
 * Deterministic interleaving barrier: a competing writer moves the durable
 * order at an exact point in the saga. Routed through the real guarded
 * transaction rather than the raw cell, so the read-your-own-writes cache
 * sees the change exactly as a concurrent worker's commit would.
 */
async function mutateStoredOrder(patch: (order: OrderRecord) => OrderRecord): Promise<void> {
  await withOrderTransaction<null>(ORDER_ID, (current) => ({ commit: patch(current), result: null }));
}

/** Another checkout attempt takes the lease. */
const stealLease = () => mutateStoredOrder((order) => ({ ...order, checkoutLeaseId: FOREIGN_LEASE }));

/** The lease runs out while a slow provider call is in flight. */
const expireLease = () => mutateStoredOrder((order) => ({
  ...order,
  checkoutLeaseExpiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
}));

/** This worker (or an authoritative retry) holds current, unexpired authority. */
const restoreLease = () => mutateStoredOrder((order) => ({
  ...order,
  checkoutLeaseId: LEASE,
  checkoutLeaseExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
}));

interface Harness {
  deps: DirectIntakeCheckoutDeps;
  calls: string[];
  sessions: Map<string, { id: string; url: string | null; status: 'open' | 'complete' | 'expired' | null }>;
  sessionsById: Map<string, { id: string; url: string | null; status: 'open' | 'complete' | 'expired' | null }>;
}

function harness(
  store: MemoryIntakeStore,
  overrides: Partial<DirectIntakeCheckoutDeps> & {
    sessionUrl?: string | null;
    sessionStatus?: 'open' | 'complete' | 'expired' | null;
  } = {},
): Harness {
  const calls: string[] = [];
  const sessions = new Map<string, { id: string; url: string | null; status: 'open' | 'complete' | 'expired' | null }>();
  const sessionsById = new Map<string, { id: string; url: string | null; status: 'open' | 'complete' | 'expired' | null }>();
  let nextSessionNumber = 1;
  const binding = buildDirectIntakeBindingDependencies(store, () => NOW);
  const traced: typeof binding = {
    finalizeIntake: async (p) => { calls.push('finalize'); return binding.finalizeIntake(p); },
    persistNewOrder: async (o) => { calls.push('persist'); return binding.persistNewOrder(o); },
    readOrder: async (id) => { calls.push('read-order'); return binding.readOrder(id); },
    markIntakeFinalized: async (p) => { calls.push('mark-finalized'); return binding.markIntakeFinalized(p); },
    abortIntakeFinalization: async (p) => { calls.push('abort'); return binding.abortIntakeFinalization(p); },
  };
  const deps: DirectIntakeCheckoutDeps = {
    binding: traced,
    async createCheckoutSession({ order, idempotencyKey }) {
      calls.push('stripe-create');
      const existing = sessions.get(idempotencyKey);
      if (existing) return existing;
      const created = {
        id: `cs_${nextSessionNumber++}`,
        url: overrides.sessionUrl === undefined ? `https://checkout.stripe.test/${order.id}` : overrides.sessionUrl,
        status: overrides.sessionStatus === undefined ? 'open' as const : overrides.sessionStatus,
      };
      sessions.set(idempotencyKey, created);
      sessionsById.set(created.id, created);
      return created;
    },
    async retrieveCheckoutSession(sessionId) {
      calls.push('stripe-retrieve');
      const found = sessionsById.get(sessionId);
      if (!found) throw new Error('session unavailable');
      return found;
    },
    async renewCheckoutLease(orderId, leaseId, fingerprint) {
      calls.push('renew-lease');
      return renewCheckoutLease(orderId, leaseId, fingerprint, { now: NOW });
    },
    async recordCheckoutSessionCandidate(orderId, sessionId, checkout) {
      calls.push('record-candidate');
      return recordCheckoutSessionCandidate(orderId, sessionId, { ...checkout, now: NOW });
    },
    async supersedeCheckoutSession(orderId, expiredSessionId, checkout) {
      calls.push('supersede-session');
      return supersedeExpiredCheckoutSession(orderId, expiredSessionId, { ...checkout, now: NOW });
    },
    async bindCheckoutSession(orderId, sessionId, checkout) {
      calls.push('bind-session');
      return bindOrderCheckoutSession(orderId, sessionId, { ...checkout, now: NOW });
    },
    async markRecoveryLeadConverted() { calls.push('recovery-lead'); },
    ...overrides,
  };
  return { deps, calls, sessions, sessionsById };
}

function request(
  session: { intakeId: string; capability: string },
  assets: Record<string, string>,
  overrides: Partial<DirectIntakeOrderRequest> = {},
): DirectIntakeOrderRequest {
  return {
    intakeId: session.intakeId,
    capability: session.capability,
    checkoutAttemptId: ATTEMPT,
    familyCharacterIds: [],
    selection: {
      primaryHeroPhotoAssetId: assets.hero ?? null,
      familyCharacterAssets: [],
      guidedStillAssetIds: [],
      voiceAssetId: null,
      documentAssetId: null,
    },
    ...overrides,
  };
}

async function storedOrder(): Promise<OrderRecord | null> {
  return (await readOrderVersioned(ORDER_ID, { preferRecentCommit: true }))?.order ?? null;
}

test('the safety-critical order is exact: finalize, create-only persist, mark, THEN Stripe, THEN bind', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'redirect');
  assert.deepEqual(h.calls, [
    'finalize',
    'persist',
    'mark-finalized',
    'recovery-lead',
    // The lease is proven again ATOMICALLY here — after the last intervening
    // await/side effect and immediately before the unbound provider call — so
    // nothing can be created against authority this worker no longer holds.
    'renew-lease',
    'stripe-create',
    // The created Session id is durable before anything else may fail.
    'record-candidate',
    'bind-session',
  ]);
});

test('a retry after a lost successful HTTP response returns the same open Stripe session', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const params = {
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  };

  const first = await runDirectIntakeCheckout(params, h.deps);
  assert.equal(first.status, 'redirect');
  const retry = await runDirectIntakeCheckout(params, h.deps);

  assert.equal(retry.status, 'redirect', JSON.stringify(retry));
  if (first.status === 'redirect' && retry.status === 'redirect') {
    assert.equal(retry.redirectTo, first.redirectTo);
  }
  assert.equal(h.sessions.size, 1, 'the deterministic idempotency key must not create a second session');
});

test('a bound-session retry retrieves by durable session id after provider idempotency expiry', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const params = {
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_digital',
    baseUrl: 'https://example.test',
    gaClientId: null,
  };

  const first = await runDirectIntakeCheckout(params, h.deps);
  assert.equal(first.status, 'redirect');
  h.sessions.delete(`hsb_checkout_${ORDER_ID}`); // provider idempotency retention elapsed

  const retry = await runDirectIntakeCheckout(params, h.deps);
  assert.equal(retry.status, 'redirect', JSON.stringify(retry));
  assert.equal(h.calls.filter((call) => call === 'stripe-create').length, 1);
  assert.equal(h.calls.filter((call) => call === 'stripe-retrieve').length, 1);
  assert.equal(h.sessionsById.size, 1, 'retry must not mint an orphan payable Session');
  if (retry.status === 'redirect') assert.equal(retry.order.stripeSessionId, 'cs_1');
  // An ALREADY-BOUND session is reconciled exactly as before: the binder has
  // already fenced this attempt, so the retrieval path takes no new lease.
  assert.equal(h.calls.filter((call) => call === 'renew-lease').length, 1);
});

test('a real second HTTP request with a new server timestamp recovers the same session', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const params = (timestamp: string) => ({
    draftOrder: draftOrder([], { createdAt: timestamp, updatedAt: timestamp }),
    request: request(session, assets),
    stripeProductId: 'prod_test', baseUrl: 'https://preview.test', gaClientId: null,
  });
  const first = await runDirectIntakeCheckout(params('2026-03-01T12:00:00.000Z'), h.deps);
  const retry = await runDirectIntakeCheckout(params('2026-03-01T12:00:03.000Z'), h.deps);
  assert.equal(first.status, 'redirect');
  assert.equal(retry.status, 'redirect', JSON.stringify(retry));
  if (first.status === 'redirect' && retry.status === 'redirect') assert.equal(retry.redirectTo, first.redirectTo);
  assert.equal(h.sessions.size, 1);
});

test('a bound-session retry fails closed when Stripe does not return the exact stored session', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const params = {
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  };

  const first = await runDirectIntakeCheckout(params, h.deps);
  assert.equal(first.status, 'redirect');
  h.sessionsById.set('cs_1', {
    id: 'cs_different',
    url: 'https://checkout.stripe.test/different',
    status: 'open',
  });

  const retry = await runDirectIntakeCheckout(params, h.deps);
  assert.equal(retry.status, 'refused');
  if (retry.status === 'refused') {
    assert.equal(retry.code, 'direct_intake_session_reconciliation_failed');
    assert.equal(retry.httpStatus, 503);
  }
});

/**
 * A non-open Session releases no URL — but "non-open" is not one state.
 *
 * `complete` may already have been PAID, so it is never retired and never
 * replaced; recovery is a support conversation. An unrecognised status is
 * simply unusable. `expired` is different in kind: it is provably dead and
 * unpayable, and refusing it forever tombstoned the attempt, because the
 * browser deliberately keeps the same checkoutAttemptId across a failure. That
 * case is covered by the supersession suite instead.
 */
test('a complete or unrecognised Stripe Session is never released on creation or retry', async () => {
  for (const [status, code] of [
    ['complete', 'direct_intake_session_complete'],
    [null, 'direct_intake_session_not_open'],
  ] as const) {
    __resetOrderStoreAdapterFactoryForTests();
    installMemoryOrderStore();
    const created = await intakeWithMedia();
    const initial = harness(created.store, { sessionStatus: status });
    const params = {
      draftOrder: draftOrder(), request: request(created.session, created.assets),
      stripeProductId: 'prod_test', baseUrl: 'https://preview.test', gaClientId: null,
    };
    const result = await runDirectIntakeCheckout(params, initial.deps);
    assert.equal(result.status, 'refused');
    if (result.status === 'refused') assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false);

    __resetOrderStoreAdapterFactoryForTests();
    installMemoryOrderStore();
    const retryCreated = await intakeWithMedia();
    const retryHarness = harness(retryCreated.store);
    const retryParams = {
      draftOrder: draftOrder(), request: request(retryCreated.session, retryCreated.assets),
      stripeProductId: 'prod_test', baseUrl: 'https://preview.test', gaClientId: null,
    };
    const first = await runDirectIntakeCheckout(retryParams, retryHarness.deps);
    assert.equal(first.status, 'redirect');
    const canonical = retryHarness.sessions.get(`hsb_checkout_${ORDER_ID}`)!;
    canonical.status = status;
    const retry = await runDirectIntakeCheckout(retryParams, retryHarness.deps);
    assert.equal(retry.status, 'refused');
    if (retry.status === 'refused') assert.equal(retry.code, code);
    assert.equal(retryHarness.sessions.size, 1, 'nothing is replaced');
  }
});

test('a complete Session never tells the buyer no charge was made', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store, { sessionStatus: 'complete' });

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(), request: request(session, assets),
    stripeProductId: 'prod_test', baseUrl: 'https://preview.test', gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  if (result.status === 'refused') {
    assert.equal(result.error, CHECKOUT_PAYMENT_MAY_BE_COMPLETE);
    assert.doesNotMatch(result.error, /no charge/i);
    assert.match(result.error, /do not pay again/i);
  }
});

test('a bound-session retrieval outage never tells the buyer no charge was made', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const params = {
    draftOrder: draftOrder(), request: request(session, assets),
    stripeProductId: 'prod_test', baseUrl: 'https://preview.test', gaClientId: null,
  };
  // The first request released a URL, so this buyer may already have paid.
  assert.equal((await runDirectIntakeCheckout(params, h.deps)).status, 'redirect');
  h.deps.retrieveCheckoutSession = async () => { throw new Error('provider unavailable'); };

  const retry = await runDirectIntakeCheckout(params, h.deps);

  assert.equal(retry.status, 'refused');
  if (retry.status === 'refused') {
    assert.equal(retry.code, 'direct_intake_session_retrieve_failed');
    assert.equal(retry.error, CHECKOUT_RECONCILIATION_SUPPORT);
    assert.doesNotMatch(retry.error, /no charge/i);
  }
});

test('the durable order is present, reconciled, and the intake already marked before Stripe is called', async () => {
  const memory = installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  let observed: { durable: OrderRecord | null; intakeFinalizedFor: string | null } | null = null;
  const h = harness(store, {
    async createCheckoutSession({ order }) {
      observed = {
        durable: await storedOrder(),
        intakeFinalizedFor: store.records.get(session.intakeId)?.record.finalizedOrderId ?? null,
      };
      return { id: 'cs_ordering', url: `https://checkout.stripe.test/${order.id}`, status: 'open' };
    },
  });

  await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.ok(observed, 'Stripe must have been reached on the happy path');
  assert.equal(observed!.durable?.id, ORDER_ID);
  assert.equal(observed!.durable?.checkoutIntake?.intakeId, session.intakeId);
  assert.equal(observed!.durable?.stripeSessionId ?? null, null, 'no session may be bound yet');
  assert.equal(observed!.intakeFinalizedFor, ORDER_ID, 'the intake must be marked before Stripe');
});

test('a direct hero photo lands on the private field and never on a public URL field', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'redirect');
  const durable = await storedOrder();
  assert.equal(durable?.primaryHeroIntakeMedia?.assetId, assets.hero);
  assert.equal(durable?.primaryHeroIntakeMedia?.category, 'primary_hero_photo');
  assert.equal(durable?.primaryHeroIntakeMedia?.etag, 'etag-hero');
  assert.equal(durable?.primaryHeroIntakeMedia?.mimeType, 'image/jpeg');
  assert.match(durable?.primaryHeroIntakeMedia?.pathname ?? '', new RegExp(`intakes/${session.intakeId}/assets/`));
  assert.equal(durable?.photoBlobPath ?? null, null);
  assert.equal(durable?.photoBlobUrl ?? null, null);
  assert.equal(durable?.fulfillmentMode, 'manual_hold');
});

test('supporting photos stay bound to their stable id when the family list is reordered', async () => {
  const bindingsFor = async (ids: string[]) => {
    __resetOrderStoreAdapterFactoryForTests();
    installMemoryOrderStore();
    const { store, session, assets } = await intakeWithMedia({ family: [FAMILY_A, FAMILY_B] });
    const h = harness(store);
    const result = await runDirectIntakeCheckout({
      draftOrder: draftOrder(ids),
      request: request(session, assets, {
        familyCharacterIds: ids,
        selection: {
          primaryHeroPhotoAssetId: assets.hero,
          // Deliberately in a FIXED array order, so only the declared id list
          // can decide which person each photo belongs to.
          familyCharacterAssets: [
            { assetId: assets[FAMILY_A]!, familyCharacterId: FAMILY_A },
            { assetId: assets[FAMILY_B]!, familyCharacterId: FAMILY_B },
          ],
          guidedStillAssetIds: [],
          voiceAssetId: null,
          documentAssetId: null,
        },
      }),
      stripeProductId: 'prod_test',
      baseUrl: 'https://preview.test',
      gaClientId: null,
    }, h.deps);
    assert.equal(result.status, 'redirect');
    const durable = (await storedOrder())!;
    return {
      perIndex: durable.familyCharacters.map((character) => character.checkoutIntakeMedia?.familyCharacterId ?? null),
      likeness: durable.familyCharacters.map((character) => character.likenessIntent),
      fingerprint: durable.checkoutIntake!.fingerprint,
      assets,
    };
  };

  const forward = await bindingsFor([FAMILY_A, FAMILY_B]);
  const reversed = await bindingsFor([FAMILY_B, FAMILY_A]);

  assert.deepEqual(forward.perIndex, [FAMILY_A, FAMILY_B]);
  assert.deepEqual(reversed.perIndex, [FAMILY_B, FAMILY_A]);
  assert.deepEqual(forward.likeness, ['reference', 'reference']);
  assert.notEqual(
    forward.fingerprint,
    reversed.fingerprint,
    'a different family order is a different book and must be a different finalization',
  );
});

test('voice source and the server-stamped consent instant round-trip into the order', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia({ voice: 'recorded' });
  const h = harness(store);

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets, {
      selection: {
        primaryHeroPhotoAssetId: assets.hero,
        familyCharacterAssets: [],
        guidedStillAssetIds: [],
        voiceAssetId: assets.voice!,
        documentAssetId: null,
      },
    }),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'redirect');
  const durable = await storedOrder();
  assert.equal(durable?.voiceIntakeMedia?.voiceSource, 'recorded');
  assert.equal(durable?.voiceIntakeMedia?.category, 'voice_inspiration');
  assert.equal(
    durable?.voiceIntakeMedia?.consentAt,
    store.records.get(session.intakeId)!.record.consent.childVoiceAuthorizedAt,
    'consent provenance must be the server-stamped instant, not a checkout-time clock',
  );
  assert.equal(durable?.voiceBlobPath ?? null, null);
  assert.equal(durable?.voiceBlobUrl ?? null, null);
});

test('the raw capability never reaches the durable order, the response, or an error path', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const logged: string[] = [];
  const h = harness(store, { logError: (message: string) => logged.push(message) });

  const ok = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  const durable = await storedOrder();
  assert.ok(session.capability.length >= 16);
  assert.equal(JSON.stringify(durable).includes(session.capability), false);
  assert.equal(JSON.stringify(ok).includes(session.capability), false);

  // And on a refusal, where an error message is the easiest place to leak it.
  const failing = await intakeWithMedia();
  const failed = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(failing.session, { hero: `asset_${'9'.repeat(32)}` }),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, harness(failing.store, { logError: (message: string) => logged.push(message) }).deps);

  assert.equal(failed.status, 'refused');
  assert.equal(JSON.stringify(failed).includes(failing.session.capability), false);
  assert.equal(logged.some((line) => line.includes(failing.session.capability)), false);
  assert.equal(logged.some((line) => line.includes(session.capability)), false);
});

test('a stale selection fails finalization, persists no order, and never reaches Stripe', async () => {
  const memory = installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  // The buyer removed the hero photo after the page built its selection.
  await releaseSlot(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: { category: 'primary_hero_photo' },
  }, NOW);
  const h = harness(store);

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'asset_not_current');
  assert.equal(h.calls.includes('stripe-create'), false);
  assert.equal(h.calls.includes('persist'), false);
  assert.equal(memory.cells.size, 0, 'no order may be written for a stale selection');
});

test('an authoritatively absent order after a persistence failure aborts the reservation and stops', async () => {
  installUnavailableOrderStore('absent');
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.httpStatus, 503);
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_order_persist_failed');
  assert.equal(h.calls.includes('stripe-create'), false);
  assert.equal(h.calls.includes('abort'), true);
  assert.equal(
    store.records.get(session.intakeId)?.record.finalization,
    null,
    'a provably absent order must hand the intake back to the buyer',
  );
});

test('an uncertain order read after a persistence failure preserves the reservation and stops', async () => {
  installUnavailableOrderStore('throws');
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.httpStatus, 503);
  assert.equal(h.calls.includes('stripe-create'), false);
  assert.equal(h.calls.includes('abort'), false, 'uncertainty must not release the media');
  assert.equal(store.records.get(session.intakeId)?.record.finalization?.orderId, ORDER_ID);
});

test('an existing order that is not the exact prepared one is a conflict and never reaches Stripe', async () => {
  const memory = installMemoryOrderStore();
  const foreign = draftOrder();
  foreign.email = 'someone-else@example.com';
  memory.cells.set(`orders/${ORDER_ID}.json`, { body: JSON.stringify(foreign), version: 1 });
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.httpStatus, 409);
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_order_conflict');
  assert.equal(h.calls.includes('stripe-create'), false);
});

test('a lost intake acknowledgement fails closed before Stripe rather than charging', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  h.deps.binding = {
    ...h.deps.binding,
    async markIntakeFinalized() { throw new Error('intake store unavailable'); },
  };

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_mark_pending');
  assert.equal(h.calls.includes('stripe-create'), false);
  assert.equal((await storedOrder())?.id, ORDER_ID, 'the durable order is kept for reconciliation');
});

test('a lost session binding releases no checkout URL', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store, { async bindCheckoutSession() { return null; } });

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.httpStatus, 503);
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_session_bind_failed');
  assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false);
});

test('a Stripe session without a URL releases nothing', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store, { sessionUrl: null });

  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_session_url_missing');
});

test('a bound-session retrieval outage fails closed without creating a replacement session', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const params = {
    draftOrder: draftOrder(), request: request(session, assets), stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test', gaClientId: null,
  };
  assert.equal((await runDirectIntakeCheckout(params, h.deps)).status, 'redirect');
  h.deps.retrieveCheckoutSession = async () => { throw new Error('provider unavailable'); };

  const retry = await runDirectIntakeCheckout(params, h.deps);
  assert.equal(retry.status, 'refused');
  assert.equal(retry.status === 'refused' && retry.code, 'direct_intake_session_retrieve_failed');
  assert.equal(h.calls.filter((call) => call === 'stripe-create').length, 1);
  assert.equal(h.sessionsById.size, 1);
});

test('a bound open session with no URL is not released and no replacement is created', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const params = {
    draftOrder: draftOrder(), request: request(session, assets), stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test', gaClientId: null,
  };
  assert.equal((await runDirectIntakeCheckout(params, h.deps)).status, 'redirect');
  const stored = h.sessionsById.get('cs_1');
  assert.ok(stored);
  stored.url = null;

  const retry = await runDirectIntakeCheckout(params, h.deps);
  assert.equal(retry.status, 'refused');
  assert.equal(retry.status === 'refused' && retry.code, 'direct_intake_session_reconciliation_failed');
  assert.equal(h.calls.filter((call) => call === 'stripe-create').length, 1);
  assert.equal(h.sessionsById.size, 1);
});

test('a retry after a lost session binding reuses the same order and the same session — never a second charge', async () => {
  const memory = installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  let bindingLost = false;
  const h = harness(store, {
    async bindCheckoutSession(orderId, sessionId, checkout) {
      if (!bindingLost) {
        bindingLost = true;
        return null;
      }
      return bindOrderCheckoutSession(orderId, sessionId, { ...checkout, now: NOW });
    },
  });
  const params = () => ({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  });

  const first = await runDirectIntakeCheckout(params(), h.deps);
  const second = await runDirectIntakeCheckout(params(), h.deps);

  assert.equal(first.status, 'refused');
  assert.equal(first.status === 'refused' && first.code, 'direct_intake_session_bind_failed');
  assert.equal(second.status, 'redirect');
  assert.equal(h.sessions.size, 1, 'exactly one Stripe Checkout Session may exist for one attempt');
  assert.equal(memory.cells.size, 1, 'exactly one durable order');
  assert.equal(store.records.get(session.intakeId)?.record.finalizedOrderId, ORDER_ID);

  // Once the session IS bound, an identical retry after a lost HTTP response
  // may only recover that exact provider session. It must not mint a second
  // session or order; a genuine new purchase gets a new attempt and order id.
  const third = await runDirectIntakeCheckout(params(), h.deps);
  assert.equal(third.status, 'redirect');
  if (second.status === 'redirect' && third.status === 'redirect') {
    assert.equal(third.redirectTo, second.redirectTo);
  }
  assert.equal(h.sessions.size, 1);
  assert.equal(memory.cells.size, 1);
});

test('a foreign order already owning this intake cannot be finalized over', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  // Someone else's checkout won the intake first.
  const other = ['ord', 'ffffffffffffffff'].join('_');
  const h = harness(store);
  await runDirectIntakeCheckout({
    draftOrder: draftOrder([], { id: other }),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, h.deps);
  await markIntakeFinalized(store, {
    intakeId: session.intakeId, capability: session.capability, orderId: other,
  }, NOW).catch(() => {});

  const second = harness(store);
  const result = await runDirectIntakeCheckout({
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  }, second.deps);

  assert.equal(result.status, 'refused');
  assert.equal(second.calls.includes('stripe-create'), false);
});

// ---------------------------------------------------------------------------
// Payment hand-off: lease/provider reconciliation
//
// The durable order existing is NOT authority to create a payable Session.
// Between the commit and the provider call there is at least one intervening
// await, and the lease can be lost in it — expired, stolen by a competing
// attempt, or overtaken by a retention claim. So the exact lease/fingerprint is
// renewed ATOMICALLY immediately before the unbound provider call, and proven
// AGAIN by the binder immediately after it.
//
// The asymmetry that makes this hard: refusing after a successful create is
// safe for the buyer but NOT free. The provider's idempotency retention is
// finite, so a retry after it lapses would mint a SECOND payable Session for
// the same order. The created id is therefore made durable before anything
// else may fail, and an authoritative retry resumes that exact candidate
// instead of creating again.
// ---------------------------------------------------------------------------

/** Standard params for the single order/intake under test. */
function checkoutParams(session: { intakeId: string; capability: string }, assets: Record<string, string>) {
  return {
    draftOrder: draftOrder(),
    request: request(session, assets),
    stripeProductId: 'prod_test',
    baseUrl: 'https://preview.test',
    gaClientId: null,
  };
}

test('a lease stolen immediately before provider creation creates ZERO Sessions', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  // The barrier sits on the LAST awaited step before the provider call — a step
  // that exists whether or not a renewal does. A competing attempt takes the
  // lease there, so from this point on the worker holds no authority at all.
  const mark = h.deps.binding.markIntakeFinalized;
  h.deps.binding = {
    ...h.deps.binding,
    async markIntakeFinalized(p) {
      await mark(p);
      await stealLease();
    },
  };

  const result = await runDirectIntakeCheckout(checkoutParams(session, assets), h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_checkout_lease_lost');
  assert.equal(result.status === 'refused' && result.httpStatus, 409);
  assert.equal(h.calls.includes('stripe-create'), false, 'no Session may be created without the lease');
  assert.equal(h.calls.includes('record-candidate'), false);
  assert.equal(h.calls.includes('bind-session'), false);
  assert.equal(h.sessions.size, 0);
  assert.equal(h.sessionsById.size, 0);
  assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false);
  const durable = await storedOrder();
  assert.equal(durable?.stripeSessionId ?? null, null);
  assert.equal(durable?.checkoutSessionCandidate ?? null, null, 'nothing was created, so nothing is recorded');
});

/**
 * The interleaving the reviewer named: the provider call SUCCEEDS, but the
 * lease is gone by the time it returns. Nothing may be bound or released — and
 * the created id must survive, or a later retry pays twice.
 */
async function checkoutLosingLeaseDuringCreate() {
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const create = h.deps.createCheckoutSession;
  h.deps.createCheckoutSession = async (req) => {
    const created = await create(req);
    await expireLease(); // the provider outlived this worker's authority
    return created;
  };
  const params = checkoutParams(session, assets);
  const result = await runDirectIntakeCheckout(params, h.deps);
  return { h, store, session, assets, params, result };
}

test('a lease lost DURING provider creation binds nothing, releases nothing, and keeps the Session id', async () => {
  installMemoryOrderStore();
  const { h, result } = await checkoutLosingLeaseDuringCreate();

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_session_bind_failed');
  assert.equal(result.status === 'refused' && result.httpStatus, 503);
  assert.equal(JSON.stringify(result).includes('checkout.stripe.test'), false, 'a stale worker exposes no URL');

  const durable = await storedOrder();
  assert.equal(durable?.stripeSessionId ?? null, null, 'the stale worker may not bind');
  assert.equal(
    durable?.checkoutSessionCandidate?.stripeSessionId,
    'cs_1',
    'the successful-but-unbound Session id must be durable for authoritative retry',
  );
  assert.equal(durable?.checkoutSessionCandidate?.checkoutAttemptId, ATTEMPT);
  assert.equal(durable?.checkoutSessionCandidate?.checkoutFingerprint, durable?.checkoutFingerprint);
  assert.equal(h.sessionsById.size, 1);
});

test('a later retry under current authority binds the durable candidate WITHOUT a second create', async () => {
  installMemoryOrderStore();
  const { h, params, result } = await checkoutLosingLeaseDuringCreate();
  assert.equal(result.status, 'refused');

  // Authoritative retry: current, unexpired lease — and the provider's
  // idempotency retention has since lapsed, so a second create would mint a
  // second payable Session rather than return cs_1.
  await restoreLease();
  h.sessions.delete(IDEMPOTENCY_KEY);

  const retry = await runDirectIntakeCheckout(params, h.deps);

  assert.equal(retry.status, 'redirect', JSON.stringify(retry));
  assert.equal(h.calls.filter((call) => call === 'stripe-create').length, 1, 'exactly one create, ever');
  assert.equal(h.calls.filter((call) => call === 'stripe-retrieve').length, 1, 'the candidate is retrieved');
  assert.equal(h.sessionsById.size, 1, 'no second payable Session may exist');
  if (retry.status === 'redirect') {
    assert.equal(retry.redirectTo, 'https://checkout.stripe.test/' + ORDER_ID);
    assert.equal(retry.order.stripeSessionId, 'cs_1');
  }
  const durable = await storedOrder();
  assert.equal(durable?.stripeSessionId, 'cs_1');
  assert.equal(
    durable?.checkoutSessionCandidate ?? null,
    null,
    'the candidate is resolved atomically by the bind that consumed it',
  );
  // And the renewal still precedes the provider call on the resume path.
  const renewIdx = h.calls.lastIndexOf('renew-lease');
  assert.ok(renewIdx > -1 && renewIdx < h.calls.lastIndexOf('stripe-retrieve'));
});

/**
 * A stranded candidate is evidence, NOT a licence.
 *
 * Note what "still lost" has to mean here. An EXPIRED lease is not lost: the
 * lease id still names this attempt, and renewing your own lapsed lease is
 * exactly what makes an ordinary retry work (the whole retry suite above
 * depends on it). Authority is genuinely gone only when the lease MOVES — and
 * the window that matters is the same one the renewal exists to close, now
 * exercised on the resume path instead of the create path.
 */
test('a retry that loses the lease before resuming retrieves, binds and exposes nothing', async () => {
  installMemoryOrderStore();
  const { h, params, result } = await checkoutLosingLeaseDuringCreate();
  assert.equal(result.status, 'refused');
  await restoreLease();
  const before = [...h.calls];
  // A competing attempt takes the lease during the retry's own last awaited
  // step — after the order was reconciled, before the candidate is resumed.
  const mark = h.deps.binding.markIntakeFinalized;
  h.deps.binding = {
    ...h.deps.binding,
    async markIntakeFinalized(p) {
      await mark(p);
      await stealLease();
    },
  };

  const retry = await runDirectIntakeCheckout(params, h.deps);

  assert.equal(retry.status, 'refused');
  assert.equal(retry.status === 'refused' && retry.code, 'direct_intake_checkout_lease_lost');
  assert.equal(retry.status === 'refused' && retry.httpStatus, 409);
  assert.equal(JSON.stringify(retry).includes('checkout.stripe.test'), false);
  assert.equal(h.calls.filter((call) => call === 'stripe-create').length, 1, 'no second create');
  assert.equal(h.calls.filter((call) => call === 'stripe-retrieve').length, 0, 'the candidate is not even read');
  assert.equal(h.calls.filter((call) => call === 'bind-session').length, 1, 'no new bind attempt');
  assert.equal(h.sessionsById.size, 1);
  assert.ok(h.calls.length > before.length, 'the retry really ran');
  const durable = await storedOrder();
  assert.equal(durable?.stripeSessionId ?? null, null);
  assert.equal(
    durable?.checkoutSessionCandidate?.stripeSessionId,
    'cs_1',
    'the candidate survives for whoever legitimately holds the order next',
  );
});

test('a candidate the provider does not answer with exactly fails closed', async () => {
  installMemoryOrderStore();
  const { h, params, result } = await checkoutLosingLeaseDuringCreate();
  assert.equal(result.status, 'refused');
  await restoreLease();
  // The provider answers the retrieval with a DIFFERENT session.
  h.sessionsById.set('cs_1', { id: 'cs_rotated', url: 'https://checkout.stripe.test/rotated', status: 'open' });

  const retry = await runDirectIntakeCheckout(params, h.deps);

  assert.equal(retry.status, 'refused');
  assert.equal(retry.status === 'refused' && retry.code, 'direct_intake_session_candidate_mismatch');
  assert.equal(retry.status === 'refused' && retry.httpStatus, 503);
  assert.equal(JSON.stringify(retry).includes('checkout.stripe.test'), false);
  assert.equal(h.calls.filter((call) => call === 'stripe-create').length, 1, 'a mismatch is never resolved by creating');
  assert.equal((await storedOrder())?.stripeSessionId ?? null, null);
});

test('a malformed or foreign durable candidate never reaches the provider', async () => {
  for (const candidate of [
    { stripeSessionId: 'not-a-stripe-session-id', checkoutAttemptId: ATTEMPT, checkoutFingerprint: 'f'.repeat(64), recordedAt: NOW.toISOString() },
    { stripeSessionId: 'cs_injected', checkoutAttemptId: 'c'.repeat(32), checkoutFingerprint: 'f'.repeat(64), recordedAt: NOW.toISOString() },
    { stripeSessionId: 'cs_injected' },
    'cs_injected',
  ]) {
    __resetOrderStoreAdapterFactoryForTests();
    const memory = installMemoryOrderStore();
    const { store, session, assets } = await intakeWithMedia();
    const h = harness(store);
    const params = checkoutParams(session, assets);
    assert.equal((await runDirectIntakeCheckout(params, h.deps)).status, 'redirect');
    const createsBefore = h.calls.filter((call) => call === 'stripe-create').length;

    // Planted in the STORE, not through a writer: the production parser now
    // refuses to commit an unaccountable candidate at all, so corruption can
    // only ever arrive underneath us. The record then reads as UNREADABLE
    // rather than as "no candidate, safe to create" — which is the whole point.
    const cell = memory.cells.get(`orders/${ORDER_ID}.json`)!;
    const planted = JSON.parse(cell.body) as Record<string, unknown>;
    planted.stripeSessionId = null;
    planted.checkoutSessionCandidate = candidate;
    memory.cells.set(`orders/${ORDER_ID}.json`, { body: JSON.stringify(planted), version: cell.version + 1 });
    __resetOrderStoreAdapterFactoryForTests();
    __setOrderStoreAdapterFactoryForTests(() => memory.adapter);

    const retry = await runDirectIntakeCheckout(params, h.deps);

    assert.equal(retry.status, 'refused', JSON.stringify(candidate));
    // Uncertainty, not absence: the order cannot be read, so the reservation is
    // preserved and nothing downstream may act on a guess.
    assert.equal(retry.status === 'refused' && retry.code, 'direct_intake_order_persist_failed');
    assert.equal(retry.status === 'refused' && retry.httpStatus, 503);
    assert.equal(
      h.calls.filter((call) => call === 'stripe-create').length,
      createsBefore,
      'an unreadable candidate must never be resolved by creating a new Session',
    );
    assert.equal(h.calls.filter((call) => call === 'stripe-retrieve').length, 0);
  }
});

test('a candidate that cannot be persisted releases no URL and mints no second Session on retry', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store);
  const keys: string[] = [];
  const create = h.deps.createCheckoutSession;
  h.deps.createCheckoutSession = async (req) => {
    keys.push(req.idempotencyKey);
    return create(req);
  };
  const record = h.deps.recordCheckoutSessionCandidate;
  let persistenceAvailable = false;
  h.deps.recordCheckoutSessionCandidate = async (...args) => (persistenceAvailable ? record(...args) : null);
  const params = checkoutParams(session, assets);

  const first = await runDirectIntakeCheckout(params, h.deps);

  assert.equal(first.status, 'refused');
  assert.equal(first.status === 'refused' && first.code, 'direct_intake_session_candidate_persist_failed');
  assert.equal(first.status === 'refused' && first.httpStatus, 503);
  assert.equal(JSON.stringify(first).includes('checkout.stripe.test'), false, 'no URL without durable evidence');
  assert.equal(h.calls.includes('bind-session'), false, 'nothing is bound that was not first recorded');
  const stranded = await storedOrder();
  assert.equal(stranded?.stripeSessionId ?? null, null);
  assert.equal(stranded?.checkoutSessionCandidate ?? null, null);

  // EXACT documented fail-closed behaviour of this branch: with no durable
  // candidate there is nothing to resume, so a safe retry DOES call the
  // provider again — but under the same deterministic idempotency key, so the
  // provider returns the same Session rather than minting a second payable one.
  persistenceAvailable = true;
  const retry = await runDirectIntakeCheckout(params, h.deps);

  assert.equal(retry.status, 'redirect', JSON.stringify(retry));
  assert.deepEqual(keys, [IDEMPOTENCY_KEY, IDEMPOTENCY_KEY], 'the idempotency key stays deterministic');
  assert.equal(h.sessions.size, 1);
  assert.equal(h.sessionsById.size, 1, 'exactly one payable Session for one attempt');
  assert.equal((await storedOrder())?.stripeSessionId, 'cs_1');
  assert.equal((await storedOrder())?.checkoutSessionCandidate ?? null, null);
});

test('a renewal outage refuses before the provider rather than creating on stale authority', async () => {
  installMemoryOrderStore();
  const { store, session, assets } = await intakeWithMedia();
  const h = harness(store, {
    async renewCheckoutLease() { throw new Error('order store unavailable'); },
  });

  const result = await runDirectIntakeCheckout(checkoutParams(session, assets), h.deps);

  assert.equal(result.status, 'refused');
  assert.equal(result.status === 'refused' && result.code, 'direct_intake_checkout_lease_lost');
  assert.equal(h.calls.includes('stripe-create'), false);
  assert.equal(h.sessionsById.size, 0);
});

test('order route: the direct saga is wired to the durable lease and candidate primitives', () => {
  // The renewal must be the REAL guarded transaction, not a saga-local guess.
  assert.match(ROUTE, /renewCheckoutLease: \(orderId, leaseId, fingerprint\) =>\s*renewCheckoutLease\(/);
  assert.match(ROUTE, /recordCheckoutSessionCandidate: \(orderId, stripeSessionId, checkout\) =>\s*recordCheckoutSessionCandidate\(/);
  const importIdx = ROUTE.indexOf('recordCheckoutSessionCandidate,');
  const sagaIdx = ROUTE.indexOf('runDirectIntakeCheckout({');
  assert.ok(importIdx > -1 && importIdx < sagaIdx, 'both primitives come from lib/orders');
});
