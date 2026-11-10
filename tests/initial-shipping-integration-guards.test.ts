import assert from 'node:assert/strict';
import test from 'node:test';
import * as checkout from '../src/lib/initial-shipping-checkout.ts';
import * as draft from '../src/lib/initial-shipping-draft.ts';
import { createIntakeRecord, createVercelIntakeStore } from '../src/lib/checkout-intake.ts';
import { sha256 } from '../src/lib/initial-shipping-contract.ts';
import { CONTACT, PROVIDER, fakePrivateSdk, fakeLuluFetch, withLuluEnv } from './support/initial-shipping-fixture.ts';

import { handleCheckoutOrderPost } from '../src/lib/checkout-order-route-handler.ts';
import { getOrderAuthoritative } from '../src/lib/orders.ts';
import { POLICY_RAW, syntheticOrderBlob } from './support/initial-shipping-fixture.ts';

async function orderFixture(run: (s: any) => Promise<void>) {
  const old = { ...process.env }; const originalFetch = globalThis.fetch;
  const orderBlob = syntheticOrderBlob(); const sdk = fakePrivateSdk();
  globalThis.fetch = async () => { throw new Error('UNMATCHED_OUTBOUND'); };
  Object.assign(process.env, { HSB_CHECKOUT_DIRECT_UPLOAD: 'true', HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true',
    HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'true', HSB_INTAKE_BLOB_READ_WRITE_TOKEN: token,
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_orderSynthetic_synthetic', HSB_BLOB_ACCESS_MODE: 'private',
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'true', STRIPE_PRODUCT_CLASSIC_ID: 'prod_syntheticBook',
    HSB_INITIAL_EXPEDITED_COMMERCIAL_POLICY: JSON.stringify(POLICY_RAW),
    HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: JSON.stringify({ ...PROVIDER, accountBinding: sha256('synthetic-client') }) });
  try {
    const owner = createIntakeRecord({ mediaAuthorizedAt: new Date().toISOString(), documentAuthorizedAt: null,
      childVoiceAuthorizedAt: null, voiceSource: null });
    const intake = createVercelIntakeStore(token, process.env, sdk.io); await intake.create(owner.record);
    const ship = checkout.createShippingRouteHandler({ blob: sdk.io, fetch: fakeLuluFetch() });
    const send = (op: string, extra: object = {}) => ship(new Request('https://example.test/api/checkout/shipping', {
      method: 'POST', headers: { origin: 'https://example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ op, intakeId: owner.record.intakeId, capability: owner.capability, ...extra }) }));
    const contactResponse = await send('put_contact', { contact, bookFormat: 'classic' });
    assert.equal(contactResponse.status, 200, await contactResponse.text());
    const q = await (await send('quote')).json(); assert.ok(q.quote, JSON.stringify(q));
    assert.equal((await send('select', { quoteId: q.quote.quoteId })).status, 200);
    const creates: any[] = []; const sessions = new Map();
    const request = (edit?: (f: FormData) => void) => {
      const f = new FormData();
      for (const [k,v] of Object.entries({ checkoutAttemptId: 'a'.repeat(32), childName: 'Synthetic', email: 'synthetic@example.invalid',
        bookFormat: 'classic', theme: 'space-adventure', characterNotes: 'Curly hair and a red cape',
        checkoutIntakeCapability: owner.capability, expeditedQuoteId: q.quote.quoteId,
        checkoutIntake: JSON.stringify({ intakeId: owner.record.intakeId, familyCharacterIds: [], selection: {
          primaryHeroPhotoAssetId: null, familyCharacterAssets: [], guidedStillAssetIds: [], voiceAssetId: null, documentAssetId: null } }) })) f.set(k,v as string);
      edit?.(f);
      return new Request('https://example.test/api/order', { method: 'POST', body: f,
        headers: { cookie: `__Host-hsb-checkout-attempt=${'a'.repeat(32)}`, 'x-hsb-checkout-attempt': 'a'.repeat(32) } });
    };
    const unexpected = async () => { throw new Error('UNEXPECTED_MEDIA_IO'); };
    const deps: any = { json: (body: any, status: number) => {
      if (status === 200 && body.redirectTo) {
        const records = [...orderBlob.files.values()].map(f => JSON.parse(f.body));
        assert.ok(records.some(r => r.stripeSessionId === 'cs_synthetic'), 'Session is durably pre-bound before URL construction');
      }
      return Response.json(body, { status });
    },
      shippingBlob: sdk.io, shippingProvenanceTransport: sdk.io, createIntakeStore: () => intake,
      createCheckoutSession: async (input: any) => {
        creates.push(input);
        const durable = await getOrderAuthoritative(input.order.id);
        assert.ok(durable?.checkoutSessionProvisioning, 'pre-provider marker is durable');
        if (input.order.initialShipping) {
          const privateDraft = [...sdk.files.entries()].find(([p]) => p.includes('checkout-shipping-drafts/'))!;
          const locked = JSON.parse(privateDraft[1].body);
          assert.equal(locked.lock.canonicalOrderId, input.order.id);
          assert.equal(locked.lock.checkoutIntentFingerprint, input.order.checkoutIntentFingerprint);
          assert.ok([...sdk.files.keys()].some(p => p.includes('order-provenance/initial-shipping/')));
        }
        const session = { id: 'cs_synthetic', url: 'https://checkout.stripe.test/synthetic', status: 'open',
          payment_status: 'unpaid', payment_intent: null, expires_at: input.expeditedParams?.expires_at };
        sessions.set(session.id, session); return session;
      }, retrieveCheckoutSession: async (id: string) => sessions.get(id),
      uploadOrderPhoto: unexpected, uploadOrderSupportingPhoto: unexpected, uploadOrderVoice: unexpected,
      uploadOrderDocument: unexpected, rollbackOrderMediaUploads: unexpected,
      markRecoveryLeadConverted: async () => null, logError: () => {} };
    await run({ request, deps, creates, sessions, sdk, owner, orderBlob, quote: q.quote });
  } finally {
    orderBlob.close(); globalThis.fetch = originalFetch;
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k]; Object.assign(process.env, old);
  }
}

test('persisted pending shipping order retries after intake ack failure at a later clock', () => withLuluEnv(() => orderFixture(async s => {
  const store = s.deps.createIntakeStore(); const cas = store.compareAndSwap; let blockedAcks = 0;
  store.compareAndSwap = async (id: string, etag: string, record: any) => {
    if (record.finalizedOrderId) { blockedAcks++; throw new Error('synthetic ack failure'); }
    return cas(id, etag, record);
  };
  const first = await handleCheckoutOrderPost(s.request(), s.deps) as Response;
  assert.notEqual(first.status, 200); assert.ok(blockedAcks > 0); assert.equal(s.creates.length, 0);
  const pending = [...s.orderBlob.files.values()].map((f: any) => JSON.parse(f.body)).filter((r: any) => r.initialShipping);
  assert.equal(pending.length, 1); assert.equal(pending[0].checkoutSessionProvisioning ?? null, null);
  store.compareAndSwap = cas;
  // Advance real Date construction as well as Date.now: the defect uses new Date().
  await new Promise(resolve => setTimeout(resolve, 20));
  const retry = await handleCheckoutOrderPost(s.request(), s.deps) as Response;
  assert.equal(retry.status, 200, await retry.text()); assert.equal(s.creates.length, 1);
  const final = [...s.orderBlob.files.values()].map((f: any) => JSON.parse(f.body)).filter((r: any) => r.initialShipping);
  assert.equal(final.length, 1); assert.equal(final[0].id, pending[0].id);
  assert.equal(final[0].initialShippingSettlement.updatedAt, pending[0].initialShippingSettlement.updatedAt);
})));

test('known short quote window on locked pending retry leaves no provisioning marker', () => withLuluEnv(() => orderFixture(async s => {
  const store = s.deps.createIntakeStore(); const cas = store.compareAndSwap;
  store.compareAndSwap = async (id: string, etag: string, record: any) => {
    if (record.finalizedOrderId) throw new Error('synthetic ack failure');
    return cas(id, etag, record);
  };
  assert.notEqual((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200);
  store.compareAndSwap = cas;
  const clock = Date.now;
  try {
    Date.now = () => s.quote.expiresAtMs - 10 * 60_000;
    assert.notEqual((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200);
    assert.equal(s.creates.length, 0);
    const orders = [...s.orderBlob.files.values()].map((f: any) => JSON.parse(f.body)).filter((r: any) => r.initialShipping);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].checkoutSessionProvisioning ?? null, null, 'knowable refusal must precede durable marker');
  } finally { Date.now = clock; }
})));

test('create boundary rejects context drift inside the final awaited owner read', () => withLuluEnv(() => orderFixture(async s => {
  assert.equal((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200);
  const order = await getOrderAuthoritative(s.creates[0].order.id); assert.ok(order);
  const get = s.sdk.io.get; let armed = false; let reads = 0;
  const blob = { ...s.sdk.io, get: async (path: string, options: any) => {
    const value = await get(path, options);
    if (armed && path.includes('intakes/') && ++reads === 2) process.env.HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED = 'false';
    return value;
  } };
  const authority = await checkout.openInitialShippingCheckout({ intakeId: s.owner.record.intakeId,
    capability: s.owner.capability, quoteId: s.quote.quoteId, bookFormat: order.bookFormat,
    bookCents: order.priceCents, blob, provenanceTransport: s.sdk.io });
  await authority.confirm(order); armed = true;
  await assert.rejects(authority.createParams(order, 'prod_syntheticBook', 'https://example.test'));
  assert.equal(reads, 2); assert.equal(s.creates.length, 1);
})));

test('order HTTP selected quote reaches shared durable provisioner and binds before releasing itemized Session', () => withLuluEnv(() => orderFixture(async s => {
  const response = await handleCheckoutOrderPost(s.request(), s.deps) as Response;
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(s.creates.length, 1);
  const input = s.creates[0]; assert.ok(input.order.initialShipping, 'selected shipping must not silently become standard');
  assert.deepEqual(input.expeditedParams.line_items.map((i: any) => i.price_data.unit_amount), [input.order.priceCents, 420]);
  assert.equal(input.expeditedParams.allow_promotion_codes, false);
  assert.equal(input.expeditedParams.shipping_address_collection, undefined);
  const durable = await getOrderAuthoritative(input.order.id);
  assert.equal(durable?.stripeSessionId, 'cs_synthetic');
  assert.equal(durable?.initialShippingSettlement?.state, 'unverified');
  assert.equal((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200);
  assert.equal(s.creates.length, 1);
})));

test('order HTTP refuses invalid, duplicate, legacy, digital, disabled, unqualified and wrong-owner selections without Stripe', () => withLuluEnv(async () => {
  for (const mode of ['malformed', 'duplicate', 'legacy', 'digital', 'flag', 'policy', 'provider', 'wrong-owner', 'draft-owner', 'mismatch', 'expired', 'marker-unknown', 'lock-conflict']) {
    await orderFixture(async s => {
      if (mode === 'flag') process.env.HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED = 'false';
      if (mode === 'policy') delete process.env.HSB_INITIAL_EXPEDITED_COMMERCIAL_POLICY;
      if (mode === 'provider') delete process.env.HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION;
      if (mode === 'marker-unknown') s.deps.shippingProvenanceTransport = { ...s.sdk.io, get: async () => { throw new Error('unknown'); }, put: async () => { throw new Error('unknown'); } };
      if (mode === 'expired' || mode === 'lock-conflict' || mode === 'draft-owner') {
        const [p,f] = [...s.sdk.files.entries()].find(([p]: any) => p.includes('checkout-shipping-drafts/')) as any;
        const d = JSON.parse(f.body);
        if (mode === 'expired') { d.quote.expiresAtMs = Date.now() - 1; }
        else if (mode === 'draft-owner') d.ownerHash = 'f'.repeat(64);
        else { d.state = 'locked'; d.lock = { canonicalOrderId: 'ord_' + 'e'.repeat(16), checkoutIntentFingerprint: 'a'.repeat(64), quoteId: d.selectedQuoteId, binding: d.quote.binding, lockedRevision: d.revision }; }
        s.sdk.files.set(p, { ...f, body: JSON.stringify(d) });
      }
      const response = await handleCheckoutOrderPost(s.request((f: FormData) => {
        if (mode === 'malformed') f.set('expeditedQuoteId', 'bad');
        if (mode === 'duplicate') f.append('expeditedQuoteId', s.quote.quoteId);
        if (mode === 'legacy') { f.delete('checkoutIntake'); f.delete('checkoutIntakeCapability'); }
        if (mode === 'digital') f.set('bookFormat', 'digital');
        if (mode === 'wrong-owner') f.set('checkoutIntakeCapability', 'wrong'.repeat(12));
        if (mode === 'mismatch') f.set('expeditedQuoteId', '00000000-0000-4000-8000-000000000000');
      }), s.deps) as Response;
      assert.notEqual(response.status, 200, mode); assert.equal(s.creates.length, 0, mode);
    });
  }
}));

test('order HTTP unknown create never creates another Session; concurrent requests create once', () => withLuluEnv(async () => {
  await orderFixture(async s => {
    const create = s.deps.createCheckoutSession;
    s.deps.createCheckoutSession = async (input: any) => { await create(input); throw new Error('response lost'); };
    assert.notEqual((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200);
    assert.notEqual((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200);
    assert.equal(s.creates.length, 1);
  });
  await orderFixture(async s => {
    const responses = await Promise.all([handleCheckoutOrderPost(s.request(), s.deps), handleCheckoutOrderPost(s.request(), s.deps)]) as Response[];
    assert.ok(responses.some(r => r.status === 200)); assert.equal(s.creates.length, 1);
  });
}));

test('order HTTP existing URL release rechecks expiry and provenance after retrieval', () => withLuluEnv(async () => {
  for (const mode of ['expiry', 'marker']) await orderFixture(async s => {
    const first = await handleCheckoutOrderPost(s.request(), s.deps) as Response;
    assert.equal(first.status, 200); const body = await first.json();
    const same = await handleCheckoutOrderPost(s.request(), s.deps) as Response;
    assert.deepEqual(await same.json(), body);
    const retrieve = s.deps.retrieveCheckoutSession; const clock = Date.now;
    s.deps.retrieveCheckoutSession = async (id: string) => {
      const session = await retrieve(id);
      if (mode === 'expiry') Date.now = () => s.quote.expiresAtMs + 1;
      else for (const [p,f] of s.sdk.files) if (p.includes('order-provenance/')) s.sdk.files.set(p, { ...f, body: '{}' });
      return session;
    };
    try { assert.notEqual((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200); }
    finally { Date.now = clock; }
    assert.equal(s.creates.length, 1);
  });
}));

test('order HTTP unselected standard has no shipping fields or parameter override', () => withLuluEnv(() => orderFixture(async s => {
  const response = await handleCheckoutOrderPost(s.request((f: FormData) => f.delete('expeditedQuoteId')), s.deps) as Response;
  assert.equal(response.status, 200, await response.text()); assert.equal(s.creates.length, 1);
  assert.equal(s.creates[0].expeditedParams, undefined); assert.equal(s.creates[0].order.initialShipping, undefined);
})));

test('order HTTP quote authority contains new/replacement session window and expiry after create prevents release', () => withLuluEnv(async () => {
  for (const mode of ['new-window', 'replacement-window', 'after-create']) await orderFixture(async s => {
    const clock = Date.now;
    try {
      if (mode === 'replacement-window') {
        assert.equal((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200);
        s.sessions.get('cs_synthetic').status = 'expired';
      }
      if (mode === 'after-create') {
        const create = s.deps.createCheckoutSession;
        s.deps.createCheckoutSession = async (input: any) => { const result = await create(input); Date.now = () => s.quote.expiresAtMs + 1; return result; };
      } else Date.now = () => s.quote.expiresAtMs - 10 * 60_000;
      assert.notEqual((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200, mode);
      assert.equal(s.creates.length, mode === 'new-window' ? 0 : 1, mode);
      assert.notEqual((await handleCheckoutOrderPost(s.request(), s.deps) as Response).status, 200, mode);
      assert.equal(s.creates.length, mode === 'new-window' ? 0 : 1, mode);
    } finally { Date.now = clock; }
  });
}));

test('browser receipt uses current catalog, revision and canonical included-tax totals without extra quotes', () => withLuluEnv(async () => {
  for (const format of ['classic', 'premium'] as const) for (const selectedTax of [50, 70]) {
    const s = await fixture(selectedTax);
    const put = await (await s.send('put_contact', { contact, bookFormat: format })).json();
    const { getBookFormatMeta } = await import('../src/lib/orders.ts');
    const bookCents = getBookFormatMeta(format).priceCents;
    assert.equal(put.bookFormat, format); assert.equal(put.bookCents, bookCents);
    assert.equal(put.totalCents, bookCents); assert.equal(put.deltaTaxIncludedCents, 0);
    const q = await (await s.send('quote')).json();
    const calls = s.seen.length;
    const selected = await (await s.send('select', { quoteId: q.quote.quoteId })).json();
    const d = JSON.parse(s.stored()![1].body);
    const canonical = checkout.buildInitialShippingMetadata({ draft: d, selectedQuoteId: d.selectedQuoteId,
      product: d.product, bookCents, now: now(), ctx: { flags: { quotes: true, checkout: true },
        provider: { ...PROVIDER, accountBinding: sha256('synthetic-client') },
        commercial: (await import('../src/lib/initial-shipping-contract.ts')).parseInitialShippingCommercialPolicy(POLICY_RAW) } });
    for (const field of ['bookCents', 'deltaCents', 'deltaTaxIncludedCents', 'totalCents'] as const) {
      assert.equal(q[field], canonical.totals[field]); assert.equal(selected[field], canonical.totals[field]);
    }
    assert.equal(q.deltaTaxIncludedCents, selectedTax - 50);
    assert.equal(selected.revision, d.revision); assert.equal(selected.revision, put.revision);
    assert.deepEqual(Object.keys(selected).sort(), ['bookCents','bookFormat','contact','deltaCents','deltaTaxIncludedCents','estimate','quote','revision','selectedQuoteId','totalCents'].sort());
    const cleared = await (await s.send('clear')).json();
    assert.equal(cleared.selectedQuoteId, null); assert.equal(cleared.quote, null);
    assert.equal(cleared.totalCents, bookCents); assert.equal(cleared.deltaTaxIncludedCents, 0);
    assert.equal(s.seen.length, calls);
  }
}));

import { InitialShippingClient } from '../src/lib/initial-shipping-client.ts';

test('rejected first contact clears authoritative empty draft through real route for Standard and Digital', () => withLuluEnv(async () => {
  for (const format of ['classic', 'digital']) {
    const s = await fixture();
    const c = new InitialShippingClient(() => {}, async body => {
      const response = await s.handler(s.request(body));
      if (!response.ok) throw new Error('shipping refused');
      return response.json();
    }, now);
    await c.quote('classic', { ...contact, name: '', postalCode: contact.zip, country: 'US', line2: '' }, async () => ({
      intakeId: s.owner.record.intakeId, capability: s.owner.capability, expiresAt: s.owner.record.expiresAt,
    }));
    assert.equal(s.stored(), undefined); assert.equal(c.ready(format), false);
    await c.standard();
    assert.equal(c.ready(format), true);
    const payload = new FormData(); c.bind(payload, c.epoch, format);
    assert.equal(payload.has('expeditedQuoteId'), false); assert.equal(s.stored(), undefined); assert.equal(s.seen.length, 0);
  }
}));

const now = () => 1_800_000_000_000;
const contact = { ...CONTACT, phone: '+13125550101' };
const token = 'vercel_blob_rw_syntheticIntake_syntheticSecret';
async function fixture(selectedTax = 70) {
  const sdk = fakePrivateSdk();
  const env: NodeJS.ProcessEnv = { ...process.env, HSB_CHECKOUT_DIRECT_UPLOAD: 'true', HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: token,
    HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: JSON.stringify({ ...PROVIDER, accountBinding: sha256('synthetic-client') }) };
  const owner = createIntakeRecord({ mediaAuthorizedAt: new Date(now()).toISOString(), documentAuthorizedAt: null,
    childVoiceAuthorizedAt: null, voiceSource: null }, new Date(now()));
  await createVercelIntakeStore(token, env, sdk.io).create(owner.record);
  const seen: string[] = [];
  assert.equal(typeof checkout.createShippingRouteHandler, 'function', 'real HTTP dispatcher must exist');
  const handler = checkout.createShippingRouteHandler({ env, now, blob: sdk.io, fetch: fakeLuluFetch(seen, selectedTax) });
  const body = (op: string, extra: object = {}) => ({ op, intakeId: owner.record.intakeId, capability: owner.capability, ...extra });
  const request = (data: unknown, headers: Record<string, string> = {}) => new Request('https://example.test/api/checkout/shipping', {
    method: 'POST', headers: { origin: 'https://example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  });
  const send = (op: string, extra: object = {}) => handler(request(body(op, extra)));
  const stored = () => [...sdk.files.entries()].find(([p]) => p.includes('checkout-shipping-drafts/'));
  return { sdk, env, owner, seen, handler, body, request, send, stored };
}

test('existing quote operation must reauthorize genuine intake after provider await', () => withLuluEnv(async () => {
  const { assertCapability, assertIntakeUsable, parseIntakeRecord } = await import('../src/lib/checkout-intake.ts');
  const { fakeBlob, realProducer } = await import('./support/initial-shipping-fixture.ts');
  const { planInitialShippingProduct } = await import('../src/lib/initial-shipping-contract.ts');
  const owner = createIntakeRecord({ mediaAuthorizedAt: new Date(now()).toISOString(), documentAuthorizedAt: null,
    childVoiceAuthorizedAt: null, voiceSource: null }, new Date(now()));
  let record = owner.record;
  const io = fakeBlob(); const store = draft.createDraftStore(io.io, { namespace: '', storeId: 'synthetic' });
  const deps = { store, namespace: '', storeId: 'synthetic', now, verifyIntake: async (_id: string, cap: string) => {
    const parsed = parseIntakeRecord(record); assertCapability(parsed, cap); assertIntakeUsable(parsed, now());
    return { ok: true, expiresAtMs: Date.parse(parsed.expiresAt) };
  } };
  await draft.putShippingContact(deps, { intakeId: record.intakeId, capability: owner.capability, contact,
    product: planInitialShippingProduct('classic', () => '0850X0850.FC.STD.PB.080CW444.GXX'), provider: PROVIDER });
  const produce = realProducer(now);
  await assert.rejects(draft.quoteShippingDraft(deps, { intakeId: record.intakeId, capability: owner.capability, provider: PROVIDER,
    produce: async (input, cap) => { const quote = await produce(input, cap); record = { ...record, capabilityHash: 'f'.repeat(64) }; return quote; } }));
  assert.equal((await store.read(record.intakeId))!.record.quote, null);
}));

test('selection validates the current CAS receipt, not only an earlier route read', () => withLuluEnv(async () => {
  const s = await fixture();
  assert.equal((await s.send('put_contact', { contact, bookFormat: 'classic' })).status, 200);
  const q = await (await s.send('quote')).json();
  const original = s.sdk.io.get; let shippingReads = 0;
  s.sdk.io.get = (async (path: string, opts: any) => {
    if (path.includes('checkout-shipping-drafts/') && ++shippingReads === 2) {
      const f = s.sdk.files.get(path)!; const d = JSON.parse(f.body); d.quote.deltaCents++;
      s.sdk.files.set(path, { ...f, body: JSON.stringify(d) });
    }
    return original(path, opts);
  }) as typeof original;
  const handler = checkout.createShippingRouteHandler({ env: s.env, now, blob: s.sdk.io, fetch: fakeLuluFetch() });
  assert.notEqual((await handler(s.request(s.body('select', { quoteId: q.quote.quoteId })))).status, 200);
  assert.equal(JSON.parse(s.stored()![1].body).selectedQuoteId, null);
}));

test('production private adapter is exported, not an intake-schema wrapper', () => {
  assert.equal(typeof draft.createPrivateShippingDraftAccess, 'function');
});
test('actual route exports POST and no contact GET; default flags refuse without resources', async () => {
  const route = await import('../src/app/api/checkout/shipping/route.ts');
  assert.equal(typeof route.POST, 'function');
  assert.equal('GET' in route, false);
  const response = await route.POST(new Request('https://example.test/api/checkout/shipping', { method: 'POST' }));
  assert.equal(response.status, 404);
});
test('real HTTP -> private adapter -> strict Lulu producer -> select -> clear; media bytes unchanged', () => withLuluEnv(async () => {
  const s = await fixture();
  const intake = [...s.sdk.files.entries()][0]; const before = intake[1].body;
  assert.equal((await s.send('put_contact', { contact, bookFormat: 'classic' })).status, 200);
  const q = await s.send('quote'); assert.equal(q.status, 200); const summary = await q.json();
  assert.equal(summary.quote.deltaCents, 420); assert.equal(summary.quote.transitDays, 2);
  assert.ok(s.seen.some(u => u.endsWith('/shipping-options/')));
  assert.equal(s.seen.filter(u => u.endsWith('/print-job-cost-calculations/')).length, 2);
  assert.equal(JSON.parse(s.stored()![1].body).product.interiorPageCount, 32);
  assert.equal((await s.send('select', { quoteId: summary.quote.quoteId })).status, 200);
  assert.equal(JSON.parse(s.stored()![1].body).state, 'selected');
  assert.equal((await s.send('clear')).status, 200);
  assert.equal(JSON.parse(s.stored()![1].body).quote, null);
  assert.equal((await s.send('put_contact', { contact, bookFormat: 'premium' })).status, 200);
  assert.equal(JSON.parse(s.stored()![1].body).product.interiorPageCount, 38);
  assert.equal(s.sdk.files.get(intake[0])!.body, before);
  for (const c of s.sdk.calls) {
    assert.equal(c.options.access, 'private'); assert.equal(c.options.token, token);
    if (c.op === 'get') assert.equal(c.options.useCache, false);
    else { assert.equal(c.options.addRandomSuffix, false); if (c.options.allowOverwrite) assert.ok(c.options.ifMatch); }
  }
  const text = JSON.stringify(summary);
  for (const secret of [s.owner.capability, sha256(s.owner.capability), 'accountBinding', 'baseline', 'binding', 'stack', 'sessionId']) assert.ok(!text.includes(secret), secret);
}));
test('malformed, duplicate, unknown, digital, tampered, cross-origin and lease requests have no write/provider effects', () => withLuluEnv(async () => {
  const s = await fixture();
  const cases = [s.request('{'), s.request('{"op":"clear","op":"quote"}'), s.request(s.body('unknown')),
    s.request(s.body('put_contact', { contact, bookFormat: 'digital' })),
    s.request(s.body('put_contact', { contact, bookFormat: 'classic', pageCount: 2 })),
    s.request(s.body('put_contact', { contact, bookFormat: 'classic' }), { origin: 'https://other.test' }),
    s.request(s.body('put_contact', { contact, bookFormat: 'classic' }), { 'x-hsb-checkout-attempt': 'a'.repeat(32) }),
    s.request({ ...s.body('put_contact', { contact, bookFormat: 'classic' }), capability: 'wrong'.repeat(12) }),
    s.request(' '.repeat(17000))];
  const writes = s.sdk.calls.filter(c => c.op === 'put').length;
  for (const r of cases) assert.notEqual((await s.handler(r)).status, 200);
  assert.equal(s.sdk.calls.filter(c => c.op === 'put').length, writes); assert.equal(s.seen.length, 0);
}));
test('expired/finalized/cleanup-claimed and capability-rotated genuine intakes refuse', () => withLuluEnv(async () => {
  for (const edit of [ { expiresAt: new Date(now() - 1).toISOString() }, { finalizedOrderId: 'ord_' + 'a'.repeat(16) },
    { cleanupClaim: { claimId: 'a'.repeat(32), claimedAt: new Date(now()).toISOString(), expiresAt: new Date(now()+60000).toISOString() } },
    { capabilityHash: 'f'.repeat(64) } ]) {
    const s = await fixture(); const [p, f] = [...s.sdk.files.entries()][0];
    s.sdk.files.set(p, { ...f, body: JSON.stringify({ ...JSON.parse(f.body), ...edit }) });
    assert.notEqual((await s.send('put_contact', { contact, bookFormat: 'classic' })).status, 200);
    assert.equal(s.stored(), undefined); assert.equal(s.seen.length, 0);
  }
}));
test('HTTP quote completion is fenced after contact, capability, account, namespace and SKU drift', () => withLuluEnv(async () => {
  for (const mode of ['contact', 'capability', 'account', 'namespace', 'sku']) {
    const s = await fixture();
    assert.equal((await s.send('put_contact', { contact, bookFormat: 'classic' })).status, 200);
    const base = fakeLuluFetch(); let costs = 0;
    const oldSku = process.env.LULU_SOFTCOVER_POD_PACKAGE_ID;
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await base(url, init);
      if (String(url).endsWith('/print-job-cost-calculations/') && ++costs === 2) {
        if (mode === 'contact') assert.equal((await s.send('put_contact', { contact: { ...contact, city: 'Evanston' }, bookFormat: 'classic' })).status, 200);
        if (mode === 'capability') {
          const [p, f] = [...s.sdk.files.entries()][0];
          s.sdk.files.set(p, { ...f, body: JSON.stringify({ ...JSON.parse(f.body), capabilityHash: 'f'.repeat(64) }) });
        }
        if (mode === 'account') s.env.HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION = JSON.stringify({ ...PROVIDER, accountBinding: 'f'.repeat(64) });
        if (mode === 'namespace') s.env.HSB_BLOB_NAMESPACE = 'other';
        if (mode === 'sku') process.env.LULU_SOFTCOVER_POD_PACKAGE_ID = 'SYNTHETIC.DRIFT.1234';
      }
      return response;
    };
    try {
      const handler = checkout.createShippingRouteHandler({ env: s.env, now, blob: s.sdk.io, fetch: fetchImpl });
      assert.notEqual((await handler(s.request(s.body('quote')))).status, 200, mode);
      assert.equal(costs, 2, 'real paired cost producer reached');
      assert.equal(JSON.parse(s.stored()![1].body).quote, null, mode);
    } finally { if (oldSku === undefined) delete process.env.LULU_SOFTCOVER_POD_PACKAGE_ID; else process.env.LULU_SOFTCOVER_POD_PACKAGE_ID = oldSku; }
  }
}));

test('select rejects a tampered real receipt; edit invalidates a selected quote; matching lease works', () => withLuluEnv(async () => {
  const s = await fixture(); const lease = 'a'.repeat(32);
  assert.equal((await s.handler(s.request(s.body('put_contact', { contact, bookFormat: 'classic' }), {
    'x-hsb-checkout-attempt': lease, cookie: `__Host-hsb-checkout-attempt=${lease}` }))).status, 200);
  const summary = await (await s.send('quote')).json(); const [p, f] = s.stored()!;
  const bad = JSON.parse(f.body); bad.quote.deltaCents += 1;
  s.sdk.files.set(p, { ...f, body: JSON.stringify(bad) });
  assert.notEqual((await s.send('select', { quoteId: summary.quote.quoteId })).status, 200);
  s.sdk.files.set(p, f);
  assert.equal((await s.send('select', { quoteId: summary.quote.quoteId })).status, 200);
  assert.equal((await s.send('put_contact', { contact: { ...contact, zip: '60602' }, bookFormat: 'classic' })).status, 200);
  const edited = JSON.parse(s.stored()![1].body); assert.equal(edited.quote, null); assert.equal(edited.selectedQuoteId, null);
}));

test('default-off/legacy/provider-baseline refusals perform no writes or provider work', () => withLuluEnv(async () => {
  for (const edit of [{ HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'false' }, { HSB_CHECKOUT_DIRECT_UPLOAD: 'false' },
    { HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: '' },
    { HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION: JSON.stringify({ ...PROVIDER, accountBinding: sha256('synthetic-client'), baselineService: 'GROUND' }) }]) {
    const s = await fixture(); Object.assign(s.env, edit);
    const before = s.sdk.calls.length;
    assert.notEqual((await s.send('put_contact', { contact, bookFormat: 'classic' })).status, 200);
    assert.equal(s.sdk.calls.length, before); assert.equal(s.seen.length, 0);
  }
}));

test('a genuinely locked selection refuses all editing operations', () => withLuluEnv(async () => {
  const s = await fixture();
  assert.equal((await s.send('put_contact', { contact, bookFormat: 'classic' })).status, 200);
  const summary = await (await s.send('quote')).json();
  assert.equal((await s.send('select', { quoteId: summary.quote.quoteId })).status, 200);
  const access = draft.createPrivateShippingDraftAccess(s.env, s.sdk.io);
  await draft.lockShippingDraft(access.store, { intakeId: s.owner.record.intakeId, capability: s.owner.capability,
    canonicalOrderId: 'ord_' + 'a'.repeat(16), checkoutIntentFingerprint: 'f'.repeat(64), quoteId: summary.quote.quoteId, now: now() });
  const before = s.stored()![1].body; const calls = s.seen.length;
  for (const [op, extra] of [['put_contact', { contact, bookFormat: 'premium' }], ['quote', {}], ['select', { quoteId: summary.quote.quoteId }], ['clear', {}]] as const) {
    assert.notEqual((await s.send(op, extra)).status, 200);
    assert.equal(s.stored()![1].body, before);
  }
  assert.equal(s.seen.length, calls);
}));

test('lost write response exact-reread succeeds; wrong namespace/store and locked records refuse', () => withLuluEnv(async () => {
  const s = await fixture(); s.sdk.faults.lostWrite = true;
  assert.equal((await s.send('put_contact', { contact, bookFormat: 'classic' })).status, 200);
  s.sdk.faults.lostWrite = false;
  const [p, f] = s.stored()!;
  for (const edit of [{ namespace: 'other' }, { storeId: 'anotherStore' }, { state: 'held' }]) {
    const body = JSON.stringify({ ...JSON.parse(f.body), ...edit }); s.sdk.files.set(p, { ...f, body });
    assert.notEqual((await s.send('put_contact', { contact, bookFormat: 'premium' })).status, 200);
    assert.equal(s.sdk.files.get(p)!.body, body);
  }
}));
