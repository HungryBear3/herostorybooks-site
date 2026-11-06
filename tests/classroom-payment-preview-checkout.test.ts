// SYNTHETIC classroom payment-Preview CHECKOUT isolation suite. Never real
// payment evidence; no provider transport.
// - The 'stripe' module is replaced before any application import by a
//   subclass of the REAL SDK whose coupon/Session resources read in-memory
//   SYNTHETIC fact maps (cloned on write and read). Transport is never reached.
// - '@vercel/blob' maps to the existing in-memory store fake; REAL roster
//   creation, manifest publication, assembly checks and native admin auth run.
// - The ACTUAL admin checkout route (POST) is the entry; the target, policy and
//   coupon are server env only. Orders use the REAL local filesystem adapter.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';

const SUITE = 'classroom-payment-preview-checkout';

// Owned runtime: the inherited TMPDIR must be an existing canonical absolute directory.
function ownedRuntime(sub: string): string {
  const tmp = (process.env.TMPDIR ?? '').replace(/\/+$/, '');
  assert.ok(tmp && path.isAbsolute(tmp), 'TMPDIR must be absolute');
  assert.equal(realpathSync(tmp), tmp, 'TMPDIR must be canonical');
  assert.ok(statSync(tmp).isDirectory(), 'TMPDIR must be an existing directory');
  const dir = path.join(tmp, sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const RUNTIME = ownedRuntime(SUITE);
const STORE = path.join(RUNTIME, `orders-${process.pid}-${Date.now()}`);
mkdirSync(STORE, { recursive: true });

const ADMIN_KEY = 'synthetic-payment-preview-admin-key-0001';
const GROUP_TOKEN = 'vercel_blob_rw_classroomsynthetic_paymentpreview';
const TEST_KEY = 'sk_test_synthetic_payment_preview_only';
const COUPON = 'synthetic_full_discount_qa';
const NAMESPACE = 'classroomqa';
const NATIVE_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const INVITES = Array.from({ length: 12 }, (_, i) => ({
  token: `SyntheticPaymentPreviewTok${String(i + 1).padStart(9, '0')}`, cohortId: `synthetic_pp_cohort_${i + 1}`,
  familySlotId: `pp_family_${i + 1}`, cohortLabel: 'Synthetic classroom', expiresAt: NATIVE_FUTURE,
}));
process.env.TMPDIR = RUNTIME;
process.env.HSB_ORDER_STORE_DIR = STORE;
process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(STORE, 'recovery');
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
process.env.STRIPE_SECRET_KEY = TEST_KEY;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic_payment_preview_only';
process.env.HSB_ORDER_ADMIN_KEY = ADMIN_KEY;
process.env.GROUP_BOOK_BLOB_READ_WRITE_TOKEN = GROUP_TOKEN;
process.env.GROUP_BOOK_INVITES_JSON = JSON.stringify(INVITES);
process.env.HSB_BLOB_NAMESPACE = NAMESPACE;
const QA_ENV = ['VERCEL_ENV', 'HSB_CLASSROOM_QA_ONLY', 'HSB_CLASSROOM_PAYMENT_QA_ONLY', 'HSB_CLASSROOM_PAYMENT_QA_SCOPE_JSON', 'HSB_CLASSROOM_CHECKOUT_TARGET_JSON', 'HSB_CLASSROOM_TEST_COUPON_ID'];
for (const name of ['VERCEL', 'BLOB_READ_WRITE_TOKEN', 'HSB_PAID_ORDER_OUTBOX_ENABLED', ...QA_ENV]) delete process.env[name];
const logs: string[] = [];
console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

// ---- SYNTHETIC SDK resource fixture (before app imports) -------------------
const sdk = {
  coupons: new Map<string, Obj>(),
  sessions: new Map<string, Obj>(),
  byIdempotency: new Map<string, string>(),
  couponReads: 0, creates: 0, minted: 0, sessionReads: 0, clients: [] as string[],
  /** Accepted by the provider, response lost before the caller sees it. */
  loseCreateResponse: false,
  /** Provider-side override applied to the created Session (native mismatch). */
  tamper: null as null | ((s: Obj) => void),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RealStripe: any = (await import('stripe')).default;
class SyntheticStripe extends RealStripe {
  constructor(...args: unknown[]) {
    super(...args);
    sdk.clients.push(String(args[0]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    self.coupons = {
      retrieve: async (id: string) => {
        sdk.couponReads += 1;
        const coupon = sdk.coupons.get(id);
        if (!coupon) throw new Error('synthetic_no_such_coupon');
        return structuredClone(coupon);
      },
      create: async () => { throw new Error('synthetic_coupon_create_forbidden'); },
      update: async () => { throw new Error('synthetic_coupon_update_forbidden'); },
    };
    self.checkout = {
      sessions: {
        create: async (params: Obj, options: Obj = {}) => {
          // Every SDK create invocation counts, including idempotent replays.
          sdk.creates += 1;
          const key = options.idempotencyKey;
          if (key && sdk.byIdempotency.has(key)) return structuredClone(sdk.sessions.get(sdk.byIdempotency.get(key)!)!);
          sdk.minted += 1;
          const item = params.line_items?.[0];
          const subtotal = (item?.price_data?.unit_amount ?? 0) * (item?.quantity ?? 0);
          const couponId = params.discounts?.[0]?.coupon;
          const coupon = couponId ? sdk.coupons.get(couponId) : undefined;
          if (couponId && !coupon) throw new Error('synthetic_no_such_coupon');
          const discount = !coupon ? 0
            : typeof coupon.percent_off === 'number' ? Math.round(subtotal * coupon.percent_off / 100)
              : Math.min(subtotal, coupon.amount_off ?? 0);
          const id = `cs_test_synthetic_pp_${process.pid}_${sdk.minted}`;
          const total = subtotal - discount;
          const s: Obj = {
            id, object: 'checkout.session', livemode: false, mode: params.mode, status: 'open', payment_status: 'unpaid',
            amount_subtotal: subtotal, amount_total: total, total_details: { amount_discount: discount, amount_shipping: 0, amount_tax: 0 },
            currency: item?.price_data?.currency, client_reference_id: params.client_reference_id, metadata: { ...(params.metadata ?? {}) },
            payment_intent: null, url: `https://checkout.synthetic.invalid/${id}`,
          };
          if (sdk.tamper) sdk.tamper(s);
          sdk.sessions.set(id, structuredClone(s));
          if (key) sdk.byIdempotency.set(key, id);
          if (sdk.loseCreateResponse) throw new Error('synthetic_response_lost');
          return structuredClone(s);
        },
        retrieve: async (id: string) => {
          sdk.sessionReads += 1;
          const s = sdk.sessions.get(id);
          if (!s) throw new Error('synthetic_no_such_session');
          return structuredClone(s);
        },
      },
    };
    self.events = { retrieve: async () => { throw new Error('synthetic_event_read_not_expected'); } };
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });
const blobFake = await import(new URL('./helpers/blob-store-fake.mjs', import.meta.url).href);
mock.module('@vercel/blob', { namedExports: { ...blobFake, BlobStoreNotFoundError: class BlobStoreNotFoundError extends Error {} } });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orders: any = await import('../src/lib/orders.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const route: any = await import('../src/app/api/admin/group-book/checkout/route.ts');

const raw = (id: string) => readFileSync(path.join(STORE, `${id}.json`), 'utf8');
const read = async (id: string) => JSON.parse(JSON.stringify((await orders.readOrderVersioned(id)).order)) as Obj;
const FULL_COUPON = { id: COUPON, object: 'coupon', livemode: false, valid: true, percent_off: 100, amount_off: null, currency: null, duration: 'once', applies_to: undefined, max_redemptions: null, times_redeemed: 0, redeem_by: null };

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
function resetEnv() {
  for (const name of QA_ENV) delete process.env[name];
  process.env.STRIPE_SECRET_KEY = TEST_KEY;
  process.env.HSB_BLOB_NAMESPACE = NAMESPACE;
  sdk.loseCreateResponse = false;
  sdk.tamper = null;
  sdk.coupons.clear();
  sdk.coupons.set(COUPON, structuredClone(FULL_COUPON));
}
function policyFor(o: { orderId: string; binding: Obj }, overrides: Obj = {}): Obj {
  return {
    schemaVersion: 1, enabled: true, orderId: o.orderId, cohortId: o.binding.cohortId, manifestDigest: o.binding.digest,
    manifestExpiresAt: o.binding.expiresAt, orderNamespace: NAMESPACE, couponId: COUPON, ...overrides,
  };
}
/** Armed classroom payment-QA Preview: every value server env, never the request. */
function arm(o: { orderId: string; binding: Obj }, policy: Obj = policyFor(o), extra: Record<string, string | undefined> = {}) {
  setEnv({
    VERCEL_ENV: 'preview', HSB_CLASSROOM_QA_ONLY: 'true', HSB_CLASSROOM_PAYMENT_QA_ONLY: 'true',
    HSB_CLASSROOM_PAYMENT_QA_SCOPE_JSON: JSON.stringify(policy),
    HSB_CLASSROOM_CHECKOUT_TARGET_JSON: JSON.stringify({ schemaVersion: 1, enabled: true, orderId: o.orderId }),
    HSB_CLASSROOM_TEST_COUPON_ID: COUPON, ...extra,
  });
}
async function post(body: string = '{}', headers: Record<string, string> = { 'x-hsb-order-admin-key': ADMIN_KEY }) {
  const res: Response = await route.POST(new Request('http://127.0.0.1/api/admin/group-book/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  }));
  return { status: res.status, body: (await res.json()) as Obj };
}
const snap = () => ({ couponReads: sdk.couponReads, creates: sdk.creates, sessionReads: sdk.sessionReads });

// ---- The ACTUAL global Date, set per scenario and always restored -----------
// Not a production seam: every module keeps reading the same global clock.
const RealDate = Date;
let clockMs: number | null = null;
class ControlledDate extends RealDate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    super(...((args.length ? args : [clockMs ?? RealDate.now()]) as [number]));
  }
  static now(): number {
    return clockMs ?? RealDate.now();
  }
}
async function underClock<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.Date = ControlledDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
    clockMs = null;
  }
}

// ---- Native fixtures (inline copy of the accepted current-contract roster flow)
let inviteIndex = 0;
async function nativeOrder() {
  const invite = INVITES[inviteIndex++];
  assert.ok(invite, 'fresh invite available');
  const release = await import('../src/lib/group-book/release.ts');
  const store = await import('../src/lib/group-book/store.ts');
  const orderHandler = await import('../src/lib/group-book/order-handler.ts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blob: any = await import('@vercel/blob');
  const state = release.groupBookPolicyState();
  assert.equal(state.state, 'adopted', 'native policy adopted');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const current = (state as any).current;
  const photo = { assetId: 'gbp_synthetic1', pathname: store.groupBookPhotoPath(invite, 'gbp_synthetic1', 'jpg'), mime: 'image/jpeg', size: 4, uploadedAt: new Date().toISOString(), storage: 'private' as const };
  await blob.put(photo.pathname, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { access: 'private', token: GROUP_TOKEN, allowOverwrite: false });
  const record = store.buildGroupBookSubmission({
    invite, parentName: 'SYNTHETIC-PARENT', parentEmail: 'synthetic-parent@example.invalid', childFirstName: 'SYNTHETIC-CHILD',
    ageRange: '5-6', characterNotes: 'SYNTHETIC', photos: [photo], policy: { version: current.record.version, digest: current.digest },
  });
  assert.equal(await store.createGroupBookSubmission(record), true, 'create-only roster submission');
  const res: Response = await orderHandler.classroomOrderResponse(new Request('http://127.0.0.1/api/admin/group-book/order', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hsb-order-admin-key': ADMIN_KEY }, body: '{}',
  }), { trustedInput: async () => ({ cohortId: invite.cohortId, bookFormat: 'digital' as const, contactEmail: 'teacher@example.invalid' }) });
  assert.equal(res.status, 201, `native classroom order: ${await res.clone().text()}`);
  const orderId = ((await res.json()) as { orderId: string }).orderId;
  const created = await read(orderId);
  assert.equal(created.paymentStatus, 'pending');
  assert.equal(created.fulfillmentMode, 'manual_hold');
  assert.ok(created.priceCents > 0, 'positive accepted price');
  return { orderId, binding: created.groupBookAssembly as Obj, priceCents: created.priceCents as number };
}

console.log(`SUITE ${SUITE}`);

test('PC01_production_inactive_and_unarmed_never_reach_the_provider', async () => {
  try {
    resetEnv();
    const o = await nativeOrder();
    const rawBefore = raw(o.orderId);
    const variants: [string, Record<string, string | undefined>][] = [
      ['production test key', { VERCEL_ENV: 'production', HSB_CLASSROOM_QA_ONLY: undefined, HSB_CLASSROOM_PAYMENT_QA_ONLY: undefined }],
      ['no deployment env', { VERCEL_ENV: undefined, HSB_CLASSROOM_QA_ONLY: undefined, HSB_CLASSROOM_PAYMENT_QA_ONLY: undefined }],
      ['production with qa flags', { VERCEL_ENV: 'production' }],
      ['preview qa payment flag off', { HSB_CLASSROOM_PAYMENT_QA_ONLY: undefined }],
      ['preview qa payment flag TRUE', { HSB_CLASSROOM_PAYMENT_QA_ONLY: 'TRUE' }],
      ['preview qa only flag off', { HSB_CLASSROOM_QA_ONLY: undefined }],
      ['development', { VERCEL_ENV: 'development' }],
    ];
    for (const [label, extra] of variants) {
      resetEnv();
      arm(o, policyFor(o), extra);
      const s0 = snap();
      const r = await post();
      assert.equal(r.status, 503, `${label}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.url, undefined, `${label}: no checkout url`);
      assert.deepEqual(snap(), s0, `${label}: zero SDK use`);
      assert.equal(raw(o.orderId), rawBefore, `${label}: zero order write`);
    }
    // Real admin auth still first: unauthenticated armed requests are 401 with no SDK use.
    resetEnv();
    arm(o);
    for (const headers of [{}, { 'x-hsb-order-admin-key': `${ADMIN_KEY}x` }, { 'x-hsb-order-admin-key': '' }] as Record<string, string>[]) {
      const s0 = snap();
      const r = await post('{}', headers);
      assert.equal(r.status, 401, JSON.stringify(r.body));
      assert.deepEqual(snap(), s0);
    }
    assert.equal(raw(o.orderId), rawBefore);
    console.log('SUBCASE PC01 production/inactive/unarmed 503 x7 auth 401 x3 zero_sdk');
  } finally {
    resetEnv();
  }
});

test('PC02_strict_policy_key_namespace_and_coupon_refuse_before_any_create', async () => {
  try {
    resetEnv();
    const o = await nativeOrder();
    const other = await nativeOrder();
    const rawBefore = raw(o.orderId);
    const p = policyFor(o);
    const cases: [string, () => void][] = [
      ['missing policy', () => arm(o, p, { HSB_CLASSROOM_PAYMENT_QA_SCOPE_JSON: undefined })],
      ['malformed policy', () => arm(o, p, { HSB_CLASSROOM_PAYMENT_QA_SCOPE_JSON: '{not json' })],
      ['extra policy key', () => arm(o, { ...p, store: 'other' })],
      ['missing policy key', () => { const q = { ...p }; delete q.couponId; arm(o, q); }],
      ['schema version 2', () => arm(o, { ...p, schemaVersion: 2 })],
      ['disabled', () => arm(o, { ...p, enabled: false })],
      ['string enabled', () => arm(o, { ...p, enabled: 'true' })],
      ['policy names other order', () => arm(o, { ...p, orderId: other.orderId })],
      ['policy wrong cohort', () => arm(o, { ...p, cohortId: other.binding.cohortId })],
      ['policy wrong digest', () => arm(o, { ...p, manifestDigest: other.binding.digest })],
      ['policy wrong expiry', () => arm(o, { ...p, manifestExpiresAt: new Date(Date.now() + 99_000_000).toISOString() })],
      ['policy wrong namespace', () => arm(o, { ...p, orderNamespace: 'preview' })],
      ['actual namespace differs', () => arm(o, p, { HSB_BLOB_NAMESPACE: 'otherqa' })],
      ['policy coupon differs from server coupon', () => arm(o, { ...p, couponId: 'synthetic_other_coupon' })],
      ['target names other order', () => arm(o, p, { HSB_CLASSROOM_CHECKOUT_TARGET_JSON: JSON.stringify({ schemaVersion: 1, enabled: true, orderId: other.orderId }) })],
      ['live key', () => arm(o, p, { STRIPE_SECRET_KEY: 'sk_live_synthetic_payment_preview_only' })],
      ['restricted key', () => arm(o, p, { STRIPE_SECRET_KEY: 'rk_test_synthetic_payment_preview_only' })],
      ['malformed test key', () => arm(o, p, { STRIPE_SECRET_KEY: 'sk_test_' })],
      ['coupon absent', () => { arm(o); sdk.coupons.clear(); }],
      ['coupon 50 percent', () => { arm(o); sdk.coupons.get(COUPON)!.percent_off = 50; }],
      ['coupon fixed amount', () => { arm(o); Object.assign(sdk.coupons.get(COUPON)!, { percent_off: null, amount_off: o.priceCents, currency: 'usd' }); }],
      ['coupon product restricted', () => { arm(o); sdk.coupons.get(COUPON)!.applies_to = { products: ['prod_synthetic'] }; }],
      ['coupon invalid', () => { arm(o); sdk.coupons.get(COUPON)!.valid = false; }],
      ['coupon livemode', () => { arm(o); sdk.coupons.get(COUPON)!.livemode = true; }],
      ['coupon exhausted', () => { arm(o); Object.assign(sdk.coupons.get(COUPON)!, { max_redemptions: 1, times_redeemed: 1 }); }],
      ['coupon identity differs', () => { arm(o); sdk.coupons.get(COUPON)!.id = 'synthetic_other_coupon'; }],
    ];
    for (const [label, setup] of cases) {
      resetEnv();
      setup();
      const creates = sdk.creates;
      const r = await post();
      assert.ok(r.status >= 400, `${label}: refused ${JSON.stringify(r.body)}`);
      assert.equal(r.body.url, undefined, `${label}: no checkout url`);
      assert.equal(sdk.creates, creates, `${label}: zero Session create`);
      assert.equal(raw(o.orderId), rawBefore, `${label}: zero order write`);
    }
    console.log(`SUBCASE PC02 refusals=${cases.length} zero_create zero_write`);
  } finally {
    resetEnv();
  }
});

test('PC03_valid_zero_create_bind_replay_and_body_smuggling_has_no_authority', async () => {
  try {
    resetEnv();
    const o = await nativeOrder();
    const decoy = await nativeOrder();
    const decoyBefore = raw(decoy.orderId);
    arm(o);
    const s0 = snap();
    // The body names a different order, price, coupon, namespace and policy: none of it is read.
    const smuggled = JSON.stringify({
      orderId: decoy.orderId, priceCents: 1, couponId: 'synthetic_other_coupon', orderNamespace: 'production',
      policy: policyFor(decoy), target: { schemaVersion: 1, enabled: true, orderId: decoy.orderId }, livemode: true,
    });
    const r = await post(smuggled);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, 'created');
    assert.equal(r.body.orderId, o.orderId, 'server-owned target, not the body');
    const delta = Object.fromEntries(Object.entries(snap()).map(([k, v]) => [k, v - s0[k as keyof typeof s0]]));
    assert.equal(delta.creates, 1, 'exactly one native create');
    assert.ok(delta.couponReads >= 1, 'coupon retrieved before create');
    assert.ok(delta.sessionReads >= 1, 'created Session re-read natively');
    assert.ok(sdk.clients.every((k) => k.startsWith('sk_test_')), 'only TEST-key SDK clients');
    const order = await read(o.orderId);
    const session = sdk.sessions.get(order.stripeSessionId)!;
    assert.ok(session, 'bound to the native Session');
    assert.equal(r.body.url, session.url);
    assert.deepEqual(
      { total: session.amount_total, subtotal: session.amount_subtotal, discount: session.total_details.amount_discount, currency: session.currency, pi: session.payment_intent, livemode: session.livemode },
      { total: 0, subtotal: o.priceCents, discount: o.priceCents, currency: 'usd', pi: null, livemode: false },
    );
    assert.deepEqual(
      { kind: session.metadata.kind, orderId: session.metadata.orderId, cohortId: session.metadata.cohortId, manifestDigest: session.metadata.manifestDigest, manifestExpiresAt: session.metadata.manifestExpiresAt, ref: session.client_reference_id },
      { kind: 'hsb_classroom_zero_total_test', orderId: o.orderId, cohortId: o.binding.cohortId, manifestDigest: o.binding.digest, manifestExpiresAt: o.binding.expiresAt, ref: o.orderId },
    );
    assert.equal(order.paymentStatus, 'pending');
    assert.equal(order.fulfillmentMode, 'manual_hold');
    assert.equal(raw(decoy.orderId), decoyBefore, 'decoy order untouched');
    // Replay: the bound Session only, no second create.
    const bound = raw(o.orderId);
    const creates = sdk.creates;
    const again = await post(smuggled);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.state, 'replayed');
    assert.equal(again.body.url, session.url);
    assert.equal(sdk.creates, creates, 'replay: no second create');
    assert.equal(raw(o.orderId), bound, 'replay: no write');
    assert.doesNotMatch(logs.join('\n'), /fulfillment kickoff|scheduling fulfillment|purchase analytics|confirmation email/i);
    console.log('SUBCASE PC03 created=1 replayed coupon_read_before_create smuggled_body_ignored');
  } finally {
    resetEnv();
  }
});

test('PC04_native_positive_or_mismatched_session_is_held_and_ambiguous_never_recreates', async () => {
  try {
    // Native create returns a positive total (provider ignored the discount): no URL, held, no recreate.
    resetEnv();
    const m = await nativeOrder();
    arm(m);
    sdk.tamper = (s) => { s.amount_total = s.amount_subtotal; s.total_details.amount_discount = 0; };
    const c1 = sdk.creates;
    const r = await post();
    assert.ok(r.status >= 400, JSON.stringify(r.body));
    assert.equal(r.body.url, undefined, 'positive Session URL never returned');
    assert.equal(sdk.creates, c1 + 1);
    const held = await read(m.orderId);
    assert.ok(held.classroomCheckoutDispatch, 'dispatch reservation retained');
    assert.ok(!held.stripeSessionId, 'positive Session never bound');
    sdk.tamper = null;
    const heldRaw = raw(m.orderId);
    const again = await post();
    assert.equal(again.status, 409, JSON.stringify(again.body));
    assert.equal(again.body.error, 'classroom_checkout_held');
    assert.equal(sdk.creates, c1 + 1, 'held: no extra create');
    assert.equal(raw(m.orderId), heldRaw);

    // Native discount mismatch alone (total zero, discount != subtotal) is also held.
    resetEnv();
    const d = await nativeOrder();
    arm(d);
    sdk.tamper = (s) => { s.total_details.amount_discount = 0; };
    const c2 = sdk.creates;
    const rd = await post();
    assert.ok(rd.status >= 400, JSON.stringify(rd.body));
    assert.equal(rd.body.url, undefined);
    assert.ok(!(await read(d.orderId)).stripeSessionId, 'mismatched Session never bound');
    assert.equal(sdk.creates, c2 + 1);

    // Ambiguous: the provider accepted the create, the response was lost.
    resetEnv();
    const a = await nativeOrder();
    arm(a);
    sdk.loseCreateResponse = true;
    const c3 = sdk.creates;
    const lost = await post();
    sdk.loseCreateResponse = false;
    assert.equal(lost.status, 502, JSON.stringify(lost.body));
    assert.equal(lost.body.error, 'classroom_provider_ambiguous_held');
    assert.equal(sdk.creates, c3 + 1);
    const ambiguousRaw = raw(a.orderId);
    const retry = await post();
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, 'classroom_checkout_held');
    assert.equal(sdk.creates, c3 + 1, 'ambiguous: no extra create');
    assert.equal(raw(a.orderId), ambiguousRaw);
    console.log('SUBCASE PC04 positive=held discount_mismatch=held ambiguous=held no_extra_create');
  } finally {
    resetEnv();
  }
});

test('PC05_expired_or_nonfinite_clock_refuses_before_any_coupon_or_session_transport', async () => {
  try {
    resetEnv();
    const o = await nativeOrder();
    const rawBefore = raw(o.orderId);
    const expires = Date.parse(o.binding.expiresAt);
    arm(o);
    const clocks = [expires, expires + 1000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    await underClock(async () => {
      for (const now of clocks) {
        clockMs = now;
        const s0 = snap();
        const clients = sdk.clients.length;
        // Actual admin checkout, authenticated: the expired scope supplies no target and no provider.
        const r = await post();
        assert.deepEqual(r, { status: 503, body: { error: 'classroom_checkout_unavailable' } }, `clock ${now}: refused`);
        assert.deepEqual(snap(), s0, `clock ${now}: zero coupon read, Session create or retrieve`);
        assert.equal(sdk.clients.length, clients, `clock ${now}: no SDK client`);
        assert.equal(raw(o.orderId), rawBefore, `clock ${now}: zero order write`);
        // Real admin auth still answers first.
        const unauthed = await post('{}', {});
        assert.equal(unauthed.status, 401, `clock ${now}: auth first`);
        assert.deepEqual(snap(), s0);
        assert.equal(orders.readClassroomPaymentQaPolicy(), null, `clock ${now}: policy refused`);
      }
      clockMs = expires - 1;
      assert.notEqual(orders.readClassroomPaymentQaPolicy(), null, 'one millisecond before expiry: admitted');
    });
    // Canonical ISO validation is unchanged under the current clock.
    for (const expiry of [null, '2026-02-30T00:00:00.000Z', '2026-10-29', 'not-a-date', o.binding.expiresAt.replace(/Z$/, '+00:00')]) {
      arm(o, policyFor(o, { manifestExpiresAt: expiry }));
      assert.equal(orders.readClassroomPaymentQaPolicy(), null, `noncanonical expiry ${String(expiry)}`);
    }
    // Current clock: the same order still creates its zero-total Session exactly once.
    resetEnv();
    arm(o);
    const s0 = snap();
    const created = await post();
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.state, 'created');
    assert.equal(sdk.creates - s0.creates, 1, 'exactly one native create');
    assert.ok(sdk.couponReads - s0.couponReads >= 1, 'coupon read before create');
    console.log(`SUBCASE PC05 expired_or_nonfinite=${clocks.length} 503 zero_coupon zero_create auth_first canonical_iso_retained valid=created`);
  } finally {
    resetEnv();
  }
});
