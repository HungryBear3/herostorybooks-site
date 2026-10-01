/*
 * L-4 A3-4 R2 — the interlocked snapshot producer (architecture §2–§16).
 *
 * With the writer armed — which needs the exact flag `true`, a complete
 * injected synthetic store adapter, and a process that is not a Vercel
 * deployment — a paid order that is positively enrolled and provably never
 * dispatched has its confirmation envelope frozen once, written write-once to
 * the private store, and committed as `SNAPSHOTTED` plus its ref in one CAS.
 * Every order read and every conditional commit of the attempt runs through
 * NBT, bound to the one namespace frozen at W0. Nothing is sent.
 *
 * Seams (matrix §0), all synthetic:
 *   - `strictSyntheticStoreIo`  put/get/del, scripted per call; anything
 *                               unscripted throws `SyntheticUnscriptedCall`;
 *   - `memOrderIo`              the in-memory bound order I/O (the raw NBT
 *                               pair over a map keyed by full record path),
 *                               with conflicts, concurrent edits, windows and L*;
 *   - real NBT over `nsOrderAdapter` (ISO-9) for the namespace rows, with the
 *     same order id seeded under `ns-a` and `ns-z`;
 *   - `withEnvRecorder` (ISO-8), `throwingTransport`, `recordingTransport`.
 *
 * Rows titled `[defensive seam]` call a pure producer seam directly and are
 * not integration coverage; rows titled `[stage seam]` call the exported S6
 * stage with synthetic evidence. Both are counted separately.
 *
 * No network, no credential, no `.env`, no real store, provider or order
 * action. Order ids are assembled, never written as literals (REQ16).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { describe, mock } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { BlobError, BlobNotFoundError } from '@vercel/blob';
import ts from 'typescript';

import * as producer from '../src/lib/confirmation-envelope-producer.ts';
import type {
  ConfirmationEnvelopeWriterGate,
  SnapshotCandidate,
  SnapshotDecisionContext,
  SnapshotEvidence,
  SnapshotFrame,
} from '../src/lib/confirmation-envelope-producer.ts';
import {
  CONFIRMATION_EMAIL_CLAIM_STALE_MS,
  deliverOrderConfirmationEmail,
  evaluateConfirmationEmailClaimability,
  type ConfirmationEmailDeliveryOutcome,
  type DeliverOrderConfirmationEmailDeps,
} from '../src/lib/confirmation-email-delivery.ts';
import { runConfirmationEmailSweep } from '../src/lib/confirmation-email-sweep.ts';
import {
  _resetConfirmationEmailInFlightForTest,
  scheduleOrderConfirmationEmail,
} from '../src/lib/order-confirmation-kickoff.ts';
import {
  CONFIRMATION_ENVELOPE_LIMITS,
  buildConfirmationEmailEnvelope,
  checkConfirmationEnvelopeLimits,
  digestConfirmationRequest,
  type ConfirmationEnvelopeRefusalReason,
} from '../src/lib/confirmation-email-envelope.ts';
import { CONFIRMATION_EMAIL_STATES, evaluateConfirmationEmailTransition } from '../src/lib/confirmation-email-state.ts';
import {
  CONFIRMATION_ENVELOPE_ACCOUNT_LABEL,
  CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES,
  CONFIRMATION_ENVELOPE_ORDER_ID_RE,
  CONFIRMATION_ENVELOPE_TEMPLATE_VERSION,
  confirmationEnvelopeObjectPath,
} from '../src/lib/confirmation-envelope-config.ts';
import { toAdminOrderDetail, toAdminOrderListItem } from '../src/lib/admin-order-dto.ts';
import {
  OrderVersionConflictError,
  __resetOrderStoreAdapterFactoryForTests,
  __setOrderStoreAdapterFactoryForTests,
  appendAuditEventTo,
  applyFulfillmentPatchTo,
  bindOrderNamespace,
  createOrderRecord,
  orderRecordPathInNamespace,
  readOrderVersionedInNamespace,
  withOrderTransactionInNamespace,
  type OrderNamespaceBinding,
  type OrderRecord,
  type OrderStoreAdapter,
} from '../src/lib/orders.ts';
import {
  buildOrderConfirmationEmail,
  buildOrderConfirmationIdempotencyKey,
} from '../src/lib/order-email.ts';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const readRepo = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');
const sha16 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);

// ── ISO-3 / ISO-4 / ISO-8 / ISO-9: file-start backstops ────────────────────

const AMBIENT_KEYS = [
  'HSB_BLOB_NAMESPACE', 'VERCEL', 'VERCEL_ENV', 'NEXT_PUBLIC_URL', 'HSB_EMAIL_FROM', 'EMAIL_FROM',
  'HSB_SUPPORT_EMAIL', 'HSB_CONFIRMATION_ENVELOPE_WRITER', 'HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH',
  'HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN', 'BLOB_READ_WRITE_TOKEN', 'HSB_REQUIRE_DURABLE_PERSISTENCE',
  'HSB_BLOB_ACCESS_MODE',
] as const;
const FILE_START_ENV = process.env;
const FILE_START_AMBIENT = Object.fromEntries(AMBIENT_KEYS.map((key) => [key, process.env[key]]));

// ISO-3: an accidental default send must become `missing_resend_api_key`.
assert.equal(process.env.HSB_RESEND_API_KEY || undefined, undefined, 'ISO-3: no usable Resend key may be present');
assert.equal(process.env.RESEND_API_KEY || undefined, undefined, 'ISO-3: no usable Resend key may be present');
// ISO-8: the suite starts from a world with no writer keys in the ambient env.
assert.equal(process.env.HSB_CONFIRMATION_ENVELOPE_WRITER, undefined, 'ISO-8: no ambient writer flag');

// ISO-4: defence in depth only — the SDK cannot be assumed to route through it.
const ORIGINAL_FETCH = globalThis.fetch;
let FETCH_CALLS = 0;
globalThis.fetch = (async () => {
  FETCH_CALLS += 1;
  throw new Error('ISO-4: fetch is forbidden in the producer suite');
}) as typeof fetch;

let SEQ = 0;
const tick = () => {
  SEQ += 1;
  return SEQ;
};

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Assembled, not written as a literal: REQ16 refuses committable id shapes. */
const idOf = (suffix: string) => ['ord', `${'0'.repeat(16 - suffix.length)}${suffix}`].join('_');
const ORDER_ID = idOf('c1');

const EPOCH = '2026-10-15T12:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH);
const NOW = '2026-10-15T13:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const FLOOR = '2026-09-21T12:48:51.665Z';

const A = 'ns-a';
const B = 'ns-b';
const Z = 'ns-z';

const SYNTHETIC_TOKEN = 'vercel_blob_rw_SYNTHETICenvStore01_SYNTHETICsecret000001';

const CANARY_FROM = 'CANARY-FROM-9f31';
const CANARY_TO = 'CANARY-TO-4b7c@example.invalid';
const CANARY_SUBJ = 'CANARY-SUBJ-1d90';
const CANARY_HTML = 'CANARY-HTML-77ae';
const CANARY_TEXT = 'CANARY-TEXT-0c52';
const CANARY_REPLY = 'CANARY-REPLY-3e18@example.invalid';
const URL_A = 'https://CANARY-URL-A-51d2.example.invalid';
const URL_B = 'https://CANARY-URL-B-8e07.example.invalid';
const URL_C = 'https://CANARY-URL-C-2af9.example.invalid';
const CANARIES = [CANARY_FROM, CANARY_TO, CANARY_SUBJ, CANARY_HTML, CANARY_TEXT, CANARY_REPLY];
const URL_CANARIES = ['CANARY-URL-A-51d2', 'CANARY-URL-B-8e07', 'CANARY-URL-C-2af9'];

/** The ambient rendering configuration every armed row starts from. */
const RENDER_ENV = {
  HSB_EMAIL_FROM: `${CANARY_FROM} <no-reply@example.invalid>`,
  HSB_SUPPORT_EMAIL: CANARY_REPLY,
  NEXT_PUBLIC_URL: `https://${CANARY_TEXT}.example.invalid`,
};

function paidOrder(overrides: Partial<OrderRecord> = {}, id = ORDER_ID): OrderRecord {
  return {
    ...createOrderRecord(
      { childName: CANARY_SUBJ, bookFormat: 'digital', email: CANARY_TO },
      { id, now: '2026-10-15T11:00:00.000Z' },
    ),
    formatLabel: CANARY_HTML,
    paymentStatus: 'paid' as const,
    paidAt: EPOCH,
    stripeSessionId: `cs_test_${id}`,
    updatedAt: '2026-10-15T12:30:00.000Z',
    ...overrides,
  } as OrderRecord;
}

/** The supplied writer environment (`envelopeWriter.env`): a plain object. */
function writerEnv(namespace?: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    HSB_CONFIRMATION_ENVELOPE_WRITER: 'true',
    HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: EPOCH,
    HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: SYNTHETIC_TOKEN,
    ...overrides,
  };
  if (namespace !== undefined) env.HSB_BLOB_NAMESPACE = namespace;
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env as NodeJS.ProcessEnv;
}

// ── Ambient environment (ISO-8) ─────────────────────────────────────────────

type AmbientValues = Partial<Record<(typeof AMBIENT_KEYS)[number], string | undefined>>;

function setAmbient(values: AmbientValues): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** One row's ambient world, restored in `finally`. Durable persistence off, no
 *  Vercel keys, no order-store token unless the row sets them. */
async function withAmbient<T>(values: AmbientValues, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(AMBIENT_KEYS.map((key) => [key, process.env[key]]));
  setAmbient({
    HSB_BLOB_NAMESPACE: undefined, VERCEL: undefined, VERCEL_ENV: undefined, BLOB_READ_WRITE_TOKEN: undefined,
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'false', HSB_CONFIRMATION_ENVELOPE_WRITER: undefined,
    HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: undefined, HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: undefined,
    HSB_BLOB_ACCESS_MODE: undefined, EMAIL_FROM: undefined,
    ...RENDER_ENV, ...values,
  });
  try {
    return await fn();
  } finally {
    setAmbient(saved as AmbientValues);
    __resetOrderStoreAdapterFactoryForTests();
  }
}

interface EnvRead { seq: number; key: string }

/** Every delivery call, as a sequence window: environment reads are counted
 *  inside it, so the harness's own save/restore reads are never attributed to
 *  the code under test. */
const DELIVERY_WINDOWS: Array<{ start: number; end: number }> = [];

async function inDelivery<T>(fn: () => Promise<T>): Promise<T> {
  const window = { start: tick(), end: Number.POSITIVE_INFINITY };
  DELIVERY_WINDOWS.push(window);
  try {
    return await fn();
  } finally {
    window.end = tick();
  }
}

/** Reads inside the most recent delivery window. */
function readsInLastDelivery(reads: EnvRead[]): EnvRead[] {
  const window = DELIVERY_WINDOWS[DELIVERY_WINDOWS.length - 1];
  return reads.filter((read) => read.seq > window.start && read.seq < window.end);
}

/** ISO-8 `envRecorder`: a recording proxy over a synthetic copy of the ambient
 *  environment; key names only, never values. The original object is put back
 *  in `finally`. */
async function withEnvRecorder<T>(fn: (reads: EnvRead[]) => Promise<T>): Promise<T> {
  const original = process.env;
  const reads: EnvRead[] = [];
  process.env = new Proxy({ ...original }, {
    get(target, key, receiver) {
      if (typeof key === 'string') reads.push({ seq: tick(), key });
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === 'string') reads.push({ seq: tick(), key });
      return Reflect.has(target, key);
    },
  }) as NodeJS.ProcessEnv;
  try {
    return await fn(reads);
  } finally {
    process.env = original;
  }
}

// ── Transports (ISO-2) ──────────────────────────────────────────────────────

class TransportTouched extends Error {
  constructor() {
    super('TransportTouched');
    this.name = 'TransportTouched';
  }
}

/** SN-6: every throwing-transport call in the whole file, asserted 0 at the end. */
let THROWING_TRANSPORT_CALLS = 0;

function throwingTransport() {
  let calls = 0;
  return {
    send: async (): Promise<never> => {
      calls += 1;
      THROWING_TRANSPORT_CALLS += 1;
      throw new TransportTouched();
    },
    calls: () => calls,
  };
}

function recordingTransport(onSend?: () => void) {
  let calls = 0;
  return {
    send: async () => {
      calls += 1;
      onSend?.();
      return { skipped: false as const, id: 'msg_synthetic' };
    },
    calls: () => calls,
  };
}

// ── strictSyntheticStoreIo (ISO-1) ──────────────────────────────────────────

class SyntheticUnscriptedCall extends Error {
  constructor(what: string) {
    super(`SyntheticUnscriptedCall: ${what}`);
    this.name = 'SyntheticUnscriptedCall';
  }
}

let UNSCRIPTED_TOTAL = 0;
/** OR-17: every `del` in the whole file, asserted 0 at the end. */
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
    io: io as unknown as NonNullable<producer.ConfirmationEnvelopeWriterDeps['storeIo']>,
    calls,
    objects,
    count: (op: StoreCall['op']) => calls.filter((call) => call.op === op).length,
  };
}

// ── memOrderIo: the in-memory bound order I/O (matrix §0) ──────────────────

class AsyncMutateError extends Error {
  constructor() {
    super('AsyncMutateError: the CAS callback returned a thenable');
    this.name = 'AsyncMutateError';
  }
}

interface Window { start: number; end: number }

interface MemScript {
  /** Lost CAS attempts, per transact call index. */
  conflicts?: number[];
  /** The concurrent change that lands when attempt `attempt` of a call loses. */
  onConflict?: (callIndex: number, attempt: number, stored: OrderRecord) => OrderRecord;
  /** A hook at the start of every transact attempt (used to drift the env). */
  beforeAttempt?: (callIndex: number, attempt: number) => void;
  /** Throw from the commit of a transact call: before or after the write. */
  throwOnCommit?: { callIndex: number; when: 'before-write' | 'after-write'; error: Error };
  /** Rewrite a provenance before it is returned (defensive seam rows). */
  provenance?: (op: 'read' | 'transact', callIndex: number, value: Record<string, unknown>) => Record<string, unknown>;
  /** Rewrite a raw read result before it is returned (defensive seam rows). */
  readResult?: (value: { found: unknown; provenance: unknown }) => { found: unknown; provenance: unknown };
}

function memOrderIo(seed: OrderRecord[], script: MemScript = {}) {
  const cells = new Map<string, { body: string; version: number }>();
  const pathFor = (namespace: string, orderId: string) => (namespace ? `${namespace}/orders/${orderId}.json` : `orders/${orderId}.json`);
  const seedNamespace = { value: '' };
  const seedInto = (namespace: string) => {
    seedNamespace.value = namespace;
    for (const order of seed) cells.set(pathFor(namespace, order.id), { body: JSON.stringify(order), version: 1 });
  };
  seedInto('');
  const reads: Array<{ seq: number; path: string }> = [];
  const transacts: Array<{ seq: number; path: string; guarded: boolean; window: Window }> = [];
  const callbackWindows: Window[] = [];
  const guardWindows: Window[] = [];
  const writes: Array<{ seq: number; path: string; body: string }> = [];
  const latests: OrderRecord[] = [];
  let lstar: OrderRecord | null = null;
  let transactCalls = 0;
  let readCalls = 0;

  const provenance = (namespace: string, recordPath: string, readPaths: string[], commitPaths: string[], outcome: string) =>
    Object.freeze({
      namespace,
      recordPath,
      readPaths: Object.freeze([...readPaths]),
      commitPaths: Object.freeze([...commitPaths]),
      attempts: readPaths.length,
      outcome,
    });

  const read = async (binding: OrderNamespaceBinding, orderId: string) => {
    const callIndex = readCalls++;
    const recordPath = orderRecordPathInNamespace(binding, orderId);
    reads.push({ seq: tick(), path: recordPath });
    const cell = cells.get(recordPath);
    let p: Record<string, unknown> = provenance(binding.namespace, recordPath, [recordPath], [], cell ? 'read' : 'not_found');
    if (script.provenance) p = script.provenance('read', callIndex, { ...p });
    let result = { found: cell ? { order: JSON.parse(cell.body) as OrderRecord, version: `v${cell.version}` } : null, provenance: p };
    if (script.readResult) result = script.readResult(result) as typeof result;
    return result;
  };

  const transact = async (
    binding: OrderNamespaceBinding,
    orderId: string,
    mutate: (order: OrderRecord) => unknown,
    opts: { notFound: () => unknown; beforeCommit?: () => boolean; maxAttempts?: number },
  ) => {
    const callIndex = transactCalls++;
    const recordPath = orderRecordPathInNamespace(binding, orderId);
    const window: Window = { start: tick(), end: Number.POSITIVE_INFINITY };
    transacts.push({ seq: window.start, path: recordPath, guarded: typeof opts.beforeCommit === 'function', window });
    const readPaths: string[] = [];
    const commitPaths: string[] = [];
    const finish = (status: string, extra: Record<string, unknown> = {}) => {
      window.end = tick();
      let p: Record<string, unknown> = provenance(binding.namespace, recordPath, readPaths, commitPaths, status);
      if (script.provenance) p = script.provenance('transact', callIndex, { ...p });
      return { status, ...extra, provenance: p };
    };
    let losses = script.conflicts?.[callIndex] ?? 0;
    const maxAttempts = opts.maxAttempts ?? 5;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        script.beforeAttempt?.(callIndex, attempt);
        readPaths.push(recordPath);
        reads.push({ seq: tick(), path: recordPath });
        const cell = cells.get(recordPath);
        if (!cell) return finish('not_found', { result: opts.notFound() });
        const latest = JSON.parse(cell.body) as OrderRecord;
        latests.push(structuredClone(latest));
        const cb: Window = { start: tick(), end: Number.POSITIVE_INFINITY };
        callbackWindows.push(cb);
        const outcome = mutate(latest) as { abort?: unknown; commit?: OrderRecord; result?: unknown } | PromiseLike<unknown>;
        cb.end = tick();
        if (outcome && typeof (outcome as PromiseLike<unknown>).then === 'function') throw new AsyncMutateError();
        const decided = outcome as { abort?: unknown; commit?: OrderRecord; result?: unknown };
        if ('abort' in decided) return finish('aborted', { result: decided.abort });
        if (decided.commit!.id !== orderId) throw new Error('commit_id_mismatch');
        const body = JSON.stringify(decided.commit);
        if (opts.beforeCommit) {
          const guard: Window = { start: tick(), end: Number.POSITIVE_INFINITY };
          guardWindows.push(guard);
          let allowed: unknown;
          try {
            allowed = opts.beforeCommit();
          } catch {
            allowed = false;
          }
          guard.end = tick();
          if (allowed !== true) return finish('commit_refused');
        }
        commitPaths.push(recordPath);
        if (losses > 0) {
          losses -= 1;
          const current = JSON.parse(cell.body) as OrderRecord;
          const changed = script.onConflict ? script.onConflict(callIndex, attempt, current) : current;
          cells.set(recordPath, { body: JSON.stringify(changed), version: cell.version + 1 });
          continue;
        }
        if (script.throwOnCommit?.callIndex === callIndex && script.throwOnCommit.when === 'before-write') {
          throw script.throwOnCommit.error;
        }
        cells.set(recordPath, { body, version: cell.version + 1 });
        writes.push({ seq: tick(), path: recordPath, body });
        lstar = structuredClone(latest);
        if (script.throwOnCommit?.callIndex === callIndex && script.throwOnCommit.when === 'after-write') {
          throw script.throwOnCommit.error;
        }
        return finish('committed', { result: decided.result });
      }
      throw new OrderVersionConflictError(orderId, maxAttempts);
    } finally {
      if (window.end === Number.POSITIVE_INFINITY) window.end = tick();
    }
  };

  return {
    io: { read, transact } as unknown as producer.ConfirmationRawOrderIo,
    reseed: (namespace: string) => { cells.clear(); seedInto(namespace); },
    record: (orderId = ORDER_ID, namespace = seedNamespace.value): OrderRecord | null => {
      const cell = cells.get(pathFor(namespace, orderId));
      return cell ? JSON.parse(cell.body) as OrderRecord : null;
    },
    body: (orderId = ORDER_ID, namespace = seedNamespace.value) => cells.get(pathFor(namespace, orderId))?.body,
    put: (order: OrderRecord, namespace = seedNamespace.value) => {
      const current = cells.get(pathFor(namespace, order.id));
      cells.set(pathFor(namespace, order.id), { body: JSON.stringify(order), version: (current?.version ?? 0) + 1 });
    },
    reads, transacts, callbackWindows, guardWindows, writes, latests,
    lstar: () => lstar,
    readCalls: () => readCalls,
    transactCalls: () => transactCalls,
  };
}

/** Delivery seams that must never be called under armed intent (NL-10). */
function forbiddenAmbientSeams() {
  let getOrderCalls = 0;
  let transactCalls = 0;
  return {
    getOrder: async () => { getOrderCalls += 1; throw new Error('ambient getOrder called under armed intent'); },
    transact: (async () => { transactCalls += 1; throw new Error('ambient transact called under armed intent'); }) as unknown as DeliverOrderConfirmationEmailDeps['transact'],
    getOrderCalls: () => getOrderCalls,
    transactCalls: () => transactCalls,
  };
}

interface DeliveryRun {
  outcome: ConfirmationEmailDeliveryOutcome;
  logs: string[];
  errors: string[];
}

/** One delivery attempt with the writer supplied, everything captured. */
async function deliverArmed(opts: {
  env?: NodeJS.ProcessEnv;
  storeIo?: unknown;
  orderIo?: unknown;
  send: DeliverOrderConfirmationEmailDeps['send'];
  now?: number;
  omitWriter?: boolean;
  extra?: Partial<DeliverOrderConfirmationEmailDeps>;
}): Promise<DeliveryRun & { ambient: ReturnType<typeof forbiddenAmbientSeams> }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const ambient = forbiddenAmbientSeams();
  const writer: Record<string, unknown> = {};
  if (opts.env !== undefined) writer.env = opts.env;
  if (opts.storeIo !== undefined) writer.storeIo = opts.storeIo;
  if (opts.orderIo !== undefined) writer.orderIo = opts.orderIo;
  const outcome = await inDelivery(() => deliverOrderConfirmationEmail(ORDER_ID, {
    send: opts.send,
    now: () => opts.now ?? NOW_MS,
    newClaimId: () => 'claim-synthetic',
    log: (line) => { logs.push(line); },
    errorLog: (line) => { errors.push(line); },
    getOrder: ambient.getOrder,
    transact: ambient.transact,
    ...(opts.omitWriter ? {} : { envelopeWriter: writer }),
    ...(opts.extra ?? {}),
  } as DeliverOrderConfirmationEmailDeps));
  return { outcome, logs, errors, ambient };
}

// ── nsOrderAdapter (ISO-9): the real NBT over a namespace-sensitive store ──

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
}

let OVERRIDE_INSTALLED = false;

const recordPathIn = (namespace: string, orderId = ORDER_ID) =>
  (namespace ? `${namespace}/orders/${orderId}.json` : `orders/${orderId}.json`);

function nsOrderAdapter(script: NsScript) {
  const cells = new Map<string, { body: string; n: number }>();
  for (const [pathname, body] of Object.entries(script.seed)) cells.set(pathname, { body, n: 1 });
  const known = new Set<string>(['', A, B, Z].map((namespace) => recordPathIn(namespace)));
  const calls: AdapterCall[] = [];
  const counts: Record<AdapterOp, number> = { readVersioned: 0, createIfAbsent: 0, replaceIfVersion: 0 };
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
      cells.set(pathname, { body, n: cell.n + 1 });
      successfulWrites += 1;
      call.result = 'ok';
      return { ok: true, version: versionOf(pathname, cell.n + 1) };
    },
  };
  let factoryCalls = 0;
  __setOrderStoreAdapterFactoryForTests(() => {
    factoryCalls += 1;
    return adapter;
  });
  OVERRIDE_INSTALLED = true;
  return {
    calls,
    bodyAt: (pathname: string) => cells.get(pathname)?.body,
    recordAt: (pathname: string) => {
      const body = cells.get(pathname)?.body;
      return body === undefined ? null : JSON.parse(body) as OrderRecord;
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

/**
 * A thin wrapper over the REAL NBT pair, injected as `orderIo`, so a row can
 * see callback and guard windows, every `latest`, L*, and which transactions
 * were post-transport (no `beforeCommit`). The NBT functions do all the work.
 */
function observedNbt() {
  const callbackWindows: Window[] = [];
  const guardWindows: Window[] = [];
  const latests: OrderRecord[] = [];
  const decisions: string[] = [];
  const transacts: Array<{ guarded: boolean; status?: string }> = [];
  let lstar: OrderRecord | null = null;
  let reads = 0;
  const io = {
    read: async (binding: OrderNamespaceBinding, orderId: string) => {
      reads += 1;
      return readOrderVersionedInNamespace(binding, orderId);
    },
    transact: async (
      binding: OrderNamespaceBinding,
      orderId: string,
      mutate: (order: OrderRecord) => unknown,
      opts: { notFound: () => unknown; beforeCommit?: () => boolean },
    ) => {
      const entry: { guarded: boolean; status?: string } = { guarded: typeof opts.beforeCommit === 'function' };
      transacts.push(entry);
      let lastCommitLatest: OrderRecord | null = null;
      const wrapped = (latest: OrderRecord) => {
        latests.push(structuredClone(latest));
        const window: Window = { start: tick(), end: Number.POSITIVE_INFINITY };
        callbackWindows.push(window);
        const outcome = mutate(latest) as { commit?: unknown };
        window.end = tick();
        decisions.push(JSON.stringify(outcome));
        if (outcome && 'commit' in outcome) lastCommitLatest = structuredClone(latest);
        return outcome as never;
      };
      const guard = opts.beforeCommit
        ? () => {
          const window: Window = { start: tick(), end: Number.POSITIVE_INFINITY };
          guardWindows.push(window);
          try {
            return opts.beforeCommit!();
          } finally {
            window.end = tick();
          }
        }
        : undefined;
      const result = await withOrderTransactionInNamespace(binding, orderId, wrapped as never, {
        notFound: opts.notFound,
        ...(guard ? { beforeCommit: guard } : {}),
      });
      entry.status = result.status;
      if (result.status === 'committed') lstar = lastCommitLatest;
      return result;
    },
  };
  return {
    io: io as unknown as producer.ConfirmationRawOrderIo,
    callbackWindows, guardWindows, latests, transacts, decisions,
    lstar: () => lstar,
    reads: () => reads,
    postTransport: () => transacts.filter((entry) => !entry.guarded).length,
  };
}

const inWindows = (seq: number, windows: readonly Window[]) => windows.some((w) => seq > w.start && seq < w.end);

// ── Privacy: deltas against L* (architecture §13.3) ────────────────────────

const WRITE_KEYS_SNAPSHOTTED = [
  'confirmationEmailState', 'confirmationEmailHoldReason', 'confirmationEmailEnvelopeRef',
  'confirmationEmailFrom', 'confirmationEmailIdempotencyKey', 'updatedAt',
];
const WRITE_KEYS_HOLD = ['confirmationEmailState', 'confirmationEmailHoldReason', 'updatedAt'];

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Δ(a, b): the keys whose presence or deep value differs. */
function delta(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => own(a, key) !== own(b, key) || !isDeepStrictEqual(a[key], b[key])).sort();
}

interface ExpectedCommit {
  state: string;
  holdReason: string | null;
  nowIso: string;
  ref?: Record<string, unknown>;
  from?: string;
  idempotencyKey?: string;
}

/**
 * PV-3 / PV-9: the pure checker. `Δ(L*, post) ⊆ WRITE_KEYS(kind)`, every write
 * key holds its prescribed value, and the state changed. Returns the
 * offending keys (or prescriptions), empty when the commit is exactly the
 * producer's.
 */
function producerDeltaOffenders(
  lstar: Record<string, unknown>,
  post: Record<string, unknown>,
  kind: 'snapshotted' | 'hold',
  expected: ExpectedCommit,
): string[] {
  const writeKeys = kind === 'snapshotted' ? WRITE_KEYS_SNAPSHOTTED : WRITE_KEYS_HOLD;
  const offenders = delta(lstar, post).filter((key) => !writeKeys.includes(key));
  if (post.confirmationEmailState !== expected.state) offenders.push('prescribed:confirmationEmailState');
  if ((post.confirmationEmailHoldReason ?? null) !== expected.holdReason) offenders.push('prescribed:confirmationEmailHoldReason');
  if (post.updatedAt !== expected.nowIso) offenders.push('prescribed:updatedAt');
  if (kind === 'snapshotted') {
    if (!isDeepStrictEqual({ ...(post.confirmationEmailEnvelopeRef as object) }, { ...expected.ref })) {
      offenders.push('prescribed:confirmationEmailEnvelopeRef');
    }
    if (post.confirmationEmailFrom !== expected.from) offenders.push('prescribed:confirmationEmailFrom');
    if (post.confirmationEmailIdempotencyKey !== expected.idempotencyKey) offenders.push('prescribed:confirmationEmailIdempotencyKey');
  }
  if (!delta(lstar, post).includes('confirmationEmailState')) offenders.push('unchanged:confirmationEmailState');
  return offenders;
}

/** PV-9: a concurrent edit E that landed before the commit is carried forward. */
function concurrentEditOffenders(
  pre: Record<string, unknown>,
  lstar: Record<string, unknown>,
  post: Record<string, unknown>,
  editKeys: readonly string[],
  kind: 'snapshotted' | 'hold',
  nowIso: string,
): string[] {
  const writeKeys = kind === 'snapshotted' ? WRITE_KEYS_SNAPSHOTTED : WRITE_KEYS_HOLD;
  const offenders: string[] = [];
  const landed = delta(pre, lstar);
  for (const key of editKeys) if (key !== 'updatedAt' && !landed.includes(key)) offenders.push(`not-landed:${key}`);
  for (const key of editKeys) {
    if (writeKeys.includes(key)) continue;
    if (!isDeepStrictEqual(post[key], lstar[key])) offenders.push(`reverted:${key}`);
  }
  if (!isDeepStrictEqual(post.auditEvents, lstar.auditEvents)) offenders.push('reverted:auditEvents');
  if (post.updatedAt !== nowIso) offenders.push('prescribed:updatedAt');
  return offenders;
}

const countIn = (needle: string, haystack: string) => haystack.split(needle).length - 1;

/** PV-4: the canary-count delta between L* and post. */
function canaryDeltas(lstar: unknown, post: unknown): Record<string, number> {
  const a = JSON.stringify(lstar);
  const b = JSON.stringify(post);
  return Object.fromEntries(CANARIES.map((canary) => [canary, countIn(canary, b) - countIn(canary, a)]));
}

/** PV-1 / PV-2: a log line or an outcome carries ids and closed codes only. */
function sinkLeaks(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const leaks: string[] = [];
  for (const canary of [...CANARIES, ...URL_CANARIES]) if (text.includes(canary)) leaks.push(canary);
  if (text.includes('@')) leaks.push('@');
  if (/[a-f0-9]{64}/.test(text)) leaks.push('digest');
  if (/confirmation-envelopes\//.test(text)) leaks.push('objectPath');
  if (/vercel_blob_rw_|SYNTHETIC/.test(text)) leaks.push('token');
  if (/https?:\/\//.test(text)) leaks.push('url');
  if (/Vercel Blob:|synthetic network failure|already exists/.test(text)) leaks.push('sdk-message');
  for (const namespace of [A, B, Z]) if (text.includes(namespace)) leaks.push(`namespace:${namespace}`);
  return leaks;
}

/** The envelope request the producer must freeze, recomputed independently. */
function expectedRequest(order: OrderRecord, env = RENDER_ENV) {
  const supportEmail = env.HSB_SUPPORT_EMAIL;
  const saved = process.env.NEXT_PUBLIC_URL;
  process.env.NEXT_PUBLIC_URL = env.NEXT_PUBLIC_URL;
  try {
    const render = buildOrderConfirmationEmail(order, { supportEmail });
    return { from: env.HSB_EMAIL_FROM, to: [order.email], subject: render.subject, html: render.html, text: render.text, replyTo: supportEmail };
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_URL;
    else process.env.NEXT_PUBLIC_URL = saved;
  }
}

/** The put body every committed snapshot must carry, as an object. */
const putEnvelope = (store: ReturnType<typeof strictSyntheticStoreIo>) => {
  const put = store.calls.find((call) => call.op === 'put');
  assert.ok(put, 'a put was expected');
  return JSON.parse(put.body!) as Record<string, unknown> & { request: Record<string, unknown> };
};

const DECISION_EVENTS = new Set(['claim_acquired', 'snapshot_refused']);

// ── Frames, candidates and the decision context (pure seam inputs) ─────────

function decisionCtx(overrides: Partial<SnapshotDecisionContext> = {}): SnapshotDecisionContext {
  return Object.freeze({
    epochMs: EPOCH_MS,
    nowIso: NOW,
    evaluateClaimability: (order: OrderRecord) =>
      evaluateConfirmationEmailClaimability(order, { nowMs: NOW_MS, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS }),
    ...overrides,
  }) as SnapshotDecisionContext;
}

/** An S3 frame, frozen the way the producer freezes it, built from the real renderer. */
function frameFor(order: OrderRecord, namespace = '', createdAt = NOW): SnapshotFrame {
  const supportEmail = RENDER_ENV.HSB_SUPPORT_EMAIL;
  const saved = process.env.NEXT_PUBLIC_URL;
  process.env.NEXT_PUBLIC_URL = RENDER_ENV.NEXT_PUBLIC_URL;
  let rendered: { subject: string; html: string; text: string };
  try {
    rendered = buildOrderConfirmationEmail(order, { supportEmail });
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_URL;
    else process.env.NEXT_PUBLIC_URL = saved;
  }
  return Object.freeze({
    orderId: order.id,
    params: Object.freeze({
      createdAt,
      from: RENDER_ENV.HSB_EMAIL_FROM,
      supportEmail,
      accountLabel: CONFIRMATION_ENVELOPE_ACCOUNT_LABEL,
      templateVersion: CONFIRMATION_ENVELOPE_TEMPLATE_VERSION,
      namespace,
    }),
    render: Object.freeze({ subject: rendered.subject, html: rendered.html, text: rendered.text }),
    renderInputsKey: producer.confirmationRenderInputsKey(order),
    idempotencyKey: buildOrderConfirmationIdempotencyKey(order),
  }) as SnapshotFrame;
}

function builtFor(frame: SnapshotFrame, email: string) {
  return buildConfirmationEmailEnvelope({
    orderId: frame.orderId,
    templateVersion: frame.params.templateVersion,
    createdAt: frame.params.createdAt,
    idempotencyKey: frame.idempotencyKey,
    providerBinding: { accountLabel: frame.params.accountLabel },
    request: producer.composeConfirmationRequest(frame.render, frame.params, email),
  });
}

/** The ten-key ref a candidate must carry, as plain data. */
function refFor(envelope: { orderId: string; templateVersion: string; createdAt: string; canonicalDigest: string; canonicalBytes: number; providerBinding: { accountLabel: string } }, namespace: string) {
  return {
    envelopeVersion: 1,
    orderId: envelope.orderId,
    templateVersion: envelope.templateVersion,
    createdAt: envelope.createdAt,
    canonicalDigest: envelope.canonicalDigest,
    canonicalBytes: envelope.canonicalBytes,
    accountLabel: envelope.providerBinding.accountLabel,
    storageKind: 'private_blob',
    objectPath: confirmationEnvelopeObjectPath(envelope.orderId, namespace),
    purgedAt: null,
  };
}

/** A real candidate through the producer's own pure seam. */
function candidateFor(order: OrderRecord, namespace = '', createdAt = NOW): SnapshotCandidate {
  const frame = frameFor(order, namespace, createdAt);
  const built = builtFor(frame, order.email);
  assert.equal(built.ok, true);
  const refResult = { ok: true as const, ref: Object.freeze(Object.assign(Object.create(null), refFor((built as unknown as { envelope: never }).envelope, namespace))) };
  const result = producer.classifySnapshotFreeze(frame, built, refResult as never);
  assert.ok(result && 'serialized' in result, 'expected a candidate');
  return result as SnapshotCandidate;
}

const ALL_REFUSALS = [
  'missing_order_id', 'missing_template_version', 'missing_idempotency_key', 'missing_account_label',
  'invalid_created_at', 'recipient_count', 'from_too_long', 'to_too_long', 'reply_to_too_long',
  'subject_too_long', 'html_too_long', 'text_too_long', 'canonical_too_large',
] as const;

const REF_PROBLEMS = [
  'ref_not_object', 'ref_not_plain_data', 'ref_request_like_field', 'ref_key_set', 'ref_envelope_version',
  'ref_order_id', 'ref_order_id_mismatch', 'ref_template_version', 'ref_created_at', 'ref_canonical_digest',
  'ref_canonical_bytes', 'ref_account_label', 'ref_storage_kind', 'ref_object_path', 'ref_purged_at',
] as const;

/** DF-4: the partition pin. A new refusal member fails `tsc` until classified. */
const REFUSAL_PARTITION = {
  missing_order_id: 'defensive',
  missing_template_version: 'defensive',
  missing_idempotency_key: 'defensive',
  missing_account_label: 'defensive',
  invalid_created_at: 'defensive',
  recipient_count: 'defensive',
  from_too_long: 'reachable',
  to_too_long: 'reachable',
  reply_to_too_long: 'reachable',
  subject_too_long: 'reachable',
  html_too_long: 'reachable',
  text_too_long: 'reachable',
  canonical_too_large: 'reachable',
} as const satisfies Record<ConfirmationEnvelopeRefusalReason, 'reachable' | 'defensive'>;

function deepFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every((member) => deepFrozen(member, seen));
}

// ══ [defensive seam] — pure producer seams; NOT integration coverage ═══════

describe('defensive refusal handling (synthetic seam; not integration)', () => {
  test('[defensive seam] DF-1: every build refusal becomes envelope_build_refused evidence, frozen, request-free', () => {
    const order = paidOrder();
    const frame = frameFor(order);
    for (const refusal of ALL_REFUSALS) {
      const evidence = producer.classifySnapshotFreeze(frame, { ok: false, refusal }, null) as SnapshotEvidence;
      assert.equal(evidence.kind, 'envelope_build_refused', refusal);
      assert.equal((evidence as { refusal: string }).refusal, refusal);
      assert.deepEqual((evidence as { params: unknown }).params, frame.params);
      assert.equal((evidence as { renderInputsKey: string }).renderInputsKey, frame.renderInputsKey);
      assert.ok(deepFrozen(evidence), `${refusal} evidence must be deep-frozen`);
      for (const key of ['request', 'subject', 'html', 'text', 'to', 'replyTo', 'render', 'serialized']) {
        assert.ok(!(key in (evidence as object)), `${refusal} evidence carries ${key}`);
      }
    }
  });

  test('[defensive seam] DF-2: decideSnapshotCommit holds every build refusal as T13, or defers on drift', () => {
    const order = paidOrder();
    const frame = frameFor(order);
    for (const refusal of ALL_REFUSALS) {
      const evidence = producer.classifySnapshotFreeze(frame, { ok: false, refusal }, null) as SnapshotEvidence;
      const decision = producer.decideSnapshotCommit(order, evidence, decisionCtx());
      assert.ok('commit' in decision, `${refusal}: expected a commit`);
      assert.deepEqual(decision.result, { status: 'held', reason: 'snapshot_refused', cause: 'envelope_build_refused' });
      const model = evaluateConfirmationEmailTransition({ from: null, event: 'snapshot_refused', actor: 'worker' });
      assert.equal(model.allowed, true);
      assert.deepEqual(
        producerDeltaOffenders(order as never, decision.commit as never, 'hold', {
          state: (model as { to: string }).to, holdReason: (model as { holdReason: string }).holdReason, nowIso: NOW,
        }),
        [],
        refusal,
      );
      const drifted = producer.decideSnapshotCommit({ ...order, childName: 'Somebody Else' }, evidence, decisionCtx());
      assert.deepEqual(drifted, { abort: { status: 'snapshot_deferred', reason: 'candidate_drift' } }, `${refusal} drift`);
    }
  });

  test('[defensive seam] DF-3: every ref problem becomes ref_invalid evidence and a T13 hold', () => {
    const order = paidOrder();
    const frame = frameFor(order);
    const built = builtFor(frame, order.email);
    assert.equal(built.ok, true);
    for (const problem of REF_PROBLEMS) {
      const evidence = producer.classifySnapshotFreeze(frame, built, { ok: false, problem }) as SnapshotEvidence;
      assert.equal(evidence.kind, 'ref_invalid', problem);
      assert.equal((evidence as { refusal: string }).refusal, problem);
      assert.ok(deepFrozen(evidence));
      const decision = producer.decideSnapshotCommit(order, evidence, decisionCtx());
      assert.ok('commit' in decision);
      assert.deepEqual(decision.result, { status: 'held', reason: 'snapshot_refused', cause: 'ref_invalid' });
    }
  });

  test('[defensive seam] DF-4: the refusal partition is exactly 7 reachable and 6 defensive', () => {
    const reachable = Object.entries(REFUSAL_PARTITION).filter(([, cls]) => cls === 'reachable').map(([key]) => key);
    const defensive = Object.entries(REFUSAL_PARTITION).filter(([, cls]) => cls === 'defensive').map(([key]) => key);
    assert.deepEqual(reachable.sort(), [
      'canonical_too_large', 'from_too_long', 'html_too_long', 'reply_to_too_long', 'subject_too_long', 'text_too_long', 'to_too_long',
    ]);
    assert.deepEqual(defensive.sort(), [
      'invalid_created_at', 'missing_account_label', 'missing_idempotency_key', 'missing_order_id', 'missing_template_version', 'recipient_count',
    ]);
    assert.equal(Object.keys(REFUSAL_PARTITION).length, ALL_REFUSALS.length);
  });

  test('[defensive seam] DF-5: the six defensive refusals are unreachable through the real path', () => {
    assert.equal(CONFIRMATION_ENVELOPE_ORDER_ID_RE.test(''), false);
    for (const value of [CONFIRMATION_ENVELOPE_ACCOUNT_LABEL, CONFIRMATION_ENVELOPE_TEMPLATE_VERSION]) {
      assert.match(value, /^[a-z0-9][a-z0-9.-]{0,63}$/);
      assert.ok(value.trim().length > 0);
    }
    assert.ok(buildOrderConfirmationIdempotencyKey(paidOrder()).trim().length > 0);
    const canonical = (value: string) => Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
    for (const n of [0, 1, NOW_MS, -1, 8.64e15, -8.64e15, 1e12 + 7]) {
      assert.equal(canonical(new Date(n).toISOString()), true, `n=${n}`);
    }
    assert.throws(() => new Date(Number.NaN).toISOString(), RangeError);
    for (const email of [CANARY_TO, '', 'x@example.invalid']) {
      const frame = frameFor(paidOrder());
      assert.equal(producer.composeConfirmationRequest(frame.render, frame.params, email).to.length, 1);
    }
  });

  test('[defensive seam] NS-10: a write result naming another path or size is store_path_mismatch', () => {
    const candidate = candidateFor(paidOrder(), A);
    const elsewhere = confirmationEnvelopeObjectPath(ORDER_ID, B)!;
    for (const value of [
      { objectPath: elsewhere, storedBytes: candidate.byteLength },
      { objectPath: candidate.objectPath, storedBytes: candidate.byteLength + 1 },
    ]) {
      assert.deepEqual(producer.classifySnapshotWrite(candidate, { ok: true, value }), { ok: false, deferral: 'store_path_mismatch' });
    }
    const accepted = producer.classifySnapshotWrite(candidate, { ok: true, value: { objectPath: candidate.objectPath, storedBytes: candidate.byteLength } });
    assert.equal(accepted.ok, true);
    assert.equal((accepted as { evidence: SnapshotEvidence }).evidence.kind, 'object_written');
  });

  test('[defensive seam] NS-11: a verify result naming another path or size is store_path_mismatch', () => {
    const candidate = candidateFor(paidOrder(), A);
    const elsewhere = confirmationEnvelopeObjectPath(ORDER_ID, B)!;
    for (const value of [
      { objectPath: elsewhere, storedBytes: candidate.byteLength },
      { objectPath: candidate.objectPath, storedBytes: candidate.byteLength + 1 },
    ]) {
      assert.deepEqual(producer.classifySnapshotVerify(candidate, { ok: true, value }), { ok: false, deferral: 'store_path_mismatch' });
    }
    const accepted = producer.classifySnapshotVerify(candidate, { ok: true, value: { objectPath: candidate.objectPath, storedBytes: candidate.byteLength } });
    assert.equal((accepted as { evidence: SnapshotEvidence }).evidence.kind, 'object_verified_equal');
  });

  test('[defensive seam] ND-13 (pure): verifyOrderProvenance refuses every mismatching provenance', () => {
    const recordPath = recordPathIn(A);
    const good = { namespace: A, recordPath, readPaths: [recordPath], commitPaths: [recordPath], attempts: 1, outcome: 'committed' };
    const expected = { namespace: A, recordPath, operation: 'transaction' as const };
    assert.doesNotThrow(() => producer.verifyOrderProvenance(good, 'committed', expected));
    for (const [label, p, outcome] of [
      ['namespace Z', { ...good, namespace: Z }, 'committed'],
      ['another record path', { ...good, recordPath: recordPathIn(Z) }, 'committed'],
      ['a differing read path', { ...good, readPaths: [recordPathIn(Z)] }, 'committed'],
      ['a differing commit path', { ...good, commitPaths: [recordPathIn(Z)] }, 'committed'],
      ['attempts that disagree with the reads', { ...good, attempts: 2 }, 'committed'],
      ['no reads', { ...good, readPaths: [], attempts: 0 }, 'committed'],
      ['an outcome that contradicts the status', good, 'aborted'],
      ['not an object', null, 'committed'],
    ] as Array<[string, unknown, string]>) {
      assert.throws(
        () => producer.verifyOrderProvenance(p, outcome as never, expected),
        (error: unknown) => error instanceof producer.ConfirmationOrderNamespaceError && error.reason === 'transaction_provenance_mismatch',
        label,
      );
    }
    const read = { namespace: A, recordPath, readPaths: [recordPath], commitPaths: [], attempts: 1, outcome: 'read' };
    const readExpected = { namespace: A, recordPath, operation: 'read' as const };
    assert.doesNotThrow(() => producer.verifyOrderProvenance(read, 'read', readExpected));
    assert.throws(() => producer.verifyOrderProvenance({ ...read, commitPaths: [recordPath] }, 'read', readExpected));
    assert.throws(() => producer.verifyOrderProvenance({ ...read, readPaths: [recordPath, recordPath], attempts: 2 }, 'read', readExpected));
  });

  test('[defensive seam] ND-15 (a): found null with outcome read is a contradictory pair', () => {
    const recordPath = recordPathIn(A);
    const expected = { namespace: A, recordPath, operation: 'read' as const };
    const p = (outcome: string) => ({ namespace: A, recordPath, readPaths: [recordPath], commitPaths: [], attempts: 1, outcome });
    // The expected outcome is derived from `found: null`, i.e. 'not_found'.
    assert.throws(
      () => producer.verifyOrderProvenance(p('read'), 'not_found', expected),
      (error: unknown) => error instanceof producer.ConfirmationOrderNamespaceError && error.reason === 'transaction_provenance_mismatch',
    );
    assert.doesNotThrow(() => producer.verifyOrderProvenance(p('not_found'), 'not_found', expected), 'control: a consistent missing order');
  });

  test('[defensive seam] ND-16 (a): a found record with outcome not_found is a contradictory pair', () => {
    const recordPath = recordPathIn(A);
    const expected = { namespace: A, recordPath, operation: 'read' as const };
    const p = (outcome: string) => ({ namespace: A, recordPath, readPaths: [recordPath], commitPaths: [], attempts: 1, outcome });
    assert.throws(
      () => producer.verifyOrderProvenance(p('not_found'), 'read', expected),
      (error: unknown) => error instanceof producer.ConfirmationOrderNamespaceError && error.reason === 'transaction_provenance_mismatch',
    );
    assert.doesNotThrow(() => producer.verifyOrderProvenance(p('read'), 'read', expected), 'control: a consistent found record');
  });
});

// ── PX: the privacy checker's own self-tests (pure) ────────────────────────

test('PX-1: unchanged no-op write keys are not offenders', () => {
  const lstar = { id: ORDER_ID, confirmationEmailHoldReason: null, updatedAt: NOW, childName: CANARY_SUBJ } as Record<string, unknown>;
  const ref = { a: 1 };
  const post = { ...lstar, confirmationEmailState: 'SNAPSHOTTED', confirmationEmailEnvelopeRef: ref, confirmationEmailFrom: 'f', confirmationEmailIdempotencyKey: 'k' };
  assert.deepEqual(producerDeltaOffenders(lstar, post, 'snapshotted', { state: 'SNAPSHOTTED', holdReason: null, nowIso: NOW, ref, from: 'f', idempotencyKey: 'k' }), []);
});

test('PX-2: a changed childName is an offender', () => {
  const lstar = { id: ORDER_ID, confirmationEmailHoldReason: null, updatedAt: NOW, childName: CANARY_SUBJ } as Record<string, unknown>;
  const ref = { a: 1 };
  const post = { ...lstar, childName: 'Other', confirmationEmailState: 'SNAPSHOTTED', confirmationEmailEnvelopeRef: ref, confirmationEmailFrom: 'f', confirmationEmailIdempotencyKey: 'k' };
  assert.deepEqual(producerDeltaOffenders(lstar, post, 'snapshotted', { state: 'SNAPSHOTTED', holdReason: null, nowIso: NOW, ref, from: 'f', idempotencyKey: 'k' }), ['childName']);
});

test('PX-3: a reverted concurrent audit event is an offender', () => {
  const pre = { id: ORDER_ID, auditEvents: [], updatedAt: 'x' } as Record<string, unknown>;
  const lstar = { ...pre, auditEvents: [{ at: NOW, type: 'note' }] };
  const post = { ...pre, confirmationEmailState: 'RECONCILIATION_REQUIRED', confirmationEmailHoldReason: 'snapshot_refused', updatedAt: NOW };
  assert.ok(producerDeltaOffenders(lstar, post, 'hold', { state: 'RECONCILIATION_REQUIRED', holdReason: 'snapshot_refused', nowIso: NOW }).includes('auditEvents'));
  assert.ok(concurrentEditOffenders(pre, lstar, post, ['auditEvents'], 'hold', NOW).includes('reverted:auditEvents'));
});

test('PX-4: the withdrawn pre baseline would report a concurrent edit as a producer change', () => {
  const pre = paidOrder() as unknown as Record<string, unknown>;
  const lstar = appendAuditEventTo(applyFulfillmentPatchTo(pre as never, { fulfillmentStatus: 'generating' } as never, NOW), { type: 'note' } as never, NOW) as unknown as Record<string, unknown>;
  const ref = { a: 1 };
  const post = { ...lstar, confirmationEmailState: 'SNAPSHOTTED', confirmationEmailHoldReason: null, confirmationEmailEnvelopeRef: ref, confirmationEmailFrom: 'f', confirmationEmailIdempotencyKey: 'k', updatedAt: NOW };
  const expected = { state: 'SNAPSHOTTED', holdReason: null, nowIso: NOW, ref, from: 'f', idempotencyKey: 'k' };
  const againstPre = producerDeltaOffenders(pre, post, 'snapshotted', expected);
  assert.ok(againstPre.includes('fulfillmentStatus') && againstPre.includes('auditEvents'), JSON.stringify(againstPre));
  assert.deepEqual(producerDeltaOffenders(lstar, post, 'snapshotted', expected), []);
});

test('PX-5: an added request-shaped record key is an offender', () => {
  const lstar = { id: ORDER_ID, confirmationEmailHoldReason: null, updatedAt: NOW } as Record<string, unknown>;
  const ref = { a: 1 };
  const post = { ...lstar, confirmationEmailSubject: 'x', confirmationEmailState: 'SNAPSHOTTED', confirmationEmailEnvelopeRef: ref, confirmationEmailFrom: 'f', confirmationEmailIdempotencyKey: 'k' };
  assert.deepEqual(producerDeltaOffenders(lstar, post, 'snapshotted', { state: 'SNAPSHOTTED', holdReason: null, nowIso: NOW, ref, from: 'f', idempotencyKey: 'k' }), ['confirmationEmailSubject']);
});

// ── Enrollment (§4.3) — the pure predicate ─────────────────────────────────

test('EN (pure): enrollment is positive only — grammar id, no state, no ref, canonical paidAt at or after the epoch', () => {
  const enrolled = (overrides: Partial<OrderRecord>, id = ORDER_ID) =>
    producer.isConfirmationEnvelopeEnrolled(paidOrder(overrides, id), EPOCH_MS);
  assert.equal(enrolled({ paidAt: EPOCH }), true, 'paidAt = epoch');
  assert.equal(enrolled({ paidAt: new Date(EPOCH_MS + 1).toISOString() }), true);
  assert.equal(enrolled({ paidAt: new Date(EPOCH_MS - 1).toISOString() }), false, 'EN-1');
  assert.equal(enrolled({ paidAt: '2026-10-15T12:00:00' }), false, 'EN-4 zone-less');
  assert.equal(enrolled({ paidAt: '2026-10-15T08:00:00' }), false, 'EN-5 zone-less, cross-TZ');
  for (const paidAt of ['2026-09-31T00:00:00.000Z', '', undefined, null]) {
    assert.equal(enrolled({ paidAt } as Partial<OrderRecord>), false, `EN-6 ${String(paidAt)}`);
  }
  assert.equal(producer.isConfirmationEnvelopeEnrolled(paidOrder({}, 'ord_incident'), EPOCH_MS), false, 'EN-7');
  for (const state of ['', 'nonsense', 'SNAPSHOTTED', 'PROVABLY_PRE_DISPATCH_FAILED']) {
    assert.equal(enrolled({ confirmationEmailState: state } as Partial<OrderRecord>), false, `EN-8 ${state}`);
  }
  assert.equal(enrolled({ confirmationEmailEnvelopeRef: { stray: true } } as unknown as Partial<OrderRecord>), false, 'EN-9');
  assert.equal(enrolled({ confirmationEmailState: null, confirmationEmailEnvelopeRef: null } as Partial<OrderRecord>), true);
});

// ── RI: environment-free CAS revalidation — the renderer pins (§5.7) ────────

function functionBody(sourceFile: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.body;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const parse = (relative: string) => ts.createSourceFile(relative, readRepo(relative), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

test('RI-1: the renderer reads exactly id, childName, formatLabel, bookFormat and deliveryExpectation from the record', () => {
  const body = functionBody(parse('src/lib/order-email.ts'), 'buildOrderConfirmationEmail');
  assert.ok(body, 'buildOrderConfirmationEmail must exist');
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === 'order') {
      const parent = node.parent;
      assert.ok(ts.isPropertyAccessExpression(parent) && parent.expression === node, `bare use of order at ${node.getStart()}`);
      names.add(parent.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  assert.deepEqual([...names].sort(), ['bookFormat', 'childName', 'deliveryExpectation', 'formatLabel', 'id']);
  assert.deepEqual([...producer.CONFIRMATION_RENDER_INPUT_KEYS], ['id', 'email', 'childName', 'formatLabel', 'bookFormat', 'deliveryExpectation']);
});

test('RI-2: the renderer reads NEXT_PUBLIC_URL and the support-address fallback, and its helpers read nothing', () => {
  const sourceFile = parse('src/lib/order-email.ts');
  const body = functionBody(sourceFile, 'buildOrderConfirmationEmail')!;
  const envReads = new Set<string>();
  const calls: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText() === 'process.env') envReads.add(node.name.text);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'getSupportEmail') {
      const parent = node.parent;
      assert.ok(
        ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
          && parent.right === node && parent.left.getText() === 'options.supportEmail',
        'getSupportEmail() may appear only as the right operand of options.supportEmail ||',
      );
      calls.push('getSupportEmail');
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  assert.deepEqual([...envReads], ['NEXT_PUBLIC_URL']);
  assert.deepEqual(calls, ['getSupportEmail']);
  const forbidden = /process\.env|\bDate\b|Math\.random/;
  for (const [file, fn] of [
    ['src/lib/orders.ts', 'renderDeliveryExpectation'],
    ['src/lib/orders.ts', 'buildDeliveryExpectation'],
    ['src/lib/orders.ts', 'normalizeFormat'],
    ['src/lib/order-email.ts', 'escapeHtml'],
  ] as const) {
    const fnBody = functionBody(parse(file), fn);
    assert.ok(fnBody, `${fn} must exist`);
    assert.doesNotMatch(fnBody.getText(), forbidden, `${fn} must not read the environment, a clock or randomness`);
  }
  assert.doesNotMatch(readRepo('src/lib/proof-turnaround.ts'), forbidden);
});

test('RI-3: the render-input key captures exactly what the renderer reads, and nothing else changes a render', () => {
  const base = paidOrder({ deliveryExpectation: 'Ships in two weeks' } as Partial<OrderRecord>);
  const renderOf = (order: OrderRecord) => JSON.stringify(buildOrderConfirmationEmail(order, { supportEmail: CANARY_REPLY }));
  const keyOf = (order: OrderRecord) => producer.confirmationRenderInputsKey(order);
  const baseRender = renderOf(base);
  const baseKey = keyOf(base);
  const inputKeys = new Set<string>(producer.CONFIRMATION_RENDER_INPUT_KEYS);
  for (const key of Object.keys(base)) {
    if (inputKeys.has(key)) continue;
    const changed = { ...base, [key]: `changed-${key}` } as OrderRecord;
    assert.equal(renderOf(changed), baseRender, `${key} must not change the render`);
    assert.equal(keyOf(changed), baseKey, `${key} must not change the key`);
  }
  const perturbations: Array<[string, unknown, boolean]> = [
    ['childName', 'Another Child', true],
    ['formatLabel', 'Another Label', true],
    ['id', idOf('d2'), true],
    ['bookFormat', 'classic', true],
    ['deliveryExpectation', 'Ships in three weeks', true],
    ['email', 'other@example.invalid', false],
  ];
  for (const [key, value, rendersDifferently] of perturbations) {
    const changed = { ...base, [key]: value } as OrderRecord;
    assert.notEqual(keyOf(changed), baseKey, `${key} must change the key`);
    if (rendersDifferently) assert.notEqual(renderOf(changed), baseRender, `${key} must change the render`);
    assert.notEqual(keyOf({ ...base, [key]: undefined } as OrderRecord), keyOf({ ...base, [key]: null } as unknown as OrderRecord), `${key}: undefined vs null`);
  }
  // classic and premium render identically: a key change that can only defer.
  const classic = { ...base, bookFormat: 'classic' } as OrderRecord;
  const premium = { ...base, bookFormat: 'premium' } as OrderRecord;
  assert.equal(renderOf(classic), renderOf(premium));
  assert.notEqual(keyOf(classic), keyOf(premium));
});

// ── CF-11 / CF-12: the fixed fixture's request (golden) and its headroom ───

const FIXED_ORDER = () => paidOrder({ childName: 'Ada', formatLabel: 'Digital Storybook', email: 'buyer@example.invalid' } as Partial<OrderRecord>);
const FIXED_RENDER_ENV = {
  HSB_EMAIL_FROM: 'Hero Story Books <no-reply@example.invalid>',
  HSB_SUPPORT_EMAIL: 'support@example.invalid',
  NEXT_PUBLIC_URL: 'https://shop.example.invalid',
};
/** Pinned: a template change must bump CONFIRMATION_ENVELOPE_TEMPLATE_VERSION. */
const FIXED_REQUEST_DIGEST = '5f9a49de4ac699d61f39baa39d99af8c9910bdd42558b6f397a34cc9da64578d';

test('CF-11: the canonical request for the fixed fixture has the pinned digest', () => {
  const request = expectedRequest(FIXED_ORDER(), FIXED_RENDER_ENV);
  const frame = { render: { subject: request.subject, html: request.html, text: request.text }, params: { from: request.from, supportEmail: request.replyTo } };
  const composed = producer.composeConfirmationRequest(frame.render as never, frame.params as never, request.to[0]);
  assert.deepEqual(composed, request);
  assert.equal(digestConfirmationRequest(composed), FIXED_REQUEST_DIGEST);
});

test('CF-12 / HO-8: the fixed fixture renders within a quarter of every ceiling, so no global build refusal', () => {
  const request = expectedRequest(FIXED_ORDER(), FIXED_RENDER_ENV);
  assert.ok(Buffer.byteLength(request.subject) <= CONFIRMATION_ENVELOPE_LIMITS.subjectBytes / 4);
  assert.ok(Buffer.byteLength(request.html) <= CONFIRMATION_ENVELOPE_LIMITS.htmlBytes / 4);
  assert.ok(Buffer.byteLength(request.text) <= CONFIRMATION_ENVELOPE_LIMITS.textBytes / 4);
  assert.equal(checkConfirmationEnvelopeLimits(request as never), null);
});

test('S3 size bound: the producer restates the private-object ceiling exactly', () => {
  assert.equal(producer.SNAPSHOT_OBJECT_MAX_BYTES, CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES);
});

// ══ Integration harness: delivery → producer, in-memory bound order I/O ════

interface ArmedOptions {
  order?: OrderRecord | null;
  seed?: OrderRecord[];
  namespace?: string;
  ambient?: AmbientValues;
  store?: StoreScript;
  mem?: MemScript;
  transport?: 'throwing' | 'recording';
  env?: NodeJS.ProcessEnv;
  now?: number;
  storeIo?: unknown;
  /** A pre-built in-memory order I/O (rows whose hooks need its handle). */
  memIo?: ReturnType<typeof memOrderIo>;
  /** A pre-built store seam (rows whose hooks need its handle). */
  storeHandle?: ReturnType<typeof strictSyntheticStoreIo>;
}

/** Build the in-memory order I/O first, so its hooks can reach its handle. */
function memWithHandle(seed: OrderRecord[], build: (handle: () => ReturnType<typeof memOrderIo>) => MemScript) {
  let handle: ReturnType<typeof memOrderIo> | null = null;
  const mem = memOrderIo(seed, build(() => handle!));
  handle = mem;
  return mem;
}

async function armed(opts: ArmedOptions = {}) {
  const namespace = opts.namespace ?? '';
  const order = opts.order === undefined ? paidOrder() : opts.order;
  const seed = opts.seed ?? (order ? [order] : []);
  const mem = opts.memIo ?? memOrderIo(seed, opts.mem);
  if (!opts.memIo || namespace) mem.reseed(namespace);
  const store = opts.storeHandle ?? strictSyntheticStoreIo(opts.store ?? { put: ['store'] });
  const transport = opts.transport === 'recording' ? recordingTransport() : throwingTransport();
  const run = await withAmbient({ HSB_BLOB_NAMESPACE: namespace || undefined, ...opts.ambient }, () => deliverArmed({
    env: opts.env ?? writerEnv(namespace || undefined),
    storeIo: opts.storeIo ?? store.io,
    orderIo: mem.io,
    send: transport.send,
    now: opts.now,
  }));
  return { ...run, store, mem, transport, pre: order, post: mem.record(ORDER_ID, namespace) };
}

/** The writer-off golden: the legacy path over in-memory ambient seams. */
async function writerOffGolden(order: OrderRecord, now = NOW_MS) {
  const cells = new Map<string, string>([[order.id, JSON.stringify(order)]]);
  const transport = recordingTransport();
  const logs: string[] = [];
  const errors: string[] = [];
  const outcome = await withAmbient({}, () => inDelivery(() => deliverOrderConfirmationEmail(order.id, {
    send: transport.send,
    now: () => now,
    newClaimId: () => 'claim-synthetic',
    log: (line) => { logs.push(line); },
    errorLog: (line) => { errors.push(line); },
    getOrder: async (id) => (cells.has(id) ? JSON.parse(cells.get(id)!) as OrderRecord : null),
    transact: (async (id: string, mutate: (o: OrderRecord) => { abort?: unknown; commit?: OrderRecord; result?: unknown }, cfg: { notFound: () => unknown }) => {
      if (!cells.has(id)) return cfg.notFound();
      const decided = mutate(JSON.parse(cells.get(id)!) as OrderRecord);
      if ('abort' in decided) return decided.abort;
      cells.set(id, JSON.stringify(decided.commit));
      return decided.result;
    }) as DeliverOrderConfirmationEmailDeps['transact'],
  })));
  return { outcome, calls: transport.calls(), logs, errors, post: JSON.parse(cells.get(order.id)!) as OrderRecord };
}

/** Bound continuation parity: outcome, transport calls and record equal the golden. */
async function assertLegacyParity(r: Awaited<ReturnType<typeof armed>>, order: OrderRecord, label: string) {
  const golden = await writerOffGolden(order);
  assert.deepEqual(r.outcome, golden.outcome, `${label}: outcome`);
  assert.equal(r.transport.calls(), golden.calls, `${label}: transport calls`);
  assert.deepEqual(r.post, golden.post, `${label}: record deltas`);
  assert.equal(r.store.calls.length, 0, `${label}: store calls`);
  assert.equal(r.ambient.getOrderCalls() + r.ambient.transactCalls(), 0, `${label}: ambient seams under armed intent`);
}

function assertSnapshotted(r: Awaited<ReturnType<typeof armed>>, via: string, label = '') {
  assert.deepEqual(r.outcome, { status: 'snapshotted', via }, label);
  assert.equal(r.transport.calls(), 0, `${label}: transport`);
  assert.equal(r.store.count('del'), 0, `${label}: del`);
}

function assertHeld(r: Awaited<ReturnType<typeof armed>>, reason: string, cause: string, label = '') {
  assert.deepEqual(r.outcome, { status: 'held', reason }, label);
  assert.ok(r.errors.includes(`[confirmation-envelope] held orderId=${ORDER_ID} reason=${reason} cause=${cause}`), `${label}: ${JSON.stringify(r.errors)}`);
  assert.equal(r.transport.calls(), 0, `${label}: transport`);
  assert.equal(r.store.count('del'), 0, `${label}: del`);
}

function assertDeferred(r: { outcome: unknown; errors: string[] }, reason: string, label = '') {
  assert.deepEqual(r.outcome, { status: 'snapshot_deferred', reason }, label);
  assert.ok(r.errors.includes(`[confirmation-envelope] deferred orderId=${ORDER_ID} reason=${reason}`), `${label}: ${JSON.stringify(r.errors)}`);
}

/** PV-3 + PV-4 + PV-5 for a SNAPSHOTTED commit, against L*. */
function assertSnapshotCommitPrivacy(r: Awaited<ReturnType<typeof armed>>, label = '') {
  const lstar = r.mem.lstar();
  assert.ok(lstar && r.post, `${label}: a commit landed`);
  const envelope = putEnvelope(r.store);
  const ref = r.post!.confirmationEmailEnvelopeRef as unknown as Record<string, unknown>;
  assert.deepEqual(
    producerDeltaOffenders(lstar as never, r.post as never, 'snapshotted', {
      state: 'SNAPSHOTTED', holdReason: null, nowIso: NOW, ref: refFor(envelope as never, ref.objectPath === confirmationEnvelopeObjectPath(ORDER_ID, '') ? '' : String(ref.objectPath).split('/')[0]),
      from: (envelope.request as { from: string }).from, idempotencyKey: String(envelope.idempotencyKey),
    }),
    [],
    `${label}: PV-3`,
  );
  const deltas = canaryDeltas(lstar, r.post);
  assert.deepEqual(deltas, { ...Object.fromEntries(CANARIES.map((c) => [c, 0])), [CANARY_FROM]: 1 }, `${label}: PV-4`);
  assert.deepEqual(Object.keys(ref).sort(), [
    'accountLabel', 'canonicalBytes', 'canonicalDigest', 'createdAt', 'envelopeVersion', 'objectPath', 'orderId', 'purgedAt', 'storageKind', 'templateVersion',
  ], `${label}: PV-5 key set`);
  assert.equal(sinkLeaks(ref).filter((leak) => !leak.startsWith('digest') && leak !== 'objectPath' && !leak.startsWith('namespace:')).length, 0, `${label}: PV-5 canaries`);
  assert.ok(!JSON.stringify(ref).includes('@'), `${label}: PV-5 @`);
}

/** PV-3 + PV-4 for a hold commit, against L*. */
function assertHoldCommitPrivacy(r: { mem: ReturnType<typeof memOrderIo>; post: OrderRecord | null }, holdReason: string, label = '') {
  const lstar = r.mem.lstar();
  assert.ok(lstar && r.post, `${label}: a hold landed`);
  assert.deepEqual(
    producerDeltaOffenders(lstar as never, r.post as never, 'hold', { state: 'RECONCILIATION_REQUIRED', holdReason, nowIso: NOW }),
    [],
    `${label}: PV-3 hold`,
  );
  for (const key of ['confirmationEmailEnvelopeRef', 'confirmationEmailFrom', 'confirmationEmailIdempotencyKey', 'emailResendClaimId', 'emailResendClaimKind', 'emailResendClaimAt', 'emailResendClaimArtifact']) {
    assert.deepEqual((r.post as never)[key], (lstar as never)[key], `${label}: hold wrote ${key}`);
  }
  assert.deepEqual(canaryDeltas(lstar, r.post), Object.fromEntries(CANARIES.map((c) => [c, 0])), `${label}: PV-4 hold`);
}

/** PV-1 / PV-2 on everything a run emitted. */
function assertSinksClean(r: { outcome: unknown; logs: string[]; errors: string[] }, label = '') {
  for (const line of [...r.logs, ...r.errors]) assert.deepEqual(sinkLeaks(line), [], `${label}: PV-1 ${line}`);
  assert.deepEqual(sinkLeaks(r.outcome), [], `${label}: PV-2`);
}

const enrolledOrder = (overrides: Partial<OrderRecord> = {}) => paidOrder(overrides);

// ══ §D — Enrollment and cutover (integration) ══════════════════════════════

test('EN-1: an order paid one ms before the epoch is not enrolled and takes the bound legacy path', async () => {
  const order = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  const r = await armed({ order, transport: 'recording' });
  assert.deepEqual(r.outcome, { status: 'sent' });
  await assertLegacyParity(r, order, 'EN-1');
});

test('EN-2 / EN-3: an order paid at or after the epoch is enrolled and snapshotted, with no send', async () => {
  for (const paidAt of [EPOCH, new Date(EPOCH_MS + 1).toISOString()]) {
    const r = await armed({ order: paidOrder({ paidAt }) });
    assertSnapshotted(r, 'committed', paidAt);
    assert.equal(r.store.count('put'), 1);
  }
});

test('EN-4 / EN-5 / EN-6 / EN-7 / EN-8: unenrollable records take the bound legacy path, equal to the golden', async () => {
  const cases: Array<[string, OrderRecord]> = [
    ['EN-4 zone-less epoch', paidOrder({ paidAt: '2026-10-15T12:00:00' })],
    ['EN-5 zone-less, cross-TZ', paidOrder({ paidAt: '2026-10-15T08:00:00' })],
    ['EN-6 impossible', paidOrder({ paidAt: '2026-09-31T00:00:00.000Z' })],
    ['EN-6 empty', paidOrder({ paidAt: '' })],
    ['EN-6 absent', paidOrder({ paidAt: undefined } as Partial<OrderRecord>)],
    ['EN-8 empty state', paidOrder({ confirmationEmailState: '' } as unknown as Partial<OrderRecord>)],
    ['EN-8 nonsense state', paidOrder({ confirmationEmailState: 'nonsense' } as unknown as Partial<OrderRecord>)],
  ];
  for (const [label, order] of cases) {
    const r = await armed({ order, transport: 'recording' });
    assert.deepEqual(r.outcome, { status: 'sent' }, label);
    await assertLegacyParity(r, order, label);
  }
});

test('EN-7: a non-grammar order id is not enrolled and takes the bound legacy path', async () => {
  const order = paidOrder({}, 'ord_incident');
  const mem = memOrderIo([order]);
  const store = strictSyntheticStoreIo();
  const transport = recordingTransport();
  const ambient = forbiddenAmbientSeams();
  const outcome = await withAmbient({}, () => deliverOrderConfirmationEmail('ord_incident', {
    send: transport.send, now: () => NOW_MS, newClaimId: () => 'claim-synthetic', log: () => {}, errorLog: () => {},
    getOrder: ambient.getOrder, transact: ambient.transact,
    envelopeWriter: { env: writerEnv(), storeIo: store.io, orderIo: mem.io },
  } as DeliverOrderConfirmationEmailDeps));
  assert.deepEqual(outcome, { status: 'sent' });
  assert.equal(transport.calls(), 1);
  assert.equal(store.calls.length, 0);
  const golden = await writerOffGolden(order);
  assert.deepEqual(mem.record('ord_incident'), golden.post);
});

test('EN-9: a stateless record with a stray ref is not enrolled and takes the bound legacy path', async () => {
  const stray = refFor({ orderId: ORDER_ID, templateVersion: 'x', createdAt: NOW, canonicalDigest: 'a'.repeat(64), canonicalBytes: 10, providerBinding: { accountLabel: 'y' } }, '');
  const order = paidOrder({ confirmationEmailEnvelopeRef: stray } as unknown as Partial<OrderRecord>);
  const r = await armed({ order, transport: 'recording' });
  assert.deepEqual(r.outcome, { status: 'sent' });
  await assertLegacyParity(r, order, 'EN-9');
});

test('EN-10 / EN-11 / EN-12: an enrolled record carrying legacy identity is held legacy_unresolved, never written', async () => {
  const cases: Array<[string, Partial<OrderRecord>]> = [
    ['EN-10 frozen sender', { confirmationEmailFrom: `${CANARY_FROM} <old@example.invalid>` }],
    ['EN-11 key only', { confirmationEmailIdempotencyKey: `order-confirmation-${ORDER_ID}-primary-v1` }],
    ['EN-12 stale claim', {
      emailResendClaimId: 'claim-stale', emailResendClaimKind: 'order_confirmation',
      emailResendClaimAt: new Date(NOW_MS - CONFIRMATION_EMAIL_CLAIM_STALE_MS - 1_000).toISOString(),
    }],
  ];
  for (const [label, overrides] of cases) {
    const r = await armed({ order: paidOrder(overrides), store: {} });
    assertHeld(r, 'legacy_unresolved', 'legacy_identity_present', label);
    assert.equal(r.store.count('put'), 0, `${label}: put`);
    assertHoldCommitPrivacy(r, 'legacy_unresolved', label);
    assertSinksClean(r, label);
  }
});

test('EN-13: fifty pre-epoch orders under an armed writer equal the writer-off golden through the sweep', async () => {
  const orders = Array.from({ length: 50 }, (_, i) => paidOrder(
    { paidAt: new Date(EPOCH_MS - (i + 1) * 60 * 60 * 1000).toISOString() },
    idOf((0xa0 + i).toString(16)),
  ));
  const mem = memOrderIo(orders);
  const store = strictSyntheticStoreIo();
  const transport = recordingTransport();
  const errors: string[] = [];
  const result = await withAmbient({}, () => runConfirmationEmailSweep({
    listOrders: async () => orders,
    deliver: (orderId) => deliverOrderConfirmationEmail(orderId, {
      send: transport.send, now: () => NOW_MS, newClaimId: () => 'claim-synthetic', log: () => {}, errorLog: (l) => { errors.push(l); },
      envelopeWriter: { env: writerEnv(), storeIo: store.io, orderIo: mem.io },
    } as DeliverOrderConfirmationEmailDeps),
    now: () => NOW_MS, graceMs: 15 * 60 * 1000, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: Date.parse(FLOOR), log: () => {}, errorLog: (l) => { errors.push(l); }, maxDeliveries: 50,
  }));
  assert.equal(result.sent, 50);
  assert.equal(result.held, 0);
  assert.equal(result.deferred, 0);
  assert.equal(transport.calls(), 50);
  assert.equal(store.calls.length, 0);
  assert.deepEqual(errors, []);
  for (const order of orders) {
    const golden = await writerOffGolden(order);
    assert.deepEqual(mem.record(order.id), golden.post, `${order.id} record deltas`);
  }
});

test('EN-14: identity frozen by a legacy worker before the CAS is classified on latest — a T1 hold, object kept', async () => {
  const identity = { confirmationEmailFrom: 'Legacy <legacy@example.invalid>', confirmationEmailIdempotencyKey: `order-confirmation-${ORDER_ID}-primary-v1` };
  const order = paidOrder();
  const mem = memWithHandle([order], (self) => ({
    beforeAttempt: (call, attempt) => {
      if (call === 0 && attempt === 1) self().put({ ...self().record()!, ...identity } as OrderRecord);
    },
  }));
  const r = await armed({ order, memIo: mem });
  assertHeld(r, 'legacy_unresolved', 'legacy_identity_present', 'EN-14');
  assert.equal(r.store.count('put'), 1, 'the object was written before the CAS');
  assert.equal(r.store.objects.size, 1, 'and it is kept');
  assert.equal(r.post!.confirmationEmailState, 'RECONCILIATION_REQUIRED');
  assert.equal(r.post!.confirmationEmailEnvelopeRef ?? null, null, 'no ref on a hold');
  assert.equal(r.post!.confirmationEmailFrom, identity.confirmationEmailFrom, 'the legacy identity is carried, not replaced');
  assertHoldCommitPrivacy(r, 'legacy_unresolved', 'EN-14');
});

/** RC-32: no store call may fall inside any transaction window. */
function assertStoreOutsideTransactions(r: { store: ReturnType<typeof strictSyntheticStoreIo>; mem: ReturnType<typeof memOrderIo> }, label = '') {
  for (const call of r.store.calls) {
    assert.equal(inWindows(call.seq, r.mem.transacts.map((t) => t.window)), false, `${label}: store ${call.op} inside a transaction`);
  }
}

/** The record a peer would have committed for the object in the store. */
function peerSnapshotted(current: OrderRecord, store: ReturnType<typeof strictSyntheticStoreIo>, namespace = ''): OrderRecord {
  const envelope = putEnvelope(store);
  return {
    ...current,
    confirmationEmailState: 'SNAPSHOTTED',
    confirmationEmailHoldReason: null,
    confirmationEmailEnvelopeRef: refFor(envelope as never, namespace),
    confirmationEmailFrom: (envelope.request as { from: string }).from,
    confirmationEmailIdempotencyKey: String(envelope.idempotencyKey),
    updatedAt: '2026-10-15T12:59:00.000Z',
  } as unknown as OrderRecord;
}

/** A canary-free unrelated edit, through the real pure transforms. */
function unrelatedEdit(order: OrderRecord, n = 1): OrderRecord {
  const patched = applyFulfillmentPatchTo(order, { fulfillmentStatus: n % 2 ? 'generating' : 'queued' } as never, `2026-10-15T12:4${n}:00.000Z`);
  return appendAuditEventTo(patched, { type: `edit-${n}` } as never, `2026-10-15T12:4${n}:00.000Z`);
}
const EDIT_KEYS = ['fulfillmentStatus', 'auditEvents', 'updatedAt'];

/** A stored envelope object, varied from a candidate and re-serialized. */
function variantObject(candidate: SnapshotCandidate, change: (envelope: Record<string, any>) => void, spacing?: number): string {
  const envelope = JSON.parse(candidate.serialized) as Record<string, any>;
  change(envelope);
  if (envelope.request) envelope.canonicalDigest = digestConfirmationRequest(envelope.request);
  return JSON.stringify(envelope, null, spacing);
}

// ══ §E — Snapshot path, ordering and commit shape ══════════════════════════

test('SN-1 / SN-2 / SN-5 / SN-7: one frozen-option put at the namespaced path, before one CAS, of exactly the frozen request', async () => {
  const r = await armed();
  assertSnapshotted(r, 'committed', 'SN-1');
  const puts = r.store.calls.filter((call) => call.op === 'put');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].pathname, confirmationEnvelopeObjectPath(ORDER_ID, ''));
  assert.deepEqual(puts[0].options, {
    access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json', dedicatedToken: true,
  });
  const expected = candidateFor(r.pre!);
  assert.equal(puts[0].body, expected.serialized, 'SN-1: the put body is the candidate bytes');
  assert.equal(r.mem.transactCalls(), 1, 'one CAS');
  assert.ok(puts[0].seq < r.mem.writes[0].seq, 'SN-2: the write precedes the commit');
  const envelope = putEnvelope(r.store);
  assert.deepEqual(envelope.request, expectedRequest(r.pre!), 'SN-5: request composition');
  assert.equal(envelope.idempotencyKey, `order-confirmation-${ORDER_ID}-primary-v1`);
  assert.deepEqual(r.logs, [`[confirmation-envelope] snapshotted orderId=${ORDER_ID} via=committed`], 'SN-7');
  assert.deepEqual(r.errors, []);
  assertStoreOutsideTransactions(r, 'SN-1');
});

test('SN-3 / SN-4: the committed record differs from L* only in the write set, and its ref matches the object', async () => {
  const r = await armed();
  assertSnapshotCommitPrivacy(r, 'SN-3');
  const putSeq = r.store.calls.find((call) => call.op === 'put')!.seq;
  assert.ok(r.mem.writes.length === 1 && putSeq < r.mem.writes[0].seq, 'I4R-1: the object write precedes the record commit');
  const lstar = r.mem.lstar()!;
  for (const key of Object.keys(lstar)) {
    if (/^(emailResendClaim|confirmationEmailSentAt|confirmationEmailFirstDispatch|confirmationEmailAttempt|confirmationEmailDispatch|confirmationEmailProvider|confirmationEmailAccepted)/.test(key)) {
      assert.deepEqual((r.post as never)[key], (lstar as never)[key], `SN-3: ${key}`);
    }
  }
  assert.equal(r.post!.emailResendClaimId ?? null, null, 'SN-3: no claim');
  const envelope = putEnvelope(r.store);
  const view = toAdminOrderDetail(r.post!).confirmation;
  assert.ok(view, 'SN-4: the operator view validates the ref');
  assert.equal(view.canonicalDigest, envelope.canonicalDigest);
  assert.equal(view.canonicalBytes, envelope.canonicalBytes);
  assert.equal(view.createdAt, envelope.createdAt);
  assert.equal(view.templateVersion, envelope.templateVersion);
  assert.equal(view.accountLabel, (envelope.providerBinding as { accountLabel: string }).accountLabel);
  assert.equal(view.purgedAt, null);
  const ref = r.post!.confirmationEmailEnvelopeRef as unknown as Record<string, unknown>;
  assert.equal(ref.objectPath, r.store.calls.find((call) => call.op === 'put')!.pathname, 'SN-4: objectPath is the put path');
  assert.equal(ref.storageKind, 'private_blob');
});

test('SN-8: a second delivery on the now-SNAPSHOTTED record waits for the frozen dispatcher, touching nothing', async () => {
  const first = await armed();
  assertSnapshotted(first, 'committed');
  const before = first.mem.body();
  const store = strictSyntheticStoreIo({});
  const transport = throwingTransport();
  const second = await withAmbient({}, () => deliverArmed({ env: writerEnv(), storeIo: store.io, orderIo: first.mem.io, send: transport.send }));
  assert.deepEqual(second.outcome, { status: 'blocked', reason: 'awaiting_frozen_dispatch' });
  assert.equal(store.calls.length, 0);
  assert.equal(first.mem.body(), before, 'record byte-identical');
  assert.equal(transport.calls(), 0);
});

test('SN-9 / SN-10: the sweep never selects SNAPSHOTTED, across ticks', async () => {
  const snapshots = Array.from({ length: 12 }, (_, i) => paidOrder({ confirmationEmailState: 'SNAPSHOTTED' } as Partial<OrderRecord>, idOf((0xd0 + i).toString(16))));
  const legacy = paidOrder({ paidAt: new Date(EPOCH_MS - 60 * 60 * 1000).toISOString() }, idOf('ee'));
  const mem = memOrderIo([...snapshots, legacy]);
  const store = strictSyntheticStoreIo({});
  const transport = recordingTransport();
  const delivered: string[] = [];
  const logs: string[] = [];
  for (let tick_ = 0; tick_ < 3; tick_ += 1) {
    await withAmbient({}, () => runConfirmationEmailSweep({
      listOrders: async () => [...snapshots, ...(tick_ === 0 ? [legacy] : [])],
      deliver: (orderId) => {
        delivered.push(orderId);
        return deliverOrderConfirmationEmail(orderId, {
          send: transport.send, now: () => NOW_MS, log: (l) => { logs.push(l); }, errorLog: (l) => { logs.push(l); },
          envelopeWriter: { env: writerEnv(), storeIo: store.io, orderIo: mem.io },
        } as DeliverOrderConfirmationEmailDeps);
      },
      now: () => NOW_MS, graceMs: 15 * 60 * 1000, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
      activationPaidAtMs: Date.parse(FLOOR), log: (l) => { logs.push(l); }, errorLog: (l) => { logs.push(l); },
    }));
  }
  assert.deepEqual(delivered, [legacy.id], 'only the legacy record is selected');
  assert.equal(transport.calls(), 1);
  assert.equal(store.calls.length, 0);
  for (const snapshot of snapshots) {
    assert.ok(!logs.some((line) => line.includes(snapshot.id)), `no log line about ${snapshot.id}`);
    assert.equal(mem.body(snapshot.id), JSON.stringify(snapshot));
  }
});

// ══ §F — Storage phase, CAS and orphans ════════════════════════════════════

test('OR-1: a lost CAS to an identical SNAPSHOTTED peer is a peer no-op', async () => {
  const order = paidOrder();
  const store = strictSyntheticStoreIo({ put: ['store'] });
  const r = await armed({
    order, storeHandle: store,
    mem: { conflicts: [1], onConflict: (_call, _attempt, current) => peerSnapshotted(current, store) },
  });
  assertSnapshotted(r, 'peer_committed', 'OR-1');
  assert.equal(r.store.count('put'), 1);
  assert.equal(r.mem.writes.length, 0, 'no second commit');
});

test('OR-2 / PV-9: two unrelated concurrent edits; the commit lands on attempt 3 and carries both', async () => {
  const order = paidOrder();
  const r = await armed({ order, mem: { conflicts: [2], onConflict: (_c, attempt, current) => unrelatedEdit(current, attempt) } });
  assertSnapshotted(r, 'committed', 'OR-2');
  assert.equal(r.mem.latests.length, 3);
  assert.equal(r.store.count('put'), 1, 'the candidate was frozen once');
  const ref = r.post!.confirmationEmailEnvelopeRef as unknown as Record<string, unknown>;
  assert.equal(ref.createdAt, putEnvelope(r.store).createdAt, 'the ref createdAt is the put body createdAt');
  assert.deepEqual(concurrentEditOffenders(order as never, r.mem.lstar() as never, r.post as never, EDIT_KEYS, 'snapshotted', NOW), []);
  assert.equal(r.post!.auditEvents?.length, 2);
  assertSnapshotCommitPrivacy(r, 'OR-2');
});

test('OR-3: a conflict then a refund blocks; the object is kept and nothing is deleted', async () => {
  const r = await armed({ mem: { conflicts: [1], onConflict: (_c, _a, current) => ({ ...current, refundedAt: '2026-10-15T12:50:00.000Z' }) } });
  assert.deepEqual(r.outcome, { status: 'blocked', reason: 'refunded' });
  assert.equal(r.store.objects.size, 1);
  assert.equal(r.store.count('del'), 0);
  assert.equal(r.mem.writes.length, 0);
});

test('OR-5: a conflict then a changed email defers as candidate_drift, with no hold', async () => {
  const r = await armed({ mem: { conflicts: [1], onConflict: (_c, _a, current) => ({ ...current, email: 'changed@example.invalid' }) } });
  assertDeferred(r, 'candidate_drift', 'OR-5');
  assert.equal(r.mem.writes.length, 0);
  assert.equal(r.store.count('del'), 0);
});

test('OR-6: five lost CASes are cas_exhausted; the next attempt adopts the object it left', async () => {
  const order = paidOrder();
  const mem = memOrderIo([order], { conflicts: [5] });
  const store = strictSyntheticStoreIo({ put: ['store', 'store'], get: ['serve', 'serve'] });
  const first = await armed({ order, memIo: mem, storeHandle: store });
  assertDeferred(first, 'cas_exhausted', 'OR-6 first');
  const second = await armed({ order, memIo: mem, storeHandle: store, now: NOW_MS + 60_000 });
  assert.deepEqual(second.outcome, { status: 'snapshotted', via: 'adopted_existing_object' });
  assert.equal(store.objects.size, 1, 'one object total');
  const ref = mem.record()!.confirmationEmailEnvelopeRef as unknown as Record<string, unknown>;
  assert.equal(ref.createdAt, NOW, 'adopted with the stored createdAt');
});

test('OR-7: a commit that throws after the write landed is commit_ambiguous; the next pre-read waits', async () => {
  const order = paidOrder();
  const mem = memOrderIo([order], { throwOnCommit: { callIndex: 0, when: 'after-write', error: new Error('ambiguous adapter failure') } });
  const first = await armed({ order, memIo: mem });
  assertDeferred(first, 'commit_ambiguous', 'OR-7');
  const second = await armed({ order, memIo: mem, store: {} });
  assert.deepEqual(second.outcome, { status: 'blocked', reason: 'awaiting_frozen_dispatch' });
  assert.equal(second.store.calls.length, 0);
});

test('OR-8: a commit that throws before the write landed is retried by the next attempt, which adopts', async () => {
  const order = paidOrder();
  const mem = memOrderIo([order], { throwOnCommit: { callIndex: 0, when: 'before-write', error: new Error('ambiguous adapter failure') } });
  const store = strictSyntheticStoreIo({ put: ['store', 'store'], get: ['serve', 'serve'] });
  const first = await armed({ order, memIo: mem, storeHandle: store });
  assertDeferred(first, 'commit_ambiguous', 'OR-8');
  const second = await armed({ order, memIo: mem, storeHandle: store });
  assert.deepEqual(second.outcome, { status: 'snapshotted', via: 'adopted_existing_object' });
  assert.equal(mem.record()!.confirmationEmailState, 'SNAPSHOTTED');
});

test('OR-9: two concurrent kickoffs with different clocks converge on one object and one ref', async () => {
  const order = paidOrder();
  const mem = memOrderIo([order]);
  const store = strictSyntheticStoreIo({ put: ['store', 'store'], get: ['serve', 'serve'] });
  const runs = await withAmbient({}, () => Promise.all([NOW_MS, NOW_MS + 5_000].map((now) => deliverArmed({
    env: writerEnv(), storeIo: store.io, orderIo: mem.io, send: throwingTransport().send, now,
  }))));
  for (const run of runs) assert.equal((run.outcome as { status: string }).status, 'snapshotted', JSON.stringify(run.outcome));
  assert.equal(store.objects.size, 1, 'one object');
  const stored = JSON.parse(store.objects.get(confirmationEnvelopeObjectPath(ORDER_ID, '')!)!.toString('utf8'));
  const ref = mem.record()!.confirmationEmailEnvelopeRef as unknown as Record<string, unknown>;
  assert.equal(ref.createdAt, stored.createdAt, 'one ref, matching the one object');
  assert.equal(ref.canonicalDigest, stored.canonicalDigest);
});

test('OR-10: a put that failed although the object landed is adopted', async () => {
  const r = await armed({ store: { put: ['fail-landed'], get: ['serve', 'serve'] } });
  assertSnapshotted(r, 'adopted_existing_object', 'OR-10');
  assert.equal(r.store.count('get'), 2, 'one read and one byte-exact verify');
});

test('OR-11: a pre-seeded object that differs in any byte is held existing_object_mismatch, untouched', async () => {
  const candidate = candidateFor(paidOrder());
  const variants: Array<[string, string]> = [
    ['template', variantObject(candidate, (e) => { e.templateVersion = 'other-template-v1'; })],
    ['label', variantObject(candidate, (e) => { e.providerBinding = { accountLabel: 'other-label-v1' }; })],
    ['key', variantObject(candidate, (e) => { e.idempotencyKey = 'order-confirmation-other-primary-v1'; })],
    ['one body byte', variantObject(candidate, (e) => { e.request.html = `${e.request.html.slice(0, -1)}!`; })],
    ['extra key', variantObject(candidate, (e) => { e.extra = 1; })],
    ['whitespace', variantObject(candidate, () => {}, 1)],
  ];
  const objectPath = confirmationEnvelopeObjectPath(ORDER_ID, '')!;
  for (const [label, body] of variants) {
    const r = await armed({ store: { objects: { [objectPath]: body }, put: ['store'], get: ['serve', 'serve'] } });
    assertHeld(r, 'snapshot_refused', 'existing_object_mismatch', `OR-11 ${label}`);
    assert.equal(r.store.objects.get(objectPath)!.toString('utf8'), body, `OR-11 ${label}: object bytes unchanged`);
    assertHoldCommitPrivacy(r, 'snapshot_refused', `OR-11 ${label}`);
  }
});

test('OR-12: a stored createdAt that is not canonical, or precedes paidAt, is held existing_object_mismatch', async () => {
  const objectPath = confirmationEnvelopeObjectPath(ORDER_ID, '')!;
  for (const [label, createdAt] of [['non-canonical', '2026-10-15T13:00:00Z'], ['before paidAt', '2026-10-15T11:59:59.000Z']]) {
    const body = variantObject(candidateFor(paidOrder()), (e) => { e.createdAt = createdAt; });
    const r = await armed({ store: { objects: { [objectPath]: body }, put: ['store'], get: ['serve'] } });
    assertHeld(r, 'snapshot_refused', 'existing_object_mismatch', `OR-12 ${label}`);
    assert.equal(r.store.count('get'), 1, `${label}: no verify after a refused createdAt`);
  }
});

test('OR-13: an unverifiable existing object defers existing_object_unverified, with no state change', async () => {
  const objectPath = confirmationEnvelopeObjectPath(ORDER_ID, '')!;
  const seeded = { [objectPath]: candidateFor(paidOrder()).serialized };
  for (const [label, script] of [
    ['read throws', { objects: seeded, put: ['store'], get: [{ error: new Error('synthetic network failure') }] }],
    ['verify throws', { objects: seeded, put: ['store'], get: ['serve', { error: new Error('synthetic network failure') }] }],
    ['read not 200', { objects: seeded, put: ['store'], get: [{ status: 500 }] }],
  ] as Array<[string, StoreScript]>) {
    const r = await armed({ store: script });
    assertDeferred(r, 'existing_object_unverified', `OR-13 ${label}`);
    assert.equal(r.mem.transactCalls(), 0, `${label}: no CAS`);
    assert.equal(r.mem.body(), JSON.stringify(r.pre), `${label}: no state change`);
  }
});

test('OR-14: a failed write with the object proven absent defers write_failed_object_absent', async () => {
  const r = await armed({ store: { put: ['fail'], get: ['serve'] } });
  assertDeferred(r, 'write_failed_object_absent', 'OR-14');
  assert.equal(r.mem.transactCalls(), 0);
});

test('OR-15: a public store defers store_not_private with no readback and no legacy send', async () => {
  const r = await armed({ store: { put: ['not_private'] } });
  assertDeferred(r, 'store_not_private', 'OR-15');
  assert.equal(r.store.count('get'), 0);
  assert.equal(r.transport.calls(), 0);
  assert.equal(r.mem.transactCalls(), 0);
});

// ── The stage seam's armed gate (OR-16, RC-19…RC-24, ND-3/5/9) ─────────────

/** An armed gate built by the real W0, under ambient agreement. */
function armedGate(orderIo: unknown, storeIo: unknown, namespace = ''): ConfirmationEnvelopeWriterGate & { kind: 'armed' } {
  const gate = producer.resolveConfirmationEnvelopeWriter({
    env: writerEnv(namespace || undefined), storeIo: storeIo as never, orderIo: orderIo as never,
  });
  assert.equal(gate.kind, 'armed', `expected an armed gate, got ${JSON.stringify(gate)}`);
  return gate as ConfirmationEnvelopeWriterGate & { kind: 'armed' };
}

const ownBytesEvidence = (candidate: SnapshotCandidate, refusal = 'too_large') =>
  Object.freeze({ kind: 'own_bytes_refused', candidate, refusal }) as unknown as SnapshotEvidence;

// ══ §F OR-16 — [stage seam]: our own bytes refused before the SDK ═════════

describe('stage seam: S6 driven with synthetic evidence (counted separately)', () => {
  test('[stage seam] OR-16: own_bytes_refused evidence commits the T13 hold object_write_refused', async () => {
    // No real-path lever exists: S3 builds within the builder's ceilings,
    // JSON.stringify is well-formed, and the producer pre-checks the size.
    const order = paidOrder();
    const mem = memOrderIo([order]);
    await withAmbient({}, async () => {
      const gate = armedGate(mem.io, strictSyntheticStoreIo().io);
      const result = await producer.runSnapshotCommitStage(ORDER_ID, ownBytesEvidence(candidateFor(order)), decisionCtx(), gate);
      assert.deepEqual(result, { status: 'held', reason: 'snapshot_refused', cause: 'object_write_refused' });
    });
    assertHoldCommitPrivacy({ mem, post: mem.record() }, 'snapshot_refused', 'OR-16');
  });

  // RC-19 … RC-24: own_bytes_refused evidence raced against the six changes.
  const ownBytesRaces: Array<[string, string, (current: OrderRecord) => OrderRecord, unknown]> = [
    ['RC-19', 'unrelated edit', (c) => unrelatedEdit(c, 1), { status: 'held', reason: 'snapshot_refused', cause: 'object_write_refused' }],
    ['RC-20', 'drift', (c) => ({ ...c, email: 'changed@example.invalid' }), { status: 'snapshot_deferred', reason: 'candidate_drift' }],
    ['RC-21', 'peer', (c) => ({ ...c, confirmationEmailState: 'SNAPSHOTTED' } as OrderRecord), { status: 'blocked', reason: 'awaiting_frozen_dispatch' }],
    ['RC-22', 'identity', (c) => ({ ...c, confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), { status: 'held', reason: 'legacy_unresolved', cause: 'legacy_identity_present' }],
    ['RC-23', 'fence', (c) => ({ ...c, refundedAt: '2026-10-15T12:50:00.000Z' }), { status: 'blocked', reason: 'refunded' }],
    ['RC-24', 'enrollment lost', (c) => ({ ...c, confirmationEmailEnvelopeRef: { stray: true } } as unknown as OrderRecord), { status: 'snapshot_deferred', reason: 'record_changed' }],
  ];
  for (const [id, change, apply, expected] of ownBytesRaces) {
    test(`[stage seam] ${id}: own_bytes_refused raced against ${change}`, async () => {
      const order = paidOrder();
      const mem = memOrderIo([order], { conflicts: [1], onConflict: (_c, _a, current) => apply(current) });
      await withAmbient({}, async () => {
        const gate = armedGate(mem.io, strictSyntheticStoreIo().io);
        const result = await producer.runSnapshotCommitStage(ORDER_ID, ownBytesEvidence(candidateFor(order)), decisionCtx(), gate);
        assert.deepEqual(result, expected);
      });
      if (id === 'RC-19') {
        assert.deepEqual(concurrentEditOffenders(order as never, mem.lstar() as never, mem.record() as never, EDIT_KEYS, 'hold', NOW), []);
      } else if ((expected as { status: string }).status !== 'held') {
        assert.equal(mem.writes.length, 0, `${id}: no commit`);
      }
    });
  }
});

// ══ §R — Evidence-bound CAS races (integration) ════════════════════════════

type RcClass = 'object_written' | 'object_verified_equal' | 'object_mismatch';
const RC_OBJECT = () => confirmationEnvelopeObjectPath(ORDER_ID, '')!;

function rcStore(cls: RcClass, order: OrderRecord) {
  switch (cls) {
    case 'object_written':
      return strictSyntheticStoreIo({ put: ['store'] });
    case 'object_verified_equal':
      return strictSyntheticStoreIo({ objects: { [RC_OBJECT()]: candidateFor(order).serialized }, put: ['store'], get: ['serve', 'serve'] });
    default:
      return strictSyntheticStoreIo({ objects: { [RC_OBJECT()]: variantObject(candidateFor(order), () => {}, 1) }, put: ['store'], get: ['serve', 'serve'] });
  }
}

const STRAY_REF = { stray: true };
const RC_CHANGES: Array<[string, (current: OrderRecord, store: ReturnType<typeof strictSyntheticStoreIo>) => OrderRecord]> = [
  ['unrelated edit', (c) => unrelatedEdit(c, 1)],
  ['drift', (c) => ({ ...c, email: 'changed@example.invalid' })],
  ['peer', (c, store) => peerSnapshotted(c, store)],
  ['identity', (c) => ({ ...c, confirmationEmailFrom: 'Legacy <legacy@example.invalid>', confirmationEmailIdempotencyKey: `order-confirmation-${ORDER_ID}-primary-v1` })],
  ['fence', (c) => ({ ...c, refundedAt: '2026-10-15T12:50:00.000Z' })],
  ['enrollment lost', (c) => ({ ...c, confirmationEmailEnvelopeRef: STRAY_REF } as unknown as OrderRecord)],
];

const RC_EXPECTED: Record<RcClass, unknown[]> = {
  object_written: [
    { status: 'snapshotted', via: 'committed' },
    { status: 'snapshot_deferred', reason: 'candidate_drift' },
    { status: 'snapshotted', via: 'peer_committed' },
    { status: 'held', reason: 'legacy_unresolved' },
    { status: 'blocked', reason: 'refunded' },
    { status: 'snapshot_deferred', reason: 'record_changed' },
  ],
  object_verified_equal: [
    { status: 'snapshotted', via: 'adopted_existing_object' },
    { status: 'snapshot_deferred', reason: 'candidate_drift' },
    { status: 'snapshotted', via: 'peer_committed' },
    { status: 'held', reason: 'legacy_unresolved' },
    { status: 'blocked', reason: 'refunded' },
    { status: 'snapshot_deferred', reason: 'record_changed' },
  ],
  object_mismatch: [
    { status: 'held', reason: 'snapshot_refused' },
    { status: 'snapshot_deferred', reason: 'candidate_drift' },
    { status: 'blocked', reason: 'awaiting_frozen_dispatch' },
    { status: 'held', reason: 'legacy_unresolved' },
    { status: 'blocked', reason: 'refunded' },
    { status: 'snapshot_deferred', reason: 'record_changed' },
  ],
};

let rcId = 1;
for (const cls of ['object_written', 'object_verified_equal', 'object_mismatch'] as const) {
  RC_CHANGES.forEach(([change, apply], index) => {
    const id = `RC-${rcId++}`;
    test(`${id}: ${cls} evidence raced against ${change}`, async () => {
      const order = paidOrder();
      const store = rcStore(cls, order);
      const r = await armed({ order, storeHandle: store, mem: { conflicts: [1], onConflict: (_c, _a, current) => apply(current, store) } });
      const expected = RC_EXPECTED[cls][index];
      assert.deepEqual(r.outcome, expected, id);
      assert.equal(r.transport.calls(), 0);
      assert.equal(r.store.count('del'), 0);
      assert.ok(r.store.count('put') <= 1, 'OR-18: at most one put');
      assertStoreOutsideTransactions(r, id);
      assertSinksClean(r, id);
      const status = (expected as { status: string }).status;
      if (status === 'snapshotted' && (expected as { via: string }).via !== 'peer_committed') assertSnapshotCommitPrivacy(r, id);
      if (status === 'held') assertHoldCommitPrivacy(r, (expected as { reason: string }).reason, id);
      if (change === 'unrelated edit') {
        assert.deepEqual(
          concurrentEditOffenders(order as never, r.mem.lstar() as never, r.post as never, EDIT_KEYS, status === 'held' ? 'hold' : 'snapshotted', NOW),
          [],
          `${id}: PV-9`,
        );
      }
      if (status !== 'snapshotted' && status !== 'held') assert.equal(r.mem.writes.length, 0, `${id}: no commit`);
      if (change === 'drift') assert.equal(r.mem.body(), JSON.stringify(r.mem.latests[1]), `${id}: record = latest, byte-identical`);
    });
  });
}

test('RC-25: the stale-peer race defers as candidate_drift, and the next attempt adopts the peer object', async () => {
  const order = paidOrder();
  const updated = { ...order, email: 'updated@example.invalid' } as OrderRecord;
  const peerObject = candidateFor(updated, '', '2026-10-15T12:58:00.000Z').serialized;
  const mem = memWithHandle([order], (self) => ({
    beforeAttempt: (call, attempt) => { if (call === 0 && attempt === 1) self().put(updated); },
  }));
  const store = strictSyntheticStoreIo({ objects: { [RC_OBJECT()]: peerObject }, put: ['store', 'store'], get: ['serve', 'serve', 'serve', 'serve'] });
  const first = await armed({ order, memIo: mem, storeHandle: store });
  assertDeferred(first, 'candidate_drift', 'RC-25 first attempt');
  assert.equal(mem.writes.length, 0, 'not a hold');
  const second = await armed({ order: updated, memIo: mem, storeHandle: store });
  assert.deepEqual(second.outcome, { status: 'snapshotted', via: 'adopted_existing_object' });
  assert.equal(store.objects.get(RC_OBJECT())!.toString('utf8'), peerObject, 'the peer object is kept, byte for byte');
});

test('RC-26 / RC-27: build-refusal evidence defers on render drift and holds on an unrelated edit', async () => {
  const huge = paidOrder({ childName: 'N'.repeat(1024 * 1024) });
  const drifted = await armed({ order: huge, store: {}, mem: { conflicts: [1], onConflict: (_c, _a, current) => ({ ...current, childName: 'Normal Name' }) } });
  assertDeferred(drifted, 'candidate_drift', 'RC-26');
  assert.equal(drifted.mem.writes.length, 0);
  const edited = await armed({ order: huge, store: {}, mem: { conflicts: [1], onConflict: (_c, _a, current) => unrelatedEdit(current, 1) } });
  assertHeld(edited, 'snapshot_refused', 'envelope_build_refused', 'RC-27');
  assert.deepEqual(concurrentEditOffenders(huge as never, edited.mem.lstar() as never, edited.post as never, EDIT_KEYS, 'hold', NOW), []);
});

test('RC-28 / RC-29: legacy_unresolved evidence defers when identity clears and holds on an unrelated edit', async () => {
  const legacy = paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' });
  const cleared = await armed({ order: legacy, store: {}, mem: { conflicts: [1], onConflict: (_c, _a, current) => ({ ...current, confirmationEmailFrom: null }) } });
  assertDeferred(cleared, 'record_changed', 'RC-28');
  assert.equal(cleared.mem.writes.length, 0);
  const edited = await armed({ order: legacy, store: {}, mem: { conflicts: [1], onConflict: (_c, _a, current) => unrelatedEdit(current, 2) } });
  assertHeld(edited, 'legacy_unresolved', 'legacy_identity_present', 'RC-29');
  assert.deepEqual(concurrentEditOffenders(legacy as never, edited.mem.lstar() as never, edited.post as never, EDIT_KEYS, 'hold', NOW), []);
});

test('RC-30: the CAS callback is synchronous — the seam refuses a thenable', async () => {
  const mem = memOrderIo([paidOrder()]);
  const binding = (bindOrderNamespace('') as { binding: OrderNamespaceBinding }).binding;
  await assert.rejects(
    (mem.io as unknown as { transact: Function }).transact(binding, ORDER_ID, async () => ({ abort: null }), { notFound: () => null }),
    (error: unknown) => error instanceof AsyncMutateError,
  );
  // And every integration row above ran with zero AsyncMutateError: one would
  // have surfaced as commit_ambiguous and failed its row.
  const r = await armed();
  assertSnapshotted(r, 'committed');
});

test('RC-31: evidence, candidate, params, render and ref are deep-frozen; a strict-mode write throws', () => {
  const candidate = candidateFor(paidOrder());
  const accepted = producer.classifySnapshotWrite(candidate, { ok: true, value: { objectPath: candidate.objectPath, storedBytes: candidate.byteLength } });
  const evidence = (accepted as { evidence: SnapshotEvidence }).evidence;
  for (const [label, value] of [['evidence', evidence], ['candidate', candidate], ['params', candidate.params], ['render', candidate.render], ['ref', candidate.ref]] as const) {
    assert.ok(Object.isFrozen(value), `${label} is frozen`);
  }
  assert.ok(deepFrozen(evidence));
  assert.throws(() => { (candidate.params as { from: string }).from = 'x'; }, TypeError);
  assert.throws(() => { (candidate.ref as { objectPath: string }).objectPath = 'x'; }, TypeError);
});

test('RC-32: no store call falls inside a transaction window, across the storage classes', async () => {
  for (const cls of ['object_written', 'object_verified_equal', 'object_mismatch'] as const) {
    const order = paidOrder();
    const r = await armed({ order, storeHandle: rcStore(cls, order), mem: { conflicts: [1], onConflict: (_c, _a, current) => unrelatedEdit(current, 1) } });
    assert.ok(r.store.calls.length > 0);
    assertStoreOutsideTransactions(r, cls);
  }
});

test('RC-33: four conflicts, four edits — the decision runs five times on its own latest; one put; the commit carries all four', async () => {
  const order = paidOrder();
  let n = 0;
  const r = await armed({ order, mem: { conflicts: [4], onConflict: (_c, _a, current) => unrelatedEdit(current, ++n) } });
  assertSnapshotted(r, 'committed', 'RC-33');
  assert.equal(r.mem.latests.length, 5, 'decided five times');
  for (let i = 1; i < 5; i += 1) assert.notDeepEqual(r.mem.latests[i], r.mem.latests[i - 1], `latest ${i} is fresh`);
  assert.equal(r.store.count('put'), 1);
  assert.ok(r.store.count('get') <= 2);
  assert.deepEqual(r.mem.lstar(), r.mem.latests[4], 'L* is the fifth latest');
  assert.equal(r.post!.auditEvents?.length, 4, 'all four edits carried');
  const ref = r.post!.confirmationEmailEnvelopeRef as unknown as Record<string, unknown>;
  assert.equal(ref.createdAt, putEnvelope(r.store).createdAt, 'the candidate was frozen once: the ref createdAt is the put body createdAt');
  assert.deepEqual(concurrentEditOffenders(order as never, r.mem.lstar() as never, r.post as never, EDIT_KEYS, 'snapshotted', NOW), []);
});

// ══ §G — Holds ═════════════════════════════════════════════════════════════

function holdLever(member: string): { order: OrderRecord; ambient: AmbientValues } {
  switch (member) {
    case 'from_too_long': return { order: paidOrder(), ambient: { HSB_EMAIL_FROM: 'F'.repeat(321) } };
    case 'to_too_long': return { order: paidOrder({ email: `${'x'.repeat(321 - '@example.invalid'.length)}@example.invalid` }), ambient: {} };
    case 'reply_to_too_long': return { order: paidOrder(), ambient: { HSB_SUPPORT_EMAIL: `${'r'.repeat(321 - '@example.invalid'.length)}@example.invalid` } };
    case 'subject_too_long': return { order: paidOrder({ childName: 'C'.repeat(980) }), ambient: {} };
    case 'html_too_long': return { order: paidOrder({ formatLabel: '"'.repeat(44_000) }), ambient: {} };
    case 'text_too_long': return { order: paidOrder({ formatLabel: 'a'.repeat(66_000) }), ambient: {} };
    default: {
      for (let n = 40_000; n <= 43_600; n += 200) {
        const order = paidOrder({ formatLabel: '"'.repeat(n) });
        if (leverRefusal(order, {}) === 'canonical_too_large') return { order, ambient: {} };
      }
      throw new Error('no canonical_too_large lever found');
    }
  }
}

/** The precondition, on the real renderer and the real limit check. */
function leverRefusal(order: OrderRecord, ambient: AmbientValues): string | null {
  const env = { ...RENDER_ENV, ...ambient } as typeof RENDER_ENV;
  const request = expectedRequest(order, env);
  return checkConfirmationEnvelopeLimits(request as never);
}

const REACHABLE = ['from_too_long', 'to_too_long', 'reply_to_too_long', 'subject_too_long', 'html_too_long', 'text_too_long', 'canonical_too_large'] as const;

for (const member of REACHABLE) {
  test(`HO-1: ${member} through the real path is held snapshot_refused, envelope_build_refused, with no put`, async () => {
    const { order, ambient } = holdLever(member);
    assert.equal(leverRefusal(order, ambient), member, 'precondition on the real functions');
    const r = await armed({ order, ambient, store: {} });
    assertHeld(r, 'snapshot_refused', 'envelope_build_refused', `HO-1 ${member}`);
    assert.equal(r.store.count('put'), 0);
    assertHoldCommitPrivacy(r, 'snapshot_refused', `HO-1 ${member}`);
  });
}

test('HO-2: a hold carries no ref, no identity and no claim', async () => {
  const r = await armed({ order: paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), store: {} });
  assertHeld(r, 'legacy_unresolved', 'legacy_identity_present');
  assert.equal(r.post!.confirmationEmailEnvelopeRef ?? null, null);
  assert.equal(r.post!.emailResendClaimId ?? null, null);
  assertHoldCommitPrivacy(r, 'legacy_unresolved', 'HO-2');
});

test('HO-3 / HO-4: no hold is committed over a live claim or a peer snapshot', async () => {
  const order = paidOrder();
  const claimed = await armed({
    order, storeHandle: rcStore('object_mismatch', order),
    mem: { conflicts: [1], onConflict: (_c, _a, current) => ({ ...current, emailResendClaimId: 'claim-live', emailResendClaimKind: 'order_confirmation', emailResendClaimAt: new Date(NOW_MS - 1_000).toISOString() }) },
  });
  assert.deepEqual(claimed.outcome, { status: 'blocked', reason: 'claim_active' }, 'HO-3');
  assert.equal(claimed.mem.writes.length, 0);
  const peer = await armed({
    order, storeHandle: rcStore('object_mismatch', order),
    mem: { conflicts: [1], onConflict: (_c, _a, current) => ({ ...current, confirmationEmailState: 'SNAPSHOTTED' } as OrderRecord) },
  });
  assert.deepEqual(peer.outcome, { status: 'blocked', reason: 'awaiting_frozen_dispatch' }, 'HO-4');
  assert.equal(peer.mem.writes.length, 0);
});

test('HO-5: a delivery after a hold is blocked held_for_reconciliation, with no store call', async () => {
  const first = await armed({ order: paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), store: {} });
  assertHeld(first, 'legacy_unresolved', 'legacy_identity_present');
  const store = strictSyntheticStoreIo({});
  const second = await withAmbient({}, () => deliverArmed({ env: writerEnv(), storeIo: store.io, orderIo: first.mem.io, send: throwingTransport().send }));
  assert.deepEqual(second.outcome, { status: 'blocked', reason: 'held_for_reconciliation' });
  assert.equal(store.calls.length, 0);
});

test('HO-7 / SM-4: every committed state comes from the model, which never permits a provider call', () => {
  const source = readRepo('src/lib/confirmation-envelope-producer.ts');
  const calls = [...source.matchAll(/evaluateConfirmationEmailTransition\(\{([^}]*)\}\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
  assert.deepEqual(calls.sort(), [
    "from: null, event: 'claim_acquired', actor: 'worker', legacyClass",
    "from: null, event: 'snapshot_refused', actor: 'worker'",
  ].sort(), 'the model is consulted with exactly the two producer transitions');
  assert.match(source, /confirmationEmailState: decision\.to\b/, 'committed state comes from the decision');
  assert.match(source, /confirmationEmailHoldReason: decision\.holdReason\b/, 'committed hold reason comes from the decision');
  for (const [input, to, holdReason] of [
    [{ from: null, event: 'claim_acquired', actor: 'worker', legacyClass: 'LEGACY_NEVER_DISPATCHED' }, 'SNAPSHOTTED', null],
    [{ from: null, event: 'claim_acquired', actor: 'worker', legacyClass: 'LEGACY_UNRESOLVED' }, 'RECONCILIATION_REQUIRED', 'legacy_unresolved'],
    [{ from: null, event: 'snapshot_refused', actor: 'worker' }, 'RECONCILIATION_REQUIRED', 'snapshot_refused'],
  ] as const) {
    const decision = evaluateConfirmationEmailTransition(input as never);
    assert.equal(decision.allowed, true);
    assert.equal((decision as { to: string }).to, to);
    assert.equal((decision as { holdReason: string | null }).holdReason, holdReason);
    assert.equal((decision as { permitsProviderCall: boolean }).permitsProviderCall, false);
    assert.ok(DECISION_EVENTS.has(input.event));
  }
});

// ══ §S — State model ═══════════════════════════════════════════════════════

test('SM-1 / SM-2: PPDF waits for the frozen dispatcher with the writer armed or off; the producer never runs', async () => {
  const ppdf = paidOrder({ confirmationEmailState: 'PROVABLY_PRE_DISPATCH_FAILED' } as Partial<OrderRecord>);
  const armedRun = await armed({ order: ppdf, store: {} });
  assert.deepEqual(armedRun.outcome, { status: 'blocked', reason: 'awaiting_frozen_dispatch' }, 'SM-1');
  assert.equal(armedRun.store.calls.length, 0);
  assert.equal(armedRun.mem.transactCalls(), 0);
  assert.equal(armedRun.mem.body(), JSON.stringify(ppdf));
  const off = await writerOffGolden(ppdf);
  assert.deepEqual(off.outcome, { status: 'blocked', reason: 'awaiting_frozen_dispatch' }, 'SM-2');
  assert.equal(off.calls, 0);
});

test('SM-3: the producer called directly with PPDF is not_enrolled and evaluates nothing', async () => {
  const ppdf = paidOrder({ confirmationEmailState: 'PROVABLY_PRE_DISPATCH_FAILED' } as Partial<OrderRecord>);
  const mem = memOrderIo([ppdf]);
  const store = strictSyntheticStoreIo({});
  await withAmbient({}, async () => {
    const gate = armedGate(mem.io, store.io);
    const outcome = await producer.snapshotConfirmationEnvelope(ppdf, gate, {
      nowMs: NOW_MS, evaluateClaimability: () => null,
    });
    assert.deepEqual(outcome, { status: 'not_enrolled' });
  });
  assert.equal(store.calls.length, 0);
  assert.equal(mem.transactCalls(), 0);
});

test('SM-5: the producer carries no dispatch vocabulary', () => {
  const source = readRepo('src/lib/confirmation-envelope-producer.ts');
  for (const literal of ['PROVABLY_PRE_DISPATCH_FAILED', 'DISPATCH_INTENT_RECORDED', 'dispatch_intent']) {
    assert.doesNotMatch(source, new RegExp(`'${literal}'`));
  }
  assert.ok(CONFIRMATION_EMAIL_STATES.includes('PROVABLY_PRE_DISPATCH_FAILED'), 'PPDF stays a modelled state (T6 intact)');
});

// ══ §H — Delivery outcomes ═════════════════════════════════════════════════

test('OU-1 / OU-2 / OU-3: delivery returns the typed snapshot outcomes, never sent', async () => {
  const snapshot = await armed();
  assert.deepEqual(snapshot.outcome, { status: 'snapshotted', via: 'committed' }, 'OU-1');
  const held = await armed({ order: paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), store: {} });
  assert.deepEqual(held.outcome, { status: 'held', reason: 'legacy_unresolved' }, 'OU-2');
  const deferred = await armed({ store: { put: ['not_private'] } });
  assert.deepEqual(deferred.outcome, { status: 'snapshot_deferred', reason: 'store_not_private' }, 'OU-3');
});

test('OU-4: a throw inside the producer is snapshot_deferred unexpected, logged by closed code only', async () => {
  const nonFinite = await armed({ now: Number.NaN, store: {} });
  assertDeferred(nonFinite, 'unexpected', 'OU-4 non-finite clock');
  const nonString = await armed({ order: paidOrder({ childName: 42 as unknown as string }), store: {} });
  assertDeferred(nonString, 'unexpected', 'OU-4 non-string record field');
  for (const run of [nonFinite, nonString]) {
    assertSinksClean(run, 'OU-4');
    assert.equal(run.mem.transactCalls(), 0);
    assert.equal(run.store.count('put'), 0);
  }
});

// ══ §V — Privacy ═══════════════════════════════════════════════════════════

test('PV-1 / PV-2: logs and outcomes carry order ids and closed codes only, across every outcome kind', async () => {
  const runs = [
    await armed(),
    await armed({ order: paidOrder({ confirmationEmailFrom: `${CANARY_FROM} <x@example.invalid>` }), store: {} }),
    await armed({ store: { put: ['not_private'] } }),
    await armed({ store: { put: ['fail'], get: ['serve'] } }),
    await armed({ order: paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() }), transport: 'recording' }),
  ];
  for (const run of runs) assertSinksClean(run, JSON.stringify(run.outcome));
});

test('PV-6: the operator projections of post equal those of L* but for updatedAt, plus the eight-key view', async () => {
  const r = await armed();
  const lstar = r.mem.lstar()!;
  mock.timers.enable({ apis: ['Date'], now: NOW_MS });
  try {
    for (const project of [toAdminOrderDetail, toAdminOrderListItem] as const) {
      const after = project(r.post!) as unknown as Record<string, unknown>;
      const before = project({ ...lstar, updatedAt: r.post!.updatedAt } as OrderRecord) as unknown as Record<string, unknown>;
      const { confirmation, ...rest } = after;
      assert.deepEqual(rest, before, `${project.name}: every derived difference is the updatedAt write`);
      assert.deepEqual(Object.keys(confirmation as object).sort(), [
        'accountLabel', 'canonicalBytes', 'canonicalDigest', 'createdAt', 'envelopeVersion', 'orderId', 'purgedAt', 'templateVersion',
      ]);
      assert.deepEqual(sinkLeaks(confirmation).filter((leak) => leak !== 'digest'), []);
      assert.deepEqual(canaryDeltas(before, after), Object.fromEntries(CANARIES.map((c) => [c, 0])), `${project.name}: DTO canary delta`);
    }
  } finally {
    mock.timers.reset();
  }
  const held = await armed({ order: paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), store: {} });
  assert.equal(toAdminOrderDetail(held.post!).confirmation, undefined, 'no confirmation view on a hold');
});

test('PV-7: an SDK error carrying a canary never surfaces', async () => {
  const leak = new BlobError(`LEAK_CANARY ${CANARY_TO} token=${SYNTHETIC_TOKEN}`);
  const r = await armed({ store: { put: [{ error: leak }], get: [{ error: new BlobError('LEAK_CANARY read') }] } });
  assertDeferred(r, 'existing_object_unverified', 'PV-7');
  const everything = JSON.stringify([r.outcome, r.logs, r.errors, r.mem.body(), toAdminOrderDetail(r.mem.record()!)]);
  assert.ok(!everything.includes('LEAK_CANARY'));
  assert.ok(!everything.includes(SYNTHETIC_TOKEN));
});

test('PV-8: the serialized envelope reaches the private put body and no other sink', async () => {
  const r = await armed({ ambient: { NEXT_PUBLIC_URL: URL_A } });
  assertSnapshotted(r, 'committed');
  const body = r.store.calls.find((call) => call.op === 'put')!.body!;
  for (const marker of [CANARY_REPLY, 'CANARY-URL-A-51d2']) assert.ok(body.includes(marker), `the put body carries ${marker}`);
  const sinks = [
    ...r.mem.writes.map((write) => write.body), ...r.logs, ...r.errors, JSON.stringify(r.outcome),
    JSON.stringify(toAdminOrderDetail(r.post!)), JSON.stringify(toAdminOrderListItem(r.post!)),
  ];
  for (const sink of sinks) {
    for (const marker of [CANARY_TEXT, CANARY_REPLY, ...URL_CANARIES]) assert.ok(!sink.includes(marker), `a sink carries ${marker}`);
  }
});

test('PV-10: an unchanged null hold reason and an equal updatedAt are not required to change', async () => {
  const order = paidOrder({ confirmationEmailHoldReason: null, updatedAt: NOW } as Partial<OrderRecord>);
  const snapshot = await armed({ order });
  assertSnapshotted(snapshot, 'committed');
  assert.deepEqual(delta(snapshot.mem.lstar() as never, snapshot.post as never), [
    'confirmationEmailEnvelopeRef', 'confirmationEmailFrom', 'confirmationEmailIdempotencyKey', 'confirmationEmailState',
  ]);
  assertSnapshotCommitPrivacy(snapshot, 'PV-10 snapshot');
  const objectPath = confirmationEnvelopeObjectPath(ORDER_ID, '')!;
  const hold = await armed({ order, store: { objects: { [objectPath]: variantObject(candidateFor(order), () => {}, 1) }, put: ['store'], get: ['serve', 'serve'] } });
  assertHeld(hold, 'snapshot_refused', 'existing_object_mismatch');
  assert.deepEqual(delta(hold.mem.lstar() as never, hold.post as never), ['confirmationEmailHoldReason', 'confirmationEmailState']);
});

// ══ §RI — Environment-free CAS revalidation (integration) ═══════════════════

test('RI-4: a public URL, sender and support address that change between CAS retries change nothing inside the callback', async () => {
  const control = await armed({ ambient: { NEXT_PUBLIC_URL: URL_A }, mem: { conflicts: [2], onConflict: (_c, a, current) => unrelatedEdit(current, a) } });
  assertSnapshotted(control, 'committed', 'RI-4 control');
  for (const rewriteAll of [false, true]) {
    const r = await armed({
      ambient: { NEXT_PUBLIC_URL: URL_A },
      mem: {
        conflicts: [2],
        onConflict: (_c, a, current) => unrelatedEdit(current, a),
        beforeAttempt: (_call, attempt) => {
          if (attempt === 2) setAmbient({ NEXT_PUBLIC_URL: URL_B, ...(rewriteAll ? { HSB_EMAIL_FROM: 'Other <o@example.invalid>', HSB_SUPPORT_EMAIL: 'other@example.invalid' } : {}) });
          if (attempt === 3) setAmbient({ NEXT_PUBLIC_URL: URL_C });
        },
      },
    });
    assertSnapshotted(r, 'committed', `RI-4 rewriteAll=${rewriteAll}`);
    assert.equal(r.mem.latests.length, 3);
    assert.deepEqual(r.post, control.post, 'the decision sequence and its commit equal the no-drift control');
    const body = r.store.calls.find((call) => call.op === 'put')!.body!;
    assert.ok(body.includes('CANARY-URL-A-51d2') && !body.includes('CANARY-URL-B-8e07') && !body.includes('CANARY-URL-C-2af9'));
    const ref = r.post!.confirmationEmailEnvelopeRef as unknown as Record<string, unknown>;
    assert.equal(ref.canonicalDigest, JSON.parse(body).canonicalDigest);
    assert.equal(ref.canonicalBytes, JSON.parse(body).canonicalBytes);
  }
});

test('RI-5: decideSnapshotCommit is deterministic across ambient rewrites, for every evidence kind', () => {
  const order = paidOrder();
  const candidate = candidateFor(order);
  const frame = frameFor(order);
  const kinds: SnapshotEvidence[] = [
    Object.freeze({ kind: 'object_written', candidate }) as SnapshotEvidence,
    Object.freeze({ kind: 'object_verified_equal', candidate }) as SnapshotEvidence,
    Object.freeze({ kind: 'object_mismatch', candidate, refusal: 'object_mismatch' }) as SnapshotEvidence,
    ownBytesEvidence(candidate),
    producer.classifySnapshotFreeze(frame, { ok: false, refusal: 'subject_too_long' }, null) as SnapshotEvidence,
    producer.classifySnapshotFreeze(frame, builtFor(frame, order.email), { ok: false, problem: 'ref_key_set' }) as SnapshotEvidence,
    Object.freeze({ kind: 'legacy_unresolved' }) as SnapshotEvidence,
  ];
  const keys = ['NEXT_PUBLIC_URL', 'HSB_EMAIL_FROM', 'EMAIL_FROM', 'HSB_SUPPORT_EMAIL', 'HSB_BLOB_NAMESPACE', 'VERCEL_ENV'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const evidence of kinds) {
      // First under the very environment the frame was rendered in, then under a rewritten one.
      setAmbient({ ...RENDER_ENV, HSB_BLOB_NAMESPACE: undefined } as AmbientValues);
      const first = producer.decideSnapshotCommit(order, evidence, decisionCtx());
      setAmbient({ NEXT_PUBLIC_URL: URL_B, HSB_EMAIL_FROM: 'b@example.invalid', HSB_SUPPORT_EMAIL: 'b@example.invalid', HSB_BLOB_NAMESPACE: Z, VERCEL_ENV: 'preview' } as AmbientValues);
      process.env.EMAIL_FROM = 'c@example.invalid';
      const second = producer.decideSnapshotCommit(order, evidence, decisionCtx());
      assert.deepEqual(second, first, evidence.kind);
    }
  } finally {
    setAmbient(saved as AmbientValues);
  }
});

test('RI-6 / RI-7: no environment read inside a callback window; one public-URL read per S3, before the put', async () => {
  const scenarios: Array<[string, ArmedOptions, number]> = [
    ['SN-1', {}, 1],
    ['OR-10', { store: { put: ['fail-landed'], get: ['serve', 'serve'] } }, 1],
    ['EN-10', { order: paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), store: {} }, 0],
    ['RC-1', { mem: { conflicts: [1], onConflict: (_c, _a, current) => unrelatedEdit(current, 1) } }, 1],
    ['HO-1', { order: paidOrder({ childName: 'C'.repeat(980) }), store: {} }, 1],
  ];
  for (const [label, options, urlReads] of scenarios) {
    await withEnvRecorder(async (reads) => {
      const r = await armed(options);
      const inCallback = reads.filter((read) => inWindows(read.seq, r.mem.callbackWindows));
      assert.deepEqual(inCallback, [], `${label}: RI-6`);
      const url = readsInLastDelivery(reads).filter((read) => read.key === 'NEXT_PUBLIC_URL');
      assert.equal(url.length, urlReads, `${label}: RI-7 public-URL reads`);
      const put = r.store.calls.find((call) => call.op === 'put');
      if (put) for (const read of url) assert.ok(read.seq < put.seq, `${label}: the render precedes the put`);
      const namespaceReads = readsInLastDelivery(reads).filter((read) => read.key === 'HSB_BLOB_NAMESPACE');
      const inGuards = namespaceReads.filter((read) => inWindows(read.seq, r.mem.guardWindows));
      assert.equal(inGuards.length, r.mem.guardWindows.length, `${label}: one namespace read per guard`);
    });
  }
});

test('RI-7 (OR-9): two concurrent attempts each read the public URL exactly once, before their own put', async () => {
  const order = paidOrder();
  const mem = memOrderIo([order]);
  const store = strictSyntheticStoreIo({ put: ['store', 'store'], get: ['serve', 'serve'] });
  await withEnvRecorder(async (reads) => {
    const windows: Array<{ start: number; end: number }> = [];
    await withAmbient({}, () => Promise.all([NOW_MS, NOW_MS + 5_000].map(async (now) => {
      const window = { start: tick(), end: Number.POSITIVE_INFINITY };
      windows.push(window);
      try {
        return await deliverArmed({ env: writerEnv(), storeIo: store.io, orderIo: mem.io, send: throwingTransport().send, now });
      } finally {
        window.end = tick();
      }
    })));
    const urlReads = reads.filter((read) => read.key === 'NEXT_PUBLIC_URL' && windows.some((w) => read.seq > w.start && read.seq < w.end));
    assert.equal(urlReads.length, 2, 'one render per attempt');
    const puts = store.calls.filter((call) => call.op === 'put');
    assert.equal(puts.length, 2);
    assert.ok(urlReads.every((read) => read.seq < Math.max(...puts.map((put) => put.seq))));
  });
});

test('RI-8: a URL change between the write and the adoption rebuild uses the frozen render', async () => {
  const order = paidOrder();
  const withUrlA = await withAmbient({ NEXT_PUBLIC_URL: URL_A }, async () => {
    const saved = RENDER_ENV.NEXT_PUBLIC_URL;
    (RENDER_ENV as { NEXT_PUBLIC_URL: string }).NEXT_PUBLIC_URL = URL_A;
    try {
      return candidateFor(order).serialized;
    } finally {
      (RENDER_ENV as { NEXT_PUBLIC_URL: string }).NEXT_PUBLIC_URL = saved;
    }
  });
  const r = await armed({
    order,
    ambient: { NEXT_PUBLIC_URL: URL_A },
    store: { objects: { [RC_OBJECT()]: withUrlA }, put: ['store'], get: ['serve', 'serve'], onPut: () => setAmbient({ NEXT_PUBLIC_URL: URL_B }) },
  });
  assertSnapshotted(r, 'adopted_existing_object', 'RI-8');
});

test('RI-9: a URL change across attempts holds existing_object_mismatch (residual R-g), keeping the object', async () => {
  const order = paidOrder();
  const mem = memOrderIo([order], { conflicts: [5] });
  const store = strictSyntheticStoreIo({ put: ['store', 'store'], get: ['serve', 'serve'] });
  const first = await armed({ order, memIo: mem, storeHandle: store, ambient: { NEXT_PUBLIC_URL: URL_A } });
  assertDeferred(first, 'cas_exhausted', 'RI-9 first');
  const stored = store.objects.get(RC_OBJECT())!.toString('utf8');
  const second = await armed({ order, memIo: mem, storeHandle: store, ambient: { NEXT_PUBLIC_URL: URL_B } });
  assertHeld(second, 'snapshot_refused', 'existing_object_mismatch', 'RI-9 second');
  assert.equal(store.objects.get(RC_OBJECT())!.toString('utf8'), stored, 'object bytes unchanged');
});

// ══ Real NBT over nsOrderAdapter: the namespace rows (§N, §ND, §NL) ═══════

/** A storeIo whose members count their reads: W0-8 reads each once, store
 *  construction reads each once more, so `put` read twice means construction. */
function instrumentedStoreIo(base: Record<string, unknown> = strictSyntheticStoreIo({}).io as never) {
  const reads = { put: 0, get: 0, del: 0 };
  const io: Record<string, unknown> = {};
  for (const key of ['put', 'get', 'del'] as const) {
    Object.defineProperty(io, key, { enumerable: true, get() { reads[key] += 1; return base[key]; } });
  }
  return { io, reads, constructed: () => reads.put >= 2 };
}

interface NbtOptions {
  seed: Record<string, string>;
  script?: Omit<NsScript, 'seed'>;
  supplied?: NodeJS.ProcessEnv | null;
  ambient?: AmbientValues;
  storeIo?: unknown;
  store?: ReturnType<typeof strictSyntheticStoreIo>;
  orderIo?: unknown;
  send?: DeliverOrderConfirmationEmailDeps['send'];
  now?: number;
  envelopeWriter?: Record<string, unknown> | null;
}

/** One delivery over the real NBT and nsOrderAdapter, ambient restored after. */
async function nbtDeliver(opts: NbtOptions) {
  const store = opts.store ?? strictSyntheticStoreIo({ put: ['store'] });
  const transport = throwingTransport();
  return withAmbient({ HSB_BLOB_NAMESPACE: A, ...opts.ambient }, async () => {
    const adapter = nsOrderAdapter({ seed: opts.seed, ...opts.script });
    const writer: Record<string, unknown> = opts.envelopeWriter ?? {
      env: opts.supplied === undefined ? writerEnv(A) : opts.supplied,
      storeIo: opts.storeIo ?? store.io,
      ...(opts.orderIo ? { orderIo: opts.orderIo } : {}),
    };
    const logs: string[] = [];
    const errors: string[] = [];
    const ambient = forbiddenAmbientSeams();
    const outcome = await inDelivery(() => deliverOrderConfirmationEmail(ORDER_ID, {
      send: opts.send ?? transport.send,
      now: () => opts.now ?? NOW_MS,
      newClaimId: () => 'claim-synthetic',
      log: (line) => { logs.push(line); },
      errorLog: (line) => { errors.push(line); },
      getOrder: ambient.getOrder,
      transact: ambient.transact,
      ...(opts.envelopeWriter === null ? {} : { envelopeWriter: writer }),
    } as DeliverOrderConfirmationEmailDeps));
    return { outcome, logs, errors, adapter, store, transport, ambient };
  });
}

/** "Zero mutations in both namespaces" (§ND): no successful write, both seeded
 *  bodies byte-identical, every call at the A record path, none at a Z path. */
function assertZeroMutations(run: { adapter: ReturnType<typeof nsOrderAdapter> }, seed: Record<string, string>, label: string) {
  assert.equal(run.adapter.successfulWrites(), 0, `${label}: a write landed`);
  for (const [pathname, body] of Object.entries(seed)) assert.equal(run.adapter.bodyAt(pathname), body, `${label}: ${pathname} changed`);
  assert.deepEqual(run.adapter.nonPathCalls(recordPathIn(A)), [], `${label}: a call left the A record path`);
  assert.equal(run.adapter.zCalls(), 0, `${label}: a Z path was called`);
}

const atA = (run: { adapter: ReturnType<typeof nsOrderAdapter> }) => run.adapter.recordAt(recordPathIn(A));

// ══ §N — One frozen namespace, bound ═══════════════════════════════════════

test('NS-1: under agreement every path, the put and the commit name the frozen namespace (flat and ns-a, write and adoption)', async () => {
  for (const namespace of ['', A]) {
    const order = paidOrder();
    const seed = { [recordPathIn(namespace)]: bodyOf(order), [recordPathIn(Z)]: bodyOf({ ...order, childName: 'Zora' } as OrderRecord) };
    const frozenPath = confirmationEnvelopeObjectPath(ORDER_ID, namespace)!;
    for (const variant of ['write', 'adopt'] as const) {
      const store = variant === 'write'
        ? strictSyntheticStoreIo({ put: ['store'] })
        : strictSyntheticStoreIo({ objects: { [frozenPath]: candidateFor(order, namespace).serialized }, put: ['store'], get: ['serve', 'serve'] });
      const run = await nbtDeliver({ seed, supplied: writerEnv(namespace || undefined), ambient: { HSB_BLOB_NAMESPACE: namespace || undefined }, store });
      assert.deepEqual(run.outcome, { status: 'snapshotted', via: variant === 'write' ? 'committed' : 'adopted_existing_object' }, `${namespace} ${variant}`);
      const puts = store.calls.filter((call) => call.op === 'put');
      assert.equal(puts.length, 1);
      assert.equal(puts[0].pathname, frozenPath);
      for (const get of store.calls.filter((call) => call.op === 'get')) assert.equal(get.pathname, frozenPath);
      const recordPath = recordPathIn(namespace);
      assert.deepEqual(run.adapter.nonPathCalls(recordPath), [], 'every order call at the frozen record path');
      assert.equal(run.adapter.successfulWrites(), 1);
      const committed = run.adapter.recordAt(recordPath)!;
      assert.equal(committed.confirmationEmailState, 'SNAPSHOTTED');
      assert.equal((committed.confirmationEmailEnvelopeRef as unknown as { objectPath: string }).objectPath, frozenPath);
      assert.equal(run.adapter.bodyAt(recordPathIn(Z)), seed[recordPathIn(Z)], 'Z untouched');
      assert.equal(run.transport.calls(), 0);
    }
  }
});

test('NS-2 / NS-3 / NS-4: a W0 disagreement is a no-send refusal before any order read or store construction', async () => {
  const order = paidOrder();
  const seed = seedAZ(order);
  const cases: Array<[string, NodeJS.ProcessEnv, AmbientValues]> = [
    ['NS-2 ambient unset', writerEnv(A), { HSB_BLOB_NAMESPACE: undefined }],
    ['NS-3 flat supplied, ambient ns-b', writerEnv(undefined), { HSB_BLOB_NAMESPACE: B }],
    ['NS-4 ambient preview without a namespace', writerEnv(A), { HSB_BLOB_NAMESPACE: undefined, VERCEL_ENV: 'preview' }],
    ['NS-4 ambient a/b', writerEnv(A), { HSB_BLOB_NAMESPACE: 'a/b' }],
  ];
  for (const [label, supplied, ambient] of cases) {
    const storeIo = instrumentedStoreIo();
    const run = await nbtDeliver({ seed, supplied, ambient, storeIo: storeIo.io });
    assertDeferred(run, 'namespace_disagreement', label);
    assert.equal(run.adapter.calls.length, 0, `${label}: an order read happened`);
    assert.equal(run.ambient.getOrderCalls() + run.ambient.transactCalls(), 0);
    assert.deepEqual(storeIo.reads, { put: 0, get: 0, del: 0 }, `${label}: the store was touched or constructed`);
    assert.equal(run.errors.length, 1);
    assert.ok(!run.errors[0].includes(A) && !run.errors[0].includes('/'), `${label}: the errorLog names a namespace or path`);
    assert.equal(run.transport.calls(), 0);
  }
});

test('NS-5: an invalid supplied namespace is refused namespace_invalid before any ambient namespace read', async () => {
  for (const invalid of [' ns-a', 'a/b']) {
    const storeIo = instrumentedStoreIo();
    const run = await nbtDeliver({ seed: seedAZ(paidOrder()), supplied: writerEnv(invalid), ambient: { HSB_BLOB_NAMESPACE: invalid }, storeIo: storeIo.io });
    assertDeferred(run, 'namespace_invalid', `NS-5 ${JSON.stringify(invalid)}`);
    assert.equal(run.adapter.calls.length, 0);
    assert.deepEqual(storeIo.reads, { put: 0, get: 0, del: 0 }, 'no store touched or constructed');
    assert.equal(run.errors.length, 1);
    assert.equal(run.transport.calls(), 0);
  }
  // The ambient namespace is never consulted: count reads across one delivery.
  await withAmbient({ HSB_BLOB_NAMESPACE: 'a/b' }, async () => {
    await withEnvRecorder(async (reads) => {
      const mem = memOrderIo([paidOrder()]);
      const run = await deliverArmed({ env: writerEnv('a/b'), storeIo: strictSyntheticStoreIo({}).io, orderIo: mem.io, send: throwingTransport().send });
      assertDeferred(run, 'namespace_invalid', 'NS-5 recorder');
      assert.equal(readsInLastDelivery(reads).filter((read) => read.key === 'HSB_BLOB_NAMESPACE').length, 0, 'W0-3 precedes CK-A: no ambient namespace read');
      assert.equal(mem.readCalls(), 0);
    });
  });
});

test('NS-6: the supplied environment is snapshotted once at W0; later changes to it have no effect', async () => {
  const order = paidOrder();
  // (a) The pre-read rewrites the supplied object's namespace, token and flag.
  const supplied = writerEnv(A) as Record<string, string | undefined>;
  const rewriting = {
    read: async (binding: OrderNamespaceBinding, orderId: string) => {
      supplied.HSB_BLOB_NAMESPACE = B;
      delete supplied.HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN;
      supplied.HSB_CONFIRMATION_ENVELOPE_WRITER = 'false';
      return readOrderVersionedInNamespace(binding, orderId);
    },
    transact: withOrderTransactionInNamespace,
  };
  const a = await nbtDeliver({ seed: seedAZ(order), supplied: supplied as NodeJS.ProcessEnv, orderIo: rewriting });
  assert.deepEqual(a.outcome, { status: 'snapshotted', via: 'committed' }, 'NS-6 (a)');
  assert.equal(a.store.calls[0].pathname, confirmationEnvelopeObjectPath(ORDER_ID, A));
  assert.equal(((atA(a)!.confirmationEmailEnvelopeRef) as unknown as { objectPath: string }).objectPath, confirmationEnvelopeObjectPath(ORDER_ID, A));
  assert.deepEqual(a.adapter.nonPathCalls(recordPathIn(A)), []);
  // (b) A proxy that answers ns-a once and ns-b afterwards, recording reads.
  const keyReads: string[] = [];
  let namespaceReads = 0;
  const proxied = new Proxy(writerEnv(A) as Record<string, string | undefined>, {
    get(target, key, receiver) {
      if (typeof key === 'string') keyReads.push(key);
      if (key === 'HSB_BLOB_NAMESPACE') {
        namespaceReads += 1;
        return namespaceReads === 1 ? A : B;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const b = await nbtDeliver({ seed: seedAZ(order), supplied: proxied as NodeJS.ProcessEnv });
  assert.deepEqual(b.outcome, { status: 'snapshotted', via: 'committed' }, 'NS-6 (b)');
  assert.equal(b.store.calls[0].pathname, confirmationEnvelopeObjectPath(ORDER_ID, A));
  const afterFlag = keyReads.slice(1);
  assert.equal(keyReads[0], 'HSB_CONFIRMATION_ENVELOPE_WRITER', 'the flag is read first');
  assert.deepEqual([...afterFlag].sort(), Object.keys(writerEnv(A)).sort(), 'every supplied key read exactly once, by the W0 snapshot');
});

test('NS-7: drift between W0 and the write is refused at CK-B: no put, no transaction', async () => {
  const seed = seedAZ(paidOrder());
  const run = await nbtDeliver({ seed, script: { hook: (op, index) => { if (op === 'readVersioned' && index === 0) setAmbient({ HSB_BLOB_NAMESPACE: Z }); } } });
  assertDeferred(run, 'namespace_drift', 'NS-7');
  assert.equal(run.store.count('put'), 0);
  assert.equal(run.adapter.calls.length, 1, 'only the pre-read');
  assertZeroMutations(run, seed, 'NS-7');
  assert.ok(run.errors.every((line) => !line.includes(Z) && !line.includes(A)));
});

test('NS-8: drift between the write and S6 is refused at CK-C: one put at the frozen path, kept; no transaction', async () => {
  const seed = seedAZ(paidOrder());
  const store = strictSyntheticStoreIo({ put: ['store'], onPut: () => setAmbient({ HSB_BLOB_NAMESPACE: Z }) });
  const run = await nbtDeliver({ seed, store });
  assertDeferred(run, 'namespace_drift', 'NS-8');
  assert.equal(store.count('put'), 1);
  assert.equal(store.calls[0].pathname, confirmationEnvelopeObjectPath(ORDER_ID, A));
  assert.equal(store.objects.size, 1, 'the object is kept');
  assert.equal(store.count('del'), 0);
  assert.equal(run.adapter.calls.length, 1, 'no transaction');
  assertZeroMutations(run, seed, 'NS-8');
});

test('NS-9: drift on the first transaction read is refused by CK-G before any write; a later delivery is refused at W0', async () => {
  const seed = seedAZ(paidOrder());
  const run = await nbtDeliver({ seed, script: { hook: (op, index) => { if (op === 'readVersioned' && index === 1) setAmbient({ HSB_BLOB_NAMESPACE: Z }); } } });
  assertDeferred(run, 'namespace_drift', 'NS-9');
  assert.equal(run.adapter.calls.filter((call) => call.op === 'replaceIfVersion').length, 0, 'no replaceIfVersion in A or Z');
  assertZeroMutations(run, seed, 'NS-9');
  const again = await nbtDeliver({ seed, ambient: { HSB_BLOB_NAMESPACE: Z } });
  assertDeferred(again, 'namespace_disagreement', 'NS-9 second delivery');
  assert.equal(again.adapter.calls.length, 0);
  assert.equal(again.transport.calls(), 0);
});

test('NS-12: ambient namespace reads per attempt are exactly the checkpoints, and none inside a callback', async () => {
  const count = (reads: EnvRead[]) => readsInLastDelivery(reads).filter((read) => read.key === 'HSB_BLOB_NAMESPACE').length;
  // Writer off, through the in-memory writer-off seams.
  await withEnvRecorder(async (reads) => {
    await writerOffGolden(paidOrder());
    assert.equal(count(reads), 0, 'writer off');
  });
  const scenarios: Array<[string, ArmedOptions, number, string]> = [
    ['namespace_invalid', { env: writerEnv('a/b'), store: {} }, 0, 'snapshot_deferred'],
    ['W0 disagreement', { env: writerEnv(A), store: {} }, 1, 'snapshot_deferred'],
    ['committed snapshot', {}, 4, 'snapshotted'],
    ['committed after one conflict', { mem: { conflicts: [1] } }, 5, 'snapshotted'],
    ['legacy_unresolved hold', { order: paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), store: {} }, 3, 'held'],
    ['sent bound continuation', { order: paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() }), store: {}, transport: 'recording' }, 3, 'sent'],
  ];
  for (const [label, options, expected, status] of scenarios) {
    await withEnvRecorder(async (reads) => {
      const r = await armed(options);
      assert.equal((r.outcome as { status: string }).status, status, label);
      assert.equal(count(reads), expected, `${label}: HSB_BLOB_NAMESPACE reads`);
      assert.deepEqual(
        readsInLastDelivery(reads).filter((read) => read.key === 'HSB_BLOB_NAMESPACE' && inWindows(read.seq, r.mem.callbackWindows)),
        [],
        `${label}: a namespace read inside a callback`,
      );
    });
  }
});

test('NS-13: a pre-read issued under a drifted ambient namespace still reads the frozen record path', async () => {
  const seed = seedAZ(paidOrder());
  let readOrder: OrderRecord | null = null;
  const drifting = {
    read: async (binding: OrderNamespaceBinding, orderId: string) => {
      setAmbient({ HSB_BLOB_NAMESPACE: Z });
      const result = await readOrderVersionedInNamespace(binding, orderId);
      readOrder = result.found?.order ?? null;
      return result;
    },
    transact: withOrderTransactionInNamespace,
  };
  const run = await nbtDeliver({ seed, orderIo: drifting });
  assert.equal(run.adapter.calls[0].path, recordPathIn(A));
  assert.equal(readOrder!.childName, CANARY_SUBJ, "A's record, never Z's");
  assertDeferred(run, 'namespace_drift', 'NS-13 (CK-B)');
  assert.equal(run.store.count('put'), 0);
});

// ══ §ND — Adversarial drift after the old checkpoint ═══════════════════════

type NdKind = 'legacy_unresolved' | 'envelope_build_refused' | 'object_mismatch' | 'object_written';

function ndOrder(kind: NdKind): OrderRecord {
  switch (kind) {
    case 'legacy_unresolved': return paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' });
    case 'envelope_build_refused': return paidOrder({ email: `${'x'.repeat(321 - '@example.invalid'.length)}@example.invalid` });
    default: return paidOrder();
  }
}

function ndStore(kind: NdKind, order: OrderRecord) {
  const frozen = confirmationEnvelopeObjectPath(ORDER_ID, A)!;
  if (kind === 'object_written') return strictSyntheticStoreIo({ put: ['store'] });
  if (kind === 'object_mismatch') {
    return strictSyntheticStoreIo({ objects: { [frozen]: variantObject(candidateFor(order, A), () => {}, 1) }, put: ['store'], get: ['serve', 'serve'] });
  }
  return strictSyntheticStoreIo({});
}

/** D1: the first readVersioned inside the S6 transaction (index 1, after the pre-read). */
const D1 = (op: AdapterOp, index: number) => { if (op === 'readVersioned' && index === 1) setAmbient({ HSB_BLOB_NAMESPACE: Z }); };

for (const [id, kind] of [['ND-1', 'legacy_unresolved'], ['ND-2', 'envelope_build_refused'], ['ND-4', 'object_mismatch'], ['ND-8', 'object_written']] as const) {
  test(`${id}: ${kind} evidence with drift after CK-C (D1) mutates nothing in either namespace`, async () => {
    const order = ndOrder(kind);
    const seed = seedAZ(order, { ...order, childName: 'Zora' } as OrderRecord);
    const store = ndStore(kind, order);
    const observed = observedNbt();
    await withEnvRecorder(async (reads) => {
      const run = await nbtDeliver({ seed, store, orderIo: observed.io, script: { hook: D1 } });
      assertDeferred(run, 'namespace_drift', id);
      assertZeroMutations(run, seed, id);
      assert.equal(run.transport.calls(), 0);
      if (kind === 'legacy_unresolved' || kind === 'envelope_build_refused') assert.equal(store.count('put'), 0);
      if (kind === 'object_mismatch') assert.equal(store.objects.size, 1, 'object bytes kept');
      if (kind === 'object_written') assert.equal(store.objects.size, 1, 'the written object is kept (R-a)');
      assert.equal(store.count('del'), 0);
      // ND-14: no environment read inside a callback window.
      assert.deepEqual(reads.filter((read) => inWindows(read.seq, observed.callbackWindows)), [], `${id}: ND-14`);
    });
  });
}

test('ND-6: drift between CAS attempts (D2) is refused by CK-G on the retry, for object_mismatch and legacy_unresolved', async () => {
  for (const kind of ['object_mismatch', 'legacy_unresolved'] as const) {
    const order = ndOrder(kind);
    const seed = seedAZ(order, { ...order, childName: 'Zora' } as OrderRecord);
    const run = await nbtDeliver({
      seed, store: ndStore(kind, order),
      script: { conflictAt: [0, 1], hook: (op, index) => { if (op === 'replaceIfVersion' && index === 0) setAmbient({ HSB_BLOB_NAMESPACE: Z }); } },
    });
    assertDeferred(run, 'namespace_drift', `ND-6 ${kind}`);
    const replaces = run.adapter.calls.filter((call) => call.op === 'replaceIfVersion');
    assert.equal(replaces.length, 1, 'attempt 1 replaced (a conflict, not a mutation); attempt 2 refused before its write');
    assert.equal(replaces[0].result, 'version_conflict');
    assert.equal(run.adapter.calls.filter((call) => call.op === 'readVersioned').length, 3, 'pre-read, attempt 1, attempt 2');
    assertZeroMutations(run, seed, `ND-6 ${kind}`);
  }
});

test('ND-7: conflict exhaustion stays at A; with drift after conflict 3, CK-G refuses attempt 4', async () => {
  const order = ndOrder('legacy_unresolved');
  const seed = seedAZ(order, { ...order, childName: 'Zora' } as OrderRecord);
  const exhausted = await nbtDeliver({ seed, script: { conflictAt: [0, 1, 2, 3, 4] } });
  assertDeferred(exhausted, 'cas_exhausted', 'ND-7 (a)');
  assert.equal(exhausted.adapter.calls.filter((call) => call.op === 'readVersioned').length, 6, 'pre-read + 5');
  assert.equal(exhausted.adapter.calls.filter((call) => call.op === 'replaceIfVersion').length, 5);
  assertZeroMutations(exhausted, seed, 'ND-7 (a)');
  const drifted = await nbtDeliver({
    seed,
    script: { conflictAt: [0, 1, 2, 3, 4], hook: (op, index) => { if (op === 'replaceIfVersion' && index === 2) setAmbient({ HSB_BLOB_NAMESPACE: Z }); } },
  });
  assertDeferred(drifted, 'namespace_drift', 'ND-7 (b)');
  assert.equal(drifted.adapter.calls.filter((call) => call.op === 'readVersioned').length, 5, 'pre-read + 4');
  assert.equal(drifted.adapter.calls.filter((call) => call.op === 'replaceIfVersion').length, 3);
  assertZeroMutations(drifted, seed, 'ND-7 (b)');
});

test('ND-10 / ND-11: drift after CK-G returned (D3) lands exactly one write, at A only, reported truthfully (R-l)', async () => {
  for (const [id, kind, expected] of [
    ['ND-10', 'object_written', { status: 'snapshotted', via: 'committed' }],
    ['ND-11', 'legacy_unresolved', { status: 'held', reason: 'legacy_unresolved' }],
  ] as const) {
    const order = ndOrder(kind);
    const seed = seedAZ(order, { ...order, childName: 'Zora' } as OrderRecord);
    const run = await nbtDeliver({ seed, store: ndStore(kind, order), script: { hook: (op) => { if (op === 'replaceIfVersion') setAmbient({ HSB_BLOB_NAMESPACE: Z }); } } });
    assert.deepEqual(run.outcome, expected, id);
    assert.equal(run.adapter.successfulWrites(), 1, `${id}: exactly one write`);
    assert.deepEqual(run.adapter.nonPathCalls(recordPathIn(A)), [], `${id}: A only`);
    assert.equal(run.adapter.bodyAt(recordPathIn(Z)), seed[recordPathIn(Z)], `${id}: Z untouched`);
    assert.equal(run.adapter.zCalls(), 0);
  }
});

test('ND-12: retries issued under a drifted ambient namespace stay at the frozen path; the binding, not the checkpoints', async () => {
  const order = paidOrder();
  const seed = seedAZ(order);
  const run = await nbtDeliver({
    seed,
    script: {
      conflictAt: [0, 1, 2],
      hook: (op, index) => {
        if (op === 'replaceIfVersion' && index < 3) setAmbient({ HSB_BLOB_NAMESPACE: Z });
        // Restore only after the following read was issued under ambient Z.
        if (op === 'readVersioned' && index >= 2) setAmbient({ HSB_BLOB_NAMESPACE: A });
      },
    },
  });
  assert.deepEqual(run.outcome, { status: 'snapshotted', via: 'committed' });
  const transactional = run.adapter.calls.slice(1);
  assert.equal(transactional.filter((call) => call.op === 'readVersioned').length, 4);
  assert.equal(transactional.filter((call) => call.op === 'replaceIfVersion').length, 4);
  assert.deepEqual(run.adapter.nonPathCalls(recordPathIn(A)), []);
  assert.equal(run.adapter.zCalls(), 0, 'Z never called');
  assert.equal(run.adapter.successfulWrites(), 1);
});

test('ND-14: under drift the decision is unchanged, reads no environment, and the guard alone reads the namespace', async () => {
  for (const kind of ['legacy_unresolved', 'object_mismatch', 'object_written'] as const) {
    const order = ndOrder(kind);
    const seed = seedAZ(order, { ...order, childName: 'Zora' } as OrderRecord);
    const control = observedNbt();
    const controlRun = await nbtDeliver({ seed, store: ndStore(kind, order), orderIo: control.io, script: { hook: (op) => { if (op === 'replaceIfVersion') throw new Error('control: stop before the write'); } } });
    void controlRun;
    const drifted = observedNbt();
    await withEnvRecorder(async (reads) => {
      const run = await nbtDeliver({ seed, store: ndStore(kind, order), orderIo: drifted.io, script: { hook: D1 } });
      assertDeferred(run, 'namespace_drift', `ND-14 ${kind}`);
      const inDeliveryReads = readsInLastDelivery(reads);
      assert.deepEqual(inDeliveryReads.filter((read) => inWindows(read.seq, drifted.callbackWindows)), [], `${kind}: a read inside a callback`);
      const transactionWindow = { start: drifted.callbackWindows[0].start, end: Number.POSITIVE_INFINITY };
      const namespaceReadsInS6 = inDeliveryReads.filter((read) => read.key === 'HSB_BLOB_NAMESPACE' && read.seq > transactionWindow.start);
      assert.ok(namespaceReadsInS6.length > 0);
      for (const read of namespaceReadsInS6) assert.ok(inWindows(read.seq, drifted.guardWindows), `${kind}: a namespace read outside a guard window`);
    });
    assert.deepEqual(drifted.decisions, control.decisions.slice(0, drifted.decisions.length), `${kind}: the decision sequence equals the no-drift control`);
  }
  // The decision itself, called twice across a namespace flip, is deep-equal.
  const order = paidOrder();
  const evidence = Object.freeze({ kind: 'object_written', candidate: candidateFor(order, A) }) as SnapshotEvidence;
  const saved = process.env.HSB_BLOB_NAMESPACE;
  try {
    process.env.HSB_BLOB_NAMESPACE = A;
    const first = producer.decideSnapshotCommit(order, evidence, decisionCtx());
    process.env.HSB_BLOB_NAMESPACE = Z;
    assert.deepEqual(producer.decideSnapshotCommit(order, evidence, decisionCtx()), first);
  } finally {
    if (saved === undefined) delete process.env.HSB_BLOB_NAMESPACE;
    else process.env.HSB_BLOB_NAMESPACE = saved;
  }
});

describe('stage seam: S6 under namespace drift (counted separately)', () => {
  async function stageDrift(kind: string, drift: 'D1' | 'D2') {
    const legacy = kind === 'legacy_unresolved';
    const order = legacy ? paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }) : paidOrder();
    const seed = seedAZ(order, { ...order, childName: 'Zora' } as OrderRecord);
    const candidate = candidateFor(order, A);
    const frame = frameFor(order, A);
    const evidence: Record<string, SnapshotEvidence> = {
      object_written: Object.freeze({ kind: 'object_written', candidate }) as SnapshotEvidence,
      object_verified_equal: Object.freeze({ kind: 'object_verified_equal', candidate }) as SnapshotEvidence,
      object_mismatch: Object.freeze({ kind: 'object_mismatch', candidate, refusal: 'object_mismatch' }) as SnapshotEvidence,
      own_bytes_refused: ownBytesEvidence(candidate),
      envelope_build_refused: producer.classifySnapshotFreeze(frame, { ok: false, refusal: 'to_too_long' }, null) as SnapshotEvidence,
      ref_invalid: producer.classifySnapshotFreeze(frame, builtFor(frame, order.email), { ok: false, problem: 'ref_object_path' }) as SnapshotEvidence,
      legacy_unresolved: Object.freeze({ kind: 'legacy_unresolved' }) as SnapshotEvidence,
    };
    return withAmbient({ HSB_BLOB_NAMESPACE: A }, async () => {
      const adapter = nsOrderAdapter({
        seed,
        ...(drift === 'D1'
          ? { hook: (op: AdapterOp, index: number) => { if (op === 'readVersioned' && index === 0) setAmbient({ HSB_BLOB_NAMESPACE: Z }); } }
          : { conflictAt: [0], hook: (op: AdapterOp, index: number) => { if (op === 'replaceIfVersion' && index === 0) setAmbient({ HSB_BLOB_NAMESPACE: Z }); } }),
      });
      const gate = armedGate(undefined, strictSyntheticStoreIo({}).io, A);
      const result = await producer.runSnapshotCommitStage(ORDER_ID, evidence[kind], decisionCtx(), gate);
      return { result, adapter, seed };
    });
  }

  for (const [id, kind] of [['ND-3', 'ref_invalid'], ['ND-5', 'own_bytes_refused']] as const) {
    test(`[stage seam] ${id}: ${kind} evidence with drift after CK-C (D1) mutates nothing`, async () => {
      const { result, adapter, seed } = await stageDrift(kind, 'D1');
      assert.deepEqual(result, { status: 'snapshot_deferred', reason: 'namespace_drift' });
      assertZeroMutations({ adapter }, seed, id);
    });
  }

  test('[stage seam] ND-9: every evidence kind × {D1, D2} mutates nothing, with identical call shapes', async () => {
    const shapes: Record<string, string[]> = {};
    for (const drift of ['D1', 'D2'] as const) {
      for (const kind of ['object_written', 'object_verified_equal', 'object_mismatch', 'own_bytes_refused', 'envelope_build_refused', 'ref_invalid', 'legacy_unresolved']) {
        const { result, adapter, seed } = await stageDrift(kind, drift);
        assert.deepEqual(result, { status: 'snapshot_deferred', reason: 'namespace_drift' }, `${kind} ${drift}`);
        assertZeroMutations({ adapter }, seed, `ND-9 ${kind} ${drift}`);
        const shape = adapter.calls.map((call) => `${call.op}:${call.path}`);
        (shapes[drift] ??= []).push(JSON.stringify(shape));
      }
      assert.equal(new Set(shapes[drift]).size, 1, `${drift}: ref-bearing and ref-less cells share one call shape`);
    }
  });
});

describe('defensive refusal handling (synthetic seam; not integration) — provenance', () => {
  const badNamespace = (_op: 'read' | 'transact', _i: number, p: Record<string, unknown>) => ({ ...p, namespace: Z });
  test('[defensive seam] ND-13: a provenance naming another namespace defers transaction_provenance_mismatch — pre-read, hold, snapshot', async () => {
    const preRead = await armed({ mem: { provenance: (op, i, p) => (op === 'read' ? badNamespace(op, i, p) : p) }, store: {} });
    assertDeferred(preRead, 'transaction_provenance_mismatch', 'ND-13 (a)');
    const hold = await armed({ order: paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), mem: { provenance: (op, i, p) => (op === 'transact' ? badNamespace(op, i, p) : p) }, store: {} });
    assertDeferred(hold, 'transaction_provenance_mismatch', 'ND-13 (b)');
    const snapshot = await armed({ mem: { provenance: (op, i, p) => (op === 'transact' ? { ...p, readPaths: [recordPathIn(Z)] } : p) } });
    assertDeferred(snapshot, 'transaction_provenance_mismatch', 'ND-13 (c)');
    for (const run of [preRead, hold, snapshot]) assert.equal(run.transport.calls(), 0);
    assert.equal(preRead.mem.transactCalls(), 0, 'the producer performs no further write after a mismatch');
  });

  test('[defensive seam] ND-15 (b): found null with outcome read is a mismatch, not order_not_found', async () => {
    const r = await armed({
      mem: { readResult: (value) => ({ found: null, provenance: { ...(value.provenance as object), outcome: 'read' } }) },
      store: {},
    });
    assertDeferred(r, 'transaction_provenance_mismatch', 'ND-15 (b)');
    assert.equal(r.mem.transactCalls(), 0);
    assert.equal(r.transport.calls(), 0);
  });

  test('[defensive seam] ND-16 (b): a found record with outcome not_found is a mismatch, and the record is never used', async () => {
    const r = await armed({
      mem: { readResult: (value) => ({ found: value.found, provenance: { ...(value.provenance as object), outcome: 'not_found' } }) },
      store: {},
    });
    assertDeferred(r, 'transaction_provenance_mismatch', 'ND-16 (b)');
    assert.equal(r.mem.transactCalls(), 0, 'the record was never used');
    assert.equal(r.store.calls.length, 0);
    assert.equal(r.transport.calls(), 0);
  });

  test('[defensive seam] NL-13: a bound continuation with mismatching provenance on the pre-read or the claim never sends', async () => {
    const legacyOrder = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
    const preRead = await armed({ order: legacyOrder, mem: { provenance: (op, i, p) => (op === 'read' ? badNamespace(op, i, p) : p) }, store: {} });
    assertDeferred(preRead, 'transaction_provenance_mismatch', 'NL-13 (a)');
    const claim = await armed({ order: legacyOrder, mem: { provenance: (op, i, p) => (op === 'transact' ? { ...p, recordPath: recordPathIn(Z) } : p) }, store: {} });
    assertDeferred(claim, 'transaction_provenance_mismatch', 'NL-13 (b)');
    assert.equal(preRead.transport.calls() + claim.transport.calls(), 0);
  });

  test('[defensive seam] NL-14: a receipt with mismatching provenance after an accepted send is receipt_unrecorded/write_failed', async () => {
    const legacyOrder = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
    const r = await armed({ order: legacyOrder, transport: 'recording', store: {}, mem: { provenance: (op, i, p) => (op === 'transact' && i >= 1 ? { ...p, namespace: Z } : p) } });
    assert.deepEqual(r.outcome, { status: 'receipt_unrecorded', reason: 'write_failed' });
    assert.equal(r.transport.calls(), 1);
    assert.ok(r.errors.includes(`[confirmation-email] receipt write failed orderId=${ORDER_ID} providerMessageId=msg_synthetic errorClass=ConfirmationOrderNamespaceError`), JSON.stringify(r.errors));
    assert.ok(r.errors.includes(`[confirmation-email] claim release failed orderId=${ORDER_ID} after=receipt_write_failed errorClass=ConfirmationOrderNamespaceError`), 'the bound release was attempted and its failure logged');
    assert.equal(r.mem.transactCalls(), 3, 'claim, receipt, release');
  });
});

// ══ §NL — Armed-intent legacy continuation, kickoff and sweep ══════════════

test('NL-1: writer off follows the ambient namespace at every call, exactly as before (R-o, regression control)', async () => {
  const order = paidOrder();
  const seed = seedAZ(order);
  const transport = recordingTransport();
  const logs: string[] = [];
  const outcome = await withAmbient({
    HSB_BLOB_NAMESPACE: A, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_SYNTHETICorder01_SYNTHETICsecret000002', HSB_BLOB_ACCESS_MODE: 'private',
  }, async () => {
    const adapter = nsOrderAdapter({ seed, hook: (op, index) => { if (op === 'readVersioned' && index === 0) setAmbient({ HSB_BLOB_NAMESPACE: Z }); } });
    const result = await deliverOrderConfirmationEmail(ORDER_ID, {
      send: transport.send, now: () => NOW_MS, newClaimId: () => 'claim-synthetic', log: (l) => { logs.push(l); }, errorLog: (l) => { logs.push(l); },
    });
    assert.deepEqual(adapter.calls.map((call) => `${call.op}:${call.path}`), [
      `readVersioned:${recordPathIn(A)}`,
      `readVersioned:${recordPathIn(Z)}`,
      `replaceIfVersion:${recordPathIn(Z)}`,
      `replaceIfVersion:${recordPathIn(Z)}`,
    ], 'the ambient API follows the ambient namespace at every call');
    return result;
  });
  assert.deepEqual(outcome, { status: 'sent' });
  assert.equal(transport.calls(), 1);
  assert.deepEqual(logs, [`[confirmation-email] delivered orderId=${ORDER_ID} providerMessageId=msg_synthetic`]);
});

test('NL-2 / NL-3 / NL-4: under armed intent a namespace refusal wins over every other fault, with no read and no send', async () => {
  const seed = seedAZ(paidOrder());
  const cases: Array<[string, NodeJS.ProcessEnv, AmbientValues, string, Record<string, unknown> | undefined]> = [
    ['NL-2 disagreement', writerEnv(A), { HSB_BLOB_NAMESPACE: Z }, 'namespace_disagreement', undefined],
    ['NL-3 unresolvable', writerEnv('a/b'), { HSB_BLOB_NAMESPACE: A }, 'namespace_invalid', undefined],
    ['NL-4 + VERCEL=1', writerEnv(A, { VERCEL: '1' }), { HSB_BLOB_NAMESPACE: Z, VERCEL: '1' }, 'namespace_disagreement', undefined],
    ['NL-4 + epoch missing', writerEnv(A, { HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: undefined }), { HSB_BLOB_NAMESPACE: Z }, 'namespace_disagreement', undefined],
    ['NL-4 + storeIo absent', writerEnv(A), { HSB_BLOB_NAMESPACE: Z }, 'namespace_disagreement', { env: writerEnv(A) }],
  ];
  for (const [label, supplied, ambient, reason, writer] of cases) {
    const run = await nbtDeliver({ seed, supplied, ambient, envelopeWriter: writer });
    assertDeferred(run, reason, label);
    assert.equal(run.adapter.calls.length, 0, `${label}: an order read`);
    assert.equal(run.store.calls.length, 0);
    assert.equal(run.transport.calls(), 0);
    assertZeroMutations(run, seed, label);
  }
});

test('NL-5 / NL-17: the activation interlock disarms to the bound legacy continuation at the A path', async () => {
  const order = paidOrder();
  const seed = seedAZ(order);
  const transport = recordingTransport();
  const run = await nbtDeliver({ seed, supplied: writerEnv(A, { VERCEL: '1' }), ambient: { VERCEL: '1' }, send: transport.send });
  assert.deepEqual(run.outcome, { status: 'sent' }, 'NL-5');
  assert.equal(transport.calls(), 1);
  assert.deepEqual(run.errors, [`[confirmation-envelope] writer disarmed orderId=${ORDER_ID} reason=activation_interlock`]);
  assert.deepEqual(run.adapter.nonPathCalls(recordPathIn(A)), [], 'pre-read, claim and receipt at A');
  assert.equal(run.adapter.bodyAt(recordPathIn(Z)), seed[recordPathIn(Z)]);
  assert.equal(run.store.calls.length, 0);
  const golden = await writerOffGolden(order);
  assert.deepEqual(atA(run), golden.post, 'A-record deltas equal the writer-off golden');
  // NL-17: a missing order under the same disarmed intent.
  const missing = await nbtDeliver({ seed: { [recordPathIn(Z)]: seed[recordPathIn(Z)] }, supplied: writerEnv(A, { VERCEL: '1' }), ambient: { VERCEL: '1' } });
  assert.deepEqual(missing.outcome, { status: 'blocked', reason: 'order_not_found' }, 'NL-17');
  assert.deepEqual(missing.errors, [`[confirmation-envelope] writer disarmed orderId=${ORDER_ID} reason=activation_interlock`]);
  assert.equal(missing.adapter.successfulWrites(), 0);
  assert.equal(missing.adapter.zCalls(), 0);
  assert.equal(missing.transport.calls(), 0);
});

test('NL-6: an armed, not-enrolled order takes the bound legacy continuation, re-using the S0 read', async () => {
  const order = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  const seed = seedAZ(order);
  const transport = recordingTransport();
  const observed = observedNbt();
  const run = await nbtDeliver({ seed, send: transport.send, orderIo: observed.io });
  assert.deepEqual(run.outcome, { status: 'sent' });
  assert.equal(observed.reads(), 1, 'one pre-read');
  assert.deepEqual(run.adapter.nonPathCalls(recordPathIn(A)), []);
  assert.equal(transport.calls(), 1);
  assert.equal(run.store.calls.length, 0);
});

test('NL-7: drift on the claim transaction read is refused by CK-G — no claim written anywhere', async () => {
  const order = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  const seed = seedAZ(order);
  const run = await nbtDeliver({ seed, script: { hook: D1 } });
  assertDeferred(run, 'namespace_drift', 'NL-7');
  assertZeroMutations(run, seed, 'NL-7');
  assert.equal(run.transport.calls(), 0);
});

/** NL-8: the CK-T scenario, shared with NL-11 and NL-15. */
async function ckTDrift(seed: Record<string, string>) {
  const observed = observedNbt();
  let claimWriteSeq = 0;
  const run = await nbtDeliver({
    seed, orderIo: observed.io,
    script: { hook: (op) => { if (op === 'replaceIfVersion') { claimWriteSeq = SEQ; setAmbient({ HSB_BLOB_NAMESPACE: Z }); } } },
  });
  return { run, observed, claimWriteSeq };
}

test('NL-8: drift observed at CK-T sends nothing and writes nothing further; the claim stays (CD-2)', async () => {
  const order = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  const seed = seedAZ(order);
  const { run, observed, claimWriteSeq } = await ckTDrift(seed);
  assertDeferred(run, 'namespace_drift', 'NL-8');
  assert.equal(run.adapter.successfulWrites(), 1, 'the claim, and nothing after it');
  assert.equal(run.adapter.calls.filter((call) => call.seq > claimWriteSeq + 1).length, 0, 'no adapter call after CK-T');
  assert.equal(observed.postTransport(), 0, 'no release and no receipt transaction');
  assert.equal(run.transport.calls(), 0);
  assert.deepEqual(run.adapter.nonPathCalls(recordPathIn(A)), [], 'every call at the A record path');
  assert.equal(run.adapter.bodyAt(recordPathIn(Z)), seed[recordPathIn(Z)], 'Z untouched');
  const record = atA(run)!;
  assert.equal(record.emailResendClaimId, 'claim-synthetic');
  assert.equal(record.emailResendClaimKind, 'order_confirmation');
  assert.equal(record.emailResendClaimAt, NOW);
  assert.equal(record.confirmationEmailSentAt ?? null, null);
  assert.deepEqual(run.errors, [`[confirmation-envelope] deferred orderId=${ORDER_ID} reason=namespace_drift`]);
});

test('NL-15: after CK-T drift the order waits for the stale-claim window, then is taken over at A exactly once', async () => {
  const order = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  const seed = seedAZ(order);
  const { run } = await ckTDrift(seed);
  assertDeferred(run, 'namespace_drift');
  const afterCkT = { [recordPathIn(A)]: run.adapter.bodyAt(recordPathIn(A))!, [recordPathIn(Z)]: seed[recordPathIn(Z)] };
  // (a) Inside the window: blocked, and the sweep finds it ineligible.
  const inside = await nbtDeliver({ seed: afterCkT, now: NOW_MS + 60_000 });
  assert.deepEqual(inside.outcome, { status: 'blocked', reason: 'claim_active' }, 'NL-15 (a)');
  assert.equal(inside.adapter.successfulWrites(), 0);
  assert.equal(inside.transport.calls(), 0);
  let swept = 0;
  await withAmbient({ HSB_BLOB_NAMESPACE: A }, () => runConfirmationEmailSweep({
    listOrders: async () => [JSON.parse(afterCkT[recordPathIn(A)]) as OrderRecord],
    deliver: async () => { swept += 1; return { status: 'sent' }; },
    now: () => NOW_MS + 60_000, graceMs: 15 * 60 * 1000, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: Date.parse(FLOOR), log: () => {}, errorLog: () => {},
  }));
  assert.equal(swept, 0, 'the sweep finds the order ineligible inside the window');
  // (b) After the window: a fresh W0, the bound claim takes over at A.
  const transport = recordingTransport();
  const after = await nbtDeliver({ seed: afterCkT, now: Date.parse(NOW) + CONFIRMATION_EMAIL_CLAIM_STALE_MS + 1, send: transport.send });
  assert.deepEqual(after.outcome, { status: 'sent' }, 'NL-15 (b)');
  assert.equal(transport.calls(), 1, 'exactly one send');
  const final = atA(after)!;
  assert.ok(final.confirmationEmailSentAt, 'receipt at A');
  assert.equal(final.confirmationEmailFrom, (JSON.parse(afterCkT[recordPathIn(A)]) as OrderRecord).confirmationEmailFrom, 'frozen identity carried forward');
  assert.equal(after.adapter.bodyAt(recordPathIn(Z)), seed[recordPathIn(Z)], 'Z untouched throughout');
});

test('NL-9: drift during the send does not move the receipt: it commits at A, unguarded', async () => {
  const order = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  const seed = seedAZ(order);
  const transport = recordingTransport(() => setAmbient({ HSB_BLOB_NAMESPACE: Z }));
  const run = await nbtDeliver({ seed, send: transport.send });
  assert.deepEqual(run.outcome, { status: 'sent' });
  assert.ok(atA(run)!.confirmationEmailSentAt, 'receipt at A');
  assert.equal(run.adapter.bodyAt(recordPathIn(Z)), seed[recordPathIn(Z)]);
  assert.equal(run.adapter.zCalls(), 0);
});

test('NL-10: under armed intent the ambient getOrder and transact seams are never called; writer off uses them as today', async () => {
  const enrolledOff = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  for (const [label, ambient] of [['NL-5 setup', { VERCEL: '1' }], ['NL-6 setup', {}]] as const) {
    const run = await armed({
      order: label === 'NL-6 setup' ? enrolledOff : paidOrder(), env: writerEnv(undefined, ambient), ambient, transport: 'recording', store: {},
    });
    assert.deepEqual(run.outcome, { status: 'sent' }, label);
    assert.equal(run.ambient.getOrderCalls(), 0, `${label}: getOrder`);
    assert.equal(run.ambient.transactCalls(), 0, `${label}: transact`);
  }
  let getOrderCalls = 0;
  let transactCalls = 0;
  const cells = new Map([[ORDER_ID, JSON.stringify(enrolledOff)]]);
  const outcome = await withAmbient({}, () => deliverOrderConfirmationEmail(ORDER_ID, {
    send: recordingTransport().send, now: () => NOW_MS, log: () => {}, errorLog: () => {},
    getOrder: async (id) => { getOrderCalls += 1; return JSON.parse(cells.get(id)!); },
    transact: (async (id: string, mutate: (o: OrderRecord) => { abort?: unknown; commit?: OrderRecord; result?: unknown }) => {
      transactCalls += 1;
      const decided = mutate(JSON.parse(cells.get(id)!));
      if ('abort' in decided) return decided.abort;
      cells.set(id, JSON.stringify(decided.commit));
      return decided.result;
    }) as DeliverOrderConfirmationEmailDeps['transact'],
  }));
  assert.deepEqual(outcome, { status: 'sent' });
  assert.deepEqual([getOrderCalls, transactCalls], [1, 2], 'writer off: one read, the claim and the receipt');
});

function runKickoff(order: OrderRecord, scheduler: 'setImmediate' | 'after', deps: Record<string, unknown>) {
  const queue: Array<() => void | Promise<void>> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  scheduleOrderConfirmationEmail(order, {
    setImmediateImpl: (cb: () => void) => { if (scheduler === 'setImmediate') queue.push(cb); return null; },
    afterImpl: scheduler === 'after' ? (cb: () => void | Promise<void>) => { queue.push(cb); } : null,
    log: (line: string) => { logs.push(line); },
    errorLog: (line: string) => { errors.push(line); },
    ...deps,
  } as never);
  return { queue, logs, errors };
}

async function settle(check: () => boolean, label: string) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out: ${label}`);
}

test('NL-11: both kickoff schedulers report namespace refusals as deferrals and clear the in-flight entry', async () => {
  for (const scheduler of ['setImmediate', 'after'] as const) {
    for (const [label, reason, ambient, order] of [
      ['NL-2', 'namespace_disagreement', { HSB_BLOB_NAMESPACE: Z }, paidOrder()],
      ['NL-8', 'namespace_drift', {}, paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() })],
    ] as const) {
      _resetConfirmationEmailInFlightForTest();
      const seed = seedAZ(order);
      const transport = throwingTransport();
      await withAmbient({ HSB_BLOB_NAMESPACE: A, ...ambient }, async () => {
        nsOrderAdapter({ seed, hook: (op) => { if (op === 'replaceIfVersion') setAmbient({ HSB_BLOB_NAMESPACE: Z }); } });
        const deps = { send: transport.send, envelopeWriter: { env: writerEnv(A), storeIo: strictSyntheticStoreIo({}).io } };
        const first = runKickoff(order, scheduler, deps);
        await first.queue.shift()!();
        await settle(() => first.errors.length > 0, `${label} ${scheduler}`);
        assert.deepEqual(first.errors.filter((l) => l.startsWith('[confirmation-email]')), [
          `[confirmation-email] ${scheduler} failed for ${ORDER_ID} reason=confirmation_email_snapshot_deferred:${reason}`,
        ], `${label} ${scheduler}`);
        // The in-flight entry was cleared: a second schedule runs a fresh delivery rather than joining.
        setAmbient({ HSB_BLOB_NAMESPACE: Z });
        const second = runKickoff(order, scheduler, deps);
        await second.queue.shift()!();
        await settle(() => second.errors.length > 0, `${label} ${scheduler} second`);
        assert.ok(!second.logs.some((l) => l.includes('joining existing send')), 'the in-flight entry was cleared');
      });
      assert.equal(transport.calls(), 0);
    }
  }
});

test('NL-12: a sweep under W0 disagreement defers every listed order with no delivery read and no send', async () => {
  const orders = [idOf('f1'), idOf('f2'), idOf('f3')].map((id) => paidOrder({ paidAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString() }, id));
  const mem = memOrderIo(orders);
  mem.reseed(A);
  const transport = throwingTransport();
  const errors: string[] = [];
  const result = await withAmbient({ HSB_BLOB_NAMESPACE: Z }, () => runConfirmationEmailSweep({
    listOrders: async () => orders,
    deliver: (orderId) => deliverOrderConfirmationEmail(orderId, {
      send: transport.send, now: () => NOW_MS, log: () => {}, errorLog: (l) => { errors.push(l); },
      envelopeWriter: { env: writerEnv(A), storeIo: strictSyntheticStoreIo({}).io, orderIo: mem.io },
    } as DeliverOrderConfirmationEmailDeps),
    now: () => NOW_MS, graceMs: 15 * 60 * 1000, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
    activationPaidAtMs: Date.parse(FLOOR), log: () => {}, errorLog: (l) => { errors.push(l); },
  }));
  assert.equal(result.deferred, 3);
  assert.equal(result.sent, 0);
  assert.equal(result.ok, false);
  assert.equal(mem.readCalls() + mem.transactCalls(), 0, 'no delivery order read');
  assert.equal(transport.calls(), 0);
  for (const order of orders) {
    assert.equal(errors.filter((l) => l === `[confirmation-email-sweep] deferred orderId=${order.id} reason=namespace_disagreement`).length, 1);
  }
});

test('NL-16: a missing order under an armed writer is blocked/order_not_found — no false provenance alarm', async () => {
  const seed = { [recordPathIn(Z)]: bodyOf(paidOrder()) };
  const run = await nbtDeliver({ seed });
  assert.deepEqual(run.outcome, { status: 'blocked', reason: 'order_not_found' });
  assert.equal(run.adapter.successfulWrites(), 0);
  assert.equal(run.adapter.zCalls(), 0, 'Z never called');
  assert.equal(run.transport.calls(), 0);
  assert.equal(run.store.calls.length, 0);
  assert.deepEqual(run.errors, [], 'no deferral and no provenance errorLog');
});

// ══ §C — Configuration at run time (through delivery) ══════════════════════

test('CF-9: VERCEL=1 with a valid armed configuration disarms to the bound legacy continuation, equal to the golden', async () => {
  const order = paidOrder();
  // The interlock reads the frozen supplied environment (W0-7); on a Vercel
  // deployment the ambient environment, which a default caller supplies, carries it.
  const r = await armed({ order, env: writerEnv(undefined, { VERCEL: '1' }), ambient: { VERCEL: '1' }, transport: 'recording' });
  assert.deepEqual(r.outcome, { status: 'sent' });
  assert.deepEqual(r.errors, [`[confirmation-envelope] writer disarmed orderId=${ORDER_ID} reason=activation_interlock`]);
  await assertLegacyParity(r, order, 'CF-9');
});

test('CF-13: store credential refusals disarm to the bound legacy continuation with no store call', async () => {
  for (const [reason, env] of [
    ['store_unconfigured', writerEnv(undefined, { HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: undefined })],
    ['store_not_dedicated', writerEnv(undefined, { HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: 'nope' })],
    ['store_not_dedicated', writerEnv(undefined, { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_SYNTHETICenvStore01_SYNTHETICother00002' })],
  ] as const) {
    const order = paidOrder();
    const r = await armed({ order, env, transport: 'recording' });
    assert.deepEqual(r.outcome, { status: 'sent' }, reason);
    assert.deepEqual(r.errors, [`[confirmation-envelope] writer disarmed orderId=${ORDER_ID} reason=${reason}`]);
    await assertLegacyParity(r, order, `CF-13 ${reason}`);
  }
});

test('CF-15: no injected storeIo — or no envelopeWriter at all — is store_io_not_injected, with no store construction', async () => {
  const order = paidOrder();
  const seed = seedAZ(order);
  const golden = await writerOffGolden(order);
  // (a) The flag in the ambient environment, envelopeWriter absent: real NBT.
  const ambientFlag = await nbtDeliver({
    seed, envelopeWriter: null, send: recordingTransport().send,
    ambient: { HSB_CONFIRMATION_ENVELOPE_WRITER: 'true', HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: EPOCH, HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: SYNTHETIC_TOKEN },
  });
  assert.deepEqual(ambientFlag.outcome, { status: 'sent' }, 'CF-15 (a)');
  assert.deepEqual(ambientFlag.errors, [`[confirmation-envelope] writer disarmed orderId=${ORDER_ID} reason=store_io_not_injected`]);
  assert.deepEqual(atA(ambientFlag), golden.post);
  // (b) envelopeWriter supplied without storeIo: real NBT, nothing constructed.
  const noStore = await nbtDeliver({ seed, envelopeWriter: { env: writerEnv(A) }, send: recordingTransport().send });
  assert.deepEqual(noStore.outcome, { status: 'sent' }, 'CF-15 (b)');
  assert.deepEqual(noStore.errors, [`[confirmation-envelope] writer disarmed orderId=${ORDER_ID} reason=store_io_not_injected`]);
  assert.deepEqual(atA(noStore), golden.post);
});

test('CF-16: a storeIo missing any one adapter, or holding a non-function, disarms with no construction', async () => {
  const full = strictSyntheticStoreIo({}).io as unknown as Record<string, unknown>;
  for (const [label, partial] of [
    ['no put', { get: full.get, del: full.del }],
    ['no get', { put: full.put, del: full.del }],
    ['no del', { put: full.put, get: full.get }],
    ['non-function del', { put: full.put, get: full.get, del: 'nope' }],
  ] as const) {
    const instrumented = instrumentedStoreIo(partial as never);
    const order = paidOrder();
    const r = await armed({ order, storeIo: instrumented.io, transport: 'recording' });
    assert.deepEqual(r.outcome, { status: 'sent' }, label);
    assert.deepEqual(r.errors, [`[confirmation-envelope] writer disarmed orderId=${ORDER_ID} reason=store_io_not_injected`], label);
    assert.equal(instrumented.constructed(), false, `${label}: constructed`);
    await assertLegacyParity(r, order, `CF-16 ${label}`);
  }
});

test('CF-17 / CF-19: a namespace refusal wins every combination with another fault, with no read and no legacy path', async () => {
  const faults: Array<[string, Record<string, string | undefined>, AmbientValues, boolean]> = [
    ['no other fault', {}, {}, true],
    ['VERCEL=1', { VERCEL: '1' }, { VERCEL: '1' }, true],
    ['epoch missing', { HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: undefined }, {}, true],
    ['epoch invalid', { HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: '2026-10-15' }, {}, true],
    ['epoch before floor', { HSB_CONFIRMATION_ENVELOPE_WRITER_EPOCH: '2026-01-01T00:00:00.000Z' }, {}, true],
    ['no dedicated token', { HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN: undefined }, {}, true],
    ['colliding token', { BLOB_READ_WRITE_TOKEN: SYNTHETIC_TOKEN }, {}, true],
    ['storeIo absent', {}, {}, false],
  ];
  for (const [label, envFault, ambientFault, withStore] of faults) {
    for (const [variant, namespace, ambientNamespace, reason] of [
      ['(a) unresolvable snapshot namespace', 'a/b', 'a/b', 'namespace_invalid'],
      ['(b) W0 disagreement', A, Z, 'namespace_disagreement'],
    ] as const) {
      const instrumented = instrumentedStoreIo();
      const mem = memOrderIo([paidOrder()]);
      const transport = throwingTransport();
      const run = await withAmbient({ HSB_BLOB_NAMESPACE: ambientNamespace, ...ambientFault }, () => deliverArmed({
        env: writerEnv(namespace, envFault), storeIo: withStore ? instrumented.io : undefined, orderIo: mem.io, send: transport.send,
      }));
      assertDeferred(run, reason, `${label} ${variant}`);
      assert.equal(mem.readCalls() + mem.transactCalls(), 0, `${label} ${variant}: an order read`);
      assert.deepEqual(instrumented.reads, { put: 0, get: 0, del: 0 }, `${label} ${variant}: the store was touched`);
      assert.equal(transport.calls(), 0);
      assert.ok(!run.errors.some((line) => line.includes('writer disarmed')), `${label} ${variant}: disarmed instead of refused`);
    }
  }
});

// ══ §P — Default off ═══════════════════════════════════════════════════════

test('PA-5 / PA-6: with the writer absent no store is constructed, no NBT entry point runs and no envelope line is logged', async () => {
  for (const [label, writer] of [
    ['flag absent, writer supplied', { env: writerEnv(undefined, { HSB_CONFIRMATION_ENVELOPE_WRITER: undefined }) }],
    ['flag false, writer supplied', { env: writerEnv(undefined, { HSB_CONFIRMATION_ENVELOPE_WRITER: 'false' }) }],
  ] as const) {
    const instrumented = instrumentedStoreIo();
    const mem = memOrderIo([paidOrder()]);
    const golden = await writerOffGolden(paidOrder());
    const cells = new Map([[ORDER_ID, JSON.stringify(paidOrder())]]);
    const logs: string[] = [];
    const outcome = await withAmbient({}, () => deliverOrderConfirmationEmail(ORDER_ID, {
      send: recordingTransport().send, now: () => NOW_MS, newClaimId: () => 'claim-synthetic',
      log: (l) => { logs.push(l); }, errorLog: (l) => { logs.push(l); },
      getOrder: async (id) => JSON.parse(cells.get(id)!),
      transact: (async (id: string, mutate: (o: OrderRecord) => { abort?: unknown; commit?: OrderRecord; result?: unknown }) => {
        const decided = mutate(JSON.parse(cells.get(id)!));
        if ('abort' in decided) return decided.abort;
        cells.set(id, JSON.stringify(decided.commit));
        return decided.result;
      }) as DeliverOrderConfirmationEmailDeps['transact'],
      envelopeWriter: { ...writer, storeIo: instrumented.io, orderIo: mem.io },
    } as DeliverOrderConfirmationEmailDeps));
    assert.deepEqual(outcome, golden.outcome, label);
    assert.deepEqual(instrumented.reads, { put: 0, get: 0, del: 0 }, `${label}: PA-5 store`);
    assert.equal(mem.readCalls() + mem.transactCalls(), 0, `${label}: PA-5 NBT`);
    assert.deepEqual(logs.filter((line) => line.startsWith('[confirmation-envelope]')), [], `${label}: PA-6`);
    assert.deepEqual(JSON.parse(cells.get(ORDER_ID)!), golden.post);
  }
});

// ══ §H — Kickoff and sweep outcome handling ════════════════════════════════

test('OU-5 / OU-6 / HO-6 / OU-8: kickoff logs snapshotted and awaiting benignly, and codes held and deferred', async () => {
  for (const scheduler of ['setImmediate', 'after'] as const) {
    // OU-5: snapshotted completes; a join makes no second delivery.
    _resetConfirmationEmailInFlightForTest();
    const order = paidOrder();
    const mem = memOrderIo([order]);
    const store = strictSyntheticStoreIo({ put: ['store'] });
    await withAmbient({}, async () => {
      const deps = { send: throwingTransport().send, envelopeWriter: { env: writerEnv(), storeIo: store.io, orderIo: mem.io } };
      const queue: Array<() => void | Promise<void>> = [];
      const logs: string[] = [];
      const errors: string[] = [];
      scheduleOrderConfirmationEmail(order, {
        ...deps,
        setImmediateImpl: (cb) => { queue.push(cb); return null; },
        afterImpl: (cb) => { queue.push(cb); },
        log: (l) => { logs.push(l); },
        errorLog: (l) => { errors.push(l); },
      } as never);
      const [first, second] = scheduler === 'setImmediate' ? [queue[0], queue[1]] : [queue[1], queue[0]];
      const other = scheduler === 'setImmediate' ? 'after' : 'setImmediate';
      await first();
      await second();
      assert.ok(logs.includes(`[confirmation-email] ${scheduler} snapshotted for ${ORDER_ID}`), JSON.stringify(logs));
      assert.ok(logs.includes(`[confirmation-email] ${other} joining existing send for ${ORDER_ID}`), 'in-flight entry kept: the second scheduler joins');
      assert.deepEqual(errors, [], 'OU-5: no errorLog');
      assert.equal(store.count('put'), 1, 'a join makes no second delivery');
      assert.equal(mem.transactCalls(), 1);
    });
    // OU-6: awaiting frozen dispatch is benign.
    _resetConfirmationEmailInFlightForTest();
    const snapshotted = paidOrder({ confirmationEmailState: 'SNAPSHOTTED' } as Partial<OrderRecord>);
    await withAmbient({}, async () => {
      const k = runKickoff(snapshotted, scheduler, { send: throwingTransport().send, envelopeWriter: { env: writerEnv(), storeIo: strictSyntheticStoreIo({}).io, orderIo: memOrderIo([snapshotted]).io } });
      await k.queue.shift()!();
      await settle(() => k.logs.length > 0, 'OU-6');
      assert.ok(k.logs.includes(`[confirmation-email] ${scheduler} awaiting frozen dispatch for ${ORDER_ID}`));
      assert.deepEqual(k.errors, []);
    });
    // OU-8 / HO-6: held and deferred become closed codes.
    for (const [order_, storeScript, code] of [
      [paidOrder({ confirmationEmailFrom: 'Legacy <legacy@example.invalid>' }), {}, 'confirmation_email_held:legacy_unresolved'],
      [paidOrder(), { put: ['not_private'] }, 'confirmation_email_snapshot_deferred:store_not_private'],
    ] as const) {
      _resetConfirmationEmailInFlightForTest();
      await withAmbient({}, async () => {
        const k = runKickoff(order_, scheduler, { send: throwingTransport().send, envelopeWriter: { env: writerEnv(), storeIo: strictSyntheticStoreIo(storeScript as StoreScript).io, orderIo: memOrderIo([order_]).io } });
        await k.queue.shift()!();
        await settle(() => k.errors.some((l) => l.startsWith('[confirmation-email] ')), code);
        assert.ok(k.errors.includes(`[confirmation-email] ${scheduler} failed for ${ORDER_ID} reason=${code}`), JSON.stringify(k.errors));
      });
    }
  }
});

test('OU-7: kickoff error codes for the pre-existing outcomes are byte-identical', async () => {
  const legacy = paidOrder({ paidAt: new Date(EPOCH_MS - 1).toISOString() });
  const cases: Array<[string, OrderRecord, Record<string, unknown>, MemScript, string]> = [
    ['skipped', legacy, { send: async () => ({ skipped: true, reason: 'missing_resend_api_key' }) }, {}, 'confirmation_email_skipped:missing_resend_api_key'],
    ['blocked', paidOrder({ refundedAt: '2026-10-15T12:10:00.000Z' }), { send: throwingTransport().send }, {}, 'confirmation_email_blocked:refunded'],
    ['failed', legacy, { send: async () => { throw new Error('synthetic provider failure'); } }, {}, 'confirmation_email_send_failed:Error'],
    ['receipt_unrecorded', legacy, { send: recordingTransport().send }, { throwOnCommit: { callIndex: 1, when: 'before-write', error: new Error('lost') } }, 'confirmation_email_receipt_unrecorded:write_failed'],
  ];
  for (const scheduler of ['setImmediate', 'after'] as const) {
    for (const [label, order, deps, memScript, code] of cases) {
      _resetConfirmationEmailInFlightForTest();
      await withAmbient({}, async () => {
        const k = runKickoff(order, scheduler, { ...deps, envelopeWriter: { env: writerEnv(), storeIo: strictSyntheticStoreIo({}).io, orderIo: memOrderIo([order], memScript).io } });
        await k.queue.shift()!();
        await settle(() => k.errors.some((l) => l.includes(' failed for ')), label);
        assert.ok(k.errors.includes(`[confirmation-email] ${scheduler} failed for ${ORDER_ID} reason=${code}`), `${label}: ${JSON.stringify(k.errors)}`);
      });
    }
  }
});

test('OU-9 / OU-10 / OU-11: the sweep counts snapshotted, held and deferred separately; only deferral fails the run', async () => {
  const ids = [idOf('b1'), idOf('b2'), idOf('b3')];
  const orders = ids.map((id) => paidOrder({ paidAt: new Date(NOW_MS - 60 * 60 * 1000).toISOString() }, id));
  const outcomes: Record<string, ConfirmationEmailDeliveryOutcome> = {
    [ids[0]]: { status: 'snapshotted', via: 'committed' } as ConfirmationEmailDeliveryOutcome,
    [ids[1]]: { status: 'held', reason: 'legacy_unresolved' } as ConfirmationEmailDeliveryOutcome,
    [ids[2]]: { status: 'snapshot_deferred', reason: 'candidate_drift' } as ConfirmationEmailDeliveryOutcome,
  };
  const run = async (subset: string[]) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const result = await runConfirmationEmailSweep({
      listOrders: async () => orders.filter((o) => subset.includes(o.id)),
      deliver: async (id) => outcomes[id],
      now: () => NOW_MS, graceMs: 15 * 60 * 1000, claimStaleMs: CONFIRMATION_EMAIL_CLAIM_STALE_MS,
      activationPaidAtMs: Date.parse(FLOOR), log: (l) => { logs.push(l); }, errorLog: (l) => { errors.push(l); },
    });
    return { result, logs, errors };
  };
  const snap = await run([ids[0]]);
  assert.deepEqual(snap.result, { ok: true, scanned: 1, eligible: 1, sent: 0, skipped: 0, blocked: 0, failed: 0, snapshotted: 1, held: 0, deferred: 0 }, 'OU-9');
  assert.deepEqual(snap.logs, [`[confirmation-email-sweep] snapshotted orderId=${ids[0]} via=committed`]);
  const held = await run([ids[1]]);
  assert.deepEqual(held.result, { ok: true, scanned: 1, eligible: 1, sent: 0, skipped: 0, blocked: 0, failed: 0, snapshotted: 0, held: 1, deferred: 0 }, 'OU-10');
  assert.deepEqual(held.errors, [`[confirmation-email-sweep] held orderId=${ids[1]} reason=legacy_unresolved`]);
  const deferred = await run([ids[2]]);
  assert.deepEqual(deferred.result, { ok: false, scanned: 1, eligible: 1, sent: 0, skipped: 0, blocked: 0, failed: 0, snapshotted: 0, held: 0, deferred: 1 }, 'OU-11');
  assert.deepEqual(deferred.errors, [`[confirmation-email-sweep] deferred orderId=${ids[2]} reason=candidate_drift`]);
});

test('OU-12: both outcome switches are exhaustive — no default arm, a never check at the end', () => {
  for (const file of ['src/lib/order-confirmation-kickoff.ts', 'src/lib/confirmation-email-sweep.ts']) {
    const source = readRepo(file);
    assert.match(source, /const _exhaustive: never = outcome;/, `${file}: never check`);
    const switchBody = source.slice(source.indexOf('switch (outcome.status)'));
    const end = switchBody.indexOf('const _exhaustive: never = outcome;');
    assert.doesNotMatch(switchBody.slice(0, end), /\bdefault\s*:/, `${file}: a default arm hides a missing outcome`);
    for (const status of ['sent', 'skipped', 'blocked', 'receipt_unrecorded', 'failed', 'snapshotted', 'held', 'snapshot_deferred']) {
      assert.match(switchBody.slice(0, end), new RegExp(`case '${status}'`), `${file}: arm for ${status}`);
    }
  }
});

// ── File-end isolation evidence (ISO-1, ISO-4, ISO-8, ISO-9, SN-6, OR-17) ───

test('ISO: file-end — no unscripted call, no fetch, no transport touched, no del, env and adapter seam restored', () => {
  assert.equal(UNSCRIPTED_TOTAL, 0, 'ISO-1 / ISO-9: a synthetic seam saw an unscripted call');
  assert.equal(FETCH_CALLS, 0, 'ISO-4: fetch was called');
  assert.equal(THROWING_TRANSPORT_CALLS, 0, 'SN-6: a throwing transport was touched');
  assert.equal(DEL_CALLS_TOTAL, 0, 'OR-17: a delete was attempted');
  assert.equal(process.env, FILE_START_ENV, 'ISO-8: the original process.env object is back');
  for (const key of AMBIENT_KEYS) {
    assert.equal(process.env[key], FILE_START_AMBIENT[key as keyof typeof FILE_START_AMBIENT], `ISO-8: ${key} restored`);
  }
  __resetOrderStoreAdapterFactoryForTests();
  assert.ok(OVERRIDE_INSTALLED, 'ISO-9: the namespace-sensitive adapter was used');
  globalThis.fetch = ORIGINAL_FETCH;
});
