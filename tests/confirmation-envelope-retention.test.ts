/*
 * L-4 Slice A3-7 — confirmation-envelope retention, SAFE INERT skeleton.
 *
 * What ships is a retention resolver that is structurally unconfigured, a
 * scheduled route that always reports `retention_unconfigured`, and a pure
 * eligibility planner whose closed vocabulary has no "purge is due" member.
 * Nothing here lists, reads, writes or deletes an order or an envelope.
 *
 * Activation — any real delete of a frozen envelope — is NOT part of this
 * slice and requires ALL of:
 *
 *   - A3-6 integrated (the reconciliation writers for RECONCILED_ACCEPTED and
 *     OWNER_AUTHORIZED_RESEND_SENT; OD-1 for the resend state);
 *   - OD-2: an owner-decided retention period (none is invented here);
 *   - OD-3: who may set `confirmationEmailRetentionHoldUntil`, and whether a
 *     past hold ever expires (until then ANY present hold blocks);
 *   - store amendments: an expected-objectPath delete, a read-back that proves
 *     `not_found` before `purgedAt` is marked, and the record-level purge
 *     claim that closes the hold race;
 *   - a separate owner approval to enable it on Production.
 *
 * Every test here runs under both `TZ=UTC` and `TZ=America/Chicago`.
 * Order ids are assembled, never written as literals (REQ16).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as route from '../src/app/api/cron/confirmation-envelope-purge/route.ts';
import {
  CONFIRMATION_ENVELOPE_PURGE_ELIGIBILITY,
  evaluateConfirmationEnvelopePurgeEligibility,
  resolveConfirmationEnvelopeRetention,
  runConfirmationEnvelopePurge,
} from '../src/lib/confirmation-envelope-retention.ts';
import { CONFIRMATION_EMAIL_STATES } from '../src/lib/confirmation-email-state.ts';
import type { OrderRecord } from '../src/lib/orders.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ORDER_ID = `ord_${'a37e'.repeat(4)}`;
const OTHER_ORDER_ID = `ord_${'b37f'.repeat(4)}`;
const NOW_MS = Date.parse('2026-10-01T12:00:00.000Z');
const ACCEPTED_AT = '2026-09-01T12:00:00.000Z';
const CREATED_AT = '2026-09-01T11:59:00.000Z';
const RETENTION_ENV = 'HSB_CONFIRMATION_ENVELOPE_RETENTION_DAYS';
const SKIPPED = { ok: true, skipped: 'retention_unconfigured' } as const;
const ORIGIN = 'https://herostorybooks.com';
const PURGE_URL = `${ORIGIN}/api/cron/confirmation-envelope-purge`;

function validRef(orderId = ORDER_ID, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelopeVersion: 1,
    orderId,
    templateVersion: 'order-confirmation@a37test',
    createdAt: CREATED_AT,
    canonicalDigest: 'b'.repeat(64),
    canonicalBytes: 1234,
    accountLabel: 'hsb-test-prod-v1',
    storageKind: 'private_blob',
    objectPath: `confirmation-envelopes/${orderId}/v1.json`,
    purgedAt: null,
    ...overrides,
  };
}

/** A record that is state-eligible in every respect; each case changes one thing. */
function eligibleOrder(overrides: Record<string, unknown> = {}): OrderRecord {
  return {
    id: ORDER_ID,
    childName: 'Luna',
    email: 'buyer@example.invalid',
    bookFormat: 'digital',
    paymentStatus: 'paid',
    paidAt: '2026-09-01T11:58:00.000Z',
    confirmationEmailSentAt: ACCEPTED_AT,
    confirmationEmailState: 'ACCEPTED',
    confirmationEmailAcceptedAt: ACCEPTED_AT,
    confirmationEmailEnvelopeRef: validRef(),
    confirmationEmailRetentionHoldUntil: null,
    createdAt: '2026-09-01T11:50:00.000Z',
    updatedAt: ACCEPTED_AT,
    ...overrides,
  } as unknown as OrderRecord;
}

const evaluate = (overrides: Record<string, unknown> = {}, nowMs = NOW_MS) =>
  evaluateConfirmationEnvelopePurgeEligibility(eligibleOrder(overrides), nowMs);

// ── Spies: environment reads, network, and the local order store ────────────

interface Observation<T> {
  value: T;
  envReads: string[];
  fetchCalls: number;
  storeChanged: boolean;
}

function snapshotDir(dir: string): string {
  return JSON.stringify(readdirSync(dir).sort().map((name) => [name, readFileSync(path.join(dir, name), 'utf8')]));
}

/**
 * Run `fn` with `process.env` behind a recording proxy, `fetch` replaced by a
 * recorder, a fake Blob credential present and a seeded local order store. A
 * reach into any of them is visible; nothing real can be contacted.
 */
async function observe<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<Observation<T>> {
  const storeDir = mkdtempSync(path.join(os.tmpdir(), 'hsb-a37-retention-'));
  writeFileSync(path.join(storeDir, `${ORDER_ID}.json`), JSON.stringify(eligibleOrder()));
  const before = snapshotDir(storeDir);

  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  const scoped: NodeJS.ProcessEnv = {
    ...originalEnv,
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_A37Retention01_fakesecret01',
    HSB_ORDER_STORE_DIR: storeDir,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete scoped[key];
    else scoped[key] = value;
  }
  const envReads: string[] = [];
  let fetchCalls = 0;
  let recording = false;
  const proxy = new Proxy(scoped, {
    get(target, key, receiver) {
      if (recording && typeof key === 'string') envReads.push(key);
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (recording && typeof key === 'string') envReads.push(key);
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      if (recording) envReads.push('<enumerated>');
      return Reflect.ownKeys(target);
    },
  });
  process.env = proxy;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('A3-7 inert retention must not reach the network');
  }) as typeof fetch;
  try {
    recording = true;
    const value = await fn();
    recording = false;
    return { value, envReads, fetchCalls, storeChanged: snapshotDir(storeDir) !== before };
  } finally {
    recording = false;
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    rmSync(storeDir, { recursive: true, force: true });
  }
}

const RETENTION_VALUES: ReadonlyArray<string | undefined> = [undefined, '30', '1', 'abc', '0', '36500', ' 30 ', ''];

// ── The resolver: structurally unconfigured ─────────────────────────────────

test('A3-7 resolver: retention is unconfigured whatever the retention variable holds', async () => {
  for (const value of RETENTION_VALUES) {
    const seen = await observe({ [RETENTION_ENV]: value }, () => resolveConfirmationEnvelopeRetention());
    assert.deepEqual(seen.value, { configured: false }, `retention variable = ${JSON.stringify(value)}`);
    assert.deepEqual(Object.keys(seen.value), ['configured']);
    assert.deepEqual(seen.envReads, [], `the resolver read the environment: ${seen.envReads.join(', ')}`);
    assert.equal(seen.fetchCalls, 0);
    assert.equal(seen.storeChanged, false);
  }
});

test('A3-7 resolver: it takes no input, so no period can be handed to it either', () => {
  assert.equal(resolveConfirmationEnvelopeRetention.length, 0);
});

// ── The run: reports and does nothing ───────────────────────────────────────

test('A3-7 run: every run, dry or not, reports retention_unconfigured and touches nothing', async () => {
  for (const value of RETENTION_VALUES) {
    for (const dryRun of [false, true]) {
      const seen = await observe({ [RETENTION_ENV]: value }, () => runConfirmationEnvelopePurge({ dryRun }));
      const label = `retention variable = ${JSON.stringify(value)}, dryRun = ${dryRun}`;
      assert.deepEqual(seen.value, SKIPPED, label);
      assert.deepEqual(Object.keys(seen.value), ['ok', 'skipped'], label);
      assert.deepEqual(seen.envReads, [], `${label}: the run read ${seen.envReads.join(', ')}`);
      assert.equal(seen.fetchCalls, 0, `${label}: the run reached the network`);
      assert.equal(seen.storeChanged, false, `${label}: the run changed the order store`);
    }
  }
});

// ── The planner: a closed vocabulary with no "due" member ───────────────────

test('A3-7 planner: the vocabulary is closed and has no purge-due or actionable member', () => {
  assert.deepEqual([...CONFIRMATION_ENVELOPE_PURGE_ELIGIBILITY], [
    'state_eligible',
    'not_terminal',
    'no_envelope_ref',
    'ref_invalid',
    'already_purged',
    'anchor_unavailable',
    'retention_hold_active',
    'retention_hold_invalid',
  ]);
  assert.ok(Object.isFrozen(CONFIRMATION_ENVELOPE_PURGE_ELIGIBILITY));
  for (const member of CONFIRMATION_ENVELOPE_PURGE_ELIGIBILITY) {
    assert.doesNotMatch(member, /due|delete|purge_now|actionable/);
  }
});

test('A3-7 planner: ACCEPTED with a valid live ref, a past canonical anchor and no hold is state_eligible', () => {
  assert.equal(evaluate(), 'state_eligible');
  assert.equal(evaluate({ confirmationEmailRetentionHoldUntil: undefined }), 'state_eligible');
  assert.equal(
    evaluate({ confirmationEmailEnvelopeRef: validRef(ORDER_ID, { objectPath: `preview-a37/confirmation-envelopes/${ORDER_ID}/v1.json` }) }),
    'state_eligible',
    'a namespaced ref is as valid as a flat one',
  );
});

test('A3-7 planner: every state but the three terminal ones is not_terminal', () => {
  const terminal = new Set(['ACCEPTED', 'RECONCILED_ACCEPTED', 'OWNER_AUTHORIZED_RESEND_SENT']);
  const nonTerminal = CONFIRMATION_EMAIL_STATES.filter((state) => !terminal.has(state));
  assert.deepEqual(nonTerminal, ['SNAPSHOTTED', 'DISPATCH_INTENT_RECORDED', 'PROVABLY_PRE_DISPATCH_FAILED', 'RECONCILIATION_REQUIRED']);
  for (const state of [...nonTerminal, null, undefined, '', 'accepted', 'LEGACY_ACCEPTED', 'GARBAGE', 0, {}]) {
    assert.equal(evaluate({ confirmationEmailState: state }), 'not_terminal', `state ${JSON.stringify(state)}`);
  }
});

test('A3-7 planner: RECONCILED_ACCEPTED and OWNER_AUTHORIZED_RESEND_SENT have no anchor until A3-6 exists', () => {
  for (const state of ['RECONCILED_ACCEPTED', 'OWNER_AUTHORIZED_RESEND_SENT']) {
    assert.equal(evaluate({ confirmationEmailState: state }), 'anchor_unavailable', state);
  }
});

test('A3-7 planner: an ACCEPTED record with no ref (the LEGACY_ACCEPTED shape) is no_envelope_ref', () => {
  assert.equal(evaluate({ confirmationEmailEnvelopeRef: null }), 'no_envelope_ref');
  assert.equal(evaluate({ confirmationEmailEnvelopeRef: undefined }), 'no_envelope_ref');
});

test('A3-7 planner: a tombstoned ref is already_purged', () => {
  assert.equal(
    evaluate({ confirmationEmailEnvelopeRef: validRef(ORDER_ID, { purgedAt: '2026-09-30T00:00:00.000Z' }) }),
    'already_purged',
  );
});

test('A3-7 planner: a malformed or foreign ref is ref_invalid', () => {
  const { purgedAt: _omitted, ...missingKey } = validRef();
  const cases: Array<[string, unknown]> = [
    ['foreign order id', validRef(OTHER_ORDER_ID)],
    ['object path of another order', validRef(ORDER_ID, { objectPath: `confirmation-envelopes/${OTHER_ORDER_ID}/v1.json` })],
    ['a missing key', missingKey],
    ['an extra key', { ...validRef(), objectUrl: 'https://example.invalid/x' }],
    ['a request-like key', { ...validRef(), html: '<p>hi</p>' }],
    ['a bad digest', validRef(ORDER_ID, { canonicalDigest: 'xyz' })],
    ['a public storage kind', validRef(ORDER_ID, { storageKind: 'public_blob' })],
    ['a non-canonical tombstone', validRef(ORDER_ID, { purgedAt: 'yesterday' })],
    ['a string', 'confirmation-envelopes/x/v1.json'],
    ['an array', [validRef()]],
    ['a number', 1],
  ];
  for (const [label, ref] of cases) {
    assert.equal(evaluate({ confirmationEmailEnvelopeRef: ref }), 'ref_invalid', label);
  }
});

test('A3-7 planner: any present hold blocks — a canonical one is active whether past or future', () => {
  for (const hold of ['2099-01-01T00:00:00.000Z', '2026-10-01T12:00:00.001Z', '2026-10-01T12:00:00.000Z', '2020-01-01T00:00:00.000Z']) {
    assert.equal(evaluate({ confirmationEmailRetentionHoldUntil: hold }), 'retention_hold_active', hold);
  }
});

test('A3-7 planner: a present hold that is not a canonical instant is retention_hold_invalid, never ignored', () => {
  for (const hold of ['', 'tomorrow', '2026-10-01', '2026-10-01T12:00:00Z', 0, false, true, {}, []]) {
    assert.equal(evaluate({ confirmationEmailRetentionHoldUntil: hold }), 'retention_hold_invalid', JSON.stringify(hold));
  }
});

test('A3-7 planner: the anchor is confirmationEmailAcceptedAt alone — no fallback to any earlier instant', () => {
  for (const acceptedAt of [undefined, null, '', '2026-09-01T12:00:00Z', 'yesterday', 0]) {
    assert.equal(
      evaluate({ confirmationEmailAcceptedAt: acceptedAt, confirmationEmailFirstDispatchIntentAt: ACCEPTED_AT }),
      'anchor_unavailable',
      `acceptedAt ${JSON.stringify(acceptedAt)} (ref.createdAt and the first-intent instant are both valid here)`,
    );
  }
});

test('A3-7 planner: an anchor after now, or a now that is not a finite instant, is anchor_unavailable', () => {
  assert.equal(evaluate({ confirmationEmailAcceptedAt: '2026-10-01T12:00:00.001Z' }), 'anchor_unavailable');
  assert.equal(evaluate({ confirmationEmailAcceptedAt: '2026-10-01T12:00:00.000Z' }), 'state_eligible');
  for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(evaluate({}, nowMs), 'anchor_unavailable', String(nowMs));
  }
});

test('A3-7 planner: it is pure — it neither mutates the record nor reads the environment or network', async () => {
  const order = eligibleOrder({ confirmationEmailRetentionHoldUntil: '2099-01-01T00:00:00.000Z' });
  const before = JSON.stringify(order);
  const deepFreeze = (value: unknown) => {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
  };
  deepFreeze(order);
  const seen = await observe({ [RETENTION_ENV]: '30' }, () => evaluateConfirmationEnvelopePurgeEligibility(order, NOW_MS));
  assert.equal(seen.value, 'retention_hold_active');
  assert.equal(JSON.stringify(order), before);
  assert.deepEqual(seen.envReads, []);
  assert.equal(seen.fetchCalls, 0);
  assert.equal(seen.storeChanged, false);
});

test('A3-7 planner: every verdict it returns is a member of the closed vocabulary', () => {
  const fixtures: Array<Record<string, unknown>> = [
    {},
    { confirmationEmailState: 'SNAPSHOTTED' },
    { confirmationEmailState: 'RECONCILED_ACCEPTED' },
    { confirmationEmailEnvelopeRef: null },
    { confirmationEmailEnvelopeRef: validRef(OTHER_ORDER_ID) },
    { confirmationEmailEnvelopeRef: validRef(ORDER_ID, { purgedAt: ACCEPTED_AT }) },
    { confirmationEmailAcceptedAt: null },
    { confirmationEmailRetentionHoldUntil: ACCEPTED_AT },
    { confirmationEmailRetentionHoldUntil: 'x' },
  ];
  const seen = new Set(fixtures.map((overrides) => evaluate(overrides)));
  assert.deepEqual([...seen].sort(), [...CONFIRMATION_ENVELOPE_PURGE_ELIGIBILITY].sort(), 'each member is reachable');
});

// ── The route: auth first, then the same inert report ───────────────────────

function cronRequest(method: 'GET' | 'POST', query = '', authorization?: string): Request {
  return new Request(`${PURGE_URL}${query}`, {
    method,
    headers: authorization === undefined ? {} : { authorization },
  });
}

const HANDLERS = [['GET', route.GET], ['POST', route.POST]] as const;

test('A3-7 route: Node runtime, never cached', () => {
  assert.equal(route.runtime, 'nodejs');
  assert.equal(route.dynamic, 'force-dynamic');
});

test('A3-7 route: no configured secret is 503 with an empty body', async () => {
  for (const [method, handler] of HANDLERS) {
    const seen = await observe({ CRON_SECRET: undefined }, async () => {
      const response = await handler(cronRequest(method, '', 'Bearer anything'));
      return { status: response.status, body: await response.text() };
    });
    assert.deepEqual(seen.value, { status: 503, body: '' }, method);
    assert.equal(seen.fetchCalls, 0);
    assert.equal(seen.storeChanged, false);
  }
});

test('A3-7 route: a missing or wrong bearer is 401 with an empty body', async () => {
  for (const [method, handler] of HANDLERS) {
    // (A trailing-space variant is not a case: the Fetch Headers API trims it.)
    for (const authorization of [undefined, 'Bearer wrong-secret', 'right-secret', 'bearer right-secret']) {
      const seen = await observe({ CRON_SECRET: 'right-secret' }, async () => {
        const response = await handler(cronRequest(method, '?dryRun=true', authorization));
        return { status: response.status, body: await response.text() };
      });
      assert.deepEqual(seen.value, { status: 401, body: '' }, `${method} ${JSON.stringify(authorization)}`);
      assert.deepEqual([...new Set(seen.envReads)], ['CRON_SECRET']);
      assert.equal(seen.fetchCalls, 0);
      assert.equal(seen.storeChanged, false);
    }
  }
});

test('A3-7 route: an authorised run reports exactly retention_unconfigured, dry or not, and reads only the secret', async () => {
  for (const [method, handler] of HANDLERS) {
    for (const query of ['', '?dryRun=true', '?dryRun=false', '?dryRun=1', `?dryRun=true&orderId=${ORDER_ID}`]) {
      for (const value of RETENTION_VALUES) {
        const seen = await observe({ CRON_SECRET: 'right-secret', [RETENTION_ENV]: value }, async () => {
          const response = await handler(cronRequest(method, query, 'Bearer right-secret'));
          return { status: response.status, body: await response.text() };
        });
        const label = `${method} ${query} retention=${JSON.stringify(value)}`;
        assert.equal(seen.value.status, 200, label);
        assert.equal(seen.value.body, JSON.stringify(SKIPPED), label);
        assert.doesNotMatch(seen.value.body, new RegExp(`${ORDER_ID}|objectPath|confirmation-envelopes`), label);
        assert.deepEqual([...new Set(seen.envReads)], ['CRON_SECRET'], `${label}: env reads ${seen.envReads.join(', ')}`);
        assert.equal(seen.fetchCalls, 0, label);
        assert.equal(seen.storeChanged, false, label);
      }
    }
  }
});

// ── The activation boundary is written down where the next editor will look ─

test('A3-7: the module states what activation requires, and that this slice is inert', () => {
  const source = readFileSync(path.join(REPO_ROOT, 'src/lib/confirmation-envelope-retention.ts'), 'utf8');
  const header = source.slice(0, source.indexOf('*/'));
  for (const required of ['INERT', 'A3-6', 'OD-2', 'OD-3', 'readback', 'separate owner approval']) {
    assert.ok(header.includes(required), `the module header must name ${required}`);
  }
  const routeSource = readFileSync(path.join(REPO_ROOT, 'src/app/api/cron/confirmation-envelope-purge/route.ts'), 'utf8');
  assert.match(routeSource.slice(0, routeSource.indexOf('*/')), /INERT/);
});
