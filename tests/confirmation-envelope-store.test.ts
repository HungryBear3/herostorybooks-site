/**
 * The dedicated private confirmation-envelope store (L-4 Slice A3-2).
 *
 * The SDK is reached only through injected seams. Every negative test uses
 * seams that THROW if they are touched, so "zero SDK calls" is proven rather
 * than assumed, and every positive test records the exact pathname, token and
 * options each call carried.
 *
 * Nothing here performs network, storage, provider, email, customer or
 * payment I/O, and the operator probe's live entry point is never invoked —
 * only its injected arms are exercised.
 *
 * Every fixture is synthetic. Tokens follow the repository's existing test
 * convention; order ids are assembled rather than written as literals so a
 * valid id cannot read as a production identifier to REQ16.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { fileURLToPath } from 'node:url';

// The ONE SDK value these tests import: cleanup verification turns on the
// SDK's own error class, so a test that hand-rolled a stand-in would be
// testing its own fixture rather than the contract.
import { BlobNotFoundError } from '@vercel/blob';

import {
  buildConfirmationEmailEnvelope,
  digestConfirmationRequest,
  type ConfirmationEmailEnvelopeV1,
  type ConfirmationEmailRequestV1,
} from '../src/lib/confirmation-email-envelope.ts';
import {
  CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES,
  CONFIRMATION_ENVELOPE_TOKEN_ENV,
} from '../src/lib/confirmation-envelope-config.ts';
import {
  createConfirmationEnvelopeStore,
  type ConfirmationEnvelopeStore,
  type ConfirmationEnvelopeStoreIo,
} from '../src/lib/confirmation-envelope-store.ts';
import {
  PROBE_ARMS,
  PROBE_BODY,
  confirmationEnvelopeProbePath,
  isProvenObjectAbsence,
  runConfirmationEnvelopeStoreProbe,
} from '../scripts/probe-confirmation-envelope-store.ts';

const REPO = path.resolve(fileURLToPath(import.meta.url), '../..');

const tokenFor = (storeId: string, secret: string) => `vercel_blob_rw_${storeId}_${secret}`;

const ENVELOPE_TOKEN = tokenFor('EnvStore0001', 'envelopesecret01');
const ORDER_TOKEN = tokenFor('OrderStore001', 'ordersecret01');
const ENVELOPE_SECRET = 'envelopesecret01';

const SYNTHETIC_ID_BODY = 'a5f0'.repeat(4);
const VALID_ORDER_ID = `ord_${SYNTHETIC_ID_BODY}`;
const OTHER_ORDER_ID = `ord_${'b4e1'.repeat(4)}`;

const NAMESPACE = 'previewns';
const EXPECTED_PATH = `${NAMESPACE}/confirmation-envelopes/${VALID_ORDER_ID}/v1.json`;

/**
 * A canary that must never appear in anything this module returns, throws or
 * logs. It stands in for an SDK message, a Blob URL and a request fragment all
 * at once: if any of those can cross the boundary, this string crosses with
 * them.
 */
const LEAK_CANARY = 'CANARY-envelope-must-not-escape';

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    [CONFIRMATION_ENVELOPE_TOKEN_ENV]: ENVELOPE_TOKEN,
    BLOB_READ_WRITE_TOKEN: ORDER_TOKEN,
    HSB_BLOB_NAMESPACE: NAMESPACE,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function syntheticRequest(overrides: Partial<ConfirmationEmailRequestV1> = {}): ConfirmationEmailRequestV1 {
  return {
    from: 'Synthetic Sender <sender@example.invalid>',
    to: ['buyer@example.invalid'],
    subject: 'Synthetic order confirmation',
    html: '<p>Synthetic confirmation body</p>',
    text: 'Synthetic confirmation body',
    replyTo: 'support@example.invalid',
    ...overrides,
  } as ConfirmationEmailRequestV1;
}

function syntheticEnvelope(orderId = VALID_ORDER_ID): ConfirmationEmailEnvelopeV1 {
  const built = buildConfirmationEmailEnvelope({
    orderId,
    templateVersion: 'order-confirmation@synthetic',
    createdAt: '2026-09-24T00:00:00.000Z',
    idempotencyKey: `order-confirmation-${orderId}-primary-v1`,
    providerBinding: { accountLabel: 'hsb-synthetic-test-v1' },
    request: syntheticRequest(),
  });
  assert.equal(built.ok, true);
  return (built as { ok: true; envelope: ConfirmationEmailEnvelopeV1 }).envelope;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

interface Call {
  readonly op: 'put' | 'get' | 'del';
  readonly pathname: string;
  readonly options: Record<string, unknown>;
}

/** Seams that fail the test if any of them is reached. */
function forbiddenIo(calls: Call[]): ConfirmationEnvelopeStoreIo {
  const forbid = (op: Call['op']) =>
    (async (pathname: string, ...rest: unknown[]) => {
      calls.push({ op, pathname, options: (rest.at(-1) ?? {}) as Record<string, unknown> });
      throw new Error(`the SDK must not be reached: ${op}`);
    }) as never;
  return { put: forbid('put'), get: forbid('get'), del: forbid('del') };
}

interface Recorder {
  readonly calls: Call[];
  readonly io: ConfirmationEnvelopeStoreIo;
  readonly objects: Map<string, string>;
}

/**
 * A recording private-store adapter.
 *
 * It models the two SDK behaviours this slice depends on: a PUBLIC store
 * rejects `access: 'private'`, and `allowOverwrite: false` refuses an object
 * that already exists. Both are modelled so a test can assert the refusal
 * rather than assume it.
 */
function recorder(options: {
  publicStore?: boolean;
  seed?: Record<string, string>;
  putError?: () => Error;
  getError?: () => Error;
  delError?: () => Error;
} = {}): Recorder {
  const calls: Call[] = [];
  const objects = new Map<string, string>(Object.entries(options.seed ?? {}));

  const io: ConfirmationEnvelopeStoreIo = {
    put: (async (pathname: string, body: string, opts: Record<string, unknown>) => {
      calls.push({ op: 'put', pathname, options: opts });
      if (options.putError) throw options.putError();
      if (options.publicStore && opts.access === 'private') {
        throw new Error('Cannot use private access on a public store');
      }
      if (opts.allowOverwrite === false && objects.has(pathname)) {
        throw new Error('This blob already exists, use allowOverwrite: true to overwrite it');
      }
      objects.set(pathname, body);
      return {
        url: `https://example-store.invalid/${pathname}?${LEAK_CANARY}`,
        downloadUrl: `https://example-store.invalid/${pathname}?download&${LEAK_CANARY}`,
        pathname,
        contentType: String(opts.contentType ?? ''),
        contentDisposition: 'inline',
      };
    }) as never,

    get: (async (pathname: string, opts: Record<string, unknown>) => {
      calls.push({ op: 'get', pathname, options: opts });
      if (options.getError) throw options.getError();
      const body = objects.get(pathname);
      if (body === undefined) return null;
      return {
        statusCode: 200,
        stream: new Response(body).body,
        headers: new Headers(),
        blob: {
          url: `https://example-store.invalid/${pathname}?${LEAK_CANARY}`,
          downloadUrl: `https://example-store.invalid/${pathname}?download&${LEAK_CANARY}`,
          pathname,
          contentDisposition: 'inline',
          cacheControl: 'no-store',
          uploadedAt: new Date(0),
          etag: 'synthetic-etag',
          contentType: 'application/json',
          size: Buffer.byteLength(body, 'utf8'),
        },
      };
    }) as never,

    del: (async (pathname: string, opts: Record<string, unknown>) => {
      calls.push({ op: 'del', pathname, options: opts });
      if (options.delError) throw options.delError();
      objects.delete(pathname);
    }) as never,
  };

  return { calls, io, objects };
}

/**
 * The refusal on a failed result.
 *
 * This repository compiles with "strict": false, so strictNullChecks is off
 * and TypeScript does not narrow a boolean-literal discriminant; the surrounding
 * suites use the same shape of cast.
 */
function refusalOf(result: { ok: boolean }): string | null {
  return result.ok ? null : (result as unknown as { refusal: string }).refusal;
}

function openStore(env: NodeJS.ProcessEnv, io: ConfirmationEnvelopeStoreIo): ConfirmationEnvelopeStore {
  const result = createConfirmationEnvelopeStore(env, io);
  assert.equal(result.ok, true, 'the store was expected to construct');
  return (result as { ok: true; value: ConfirmationEnvelopeStore }).value;
}

/** Everything a refusal could possibly carry, flattened for leak assertions. */
function surfaceOf(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    inner instanceof Error ? { name: inner.name, message: inner.message, stack: inner.stack } : inner,
  ) ?? String(value);
}

/**
 * Credentials, Blob URLs, SDK text and stacks may never cross the boundary on
 * ANY path, success included.
 */
function assertNoLeak(value: unknown): void {
  const surface = surfaceOf(value);
  for (const forbidden of [
    LEAK_CANARY,
    ENVELOPE_TOKEN,
    ORDER_TOKEN,
    ENVELOPE_SECRET,
    'vercel_blob_rw_',
    'https://',
    'downloadUrl',
    'at Object',
  ]) {
    assert.ok(!surface.includes(forbidden), `surface leaked ${forbidden}: ${surface}`);
  }
}

/**
 * Request bytes may never ride out on a REFUSAL. A successful read returns the
 * envelope — that is what a read is for — so this is asserted only on the
 * failure arm, which is the arm an operator surface and a log sink see.
 */
function assertNoRequestBytes(value: unknown): void {
  const surface = surfaceOf(value);
  for (const fragment of [
    'buyer@example.invalid',
    'Synthetic order confirmation',
    'Synthetic confirmation body',
    'support@example.invalid',
  ]) {
    assert.ok(!surface.includes(fragment), `refusal surface leaked request bytes: ${fragment}`);
  }
}

// ── Construction refuses before any SDK call (S-1…S-4, S-6) ─────────────────

test('an unconfigured credential refuses construction and touches no SDK', () => {
  const calls: Call[] = [];
  const env = baseEnv();
  delete env[CONFIRMATION_ENVELOPE_TOKEN_ENV];
  const result = createConfirmationEnvelopeStore(env, forbiddenIo(calls));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'store_unconfigured');
  assert.deepEqual(calls, []);
});

test('a credential naming the order store refuses construction and touches no SDK', () => {
  const calls: Call[] = [];
  const result = createConfirmationEnvelopeStore(
    baseEnv({ [CONFIRMATION_ENVELOPE_TOKEN_ENV]: tokenFor('OrderStore001', 'adifferentsecret') }),
    forbiddenIo(calls),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'store_not_dedicated');
  assert.deepEqual(calls, []);
});

test('an invalid namespace refuses construction and touches no SDK', () => {
  const calls: Call[] = [];
  const result = createConfirmationEnvelopeStore(
    baseEnv({ HSB_BLOB_NAMESPACE: 'two/segments' }),
    forbiddenIo(calls),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'namespace_invalid');
  assert.deepEqual(calls, []);
});

// ── S-7: the path grammar, before any SDK call ──────────────────────────────

test('every operation refuses a non-grammatical order id with zero SDK calls', async () => {
  const calls: Call[] = [];
  const store = openStore(baseEnv(), forbiddenIo(calls));
  const envelope = JSON.stringify(syntheticEnvelope());
  for (const orderId of [
    '../etc',
    `ord_${SYNTHETIC_ID_BODY}/..`,
    `ord_${SYNTHETIC_ID_BODY.toUpperCase()}`,
    `ord_${SYNTHETIC_ID_BODY.slice(0, 15)}`,
    `ord_${SYNTHETIC_ID_BODY}0`,
    '',
  ]) {
    for (const result of [
      await store.write(orderId, envelope),
      await store.read(orderId),
      await store.delete(orderId),
    ]) {
      assert.equal(result.ok, false, `${JSON.stringify(orderId)} must refuse`);
      assert.equal(result.ok === false && result.refusal, 'path_invalid');
    }
  }
  assert.deepEqual(calls, [], 'no SDK call may be made for an invalid order id');
});

// ── P-1: the write carries exactly the private, write-once options ──────────

test('a write carries the dedicated token and the private write-once options', async () => {
  const rec = recorder();
  const store = openStore(baseEnv(), rec.io);
  const envelope = syntheticEnvelope();
  const serialized = JSON.stringify(envelope);

  const result = await store.write(VALID_ORDER_ID, serialized);
  assert.equal(result.ok, true);
  assert.equal(rec.calls.length, 1);

  const [call] = rec.calls;
  assert.equal(call!.op, 'put');
  assert.equal(call!.pathname, EXPECTED_PATH);
  assert.deepEqual(call!.options, {
    access: 'private',
    allowOverwrite: false,
    addRandomSuffix: false,
    contentType: 'application/json',
    token: ENVELOPE_TOKEN,
  });
});

test('the write returns the computed path and never the SDK url', async () => {
  const rec = recorder();
  const store = openStore(baseEnv(), rec.io);
  const serialized = JSON.stringify(syntheticEnvelope());
  const result = await store.write(VALID_ORDER_ID, serialized);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok === true ? Object.keys(result.value).sort() : [], [
    'objectPath',
    'storedBytes',
  ]);
  assert.equal(result.ok === true && result.value.objectPath, EXPECTED_PATH);
  assertNoLeak(result);
});

// ── P-3: bytes are stored verbatim and survive the digest fence ─────────────

test('the caller bytes are stored verbatim and read back byte-identical', async () => {
  const rec = recorder();
  const store = openStore(baseEnv(), rec.io);
  const envelope = syntheticEnvelope();
  // Pretty-printed on purpose: if anything on the write path re-serialized,
  // normalized or trimmed, these bytes would not survive.
  const serialized = JSON.stringify(envelope, null, 2);
  assert.ok(serialized.includes('\n  '));

  const written = await store.write(VALID_ORDER_ID, serialized);
  assert.equal(written.ok, true);
  assert.equal(rec.objects.get(EXPECTED_PATH), serialized);
  assert.equal(
    written.ok === true && written.value.storedBytes,
    Buffer.byteLength(serialized, 'utf8'),
  );

  const read = await store.read(VALID_ORDER_ID);
  assert.equal(read.ok, true);
  const back = (read as { ok: true; value: ConfirmationEmailEnvelopeV1 }).value;
  assert.deepEqual(back, envelope);
  assert.equal(digestConfirmationRequest(back.request!), back.canonicalDigest);
});

// ── P-4: reads are private and uncached ─────────────────────────────────────

test('a read carries the dedicated token, private access and no cache', async () => {
  const serialized = JSON.stringify(syntheticEnvelope());
  const rec = recorder({ seed: { [EXPECTED_PATH]: serialized } });
  const store = openStore(baseEnv(), rec.io);

  const result = await store.read(VALID_ORDER_ID);
  assert.equal(result.ok, true);
  assert.equal(rec.calls.length, 1);
  assert.deepEqual(rec.calls[0], {
    op: 'get',
    pathname: EXPECTED_PATH,
    options: { access: 'private', useCache: false, token: ENVELOPE_TOKEN },
  });
});

// ── S-5: a public store rejects the private write, and nothing is retried ───

test('a public-store rejection is store_not_private with exactly one put', async () => {
  const rec = recorder({ publicStore: true });
  const store = openStore(baseEnv(), rec.io);
  const result = await store.write(VALID_ORDER_ID, JSON.stringify(syntheticEnvelope()));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'store_not_private');
  assert.equal(rec.calls.length, 1, 'there must be no second attempt of any kind');
  assert.equal(rec.calls[0]!.options.access, 'private');
  assert.equal(rec.calls[0]!.options.token, ENVELOPE_TOKEN);
  assert.equal(rec.objects.size, 0, 'nothing may be stored after a rejected private write');
  assertNoLeak(result);
});

// ── P-5: write-once ─────────────────────────────────────────────────────────

test('a second write is object_exists and never clobbers the first', async () => {
  const rec = recorder();
  const store = openStore(baseEnv(), rec.io);
  const first = JSON.stringify(syntheticEnvelope());

  assert.equal((await store.write(VALID_ORDER_ID, first)).ok, true);

  const replacement = JSON.stringify(
    syntheticEnvelope(),
    null,
    4,
  );
  assert.notEqual(replacement, first);
  const second = await store.write(VALID_ORDER_ID, replacement);

  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.refusal, 'object_exists');
  assert.equal(rec.objects.get(EXPECTED_PATH), first, 'the first object must be untouched');
  assertNoLeak(second);
});

// ── Delete ──────────────────────────────────────────────────────────────────

test('delete removes the object, is idempotent, and carries the dedicated token', async () => {
  const serialized = JSON.stringify(syntheticEnvelope());
  const rec = recorder({ seed: { [EXPECTED_PATH]: serialized } });
  const store = openStore(baseEnv(), rec.io);

  const first = await store.delete(VALID_ORDER_ID);
  assert.equal(first.ok, true);
  assert.equal(rec.objects.has(EXPECTED_PATH), false);

  const second = await store.delete(VALID_ORDER_ID);
  assert.equal(second.ok, true, 'a second delete is not an error');

  for (const call of rec.calls) {
    assert.equal(call.op, 'del');
    assert.equal(call.pathname, EXPECTED_PATH);
    assert.deepEqual(call.options, { token: ENVELOPE_TOKEN });
  }
});

test('a delete failure that is not an absent object is delete_failed', async () => {
  const rec = recorder({ delError: () => new Error(`service unavailable ${LEAK_CANARY}`) });
  const store = openStore(baseEnv(), rec.io);
  const result = await store.delete(VALID_ORDER_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'delete_failed');
  assertNoLeak(result);
});

test('deleting an object the store says is absent is success', async () => {
  const rec = recorder({ delError: () => Object.assign(new Error('blob not found'), { name: 'BlobNotFoundError' }) });
  const store = openStore(baseEnv(), rec.io);
  assert.equal((await store.delete(VALID_ORDER_ID)).ok, true);
});

// ── Read refusals ───────────────────────────────────────────────────────────

test('an absent object is not_found', async () => {
  const rec = recorder();
  const store = openStore(baseEnv(), rec.io);
  const result = await store.read(VALID_ORDER_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'not_found');
});

test('an unreadable store is read_failed, not a silent absence', async () => {
  const rec = recorder({ getError: () => new Error(`upstream exploded ${LEAK_CANARY}`) });
  const store = openStore(baseEnv(), rec.io);
  const result = await store.read(VALID_ORDER_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'read_failed');
  assertNoLeak(result);
});

test('an unparseable or wrongly shaped object is invalid_object', async () => {
  const envelope = syntheticEnvelope();
  const broken: Record<string, string> = {
    'not json at all': 'this is not json',
    'wrong envelope version': JSON.stringify({ ...envelope, envelopeVersion: 2 }),
    'another order id': JSON.stringify({ ...envelope, orderId: OTHER_ORDER_ID }),
    'missing template version': JSON.stringify({ ...envelope, templateVersion: '' }),
    'missing account label': JSON.stringify({ ...envelope, providerBinding: {} }),
    'two recipients': JSON.stringify({
      ...envelope,
      request: { ...envelope.request, to: ['a@example.invalid', 'b@example.invalid'] },
    }),
    'non-integer canonical bytes': JSON.stringify({ ...envelope, canonicalBytes: 1.5 }),
  };
  for (const [label, body] of Object.entries(broken)) {
    const rec = recorder({ seed: { [EXPECTED_PATH]: body } });
    const store = openStore(baseEnv(), rec.io);
    const result = await store.read(VALID_ORDER_ID);
    assert.equal(result.ok, false, label);
    assert.equal(result.ok === false && result.refusal, 'invalid_object', label);
  }
});

test('a tombstone is refused by this slice, deliberately', async () => {
  // A3-2 implements no retention policy and has no tombstone-aware read: a
  // digest cannot be recomputed over a payload that is gone. A3-7 owns the
  // lifecycle. Pinned so the choice is visible rather than discovered.
  const envelope = syntheticEnvelope();
  const tombstone = JSON.stringify({ ...envelope, request: null, purgedAt: '2026-09-24T00:00:00.000Z' });
  const rec = recorder({ seed: { [EXPECTED_PATH]: tombstone } });
  const store = openStore(baseEnv(), rec.io);
  const result = await store.read(VALID_ORDER_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'invalid_object');
});

test('an object whose request does not hash to its own digest is digest_mismatch', async () => {
  const envelope = syntheticEnvelope();
  const tampered = JSON.stringify({
    ...envelope,
    request: { ...envelope.request, subject: 'Tampered subject' },
  });
  const rec = recorder({ seed: { [EXPECTED_PATH]: tampered } });
  const store = openStore(baseEnv(), rec.io);
  const result = await store.read(VALID_ORDER_ID);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'digest_mismatch');
});

test('an oversized object is refused by the declared size and by the stream', async () => {
  const oversized = 'x'.repeat(CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES + 1);

  const declared = recorder({ seed: { [EXPECTED_PATH]: oversized } });
  const byDeclaredSize = await openStore(baseEnv(), declared.io).read(VALID_ORDER_ID);
  assert.equal(refusalOf(byDeclaredSize), 'too_large');

  // The same object with a store that under-reports its size: the ceiling must
  // still hold while buffering, because a size header is a claim, not a fact.
  const lying = recorder({ seed: { [EXPECTED_PATH]: oversized } });
  const originalGet = lying.io.get!;
  lying.io.get = (async (pathname: string, opts: Record<string, unknown>) => {
    const result = await (originalGet as (p: string, o: unknown) => Promise<{ blob: { size: number } }>)(
      pathname,
      opts,
    );
    return { ...result, blob: { ...result.blob, size: 10 } };
  }) as never;
  const byStream = await openStore(baseEnv(), lying.io).read(VALID_ORDER_ID);
  assert.equal(refusalOf(byStream), 'too_large');
});

// ── Write refusals ──────────────────────────────────────────────────────────

test('a write of bytes that could not survive their own read fence is refused', async () => {
  const envelope = syntheticEnvelope();
  const cases: Array<[string, string, string]> = [
    ['unparseable', 'not json', 'invalid_object'],
    ['wrong order id', JSON.stringify({ ...envelope, orderId: OTHER_ORDER_ID }), 'invalid_object'],
    [
      'digest that does not match',
      JSON.stringify({ ...envelope, canonicalDigest: 'f'.repeat(64) }),
      'digest_mismatch',
    ],
  ];
  for (const [label, body, refusal] of cases) {
    const rec = recorder();
    const store = openStore(baseEnv(), rec.io);
    const result = await store.write(VALID_ORDER_ID, body);
    assert.equal(result.ok, false, label);
    assert.equal(result.ok === false && result.refusal, refusal, label);
    assert.deepEqual(rec.calls, [], `${label} must refuse before the SDK`);
  }
});

test('an oversized write is refused before the SDK', async () => {
  const rec = recorder();
  const store = openStore(baseEnv(), rec.io);
  const result = await store.write(
    VALID_ORDER_ID,
    'x'.repeat(CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES + 1),
  );
  assert.equal(result.ok === false && result.refusal, 'too_large');
  assert.deepEqual(rec.calls, []);
});

test('an unclassifiable write failure is write_failed and carries nothing out', async () => {
  const rec = recorder({ putError: () => new Error(`provider said ${LEAK_CANARY}`) });
  const store = openStore(baseEnv(), rec.io);
  const result = await store.write(VALID_ORDER_ID, JSON.stringify(syntheticEnvelope()));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.refusal, 'write_failed');
  assert.equal(rec.calls.length, 1, 'a failed write is never retried');
  assertNoLeak(result);
});

// ── No value ever crosses the boundary ──────────────────────────────────────

test('no refusal on any path carries a token, a url, a canary or a stack', async () => {
  const thrower = () => {
    const error = new Error(
      `BlobError: ${LEAK_CANARY} token=${ENVELOPE_TOKEN} url=https://example-store.invalid/x`,
    );
    error.stack = `Error: ${LEAK_CANARY}\n    at Object.<anonymous> (/repo/secret.ts:1:1)`;
    return error;
  };
  const serialized = JSON.stringify(syntheticEnvelope());

  const surfaces: unknown[] = [];
  for (const rec of [
    recorder({ putError: thrower }),
    recorder({ getError: thrower }),
    recorder({ delError: thrower }),
    recorder({ publicStore: true }),
    recorder({ seed: { [EXPECTED_PATH]: serialized } }),
  ]) {
    const store = openStore(baseEnv(), rec.io);
    surfaces.push(await store.write(VALID_ORDER_ID, serialized));
    surfaces.push(await store.read(VALID_ORDER_ID));
    surfaces.push(await store.delete(VALID_ORDER_ID));
  }
  assert.ok(
    surfaces.some((surface) => (surface as { ok: boolean }).ok === false),
    'the sweep must actually exercise refusals',
  );
  for (const surface of surfaces) {
    assertNoLeak(surface);
    if ((surface as { ok: boolean }).ok === false) assertNoRequestBytes(surface);
  }
});

test('no store operation throws; every failure is a closed refusal member', async () => {
  const closed = new Set([
    'store_unconfigured',
    'store_not_dedicated',
    'namespace_invalid',
    'path_invalid',
    'store_not_private',
    'object_exists',
    'not_found',
    'read_failed',
    'write_failed',
    'delete_failed',
    'invalid_object',
    'too_large',
    'digest_mismatch',
  ]);
  const hostile = () => {
    // A thrown value whose every property access explodes: the classifier must
    // survive it and still produce a closed member.
    return new Proxy({} as Error, {
      get() {
        throw new Error('property access is hostile');
      },
    });
  };
  for (const rec of [
    recorder({ putError: hostile }),
    recorder({ getError: hostile }),
    recorder({ delError: hostile }),
  ]) {
    const store = openStore(baseEnv(), rec.io);
    for (const result of [
      await store.write(VALID_ORDER_ID, JSON.stringify(syntheticEnvelope())),
      await store.read(VALID_ORDER_ID),
      await store.delete(VALID_ORDER_ID),
    ]) {
      const refusal = refusalOf(result);
      if (refusal === null) continue;
      assert.ok(closed.has(refusal), `${refusal} is outside the closed union`);
    }
  }
});

// ── Source guards: the lane is inert in the application ─────────────────────

const NEW_PATHS = new Set([
  'src/lib/confirmation-envelope-config.ts',
  'src/lib/confirmation-envelope-store.ts',
  'scripts/check-confirmation-envelope-env.ts',
  'scripts/probe-confirmation-envelope-store.ts',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(entry)) out.push(full);
    }
  };
  walk(path.join(REPO, dir));
  return out;
}

/**
 * A module specifier in an `import`, a dynamic `import()` or a `require()` —
 * an actual edge in the module graph, not a mention in prose. The store module
 * names the probe in its own documentation, and documentation is not a caller.
 */
function importsModuleMatching(text: string, pattern: string): boolean {
  const specifier = String.raw`['"\`][^'"\`]*${pattern}[^'"\`]*['"\`]`;
  return new RegExp(
    [
      String.raw`\bfrom\s+${specifier}`,
      String.raw`\bimport\s*\(\s*${specifier}`,
      String.raw`\brequire\s*\(\s*${specifier}`,
      String.raw`\bimport\s+${specifier}`,
    ].join('|'),
  ).test(text);
}

test('no application runtime file imports the envelope store or its config', () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles('src'), ...sourceFiles('scripts')]) {
    const rel = path.relative(REPO, file);
    if (NEW_PATHS.has(rel)) continue;
    if (importsModuleMatching(readFileSync(file, 'utf8'), 'confirmation-envelope-(store|config)')) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A3-2 adds no application caller: the producer is A3-4 and the dispatcher is A3-5',
  );
});

test('the import guard would actually catch a caller', () => {
  // A guard that has never been seen to fire is not evidence.
  assert.equal(
    importsModuleMatching(
      "import { createConfirmationEnvelopeStore } from './confirmation-envelope-store.ts';",
      'confirmation-envelope-(store|config)',
    ),
    true,
  );
  assert.equal(
    importsModuleMatching(
      "const s = await import('../src/lib/confirmation-envelope-config.ts');",
      'confirmation-envelope-(store|config)',
    ),
    true,
  );
  assert.equal(
    importsModuleMatching(
      '// see src/lib/confirmation-envelope-store.ts for the boundary',
      'confirmation-envelope-(store|config)',
    ),
    false,
  );
});

test('no application file imports the operator probe', () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles('src'), ...sourceFiles('scripts')]) {
    const rel = path.relative(REPO, file);
    if (rel === 'scripts/probe-confirmation-envelope-store.ts') continue;
    if (importsModuleMatching(readFileSync(file, 'utf8'), 'probe-confirmation-envelope-store')) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the probe runs only as the process entry module', () => {
  const text = readFileSync(path.join(REPO, 'scripts/probe-confirmation-envelope-store.ts'), 'utf8');
  assert.match(text, /import\.meta\.url === pathToFileURL\(entry\)\.href/);
  // Importing it here did not run it: if it had, this suite would have exited.
  assert.equal(typeof runConfirmationEnvelopeStoreProbe, 'function');
});

test('the store module never enumerates', () => {
  const text = readFileSync(path.join(REPO, 'src/lib/confirmation-envelope-store.ts'), 'utf8');
  assert.match(text, /^import \{ del, get, put \} from '@vercel\/blob';$/m);
  assert.doesNotMatch(text, /\blist\s*\(/);
  assert.doesNotMatch(text, /\bhead\s*\(/);
});

test('neither new module reads an access mode from the environment', () => {
  for (const rel of ['src/lib/confirmation-envelope-config.ts', 'src/lib/confirmation-envelope-store.ts']) {
    const text = readFileSync(path.join(REPO, rel), 'utf8');
    assert.doesNotMatch(text, /env\[[^\]]*ACCESS[^\]]*\]|env\.HSB_BLOB_ACCESS_MODE/i, rel);
  }
});

test('the build chains the envelope gate without displacing the story-media gate', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts.build!, /check-story-media-env\.ts/);
  assert.match(pkg.scripts.build!, /check-confirmation-envelope-env\.ts/);
  assert.ok(
    pkg.scripts.build!.indexOf('check-confirmation-envelope-env.ts') <
      pkg.scripts.build!.indexOf('next build'),
    'the gate must run before next build',
  );
  assert.equal(
    pkg.scripts['envelope:probe'],
    'node --experimental-strip-types scripts/probe-confirmation-envelope-store.ts',
  );
});

// ── The operator probe's arms, driven by injection only ─────────────────────

function probeSeams(overrides: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const objects = new Map<string, string>();
  const base = {
    env: baseEnv(),
    put: (async (pathname: string, body: string) => {
      objects.set(pathname, body);
      return { url: `https://example-store.invalid/${pathname}`, pathname };
    }) as never,
    get: (async (pathname: string) => {
      const body = objects.get(pathname);
      if (body === undefined) return null;
      return { statusCode: 200, stream: new Response(body).body, blob: { size: body.length } };
    }) as never,
    del: (async (pathname: string) => {
      objects.delete(pathname);
    }) as never,
    head: (async (pathname: string) => {
      // A GENUINE typed SDK error, not an Error with `.name` stamped on it: a
      // real BlobNotFoundError reports `.name === 'Error'`, so a name-stamped
      // stand-in is a fixture the production predicate must — and does — refuse.
      if (!objects.has(pathname)) throw new BlobNotFoundError();
      return { pathname };
    }) as never,
    fetch: async () => ({ status: 403 }),
    randomId: () => 'synthetic-probe-id',
    log: (line: string) => lines.push(line),
  };
  return { lines, objects, deps: { ...base, ...overrides } };
}

test('the probe passes every arm against a private store and cleans up', async () => {
  const { lines, objects, deps } = probeSeams();
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.arms.map((arm) => arm.arm).sort(),
    [...PROBE_ARMS].sort(),
  );
  assert.equal(objects.size, 0, 'the probe object must not survive the probe');
  for (const line of lines) {
    assert.match(line, /^\[confirmation-envelope-probe\] (PASS|FAIL) [a-z_]+$/);
  }
});

test('the decisive arm fails when an unauthenticated fetch succeeds', async () => {
  const { objects, deps } = probeSeams({ fetch: async () => ({ status: 200 }) });
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(result.passed, false);
  const arm = result.arms.find((entry) => entry.arm === 'unauthenticated_fetch_denied');
  assert.equal(arm?.passed, false);
  assert.equal(objects.size, 0, 'cleanup still runs after the decisive arm fails');
});

test('a cleanup failure fails the probe even when every other arm passed', async () => {
  const { deps } = probeSeams({
    del: (async () => {
      throw new Error('delete refused');
    }) as never,
  });
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(result.passed, false);
  assert.equal(result.arms.find((entry) => entry.arm === 'cleanup_delete')?.passed, false);
});

test('a public store fails the probe at the private write, with no fallback', async () => {
  const { objects, deps } = probeSeams({
    put: (async () => {
      throw new Error('Cannot use private access on a public store');
    }) as never,
  });
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(result.passed, false);
  assert.equal(result.arms.find((entry) => entry.arm === 'private_write')?.passed, false);
  assert.equal(objects.size, 0);
  assert.equal(
    result.arms.some((entry) => entry.arm === 'authenticated_read'),
    false,
    'no arm may run after the write was refused',
  );
});

test('an unconfigured store fails the probe before any I/O', async () => {
  const env = baseEnv();
  delete env[CONFIRMATION_ENVELOPE_TOKEN_ENV];
  const { objects, deps } = probeSeams({ env });
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(result.passed, false);
  assert.equal(result.arms.find((entry) => entry.arm === 'dedicated_store')?.passed, false);
  assert.equal(objects.size, 0);
});

test('the probe body and path carry no customer bytes and no order identifier', () => {
  assert.equal(PROBE_BODY, '{"probe":1}');
  const probePath = confirmationEnvelopeProbePath(NAMESPACE, 'synthetic-probe-id');
  assert.equal(probePath, `${NAMESPACE}/confirmation-envelopes/_probe/synthetic-probe-id.json`);
  assert.doesNotMatch(probePath, /ord_/);
});

test('the probe prints arm names only', async () => {
  const { lines, deps } = probeSeams();
  await runConfirmationEnvelopeStoreProbe(deps);
  const printed = lines.join('\n');
  for (const forbidden of ['vercel_blob_rw_', 'https://', ENVELOPE_TOKEN, 'EnvStore0001', 'Error']) {
    assert.ok(!printed.includes(forbidden), `the probe printed ${forbidden}`);
  }
});

// ── Cleanup verification: proven absence only ───────────────────────────────
//
// Arm 7 is the one arm whose wrong answer is silent. A catch-all "head threw,
// so the object is gone" certifies cleanup from an expired token, a rate limit,
// an outage, a suspended or deleted store, an abort or a dropped socket — and a
// timeout is exactly when a delete is most likely not to have landed. These
// tests pin the arm to typed evidence, and they are what kills a reversion to
// the catch-all.

/** The verbatim messages @vercel/blob@2.3.3 constructs, by class. */
const SDK_ERROR_TEXT = {
  blobNotFound: 'Vercel Blob: The requested blob does not exist',
  storeNotFound: 'Vercel Blob: This store does not exist.',
  accessDenied: 'Vercel Blob: Access denied, please provide a valid token for this resource.',
  storeSuspended: 'Vercel Blob: This store has been suspended.',
  rateLimited: 'Vercel Blob: Too many requests please lower the number of concurrent requests .',
  serviceUnavailable: 'Vercel Blob: The blob service is currently not available. Please try again.',
  requestAborted: 'Vercel Blob: The request was aborted.',
  unknown: 'Vercel Blob: Unknown error, please visit https://vercel.com/help.',
} as const;

/**
 * Every way a cleanup HEAD can fail WITHOUT proving the object is gone. Each
 * one must leave `cleanup_verified` false and fail the probe overall.
 */
const AMBIGUOUS_CLEANUP_FAILURES: Array<{ label: string; thrown: () => unknown }> = [
  { label: 'access denied / token expired', thrown: () => new Error(SDK_ERROR_TEXT.accessDenied) },
  { label: 'rate limited', thrown: () => new Error(SDK_ERROR_TEXT.rateLimited) },
  { label: 'service unavailable', thrown: () => new Error(SDK_ERROR_TEXT.serviceUnavailable) },
  { label: 'store suspended', thrown: () => new Error(SDK_ERROR_TEXT.storeSuspended) },
  { label: 'store vanished', thrown: () => new Error(SDK_ERROR_TEXT.storeNotFound) },
  { label: 'request aborted / timeout', thrown: () => new Error(SDK_ERROR_TEXT.requestAborted) },
  { label: 'unknown provider error', thrown: () => new Error(SDK_ERROR_TEXT.unknown) },
  { label: 'raw network failure', thrown: () => new TypeError('fetch failed') },
  { label: 'thrown null', thrown: () => null },
  { label: 'thrown undefined', thrown: () => undefined },
  { label: 'thrown string', thrown: () => 'blob not found' },
  { label: 'thrown number', thrown: () => 404 },
  {
    label: 'a hostile value that explodes on property and prototype access',
    thrown: () =>
      new Proxy({}, {
        get() { throw new Error('boom'); },
        has() { throw new Error('boom'); },
        getPrototypeOf() { throw new Error('boom'); },
      }),
  },
  {
    label: 'MESSAGE-only lookalike: a plain Error carrying the SDK not-found sentence',
    thrown: () => new Error(SDK_ERROR_TEXT.blobNotFound),
  },
  { label: 'MESSAGE-only lookalike: a plain Error saying "not found"', thrown: () => new Error('404 not found') },
  {
    label: 'NAME-only lookalike: a plain Error with .name reassigned',
    thrown: () => Object.assign(new Error('absent'), { name: 'BlobNotFoundError' }),
  },
  {
    label: 'a sibling SDK-shaped class that is NOT BlobNotFoundError',
    thrown: () => {
      class BlobStoreNotFoundError extends Error {}
      return new BlobStoreNotFoundError('Vercel Blob: This store does not exist.');
    },
  },
  {
    label: 'a foreign same-named class without SDK identity',
    thrown: () => {
      const ForeignBlobNotFoundError = class BlobNotFoundError extends Error {};
      return new ForeignBlobNotFoundError('ambiguous foreign failure');
    },
  },
  {
    label: 'a timeout error whose constructor was renamed',
    thrown: () => {
      class TimeoutError extends Error {}
      Object.defineProperty(TimeoutError, 'name', { value: 'BlobNotFoundError' });
      return new TimeoutError('timeout');
    },
  },
  {
    label: 'an Error whose prototype constructor is a same-named object',
    thrown: () => {
      const error = new Error('ambiguous');
      const proto = Object.create(Error.prototype) as { constructor: unknown };
      Object.defineProperty(proto, 'constructor', {
        value: { name: 'BlobNotFoundError' },
      });
      Object.setPrototypeOf(error, proto);
      return error;
    },
  },
];

const cleanupVerifiedArm = (result: Awaited<ReturnType<typeof runConfirmationEnvelopeStoreProbe>>) =>
  result.arms.find((entry) => entry.arm === 'cleanup_verified')?.passed;

test('a typed BlobNotFoundError after delete certifies cleanup and the probe passes', async () => {
  const { deps, objects } = probeSeams({
    head: (async () => {
      throw new BlobNotFoundError();
    }) as never,
  });
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(cleanupVerifiedArm(result), true);
  assert.equal(result.passed, true);
  assert.equal(objects.size, 0, 'the delete must still have been attempted');
});

test('no ambiguous cleanup failure may certify absence, and each one fails the probe', async () => {
  const certified: string[] = [];
  const passedOverall: string[] = [];
  for (const { label, thrown } of AMBIGUOUS_CLEANUP_FAILURES) {
    const { deps } = probeSeams({
      head: (async () => {
        throw thrown();
      }) as never,
    });
    const result = await runConfirmationEnvelopeStoreProbe(deps);
    if (cleanupVerifiedArm(result) !== false) certified.push(label);
    if (result.passed !== false) passedOverall.push(label);
  }
  assert.deepEqual(
    certified,
    [],
    `cleanup was certified from ambiguity:\n${certified.join('\n')}`,
  );
  assert.deepEqual(
    passedOverall,
    [],
    `the probe passed overall despite unverified cleanup:\n${passedOverall.join('\n')}`,
  );
});

test('the absence predicate turns on the SDK class, not on a message or a name', () => {
  assert.equal(isProvenObjectAbsence(new BlobNotFoundError()), true);
  // A real BlobNotFoundError does not carry its class in `.name` — the SDK's
  // subclasses never assign it — which is exactly why `.name` is not the handle.
  assert.equal(new BlobNotFoundError().name, 'Error');
  for (const { label, thrown } of AMBIGUOUS_CLEANUP_FAILURES) {
    assert.equal(isProvenObjectAbsence(thrown()), false, label);
  }
});

test('the absence predicate accepts SDK identity and rejects foreign constructor names', () => {
  class SdkSubclass extends BlobNotFoundError {}
  assert.equal(isProvenObjectAbsence(new SdkSubclass()), true);

  const ForeignBlobNotFoundError = class BlobNotFoundError extends Error {};
  assert.equal(
    isProvenObjectAbsence(new ForeignBlobNotFoundError()),
    false,
    'a same-named foreign class is ambiguity, not proven absence',
  );
});

test('a cleanup failure and an unverified cleanup are reported separately', async () => {
  // The delete itself failing is arm 6; being unable to prove absence is arm 7.
  // Collapsing them would hide which half went wrong.
  const { deps } = probeSeams({
    del: (async () => {
      throw new Error(SDK_ERROR_TEXT.accessDenied);
    }) as never,
    head: (async () => {
      throw new Error(SDK_ERROR_TEXT.rateLimited);
    }) as never,
  });
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(result.arms.find((entry) => entry.arm === 'cleanup_delete')?.passed, false);
  assert.equal(cleanupVerifiedArm(result), false);
  assert.equal(result.passed, false);
});

test('an unverified cleanup leaks no provider message, stack, url, token or thrown value', async () => {
  const canary = 'CLEANUPCANARY';
  const { lines, deps } = probeSeams({
    head: (async () => {
      const error = new Error(`Vercel Blob: ${canary} https://leak.invalid/${canary}`);
      error.stack = `Error: ${canary}\n    at Object.<anonymous> (https://leak.invalid/${canary})`;
      throw error;
    }) as never,
  });
  const result = await runConfirmationEnvelopeStoreProbe(deps);
  assert.equal(cleanupVerifiedArm(result), false);
  const surface = `${lines.join('\n')}\n${JSON.stringify(result)}`;
  for (const forbidden of [canary, 'https://', 'Vercel Blob', 'at Object.', ENVELOPE_TOKEN, 'EnvStore0001']) {
    assert.ok(!surface.includes(forbidden), `an unverified cleanup surfaced ${forbidden}`);
  }
  for (const line of lines) {
    assert.match(line, /^\[confirmation-envelope-probe\] (PASS|FAIL) [a-z_]+$/);
  }
});

test('the probe certifies cleanup from a class, not from a catch-all', () => {
  // A source guard, so a future edit that reintroduces `catch { verified = true }`
  // is caught even if someone also weakens a fixture.
  const text = readFileSync(path.join(REPO, 'scripts/probe-confirmation-envelope-store.ts'), 'utf8');
  assert.match(text, /import \{ BlobNotFoundError, del, get, head, put \} from '@vercel\/blob';/);
  assert.match(text, /verified = isProvenObjectAbsence\(error\)/);
  assert.doesNotMatch(text, /catch\s*\{\s*\n?\s*(\/\/[^\n]*\n\s*)*verified = true/);
});
