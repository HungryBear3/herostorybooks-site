// SYNTHETIC classroom payment-Preview ISOLATION suite. Never real payment
// evidence; no provider transport.
// - The REAL root middleware.ts (the only mounted middleware) runs
//   through an in-thread resolve hook for the `@/` alias and `next/server`.
// - The 'stripe' module is replaced before any application import by a
//   subclass of the REAL SDK whose Event/Session/coupon resources read
//   in-memory SYNTHETIC fact maps. Real offline generateTestHeaderString signs;
//   the ACTUAL webhook route's inherited constructEvent verifies; the ACTUAL
//   fixed producer builds its own client and retrieves Event then Session.
// - '@vercel/blob' maps to the existing in-memory store fake; REAL roster,
//   manifest, native admin auth and the ACTUAL admin checkout route run.
// - Orders and payment recovery use the REAL local filesystem adapters.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUITE = 'classroom-payment-preview-isolation';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const WEBHOOK_SECRET = 'whsec_synthetic_payment_isolation_only';
const ADMIN_KEY = 'synthetic-payment-isolation-admin-key-0001';
const GROUP_TOKEN = 'vercel_blob_rw_classroomsynthetic_paymentisolation';
const TEST_KEY = 'sk_test_synthetic_payment_isolation_only';
const COUPON = 'synthetic_full_discount_qa';
const NAMESPACE = 'classroomqa';
const KIND = 'hsb_classroom_zero_total_test';
// The Preview read lane admits exactly `ord_` plus 16 lowercase hex. All zeros and
// assembled here, so this explicitly fake id commits no production-shaped literal.
const SYNTHETIC_PREVIEW_ORDER_ID = `ord_${'0'.repeat(16)}`;
const NATIVE_FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const INVITES = Array.from({ length: 12 }, (_, i) => ({
  token: `SyntheticPaymentIsolationTok${String(i + 1).padStart(9, '0')}`, cohortId: `synthetic_pi_cohort_${i + 1}`,
  familySlotId: `pi_family_${i + 1}`, cohortLabel: 'Synthetic classroom', expiresAt: NATIVE_FUTURE,
}));
process.env.TMPDIR = RUNTIME;
process.env.HSB_ORDER_STORE_DIR = STORE;
process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(STORE, 'recovery');
process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
process.env.STRIPE_SECRET_KEY = TEST_KEY;
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
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

// ---- Middleware resolution: `@/` alias and `next/server` only --------------
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return nextResolve('next/server.js', context);
    if (specifier.startsWith('@/')) {
      const base = path.resolve(ROOT, 'src', specifier.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    // Extensionless relative imports (the mount's `../middleware`) resolve as the bundler does.
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.startsWith('file:')) {
      const base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
      for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

// ---- SYNTHETIC SDK resource fixture (before app imports) -------------------
const sdk = {
  events: new Map<string, Obj>(),
  sessions: new Map<string, Obj>(),
  coupons: new Map<string, Obj>([[COUPON, { id: COUPON, object: 'coupon', livemode: false, valid: true, percent_off: 100, amount_off: null, max_redemptions: null, times_redeemed: 0, redeem_by: null }]]),
  byIdempotency: new Map<string, string>(),
  eventReads: 0, sessionReads: 0, creates: 0, minted: 0, clients: [] as string[],
  /** One-shot observer inside the native Session read (facts unchanged). */
  onSessionRead: null as null | (() => void),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RealStripe: any = (await import('stripe')).default;
class SyntheticStripe extends RealStripe {
  constructor(...args: unknown[]) {
    super(...args);
    sdk.clients.push(String(args[0]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const self = this as any;
    self.events = {
      retrieve: async (id: string) => {
        sdk.eventReads += 1;
        const event = sdk.events.get(id);
        if (!event) throw new Error('synthetic_no_such_event');
        return structuredClone(event);
      },
    };
    self.coupons = {
      retrieve: async (id: string) => {
        const coupon = sdk.coupons.get(id);
        if (!coupon) throw new Error('synthetic_no_such_coupon');
        return structuredClone(coupon);
      },
    };
    self.checkout = {
      sessions: {
        create: async (params: Obj, options: Obj = {}) => {
          // Every SDK create invocation counts, including idempotent replays.
          sdk.creates += 1;
          const key = options.idempotencyKey;
          if (key && sdk.byIdempotency.has(key)) return structuredClone(sdk.sessions.get(sdk.byIdempotency.get(key)!)!);
          sdk.minted += 1;
          const item = params.line_items[0];
          const subtotal = item.price_data.unit_amount * item.quantity;
          const coupon = sdk.coupons.get(params.discounts?.[0]?.coupon);
          if (!coupon) throw new Error('synthetic_no_such_coupon');
          const discount = Math.round(subtotal * coupon.percent_off / 100);
          const id = `cs_test_synthetic_pi_${process.pid}_${sdk.minted}`;
          const s = {
            id, object: 'checkout.session', livemode: false, mode: params.mode, status: 'open', payment_status: 'unpaid',
            amount_subtotal: subtotal, amount_total: subtotal - discount, total_details: { amount_discount: discount, amount_shipping: 0, amount_tax: 0 },
            currency: item.price_data.currency, client_reference_id: params.client_reference_id, metadata: { ...params.metadata },
            payment_intent: null, url: `https://checkout.synthetic.invalid/${id}`,
          };
          sdk.sessions.set(id, structuredClone(s));
          if (key) sdk.byIdempotency.set(key, id);
          return structuredClone(s);
        },
        retrieve: async (id: string) => {
          sdk.sessionReads += 1;
          const s = sdk.sessions.get(id);
          if (!s) throw new Error('synthetic_no_such_session');
          const hook = sdk.onSessionRead;
          sdk.onSessionRead = null;
          hook?.();
          return structuredClone(s);
        },
      },
    };
  }
}
mock.module('stripe', { defaultExport: SyntheticStripe });
const blobFake = await import(new URL('./helpers/blob-store-fake.mjs', import.meta.url).href);
/** Observer awaited inside the existing store's `get`, after the real read; never alters bytes. */
let blobGetHook: null | ((pathname: string) => Promise<void>) = null;
mock.module('@vercel/blob', {
  namedExports: {
    ...blobFake,
    get: async (pathname: string, options?: Obj) => {
      const result = await blobFake.get(pathname, options);
      if (blobGetHook) await blobGetHook(pathname);
      return result;
    },
    BlobStoreNotFoundError: class BlobStoreNotFoundError extends Error {},
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orders: any = await import('../src/lib/orders.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const webhook: any = await import('../src/app/api/webhooks/stripe/route.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const checkoutRoute: any = await import('../src/app/api/admin/group-book/checkout/route.ts');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rootMiddleware: any = await import(pathToFileURL(path.join(ROOT, 'middleware.ts')).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mountMiddleware: any = await import(pathToFileURL(path.join(ROOT, 'middleware.ts')).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { NextRequest }: any = await import('next/server.js');

const raw = (id: string) => readFileSync(path.join(STORE, `${id}.json`), 'utf8');
const read = async (id: string) => JSON.parse(JSON.stringify((await orders.readOrderVersioned(id)).order)) as Obj;
/** Every durable byte under the owned order + recovery store. */
function durable(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else out[path.relative(STORE, full)] = readFileSync(full, 'utf8');
    }
  };
  walk(STORE);
  return out;
}
const blobPuts = () => blobFake.journal.filter((e: Obj) => e.op === 'put').length;
const EFFECT_LOG = /fulfillment kickoff|scheduling fulfillment|fulfillment backfill|purchase analytics|confirmation email|recovery recorded|CRITICAL/i;

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
function resetEnv() {
  for (const name of QA_ENV) delete process.env[name];
  process.env.STRIPE_SECRET_KEY = TEST_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.HSB_BLOB_NAMESPACE = NAMESPACE;
}
type Native = { orderId: string; binding: Obj };
const policyFor = (o: Native, overrides: Obj = {}) => ({
  schemaVersion: 1, enabled: true, orderId: o.orderId, cohortId: o.binding.cohortId, manifestDigest: o.binding.digest,
  manifestExpiresAt: o.binding.expiresAt, orderNamespace: NAMESPACE, couponId: COUPON, ...overrides,
});
function arm(o: Native, policy: Obj = policyFor(o), extra: Record<string, string | undefined> = {}) {
  setEnv({
    VERCEL_ENV: 'preview', HSB_CLASSROOM_QA_ONLY: 'true', HSB_CLASSROOM_PAYMENT_QA_ONLY: 'true',
    HSB_CLASSROOM_PAYMENT_QA_SCOPE_JSON: JSON.stringify(policy),
    HSB_CLASSROOM_CHECKOUT_TARGET_JSON: JSON.stringify({ schemaVersion: 1, enabled: true, orderId: o.orderId }),
    HSB_CLASSROOM_TEST_COUPON_ID: COUPON, ...extra,
  });
}

// ---- Native fixtures (inline copy of the accepted current-contract roster flow)
let inviteIndex = 0;
async function nativeOrder(): Promise<Native> {
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
  assert.equal(created.classroomFinancialReceipt, undefined, 'no seeded receipt');
  return { orderId, binding: created.groupBookAssembly as Obj };
}
/** Native order bound through the ACTUAL admin checkout route under its own armed policy. */
async function nativeBound(): Promise<Native & { sessionId: string }> {
  const o = await nativeOrder();
  arm(o);
  const res: Response = await checkoutRoute.POST(new Request('http://127.0.0.1/api/admin/group-book/checkout', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hsb-order-admin-key': ADMIN_KEY }, body: '{}',
  }));
  const body = await res.json() as Obj;
  assert.equal(res.status, 200, `native checkout ${JSON.stringify(body)}`);
  assert.equal(body.state, 'created');
  resetEnv();
  const order = await read(o.orderId);
  const sessionId = order.stripeSessionId as string;
  Object.assign(sdk.sessions.get(sessionId)!, { status: 'complete', payment_status: 'no_payment_required' });
  return { ...o, sessionId };
}
let eventSeq = 0;
function publishEvent(sessionId: string, orderId: string, extra: Obj = {}): string {
  eventSeq += 1;
  const id = `evt_synthetic_pi_${process.pid}_${eventSeq}`;
  sdk.events.set(id, {
    id, object: 'event', type: 'checkout.session.completed', livemode: false, created: 1_777_200_000 + eventSeq, api_version: '2024-06-20',
    data: { object: { id: sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId } } }, ...extra,
  });
  return id;
}
function signedRequest(payload: string, url = 'http://127.0.0.1/api/webhooks/stripe', secret = WEBHOOK_SECRET) {
  const sig = new RealStripe('sk_test_synthetic_signer').webhooks.generateTestHeaderString({ payload, secret });
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
}
async function deliverBody(body: Obj, secret = WEBHOOK_SECRET) {
  const res: Response = await webhook.POST(signedRequest(JSON.stringify(body), undefined, secret));
  return { status: res.status, body: (await res.json()) as Obj };
}
const deliver = (eventId: string) => deliverBody(sdk.events.get(eventId)!);
function through(pathname: string, method = 'POST') {
  const res = mountMiddleware.middleware(new NextRequest(new URL(pathname, 'https://preview.synthetic.invalid'), { method }));
  return { status: res.status, next: res.headers.get('x-middleware-next') === '1' };
}

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
const QA_UNAVAILABLE = { status: 503, body: { error: 'classroom_payment_qa_unavailable' } };
const PRODUCER_EXPIRED = { status: 409, body: { received: true, classroomSettlement: 'refused', reason: 'payment_qa_unavailable' } };
const manifestOf = (o: Native) => (pathname: string) => pathname.includes(`/assembly-manifests/${o.binding.cohortId}/`);

console.log(`SUITE ${SUITE}`);

test('PI01_mounted_gate_admits_exactly_two_post_payment_lanes_only_when_armed', async () => {
  try {
    resetEnv();
    const o = await nativeOrder();
    const lanes = ['/api/admin/group-book/checkout', '/api/webhooks/stripe'];
    arm(o);
    for (const lane of lanes) {
      assert.deepEqual(through(lane, 'POST'), { status: 200, next: true }, `armed POST ${lane}`);
      // Root gate agrees (mount delegates unchanged).
      const r = rootMiddleware.middleware(new NextRequest(new URL(lane, 'https://preview.synthetic.invalid'), { method: 'POST' }));
      assert.notEqual(r.status, 503, `root armed POST ${lane}`);
      for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal(through(lane, method).status, 503, `armed ${method} ${lane}`);
    }
    // Next erases dot segments before middleware; a dot alias IS the canonical path (handler auth/signature still apply).
    assert.deepEqual(through('/api/x/../webhooks/stripe', 'POST'), { status: 200, next: true });
    const aliases = [
      '/api/webhooks/stripe/', '/API/webhooks/stripe', '/api/Webhooks/stripe', '/api//webhooks/stripe', '/api/webhooks/stripe.json',
      '/api/webhooks/stripe%2F', '/api/webhooks/%73tripe', '/api/webhooks/stripe/extra', '/api/webhooks/stripe-connect',
      '/api/webhooks/lulu', '/api/admin/group-book/checkout/', '/api/admin/group-book/checkout.png', '/api/admin/group-book/Checkout',
      '/api/admin/group-book/checkout%00', '/group-book/checkout', '/api/order', '/api/checkout', '/api/recovery', '/api/cron/fulfillment-sweep',
      '/api/admin/orders', '/api/family-review/upload', `/api/order/${SYNTHETIC_PREVIEW_ORDER_ID}/review`, '/api/print-upgrade', '/api/otp',
    ];
    for (const p of aliases) assert.equal(through(p, 'POST').status, 503, `armed alias refused: ${p}`);
    // Existing unpaid lanes unchanged.
    assert.deepEqual(through('/api/admin/group-book/order', 'POST'), { status: 200, next: true });
    assert.equal(through(`/api/order/${SYNTHETIC_PREVIEW_ORDER_ID}`, 'GET').next, true);
    assert.equal(through(`/api/order/${SYNTHETIC_PREVIEW_ORDER_ID}`, 'POST').status, 503);
    // Payment flag off / malformed: the two payment lanes stay refused.
    for (const flag of [undefined, 'TRUE', '1', 'true ', 'yes']) {
      arm(o, policyFor(o), { HSB_CLASSROOM_PAYMENT_QA_ONLY: flag });
      for (const lane of lanes) assert.equal(through(lane, 'POST').status, 503, `flag ${String(flag)}: ${lane}`);
      assert.deepEqual(through('/api/admin/group-book/order', 'POST'), { status: 200, next: true });
    }
    // Outside the Preview pair the mount stays a bare next(), payment flag or not.
    for (const extra of [{ VERCEL_ENV: 'production' }, { VERCEL_ENV: undefined }, { HSB_CLASSROOM_QA_ONLY: undefined }]) {
      arm(o, policyFor(o), extra);
      for (const lane of lanes) assert.deepEqual(through(lane, 'POST'), { status: 200, next: true });
    }
    console.log(`SUBCASE PI01 armed_lanes=2 methods_refused=12 aliases_refused=${aliases.length} flag_off_refused=5 inactive_next=3`);
  } finally {
    resetEnv();
  }
});

test('PI02_armed_signed_classroom_event_reaches_fixed_producer_receipt_held', async () => {
  try {
    resetEnv();
    const b = await nativeBound();
    const e = publishEvent(b.sessionId, b.orderId);
    arm(b);
    assert.deepEqual(through('/api/webhooks/stripe', 'POST'), { status: 200, next: true });
    const r0 = { e: sdk.eventReads, s: sdk.sessionReads };
    const r = await deliver(e);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.classroomSettlement, 'receipt_recorded_held');
    assert.deepEqual({ e: sdk.eventReads - r0.e, s: sdk.sessionReads - r0.s }, { e: 1, s: 1 }, 'fixed producer fetched Event then Session');
    const o = await read(b.orderId);
    assert.equal(o.classroomFinancialReceipt.providerEventId, e);
    assert.equal(o.classroomFinancialReceipt.amountTotalCents, 0);
    assert.equal(o.classroomFinancialReceipt.discountAmountCents, o.classroomFinancialReceipt.amountSubtotalCents);
    assert.equal(o.fulfillmentMode, 'manual_hold');
    assert.equal(orders.isClassroomReleaseHeld(o), true);
    const after = raw(b.orderId);
    const replay = await deliver(e);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.classroomSettlement, 'receipt_replay_held');
    assert.equal(raw(b.orderId), after, 'replay writes nothing');
    assert.ok(sdk.clients.every((k) => k.startsWith('sk_test_')), 'TEST-key clients only');
    assert.doesNotMatch(logs.join('\n'), EFFECT_LOG);
    console.log('SUBCASE PI02 receipt_recorded_held replay_held reads=event+session');
  } finally {
    resetEnv();
  }
});

test('PI03_signed_retail_and_out_of_scope_corpus_has_zero_effects_when_armed_or_unarmed', async () => {
  try {
    resetEnv();
    const b = await nativeBound();
    const other = await nativeBound();
    // Unrelated retail order with a durable Session binding.
    const retail = orders.createOrderRecord({ childName: 'SYNTHETIC-RETAIL', bookFormat: 'digital', email: 'retail@example.invalid' }, { id: 'ord_synthetic_retail_bound', now: new Date().toISOString() });
    await orders.persistOrder({ ...retail, stripeSessionId: 'cs_test_synthetic_retail_bound' });
    const valid = publishEvent(b.sessionId, b.orderId);
    // Body smuggling: the signed body names the policy order; the NATIVE Event points at the other classroom Session.
    const smuggledId = publishEvent(other.sessionId, other.orderId);
    const smuggledBody = { ...structuredClone(sdk.events.get(smuggledId)!), data: { object: { id: b.sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId: b.orderId, cohortId: b.binding.cohortId, manifestDigest: b.binding.digest, manifestExpiresAt: b.binding.expiresAt } } } };
    const session = (id: string, metadata: Obj | null, extra: Obj = {}) => ({ id, object: 'checkout.session', livemode: false, mode: 'payment', status: 'complete', payment_status: 'paid', amount_subtotal: 2900, amount_total: 2900, currency: 'usd', client_reference_id: metadata?.orderId ?? null, metadata, payment_intent: 'pi_synthetic', ...extra });
    const ev = (type: string, object: Obj, extra: Obj = {}) => { eventSeq += 1; return { id: `evt_synthetic_pi_corpus_${eventSeq}`, object: 'event', type, livemode: false, created: 1_777_300_000 + eventSeq, data: { object }, ...extra }; };
    const corpus: [string, Obj][] = [
      ['retail completion binding mismatch', ev('checkout.session.completed', session('cs_test_synthetic_retail_other', { orderId: retail.id }))],
      ['retail completion missing metadata', ev('checkout.session.completed', session('cs_test_synthetic_retail_nometa', null))],
      ['retail completion unknown order', ev('checkout.session.completed', session('cs_test_synthetic_retail_unknown', { orderId: 'ord_synthetic_retail_unknown' }))],
      ['retail replay of bound session', ev('checkout.session.completed', session('cs_test_synthetic_retail_bound', { orderId: retail.id }, { amount_total: 1 }))],
      ['refund', ev('charge.refunded', { id: 'ch_synthetic', object: 'charge', payment_intent: 'pi_synthetic', amount_refunded: 2900, metadata: { orderId: retail.id } })],
      ['dispute', ev('charge.dispute.created', { id: 'dp_synthetic', object: 'dispute', charge: 'ch_synthetic', payment_intent: 'pi_synthetic', metadata: {} })],
      ['async failure', ev('checkout.session.async_payment_failed', session('cs_test_synthetic_retail_async', { orderId: retail.id }))],
      ['upgrade expiry', ev('checkout.session.expired', session('cs_test_synthetic_upgrade_exp', { kind: 'print_upgrade_at_cost', orderId: retail.id }))],
      ['print upgrade completion', ev('checkout.session.completed', session('cs_test_synthetic_upgrade', { kind: 'print_upgrade', orderId: retail.id, targetFormat: 'softcover' }))],
      ['unknown type', ev('customer.created', { id: 'cus_synthetic', object: 'customer' })],
      ['classroom kind wrong type', ev('checkout.session.expired', { id: b.sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId: b.orderId } })],
      ['classroom wrong order', ev('checkout.session.completed', { id: other.sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId: other.orderId } })],
      ['classroom body wrong cohort', ev('checkout.session.completed', { id: b.sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId: b.orderId, cohortId: other.binding.cohortId } })],
      ['classroom live', ev('checkout.session.completed', { id: b.sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId: b.orderId } }, { livemode: true })],
      ['classroom connect', ev('checkout.session.completed', { id: b.sessionId, object: 'checkout.session', metadata: { kind: KIND, orderId: b.orderId } }, { account: 'acct_synthetic' })],
      ['native event differs from signed body', smuggledBody],
    ];
    const run = async (label: string) => {
      for (const [name, body] of corpus) {
        const before = durable();
        const puts = blobPuts();
        const logMark = logs.length;
        const r = await deliverBody(body);
        assert.ok(r.status >= 400 || r.body.classroomSettlement === 'refused' || r.body.classroomPaymentQa === 'refused', `${label} ${name}: refused ${r.status} ${JSON.stringify(r.body)}`);
        assert.notEqual(r.body.classroomSettlement, 'receipt_recorded_held', `${label} ${name}: no receipt`);
        assert.deepEqual(durable(), before, `${label} ${name}: zero durable change`);
        assert.equal(blobPuts(), puts, `${label} ${name}: zero blob writes`);
        assert.doesNotMatch(logs.slice(logMark).join('\n'), EFFECT_LOG, `${label} ${name}: no scheduling/recovery`);
      }
    };
    arm(b);
    await run('armed');
    // Invalid signature: still 400, no effects.
    const before = durable();
    const bad = await deliverBody(sdk.events.get(valid)!, 'whsec_synthetic_wrong_secret');
    assert.equal(bad.status, 400);
    assert.deepEqual(durable(), before);
    // Unarmed classroom-QA Preview: even the valid classroom event is refused, and so is the retail corpus.
    // (Production is NOT classroom QA: its unchanged retail behaviour is pinned in PI04.)
    for (const extra of [{ HSB_CLASSROOM_PAYMENT_QA_ONLY: undefined }, { HSB_CLASSROOM_PAYMENT_QA_SCOPE_JSON: '{"schemaVersion":1}' }, { STRIPE_SECRET_KEY: 'sk_live_synthetic_isolation_only' }]) {
      arm(b, policyFor(b), extra);
      await run(`unarmed ${JSON.stringify(extra)}`);
      const s = durable();
      const r = await deliver(valid);
      assert.ok(r.status >= 400, `unarmed valid refused ${JSON.stringify(r.body)}`);
      assert.deepEqual(durable(), s);
    }
    // Policy names another order, cohort or namespace: the valid native event is refused, zero writes.
    for (const policy of [policyFor(b, { orderId: other.orderId }), policyFor(b, { cohortId: other.binding.cohortId }), policyFor(b, { orderNamespace: 'otherqa' })]) {
      // Reset first: the unarmed loop above left a live key in the environment.
      resetEnv();
      arm(b, policy);
      const s = durable();
      const r = await deliver(valid);
      assert.ok(r.status >= 400, `out-of-policy refused ${JSON.stringify(r.body)}`);
      assert.deepEqual(durable(), s);
    }
    // Native wrong context: the signed body passes the preliminary screen, the FIXED
    // producer fetches Event + Session, and the fetched Session's cohort/manifest differ.
    resetEnv();
    arm(b);
    const nativeSession = sdk.sessions.get(b.sessionId)!;
    const pristine = structuredClone(nativeSession.metadata);
    const fetchedCases: [string, Obj][] = [
      ['native cohort differs', { cohortId: other.binding.cohortId }],
      ['native manifest digest differs', { manifestDigest: other.binding.digest }],
      ['native manifest expiry differs', { manifestExpiresAt: new Date(Date.parse(b.binding.expiresAt) + 1000).toISOString() }],
    ];
    for (const [name, change] of fetchedCases) {
      nativeSession.metadata = { ...pristine, ...change };
      const s = durable();
      const reads = { e: sdk.eventReads, s: sdk.sessionReads };
      const r = await deliver(valid);
      nativeSession.metadata = structuredClone(pristine);
      assert.ok(r.status >= 400, `${name}: refused ${JSON.stringify(r.body)}`);
      assert.deepEqual({ e: sdk.eventReads - reads.e, s: sdk.sessionReads - reads.s }, { e: 1, s: 1 }, `${name}: fixed producer fetched Event + Session`);
      assert.deepEqual(durable(), s, `${name}: zero durable change`);
    }
    // The smuggled body likewise reached the native fetch, which then refused.
    {
      const s = durable();
      const reads = { e: sdk.eventReads, s: sdk.sessionReads };
      const r = await deliverBody(smuggledBody);
      assert.ok(r.status >= 400, JSON.stringify(r.body));
      assert.deepEqual({ e: sdk.eventReads - reads.e, s: sdk.sessionReads - reads.s }, { e: 1, s: 1 }, 'smuggled body: native Event + Session fetched');
      assert.deepEqual(durable(), s);
    }
    // Source proof of the terminal branch (complements the durable snapshots): the QA
    // function is the first statement of POST and names no retail/scheduling seam.
    const routeSource = readFileSync(path.join(ROOT, 'src/app/api/webhooks/stripe/route.ts'), 'utf8');
    const postBody = routeSource.slice(routeSource.indexOf('export async function POST(request: Request) {'));
    assert.match(postBody, /^export async function POST\(request: Request\) \{\n  if \(isClassroomQaDeployment\(\)\) return await classroomPaymentQaWebhook\(request\);\n/);
    const qaStart = routeSource.indexOf('async function classroomPaymentQaWebhook(');
    assert.ok(qaStart > 0, 'terminal QA branch present');
    const qaBody = routeSource.slice(qaStart, routeSource.indexOf('\n}\n', qaStart));
    assert.doesNotMatch(qaBody, /schedule|processStripePaymentTerminalEvent|recordUnmatched|recordPaymentSettlementConflict|settleOrderPayment|updateOrderPayment|PrintUpgrade|recordShadow|getOrder|after\(/);
    assert.equal((await read(b.orderId)).classroomFinancialReceipt, undefined, 'policy order: no receipt from the corpus');
    assert.equal((await read(other.orderId)).classroomFinancialReceipt, undefined, 'other classroom: no redirected receipt');
    // The authorized event still records afterwards (the refusals were not a global outage).
    resetEnv();
    arm(b);
    const ok = await deliver(valid);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.classroomSettlement, 'receipt_recorded_held');
    console.log(`SUBCASE PI03 corpus=${corpus.length} armed+4_unarmed zero_effects invalid_sig=400 out_of_policy=3 then_valid=recorded`);
  } finally {
    resetEnv();
  }
});

test('PI04_production_and_inactive_retail_handler_never_consults_payment_qa_policy', async () => {
  try {
    resetEnv();
    // A malformed policy and payment flag are present but the deployment is not classroom QA.
    for (const extra of [{ VERCEL_ENV: 'production' }, { VERCEL_ENV: undefined }, { VERCEL_ENV: 'production', HSB_CLASSROOM_QA_ONLY: 'true' }, { VERCEL_ENV: 'development', HSB_CLASSROOM_QA_ONLY: 'true' }]) {
      setEnv({ HSB_CLASSROOM_PAYMENT_QA_ONLY: 'true', HSB_CLASSROOM_PAYMENT_QA_SCOPE_JSON: '{malformed', ...extra });
      const id = `cs_test_synthetic_retail_prod_${eventSeq + 1}`;
      eventSeq += 1;
      const before = Object.keys(durable()).length;
      const r = await deliverBody({ id: `evt_synthetic_pi_prod_${eventSeq}`, object: 'event', type: 'checkout.session.completed', livemode: false, created: 1_777_400_000 + eventSeq, data: { object: { id, object: 'checkout.session', metadata: null, amount_subtotal: 2900, amount_total: 2900 } } });
      // Exactly the existing retail branch: missing identity is recorded for recovery.
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.deepEqual(r.body, { error: 'Missing durable order identity; recovery recorded' });
      assert.ok(Object.keys(durable()).length > before, 'retail recovery record written as before');
      const unknown = await deliverBody({ id: `evt_synthetic_pi_prod_u${eventSeq}`, object: 'event', type: 'customer.created', livemode: false, created: 1, data: { object: { id: 'cus_x' } } });
      assert.deepEqual([unknown.status, unknown.body], [200, { received: true }]);
      resetEnv();
    }
    console.log('SUBCASE PI04 production+inactive retail_unchanged policy_ignored');
  } finally {
    resetEnv();
  }
});

test('PI05_expired_policy_refuses_signed_entry_before_any_event_or_session_transport', async () => {
  try {
    resetEnv();
    const b = await nativeBound();
    const e = publishEvent(b.sessionId, b.orderId);
    const expires = Date.parse(b.binding.expiresAt);
    // The refusal an unarmed classroom-QA Preview gives at entry: expiry must be the same.
    arm(b, policyFor(b), { HSB_CLASSROOM_PAYMENT_QA_ONLY: undefined });
    assert.deepEqual(await deliver(e), QA_UNAVAILABLE, 'unarmed entry refusal');
    arm(b);
    await underClock(async () => {
      for (const now of [expires, expires + 1000]) {
        clockMs = now;
        const before = durable();
        const puts = blobPuts();
        const logMark = logs.length;
        const r0 = { e: sdk.eventReads, s: sdk.sessionReads, clients: sdk.clients.length };
        assert.deepEqual(await deliver(e), QA_UNAVAILABLE, `clock ${now}: correctly signed event refused at entry`);
        // Once scope is gone the signature is never consulted, and a bad one gains nothing.
        assert.deepEqual(await deliverBody(sdk.events.get(e)!, 'whsec_synthetic_wrong_secret'), QA_UNAVAILABLE, `clock ${now}: bad signature`);
        // The actual fixed producer refuses on its own, before building any client.
        assert.deepEqual(await orders.recordClassroomFinancialEvent(e), PRODUCER_EXPIRED, `clock ${now}: producer`);
        assert.deepEqual(
          { e: sdk.eventReads - r0.e, s: sdk.sessionReads - r0.s, clients: sdk.clients.length - r0.clients },
          { e: 0, s: 0, clients: 0 }, `clock ${now}: zero Event/Session transport, zero SDK clients`,
        );
        assert.deepEqual(durable(), before, `clock ${now}: zero order/recovery writes`);
        assert.equal(blobPuts(), puts, `clock ${now}: zero blob writes`);
        assert.doesNotMatch(logs.slice(logMark).join('\n'), EFFECT_LOG, `clock ${now}: no retail/scheduling`);
      }
      // Reader: admitted strictly before expiry only, under a finite current clock.
      clockMs = expires - 1;
      assert.notEqual(orders.readClassroomPaymentQaPolicy(), null, 'one millisecond before expiry: admitted');
      for (const now of [expires, expires + 1000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        clockMs = now;
        assert.equal(orders.readClassroomPaymentQaPolicy(), null, `clock ${now}: refused`);
      }
    });
    assert.equal((await read(b.orderId)).classroomFinancialReceipt, undefined, 'no receipt from the expired entry');
    // Current clock: signature authentication retained, and the zero-total receipt is held.
    assert.equal((await deliverBody(sdk.events.get(e)!, 'whsec_synthetic_wrong_secret')).status, 400);
    const ok = await deliver(e);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.classroomSettlement, 'receipt_recorded_held');
    const recorded = raw(b.orderId);
    const receipt = (await read(b.orderId)).classroomFinancialReceipt;
    assert.equal(receipt.providerEventId, e);
    assert.equal(receipt.amountTotalCents, 0);
    // Expiry AFTER the receipt committed: refused, and the truthful receipt stays byte for byte.
    await underClock(async () => {
      clockMs = expires + 1000;
      const before = durable();
      assert.deepEqual(await deliver(e), QA_UNAVAILABLE, 'post-receipt expiry refused at entry');
      assert.deepEqual(await orders.recordClassroomFinancialEvent(e), PRODUCER_EXPIRED, 'post-receipt expiry refused by producer');
      assert.deepEqual(durable(), before, 'post-receipt expiry writes nothing');
    });
    assert.equal(raw(b.orderId), recorded, 'receipt never rolled back');
    assert.deepEqual((await read(b.orderId)).classroomFinancialReceipt, receipt);
    assert.equal(orders.isClassroomReleaseHeld(await read(b.orderId)), true);
    console.log('SUBCASE PI05 expired_entry=503x2 bad_sig=503 producer=refused zero_transport valid=receipt_held post_receipt_expiry=retained');
  } finally {
    resetEnv();
  }
});

test('PI06_expiry_inside_the_native_session_read_refuses_before_the_cas_decision', async () => {
  try {
    resetEnv();
    const b = await nativeBound();
    const e = publishEvent(b.sessionId, b.orderId);
    const expires = Date.parse(b.binding.expiresAt);
    arm(b);
    await underClock(async () => {
      const before = durable();
      const puts = blobPuts();
      const r0 = { e: sdk.eventReads, s: sdk.sessionReads };
      // Entry admits under the current clock; the scope expires inside the real SDK Session read.
      sdk.onSessionRead = () => { clockMs = expires + 1000; };
      const r = await deliver(e);
      assert.equal(sdk.onSessionRead, null, 'expiry landed inside the Session read');
      assert.deepEqual(r, PRODUCER_EXPIRED, 'expired before the custody decision: refused');
      assert.deepEqual({ e: sdk.eventReads - r0.e, s: sdk.sessionReads - r0.s }, { e: 1, s: 1 }, 'reached the actual fixed producer');
      assert.deepEqual(durable(), before, 'zero order/recovery writes');
      assert.equal(blobPuts(), puts);
    });
    assert.equal((await read(b.orderId)).classroomFinancialReceipt, undefined);
    // Refusal left the order eligible: under the current clock the same event records.
    const ok = await deliver(e);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.classroomSettlement, 'receipt_recorded_held');
    console.log('SUBCASE PI06 session_read_expiry=refused zero_write then_valid=receipt_held');
  } finally {
    resetEnv();
  }
});

test('PI07_expiry_inside_the_cas_attempt_assembly_read_refuses_before_commit', async () => {
  try {
    resetEnv();
    const b = await nativeBound();
    const e = publishEvent(b.sessionId, b.orderId);
    const expires = Date.parse(b.binding.expiresAt);
    const isManifest = manifestOf(b);
    arm(b);
    await underClock(async () => {
      const before = durable();
      const puts = blobPuts();
      // The attempt's opening policy check passes; expiry lands inside its awaited
      // assembly read, after which nothing may commit.
      blobGetHook = async (pathname) => {
        if (!isManifest(pathname)) return;
        blobGetHook = null;
        clockMs = expires + 1000;
      };
      const r = await deliver(e);
      assert.equal(blobGetHook, null, 'expiry landed inside the attempt assembly read');
      assert.deepEqual(r, PRODUCER_EXPIRED, 'expired inside the CAS attempt: refused');
      assert.deepEqual(durable(), before, 'zero order/recovery writes');
      assert.equal(blobPuts(), puts);
    });
    const after = await read(b.orderId);
    assert.equal(after.classroomFinancialReceipt, undefined, 'no receipt');
    assert.equal(after.paymentStatus, 'pending', 'no paid projection');
    const ok = await deliver(e);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.classroomSettlement, 'receipt_recorded_held');
    console.log('SUBCASE PI07 cas_assembly_read_expiry=refused zero_write then_valid=receipt_held');
  } finally {
    blobGetHook = null;
    resetEnv();
  }
});

test('PI08_receipt_committed_before_expiry_is_retained_and_the_conflicting_retry_writes_nothing', async () => {
  try {
    resetEnv();
    const b = await nativeBound();
    const unrelated = await nativeBound();
    const unrelatedBefore = raw(unrelated.orderId);
    const first = publishEvent(b.sessionId, b.orderId);
    const second = publishEvent(b.sessionId, b.orderId);
    const expires = Date.parse(b.binding.expiresAt);
    const isManifest = manifestOf(b);
    arm(b);
    let nested: unknown = null;
    let afterFirst: Record<string, string> | null = null;
    await underClock(async () => {
      blobGetHook = async (pathname) => {
        if (!isManifest(pathname)) return;
        blobGetHook = null;
        // A genuine concurrent delivery commits its receipt under the current clock,
        // leaving the suspended attempt's version stale; then the scope expires.
        nested = await deliver(first);
        afterFirst = durable();
        clockMs = expires + 1000;
      };
      const r = await deliver(second);
      assert.equal(blobGetHook, null, 'concurrent commit landed inside the attempt');
      assert.deepEqual(nested, { status: 200, body: { received: true, classroomSettlement: 'receipt_recorded_held' } }, 'pre-expiry receipt committed');
      assert.deepEqual(r, PRODUCER_EXPIRED, 'conflicting attempt after expiry: refused');
    });
    assert.ok(afterFirst, 'snapshot after the committed receipt');
    assert.deepEqual(durable(), afterFirst, 'nothing written after expiry: no retry receipt, no reconciliation');
    const o = await read(b.orderId);
    assert.equal(o.classroomFinancialReceipt.providerEventId, first, 'truthful pre-expiry receipt retained');
    assert.equal(o.classroomFinancialReconciliation, undefined, 'no reconciliation appended');
    assert.equal(raw(unrelated.orderId), unrelatedBefore, 'unrelated classroom order unchanged');
    assert.equal((await read(unrelated.orderId)).classroomFinancialReceipt, undefined);
    console.log('SUBCASE PI08 concurrent_receipt=retained conflicting_retry_after_expiry=refused zero_write unrelated=unchanged');
  } finally {
    blobGetHook = null;
    resetEnv();
  }
});
