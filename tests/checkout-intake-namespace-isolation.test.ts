/*
 * F5 — namespace and Blob-store identity isolation.
 *
 * Two reproduced defects this file pins down:
 *
 *  1. Intake and guard paths bypassed the repository's namespace isolation
 *     entirely. `orders.ts` has enforced `HSB_BLOB_NAMESPACE` since the order
 *     store was hardened — a Preview deployment holding a production token
 *     addresses `preview/orders/...`, not `orders/...`. The intake and guard
 *     stores wrote flat `intakes/` and `guard/` keys, so Preview with a
 *     production token would have addressed production keyspace directly.
 *
 *  2. "Dedicated store" was checked by comparing whole token STRINGS. Two
 *     different credentials issued for the SAME Vercel Blob store are two
 *     different strings, so the check passed while both tokens addressed one
 *     store. Vercel tokens are `vercel_blob_rw_<storeId>_<secret>`; identity
 *     is the store id, not the secret.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDistinctBlobStores,
  BlobTokenError,
  parseBlobToken,
} from '../src/lib/checkout-blob-identity.ts';
import {
  createVercelIntakeStore,
  getRequiredIntakeBlobToken,
  intakeAssetPath,
  intakeRecordPath,
  IntakeError,
} from '../src/lib/checkout-intake.ts';
import {
  createBlobCheckoutGuardStore,
  guardBucketPath,
  resolveCheckoutGuardStore,
} from '../src/lib/checkout-request-guard.ts';
import { getBlobNamespace } from '../src/lib/blob-namespace.ts';

const STORE_A = 'AbCd1234EfGh5678';
const STORE_B = 'ZzZz9999YyYy8888';
const tokenFor = (storeId: string, secret: string) => `vercel_blob_rw_${storeId}_${secret}`;

const INTAKE_TOKEN = tokenFor(STORE_A, 'intakeSecret000000000001');
const GUARD_TOKEN = tokenFor(STORE_B, 'guardSecret0000000000001');
const ORDER_TOKEN = tokenFor('OrDeRsToRe123456', 'orderSecret0000000000001');

function code(error: unknown): string {
  assert.ok(
    error instanceof IntakeError || error instanceof BlobTokenError,
    `expected a typed error, got ${String(error)}`,
  );
  return (error as { code?: string }).code ?? (error as Error).name;
}

// ---------------------------------------------------------------------------
// Token shape and store identity
// ---------------------------------------------------------------------------

test('a Vercel Blob token is parsed to its store id, and never echoed', () => {
  const parsed = parseBlobToken(INTAKE_TOKEN, 'intake');
  assert.equal(parsed.storeId, STORE_A);
  assert.equal(Object.values(parsed).includes(INTAKE_TOKEN), false, 'the token is not carried in the parse result');
});

test('a malformed token fails closed and the message never contains token bytes', () => {
  for (const bad of ['', '   ', 'nope', 'vercel_blob_rw_only3', `${INTAKE_TOKEN}_extra`, 'vercel_blob_ro_Store_secret']) {
    let thrown: unknown;
    try {
      parseBlobToken(bad, 'intake');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof BlobTokenError, `"${bad}" must be refused`);
    assert.equal(
      (thrown as Error).message.includes(bad.trim()) && bad.trim().length > 0,
      false,
      'the rejected token value must not appear in the error message',
    );
  }
});

test('two DIFFERENT tokens for the SAME store are refused as not dedicated', () => {
  // The exact reproduced case: string comparison passes, store identity does not.
  const sameStoreOtherSecret = tokenFor(STORE_A, 'aCompletelyDifferentSecret1');
  assert.notEqual(INTAKE_TOKEN, sameStoreOtherSecret, 'the two tokens really are different strings');

  assert.throws(
    () => assertDistinctBlobStores([
      { label: 'intake', token: INTAKE_TOKEN },
      { label: 'guard', token: sameStoreOtherSecret },
    ]),
    (error) => code(error) === 'BlobTokenError',
  );
});

test('distinct stores are accepted', () => {
  assert.doesNotThrow(() => assertDistinctBlobStores([
    { label: 'intake', token: INTAKE_TOKEN },
    { label: 'guard', token: GUARD_TOKEN },
    { label: 'order', token: ORDER_TOKEN },
  ]));
});

test('the intake credential is refused when it shares a store with orders or the guard', () => {
  const shared = tokenFor(STORE_A, 'anotherSecretEntirely00001');
  assert.throws(
    () => getRequiredIntakeBlobToken({
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
      BLOB_READ_WRITE_TOKEN: shared,
    } as NodeJS.ProcessEnv),
    (error) => code(error) === 'intake_store_must_be_dedicated',
  );
  assert.throws(
    () => getRequiredIntakeBlobToken({
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
      HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: shared,
    } as NodeJS.ProcessEnv),
    (error) => code(error) === 'intake_store_must_be_dedicated',
  );
  assert.equal(
    getRequiredIntakeBlobToken({
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
      BLOB_READ_WRITE_TOKEN: ORDER_TOKEN,
      HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: GUARD_TOKEN,
    } as NodeJS.ProcessEnv),
    INTAKE_TOKEN,
  );
});

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

test('every intake and guard path is namespaced', () => {
  assert.equal(intakeRecordPath(`intake_${'a'.repeat(32)}`, 'preview'), `preview/intakes/intake_${'a'.repeat(32)}.json`);
  assert.equal(
    intakeAssetPath(`intake_${'a'.repeat(32)}`, `asset_${'b'.repeat(32)}`, 'preview'),
    `preview/intakes/intake_${'a'.repeat(32)}/assets/asset_${'b'.repeat(32)}`,
  );
  assert.equal(guardBucketPath('intake', 60_000, 'preview'), 'preview/guard/intake/60000.json');

  // Production keeps flat paths, matching the order store's legacy layout.
  assert.equal(intakeRecordPath(`intake_${'a'.repeat(32)}`, ''), `intakes/intake_${'a'.repeat(32)}.json`);
  assert.equal(guardBucketPath('intake', 60_000, ''), 'guard/intake/60000.json');
});

test('Preview without an explicit namespace fails closed', () => {
  const previewEnv = { VERCEL_ENV: 'preview' } as NodeJS.ProcessEnv;
  assert.throws(() => getBlobNamespace(previewEnv), /HSB_BLOB_NAMESPACE/);

  // ...and that failure reaches store construction rather than defaulting to
  // the flat production keyspace.
  assert.throws(
    () => createVercelIntakeStore(INTAKE_TOKEN, {
      ...previewEnv,
      HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
    } as NodeJS.ProcessEnv),
    /HSB_BLOB_NAMESPACE/,
  );
  assert.throws(
    () => createBlobCheckoutGuardStore(GUARD_TOKEN, previewEnv),
    /HSB_BLOB_NAMESPACE/,
  );
});

test('Preview naming itself "production" is refused', () => {
  const env = { VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'production' } as NodeJS.ProcessEnv;
  assert.throws(() => getBlobNamespace(env), /production/);
  assert.throws(() => createBlobCheckoutGuardStore(GUARD_TOKEN, env), /production/);
});

test('namespaces that normalize or escape path segments fail closed', () => {
  for (const namespace of ['.', '..', './preview', 'preview/..', 'preview/x', 'preview\\x', ' preview ', 'preview\n', 'a'.repeat(65)]) {
    assert.throws(
      () => getBlobNamespace({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: namespace } as NodeJS.ProcessEnv),
      /namespace/i,
      namespace,
    );
  }
  assert.equal(
    getBlobNamespace({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'preview-pr-154' } as NodeJS.ProcessEnv),
    'preview-pr-154',
  );
});

test('an explicit Preview namespace is honoured end to end', () => {
  const env = {
    VERCEL_ENV: 'preview',
    HSB_BLOB_NAMESPACE: 'preview',
    HSB_CHECKOUT_GUARD_MODE: 'durable',
    HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: GUARD_TOKEN,
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: INTAKE_TOKEN,
    BLOB_READ_WRITE_TOKEN: ORDER_TOKEN,
  } as NodeJS.ProcessEnv;

  assert.equal(getBlobNamespace(env), 'preview');
  assert.doesNotThrow(() => createVercelIntakeStore(INTAKE_TOKEN, env));
  assert.doesNotThrow(() => resolveCheckoutGuardStore(env));
});
