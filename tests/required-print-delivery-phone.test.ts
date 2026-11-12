/**
 * Required delivery phone for printed books (standard lane).
 *
 * Stripe hosted Checkout collects the shipping address AND a phone number for
 * standard print orders; the signed webhook persists the recipient name and
 * phone on the order's ShippingAddress from exactly one coherent Stripe shape
 * (current `collected_information.shipping_details` + current
 * `customer_details.phone`, or the legacy top-level `shipping_details`); Lulu
 * receives the saved name and phone (never the child's name or a dummy
 * number); a standard print order with no usable delivery contact is refused
 * before any provider call; the quote-only fallback phone is validated before
 * auth; and the expedited lane, whose contact lives in its private draft, is
 * not gated on `order.shippingAddress`.
 *
 * Behavioural witnesses import only modules that already exist. The new
 * helper module is loaded lazily inside its own tests so that a missing
 * module fails only those tests, separately from missing behaviour.
 *
 * Every network call is intercepted: nothing leaves the host.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Stripe from 'stripe';

import { POST as stripeWebhookPost } from '../src/app/api/webhooks/stripe/route.ts';
import { createOrderRecord, getOrder, persistOrder, type OrderRecord, type PageArtifact } from '../src/lib/orders.ts';
import { calculatePrintJobCost, clearTokenCache, submitPrintJob } from '../src/lib/lulu.ts';
import { approvePrintProof, proofSourceFingerprint, type FulfillmentDeps } from '../src/lib/fulfillment.ts';
import { ensureRecommendedTextLayout, NEW_PROOF_LAYOUT_VERSION } from '../src/lib/fulfillment-types.ts';
import { fillerPage, padPageSet } from './support/full-page-set.ts';

const PHONE_E164 = '+13125550100';
const RECIPIENT = 'Alexy Kaplun';
const ADDRESS = { line1: '1234 N Broadway', line2: null, city: 'Chicago', state: 'IL', zip: '60640', country: 'US' };
const STRIPE_ADDRESS = { line1: '1234 N Broadway', line2: null, city: 'Chicago', state: 'IL', postal_code: '60640', country: 'US' };
const STALE_STRIPE_ADDRESS = { ...STRIPE_ADDRESS, line1: '999 Stale Lane' };

function contactModule() {
  return import('../src/lib/print-delivery-contact.ts');
}

// ── Helper contract (new module; a missing module fails only these) ──────────

test('helper: normalizeDeliveryPhone keeps a dialable number and rejects blanks, letters, junk and the dummy zero number', async () => {
  const { normalizeDeliveryPhone } = await contactModule();
  assert.equal(normalizeDeliveryPhone('+1 (312) 555-0100'), PHONE_E164);
  assert.equal(normalizeDeliveryPhone(PHONE_E164), PHONE_E164);
  assert.equal(normalizeDeliveryPhone('312-555-0100'), '3125550100');
  assert.equal(normalizeDeliveryPhone('  +13125550100  '), PHONE_E164);
  for (const bad of ['', '   ', null, undefined, 42, 'call me', 'call 312-555-0100', '312-555-0100 ext 4', '+1', '000-000-0000', '+1234567890123456']) {
    assert.equal(normalizeDeliveryPhone(bad), null, String(bad));
  }
});

test('helper: current Stripe shape uses collected_information.shipping_details + customer_details.phone', async () => {
  const { extractStripeShippingAddress } = await contactModule();
  assert.deepEqual(extractStripeShippingAddress({
    customer_details: { name: 'Card Holder', phone: PHONE_E164, email: 'buyer@example.invalid' },
    collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
  }), { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 });
});

test('helper: a current address never takes a legacy-shape name, address or phone', async () => {
  const { extractStripeShippingAddress } = await contactModule();
  assert.deepEqual(extractStripeShippingAddress({
    customer_details: { name: 'Card Holder', phone: PHONE_E164 },
    collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
    shipping_details: { name: 'Stale Recipient', phone: '+17775550199', address: STALE_STRIPE_ADDRESS },
  }), { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 });
  // No current phone: the legacy phone belongs to a different address and is never borrowed.
  assert.deepEqual(extractStripeShippingAddress({
    collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
    shipping_details: { name: 'Stale Recipient', phone: '+17775550199', address: STALE_STRIPE_ADDRESS },
  }), { ...ADDRESS, name: RECIPIENT, phone: null });
});

test('helper: legacy shape uses its own phone, else customer_details.phone', async () => {
  const { extractStripeShippingAddress } = await contactModule();
  assert.deepEqual(extractStripeShippingAddress({
    shipping_details: { name: RECIPIENT, phone: '312-555-0100', address: STRIPE_ADDRESS },
  }), { ...ADDRESS, name: RECIPIENT, phone: '3125550100' });
  assert.deepEqual(extractStripeShippingAddress({
    customer_details: { phone: PHONE_E164 },
    shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS },
  }), { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 });
});

test('helper: unusable phones are recorded as null and no address means no address', async () => {
  const { extractStripeShippingAddress } = await contactModule();
  assert.deepEqual(extractStripeShippingAddress({
    collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
  }), { ...ADDRESS, name: RECIPIENT, phone: null });
  assert.equal(extractStripeShippingAddress({
    customer_details: { phone: 'n/a' },
    shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS },
  })?.phone, null);
  assert.equal(extractStripeShippingAddress({ customer_details: { phone: PHONE_E164, name: RECIPIENT } }), undefined);
  assert.equal(extractStripeShippingAddress({}), undefined);
});

test('helper: printDeliveryContactRefusal names what is missing', async () => {
  const { printDeliveryContactRefusal } = await contactModule();
  assert.equal(printDeliveryContactRefusal(undefined), 'shipping_address_missing');
  assert.equal(printDeliveryContactRefusal(null), 'shipping_address_missing');
  assert.equal(printDeliveryContactRefusal({ ...ADDRESS }), 'shipping_contact_missing');
  assert.equal(printDeliveryContactRefusal({ ...ADDRESS, name: RECIPIENT, phone: null }), 'shipping_contact_missing');
  assert.equal(printDeliveryContactRefusal({ ...ADDRESS, name: '', phone: PHONE_E164 }), 'shipping_contact_missing');
  assert.equal(printDeliveryContactRefusal({ ...ADDRESS, name: RECIPIENT, phone: '000-000-0000' }), 'shipping_contact_missing');
  assert.equal(printDeliveryContactRefusal({ ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 }), null);
});

// ── The real signed webhook persists the delivery contact ─────────────────────

const WEBHOOK_SECRET = 'whsec_hsb_print_phone_local_test';
const STRIPE_KEY = 'sk_test_hsb_print_phone_local_test';
const MANAGED_ENV = [
  'HSB_ORDER_STORE_DIR', 'HSB_PAYMENT_RECOVERY_STORE_DIR', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VERCEL_ENV', 'VERCEL', 'BLOB_READ_WRITE_TOKEN',
  'GA4_MEASUREMENT_ID', 'GA4_API_SECRET', 'NEXT_PUBLIC_GA_MEASUREMENT_ID',
  'RESEND_API_KEY', 'HSB_RESEND_API_KEY', 'HSB_CONTROL_PLANE_SHADOW', 'LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET',
  'HSB_INITIAL_EXPEDITED_QUOTES_ENABLED', 'HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED', 'HSB_INITIAL_EXPEDITED_PROVIDER_QUALIFICATION',
] as const;

function setupStore() {
  const saved = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-print-phone-webhook-'));
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.HSB_ORDER_STORE_DIR = path.join(root, 'orders');
  process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(root, 'recovery');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  return () => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function seedPendingPrintOrder(hex: string): Promise<OrderRecord> {
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'ZQX-CHILD-7731', bookFormat: 'classic', email: 'zqx.parent.7731@example.invalid' },
      { id: `ord_${hex}`, now: new Date().toISOString() },
    ),
    stripeSessionId: `cs_test_${hex}`,
    paymentStatus: 'pending',
    // Operator-held: the kickoff the webhook schedules refuses without any
    // provider call, so the test exercises payment + address persistence only.
    fulfillmentMode: 'manual_hold',
  };
  await persistOrder(order);
  return order;
}

function completedEvent(order: OrderRecord, sessionOverrides: Record<string, unknown>) {
  return {
    id: `evt_${order.id.slice(4)}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: 1_800_000_000,
    data: {
      object: {
        id: order.stripeSessionId,
        object: 'checkout.session',
        client_reference_id: order.id,
        metadata: { orderId: order.id },
        payment_intent: `pi_${order.id.slice(4)}`,
        amount_total: order.priceCents,
        amount_subtotal: order.priceCents,
        currency: 'usd',
        mode: 'payment',
        payment_status: 'paid',
        ...sessionOverrides,
      },
    },
  };
}

function signed(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const signature = new Stripe(STRIPE_KEY).webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return new Request('http://127.0.0.1/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

const CONFIRMATION_EMAIL_SETTLED = /^\[confirmation-email\] setImmediate (?:completed|failed|joined failed send) for /;
const FULFILLMENT_KICKOFF_SETTLED = /^\[webhook\]\[kickoff:[^\]]+\] \[setImmediate\] chain exited:/;

async function runWebhook(event: Record<string, unknown>): Promise<{ response: Response; lines: string[]; fetches: number }> {
  const lines: string[] = [];
  let fetches = 0;
  const sinks = ['error', 'warn', 'log', 'info'] as const;
  const originals = sinks.map((sink) => console[sink]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetches += 1; throw new Error('this test must make no network call'); }) as typeof fetch;
  for (const sink of sinks) {
    console[sink] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
  }
  try {
    const response = await stripeWebhookPost(signed(event));
    const markers = [CONFIRMATION_EMAIL_SETTLED, FULFILLMENT_KICKOFF_SETTLED];
    const expiry = Date.now() + 30_000;
    while (!markers.every((marker) => lines.some((line) => marker.test(line))) && Date.now() < expiry) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(markers.every((marker) => lines.some((line) => marker.test(line))), `deferred webhook work did not settle:\n${lines.join('\n')}`);
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return { response, lines: [...lines], fetches };
  } finally {
    sinks.forEach((sink, index) => { console[sink] = originals[index]; });
    globalThis.fetch = realFetch;
  }
}

test('webhook: current Stripe shape persists recipient name and phone on the paid print order, leaking neither', async () => {
  const restore = setupStore();
  try {
    const order = await seedPendingPrintOrder('print_phone_current');
    const { response, lines, fetches } = await runWebhook(completedEvent(order, {
      customer_details: { name: 'Card Holder', phone: PHONE_E164, email: order.email },
      collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
    }));
    assert.equal(response.status, 200);
    assert.equal(fetches, 0);
    const stored = (await getOrder(order.id))!;
    assert.equal(stored.paymentStatus, 'paid');
    assert.deepEqual(stored.shippingAddress, { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 });
    const log = lines.join('\n');
    assert.doesNotMatch(log, /3125550100|Kaplun|Broadway/, 'delivery contact must never reach the shared runtime log');
    assert.doesNotMatch(JSON.stringify(stored.auditEvents ?? []), /3125550100|Kaplun|Broadway/, 'audit events carry no delivery contact');
  } finally {
    restore();
  }
});

test('webhook: a current address with a stale legacy block keeps the current address and current phone only', async () => {
  const restore = setupStore();
  try {
    const order = await seedPendingPrintOrder('print_phone_stale');
    const { response } = await runWebhook(completedEvent(order, {
      customer_details: { name: 'Card Holder', phone: PHONE_E164, email: order.email },
      collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
      shipping_details: { name: 'Stale Recipient', phone: '+17775550199', address: STALE_STRIPE_ADDRESS },
    }));
    assert.equal(response.status, 200);
    const stored = (await getOrder(order.id))!;
    assert.equal(stored.paymentStatus, 'paid');
    assert.deepEqual(stored.shippingAddress, { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 });
  } finally {
    restore();
  }
});

test('webhook: a current address without a current phone never borrows the legacy-address phone', async () => {
  const restore = setupStore();
  try {
    const order = await seedPendingPrintOrder('print_phone_nomix');
    const { response } = await runWebhook(completedEvent(order, {
      customer_details: { name: 'Card Holder', email: order.email },
      collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
      shipping_details: { name: 'Stale Recipient', phone: '+17775550199', address: STALE_STRIPE_ADDRESS },
    }));
    assert.equal(response.status, 200);
    const stored = (await getOrder(order.id))!;
    assert.equal(stored.paymentStatus, 'paid');
    assert.deepEqual(stored.shippingAddress, { ...ADDRESS, name: RECIPIENT, phone: null });
  } finally {
    restore();
  }
});

test('webhook: a current-shape phone with letters is recorded as no phone', async () => {
  const restore = setupStore();
  try {
    const order = await seedPendingPrintOrder('print_phone_letters');
    const { response } = await runWebhook(completedEvent(order, {
      customer_details: { name: 'Card Holder', phone: 'call 312-555-0100', email: order.email },
      collected_information: { shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS } },
    }));
    assert.equal(response.status, 200);
    const stored = (await getOrder(order.id))!;
    assert.equal(stored.paymentStatus, 'paid');
    assert.deepEqual(stored.shippingAddress, { ...ADDRESS, name: RECIPIENT, phone: null });
  } finally {
    restore();
  }
});

test('webhook: legacy Stripe shape (top-level shipping_details) persists the same contact', async () => {
  const restore = setupStore();
  try {
    const order = await seedPendingPrintOrder('print_phone_legacy');
    const { response } = await runWebhook(completedEvent(order, {
      shipping_details: { name: RECIPIENT, phone: '(312) 555-0100', address: STRIPE_ADDRESS },
    }));
    assert.equal(response.status, 200);
    const stored = (await getOrder(order.id))!;
    assert.equal(stored.paymentStatus, 'paid');
    assert.deepEqual(stored.shippingAddress, { ...ADDRESS, name: RECIPIENT, phone: '3125550100' });
  } finally {
    restore();
  }
});

test('webhook: a legacy Session with no phone still settles the payment and records no phone', async () => {
  const restore = setupStore();
  try {
    const order = await seedPendingPrintOrder('print_phone_nophone');
    const { response } = await runWebhook(completedEvent(order, {
      shipping_details: { name: RECIPIENT, address: STRIPE_ADDRESS },
    }));
    assert.equal(response.status, 200);
    const stored = (await getOrder(order.id))!;
    assert.equal(stored.paymentStatus, 'paid');
    assert.equal(stored.settledAmountCents, order.priceCents);
    assert.deepEqual(stored.shippingAddress, { ...ADDRESS, name: RECIPIENT, phone: null });
  } finally {
    restore();
  }
});

// ── Lulu uses the saved contact and refuses to call out without it ────────────

const TOKEN_RESPONSE = { access_token: 'tok_test', expires_in: 3600, token_type: 'Bearer' };

function withLulu(env: Record<string, string>, fn: () => Promise<void>) {
  return async () => {
    const keys = ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_FALLBACK_PHONE', 'LULU_API_URL', 'HSB_SUPPORT_EMAIL', 'EMAIL_FROM'];
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    clearTokenCache();
    for (const key of keys) delete process.env[key];
    process.env.LULU_CLIENT_KEY = 'k';
    process.env.LULU_CLIENT_SECRET = 's';
    Object.assign(process.env, env);
    try {
      await fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      clearTokenCache();
    }
  };
}

function printReadyOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: 'Luna', bookFormat: 'classic', email: 'luna@example.invalid' },
      { id: 'ord_print_phone_lulu', now: '2026-10-29T10:00:00Z' },
    ),
    paymentStatus: 'paid',
    printTitle: "Luna's Great Adventure",
    printInteriorArtifactUrl: 'https://cdn.example.invalid/interior.pdf',
    printInteriorMd5: 'INTERIORMD5',
    printInteriorPageCount: 32,
    printCoverArtifactUrl: 'https://cdn.example.invalid/cover.pdf',
    printCoverMd5: 'COVERMD5',
    shippingAddress: { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 },
    ...overrides,
  };
}

function recordingFetch(seen: { url: string; body: string }[]) {
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(url), body: String(init?.body ?? '') });
    if (String(url).includes('openid-connect/token')) return new Response(JSON.stringify(TOKEN_RESPONSE), { status: 200 });
    if (String(url).endsWith('/print-jobs/')) return new Response(JSON.stringify({ id: 4242, status: 'CREATED' }), { status: 201 });
    return new Response(JSON.stringify({ total_cost_incl_tax: '17.33', total_cost_excl_tax: '15.00', currency: 'USD', line_item_costs: [], shipping_cost: { total_cost_excl_tax: '4.49', total_cost_incl_tax: '4.49' }, fulfillment_cost: { total_cost_excl_tax: '1.50', total_cost_incl_tax: '1.50' }, total_tax: '2.00' }), { status: 201 });
  };
}

test('submitPrintJob ships to the saved recipient name and phone, never the child name or the fallback phone', withLulu({ LULU_FALLBACK_PHONE: '312-555-0199' }, async () => {
  const seen: { url: string; body: string }[] = [];
  await submitPrintJob(printReadyOrder(), { fetch: recordingFetch(seen) });
  const job = seen.find((call) => call.url.endsWith('/print-jobs/'))!;
  const shipping = JSON.parse(job.body).shipping_address;
  assert.equal(shipping.name, RECIPIENT);
  assert.equal(shipping.phone_number, PHONE_E164);
  assert.equal(shipping.street1, ADDRESS.line1);
  assert.notEqual(shipping.name, 'Luna');
}));

test('submitPrintJob refuses before any network call when the phone is missing, even with a fallback configured', withLulu({ LULU_FALLBACK_PHONE: '312-555-0199' }, async () => {
  const seen: { url: string; body: string }[] = [];
  await assert.rejects(
    submitPrintJob(printReadyOrder({ shippingAddress: { ...ADDRESS, name: RECIPIENT } }), { fetch: recordingFetch(seen) }),
    /shipping_contact_missing/,
  );
  await assert.rejects(
    submitPrintJob(printReadyOrder({ shippingAddress: { ...ADDRESS, name: RECIPIENT, phone: 'call 312-555-0100' } }), { fetch: recordingFetch(seen) }),
    /shipping_contact_missing/,
  );
  assert.equal(seen.length, 0, 'no auth or print-job request may be made');
}));

test('submitPrintJob refuses before any network call when the recipient name or whole address is missing', withLulu({}, async () => {
  const seen: { url: string; body: string }[] = [];
  await assert.rejects(
    submitPrintJob(printReadyOrder({ shippingAddress: { ...ADDRESS, phone: PHONE_E164 } }), { fetch: recordingFetch(seen) }),
    /shipping_contact_missing/,
  );
  await assert.rejects(
    submitPrintJob(printReadyOrder({ shippingAddress: null }), { fetch: recordingFetch(seen) }),
    /shipping_address_missing/,
  );
  assert.equal(seen.length, 0);
}));

test('calculatePrintJobCost prefers the saved phone, uses the normalized operator fallback for quotes only', withLulu({ LULU_FALLBACK_PHONE: '312-555-0199' }, async () => {
  const seen: { url: string; body: string }[] = [];
  await calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 }, shippingLevel: 'MAIL' }, { fetch: recordingFetch(seen) });
  assert.equal(JSON.parse(seen.at(-1)!.body).shipping_address.phone_number, PHONE_E164);
  await calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: { ...ADDRESS, name: RECIPIENT }, shippingLevel: 'MAIL' }, { fetch: recordingFetch(seen) });
  assert.equal(JSON.parse(seen.at(-1)!.body).shipping_address.phone_number, '3125550199');
}));

test('calculatePrintJobCost with no phone and no fallback fails before any network call', withLulu({}, async () => {
  const seen: { url: string; body: string }[] = [];
  await assert.rejects(
    calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: { ...ADDRESS, name: RECIPIENT }, shippingLevel: 'MAIL' }, { fetch: recordingFetch(seen) }),
    /phone/,
  );
  assert.equal(seen.length, 0);
}));

test('calculatePrintJobCost rejects a non-dialable fallback before any network call', withLulu({ LULU_FALLBACK_PHONE: 'call the office' }, async () => {
  const seen: { url: string; body: string }[] = [];
  await assert.rejects(
    calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: { ...ADDRESS, name: RECIPIENT }, shippingLevel: 'MAIL' }, { fetch: recordingFetch(seen) }),
    /phone/,
  );
  await assert.rejects(
    calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: { ...ADDRESS, name: RECIPIENT, phone: 'n/a' }, shippingLevel: 'MAIL' }, { fetch: recordingFetch(seen) }),
    /phone/,
  );
  assert.equal(seen.length, 0);
}));

// ── The print-release gate refuses before cover dimensions or submission ──────

const PROOF_TOKEN = 'synthetic-proof-token';
const NOW = '2026-10-29T12:00:00.000Z';

function completePages(): PageArtifact[] {
  return padPageSet([fillerPage(0)]).map((page) => ({ ...page, textLayout: ensureRecommendedTextLayout(page.textLayout) }));
}

function proofApprovedPrintOrder(id: string, overrides: Partial<OrderRecord>): OrderRecord {
  const order: OrderRecord = {
    ...createOrderRecord(
      { childName: 'Synthetic Hero', bookFormat: 'classic', email: 'synthetic@example.invalid' },
      { id, now: NOW },
    ),
    paymentStatus: 'paid',
    status: 'preview_ready',
    fulfillmentStatus: 'proof_ready',
    reviewStatus: 'approved',
    layoutVersion: NEW_PROOF_LAYOUT_VERSION,
    pageArtifacts: completePages(),
    storyArtifactUrl: `https://example.invalid/${id}/proof.pdf`,
    proofVersion: 'proof-v1',
    proofSourceFingerprint: null,
    proofReviewedAt: NOW,
    proofReviewedVersion: 'proof-v1',
    proofApprovalToken: PROOF_TOKEN,
    printInteriorArtifactUrl: `https://example.invalid/${id}/interior.pdf`,
    printInteriorMd5: 'synthetic-interior-md5',
    printInteriorPageCount: 32,
    printInteriorProofVersion: 'proof-v1',
    printTitle: 'Synthetic Hero Story',
    ...overrides,
  };
  order.proofSourceFingerprint = proofSourceFingerprint(order);
  return order;
}

function withOrderStore(fn: () => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-print-phone-gate-'));
    const saved = { store: process.env.HSB_ORDER_STORE_DIR, blob: process.env.BLOB_READ_WRITE_TOKEN, durable: process.env.HSB_REQUIRE_DURABLE_PERSISTENCE };
    process.env.HSB_ORDER_STORE_DIR = dir;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.HSB_REQUIRE_DURABLE_PERSISTENCE;
    for (const key of ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'RESEND_API_KEY', 'HSB_RESEND_API_KEY']) delete process.env[key];
    try {
      await fn();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (saved.store === undefined) delete process.env.HSB_ORDER_STORE_DIR; else process.env.HSB_ORDER_STORE_DIR = saved.store;
      if (saved.blob !== undefined) process.env.BLOB_READ_WRITE_TOKEN = saved.blob;
      if (saved.durable !== undefined) process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = saved.durable;
    }
  };
}

function countingDeps(calls: { cover: number; submit: number }, onSubmit?: (order: OrderRecord) => void): FulfillmentDeps {
  return {
    calculateCoverDimensions: async () => { calls.cover += 1; return { widthPt: 1200, heightPt: 650 }; },
    buildPrintCoverPdf: () => Buffer.from('%PDF synthetic cover'),
    uploadArtifact: async (id, _buffer, filename) => `https://example.invalid/${id}/${filename}`,
    submitPrint: async (order) => { calls.submit += 1; onSubmit?.(order); return { jobId: 'synthetic-print-job' }; },
    sleep: async () => {},
  };
}

test('approvePrintProof refuses a standard print order without a delivery phone before any provider call', withOrderStore(async () => {
  const calls = { cover: 0, submit: 0 };
  await persistOrder(proofApprovedPrintOrder('ord_gate_no_phone', { shippingAddress: { ...ADDRESS, name: RECIPIENT } }));
  const result = await approvePrintProof('ord_gate_no_phone', PROOF_TOKEN, countingDeps(calls));
  assert.deepEqual(result, { ok: false, error: 'shipping_contact_missing' });
  assert.deepEqual(calls, { cover: 0, submit: 0 });
  const after = (await getOrder('ord_gate_no_phone'))!;
  assert.equal(after.fulfillmentStatus, 'proof_ready', 'no claim is taken when the contact is missing');
  assert.equal(after.printSubmissionAttemptedAt ?? null, null);
  assert.equal(after.printJobId ?? null, null);
}));

test('approvePrintProof submits a standard print order whose saved contact is complete', withOrderStore(async () => {
  const calls = { cover: 0, submit: 0 };
  let submitted: OrderRecord | null = null;
  await persistOrder(proofApprovedPrintOrder('ord_gate_with_phone', { shippingAddress: { ...ADDRESS, name: RECIPIENT, phone: PHONE_E164 } }));
  const result = await approvePrintProof('ord_gate_with_phone', PROOF_TOKEN, countingDeps(calls, (order) => { submitted = order; }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.submit, 1);
  assert.equal(submitted!.shippingAddress?.phone, PHONE_E164);
  assert.equal((await getOrder('ord_gate_with_phone'))!.printJobId, 'synthetic-print-job');
}));

test('approvePrintProof on a non-standard (expedited-held) order is decided by the shipping hold, never the standard contact gate', withOrderStore(async () => {
  // The expedited lane keeps its delivery contact in the private draft, not on
  // order.shippingAddress. The standard contact gate must not pre-empt it.
  const calls = { cover: 0, submit: 0 };
  await persistOrder(proofApprovedPrintOrder('ord_gate_expedited_held', {
    shippingAddress: null,
    initialShipping: { version: 99 } as unknown as OrderRecord['initialShipping'],
  }));
  const result = await approvePrintProof('ord_gate_expedited_held', PROOF_TOKEN, countingDeps(calls));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'shipping_hold');
  assert.deepEqual(calls, { cover: 0, submit: 0 });
  const after = (await getOrder('ord_gate_expedited_held'))!;
  assert.match(after.fulfillmentLastError ?? '', /^shipping_hold:/);
  assert.equal(after.printSubmissionAttemptedAt ?? null, null);
}));

// ── Supplemental source guards (not behavioural evidence) ─────────────────────

test('source guard: standard /api/order Session adds required phone collection for print only; expedited params untouched', () => {
  const route = readFileSync('src/app/api/order/route.ts', 'utf8');
  const expedited = route.slice(route.indexOf('if (request.expeditedParams)'), route.indexOf('const successParams'));
  assert.ok(expedited.length > 0);
  assert.doesNotMatch(expedited, /phone_number_collection/);
  const start = route.indexOf('...(isPrintFormat(order.bookFormat)');
  assert.ok(start > -1, 'print-only branch stays gated on isPrintFormat');
  const branch = route.slice(start, route.indexOf(': {})', start));
  assert.match(branch, /shipping_address_collection:\s*\{\s*allowed_countries:\s*\[\s*'US'\s*\]/);
  assert.match(branch, /phone_number_collection:\s*\{\s*enabled:\s*true\s*\}/);
});

test('source guard: both webhook settlement sites use the shared Stripe extractor', () => {
  const route = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.match(route, /import \{[^}]*extractStripeShippingAddress[^}]*\} from '[^']*print-delivery-contact\.ts'/);
  assert.doesNotMatch(route, /function extractShipping\(/);
  assert.ok((route.match(/extractStripeShippingAddress\(session\)/g) ?? []).length >= 2);
});

test('source guard: the dummy zero phone is gone from lulu', () => {
  assert.doesNotMatch(readFileSync('src/lib/lulu.ts', 'utf8'), /000-000-0000/);
});

test('source guard: checkout copy tells standard print buyers where the delivery contact is collected', () => {
  const form = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const at = form.indexOf('shipping address and a delivery phone number');
  assert.ok(at > -1, 'print buyers must be told where the delivery contact is collected');
  const window = form.slice(Math.max(0, at - 400), at);
  assert.match(window, /bookFormat !== "digital"/, 'gated to print formats');
  assert.match(window, /shippingView\.mode !== "expedited"/, 'not shown when the expedited form collects the contact');
});

test('source guard: admin order page shows the saved recipient and phone with the address', () => {
  const page = readFileSync('src/app/admin/orders/[orderId]/page.tsx', 'utf8');
  assert.match(page, /shippingAddress\.phone/);
  assert.match(page, /shippingAddress\.name/);
  assert.match(page, /not collected; print release will refuse/);
});
