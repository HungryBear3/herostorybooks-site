/**
 * The PRODUCTION `POST /api/order` handler, executed.
 *
 * `src/app/api/order/route.ts` is now a thin instantiation of
 * `handleCheckoutOrderPost` with the real Next/Stripe/Blob adapters, and this
 * file drives that same function — the one that contains the production call
 * into the legacy resume/recovery orchestration — against the REAL order CAS,
 * the REAL provisioning machine and the REAL validation. Only the boundaries
 * that cannot exist here are doubles: the response constructor, the provider,
 * the media uploads, the intake store, the recovery-lead write.
 *
 * WHAT THIS EXISTS TO CATCH
 * -------------------------
 * In review, the production call site was changed to
 *
 *     if (false) return await runLegacyCheckoutRoute<NextResponse>({ … })
 *
 * and 31/31 tests across both wiring suites still passed: the lexical guards
 * matched the dead call and the behavioural tests drove a detached copy of the
 * orchestration. Every test below fails under that mutation — either because
 * the handler answers nothing at all, or because an order that already has
 * provider history reaches the media stage, which is the exact bug the resume
 * exists to prevent.
 */
import assert from 'node:assert/strict';
import test, { afterEach, before, after } from 'node:test';
import crypto from 'node:crypto';
import sharp from 'sharp';

import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  readOrderVersioned,
  withOrderTransaction,
  type OrderRecord,
  type OrderStoreAdapter,
  type UploadedPhotoRef,
  type UploadedVoiceRef,
} from '../src/lib/orders.ts';
import {
  handleCheckoutOrderPost,
  type CheckoutOrderRouteDeps,
} from '../src/lib/checkout-order-route-handler.ts';
import {
  CHECKOUT_RECONCILIATION_SUPPORT,
  type ProviderCheckoutSession,
} from '../src/lib/checkout-session-provisioning.ts';

const ATTEMPT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const ORDER_ID = `ord_${crypto.createHash('sha256').update(ATTEMPT).digest('hex').slice(0, 16)}`;

const savedEnv: Record<string, string | undefined> = {};

before(() => {
  for (const key of [
    'BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_ACCESS_MODE', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
    'HSB_CHECKOUT_PAUSED', 'STRIPE_PRODUCT_DIGITAL_ID', 'VERCEL_ENV', 'NEXT_PUBLIC_URL',
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_testsecret';
  process.env.HSB_BLOB_ACCESS_MODE = 'private';
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  delete process.env.HSB_CHECKOUT_PAUSED;
  delete process.env.VERCEL_ENV;
  process.env.STRIPE_PRODUCT_DIGITAL_ID = 'prod_testdigital';
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

/** What the route's `json` adapter builds, minus Next. */
interface RouteResponse { httpStatus: number; body: Record<string, unknown> }

interface Harness {
  deps: CheckoutOrderRouteDeps<RouteResponse>;
  /** Provider calls only: `create:<key>` / `retrieve:<id>`. */
  provider: string[];
  /** Every media write the handler asked for. */
  uploads: string[];
  converted: string[];
  minted: Map<string, ProviderCheckoutSession>;
  logs: string[];
}

function harness(overrides: Partial<CheckoutOrderRouteDeps<RouteResponse>> = {}): Harness {
  const provider: string[] = [];
  const uploads: string[] = [];
  const converted: string[] = [];
  const logs: string[] = [];
  const minted = new Map<string, ProviderCheckoutSession>();
  let next = 1;
  const photoRef = (name: string): UploadedPhotoRef => ({
    pathname: `orders/${ORDER_ID}/${name}`,
    url: `https://blob.test/orders/${ORDER_ID}/${name}`,
  }) as UploadedPhotoRef;
  const deps: CheckoutOrderRouteDeps<RouteResponse> = {
    json: (body, httpStatus) => ({ httpStatus, body }),
    async createCheckoutSession({ order, idempotencyKey }) {
      provider.push(`create:${idempotencyKey}`);
      const session: ProviderCheckoutSession = {
        id: `cs_${next++}`,
        url: `https://checkout.stripe.test/${order.id}/${next - 1}`,
        status: 'open',
      };
      minted.set(session.id, session);
      return session;
    },
    async retrieveCheckoutSession(sessionId) {
      provider.push(`retrieve:${sessionId}`);
      const found = minted.get(sessionId);
      if (!found) throw new Error('session unavailable');
      return found;
    },
    createIntakeStore() {
      throw new Error('the legacy path must never construct the private intake store');
    },
    async uploadOrderPhoto() {
      uploads.push('photo');
      return photoRef('photo-hero.jpg');
    },
    async uploadOrderSupportingPhoto(_orderId, index) {
      uploads.push(`supporting:${index}`);
      return photoRef(`supporting-${index + 1}.jpg`);
    },
    async uploadOrderVoice() {
      uploads.push('voice');
      return photoRef('voice.m4a') as unknown as UploadedVoiceRef;
    },
    async uploadOrderDocument() {
      uploads.push('document');
      return photoRef('document.txt') as unknown as UploadedVoiceRef;
    },
    async rollbackOrderMediaUploads(_orderId, pathnames) {
      uploads.push(`rollback:${pathnames.length}`);
      return pathnames.length;
    },
    async markRecoveryLeadConverted(email, orderId) {
      converted.push(`${email}:${orderId}`);
      return null;
    },
    logError: (message) => { logs.push(message); },
    ...overrides,
  };
  return { deps, provider, uploads, converted, minted, logs };
}

let heroPhotoBytes: Buffer;

before(async () => {
  heroPhotoBytes = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#336699' },
  }).png().toBuffer();
});

/** The exact multipart body the checkout form posts on the legacy path. */
function legacyRequest(): Request {
  const form = new FormData();
  form.set('checkoutAttemptId', ATTEMPT);
  form.set('childName', 'Mina');
  form.set('email', 'buyer@example.com');
  form.set('bookFormat', 'digital');
  form.set('theme', 'space-adventure');
  form.set('characterNotes', 'Curly hair, always wearing a red cape');
  form.set('photo', new File([new Uint8Array(heroPhotoBytes)], 'hero.png', { type: 'image/png' }));
  return new Request('https://preview.test/api/order', { method: 'POST', body: form });
}

async function stored(): Promise<OrderRecord | null> {
  return (await readOrderVersioned(ORDER_ID, { preferRecentCommit: true }))?.order ?? null;
}

const creates = (h: Harness) => h.provider.filter((call) => call.startsWith('create:'));

// ---------------------------------------------------------------------------
// A first request: media, then the durable CAS, then the shared provisioner
// ---------------------------------------------------------------------------

test('the production handler uploads media and releases a provisioner-approved URL', async () => {
  installMemoryOrderStore();
  const h = harness();

  const response = await handleCheckoutOrderPost(legacyRequest(), h.deps);

  assert.equal(response.httpStatus, 200, JSON.stringify(response));
  assert.deepEqual(h.uploads, ['photo'], 'a first request does its media work');
  assert.equal(creates(h).length, 1);
  assert.equal(response.body.redirectTo, h.minted.get('cs_1')!.url);
  assert.deepEqual(h.converted, [`buyer@example.com:${ORDER_ID}`]);
  const durable = await stored();
  assert.equal(durable?.id, ORDER_ID);
  assert.equal(durable?.stripeSessionId, 'cs_1');
  assert.equal(durable?.photoBlobPath, `orders/${ORDER_ID}/photo-hero.jpg`);
});

// ---------------------------------------------------------------------------
// The reachability of the resume, from the handler that must reach it
//
// Both tests below are the mutation gate: with the production legacy call made
// unreachable, an order that already has provider history either gets no answer
// at all or walks straight back into the media stage and the provider.
// ---------------------------------------------------------------------------

test('a retry of the same attempt resumes the bound Session and never re-enters media', async () => {
  installMemoryOrderStore();
  const first = harness();
  await handleCheckoutOrderPost(legacyRequest(), first.deps);

  // The same buyer, the same attempt id, byte-identical inputs — which is what
  // the browser deliberately sends on a retry.
  const retry = harness();
  retry.minted.set('cs_1', first.minted.get('cs_1')!);
  const response = await handleCheckoutOrderPost(legacyRequest(), retry.deps);

  assert.deepEqual(retry.uploads, [], 'a resumable order must never re-upload the buyer\'s media');
  assert.deepEqual(retry.converted, [], 'and must not re-enter the post-media stage at all');
  assert.deepEqual(creates(retry), [], 'nor mint a second payable Session');
  assert.deepEqual(retry.provider, ['retrieve:cs_1'], 'the bound Session is reconciled at the provider');
  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.redirectTo, first.minted.get('cs_1')!.url);
  assert.equal((await stored())?.stripeSessionId, 'cs_1');
});

test('an unresolved provider create from an earlier request stops the handler before media', async () => {
  installMemoryOrderStore();
  // The first request commits the durable pre-provider marker and then loses
  // the create: the provider may be holding a payable Session for this order.
  const first = harness({
    async createCheckoutSession() { throw new Error('provider unavailable'); },
  });
  const opened = await handleCheckoutOrderPost(legacyRequest(), first.deps);
  assert.equal(opened.httpStatus, 503);
  assert.equal(opened.body.code, 'checkout_session_create_failed');
  assert.deepEqual(first.uploads, ['photo']);
  assert.equal((await stored())?.checkoutSessionProvisioning?.checkoutSessionAttempt, 0);

  // That request's lease lapses; the buyer retries.
  await withOrderTransaction<null>(ORDER_ID, (current) => ({
    commit: { ...current, checkoutLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString() },
    result: null,
  }));

  const retry = harness();
  const response = await handleCheckoutOrderPost(legacyRequest(), retry.deps);

  assert.deepEqual(retry.uploads, [], 'an order with provider history may not reach the media stage');
  assert.deepEqual(retry.provider, [], 'and may not reach the provider either');
  assert.equal(response.httpStatus, 409);
  assert.equal(response.body.code, 'checkout_session_reconciliation_required');
  assert.equal(response.body.error, CHECKOUT_RECONCILIATION_SUPPORT);
  assert.doesNotMatch(String(response.body.error), /no charge/i);
  assert.equal(
    (await stored())?.checkoutSessionProvisioning?.checkoutSessionAttempt,
    0,
    'the marker survives for reconciliation',
  );
});

// ---------------------------------------------------------------------------
// The handler's own refusals still come from the handler
// ---------------------------------------------------------------------------

test('checkout pause is answered by the production handler before anything else', async () => {
  installMemoryOrderStore();
  const h = harness();
  process.env.HSB_CHECKOUT_PAUSED = 'true';
  try {
    const response = await handleCheckoutOrderPost(legacyRequest(), h.deps);
    assert.equal(response.httpStatus, 503);
    assert.equal(response.body.code, 'checkout_paused');
  } finally {
    delete process.env.HSB_CHECKOUT_PAUSED;
  }
  assert.deepEqual(h.uploads, []);
  assert.deepEqual(h.provider, []);
  assert.equal(await stored(), null, 'no durable order is created while checkout is paused');
});

test('an invalid submission is refused before any durable order or media exists', async () => {
  installMemoryOrderStore();
  const h = harness();
  const form = new FormData();
  form.set('checkoutAttemptId', ATTEMPT);
  form.set('childName', 'Mina');
  form.set('email', 'not-an-email');
  form.set('theme', 'space-adventure');
  form.set('characterNotes', 'Curly hair');

  const response = await handleCheckoutOrderPost(
    new Request('https://preview.test/api/order', { method: 'POST', body: form }),
    h.deps,
  );

  assert.equal(response.httpStatus, 400);
  assert.equal(response.body.code, 'email_invalid');
  assert.deepEqual(h.uploads, []);
  assert.deepEqual(h.provider, []);
  assert.equal(await stored(), null);
});
