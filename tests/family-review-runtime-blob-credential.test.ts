/**
 * The Family Review lane's dedicated runtime Blob credential.
 *
 * `BLOB_READ_WRITE_TOKEN` names the ORDER lane's store: the order
 * records, customer photos, voice notes, payment-recovery and recovery
 * objects all live in it. Before the boundary these tests guard,
 * the only way to point the Family Review runtime at a private store was
 * to repoint that ambient token, which would have taken every one of
 * those with it into a store the migration never populated.
 *
 * So: in private mode the lane addresses its own store with
 * FAMILY_REVIEW_DEST_BLOB_TOKEN — the same variable the migration writes
 * to — and a missing or malformed one is a refusal, never a fallback.
 *
 * Behavioural proof that the calls actually land on separate stores is
 * in tests/family-review-two-store-isolation.test.ts, which runs the
 * real modules against a two-store fake. This file covers the credential
 * rules themselves and the source-level invariants that keep the
 * boundary from being re-opened by a later edit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FAMILY_REVIEW_PRIVATE_TOKEN_ENV,
  blobStoreIdFromToken,
  familyReviewPrivateToken,
  familyReviewPrivateTokenAvailable,
  familyReviewPrivateTokenProblem,
} from '../src/lib/family-review/blob-credentials.ts';
import { hasBlobToken } from '../src/lib/family-review/store.ts';

const VALID = 'vercel_blob_rw_storeDEST01_secretvalue01';
const AMBIENT = 'vercel_blob_rw_storeAMBIENT1_secretvalue02';

function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T,
): T {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

/* ── 1. The variable ────────────────────────────────────────────────── */

test('the runtime credential is the migration destination variable, not a sixth name', () => {
  // Reusing the name the migration already writes to is what keeps the
  // runtime and the migration from disagreeing about which store "the
  // private Family Review store" is — and keeps the approved cutover at
  // five Production variables rather than six.
  assert.equal(FAMILY_REVIEW_PRIVATE_TOKEN_ENV, 'FAMILY_REVIEW_DEST_BLOB_TOKEN');
  const migration = read('scripts/family-review-migrate-assets.ts');
  assert.match(migration, /const DEST_TOKEN_ENV = 'FAMILY_REVIEW_DEST_BLOB_TOKEN'/);
});

/* ── 2. Token shape ─────────────────────────────────────────────────── */

test('a store id is parsed from a well-formed token and nothing else', () => {
  assert.equal(blobStoreIdFromToken(VALID), 'storeDEST01');
  for (const bad of [
    undefined,
    null,
    '',
    '   ',
    'not-a-token',
    'vercel_blob_rw_onlyonepart',
    'vercel_blob_rw__nosecret',
    'prefix_vercel_blob_rw_store_secret',
    12345 as unknown as string,
  ]) {
    assert.equal(blobStoreIdFromToken(bad as string), null, `must reject: ${String(bad)}`);
  }
});

test('the runtime and the migration share ONE token parser', () => {
  // Two copies could drift into accepting a credential the other
  // refuses, and the aliasing check that stops source and destination
  // being the same store depends on both sides parsing identically.
  const migration = read('scripts/family-review-migrate-assets.ts');
  assert.match(
    migration,
    /import \{ blobStoreIdFromToken \} from '\.\.\/src\/lib\/family-review\/blob-credentials\.ts'/,
    'the migration must import the parser, not redefine it',
  );
  assert.doesNotMatch(
    migration,
    /export function blobStoreIdFromToken/,
    'a second definition is exactly the drift this guards against',
  );
});

/* ── 3. Fail closed ─────────────────────────────────────────────────── */

test('a missing, blank, or malformed credential is reported, never guessed at', () => {
  const cases: [string | undefined, RegExp][] = [
    [undefined, /is not set$/],
    ['', /is not set$/],
    ['    ', /is not set$/],
    ['nonsense', /is not a well-formed Blob token$/],
    ['vercel_blob_rw_x', /is not a well-formed Blob token$/],
  ];
  for (const [value, expected] of cases) {
    const problem = familyReviewPrivateTokenProblem(value);
    assert.ok(problem, `expected a problem for ${JSON.stringify(value)}`);
    assert.match(problem, expected);
    assert.match(problem, /^FAMILY_REVIEW_DEST_BLOB_TOKEN /, 'the problem must name the variable');
  }
  assert.equal(familyReviewPrivateTokenProblem(VALID), null);
});

test('a problem message never contains the value it is complaining about', () => {
  const secret = 'vercel_blob_rw_leaky_SUPERSECRETVALUE';
  for (const value of [secret, 'plain-secret-string', '  padded-secret  ']) {
    const problem = familyReviewPrivateTokenProblem(value) ?? '';
    assert.ok(
      !problem.includes(value.trim()),
      'a credential problem must name the variable and the fault, never the value',
    );
  }
});

test('the resolver returns null rather than falling back to the ambient token', () => {
  withEnv(
    { BLOB_READ_WRITE_TOKEN: AMBIENT, FAMILY_REVIEW_DEST_BLOB_TOKEN: undefined },
    () => {
      assert.equal(familyReviewPrivateToken(), null);
      assert.equal(familyReviewPrivateTokenAvailable(), false);
    },
  );
  withEnv(
    { BLOB_READ_WRITE_TOKEN: AMBIENT, FAMILY_REVIEW_DEST_BLOB_TOKEN: 'garbage' },
    () => {
      assert.equal(familyReviewPrivateToken(), null, 'a malformed value must not resolve');
    },
  );
});

test('a usable credential is returned trimmed', () => {
  withEnv({ FAMILY_REVIEW_DEST_BLOB_TOKEN: `  ${VALID}  ` }, () => {
    assert.equal(familyReviewPrivateToken(), VALID);
  });
});

/* ── 4. The storage gate the routes read ────────────────────────────── */

test('public mode keeps using the ambient token, exactly as before', () => {
  withEnv(
    {
      FAMILY_REVIEW_BLOB_ACCESS: undefined,
      BLOB_READ_WRITE_TOKEN: AMBIENT,
      FAMILY_REVIEW_DEST_BLOB_TOKEN: undefined,
    },
    () => assert.equal(hasBlobToken(), true, 'public mode must not require the dedicated token'),
  );
  withEnv(
    {
      FAMILY_REVIEW_BLOB_ACCESS: undefined,
      BLOB_READ_WRITE_TOKEN: undefined,
      FAMILY_REVIEW_DEST_BLOB_TOKEN: VALID,
    },
    () =>
      assert.equal(
        hasBlobToken(),
        false,
        'the dedicated token must not stand in for the ambient one in public mode',
      ),
  );
});

test('private mode requires the dedicated token and refuses at the door without it', () => {
  // The routes turn `false` into 503 storage_disabled — the same honest
  // refusal an unconfigured deployment already returns — and no SDK or
  // network call is made.
  for (const dest of [undefined, '', '   ', 'not-a-blob-token']) {
    withEnv(
      {
        FAMILY_REVIEW_BLOB_ACCESS: 'private',
        BLOB_READ_WRITE_TOKEN: AMBIENT,
        FAMILY_REVIEW_DEST_BLOB_TOKEN: dest,
      },
      () =>
        assert.equal(
          hasBlobToken(),
          false,
          `private mode must refuse with FAMILY_REVIEW_DEST_BLOB_TOKEN=${JSON.stringify(dest)} even though the ambient token is present`,
        ),
    );
  }
  withEnv(
    {
      FAMILY_REVIEW_BLOB_ACCESS: 'private',
      BLOB_READ_WRITE_TOKEN: undefined,
      FAMILY_REVIEW_DEST_BLOB_TOKEN: VALID,
    },
    () =>
      assert.equal(
        hasBlobToken(),
        true,
        'the private lane stands on its own credential; the ambient one is not its dependency',
      ),
  );
});

/* ── 5. Source invariants: the boundary cannot be re-opened quietly ─── */

test('no Family Review module reads the ambient token except the public-mode gate', () => {
  const assets = read('src/lib/family-review/private-assets.ts');
  const store = read('src/lib/family-review/store.ts');
  const credentials = read('src/lib/family-review/blob-credentials.ts');

  assert.doesNotMatch(
    assets.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''),
    /process\.env\.BLOB_READ_WRITE_TOKEN/,
    'the asset boundary must never consult the order lane’s credential',
  );
  assert.doesNotMatch(
    credentials.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''),
    /process\.env\.BLOB_READ_WRITE_TOKEN/,
  );

  const gate = store.slice(
    store.indexOf('export function hasBlobToken'),
    store.indexOf('function storeTokenOptionsOrNull'),
  );
  const uses = store.split('process.env.BLOB_READ_WRITE_TOKEN').length - 1;
  assert.equal(uses, 1, 'the ambient token may be read in exactly one place');
  assert.match(gate, /process\.env\.BLOB_READ_WRITE_TOKEN/, 'and that place is the public-mode gate');
});

test('every private-mode SDK call in the asset boundary carries the dedicated token', () => {
  const assets = read('src/lib/family-review/private-assets.ts');
  // The private write and the private read both resolve-or-throw first.
  assert.match(assets, /const token = requirePrivateToken\(\);[\s\S]{0,400}?await put\([\s\S]{0,200}?access: 'private',\n\s*token,/);
  assert.match(assets, /const token = requirePrivateToken\(\);[\s\S]{0,400}?await get\([\s\S]{0,200}?access: 'private',\n\s*token,/);
  // Delete and stat follow the configured mode, and refuse rather than
  // silently addressing the ambient store.
  assert.match(assets, /const options = privateTokenOptionsOrNull\(\);\n\s*if \(options === null\) \{\n\s*return \{ deleted: false, reason: 'credential_unavailable' \};/);
  assert.match(assets, /const options = privateTokenOptionsOrNull\(\);\n\s*if \(options === null\) return null;\n[\s\S]{0,120}?await head\(pathname, options\)/);
  assert.match(assets, /await del\(pathname, options\)/);
});

test('every private-mode SDK call in the record store carries the dedicated token', () => {
  const store = read('src/lib/family-review/store.ts');
  // Record + token index writes.
  assert.match(store, /await put\(plan\.submissionPathname, plan\.submissionBody, \{\n\s*access,\n\s*\.\.\.tokenOptions,/);
  assert.match(store, /await put\(plan\.indexPathname, plan\.indexBody, \{\n\s*access,\n\s*\.\.\.tokenOptions,/);
  // Enumeration.
  assert.match(store, /await list\(\{ prefix, limit: LIST_PAGE_SIZE, cursor, \.\.\.tokenOptions \}\)/);
  // Record reads: the token rides only on the private attempt.
  assert.match(store, /\.\.\.\(access === 'private' \? \{ token: privateToken as string \} : \{\}\)/);
});

test('no module interpolates a store credential into a message, log, or thrown error', () => {
  // `token` on its own is ambiguous in this lane — the parent's REVIEW
  // token is also called that, and legacyRawReviewTokenPath legitimately
  // interpolates it (guarded separately by
  // tests/family-review-token-privacy.test.ts). So: the bare name is
  // checked only where it can only mean a store credential, and the
  // unambiguous names are checked everywhere.
  for (const file of [
    'src/lib/family-review/blob-credentials.ts',
    'src/lib/family-review/private-assets.ts',
  ]) {
    assert.doesNotMatch(read(file), /\$\{token\}/, `${file} must never interpolate the store token`);
  }
  for (const file of [
    'src/lib/family-review/blob-credentials.ts',
    'src/lib/family-review/private-assets.ts',
    'src/lib/family-review/store.ts',
  ]) {
    const source = read(file);
    for (const name of ['privateToken', 'destToken', 'sourceToken', 'blobToken']) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\$\\{${name}\\}`),
        `${file} must never interpolate ${name} into a string`,
      );
    }
  }
});

test('a private failure is never retried as a public read', () => {
  const assets = read('src/lib/family-review/private-assets.ts');
  const openAsset = assets.slice(
    assets.indexOf('export async function openAsset'),
    assets.indexOf('export async function deleteAsset'),
  );
  const privateBranch = openAsset.slice(0, openAsset.indexOf('if (!legacyPublicAssetReadsAllowed())'));
  assert.match(privateBranch, /throw new AssetStorageError\(\s*'private_read_failed'/);
  assert.match(privateBranch, /throw new AssetStorageError\(\s*'not_found'/);
  assert.doesNotMatch(privateBranch, /fetch\(/, 'the private branch must never reach the public fetch');
  assert.doesNotMatch(privateBranch, /blobUrl/, 'a private asset has no URL to fall back to');
});

test('an unusable private credential stops a record read before any attempt', () => {
  const store = read('src/lib/family-review/store.ts');
  const fn = store.slice(
    store.indexOf('async function getJsonAtPath'),
    store.indexOf('async function fetchSubmissionByPath'),
  );
  const guard = fn.indexOf("if (mode === 'private' && !privateToken) return null;");
  const attempts = fn.indexOf('const attempts:');
  assert.ok(guard > 0, 'private mode must resolve its credential before choosing attempts');
  assert.ok(
    guard < attempts,
    'the refusal must come BEFORE the public attempt is even in the list — a private lane must not satisfy a read from the ambient public store',
  );
});
