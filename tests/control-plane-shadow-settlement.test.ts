/**
 * HSB Phase B — default-off shadow settlement projection (runtime adapter).
 *
 * What this proves, and nothing more:
 *   - the adapter is OFF unless `HSB_CONTROL_PLANE_SHADOW` is exactly `'true'`,
 *     and while OFF it reads no database URL, builds no pool, and issues no SQL;
 *   - when ON it emits exactly one parameterized `hsb_control.enqueue_projection`
 *     call carrying a fixed six-key canonical payload and its SHA-256 digest;
 *   - the payload carries no buyer, provider, media, or raw-event data;
 *   - the public route-facing wrapper contains errors behind one bounded
 *     sanitized log line while its executor-taking core remains private;
 *   - the Stripe webhook calls the wrapper at both paid seams and at no other
 *     branch, and the existing acknowledgement / email / GA4 / fulfillment
 *     behaviour is byte-identical with the shadow off, succeeding, and failing.
 *
 * This is bounded non-authoritative evidence. It is best-effort, default-off,
 * and is not an order or payment transition.
 *
 * Offline: no network, no live database, no credentials.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Stripe from 'stripe';

import { POST } from '../src/app/api/webhooks/stripe/route.ts';
import {
  SHADOW_SETTLEMENT_ENTITY_KIND,
  SHADOW_SETTLEMENT_MUTATION_SEQ,
  SHADOW_SETTLEMENT_SCHEMA,
  SHADOW_SETTLEMENT_SQL,
  canonicalShadowSettlementBytes,
  recordShadowCheckoutSettlement,
  shadowSettlementDigest,
  __clearShadowSettlementWarningsForTest,
  __readShadowSettlementWarningsForTest,
  __resetShadowSettlementTestOverrides,
  __setShadowSettlementTestOverrides,
  type ShadowProjectionExecutor,
  type ShadowSettlementFacts,
  type ShadowSettlementOutcome,
} from '../src/lib/hsb-control-plane-runtime/shadow-settlement.ts';
// The hardening seams added for the runtime/security blockers are reached through
// a namespace import on purpose: a missing seam then fails the one test that needs
// it, instead of failing this whole module at link time.
import * as shadowAdapter from '../src/lib/hsb-control-plane-runtime/shadow-settlement.ts';
import {
  createOrderRecord,
  getOrder,
  persistOrder,
  type OrderRecord,
} from '../src/lib/orders.ts';

// Split so the fixture never forms a production-shaped order id on one line.
const HEX_A = '0f1e2d3c4b5a6978';
const HEX_B = '1a2b3c4d5e6f7081';
const HEX_C = '2b3c4d5e6f708192';
const HEX_D = '3c4d5e6f708192a3';
const HEX_E = '4d5e6f708192a3b4';
const HEX_F = '5e6f708192a3b4c5';
const HEX_G = '6f708192a3b4c5d6';
const HEX_H = '708192a3b4c5d6e7';

const orderIdOf = (hex: string) => `ord_${hex}`;
const sessionIdOf = (hex: string) => `cs_test_${hex}`;

const FACTS: ShadowSettlementFacts = {
  orderKey: orderIdOf(HEX_A),
  stripeSessionId: sessionIdOf(HEX_A),
  amountTotalCents: 4900,
  currency: 'usd',
};

const EXPECTED_CANONICAL =
  `{"schema":"hsb.shadow.checkout_settlement.v1"`
  + `,"orderKey":"${FACTS.orderKey}"`
  + `,"stripeSessionId":"${FACTS.stripeSessionId}"`
  + `,"amountTotalCents":4900`
  + `,"currency":"usd"`
  + `,"paymentState":"paid"}`;

/** Source-compatibility value: production must never read or invoke it. */
interface RecordedCall {
  text: string;
  values: readonly unknown[];
}

function recordingExecutor(inserted: boolean = true) {
  const calls: RecordedCall[] = [];
  const executor: ShadowProjectionExecutor = async (text, values) => {
    calls.push({ text, values });
    return { rows: [{ enqueue_projection: inserted }] };
  };
  return { calls, executor };
}

/** An env object that records every key the adapter actually reads. */
function envProbe(values: Record<string, string | undefined>) {
  const reads: string[] = [];
  const backing: Record<string, string | undefined> = { ...values };
  const env = new Proxy(backing, {
    get(target, property) {
      if (typeof property === 'string') reads.push(property);
      return target[property as string];
    },
  }) as unknown as NodeJS.ProcessEnv;
  return { reads, env };
}

// ===========================================================================
// 1. The flag. Anything but the exact string `true` is OFF.
// ===========================================================================

const OFF_FLAGS: Array<string | undefined> = [
  undefined,
  '',
  'false',
  'FALSE',
  'True',
  'TRUE',
  'tRuE',
  '1',
  '0',
  ' true',
  'true ',
  ' true ',
  'true\n',
  '\ttrue',
  'yes',
  'on',
  'enabled',
  'true,true',
];

for (const flag of OFF_FLAGS) {
  test(`shadow projection stays off for HSB_CONTROL_PLANE_SHADOW=${JSON.stringify(flag)}`, async () => {
    const { calls, executor } = recordingExecutor();
    let executorsCreated = 0;
    const { reads, env } = envProbe({
      HSB_CONTROL_PLANE_SHADOW: flag,
      HSB_CONTROL_PLANE_DATABASE_URL: 'postgres://never-read.invalid/control',
      POSTGRES_URL: 'postgres://never-read.invalid/app',
      DATABASE_URL: 'postgres://never-read.invalid/app',
      BLOB_READ_WRITE_TOKEN: 'never-read',
    });

    const outcome = await recordShadowCheckoutSettlement(FACTS, {
      env,
      executor,
      createExecutor: async () => {
        executorsCreated += 1;
        return executor;
      },
    });

    assert.deepEqual(outcome, { status: 'disabled' });
    assert.equal(calls.length, 0, 'an off shadow must issue no SQL');
    assert.equal(executorsCreated, 0, 'an off shadow must construct no pool or client');
    assert.deepEqual(
      [...new Set(reads)],
      ['HSB_CONTROL_PLANE_SHADOW'],
      'an off shadow must read the flag and nothing else',
    );
  });
}

test('exactly true turns the shadow on and reads only the flag and the control-plane URL', async () => {
  const { calls, executor } = recordingExecutor();
  const { reads, env } = envProbe({
    HSB_CONTROL_PLANE_SHADOW: 'true',
    HSB_CONTROL_PLANE_DATABASE_URL: 'postgres://harness.invalid/control',
    POSTGRES_URL: 'postgres://never-read.invalid/app',
    DATABASE_URL: 'postgres://never-read.invalid/app',
    BLOB_READ_WRITE_TOKEN: 'never-read',
  });

  const outcome = await recordShadowCheckoutSettlement(FACTS, { env, executor });

  assert.deepEqual(outcome, { status: 'recorded', inserted: true });
  assert.equal(calls.length, 1);
  assert.ok(
    !reads.includes('POSTGRES_URL') && !reads.includes('DATABASE_URL') && !reads.includes('BLOB_READ_WRITE_TOKEN'),
    `the shadow must never fall back to a general or blob URL; read ${JSON.stringify([...new Set(reads)])}`,
  );
});

// ===========================================================================
// 2. The one call, and the exact canonical bytes.
// ===========================================================================

test('an enabled shadow issues exactly one parameterized enqueue_projection call', async () => {
  const { calls, executor } = recordingExecutor();

  await recordShadowCheckoutSettlement(FACTS, {
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'SELECT hsb_control.enqueue_projection($1, $2, $3, $4::bytea, $5)');
  assert.equal(calls[0].text, SHADOW_SETTLEMENT_SQL);

  const [entityKind, entityKey, mutationSeq, payloadBytes, payloadDigest] = calls[0].values;
  assert.equal(entityKind, 'legacy_checkout_settlement');
  assert.equal(entityKind, SHADOW_SETTLEMENT_ENTITY_KIND);
  assert.equal(entityKey, FACTS.orderKey);
  assert.equal(mutationSeq, 0);
  assert.equal(mutationSeq, SHADOW_SETTLEMENT_MUTATION_SEQ);
  assert.ok(Buffer.isBuffer(payloadBytes), 'canonical payload must be passed as bytea bytes');
  assert.equal((payloadBytes as Buffer).toString('utf8'), EXPECTED_CANONICAL);
  assert.equal(payloadDigest, createHash('sha256').update(payloadBytes as Buffer).digest('hex'));
  assert.match(payloadDigest as string, /^[0-9a-f]{64}$/);
  assert.equal(calls[0].values.length, 5, 'the call takes exactly five bound parameters');
});

test('the canonical payload is the fixed six-key shape in fixed key order', () => {
  const bytes = canonicalShadowSettlementBytes(FACTS);
  assert.equal(bytes.toString('utf8'), EXPECTED_CANONICAL);
  assert.deepEqual(Object.keys(JSON.parse(bytes.toString('utf8'))), [
    'schema',
    'orderKey',
    'stripeSessionId',
    'amountTotalCents',
    'currency',
    'paymentState',
  ]);
  assert.equal(JSON.parse(bytes.toString('utf8')).schema, SHADOW_SETTLEMENT_SCHEMA);
  assert.equal(JSON.parse(bytes.toString('utf8')).paymentState, 'paid');
});

test('the canonical payload carries no buyer, provider, media, or raw-event data', () => {
  const contaminated = {
    ...FACTS,
    eventId: `evt_${HEX_A}`,
    stripePaymentIntentId: `pi_${HEX_A}`,
    email: 'buyer.contact@example.com',
    customerName: 'Wilhelmina',
    childName: 'Luna',
    shippingAddress: { line1: '1 Somewhere Way', city: 'Springfield', zip: '00000' },
    phone: '+15550100',
    photoUrl: 'https://blob.example.invalid/photo.png',
    pdfUrl: 'https://blob.example.invalid/book.pdf',
    rawEvent: { object: 'event' },
    errorMessage: 'nothing to see',
    fulfillmentStatus: 'not_started',
    accessToken: 'tok_secret',
  } as unknown as ShadowSettlementFacts;

  const text = canonicalShadowSettlementBytes(contaminated).toString('utf8');
  assert.equal(text, EXPECTED_CANONICAL);
  for (const forbidden of [
    'eventId', 'evt_', 'paymentIntent', 'pi_', 'email', '@', 'Wilhelmina', 'Luna',
    'shipping', 'Somewhere', 'phone', '5550100', 'photo', 'pdf', 'http', 'raw',
    'errorMessage', 'fulfillment', 'Token', 'token',
  ]) {
    assert.ok(!text.includes(forbidden), `canonical payload leaked ${forbidden}: ${text}`);
  }
});

test('identical settlement facts are byte-identical and digest-identical on replay', () => {
  const first = canonicalShadowSettlementBytes(FACTS);
  const reordered = canonicalShadowSettlementBytes({
    currency: FACTS.currency,
    amountTotalCents: FACTS.amountTotalCents,
    stripeSessionId: FACTS.stripeSessionId,
    orderKey: FACTS.orderKey,
  });
  assert.equal(first.toString('hex'), reordered.toString('hex'));
  assert.equal(shadowSettlementDigest(first), shadowSettlementDigest(reordered));
  assert.equal(shadowSettlementDigest(first), createHash('sha256').update(first).digest('hex'));
});

test('a different settlement under the same order produces different canonical bytes', () => {
  const different = canonicalShadowSettlementBytes({ ...FACTS, amountTotalCents: 5900 });
  assert.notEqual(different.toString('utf8'), EXPECTED_CANONICAL);
  assert.notEqual(shadowSettlementDigest(different), shadowSettlementDigest(canonicalShadowSettlementBytes(FACTS)));
});

// ===========================================================================
// 3. Validation happens before the database is touched.
// ===========================================================================

const INVALID_FACTS: Array<[string, unknown]> = [
  ['an empty order key', { ...FACTS, orderKey: '' }],
  ['an order key with whitespace', { ...FACTS, orderKey: `ord_${HEX_A} ` }],
  ['an order key with SQL punctuation', { ...FACTS, orderKey: `ord_${HEX_A}'; --` }],
  ['an order key with a slash', { ...FACTS, orderKey: `ord/${HEX_A}` }],
  ['an order key over the SQL length bound', { ...FACTS, orderKey: 'a'.repeat(129) }],
  ['a non-string order key', { ...FACTS, orderKey: 12345 }],
  ['an empty session id', { ...FACTS, stripeSessionId: '' }],
  ['a session id with SQL punctuation', { ...FACTS, stripeSessionId: `cs_${HEX_A}'; --` }],
  ['a session id that is a URL', { ...FACTS, stripeSessionId: 'https://checkout.stripe.invalid/x' }],
  ['an over-long session id', { ...FACTS, stripeSessionId: 'c'.repeat(300) }],
  ['a non-string session id', { ...FACTS, stripeSessionId: null }],
  ['a fractional amount', { ...FACTS, amountTotalCents: 49.5 }],
  ['a negative amount', { ...FACTS, amountTotalCents: -1 }],
  ['a NaN amount', { ...FACTS, amountTotalCents: Number.NaN }],
  ['an infinite amount', { ...FACTS, amountTotalCents: Number.POSITIVE_INFINITY }],
  ['an unsafe integer amount', { ...FACTS, amountTotalCents: Number.MAX_SAFE_INTEGER + 2 }],
  ['a string amount', { ...FACTS, amountTotalCents: '4900' }],
  ['a null amount', { ...FACTS, amountTotalCents: null }],
  ['an uppercase currency', { ...FACTS, currency: 'USD' }],
  ['a mixed-case currency', { ...FACTS, currency: 'Usd' }],
  ['a four-letter currency', { ...FACTS, currency: 'usdd' }],
  ['a two-letter currency', { ...FACTS, currency: 'us' }],
  ['an empty currency', { ...FACTS, currency: '' }],
  ['a null currency', { ...FACTS, currency: null }],
];

for (const [label, facts] of INVALID_FACTS) {
  test(`the public recorder refuses ${label} and still issues no SQL`, async () => {
    const { calls, executor } = recordingExecutor();
    const outcome = await recordShadowCheckoutSettlement(facts as ShadowSettlementFacts, {
      env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
      executor,
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(calls.length, 0);
  });
}

// ===========================================================================
// 4. Database errors are contained by the public recorder.
// ===========================================================================

test('the public recorder contains a database stage refusal', async () => {
  const boom = Object.assign(new Error('HSB_CONTROL_STAGE_OFF: enqueue_projection is refused'), { code: 'ZH001' });
  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: ON_ENV,
    executor: async () => { throw boom; },
  });
  assert.deepEqual(outcome, { status: 'failed', errorClass: 'Error', errorCode: 'ZH001' });
});

test('the public recorder contains a replay conflict', async () => {
  const conflict = Object.assign(new Error('HSB_CONTROL_PROJECTION_REPLAY_CONFLICT'), { code: 'ZH007' });
  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: ON_ENV,
    executor: async () => { throw conflict; },
  });
  assert.deepEqual(outcome, { status: 'failed', errorClass: 'Error', errorCode: 'ZH007' });
});

test('the best-effort wrapper swallows a stage-off refusal and logs a bounded sanitized line', async () => {
  __clearShadowSettlementWarningsForTest();
  const stageOff = Object.assign(
    new Error(
      'HSB_CONTROL_STAGE_OFF: enqueue_projection is refused while the control plane stage is off '
      + '(connection postgres://hsb_app:hunter2@db.invalid:5432/control)',
    ),
    { code: 'ZH001', stack: 'Error: secret stack frame at /Users/someone/secret.ts:1:1', detail: 'buyer@example.com' },
  );

  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor: async () => { throw stageOff; },
  });

  assert.deepEqual(outcome, { status: 'failed', errorClass: 'Error', errorCode: 'ZH001' });
  const warnings = __readShadowSettlementWarningsForTest();
  assert.equal(warnings.length, 1);

  const logged = `${warnings[0].message} ${JSON.stringify(warnings[0].detail)}`;
  assert.ok(logged.includes(FACTS.orderKey), 'the sanitized log keeps the opaque order identity');
  assert.ok(logged.includes('ZH001'), 'the sanitized log keeps the safe SQLSTATE');
  assert.ok(logged.length <= 512, `the sanitized log must be bounded, was ${logged.length} chars`);
  for (const leak of [
    'postgres://', 'hunter2', 'hsb_app:', 'db.invalid', 'HSB_CONTROL_STAGE_OFF',
    'secret stack frame', '/Users/', 'buyer@example.com', FACTS.stripeSessionId,
  ]) {
    assert.ok(!logged.includes(leak), `the sanitized log leaked ${leak}: ${logged}`);
  }
});

test('the wrapper sanitizes an error with a hostile code and a hostile constructor name', async () => {
  __clearShadowSettlementWarningsForTest();
  class Weird extends Error {}
  Object.defineProperty(Weird, 'name', { value: 'A'.repeat(500) });
  const hostile = Object.assign(new Weird('x'), { code: `postgres://leak@host/db ${'y'.repeat(400)}` });

  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor: async () => { throw hostile; },
  });

  assert.equal(outcome.status, 'failed');
  const warning = __readShadowSettlementWarningsForTest().at(-1)!;
  const logged = `${warning.message} ${JSON.stringify(warning.detail)}`;
  assert.ok(logged.length <= 512, `hostile error must stay bounded, was ${logged.length}`);
  assert.ok(!logged.includes('postgres://'), 'a hostile code must not reach the log');
});

test('a duplicate enqueue reported by SQL is a converged replay, not a failure', async () => {
  const { calls, executor } = recordingExecutor(false);
  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });
  assert.deepEqual(outcome, { status: 'recorded', inserted: false });
  assert.equal(calls.length, 1);
});

// ===========================================================================
// 5. Importing the module is inert: no DB env, no pool, no network.
// ===========================================================================

test('importing the adapter with a scrubbed environment performs no database access', () => {
  const script = `
    const mod = await import(${JSON.stringify(path.resolve('src/lib/hsb-control-plane-runtime/shadow-settlement.ts'))});
    const outcome = await mod.recordShadowCheckoutSettlement(
      { orderKey: 'ord' + '_' + ${JSON.stringify(HEX_A)}, stripeSessionId: ${JSON.stringify(sessionIdOf(HEX_A))},
        amountTotalCents: 4900, currency: 'usd' },
    );
    console.log(JSON.stringify(outcome));
  `;
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.deepEqual(JSON.parse(output.trim().split('\n').pop()!), { status: 'disabled' });
});

test('the adapter never statically imports pg and only loads it behind the flag', () => {
  const source = readFileSync('src/lib/hsb-control-plane-runtime/shadow-settlement.ts', 'utf8');
  // Source-order boundary: a static `pg` import would put the driver in every
  // bundle that touches the webhook route, which no executable test can observe
  // from inside this process once the module is already loaded.
  assert.doesNotMatch(source, /^\s*import\s[^\n]*['"]pg['"]/m, 'pg must never be statically imported');
  assert.doesNotMatch(source, /^\s*import\s+type\s[^\n]*['"]pg['"]/m, 'even a type import pins the package');
  assert.match(source, /await import\('pg'\)/, 'pg must be loaded through a lazy dynamic import');
  const dynamicAt = source.indexOf("await import('pg')");
  const flagAt = source.indexOf('HSB_CONTROL_PLANE_SHADOW');
  const urlAt = source.indexOf('HSB_CONTROL_PLANE_DATABASE_URL');
  assert.ok(flagAt >= 0 && urlAt >= 0 && dynamicAt >= 0);
  assert.ok(flagAt < urlAt, 'the flag must be named before the database URL');
  assert.ok(urlAt < dynamicAt, 'the URL guard must precede the driver import');
});

test('the adapter never logs or returns the control-plane database URL', () => {
  const source = readFileSync('src/lib/hsb-control-plane-runtime/shadow-settlement.ts', 'utf8');
  for (const line of source.split('\n')) {
    if (!/console\.|logger\.|\.warn\(|\.error\(/.test(line)) continue;
    assert.ok(
      !/DATABASE_URL|connectionString|\burl\b/i.test(line),
      `a log line references the database URL: ${line.trim()}`,
    );
  }
});

// ===========================================================================
// 6. Route wiring — behavioural, through the real signed webhook.
// ===========================================================================

const WEBHOOK_SECRET = 'whsec_hsb_shadow_settlement_local_test';
const STRIPE_KEY = 'sk_test_hsb_shadow_settlement_local_test';
const BUYER_EMAIL = 'shadow.settlement.buyer@example.com';

function setupStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hsb-shadow-settlement-'));
  process.env.HSB_ORDER_STORE_DIR = path.join(root, 'orders');
  process.env.HSB_PAYMENT_RECOVERY_STORE_DIR = path.join(root, 'recovery');
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
  delete process.env.VERCEL;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.RESEND_API_KEY;
  delete process.env.HSB_RESEND_API_KEY;
  delete process.env.GA4_MEASUREMENT_ID;
  delete process.env.GA4_API_SECRET;
  delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  return root;
}

function cleanupStore(root: string) {
  rmSync(root, { recursive: true, force: true });
  for (const key of [
    'HSB_ORDER_STORE_DIR',
    'HSB_PAYMENT_RECOVERY_STORE_DIR',
    'HSB_REQUIRE_DURABLE_PERSISTENCE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ]) delete process.env[key];
}

function signed(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  const stripe = new Stripe(STRIPE_KEY);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return new Request('http://127.0.0.1/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
}

async function seedOrder(hex: string, overrides: Partial<OrderRecord> = {}): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: 'Luna', bookFormat: 'digital', email: BUYER_EMAIL },
    { id: orderIdOf(hex), now: '2026-09-15T00:00:00.000Z' },
  );
  const order = {
    ...base,
    stripeSessionId: sessionIdOf(hex),
    paymentStatus: 'pending',
    ...overrides,
  } as OrderRecord;
  await persistOrder(order);
  return order;
}

function completedEvent(order: OrderRecord, sessionOverrides: Record<string, unknown> = {}) {
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

const LEGACY_MARKER = /^(\[webhook\]|\[fulfillment\]|\[confirmation-email\]|Stripe webhook:|after\(\) unavailable)/;

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * The terminal log line of each chain the webhook defers with `setImmediate`.
 *
 * Waiting for the log to go quiet is a *proxy* for "the deferred work finished",
 * and it is a proxy that breaks: both chains do real filesystem work between
 * their log lines, so under parallel load an inter-line gap can outlast any
 * quiescence window. When that happens the run returns a truncated capture, the
 * `finally` block deletes the order store out from under the still-running
 * chain (ENOENT after teardown), and that chain's terminal line lands in the
 * *next* run's capture carrying a foreign order id. Waiting for these markers
 * instead makes the wait a real condition rather than a guess.
 */
const CONFIRMATION_EMAIL_SETTLED =
  /^\[confirmation-email\] setImmediate (?:completed|failed|joined failed send) for /;
const FULFILLMENT_KICKOFF_SETTLED =
  /^\[webhook\]\[kickoff:[^\]]+\] \[setImmediate\] chain exited:/;

/** Settled once every listed chain has logged its terminal line. */
const settledBy = (...patterns: RegExp[]) =>
  (lines: string[]): boolean => patterns.every((pattern) => lines.some((line) => pattern.test(line)));

/** A paid replay whose fulfillment is already complete defers only the email. */
const EMAIL_ONLY = settledBy(CONFIRMATION_EMAIL_SETTLED);
/** A newly-paid transition (and the repair path) also defers a fulfillment kickoff. */
const EMAIL_AND_KICKOFF = settledBy(CONFIRMATION_EMAIL_SETTLED, FULFILLMENT_KICKOFF_SETTLED);

interface RunWebhookOptions {
  /**
   * Bounded explicit completion condition. Supply it for every scenario that
   * actually schedules deferred work — not only the ones whose assertions read
   * the scheduling markers, because an unawaited chain corrupts whichever run
   * happens to be capturing when it finally logs.
   */
  settled?: (lines: string[]) => boolean;
  settleTimeoutMs?: number;
}

/** Run the webhook and drain every deferred scheduler callback it started. */
async function runWebhook(
  event: Record<string, unknown>,
  options: RunWebhookOptions = {},
): Promise<{ response: Response; lines: string[] }> {
  const lines: string[] = [];
  const sinks = ['error', 'warn', 'log', 'info'] as const;
  const originals = sinks.map((sink) => console[sink]);
  const record = (...args: unknown[]) => { lines.push(args.map(formatArg).join(' ')); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('this test must make no network call');
  }) as typeof fetch;
  for (const sink of sinks) console[sink] = record;
  try {
    const response = await POST(signed(event));

    // Deferred work is scheduled with setImmediate. Wait on the terminal marker
    // of each chain this scenario starts, bounded, and fail loudly on expiry
    // rather than returning a half-captured run.
    if (options.settled) {
      const budgetMs = options.settleTimeoutMs ?? 30_000;
      const expiry = Date.now() + budgetMs;
      while (!options.settled(lines) && Date.now() < expiry) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!options.settled(lines)) {
        throw new Error(
          `deferred webhook work did not reach its terminal marker within ${budgetMs}ms.\n`
          + `captured lines:\n${lines.map((line) => `  ${line}`).join('\n')}`,
        );
      }
    }

    // Trailing settle: the markers above are each chain's last line, but a
    // sibling line can still be in flight behind them.
    for (let idle = 0, seen = lines.length, i = 0; i < 60 && idle < 1; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (lines.length === seen) idle += 1;
      else { idle = 0; seen = lines.length; }
    }
    return { response, lines: [...lines] };
  } finally {
    sinks.forEach((sink, index) => { console[sink] = originals[index]; });
    globalThis.fetch = realFetch;
  }
}

/** Legacy log markers with every per-run identity normalised away. */
function legacyMarkers(lines: string[], order: OrderRecord): string[] {
  return lines
    .filter((line) => LEGACY_MARKER.test(line))
    .map((line) =>
      line
        .split(order.id).join('<order>')
        .split(order.stripeSessionId!).join('<session>')
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
        .replace(/\b[0-9a-f]{6,}\b/g, '<hex>'),
    );
}

test('the webhook records one shadow projection on the newly-paid transition', async () => {
  const root = setupStore();
  const { calls, executor } = recordingExecutor();
  __setShadowSettlementTestOverrides({
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });
  try {
    const order = await seedOrder(HEX_B);
    const { response } = await runWebhook(completedEvent(order), { settled: EMAIL_AND_KICKOFF });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1, 'exactly one shadow projection for one new settlement');
    assert.equal(calls[0].values[1], order.id);
    assert.equal(
      (calls[0].values[3] as Buffer).toString('utf8'),
      `{"schema":"${SHADOW_SETTLEMENT_SCHEMA}","orderKey":"${order.id}",`
      + `"stripeSessionId":"${order.stripeSessionId}","amountTotalCents":${order.priceCents},`
      + `"currency":"usd","paymentState":"paid"}`,
    );

    const settled = await getOrder(order.id);
    assert.equal(settled?.paymentStatus, 'paid', 'the authoritative payment write is unaffected');
  } finally {
    __resetShadowSettlementTestOverrides();
    cleanupStore(root);
  }
});

test('the webhook records one shadow projection on an exact already-paid replay', async () => {
  const root = setupStore();
  const { calls, executor } = recordingExecutor();
  __setShadowSettlementTestOverrides({
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });
  try {
    const order = await seedOrder(HEX_C, {
      paymentStatus: 'paid',
      paidAt: '2026-09-15T00:05:00.000Z',
      stripePaymentIntentId: `pi_${HEX_C}`,
      fulfillmentStatus: 'complete',
    });
    const { response } = await runWebhook(completedEvent(order), { settled: EMAIL_ONLY });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1, 'the replay seam records evidence exactly once');
    assert.equal(calls[0].values[1], order.id);
  } finally {
    __resetShadowSettlementTestOverrides();
    cleanupStore(root);
  }
});

test('an exact replay of the same settlement re-presents byte-identical evidence', async () => {
  const root = setupStore();
  const { calls, executor } = recordingExecutor();
  __setShadowSettlementTestOverrides({
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });
  try {
    const order = await seedOrder(HEX_D);
    await runWebhook(completedEvent(order), { settled: EMAIL_AND_KICKOFF });
    await runWebhook(completedEvent(order), { settled: EMAIL_AND_KICKOFF });

    assert.equal(calls.length, 2, 'first delivery plus its replay');
    assert.deepEqual(calls[0].values, calls[1].values, 'replay must converge on identical bytes and digest');
  } finally {
    __resetShadowSettlementTestOverrides();
    cleanupStore(root);
  }
});

const NON_SETTLEMENT_CASES: Array<[string, (order: OrderRecord) => Record<string, unknown>]> = [
  ['a refund', () => ({
    id: `evt_refund_${HEX_E}`,
    object: 'event',
    type: 'charge.refunded',
    created: 1_800_000_000,
    data: { object: { id: `ch_${HEX_E}`, object: 'charge', payment_intent: `pi_${HEX_E}`, amount_refunded: 4900 } },
  })],
  ['a dispute', () => ({
    id: `evt_dispute_${HEX_E}`,
    object: 'event',
    type: 'charge.dispute.created',
    created: 1_800_000_000,
    data: { object: { id: `dp_${HEX_E}`, object: 'dispute', payment_intent: `pi_${HEX_E}`, amount: 4900 } },
  })],
  ['an async payment failure', () => ({
    id: `evt_failed_${HEX_E}`,
    object: 'event',
    type: 'checkout.session.async_payment_failed',
    created: 1_800_000_000,
    data: { object: { id: `cs_test_${HEX_E}`, object: 'checkout.session', payment_intent: `pi_${HEX_E}` } },
  })],
  ['an unrelated event family', () => ({
    id: `evt_other_${HEX_E}`,
    object: 'event',
    type: 'payment_intent.succeeded',
    created: 1_800_000_000,
    data: { object: { id: `pi_${HEX_E}`, object: 'payment_intent' } },
  })],
  ['a session-binding conflict', (order) => completedEvent({ ...order, stripeSessionId: `cs_test_other_${HEX_E}` } as OrderRecord)],
  ['an amount mismatch', (order) => completedEvent(order, { amount_subtotal: order.priceCents + 100 })],
  ['an unpaid session', (order) => completedEvent(order, { payment_status: 'unpaid' })],
  ['a session with no order identity', (order) => completedEvent(order, { metadata: {}, client_reference_id: null })],
];

for (const [label, build] of NON_SETTLEMENT_CASES) {
  test(`the webhook records no shadow projection for ${label}`, async () => {
    const root = setupStore();
    const { calls, executor } = recordingExecutor();
    __setShadowSettlementTestOverrides({
      env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
      executor,
    });
    try {
      const order = await seedOrder(HEX_E);
      await runWebhook(build(order));
      assert.equal(calls.length, 0, `${label} is not a settlement and must produce no evidence`);
    } finally {
      __resetShadowSettlementTestOverrides();
      cleanupStore(root);
    }
  });
}

test('a missing order records no shadow projection', async () => {
  const root = setupStore();
  const { calls, executor } = recordingExecutor();
  __setShadowSettlementTestOverrides({
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });
  try {
    const phantom = {
      id: orderIdOf(HEX_F),
      stripeSessionId: sessionIdOf(HEX_F),
      priceCents: 4900,
    } as OrderRecord;
    await runWebhook(completedEvent(phantom));
    assert.equal(calls.length, 0);
  } finally {
    __resetShadowSettlementTestOverrides();
    cleanupStore(root);
  }
});

// ---------------------------------------------------------------------------
// A paid replay that contradicts itself records no settlement evidence.
//
// The legacy replay branch treats paymentStatus='paid' as the whole story. An
// order can sit in that branch while also carrying a refund marker, or while its
// authoritative settled amount disagrees with the Stripe total. Evidence that a
// legacy checkout settled is false in those states, so the shadow seam is skipped
// — and only the shadow seam is skipped: the acknowledgement, the email, the GA4
// event, and the fulfillment decision are untouched.
// ---------------------------------------------------------------------------

/**
 * A fresh 16-hex order body per webhook run. Fulfillment kickoff and confirmation
 * email both keep per-order-id state that outlives a single test, so reusing an id
 * across runs would couple otherwise independent scenarios.
 */
let hexCounter = 0;
const freshHex = (): string => `a0b0c0d0${(hexCounter += 1).toString(16).padStart(8, '0')}`;

async function seedPaidReplayOrder(
  hex: string,
  marker: (order: OrderRecord) => Partial<OrderRecord>,
): Promise<OrderRecord> {
  const paid = await seedOrder(hex, {
    paymentStatus: 'paid',
    paidAt: '2026-09-15T00:05:00.000Z',
    stripePaymentIntentId: `pi_${hex}`,
    fulfillmentStatus: 'complete',
  });
  const marked = { ...paid, ...marker(paid) } as OrderRecord;
  await persistOrder(marked);
  return marked;
}

const CONTRADICTORY_PAID_REPLAYS: Array<[string, (order: OrderRecord) => Partial<OrderRecord>]> = [
  ['a refundedAt timestamp', () => ({ refundedAt: '2026-09-15T02:00:00.000Z' })],
  ['a Stripe refund id', () => ({ stripeRefundId: `re_${HEX_F}` })],
  ['a refund claim id', () => ({ refundClaimId: `rc_${HEX_F}` })],
  ['a settled amount below the Stripe total', (order) => ({ settledAmountCents: order.priceCents - 500 })],
  ['a settled amount above the Stripe total', (order) => ({ settledAmountCents: order.priceCents + 500 })],
  ['a zero settled amount against a non-zero Stripe total', () => ({ settledAmountCents: 0 })],
];

for (const [label, marker] of CONTRADICTORY_PAID_REPLAYS) {
  test(`an already-paid replay carrying ${label} records no shadow evidence`, async () => {
    const observed: Array<{ name: string; status: number; body: string; markers: string[]; queries: number }> = [];

    for (const shadow of ['off', 'on'] as const) {
      const root = setupStore();
      const { calls, executor } = recordingExecutor();
      __setShadowSettlementTestOverrides({
        env: (shadow === 'on' ? { HSB_CONTROL_PLANE_SHADOW: 'true' } : {}) as unknown as NodeJS.ProcessEnv,
        executor,
      });
      try {
        const order = await seedPaidReplayOrder(freshHex(), marker);
        const { response, lines } = await runWebhook(completedEvent(order), { settled: EMAIL_ONLY });
        observed.push({
          name: shadow,
          status: response.status,
          body: JSON.stringify(await response.json()),
          markers: legacyMarkers(lines, order),
          queries: calls.length,
        });
      } finally {
        __resetShadowSettlementTestOverrides();
        cleanupStore(root);
      }
    }

    const [off, on] = observed;
    assert.equal(on.queries, 0, `${label} must produce zero shadow queries`);
    assert.ok(off.markers.length > 0, 'the legacy replay markers must actually be observed');
    assert.equal(on.status, off.status, 'the shadow exclusion changed the legacy response status');
    assert.equal(on.body, off.body, 'the shadow exclusion changed the legacy response body');
    assert.deepEqual(on.markers, off.markers, 'the shadow exclusion changed legacy email/GA4/fulfillment scheduling');
  });
}

test('an already-paid replay whose settled amount matches Stripe still records evidence', async () => {
  const root = setupStore();
  const { calls, executor } = recordingExecutor();
  __setShadowSettlementTestOverrides({
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });
  try {
    const order = await seedPaidReplayOrder(freshHex(), (seeded) => ({ settledAmountCents: seeded.priceCents }));
    const { response } = await runWebhook(completedEvent(order), { settled: EMAIL_ONLY });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1, 'a consistent paid replay is still real settlement evidence');
    assert.equal(calls[0].values[1], order.id);
  } finally {
    __resetShadowSettlementTestOverrides();
    cleanupStore(root);
  }
});

test('the newly-paid seam is unaffected by the replay-branch exclusion', async () => {
  const root = setupStore();
  const { calls, executor } = recordingExecutor();
  __setShadowSettlementTestOverrides({
    env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
    executor,
  });
  try {
    const order = await seedOrder(freshHex());
    const { response } = await runWebhook(completedEvent(order), { settled: EMAIL_AND_KICKOFF });
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
  } finally {
    __resetShadowSettlementTestOverrides();
    cleanupStore(root);
  }
});

test('legacy acknowledgement and scheduling are identical off, on-success, and on-failure', async () => {
  const scenarios: Array<{ name: string; hex: string; overrides: () => void }> = [
    { name: 'off', hex: HEX_G, overrides: () => __setShadowSettlementTestOverrides({
      env: {} as unknown as NodeJS.ProcessEnv,
      executor: async () => { throw new Error('unreachable while off'); },
    }) },
    { name: 'success', hex: HEX_H, overrides: () => __setShadowSettlementTestOverrides({
      env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
      executor: async () => ({ rows: [{ enqueue_projection: true }] }),
    }) },
    { name: 'failure', hex: HEX_A, overrides: () => __setShadowSettlementTestOverrides({
      env: { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv,
      executor: async () => {
        throw Object.assign(new Error('HSB_CONTROL_STAGE_OFF'), { code: 'ZH001' });
      },
    }) },
  ];

  const observed: Array<{ name: string; status: number; body: string; markers: string[] }> = [];
  for (const scenario of scenarios) {
    const root = setupStore();
    scenario.overrides();
    try {
      const order = await seedOrder(scenario.hex);
      const { response, lines } = await runWebhook(completedEvent(order), { settled: EMAIL_AND_KICKOFF });
      const settled = await getOrder(order.id);
      assert.equal(settled?.paymentStatus, 'paid', `${scenario.name}: the payment must still land`);
      observed.push({
        name: scenario.name,
        status: response.status,
        body: JSON.stringify(await response.json()),
        markers: legacyMarkers(lines, order),
      });
    } finally {
      __resetShadowSettlementTestOverrides();
      cleanupStore(root);
    }
  }

  assert.ok(observed[0].markers.length > 0, 'the legacy scheduling markers must actually be observed');
  for (const scenario of observed.slice(1)) {
    assert.equal(scenario.status, observed[0].status, `${scenario.name} changed the response status`);
    assert.equal(scenario.body, observed[0].body, `${scenario.name} changed the response body`);
    assert.deepEqual(
      scenario.markers,
      observed[0].markers,
      `${scenario.name} changed legacy email/GA4/fulfillment scheduling`,
    );
  }
});

// ===========================================================================
// 7. Route source-order boundary.
//
// The two seams above are proven behaviourally. These assertions additionally
// pin WHERE the call sits relative to the legacy writes and schedulers, which
// the behavioural tests cannot observe from outside the handler.
// ===========================================================================

test('the webhook calls the shadow wrapper at exactly the two paid seams', () => {
  const route = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  assert.match(route, /from '\.\.\/\.\.\/\.\.\/\.\.\/lib\/hsb-control-plane-runtime\/shadow-settlement\.ts'/);

  const callSites = [...route.matchAll(/recordShadowCheckoutSettlement\(/g)].map((m) => m.index!);
  assert.equal(callSites.length, 2, 'exactly two call sites: newly-paid and exact replay');

  const newlyPaidWrite = route.indexOf('const updated = await updateOrderPayment(orderId, \'paid\'');
  const newlyPaidGuardEnd = route.indexOf('scheduleOrderConfirmationEmail(updated');
  assert.ok(newlyPaidWrite > 0 && newlyPaidGuardEnd > newlyPaidWrite);

  const replayGuard = route.indexOf('if (!replayOrder)');
  const replayGa4 = route.indexOf('scheduleGa4Purchase({', replayGuard);
  assert.ok(replayGuard > 0 && replayGa4 > replayGuard);

  const [replaySeam, newSeam] = callSites.sort((a, b) => a - b);
  assert.ok(replaySeam > replayGuard && replaySeam < replayGa4,
    'the replay seam must sit after the PaymentIntent backfill guard and before replay notification');
  assert.ok(newSeam > newlyPaidWrite && newSeam < newlyPaidGuardEnd,
    'the newly-paid seam must sit after the proven payment write and before notification scheduling');
});

test('the print-upgrade and conflict branches never reach the shadow wrapper', () => {
  const route = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  const printUpgradeStart = route.indexOf("if (kind === 'print_upgrade')");
  const printUpgradeEnd = route.indexOf('const orderId = (session.metadata?.orderId');
  assert.ok(printUpgradeStart > 0 && printUpgradeEnd > printUpgradeStart);
  assert.ok(
    !route.slice(printUpgradeStart, printUpgradeEnd).includes('recordShadowCheckoutSettlement'),
    'a print upgrade is not a legacy checkout settlement',
  );

  const terminalStart = route.indexOf("event.type === 'charge.refunded'");
  const terminalEnd = route.indexOf("if (event.type === 'checkout.session.completed')");
  assert.ok(
    !route.slice(terminalStart, terminalEnd).includes('recordShadowCheckoutSettlement'),
    'refund, dispute, and failed-payment families record no settlement evidence',
  );
});

test('the webhook never hands the shadow adapter buyer, media, or provider data', () => {
  const route = readFileSync('src/app/api/webhooks/stripe/route.ts', 'utf8');
  for (const match of route.matchAll(/recordShadowCheckoutSettlement\(([\s\S]{0,400}?)\)\s*;/g)) {
    const argument = match[1];
    assert.deepEqual(
      [...argument.matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1]).sort(),
      ['amountTotalCents', 'currency', 'orderKey', 'stripeSessionId'],
      `the shadow call passes unexpected fields: ${argument}`,
    );
  }
});

// ===========================================================================
// 8. Order identity is the real producer's shape, not generic SQL syntax.
//
// `ord_` + 16 lowercase hex is what src/lib/orders.ts actually mints. A key
// that is merely SQL-compatible — a person's name, a colon-separated handle,
// uppercase hex, a wrong prefix or length — is not an HSB order and must be
// refused before any I/O, and must never be echoed into the sanitized log.
// ===========================================================================

const ON_ENV = { HSB_CONTROL_PLANE_SHADOW: 'true' } as unknown as NodeJS.ProcessEnv;

const REFUSED_ORDER_KEYS: Array<[string, string]> = [
  ['personal text', 'Alice_Smith'],
  ['a person-shaped handle with a colon', 'order:123'],
  ['a colon-separated identifier', `order:${HEX_A}`],
  ['uppercase hex', `ord_${HEX_A.toUpperCase()}`],
  ['mixed-case hex', `ord_${HEX_A.slice(0, 8)}${HEX_A.slice(8).toUpperCase()}`],
  ['an uppercase prefix', `ORD_${HEX_A}`],
  ['a wrong prefix', `order_${HEX_A}`],
  ['a hyphen separator', `ord-${HEX_A}`],
  ['no prefix at all', HEX_A],
  ['one hex digit too many', `ord_${HEX_A}a`],
  ['one hex digit too few', `ord_${HEX_A.slice(0, 15)}`],
  ['a UUID body', 'ord_0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7'],
  ['a non-hex letter in the body', `ord_${'g'.repeat(16)}`],
  ['a Stripe session id', `cs_test_${HEX_A}`],
  ['a trailing underscore', `ord_${HEX_A}_`],
];

for (const [label, key] of REFUSED_ORDER_KEYS) {
  test(`the public recorder refuses an order key that is ${label} and never logs the raw input`, async () => {
    const { calls, executor } = recordingExecutor();
    __clearShadowSettlementWarningsForTest();
    const outcome = await recordShadowCheckoutSettlement({ ...FACTS, orderKey: key }, {
      env: ON_ENV,
      executor,
    });

    assert.equal(outcome.status, 'failed');
    assert.equal(calls.length, 0, `${label} must issue no SQL`);
    const warnings = __readShadowSettlementWarningsForTest();
    assert.equal(warnings.length, 1);
    const logged = `${warnings[0].message} ${JSON.stringify(warnings[0].detail)}`;
    assert.ok(!logged.includes(key), `the sanitized log echoed the rejected raw order key: ${logged}`);
    assert.ok(logged.includes('<invalid>'), `a refused identity must log the opaque placeholder: ${logged}`);
  });
}

const ACCEPTED_ORDER_KEYS: Array<[string, string]> = [
  // Built through the helper so the boundary fixtures never spell a
  // production-shaped order id out in the committed source.
  ['the all-zero hex boundary', orderIdOf('0'.repeat(16))],
  ['the all-f hex boundary', orderIdOf('f'.repeat(16))],
  ['a production-shaped key', orderIdOf(HEX_A)],
];

for (const [label, key] of ACCEPTED_ORDER_KEYS) {
  test(`the adapter accepts ${label} and issues exactly one call`, async () => {
    const { calls, executor } = recordingExecutor();
    const outcome = await recordShadowCheckoutSettlement({ ...FACTS, orderKey: key }, {
      env: ON_ENV,
      executor,
    });
    assert.deepEqual(outcome, { status: 'recorded', inserted: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[1], key);
  });
}

test('the order key and the Stripe session id keep separate explicit validations', async () => {
  const { calls, executor } = recordingExecutor();
  // A session id is not an order key …
  const wrongOrder = await recordShadowCheckoutSettlement(
    { ...FACTS, orderKey: sessionIdOf(HEX_A) },
    { env: ON_ENV, executor },
  );
  assert.equal(wrongOrder.status, 'failed');
  // … and an order key is still not a licence to skip session validation.
  const wrongSession = await recordShadowCheckoutSettlement(
    { ...FACTS, stripeSessionId: `cs_test_${HEX_A}'; --` },
    { env: ON_ENV, executor },
  );
  assert.equal(wrongSession.status, 'failed');
  assert.equal(calls.length, 0);
  // The real Stripe shape still passes.
  const valid = await recordShadowCheckoutSettlement(
    { ...FACTS, stripeSessionId: sessionIdOf(HEX_B) },
    { env: ON_ENV, executor },
  );
  assert.deepEqual(valid, { status: 'recorded', inserted: true });
  assert.equal(calls.length, 1);
});

// ===========================================================================
// 9. Caller logging code is never read or executed.
// ===========================================================================

test('rejected native logger promises cannot exit or leak through constructor machinery', { timeout: 90_000 }, () => {
  const failures: Array<{ mode: string; variant: string; status: number | null; leaked: boolean }> = [];
  for (const mode of ['test', 'production'] as const) {
    for (const variant of ['throwing-constructor', 'throwing-species', 'invalid-constructor']) {
      const privateReason = `PRIVATE_LOGGER_REJECTION_${mode}_${variant}`;
      const script = `
        const mod = await import(${JSON.stringify(path.resolve('src/lib/hsb-control-plane-runtime/shadow-settlement.ts'))});
        const outcome = await mod.recordShadowCheckoutSettlement(
          ${JSON.stringify(FACTS)},
          {
            env: { HSB_CONTROL_PLANE_SHADOW: 'true' },
            executor: async () => { throw Object.assign(new Error('stage off'), { code: 'ZH001' }); },
            logger: { warn() {
              const rejected = Promise.reject(new Error(${JSON.stringify(privateReason)}));
              if (${JSON.stringify(variant)} === 'throwing-constructor') {
                Object.defineProperty(rejected, 'constructor', {
                  configurable: false,
                  get() { throw new Error('PRIVATE_CONSTRUCTOR_GETTER'); },
                });
              } else if (${JSON.stringify(variant)} === 'throwing-species') {
                const constructor = {};
                Object.defineProperty(constructor, Symbol.species, {
                  get() { throw new Error('PRIVATE_SPECIES_GETTER'); },
                });
                Object.defineProperty(rejected, 'constructor', { value: constructor });
              } else {
                Object.defineProperty(rejected, 'constructor', { value: 17 });
              }
              return rejected;
            } },
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 25));
        console.log(JSON.stringify(outcome));
      `;
      const child = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '--eval', script],
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: os.tmpdir(),
            NODE_ENV: mode,
            ...(mode === 'production' ? { HSB_CONTROL_PLANE_SHADOW: 'true' } : {}),
          },
        },
      );
      const observable = `${child.stdout}\n${child.stderr}`;
      if (child.status !== 0 || observable.includes(privateReason)) {
        failures.push({ mode, variant, status: child.status, leaked: observable.includes(privateReason) });
      }
    }
  }
  assert.deepEqual(failures, [], `hostile native Promise results escaped containment: ${JSON.stringify(failures)}`);
});

test('options.logger is never read, enumerated, or invoked in either runtime mode', { timeout: 90_000 }, () => {
  const script = `
    const mod = await import(${JSON.stringify(path.resolve('src/lib/hsb-control-plane-runtime/shadow-settlement.ts'))});
    const results = [];
    for (const mode of ['test', 'production']) {
      process.env.NODE_ENV = mode;
      process.env.HSB_CONTROL_PLANE_SHADOW = 'true';
      delete process.env.HSB_CONTROL_PLANE_DATABASE_URL;
      const observed = { gets: [], ownKeys: 0, calls: 0 };
      const target = {
        env: { HSB_CONTROL_PLANE_SHADOW: 'true' },
        executor: async () => ({ rows: [{ enqueue_projection: true }] }),
      };
      Object.defineProperty(target, 'logger', {
        enumerable: true,
        get() {
          observed.gets.push('logger-getter');
          return new Proxy(function hostileLogger() {}, {
            apply() { observed.calls += 1; throw new Error('PRIVATE_LOGGER_CALL'); },
            get(_source, key) {
              observed.gets.push('logger.' + String(key));
              if (key === 'warn') return () => { observed.calls += 1; throw new Error('PRIVATE_LOGGER_WARN'); };
              throw new Error('PRIVATE_LOGGER_PROXY');
            },
          });
        },
      });
      const options = new Proxy(target, {
        ownKeys(source) { observed.ownKeys += 1; return Reflect.ownKeys(source); },
        get(source, key, receiver) {
          observed.gets.push(String(key));
          return Reflect.get(source, key, receiver);
        },
      });
      const outcome = await mod.recordShadowCheckoutSettlement(
        { ...${JSON.stringify(FACTS)}, orderKey: 'invalid' },
        options,
      );
      results.push({ mode, outcome, observed });
    }
    console.log(JSON.stringify(results));
  `;
  const child = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), NODE_ENV: 'test' },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout.trim().split('\n').pop()!) as Array<{
    mode: string;
    observed: { gets: string[]; ownKeys: number; calls: number };
  }>;
  for (const result of results) {
    assert.equal(result.observed.ownKeys, 0, `${result.mode} enumerated options`);
    assert.ok(!result.observed.gets.includes('logger'), `${result.mode} read options.logger`);
    assert.ok(!result.observed.gets.includes('logger-getter'), `${result.mode} invoked the logger getter`);
    assert.equal(result.observed.calls, 0, `${result.mode} invoked caller logging code`);
  }
});

test('the Pool idle-failure path never reaches options.logger', { timeout: 30_000 }, async () => {
  const observed = { loggerReads: 0, loggerCalls: 0 };
  const pools: FakePool[] = [];
  const options = {
    env: poolEnv(),
    get logger() {
      observed.loggerReads += 1;
      return { warn: () => { observed.loggerCalls += 1; } };
    },
  };
  await withDriver(
    async () => ({
      Pool: class extends FakePool {
        constructor(config: Record<string, unknown>) { super(config); pools.push(this); }
      } as unknown as new (config: unknown) => unknown,
    }),
    async () => {
      assert.deepEqual(
        await recordShadowCheckoutSettlement(FACTS, options),
        { status: 'recorded', inserted: true },
      );
      const listener = pools[0].listeners.get('error')?.[0];
      assert.equal(typeof listener, 'function');
      assert.doesNotThrow(() => listener?.(new Error('idle failure')));
    },
  );
  assert.deepEqual(observed, { loggerReads: 0, loggerCalls: 0 });
});

test('stored test overrides sample only the four allowlisted seams', async () => {
  const observed = { gets: [] as string[], ownKeys: 0, loggerCalls: 0 };
  const target = {
    env: ON_ENV,
    executor: async () => ({ rows: [{ enqueue_projection: true }] }),
  };
  Object.defineProperty(target, 'logger', {
    enumerable: true,
    get() {
      observed.gets.push('logger-getter');
      return { warn: () => { observed.loggerCalls += 1; } };
    },
  });
  const overrides = new Proxy(target, {
    ownKeys(source) { observed.ownKeys += 1; return Reflect.ownKeys(source); },
    get(source, key, receiver) {
      observed.gets.push(String(key));
      return Reflect.get(source, key, receiver);
    },
  });

  __setShadowSettlementTestOverrides(overrides);
  try {
    const outcome = await recordShadowCheckoutSettlement({ ...FACTS, orderKey: 'invalid' });
    assert.equal(outcome.status, 'failed');
  } finally {
    __resetShadowSettlementTestOverrides();
  }

  assert.equal(observed.ownKeys, 0, 'stored overrides must never be enumerated');
  assert.deepEqual(observed.gets, ['env', 'executor', 'createExecutor', 'deadlineMs']);
  assert.equal(observed.loggerCalls, 0);
});

// ===========================================================================
// 10. A finite total deadline, and contained late rejections.
//
// The deadline bounds *this wrapper*. It does not cancel work already handed to
// the driver; pg's own connectionTimeoutMillis / query_timeout / statement_timeout
// remain the bounds on the socket and the server.
// ===========================================================================

test('the production total deadline is explicit, finite, and exported', () => {
  const deadline = shadowAdapter.SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS;
  assert.equal(typeof deadline, 'number', 'the production deadline must be exported');
  assert.ok(Number.isFinite(deadline) && deadline > 0, `the deadline must be finite and positive, was ${deadline}`);
  const source = readFileSync('src/lib/hsb-control-plane-runtime/shadow-settlement.ts', 'utf8');
  assert.match(source, /SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS/);
});

test('a never-resolving executor still resolves inside the per-call deadline', { timeout: 15_000 }, async () => {
  const started = Date.now();
  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: ON_ENV,
    executor: () => new Promise<never>(() => {}),
    deadlineMs: 75,
  } as never);
  const elapsed = Date.now() - started;

  assert.deepEqual(outcome, { status: 'failed', errorClass: 'ShadowSettlementDeadlineError', errorCode: null });
  assert.ok(elapsed < 5_000, `the wrapper must resolve on its own deadline, took ${elapsed}ms`);
});

test('a never-resolving executor factory is bounded by the same deadline', { timeout: 15_000 }, async () => {
  const started = Date.now();
  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: ON_ENV,
    createExecutor: () => new Promise<never>(() => {}),
    deadlineMs: 75,
  } as never);
  const elapsed = Date.now() - started;

  assert.equal(outcome.status, 'failed');
  assert.equal((outcome as { errorClass: string }).errorClass, 'ShadowSettlementDeadlineError');
  assert.ok(elapsed < 5_000, `executor creation must be inside the deadline, took ${elapsed}ms`);
});

test('a rejection arriving after the deadline never becomes an unhandled rejection', { timeout: 15_000 }, async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const outcome = await recordShadowCheckoutSettlement(FACTS, {
      env: ON_ENV,
      executor: () => new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error('late driver failure'), { code: 'ECONNRESET' })), 250);
      }),
      deadlineMs: 50,
    } as never);
    assert.equal((outcome as { errorClass: string }).errorClass, 'ShadowSettlementDeadlineError');

    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(unhandled, [], 'a late rejection must already carry a handler');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('the deadline timer does not pin the process open', () => {
  const script = `
    const mod = await import(${JSON.stringify(path.resolve('src/lib/hsb-control-plane-runtime/shadow-settlement.ts'))});
    const outcome = await mod.recordShadowCheckoutSettlement(
      { orderKey: 'ord' + '_' + ${JSON.stringify(HEX_A)}, stripeSessionId: ${JSON.stringify(sessionIdOf(HEX_A))},
        amountTotalCents: 4900, currency: 'usd' },
      {
        env: { HSB_CONTROL_PLANE_SHADOW: 'true' },
        executor: async () => ({ rows: [{ enqueue_projection: true }] }),
        deadlineMs: 120000,
      },
    );
    console.log(JSON.stringify(outcome));
  `;
  const started = Date.now();
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.deepEqual(JSON.parse(output.trim().split('\n').pop()!), { status: 'recorded', inserted: true });
  assert.ok(Date.now() - started < 25_000, 'a pending deadline timer must not hold the event loop open');
});

// ===========================================================================
// 11. The lazy pool: one construction under concurrency, a live error listener,
//     retry after a failed initialization, and still off by default.
// ===========================================================================

/** A pool stand-in with the exact surface the adapter is allowed to use. */
class FakePool {
  static constructed = 0;
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  queries = 0;
  config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) {
    this.config = config;
    FakePool.constructed += 1;
  }
  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }
  async query(): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries += 1;
    return { rows: [{ enqueue_projection: true }] };
  }
  async end(): Promise<void> {}
}

const CONTROL_URL = 'postgres://hsb_login@localhost/control?host=%2Fnonexistent-hsb-control-socket&port=5432';
const poolEnv = () => ({
  HSB_CONTROL_PLANE_SHADOW: 'true',
  HSB_CONTROL_PLANE_DATABASE_URL: CONTROL_URL,
}) as unknown as NodeJS.ProcessEnv;

async function withDriver<T>(
  loader: () => Promise<{ Pool: new (config: unknown) => unknown }>,
  body: () => Promise<T>,
): Promise<T> {
  shadowAdapter.__setShadowSettlementDriverForTest(loader as never);
  try {
    return await body();
  } finally {
    await shadowAdapter.__closeShadowSettlementPoolForTest();
    shadowAdapter.__setShadowSettlementDriverForTest(null as never);
    __resetShadowSettlementTestOverrides();
  }
}

test('concurrent first calls construct exactly one pool', { timeout: 15_000 }, async () => {
  FakePool.constructed = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });

  await withDriver(
    async () => { await gate; return { Pool: FakePool as unknown as new (config: unknown) => unknown }; },
    async () => {
      const calls = [
        recordShadowCheckoutSettlement(FACTS, { env: poolEnv() }),
        recordShadowCheckoutSettlement(FACTS, { env: poolEnv() }),
        recordShadowCheckoutSettlement(FACTS, { env: poolEnv() }),
      ];
      open();
      const outcomes = await Promise.all(calls);
      for (const outcome of outcomes) {
        assert.deepEqual(outcome, { status: 'recorded', inserted: true });
      }
      assert.equal(FakePool.constructed, 1, 'concurrent first calls must share one lazily constructed pool');
    },
  );
});

test('a failed pool initialization is not cached and a later call retries', { timeout: 15_000 }, async () => {
  FakePool.constructed = 0;
  let attempts = 0;

  await withDriver(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('driver load failed');
      return { Pool: FakePool as unknown as new (config: unknown) => unknown };
    },
    async () => {
      const first = await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.equal(first.status, 'failed', 'the first initialization failure is surfaced as a failed outcome');

      const second = await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.deepEqual(second, { status: 'recorded', inserted: true }, 'a later call must be allowed to retry');
      assert.equal(attempts, 2);
      assert.equal(FakePool.constructed, 1);
    },
  );
});

test('the reset and close helpers retire provenance and close every cached pool', { timeout: 15_000 }, async () => {
  const pools: Array<FakePool & { ended: number }> = [];
  class ClosingPool extends FakePool {
    ended = 0;
    constructor(config: Record<string, unknown>) {
      super(config);
      pools.push(this);
    }
    override async end(): Promise<void> { this.ended += 1; }
  }

  await withDriver(
    async () => ({ Pool: ClosingPool as unknown as new (config: unknown) => unknown }),
    async () => {
      await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.equal(pools.length, 1);

      __resetShadowSettlementTestOverrides();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(pools[0].ended, 1, 'reset must safely close the detached pool');

      await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.equal(pools.length, 2, 'reset must clear the cache provenance as well as the instance');

      await shadowAdapter.__closeShadowSettlementPoolForTest();
      assert.equal(pools[1].ended, 1, 'close must await the detached pool close');

      await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.equal(pools.length, 3, 'close must leave no cache provenance behind');
    },
  );
  assert.equal(pools[2].ended, 1, 'the final helper cleanup closes the last cached pool');
});

test('the shadow is still off by default once a pool already exists', { timeout: 15_000 }, async () => {
  FakePool.constructed = 0;

  await withDriver(
    async () => ({ Pool: FakePool as unknown as new (config: unknown) => unknown }),
    async () => {
      const warm = await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.deepEqual(warm, { status: 'recorded', inserted: true });
      assert.equal(FakePool.constructed, 1);

      const { reads, env } = envProbe({
        HSB_CONTROL_PLANE_SHADOW: undefined,
        HSB_CONTROL_PLANE_DATABASE_URL: CONTROL_URL,
      });
      const outcome = await recordShadowCheckoutSettlement(FACTS, { env });

      assert.deepEqual(outcome, { status: 'disabled' }, 'an existing pool must not make the shadow reachable');
      assert.deepEqual(
        [...new Set(reads)],
        ['HSB_CONTROL_PLANE_SHADOW'],
        'an off shadow must read the flag and nothing else even after a pool exists',
      );
      assert.equal(FakePool.constructed, 1, 'an off shadow must construct no further pool');
    },
  );
});

test('the lazy pool registers exactly one error listener at construction', { timeout: 15_000 }, async () => {
  FakePool.constructed = 0;
  const pools: FakePool[] = [];

  await withDriver(
    async () => ({
      Pool: class extends FakePool {
        constructor(config: Record<string, unknown>) { super(config); pools.push(this); }
      } as unknown as new (config: unknown) => unknown,
    }),
    async () => {
      await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.equal(pools.length, 1);
      assert.equal(
        pools[0].listeners.get('error')?.length,
        1,
        'the pool must carry exactly one permanent error listener',
      );
    },
  );
});

test('a real pg Pool idle failure is swallowed, sanitized, and never re-thrown', { timeout: 30_000 }, async () => {
  const pg = await import('pg');
  const RealPool = (pg as unknown as { Pool?: new (config: unknown) => unknown; default: { Pool: new (config: unknown) => unknown } })
    .Pool ?? (pg as unknown as { default: { Pool: new (config: unknown) => unknown } }).default.Pool;

  const pools: Array<{ emit: (event: string, ...args: unknown[]) => boolean; listenerCount: (event: string) => number }> = [];
  class CapturingPool extends (RealPool as new (config: unknown) => Record<string, unknown>) {
    constructor(config: unknown) {
      super(config);
      pools.push(this as never);
    }
  }

  __clearShadowSettlementWarningsForTest();
  await withDriver(
    async () => ({ Pool: CapturingPool as unknown as new (config: unknown) => unknown }),
    async () => {
      // The connection target is a socket path that does not exist, so this fails
      // locally and immediately: no DNS, no network, no credentials.
      const outcome = await recordShadowCheckoutSettlement(FACTS, {
        env: poolEnv(),
      });
      assert.equal(outcome.status, 'failed', 'a dead socket target must fail, not hang');
      assert.equal(pools.length, 1, 'the production path must construct a real pg Pool');
      assert.equal(pools[0].listenerCount('error'), 1, 'the real Pool must carry exactly one error listener');

      // Exactly what pg-pool does for an idle client failure, outside any awaited
      // query: `pool.emit('error', err, client)`. With no listener this throws out
      // of the emit and takes the process down.
      __clearShadowSettlementWarningsForTest();
      const idleClient = {
        connectionParameters: { password: 'hunter2', host: 'db.invalid' },
        secretToken: 'tok_secret',
      };
      const idleError = Object.assign(
        new Error('terminating connection due to administrator command '
          + '(postgres://hsb_app:hunter2@db.invalid:5432/control)'),
        { code: 'ECONNRESET', client: idleClient, stack: 'Error: at /Users/someone/secret.ts:1:1' },
      );

      assert.doesNotThrow(() => { pools[0].emit('error', idleError, idleClient); });

      const warnings = __readShadowSettlementWarningsForTest();
      assert.equal(warnings.length, 1, 'an idle pool failure emits exactly one bounded line');
      const logged = `${warnings[0].message} ${JSON.stringify(warnings[0].detail)}`;
      assert.ok(logged.length <= 512, `the idle failure log must stay bounded, was ${logged.length}`);
      for (const leak of [
        'postgres://', 'hunter2', 'db.invalid', 'tok_secret', 'secretToken',
        '/Users/', 'terminating connection', 'connectionParameters',
      ]) {
        assert.ok(!logged.includes(leak), `the idle failure log leaked ${leak}: ${logged}`);
      }
      assert.ok(logged.includes('ECONNRESET'), `the idle failure log keeps the safe code: ${logged}`);
    },
  );
});

test('the lazy pool keeps pg\'s own connection, query, and statement bounds', () => {
  const source = readFileSync('src/lib/hsb-control-plane-runtime/shadow-settlement.ts', 'utf8');
  for (const bound of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout']) {
    assert.match(source, new RegExp(`${bound}:\\s*\\d`), `the pool dropped pg's ${bound} bound`);
  }
});

// ===========================================================================
// 12. The effective SQL role is bound to the accepted grant boundary.
//
// `enqueue_projection` is granted to hsb_app, not hsb_webhook. The pool asks the
// server for that role explicitly, and an options value carried in the URL must
// not be able to change it. The behavioural half of this proof runs against real
// PostgreSQL in control-plane-shadow-settlement-postgres.test.ts.
// ===========================================================================

test('the pool asks PostgreSQL for the granted effective role', { timeout: 15_000 }, async () => {
  const pools: FakePool[] = [];
  await withDriver(
    async () => ({
      Pool: class extends FakePool {
        constructor(config: Record<string, unknown>) { super(config); pools.push(this); }
      } as unknown as new (config: unknown) => unknown,
    }),
    async () => {
      await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      assert.equal(pools.length, 1);
      const connectionString = String(pools[0].config.connectionString ?? '');
      const parsed = new URL(connectionString);
      assert.equal(parsed.searchParams.get('options'), '-c role=hsb_app');
      // The dedicated target itself is otherwise untouched.
      assert.equal(parsed.searchParams.get('host'), '/nonexistent-hsb-control-socket');
      assert.equal(parsed.searchParams.get('port'), '5432');
    },
  );
});

test('an effective role carried in the URL cannot override the granted one', { timeout: 15_000 }, async () => {
  const pools: FakePool[] = [];
  await withDriver(
    async () => ({
      Pool: class extends FakePool {
        constructor(config: Record<string, unknown>) { super(config); pools.push(this); }
      } as unknown as new (config: unknown) => unknown,
    }),
    async () => {
      await recordShadowCheckoutSettlement(FACTS, {
        env: {
          HSB_CONTROL_PLANE_SHADOW: 'true',
          HSB_CONTROL_PLANE_DATABASE_URL:
            `${CONTROL_URL}&options=${encodeURIComponent('-c role=hsb_webhook -c statement_timeout=0')}`,
        } as unknown as NodeJS.ProcessEnv,
      });
      assert.equal(pools.length, 1);
      const parsed = new URL(String(pools[0].config.connectionString ?? ''));
      assert.deepEqual(parsed.searchParams.getAll('options'), ['-c role=hsb_app']);
    },
  );
});

test('a control-plane target that is not a parseable URL is refused without echoing it', { timeout: 15_000 }, async () => {
  __clearShadowSettlementWarningsForTest();
  const secret = 'host=/var/run/pg user=hsb_app password=hunter2';
  const outcome = await recordShadowCheckoutSettlement(FACTS, {
    env: {
      HSB_CONTROL_PLANE_SHADOW: 'true',
      HSB_CONTROL_PLANE_DATABASE_URL: secret,
    } as unknown as NodeJS.ProcessEnv,
  });

  assert.equal(outcome.status, 'failed');
  assert.equal((outcome as { errorClass: string }).errorClass, 'ShadowSettlementConfigurationError');
  const warning = __readShadowSettlementWarningsForTest().at(-1)!;
  const logged = `${warning.message} ${JSON.stringify(warning.detail)}`;
  assert.ok(!logged.includes('hunter2') && !logged.includes('/var/run/pg'), `the refusal leaked the target: ${logged}`);
});

// ===========================================================================
// 13. The exported test seam is not a production activation path.
//
// `__setShadowSettlementTestOverrides` and `__setShadowSettlementDriverForTest`
// are importable from production code. Neither may stand in for the ambient
// exact-string flag, the dedicated control-plane target, or the real `pg` Pool:
// in production the seam is refused at its own boundary and is never consumed.
//
// Both probes run out of process under a scrubbed `NODE_ENV=production`
// environment — no ambient flag, no credentials, no network.
// ===========================================================================

/** The facts literal, with the `ord_` prefix kept off the same token as its hex. */
const PROBE_FACTS_LITERAL =
  `{ orderKey: 'ord' + '_' + ${JSON.stringify(HEX_A)}, `
  + `stripeSessionId: ${JSON.stringify(sessionIdOf(HEX_A))}, `
  + `amountTotalCents: 4900, currency: 'usd' }`;

const ADAPTER_SPECIFIER = JSON.stringify(path.resolve('src/lib/hsb-control-plane-runtime/shadow-settlement.ts'));

/**
 * `NODE_ENV` is required rather than defaulted: the probe environment is
 * scrubbed, so a caller that omitted it would silently test the wrong mode.
 * (It is also required by the `ProcessEnv` shape `execFileSync` expects.)
 */
function runProductionProbe(
  script: string,
  env: Record<string, string> & { NODE_ENV: 'production' },
): Record<string, unknown> {
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(output.trim().split('\n').pop()!) as Record<string, unknown>;
}

test('an imported test override cannot activate the shadow in production', { timeout: 90_000 }, () => {
  const script = `
    const mod = await import(${ADAPTER_SPECIFIER});
    const observed = { overrideRefused: null, sqlCalls: 0 };
    try {
      mod.__setShadowSettlementTestOverrides({
        env: { HSB_CONTROL_PLANE_SHADOW: 'true' },
        executor: async () => { observed.sqlCalls += 1; return { rows: [{ enqueue_projection: true }] }; },
      });
      observed.overrideRefused = false;
    } catch (error) {
      observed.overrideRefused = (error && error.name) || 'Error';
    }
    // The ordinary route-facing call: no options, no ambient flag, no target.
    const outcome = await mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL});
    console.log(JSON.stringify({ ...observed, outcome }));
  `;

  const probe = runProductionProbe(script, { NODE_ENV: 'production' });

  assert.deepEqual(
    probe.outcome,
    { status: 'disabled' },
    'imported test plumbing must not substitute for the ambient activation flag',
  );
  assert.equal(probe.sqlCalls, 0, 'an override-supplied executor must never be reached in production');
  assert.equal(
    probe.overrideRefused,
    'ShadowSettlementTestOverrideError',
    'the override boundary itself must fail closed in production',
  );
});

test('an imported driver override cannot replace the production Pool path', { timeout: 90_000 }, () => {
  const script = `
    const mod = await import(${ADAPTER_SPECIFIER});
    const observed = { driverRefused: null, fakePools: 0 };
    class FakePool {
      constructor() { observed.fakePools += 1; }
      on() { return this; }
      async query() { return { rows: [{ enqueue_projection: true }] }; }
      async end() {}
    }
    try {
      mod.__setShadowSettlementDriverForTest(async () => ({ Pool: FakePool }));
      observed.driverRefused = false;
    } catch (error) {
      observed.driverRefused = (error && error.name) || 'Error';
    }
    const outcome = await mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL});
    await mod.__closeShadowSettlementPoolForTest();
    console.log(JSON.stringify({ ...observed, outcome }));
  `;

  // Ambient activation is genuine here; what must not be substitutable is the
  // driver. The target is a unix socket path that does not exist, so the real
  // pg Pool fails locally and immediately: no DNS, no network, no credentials.
  const probe = runProductionProbe(script, {
    NODE_ENV: 'production',
    HSB_CONTROL_PLANE_SHADOW: 'true',
    HSB_CONTROL_PLANE_DATABASE_URL: CONTROL_URL,
  });

  assert.equal(probe.fakePools, 0, 'a test driver must never be constructed in production');
  assert.equal(
    (probe.outcome as { status: string }).status,
    'failed',
    'production must take the real pg Pool path and fail against a dead target, not record via test plumbing',
  );
  assert.equal(
    probe.driverRefused,
    'ShadowSettlementTestOverrideError',
    'the driver seam must fail closed in production too',
  );
});

test('the test override seam still works under test mode', async () => {
  const { calls, executor } = recordingExecutor();
  __setShadowSettlementTestOverrides({ env: ON_ENV, executor });
  try {
    const outcome = await recordShadowCheckoutSettlement(FACTS);
    assert.deepEqual(outcome, { status: 'recorded', inserted: true }, 'test ergonomics must be preserved');
    assert.equal(calls.length, 1);
  } finally {
    __resetShadowSettlementTestOverrides();
  }
});

// ===========================================================================
// 14. Rejection monitoring used by the hostile-error regressions below.
// ===========================================================================

/** Collect unhandled rejections for the duration of `body`. */
async function withUnhandledRejectionWatch<T>(body: () => Promise<T>): Promise<{ result: T; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await body();
    // Let a late rejection settle and be reported before the watch is removed.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { result, unhandled: [...unhandled] };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

// ===========================================================================
// 15. The sanitizers are total: a hostile *error object* cannot escape either.
//
// The idle-pool listener builds its detail — `sanitizedErrorClass(error)` and
// `sanitizedErrorCode(error)` — as the argument to `emitSanitizedWarning`, so
// those property reads happen *before* that function's containment. An error
// whose `code`, `constructor`, or `constructor.name` is an accessor that throws
// therefore throws straight out of the EventEmitter listener, where pg-pool
// emits outside any awaited query: an uncaught exception that, under Node's
// default policy, ends the process mid-webhook. Whatever the shape of the
// object, reading it may yield only bounded sanitized metadata — never the
// getter's own message, and never the object, the client, the target, or PII.
// ===========================================================================

/** Everything a hostile accessor might try to smuggle out through its throw. */
const GETTER_LEAK =
  'hostile getter (postgres://hsb_app:hunter2@db.invalid:5432/control) buyer@example.com'
  + ' at /Users/someone/secret.ts:1:1';

const GETTER_LEAK_MARKERS = [
  'postgres://', 'hunter2', 'db.invalid', 'buyer@example.com', 'hostile getter', '/Users/',
  'tok_secret', 'secretToken', 'connectionParameters',
];

/** An otherwise ordinary pg error whose SQLSTATE read throws. */
function errorWithThrowingCode(): unknown {
  const error = new Error('idle failure');
  Object.defineProperty(error, 'code', {
    configurable: true,
    get() { throw new Error(GETTER_LEAK); },
  });
  return error;
}

/** An error whose own `constructor` read throws, shadowing the prototype's. */
function errorWithThrowingConstructor(): unknown {
  const error = new Error('idle failure');
  Object.defineProperty(error, 'constructor', {
    configurable: true,
    get() { throw new Error(GETTER_LEAK); },
  });
  return error;
}

/** A safe-looking constructor whose `name` is the accessor that throws. */
function errorWithThrowingClassName(): unknown {
  return {
    code: 'ECONNRESET',
    constructor: { get name(): string { throw new Error(GETTER_LEAK); } },
  };
}

/** The general case: every property read on the object throws. */
function hostileProxyError(): unknown {
  return new Proxy({}, { get() { throw new Error(GETTER_LEAK); } });
}

type HostileCase = [label: string, make: () => unknown, probe: (error: unknown) => unknown];

const HOSTILE_ERROR_CASES: HostileCase[] = [
  ['a code getter that throws', errorWithThrowingCode, (e) => (e as { code: unknown }).code],
  [
    'a constructor getter that throws',
    errorWithThrowingConstructor,
    (e) => (e as { constructor: unknown }).constructor,
  ],
  [
    'a constructor.name getter that throws',
    errorWithThrowingClassName,
    (e) => (e as { constructor: { name: unknown } }).constructor.name,
  ],
  ['a proxy that throws on every read', hostileProxyError, (e) => (e as { code: unknown }).code],
];

/** Assert one emitted warning carries exactly the four bounded sanitized keys. */
function assertBoundedSanitizedDetail(entityKey: string): void {
  const warning = __readShadowSettlementWarningsForTest().at(-1);
  assert.ok(warning, 'a contained failure emits a bounded warning');
  const detail = warning.detail as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(detail).sort(),
    ['entityKey', 'entityKind', 'errorClass', 'errorCode'],
    'the sanitized line carries exactly the four bounded keys',
  );
  assert.equal(detail.entityKind, SHADOW_SETTLEMENT_ENTITY_KIND);
  assert.equal(detail.entityKey, entityKey);
  assert.match(
    String(detail.errorClass),
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/,
    'the error class stays inside its bound',
  );
  assert.ok(
    detail.errorCode === null || /^[A-Za-z0-9_]{1,16}$/.test(String(detail.errorCode)),
    `the error code stays inside its bound, was ${String(detail.errorCode)}`,
  );

  const logged = `${warning.message} ${JSON.stringify(warning.detail)}`;
  assert.ok(logged.length <= 512, `the sanitized line must stay bounded, was ${logged.length}`);
  for (const leak of GETTER_LEAK_MARKERS) {
    assert.ok(!logged.includes(leak), `the sanitized line leaked ${leak}: ${logged}`);
  }
}

/** Build the lazy pool over a FakePool and hand its idle error listener to `body`. */
async function withIdleErrorListener(
  body: (listener: (...args: unknown[]) => void) => Promise<void>,
): Promise<void> {
  const pools: FakePool[] = [];
  await withDriver(
    async () => ({
      Pool: class extends FakePool {
        constructor(config: Record<string, unknown>) { super(config); pools.push(this); }
      } as unknown as new (config: unknown) => unknown,
    }),
    async () => {
      await recordShadowCheckoutSettlement(FACTS, { env: poolEnv() });
      const listener = pools[0].listeners.get('error')?.[0];
      assert.equal(typeof listener, 'function', 'the pool must carry its idle error listener');
      await body(listener!);
    },
  );
}

for (const [label, make, probe] of HOSTILE_ERROR_CASES) {
  test(`the idle pool listener contains ${label}`, { timeout: 15_000 }, async () => {
    const hostile = make();
    assert.throws(() => probe(hostile), 'the fixture must actually be hostile');

    const { unhandled } = await withUnhandledRejectionWatch(async () => {
      await withIdleErrorListener(
        async (listener) => {
          // Exactly pg-pool's idle-client path: emitted outside any awaited
          // query, where a throw is an uncaught exception, not a rejection.
          assert.doesNotThrow(
            () => { listener(hostile, {}); },
            'a hostile error object must not escape the idle pool listener',
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      );
    });

    assert.deepEqual(unhandled, [], 'containing a hostile error must leave no unhandled rejection');
    assertBoundedSanitizedDetail('<idle>');
  });

  test(`the wrapper failure path contains ${label}`, { timeout: 15_000 }, async () => {
    const hostile = make();
    const { result: outcome, unhandled } = await withUnhandledRejectionWatch(() =>
      recordShadowCheckoutSettlement(FACTS, {
        env: ON_ENV,
        executor: async () => { throw hostile; },
      }));

    assert.equal(
      outcome.status,
      'failed',
      'the wrapper must still resolve, never reject, on a hostile error object',
    );
    if (outcome.status === 'failed') {
      assert.match(outcome.errorClass, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
      assert.ok(outcome.errorCode === null || /^[A-Za-z0-9_]{1,16}$/.test(outcome.errorCode));
      for (const leak of GETTER_LEAK_MARKERS) {
        assert.ok(!`${outcome.errorClass}${outcome.errorCode ?? ''}`.includes(leak));
      }
    }
    assert.deepEqual(unhandled, []);
    assertBoundedSanitizedDetail(FACTS.orderKey);
  });
}

// ===========================================================================
// 16. The per-call `options` argument is not a production activation path.
//
// Section 13 closed the *stored* test-override seam, but the direct second
// argument of `recordShadowCheckoutSettlement` bypassed it entirely: the
// wrapper merged caller options in every runtime. In production that meant
// `options.env` could supply the activation flag and the dedicated connection
// target, `options.executor` / `options.createExecutor` could stand in for the
// real `pg` pool, and `options.deadlineMs` could replace the one budget that
// keeps a wedged driver off the payment path. The wrapper is exported and
// importable from production code, so that argument is reachable from anywhere
// the wrapper is.
//
// Under production the activation flag, the dedicated target, the executor and
// the total deadline must therefore come from the ambient runtime alone, and
// the entire options object is ignored. Outside production only the four
// documented test seams remain available.
//
// Every probe runs out of process under a scrubbed environment: no ambient
// credentials, no network, no live database. The only connection target used is
// a unix socket path that does not exist, so the real driver fails locally.
// ===========================================================================

/** Which direct options a probe hands to the wrapper. Each one is counted. */
interface DirectOptionsProbe {
  env?: Record<string, string>;
  executor?: boolean;
  createExecutor?: boolean;
  deadlineMs?: number;
  hostileLogger?: boolean;
}

/**
 * One probe body: install the requested seams, make a single ordinary call, and
 * report what was actually reached. Counting the seams is what makes "never
 * consumed" observable rather than inferred from the outcome alone.
 */
function directOptionsProbeScript(supplied: DirectOptionsProbe): string {
  const installed: string[] = [];
  if (supplied.env !== undefined) {
    installed.push(`options.env = ${JSON.stringify(supplied.env)};`);
  }
  if (supplied.executor === true) {
    installed.push(
      'options.executor = async () => { observed.executorCalls += 1;'
      + ' return { rows: [{ enqueue_projection: true }] }; };',
    );
  }
  if (supplied.createExecutor === true) {
    installed.push(
      'options.createExecutor = async () => { observed.factoryCalls += 1;'
      + ' return async () => { observed.executorCalls += 1;'
      + ' return { rows: [{ enqueue_projection: true }] }; }; };',
    );
  }
  if (supplied.deadlineMs !== undefined) {
    installed.push(`options.deadlineMs = ${supplied.deadlineMs};`);
  }
  const warn = supplied.hostileLogger === true
    ? `() => { throw new Error('hostile logger'); }`
    : '(message, detail) => { observed.warnings.push([String(message), detail]); }';

  return `
    const mod = await import(${ADAPTER_SPECIFIER});
    const observed = { executorCalls: 0, factoryCalls: 0, warnings: [] };
    const options = { logger: { warn: ${warn} } };
    ${installed.join('\n    ')}
    const outcome = await mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}, options);
    await mod.__closeShadowSettlementPoolForTest();
    console.log(JSON.stringify({
      ...observed,
      outcome,
      exportedDeadline: mod.SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS,
    }));
  `;
}

/**
 * `NODE_ENV` is required rather than defaulted for the same reason as the
 * section 13 probe: the environment is scrubbed, so a caller that omitted the
 * mode would silently test the wrong one.
 */
function runScrubbedProbe(
  script: string,
  env: Record<string, string> & { NODE_ENV: 'production' | 'test' },
): Record<string, unknown> {
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(output.trim().split('\n').pop()!) as Record<string, unknown>;
}

/** Production with nothing ambient: no flag, no target, no credentials. */
const PRODUCTION_INERT: Record<string, string> & { NODE_ENV: 'production' } = {
  NODE_ENV: 'production',
};

/** Production with a genuine ambient flag and a dead local target. */
const PRODUCTION_ACTIVATED: Record<string, string> & { NODE_ENV: 'production' } = {
  NODE_ENV: 'production',
  HSB_CONTROL_PLANE_SHADOW: 'true',
  HSB_CONTROL_PLANE_DATABASE_URL: CONTROL_URL,
};

/** The activation flag and target a hostile caller would try to inject. */
const INJECTED_ENV: Record<string, string> = {
  HSB_CONTROL_PLANE_SHADOW: 'true',
  HSB_CONTROL_PLANE_DATABASE_URL: CONTROL_URL,
};

function probeOutcome(probe: Record<string, unknown>): { status: string; errorClass?: string; errorCode?: string | null } {
  return probe.outcome as { status: string; errorClass?: string; errorCode?: string | null };
}

/** No injected DB seam was reached, whatever the outcome was. */
function assertNoInjectedSeamReached(probe: Record<string, unknown>): void {
  assert.equal(probe.executorCalls, 0, 'a directly supplied executor must never be reached in production');
  assert.equal(probe.factoryCalls, 0, 'a directly supplied executor factory must never be reached in production');
}

test('a direct options.env and executor cannot activate the shadow in production', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ env: INJECTED_ENV, executor: true }),
    PRODUCTION_INERT,
  );

  assert.deepEqual(
    probe.outcome,
    { status: 'disabled' },
    'a caller-supplied env must not substitute for the ambient activation flag',
  );
  assertNoInjectedSeamReached(probe);
  assert.deepEqual(probe.warnings, [], 'an off shadow emits nothing at all');
});

test('a direct options.env and executor factory cannot activate the shadow in production', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ env: INJECTED_ENV, createExecutor: true }),
    PRODUCTION_INERT,
  );

  assert.deepEqual(
    probe.outcome,
    { status: 'disabled' },
    'a caller-supplied executor factory must not substitute for the ambient flag either',
  );
  assertNoInjectedSeamReached(probe);
  assert.deepEqual(probe.warnings, [], 'an off shadow emits nothing at all');
});

test('a direct options.env cannot supply the dedicated control-plane target in production', { timeout: 90_000 }, () => {
  // The ambient flag is genuine here; what must not be injectable is the target.
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ env: INJECTED_ENV }),
    { NODE_ENV: 'production', HSB_CONTROL_PLANE_SHADOW: 'true' },
  );

  assert.equal(probeOutcome(probe).status, 'failed');
  assert.equal(
    probeOutcome(probe).errorClass,
    'ShadowSettlementConfigurationError',
    'with no ambient target the shadow must refuse, not borrow a caller-supplied one',
  );
});

test('a genuine ambient flag still refuses a direct options.executor', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ executor: true }),
    PRODUCTION_ACTIVATED,
  );

  assert.equal(
    probeOutcome(probe).status,
    'failed',
    'production must take the real pg Pool path and fail against a dead target, not record via a caller executor',
  );
  assertNoInjectedSeamReached(probe);
});

test('a genuine ambient flag still refuses a direct options.createExecutor', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ createExecutor: true }),
    PRODUCTION_ACTIVATED,
  );

  assert.equal(
    probeOutcome(probe).status,
    'failed',
    'a caller-supplied factory must not displace the dedicated pool',
  );
  assertNoInjectedSeamReached(probe);
});

test('a direct deadline override cannot shorten the production evidence budget', { timeout: 90_000 }, () => {
  // A 1ms budget would expire long before the lazy driver import resolves, so a
  // consumed override is unmistakable: the failure would be the deadline's own.
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ deadlineMs: 1 }),
    PRODUCTION_ACTIVATED,
  );

  assert.equal(probeOutcome(probe).status, 'failed', 'a dead target must still fail');
  assert.notEqual(
    probeOutcome(probe).errorClass,
    'ShadowSettlementDeadlineError',
    'a caller must not be able to replace the production total deadline with its own',
  );
  assert.equal(
    probe.exportedDeadline,
    shadowAdapter.SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS,
    'the production budget stays the exported default',
  );
});

test('every direct option together is refused under a genuine ambient flag', { timeout: 90_000 }, () => {
  const started = Date.now();
  const probe = runScrubbedProbe(
    directOptionsProbeScript({
      env: INJECTED_ENV,
      executor: true,
      createExecutor: true,
      deadlineMs: 120_000,
    }),
    PRODUCTION_ACTIVATED,
  );
  const elapsed = Date.now() - started;

  assert.equal(
    probeOutcome(probe).status,
    'failed',
    'combining the seams must not record evidence through caller plumbing',
  );
  assertNoInjectedSeamReached(probe);
  assert.notEqual(probeOutcome(probe).errorClass, 'ShadowSettlementDeadlineError');
  assert.equal(probe.exportedDeadline, shadowAdapter.SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS);
  assert.ok(
    elapsed < 60_000,
    `a caller-supplied 120s budget must not govern the production path, took ${elapsed}ms`,
  );
});

test('every direct option together is disabled with no ambient flag', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    directOptionsProbeScript({
      env: INJECTED_ENV,
      executor: true,
      createExecutor: true,
      deadlineMs: 120_000,
    }),
    PRODUCTION_INERT,
  );

  assert.deepEqual(
    probe.outcome,
    { status: 'disabled' },
    'no combination of direct options may stand in for the ambient flag',
  );
  assertNoInjectedSeamReached(probe);
  assert.deepEqual(probe.warnings, []);
});

test('a caller-supplied logger is ignored in production', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(directOptionsProbeScript({}), PRODUCTION_ACTIVATED);

  assert.equal(probeOutcome(probe).status, 'failed');
  assert.deepEqual(probe.warnings, [], 'caller logging code must not receive the internal warning');
});

test('a hostile direct logger is still contained in production', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ hostileLogger: true }),
    PRODUCTION_ACTIVATED,
  );

  assert.equal(
    probeOutcome(probe).status,
    'failed',
    'a throwing logger must not turn best-effort evidence into a rejected webhook',
  );
});

test('direct option injection ergonomics are unchanged outside production', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    directOptionsProbeScript({ env: INJECTED_ENV, executor: true, deadlineMs: 5_000 }),
    { NODE_ENV: 'test' },
  );

  assert.deepEqual(
    probe.outcome,
    { status: 'recorded', inserted: true },
    'test-mode callers must keep injecting env, executor, and deadline',
  );
  assert.equal(probe.executorCalls, 1, 'the injected executor must still be the one that runs');
});

// ===========================================================================
// 17. Production treats the direct options object as an untrusted boundary.
//
// Ignoring injected values is not enough: object spread enumerates the caller's
// object and invokes enumerable getters before filtering. In production the
// object must never be enumerated or read at all. The warning destination is
// module-owned and non-injectable.
// ===========================================================================

function hostileProductionOptionsProbeScript(): string {
  return `
    const mod = await import(${ADAPTER_SPECIFIER});
    const observed = { reads: [], escaped: [] };
    const throwing = {};
    for (const key of ['env', 'executor', 'createExecutor', 'deadlineMs', 'logger']) {
      Object.defineProperty(throwing, key, {
        enumerable: true,
        get() {
          observed.reads.push(key);
          throw new Error('LEAK_' + key);
        },
      });
    }
    const ownKeysProxy = new Proxy({}, {
      ownKeys() { throw new Error('LEAK_ownKeys'); },
    });
    for (const [label, options] of [['getters', throwing], ['ownKeys', ownKeysProxy]]) {
      try {
        const outcome = await mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}, options);
        observed[label] = outcome;
      } catch (error) {
        observed.escaped.push(String(error && error.message));
      }
    }
    console.log(JSON.stringify(observed));
  `;
}

for (const [label, env, expectedStatus] of [
  ['ambient flag absent', PRODUCTION_INERT, 'disabled'],
  ['ambient flag present', { NODE_ENV: 'production', HSB_CONTROL_PLANE_SHADOW: 'true' }, 'failed'],
] as const) {
  test(`production never enumerates hostile options with ${label}`, { timeout: 90_000 }, () => {
    const probe = runScrubbedProbe(hostileProductionOptionsProbeScript(), env);

    assert.deepEqual(probe.escaped, [], 'no option trap or getter may escape the best-effort boundary');
    assert.deepEqual(
      probe.reads,
      [],
      'production must not read any direct option property',
    );
    assert.equal((probe.getters as { status: string }).status, expectedStatus);
    assert.equal((probe.ownKeys as { status: string }).status, expectedStatus);
    assert.ok(
      !JSON.stringify(probe).includes('LEAK_'),
      'a hostile option getter or proxy trap must not leak into the outcome',
    );
  });
}

test('the source does not export a raw executor-taking projection helper', () => {
  const source = readFileSync('src/lib/hsb-control-plane-runtime/shadow-settlement.ts', 'utf8');
  assert.doesNotMatch(
    source,
    /export\s+(?:async\s+)?function\s+enqueueShadowSettlementProjection\b/,
    'the executor-taking core must remain module-private',
  );
});

test('a production dynamic import exposes no callable raw executor helper', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(`
    const mod = await import(${ADAPTER_SPECIFIER});
    console.log(JSON.stringify({
      hasRawHelper: Object.prototype.hasOwnProperty.call(mod, 'enqueueShadowSettlementProjection'),
      rawHelperType: typeof mod.enqueueShadowSettlementProjection,
      callableExecutorExports: Object.entries(mod)
        .filter(([name, value]) => typeof value === 'function' && /enqueue.*projection|projection.*executor/i.test(name))
        .map(([name]) => name),
    }));
  `, PRODUCTION_INERT);

  assert.equal(probe.hasRawHelper, false);
  assert.equal(probe.rawHelperType, 'undefined');
  assert.deepEqual(probe.callableExecutorExports, []);
});

// ===========================================================================
// 18. A lazy pool belongs to the runtime mode that created it.
//
// NODE_ENV is ambient mutable process state. A pool built through the injected
// nonproduction driver must never survive a later production call, and a real
// production pool must likewise never be reused after the process enters test
// mode. Both directions are proved out of process so this suite's own mode and
// cache cannot influence the result. The production target is a dedicated dead
// Unix socket: the real pg path is exercised locally, deterministically, and
// without a server, credentials, DNS, or TCP.
// ===========================================================================

function runtimeModeTransitionProbeScript(direction: 'test-to-production' | 'production-to-test'): string {
  return `
    const mod = await import(${ADAPTER_SPECIFIER});
    const observed = { constructed: 0, queries: 0, ended: 0 };
    class FakePool {
      constructor() { observed.constructed += 1; }
      on() { return this; }
      async query() {
        observed.queries += 1;
        return { rows: [{ enqueue_projection: true }] };
      }
      async end() { observed.ended += 1; }
    }
    const fakeLoader = async () => ({ Pool: FakePool });
    const testOptions = {
      env: {
        HSB_CONTROL_PLANE_SHADOW: 'true',
        HSB_CONTROL_PLANE_DATABASE_URL: ${JSON.stringify(CONTROL_URL)},
      },
    };
    const productionEnv = {
      HSB_CONTROL_PLANE_SHADOW: 'true',
      HSB_CONTROL_PLANE_DATABASE_URL: ${JSON.stringify(CONTROL_URL)},
    };
    let before;
    let after;
    if (${JSON.stringify(direction)} === 'test-to-production') {
      process.env.NODE_ENV = 'test';
      mod.__setShadowSettlementDriverForTest(fakeLoader);
      before = await mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}, testOptions);
      process.env.NODE_ENV = 'production';
      Object.assign(process.env, productionEnv);
      after = await Promise.all([
        mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}),
        mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}),
        mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}),
      ]);
    } else {
      process.env.NODE_ENV = 'production';
      Object.assign(process.env, productionEnv);
      before = await mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL});
      process.env.NODE_ENV = 'test';
      mod.__setShadowSettlementDriverForTest(fakeLoader);
      after = await Promise.all([
        mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}, testOptions),
        mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}, testOptions),
        mod.recordShadowCheckoutSettlement(${PROBE_FACTS_LITERAL}, testOptions),
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    await mod.__closeShadowSettlementPoolForTest();
    console.log(JSON.stringify({ before, after, observed }));
  `;
}

test('a cached test driver is invalidated before a test-to-production transition', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    runtimeModeTransitionProbeScript('test-to-production'),
    { NODE_ENV: 'test' },
  );
  assert.deepEqual(probe.before, { status: 'recorded', inserted: true });
  assert.deepEqual(
    (probe.after as Array<{ status: string }>).map(({ status }) => status),
    ['failed', 'failed', 'failed'],
    'production calls must use the real driver path against the dead local target',
  );
  assert.deepEqual(probe.observed, { constructed: 1, queries: 1, ended: 1 });
});

test('a cached production pool is invalidated before a production-to-test transition', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(
    runtimeModeTransitionProbeScript('production-to-test'),
    { NODE_ENV: 'production' },
  );
  assert.equal((probe.before as { status: string }).status, 'failed');
  assert.deepEqual(
    probe.after,
    Array.from({ length: 3 }, () => ({ status: 'recorded', inserted: true })),
  );
  assert.deepEqual(
    probe.observed,
    { constructed: 1, queries: 3, ended: 1 },
    'same-mode concurrent calls share one replacement pool and close it once',
  );
});

// ===========================================================================
// 19. Facts are hostile exported-boundary input, including in the catch path.
// ===========================================================================

function hostileFactsProbeScript(): string {
  return `
    const mod = await import(${ADAPTER_SPECIFIER});
    const marker = 'HOSTILE_FACTS_MARKER_postgres://secret@db.invalid/buyer@example.com';
    const makeCases = () => {
      const throwingOrderKey = { ...${PROBE_FACTS_LITERAL} };
      Object.defineProperty(throwingOrderKey, 'orderKey', {
        enumerable: true,
        get() { throw new Error(marker); },
      });
      const allReadProxy = new Proxy({}, {
        get() { throw new Error(marker); },
        ownKeys() { throw new Error(marker); },
      });
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      const hostileObject = Object.create(null);
      Object.defineProperty(hostileObject, 'toString', {
        get() { throw new Error(marker); },
      });
      return [
        ['throwing-orderKey', throwingOrderKey],
        ['all-read-ownKeys-proxy', allReadProxy],
        ['revoked-proxy', revocable.proxy],
        ['hostile-primitive', Symbol(marker)],
        ['hostile-object', hostileObject],
      ];
    };
    const results = [];
    const unhandled = [];
    process.on('unhandledRejection', (reason) => { unhandled.push(String(reason)); });
    for (const mode of ['test', 'production']) {
      process.env.NODE_ENV = mode;
      process.env.HSB_CONTROL_PLANE_SHADOW = 'true';
      delete process.env.HSB_CONTROL_PLANE_DATABASE_URL;
      for (const [label, facts] of makeCases()) {
        let escaped = null;
        let outcome;
        try {
          outcome = await mod.recordShadowCheckoutSettlement(facts, {
            env: { HSB_CONTROL_PLANE_SHADOW: 'true' },
            executor: async () => { throw new Error('executor must not run'); },
          });
        } catch (error) {
          escaped = String(error);
        }
        results.push({ mode, label, outcome, escaped });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    console.log(JSON.stringify({ marker, results, unhandled }));
  `;
}

test('hostile facts are totally contained in test and production modes', { timeout: 90_000 }, () => {
  const probe = runScrubbedProbe(hostileFactsProbeScript(), { NODE_ENV: 'test' });
  assert.deepEqual(probe.unhandled, [], 'hostile facts must leave no unhandled rejection');
  const results = probe.results as Array<{
    mode: string;
    label: string;
    outcome?: ShadowSettlementOutcome;
    escaped: string | null;
  }>;
  assert.equal(results.length, 10);
  for (const result of results) {
    assert.equal(result.escaped, null, `${result.mode}/${result.label} escaped the recorder`);
    assert.equal(result.outcome?.status, 'failed', `${result.mode}/${result.label} did not fail safely`);
    assert.ok(
      !JSON.stringify(result).includes(String(probe.marker)),
      `${result.mode}/${result.label} leaked the hostile marker`,
    );
  }
});

// ===========================================================================
// 20. Each hostile fact is sampled exactly once into a safe snapshot.
// ===========================================================================

const FACT_FIELDS = [
  'orderKey',
  'stripeSessionId',
  'amountTotalCents',
  'currency',
] as const;

type FactField = typeof FACT_FIELDS[number];

const INVALID_FIRST_VALUE: Record<FactField, unknown> = {
  orderKey: '',
  stripeSessionId: '',
  amountTotalCents: -1,
  currency: 'USD',
};

function statefulFacts(
  field: FactField,
  first: 'throw' | 'invalid' | 'valid',
  later: 'valid' | 'throw' | 'change',
) {
  const reads = new Map<PropertyKey, number>();
  let enumerations = 0;
  let extraFieldReads = 0;
  const marker = `HOSTILE_FACT_${field}_postgres://secret@db.invalid/buyer@example.com`;
  const values = { ...FACTS } as Record<FactField, unknown>;
  const target = Object.create(null) as Record<PropertyKey, unknown>;

  for (const key of FACT_FIELDS) {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: false,
      get() {
        const count = (reads.get(key) ?? 0) + 1;
        reads.set(key, count);
        if (key !== field) return values[key];
        if (count === 1) {
          if (first === 'throw') throw new Error(marker);
          return first === 'invalid' ? INVALID_FIRST_VALUE[key] : values[key];
        }
        if (later === 'throw') throw new Error(marker);
        if (later === 'change') {
          return key === 'orderKey' ? orderIdOf(HEX_B) : INVALID_FIRST_VALUE[key];
        }
        return values[key];
      },
    });
  }
  Object.defineProperty(target, 'buyerEmail', {
    enumerable: true,
    get() {
      extraFieldReads += 1;
      throw new Error(marker);
    },
  });

  const facts = new Proxy(target, {
    ownKeys() {
      enumerations += 1;
      throw new Error(marker);
    },
  }) as unknown as ShadowSettlementFacts;
  return {
    facts,
    reads,
    marker,
    enumerations: () => enumerations,
    extraFieldReads: () => extraFieldReads,
  };
}

function assertSingleFactReads(reads: Map<PropertyKey, number>): void {
  for (const field of FACT_FIELDS) {
    assert.equal(reads.get(field), 1, `${field} must be read exactly once`);
  }
}

for (const field of FACT_FIELDS) {
  for (const first of ['throw', 'invalid'] as const) {
    test(`${field}: a ${first} first read cannot be replaced by a valid catch-path read`, async () => {
      const probe = statefulFacts(field, first, 'valid');
      let executorCalls = 0;

      const { result: outcome, unhandled } = await withUnhandledRejectionWatch(() =>
        recordShadowCheckoutSettlement(probe.facts, {
          env: ON_ENV,
          executor: async () => {
            executorCalls += 1;
            return { rows: [{ enqueue_projection: true }] };
          },
        }));

      assert.equal(outcome.status, 'failed');
      assert.equal(executorCalls, 0);
      assertSingleFactReads(probe.reads);
      assert.equal(probe.enumerations(), 0, 'hostile facts must never be enumerated');
      assert.equal(probe.extraFieldReads(), 0, 'extra fact fields must never be read');
      assert.deepEqual(unhandled, []);
      assertBoundedSanitizedDetail('<invalid>');
    });
  }

  test(`${field}: a valid first read is authoritative after later change or throw`, async () => {
    for (const later of ['throw', 'change'] as const) {
      const probe = statefulFacts(field, 'valid', later);
      const refusal = Object.assign(new Error('stage off'), { code: 'ZH001' });

      const { result: outcome, unhandled } = await withUnhandledRejectionWatch(() =>
        recordShadowCheckoutSettlement(probe.facts, {
          env: ON_ENV,
          executor: async () => { throw refusal; },
        }));

      assert.deepEqual(outcome, { status: 'failed', errorClass: 'Error', errorCode: 'ZH001' });
      assertSingleFactReads(probe.reads);
      assert.equal(probe.enumerations(), 0, 'hostile facts must never be enumerated');
      assert.equal(probe.extraFieldReads(), 0, 'extra fact fields must never be read');
      assert.deepEqual(unhandled, []);
      assertBoundedSanitizedDetail(FACTS.orderKey);
    }
  });
}

test('canonical bytes sample hostile facts once and ignore extra fields', () => {
  const probe = statefulFacts('orderKey', 'valid', 'throw');
  assert.equal(canonicalShadowSettlementBytes(probe.facts).toString('utf8'), EXPECTED_CANONICAL);
  assertSingleFactReads(probe.reads);
  assert.equal(probe.enumerations(), 0);
  assert.equal(probe.extraFieldReads(), 0);
});

test('an all-read hostile proxy is sampled totally once without enumeration or leakage', async () => {
  const reads = new Map<PropertyKey, number>();
  let enumerations = 0;
  const marker = 'ALL_READ_FACTS_postgres://secret@db.invalid/buyer@example.com';
  const facts = new Proxy({}, {
    get(_target, key) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      throw new Error(marker);
    },
    ownKeys() {
      enumerations += 1;
      throw new Error(marker);
    },
  }) as ShadowSettlementFacts;
  const { result: outcome, unhandled } = await withUnhandledRejectionWatch(() =>
    recordShadowCheckoutSettlement(facts, {
      env: ON_ENV,
      executor: async () => { throw new Error('executor must not run'); },
    }));

  assert.equal(outcome.status, 'failed');
  assertSingleFactReads(reads);
  assert.equal(enumerations, 0);
  assert.deepEqual(unhandled, []);
  assertBoundedSanitizedDetail('<invalid>');
});

test('a revoked facts proxy is contained without enumeration, rejection, or leakage', async () => {
  const revocable = Proxy.revocable({ ...FACTS }, {});
  revocable.revoke();
  const { result: outcome, unhandled } = await withUnhandledRejectionWatch(() =>
    recordShadowCheckoutSettlement(revocable.proxy, {
      env: ON_ENV,
      executor: async () => { throw new Error('executor must not run'); },
    }));

  assert.equal(outcome.status, 'failed');
  assert.deepEqual(unhandled, []);
  assertBoundedSanitizedDetail('<invalid>');
});
