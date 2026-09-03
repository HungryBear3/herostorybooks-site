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

import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  bindOrderCheckoutSession,
  createOrderRecord,
  readOrderVersioned,
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
import type { DirectIntakeOrderRequest } from '../src/lib/checkout-direct-order-request.ts';
import { createMemoryIntakeStore, type MemoryIntakeStore } from './support/checkout-intake-memory-store.ts';

const ATTEMPT = 'b'.repeat(32);
const ORDER_ID = ['ord', '0123456789abcdef'].join('_');
const NOW = new Date('2026-03-01T12:00:00.000Z');
const FAMILY_A = 'supporting-character-aaaa';
const FAMILY_B = 'supporting-character-bbbb';

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
  order.checkoutLeaseId = '11111111-1111-4111-8111-111111111111';
  order.checkoutLeaseExpiresAt = new Date(NOW.getTime() + 5 * 60_000).toISOString();
  return { ...order, ...overrides };
}

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
    'stripe-create',
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

test('a non-open Stripe Session is never released on creation or retry', async () => {
  for (const status of ['complete', 'expired', null] as const) {
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
    if (result.status === 'refused') assert.equal(result.code, 'direct_intake_session_not_open');

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
    if (retry.status === 'refused') assert.equal(retry.code, 'direct_intake_session_not_open');
    assert.equal(retryHarness.sessions.size, 1);
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
