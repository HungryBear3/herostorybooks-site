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

// The SDK error classes these tests construct: absence (store and probe) turns
// on the SDK's own error identity, and A3-2.1's existence/absence rows throw
// the real classes, so a test that hand-rolled a stand-in would be testing its
// own fixture rather than the contract. @vercel/blob@2.3.3 exports no
// existing-object class (evidence branch N), so none is imported.
import { BlobError, BlobNotFoundError, BlobStoreNotFoundError } from '@vercel/blob';

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

test('a second write is refused as write_failed and never clobbers the first', async () => {
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
  assert.equal(second.ok === false && second.refusal, 'write_failed');
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
  const rec = recorder({ delError: () => new BlobNotFoundError() });
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

// ── A3-2.1: existence and absence by SDK identity (E-1…E-10) ────────────────
//
// @vercel/blob@2.3.3 has no existing-object class and emits no fixed
// existing-object sentence (evidence branch N): an `allowOverwrite: false`
// conflict can only surface as server-supplied `bad_request` prose or as the
// generic `BlobUnknownError`. So no write failure is `object_exists` — every
// one other than `store_not_private` is `write_failed` — and absence is proven
// only by `BlobNotFoundError` that is not `BlobStoreNotFoundError`, never by
// text or by a stamped `.name`.

/**
 * Every result an E or BX row produced, sealed afterwards by E-14 and BX-8.
 * Rows run in declaration order within this file, and E-14/BX-8 refuse to pass
 * on a partial collection, so an isolated run cannot pass vacuously.
 */
const SEALED: Array<{ row: string; result: unknown }> = [];

function seal(row: string, result: unknown): void {
  SEALED.push({ row, result });
}

async function writeFailureFor(row: string, thrown: () => Error): Promise<string | null> {
  const rec = recorder({ putError: thrown });
  const store = openStore(baseEnv(), rec.io);
  const result = await store.write(VALID_ORDER_ID, JSON.stringify(syntheticEnvelope()));
  seal(row, result);
  assert.equal(rec.calls.length, 1, `${row}: a failed write is never retried`);
  assert.equal(rec.objects.size, 0, `${row}: nothing may be stored`);
  return refusalOf(result);
}

async function readFailureFor(row: string, thrown: () => unknown): Promise<string | null> {
  const rec = recorder({ getError: thrown as () => Error });
  const result = await openStore(baseEnv(), rec.io).read(VALID_ORDER_ID);
  seal(row, result);
  assert.equal(rec.calls.length, 1, `${row}: exactly one get`);
  return refusalOf(result);
}

async function deleteOutcomeFor(row: string, thrown: () => unknown): Promise<string | null> {
  const rec = recorder({ delError: thrown as () => Error });
  const result = await openStore(baseEnv(), rec.io).delete(VALID_ORDER_ID);
  seal(row, result);
  assert.equal(rec.calls.length, 1, `${row}: exactly one del`);
  return result.ok ? 'ok' : refusalOf(result);
}

/** Plain values that only LOOK like SDK absence. None of them is evidence. */
const ABSENCE_LOOKALIKES: Array<{ label: string; thrown: () => unknown }> = [
  {
    label: 'a plain Error whose name is BlobNotFoundError',
    thrown: () => Object.assign(new Error('blob not found'), { name: 'BlobNotFoundError' }),
  },
  { label: 'a plain Error carrying the SDK not-found sentence', thrown: () => new Error(SDK_ERROR_TEXT.blobNotFound) },
  { label: 'a plain Error saying 404 not found', thrown: () => new Error('404 not found') },
  {
    label: 'a foreign same-named class without SDK identity',
    thrown: () => {
      const ForeignBlobNotFoundError = class BlobNotFoundError extends Error {};
      return new ForeignBlobNotFoundError('The requested blob does not exist');
    },
  },
];

test('E-1: put throwing the real BlobStoreNotFoundError is write_failed', async () => {
  assert.equal(await writeFailureFor('E-1', () => new BlobStoreNotFoundError()), 'write_failed');
});

test('E-2: put throwing the real BlobNotFoundError is write_failed', async () => {
  assert.equal(await writeFailureFor('E-2', () => new BlobNotFoundError()), 'write_failed');
});

test('E-3: a plain Error with existing-object prose is write_failed', async () => {
  assert.equal(
    await writeFailureFor(
      'E-3',
      () => new Error('This blob already exists, use allowOverwrite: true to overwrite it'),
    ),
    'write_failed',
  );
});

test('E-4: a plain Error saying 409 or Conflict is write_failed', async () => {
  assert.equal(await writeFailureFor('E-4', () => new Error('409 conflict')), 'write_failed');
  assert.equal(await writeFailureFor('E-4', () => new Error('Conflict')), 'write_failed');
});

test('E-5 (branch N): a real BlobError with existing-object wording is write_failed', async () => {
  // The dist carries no existing-object wording of its own, so the matrix's
  // fallback sentence is used.
  const error = new BlobError('This blob already exists');
  assert.equal(Object.getPrototypeOf(error), BlobError.prototype);
  assert.equal(await writeFailureFor('E-5', () => error), 'write_failed');
});

test('E-6: get throwing the real BlobStoreNotFoundError is read_failed, never not_found', async () => {
  assert.equal(await readFailureFor('E-6', () => new BlobStoreNotFoundError()), 'read_failed');
});

test('E-7: get throwing the real BlobNotFoundError, or a subclass of it, is not_found', async () => {
  class SdkSubclass extends BlobNotFoundError {}
  assert.equal(await readFailureFor('E-7', () => new BlobNotFoundError()), 'not_found');
  assert.equal(await readFailureFor('E-7', () => new SdkSubclass()), 'not_found');
});

test('E-8: a lookalike of SDK absence is never absence, on read or on delete', async () => {
  for (const { label, thrown } of ABSENCE_LOOKALIKES) {
    assert.equal(await readFailureFor('E-8', thrown), 'read_failed', `read: ${label}`);
    assert.equal(await deleteOutcomeFor('E-8', thrown), 'delete_failed', `delete: ${label}`);
  }
});

test('E-9: del throwing the real BlobStoreNotFoundError is delete_failed, never ok', async () => {
  assert.equal(await deleteOutcomeFor('E-9', () => new BlobStoreNotFoundError()), 'delete_failed');
});

test('E-10: del throwing the real BlobNotFoundError is an idempotent ok', async () => {
  assert.equal(await deleteOutcomeFor('E-10', () => new BlobNotFoundError()), 'ok');
});

// ── A3-2.1: byte-exact readback (E-11…E-14, BX-1…BX-9) ─────────────────────

const CANONICAL = JSON.stringify(syntheticEnvelope());

function envelopeWith(request: Partial<ConfirmationEmailRequestV1>): ConfirmationEmailEnvelopeV1 {
  const built = buildConfirmationEmailEnvelope({
    orderId: VALID_ORDER_ID,
    templateVersion: 'order-confirmation@synthetic',
    createdAt: '2026-09-24T00:00:00.000Z',
    idempotencyKey: `order-confirmation-${VALID_ORDER_ID}-primary-v1`,
    providerBinding: { accountLabel: 'hsb-synthetic-test-v1' },
    request: syntheticRequest(request),
  });
  assert.equal(built.ok, true);
  return (built as { ok: true; envelope: ConfirmationEmailEnvelopeV1 }).envelope;
}

interface ByteStore {
  readonly calls: Call[];
  readonly io: ConfirmationEnvelopeStoreIo;
}

/**
 * A read-only adapter over RAW stored bytes. `put` and `del` fail the test if
 * reached; `get` serves `body` (null = absent) with an optional declared size,
 * status code, stream or thrown error, and every `get` carries a canary URL
 * that must never cross the boundary.
 */
function byteStore(
  body: Uint8Array | null,
  options: {
    declaredSize?: number;
    statusCode?: number;
    stream?: ReadableStream<Uint8Array> | null;
    getError?: () => unknown;
  } = {},
): ByteStore {
  const calls: Call[] = [];
  const forbid = (op: Call['op']) =>
    (async (pathname: string, ...rest: unknown[]) => {
      calls.push({ op, pathname, options: (rest.at(-1) ?? {}) as Record<string, unknown> });
      throw new Error(`the SDK must not be reached: ${op}`);
    }) as never;
  const io: ConfirmationEnvelopeStoreIo = {
    put: forbid('put'),
    del: forbid('del'),
    get: (async (pathname: string, opts: Record<string, unknown>) => {
      calls.push({ op: 'get', pathname, options: opts });
      if (options.getError) throw options.getError();
      if (body === null) return null;
      return {
        statusCode: options.statusCode ?? 200,
        stream: options.stream === undefined ? new Response(new Uint8Array(body)).body : options.stream,
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
          size: options.declaredSize ?? body.byteLength,
        },
      };
    }) as never,
  };
  return { calls, io };
}

/**
 * Observe every decode and parse while `run` executes. Counts only decodes of
 * buffers whose bytes equal `stored`, so an unrelated decode elsewhere in the
 * process cannot trip it; records every JSON.parse input.
 */
async function withDecodeSpy<T>(
  stored: Uint8Array,
  run: () => Promise<T>,
): Promise<{ result: T; storedDecodes: number; parsed: string[] }> {
  const storedBuffer = Buffer.from(stored);
  const sameBytes = (input: unknown) => {
    try {
      if (!ArrayBuffer.isView(input)) return false;
      const view = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
      return view.equals(storedBuffer);
    } catch {
      return false;
    }
  };
  const originalDecode = TextDecoder.prototype.decode;
  const originalToString = Buffer.prototype.toString;
  const originalParse = JSON.parse;
  let storedDecodes = 0;
  const parsed: string[] = [];
  TextDecoder.prototype.decode = function (this: TextDecoder, ...args: Parameters<TextDecoder['decode']>) {
    if (sameBytes(args[0])) storedDecodes += 1;
    return originalDecode.apply(this, args);
  };
  Buffer.prototype.toString = function (this: Buffer, ...args: unknown[]) {
    if (sameBytes(this)) storedDecodes += 1;
    return (originalToString as (...inner: unknown[]) => string).apply(this, args);
  } as typeof Buffer.prototype.toString;
  JSON.parse = function (text: string, reviver?: (key: string, value: unknown) => unknown) {
    parsed.push(String(text));
    return originalParse(text, reviver);
  } as typeof JSON.parse;
  try {
    const result = await run();
    return { result, storedDecodes, parsed };
  } finally {
    TextDecoder.prototype.decode = originalDecode;
    Buffer.prototype.toString = originalToString;
    JSON.parse = originalParse;
  }
}

/**
 * The readback of `stored` against `expectedSerialized` must be
 * `object_mismatch` after exactly one private, uncached, dedicated-token get,
 * and the stored bytes must never be decoded or parsed.
 */
async function assertObjectMismatch(
  row: string,
  label: string,
  expectedSerialized: string,
  stored: Uint8Array,
): Promise<void> {
  const bytes = byteStore(stored);
  const store = openStore(baseEnv(), bytes.io);
  const { result, storedDecodes, parsed } = await withDecodeSpy(stored, () =>
    store.verifyStoredBytes(VALID_ORDER_ID, expectedSerialized),
  );
  seal(row, result);
  assert.equal(refusalOf(result), 'object_mismatch', `${row}: ${label}`);
  assert.deepEqual(
    bytes.calls,
    [{ op: 'get', pathname: EXPECTED_PATH, options: { access: 'private', useCache: false, token: ENVELOPE_TOKEN } }],
    `${row}: ${label}: exactly one private uncached get`,
  );
  assert.equal(storedDecodes, 0, `${row}: ${label}: mismatching stored bytes were decoded`);
  assert.deepEqual(
    parsed.filter((text) => text !== expectedSerialized),
    [],
    `${row}: ${label}: something other than the expected document was parsed`,
  );
}

/** Replace the first occurrence of `needle` in `haystack` with `replacement`. */
function spliceBytes(haystack: Buffer, needle: Buffer, replacement: Buffer): Buffer {
  const at = haystack.indexOf(needle);
  assert.ok(at >= 0, 'fixture: the byte run to replace must be present');
  return Buffer.concat([haystack.subarray(0, at), replacement, haystack.subarray(at + needle.byteLength)]);
}

/**
 * Malformed UTF-8 sequences that a replacing decoder turns into exactly `k`
 * U+FFFD characters (WHATWG maximal-subpart replacement), each followed in the
 * fixture by an ASCII byte.
 */
const FFFD_COLLISIONS: Array<{ label: string; k: number; bytes: Buffer }> = [
  { label: 'FF', k: 1, bytes: Buffer.from([0xff]) },
  { label: 'C0 AF overlong', k: 2, bytes: Buffer.from([0xc0, 0xaf]) },
  { label: 'ED A0 80 encoded surrogate', k: 3, bytes: Buffer.from([0xed, 0xa0, 0x80]) },
  { label: 'F4 90 80 80 above U+10FFFF', k: 4, bytes: Buffer.from([0xf4, 0x90, 0x80, 0x80]) },
  { label: 'E2 82 truncated before an ASCII byte', k: 1, bytes: Buffer.from([0xe2, 0x82]) },
];

/** A valid envelope whose subject carries k×U+FFFD, and a malformed twin of its bytes. */
function fffdCollision(k: number, malformed: Buffer): { serialized: string; stored: Buffer } {
  const serialized = JSON.stringify(envelopeWith({ subject: `Hero ${'�'.repeat(k)} story` }));
  const stored = spliceBytes(
    Buffer.from(serialized, 'utf8'),
    Buffer.from('�'.repeat(k), 'utf8'),
    malformed,
  );
  return { serialized, stored };
}

const REFUSALS_A321 = new Set([
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
  'object_mismatch',
]);

/**
 * A result is sealed when it carries exactly its discriminant and one closed
 * member (or the two-field ref), and nothing else: no stored byte, decoded
 * text, U+FFFD, SDK message, URL, token or canary.
 */
function assertSealed(row: string, result: unknown): void {
  const value = result as Record<string, unknown>;
  if (value.ok === true) {
    assert.deepEqual(Object.keys(value).sort(), ['ok', 'value'], `${row}: ok shape`);
    const inner = value.value;
    if (inner !== null) {
      assert.deepEqual(Object.keys(inner as object).sort(), ['objectPath', 'storedBytes'], `${row}: ref shape`);
      assert.equal((inner as { objectPath: unknown }).objectPath, EXPECTED_PATH, `${row}: ref path`);
      assert.equal(typeof (inner as { storedBytes: unknown }).storedBytes, 'number', `${row}: ref size`);
    }
  } else {
    assert.deepEqual(Object.keys(value).sort(), ['ok', 'refusal'], `${row}: refusal shape`);
    assert.ok(REFUSALS_A321.has(value.refusal as string), `${row}: ${String(value.refusal)} is not closed`);
  }
  assertNoLeak(result);
  const surface = surfaceOf(result);
  for (const forbidden of ['Vercel Blob', '�', 'Buffer', 'buyer@example.invalid', 'Synthetic order confirmation', 'Hero ']) {
    assert.ok(!surface.includes(forbidden), `${row}: surface leaked ${JSON.stringify(forbidden)}: ${surface}`);
  }
}

test('E-11: stored bytes identical to the expected bytes verify ok after exactly one private get', async () => {
  for (const serialized of [CANONICAL, JSON.stringify(envelopeWith({ subject: 'Héro ✓ \u{1F600} story' }))]) {
    const bytes = byteStore(Buffer.from(serialized, 'utf8'));
    const store = openStore(baseEnv(), bytes.io);
    const result = await store.verifyStoredBytes(VALID_ORDER_ID, serialized);
    seal('E-11', result);
    assert.equal(result.ok, true);
    assert.deepEqual((result as { ok: true; value: unknown }).value, {
      objectPath: EXPECTED_PATH,
      storedBytes: Buffer.byteLength(serialized, 'utf8'),
    });
    assert.deepEqual(bytes.calls, [
      { op: 'get', pathname: EXPECTED_PATH, options: { access: 'private', useCache: false, token: ENVELOPE_TOKEN } },
    ]);
  }
});

test('E-11 (absence): the readback classifies absence by SDK identity only', async () => {
  const cases: Array<[string, ByteStore, string]> = [
    ['get returns null', byteStore(null), 'not_found'],
    ['status 404', byteStore(Buffer.from(CANONICAL), { statusCode: 404 }), 'not_found'],
    ['real BlobNotFoundError', byteStore(null, { getError: () => new BlobNotFoundError() }), 'not_found'],
    ['real BlobStoreNotFoundError', byteStore(null, { getError: () => new BlobStoreNotFoundError() }), 'read_failed'],
    ...ABSENCE_LOOKALIKES.map(({ label, thrown }): [string, ByteStore, string] => [
      label,
      byteStore(null, { getError: thrown }),
      'read_failed',
    ]),
    ['status 500', byteStore(Buffer.from(CANONICAL), { statusCode: 500 }), 'read_failed'],
    ['no stream', byteStore(Buffer.from(CANONICAL), { stream: null }), 'read_failed'],
  ];
  for (const [label, bytes, refusal] of cases) {
    const result = await openStore(baseEnv(), bytes.io).verifyStoredBytes(VALID_ORDER_ID, CANONICAL);
    seal('E-11', result);
    assert.equal(refusalOf(result), refusal, label);
    assert.equal(bytes.calls.length, 1, `${label}: exactly one get`);
  }
});

test('E-12: valid, self-consistent objects that differ from the expected bytes are object_mismatch', async () => {
  const envelope = syntheticEnvelope();
  const { envelopeVersion, ...rest } = envelope;
  const variants: Record<string, string> = {
    'key order': JSON.stringify({ ...rest, envelopeVersion }),
    whitespace: JSON.stringify(envelope, null, 2),
    createdAt: JSON.stringify({ ...envelope, createdAt: '2026-09-25T00:00:00.000Z' }),
    'extra unknown key': JSON.stringify({ ...envelope, note: LEAK_CANARY }),
    templateVersion: JSON.stringify({ ...envelope, templateVersion: 'order-confirmation@synthetic-2' }),
    'escape form': CANONICAL.replace('"Synthetic order confirmation"', '"\\u0053ynthetic order confirmation"'),
  };
  for (const [label, body] of Object.entries(variants)) {
    assert.notEqual(body, CANONICAL, `fixture: ${label} must differ`);
    // Precondition: each variant is itself a valid, digest-consistent object.
    const rec = recorder({ seed: { [EXPECTED_PATH]: body } });
    assert.equal((await openStore(baseEnv(), rec.io).read(VALID_ORDER_ID)).ok, true, `fixture: ${label} reads ok`);
    await assertObjectMismatch('E-12', label, CANONICAL, Buffer.from(body, 'utf8'));
  }
});

test('E-13: oversized stored objects are too_large; non-JSON, tombstone and digest-inconsistent are object_mismatch', async () => {
  const envelope = syntheticEnvelope();

  const declared = byteStore(Buffer.from(CANONICAL), { declaredSize: CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES + 1 });
  const byDeclared = await openStore(baseEnv(), declared.io).verifyStoredBytes(VALID_ORDER_ID, CANONICAL);
  seal('E-13', byDeclared);
  assert.equal(refusalOf(byDeclared), 'too_large', 'declared oversize');

  const oversized = Buffer.alloc(CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES + 1, 0x78);
  const streamed = byteStore(oversized, { declaredSize: 10 });
  const { result: byStream, storedDecodes } = await withDecodeSpy(oversized, () =>
    openStore(baseEnv(), streamed.io).verifyStoredBytes(VALID_ORDER_ID, CANONICAL),
  );
  seal('E-13', byStream);
  assert.equal(refusalOf(byStream), 'too_large', 'streamed oversize');
  assert.equal(storedDecodes, 0);

  const others: Record<string, string> = {
    'non-JSON': `this is not json ${LEAK_CANARY}`,
    tombstone: JSON.stringify({ ...envelope, request: null, purgedAt: '2026-09-24T00:00:00.000Z' }),
    'digest-inconsistent': JSON.stringify({
      ...envelope,
      request: { ...envelope.request, subject: `Tampered ${LEAK_CANARY}` },
    }),
  };
  for (const [label, body] of Object.entries(others)) {
    await assertObjectMismatch('E-13', label, CANONICAL, Buffer.from(body, 'utf8'));
  }
});

test('BX-1: a malformed sequence that decodes to the expected U+FFFD run is object_mismatch', async () => {
  for (const { label, k, bytes } of FFFD_COLLISIONS) {
    const { serialized, stored } = fffdCollision(k, bytes);
    // The collision precondition: a replacing decoder cannot tell them apart.
    assert.equal(stored.toString('utf8'), serialized, `fixture: ${label} must collide`);
    assert.equal(Buffer.from(serialized, 'utf8').equals(stored), false, `fixture: ${label} bytes differ`);
    await assertObjectMismatch('BX-1', label, serialized, stored);
  }
});

test('BX-2: a BOM-prefixed copy of the expected bytes is object_mismatch', async () => {
  const stored = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CANONICAL, 'utf8')]);
  await assertObjectMismatch('BX-2', 'BOM', CANONICAL, stored);
});

test('BX-3: an expected string that is not well-formed is invalid_object with zero SDK calls', async () => {
  // UTF-8 encoding is not injective on ill-formed strings: every lone
  // surrogate encodes to EF BF BD.
  assert.equal(Buffer.from('a\uD800', 'utf8').equals(Buffer.from('a\uDC00', 'utf8')), true);
  for (const lone of ['\uD800', '\uDC00']) {
    const escaped = JSON.stringify(envelopeWith({ subject: `Synthetic ${lone} confirmation` }));
    const expected = escaped.replace(`\\u${lone.charCodeAt(0).toString(16)}`, lone);
    assert.notEqual(expected, escaped, 'fixture: the escape must have been replaced');
    assert.equal(expected.isWellFormed(), false, 'fixture: the expected string must be ill-formed');
    const calls: Call[] = [];
    const result = await openStore(baseEnv(), forbiddenIo(calls)).verifyStoredBytes(VALID_ORDER_ID, expected);
    seal('BX-3', result);
    assert.equal(refusalOf(result), 'invalid_object');
    assert.deepEqual(calls, [], 'an ill-formed expected string must refuse before the SDK');
  }
});

test('BX-4: a non-canonical expected string is invalid_object with zero SDK calls', async () => {
  const envelope = syntheticEnvelope();
  const { envelopeVersion, ...rest } = envelope;
  const variants: Record<string, string> = {
    whitespace: JSON.stringify(envelope, null, 2),
    'trailing newline': `${CANONICAL}\n`,
    'reordered keys': JSON.stringify({ ...rest, envelopeVersion }),
    'extra key': JSON.stringify({ ...envelope, note: 'synthetic' }),
    'escape variant': CANONICAL.replace('"Synthetic order confirmation"', '"\\u0053ynthetic order confirmation"'),
  };
  for (const [label, expected] of Object.entries(variants)) {
    const calls: Call[] = [];
    const result = await openStore(baseEnv(), forbiddenIo(calls)).verifyStoredBytes(VALID_ORDER_ID, expected);
    seal('BX-4', result);
    assert.equal(refusalOf(result), 'invalid_object', label);
    assert.deepEqual(calls, [], `${label} must refuse before the SDK`);
  }
});

test('BX-4 (pre-I/O): the other expected-side pre-checks refuse before the SDK', async () => {
  const envelope = syntheticEnvelope();
  const cases: Array<[string, string, unknown, string]> = [
    ['invalid order id', '../etc', CANONICAL, 'path_invalid'],
    ['non-string expected', VALID_ORDER_ID, 42, 'invalid_object'],
    ['oversized expected', VALID_ORDER_ID, 'x'.repeat(CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES + 1), 'too_large'],
    ['unparseable expected', VALID_ORDER_ID, 'not json', 'invalid_object'],
    ['expected bound to another order', OTHER_ORDER_ID, CANONICAL, 'invalid_object'],
    ['expected tombstone', VALID_ORDER_ID, JSON.stringify({ ...envelope, request: null, purgedAt: '2026-09-24T00:00:00.000Z' }), 'invalid_object'],
    [
      'expected digest-inconsistent',
      VALID_ORDER_ID,
      JSON.stringify({ ...envelope, request: { ...envelope.request, subject: 'Tampered subject' } }),
      'digest_mismatch',
    ],
  ];
  for (const [label, orderId, expected, refusal] of cases) {
    const calls: Call[] = [];
    const result = await openStore(baseEnv(), forbiddenIo(calls)).verifyStoredBytes(orderId, expected as string);
    seal('BX-4', result);
    assert.equal(refusalOf(result), refusal, label);
    assert.deepEqual(calls, [], `${label} must refuse before the SDK`);
  }
});

test('BX-5: one byte more, one byte fewer, or one byte flipped is object_mismatch', async () => {
  const expected = Buffer.from(CANONICAL, 'utf8');
  const flipped = Buffer.from(expected);
  const at = flipped.indexOf(Buffer.from('Synthetic order confirmation'));
  flipped[at] = flipped[at]! ^ 0x01;
  const variants: Record<string, Buffer> = {
    'one trailing byte': Buffer.concat([expected, Buffer.from([0x0a])]),
    'last byte removed': expected.subarray(0, expected.byteLength - 1),
    'one byte flipped': flipped,
  };
  for (const [label, stored] of Object.entries(variants)) {
    await assertObjectMismatch('BX-5', label, CANONICAL, stored);
  }
});

test('BX-6: read() refuses malformed UTF-8 even when its repaired text is a valid envelope', async () => {
  for (const { label, k, bytes } of FFFD_COLLISIONS) {
    const { serialized, stored } = fffdCollision(k, bytes);
    assert.equal(stored.toString('utf8'), serialized, `fixture: ${label} must collide`);
    // Precondition: the repaired text is a self-consistent, valid envelope.
    const repaired = recorder({ seed: { [EXPECTED_PATH]: serialized } });
    assert.equal((await openStore(baseEnv(), repaired.io).read(VALID_ORDER_ID)).ok, true, `fixture: ${label}`);

    const bytesIo = byteStore(stored);
    const result = await openStore(baseEnv(), bytesIo.io).read(VALID_ORDER_ID);
    seal('BX-6', result);
    assert.equal(refusalOf(result), 'invalid_object', label);
    assert.equal(bytesIo.calls.length, 1);
  }
});

test('BX-7: read() refuses a BOM-prefixed valid object', async () => {
  const stored = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CANONICAL, 'utf8')]);
  const bytesIo = byteStore(stored);
  const result = await openStore(baseEnv(), bytesIo.io).read(VALID_ORDER_ID);
  seal('BX-7', result);
  assert.equal(refusalOf(result), 'invalid_object');
});

test('BX-9: a stream that passes the ceiling after a small declared size is too_large, and is cancelled', async () => {
  const chunkBytes = Math.ceil((CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES + 1) / 2);
  const chunks = [0, 1, 2, 3].map(() => new Uint8Array(chunkBytes).fill(0x78));
  const state = { pulled: 0, cancelled: false };
  let next = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (next < chunks.length) {
          state.pulled += 1;
          controller.enqueue(chunks[next++]!);
        } else {
          controller.close();
        }
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const bytesIo = byteStore(Buffer.from(CANONICAL), { declaredSize: 10, stream });
  const result = await openStore(baseEnv(), bytesIo.io).verifyStoredBytes(VALID_ORDER_ID, CANONICAL);
  seal('BX-9', result);
  assert.equal(refusalOf(result), 'too_large');
  assert.equal(state.cancelled, true, 'the reader must be cancelled');
  assert.equal(state.pulled, 2, 'reading must stop at the first chunk past the ceiling');
});

const E_ROWS = ['E-1', 'E-2', 'E-3', 'E-4', 'E-5', 'E-6', 'E-7', 'E-8', 'E-9', 'E-10', 'E-11', 'E-12', 'E-13'];
const BX_ROWS = ['BX-1', 'BX-2', 'BX-3', 'BX-4', 'BX-5', 'BX-6', 'BX-7', 'BX-9'];

test('E-14: every E result is sealed: no canary, token, url, SDK text, stored bytes or U+FFFD', () => {
  const rows = new Set(SEALED.map((entry) => entry.row));
  assert.deepEqual(E_ROWS.filter((row) => !rows.has(row)), [], 'every E row must have produced results');
  for (const { row, result } of SEALED) if (row.startsWith('E-')) assertSealed(row, result);
});

test('BX-8: every BX result is sealed: no stored bytes, U+FFFD, canary or SDK text', () => {
  const rows = new Set(SEALED.map((entry) => entry.row));
  assert.deepEqual(BX_ROWS.filter((row) => !rows.has(row)), [], 'every BX row must have produced results');
  for (const { row, result } of SEALED) if (row.startsWith('BX-')) assertSealed(row, result);
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

/** A3-4 R2 AM-S4: the snapshot producer is the one application importer. */
const A3_4_STORE_IMPORTERS = new Set(['src/lib/confirmation-envelope-producer.ts']);

test('no application runtime file other than the A3-4 snapshot producer imports the envelope store or its config', () => {
  const offenders: string[] = [];
  for (const file of [...sourceFiles('src'), ...sourceFiles('scripts')]) {
    const rel = path.relative(REPO, file);
    if (NEW_PATHS.has(rel)) continue;
    if (A3_4_STORE_IMPORTERS.has(rel)) continue;
    if (importsModuleMatching(readFileSync(file, 'utf8'), 'confirmation-envelope-(store|config)')) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'A3-4 R2 adds exactly one application caller, the snapshot producer; the dispatcher is A3-5',
  );
  // The producer is reached only through its own entry points: delivery,
  // kickoff and sweep import neither the store nor its config.
  for (const rel of [
    'src/lib/confirmation-email-delivery.ts',
    'src/lib/order-confirmation-kickoff.ts',
    'src/lib/confirmation-email-sweep.ts',
  ]) {
    assert.equal(
      importsModuleMatching(readFileSync(path.join(REPO, rel), 'utf8'), 'confirmation-envelope-(store|config)'),
      false,
      `${rel} must not import the envelope store or its config`,
    );
  }
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
