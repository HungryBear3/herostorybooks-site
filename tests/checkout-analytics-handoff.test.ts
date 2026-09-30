/**
 * Checkout → Stripe continuity for the bounded analytics context.
 *
 * Drives the production `POST /api/order` handler (real validation, real order
 * CAS, real provisioning machine) and then the real route adapter in a child
 * process, and proves three things: the validated attribution is persisted on
 * the durable order, the paired GA session reaches the provider request, and
 * the Stripe Session metadata carries exactly the bounded keys and nothing a
 * buyer typed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before } from 'node:test';

import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  readOrderVersioned,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';
import {
  handleCheckoutOrderPost,
  type CheckoutOrderRouteDeps,
} from '../src/lib/checkout-order-route-handler.ts';
import type {
  ProviderCheckoutSession,
  ProviderCheckoutSessionRequest,
} from '../src/lib/checkout-session-provisioning.ts';

const ATTEMPT = 'd4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1';
const ORDER_ID = `ord_${crypto.createHash('sha256').update(ATTEMPT).digest('hex').slice(0, 16)}`;
const CLIENT = '123456789.1727500000';
const DAY = 86_400_000;

const savedEnv: Record<string, string | undefined> = {};
before(() => {
  for (const key of [
    'BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_ACCESS_MODE', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
    'HSB_CHECKOUT_PAUSED', 'STRIPE_PRODUCT_DIGITAL_ID', 'VERCEL_ENV', 'HSB_CHECKOUT_DIRECT_UPLOAD',
  ]) savedEnv[key] = process.env[key];
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

function installMemoryOrderStore(): void {
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
}

interface RouteResponse { httpStatus: number; body: Record<string, unknown> }

function harness() {
  const requests: ProviderCheckoutSessionRequest[] = [];
  const minted = new Map<string, ProviderCheckoutSession>();
  let next = 1;
  const deps: CheckoutOrderRouteDeps<RouteResponse> = {
    json: (body, httpStatus) => ({ httpStatus, body }),
    async createCheckoutSession(request) {
      requests.push(request);
      const session: ProviderCheckoutSession = {
        id: `cs_test_handoff${next++}`,
        url: `https://checkout.stripe.test/${request.order.id}/${next - 1}`,
        status: 'open',
        payment_status: 'unpaid',
        payment_intent: null,
      };
      minted.set(session.id, session);
      return session;
    },
    async retrieveCheckoutSession(sessionId) {
      const found = minted.get(sessionId);
      if (!found) throw new Error('session unavailable');
      return found;
    },
    createIntakeStore() { throw new Error('the legacy path never constructs the private intake store'); },
    async uploadOrderPhoto() { throw new Error('no photo is uploaded in this suite'); },
    async uploadOrderSupportingPhoto() { throw new Error('no supporting photo is uploaded in this suite'); },
    async uploadOrderVoice() { throw new Error('no voice note is uploaded in this suite'); },
    async uploadOrderDocument() { throw new Error('no document is uploaded in this suite'); },
    async rollbackOrderMediaUploads() { return 0; },
    async markRecoveryLeadConverted() { return null; },
    logError: () => {},
  };
  return { deps, requests, minted };
}

function checkoutForm(): FormData {
  const form = new FormData();
  form.set('checkoutAttemptId', ATTEMPT);
  form.set('childName', 'Mina');
  form.set('email', 'buyer@example.com');
  form.set('bookFormat', 'digital');
  form.set('theme', 'space-adventure');
  form.set('characterNotes', 'Curly hair, always wearing a red cape');
  return form;
}

const post = (form: FormData) => new Request('https://preview.test/api/order', { method: 'POST', body: form });

/** Captured a few days ago, so the state is valid whenever this suite runs. */
function recentState() {
  return {
    version: 1,
    firstTouch: {
      source: 'facebook', medium: 'paid_social', campaign: '2026-10-gifts', content: null, term: null,
      landingPath: '/gifts/birthdays', capturedAt: new Date(Date.now() - 3 * DAY).toISOString(),
    },
    lastNonDirectTouch: {
      source: 'newsletter', medium: 'email', campaign: null, content: null, term: null,
      landingPath: '/', capturedAt: new Date(Date.now() - DAY).toISOString(),
    },
  };
}

async function stored(): Promise<OrderRecord | null> {
  return (await readOrderVersioned(ORDER_ID, { preferRecentCommit: true }))?.order ?? null;
}

test('validated attribution and a paired GA session reach the provider request and the durable order', async () => {
  installMemoryOrderStore();
  const h = harness();
  const state = recentState();
  const form = checkoutForm();
  form.set('gaClientId', CLIENT);
  form.set('gaSessionId', '1727500000');
  form.set('gaSessionNumber', '3');
  form.set('attribution', JSON.stringify(state));

  const response = await handleCheckoutOrderPost(post(form), h.deps);
  assert.equal(response.httpStatus, 200, JSON.stringify(response.body));
  assert.equal(h.requests.length, 1);
  const [request] = h.requests;
  assert.equal(request.gaClientId, CLIENT);
  assert.deepEqual(request.analytics, { gaSessionId: '1727500000', gaSessionNumber: '3' });
  assert.deepEqual(request.order.checkoutAttribution, state);
  assert.deepEqual((await stored())?.checkoutAttribution, state);
});

test('hostile analytics fields are dropped before the provider request and the durable order', async () => {
  installMemoryOrderStore();
  const h = harness();
  const state = recentState();
  const form = checkoutForm();
  form.set('gaClientId', CLIENT);
  form.set('gaSessionId', '1727500000');
  form.set('gaSessionNumber', 'ZQX-7731');
  form.set('attribution', JSON.stringify({
    ...state,
    firstTouch: { ...state.firstTouch, term: 'zqx.parent.7731@example.invalid' },
  }));

  const response = await handleCheckoutOrderPost(post(form), h.deps);
  assert.equal(response.httpStatus, 200, JSON.stringify(response.body));
  const [request] = h.requests;
  assert.deepEqual(request.analytics, { gaSessionId: null, gaSessionNumber: null });
  assert.equal(request.order.checkoutAttribution, undefined);
  const persisted = await stored();
  assert.ok(persisted);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'checkoutAttribution'), false);
  assert.doesNotMatch(JSON.stringify({ request, persisted }), /ZQX|zqx|example\.invalid/);
});

test('a checkout without analytics fields keeps the pre-existing order shape', async () => {
  installMemoryOrderStore();
  const h = harness();
  const response = await handleCheckoutOrderPost(post(checkoutForm()), h.deps);
  assert.equal(response.httpStatus, 200, JSON.stringify(response.body));
  assert.equal(h.requests[0].gaClientId, null);
  assert.deepEqual(h.requests[0].analytics, { gaSessionId: null, gaSessionNumber: null });
  assert.equal(Object.prototype.hasOwnProperty.call(await stored(), 'checkoutAttribution'), false);
});

test('a replacement Session minted on a later retry carries that retry’s own GA session', async () => {
  installMemoryOrderStore();
  const h = harness();
  const first = checkoutForm();
  first.set('gaClientId', CLIENT);
  first.set('gaSessionId', '1727500000');
  first.set('gaSessionNumber', '3');
  const initial = await handleCheckoutOrderPost(post(first), h.deps);
  assert.equal(initial.httpStatus, 200, JSON.stringify(initial.body));

  // The provider expires the first Session unpaid; the buyer returns later.
  for (const session of h.minted.values()) session.status = 'expired';
  const retry = checkoutForm();
  retry.set('gaClientId', CLIENT);
  retry.set('gaSessionId', '1727600000');
  retry.set('gaSessionNumber', '4');
  const resumed = await handleCheckoutOrderPost(post(retry), h.deps);

  assert.equal(resumed.httpStatus, 200, JSON.stringify(resumed.body));
  assert.equal(h.requests.length, 2, 'the expired Session is replaced exactly once');
  assert.deepEqual(h.requests[1].analytics, { gaSessionId: '1727600000', gaSessionNumber: '4' });
});

// ── The real route adapter, in a child process ─────────────────────────────

interface JournalEntry { surface: string; op: string; detail: Record<string, unknown> | null }

test('the Stripe Session metadata carries exactly the bounded analytics keys', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-analytics-route-'));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Synthetic token: it only selects the versioned-store code path, which
      // the scenario backs with an in-memory adapter. @vercel/blob is a fake.
      BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_teststore_testsecret',
      HSB_BLOB_ACCESS_MODE: 'private',
      HSB_REQUIRE_DURABLE_PERSISTENCE: 'true',
      HSB_PAYMENT_RECOVERY_STORE_DIR: path.join(root, 'recovery'),
      STRIPE_PRODUCT_DIGITAL_ID: 'prod_TestDigital',
      STRIPE_SECRET_KEY: 'sk_test_journalled',
      HSB_CHECKOUT_PAUSED: 'false',
    };
    for (const key of ['VERCEL', 'VERCEL_ENV', 'HSB_CHECKOUT_DIRECT_UPLOAD', 'HSB_ORDER_STORE_DIR']) {
      delete env[key];
    }
    const raw = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--import',
        path.resolve(process.cwd(), 'tests/helpers/order-route-register.mjs'),
        path.resolve(process.cwd(), 'tests/helpers/checkout-analytics-route-scenario.mjs'),
      ],
      { encoding: 'utf8', cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const match = raw.match(/__SCENARIO_JSON__([\s\S]*?)__END__/);
    assert.ok(match, `scenario produced no result payload:\n${raw}`);
    const result = JSON.parse(match[1]!) as {
      status: number;
      body: Record<string, unknown> | null;
      attemptId: string;
      state: ReturnType<typeof recentState>;
      journal: JournalEntry[];
    };

    assert.equal(result.status, 200, JSON.stringify(result.body));
    const creates = result.journal.filter((entry) => entry.op === 'checkout.sessions.create');
    assert.equal(creates.length, 1);
    const orderId = `ord_${crypto.createHash('sha256').update(result.attemptId).digest('hex').slice(0, 16)}`;
    assert.deepEqual(creates[0].detail?.metadata, {
      orderId,
      gaClientId: CLIENT,
      hsbAttrV: '1',
      hsbFtSrc: 'facebook',
      hsbFtMed: 'paid_social',
      hsbFtCmp: '2026-10-gifts',
      hsbFtPath: '/gifts/birthdays',
      hsbFtAt: result.state.firstTouch.capturedAt,
      hsbLtSrc: 'newsletter',
      hsbLtMed: 'email',
      hsbLtPath: '/',
      hsbLtAt: result.state.lastNonDirectTouch.capturedAt,
      gaSessionId: '1727500000',
      gaSessionNumber: '3',
    });
    assert.doesNotMatch(JSON.stringify(creates[0].detail?.metadata), /ZQX|Mina|buyer@|red cape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
