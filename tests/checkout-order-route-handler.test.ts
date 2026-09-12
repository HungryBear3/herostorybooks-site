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
  claimCheckoutIntentOrderId,
  getOrderAuthoritative,
  readOrderVersioned,
  releaseCheckoutIntentOrderId,
  resolveCheckoutOrderIdForAttempt,
  retireExpiredCheckoutAttempt,
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
import { checkoutIntentFingerprint } from '../src/lib/checkout-request-fingerprint.ts';
import {
  checkoutAttemptRestartDependencies,
  resolveCheckoutAttemptRestart,
  type CheckoutAttemptProviderSession,
} from '../src/lib/checkout-attempt-restart.ts';
import { createIntake } from '../src/lib/checkout-intake.ts';
import { completeSlotUpload, reserveSlotUpload } from '../src/lib/checkout-intake-upload.ts';
import { createMemoryIntakeStore } from './support/checkout-intake-memory-store.ts';
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
    'HSB_CHECKOUT_PAUSED', 'HSB_STORY_MEDIA_INTENT', 'STRIPE_PRODUCT_DIGITAL_ID',
    'STRIPE_PRODUCT_CLASSIC_ID', 'VERCEL_ENV', 'NEXT_PUBLIC_URL',
    'HSB_CHECKOUT_DIRECT_UPLOAD',
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_testsecret';
  process.env.HSB_BLOB_ACCESS_MODE = 'private';
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'true';
  delete process.env.HSB_CHECKOUT_PAUSED;
  delete process.env.HSB_STORY_MEDIA_INTENT;
  delete process.env.VERCEL_ENV;
  process.env.STRIPE_PRODUCT_DIGITAL_ID = 'prod_testdigital';
  process.env.STRIPE_PRODUCT_CLASSIC_ID = 'prod_testclassic';
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
    /** Make the durable store unavailable for the writes this predicate selects. */
    rejectCreateWhen?: (pathname: string) => boolean;
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
      if (opts.rejectCreateWhen?.(pathname)) throw new Error('durable store unavailable');
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
        payment_status: 'unpaid',
        payment_intent: null,
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

function legacyForm(attemptId = ATTEMPT): FormData {
  const form = new FormData();
  form.set('checkoutAttemptId', attemptId);
  form.set('childName', 'Mina');
  form.set('email', 'buyer@example.com');
  form.set('bookFormat', 'digital');
  form.set('theme', 'space-adventure');
  form.set('characterNotes', 'Curly hair, always wearing a red cape');
  form.set('photo', new File([new Uint8Array(heroPhotoBytes)], 'hero.png', { type: 'image/png' }));
  return form;
}

/** The exact multipart body the checkout form posts on the legacy path. */
function legacyRequest(): Request {
  return new Request('https://preview.test/api/order', { method: 'POST', body: legacyForm() });
}

function legacyStoryMediaRequest(kind: 'voice' | 'document'): Request {
  const form = legacyForm();
  if (kind === 'voice') {
    form.set('voice', new File([new Uint8Array([1, 2, 3])], 'memory.m4a', { type: 'audio/mp4' }));
  } else {
    form.set('document', new File([new TextEncoder().encode('A family memory')], 'memory.txt', { type: 'text/plain' }));
  }
  return new Request('https://preview.test/api/order', { method: 'POST', body: form });
}

function typedCustomStoryRequest(): Request {
  const form = legacyForm();
  form.set('theme', 'custom-voice-story');
  form.set('customStoryText', 'A typed family memory with no attached media.');
  return new Request('https://preview.test/api/order', { method: 'POST', body: form });
}

async function stored(): Promise<OrderRecord | null> {
  return (await readOrderVersioned(ORDER_ID, { preferRecentCommit: true }))?.order ?? null;
}

const creates = (h: Harness) => h.provider.filter((call) => call.startsWith('create:'));

test('a stale server-lease header is rejected before order, media, or provider work', async () => {
  installMemoryOrderStore();
  const h = harness();
  const request = new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${ATTEMPT}`,
      'x-hsb-checkout-attempt': 'b'.repeat(32),
    },
    body: legacyForm(),
  });

  const response = await handleCheckoutOrderPost(request, h.deps);
  assert.equal(response.httpStatus, 409);
  assert.deepEqual(h.uploads, []);
  assert.deepEqual(h.provider, []);
  assert.equal(await stored(), null);
});

test('different Safari leases can refuse an early loser, whose retry resumes the one provider Session', async () => {
  const cells = installMemoryOrderStore();
  const entered = deferred<void>();
  const release = deferred<void>();
  const h = harness({
    async uploadOrderPhoto(orderId) {
      h.uploads.push('photo');
      entered.resolve();
      await release.promise;
      return {
        pathname: `orders/${orderId}/photo-hero.jpg`,
        url: `https://blob.test/orders/${orderId}/photo-hero.jpg`,
      } as UploadedPhotoRef;
    },
  });
  const attemptA = 'a'.repeat(32);
  const attemptB = 'b'.repeat(32);
  const requestFor = (attemptId: string) => new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${attemptId}`,
      'x-hsb-checkout-attempt': attemptId,
    },
    body: legacyForm(attemptId),
  });

  const pendingWinner = handleCheckoutOrderPost(requestFor(attemptA), h.deps);
  await entered.promise;
  const earlyLoser = await handleCheckoutOrderPost(requestFor(attemptB), h.deps);
  assert.ok(earlyLoser.httpStatus >= 400, JSON.stringify(earlyLoser));
  assert.equal(creates(h).length, 0, 'the winner is still pre-provider');

  release.resolve();
  const winner = await pendingWinner;
  assert.equal(winner.httpStatus, 200, JSON.stringify(winner));
  const retry = await handleCheckoutOrderPost(requestFor(attemptB), h.deps);
  assert.equal(retry.httpStatus, 200, JSON.stringify(retry));
  assert.equal(retry.body.redirectTo, winner.body.redirectTo);
  assert.equal(creates(h).length, 1, 'retrying the loser must resume, never mint again');
  assert.equal(await resolveCheckoutOrderIdForAttempt(attemptB), await resolveCheckoutOrderIdForAttempt(attemptA));
  assert.equal(
    [...cells.keys()].filter((pathname) => /(^|\/)orders\/ord_[a-f0-9]{16}\.json$/.test(pathname)).length,
    1,
  );
});

test('a delayed different Safari lease resumes the canonical open Session for identical content', async () => {
  installMemoryOrderStore();
  const h = harness();
  const attemptA = 'a'.repeat(32);
  const attemptB = 'b'.repeat(32);
  const requestFor = (attemptId: string) => new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${attemptId}`,
      'x-hsb-checkout-attempt': attemptId,
    },
    body: legacyForm(attemptId),
  });

  const first = await handleCheckoutOrderPost(requestFor(attemptA), h.deps);
  const second = await handleCheckoutOrderPost(requestFor(attemptB), h.deps);

  assert.equal(first.httpStatus, 200);
  assert.equal(second.httpStatus, 200, JSON.stringify(second));
  assert.equal(second.body.redirectTo, first.body.redirectTo);
  assert.equal(creates(h).length, 1);
  assert.equal(await resolveCheckoutOrderIdForAttempt(attemptB), await resolveCheckoutOrderIdForAttempt(attemptA));
});

test('normalized payable-equivalent requests converge before provider creation', async () => {
  installMemoryOrderStore();
  const h = harness();
  const attemptA = 'a'.repeat(32);
  const attemptB = 'b'.repeat(32);
  const requestFor = (attemptId: string, variant: 'explicit' | 'normalized') => {
    const form = legacyForm(attemptId);
    form.set('bookFormat', 'classic');
    if (variant === 'normalized') {
      form.set('childName', '  Mina  ');
      form.set('email', '  buyer@example.com  ');
      form.delete('bookFormat');
    }
    return new Request('https://preview.test/api/order', {
      method: 'POST',
      headers: {
        cookie: `__Host-hsb-checkout-attempt=${attemptId}`,
        'x-hsb-checkout-attempt': attemptId,
      },
      body: form,
    });
  };

  const first = await handleCheckoutOrderPost(requestFor(attemptA, 'explicit'), h.deps);
  const second = await handleCheckoutOrderPost(requestFor(attemptB, 'normalized'), h.deps);

  assert.equal(first.httpStatus, 200, JSON.stringify(first));
  assert.equal(second.httpStatus, 200, JSON.stringify(second));
  assert.equal(second.body.redirectTo, first.body.redirectTo);
  assert.equal(creates(h).length, 1, 'payable-equivalent requests must share one semantic claim');
});

test('a losing Safari lease fails closed on canonical expired evidence with omitted payment_intent', async () => {
  installMemoryOrderStore();
  const h = harness();
  const attemptA = 'a'.repeat(32);
  const attemptB = 'b'.repeat(32);
  const requestFor = (attemptId: string) => new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${attemptId}`,
      'x-hsb-checkout-attempt': attemptId,
    },
    body: legacyForm(attemptId),
  });

  const first = await handleCheckoutOrderPost(requestFor(attemptA), h.deps);
  assert.equal(first.httpStatus, 200, JSON.stringify(first));
  const canonical = h.minted.get('cs_1')!;
  canonical.status = 'expired';
  canonical.payment_status = 'unpaid';
  delete canonical.payment_intent;

  const second = await handleCheckoutOrderPost(requestFor(attemptB), h.deps);
  assert.equal(second.httpStatus, 409, JSON.stringify(second));
  assert.equal(second.body.code, 'checkout_session_payment_ambiguous');
  assert.equal(second.body.error, CHECKOUT_RECONCILIATION_SUPPORT);
  assert.equal(creates(h).length, 1, 'ambiguous canonical evidence must never mint a replacement');
});

async function directIntakeWithEquivalentHero(store: ReturnType<typeof createMemoryIntakeStore>, etag: string) {
  const now = new Date();
  const session = await createIntake(store, { mediaAuthorizedAt: now.toISOString() }, now);
  const reservation = await reserveSlotUpload(store, {
    intakeId: session.intakeId,
    capability: session.capability,
    slot: { category: 'primary_hero_photo' },
    mimeType: 'image/jpeg',
    size: 4096,
  }, now);
  store.putAsset({ pathname: reservation.pathname, mimeType: 'image/jpeg', size: 4096, etag });
  await completeSlotUpload(store, {
    tokenPayload: reservation.tokenPayload,
    blob: { pathname: reservation.pathname, contentType: 'image/jpeg', size: 4096, etag },
  }, now);
  return { session, assetId: reservation.assetId };
}

function directRequestFor(
  attemptId: string,
  intake: Awaited<ReturnType<typeof directIntakeWithEquivalentHero>>,
): Request {
  const form = legacyForm(attemptId);
  form.delete('photo');
  form.set('checkoutIntakeCapability', intake.session.capability);
  form.set('checkoutIntake', JSON.stringify({
    intakeId: intake.session.intakeId,
    familyCharacterIds: [],
    selection: {
      primaryHeroPhotoAssetId: intake.assetId,
      familyCharacterAssets: [],
      guidedStillAssetIds: [],
      voiceAssetId: null,
      documentAssetId: null,
    },
  }));
  return new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${attemptId}`,
      'x-hsb-checkout-attempt': attemptId,
    },
    body: form,
  });
}

test('a losing direct intake resumes the canonical URL without finalizing its distinct intake', async () => {
  installMemoryOrderStore();
  const store = createMemoryIntakeStore();
  const intakeA = await directIntakeWithEquivalentHero(store, 'sha256:same-validated-bytes');
  const intakeB = await directIntakeWithEquivalentHero(store, 'sha256:same-validated-bytes');
  const h = harness({ createIntakeStore: () => store });
  process.env.HSB_CHECKOUT_DIRECT_UPLOAD = 'true';
  try {
    const first = await handleCheckoutOrderPost(directRequestFor('a'.repeat(32), intakeA), h.deps);
    assert.equal(first.httpStatus, 200, JSON.stringify(first));
    assert.equal(store.records.get(intakeA.session.intakeId)?.record.finalizedOrderId != null, true);

    const second = await handleCheckoutOrderPost(directRequestFor('b'.repeat(32), intakeB), h.deps);
    assert.equal(second.httpStatus, 200, JSON.stringify(second));
    assert.equal(second.body.redirectTo, first.body.redirectTo);
    assert.equal(creates(h).length, 1);
    assert.equal(
      store.records.get(intakeB.session.intakeId)?.record.finalization,
      null,
      'the losing direct intake must not even reserve finalization',
    );
    assert.equal(store.records.get(intakeB.session.intakeId)?.record.finalizedOrderId, null);
  } finally {
    delete process.env.HSB_CHECKOUT_DIRECT_UPLOAD;
  }
});

test('malformed canonical provider identity fails closed before touching a losing direct intake', async () => {
  installMemoryOrderStore();
  const store = createMemoryIntakeStore();
  const intakeA = await directIntakeWithEquivalentHero(store, 'sha256:same-validated-bytes');
  const intakeB = await directIntakeWithEquivalentHero(store, 'sha256:same-validated-bytes');
  const h = harness({ createIntakeStore: () => store });
  process.env.HSB_CHECKOUT_DIRECT_UPLOAD = 'true';
  try {
    const first = await handleCheckoutOrderPost(directRequestFor('a'.repeat(32), intakeA), h.deps);
    assert.equal(first.httpStatus, 200, JSON.stringify(first));
    const canonicalOrderId = await resolveCheckoutOrderIdForAttempt('a'.repeat(32));
    assert.ok(canonicalOrderId);
    await withOrderTransaction<null>(canonicalOrderId, (current) => ({
      commit: { ...current, checkoutIntentFingerprint: 'f'.repeat(64) },
      result: null,
    }));
    const intakeCasBefore = store.casAttempts;

    const second = await handleCheckoutOrderPost(directRequestFor('b'.repeat(32), intakeB), h.deps);
    assert.ok(second.httpStatus >= 400, JSON.stringify(second));
    assert.equal(second.body.error, CHECKOUT_RECONCILIATION_SUPPORT);
    assert.equal(creates(h).length, 1);
    assert.equal(store.casAttempts, intakeCasBefore, 'malformed canonical evidence must stop before direct finalization');
    assert.equal(store.records.get(intakeB.session.intakeId)?.record.finalization, null);
    assert.equal(store.records.get(intakeB.session.intakeId)?.record.finalizedOrderId, null);
  } finally {
    delete process.env.HSB_CHECKOUT_DIRECT_UPLOAD;
  }
});

test('an attempt that persists another attempt claim winner remains restart-addressable', async () => {
  installMemoryOrderStore();
  const attemptA = 'a'.repeat(32);
  const attemptB = 'b'.repeat(32);
  const canonicalOrderId = `ord_${crypto.createHash('sha256').update(attemptA).digest('hex').slice(0, 16)}`;
  const calibration = harness();
  assert.equal((await handleCheckoutOrderPost(new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${attemptA}`,
      'x-hsb-checkout-attempt': attemptA,
    },
    body: legacyForm(attemptA),
  }), calibration.deps)).httpStatus, 200);
  const intentFingerprint = (await readOrderVersioned(canonicalOrderId))?.order.checkoutIntentFingerprint;
  assert.match(intentFingerprint ?? '', /^[a-f0-9]{64}$/);

  installMemoryOrderStore();
  const h = harness();
  assert.deepEqual(
    await claimCheckoutIntentOrderId(intentFingerprint!, canonicalOrderId),
    { orderId: canonicalOrderId, generation: 0 },
  );

  const response = await handleCheckoutOrderPost(new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${attemptB}`,
      'x-hsb-checkout-attempt': attemptB,
    },
    body: legacyForm(attemptB),
  }), h.deps);

  assert.equal(response.httpStatus, 200);
  assert.equal(await resolveCheckoutOrderIdForAttempt(attemptB), canonicalOrderId);
  assert.equal((await readOrderVersioned(canonicalOrderId))?.order.checkoutAttemptId, attemptB);
  assert.equal(creates(h).length, 1);
});

for (const kind of ['voice', 'document'] as const) {
  test(`explicit story-media disable rejects a new legacy ${kind} before persistence`, async () => {
    installMemoryOrderStore();
    const h = harness();
    process.env.HSB_STORY_MEDIA_INTENT = 'disabled';
    try {
      const response = await handleCheckoutOrderPost(legacyStoryMediaRequest(kind), h.deps);

      assert.equal(response.httpStatus, 404, JSON.stringify(response));
      assert.equal(response.body.code, 'story_media_disabled');
      assert.deepEqual(h.uploads, [], 'disabled media must not reach any upload adapter');
      assert.deepEqual(h.provider, [], 'disabled media must not reach Stripe');
      assert.equal(await stored(), null, 'disabled media must not create a durable order owner');
    } finally {
      delete process.env.HSB_STORY_MEDIA_INTENT;
    }
  });
}

test('explicit story-media disable preserves ordinary text-free legacy checkout', async () => {
  installMemoryOrderStore();
  const h = harness();
  process.env.HSB_STORY_MEDIA_INTENT = 'disabled';
  try {
    const response = await handleCheckoutOrderPost(legacyRequest(), h.deps);
    assert.equal(response.httpStatus, 200, JSON.stringify(response));
    assert.deepEqual(h.uploads, ['photo']);
    assert.equal(creates(h).length, 1);
  } finally {
    delete process.env.HSB_STORY_MEDIA_INTENT;
  }
});

test('explicit story-media disable does not classify typed Custom Story text as disabled media', async () => {
  installMemoryOrderStore();
  const h = harness();
  process.env.HSB_STORY_MEDIA_INTENT = 'disabled';
  try {
    const response = await handleCheckoutOrderPost(typedCustomStoryRequest(), h.deps);
    assert.equal(response.httpStatus, 200, JSON.stringify(response));
    assert.notEqual(response.body.code, 'story_media_disabled');
    assert.deepEqual(h.uploads, ['photo'], 'typed text must not invoke a voice or document adapter');
  } finally {
    delete process.env.HSB_STORY_MEDIA_INTENT;
  }
});

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

test('legacy production handler never replaces an expired Session that has a PaymentIntent', async () => {
  installMemoryOrderStore();
  const first = harness();
  const opened = await handleCheckoutOrderPost(legacyRequest(), first.deps);
  assert.equal(opened.httpStatus, 200);

  const oldSession = first.minted.get('cs_1')! as ProviderCheckoutSession & {
    payment_status: string;
    payment_intent: string | null;
  };
  oldSession.status = 'expired';
  oldSession.payment_status = 'unpaid';
  oldSession.payment_intent = 'pi_may_still_settle';

  const retry = harness();
  retry.minted.set('cs_1', oldSession);
  const response = await handleCheckoutOrderPost(legacyRequest(), retry.deps);

  assert.equal(response.httpStatus, 409);
  assert.equal(response.body.code, 'checkout_session_payment_ambiguous');
  assert.deepEqual(creates(retry), [], 'a Session with any PaymentIntent must never be replaced');
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
        payment_status: 'unpaid',
        payment_intent: null,
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

// A dotless domain is exactly what the client-side Pay gate must stop, because
// the server cannot answer it actionably: by the time a valid attempt ID exists,
// a concurrent request on the SAME attempt may already hold provider evidence,
// so every 4xx under that attempt is reconciliation-safe by policy. This pins
// that policy for `email_invalid` so a client-side fix is never "helped along"
// by loosening the server back into actionable local-validation copy.
test('a dotless-domain email under a valid attempt keeps its code but answers reconciliation-safe', async () => {
  installMemoryOrderStore();
  const h = harness();
  const form = new FormData();
  form.set('checkoutAttemptId', ATTEMPT);
  form.set('childName', 'Mina');
  form.set('email', 'alexy@gmail');
  form.set('bookFormat', 'digital');
  form.set('theme', 'space-adventure');
  form.set('characterNotes', 'Curly hair');

  const response = await handleCheckoutOrderPost(
    new Request('https://preview.test/api/order', { method: 'POST', body: form }),
    h.deps,
  );

  assert.equal(response.httpStatus, 400);
  assert.equal(response.body.code, 'email_invalid');
  assert.equal(response.body.error, CHECKOUT_RECONCILIATION_SUPPORT);
  assert.match(String(response.body.error), /do not pay again/i);
  assert.doesNotMatch(
    String(response.body.error),
    /no charge|not been charged|stopped before payment|\b(retry|try again|submit again)\b/i,
  );
  assert.deepEqual(h.uploads, [], 'no media is written');
  assert.deepEqual(h.provider, [], 'the provider is never reached');
  assert.deepEqual(h.converted, [], 'no recovery lead is converted');
  assert.equal(await stored(), null, 'nothing durable is created');
});

test('a valid attempt uses reconciliation-safe copy even when asynchronous photo validation refuses it', async () => {
  installMemoryOrderStore();
  const h = harness();
  const form = new FormData();
  form.set('checkoutAttemptId', ATTEMPT);
  form.set('childName', 'Mina');
  form.set('email', 'buyer@example.com');
  form.set('bookFormat', 'digital');
  form.set('theme', 'space-adventure');
  form.set('characterNotes', 'Curly hair');
  form.set('photo', new File([new TextEncoder().encode('not an image')], 'hero.png', { type: 'image/png' }));

  const response = await handleCheckoutOrderPost(
    new Request('https://preview.test/api/order', { method: 'POST', body: form }),
    h.deps,
  );

  assert.equal(response.httpStatus, 400);
  assert.equal(response.body.code, 'photo_invalid_content');
  assert.equal(response.body.error, CHECKOUT_RECONCILIATION_SUPPORT);
  assert.doesNotMatch(String(response.body.error), /no charge|stopped before payment|\btry again\b|\bretry\b/i);
  assert.match(String(response.body.error), /do not pay again/i);
  assert.deepEqual(h.uploads, []);
  assert.deepEqual(h.provider, []);
  assert.equal(await stored(), null);
});

// ---------------------------------------------------------------------------
// R2: an attempt that EDITS its purchased content
// ---------------------------------------------------------------------------
// The deterministic order id is derived from the browser attempt, so one attempt
// proposes the SAME order id for two different semantic intents. The second
// intent must never be bound to the first intent's provider-backed order: that
// binding is durable, so it would keep answering 409 forever — for this attempt
// AND for every later attempt that submits the edited content. Refusing the edit
// is correct; poisoning the edited content is not.

function attemptRequest(attemptId: string, mutate: (form: FormData) => void = () => {}): Request {
  const form = legacyForm(attemptId);
  mutate(form);
  return new Request('https://preview.test/api/order', {
    method: 'POST',
    headers: {
      cookie: `__Host-hsb-checkout-attempt=${attemptId}`,
      'x-hsb-checkout-attempt': attemptId,
    },
    body: form,
  });
}

/** A different book: a different semantic intent, and a different purchase. */
const editedContent = (form: FormData) => { form.set('childName', 'Nora'); };
const originalContent = () => {};

const orderIdFor = (attemptId: string) =>
  `ord_${crypto.createHash('sha256').update(attemptId).digest('hex').slice(0, 16)}`;

type MemoryCells = ReturnType<typeof installMemoryOrderStore>;

const claimPaths = (cells: MemoryCells) =>
  [...cells.keys()].filter((pathname) => /(^|\/)checkout-intent-claims\/[a-f0-9]{64}\.json$/.test(pathname));

const claimedOrderIds = (cells: MemoryCells) =>
  claimPaths(cells).map((pathname) => JSON.parse(cells.get(pathname)!.body).orderId as string | null);

async function orderRecord(orderId: string): Promise<OrderRecord | null> {
  return (await readOrderVersioned(orderId, { preferRecentCommit: true }))?.order ?? null;
}

/** The semantic fingerprint a given content produces, measured in its own store. */
async function intentFingerprintOf(mutate: (form: FormData) => void): Promise<string> {
  installMemoryOrderStore();
  const calibration = harness();
  const attemptId = 'c'.repeat(32);
  const response = await handleCheckoutOrderPost(attemptRequest(attemptId, mutate), calibration.deps);
  assert.equal(response.httpStatus, 200, JSON.stringify(response));
  const fingerprint = (await orderRecord(orderIdFor(attemptId)))?.checkoutIntentFingerprint;
  assert.match(fingerprint ?? '', /^[a-f0-9]{64}$/);
  return fingerprint!;
}

/** Seed the exact durable damage an earlier release could leave behind. */
function seedClaim(cells: MemoryCells, canonicalOrderId: string, fingerprint: string): string {
  const orderPath = [...cells.keys()].find((pathname) => pathname.endsWith(`orders/${canonicalOrderId}.json`))!;
  const namespace = orderPath.slice(0, orderPath.length - `orders/${canonicalOrderId}.json`.length);
  const pathname = `${namespace}checkout-intent-claims/${fingerprint}.json`;
  cells.set(pathname, {
    body: JSON.stringify({
      fingerprint,
      orderId: canonicalOrderId,
      previousOrderId: null,
      retiredOrderIds: [],
      generation: 0,
      updatedAt: '2026-09-12T00:00:00.000Z',
    }),
    version: 1,
  });
  return pathname;
}

test('an edited attempt is refused without binding the edited content to the old order', async () => {
  const cells = installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);
  const canonicalOrderId = orderIdFor(attemptId);

  const first = await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps);
  assert.equal(first.httpStatus, 200, JSON.stringify(first));

  const edited = await handleCheckoutOrderPost(attemptRequest(attemptId, editedContent), h.deps);

  assert.ok(edited.httpStatus >= 400, JSON.stringify(edited));
  const copy = String(edited.body.error);
  assert.match(copy, /do not pay again/i, 'the open attempt may already be payable');
  assert.match(copy, /support@herostorybooks\.com/);
  assert.doesNotMatch(copy, /no charge|not been charged|stopped before payment/i);
  assert.equal(creates(h).length, 1, 'a refused edit may never mint a second payable Session');
  assert.deepEqual(h.uploads, ['photo'], 'a refused edit never reaches the media stage');
  assert.equal((await orderRecord(canonicalOrderId))?.childName, 'Mina', 'the open order keeps its own content');
  assert.deepEqual(
    claimedOrderIds(cells).filter((orderId) => orderId === canonicalOrderId),
    [canonicalOrderId],
    'exactly one semantic intent may ever own the provider-backed order',
  );
});

test('a fresh attempt can still buy the edited content after the edit was refused', async () => {
  installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);
  const freshAttemptId = 'b'.repeat(32);

  assert.equal(
    (await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps)).httpStatus,
    200,
  );
  assert.ok((await handleCheckoutOrderPost(attemptRequest(attemptId, editedContent), h.deps)).httpStatus >= 400);

  const fresh = await handleCheckoutOrderPost(attemptRequest(freshAttemptId, editedContent), h.deps);

  assert.equal(fresh.httpStatus, 200, JSON.stringify(fresh));
  assert.equal(await resolveCheckoutOrderIdForAttempt(freshAttemptId), orderIdFor(freshAttemptId));
  assert.equal(creates(h).length, 2, 'the edited book is a different purchase and needs its own Session');
  assert.equal((await orderRecord(orderIdFor(freshAttemptId)))?.childName, 'Nora');
  assert.equal(
    (await orderRecord(orderIdFor(attemptId)))?.childName,
    'Mina',
    'and the original open order is untouched by it',
  );
});

test('the original content still resumes its one Session after an edit was refused', async () => {
  installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);

  const first = await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps);
  assert.ok((await handleCheckoutOrderPost(attemptRequest(attemptId, editedContent), h.deps)).httpStatus >= 400);

  const resumed = await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps);

  assert.equal(resumed.httpStatus, 200, JSON.stringify(resumed));
  assert.equal(resumed.body.redirectTo, first.body.redirectTo, 'the buyer returns to the one open Session');
  assert.equal(creates(h).length, 1);
});

test('concurrent edits of one attempt settle on a single order and leave the loser buyable', async () => {
  installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);

  const [original, edited] = await Promise.all([
    handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps),
    handleCheckoutOrderPost(attemptRequest(attemptId, editedContent), h.deps),
  ]);

  const settled = [original, edited].filter((response) => response.httpStatus === 200);
  assert.equal(settled.length, 1, `exactly one intent may win: ${JSON.stringify([original, edited])}`);
  assert.equal(creates(h).length, 1);
  const loser = original.httpStatus === 200 ? editedContent : originalContent;
  const loserName = original.httpStatus === 200 ? 'Nora' : 'Mina';

  const freshAttemptId = 'b'.repeat(32);
  const retry = await handleCheckoutOrderPost(attemptRequest(freshAttemptId, loser), h.deps);

  assert.equal(retry.httpStatus, 200, JSON.stringify(retry));
  assert.equal((await orderRecord(orderIdFor(freshAttemptId)))?.childName, loserName);
  assert.equal(creates(h).length, 2);
});

test('a mis-bound claim written by an earlier release is repaired for the next fresh attempt', async () => {
  const editedFingerprint = await intentFingerprintOf(editedContent);
  const cells = installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);
  const canonicalOrderId = orderIdFor(attemptId);

  assert.equal(
    (await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps)).httpStatus,
    200,
  );
  const poisonedPath = seedClaim(cells, canonicalOrderId, editedFingerprint);

  const freshAttemptId = 'b'.repeat(32);
  const fresh = await handleCheckoutOrderPost(attemptRequest(freshAttemptId, editedContent), h.deps);

  assert.equal(fresh.httpStatus, 200, `a mis-bound claim may not wedge content forever: ${JSON.stringify(fresh)}`);
  assert.equal(await resolveCheckoutOrderIdForAttempt(freshAttemptId), orderIdFor(freshAttemptId));
  const repaired = JSON.parse(cells.get(poisonedPath)!.body);
  assert.equal(repaired.orderId, orderIdFor(freshAttemptId));
  assert.deepEqual(repaired.retiredOrderIds, [canonicalOrderId], 'the mis-bound order is retired, never reusable');
  assert.equal((await orderRecord(canonicalOrderId))?.childName, 'Mina', 'the other intent keeps its own order');
  assert.equal(creates(h).length, 2);
});

test('a claim pointing at an order with no proven semantic owner is never repaired', async () => {
  const editedFingerprint = await intentFingerprintOf(editedContent);
  const cells = installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);
  const canonicalOrderId = orderIdFor(attemptId);

  assert.equal(
    (await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps)).httpStatus,
    200,
  );
  // No semantic owner on the record: this store cannot prove the claim is wrong.
  await withOrderTransaction<null>(canonicalOrderId, (current) => ({
    commit: { ...current, checkoutIntentFingerprint: null },
    result: null,
  }));
  const poisonedPath = seedClaim(cells, canonicalOrderId, editedFingerprint);
  const orderPaths = () => [...cells.keys()].filter((pathname) => /orders\/ord_[a-f0-9]{16}\.json$/.test(pathname));
  const ordersBefore = orderPaths();

  const freshAttemptId = 'b'.repeat(32);
  const fresh = await handleCheckoutOrderPost(attemptRequest(freshAttemptId, editedContent), h.deps);

  assert.ok(fresh.httpStatus >= 400, JSON.stringify(fresh));
  assert.match(String(fresh.body.error), /do not pay again/i);
  assert.equal(creates(h).length, 1, 'unprovable ownership may not mint a second Session');
  assert.equal(
    JSON.parse(cells.get(poisonedPath)!.body).orderId,
    canonicalOrderId,
    'an unprovable claim is left exactly as found',
  );
  assert.deepEqual(orderPaths(), ordersBefore, 'and no second durable order is created behind it');
  assert.equal(
    await resolveCheckoutOrderIdForAttempt(freshAttemptId),
    canonicalOrderId,
    'the attempt stays addressable through the canonical order it reconciled against',
  );
});

// ---------------------------------------------------------------------------
// The whole recovery path: open → protected, terminal → restart → fresh buy
// ---------------------------------------------------------------------------
// The restart decision runs on the SAME durable primitives the two attempt
// routes hand it (`checkoutAttemptRestartDependencies`), against the same order
// store this handler just wrote — only the provider read is a double, because
// only Stripe can say what a Session became.

async function restartDecision(
  attemptId: string,
  session: CheckoutAttemptProviderSession,
) {
  return resolveCheckoutAttemptRestart(attemptId, checkoutAttemptRestartDependencies({
    resolveOrderId: resolveCheckoutOrderIdForAttempt,
    getOrder: getOrderAuthoritative,
    retrieveSession: async () => session,
    retireExpiredAttempt: retireExpiredCheckoutAttempt,
    releaseIntentClaim: releaseCheckoutIntentOrderId,
  }));
}

const PROVIDER_SESSION = {
  open: { status: 'open', payment_status: 'unpaid', payment_intent: null },
  paid: { status: 'complete', payment_status: 'paid', payment_intent: 'pi_test_1' },
  expired: { status: 'expired', payment_status: 'unpaid', payment_intent: null },
} satisfies Record<string, CheckoutAttemptProviderSession>;

test('an open attempt is protected: no restart, no release, and no second Session', async () => {
  const cells = installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);
  const canonicalOrderId = orderIdFor(attemptId);

  const first = await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps);
  assert.equal(first.httpStatus, 200, JSON.stringify(first));
  const claimBefore = structuredClone(claimPaths(cells).map((pathname) => cells.get(pathname)!.body));

  assert.deepEqual(
    await restartDecision(attemptId, PROVIDER_SESSION.open),
    { status: 'resume_required', reason: 'session_open' },
  );
  assert.deepEqual(
    claimPaths(cells).map((pathname) => cells.get(pathname)!.body),
    claimBefore,
    'an open Session may never have its semantic claim released',
  );

  // And the identical purchase from any other attempt still resumes the one
  // Session rather than minting a second payable one behind it.
  const resumed = await handleCheckoutOrderPost(attemptRequest('b'.repeat(32), originalContent), h.deps);
  assert.equal(resumed.httpStatus, 200, JSON.stringify(resumed));
  assert.equal(resumed.body.redirectTo, first.body.redirectTo);
  assert.equal(creates(h).length, 1);
  assert.equal((await orderRecord(canonicalOrderId))?.paymentStatus, 'pending');
});

for (const terminal of ['paid', 'expired'] as const) {
  test(`a ${terminal} attempt restarts authoritatively and the edited content then buys`, async () => {
    installMemoryOrderStore();
    const h = harness();
    const attemptId = 'a'.repeat(32);
    const canonicalOrderId = orderIdFor(attemptId);

    const first = await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps);
    assert.equal(first.httpStatus, 200, JSON.stringify(first));
    // The edit that was refused while the attempt was live: still no claim.
    assert.ok((await handleCheckoutOrderPost(attemptRequest(attemptId, editedContent), h.deps)).httpStatus >= 400);

    if (terminal === 'paid') {
      await withOrderTransaction<null>(canonicalOrderId, (current) => ({
        commit: { ...current, paymentStatus: 'paid', paidAt: new Date().toISOString() },
        result: null,
      }));
    }
    assert.deepEqual(
      await restartDecision(attemptId, PROVIDER_SESSION[terminal]),
      { status: 'restart_allowed', reason: terminal === 'paid' ? 'completed_paid' : 'expired_unpaid' },
    );

    // Only now may the browser rotate. The edited book is a different purchase,
    // and the restarted original content is buyable again as a repeat purchase.
    const editedAttemptId = 'b'.repeat(32);
    const repeatAttemptId = 'c'.repeat(32);
    const edited = await handleCheckoutOrderPost(attemptRequest(editedAttemptId, editedContent), h.deps);
    const repeat = await handleCheckoutOrderPost(attemptRequest(repeatAttemptId, originalContent), h.deps);

    assert.equal(edited.httpStatus, 200, JSON.stringify(edited));
    assert.equal(repeat.httpStatus, 200, JSON.stringify(repeat));
    assert.equal((await orderRecord(orderIdFor(editedAttemptId)))?.childName, 'Nora');
    assert.equal((await orderRecord(orderIdFor(repeatAttemptId)))?.childName, 'Mina');
    assert.equal(creates(h).length, 3, 'each settled purchase gets exactly one Session');
    assert.notEqual(repeat.body.redirectTo, first.body.redirectTo);
    const settledOriginal = await orderRecord(canonicalOrderId);
    assert.equal(settledOriginal?.childName, 'Mina');
    assert.equal(
      settledOriginal?.paymentStatus,
      terminal === 'paid' ? 'paid' : 'failed',
      'the restarted order keeps its own settled payment state',
    );
  });
}

test('a restart is refused while the provider answer stays ambiguous', async () => {
  const cells = installMemoryOrderStore();
  const h = harness();
  const attemptId = 'a'.repeat(32);

  assert.equal(
    (await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps)).httpStatus,
    200,
  );
  const claimBefore = structuredClone(claimPaths(cells).map((pathname) => cells.get(pathname)!.body));

  for (const session of [
    { status: 'expired', payment_status: 'unpaid' },
    { status: 'expired', payment_status: 'unpaid', payment_intent: 'pi_test_1' },
    { status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_test_1' },
  ] satisfies CheckoutAttemptProviderSession[]) {
    assert.deepEqual(
      await restartDecision(attemptId, session),
      { status: 'unknown', reason: 'provider_ambiguous' },
      JSON.stringify(session),
    );
  }
  assert.deepEqual(
    claimPaths(cells).map((pathname) => cells.get(pathname)!.body),
    claimBefore,
    'an ambiguous provider answer may never release a semantic claim',
  );
});

test('an ownership proof that cannot be written fails closed and replays cleanly', async () => {
  const cells = installMemoryOrderStore({
    rejectCreateWhen: (pathname) => /checkout-order-intent-owners\//.test(pathname),
  });
  const h = harness();
  const attemptId = 'a'.repeat(32);

  const refused = await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), h.deps);

  assert.ok(refused.httpStatus >= 400, JSON.stringify(refused));
  assert.deepEqual(h.provider, [], 'an unproven order id may never reach the provider');
  assert.deepEqual(h.uploads, [], 'nor the media stage');
  assert.deepEqual(claimPaths(cells), [], 'nor leave a claim behind');

  installMemoryOrderStore();
  const replay = harness();
  const replayed = await handleCheckoutOrderPost(attemptRequest(attemptId, originalContent), replay.deps);
  assert.equal(replayed.httpStatus, 200, JSON.stringify(replayed));
});
