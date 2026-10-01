/*
 * NBT — the namespace-bound order transaction substrate (architecture §N).
 *
 * The ambient order API resolves the Blob namespace from `process.env` at every
 * call. A transaction that starts in one namespace can therefore read, retry or
 * commit in another if the environment moves underneath it, and the record
 * boundary validates refs and the checkout-intake contract against whatever the
 * environment says at that instant. NBT closes that by passing the namespace as
 * DATA: a branded, frozen binding fixes the record path once, and every read,
 * every CAS retry, the conditional commit, the ref boundary and seal, the
 * checkout-intake contract and the returned provenance use it.
 *
 * Every row runs the real `orders.ts` NBT API over `nsOrderAdapter`, a
 * namespace-sensitive synthetic adapter keyed by FULL pathname, installed only
 * through the order-store test seam (ISO-9). The same order id is seeded under
 * `ns-a` and `ns-z` with different, individually valid record bytes, so a read
 * or a write in the wrong namespace is visible as the wrong bytes, the wrong
 * path in the adapter trace, or both. "Drift" is a per-call adapter hook that
 * rewrites the ambient `HSB_BLOB_NAMESPACE` mid-transaction (ISO-8).
 *
 * The order module is imported as a namespace object so that, on a tree without
 * the NBT API, each row fails on its own ("is not a function") instead of the
 * whole file failing to link. NT-19 and NT-20 use only the pre-existing API and
 * the source text; their expected values were recorded from the untouched base
 * tree and are the controls that prove existing callers did not move.
 *
 * Everything is synthetic: no network, no credential, no real store, no `.env`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { applyBlobNamespace } from '../src/lib/blob-namespace.ts';
import { finalizationFingerprint, intakeAssetPath, type FinalizedSelectionEntry } from '../src/lib/checkout-intake.ts';
import * as orders from '../src/lib/orders.ts';
import type {
  BoundOrderTransactionResult,
  OrderNamespaceBinding,
  OrderNamespaceProvenance,
  OrderRecord,
  OrderStoreAdapter,
  OrderTransactionOutcome,
} from '../src/lib/orders.ts';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ORDERS_SOURCE = readFileSync(path.join(REPO_ROOT, 'src/lib/orders.ts'), 'utf8');

// ── Fixtures ───────────────────────────────────────────────────────────────

/** Assembled, not written as a literal: REQ16 refuses committable order-id shapes. */
const ORDER_ID = ['ord', `${'0'.repeat(14)}c1`].join('_');
const OTHER_ORDER_ID = ['ord', `${'0'.repeat(14)}d2`].join('_');

const A = 'ns-a';
const B = 'ns-b';
const Z = 'ns-z';
const NAMESPACES = ['', A, B, Z] as const;

const EPOCH = '2026-10-15T12:00:00.000Z';
const NOW = '2026-10-15T13:00:00.000Z';

const pathIn = (namespace: string, orderId = ORDER_ID) =>
  (namespace ? `${namespace}/orders/${orderId}.json` : `orders/${orderId}.json`);
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const bodyOf = (order: OrderRecord) => JSON.stringify(order, null, 2);

function seedRecord(namespace: string, overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    ...orders.createOrderRecord(
      { childName: namespace === Z ? 'Zora' : 'Ada', bookFormat: 'digital', email: 'buyer@example.invalid' },
      { id: ORDER_ID, now: EPOCH },
    ),
    paymentStatus: 'paid' as const,
    paidAt: EPOCH,
    internalDispositionNote: `seed:${namespace || 'flat'}`,
    ...overrides,
  } as OrderRecord;
}

function seedAZ(a: OrderRecord = seedRecord(A), z: OrderRecord = seedRecord(Z)): Record<string, string> {
  return { [pathIn(A)]: bodyOf(a), [pathIn(Z)]: bodyOf(z) };
}

/** An unrelated edit, deterministic so traces and bodies are reproducible. */
function edit(order: OrderRecord, note: string): OrderRecord {
  return { ...order, internalDispositionNote: note, updatedAt: NOW };
}

const ENVELOPE_KEY_PREFIX = 'confirmation-envelopes';

/**
 * The two record fields NT-9, NT-10, NT-11 and NT-23 need, written as direct
 * literals. `tests/confirmation-email-integration-guards` (I1-2 and A3-3)
 * scans every file for these whole identifiers; this suite is listed in its
 * `CANDIDATE_TESTS` because it directly exercises the state/ref boundary.
 */
const REF_FIELD = 'confirmationEmailEnvelopeRef';
const STATE_FIELD = 'confirmationEmailState';

/** An edited record carrying the given confirmation fields. */
function withFields(order: OrderRecord, note: string, fields: Record<string, unknown>): OrderRecord {
  return { ...edit(order, note), ...fields } as OrderRecord;
}
const storedRef = (body: string | undefined) => (JSON.parse(body!) as Record<string, unknown>)[REF_FIELD];

/**
 * A 10-key confirmation-envelope ref, built as plain data from fixture
 * constants. The bound boundary and seal validate it; this file never imports
 * the module that defines the ref grammar (architecture §14.2).
 */
function refUnder(namespace: string): Record<string, unknown> {
  const key = `${ENVELOPE_KEY_PREFIX}/${ORDER_ID}/v1.json`;
  return {
    envelopeVersion: 1,
    orderId: ORDER_ID,
    templateVersion: 'order-confirmation@a33test',
    createdAt: '2026-09-26T12:00:00.000Z',
    canonicalDigest: 'a'.repeat(64),
    canonicalBytes: 1234,
    accountLabel: 'hsb-test-prod-v1',
    storageKind: 'private_blob',
    objectPath: namespace ? `${namespace}/${key}` : key,
    purgedAt: null,
  };
}

/** The two commit shapes NT-11 compares: ref-bearing snapshot and ref-less hold. */
type CommitShape = 'ref-bearing' | 'ref-less';
function shapedCommit(order: OrderRecord, shape: CommitShape, note: string): OrderRecord {
  return shape === 'ref-bearing'
    ? withFields(order, note, { [STATE_FIELD]: 'SNAPSHOTTED', [REF_FIELD]: refUnder(A) })
    : withFields(order, note, { [STATE_FIELD]: 'RECONCILIATION_REQUIRED' });
}

// ── Global sequence, windows and the ambient environment ───────────────────

let SEQ = 0;
const tick = () => {
  SEQ += 1;
  return SEQ;
};

interface Window { start: number; end: number }
/** Every NBT entry-point call, as a [start, end] sequence window. */
const NBT_WINDOWS: Window[] = [];
/** Every test-owned hook body (drift writes), excluded from env-freedom checks. */
const HOOK_WINDOWS: Window[] = [];

async function inWindow<T>(windows: Window[], fn: () => Promise<T> | T): Promise<T> {
  const window = { start: tick(), end: Number.POSITIVE_INFINITY };
  windows.push(window);
  try {
    return await fn();
  } finally {
    window.end = tick();
  }
}

const nbt = <T>(fn: () => Promise<T>) => inWindow(NBT_WINDOWS, fn);
const hookBody = (fn: () => void) => inWindow(HOOK_WINDOWS, fn);

const AMBIENT_KEYS = [
  'HSB_BLOB_NAMESPACE',
  'VERCEL_ENV',
  'VERCEL',
  'BLOB_READ_WRITE_TOKEN',
  'HSB_REQUIRE_DURABLE_PERSISTENCE',
] as const;
const ORIGINAL_ENV = process.env;
const ORIGINAL_AMBIENT = Object.fromEntries(AMBIENT_KEYS.map((key) => [key, process.env[key]]));

function setAmbient(namespace: string | undefined): void {
  if (namespace === undefined) delete process.env.HSB_BLOB_NAMESPACE;
  else process.env.HSB_BLOB_NAMESPACE = namespace;
}

/** A drift write performed by a test hook, inside a hook window. */
const drift = (namespace: string | undefined) => hookBody(() => setAmbient(namespace));

let OVERRIDE_ACTIVE = false;
let UNSCRIPTED_TOTAL = 0;

/**
 * One row's ambient world: durable persistence off, no Vercel keys, no token,
 * and the given ambient namespace. Restored, and the adapter seam reset, in
 * `finally` (ISO-8, ISO-9).
 */
async function scenario<T>(ambient: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(AMBIENT_KEYS.map((key) => [key, process.env[key]]));
  process.env.HSB_REQUIRE_DURABLE_PERSISTENCE = 'false';
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  setAmbient(ambient);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    orders.__resetOrderStoreAdapterFactoryForTests();
    OVERRIDE_ACTIVE = false;
  }
}

interface EnvRead { seq: number; key: string }

/**
 * ISO-8 `envRecorder`: replace `process.env` with a recording proxy over a
 * synthetic copy for the duration of `fn`, and put the original object back in
 * `finally`. Only key names are logged, never values.
 */
async function withEnvRecorder<T>(fn: (reads: EnvRead[]) => Promise<T>): Promise<T> {
  const original = process.env;
  const reads: EnvRead[] = [];
  const copy: Record<string, string | undefined> = { ...original };
  process.env = new Proxy(copy, {
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

// ── nsOrderAdapter (ISO-9) ─────────────────────────────────────────────────

class SyntheticUnscriptedCall extends Error {
  constructor(what: string) {
    super(`SyntheticUnscriptedCall: ${what}`);
    this.name = 'SyntheticUnscriptedCall';
  }
}

type AdapterOp = 'readVersioned' | 'createIfAbsent' | 'replaceIfVersion';

interface AdapterCall {
  seq: number;
  op: AdapterOp;
  path: string;
  expectedVersion: string | null;
  bodySha: string | null;
  result: string;
}

/** Every adapter call in this file, in sequence order (NT-22 locates entry with it). */
const ALL_ADAPTER_CALLS: AdapterCall[] = [];

interface NsScript {
  seed: Record<string, string>;
  /** `replaceIfVersion` call indexes (0-based, across all paths) that lose the CAS. */
  conflictAt?: readonly number[];
  /** Whether a scripted conflict also advances the stored version (default true). */
  conflictAdvancesVersion?: boolean;
  /** Runs before the scripted result of every call; may drift the ambient env. */
  hook?: (op: AdapterOp, index: number, pathname: string) => void | Promise<void>;
  /** Runs synchronously at `replaceIfVersion` entry, before anything else. */
  onReplaceEntry?: () => void;
}

interface NsAdapter {
  readonly adapter: OrderStoreAdapter;
  readonly calls: AdapterCall[];
  bodyAt(pathname: string): string | undefined;
  factoryCalls(): number;
  unscripted(): number;
}

/**
 * Namespace-sensitive and strict. Known paths are the order's record path
 * under each of the four fixture namespaces; anything else, and every create,
 * is unscripted and throws. A scripted conflict models a concurrent writer by
 * advancing the version only, so the bytes stay comparable.
 */
function nsOrderAdapter(script: NsScript): NsAdapter {
  const cells = new Map<string, { body: string; n: number }>();
  for (const [pathname, body] of Object.entries(script.seed)) cells.set(pathname, { body, n: 1 });
  const known = new Set<string>(NAMESPACES.map((namespace) => pathIn(namespace)));
  const calls: AdapterCall[] = [];
  const counts: Record<AdapterOp, number> = { readVersioned: 0, createIfAbsent: 0, replaceIfVersion: 0 };
  let unscripted = 0;
  let factory = 0;
  const versionOf = (pathname: string, n: number) => `v${n}-${sha(pathname).slice(0, 8)}`;
  const enter = (op: AdapterOp, pathname: string, expectedVersion: string | null, body: string | null) => {
    const call: AdapterCall = {
      seq: tick(), op, path: pathname, expectedVersion, bodySha: body === null ? null : sha(body).slice(0, 16), result: 'pending',
    };
    calls.push(call);
    ALL_ADAPTER_CALLS.push(call);
    return call;
  };
  const refuse = (call: AdapterCall): never => {
    unscripted += 1;
    UNSCRIPTED_TOTAL += 1;
    call.result = 'unscripted';
    throw new SyntheticUnscriptedCall(`${call.op} ${call.path}`);
  };
  const adapter: OrderStoreAdapter = {
    kind: 'ns-synthetic',
    async readVersioned(pathname) {
      const call = enter('readVersioned', pathname, null, null);
      const index = counts.readVersioned++;
      if (!known.has(pathname)) refuse(call);
      await script.hook?.('readVersioned', index, pathname);
      const cell = cells.get(pathname);
      call.result = cell ? versionOf(pathname, cell.n) : 'absent';
      return cell ? { body: cell.body, version: versionOf(pathname, cell.n) } : null;
    },
    async createIfAbsent(pathname, body) {
      counts.createIfAbsent += 1;
      return refuse(enter('createIfAbsent', pathname, null, body));
    },
    async replaceIfVersion(pathname, body, expectedVersion) {
      script.onReplaceEntry?.();
      const call = enter('replaceIfVersion', pathname, expectedVersion, body);
      const index = counts.replaceIfVersion++;
      if (!known.has(pathname)) refuse(call);
      await script.hook?.('replaceIfVersion', index, pathname);
      const cell = cells.get(pathname);
      if (script.conflictAt?.includes(index)) {
        if (cell && script.conflictAdvancesVersion !== false) cell.n += 1;
        call.result = 'conflict:scripted';
        return { ok: false, reason: 'version_conflict' };
      }
      if (!cell || versionOf(pathname, cell.n) !== expectedVersion) {
        call.result = 'conflict';
        return { ok: false, reason: 'version_conflict' };
      }
      cell.body = body;
      cell.n += 1;
      call.result = 'ok';
      return { ok: true, version: versionOf(pathname, cell.n) };
    },
  };
  orders.__setOrderStoreAdapterFactoryForTests(() => {
    factory += 1;
    return adapter;
  });
  OVERRIDE_ACTIVE = true;
  return {
    adapter,
    calls,
    bodyAt: (pathname) => cells.get(pathname)?.body,
    factoryCalls: () => factory,
    unscripted: () => unscripted,
  };
}

const opsOf = (calls: readonly AdapterCall[]) => calls.map((call) => `${call.op}:${call.path}:${call.result}`);
const successfulWrites = (calls: readonly AdapterCall[]) =>
  calls.filter((call) => call.op !== 'readVersioned' && call.result === 'ok');
const callsUnder = (calls: readonly AdapterCall[], namespace: string) =>
  calls.filter((call) => call.path === pathIn(namespace));

/** Zero mutation: no successful write, and both seeded bodies byte-identical. */
function assertZeroMutation(ns: NsAdapter, seed: Record<string, string>, where: string): void {
  assert.deepEqual(successfulWrites(ns.calls), [], `${where}: no write may land`);
  for (const [pathname, body] of Object.entries(seed)) {
    assert.equal(ns.bodyAt(pathname), body, `${where}: ${pathname} must be byte-identical`);
  }
}

// ── Bound-call helpers ─────────────────────────────────────────────────────

function bindOrThrow(namespace: string): OrderNamespaceBinding {
  const result = orders.bindOrderNamespace(namespace);
  assert.equal(result.ok, true, `binding ${JSON.stringify(namespace)} must succeed`);
  return (result as { ok: true; binding: OrderNamespaceBinding }).binding;
}

interface Recorder {
  readonly events: Array<{ seq: number; kind: 'mutate:start' | 'mutate:end' | 'guard'; marker?: string }>;
  mutateInputs: string[];
}

const newRecorder = (): Recorder => ({ events: [], mutateInputs: [] });

/**
 * Wrap a decision so its window is visible: the record it receives, and the
 * start and end of the (deliberately asynchronous) decision.
 */
function recordedMutate<T>(
  recorder: Recorder,
  decide: (order: OrderRecord, call: number) => OrderTransactionOutcome<T>,
): (order: OrderRecord) => Promise<OrderTransactionOutcome<T>> {
  let call = 0;
  return async (order) => {
    call += 1;
    recorder.events.push({ seq: tick(), kind: 'mutate:start' });
    recorder.mutateInputs.push(String(order.internalDispositionNote));
    await Promise.resolve();
    const outcome = decide(order, call);
    recorder.events.push({ seq: tick(), kind: 'mutate:end' });
    return outcome;
  };
}

function recordedGuard(recorder: Recorder, answer: () => unknown = () => true): () => boolean {
  return () => {
    recorder.events.push({ seq: tick(), kind: 'guard' });
    return answer() as boolean;
  };
}

/** Read and commit sequence, merged from the adapter trace and the recorder. */
function timeline(ns: NsAdapter, recorder: Recorder): string[] {
  return [
    ...ns.calls.map((call) => ({ seq: call.seq, kind: call.op === 'readVersioned' ? 'read' : 'replace' })),
    ...recorder.events,
  ].sort((left, right) => left.seq - right.seq).map((event) => event.kind);
}

function assertProvenance(
  provenance: OrderNamespaceProvenance,
  expected: { namespace: string; reads: number; commits: number; outcome: OrderNamespaceProvenance['outcome'] },
): void {
  const recordPath = pathIn(expected.namespace);
  assert.ok(Object.isFrozen(provenance), 'provenance must be frozen');
  assert.ok(Object.isFrozen(provenance.readPaths) && Object.isFrozen(provenance.commitPaths));
  assert.deepEqual({ ...provenance, readPaths: [...provenance.readPaths], commitPaths: [...provenance.commitPaths] }, {
    namespace: expected.namespace,
    recordPath,
    readPaths: Array.from({ length: expected.reads }, () => recordPath),
    commitPaths: Array.from({ length: expected.commits }, () => recordPath),
    attempts: expected.reads,
    outcome: expected.outcome,
  });
}

async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected a rejection');
}

function assertPersistenceError(error: unknown, message: string | RegExp, where: string): void {
  assert.ok(error instanceof orders.OrderPersistenceError, `${where}: expected OrderPersistenceError, got ${String(error)}`);
  if (typeof message === 'string') assert.equal((error as Error).message, message, where);
  else assert.match((error as Error).message, message, where);
}

// ── Scenario bodies shared by several rows (NT-5…NT-9, NT-11, NT-22, NT-24) ─

interface ScenarioRun {
  ns: NsAdapter;
  seed: Record<string, string>;
  recorder: Recorder;
  result?: BoundOrderTransactionResult<string>;
  error?: unknown;
}

async function runBoundTransaction(
  ns: NsAdapter,
  seed: Record<string, string>,
  recorder: Recorder,
  decide: (order: OrderRecord, call: number) => OrderTransactionOutcome<string>,
  opts: { beforeCommit?: () => boolean; maxAttempts?: number; binding?: OrderNamespaceBinding } = {},
): Promise<ScenarioRun> {
  const binding = opts.binding ?? bindOrThrow(A);
  try {
    const result = await nbt(() => orders.withOrderTransactionInNamespace(binding, ORDER_ID, recordedMutate(recorder, decide), {
      notFound: () => 'not-found',
      ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
      ...(opts.beforeCommit === undefined ? {} : { beforeCommit: opts.beforeCommit }),
    }));
    return { ns, seed, recorder, result };
  } catch (error) {
    return { ns, seed, recorder, error };
  }
}

/** NT-5: binding A, ambient A; the first read drifts the ambient env to Z. */
async function scenarioNt5(shape: CommitShape, opts: { beforeCommit?: (r: Recorder) => () => boolean } = {}): Promise<ScenarioRun> {
  const seed = seedAZ();
  const ns = nsOrderAdapter({
    seed,
    hook: (op, index) => (op === 'readVersioned' && index === 0 ? drift(Z) : undefined),
  });
  const recorder = newRecorder();
  return runBoundTransaction(ns, seed, recorder, (order) => ({ commit: shapedCommit(order, shape, 'nt5'), result: 'done' }), {
    beforeCommit: opts.beforeCommit?.(recorder),
  });
}

const DRIFT_SEQUENCE: ReadonlyArray<string | undefined> = [Z, undefined, B, Z, undefined, B];

/** NT-6 / NT-7: scripted conflicts, with the ambient env flipping at each one. */
async function scenarioConflicts(
  shape: CommitShape,
  conflicts: number,
  opts: { beforeCommit?: (r: Recorder) => () => boolean } = {},
): Promise<ScenarioRun> {
  const seed = seedAZ();
  const ns = nsOrderAdapter({
    seed,
    conflictAt: Array.from({ length: conflicts }, (_, index) => index),
    hook: (op, index) => (op === 'replaceIfVersion' && index < conflicts ? drift(DRIFT_SEQUENCE[index]) : undefined),
  });
  const recorder = newRecorder();
  return runBoundTransaction(ns, seed, recorder, (order, call) => ({
    commit: shapedCommit(order, shape, `conflict-attempt-${call}`),
    result: `attempt-${call}`,
  }), { beforeCommit: opts.beforeCommit?.(recorder) });
}

/** NT-8: the guard refuses with the given answer. */
async function scenarioRefusal(shape: CommitShape, answer: () => unknown): Promise<ScenarioRun> {
  const seed = seedAZ();
  const ns = nsOrderAdapter({ seed, hook: (op, index) => (op === 'readVersioned' && index === 0 ? drift(Z) : undefined) });
  const recorder = newRecorder();
  return runBoundTransaction(ns, seed, recorder, (order) => ({ commit: shapedCommit(order, shape, 'nt8'), result: 'done' }), {
    beforeCommit: recordedGuard(recorder, answer),
  });
}

const REFUSALS: ReadonlyArray<[string, () => unknown]> = [
  ['false', () => false],
  ['a thenable', () => ({ then(resolve: (value: boolean) => void) { resolve(true); } })],
  ['1', () => 1],
  ['a throw', () => { throw new Error('guard refused by throwing'); }],
];

// ── NT-1 … NT-24 ───────────────────────────────────────────────────────────

test('NT-1: bindOrderNamespace accepts exactly the blob-namespace grammar, freezes the binding and reads no environment', async () => {
  await withEnvRecorder(async (reads) => {
    for (const namespace of ['', A, 'development', 'preview-pr-154']) {
      const result = orders.bindOrderNamespace(namespace);
      assert.equal(result.ok, true, `${JSON.stringify(namespace)} must bind`);
      const { binding } = result as { ok: true; binding: OrderNamespaceBinding };
      assert.ok(Object.isFrozen(binding), 'the binding must be frozen');
      assert.deepEqual(Object.keys(binding), ['namespace']);
      assert.equal(binding.namespace, namespace);
      assert.equal(
        orders.orderRecordPathInNamespace(binding, ORDER_ID),
        applyBlobNamespace(`orders/${ORDER_ID}.json`, namespace),
      );
    }
    for (const bad of [' ns-a', 'a/b', 'ns a', 'x'.repeat(65), 42, undefined, null, { namespace: A }]) {
      assert.deepEqual(
        orders.bindOrderNamespace(bad as unknown as string),
        { ok: false, problem: 'namespace_invalid' },
        `${String(bad)} must be refused`,
      );
    }
    assert.deepEqual(reads, [], 'binding and path derivation must not read process.env');
  });
});

test('NT-2: forged bindings are refused before the adapter is even resolved', async () => {
  await scenario(A, async () => {
    const real = bindOrThrow(A);
    const forged: ReadonlyArray<[string, unknown]> = [
      ['a plain object', { namespace: A }],
      ['a frozen copy of a real binding', Object.freeze({ ...real })],
      ['a proxy over a real binding', new Proxy(real, {})],
      ['null', null],
    ];
    const ns = nsOrderAdapter({ seed: seedAZ() });
    for (const [label, binding] of forged) {
      const forgedBinding = binding as OrderNamespaceBinding;
      for (const [entry, call] of [
        ['read', () => orders.readOrderVersionedInNamespace(forgedBinding, ORDER_ID)],
        ['transaction', () => orders.withOrderTransactionInNamespace(forgedBinding, ORDER_ID, () => ({ abort: 'x' }), {
          notFound: () => 'nf',
        })],
      ] as const) {
        assertPersistenceError(await rejection(call), 'order_namespace_binding:binding_invalid', `${label} via ${entry}`);
      }
      assert.throws(() => orders.orderRecordPathInNamespace(forgedBinding, ORDER_ID), /order_namespace_binding:binding_invalid/);
    }
    assert.equal(ns.factoryCalls(), 0, 'the adapter factory must not be called');
    assert.deepEqual(ns.calls, [], 'no adapter call may happen');
  });
});

async function scenarioNt3(): Promise<void> {
  await scenario(Z, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const read = await nbt(() => orders.readOrderVersionedInNamespace(bindOrThrow(A), ORDER_ID));
    assert.ok(read.found, 'the A record must be found');
    assert.equal(read.found.order.internalDispositionNote, 'seed:ns-a');
    assert.equal(read.found.order.childName, 'Ada');
    assert.equal(read.found.version, ns.calls[0].result, "A's version");
    assertProvenance(read.provenance, { namespace: A, reads: 1, commits: 0, outcome: 'read' });
    assert.deepEqual(opsOf(ns.calls), [`readVersioned:${pathIn(A)}:${ns.calls[0].result}`]);
    assert.deepEqual(callsUnder(ns.calls, Z), [], 'no call may touch Z');
    assert.ok(Object.isFrozen(read));
  });
}

test('NT-3: the bound initial read is A under ambient Z, with exact provenance', scenarioNt3);

test('NT-4: the bound read and the bound transaction never consult the id-keyed cache', async () => {
  await scenario(Z, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    // An ambient commit under Z publishes Z's record to the read-your-own-writes cache.
    await orders.withOrderTransaction(ORDER_ID, (order) => ({ commit: edit(order, 'ambient-z-commit'), result: null }));
    const before = ns.calls.length;
    const cached = await orders.readOrderVersioned(ORDER_ID, { preferRecentCommit: true });
    assert.equal(ns.calls.length, before, 'control: the ambient cached read is served from the cache');
    assert.equal(cached?.order.internalDispositionNote, 'ambient-z-commit');

    const read = await nbt(() => orders.readOrderVersionedInNamespace(bindOrThrow(A), ORDER_ID));
    assert.equal(read.found?.order.internalDispositionNote, 'seed:ns-a', 'the bound read must return A, not the cached Z');
    assert.deepEqual(opsOf(ns.calls.slice(before)), [`readVersioned:${pathIn(A)}:${ns.calls[before].result}`]);

    const recorder = newRecorder();
    const run = await runBoundTransaction(ns, seed, recorder, () => ({ abort: 'peek' }));
    assert.equal(run.result?.status, 'aborted');
    assert.deepEqual(recorder.mutateInputs, ['seed:ns-a'], 'attempt 1 of the bound transaction must read the adapter at A');
    assert.equal(ns.calls.at(-1)?.path, pathIn(A));
    assert.equal(ns.calls.at(-1)?.op, 'readVersioned');
  });
});

async function checkNt5(shape: CommitShape): Promise<ScenarioRun> {
  const run = await scenarioNt5(shape);
  assert.equal(run.error, undefined, `${shape}: no error expected, got ${String(run.error)}`);
  assert.equal(run.result?.status, 'committed');
  assert.deepEqual(successfulWrites(run.ns.calls).map((call) => call.path), [pathIn(A)], 'exactly one write, at A');
  assert.deepEqual(callsUnder(run.ns.calls, Z), [], 'no call may touch Z');
  assert.equal(run.ns.bodyAt(pathIn(Z)), run.seed[pathIn(Z)], 'Z bytes unchanged');
  assert.equal((JSON.parse(run.ns.bodyAt(pathIn(A))!) as OrderRecord).internalDispositionNote, 'nt5');
  assertProvenance(run.result!.provenance, { namespace: A, reads: 1, commits: 1, outcome: 'committed' });
  return run;
}

test('NT-5: a bound commit lands at A although the ambient env drifted to Z mid-transaction (no guard)', async () => {
  await scenario(A, async () => {
    await checkNt5('ref-less');
  });
});

async function checkNt6(shape: CommitShape): Promise<ScenarioRun> {
  const run = await scenarioConflicts(shape, 3);
  assert.equal(run.error, undefined, `${shape}: no error expected, got ${String(run.error)}`);
  assert.equal(run.result?.status, 'committed');
  assert.equal(run.result?.status === 'committed' ? run.result.result : null, 'attempt-4');
  const reads = run.ns.calls.filter((call) => call.op === 'readVersioned');
  const replaces = run.ns.calls.filter((call) => call.op === 'replaceIfVersion');
  assert.equal(reads.length, 4);
  assert.equal(replaces.length, 4);
  for (const call of run.ns.calls) assert.equal(call.path, pathIn(A), `every call must be at A: ${call.op}`);
  assert.deepEqual(replaces.map((call) => call.result), ['conflict:scripted', 'conflict:scripted', 'conflict:scripted', 'ok']);
  // Each retry committed against the version its own fresh read returned.
  assert.deepEqual(replaces.map((call) => call.expectedVersion), reads.map((call) => call.result));
  assert.deepEqual(run.recorder.mutateInputs, ['seed:ns-a', 'seed:ns-a', 'seed:ns-a', 'seed:ns-a']);
  assert.equal(run.ns.bodyAt(pathIn(Z)), run.seed[pathIn(Z)], 'Z untouched');
  assertProvenance(run.result!.provenance, { namespace: A, reads: 4, commits: 4, outcome: 'committed' });
  return run;
}

test('NT-6: every CAS retry reads and commits in the frozen namespace while the ambient env flips A→Z→unset→ns-b', async () => {
  await scenario(A, async () => {
    await checkNt6('ref-less');
  });
});

async function checkNt7(shape: CommitShape): Promise<ScenarioRun> {
  const run = await scenarioConflicts(shape, 5);
  assert.ok(run.error instanceof orders.OrderVersionConflictError, `${shape}: expected OrderVersionConflictError`);
  assert.equal((run.error as InstanceType<typeof orders.OrderVersionConflictError>).attempts, 5);
  assert.equal(run.result, undefined, 'no provenance is returned on exhaustion; the trace is the evidence');
  const reads = run.ns.calls.filter((call) => call.op === 'readVersioned');
  const replaces = run.ns.calls.filter((call) => call.op === 'replaceIfVersion');
  assert.equal(reads.length, 5);
  assert.equal(replaces.length, 5);
  for (const call of run.ns.calls) assert.equal(call.path, pathIn(A), `every call must be at A: ${call.op}`);
  assertZeroMutation(run.ns, run.seed, `${shape} exhaustion`);
  return run;
}

test('NT-7: conflict exhaustion throws OrderVersionConflictError after 5 attempts, all at A, with zero mutation', async () => {
  await scenario(A, async () => {
    await checkNt7('ref-less');
  });
});

async function checkNt8(shape: CommitShape): Promise<ScenarioRun[]> {
  const runs: ScenarioRun[] = [];
  for (const [label, answer] of REFUSALS) {
    const run = await scenarioRefusal(shape, answer);
    assert.equal(run.error, undefined, `${shape}/${label}: a refusal is not an error, got ${String(run.error)}`);
    assert.equal(run.result?.status, 'commit_refused', `${shape}/${label}`);
    assert.equal(run.recorder.events.filter((event) => event.kind === 'guard').length, 1, `${label}: guard called once`);
    assert.equal(run.ns.calls.filter((call) => call.op === 'replaceIfVersion').length, 0, `${label}: no replace`);
    assertZeroMutation(run.ns, run.seed, `${shape}/${label}`);
    assertProvenance(run.result!.provenance, { namespace: A, reads: 1, commits: 0, outcome: 'commit_refused' });
    orders.__resetOrderStoreAdapterFactoryForTests();
    runs.push(run);
  }
  return runs;
}

test('NT-8: a refusing guard (false, thenable, 1, throw) means commit_refused, zero writes, and a retracted generation', async () => {
  await scenario(A, async () => {
    await checkNt8('ref-less');
  });

  // The refused generation must be RETRACTED, not leaked: an ambient commit
  // already in flight when the bound transaction is refused keeps its right to
  // publish its record to the attempt-1 cache.
  for (const [label, answer] of REFUSALS) {
    await scenario(A, async () => {
      const seed = seedAZ();
      let bound: BoundOrderTransactionResult<string> | undefined;
      const ns = nsOrderAdapter({
        seed,
        hook: async (op, index) => {
          if (op !== 'replaceIfVersion' || index !== 0) return;
          bound = await nbt(() => orders.withOrderTransactionInNamespace(bindOrThrow(A), ORDER_ID,
            (order) => ({ commit: edit(order, 'bound-refused'), result: 'never' }),
            { notFound: () => 'nf', beforeCommit: answer as () => boolean }));
        },
      });
      await orders.withOrderTransaction(ORDER_ID, (order) => ({ commit: edit(order, 'ambient-in-flight'), result: null }));
      assert.equal(bound?.status, 'commit_refused', label);
      assert.deepEqual(successfulWrites(ns.calls).map((call) => call.path), [pathIn(A)], `${label}: only the ambient write lands`);
      assert.equal(ns.calls.filter((call) => call.op === 'replaceIfVersion').length, 1, `${label}: the bound side never wrote`);
      const before = ns.calls.length;
      const cached = await orders.readOrderVersioned(ORDER_ID, { preferRecentCommit: true });
      assert.equal(ns.calls.length, before, `${label}: the in-flight ambient commit must still have published`);
      assert.equal(cached?.order.internalDispositionNote, 'ambient-in-flight');
    });
  }
});

async function scenarioGuardTiming(): Promise<{ ns: NsAdapter; recorder: Recorder; freshAtEntry: boolean[]; result: unknown }> {
  const recorder = newRecorder();
  let fresh = false;
  const freshAtEntry: boolean[] = [];
  const ns = nsOrderAdapter({ seed: seedAZ(), conflictAt: [0], onReplaceEntry: () => { freshAtEntry.push(fresh); } });
  const result = await nbt(() => orders.withOrderTransactionInNamespace(bindOrThrow(A), ORDER_ID,
    recordedMutate(recorder, (order, call) => ({ commit: edit(order, `timed-${call}`), result: call })),
    {
      notFound: () => -1,
      beforeCommit: recordedGuard(recorder, () => {
        // Cleared by the next microtask: if anything awaits between the guard
        // and the write, the adapter sees it cleared.
        fresh = true;
        queueMicrotask(() => { fresh = false; });
        return true;
      }),
    }));
  return { ns, recorder, freshAtEntry, result };
}

/** A record whose ref answers the boundary's read with a valid ref and the scrub's with a hostile one. */
function swappingRefCommit(order: OrderRecord): OrderRecord {
  const commit = edit(order, 'swap') as OrderRecord & Record<string, unknown>;
  let reads = 0;
  Object.defineProperty(commit, REF_FIELD, {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      if (reads === 1) return refUnder(A);
      return Object.assign(Object.create({ toJSON: () => ({ leaked: true }) }) as object, refUnder(A));
    },
  });
  return commit;
}

test('NT-9: the guard runs once per commit attempt, after mutate and the boundary checks, immediately before the write', async () => {
  await scenario(A, async () => {
    const { ns, recorder, freshAtEntry, result } = await scenarioGuardTiming();
    assert.equal((result as BoundOrderTransactionResult<number>).status, 'committed');
    assert.deepEqual(timeline(ns, recorder), [
      'read', 'mutate:start', 'mutate:end', 'guard', 'replace',
      'read', 'mutate:start', 'mutate:end', 'guard', 'replace',
    ]);
    assert.deepEqual(freshAtEntry, [true, true], 'no microtask turn between the guard and the adapter write');
  });

  // A seal refusal (and a boundary refusal) happen BEFORE the guard: 0 guard calls.
  for (const [label, commitOf, code] of [
    ['seal refusal', swappingRefCommit, /^confirmation_envelope_boundary:ref_not_plain_data$/],
    ['boundary refusal', (order: OrderRecord) => withFields(order, 'zref', { [REF_FIELD]: refUnder(Z) }),
      /^confirmation_envelope_boundary:ref_/],
  ] as const) {
    await scenario(A, async () => {
      const seed = seedAZ();
      const ns = nsOrderAdapter({ seed });
      const recorder = newRecorder();
      const run = await runBoundTransaction(ns, seed, recorder, (order) => ({ commit: commitOf(order), result: 'x' }), {
        beforeCommit: recordedGuard(recorder),
      });
      assertPersistenceError(run.error, code, label);
      assert.equal(recorder.events.filter((event) => event.kind === 'guard').length, 0, `${label}: the guard is never reached`);
      assertZeroMutation(ns, seed, label);
    });
  }

  // An aborting attempt never calls the guard.
  await scenario(A, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const recorder = newRecorder();
    const run = await runBoundTransaction(ns, seed, recorder, () => ({ abort: 'no' }), { beforeCommit: recordedGuard(recorder) });
    assert.equal(run.result?.status, 'aborted');
    assert.equal(recorder.events.filter((event) => event.kind === 'guard').length, 0);
  });
});

test('NT-10: the bound boundary and seal validate the ref against the binding, not the ambient env', async () => {
  // (a) A ref under Z, binding A, ambient Z: refused before any adapter write.
  await scenario(Z, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const recorder = newRecorder();
    const run = await runBoundTransaction(ns, seed, recorder, (order) => ({
      commit: withFields(order, 'zref', { [STATE_FIELD]: 'SNAPSHOTTED', [REF_FIELD]: refUnder(Z) }),
      result: 'x',
    }));
    assertPersistenceError(run.error, /^confirmation_envelope_boundary:ref_[a-z_]+$/, '(a)');
    assert.equal(ns.calls.filter((call) => call.op === 'replaceIfVersion').length, 0, '(a) no write attempted');
    assertZeroMutation(ns, seed, '(a)');
  });

  // (b) A ref under A, binding A, ambient Z: sealed and committed at A.
  await scenario(Z, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const recorder = newRecorder();
    const ref = refUnder(A);
    let committed: OrderRecord | undefined;
    const run = await runBoundTransaction(ns, seed, recorder, (order) => {
      committed = withFields(order, 'aref', { [STATE_FIELD]: 'SNAPSHOTTED', [REF_FIELD]: ref });
      return { commit: committed, result: 'x' };
    });
    assert.equal(run.error, undefined, `(b) ${String(run.error)}`);
    assert.equal(run.result?.status, 'committed');
    assert.deepEqual(successfulWrites(ns.calls).map((call) => call.path), [pathIn(A)]);
    const stored = storedRef(ns.bodyAt(pathIn(A)));
    assert.equal(JSON.stringify(stored), JSON.stringify(ref), 'the stored ref is the validated ten values');
    assert.equal(committed && Reflect.get(committed, REF_FIELD), ref, "the caller's record is not mutated by the seal");
    assert.equal(ns.bodyAt(pathIn(Z)), seed[pathIn(Z)], 'Z untouched');
  });
});

/** The adapter trace and outcome of one scenario, normalized for NT-11 comparison. */
function normalizedRun(run: ScenarioRun): unknown {
  return {
    calls: run.ns.calls.map((call) => `${call.op}:${call.path}:${call.result}`),
    status: run.result?.status ?? null,
    provenance: run.result ? { ...run.result.provenance } : null,
    error: run.error === undefined ? null : (run.error as Error).name,
    guards: run.recorder.events.filter((event) => event.kind === 'guard').length,
  };
}

test('NT-11: a ref-less hold gets exactly the namespace protection of a ref-bearing snapshot commit', async () => {
  const compare = async (label: string, run: (shape: CommitShape) => Promise<ScenarioRun | ScenarioRun[]>) => {
    const traces: Record<CommitShape, unknown> = { 'ref-bearing': null, 'ref-less': null };
    for (const shape of ['ref-bearing', 'ref-less'] as const) {
      await scenario(A, async () => {
        const result = await run(shape);
        traces[shape] = Array.isArray(result) ? result.map(normalizedRun) : normalizedRun(result);
      });
    }
    assert.deepEqual(traces['ref-less'], traces['ref-bearing'], `${label}: identical traces and outcomes for both shapes`);
  };
  await compare('NT-5', checkNt5);
  await compare('NT-6', checkNt6);
  await compare('NT-7', checkNt7);
  await compare('NT-8', checkNt8);
});

const INTAKE_ID = `intake_${'d'.repeat(32)}`;

/** A checkout-intake order whose finalized selection is valid under `namespace`. */
function intakeRecord(namespace: string): OrderRecord {
  const assetId = `asset_${'e'.repeat(32)}`;
  const hero: FinalizedSelectionEntry = {
    slotKey: 'primary_hero_photo',
    category: 'primary_hero_photo',
    familyCharacterId: null,
    familyCharacterIndex: null,
    guidedStillIndex: null,
    assetId,
    pathname: intakeAssetPath(INTAKE_ID, assetId, namespace),
    mimeType: 'image/jpeg',
    size: 1024,
    etag: 'etag-nbt',
    generation: 1,
    consentAt: EPOCH,
    voiceSource: null,
  };
  const created = orders.createOrderRecord(
    { childName: 'Mina', bookFormat: 'digital', email: 'buyer@example.invalid' },
    { id: ORDER_ID, now: EPOCH, fulfillmentMode: 'manual_hold' },
  );
  const bound: OrderRecord = {
    ...created,
    checkoutAttemptId: 'b'.repeat(32),
    checkoutFingerprint: 'c'.repeat(64),
    checkoutLeaseId: '11111111-1111-4111-8111-111111111111',
    checkoutLeaseExpiresAt: '2026-10-15T11:59:59.999Z',
    primaryHeroIntakeMedia: hero,
    checkoutIntake: {
      intakeId: INTAKE_ID,
      fingerprint: finalizationFingerprint(INTAKE_ID, [hero]),
      orderContractDigest: '',
      selection: [hero],
    },
    checkoutIntakeMediaRetention: { status: 'active', activatedAt: EPOCH },
    internalDispositionNote: `seed:${namespace}`,
  };
  const digest = orders.checkoutIntakeOrderContractDigest(bound);
  assert.ok(digest);
  bound.checkoutIntake!.orderContractDigest = digest;
  return bound;
}

test('NT-12: the checkout-intake contract is evaluated against the binding on read and on commit', async () => {
  // Control first, so it also runs on a tree without NBT: the A intake bytes,
  // read through the ambient API under ambient Z, fail closed. That is
  // pre-existing behaviour NBT does not change. The cause is the selection
  // pathname check (`intake_record_invalid`), which runs inside the
  // checkout-intake contract before its own digest and fingerprint checks.
  await scenario(Z, async () => {
    nsOrderAdapter({ seed: { [pathIn(Z)]: bodyOf(intakeRecord(A)) } });
    const error = await rejection(() => orders.readOrderVersioned(ORDER_ID));
    assertPersistenceError(error, 'Stored order record is not valid JSON', 'ambient control');
    assert.equal(((error as orders.OrderPersistenceError).cause as Error).message, 'intake_record_invalid');
  });

  await scenario(Z, async () => {
    const seed = seedAZ(intakeRecord(A), intakeRecord(Z));
    const ns = nsOrderAdapter({ seed });
    const read = await nbt(() => orders.readOrderVersionedInNamespace(bindOrThrow(A), ORDER_ID));
    assert.equal(read.found?.order.internalDispositionNote, `seed:${A}`, 'the bound read must accept A intake under ambient Z');
    const recorder = newRecorder();
    const run = await runBoundTransaction(ns, seed, recorder, (order) => ({ commit: edit(order, 'intake-edit'), result: 'ok' }));
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.result?.status, 'committed');
    assert.deepEqual(successfulWrites(ns.calls).map((call) => call.path), [pathIn(A)]);
    assert.equal(ns.bodyAt(pathIn(Z)), seed[pathIn(Z)]);
  });
});

test('NT-13: a commit whose id is not the bound order id is refused and nothing is written', async () => {
  await scenario(A, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const recorder = newRecorder();
    const run = await runBoundTransaction(ns, seed, recorder, (order) => ({
      commit: { ...edit(order, 'wrong-id'), id: OTHER_ORDER_ID },
      result: 'x',
    }), { beforeCommit: recordedGuard(recorder) });
    assertPersistenceError(run.error, 'order_namespace_binding:commit_id_mismatch', 'NT-13');
    assert.equal(ns.calls.filter((call) => call.op === 'replaceIfVersion').length, 0);
    assert.equal(recorder.events.filter((event) => event.kind === 'guard').length, 0);
    assertZeroMutation(ns, seed, 'NT-13');
  });
});

test('NT-14: an empty or path-bearing order id is refused before the adapter is resolved', async () => {
  await scenario(A, async () => {
    const ns = nsOrderAdapter({ seed: seedAZ() });
    const binding = bindOrThrow(A);
    for (const orderId of ['', 'a/b', 'a\\b', 7 as unknown as string]) {
      for (const [entry, call] of [
        ['read', () => orders.readOrderVersionedInNamespace(binding, orderId)],
        ['transaction', () => orders.withOrderTransactionInNamespace(binding, orderId, () => ({ abort: 'x' }), {
          notFound: () => 'nf',
        })],
      ] as const) {
        assertPersistenceError(await rejection(call), 'order_namespace_binding:order_id_invalid', `${String(orderId)} via ${entry}`);
      }
    }
    assert.equal(ns.factoryCalls(), 0);
    assert.deepEqual(ns.calls, []);
  });
});

test('NT-15: A absent and Z present under ambient Z is not_found, with zero writes and Z never read', async () => {
  await scenario(Z, async () => {
    const seed = { [pathIn(Z)]: bodyOf(seedRecord(Z)) };
    const ns = nsOrderAdapter({ seed });
    const recorder = newRecorder();
    const run = await runBoundTransaction(ns, seed, recorder, () => ({ abort: 'never' }), { beforeCommit: recordedGuard(recorder) });
    assert.equal(run.result?.status, 'not_found');
    assert.equal(run.result?.status === 'not_found' ? run.result.result : null, 'not-found', 'the notFound() result');
    assertProvenance(run.result!.provenance, { namespace: A, reads: 1, commits: 0, outcome: 'not_found' });
    assert.deepEqual(recorder.mutateInputs, [], 'mutate is not called for an absent record');

    const read = await nbt(() => orders.readOrderVersionedInNamespace(bindOrThrow(A), ORDER_ID));
    assert.equal(read.found, null);
    assertProvenance(read.provenance, { namespace: A, reads: 1, commits: 0, outcome: 'not_found' });

    assert.deepEqual(callsUnder(ns.calls, Z), [], 'Z is never read');
    assertZeroMutation(ns, seed, 'NT-15');
  });
});

test('NT-16: an aborting decision writes nothing and never reaches the guard', async () => {
  await scenario(A, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const recorder = newRecorder();
    const run = await runBoundTransaction(ns, seed, recorder, () => ({ abort: 'declined' }), { beforeCommit: recordedGuard(recorder) });
    assert.equal(run.result?.status, 'aborted');
    assert.equal(run.result?.status === 'aborted' ? run.result.result : null, 'declined');
    assertProvenance(run.result!.provenance, { namespace: A, reads: 1, commits: 0, outcome: 'aborted' });
    assert.equal(recorder.events.filter((event) => event.kind === 'guard').length, 0);
    assertZeroMutation(ns, seed, 'NT-16');
  });
});

test('NT-17: bound commits never publish to the id-keyed cache, evict only older entries, and retract lost CAS claims', async () => {
  // (a) After a bound commit, an ambient attempt 1 reads the adapter.
  await scenario(A, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const run = await runBoundTransaction(ns, seed, newRecorder(), (order) => ({ commit: edit(order, 'bound-a'), result: 'x' }));
    assert.equal(run.result?.status, 'committed');
    const before = ns.calls.length;
    const seen = await orders.withOrderTransaction(ORDER_ID, (order) => ({ abort: order.internalDispositionNote }));
    assert.equal(seen, 'bound-a');
    assert.deepEqual(ns.calls.slice(before).map((call) => `${call.op}:${call.path}`), [`readVersioned:${pathIn(A)}`],
      '(a) the bound record was not published, so attempt 1 reads the adapter');
  });

  // (b-older) An older cached ambient entry for the id is evicted by the bound commit.
  await scenario(A, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    await orders.withOrderTransaction(ORDER_ID, (order) => ({ commit: edit(order, 'ambient-older'), result: null }));
    const run = await runBoundTransaction(ns, seed, newRecorder(), (order) => ({ commit: edit(order, 'bound-newer'), result: 'x' }));
    assert.equal(run.result?.status, 'committed');
    const before = ns.calls.length;
    const read = await orders.readOrderVersioned(ORDER_ID, { preferRecentCommit: true });
    assert.equal(ns.calls.length, before + 1, '(b) the stale entry was evicted, so the cached read goes to the adapter');
    assert.equal(read?.order.internalDispositionNote, 'bound-newer');
  });

  // (b-newer) A newer cached ambient entry (published mid-flight) is not evicted.
  await scenario(Z, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({
      seed,
      hook: async (op, index) => {
        if (op !== 'replaceIfVersion' || index !== 0) return;
        // The bound write is in flight at A; a newer ambient commit lands at Z and publishes.
        await orders.withOrderTransaction(ORDER_ID, (order) => ({ commit: edit(order, 'ambient-newer-z'), result: null }));
      },
    });
    const run = await runBoundTransaction(ns, seed, newRecorder(), (order) => ({ commit: edit(order, 'bound-older'), result: 'x' }));
    assert.equal(run.result?.status, 'committed');
    const before = ns.calls.length;
    const read = await orders.readOrderVersioned(ORDER_ID, { preferRecentCommit: true });
    assert.equal(ns.calls.length, before, '(b) the newer entry survives the bound commit');
    assert.equal(read?.order.internalDispositionNote, 'ambient-newer-z');
  });

  // (c) A bound lost CAS retracts its claim, so a concurrent ambient winner still publishes.
  await scenario(A, async () => {
    const seed = seedAZ();
    let boundError: unknown;
    const ns = nsOrderAdapter({
      seed,
      conflictAt: [1],
      conflictAdvancesVersion: false,
      hook: async (op, index) => {
        if (op !== 'replaceIfVersion' || index !== 0) return;
        boundError = await rejection(() => nbt(() => orders.withOrderTransactionInNamespace(bindOrThrow(A), ORDER_ID,
          (order) => ({ commit: edit(order, 'bound-loser'), result: 'x' }), { notFound: () => 'nf', maxAttempts: 1 })));
      },
    });
    await orders.withOrderTransaction(ORDER_ID, (order) => ({ commit: edit(order, 'ambient-winner'), result: null }));
    assert.ok(boundError instanceof orders.OrderVersionConflictError, '(c) the bound attempt lost its CAS');
    const before = ns.calls.length;
    const read = await orders.readOrderVersioned(ORDER_ID, { preferRecentCommit: true });
    assert.equal(ns.calls.length, before, '(c) the ambient winner still published');
    assert.equal(read?.order.internalDispositionNote, 'ambient-winner');
  });
});

test('NT-18: the adapter is resolved exactly once per bound call (the ambient API per read and per commit)', async () => {
  await scenario(A, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed, conflictAt: [0, 1, 2] });
    const run = await runBoundTransaction(ns, seed, newRecorder(), (order, call) => ({ commit: edit(order, `n${call}`), result: 'x' }));
    assert.equal(run.result?.status, 'committed');
    assert.equal(ns.factoryCalls(), 1, 'one resolution for a bound transaction with 3 conflicts');
    await nbt(() => orders.readOrderVersionedInNamespace(bindOrThrow(A), ORDER_ID));
    assert.equal(ns.factoryCalls(), 2, 'one resolution for a bound read');
  });
  // Control: the ambient API resolves per read and per commit.
  await scenario(A, async () => {
    const ns = nsOrderAdapter({ seed: seedAZ(), conflictAt: [0, 1, 2] });
    await orders.withOrderTransaction(ORDER_ID, (order) => ({ commit: edit(order, 'ambient'), result: null }));
    assert.equal(ns.factoryCalls(), 8, 'control: 4 reads + 4 commits');
  });
});

// ── NT-19: existing ambient callers, differential trace ────────────────────

function digestValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value && typeof value === 'object' && 'order' in value && 'version' in value) {
    const versioned = value as { order: OrderRecord; version: string };
    return { version: versioned.version, orderSha: sha(JSON.stringify(versioned.order)).slice(0, 16) };
  }
  return value;
}

/** One scripted scenario through the ambient API only. Recorded on the base tree. */
async function ambientDifferentialTrace(): Promise<unknown[]> {
  return scenario(A, async () => {
    const trace: unknown[] = [];
    const ns = nsOrderAdapter({ seed: seedAZ() });
    const step = async (label: string, fn: () => Promise<unknown>) => {
      const before = ns.calls.length;
      const factoryBefore = ns.factoryCalls();
      let value: unknown;
      let error: string | null = null;
      try {
        value = await fn();
      } catch (caught) {
        error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
      }
      trace.push({
        step: label,
        // The id is masked so the recorded trace carries no order-id-shaped literal (REQ16).
        ops: ns.calls.slice(before).map((call) =>
          [call.op, call.path.split(ORDER_ID).join('<id>'), call.expectedVersion, call.bodySha, call.result]),
        factory: ns.factoryCalls() - factoryBefore,
        value: digestValue(value),
        error,
      });
    };
    await step('txn-1 ambient A', () => orders.withOrderTransaction(ORDER_ID, (order) => ({
      commit: edit(order, 'edit-1'), result: order.internalDispositionNote,
    })));
    await step('txn-2 ambient A, attempt-1 cache hit', () => orders.withOrderTransaction(ORDER_ID, (order) => ({
      commit: edit(order, 'edit-2'), result: order.internalDispositionNote,
    })));
    setAmbient(Z);
    await step('read ambient Z', () => orders.readOrderVersioned(ORDER_ID));
    await step('txn-3 ambient Z, cache hit from A, conflict, retry', () => orders.withOrderTransaction(ORDER_ID, (order) => ({
      commit: edit(order, 'edit-3'), result: order.internalDispositionNote,
    })));
    await step('direct commit ambient Z, stale version', () =>
      orders.commitOrderConditional(edit(seedRecord(Z), 'edit-4'), 'v1-stale'));
    await step('cached read ambient Z', () => orders.readOrderVersioned(ORDER_ID, { preferRecentCommit: true }));
    trace.push({ final: NAMESPACES.map((namespace) => [namespace, sha(ns.bodyAt(pathIn(namespace)) ?? '').slice(0, 16)]) });
    return trace;
  });
}

/** Recorded in B0 from the untouched base tree (evidence/logs/B0-nt19-nt20.json). */
const NT19_BASE_TRACE: unknown[] = [
  {"step": "txn-1 ambient A", "ops": [["readVersioned", "ns-a/orders/<id>.json", null, null, "v1-064fc094"], ["replaceIfVersion", "ns-a/orders/<id>.json", "v1-064fc094", "c31b3989a5672455", "ok"]], "factory": 2, "value": "seed:ns-a", "error": null},
  {"step": "txn-2 ambient A, attempt-1 cache hit", "ops": [["replaceIfVersion", "ns-a/orders/<id>.json", "v2-064fc094", "785ae5a4c0dd55cc", "ok"]], "factory": 1, "value": "edit-1", "error": null},
  {"step": "read ambient Z", "ops": [["readVersioned", "ns-z/orders/<id>.json", null, null, "v1-c96336b4"]], "factory": 1, "value": {"version": "v1-c96336b4", "orderSha": "b0b84a774b9afae6"}, "error": null},
  {"step": "txn-3 ambient Z, cache hit from A, conflict, retry", "ops": [["replaceIfVersion", "ns-z/orders/<id>.json", "v3-064fc094", "fcb8f0bcc6d50876", "conflict"], ["readVersioned", "ns-z/orders/<id>.json", null, null, "v1-c96336b4"], ["replaceIfVersion", "ns-z/orders/<id>.json", "v1-c96336b4", "5762f2e3fa639d32", "ok"]], "factory": 3, "value": "seed:ns-z", "error": null},
  {"step": "direct commit ambient Z, stale version", "ops": [["replaceIfVersion", "ns-z/orders/<id>.json", "v1-stale", "99b6ba60f8e0f9ed", "conflict"]], "factory": 1, "value": {"ok": false, "reason": "version_conflict"}, "error": null},
  {"step": "cached read ambient Z", "ops": [], "factory": 0, "value": {"version": "v2-c96336b4", "orderSha": "7e1a0a51be94c90b"}, "error": null},
  {"final": [["", "e3b0c44298fc1c14"], ["ns-a", "785ae5a4c0dd55cc"], ["ns-b", "e3b0c44298fc1c14"], ["ns-z", "5762f2e3fa639d32"]]},
];

test('NT-19: existing ambient callers produce the identical adapter, cache and publish trace as on the base tree', async () => {
  assert.deepEqual(await ambientDifferentialTrace(), NT19_BASE_TRACE);
});

// ── Source pins (NT-20, NT-21) ─────────────────────────────────────────────

/** Index just past a quoted string starting at `i`. */
function skipQuoted(source: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < source.length && source[j] !== quote) j += source[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** Scan template text from `i`; stop after the closing backtick or after a `${` (pushed). */
function scanTemplate(source: string, i: number, stack: string[]): number {
  let j = i;
  while (j < source.length) {
    if (source[j] === '\\') { j += 2; continue; }
    if (source[j] === '`') return j + 1;
    if (source[j] === '$' && source[j + 1] === '{') { stack.push('interp'); return j + 2; }
    j += 1;
  }
  return j;
}

function regexAllowedAt(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j -= 1;
  if (j < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(source[j])) return true;
  return /\b(?:return|typeof|case|in|of)$/.test(source.slice(Math.max(0, j - 6), j + 1));
}

function skipRegex(source: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < source.length) {
    const ch = source[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) { j += 1; break; }
    j += 1;
  }
  while (j < source.length && /[a-z]/.test(source[j])) j += 1;
  return j;
}

/**
 * The file's own brace matcher: the text of the declaration that starts with
 * `head` (which must be unique), through its matching closing brace. Strings,
 * template literals, comments and regex literals are skipped.
 */
function declarationText(source: string, head: string): string {
  const start = source.indexOf(head);
  assert.ok(start >= 0, `${head} must exist`);
  assert.equal(source.indexOf(head, start + 1), -1, `${head} must be unique`);
  let i = start + head.length;
  let paren = head.endsWith('(') ? 1 : 0;
  while (i < source.length && !(source[i] === '{' && paren === 0)) {
    if (source[i] === '(') paren += 1;
    else if (source[i] === ')') paren -= 1;
    i += 1;
  }
  const stack: string[] = [];
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); continue; }
    if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (ch === '"' || ch === "'") { i = skipQuoted(source, i, ch); continue; }
    if (ch === '`') { i = scanTemplate(source, i + 1, stack); continue; }
    if (ch === '/' && regexAllowedAt(source, i)) { i = skipRegex(source, i); continue; }
    if (ch === '{') stack.push('block');
    else if (ch === '}') {
      const top = stack.pop();
      if (top === 'interp') { i = scanTemplate(source, i + 1, stack); continue; }
      if (stack.length === 0) return source.slice(start, i + 1);
    }
    i += 1;
  }
  assert.fail(`${head} has no matching brace`);
}

/** Pre-existing declarations NBT must leave byte-identical (architecture §N.4). */
const UNCHANGED_DECLARATIONS = [
  'function getOrderBlobPath(',
  'function getOrdersListPrefix(',
  'export async function readOrderVersioned(',
  'export async function commitOrderConditional(',
  'export async function withOrderTransaction<T>(',
  'export async function persistOrder(',
  'async function persistOrderUnsafe(',
  'export async function persistNewOrder(',
  'export async function getOrder(',
  'export async function getOrderAuthoritative(',
  'export async function listOrdersAuthoritative(',
  'function resolveOrderStoreAdapter(',
  'function blobOrderStoreAdapter(',
  'function localOrderStoreAdapter(',
  'function beginOrderWrite(',
  'function isNewestOrderWrite(',
  'function retractOrderWrite(',
  'function forgetRecentConditionalCommit(',
  'function publishConditionalCommit(',
  'function scrubRetiredPrivateFields(',
  'export interface OrderStoreAdapter ',
  'export function __setOrderStoreAdapterFactoryForTests(',
  'export function __resetOrderStoreAdapterFactoryForTests(',
] as const;

/**
 * The four NBT-C2…NBT-C5 declarations, with the ONLY permitted differences
 * from base: the signature line and the one bound expression or pass-through.
 */
const BOUND_HELPERS: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
  ['export function assertNoConfirmationRequestBytes(', [
    ['assertNoConfirmationRequestBytes(order: OrderRecord, boundNamespace?: string): void {',
      'assertNoConfirmationRequestBytes(order: OrderRecord): void {'],
    ['    namespace: boundNamespace ?? getBlobNamespace(),\n', '    namespace: getBlobNamespace(),\n'],
  ]],
  ['function sealConfirmationEnvelopeRefForWrite(', [
    ['sealConfirmationEnvelopeRefForWrite(write: OrderRecord, boundNamespace?: string): void {',
      'sealConfirmationEnvelopeRefForWrite(write: OrderRecord): void {'],
    ['    namespace: boundNamespace ?? getBlobNamespace(),\n', '    namespace: getBlobNamespace(),\n'],
  ]],
  ['function assertCheckoutIntakeOrderContract(', [
    ['assertCheckoutIntakeOrderContract(order: OrderRecord, boundNamespace?: string): void {',
      'assertCheckoutIntakeOrderContract(order: OrderRecord): void {'],
    ['  const namespace = boundNamespace ?? getBlobNamespace();\n', '  const namespace = getBlobNamespace();\n'],
  ]],
  ['function parseOrderRecord(', [
    ['parseOrderRecord(serialized: string, boundNamespace?: string): OrderRecord {',
      'parseOrderRecord(serialized: string): OrderRecord {'],
    ['  assertCheckoutIntakeOrderContract(order, boundNamespace);\n', '  assertCheckoutIntakeOrderContract(order);\n'],
  ]],
];

const NBT_IMPORT_HUNK: [string, string] = [
  "import { applyBlobNamespace, BlobNamespaceError, getBlobNamespace, withBlobNamespace } from './blob-namespace.ts';\n",
  "import { BlobNamespaceError, getBlobNamespace, withBlobNamespace } from './blob-namespace.ts';\n",
];
const NBT_BLOCK_START = '// ── NBT: the namespace-bound order transaction substrate';
const NBT_BLOCK_END = '// ── end NBT ──\n\n';

/**
 * Undo each permitted hunk; anything else stays a difference. A hunk text may
 * occur at most as many times as the list names it (NBT-C2 and NBT-C3 share
 * one expression).
 */
function revertHunks(text: string, hunks: ReadonlyArray<readonly [string, string]>): string {
  const allowed = new Map<string, { base: string; times: number }>();
  for (const [final, base] of hunks) {
    const entry = allowed.get(final);
    if (entry) {
      assert.equal(entry.base, base);
      entry.times += 1;
    } else {
      allowed.set(final, { base, times: 1 });
    }
  }
  let out = text;
  for (const [final, { base, times }] of allowed) {
    const count = out.split(final).length - 1;
    assert.ok(count <= times, `hunk text may occur at most ${times} time(s): ${final.trim()}`);
    out = out.split(final).join(base);
  }
  return out;
}

/** Recorded in B0 from the untouched base tree (evidence/logs/B0-nt19-nt20.json). */
const NT20_BASE_HASHES: Record<string, string> = {
  "function getOrderBlobPath(":
    '33c101588545df075899d7afa4e080a53bd6a0a096608630c5ea3d9ab41d018f',
  "function getOrdersListPrefix(":
    '854b2c88c27908f0f2592762c40532098b4be0b4bb1777f0f73ad8f0ce2efcdb',
  "export async function readOrderVersioned(":
    '15b248f66553de01364fe1e839b53ce629455c7bbb85d9988265de4b270c0e3e',
  "export async function commitOrderConditional(":
    '30cab2bde772fa5d32748c8432139c084720b8db1b775669be72b8133976983d',
  "export async function withOrderTransaction<T>(":
    'af2742857c2f096cbfe8093779f5275249bf5bec7d257f2ff9fba271a49bd0ad',
  "export async function persistOrder(":
    '69345e583e6148f39d68cf0a3a40b3b23e64adcc87db92aa0005dd24c791d20a',
  "async function persistOrderUnsafe(":
    '17720f10214efcf889b532fcc0a72808143c329a8d0f1c863b3c76337994c5c2',
  "export async function persistNewOrder(":
    '9f33a30fb4de2469dba1cfce9b1208ec09dcfbbbf613074c70d9f90fa7006838',
  "export async function getOrder(":
    '70dc468e0a9a88cf12586b8f8e8c5e8d6c0c520875583b5dbcca62fd1f162e49',
  "export async function getOrderAuthoritative(":
    '08f792fa0dbee4f483cc1ed20044429b06a9a3cdfe29572f6228c766f949903d',
  "export async function listOrdersAuthoritative(":
    'cd82d3d6c46f8297fdc758162a4123964806c1812f53e69d32cf9b24d427e2b8',
  "function resolveOrderStoreAdapter(":
    'b6fd3c883c3f01281939d5bbb67cc6b2b60fd0190a9ee073c0b60f0db232e1e7',
  "function blobOrderStoreAdapter(":
    'dad049a831efba9a76789494a2671e132360414d9b39587ee8a99251167a954e',
  "function localOrderStoreAdapter(":
    'cdfb7bb02d95208e346e7b2f50b300837e02db8697921318bb53ad6224bb2e54',
  "function beginOrderWrite(":
    '25967673e8f0bf2847271de137b193b891b0cf249d2072c3d95b4a9dac878ffd',
  "function isNewestOrderWrite(":
    '254ebef9740da86488d0d86471cd3f03203eb400a972679c6e1d92d7170b8dd3',
  "function retractOrderWrite(":
    '4500602f9b5668c3a6394d01088a4ea93315c0f94ab4997bf9c67198f0434122',
  "function forgetRecentConditionalCommit(":
    '0a242ec64599aedc1c3125a883026ed4c33fe913cc805c6c9feac14b53abb89a',
  "function publishConditionalCommit(":
    '5440a49f61a0d250705c0bfbb6a9eedf4583d9635ec34c66bf425c707611060d',
  "function scrubRetiredPrivateFields(":
    '9195bdfa3d922fd12d252b1e1ca2c7deb17ca3e712d0ba865917bd3a28bb9f83',
  "export interface OrderStoreAdapter ":
    '9eef709a6cf4dc5650a8596be3d2dc368c2c3022d82034b2760c97ca40b9b7c7',
  "export function __setOrderStoreAdapterFactoryForTests(":
    'c72321ad892c995df9281af8734974ad4a179856909ce09b36c1e6a01e31f2fc',
  "export function __resetOrderStoreAdapterFactoryForTests(":
    'd7dbde8cd950d1f111c7efe3ea40755d75c6a0bf279a70015efe6034443c0aad',
  "export function assertNoConfirmationRequestBytes(":
    '39cb686f253a845e66b2f74d33548e7355314f44d77aad86a4617bd6cd09fab5',
  "function sealConfirmationEnvelopeRefForWrite(":
    '4dddd33cb9634d71a7b0ea8b247ee2c27d07cf9176eb6c55c0aee9f942ee9039',
  "function assertCheckoutIntakeOrderContract(":
    '4e4c500444dab2cc27868e3771a8ce01fafe530911484a24319321c271c7c370',
  "function parseOrderRecord(":
    '04599044d1db019fa391e96d232706a328f4bc292298abeefbe333e799a7a2fa',
};
const NT20_BASE_FILE_SHA256 = '8c0498d42c750f1d5835f103c8b3f239b657e8a8b3beafebe036bd122d01d218';

test('NT-20: every existing declaration is source-identical to base; the four bound helpers differ only by the permitted hunks', () => {
  const actual: Record<string, string> = {};
  for (const head of UNCHANGED_DECLARATIONS) actual[head] = sha(declarationText(ORDERS_SOURCE, head));
  for (const [head, hunks] of BOUND_HELPERS) actual[head] = sha(revertHunks(declarationText(ORDERS_SOURCE, head), hunks));
  assert.deepEqual(actual, NT20_BASE_HASHES);

  // The whole file: remove the one NBT block, undo the permitted hunks, and
  // the result must be the base file byte for byte. This is what makes "every
  // other function in the file" a checked claim rather than a list.
  let whole = ORDERS_SOURCE;
  const blockStart = whole.indexOf(NBT_BLOCK_START);
  if (blockStart >= 0) {
    const blockEnd = whole.indexOf(NBT_BLOCK_END, blockStart);
    assert.ok(blockEnd > blockStart, 'the NBT block must be terminated');
    assert.equal(whole.indexOf(NBT_BLOCK_START, blockStart + 1), -1, 'exactly one NBT block');
    whole = whole.slice(0, blockStart) + whole.slice(blockEnd + NBT_BLOCK_END.length);
  }
  whole = revertHunks(whole, [NBT_IMPORT_HUNK, ...BOUND_HELPERS.flatMap(([, hunks]) => hunks)]);
  assert.equal(sha(whole), NT20_BASE_FILE_SHA256);
});

const NBT_DECLARATIONS = [
  'export function bindOrderNamespace(',
  'export function orderRecordPathInNamespace(',
  'export async function readOrderVersionedInNamespace(',
  'export async function withOrderTransactionInNamespace<T>(',
  'async function commitOrderConditionalInNamespace(',
] as const;

test('NT-21: the substrate is environment-free and cache-free by source', () => {
  const bodies = Object.fromEntries(NBT_DECLARATIONS.map((head) => [head, declarationText(ORDERS_SOURCE, head)]));
  for (const [head, body] of Object.entries(bodies)) {
    for (const forbidden of [
      'process.env', 'getBlobNamespace()', 'withBlobNamespace(', 'getOrderBlobPath(', 'getOrdersListPrefix(',
      'preferRecentCommit', 'publishConditionalCommit(', 'recentConditionalCommits', 'readOrderVersioned(',
      'commitOrderConditional(',
    ]) {
      assert.equal(body.includes(forbidden), false, `${head} must not contain ${forbidden}`);
    }
  }
  const bind = bodies['export function bindOrderNamespace('];
  assert.equal(bind.split('getBlobNamespace(').length - 1, 1, 'bindOrderNamespace resolves the grammar exactly once');
  assert.match(bind, /getBlobNamespace\(\{ HSB_BLOB_NAMESPACE: namespace \} as Partial<NodeJS\.ProcessEnv> as NodeJS\.ProcessEnv\)/,
    'on an object literal (a type-only cast), never process.env');
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  assert.equal(count(bodies['export async function readOrderVersionedInNamespace('], 'resolveOrderStoreAdapter()'), 1);
  assert.equal(count(bodies['export async function withOrderTransactionInNamespace<T>('], 'resolveOrderStoreAdapter()'), 1);
  assert.equal(count(bodies['async function commitOrderConditionalInNamespace('], 'resolveOrderStoreAdapter()'), 0);
  // The private writer is the only bound writer, and it is not exported.
  assert.equal(count(ORDERS_SOURCE, 'export async function commitOrderConditionalInNamespace'), 0);
  assert.equal(count(ORDERS_SOURCE, 'commitOrderConditionalInNamespace('), 2, 'declared once and called once');
});

test('NT-22: no namespace or Vercel env read inside any bound call; the token is read once, at entry, per call', async () => {
  const runs: Array<[string, () => Promise<unknown>]> = [
    ['NT-3', scenarioNt3],
    ['NT-5', () => scenario(A, () => checkNt5('ref-less'))],
    ['NT-6', () => scenario(A, () => checkNt6('ref-less'))],
    ['NT-7', () => scenario(A, () => checkNt7('ref-less'))],
  ];
  for (const [label, run] of runs) {
    const windowsBefore = NBT_WINDOWS.length;
    const hooksBefore = HOOK_WINDOWS.length;
    await withEnvRecorder(async (reads) => {
      await run();
      const windows = NBT_WINDOWS.slice(windowsBefore);
      const hooks = HOOK_WINDOWS.slice(hooksBefore);
      assert.ok(windows.length > 0, `${label}: at least one bound call`);
      const within = (seq: number, window: Window) => seq > window.start && seq < window.end;
      for (const window of windows) {
        const own = reads.filter((read) => within(read.seq, window) && !hooks.some((hook) => within(read.seq, hook)));
        assert.deepEqual(own.map((read) => read.key), ['BLOB_READ_WRITE_TOKEN'],
          `${label}: the only env read in a bound call is the adapter resolution, once`);
        const firstCall = ALL_ADAPTER_CALLS.find((call) => within(call.seq, window));
        assert.ok(firstCall && own[0].seq < firstCall.seq, `${label}: the adapter is resolved at entry, before any I/O`);
      }
    });
  }
});

test('NT-23: under agreement, bound and ambient paths, records, versions and stored bytes are identical', async () => {
  await scenario(A, async () => {
    const seed = seedAZ();
    const ns = nsOrderAdapter({ seed });
    const ambient = await orders.readOrderVersioned(ORDER_ID);
    const ambientPath = ns.calls.at(-1)!.path;
    const bound = await nbt(() => orders.readOrderVersionedInNamespace(bindOrThrow(A), ORDER_ID));
    assert.equal(orders.orderRecordPathInNamespace(bindOrThrow(A), ORDER_ID), ambientPath);
    assert.equal(ns.calls.at(-1)!.path, ambientPath);
    assert.deepEqual(bound.found?.order, ambient?.order);
    assert.equal(bound.found?.version, ambient?.version);
  });

  const stored: Record<string, string | undefined> = {};
  for (const via of ['bound', 'ambient'] as const) {
    await scenario(A, async () => {
      const seed = seedAZ();
      const ns = nsOrderAdapter({ seed });
      const commitOf = (order: OrderRecord) => withFields(order, 'agreed', { [REF_FIELD]: refUnder(A) });
      if (via === 'bound') {
        const run = await runBoundTransaction(ns, seed, newRecorder(), (order) => ({ commit: commitOf(order), result: 'x' }));
        assert.equal(run.result?.status, 'committed');
      } else {
        await orders.withOrderTransaction(ORDER_ID, (order) => ({ commit: commitOf(order), result: null }));
      }
      stored[via] = ns.bodyAt(pathIn(A));
    });
  }
  assert.ok(stored.bound);
  assert.equal(stored.bound, stored.ambient, 'a bound and an ambient commit of the same record store identical bytes');
});

test('NT-24: decision windows — the guard never runs inside a decision, and every decision saw only A', async () => {
  const runs: Array<[string, () => Promise<ScenarioRun | { ns: NsAdapter; recorder: Recorder }>]> = [
    ['NT-5', () => scenarioNt5('ref-bearing', { beforeCommit: (r) => recordedGuard(r) })],
    ['NT-6', () => scenarioConflicts('ref-bearing', 3, { beforeCommit: (r) => recordedGuard(r) })],
    ['NT-7', () => scenarioConflicts('ref-less', 5, { beforeCommit: (r) => recordedGuard(r) })],
    ['NT-8', () => scenarioRefusal('ref-less', () => false)],
    ['NT-9', scenarioGuardTiming],
    ['NT-9 seal refusal', async () => {
      const seed = seedAZ();
      const ns = nsOrderAdapter({ seed });
      const recorder = newRecorder();
      return runBoundTransaction(ns, seed, recorder, (order) => ({ commit: swappingRefCommit(order), result: 'x' }), {
        beforeCommit: recordedGuard(recorder),
      });
    }],
  ];
  for (const [label, run] of runs) {
    await scenario(A, async () => {
      const { ns, recorder } = await run();
      const windows: Array<[number, number]> = [];
      let open: number | null = null;
      for (const event of recorder.events) {
        if (event.kind === 'mutate:start') open = event.seq;
        if (event.kind === 'mutate:end' && open !== null) { windows.push([open, event.seq]); open = null; }
      }
      const merged = [
        ...ns.calls.map((call) => ({ seq: call.seq, kind: `${call.op}:${call.path}` })),
        ...recorder.events.map((event) => ({ seq: event.seq, kind: event.kind })),
      ].sort((left, right) => left.seq - right.seq);
      merged.forEach((event, index) => {
        if (event.kind !== 'guard') return;
        assert.ok(!windows.some(([start, end]) => event.seq > start && event.seq < end), `${label}: guard inside a decision`);
        assert.equal(merged[index - 1]?.kind, 'mutate:end', `${label}: the guard follows a completed decision`);
        const next = merged[index + 1];
        if (next !== undefined || label !== 'NT-8') {
          assert.equal(next?.kind, `replaceIfVersion:${pathIn(A)}`,
            `${label}: an accepting guard is followed directly by the write at the frozen path`);
        }
      });
      for (const input of recorder.mutateInputs) assert.equal(input, 'seed:ns-a', `${label}: decisions see only A`);
    });
  }
});

// ── ISO-8 / ISO-9 file-end assertions ──────────────────────────────────────

test('ISO-8/ISO-9: the ambient environment and the adapter seam are restored, and nothing was unscripted', () => {
  assert.equal(process.env, ORIGINAL_ENV, 'process.env must be the original object');
  for (const key of AMBIENT_KEYS) assert.equal(process.env[key], ORIGINAL_AMBIENT[key], `${key} restored`);
  assert.equal(OVERRIDE_ACTIVE, false, 'the order-store adapter override must be cleared');
  assert.equal(UNSCRIPTED_TOTAL, 0, 'no SyntheticUnscriptedCall in this file');
});
