/**
 * Checkout intake abuse guard.
 *
 * TWO SEPARATE CONCERNS, DELIBERATELY NOT FUSED
 * ---------------------------------------------
 * `assertBrowserMutationRequest` is a BROWSER guard: it proves a mutation came
 * from our own page rather than from a cross-site form post. It belongs on
 * routes the browser calls directly.
 *
 * `consumeCheckoutBudget` / `enforceCheckoutBudget` is COST accounting: it
 * bounds how much work anyone can make this endpoint do in a minute.
 *
 * The previous implementation fused them, and the checkout upload route
 * applied the fused guard to every POST. Vercel Blob delivers its upload
 * completion as a server-to-server callback with an HMAC signature and no
 * `Origin` or `Sec-Fetch-Site` header, so in production every completion was
 * rejected with 403 `origin_required` before `handleUpload` could verify its
 * signature — the state machine's completion half never ran at all. Keeping
 * the two apart is the fix: the budget path here takes no `Request` and can
 * therefore never reintroduce a header check.
 *
 * FAIL-CLOSED DURABLE STATE
 * -------------------------
 * A counter we cannot read or cannot trust is not a counter of zero.
 *
 *   - `read` throwing means the store is unavailable → 503, and NOTHING is
 *     written. (Swallowing the error and writing a fresh bucket is what let an
 *     unavailable store allow unlimited traffic.)
 *   - A record that does not validate → 503. Unvalidated records let
 *     `requestCount: "x"` become `"x1"`, `"x11"`, … while every
 *     `"x11" > limit` comparison was `NaN > limit`, i.e. never true.
 *   - CAS is required on every update, so two concurrent consumers cannot lose
 *     an increment. Running out of attempts is a 503, not a silent overwrite.
 *
 * IDENTITY
 * --------
 * Buckets are keyed by (scope, minute) alone. There is deliberately no
 * per-client dimension: `x-forwarded-for` and friends are attacker-controlled,
 * and a guard that shards on them bounds nothing. These are global ceilings on
 * a pre-payment endpoint, sized so ordinary checkout traffic never reaches
 * them.
 */
import { BlobPreconditionFailedError, get, put } from '@vercel/blob';

import { applyBlobNamespace, getBlobNamespace } from './blob-namespace.ts';
import { normalizeEtagForIfMatch } from './blob-etag.ts';
import { assertDistinctBlobStores, parseBlobToken } from './checkout-blob-identity.ts';
import { IntakeError } from './checkout-intake.ts';

export const CHECKOUT_GUARD_TOKEN_ENV = 'HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN';
export const GUARD_BUCKET_MS = 60_000;
const GUARD_CAS_ATTEMPTS = 6;
const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CheckoutGuardStoreIo {
  get?: typeof get;
  put?: typeof put;
}

export interface CheckoutGuardCost {
  requestCount?: number;
  intakeCreations?: number;
  uploadReservations?: number;
  uploadBytes?: number;
  finalizations?: number;
  replacementCount?: number;
}

export interface CheckoutGuardLimits {
  requestLimit: number;
  intakeCreationLimit: number;
  uploadReservationLimit: number;
  uploadByteLimit: number;
  finalizationLimit: number;
  replacementLimit: number;
}

export interface CheckoutGuardBucket extends Required<CheckoutGuardCost> {
  scope: string;
  bucketStart: number;
  updatedAt: string;
}

export interface CheckoutGuardStore {
  /** `null` for an absent bucket. THROWS when the store is unavailable. */
  read(pathname: string): Promise<{ record: unknown; etag: string } | null>;
  /**
   * Conditional write. `ifMatch` absent means "create only if absent".
   * Returns false when the precondition failed (someone else got there
   * first); throws when the store is unavailable.
   */
  write(pathname: string, record: CheckoutGuardBucket, options: { ifMatch?: string }): Promise<boolean>;
}

const COUNTER_KEYS = [
  'requestCount',
  'intakeCreations',
  'uploadReservations',
  'uploadBytes',
  'finalizations',
  'replacementCount',
] as const;

const LIMIT_FOR_COUNTER: Record<(typeof COUNTER_KEYS)[number], keyof CheckoutGuardLimits> = {
  requestCount: 'requestLimit',
  intakeCreations: 'intakeCreationLimit',
  uploadReservations: 'uploadReservationLimit',
  uploadBytes: 'uploadByteLimit',
  finalizations: 'finalizationLimit',
  replacementCount: 'replacementLimit',
};

// ---------------------------------------------------------------------------
// Browser guard (never called from the budget path)
// ---------------------------------------------------------------------------

/**
 * Proves a mutating request came from our own page.
 *
 * Only for routes the BROWSER calls. Never apply it to a provider callback:
 * those authenticate with a signature and legitimately carry no `Origin`.
 */
export function assertBrowserMutationRequest(request: Request): void {
  const origin = request.headers.get('origin');
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (!origin || !secFetchSite) throw new IntakeError('origin_required', 403);
  let expected: string;
  try {
    expected = new URL(request.url).origin;
  } catch {
    throw new IntakeError('origin_forbidden', 403);
  }
  if (origin !== expected) throw new IntakeError('origin_forbidden', 403);
  if (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
    throw new IntakeError('origin_forbidden', 403);
  }
}

// ---------------------------------------------------------------------------
// Bucket addressing, parsing, arithmetic
// ---------------------------------------------------------------------------

/**
 * The durable address of a counter bucket.
 *
 * A pure function of (scope, minute) plus the environment namespace. It takes
 * no request, so no client-controlled value can shift a caller into a private
 * bucket; and it is namespaced with the same primitive the order and intake
 * stores use, so Preview cannot consume or exhaust production's budget.
 */
export function guardBucketPath(
  scope: string,
  bucketStart: number,
  namespace = getBlobNamespace(),
): string {
  if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) {
    throw new IntakeError('abuse_guard_scope_invalid', 500);
  }
  if (!Number.isSafeInteger(bucketStart) || bucketStart < 0 || bucketStart % GUARD_BUCKET_MS !== 0) {
    throw new IntakeError('abuse_guard_state_invalid', 503);
  }
  return applyBlobNamespace(`guard/${scope}/${bucketStart}.json`, namespace);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fail-closed schema validation for a stored bucket.
 *
 * Every counter must be a non-negative safe integer and the record must
 * identify the exact bucket we asked for. A record that fails any of these is
 * refused; it is never repaired, defaulted, or arithmetically extended.
 */
const BUCKET_KEYS = ['scope', 'bucketStart', 'updatedAt', ...COUNTER_KEYS] as const;

export function parseGuardBucket(
  raw: unknown,
  expect: { scope: string; bucketStart: number },
): CheckoutGuardBucket {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IntakeError('abuse_guard_state_invalid', 503);
  }
  const value = raw as Record<string, unknown>;
  // An unknown field is somewhere contradictory state could sit unread — for a
  // record whose whole job is to say "no", partly understood is not understood.
  for (const key of Object.keys(value)) {
    if (!BUCKET_KEYS.includes(key as (typeof BUCKET_KEYS)[number])) {
      throw new IntakeError('abuse_guard_state_invalid', 503);
    }
  }
  if (value.scope !== expect.scope || value.bucketStart !== expect.bucketStart) {
    throw new IntakeError('abuse_guard_state_invalid', 503);
  }
  if (typeof value.updatedAt !== 'string'
    || value.updatedAt.length < 20
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new IntakeError('abuse_guard_state_invalid', 503);
  }
  const bucket: CheckoutGuardBucket = {
    scope: expect.scope,
    bucketStart: expect.bucketStart,
    updatedAt: value.updatedAt,
    requestCount: 0,
    intakeCreations: 0,
    uploadReservations: 0,
    uploadBytes: 0,
    finalizations: 0,
    replacementCount: 0,
  };
  for (const key of COUNTER_KEYS) {
    const counter = value[key];
    if (!isCounter(counter)) throw new IntakeError('abuse_guard_state_invalid', 503);
    bucket[key] = counter;
  }
  return bucket;
}

export function normalizeGuardCost(cost?: CheckoutGuardCost): Required<CheckoutGuardCost> {
  const read = (value: unknown, fallback: number): number => {
    if (value === undefined || value === null) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new IntakeError('abuse_guard_cost_invalid', 500);
    }
    return value as number;
  };
  return {
    requestCount: read(cost?.requestCount, 1),
    intakeCreations: read(cost?.intakeCreations, 0),
    uploadReservations: read(cost?.uploadReservations, 0),
    uploadBytes: read(cost?.uploadBytes, 0),
    finalizations: read(cost?.finalizations, 0),
    replacementCount: read(cost?.replacementCount, 0),
  };
}

function emptyBucket(scope: string, bucketStart: number): CheckoutGuardBucket {
  return {
    scope,
    bucketStart,
    updatedAt: new Date(bucketStart).toISOString(),
    requestCount: 0,
    intakeCreations: 0,
    uploadReservations: 0,
    uploadBytes: 0,
    finalizations: 0,
    replacementCount: 0,
  };
}

function applyCost(
  current: CheckoutGuardBucket,
  cost: Required<CheckoutGuardCost>,
  now: number,
  limits: CheckoutGuardLimits,
): CheckoutGuardBucket {
  const next: CheckoutGuardBucket = { ...current, updatedAt: new Date(now).toISOString() };
  for (const key of COUNTER_KEYS) {
    const total = current[key] + cost[key];
    if (!Number.isSafeInteger(total)) throw new IntakeError('abuse_guard_state_invalid', 503);
    if (total > limits[LIMIT_FOR_COUNTER[key]]) throw new IntakeError('rate_limited', 429);
    next[key] = total;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Consumption
// ---------------------------------------------------------------------------

/**
 * Adds `cost` to the current minute's bucket for `scope`, or refuses.
 *
 * Takes a store and numbers — never a `Request`. A refused spend is not
 * banked: the limit check happens before the write, so a rejected caller does
 * not consume budget from the callers behind it.
 */
export async function consumeCheckoutBudget(
  store: CheckoutGuardStore,
  params: {
    scope: string;
    now: number;
    limits: CheckoutGuardLimits;
    cost?: CheckoutGuardCost;
    namespace?: string;
  },
): Promise<void> {
  const bucketStart = params.now - (params.now % GUARD_BUCKET_MS);
  const pathname = guardBucketPath(params.scope, bucketStart, params.namespace ?? getBlobNamespace());
  const cost = normalizeGuardCost(params.cost);

  for (let attempt = 0; attempt < GUARD_CAS_ATTEMPTS; attempt += 1) {
    let existing: { record: unknown; etag: string } | null;
    try {
      existing = await store.read(pathname);
    } catch (error) {
      // An unreadable guard is an unenforceable guard.
      if (error instanceof IntakeError) throw error;
      throw new IntakeError('abuse_guard_unavailable', 503);
    }

    const current = existing
      ? parseGuardBucket(existing.record, { scope: params.scope, bucketStart })
      : emptyBucket(params.scope, bucketStart);
    const next = applyCost(current, cost, params.now, params.limits);

    let written: boolean;
    try {
      written = await store.write(pathname, next, existing ? { ifMatch: existing.etag } : {});
    } catch (error) {
      if (error instanceof IntakeError) throw error;
      throw new IntakeError('abuse_guard_unavailable', 503);
    }
    if (written) return;
  }
  throw new IntakeError('abuse_guard_unavailable', 503);
}

/** Compensate a committed cost when the protected mutation fails. */
export async function refundCheckoutBudget(
  store: CheckoutGuardStore,
  params: { scope: string; now: number; cost: CheckoutGuardCost; namespace?: string },
): Promise<void> {
  const bucketStart = params.now - (params.now % GUARD_BUCKET_MS);
  const pathname = guardBucketPath(params.scope, bucketStart, params.namespace ?? getBlobNamespace());
  const cost = normalizeGuardCost(params.cost);
  for (let attempt = 0; attempt < GUARD_CAS_ATTEMPTS; attempt += 1) {
    let existing: { record: unknown; etag: string } | null;
    try { existing = await store.read(pathname); }
    catch { throw new IntakeError('abuse_guard_unavailable', 503); }
    if (!existing) throw new IntakeError('abuse_guard_state_invalid', 503);
    const current = parseGuardBucket(existing.record, { scope: params.scope, bucketStart });
    const next: CheckoutGuardBucket = { ...current, updatedAt: new Date(params.now).toISOString() };
    for (const key of COUNTER_KEYS) {
      if (cost[key] > current[key]) throw new IntakeError('abuse_guard_state_invalid', 503);
      next[key] = current[key] - cost[key];
    }
    try {
      if (await store.write(pathname, next, { ifMatch: existing.etag })) return;
    } catch {
      throw new IntakeError('abuse_guard_unavailable', 503);
    }
  }
  throw new IntakeError('abuse_guard_unavailable', 503);
}

// ---------------------------------------------------------------------------
// Limits + environment resolution
// ---------------------------------------------------------------------------

const DEFAULT_REQUEST_LIMIT = 45;
const DEFAULT_CALLBACK_REQUEST_LIMIT = 120;

/**
 * How many authenticated upload completions we will service per minute.
 *
 * Separate from the browser request limit because the two are driven by
 * different things: browser traffic by people, completions by however many
 * uploads are in flight.
 */
export function resolveCallbackRequestLimit(env: NodeJS.ProcessEnv): number {
  return readConfiguredLimit(
    env,
    'HSB_CHECKOUT_GUARD_MAX_CALLBACKS_PER_MINUTE',
    DEFAULT_CALLBACK_REQUEST_LIMIT,
  );
}

/**
 * Reads one configured limit, or refuses to run.
 *
 * Unset (or empty) means "use the documented default". Anything else must
 * parse exactly as a non-negative integer: replacing a malformed value with
 * the default silently widens a limit somebody was deliberately tightening.
 * `0` is a legitimate configuration — "allow nothing" is a real operational
 * request — and survives as `0`.
 */
export function readConfiguredLimit(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const trimmed = String(raw).trim();
  // Plain decimal digits only. `Number()` would also accept '0x10' (16) and
  // '1e3' (1000), so what is configured would not be what is read.
  if (!/^\d+$/.test(trimmed)) throw new IntakeError('abuse_guard_config_invalid', 503);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new IntakeError('abuse_guard_config_invalid', 503);
  }
  return parsed;
}

export function resolveGuardLimits(
  env: NodeJS.ProcessEnv,
  requestLimit = DEFAULT_REQUEST_LIMIT,
): CheckoutGuardLimits {
  return {
    requestLimit,
    intakeCreationLimit: readConfiguredLimit(env, 'HSB_CHECKOUT_GUARD_MAX_INTAKES_PER_MINUTE', 12),
    uploadReservationLimit: readConfiguredLimit(env, 'HSB_CHECKOUT_GUARD_MAX_UPLOADS_PER_MINUTE', 24),
    uploadByteLimit: readConfiguredLimit(env, 'HSB_CHECKOUT_GUARD_MAX_UPLOAD_BYTES_PER_MINUTE', 120 * 1024 * 1024),
    finalizationLimit: readConfiguredLimit(env, 'HSB_CHECKOUT_GUARD_MAX_FINALIZATIONS_PER_MINUTE', 12),
    replacementLimit: readConfiguredLimit(env, 'HSB_CHECKOUT_GUARD_MAX_REPLACEMENTS_PER_MINUTE', 32),
  };
}

function getRequiredGuardToken(env: NodeJS.ProcessEnv): string {
  const token = env[CHECKOUT_GUARD_TOKEN_ENV]?.trim();
  if (!token) throw new IntakeError('abuse_guard_unavailable', 503);
  // Sharing a STORE with orders or with intake media would let a guard write
  // reach state it has no business touching. Compared by parsed store id, not
  // by token string: two credentials for one store are two different strings.
  try {
    parseBlobToken(token, 'guard');
    assertDistinctBlobStores([
      { label: 'guard', token },
      { label: 'order', token: env.BLOB_READ_WRITE_TOKEN?.trim() },
      { label: 'intake', token: env.HSB_INTAKE_BLOB_READ_WRITE_TOKEN?.trim() },
    ]);
  } catch {
    throw new IntakeError('abuse_guard_unavailable', 503);
  }
  return token;
}

export function resolveCheckoutGuardStore(env: NodeJS.ProcessEnv): CheckoutGuardStore {
  if (env.HSB_CHECKOUT_GUARD_MODE === 'durable') {
    return createBlobCheckoutGuardStore(getRequiredGuardToken(env), env);
  }
  // A process-local counter is worthless across serverless instances, so it is
  // available only outside production and only when explicitly opted into.
  if (env.VERCEL_ENV !== 'production' && env.HSB_CHECKOUT_ALLOW_PROCESS_LOCAL_GUARD === 'true') {
    return processLocalGuardStore;
  }
  throw new IntakeError('abuse_guard_unavailable', 503);
}

export async function enforceCheckoutBudget(params: {
  scope: string;
  cost?: CheckoutGuardCost;
  now?: number;
  env?: NodeJS.ProcessEnv;
  requestLimit?: number;
  store?: CheckoutGuardStore | null;
}): Promise<void> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const store = params.store ?? resolveCheckoutGuardStore(env);
  await consumeCheckoutBudget(store, {
    scope: params.scope,
    now,
    limits: resolveGuardLimits(env, params.requestLimit),
    cost: params.cost,
    namespace: getBlobNamespace(env),
  });
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

export function createMemoryCheckoutGuardStore(): CheckoutGuardStore {
  const buckets = new Map<string, { record: CheckoutGuardBucket; etag: string }>();
  let etagCounter = 0;
  return {
    async read(pathname) {
      const entry = buckets.get(pathname);
      return entry ? { record: { ...entry.record }, etag: entry.etag } : null;
    },
    async write(pathname, record, options) {
      const entry = buckets.get(pathname);
      if (options.ifMatch === undefined) {
        if (entry) return false;
      } else if (!entry || entry.etag !== options.ifMatch) {
        return false;
      }
      etagCounter += 1;
      buckets.set(pathname, { record: { ...record }, etag: `guard-etag-${etagCounter}` });
      return true;
    },
  };
}

/** Non-production only; see `resolveCheckoutGuardStore`. */
const processLocalGuardStore: CheckoutGuardStore = createMemoryCheckoutGuardStore();

export function createBlobCheckoutGuardStore(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
  io: CheckoutGuardStoreIo = {},
): CheckoutGuardStore {
  // Resolved at construction so a Preview deployment with no explicit
  // namespace cannot come into existence pointing at production buckets.
  getBlobNamespace(env);
  const getImpl = io.get ?? get;
  const putImpl = io.put ?? put;
  return {
    async read(pathname) {
      const result = await getImpl(pathname, { access: 'private', token, useCache: false });
      if (!result || !result.stream) return null;
      const text = await new Response(result.stream).text();
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        throw new IntakeError('abuse_guard_state_invalid', 503);
      }
      const etag = normalizeEtagForIfMatch(result.blob.etag);
      if (!etag) throw new IntakeError('abuse_guard_unavailable', 503);
      return { record, etag };
    },

    async write(pathname, record, options) {
      const body = JSON.stringify(record);
      if (options.ifMatch !== undefined) {
        try {
          await putImpl(pathname, body, {
            access: 'private',
            token,
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: 'application/json',
            ifMatch: options.ifMatch,
          });
          return true;
        } catch (error) {
          if (error instanceof BlobPreconditionFailedError) return false;
          throw error;
        }
      }
      try {
        await putImpl(pathname, body, {
          access: 'private',
          token,
          addRandomSuffix: false,
          allowOverwrite: false,
          contentType: 'application/json',
        });
        return true;
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return false;
        // A create can also fail because another instance created the bucket
        // between our read and our write. Rather than pattern-matching the
        // provider's message, ask storage: if the object now exists this was a
        // lost race and the caller should retry with a real CAS.
        const existing = await getImpl(pathname, { access: 'private', token, useCache: false }).catch(() => null);
        if (existing) return false;
        throw error;
      }
    },
  };
}
