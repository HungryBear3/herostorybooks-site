/**
 * HSB Phase B — default-off shadow settlement projection (server-only adapter).
 *
 * This records **bounded non-authoritative evidence** that a legacy checkout
 * settlement happened. It is not an order transition, not a payment transition,
 * and not a source of truth: the only SQL it may call is
 * `hsb_control.enqueue_projection`, whose downstream projection row is pinned
 * non-authoritative by a CHECK constraint.
 *
 * It is OFF unless `HSB_CONTROL_PLANE_SHADOW` is exactly the string `true`.
 * While OFF this module reads no other environment variable, constructs no
 * connection pool, loads no database driver, and issues no SQL.
 *
 * Best-effort by construction: `recordShadowCheckoutSettlement` never throws and
 * never alters the caller's control flow.
 *
 * Admission has a second gate the app flag does not control. The database stage
 * is evaluated independently, inside SQL, on every call:
 *   - at stage `off` (the default) the enqueue is refused with `ZH001`; that
 *     refusal is contained here and reported only as a bounded `failed` outcome;
 *   - at stage `shadow` the enqueue is admitted and one non-authoritative
 *     evidence row is written.
 * Neither state changes legacy authority. The enqueued row is pinned
 * non-authoritative in SQL, nothing applies it, and no legacy order, payment,
 * email, analytics, or fulfillment decision reads this module's outcome. This is
 * deliberately NOT fulfillment durability, NOT reconciliation, and NOT an
 * activation path.
 *
 * Server-only: `pg` is reached through a lazy dynamic import behind the flag, so
 * the driver never enters a client bundle.
 */

import { createHash } from 'node:crypto';

/** The exact settlement facts. Nothing else is ever sent. */
export interface ShadowSettlementFacts {
  orderKey: string;
  stripeSessionId: string;
  amountTotalCents: number;
  currency: string;
}

/** Minimal parameterized-query seam. Satisfied by `pg`'s Pool and by tests. */
export interface ShadowProjectionExecutor {
  (text: string, values: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Per-call injection, for tests. Production ignores the entire object without
 * reading or enumerating it. Nonproduction samples only the four explicit test
 * seams below. `logger` remains solely as an ignored source-compatibility field:
 * caller logging code is never read, reflected over, or executed.
 */
export interface ShadowSettlementOptions {
  env?: NodeJS.ProcessEnv;
  executor?: ShadowProjectionExecutor;
  createExecutor?: (env: NodeJS.ProcessEnv) => Promise<ShadowProjectionExecutor>;
  logger?: unknown;
  /**
   * Narrow per-call override of the total deadline, for tests that must prove
   * bounded resolution quickly. Outside a test runtime it is ignored, so the
   * exported `SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS` is what production applies.
   */
  deadlineMs?: number;
}

export type ShadowSettlementOutcome =
  | { status: 'disabled' }
  | { status: 'recorded'; inserted: boolean }
  | { status: 'failed'; errorClass: string; errorCode: string | null };

export const SHADOW_SETTLEMENT_SCHEMA = 'hsb.shadow.checkout_settlement.v1';
export const SHADOW_SETTLEMENT_ENTITY_KIND = 'legacy_checkout_settlement';
export const SHADOW_SETTLEMENT_MUTATION_SEQ = 0;
export const SHADOW_SETTLEMENT_SQL = 'SELECT hsb_control.enqueue_projection($1, $2, $3, $4::bytea, $5)';

/**
 * The finite total budget for one best-effort evidence attempt, covering executor
 * creation and the query together. It sits just above the driver's own
 * connect-plus-query bounds so it is an outer backstop rather than a competitor
 * to them, and it is what keeps a wedged driver from holding a payment webhook.
 */
export const SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS = 6_000;

/**
 * The effective SQL role. This path is webhook evidence intake, so it binds the
 * existing `hsb_webhook` privilege boundary — the narrowest role that holds
 * `enqueue_projection`. That role carries no order lifecycle, no provider
 * lifecycle, no stage machine, no worker, and no backfill function, and no
 * direct table DML, so a compromised shadow session cannot reach beyond
 * evidence. The pool binds its sessions to exactly that boundary; the server
 * additionally binds the runtime login to it by default, so a pooler that drops
 * startup options cannot widen the session.
 */
export const SHADOW_SETTLEMENT_EFFECTIVE_ROLE = 'hsb_webhook';

/**
 * The exact app flag. Anything other than the literal string `true` — absent,
 * empty, `false`, `TRUE`, `1`, padded, or malformed — leaves the shadow off.
 */
const SHADOW_FLAG_ENV_KEY = 'HSB_CONTROL_PLANE_SHADOW';

/**
 * The exact shape `createOrderRecord` mints: `ord_` plus sixteen lowercase hex
 * digits. This is deliberately the *producer's* identity, not merely something
 * SQL would tolerate — a person's name, a colon-separated handle, uppercase hex,
 * or a wrong prefix or length is not an HSB order and never reaches the database.
 */
const ORDER_KEY_PATTERN = /^ord_[a-f0-9]{16}$/;

/** Mirrors the SQL constraints the control plane enforces on Stripe identity. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_]{1,128}$/;
const CURRENCY_PATTERN = /^[a-z]{3}$/;

/** Bounds for the sanitized failure log. Nothing unbounded ever reaches it. */
const ERROR_CLASS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_]{1,16}$/;

type SanitizedWarningDetail = Readonly<{
  entityKind: string;
  entityKey: string;
  errorClass: string;
  errorCode: string | null;
}>;

type SanitizedWarning = Readonly<{
  message: string;
  detail: SanitizedWarningDetail;
}>;

const TEST_WARNING_LEDGER_LIMIT = 64;
const testWarningLedger: SanitizedWarning[] = [];
const CAPTURED_CONSOLE_WARN = console.warn.bind(console);

/**
 * The warning destination is captured once from trusted module state. It is
 * deliberately non-injectable and synchronous; its return value is ignored.
 * Nonproduction keeps a bounded module-owned ledger so tests stay quiet without
 * creating a callback seam. Production writes through the captured built-in.
 */
const INTERNAL_WARNING_SINK = (message: string, detail: SanitizedWarningDetail): void => {
  if (isProductionRuntime()) {
    CAPTURED_CONSOLE_WARN(message, detail);
    return;
  }
  const entry = Object.freeze({
    message,
    detail: Object.freeze({ ...detail }),
  });
  testWarningLedger.push(entry);
  if (testWarningLedger.length > TEST_WARNING_LEDGER_LIMIT) testWarningLedger.shift();
};

export class ShadowSettlementValidationError extends Error {
  constructor(field: string) {
    super(`HSB_CONTROL_PLANE_SHADOW_INVALID: shadow settlement field ${field} failed validation`);
    this.name = 'ShadowSettlementValidationError';
  }
}

export class ShadowSettlementConfigurationError extends Error {
  constructor(reason: string) {
    super(`HSB_CONTROL_PLANE_SHADOW_INVALID: ${reason}`);
    this.name = 'ShadowSettlementConfigurationError';
  }
}

/**
 * Raised when the importable test seam is touched under a production runtime.
 * The seam exists so the webhook route can be exercised without credentials or a
 * network; it is not a second activation path, so in production it fails closed
 * rather than quietly standing in for the ambient flag and the dedicated target.
 */
export class ShadowSettlementTestOverrideError extends Error {
  constructor(seam: string) {
    super(`HSB_CONTROL_PLANE_SHADOW_INVALID: the ${seam} test seam is refused in production`);
    this.name = 'ShadowSettlementTestOverrideError';
  }
}

export class ShadowSettlementDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`HSB_CONTROL_PLANE_SHADOW_DEADLINE: exceeded the ${deadlineMs}ms total evidence budget`);
    this.name = 'ShadowSettlementDeadlineError';
  }
}

type ShadowSettlementSnapshot = Readonly<{
  orderKey: unknown;
  stripeSessionId: unknown;
  amountTotalCents: unknown;
  currency: unknown;
}>;

type ValidatedShadowSettlementFacts = Readonly<ShadowSettlementFacts>;

/**
 * Sample exactly the four approved fields from hostile exported-boundary input.
 * Each read is total and independent, so one throwing getter cannot prevent the
 * other approved fields from being sampled. The plain frozen result severs all
 * later validation, canonicalization, enqueue, and error handling from caller
 * getters/proxy traps. No key enumeration is used, so extra fields are ignored
 * without being observed.
 */
function snapshotShadowSettlementFacts(facts: unknown): ShadowSettlementSnapshot {
  return Object.freeze({
    orderKey: safePropertyRead(facts, 'orderKey'),
    stripeSessionId: safePropertyRead(facts, 'stripeSessionId'),
    amountTotalCents: safePropertyRead(facts, 'amountTotalCents'),
    currency: safePropertyRead(facts, 'currency'),
  });
}

/**
 * Validate the already-detached snapshot against the producer's own bounds
 * BEFORE the database is reached. Nothing here can touch caller-owned state.
 */
function validateShadowSettlementSnapshot(
  snapshot: ShadowSettlementSnapshot,
): ValidatedShadowSettlementFacts {
  const { orderKey, stripeSessionId, amountTotalCents, currency } = snapshot;
  if (typeof orderKey !== 'string' || !ORDER_KEY_PATTERN.test(orderKey)) {
    throw new ShadowSettlementValidationError('orderKey');
  }
  if (typeof stripeSessionId !== 'string' || !SESSION_ID_PATTERN.test(stripeSessionId)) {
    throw new ShadowSettlementValidationError('stripeSessionId');
  }
  if (typeof amountTotalCents !== 'number' || !Number.isSafeInteger(amountTotalCents) || amountTotalCents < 0) {
    throw new ShadowSettlementValidationError('amountTotalCents');
  }
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new ShadowSettlementValidationError('currency');
  }
  return snapshot as ValidatedShadowSettlementFacts;
}

/** Serialize only a detached, fully validated snapshot. */
function canonicalValidatedShadowSettlementBytes(facts: ValidatedShadowSettlementFacts): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: SHADOW_SETTLEMENT_SCHEMA,
      orderKey: facts.orderKey,
      stripeSessionId: facts.stripeSessionId,
      amountTotalCents: facts.amountTotalCents,
      currency: facts.currency,
      paymentState: 'paid',
    }),
    'utf8',
  );
}

/**
 * The canonical payload: exactly six literal keys in exactly this order,
 * serialized as UTF-8 JSON. Any extra property on `facts` is dropped here, which
 * is what keeps buyer, provider, media, and raw-event data structurally out of
 * the control plane. (Five of the six vary with the settlement; `schema` is
 * fixed. The SQL call below binds five parameters, which is a different count
 * for a different reason: the payload travels as one `bytea`.)
 */
export function canonicalShadowSettlementBytes(facts: ShadowSettlementFacts): Buffer {
  const valid = validateShadowSettlementSnapshot(
    snapshotShadowSettlementFacts(facts),
  );
  return canonicalValidatedShadowSettlementBytes(valid);
}

/** SHA-256, lowercase hex, over the exact canonical bytes. */
export function shadowSettlementDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The module-private core accepts only the detached validated snapshot, issues
 * exactly one parameterized `enqueue_projection` call, and surfaces database
 * errors to the route-facing wrapper. The executor seam stays reachable to
 * tests only through that wrapper's nonproduction options; it is not an
 * exported bypass.
 *
 * Returns whether SQL inserted a new outbox row. An exact replay of the same
 * settlement converges to `false`; a *different* settlement under the same
 * identity raises `ZH007` inside SQL and is surfaced, never overwritten.
 */
async function enqueueShadowSettlementProjection(
  facts: ValidatedShadowSettlementFacts,
  executor: ShadowProjectionExecutor,
): Promise<boolean> {
  const payload = canonicalValidatedShadowSettlementBytes(facts);
  const digest = shadowSettlementDigest(payload);

  const result = await executor(SHADOW_SETTLEMENT_SQL, [
    SHADOW_SETTLEMENT_ENTITY_KIND,
    facts.orderKey,
    SHADOW_SETTLEMENT_MUTATION_SEQ,
    payload,
    digest,
  ]);

  return result?.rows?.[0]?.enqueue_projection === true;
}

// ---------------------------------------------------------------------------
// Lazy driver. Nothing below here runs until the flag has already passed.
// ---------------------------------------------------------------------------

interface LazyPool {
  query(text: string, values: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  on(event: 'error', listener: (error: unknown, client?: unknown) => void): unknown;
  end?(): Promise<void>;
}

/** The slice of the `pg` module surface this adapter is allowed to touch. */
export interface ShadowSettlementDriver {
  Pool: new (config: unknown) => LazyPool;
}

type PoolRuntimeMode = 'production' | 'nonproduction';

interface LazyPoolCache {
  readonly mode: PoolRuntimeMode;
  readonly promise: Promise<LazyPool>;
}

/**
 * One mode-tagged initialization promise, never a bare instance. Claiming the
 * promise synchronously preserves singleton construction under concurrent calls;
 * tagging it prevents a test-driver pool from crossing into production (or a
 * production pool from crossing back into a nonproduction runtime).
 */
let lazyPoolCache: LazyPoolCache | null = null;

function currentPoolRuntimeMode(): PoolRuntimeMode {
  return isProductionRuntime() ? 'production' : 'nonproduction';
}

/** Close either an initialized pool or one whose initialization is still pending. */
async function safelyClosePoolCache(cache: LazyPoolCache): Promise<void> {
  try {
    const pool = await cache.promise;
    await pool.end?.();
  } catch {
    // A rejected initialization or broken close has no useful caller-facing
    // signal. Cache retirement is containment and must never leak an error.
  }
}

/** Detach the current cache synchronously, then contain its eventual close. */
function detachLazyPoolCache(): LazyPoolCache | null {
  const detached = lazyPoolCache;
  lazyPoolCache = null;
  return detached;
}

/**
 * Construct the control-plane pool at most once, reading only the dedicated
 * control-plane connection setting. There is deliberately no fallback to the
 * application, Blob, or production connection settings: a shadow that cannot
 * find its own dedicated target must fail, not borrow someone else's.
 */
async function createPoolExecutor(
  env: NodeJS.ProcessEnv,
): Promise<ShadowProjectionExecutor> {
  const connectionString = env.HSB_CONTROL_PLANE_DATABASE_URL;
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new ShadowSettlementConfigurationError('no dedicated control-plane target is configured');
  }

  const mode = currentPoolRuntimeMode();
  if (lazyPoolCache !== null && lazyPoolCache.mode !== mode) {
    const stale = detachLazyPoolCache();
    if (stale !== null) void safelyClosePoolCache(stale);
  }

  if (lazyPoolCache === null) {
    const attempt = initializePool(connectionString);
    const cache: LazyPoolCache = { mode, promise: attempt };
    lazyPoolCache = cache;
    attempt.catch(() => {
      // A failed initialization is never cached, so a later call may retry. The
      // handler also keeps this rejection from ever being an unhandled one.
      if (lazyPoolCache === cache) lazyPoolCache = null;
    });
  }

  // Capture this mode's entry. A later runtime transition may replace the
  // module cache while this call is awaiting initialization; this call must not
  // jump across provenance and begin awaiting the replacement entry instead.
  const selected = lazyPoolCache;
  const pool = await selected.promise;
  return (text, values) => pool.query(text, values);
}

/**
 * Bind the session's effective SQL role to the boundary the control plane
 * actually granted. It is applied as a startup option, so the server refuses the
 * connection outright when the authenticated login is not a member of the role,
 * and it deliberately replaces any `options` the configured target carried.
 */
function withEffectiveRole(connectionString: string): string {
  let target: URL;
  try {
    target = new URL(connectionString);
  } catch {
    throw new ShadowSettlementConfigurationError(
      'the dedicated control-plane target is not a parseable connection URL',
    );
  }
  target.searchParams.set('options', `-c role=${SHADOW_SETTLEMENT_EFFECTIVE_ROLE}`);
  return target.toString();
}

async function initializePool(
  connectionString: string,
): Promise<LazyPool> {
  const bound = withEffectiveRole(connectionString);
  const driver = await loadShadowSettlementDriver();
  const pool = new driver.Pool({
    connectionString: bound,
    max: 2,
    application_name: 'hsb-shadow-settlement',
    // Conservative bounds: a shadow projection must never hold a webhook open.
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 4_000,
    statement_timeout: 4_000,
  });

  // pg-pool reports idle-client failures on the Pool itself, outside any awaited
  // query. An EventEmitter with no `error` listener re-throws them, which takes
  // the whole process down. Exactly one permanent listener, registered here at
  // construction, contains that: it emits one bounded sanitized line, mutates no
  // legacy state, and never lets the Error, the client, the target, or the
  // payload reach a log.
  //
  // The whole body is contained, not just the emit: the detail is built from an
  // arbitrary thrown object *before* `emitSanitizedWarning` can contain it, and
  // this listener is the one place where a throw is an uncaught exception
  // rather than a rejection. The sanitizers below are total on their own; this
  // keeps that true of the listener no matter what the detail later carries.
  pool.on('error', (error: unknown) => {
    try {
      emitSanitizedWarning('[hsb-control-plane] shadow settlement pool reported an idle failure', {
        entityKind: SHADOW_SETTLEMENT_ENTITY_KIND,
        entityKey: '<idle>',
        errorClass: sanitizedErrorClass(error),
        errorCode: sanitizedErrorCode(error),
      });
    } catch {
      // An idle-client report is best-effort evidence about a failure that has
      // already happened. It is never a reason to take the process down.
    }
  });

  return pool;
}

async function loadShadowSettlementDriver(): Promise<ShadowSettlementDriver> {
  // Consumed only outside production. The setter already refuses there; this is
  // the second half of the same guard, so a loader installed before the mode was
  // observable still cannot displace the real driver.
  if (driverLoaderForTest !== null && !isProductionRuntime()) return driverLoaderForTest();
  const pg = await import('pg');
  const Pool = (pg as unknown as { default?: ShadowSettlementDriver; Pool?: ShadowSettlementDriver['Pool'] }).Pool
    ?? (pg as unknown as { default: ShadowSettlementDriver }).default.Pool;
  return { Pool };
}

// ---------------------------------------------------------------------------
// Test seam. Lets the webhook route be exercised end to end without ambient
// credentials or a network, without exporting a production activation switch.
//
// These functions are importable from production code, so the seam is refused
// at its own boundary — and again where it is consumed — whenever the process
// is running as production. Otherwise imported test plumbing could stand in for
// the ambient flag, the dedicated target, and the real driver all at once.
// ---------------------------------------------------------------------------

let testOverrides: ShadowSettlementOptions | null = null;
let driverLoaderForTest: (() => Promise<ShadowSettlementDriver>) | null = null;

/**
 * Whether this process is production, read ONLY from the ambient environment.
 * Deliberately not from any caller- or override-supplied env: a seam must never
 * be able to declare the very mode that would exempt it.
 */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function __setShadowSettlementTestOverrides(options: ShadowSettlementOptions): void {
  if (isProductionRuntime()) {
    // Fail closed, and leave nothing behind: a refused call must not be able to
    // preserve a previously installed override either.
    testOverrides = null;
    throw new ShadowSettlementTestOverrideError('shadow settlement override');
  }
  testOverrides = options;
}

export function __resetShadowSettlementTestOverrides(): void {
  testOverrides = null;
  const stale = detachLazyPoolCache();
  if (stale !== null) void safelyClosePoolCache(stale);
}

/**
 * Substitute the driver module. This changes *which* `Pool` class is built, never
 * whether a pool may be built at all: the flag and the dedicated-target guard
 * still gate every call, so this is not an activation bypass.
 */
export function __setShadowSettlementDriverForTest(
  loader: (() => Promise<ShadowSettlementDriver>) | null,
): void {
  if (loader !== null && isProductionRuntime()) {
    driverLoaderForTest = null;
    throw new ShadowSettlementTestOverrideError('shadow settlement driver');
  }
  driverLoaderForTest = loader;
}

/** Release a pool a test caused to exist, so it cannot outlive the test run. */
export async function __closeShadowSettlementPoolForTest(): Promise<void> {
  const stale = detachLazyPoolCache();
  if (stale !== null) await safelyClosePoolCache(stale);
}

/** Read already-sanitized nonproduction warnings without installing code. */
export function __readShadowSettlementWarningsForTest(): readonly SanitizedWarning[] {
  if (isProductionRuntime()) throw new ShadowSettlementTestOverrideError('shadow settlement warning ledger');
  return testWarningLedger.map((entry) => Object.freeze({
    message: entry.message,
    detail: Object.freeze({ ...entry.detail }),
  }));
}

/** Clear the bounded nonproduction warning ledger between assertions. */
export function __clearShadowSettlementWarningsForTest(): void {
  if (isProductionRuntime()) throw new ShadowSettlementTestOverrideError('shadow settlement warning ledger');
  testWarningLedger.length = 0;
}

/**
 * Read one property off an untrusted value without trusting the read itself.
 *
 * What reaches these sanitizers is an arbitrary thrown object, so `code`,
 * `constructor`, and `constructor.name` may each be an accessor — or a proxy
 * trap — that throws. On the pool's idle path that read happens inside an
 * EventEmitter listener, outside any awaited query, so a throw there is an
 * uncaught exception that ends the process rather than a catchable rejection.
 * A failed read is therefore not an error to report: it yields `undefined` and
 * the caller falls back to its bounded default. The thrown reason is discarded
 * unexamined, so hostile getter text reaches no log, no outcome, and no branch.
 */
function safePropertyRead(source: unknown, key: string): unknown {
  if (source === null || source === undefined) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function sanitizedErrorClass(error: unknown): string {
  const name = safePropertyRead(safePropertyRead(error, 'constructor'), 'name');
  return typeof name === 'string' && ERROR_CLASS_PATTERN.test(name) ? name : 'Error';
}

function sanitizedErrorCode(error: unknown): string | null {
  const code = safePropertyRead(error, 'code');
  return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : null;
}

/**
 * The only place this module writes a line. The destination is the trusted
 * synchronous sink captured at module initialization; caller state cannot
 * select or execute a logging callback, and no sink return value is inspected.
 */
function emitSanitizedWarning(
  message: string,
  detail: SanitizedWarningDetail,
): void {
  try {
    INTERNAL_WARNING_SINK(message, detail);
  } catch {
    // A warning failure is not a reason to fail a payment webhook.
  }
}

type NonproductionSettings = Pick<
  ShadowSettlementOptions,
  'env' | 'executor' | 'createExecutor' | 'deadlineMs'
>;

/** Sample only the four documented nonproduction seams, without enumeration. */
function snapshotNonproductionSettings(source: unknown): NonproductionSettings {
  return {
    env: safePropertyRead(source, 'env') as NodeJS.ProcessEnv | undefined,
    executor: safePropertyRead(source, 'executor') as ShadowProjectionExecutor | undefined,
    createExecutor: safePropertyRead(source, 'createExecutor') as ShadowSettlementOptions['createExecutor'],
    deadlineMs: safePropertyRead(source, 'deadlineMs') as number | undefined,
  };
}

/**
 * Bound how long the wrapper itself may take. This is a fail-open budget, not a
 * cancellation: work already handed to the driver keeps running under pg's own
 * connect, query, and statement bounds, and nothing here can stop arbitrary
 * injected work. The losing promise keeps a rejection handler, so a failure that
 * lands after the budget expires can never surface as an unhandled rejection,
 * and the timer is unreferenced and cleared so it cannot pin the process open.
 */
function withTotalDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShadowSettlementDeadlineError(deadlineMs)), deadlineMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The route-facing best-effort wrapper. Never throws, never changes the
 * caller's response, and emits at most one bounded sanitized line per failure:
 * an opaque entity identity plus a safe error class and SQLSTATE. No message,
 * no stack, no provider payload, no connection details.
 */
export async function recordShadowCheckoutSettlement(
  facts: ShadowSettlementFacts,
  options?: ShadowSettlementOptions,
): Promise<ShadowSettlementOutcome> {
  // In production neither the stored test override nor the caller's own
  // `options` is read at all: this
  // wrapper is exported and importable, so its second argument is reachable
  // from anywhere it is, and `env`, `executor`, `createExecutor`, and
  // `deadlineMs` would each be a second activation path. A route-facing call is
  // therefore governed only by the ambient exact-string flag, the dedicated
  // control-plane target, the real Pool path, the exported total deadline, and
  // the module-owned warning destination.
  const production = isProductionRuntime();
  // Outside production, both sources are untrusted exported-boundary values.
  // Sample only the four documented seams with total single-property reads;
  // never enumerate either object and never touch `logger`.
  const stored: NonproductionSettings = production ? {} : snapshotNonproductionSettings(testOverrides);
  const direct: NonproductionSettings = production ? {} : snapshotNonproductionSettings(options);
  const settings: NonproductionSettings = production ? {} : {
    env: direct.env ?? stored.env,
    executor: direct.executor ?? stored.executor,
    createExecutor: direct.createExecutor ?? stored.createExecutor,
    deadlineMs: direct.deadlineMs ?? stored.deadlineMs,
  };
  const env = settings.env ?? process.env;

  if (env[SHADOW_FLAG_ENV_KEY] !== 'true') return { status: 'disabled' };

  const override = settings.deadlineMs;
  const deadlineMs = typeof override === 'number' && Number.isFinite(override) && override > 0
    ? override
    : SHADOW_SETTLEMENT_TOTAL_DEADLINE_MS;

  let failureEntityKey = '<invalid>';
  try {
    const valid = validateShadowSettlementSnapshot(snapshotShadowSettlementFacts(facts));
    // Identity becomes loggable only once every fact has validated. From here
    // onward the catch path uses this detached opaque value and never `facts`.
    failureEntityKey = valid.orderKey;
    const attempt = (async () => {
      const executor = settings.executor
        ?? (settings.createExecutor
          ? await settings.createExecutor(env)
          : await createPoolExecutor(env));
      return enqueueShadowSettlementProjection(valid, executor);
    })();
    const inserted = await withTotalDeadline(attempt, deadlineMs);
    return { status: 'recorded', inserted };
  } catch (error) {
    const errorClass = sanitizedErrorClass(error);
    const errorCode = sanitizedErrorCode(error);
    emitSanitizedWarning('[hsb-control-plane] shadow settlement evidence not recorded', {
      entityKind: SHADOW_SETTLEMENT_ENTITY_KIND,
      entityKey: failureEntityKey,
      errorClass,
      errorCode,
    });
    return { status: 'failed', errorClass, errorCode };
  }
}
