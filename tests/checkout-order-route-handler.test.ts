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
import { readFileSync } from 'node:fs';
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

function installMemoryOrderStore(
  opts: {
    /**
     * Report a losing CAS for the commits this predicate selects — i.e. make a
     * concurrent mutation happen underneath a specific write, deterministically.
     */
    rejectReplaceWhen?: (body: string) => boolean;
  } = {},
) {
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
      if (opts.rejectReplaceWhen?.(body)) return { ok: false, reason: 'version_conflict' };
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
// A stale media worker may not tell the buyer their money is untouched
//
// The browser deliberately reuses one checkoutAttemptId, so an exact retry is
// the ordinary case, and persistOrResumeCheckoutOrder lets such a retry take
// over an EXPIRED lease. A lease can expire inside any awaited media upload.
// The worker that then wakes up has made zero provider calls of its own — and
// that is a fact about the worker, not about the order: the retry that took
// over may already have minted and bound a payable Session.
//
// Both windows below are that state. Neither may say "no charge" or ask the
// buyer to submit or pay again.
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function expireDurableCheckoutLease() {
  await withOrderTransaction<null>(ORDER_ID, (current) => ({
    commit: { ...current, checkoutLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString() },
    result: null,
  }));
}

/**
 * Drive the reviewer's reproduction against the real handler and the real order
 * CAS: worker A blocks inside its hero-photo upload, its lease expires, an
 * identical worker B takes over and binds `cs_concurrent`, and only then does
 * A's upload settle the way `settleUpload` says.
 */
async function raceStaleMediaWorker(
  settleUpload: (photoRef: UploadedPhotoRef) => UploadedPhotoRef | null,
) {
  installMemoryOrderStore();
  const entered = deferred<void>();
  const release = deferred<void>();

  const a = harness({
    async uploadOrderPhoto(orderId) {
      entered.resolve();
      await release.promise;
      return settleUpload({
        pathname: `orders/${orderId}/photo-hero.jpg`,
        url: `https://blob.test/orders/${orderId}/photo-hero.jpg`,
      } as UploadedPhotoRef);
    },
  });
  const pendingA = handleCheckoutOrderPost(legacyRequest(), a.deps);
  await entered.promise;

  // A holds the durable owner record and a renewed lease. Then it lapses.
  assert.equal((await stored())?.id, ORDER_ID, 'A created the durable owner record');
  await expireDurableCheckoutLease();

  // The identical retry takes the order over and reaches payment.
  const b = harness({
    async createCheckoutSession({ order, idempotencyKey }) {
      b.provider.push(`create:${idempotencyKey}`);
      const session: ProviderCheckoutSession = {
        id: 'cs_concurrent',
        url: `https://checkout.stripe.test/${order.id}/concurrent`,
        status: 'open',
      };
      b.minted.set(session.id, session);
      return session;
    },
  });
  const responseB = await handleCheckoutOrderPost(legacyRequest(), b.deps);
  assert.equal(responseB.httpStatus, 200, JSON.stringify(responseB));
  assert.equal(responseB.body.redirectTo, b.minted.get('cs_concurrent')!.url);
  assert.equal((await stored())?.stripeSessionId, 'cs_concurrent');

  release.resolve();
  return { a, b, responseA: await pendingA };
}

function assertReconciliationRefusal(response: RouteResponse, label: string) {
  assert.equal(response.httpStatus, 503, `${label}: ${JSON.stringify(response)}`);
  const copy = String(response.body.error);
  assert.equal(copy, CHECKOUT_RECONCILIATION_SUPPORT, `${label} must use the shared reconciliation copy`);
  assert.doesNotMatch(copy, /no charge/i, `${label} may not deny a charge`);
  assert.doesNotMatch(copy, /not been charged/i, `${label} may not deny a charge`);
  assert.doesNotMatch(copy, /stopped before payment/i, `${label} may not claim it stopped before payment`);
  assert.doesNotMatch(copy, /\b(retry|try again|submit again)\b/i, `${label} may not invite resubmission`);
  assert.match(copy, /do not pay again/i, `${label} must tell the buyer not to pay again`);
  assert.match(copy, /support@herostorybooks\.com/, `${label} must route to support`);
  assert.ok(typeof response.body.code === 'string' && response.body.code, `${label} must carry a stable code`);
}

test('a stale worker whose photo upload returns null must not claim no charge', async () => {
  const { a, responseA } = await raceStaleMediaWorker(() => null);

  assert.deepEqual(a.provider, [], 'the stale worker itself never touched the provider');
  assertReconciliationRefusal(responseA, 'upload-returned-null');
  assert.equal(responseA.body.code, 'hero_photo_persist_failed');
  assert.equal(
    (await stored())?.stripeSessionId,
    'cs_concurrent',
    'the payable Session the winner bound survives the loser',
  );
});

test('a stale worker that uploads successfully and then loses the final CAS must not claim no charge', async () => {
  const { a, responseA } = await raceStaleMediaWorker((ref) => ref);

  assert.deepEqual(a.provider, [], 'the stale worker itself never touched the provider');
  assert.ok(a.uploads.includes('rollback:1'), 'its orphaned upload is still rolled back');
  assert.deepEqual(a.converted, [], 'and it never reaches the post-CAS stage');
  assertReconciliationRefusal(responseA, 'final-CAS-loss');
  assert.equal(responseA.body.code, 'checkout_order_media_persist_failed');
  assert.equal(
    (await stored())?.stripeSessionId,
    'cs_concurrent',
    'the payable Session the winner bound survives the loser',
  );
});

// ---------------------------------------------------------------------------
// …and neither may any of the other post-durable media exits
//
// Only two of these windows can be reached at runtime from one request shape,
// so the remaining branches are pinned at the source: every refusal inside
// `continueWithMedia` is the one shared constant, and none of them carries a
// claim about the buyer's money.
// ---------------------------------------------------------------------------

test('every refusal inside the post-durable media stage uses the shared reconciliation constant', () => {
  const src = readFileSync('src/lib/checkout-order-route-handler.ts', 'utf8');
  const start = src.indexOf('continueWithMedia: async (persisted) => {');
  // The media stage ends where the order is durable and the shared provisioner
  // takes over the answer; from there the copy is `provisioned.message`, which
  // the provisioner already classifies for charge risk.
  const end = src.indexOf('deps.markRecoveryLeadConverted(order.email', start);
  assert.ok(start > -1 && end > start, 'the media continuation must still exist');
  const stage = src.slice(start, end);

  const refusals = [...stage.matchAll(/return json\(\s*\{([\s\S]*?)\}\s*,\s*(\d{3})\s*,?\s*\)/g)];
  assert.ok(refusals.length >= 9, `expected every media exit to be pinned, found ${refusals.length}`);
  const codes = new Set<string>();
  for (const [, body, status] of refusals) {
    assert.equal(status, '503', `a post-durable media exit answered ${status}: ${body}`);
    assert.match(
      body,
      /error:\s*POST_DURABLE_MEDIA_REFUSAL/,
      `a post-durable media exit does not use the shared constant: ${body}`,
    );
    const code = body.match(/code:\s*'([a-z_]+)'/);
    assert.ok(code, `a post-durable media exit has no stable code: ${body}`);
    codes.add(code[1]);
  }
  assert.deepEqual(
    [...codes].sort(),
    [
      'checkout_order_media_persist_failed',
      'document_persist_failed',
      'hero_photo_persist_failed',
      'supporting_photo_persist_failed',
      'voice_persist_failed',
    ],
    'every media asset stage keeps its own operator-facing code',
  );
  // No literal customer copy may be reintroduced alongside it.
  assert.doesNotMatch(stage, /error:\s*['"`]/, 'media-stage copy must be single-sourced');
  assert.match(
    src.slice(end),
    /error: provisioned\.message/,
    'and the provisioner hand-off still returns the provisioner\'s own classified copy',
  );
});

test('the post-durable constant is the shared reconciliation copy, not a second wording', () => {
  const src = readFileSync('src/lib/checkout-order-route-handler.ts', 'utf8');
  assert.match(
    src,
    /const POST_DURABLE_MEDIA_REFUSAL = CHECKOUT_RECONCILIATION_SUPPORT;/,
    'the media stage must alias the shared constant rather than restate it',
  );
});

// ---------------------------------------------------------------------------
// The outer catch answers for whichever stage threw
// ---------------------------------------------------------------------------

test('an unclassified throw after the durable order exists reconciles instead of failing generically', async () => {
  // `withOrderTransaction` gives up with an OrderVersionConflictError, which is
  // NOT an OrderPersistenceError — so the final media CAS rethrows it past its
  // own classification and only the outer catch answers. Repeated concurrent
  // mutation is exactly the state where another worker may hold a payable
  // Session, so the generic answer may not be a bare failure either.
  installMemoryOrderStore({
    rejectReplaceWhen: (body) => body.includes(`orders/${ORDER_ID}/photo-hero.jpg`),
  });
  const h = harness();

  const response = await handleCheckoutOrderPost(legacyRequest(), h.deps);

  assertReconciliationRefusal(response, 'final-CAS version-conflict exhaustion');
  assert.equal(response.body.code, 'checkout_unconfirmed');
  assert.deepEqual(h.provider, [], 'the losing worker never reached the provider');
  assert.ok(h.uploads.includes('rollback:1'), 'and its orphaned upload is still rolled back');
});

test('a pre-durable failure keeps its proven no-charge answer', async () => {
  installMemoryOrderStore();
  const h = harness();
  // A body that is not multipart at all: request.formData() throws before any
  // durable record — and before any concurrent worker — can exist.
  const response = await handleCheckoutOrderPost(
    new Request('https://preview.test/api/order', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=nope' },
      body: 'not a real multipart body',
    }),
    h.deps,
  );

  assert.equal(response.httpStatus, 500);
  assert.equal(response.body.error, 'Order submission failed');
  assert.equal(await stored(), null, 'nothing durable exists, so nothing can be outstanding');
  assert.deepEqual(h.provider, []);
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
