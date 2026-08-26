/**
 * Adversarial guards for the Family Review CROSS-STORE cutover.
 *
 * The flaw these exist to prevent: a migration that uses one ambient
 * credential for both sides. Source and destination are DIFFERENT Blob
 * stores, so every call must name which side it talks to, and a config
 * that makes them the same store must fail closed rather than perform a
 * self-confirming in-place "copy".
 *
 * Pure guards are exercised directly; wiring guarantees (which token
 * reaches which SDK call) are checked structurally against the source,
 * because those calls cannot be made without live store credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  allAssetsOf,
  applyAuthorizationProblems,
  assetsNeedingCopy,
  blobStoreIdFromToken,
  credentialProblems,
  cutoverStatePath,
  destructiveFlag,
  flipAssetToPrivate,
  parseArgs,
  recordIsReady,
  redactTokens,
} from '../scripts/family-review-migrate-assets.ts';

const SCRIPT = 'scripts/family-review-migrate-assets.ts';

function migrationSource(): string {
  return readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
}

const SRC_TOKEN = 'vercel_blob_rw_SourceStore01_aaaaaaaaaaaaaaaa';
const DST_TOKEN = 'vercel_blob_rw_DestStore99_bbbbbbbbbbbbbbbb';
/** Same store as SRC_TOKEN, different secret — the aliasing case. */
const SRC_TOKEN_ALIAS = 'vercel_blob_rw_SourceStore01_cccccccccccccccc';

/**
 * Strip comments so prose describing a call is never mistaken for the
 * call itself. Block comments go first; then whole-line `//` comments,
 * which is every line comment in this file (a trailing one could not
 * introduce a call site).
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/**
 * Extract the argument text of each call to `name(` in the CODE,
 * balancing parentheses so nested objects are included.
 */
function callArgs(rawSrc: string, name: string): string[] {
  const src = stripComments(rawSrc);
  const out: string[] = [];
  const needle = `${name}(`;
  let idx = src.indexOf(needle);
  while (idx !== -1) {
    const before = src[idx - 1] ?? '';
    // Skip `.get(`, `foo_get(` etc — we want the bare SDK call.
    if (!/[A-Za-z0-9_.$]/.test(before)) {
      let depth = 0;
      let i = idx + needle.length - 1;
      for (; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(src.slice(idx + needle.length, i));
    }
    idx = src.indexOf(needle, idx + needle.length);
  }
  return out;
}

/* ── 1. Missing configuration fails closed ─────────────────────────── */

test('a missing source credential fails closed', () => {
  const problems = credentialProblems(undefined, DST_TOKEN);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /FAMILY_REVIEW_SOURCE_BLOB_TOKEN is not set/);
});

test('a missing destination credential fails closed', () => {
  const problems = credentialProblems(SRC_TOKEN, undefined);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /FAMILY_REVIEW_DEST_BLOB_TOKEN is not set/);
});

test('both missing reports both, not just the first', () => {
  const problems = credentialProblems(undefined, undefined);
  assert.equal(problems.length, 2);
});

test('a blank or whitespace credential is treated as missing', () => {
  assert.ok(credentialProblems('', DST_TOKEN).length > 0);
  assert.ok(credentialProblems('   ', DST_TOKEN).length > 0);
  assert.ok(credentialProblems(SRC_TOKEN, '  ').length > 0);
});

test('a malformed credential fails closed rather than being guessed at', () => {
  for (const bad of [
    'not-a-token',
    'vercel_blob_rw_',
    'vercel_blob_rw_OnlyOnePart',
    'BLOB_READ_WRITE_TOKEN',
    'vercel_blob_ro_Store01_secret',
  ]) {
    assert.equal(blobStoreIdFromToken(bad), null, `${bad} must not parse`);
    assert.ok(
      credentialProblems(bad, DST_TOKEN).some((p) => /well-formed/.test(p)),
      `${bad} must be reported as malformed`,
    );
  }
});

test('a well-formed credential yields its store id', () => {
  assert.equal(blobStoreIdFromToken(SRC_TOKEN), 'SourceStore01');
  assert.equal(blobStoreIdFromToken(DST_TOKEN), 'DestStore99');
});

/* ── 2. Aliasing is rejected ───────────────────────────────────────── */

test('identical credentials are rejected as the same store', () => {
  const problems = credentialProblems(SRC_TOKEN, SRC_TOKEN);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SAME store/);
});

test('DIFFERENT tokens that resolve to the same store are still rejected', () => {
  // The adversarial case: two distinct secrets minted for one store.
  // Comparing token strings would miss this; comparing store ids does not.
  assert.notEqual(SRC_TOKEN, SRC_TOKEN_ALIAS);
  const problems = credentialProblems(SRC_TOKEN, SRC_TOKEN_ALIAS);
  assert.equal(problems.length, 1, 'aliasing must be the single reported problem');
  assert.match(problems[0], /SAME store \(SourceStore01\)/);
});

test('two genuinely distinct stores are accepted', () => {
  assert.deepEqual(credentialProblems(SRC_TOKEN, DST_TOKEN), []);
});

test('aliasing is judged by store id, not by secret length or ordering', () => {
  assert.ok(credentialProblems(SRC_TOKEN_ALIAS, SRC_TOKEN).length > 0);
  assert.deepEqual(credentialProblems(DST_TOKEN, SRC_TOKEN), [], 'reversed roles are still two stores');
});

/* ── 3. Source and destination cannot be confused ──────────────────── */

test('every SDK call names the store it talks to — none rides an ambient token', () => {
  const src = migrationSource();
  for (const fn of ['get', 'put', 'list']) {
    const calls = callArgs(src, fn);
    assert.ok(calls.length > 0, `${fn}() must be called at least once`);
    for (const args of calls) {
      assert.match(
        args,
        /token:\s*creds\.(sourceToken|destToken)/,
        `every ${fn}() must pass an explicit store token. Offending call args: ${args.slice(0, 160)}`,
      );
    }
  }
});

test('writes go ONLY to the destination store', () => {
  const src = migrationSource();
  for (const args of callArgs(src, 'put')) {
    assert.match(
      args,
      /token:\s*creds\.destToken/,
      `put() must write to the destination. Offending: ${args.slice(0, 160)}`,
    );
    assert.doesNotMatch(
      args,
      /token:\s*creds\.sourceToken/,
      'the source store must never be written to',
    );
  }
});

test('writes to the destination are always private', () => {
  const src = migrationSource();
  for (const args of callArgs(src, 'put')) {
    assert.match(
      args,
      /access:\s*'private'/,
      `every destination write must be private. Offending: ${args.slice(0, 160)}`,
    );
  }
});

test('enumeration happens ONLY through the source store', () => {
  const src = migrationSource();
  const calls = callArgs(src, 'list');
  assert.equal(calls.length, 1, 'exactly one enumeration site');
  assert.match(calls[0], /token:\s*creds\.sourceToken/);
  assert.doesNotMatch(calls[0], /destToken/, 'never enumerate the destination');
});

test('the ambient BLOB_READ_WRITE_TOKEN is never consulted', () => {
  const src = migrationSource();
  assert.doesNotMatch(
    src,
    /process\.env\.BLOB_READ_WRITE_TOKEN|BLOB_READ_WRITE_TOKEN['"\]]/,
    'an ambient credential would let one store silently play both roles',
  );
});

test('source bytes are addressed by pathname, never by the recorded URL', () => {
  const src = migrationSource();
  const fnStart = src.indexOf('async function readSourceBytes');
  const fnEnd = src.indexOf('async function copyAndVerify');
  const body = src.slice(fnStart, fnEnd);
  assert.match(body, /get\(\s*asset\.blobPathname/, 'read by pathname + source token');
  assert.doesNotMatch(
    body,
    /asset\.blobUrl/,
    'a recorded URL is untrusted — it could point at another store',
  );
  assert.doesNotMatch(src, /fetch\(/, 'no raw fetch may bypass the token-scoped SDK');
});

/* ── 4. Interrupted copies resume idempotently ─────────────────────── */

const RECORD = {
  photos: {
    assets: [
      { assetId: 'a-p1' } as never,
      { assetId: 'a-p2' } as never,
    ],
  },
  samples: [{ assetId: 'a-s1' } as never],
};

test('a fresh run copies every asset', () => {
  const all = allAssetsOf(RECORD);
  assert.deepEqual(all.map((a) => a.assetId), ['a-p1', 'a-p2', 'a-s1']);
  assert.deepEqual(
    assetsNeedingCopy(all, { assetsVerified: [] }).map((a) => a.assetId),
    ['a-p1', 'a-p2', 'a-s1'],
  );
});

test('an interrupted run resumes at the first unverified asset', () => {
  const all = allAssetsOf(RECORD);
  assert.deepEqual(
    assetsNeedingCopy(all, { assetsVerified: ['a-p1'] }).map((a) => a.assetId),
    ['a-p2', 'a-s1'],
    'a verified asset must never be recopied',
  );
  assert.deepEqual(
    assetsNeedingCopy(all, { assetsVerified: ['a-p1', 'a-p2'] }).map((a) => a.assetId),
    ['a-s1'],
  );
});

test('re-running a completed submission copies nothing — idempotent', () => {
  const all = allAssetsOf(RECORD);
  assert.deepEqual(assetsNeedingCopy(all, { assetsVerified: ['a-p1', 'a-p2', 'a-s1'] }), []);
});

test('resume tolerates stale ids in state without recopying the rest', () => {
  const all = allAssetsOf(RECORD);
  assert.deepEqual(
    assetsNeedingCopy(all, { assetsVerified: ['a-gone', 'a-p1'] }).map((a) => a.assetId),
    ['a-p2', 'a-s1'],
  );
});

test('cutover state lives in the namespaced Family Review prefix', () => {
  assert.match(cutoverStatePath('fr-abc'), /family-review\/cutover\/fr-abc\.json$/);
});

test('cutover state is written to the destination, and checkpointed per asset', () => {
  const src = migrationSource();
  for (const args of callArgs(src, 'put')) {
    if (args.includes('cutoverStatePath')) {
      assert.match(args, /token:\s*creds\.destToken/);
      assert.match(args, /access:\s*'private'/);
    }
  }
  // The checkpoint must happen inside the per-asset loop, before the
  // record write — otherwise an interruption loses all progress.
  const loopIdx = src.indexOf('verified.add(asset.assetId);');
  const recordIdx = src.indexOf('const written = await writeDestinationRecord');
  assert.ok(loopIdx > 0 && recordIdx > loopIdx, 'checkpoint precedes the record write');
  assert.match(
    src.slice(loopIdx, recordIdx),
    /await writeCutoverState\(creds, state\);/,
    'each verified asset must be checkpointed immediately',
  );
});

/* ── 5. Metadata switches only after verified destination persistence ─ */

test('the record is withheld until EVERY asset is verified', () => {
  const all = allAssetsOf(RECORD);
  assert.equal(recordIsReady(all, []), false);
  assert.equal(recordIsReady(all, ['a-p1']), false);
  assert.equal(recordIsReady(all, ['a-p1', 'a-p2']), false, 'one sample still unproven');
  assert.equal(recordIsReady(all, ['a-p1', 'a-p2', 'a-s1']), true);
});

test('unrelated verified ids cannot satisfy the gate', () => {
  const all = allAssetsOf(RECORD);
  assert.equal(
    recordIsReady(all, ['a-x', 'a-y', 'a-z']),
    false,
    'the gate must check THESE assets, not a count',
  );
});

test('the metadata flip points at private storage and drops the public URL', () => {
  const flipped = flipAssetToPrivate({
    assetId: 'a-p1',
    blobPathname: 'family-review/photos/fr-x/a-p1.jpg',
    blobUrl: 'https://example.public.blob.vercel-storage.com/leak.jpg',
    storage: 'public',
    mime: 'image/jpeg',
    size: 10,
    uploadedAt: 'now',
  } as never) as Record<string, unknown>;
  assert.equal(flipped.storage, 'private');
  assert.ok(!('blobUrl' in flipped), 'the legacy public URL must not survive the flip');
  assert.equal(flipped.blobPathname, 'family-review/photos/fr-x/a-p1.jpg');
});

test('verification compares size, content type, AND a content hash of the READ-BACK bytes', () => {
  const src = migrationSource();
  assert.match(src, /size_mismatch/);
  assert.match(src, /content_type_mismatch/);
  assert.match(src, /hash_mismatch/);
  assert.match(src, /sha256\(roundTripped\) !== sourceHash/);
  // The read-back must come from the DESTINATION, or verification would
  // be self-confirming.
  const verifyStart = src.indexOf('// Verify by reading the object BACK');
  const verifyEnd = src.indexOf('return { ok: true };');
  assert.match(src.slice(verifyStart, verifyEnd), /token:\s*creds\.destToken/);
});

test('ordering in source: verify, then checkpoint, then record, then complete', () => {
  const src = migrationSource();
  const copy = src.indexOf('const copied = await copyAndVerify');
  const checkpoint = src.indexOf('verified.add(asset.assetId);');
  const ready = src.indexOf('if (!recordIsReady(');
  const record = src.indexOf('const written = await writeDestinationRecord');
  const complete = src.indexOf('state.completedAt = new Date().toISOString();');
  assert.ok(
    copy > 0 && checkpoint > copy && ready > checkpoint && record > ready && complete > record,
    'copy → verify → checkpoint → readiness gate → record → completion',
  );
});

/* ── 6. Never delete the source ────────────────────────────────────── */

test('any deletion-shaped flag is refused', () => {
  for (const flag of [
    '--delete-source',
    '--delete',
    '--purge',
    '--purge-public',
    '--remove-source',
    '--drop-legacy',
    '--DELETE-SOURCE',
  ]) {
    assert.equal(destructiveFlag([flag]), flag, `${flag} must be refused`);
  }
  assert.equal(destructiveFlag(['--apply', '--limit=3']), null);
});

test('the script neither imports nor calls the Blob delete API', () => {
  const src = migrationSource();
  assert.doesNotMatch(src, /\bdel\s*\(/, 'no delete call');
  const importLine = src.match(/import \{[^}]*\} from '@vercel\/blob';/)?.[0] ?? '';
  assert.doesNotMatch(importLine, /\bdel\b/, 'delete must not even be imported');
  assert.equal(importLine.includes('get'), true);
  assert.equal(importLine.includes('put'), true);
});

/* ── 7. Credentials and private URLs never surface ─────────────────── */

test('token-shaped strings are redacted from any operator-visible text', () => {
  const leaked = `failed with ${SRC_TOKEN} and Bearer abc.def-123 and ?token=${DST_TOKEN}`;
  const safe = redactTokens(leaked);
  assert.ok(!safe.includes(SRC_TOKEN), 'source token must not survive');
  assert.ok(!safe.includes(DST_TOKEN), 'dest token must not survive');
  assert.ok(!safe.includes('abc.def-123'), 'bearer value must not survive');
  assert.match(safe, /\[redacted/);
});

test('errors reaching the console go through redaction', () => {
  const src = migrationSource();
  assert.match(
    src,
    /function errorCode\(err: unknown\): string \{\s*return redactTokens\(/,
    'every error code must be redacted',
  );
  assert.match(
    src,
    /console\.error\(\s*'\[migrate\] fatal:',\s*redactTokens\(/,
    'the fatal handler must redact',
  );
});

test('reporting carries opaque ids and store ids only — no tokens, URLs, or PII', () => {
  const src = migrationSource();
  const report = src.slice(src.indexOf('const tally = new Map'));
  for (const forbidden of [
    'parent',
    'email',
    'firstName',
    'reviewToken',
    'blobUrl',
    'blobPathname',
    'sourceToken',
    'destToken',
  ]) {
    assert.ok(!report.includes(forbidden), `report must never include ${forbidden}`);
  }
  // Store IDS are fine and useful; store SECRETS are not.
  assert.match(src, /creds\.sourceStoreId/);
  assert.match(src, /creds\.destStoreId/);
});

test('no console output interpolates a token', () => {
  const src = migrationSource();
  for (const line of src.split('\n')) {
    if (!/console\.(log|error|warn)/.test(line)) continue;
    assert.doesNotMatch(
      line,
      /\$\{[^}]*(sourceToken|destToken)[^}]*\}/,
      `a credential must never be interpolated into output: ${line.trim()}`,
    );
  }
});

/* ── 8. Operator confirmation (unchanged contract) ─────────────────── */

test('dry run is the default', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--limit=5', '--submission=fr-abc']).apply, false);
});

test('every partial confirmation is refused, including every path to production', () => {
  const partials: [string[], string | undefined][] = [
    [['--apply'], 'i-am-migrating-production'],
    [['--apply', '--target=production'], undefined],
    [['--apply', '--target=production'], 'i-am-migrating-preview'],
    [['--apply', '--target=preview'], 'i-am-migrating-production'],
    [[], 'i-am-migrating-production'],
  ];
  for (const [argv, confirm] of partials) {
    assert.ok(
      applyAuthorizationProblems('production', parseArgs(argv), confirm).length > 0,
      `argv=${JSON.stringify(argv)} must NOT authorize a production write`,
    );
  }
});

test('all three matching confirmations authorize the write', () => {
  assert.deepEqual(
    applyAuthorizationProblems(
      'preview',
      parseArgs(['--apply', '--target=preview']),
      'i-am-migrating-preview',
    ),
    [],
  );
});

test('credentials are validated before any enumeration, even in dry run', () => {
  const src = migrationSource();
  const credIdx = src.indexOf('const creds = resolveCredentials();');
  const listIdx = src.indexOf('await listSourceSubmissionPathnames(creds)');
  const applyIdx = src.indexOf('if (args.apply) requireApplyAuthorization');
  assert.ok(credIdx > 0 && listIdx > credIdx, 'credentials resolve before enumeration');
  assert.ok(
    credIdx < applyIdx,
    'a dry run must also fail closed on bad credentials, not just an apply run',
  );
});

/* ── 9. Enumeration stays scoped ───────────────────────────────────── */

test('enumeration is bounded and confined to the Family Review prefix', () => {
  const src = migrationSource();
  assert.match(src, /withBlobNamespace\('family-review\/submissions\/'\)/);
  assert.match(src, /MAX_LIST_PAGES/);
  assert.doesNotMatch(
    src,
    /list\(\{\s*prefix:\s*withBlobNamespace\('family-review\/(photos|samples)/,
    'asset objects must never be discovered by globbing a prefix',
  );
});

test('the record written to the destination goes through the shared sanitizer', () => {
  const src = migrationSource();
  assert.match(
    src,
    /const plan = buildPersistPlan\(record\);/,
    'reuse the sanitizer so no plaintext review token can reach the destination',
  );
});
