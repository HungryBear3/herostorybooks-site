import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkoutIntentFingerprint,
  checkoutRequestFingerprint,
} from '../src/lib/checkout-request-fingerprint.ts';
import {
  bindCheckoutAttemptToOrderId,
  CheckoutIntentOwnershipError,
  claimCheckoutIntentOrderId,
  createOrderRecord,
  resolveCheckoutOrderIdForAttempt,
  releaseCheckoutIntentOrderId,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';

const ATTEMPT_A = 'a'.repeat(32);
const ATTEMPT_B = 'b'.repeat(32);
const ORDER_A = `ord_${'1'.repeat(16)}`;
const ORDER_B = `ord_${'2'.repeat(16)}`;

function form(overrides: Record<string, string | File> = {}): FormData {
  const value = new FormData();
  value.set('checkoutAttemptId', ATTEMPT_A);
  value.set('checkoutIntakeCapability', 'capability-a');
  value.set('gaClientId', 'ga-a');
  value.set('cohort', 'friends-a');
  value.set('invite', 'invite-a');
  value.set('childName', 'Mina');
  value.set('email', 'buyer@example.com');
  value.set('bookFormat', 'digital');
  value.set('photo', new File([new Uint8Array([1, 2, 3])], 'hero.jpg', { type: 'image/jpeg' }));
  for (const [key, entry] of Object.entries(overrides)) value.set(key, entry);
  return value;
}

function directForm(intakeHex: string, assetHex: string): FormData {
  const value = new FormData();
  value.set('checkoutAttemptId', intakeHex === '1' ? ATTEMPT_A : ATTEMPT_B);
  value.set('childName', 'Mina');
  value.set('email', 'buyer@example.com');
  value.set('bookFormat', 'digital');
  value.set('checkoutIntake', JSON.stringify({
    intakeId: `intake_${intakeHex.repeat(32)}`,
    familyCharacterIds: [],
    selection: {
      primaryHeroPhotoAssetId: `asset_${assetHex.repeat(32)}`,
      familyCharacterAssets: [],
      guidedStillAssetIds: [],
      voiceAssetId: null,
      documentAssetId: null,
    },
  }));
  return value;
}

const directMedia = (etag: string) => [{
  category: 'primary_hero_photo',
  familyCharacterIndex: null,
  guidedStillIndex: null,
  mimeType: 'image/jpeg',
  size: 3,
  etag,
  voiceSource: null,
}] as const;

function normalizedOrder(value: FormData) {
  return createOrderRecord({
    childName: String(value.get('childName') || ''),
    email: String(value.get('email') || ''),
    bookFormat: String(value.get('bookFormat') || 'classic'),
  }, { id: ORDER_A, now: '2026-09-12T00:00:00.000Z', fulfillmentMode: 'manual_hold' });
}

async function intent(value: FormData, validatedDirectMedia?: ReturnType<typeof directMedia>) {
  const photo = value.get('photo');
  return checkoutIntentFingerprint(normalizedOrder(value), {
    media: photo instanceof File ? [{ category: 'primary_hero_photo', file: photo }] : [],
    directMedia: validatedDirectMedia,
  });
}

class AtomicMemoryStore implements OrderStoreAdapter {
  readonly kind = 'test';
  readonly records = new Map<string, { body: string; version: string }>();
  creates = 0;

  async readVersioned(pathname: string) {
    return this.records.get(pathname) ?? null;
  }

  async createIfAbsent(pathname: string, body: string) {
    if (this.records.has(pathname)) return { ok: false as const, reason: 'exists' as const };
    this.creates += 1;
    this.records.set(pathname, { body, version: `v${this.creates}` });
    return { ok: true as const, version: `v${this.creates}` };
  }

  async replaceIfVersion(pathname: string, body: string, expectedVersion: string) {
    const current = this.records.get(pathname);
    if (!current || current.version !== expectedVersion) {
      return { ok: false as const, reason: 'version_conflict' as const };
    }
    this.creates += 1;
    const version = `v${this.creates}`;
    this.records.set(pathname, { body, version });
    return { ok: true as const, version };
  }
}

test('semantic checkout identity ignores browser authority and analytics fields', async () => {
  const first = form();
  const second = form({
    checkoutAttemptId: ATTEMPT_B,
    checkoutIntakeCapability: 'capability-b',
    gaClientId: 'ga-b',
    cohort: 'friends-b',
    invite: 'invite-b',
    referralCode: 'referral-b',
  });

  assert.notEqual(await checkoutRequestFingerprint(first), await checkoutRequestFingerprint(second));
  assert.equal(await intent(first), await intent(second));
});

test('semantic checkout identity changes with purchased content or media bytes', async () => {
  const baseline = await intent(form());
  assert.notEqual(baseline, await intent(form({ childName: 'Nora' })));
  assert.notEqual(
    baseline,
    await intent(form({
      photo: new File([new Uint8Array([1, 2, 4])], 'hero.jpg', { type: 'image/jpeg' }),
    })),
  );
});

test('direct-upload semantic identity ignores intake and asset ids but preserves validated media bytes', async () => {
  const first = directForm('1', 'a');
  const second = directForm('2', 'b');

  assert.equal(
    await intent(first, directMedia('sha256:same-bytes')),
    await intent(second, directMedia('sha256:same-bytes')),
  );
  assert.notEqual(
    await intent(first, directMedia('sha256:same-bytes')),
    await intent(second, directMedia('sha256:different-bytes')),
    'different validated object identity must not converge',
  );
});

test('concurrent identical intents atomically converge on one canonical order id', async () => {
  const store = new AtomicMemoryStore();
  const fingerprint = 'c'.repeat(64);

  const results = await Promise.all([
    claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store }),
    claimCheckoutIntentOrderId(fingerprint, ORDER_B, { store }),
  ]);

  assert.equal(new Set(results.map((result) => result.orderId)).size, 1);
  assert.ok(results[0]!.orderId === ORDER_A || results[0]!.orderId === ORDER_B);
  assert.equal(results[0]!.generation, 0);
  assert.equal(
    [...store.records.keys()].filter((pathname) => pathname.startsWith('checkout-intent-claims/')).length,
    1,
    'one claim, so one canonical order id',
  );
  assert.equal(
    JSON.parse(store.records.get(`checkout-order-intent-owners/${results[0]!.orderId}.json`)!.body).fingerprint,
    fingerprint,
    'the canonical order id is owned by the intent that claimed it',
  );
});

test('a malformed durable intent claim fails closed', async () => {
  const store = new AtomicMemoryStore();
  const fingerprint = 'd'.repeat(64);
  store.records.set(`checkout-intent-claims/${fingerprint}.json`, {
    body: JSON.stringify({ fingerprint, orderId: 'ord_not-valid', createdAt: new Date().toISOString() }),
    version: 'v1',
  });

  await assert.rejects(
    claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store }),
    /invalid checkout intent claim/i,
  );
});

test('claim storage failure aborts instead of returning an unclaimed order id', async () => {
  const store: OrderStoreAdapter = {
    kind: 'unavailable',
    readVersioned: async () => { throw new Error('store unavailable'); },
    createIfAbsent: async () => { throw new Error('store unavailable'); },
    replaceIfVersion: async () => { throw new Error('not used'); },
  };

  await assert.rejects(
    claimCheckoutIntentOrderId('e'.repeat(64), ORDER_A, { store }),
    /store unavailable/,
  );
});

test('an exact retired order releases its claim and the next generation converges once', async () => {
  const store = new AtomicMemoryStore();
  const fingerprint = 'e'.repeat(64);
  const first = await claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store });
  assert.deepEqual(first, { orderId: ORDER_A, generation: 0 });
  assert.equal(await releaseCheckoutIntentOrderId(fingerprint, ORDER_A, first.generation, { store }), true);

  const proposals = Array.from({ length: 24 }, (_, index) =>
    `ord_${(index + 16).toString(16).padStart(16, '0')}`);
  const claimed = await Promise.all(
    proposals.map((orderId) => claimCheckoutIntentOrderId(fingerprint, orderId, { store })),
  );
  assert.equal(new Set(claimed.map((result) => result.orderId)).size, 1);
  assert.notEqual(claimed[0]!.orderId, ORDER_A);
  assert.equal(claimed[0]!.generation, 1);
});

test('a retired order id cannot reacquire its released generation or wedge a fresh successor', async () => {
  const store = new AtomicMemoryStore();
  const fingerprint = 'f'.repeat(64);
  const first = await claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store });
  assert.deepEqual(first, { orderId: ORDER_A, generation: 0 });
  assert.equal(await releaseCheckoutIntentOrderId(fingerprint, ORDER_A, first.generation, { store }), true);

  await assert.rejects(
    claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store }),
    /retired checkout intent order/i,
    'an in-flight stale request for A must not reactivate retired order A',
  );

  const successor = await claimCheckoutIntentOrderId(fingerprint, ORDER_B, { store });
  assert.deepEqual(successor, { orderId: ORDER_B, generation: 1 });
  assert.equal(
    await releaseCheckoutIntentOrderId(fingerprint, ORDER_A, first.generation, { store }),
    false,
    'a stale release for A cannot clear successor B',
  );
  assert.deepEqual(
    await claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store }),
    successor,
    'once B is active, stale A observes B without mutating the claim',
  );
});

test('an order retired in any older generation can never return after a later successor is released', async () => {
  const store = new AtomicMemoryStore();
  const fingerprint = '9'.repeat(64);
  const first = await claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store });
  assert.equal(await releaseCheckoutIntentOrderId(fingerprint, ORDER_A, first.generation, { store }), true);

  const successor = await claimCheckoutIntentOrderId(fingerprint, ORDER_B, { store });
  assert.equal(await releaseCheckoutIntentOrderId(fingerprint, ORDER_B, successor.generation, { store }), true);

  await assert.rejects(
    claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store }),
    /retired checkout intent order/i,
    'generation-0 order A must remain retired after generation-1 order B is released',
  );
});

test('semantic checkout identity canonicalizes appearance JSON object key order recursively', async () => {
  const common = {
    childName: 'Mina',
    childAge: '6',
    childPronouns: 'she/her' as const,
    theme: 'space-adventure',
    lesson: 'kindness',
    occasion: 'birthday',
    giftMessage: 'Love always',
    characterNotes: 'curly hair',
    customStoryText: '',
    familyCharacters: [],
    bookFormat: 'digital',
    email: 'buyer@example.com',
  };
  const first = createOrderRecord({
    ...common,
    appearanceOptions: JSON.stringify({
      skinTone: 'warm',
      hairStyle: 'curly',
      description: 'curly hair',
      likenessIntent: 'reference',
      nested: { z: 1, a: 2 },
    }),
  }, { id: ORDER_A, now: '2026-09-12T00:00:00.000Z', fulfillmentMode: 'manual_hold' });
  const second = createOrderRecord({
    ...common,
    appearanceOptions: JSON.stringify({
      nested: { a: 2, z: 1 },
      likenessIntent: 'reference',
      description: 'curly hair',
      hairStyle: 'curly',
      skinTone: 'warm',
    }),
  }, { id: ORDER_B, now: '2026-09-12T00:00:00.000Z', fulfillmentMode: 'manual_hold' });

  assert.equal(await checkoutIntentFingerprint(first), await checkoutIntentFingerprint(second));
});

test('retirement history survives multiple generations without mutation on stale requests', async () => {
  const store = new AtomicMemoryStore();
  const fingerprint = '8'.repeat(64);
  const retired: string[] = [];
  for (let generation = 0; generation < 5; generation += 1) {
    const orderId = `ord_${(generation + 1).toString(16).repeat(16)}`;
    assert.deepEqual(await claimCheckoutIntentOrderId(fingerprint, orderId, { store }), { orderId, generation });
    assert.equal(await releaseCheckoutIntentOrderId(fingerprint, orderId, generation, { store }), true);
    retired.push(orderId);
    const snapshot = structuredClone([...store.records]);
    const writes = store.creates;
    for (const old of retired) {
      await assert.rejects(claimCheckoutIntentOrderId(fingerprint, old, { store }), /retired checkout intent order/i);
    }
    assert.deepEqual([...store.records], snapshot);
    assert.equal(store.creates, writes);
    assert.deepEqual(
      JSON.parse(store.records.get(`checkout-intent-claims/${fingerprint}.json`)!.body).retiredOrderIds,
      retired,
    );
  }
  const proposals = Array.from({ length: 24 }, (_, i) => `ord_${(i + 32).toString(16).padStart(16, '0')}`);
  const results = await Promise.all(proposals.map((id) => claimCheckoutIntentOrderId(fingerprint, id, { store })));
  assert.equal(new Set(results.map((result) => result.orderId)).size, 1);
  assert.equal(results[0]!.generation, retired.length);
  const snapshot = structuredClone([...store.records]);
  const writes = store.creates;
  for (const [generation, old] of retired.entries()) {
    assert.equal(await releaseCheckoutIntentOrderId(fingerprint, old, generation, { store }), false);
    assert.deepEqual(await claimCheckoutIntentOrderId(fingerprint, old, { store }), results[0]);
  }
  assert.equal(await releaseCheckoutIntentOrderId(fingerprint, results[0]!.orderId, 0, { store }), false);
  assert.deepEqual([...store.records], snapshot);
  assert.equal(store.creates, writes);
});

const historyCases: { name: string; overrides: Record<string, unknown> }[] = [
  { name: 'null history', overrides: { retiredOrderIds: null } },
  { name: 'non-array history', overrides: { retiredOrderIds: ORDER_A } },
  { name: 'invalid history id', overrides: { retiredOrderIds: ['invalid'] } },
  { name: 'duplicate retirement', overrides: { generation: 2, retiredOrderIds: [ORDER_A, ORDER_A] } },
  { name: 'incomplete history', overrides: { generation: 2, retiredOrderIds: [ORDER_A] } },
  { name: 'excess history', overrides: { generation: 0, retiredOrderIds: [ORDER_A] } },
  { name: 'last retirement mismatch', overrides: { retiredOrderIds: [ORDER_B] } },
  { name: 'active retired owner', overrides: { orderId: ORDER_A } },
  { name: 'unsafe generation', overrides: { generation: Number.MAX_SAFE_INTEGER + 1 } },
];
for (const { name, overrides } of historyCases) {
  test(`claim and release reject ${name} without mutation`, async () => {
    const store = new AtomicMemoryStore();
    const fingerprint = '7'.repeat(64);
    store.records.set(`checkout-intent-claims/${fingerprint}.json`, {
      body: JSON.stringify({ fingerprint, orderId: null, previousOrderId: ORDER_A,
        retiredOrderIds: [ORDER_A], generation: 1, updatedAt: '2026-09-12T00:00:00.000Z', ...overrides }),
      version: 'v1',
    });
    const snapshot = structuredClone([...store.records]);
    await assert.rejects(claimCheckoutIntentOrderId(fingerprint, ORDER_B, { store }), /invalid checkout intent claim/i);
    await assert.rejects(releaseCheckoutIntentOrderId(fingerprint, ORDER_A, 1, { store }), /invalid checkout intent claim/i);
    assert.deepEqual([...store.records], snapshot);
    assert.equal(store.creates, 0);
  });
}

for (const orderId of [null, ORDER_B]) {
  test(`legacy multigeneration history fails closed with ${orderId ? 'active' : 'vacant'} ownership`, async () => {
    const store = new AtomicMemoryStore();
    const fingerprint = '6'.repeat(64);
    store.records.set(`checkout-intent-claims/${fingerprint}.json`, {
      body: JSON.stringify({ fingerprint, orderId, previousOrderId: ORDER_A,
        generation: 2, updatedAt: '2026-09-12T00:00:00.000Z' }), version: 'v1',
    });
    const snapshot = structuredClone([...store.records]);
    await assert.rejects(claimCheckoutIntentOrderId(fingerprint, ORDER_B, { store }), /invalid checkout intent claim/i);
    await assert.rejects(releaseCheckoutIntentOrderId(fingerprint, ORDER_B, 2, { store }), /invalid checkout intent claim/i);
    assert.deepEqual([...store.records], snapshot);
    assert.equal(store.creates, 0);
  });
}

for (const generation of [0, 1]) {
  test(`complete legacy generation ${generation} upgrades history on the next CAS`, async () => {
    const store = new AtomicMemoryStore();
    const fingerprint = '5'.repeat(64);
    const path = `checkout-intent-claims/${fingerprint}.json`;
    store.records.set(path, {
      body: JSON.stringify({ fingerprint, orderId: ORDER_B, previousOrderId: generation ? ORDER_A : null,
        generation, updatedAt: '2026-09-12T00:00:00.000Z' }), version: 'legacy',
    });
    assert.deepEqual(await claimCheckoutIntentOrderId(fingerprint, ORDER_A, { store }), { orderId: ORDER_B, generation });
    assert.equal(await releaseCheckoutIntentOrderId(fingerprint, ORDER_B, generation, { store }), true);
    assert.deepEqual(JSON.parse(store.records.get(path)!.body).retiredOrderIds, generation ? [ORDER_A, ORDER_B] : [ORDER_B]);
    const snapshot = structuredClone([...store.records]);
    assert.equal(await releaseCheckoutIntentOrderId(fingerprint, ORDER_B, generation, { store }), true);
    assert.deepEqual([...store.records], snapshot, 'repeat release must not append or write again');
    await assert.rejects(claimCheckoutIntentOrderId(fingerprint, ORDER_B, { store }), /retired checkout intent order/i);
  });
}

test('appearance canonicalization preserves array order and JSON value semantics', async () => {
  const order = normalizedOrder(form());
  const identity = (appearanceOptions: string) => checkoutIntentFingerprint({ ...order, appearanceOptions });
  const baseline = await identity('{"items":[{"z":1,"a":2},null,true,"1",1],"__proto__":{"z":1,"a":2}}');
  assert.equal(baseline, await identity('{"__proto__":{"a":2,"z":1},"items":[{"a":2,"z":1},null,true,"1",1]}'));
  assert.notEqual(baseline, await identity('{"items":[{"z":1,"a":2},null,true,1,"1"],"__proto__":{"z":1,"a":2}}'));
  for (const [left, right] of [['null', '"null"'], ['1', '"1"'], ['false', 'null'], ['{}', '[]'], ['{"x":null}', '{}']]) {
    assert.notEqual(await identity(left!), await identity(right!));
  }
});

test('malformed appearance JSON retains distinct identity instead of falling back to an empty value', async () => {
  const order = normalizedOrder(form());
  const values = ['', '{', '{broken', '{}', 'null', '[]'];
  const fingerprints = await Promise.all(values.map((appearanceOptions) => checkoutIntentFingerprint({ ...order, appearanceOptions })));
  assert.equal(new Set(fingerprints).size, values.length);
});

// ---------------------------------------------------------------------------
// One order id, one semantic owner
// ---------------------------------------------------------------------------
// The proposed order id is derived from a browser attempt, so one attempt
// proposes the same id for whatever content it currently holds. Ownership is
// durable and exclusive: a second intent that proposes an owned id is refused
// BEFORE any claim for it exists, so the refused content stays buyable.

const INTENT_A = 'a'.repeat(64);
const INTENT_B = 'b'.repeat(64);

test('a second intent can never take the order id an earlier intent owns', async () => {
  const store = new AtomicMemoryStore();
  assert.deepEqual(await claimCheckoutIntentOrderId(INTENT_A, ORDER_A, { store }), { orderId: ORDER_A, generation: 0 });

  await assert.rejects(
    claimCheckoutIntentOrderId(INTENT_B, ORDER_A, { store }),
    (error: Error) => error instanceof CheckoutIntentOwnershipError,
    'the edited content must be refused, not bound to the other intent order',
  );
  assert.equal(store.records.has(`checkout-intent-claims/${INTENT_B}.json`), false, 'no claim may be poisoned');
  assert.deepEqual(
    await claimCheckoutIntentOrderId(INTENT_B, ORDER_B, { store }),
    { orderId: ORDER_B, generation: 0 },
    'and a free order id still buys it',
  );
});

test('the owning intent keeps reclaiming its own order id idempotently', async () => {
  const store = new AtomicMemoryStore();
  const first = await claimCheckoutIntentOrderId(INTENT_A, ORDER_A, { store });
  assert.deepEqual(await claimCheckoutIntentOrderId(INTENT_A, ORDER_A, { store }), first);
  assert.equal(await releaseCheckoutIntentOrderId(INTENT_A, ORDER_A, first.generation, { store }), true);
  assert.deepEqual(
    await claimCheckoutIntentOrderId(INTENT_A, ORDER_B, { store }),
    { orderId: ORDER_B, generation: 1 },
    'a released intent may still take a free successor id',
  );
});

test('a released order id stays owned and can never be taken by a different intent', async () => {
  const store = new AtomicMemoryStore();
  const first = await claimCheckoutIntentOrderId(INTENT_A, ORDER_A, { store });
  assert.equal(await releaseCheckoutIntentOrderId(INTENT_A, ORDER_A, first.generation, { store }), true);

  await assert.rejects(
    claimCheckoutIntentOrderId(INTENT_B, ORDER_A, { store }),
    (error: Error) => error instanceof CheckoutIntentOwnershipError,
  );
  assert.equal(store.records.has(`checkout-intent-claims/${INTENT_B}.json`), false);
});

test('concurrent intents proposing one order id settle on a single durable owner', async () => {
  const store = new AtomicMemoryStore();
  const results = await Promise.allSettled([
    claimCheckoutIntentOrderId(INTENT_A, ORDER_A, { store }),
    claimCheckoutIntentOrderId(INTENT_B, ORDER_A, { store }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok((rejected as PromiseRejectedResult).reason instanceof CheckoutIntentOwnershipError);
  assert.equal(
    [INTENT_A, INTENT_B].filter((fingerprint) => store.records.has(`checkout-intent-claims/${fingerprint}.json`)).length,
    1,
  );
});

test('an order record proves ownership when the durable owner index is missing', async () => {
  const store = new AtomicMemoryStore();
  const owned = { ...normalizedOrder(form()), id: ORDER_A, checkoutIntentFingerprint: INTENT_A };
  const readOrder = async (orderId: string) => (orderId === ORDER_A ? owned : null);

  await assert.rejects(
    claimCheckoutIntentOrderId(INTENT_B, ORDER_A, { store, readOrder }),
    (error: Error) => error instanceof CheckoutIntentOwnershipError,
    'a pre-index order still belongs to the intent recorded on it',
  );
  assert.equal(store.records.has(`checkout-intent-claims/${INTENT_B}.json`), false);
  assert.deepEqual(
    await claimCheckoutIntentOrderId(INTENT_A, ORDER_A, { store, readOrder }),
    { orderId: ORDER_A, generation: 0 },
    'and its own intent may still adopt it',
  );
});

function seedMisboundClaim(store: AtomicMemoryStore, fingerprint: string, orderId: string): string {
  const pathname = `checkout-intent-claims/${fingerprint}.json`;
  store.records.set(pathname, {
    body: JSON.stringify({
      fingerprint, orderId, previousOrderId: null,
      retiredOrderIds: [], generation: 0, updatedAt: '2026-09-12T00:00:00.000Z',
    }),
    version: 'v1',
  });
  return pathname;
}

test('a mis-bound claim is repaired only when another intent provably owns the order', async () => {
  const store = new AtomicMemoryStore();
  // Two independent records agree that ORDER_A belongs to INTENT_A: its claim
  // and the order itself. Only that pair licenses retiring the mis-binding.
  await claimCheckoutIntentOrderId(INTENT_A, ORDER_A, { store });
  const misboundPath = seedMisboundClaim(store, INTENT_B, ORDER_A);
  const owned = { ...normalizedOrder(form()), id: ORDER_A, checkoutIntentFingerprint: INTENT_A };
  const readOrder = async (orderId: string) => (orderId === ORDER_A ? owned : null);

  assert.deepEqual(
    await claimCheckoutIntentOrderId(INTENT_B, ORDER_B, { store, readOrder }),
    { orderId: ORDER_B, generation: 1 },
  );
  const repaired = JSON.parse(store.records.get(misboundPath)!.body);
  assert.equal(repaired.orderId, ORDER_B);
  assert.deepEqual(repaired.retiredOrderIds, [ORDER_A]);
  assert.equal(
    JSON.parse(store.records.get(`checkout-intent-claims/${INTENT_A}.json`)!.body).orderId,
    ORDER_A,
    'the proven owner keeps its own order and Session',
  );

  assert.equal(await releaseCheckoutIntentOrderId(INTENT_B, ORDER_B, 1, { store }), true);
  await assert.rejects(
    claimCheckoutIntentOrderId(INTENT_B, ORDER_A, { store, readOrder }),
    /retired checkout intent order/i,
    'the repaired order id can never come back',
  );
});

test('a claim whose order cannot be proven foreign is returned unchanged', async () => {
  const store = new AtomicMemoryStore();
  const claimPath = seedMisboundClaim(store, INTENT_B, ORDER_A);
  const unowned = { ...normalizedOrder(form()), id: ORDER_A, checkoutIntentFingerprint: null };
  const snapshot = structuredClone([...store.records]);

  for (const readOrder of [
    async () => null,
    async () => unowned,
    async (orderId: string) => ({ ...unowned, checkoutIntentFingerprint: orderId === ORDER_A ? INTENT_B : null }),
    // A recorded owner that claims nothing is an unexplained rewrite, not proof.
    async (orderId: string) => ({ ...unowned, checkoutIntentFingerprint: orderId === ORDER_A ? INTENT_A : null }),
  ]) {
    assert.deepEqual(
      await claimCheckoutIntentOrderId(INTENT_B, ORDER_B, { store, readOrder }),
      { orderId: ORDER_A, generation: 0 },
      'an in-flight or self-owned order stays this intent canonical order',
    );
  }
  assert.deepEqual([...store.records], snapshot);
  assert.equal(store.creates, 0);
});

test('every browser attempt binds atomically to the canonical order and cannot be remapped', async () => {
  const store = new AtomicMemoryStore();
  assert.equal(await bindCheckoutAttemptToOrderId(ATTEMPT_B, ORDER_A, { store }), true);
  assert.equal(await bindCheckoutAttemptToOrderId(ATTEMPT_B, ORDER_A, { store }), true);
  assert.equal(await resolveCheckoutOrderIdForAttempt(ATTEMPT_B, { store }), ORDER_A);
  assert.equal(await bindCheckoutAttemptToOrderId(ATTEMPT_B, ORDER_B, { store }), false);
  assert.equal(await resolveCheckoutOrderIdForAttempt(ATTEMPT_B, { store }), ORDER_A);
});
