/*
 * L-4 A3-5 — the frozen dispatcher (plan §3–§6).
 *
 * With the writer armed, the dispatch flag exactly `true` in the writer's
 * supplied environment, and a transport injected, a `SNAPSHOTTED` or
 * `PROVABLY_PRE_DISPATCH_FAILED` record is sent from the stored envelope,
 * verbatim, under its frozen key — after one dispatch-intent CAS has landed and
 * the record↔envelope fence has passed. Every outcome is one further CAS.
 *
 * Seams, all synthetic:
 *   - `strictSyntheticStoreIo` (ISO-1) put/get/del, scripted per call; anything
 *                       unscripted throws `SyntheticUnscriptedCall`;
 *   - the REAL NBT over `nsOrderAdapter` (ISO-9), with the same order id seeded
 *                       under `ns-a` and `ns-z`. Both helpers are copied from
 *                       the producer suite; the adapter gains a log of landed
 *                       writes and two body-aware write hooks (marked A3-5);
 *   - `frozenTransport` the injected transport: scripted results, a call log;
 *   - the legacy `send`, ambient `getOrder` and ambient `transact` all throw.
 *
 * No network (ISO-4: `fetch` throws) and no Resend key (ISO-2/3) — except that
 * FD-15 sets a synthetic key around calls that inject a fake `createClient`
 * (controller ruling). No real store, provider or order action. Order ids are
 * assembled, never written as literals.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { BlobError, BlobNotFoundError } from '@vercel/blob';

import {
  CONFIRMATION_FROZEN_DISPATCH_ENV,
  evaluateFrozenDispatchFence,
  type ConfirmationFrozenDispatchDeps,
} from '../src/lib/confirmation-email-dispatch.ts';
import {
  deliverOrderConfirmationEmail,
  type ConfirmationEmailDeliveryOutcome,
  type DeliverOrderConfirmationEmailDeps,
} from '../src/lib/confirmation-email-delivery.ts';
import { runConfirmationEmailSweep, CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS } from '../src/lib/confirmation-email-sweep.ts';
import { CONFIRMATION_EMAIL_CLAIM_STALE_MS } from '../src/lib/confirmation-email-delivery.ts';
import {
  _resetConfirmationEmailInFlightForTest,
  scheduleOrderConfirmationEmail,
} from '../src/lib/order-confirmation-kickoff.ts';
import {
  dispatchFrozenConfirmationRequest,
  type FrozenDispatchTransportResult,
} from '../src/lib/order-email.ts';
import {
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  createOrderRecord,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';

// ── ISO-2 / ISO-3 / ISO-4: file-start backstops ────────────────────────────

assert.equal(process.env.HSB_RESEND_API_KEY || undefined, undefined, 'ISO-3: no usable Resend key may be present');
assert.equal(process.env.RESEND_API_KEY || undefined, undefined, 'ISO-3: no usable Resend key may be present');
assert.equal(process.env.HSB_CONFIRMATION_ENVELOPE_WRITER, undefined, 'no ambient writer flag');
assert.equal(process.env.HSB_CONFIRMATION_FROZEN_DISPATCH, undefined, 'no ambient dispatch flag');

let FETCH_CALLS = 0;
globalThis.fetch = (async () => {
  FETCH_CALLS += 1;
  throw new Error('ISO-4: fetch is forbidden in the frozen-dispatch suite');
}) as typeof fetch;

let SEQ = 0;
const tick = () => {
  SEQ += 1;
  return SEQ;
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const idOf = (suffix: string) => ['ord', `${'0'.repeat(16 - suffix.length)}${suffix}`].join('_');
const ORDER_ID = idOf('d5');

const EPOCH = '2026-10-15T12:00:00.000Z';
const SNAPSHOT_NOW_MS = Date.parse('2026-10-15T13:00:00.000Z');
const DISPATCH_NOW_MS = SNAPSHOT_NOW_MS + 60_000;
const DISPATCH_NOW = new Date(DISPATCH_NOW_MS).toISOString();
const SYNTHETIC_TOKEN = 'vercel_blob_rw_SYNTHETICenvStore01_SYNTHETICsecret000001';
const A = 'ns-a';
const B = 'ns-b';
const Z = 'ns-z';
const MESSAGE_ID = 'a35f0000-0000-4000-8000-000000000001';
const CLAIM_ID = 'claim-frozen';
const ATTEMPT_ID = 'attempt-frozen-1';

const CANARY_TO = 'CANARY-TO-6a1e@example.invalid';
const CANARY_CHILD = 'CANARY-CHILD-2b94';
const CANARY_FROM = 'CANARY-FROM-81c3';
const CANARY_REPLY = 'CANARY-REPLY-5d07@example.invalid';
const CANARY_URL = 'CANARY-URL-c4f2';
const CANARIES = [CANARY_TO, CANARY_CHILD, CANARY_FROM, CANARY_REPLY, CANARY_URL];

const RENDER_ENV = {
  HSB_EMAIL_FROM: `${CANARY_FROM} <no-reply@example.invalid>`,
  HSB_SUPPORT_EMAIL: CANARY_REPLY,
  NEXT_PUBLIC_URL: `https://${CANARY_URL}.example.invalid`,
};

const AMBIENT_KEYS = [
  'HSB_BLOB_NAMESPACE', 'VERCEL', 'VERCEL_ENV', 'NEXT_PUBLIC_URL', 'HSB_EMAIL_FROM', 'EMAIL_FROM',
  'HSB_SUPPORT_EMAIL', 'HSB_CONFIRMATION_ENVELOPE_WRITER', 'HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH',
  'HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'HSB_CONFIRMATION_FROZEN_DISPATCH',
  'HSB_RESEND_API_KEY', 'RESEND_API_KEY', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
] as const;

function setAmbient(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withAmbient<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(AMBIENT_KEYS.map((key) => [key, process.env[key]]));
  setAmbient({
    VERCEL: undefined, VERCEL_ENV: undefined, BLOB_READ_WRITE_TOKEN: undefined,
    HSB_CONFIRMATION_ENVELOPE_WRITER: undefined, HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: undefined,
    HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: undefined, HSB_CONFIRMATION_FROZEN_DISPATCH: undefined,
    EMAIL_FROM: undefined, HSB_RESEND_API_KEY: undefined, RESEND_API_KEY: undefined,
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
    // The ambient namespace agrees with the writer's, so CK-A/CK-G/CK-T pass.
    HSB_BLOB_NAMESPACE: A,
    ...RENDER_ENV, ...values,
  });
  try {
    return await fn();
  } finally {
    setAmbient(saved);
    __resetOrderStoreAdapterFactoryForTests();
  }
}

function paidOrder(overrides: Partial<OrderRecord> = {}, id = ORDER_ID): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: CANARY_CHILD, bookFormat: 'digital', email: CANARY_TO },
      { id, now: '2026-10-15T11:00:00.000Z' },
    ),
    paymentStatus: 'paid' as const,
    paidAt: EPOCH,
    stripeSessionId: `cs_test_${id}`,
    updatedAt: '2026-10-15T12:30:00.000Z',
    ...overrides,
  } as OrderRecord;
}

/** The writer's supplied environment; the dispatch flag lives here. */
function writerEnv(dispatchFlag: string | undefined): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    HSB_CONFIRMATION_ENVELOPE_WRITER: 'true',
    HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: EPOCH,
    HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: SYNTHETIC_TOKEN,
    HSB_BLOB_NAMESPACE: A,
  };
  if (dispatchFlag !== undefined) env[CONFIRMATION_FROZEN_DISPATCH_ENV] = dispatchFlag;
  return env as NodeJS.ProcessEnv;
}

// ── strictSyntheticStoreIo (ISO-1) — copied from the producer suite ───────

class SyntheticUnscriptedCall extends Error {
  constructor(what: string) {
    super(`SyntheticUnscriptedCall: ${what}`);
    this.name = 'SyntheticUnscriptedCall';
  }
}

let UNSCRIPTED_TOTAL = 0;
/** Every `del` in the whole file, asserted 0 at the end. */
let DEL_CALLS_TOTAL = 0;

type PutStep = 'store' | 'exists' | 'fail' | 'fail-landed' | 'not_private' | { error: unknown };
type GetStep = 'serve' | { error: unknown } | { status: number };

interface StoreCall {
  seq: number;
  op: 'put' | 'get' | 'del';
  pathname: string;
  options: Record<string, unknown>;
  body?: string;
}

interface StoreScript {
  objects?: Record<string, string | Buffer>;
  put?: PutStep[];
  get?: GetStep[];
  /** Runs before the scripted result of the i-th call of that op. */
  onPut?: (index: number) => void;
  onGet?: (index: number) => void;
}

function strictSyntheticStoreIo(script: StoreScript = {}) {
  const objects = new Map<string, Buffer>();
  for (const [pathname, body] of Object.entries(script.objects ?? {})) {
    objects.set(pathname, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
  }
  const calls: StoreCall[] = [];
  let puts = 0;
  let gets = 0;
  const describe = (options: Record<string, unknown> | undefined) => {
    const { token, ...rest } = options ?? {};
    return { ...rest, dedicatedToken: token === SYNTHETIC_TOKEN };
  };
  const unscripted = (what: string): never => {
    UNSCRIPTED_TOTAL += 1;
    throw new SyntheticUnscriptedCall(what);
  };
  const io = {
    put: async (pathname: string, body: unknown, options?: Record<string, unknown>) => {
      const index = puts++;
      calls.push({ seq: tick(), op: 'put', pathname, options: describe(options), body: String(body) });
      const step = script.put?.[index];
      if (step === undefined) return unscripted(`put ${pathname}`);
      script.onPut?.(index);
      if (typeof step === 'object') throw step.error;
      switch (step) {
        case 'store':
          if (objects.has(pathname)) throw new BlobError('This blob already exists, use allowOverwrite: true to overwrite it');
          objects.set(pathname, Buffer.from(String(body), 'utf8'));
          return { pathname, url: 'https://example.invalid/never-returned', downloadUrl: 'https://example.invalid/never' };
        case 'exists':
          throw new BlobError('This blob already exists, use allowOverwrite: true to overwrite it');
        case 'fail':
          throw new Error('synthetic network failure');
        case 'fail-landed':
          objects.set(pathname, Buffer.from(String(body), 'utf8'));
          throw new Error('synthetic network failure after the write landed');
        case 'not_private':
          throw new BlobError('Cannot use private access on a public store');
        default:
          return unscripted(`put step ${String(step)}`);
      }
    },
    get: async (pathname: string, options?: Record<string, unknown>) => {
      const index = gets++;
      calls.push({ seq: tick(), op: 'get', pathname, options: describe(options) });
      const step = script.get?.[index];
      if (step === undefined) return unscripted(`get ${pathname}`);
      script.onGet?.(index);
      if (typeof step === 'object' && 'error' in step) throw step.error;
      if (typeof step === 'object' && 'status' in step) return { statusCode: step.status, stream: null, blob: null };
      const stored = objects.get(pathname);
      if (!stored) throw new BlobNotFoundError();
      const bytes = new Uint8Array(stored);
      return {
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        blob: { size: bytes.byteLength },
      };
    },
    del: async (pathname: string) => {
      DEL_CALLS_TOTAL += 1;
      calls.push({ seq: tick(), op: 'del', pathname, options: {} });
      return unscripted(`del ${pathname}`);
    },
  };
  return {
    io: io as unknown as NonNullable<DeliverOrderConfirmationEmailDeps['envelopeWriter']>['storeIo'],
    calls,
    objects,
    count: (op: StoreCall['op']) => calls.filter((call) => call.op === op).length,
  };
}

// ── nsOrderAdapter (ISO-9): the real NBT over a namespace-sensitive store ──
// Copied from the producer suite. A3-5 extensions: `beforeWrite` may throw in
// place of a write (a store outage on that commit), `afterWrite` runs once a
// write has landed, and every landed write is logged with its prior body.

type AdapterOp = 'readVersioned' | 'createIfAbsent' | 'replaceIfVersion';

interface AdapterCall {
  seq: number;
  op: AdapterOp;
  path: string;
  result: string;
}

interface NsScript {
  seed: Record<string, string>;
  /** `replaceIfVersion` call indexes (0-based) that lose the CAS. */
  conflictAt?: readonly number[];
  /** Runs before the scripted result of every call; may drift the ambient env. */
  hook?: (op: AdapterOp, index: number, pathname: string) => void;
  /** A3-5: return an error to throw it in place of this write. */
  beforeWrite?: (next: OrderRecord) => Error | null;
  /** A3-5: after a write has landed. */
  afterWrite?: (committed: OrderRecord) => void;
}

interface Commit { seq: number; before: OrderRecord; after: OrderRecord }

const recordPathIn = (namespace: string, orderId = ORDER_ID) =>
  (namespace ? `${namespace}/orders/${orderId}.json` : `orders/${orderId}.json`);

const sha16 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

function nsOrderAdapter(script: NsScript) {
  const cells = new Map<string, { body: string; n: number }>();
  for (const [pathname, body] of Object.entries(script.seed)) cells.set(pathname, { body, n: 1 });
  const known = new Set<string>(['', A, B, Z].map((namespace) => recordPathIn(namespace)));
  const calls: AdapterCall[] = [];
  const counts: Record<AdapterOp, number> = { readVersioned: 0, createIfAbsent: 0, replaceIfVersion: 0 };
  const writes: Commit[] = [];
  let successfulWrites = 0;
  const versionOf = (pathname: string, n: number) => `v${n}-${sha16(pathname).slice(0, 8)}`;
  const enter = (op: AdapterOp, pathname: string) => {
    const call: AdapterCall = { seq: tick(), op, path: pathname, result: 'pending' };
    calls.push(call);
    return call;
  };
  const refuse = (call: AdapterCall): never => {
    UNSCRIPTED_TOTAL += 1;
    call.result = 'unscripted';
    throw new SyntheticUnscriptedCall(`${call.op} ${call.path}`);
  };
  const adapter: OrderStoreAdapter = {
    kind: 'ns-synthetic',
    async readVersioned(pathname) {
      const call = enter('readVersioned', pathname);
      const index = counts.readVersioned++;
      if (!known.has(pathname)) refuse(call);
      script.hook?.('readVersioned', index, pathname);
      const cell = cells.get(pathname);
      call.result = cell ? versionOf(pathname, cell.n) : 'absent';
      return cell ? { body: cell.body, version: versionOf(pathname, cell.n) } : null;
    },
    async createIfAbsent(pathname) {
      counts.createIfAbsent += 1;
      return refuse(enter('createIfAbsent', pathname));
    },
    async replaceIfVersion(pathname, body, expectedVersion) {
      const call = enter('replaceIfVersion', pathname);
      const index = counts.replaceIfVersion++;
      if (!known.has(pathname)) refuse(call);
      script.hook?.('replaceIfVersion', index, pathname);
      const cell = cells.get(pathname);
      if (!cell || versionOf(pathname, cell.n) !== expectedVersion) {
        call.result = 'version_conflict';
        return { ok: false, reason: 'version_conflict' };
      }
      if (script.conflictAt?.includes(index)) {
        cells.set(pathname, { body: cell.body, n: cell.n + 1 });
        call.result = 'version_conflict';
        return { ok: false, reason: 'version_conflict' };
      }
      const next = JSON.parse(body) as OrderRecord;
      const fault = script.beforeWrite?.(next) ?? null;
      if (fault) {
        call.result = 'thrown';
        throw fault;
      }
      cells.set(pathname, { body, n: cell.n + 1 });
      successfulWrites += 1;
      writes.push({ seq: tick(), before: JSON.parse(cell.body) as OrderRecord, after: next });
      call.result = 'ok';
      script.afterWrite?.(next);
      return { ok: true, version: versionOf(pathname, cell.n + 1) };
    },
  };
  let factoryCalls = 0;
  __setOrderStoreAdapterFactoryForTests(() => {
    factoryCalls += 1;
    return adapter;
  });
  return {
    calls,
    writes,
    bodyAt: (pathname: string) => cells.get(pathname)?.body,
    recordAt: (pathname: string) => {
      const body = cells.get(pathname)?.body;
      return body === undefined ? null : JSON.parse(body) as OrderRecord;
    },
    /** A3-5: an out-of-band change to a stored record (a concurrent writer). */
    patchAt: (pathname: string, fields: Record<string, unknown>) => {
      const cell = cells.get(pathname)!;
      cells.set(pathname, { body: JSON.stringify({ ...JSON.parse(cell.body), ...fields }, null, 2), n: cell.n + 1 });
    },
    successfulWrites: () => successfulWrites,
    factoryCalls: () => factoryCalls,
    zCalls: () => calls.filter((call) => call.path.startsWith(`${Z}/`)).length,
    nonPathCalls: (pathname: string) => calls.filter((call) => call.path !== pathname),
  };
}

const bodyOf = (order: OrderRecord) => JSON.stringify(order, null, 2);

/** The same order id under A and Z, with different, individually valid bytes. */
function seedAZ(a: OrderRecord, z: OrderRecord = { ...a, childName: 'Zora', internalDispositionNote: 'seed:z' } as OrderRecord) {
  return { [recordPathIn(A)]: bodyOf(a), [recordPathIn(Z)]: bodyOf(z) };
}

interface MemScript {
  /** Return an error to throw it in place of the write. */
  throwOnCommit?: (next: OrderRecord) => Error | null;
  afterCommit?: (committed: OrderRecord) => void;
}

// ── frozenTransport ─────────────────────────────────────────────────────────

interface TransportCall { seq: number; request: unknown; key: string; stateAtSend: unknown }

function frozenTransport(
  world: { orderIo: World['orderIo'] },
  results: Array<FrozenDispatchTransportResult | (() => Promise<FrozenDispatchTransportResult>)>,
  opts: { ready?: () => boolean; onSend?: () => void } = {},
) {
  const calls: TransportCall[] = [];
  const transport = {
    ready: opts.ready ?? (() => true),
    send: async (request: unknown, key: string): Promise<FrozenDispatchTransportResult> => {
      calls.push({ seq: tick(), request: JSON.parse(JSON.stringify(request)), key, stateAtSend: world.orderIo.record()?.confirmationEmailState });
      opts.onSend?.();
      const next = results[calls.length - 1];
      assert.ok(next !== undefined, 'an unscripted transport call');
      return typeof next === 'function' ? next() : next;
    },
  };
  return { transport, calls };
}

// ── The delivery seams that must stay untouched ─────────────────────────────

let LEGACY_SEND_CALLS = 0;
const legacySend = async (): Promise<never> => {
  LEGACY_SEND_CALLS += 1;
  throw new Error('TransportTouched: the legacy send was reached');
};
const forbiddenGetOrder = async (): Promise<never> => { throw new Error('ambient getOrder under armed intent'); };
const forbiddenTransact = (async () => { throw new Error('ambient transact under armed intent'); }) as unknown as DeliverOrderConfirmationEmailDeps['transact'];

function storeView(raw: ReturnType<typeof strictSyntheticStoreIo>, script: { put: PutStep[]; get: GetStep[] }) {
  return {
    ...raw,
    script,
    only: () => {
      assert.equal(raw.objects.size, 1, 'exactly one stored envelope');
      const [[pathname, bytes]] = [...raw.objects.entries()];
      const body = bytes.toString('utf8');
      return { pathname, body, envelope: JSON.parse(body) as Record<string, unknown> & { request: Record<string, unknown> } };
    },
    setObject: (pathname: string, body: string) => { raw.objects.set(pathname, Buffer.from(body, 'utf8')); },
  };
}

interface World {
  adapter: ReturnType<typeof nsOrderAdapter>;
  store: ReturnType<typeof storeView>;
  orderIo: {
    record: () => OrderRecord | null;
    patch: (fields: Record<string, unknown>) => void;
    commits: Commit[];
  };
}

/**
 * One order under `ns-a` (and a decoy under `ns-z`), the real NBT over the
 * namespace-sensitive adapter, and a strict store scripted with exactly the
 * one `put` the snapshot needs. Each dispatch scripts its own `get`.
 */
function world(seed: OrderRecord[] = [paidOrder()], script: MemScript = {}): World {
  const storeScript: { put: PutStep[]; get: GetStep[] } = { put: ['store'], get: [] };
  const store = storeView(strictSyntheticStoreIo(storeScript), storeScript);
  const adapter = nsOrderAdapter({ seed: seedAZ(seed[0]), beforeWrite: script.throwOnCommit, afterWrite: script.afterCommit });
  return {
    adapter,
    store,
    orderIo: {
      record: () => adapter.recordAt(recordPathIn(A)),
      patch: (fields) => adapter.patchAt(recordPathIn(A), fields),
      commits: adapter.writes,
    },
  };
}

interface Run { outcome: ConfirmationEmailDeliveryOutcome; logs: string[]; errors: string[] }

function deliveryDeps(w: World, opts: {
  flag?: string;
  frozen?: ConfirmationFrozenDispatchDeps;
  nowMs?: number;
  logs: string[];
  errors: string[];
}): DeliverOrderConfirmationEmailDeps {
  return {
    send: legacySend,
    getOrder: forbiddenGetOrder,
    transact: forbiddenTransact,
    now: () => opts.nowMs ?? DISPATCH_NOW_MS,
    newClaimId: () => CLAIM_ID,
    log: (line) => { opts.logs.push(line); },
    errorLog: (line) => { opts.errors.push(line); },
    envelopeWriter: { env: writerEnv(opts.flag), storeIo: w.store.io },
    ...(opts.frozen ? { frozenDispatch: opts.frozen } : {}),
  };
}

async function deliver(w: World, opts: { flag?: string; frozen?: ConfirmationFrozenDispatchDeps; nowMs?: number; orderId?: string } = {}): Promise<Run> {
  const logs: string[] = [];
  const errors: string[] = [];
  const outcome = await deliverOrderConfirmationEmail(opts.orderId ?? ORDER_ID, deliveryDeps(w, { ...opts, logs, errors }));
  return { outcome, logs, errors };
}

/** Freeze the envelope with the dispatcher off: the A3-4 producer, unchanged. */
async function snapshot(w: World): Promise<OrderRecord> {
  const run = await deliver(w, { nowMs: SNAPSHOT_NOW_MS });
  assert.deepEqual(run.outcome, { status: 'snapshotted', via: 'committed' });
  const record = w.orderIo.record()!;
  assert.equal(record.confirmationEmailState, 'SNAPSHOTTED');
  return record;
}

const armedFrozen = (transport: ConfirmationFrozenDispatchDeps['transport'], attemptId = ATTEMPT_ID): ConfirmationFrozenDispatchDeps => ({
  transport,
  newAttemptId: () => attemptId,
});

const ACCEPTED: FrozenDispatchTransportResult = { kind: 'accepted', id: MESSAGE_ID };

/** One dispatch attempt with the flag on and the transport injected. `gets`
 *  scripts the store reads it may make (default: serve the object once). */
async function dispatch(
  w: World,
  transport: ConfirmationFrozenDispatchDeps['transport'],
  opts: { nowMs?: number; attemptId?: string; gets?: GetStep[] } = {},
) {
  w.store.script.get.push(...(opts.gets ?? ['serve']));
  return deliver(w, { flag: 'true', frozen: armedFrozen(transport, opts.attemptId), nowMs: opts.nowMs });
}

/** Leave the record in PPDF: one attempt whose failure is proven pre-submit. */
async function toPpdf(w: World): Promise<OrderRecord> {
  await snapshot(w);
  const t = frozenTransport(w, [{ kind: 'not_submitted', cause: 'missing_resend_api_key' }]);
  const run = await dispatch(w, t.transport);
  assert.deepEqual(run.outcome, { status: 'failed', reason: 'send_error', errorClass: 'missing_resend_api_key' });
  return w.orderIo.record()!;
}

const CLAIM_KEYS = ['emailResendClaimId', 'emailResendClaimKind', 'emailResendClaimArtifact', 'emailResendClaimAt'];

function delta(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
}

const countIn = (needle: string, haystack: string) => haystack.split(needle).length - 1;

function canaryDelta(before: unknown, after: unknown): Record<string, number> {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  return Object.fromEntries(CANARIES.map((canary) => [canary, countIn(canary, b) - countIn(canary, a)]));
}

const ZERO_CANARY_DELTA = Object.fromEntries(CANARIES.map((canary) => [canary, 0]));

function assertNoCanaryInLogs(run: Run): void {
  for (const line of [...run.logs, ...run.errors]) {
    for (const canary of CANARIES) assert.ok(!line.includes(canary), `a log line carries ${canary}`);
    assert.ok(!line.includes('@'), `a log line carries an address: ${line}`);
  }
}

// ── FD-1: byte-for-byte, after everything the body was built from changed ──

test('FD-1: the stored request is dispatched verbatim under the frozen key after env and record drift', async () => {
  await withAmbient({}, async () => {
    const w = world();
    const frozen = await snapshot(w);
    const stored = w.store.only().envelope;

    // Everything the renderer and the sender read has moved since the freeze.
    setAmbient({
      HSB_EMAIL_FROM: 'Rotated <rotated@example.invalid>',
      HSB_SUPPORT_EMAIL: 'rotated-support@example.invalid',
      NEXT_PUBLIC_URL: 'https://rotated.example.invalid',
    });
    w.orderIo.patch({ email: 'changed-buyer@example.invalid', childName: 'Changed Child' });

    const t = frozenTransport(w, [ACCEPTED]);
    const run = await dispatch(w, t.transport);

    assert.deepEqual(run.outcome, { status: 'sent' });
    assert.equal(t.calls.length, 1);
    assert.deepEqual(t.calls[0].request, stored.request, 'the provider receives the stored request exactly');
    assert.equal(t.calls[0].key, frozen.confirmationEmailIdempotencyKey);
    assert.equal(t.calls[0].key, stored.idempotencyKey);
    const sent = JSON.stringify(t.calls[0].request);
    for (const moved of ['rotated', 'changed-buyer', 'Changed Child']) assert.ok(!sent.includes(moved), `${moved} leaked into the dispatch`);
    assert.equal(LEGACY_SEND_CALLS, 0);
    assertNoCanaryInLogs(run);
  });
});

// ── FD-2: every fence mismatch reaches F4/F5 with zero transport calls ─────

const FENCE_CASES: Array<[string, (w: World) => void, 'digest_mismatch' | 'account_binding_mismatch']> = [
  ['ref digest', (w) => w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, canonicalDigest: 'f'.repeat(64) } }), 'digest_mismatch'],
  ['ref canonical bytes', (w) => w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, canonicalBytes: 1 } }), 'digest_mismatch'],
  ['ref template', (w) => w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, templateVersion: 'hsb-order-confirmation-v0' } }), 'digest_mismatch'],
  ['ref createdAt', (w) => w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, createdAt: '2026-10-15T12:59:59.000Z' } }), 'digest_mismatch'],
  ['record key', (w) => w.orderIo.patch({ confirmationEmailIdempotencyKey: 'order-confirmation-other-primary-v1' }), 'digest_mismatch'],
  ['record sender', (w) => w.orderIo.patch({ confirmationEmailFrom: 'Other <other@example.invalid>' }), 'digest_mismatch'],
  ['stored key', (w) => {
    const { pathname, envelope } = w.store.only();
    w.store.setObject(pathname, JSON.stringify({ ...envelope, idempotencyKey: 'order-confirmation-other-primary-v1' }));
  }, 'digest_mismatch'],
  ['stored createdAt', (w) => {
    const { pathname, envelope } = w.store.only();
    w.store.setObject(pathname, JSON.stringify({ ...envelope, createdAt: '2026-10-15T12:59:59.000Z' }));
  }, 'digest_mismatch'],
  ['stored account', (w) => {
    const { pathname, envelope } = w.store.only();
    w.store.setObject(pathname, JSON.stringify({ ...envelope, providerBinding: { accountLabel: 'hsb-resend-other-v1' } }));
  }, 'account_binding_mismatch'],
  ['ref account', (w) => w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, accountLabel: 'hsb-resend-other-v1' } }), 'account_binding_mismatch'],
  ['both account labels off the writer binding', (w) => {
    const { pathname, envelope } = w.store.only();
    w.store.setObject(pathname, JSON.stringify({ ...envelope, providerBinding: { accountLabel: 'hsb-resend-other-v1' } }));
    w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, accountLabel: 'hsb-resend-other-v1' } });
  }, 'account_binding_mismatch'],
];

for (const [label, tamper, reason] of FENCE_CASES) {
  test(`FD-2: a ${label} mismatch is held as ${reason} with zero transport calls`, async () => {
    await withAmbient({}, async () => {
      const w = world();
      await snapshot(w);
      tamper(w);
      const t = frozenTransport(w, []);
      const before = w.orderIo.commits.length;
      const run = await dispatch(w, t.transport);
      assert.deepEqual(run.outcome, { status: 'held', reason });
      assert.equal(t.calls.length, 0, 'the fence must run before the provider call');
      const record = w.orderIo.record()!;
      assert.equal(record.confirmationEmailState, 'RECONCILIATION_REQUIRED');
      assert.equal(record.confirmationEmailHoldReason, reason);
      for (const key of CLAIM_KEYS) assert.equal((record as unknown as Record<string, unknown>)[key], null, `${key} released`);
      const attempts = record.confirmationEmailAttempts ?? [];
      assert.equal(attempts.at(-1)?.outcome, 'fenced_before_dispatch');
      assert.equal(w.orderIo.commits.length - before, 2, 'C2 and the fence hold, nothing else');
    });
  });
}

test('FD-2: a ref naming another order is refused by the record boundary before intent lands — no write, no call', async () => {
  await withAmbient({}, async () => {
    const w = world();
    await snapshot(w);
    w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, orderId: idOf('e9') } });
    const t = frozenTransport(w, []);
    const before = { commits: w.orderIo.commits.length, body: w.adapter.bodyAt(recordPathIn(A)) };
    await assert.rejects(dispatch(w, t.transport), (error: Error) => error.name === 'OrderPersistenceError');
    assert.equal(t.calls.length, 0);
    assert.equal(w.orderIo.commits.length, before.commits);
    assert.equal(w.adapter.bodyAt(recordPathIn(A)), before.body);
  });
});

test('FD-2: the fence itself refuses a ref or envelope naming another order (defence in depth)', async () => {
  await withAmbient({}, async () => {
    const w = world();
    await snapshot(w);
    const record = w.orderIo.record()!;
    const envelope = w.store.only().envelope as unknown as Parameters<typeof evaluateFrozenDispatchFence>[1];
    const label = (envelope as unknown as { providerBinding: { accountLabel: string } }).providerBinding.accountLabel;
    assert.equal(evaluateFrozenDispatchFence(record, envelope, label), null, 'control: the frozen pair passes');
    const foreignRef = { ...record, confirmationEmailEnvelopeRef: { ...record.confirmationEmailEnvelopeRef, orderId: idOf('e9') } } as OrderRecord;
    assert.equal(evaluateFrozenDispatchFence(foreignRef, envelope, label), 'digest_mismatch');
    assert.equal(evaluateFrozenDispatchFence(record, { ...envelope, orderId: idOf('e9') }, label), 'digest_mismatch');
    assert.equal(evaluateFrozenDispatchFence({ ...record, id: idOf('e9') }, envelope, label), 'digest_mismatch');
    assert.equal(evaluateFrozenDispatchFence(record, envelope, 'hsb-resend-other-v1'), 'account_binding_mismatch');
  });
});

// ── FD-3: the provider call follows the landed intent commit ───────────────

test('FD-3: the transport is called only after the dispatch-intent commit has landed', async () => {
  await withAmbient({}, async () => {
    const w = world();
    await snapshot(w);
    const t = frozenTransport(w, [ACCEPTED]);
    const before = w.orderIo.commits.length;
    await dispatch(w, t.transport);
    const intent = w.orderIo.commits[before];
    assert.equal(intent.after.confirmationEmailState, 'DISPATCH_INTENT_RECORDED');
    assert.ok(t.calls[0].seq > intent.seq, 'send happened before the intent commit');
    assert.equal(t.calls[0].stateAtSend, 'DISPATCH_INTENT_RECORDED');
    const store = w.store.calls.filter((call) => call.op === 'get');
    assert.equal(store.length, 1);
    assert.ok(store[0].seq < intent.seq, 'the envelope is read before the intent commit');
  });
});

// ── FD-4: concurrent kickoff + sweep + direct deliveries → at most one call ─

test('FD-4: concurrent kickoff, sweep and direct deliveries make exactly one transport call', async () => {
  await withAmbient({}, async () => {
    _resetConfirmationEmailInFlightForTest();
    const w = world();
    await snapshot(w);
    const t = frozenTransport(w, [ACCEPTED, ACCEPTED, ACCEPTED, ACCEPTED, ACCEPTED]);
    // Every armed attempt may read the envelope once; the kickoff carries no
    // transport and never reaches the store.
    w.store.script.get.push('serve', 'serve', 'serve', 'serve');
    const sink: string[] = [];
    const deps = (attemptId: string) => deliveryDeps(w, { flag: 'true', frozen: armedFrozen(t.transport, attemptId), logs: sink, errors: sink });

    const queue: Array<() => void | Promise<void>> = [];
    scheduleOrderConfirmationEmail(w.orderIo.record()!, {
      send: legacySend,
      setImmediateImpl: (cb) => { queue.push(cb); return null; },
      afterImpl: (cb) => { queue.push(cb); },
      log: (line) => { sink.push(line); },
      errorLog: (line) => { sink.push(line); },
      envelopeWriter: { env: writerEnv('true'), storeIo: w.store.io },
    });

    const outcomes = await Promise.all([
      deliverOrderConfirmationEmail(ORDER_ID, deps('attempt-a')),
      deliverOrderConfirmationEmail(ORDER_ID, deps('attempt-b')),
      deliverOrderConfirmationEmail(ORDER_ID, deps('attempt-c')),
      runConfirmationEmailSweep({
        listOrders: async () => [w.orderIo.record()!],
        deliver: (orderId) => deliverOrderConfirmationEmail(orderId, deps('attempt-sweep')),
        now: () => DISPATCH_NOW_MS,
        graceMs: 0,
        claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
        activationPaidAtMs: CONFIRMATION_EMAIL_SWEEP_ACTIVATION_PAID_AT_MS,
        admitAwaitingFrozenDispatch: true,
        log: (line) => { sink.push(line); },
        errorLog: (line) => { sink.push(line); },
      }),
      ...queue.map((cb) => Promise.resolve(cb())),
    ]);

    assert.equal(t.calls.length, 1, 'more than one provider call for one order');
    const direct = outcomes.slice(0, 3) as ConfirmationEmailDeliveryOutcome[];
    assert.equal(direct.filter((o) => o.status === 'sent').length + (outcomes[3] as { sent: number }).sent, 1);
    assert.equal(w.orderIo.record()!.confirmationEmailState, 'ACCEPTED');
    assert.equal(LEGACY_SEND_CALLS, 0);
  });
});

// ── FD-5: an outcome that is not known is held, and never retried ──────────

for (const [label, result] of [
  ['a timeout after submission', { kind: 'submit_threw', errorClass: 'TimeoutError' }],
  ['a provider 500', { kind: 'provider_error', statusCode: 500, providerErrorClass: 'internal_server_error' }],
  ['a transport that throws', () => Promise.reject(new Error('CANARY-TO-6a1e@example.invalid timed out'))],
] as const) {
  test(`FD-5: ${label} is held as ambiguous_dispatch and a later delivery makes no call`, async () => {
    await withAmbient({}, async () => {
      const w = world();
      await snapshot(w);
      const t = frozenTransport(w, [result as FrozenDispatchTransportResult]);
      const first = await dispatch(w, t.transport);
      assert.deepEqual(first.outcome, { status: 'held', reason: 'ambiguous_dispatch' });
      assertNoCanaryInLogs(first);
      const record = w.orderIo.record()!;
      assert.equal(record.confirmationEmailState, 'RECONCILIATION_REQUIRED');
      assert.equal(record.confirmationEmailAttempts?.at(-1)?.outcome, 'ambiguous');
      for (const key of CLAIM_KEYS) assert.equal((record as unknown as Record<string, unknown>)[key], null);

      const t2 = frozenTransport(w, []);
      const second = await dispatch(w, t2.transport, { nowMs: DISPATCH_NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS * 2 });
      assert.deepEqual(second.outcome, { status: 'blocked', reason: 'held_for_reconciliation' });
      assert.equal(t.calls.length + t2.calls.length, 1);
    });
  });
}

// ── FD-6: acceptance whose receipt does not land keeps the claim ───────────

test('FD-6: accepted, then the receipt CAS throws — held as receipt_write_failed with the claim retained', async () => {
  await withAmbient({}, async () => {
    const w = world([paidOrder()], {
      throwOnCommit: (next) => (next.confirmationEmailState === 'ACCEPTED' ? new Error('synthetic receipt write failure') : null),
    });
    await snapshot(w);
    const t = frozenTransport(w, [ACCEPTED]);
    const run = await dispatch(w, t.transport);
    assert.deepEqual(run.outcome, { status: 'receipt_unrecorded', reason: 'write_failed' });
    const record = w.orderIo.record()!;
    assert.equal(record.confirmationEmailState, 'RECONCILIATION_REQUIRED');
    assert.equal(record.confirmationEmailHoldReason, 'receipt_write_failed');
    assert.equal(record.emailResendClaimId, CLAIM_ID, 'the claim must be retained');
    assert.equal(record.emailResendClaimKind, 'order_confirmation');
    assert.equal(record.confirmationEmailAttempts?.at(-1)?.outcome, 'accepted');
    assert.equal(record.confirmationEmailAttempts?.at(-1)?.providerMessageId, MESSAGE_ID);
    // Zero release writes: no commit anywhere in the attempt nulls the claim.
    for (const commit of w.orderIo.commits) {
      if (commit.before.emailResendClaimId === CLAIM_ID) assert.equal(commit.after.emailResendClaimId, CLAIM_ID, 'a release was written');
    }
    const later = frozenTransport(w, []);
    const again = await dispatch(w, later.transport, { nowMs: DISPATCH_NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS * 2 });
    assert.deepEqual(again.outcome, { status: 'blocked', reason: 'held_for_reconciliation' });
    assert.equal(later.calls.length, 0);
  });
});

test('FD-6: accepted, and the hold CAS throws too — the record stays DISPATCH_INTENT_RECORDED with its claim', async () => {
  await withAmbient({}, async () => {
    const w = world([paidOrder()], {
      throwOnCommit: (next) => (next.confirmationEmailState === 'ACCEPTED' || next.confirmationEmailState === 'RECONCILIATION_REQUIRED'
        ? new Error('synthetic store outage') : null),
    });
    await snapshot(w);
    const t = frozenTransport(w, [ACCEPTED]);
    const run = await dispatch(w, t.transport);
    assert.deepEqual(run.outcome, { status: 'receipt_unrecorded', reason: 'write_failed' });
    const record = w.orderIo.record()!;
    assert.equal(record.confirmationEmailState, 'DISPATCH_INTENT_RECORDED');
    assert.equal(record.emailResendClaimId, CLAIM_ID);
  });
});

test('FD-6: accepted while the claim moved — held as claim_lost_after_acceptance, the other claim untouched', async () => {
  await withAmbient({}, async () => {
    const w = world();
    await snapshot(w);
    const t = frozenTransport(w, [ACCEPTED], { onSend: () => w.orderIo.patch({ emailResendClaimId: 'claim-intruder' }) });
    const run = await dispatch(w, t.transport);
    assert.deepEqual(run.outcome, { status: 'receipt_unrecorded', reason: 'claim_lost' });
    const record = w.orderIo.record()!;
    assert.equal(record.confirmationEmailState, 'RECONCILIATION_REQUIRED');
    assert.equal(record.confirmationEmailHoldReason, 'claim_lost_after_acceptance');
    assert.equal(record.emailResendClaimId, 'claim-intruder');
  });
});

test('FD-6 / MP-13: accepted after the record left our attempt — no write at all', async () => {
  await withAmbient({}, async () => {
    for (const moved of [
      { confirmationEmailAttemptId: 'attempt-other' },
      { confirmationEmailState: 'RECONCILIATION_REQUIRED', confirmationEmailHoldReason: 'deadline_exceeded' },
    ]) {
      const w = world();
      await snapshot(w);
      const t = frozenTransport(w, [ACCEPTED], { onSend: () => w.orderIo.patch(moved) });
      const before = w.orderIo.commits.length;
      const run = await dispatch(w, t.transport);
      assert.deepEqual(run.outcome, { status: 'receipt_unrecorded', reason: 'claim_lost' }, JSON.stringify(moved));
      assert.equal(w.orderIo.commits.length - before, 1, 'only the intent commit');
    }
  });
});

// ── FD-17: a post-send outcome write that throws or loses the record ───────
//
// After the provider call nothing throws and nothing reports "no send": the
// outcome is `receipt_unrecorded`, the record stays where it is, and no later
// delivery sends again.

const POST_SEND_ROWS: Array<[string, FrozenDispatchTransportResult, 'PROVABLY_PRE_DISPATCH_FAILED' | 'RECONCILIATION_REQUIRED']> = [
  ['T5 (proven pre-submit)', { kind: 'not_submitted', cause: 'missing_resend_api_key' }, 'PROVABLY_PRE_DISPATCH_FAILED'],
  ['T7 (ambiguous)', { kind: 'submit_threw', errorClass: 'TimeoutError' }, 'RECONCILIATION_REQUIRED'],
  ['T7 (provider 409 body conflict)', { kind: 'provider_error', statusCode: 409, providerErrorClass: 'invalid_idempotent_request' }, 'RECONCILIATION_REQUIRED'],
];

for (const [label, result, target] of POST_SEND_ROWS) {
  test(`FD-17: a ${label} outcome write that throws returns write_failed, keeps DIR and the claim, and never sends again`, async () => {
    await withAmbient({}, async () => {
      const w = world([paidOrder()], {
        throwOnCommit: (next) => (next.confirmationEmailState === target ? new Error('synthetic store outage CANARY-TO-6a1e@example.invalid') : null),
      });
      await snapshot(w);
      const t = frozenTransport(w, [result]);
      const before = w.orderIo.commits.length;
      const run = await dispatch(w, t.transport);
      assert.deepEqual(run.outcome, { status: 'receipt_unrecorded', reason: 'write_failed' });
      assert.equal(t.calls.length, 1);
      assert.equal(w.orderIo.commits.length - before, 1, 'only the intent commit landed');
      const record = w.orderIo.record()!;
      assert.equal(record.confirmationEmailState, 'DISPATCH_INTENT_RECORDED');
      assert.equal(record.emailResendClaimId, CLAIM_ID, 'the claim must be retained');
      assertNoCanaryInLogs(run);
      assert.ok(run.errors.some((line) => line.includes('outcome write failed') && line.includes('errorClass=Error')));

      const later = frozenTransport(w, []);
      const again = await dispatch(w, later.transport, { nowMs: DISPATCH_NOW_MS + CONFIRMATION_EMAIL_CLAIM_STALE_MS * 2, gets: [] });
      assert.deepEqual(again.outcome, { status: 'blocked', reason: 'held_for_reconciliation' });
      assert.equal(later.calls.length, 0);
    });
  });

  test(`FD-17: a ${label} outcome write that finds the record moved returns claim_lost and writes nothing`, async () => {
    await withAmbient({}, async () => {
      for (const moved of [
        { confirmationEmailAttemptId: 'attempt-other' },
        { confirmationEmailState: 'RECONCILIATION_REQUIRED', confirmationEmailHoldReason: 'deadline_exceeded' },
      ]) {
        const w = world();
        await snapshot(w);
        const t = frozenTransport(w, [result], { onSend: () => w.orderIo.patch(moved) });
        const before = w.orderIo.commits.length;
        const run = await dispatch(w, t.transport);
        assert.deepEqual(run.outcome, { status: 'receipt_unrecorded', reason: 'claim_lost' }, JSON.stringify(moved));
        assert.equal(w.orderIo.commits.length - before, 1, 'only the intent commit');
        const record = w.orderIo.record()!;
        for (const [key, value] of Object.entries(moved)) assert.equal((record as unknown as Record<string, unknown>)[key], value);
        assert.equal(record.emailResendClaimId, CLAIM_ID, 'nothing released the claim');
        assert.equal(t.calls.length, 1);
      }
    });
  });
}

// ── FD-7: proven pre-submit failure → PPDF → exactly one modelled retry ────

test('FD-7: not_submitted leaves PPDF, and the next delivery makes exactly one call (T6)', async () => {
  await withAmbient({}, async () => {
    const w = world();
    const ppdf = await toPpdf(w);
    assert.equal(ppdf.confirmationEmailState, 'PROVABLY_PRE_DISPATCH_FAILED');
    assert.equal(ppdf.confirmationEmailHoldReason ?? null, null);
    for (const key of CLAIM_KEYS) assert.equal((ppdf as unknown as Record<string, unknown>)[key], null);
    assert.equal(ppdf.confirmationEmailAttempts?.at(-1)?.outcome, 'pre_dispatch_failed');

    const t = frozenTransport(w, [ACCEPTED]);
    const run = await dispatch(w, t.transport, { nowMs: DISPATCH_NOW_MS + 300_000, attemptId: 'attempt-frozen-2' });
    assert.deepEqual(run.outcome, { status: 'sent' });
    assert.equal(t.calls.length, 1);
    const record = w.orderIo.record()!;
    assert.equal(record.confirmationEmailState, 'ACCEPTED');
    assert.equal(record.confirmationEmailAttempts?.length, 2);
  });
});

// ── FD-8: W1 — the first-intent instant is carried, never replaced ─────────

test('FD-8: a second intent keeps the original first-dispatch instant', async () => {
  await withAmbient({}, async () => {
    const w = world();
    const ppdf = await toPpdf(w);
    assert.equal(ppdf.confirmationEmailFirstDispatchIntentAt, DISPATCH_NOW);
    const later = DISPATCH_NOW_MS + 300_000;
    const t = frozenTransport(w, [{ kind: 'submit_threw', errorClass: 'TimeoutError' }]);
    const before = w.orderIo.commits.length;
    await dispatch(w, t.transport, { nowMs: later, attemptId: 'attempt-frozen-2' });
    const intent = w.orderIo.commits[before].after;
    assert.equal(intent.confirmationEmailState, 'DISPATCH_INTENT_RECORDED');
    assert.equal(intent.confirmationEmailFirstDispatchIntentAt, DISPATCH_NOW, 'W1: the instant moved');
    assert.equal(intent.confirmationEmailDispatchDeadlineAt, new Date(later + 90_000).toISOString());
    assert.equal(w.orderIo.record()!.confirmationEmailFirstDispatchIntentAt, DISPATCH_NOW);
  });
});

for (const corrupt of ['not-an-instant', '', '2026-10-15T13:01:00Z']) {
  test(`FD-8: a corrupt first-dispatch instant (${JSON.stringify(corrupt)}) defers with zero writes and zero calls`, async () => {
    await withAmbient({}, async () => {
      for (const state of ['SNAPSHOTTED', 'PROVABLY_PRE_DISPATCH_FAILED'] as const) {
        const w = world();
        if (state === 'SNAPSHOTTED') await snapshot(w);
        else await toPpdf(w);
        w.orderIo.patch({ confirmationEmailFirstDispatchIntentAt: corrupt });
        const t = frozenTransport(w, []);
        const before = w.orderIo.commits.length;
        const run = await dispatch(w, t.transport, { nowMs: DISPATCH_NOW_MS + 300_000 });
        assert.deepEqual(run.outcome, { status: 'snapshot_deferred', reason: 'first_intent_invalid' }, state);
        assert.equal(w.orderIo.commits.length, before, `${state}: a write`);
        assert.equal(t.calls.length, 0);
      }
    });
  });
}

// ── FD-9: a purged ref is structurally unsendable ──────────────────────────

test('FD-9: a purged ref is held as payload_purged with no store read and no call', async () => {
  await withAmbient({}, async () => {
    const w = world();
    await snapshot(w);
    w.orderIo.patch({ confirmationEmailEnvelopeRef: { ...w.orderIo.record()!.confirmationEmailEnvelopeRef, purgedAt: '2026-10-15T13:00:30.000Z' } });
    const gets = w.store.count('get');
    const t = frozenTransport(w, []);
    const run = await dispatch(w, t.transport, { gets: [] });
    assert.deepEqual(run.outcome, { status: 'held', reason: 'payload_purged' });
    assert.equal(w.store.count('get'), gets);
    assert.equal(t.calls.length, 0);
    assert.equal(w.orderIo.record()!.confirmationEmailState, 'RECONCILIATION_REQUIRED');
  });
});

// ── FD-10: an unusable envelope (P3b / P3c) and an unreadable one (P3a) ────

for (const [label, spoil] of [
  ['missing', (w: World) => { w.store.objects.clear(); }],
  ['unparseable', (w: World) => { const { pathname } = w.store.only(); w.store.setObject(pathname, '{'); }],
  ['digest-broken', (w: World) => {
    const { pathname, envelope } = w.store.only();
    w.store.setObject(pathname, JSON.stringify({ ...envelope, request: { ...envelope.request, subject: 'tampered' } }));
  }],
] as const) {
  test(`FD-10: a ${label} envelope from SNAPSHOTTED is held as snapshot_refused; from PPDF it defers`, async () => {
    await withAmbient({}, async () => {
      const snap = world();
      await snapshot(snap);
      spoil(snap);
      const t = frozenTransport(snap, []);
      const run = await dispatch(snap, t.transport);
      assert.deepEqual(run.outcome, { status: 'held', reason: 'snapshot_refused' });
      assert.equal(snap.orderIo.record()!.confirmationEmailHoldReason, 'snapshot_refused');

      const ppdf = world();
      await toPpdf(ppdf);
      spoil(ppdf);
      const t2 = frozenTransport(ppdf, []);
      const before = ppdf.orderIo.commits.length;
      const run2 = await dispatch(ppdf, t2.transport, { nowMs: DISPATCH_NOW_MS + 300_000 });
      assert.deepEqual(run2.outcome, { status: 'snapshot_deferred', reason: 'envelope_unusable_ppdf' });
      assert.equal(ppdf.orderIo.commits.length, before);
      assert.equal(t.calls.length + t2.calls.length, 0);
    });
  });
}

test('FD-10: a transient store failure defers with no write from either state', async () => {
  await withAmbient({}, async () => {
    for (const make of [snapshot, toPpdf]) {
      const w = world();
      await make(w);
      const t = frozenTransport(w, []);
      const before = w.orderIo.commits.length;
      const run = await dispatch(w, t.transport, { nowMs: DISPATCH_NOW_MS + 300_000, gets: [{ error: new Error('synthetic network failure') }] });
      assert.deepEqual(run.outcome, { status: 'snapshot_deferred', reason: 'envelope_read_failed' });
      assert.equal(w.orderIo.commits.length, before);
      assert.equal(t.calls.length, 0);
    }
  });
});

// ── FD-11: CK-T drift after the intent commit ──────────────────────────────

test('FD-11: namespace drift after the intent commit sends nothing and writes nothing further', async () => {
  await withAmbient({}, async () => {
    const w = world([paidOrder()], {
      afterCommit: (committed) => {
        if (committed.confirmationEmailState === 'DISPATCH_INTENT_RECORDED') process.env.HSB_BLOB_NAMESPACE = Z;
      },
    });
    await snapshot(w);
    const t = frozenTransport(w, [ACCEPTED]);
    const before = w.orderIo.commits.length;
    const run = await dispatch(w, t.transport);
    assert.deepEqual(run.outcome, { status: 'snapshot_deferred', reason: 'namespace_drift' });
    assert.equal(t.calls.length, 0);
    assert.equal(w.orderIo.commits.length - before, 1, 'only the intent commit');
    const record = w.orderIo.record()!;
    assert.equal(record.confirmationEmailState, 'DISPATCH_INTENT_RECORDED');
    assert.equal(record.emailResendClaimId, CLAIM_ID);
    // Namespace-sensitive store: nothing under ns-z was read or written, and
    // every call named the one ns-a record path.
    assert.equal(w.adapter.zCalls(), 0);
    assert.deepEqual(w.adapter.nonPathCalls(recordPathIn(A)), []);
  });
});

// ── FD-12: a transport that is not ready ───────────────────────────────────

for (const [label, ready] of [
  ['false', () => false],
  ['throwing', () => { throw new Error('not configured'); }],
  ['truthy but not true', () => 1 as unknown as boolean],
] as const) {
  test(`FD-12: ready() ${label} defers before any read or write`, async () => {
    await withAmbient({}, async () => {
      const w = world();
      await snapshot(w);
      const t = frozenTransport(w, [], { ready });
      const before = { commits: w.orderIo.commits.length, gets: w.store.count('get') };
      const run = await dispatch(w, t.transport, { gets: [] });
      assert.deepEqual(run.outcome, { status: 'snapshot_deferred', reason: 'transport_not_ready' });
      assert.equal(w.orderIo.commits.length, before.commits);
      assert.equal(w.store.count('get'), before.gets);
      assert.equal(t.calls.length, 0);
    });
  });
}

// ── FD-13: ACCEPTED carries all four receipt fields from one CAS ───────────

test('FD-13: the receipt commit writes state, sentAt, acceptedAt and the message id together', async () => {
  await withAmbient({}, async () => {
    const w = world();
    await snapshot(w);
    const t = frozenTransport(w, [ACCEPTED]);
    const before = w.orderIo.commits.length;
    const run = await dispatch(w, t.transport);
    assert.deepEqual(run.outcome, { status: 'sent' });
    assert.equal(w.orderIo.commits.length - before, 2, 'C2 and C3');
    const receipt = w.orderIo.commits.at(-1)!.after;
    assert.equal(receipt.confirmationEmailState, 'ACCEPTED');
    assert.equal(receipt.confirmationEmailSentAt, DISPATCH_NOW);
    assert.equal(receipt.confirmationEmailAcceptedAt, DISPATCH_NOW);
    assert.equal(receipt.confirmationEmailProviderMessageId, MESSAGE_ID);
    assert.equal(receipt.confirmationEmailHoldReason, null);
    assert.equal(receipt.confirmationEmailDispatchDeadlineAt, null);
    for (const key of CLAIM_KEYS) assert.equal((receipt as unknown as Record<string, unknown>)[key], null);
    assert.equal(receipt.confirmationEmailAttemptId, ATTEMPT_ID);
    assert.equal(receipt.confirmationEmailFirstDispatchIntentAt, DISPATCH_NOW);
    assert.deepEqual(receipt.confirmationEmailAttempts, [{
      attemptId: ATTEMPT_ID, claimId: CLAIM_ID, intentAt: DISPATCH_NOW, outcome: 'accepted',
      providerMessageId: MESSAGE_ID, providerErrorClass: null, statusCode: null,
    }]);
    assert.ok(run.logs.some((line) => line.includes(`orderId=${ORDER_ID}`) && line.includes(`providerMessageId=${MESSAGE_ID}`)));
  });
});

// ── FD-14: the write set of every commit kind, and no canary movement ──────

const WRITE_SET_INTENT = [
  'confirmationEmailAttemptId', 'confirmationEmailDispatchDeadlineAt', 'confirmationEmailFirstDispatchIntentAt',
  'confirmationEmailState', ...CLAIM_KEYS, 'updatedAt',
].sort();
// The attempt reads its clock once, so a terminal commit's `updatedAt` equals
// the intent commit's and is not in its delta.
const RELEASE_HOLD = ['confirmationEmailAttempts', 'confirmationEmailHoldReason', 'confirmationEmailState', ...CLAIM_KEYS].sort();

const WRITE_SET_CASES: Array<{ label: string; result?: FrozenDispatchTransportResult; tamper?: (w: World) => void; script?: MemScript; terminal: string[] }> = [
  {
    label: 'C3 accepted',
    result: ACCEPTED,
    terminal: ['confirmationEmailAcceptedAt', 'confirmationEmailAttempts', 'confirmationEmailDispatchDeadlineAt',
      'confirmationEmailProviderMessageId', 'confirmationEmailSentAt', 'confirmationEmailState', ...CLAIM_KEYS].sort(),
  },
  { label: 'T5 pre-dispatch', result: { kind: 'not_submitted', cause: 'client_construction' },
    terminal: ['confirmationEmailAttempts', 'confirmationEmailState', ...CLAIM_KEYS].sort() },
  { label: 'T7 ambiguous', result: { kind: 'no_message_id' }, terminal: RELEASE_HOLD },
  { label: 'F4 fence', tamper: (w) => w.orderIo.patch({ confirmationEmailFrom: 'Other <other@example.invalid>' }), terminal: RELEASE_HOLD },
  {
    label: 'T8 receipt failed',
    result: ACCEPTED,
    script: { throwOnCommit: (next) => (next.confirmationEmailState === 'ACCEPTED' ? new Error('synthetic') : null) },
    terminal: ['confirmationEmailAttempts', 'confirmationEmailHoldReason', 'confirmationEmailState'].sort(),
  },
];

for (const row of WRITE_SET_CASES) {
  test(`FD-14: ${row.label} — exact write set, first-intent untouched, no canary movement`, async () => {
    await withAmbient({}, async () => {
      const w = world([paidOrder()], row.script ?? {});
      await snapshot(w);
      row.tamper?.(w);
      const t = frozenTransport(w, row.result ? [row.result] : []);
      const start = w.orderIo.commits.length;
      const run = await dispatch(w, t.transport);
      const [intent, terminal, ...rest] = w.orderIo.commits.slice(start);
      assert.deepEqual(rest, []);
      assert.deepEqual(delta(intent.before as never, intent.after as never), WRITE_SET_INTENT, 'C2 write set');
      assert.deepEqual(delta(terminal.before as never, terminal.after as never), row.terminal, `${row.label} write set`);
      assert.equal(terminal.after.confirmationEmailFirstDispatchIntentAt, intent.after.confirmationEmailFirstDispatchIntentAt);
      assert.deepEqual(canaryDelta(intent.before, intent.after), ZERO_CANARY_DELTA);
      assert.deepEqual(canaryDelta(terminal.before, terminal.after), ZERO_CANARY_DELTA);
      assertNoCanaryInLogs(run);
    });
  });
}

test('FD-14: the two refusal holds write state, hold reason and updatedAt only', async () => {
  await withAmbient({}, async () => {
    const purged = world();
    await snapshot(purged);
    purged.orderIo.patch({ confirmationEmailEnvelopeRef: { ...purged.orderIo.record()!.confirmationEmailEnvelopeRef, purgedAt: '2026-10-15T13:00:30.000Z' } });
    let start = purged.orderIo.commits.length;
    await dispatch(purged, frozenTransport(purged, []).transport);
    const [hold] = purged.orderIo.commits.slice(start);
    assert.deepEqual(delta(hold.before as never, hold.after as never), ['confirmationEmailHoldReason', 'confirmationEmailState', 'updatedAt']);

    const refused = world();
    await snapshot(refused);
    refused.store.objects.clear();
    start = refused.orderIo.commits.length;
    await dispatch(refused, frozenTransport(refused, []).transport);
    const [t13] = refused.orderIo.commits.slice(start);
    assert.deepEqual(delta(t13.before as never, t13.after as never), ['confirmationEmailHoldReason', 'confirmationEmailState', 'updatedAt']);
  });
});

// ── FD-15: the real transport binding, against a fake client ───────────────

const FROZEN_REQUEST = Object.freeze({
  from: 'Hero Story Books <frozen@example.invalid>',
  to: Object.freeze(['buyer-frozen@example.invalid']) as unknown as readonly [string],
  subject: 'Frozen subject',
  html: '<p>frozen</p>',
  text: 'frozen',
  replyTo: 'support-frozen@example.invalid',
});
const FROZEN_KEY = `order-confirmation-${ORDER_ID}-primary-v1`;

function fakeClient(response: () => unknown) {
  const sends: Array<{ payload: unknown; options: unknown }> = [];
  const keys: string[] = [];
  const createClient = (apiKey: string) => {
    keys.push(apiKey);
    return {
      emails: {
        send: async (payload: unknown, options: unknown) => {
          sends.push({ payload: JSON.parse(JSON.stringify(payload)), options: JSON.parse(JSON.stringify(options)) });
          return response();
        },
      },
    } as never;
  };
  return { createClient, sends, keys };
}

const withKey = <T>(env: Record<string, string | undefined>, fn: () => Promise<T>) => withAmbient(env, fn);

test('FD-15: the exact six fields and the exact key reach the client, once', async () => {
  await withKey({ HSB_RESEND_API_KEY: 're_SYNTHETIC_not_a_key' }, async () => {
    const client = fakeClient(() => ({ data: { id: MESSAGE_ID }, error: null }));
    const result = await dispatchFrozenConfirmationRequest(FROZEN_REQUEST, FROZEN_KEY, { createClient: client.createClient });
    assert.deepEqual(result, { kind: 'accepted', id: MESSAGE_ID });
    assert.deepEqual(client.keys, ['re_SYNTHETIC_not_a_key']);
    assert.deepEqual(client.sends, [{
      payload: {
        from: FROZEN_REQUEST.from, to: [FROZEN_REQUEST.to[0]], subject: FROZEN_REQUEST.subject,
        html: FROZEN_REQUEST.html, text: FROZEN_REQUEST.text, replyTo: FROZEN_REQUEST.replyTo,
      },
      options: { idempotencyKey: FROZEN_KEY },
    }]);
  });
  await withKey({ RESEND_API_KEY: 're_SYNTHETIC_fallback' }, async () => {
    const client = fakeClient(() => ({ data: { id: MESSAGE_ID }, error: null }));
    await dispatchFrozenConfirmationRequest(FROZEN_REQUEST, FROZEN_KEY, { createClient: client.createClient });
    assert.deepEqual(client.keys, ['re_SYNTHETIC_fallback']);
  });
});

test('FD-15: a missing key, an invalid argument or a client that cannot be built is not_submitted with zero sends', async () => {
  await withKey({}, async () => {
    const client = fakeClient(() => { throw new Error('unreachable'); });
    assert.deepEqual(await dispatchFrozenConfirmationRequest(FROZEN_REQUEST, FROZEN_KEY, { createClient: client.createClient }),
      { kind: 'not_submitted', cause: 'missing_resend_api_key' });
    assert.equal(client.keys.length, 0);
  });
  await withKey({ HSB_RESEND_API_KEY: 're_SYNTHETIC_not_a_key' }, async () => {
    const client = fakeClient(() => { throw new Error('unreachable'); });
    for (const [request, key] of [
      [{ ...FROZEN_REQUEST, to: ['a@example.invalid', 'b@example.invalid'] }, FROZEN_KEY],
      [{ ...FROZEN_REQUEST, to: [] }, FROZEN_KEY],
      [{ ...FROZEN_REQUEST, subject: 7 }, FROZEN_KEY],
      [{ ...FROZEN_REQUEST, replyTo: undefined }, FROZEN_KEY],
      [null, FROZEN_KEY],
      [FROZEN_REQUEST, ''],
      [FROZEN_REQUEST, 42],
    ] as const) {
      assert.deepEqual(
        await dispatchFrozenConfirmationRequest(request as never, key as never, { createClient: client.createClient }),
        { kind: 'not_submitted', cause: 'argument_invalid' },
      );
    }
    assert.equal(client.keys.length, 0);
    const broken = await dispatchFrozenConfirmationRequest(FROZEN_REQUEST, FROZEN_KEY, {
      createClient: () => { throw new Error('CANARY constructor failure for buyer@example.invalid'); },
    });
    assert.deepEqual(broken, { kind: 'not_submitted', cause: 'client_construction' });
  });
});

test('FD-15: every post-submission failure carries a status and a class, never a message', async () => {
  await withKey({ HSB_RESEND_API_KEY: 're_SYNTHETIC_not_a_key' }, async () => {
    const cases: Array<[() => unknown, FrozenDispatchTransportResult]> = [
      [() => ({ data: null, error: { statusCode: 422, name: 'validation_error', message: 'CANARY-TO-6a1e@example.invalid is invalid' } }),
        { kind: 'provider_error', statusCode: 422, providerErrorClass: 'validation_error' }],
      [() => ({ data: null, error: { statusCode: null, name: 'application_error', message: 'Unable to fetch data.' } }),
        { kind: 'provider_error', statusCode: null, providerErrorClass: 'application_error' }],
      [() => ({ data: null, error: { statusCode: '409', name: 'bad name with spaces', message: 'x' } }),
        { kind: 'provider_error', statusCode: null, providerErrorClass: 'unknown' }],
      [() => ({ data: {}, error: null }), { kind: 'no_message_id' }],
      [() => ({ data: { id: 'CANARY-TO-6a1e@example.invalid' }, error: null }), { kind: 'no_message_id' }],
      [() => ({ data: { id: 'x'.repeat(129) }, error: null }), { kind: 'no_message_id' }],
      [() => { throw new TypeError('CANARY-TO-6a1e@example.invalid socket hang up'); }, { kind: 'submit_threw', errorClass: 'TypeError' }],
      [() => null, { kind: 'submit_threw', errorClass: 'TypeError' }],
    ];
    for (const [response, expected] of cases) {
      const client = fakeClient(response);
      const result = await dispatchFrozenConfirmationRequest(FROZEN_REQUEST, FROZEN_KEY, { createClient: client.createClient });
      assert.deepEqual(result, expected);
      assert.equal(client.sends.length, 1);
      const text = JSON.stringify(result);
      assert.ok(!text.includes('@') && !text.includes('CANARY'), `a provider message crossed: ${text}`);
    }
  });
});

test('FD-15: the transport reads only the two Resend key names from the environment', async () => {
  await withKey({ HSB_RESEND_API_KEY: 're_SYNTHETIC_not_a_key' }, async () => {
    const original = process.env;
    const reads: string[] = [];
    process.env = new Proxy({ ...original }, {
      get(target, key, receiver) {
        if (typeof key === 'string') reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    }) as NodeJS.ProcessEnv;
    try {
      const client = fakeClient(() => ({ data: { id: MESSAGE_ID }, error: null }));
      await dispatchFrozenConfirmationRequest(FROZEN_REQUEST, FROZEN_KEY, { createClient: client.createClient });
    } finally {
      process.env = original;
    }
    assert.deepEqual([...new Set(reads)].filter((key) => key !== 'HSB_RESEND_API_KEY' && key !== 'RESEND_API_KEY'), []);
  });
});

// ── FD-16: the writer's supplied environment gains no read without a transport ─

test('FD-16: the dispatch flag is read once, and only with the writer armed and a transport injected', async () => {
  await withAmbient({}, async () => {
    const recorded = (flag: string | undefined) => {
      const reads: string[] = [];
      const env = new Proxy(writerEnv(flag) as Record<string, string | undefined>, {
        get(target, key, receiver) {
          if (typeof key === 'string') reads.push(key);
          return Reflect.get(target, key, receiver);
        },
      }) as NodeJS.ProcessEnv;
      return { env, reads };
    };
    const runWith = async (w: World, env: NodeJS.ProcessEnv, frozen?: ConfirmationFrozenDispatchDeps) => {
      const deps = deliveryDeps(w, { flag: 'true', frozen, logs: [], errors: [] });
      return deliverOrderConfirmationEmail(ORDER_ID, { ...deps, envelopeWriter: { ...deps.envelopeWriter, env } });
    };

    const count = (reads: string[], key: string) => reads.filter((read) => read === key).length;

    // No transport: the supplied environment is read exactly as the writer
    // reads it — the flag first, then each own key once by the W0 snapshot —
    // and the dispatch key, which is not an own key here, not at all.
    const plain = world();
    await snapshot(plain);
    const without = recorded(undefined);
    assert.deepEqual(await runWith(plain, without.env), { status: 'blocked', reason: 'awaiting_frozen_dispatch' });
    assert.equal(count(without.reads, CONFIRMATION_FROZEN_DISPATCH_ENV), 0, 'the flag was read with no transport injected');
    assert.deepEqual([...without.reads.slice(1)].sort(), Object.keys(writerEnv(undefined)).sort());

    // A transport: the W0 snapshot reads the own key once and the dispatcher once more.
    const armed = world();
    await snapshot(armed);
    const withT = recorded('true');
    const t = frozenTransport(armed, [ACCEPTED]);
    armed.store.script.get.push('serve');
    assert.deepEqual(await runWith(armed, withT.env, armedFrozen(t.transport)), { status: 'sent' });
    assert.equal(count(withT.reads, CONFIRMATION_FROZEN_DISPATCH_ENV), 2);
    for (const key of Object.keys(writerEnv(undefined))) {
      assert.equal(count(withT.reads, key), key === 'HSB_CONFIRMATION_ENVELOPE_WRITER' ? 2 : 1, key);
    }
  });
});

// ── File-end isolation evidence ─────────────────────────────────────────────

test('ISO: file-end — no fetch, no legacy send, no Resend key, no ambient flag left behind', () => {
  assert.equal(FETCH_CALLS, 0, 'ISO-4: fetch was called');
  assert.equal(LEGACY_SEND_CALLS, 0, 'the legacy send was reached');
  assert.equal(process.env.HSB_RESEND_API_KEY || undefined, undefined);
  assert.equal(process.env.RESEND_API_KEY || undefined, undefined);
  assert.equal(process.env.HSB_CONFIRMATION_FROZEN_DISPATCH, undefined);
  assert.equal(process.env.HSB_BLOB_NAMESPACE, undefined);
  assert.equal(UNSCRIPTED_TOTAL, 0, 'ISO-1 / ISO-9: a synthetic seam saw an unscripted call');
  assert.equal(DEL_CALLS_TOTAL, 0, 'a delete was attempted');
});
