import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  exactIntakeBoundOrder,
  runPreparedIntakeOrderBinding,
  type PreparedIntakeOrderBindingDependencies,
  type PreparedIntakeOrderBindingResult,
} from '../src/lib/checkout-intake-order-binding.ts';
import type {
  CheckoutFinalizeSelection,
  FinalizeIntakeParams,
  FinalizeIntakeResult,
} from '../src/lib/checkout-finalize.ts';
import { finalizationFingerprint, intakeAssetPath, type FinalizedSelectionEntry } from '../src/lib/checkout-intake.ts';
import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  createOrderRecord,
  persistNewOrder,
  readOrderVersioned,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';

const ATTEMPT = 'a'.repeat(32);
const ORDER_ID = 'ord_binding_saga_test';
const INTAKE_ID = 'intake_11111111111111111111111111111111';
const CAPABILITY = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
const BASE_FINGERPRINT = 'b'.repeat(64);

afterEach(() => __resetOrderStoreAdapterFactoryForTests());

function memoryOrderAdapter(): OrderStoreAdapter {
  const cells = new Map<string, { body: string; version: number }>();
  return {
    kind: 'binding-roundtrip-memory',
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
      cells.set(pathname, { body, version: cell.version + 1 });
      return { ok: true, version: String(cell.version + 1) };
    },
  };
}

const selection: CheckoutFinalizeSelection = {
  primaryHeroPhotoAssetId: 'asset_11111111111111111111111111111111',
  familyCharacterAssets: [{
    assetId: 'asset_22222222222222222222222222222222',
    familyCharacterId: 'char-bruno',
  }],
  guidedStillAssetIds: ['asset_33333333333333333333333333333333'],
  voiceAssetId: 'asset_44444444444444444444444444444444',
  documentAssetId: null,
};

function entry(
  category: FinalizedSelectionEntry['category'],
  assetDigit: string,
  overrides: Partial<FinalizedSelectionEntry> = {},
): FinalizedSelectionEntry {
  const familyCharacterId = category === 'family_pet_reference' ? 'char-bruno' : null;
  const guidedStillIndex = category === 'guided_still' ? 2 : null;
  const slotKey = category === 'family_pet_reference'
    ? `${category}:${familyCharacterId}`
    : category === 'guided_still'
      ? `${category}:${guidedStillIndex}`
      : category;
  return {
    slotKey,
    category,
    familyCharacterId,
    familyCharacterIndex: category === 'family_pet_reference' ? 1 : null,
    guidedStillIndex,
    assetId: `asset_${assetDigit.repeat(32)}`,
    pathname: intakeAssetPath(INTAKE_ID, `asset_${assetDigit.repeat(32)}`),
    mimeType: category === 'voice_inspiration' ? 'audio/webm'
      : category === 'document_inspiration' ? 'application/pdf'
        : 'image/jpeg',
    size: Number(assetDigit) * 1000,
    etag: `etag-${assetDigit}`,
    generation: Number(assetDigit),
    consentAt: `2026-09-02T12:0${assetDigit}:00.000Z`,
    voiceSource: category === 'voice_inspiration' ? 'recorded' : null,
    ...overrides,
  };
}

const hero = entry('primary_hero_photo', '1');
const family = entry('family_pet_reference', '2');
const guided = entry('guided_still', '3');
const voice = entry('voice_inspiration', '4');
const document = entry('document_inspiration', '5');

function finalizeResult(entries: FinalizedSelectionEntry[]): FinalizeIntakeResult {
  const fingerprint = finalizationFingerprint(INTAKE_ID, entries);
  return {
    status: 'reserved',
    finalization: {
      checkoutAttemptId: ATTEMPT,
      orderId: ORDER_ID,
      fingerprint,
      reservedAt: '2026-09-02T12:10:00.000Z',
      leaseExpiresAt: '2026-09-02T12:25:00.000Z',
      selection: structuredClone(entries),
    },
    resolved: {
      record: {} as never,
      fingerprint,
      entries: structuredClone(entries),
      primaryHeroPhoto: null,
      familyCharacters: [],
      guidedStills: [],
      voiceAsset: null,
      documentAsset: null,
    },
  };
}

function draft(): OrderRecord {
  const order = createOrderRecord({
    childName: 'Mina',
    bookFormat: 'digital',
    email: 'buyer@example.com',
    familyCharacters: [
      { role: 'sibling', name: 'Alice', relationshipLabel: 'sister' },
      { role: 'pet', name: 'Bruno', relationshipLabel: 'dog' },
    ],
  }, {
    id: ORDER_ID,
    now: '2026-09-02T12:10:00.000Z',
    fulfillmentMode: 'manual_hold',
  });
  order.checkoutAttemptId = ATTEMPT;
  order.checkoutFingerprint = BASE_FINGERPRINT;
  order.checkoutLeaseId = '11111111-1111-4111-8111-111111111111';
  order.checkoutLeaseExpiresAt = '2026-09-02T12:15:00.000Z';
  return order;
}

interface Harness {
  deps: PreparedIntakeOrderBindingDependencies;
  calls: string[];
  orders: Map<string, OrderRecord>;
  reservation: 'none' | 'reserved' | 'finalized' | 'aborted';
  failPersist: 'none' | 'before' | 'after';
  lookup: 'normal' | 'absent' | 'unknown';
  failMark: boolean;
}

function harness(entries = [hero, family, guided, voice]): Harness {
  const calls: string[] = [];
  const orders = new Map<string, OrderRecord>();
  const state: Harness = {
    calls,
    orders,
    reservation: 'none',
    failPersist: 'none',
    lookup: 'normal',
    failMark: false,
    deps: {} as PreparedIntakeOrderBindingDependencies,
  };
  state.deps = {
    async finalizeIntake(params: FinalizeIntakeParams) {
      calls.push('finalize');
      assert.equal(params.capability, CAPABILITY);
      assert.deepEqual(params.selection, selection);
      state.reservation = 'reserved';
      return finalizeResult(entries);
    },
    async persistNewOrder(order: OrderRecord) {
      calls.push('persist');
      if (state.failPersist === 'before') return { status: 'ambiguous' as const };
      const existing = orders.get(order.id);
      if (existing) {
        return { status: 'existing' as const, order: structuredClone(existing) };
      }
      orders.set(order.id, structuredClone(order));
      if (state.failPersist === 'after') return { status: 'ambiguous' as const };
      return { status: 'created' as const, order: structuredClone(order) };
    },
    async readOrder(orderId: string) {
      calls.push('read');
      if (state.lookup === 'unknown') return { status: 'unknown' as const };
      if (state.lookup === 'absent') return { status: 'absent' as const };
      const order = orders.get(orderId);
      return order
        ? { status: 'found' as const, order: structuredClone(order) }
        : { status: 'absent' as const };
    },
    async markIntakeFinalized() {
      calls.push('mark');
      if (state.failMark) throw new Error('mark response unavailable');
      state.reservation = 'finalized';
    },
    async abortIntakeFinalization() {
      calls.push('abort');
      state.reservation = 'aborted';
      return { aborted: true };
    },
  };
  return state;
}

async function run(h: Harness): Promise<PreparedIntakeOrderBindingResult> {
  return runPreparedIntakeOrderBinding({
    draftOrder: draft(),
    intakeId: INTAKE_ID,
    capability: CAPABILITY,
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);
}

test('finalizes first, persists the complete prepared order as commit point, then marks intake', async () => {
  const h = harness();
  const result = await run(h);

  assert.equal(result.status, 'committed');
  assert.deepEqual(h.calls, ['finalize', 'persist', 'mark']);
  assert.equal(h.reservation, 'finalized');
  const stored = h.orders.get(ORDER_ID)!;
  assert.ok(stored.checkoutIntake);
  assert.equal(stored.checkoutIntake.fingerprint, finalizationFingerprint(INTAKE_ID, [hero, family, guided, voice]));
  assert.deepEqual(stored.checkoutIntake.selection, [hero, family, guided, voice]);
  assert.deepEqual(stored.checkoutIntakeMediaRetention, {
    status: 'active',
    activatedAt: stored.createdAt,
  });
  assert.equal(exactIntakeBoundOrder(stored, result.order), true);
});

test('prepared saga bytes round-trip through the production order writer and parser', async () => {
  const adapter = memoryOrderAdapter();
  __setOrderStoreAdapterFactoryForTests(() => adapter);
  const h = harness();
  h.deps.persistNewOrder = async (prepared) => {
    const created = await persistNewOrder(prepared);
    return { status: 'created', order: created };
  };
  h.deps.readOrder = async (orderId) => {
    const stored = await readOrderVersioned(orderId);
    return stored ? { status: 'found', order: stored.order } : { status: 'absent' };
  };

  const result = await run(h);
  assert.equal(result.status, 'committed');
  if (result.status !== 'committed') return;
  const stored = await readOrderVersioned(ORDER_ID);
  assert.ok(stored);
  assert.deepEqual(stored.order, result.order);
  assert.equal(exactIntakeBoundOrder(stored.order, result.order), true);
});

test('maps all five categories losslessly, preserving family reorder and guided index', async () => {
  const voiceHarness = harness([hero, family, guided, voice]);
  const voiceResult = await run(voiceHarness);
  assert.equal(voiceResult.status, 'committed');
  if (voiceResult.status !== 'committed') return;
  const voiceOrder = voiceResult.order;

  assert.deepEqual(voiceOrder.primaryHeroIntakeMedia, hero);
  assert.deepEqual((voiceOrder.familyCharacters as NonNullable<OrderRecord['familyCharacters']>)[1]?.checkoutIntakeMedia, family);
  assert.deepEqual(voiceOrder.guidedStillIntakeMedia, [guided]);
  assert.deepEqual(voiceOrder.voiceIntakeMedia, voice);
  assert.equal(voiceOrder.documentIntakeMedia, null);
  assert.equal(family.familyCharacterIndex, 1);
  assert.equal(guided.guidedStillIndex, 2);

  const documentHarness = harness([document]);
  const documentSelection = { ...selection, primaryHeroPhotoAssetId: null, familyCharacterAssets: [], guidedStillAssetIds: [], voiceAssetId: null, documentAssetId: document.assetId };
  documentHarness.deps.finalizeIntake = async (params) => {
    documentHarness.calls.push('finalize');
    assert.deepEqual(params.selection, documentSelection);
    documentHarness.reservation = 'reserved';
    return finalizeResult([document]);
  };
  const result = await runPreparedIntakeOrderBinding({
    draftOrder: draft(), intakeId: INTAKE_ID, capability: CAPABILITY,
    selection: documentSelection, familyCharacterIds: ['char-alice', 'char-bruno'],
  }, documentHarness.deps);
  assert.equal(result.status, 'committed');
  if (result.status !== 'committed') return;
  assert.deepEqual(result.order.documentIntakeMedia, document);
  assert.equal(result.order.voiceIntakeMedia, null);
});

test('never presents private intake paths as public URLs', async () => {
  const h = harness();
  const result = await runPreparedIntakeOrderBinding({
    draftOrder: draft(),
    intakeId: INTAKE_ID,
    capability: CAPABILITY,
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);
  assert.equal(result.status, 'committed');
  const serialized = JSON.stringify(h.orders.get(ORDER_ID));
  assert.equal(serialized.includes(CAPABILITY), false);
  assert.equal(serialized.includes('https://'), false);
  if (result.status !== 'committed') return;
  assert.equal(result.order.photoBlobPath, null);
  assert.equal(result.order.photoBlobUrl, null);
  assert.equal(result.order.voiceBlobPath, null);
  assert.equal(result.order.voiceBlobUrl, null);
});

test('rejects a nested raw capability value even under an innocent key before persistence', async () => {
  const h = harness();
  const contaminated = draft() as OrderRecord & { privateAuth?: { uploadToken: string } };
  contaminated.privateAuth = { uploadToken: CAPABILITY };

  const result = await runPreparedIntakeOrderBinding({
    draftOrder: contaminated,
    intakeId: INTAKE_ID,
    capability: CAPABILITY,
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);

  assert.deepEqual(result, {
    status: 'preparation_failed',
    orderId: ORDER_ID,
    code: 'capability_key_forbidden',
  });
  assert.deepEqual(h.calls, []);
  assert.equal(h.orders.size, 0);
  assert.equal(h.reservation, 'none');
});

test('rejects a raw capability embedded in a larger persisted string', async () => {
  const h = harness();
  const contaminated = draft();
  contaminated.giftMessage = `Bearer ${CAPABILITY}`;

  const result = await runPreparedIntakeOrderBinding({
    draftOrder: contaminated,
    intakeId: INTAKE_ID,
    capability: CAPABILITY,
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);

  assert.equal(result.status, 'preparation_failed');
  assert.equal(h.orders.size, 0);
});

test('rejects a raw capability used as a persisted JSON property key', async () => {
  const h = harness();
  const contaminated = draft() as OrderRecord & { privateAuth?: Record<string, boolean> };
  contaminated.privateAuth = { [CAPABILITY]: true };

  const result = await runPreparedIntakeOrderBinding({
    draftOrder: contaminated,
    intakeId: INTAKE_ID,
    capability: CAPABILITY,
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);

  assert.equal(result.status, 'preparation_failed');
  assert.equal(h.orders.size, 0);
});

test('rejects capability-like keys even when they do not contain the raw token', async () => {
  const h = harness();
  const contaminated = draft() as OrderRecord & { privateAuth?: { capabilityHint: string } };
  contaminated.privateAuth = { capabilityHint: 'redacted' };

  const result = await runPreparedIntakeOrderBinding({
    draftOrder: contaminated,
    intakeId: INTAKE_ID,
    capability: CAPABILITY,
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);

  assert.equal(result.status, 'preparation_failed');
  assert.equal(h.orders.size, 0);
});

test('rejects a boxed String capability before its serialized bytes can persist', async () => {
  const h = harness();
  const contaminated = draft() as OrderRecord & { privateAuth?: unknown };
  contaminated.privateAuth = new String(CAPABILITY);

  const result = await runPreparedIntakeOrderBinding({
    draftOrder: contaminated,
    intakeId: INTAKE_ID,
    capability: CAPABILITY,
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);

  assert.deepEqual(result, {
    status: 'preparation_failed',
    orderId: ORDER_ID,
    code: 'capability_key_forbidden',
  });
  assert.deepEqual(h.calls, []);
  assert.equal(h.orders.size, 0);
});

test('prepared-record scan rejects a capability introduced only by finalization output', async () => {
  const h = harness();
  h.deps.finalizeIntake = async () => {
    h.calls.push('finalize');
    h.reservation = 'reserved';
    const finalized = finalizeResult([hero, family, guided, voice]);
    finalized.finalization.fingerprint = CAPABILITY;
    finalized.resolved.fingerprint = CAPABILITY;
    return finalized;
  };

  const result = await run(h);

  assert.equal(result.status, 'preparation_failed');
  assert.deepEqual(h.calls, ['finalize']);
  assert.equal(h.orders.size, 0);
});

test('empty capability fails closed before persistence', async () => {
  const h = harness();
  h.deps.finalizeIntake = async () => {
    h.calls.push('finalize');
    h.reservation = 'reserved';
    return finalizeResult([hero, family, guided, voice]);
  };

  const result = await runPreparedIntakeOrderBinding({
    draftOrder: draft(),
    intakeId: INTAKE_ID,
    capability: '',
    selection,
    familyCharacterIds: ['char-alice', 'char-bruno'],
  }, h.deps);

  assert.equal(result.status, 'preparation_failed');
  assert.deepEqual(h.calls, []);
  assert.equal(h.orders.size, 0);
});

test('invalid finalization reservedAt returns a structured failure and aborts its reservation', async () => {
  const h = harness();
  h.deps.finalizeIntake = async () => {
    h.calls.push('finalize');
    h.reservation = 'reserved';
    const finalized = finalizeResult([hero, family, guided, voice]);
    finalized.finalization.reservedAt = 'not-a-timestamp';
    return finalized;
  };

  const result = await run(h);

  assert.deepEqual(result, {
    status: 'preparation_failed',
    orderId: ORDER_ID,
    code: 'finalized_tuple_invalid',
  });
  assert.deepEqual(h.calls, ['finalize', 'abort']);
  assert.equal(h.reservation, 'aborted');
  assert.equal(h.orders.size, 0);
});

test('an ambiguous persistence response reconciles an exact durable order and continues to mark', async () => {
  const h = harness();
  h.failPersist = 'after';
  const result = await run(h);
  assert.equal(result.status, 'committed');
  assert.deepEqual(h.calls, ['finalize', 'persist', 'read', 'mark']);
  assert.equal(h.orders.size, 1);
  assert.equal(h.reservation, 'finalized');
});

test('proven absence aborts the owning reservation, while unknown persistence preserves it', async () => {
  const absent = harness();
  absent.failPersist = 'before';
  absent.lookup = 'absent';
  const absentResult = await run(absent);
  assert.deepEqual(absentResult, {
    status: 'order_persistence_failed',
    orderId: ORDER_ID,
    reconciliation: 'absent',
    reservation: 'aborted',
  });
  assert.deepEqual(absent.calls, ['finalize', 'persist', 'read', 'abort']);

  const unknown = harness();
  unknown.failPersist = 'before';
  unknown.lookup = 'unknown';
  const unknownResult = await run(unknown);
  assert.deepEqual(unknownResult, {
    status: 'order_persistence_failed',
    orderId: ORDER_ID,
    reconciliation: 'unknown',
    reservation: 'preserved',
  });
  assert.deepEqual(unknown.calls, ['finalize', 'persist', 'read']);
  assert.equal(unknown.reservation, 'reserved');
});

test('a rejected abort never reports the reservation as aborted', async () => {
  const h = harness();
  h.failPersist = 'before';
  h.lookup = 'absent';
  h.deps.abortIntakeFinalization = async () => {
    h.calls.push('abort');
    return { aborted: false };
  };

  const result = await run(h);
  assert.deepEqual(result, {
    status: 'order_persistence_failed',
    orderId: ORDER_ID,
    reconciliation: 'absent',
    reservation: 'abort_failed',
  });
  assert.deepEqual(h.calls, ['finalize', 'persist', 'read', 'abort']);
  assert.equal(h.reservation, 'reserved');
});

test('a mismatched durable order is never overwritten or used to abort intake authority', async () => {
  const h = harness();
  const mismatch = draft();
  mismatch.checkoutAttemptId = 'c'.repeat(32);
  h.orders.set(ORDER_ID, mismatch);
  h.failPersist = 'before';
  const result = await run(h);
  assert.deepEqual(result, { status: 'order_conflict', orderId: ORDER_ID });
  assert.deepEqual(h.calls, ['finalize', 'persist', 'read']);
  assert.equal(h.reservation, 'reserved');
  assert.equal(h.orders.get(ORDER_ID)?.checkoutAttemptId, 'c'.repeat(32));
});

test('create-if-absent reports a destructive overwrite target as existing and preserves it', async () => {
  const h = harness();
  const foreign = draft();
  foreign.checkoutAttemptId = 'c'.repeat(32);
  foreign.email = 'foreign-owner@example.com';
  h.orders.set(ORDER_ID, structuredClone(foreign));
  let destructiveOverwriteCalled = false;
  (h.deps as PreparedIntakeOrderBindingDependencies & {
    persistOrder(order: OrderRecord): Promise<OrderRecord>;
  }).persistOrder = async (order) => {
    destructiveOverwriteCalled = true;
    h.orders.set(order.id, structuredClone(order));
    return order;
  };

  const result = await run(h);

  assert.deepEqual(result, { status: 'order_conflict', orderId: ORDER_ID });
  assert.deepEqual(h.calls, ['finalize', 'persist']);
  assert.equal(destructiveOverwriteCalled, false);
  assert.equal(h.reservation, 'reserved');
  assert.deepEqual(h.orders.get(ORDER_ID), foreign);
});

test('mark failure preserves the committed order and reservation; exact retry converges', async () => {
  const h = harness();
  h.failMark = true;
  const first = await run(h);
  assert.equal(first.status, 'intake_mark_pending');
  assert.equal(h.orders.size, 1);
  assert.equal(h.reservation, 'reserved');
  assert.deepEqual(h.calls, ['finalize', 'persist', 'mark']);

  h.failMark = false;
  h.calls.length = 0;
  const second = await run(h);
  assert.equal(second.status, 'committed');
  assert.equal(h.orders.size, 1);
  assert.deepEqual(h.calls, ['finalize', 'persist', 'mark']);
  assert.equal(h.reservation, 'finalized');
});

test('intake, fingerprint, tuple, family order, checkout attempt, and contract mismatches are non-resumable', async () => {
  const h = harness();
  const committed = await run(h);
  assert.equal(committed.status, 'committed');
  if (committed.status !== 'committed') return;

  const mutations: Array<(order: OrderRecord) => void> = [
    (order) => { order.checkoutIntake = { ...order.checkoutIntake!, intakeId: 'intake_other' }; },
    (order) => { order.checkoutIntake = { ...order.checkoutIntake!, fingerprint: '0'.repeat(64) }; },
    (order) => { order.checkoutIntake = { ...order.checkoutIntake!, selection: [hero] }; },
    (order) => { order.checkoutIntake = { ...order.checkoutIntake!, selection: order.checkoutIntake!.selection.map((item) => item.category === 'family_pet_reference' ? { ...item, familyCharacterIndex: 0 } : item) }; },
    (order) => { order.checkoutAttemptId = 'd'.repeat(32); },
    (order) => { order.checkoutFingerprint = 'e'.repeat(64); },
    (order) => { order.checkoutIntakeMediaRetention = { ...order.checkoutIntakeMediaRetention!, status: 'cleanup_claimed' }; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(committed.order);
    mutate(changed);
    assert.equal(exactIntakeBoundOrder(changed, committed.order), false);
  }
});

test('authoritative reconciliation recomputes the durable immutable order-contract digest', async () => {
  const h = harness();
  const committed = await run(h);
  assert.equal(committed.status, 'committed');
  if (committed.status !== 'committed') return;

  const expected = committed.order;
  assert.match(expected.checkoutIntake?.orderContractDigest ?? '', /^[a-f0-9]{64}$/);
  const parsed = JSON.parse(JSON.stringify(expected)) as OrderRecord;
  assert.equal(exactIntakeBoundOrder(parsed, expected), true);

  const mutations: Array<(order: OrderRecord) => void> = [
    (order) => { order.email = 'attacker@example.com'; },
    (order) => { order.priceCents += 1; },
    (order) => { order.paymentStatus = 'paid'; order.stripeSessionId = 'cs_foreign'; },
    (order) => { order.photoBlobUrl = 'https://public.example/customer-photo.jpg'; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(expected);
    mutate(changed);
    assert.equal(changed.checkoutFingerprint, expected.checkoutFingerprint);
    assert.equal(changed.checkoutIntake?.orderContractDigest, expected.checkoutIntake?.orderContractDigest);
    assert.equal(exactIntakeBoundOrder(changed, expected), false);
  }
});

test('immutable order-contract reconciliation permits only enumerated retry lifecycle fields', async () => {
  const h = harness();
  const committed = await run(h);
  assert.equal(committed.status, 'committed');
  if (committed.status !== 'committed') return;

  const retried = structuredClone(committed.order);
  retried.updatedAt = '2026-09-02T12:11:00.000Z';
  retried.checkoutLeaseId = '22222222-2222-4222-8222-222222222222';
  retried.checkoutLeaseExpiresAt = '2026-09-02T12:30:00.000Z';
  assert.equal(exactIntakeBoundOrder(retried, committed.order), true);

  const forbiddenMutations: Array<(order: OrderRecord) => void> = [
    (order) => { order.shippingAddress = { line1: '1 Wrong Way', city: 'Chicago', state: 'IL', zip: '60601', country: 'US' }; },
    (order) => { order.fulfillmentStatus = 'complete'; },
    (order) => { order.storyArtifactUrl = 'https://foreign.example/story.pdf'; },
    (order) => { order.refundClaimId = 'refund_foreign'; },
  ];
  for (const mutate of forbiddenMutations) {
    const contaminated = structuredClone(committed.order);
    mutate(contaminated);
    assert.equal(exactIntakeBoundOrder(contaminated, committed.order), false);
  }
});
