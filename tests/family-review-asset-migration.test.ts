/**
 * Adversarial guards for the Family Review CROSS-STORE cutover.
 *
 * Two classes of flaw these exist to prevent:
 *
 *   1. One ambient credential playing both sides, which turns a "copy"
 *      into a self-confirming no-op.
 *   2. Resume state that is trusted without being bound to the thing it
 *      describes, which turns a crash into silent data loss.
 *
 * Pure logic is exercised directly. Wiring guarantees (which token
 * reaches which SDK call) are checked structurally against the source,
 * because those calls cannot be made without live store credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyAuthorizationProblems,
  assetIdentitiesOf,
  assetIdentityKey,
  assetsNeedingCopy,
  blobStoreIdFromToken,
  collectPathnames,
  checkpointStateRequiresRefusal,
  computeRecordFingerprint,
  credentialProblems,
  cutoverStatePath,
  destructiveFlag,
  digestStream,
  duplicateIdentityKeys,
  destinationRecordMatchesSource,
  EnumerationTruncatedError,
  flipAssetToPrivate,
  MAX_ASSET_BYTES,
  MAX_ASSETS_PER_RECORD,
  MAX_CUTOVER_JSON_BYTES,
  MAX_STATE_REASONS,
  meterAndSniff,
  parseBoundedJsonStream,
  inspectSubmissionForMigration,
  parseArgs,
  persistCutoverStateOrFailure,
  persistDestinationRecordOrFailure,
  recordFailureOutcome,
  recordIsReady,
  requestedRecordMissingOutcome,
  safeAssetIdForOperatorOutput,
  redactTokens,
  sourceGetOptions,
  destGetOptions,
  bindPathnameToSubmission,
  familyReviewAssetPrefix,
  pathnameMatchesIdentity,
  recordPathnameBindingFailures,
  validateSubmissionAddress,
  revalidateCheckpointedAsset,
  revalidateCheckpoints,
  reviseStateAfterRevalidation,
  validateCutoverState,
  verifySourceType,
  CUTOVER_STATE_VERSION,
} from '../scripts/family-review-migrate-assets.ts';

const SCRIPT = 'scripts/family-review-migrate-assets.ts';

function migrationSource(): string {
  return readFileSync(resolve(process.cwd(), SCRIPT), 'utf8');
}

const SRC_TOKEN = 'vercel_blob_rw_SourceStore01_aaaaaaaaaaaaaaaa';
const DST_TOKEN = 'vercel_blob_rw_DestStore99_bbbbbbbbbbbbbbbb';
/** Same store as SRC_TOKEN, different secret - the aliasing case. */
const SRC_TOKEN_ALIAS = 'vercel_blob_rw_SourceStore01_cccccccccccccccc';

const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

/**
 * Strip comments so prose describing a call is never mistaken for the
 * call itself.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** Argument text of each call to `name(` in the CODE, parens balanced. */
function callArgs(rawSrc: string, name: string): string[] {
  const src = stripComments(rawSrc);
  const out: string[] = [];
  const needle = `${name}(`;
  let idx = src.indexOf(needle);
  while (idx !== -1) {
    const before = src[idx - 1] ?? '';
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

/* ---- record fixtures ---- */

function photo(assetId: string, over: Record<string, unknown> = {}) {
  return {
    assetId,
    blobPathname: `family-review/photos/fr-x-1234/${assetId}.jpg`,
    blobUrl: `https://example.public.blob.vercel-storage.com/${assetId}.jpg`,
    storage: 'public',
    mime: 'image/jpeg',
    size: 1000,
    uploadedAt: 'now',
    ...over,
  } as never;
}

function sample(assetId: string, over: Record<string, unknown> = {}) {
  return {
    assetId,
    briefId: 'cover-hero',
    blobPathname: `family-review/samples/fr-x-1234/${assetId}.png`,
    blobUrl: `https://example.public.blob.vercel-storage.com/${assetId}.png`,
    storage: 'public',
    mime: 'image/png',
    size: 2000,
    uploadedAt: 'now',
    ...over,
  } as never;
}

function record(over: Record<string, unknown> = {}) {
  return {
    id: 'fr-x-1234',
    photos: { assets: [photo('a-photo00000001'), photo('a-photo00000002')] },
    samples: [sample('a-sample00000001')],
    ...over,
  } as never as {
    id: string;
    photos: { assets: never[] };
    samples: never[];
  };
}

/** A fully-verified, correctly-bound state for a record. */
function goodState(rec: ReturnType<typeof record>, over: Record<string, unknown> = {}) {
  return {
    version: CUTOVER_STATE_VERSION,
    submissionId: rec.id,
    recordFingerprint: computeRecordFingerprint(rec),
    assetsVerified: assetIdentitiesOf(rec).map((i) => ({ ...i, sourceSha256: SHA })),
    recordWritten: true,
    recordUpdatedAt: '2026-08-25T23:59:59.000Z',
    completedAt: '2026-08-26T00:00:00.000Z',
    ...over,
  };
}

/* ---- byte fixtures ---- */

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

function bytesOf(head: number[], totalLen: number): Uint8Array {
  const out = new Uint8Array(totalLen);
  out.set(head.slice(0, totalLen), 0);
  return out;
}

/**
 * A stream that emits `chunks` chunks of `chunkSize` bytes, counting how
 * many were actually produced so a test can prove early cancellation.
 */
function countingStream(
  chunkSize: number,
  chunks: number,
  head: number[],
  counter: { produced: number },
): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= chunks) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(chunkSize);
      if (emitted === 0) chunk.set(head.slice(0, chunkSize), 0);
      emitted += 1;
      counter.produced += 1;
      controller.enqueue(chunk);
    },
  });
}

/* == 1. Missing configuration fails closed ================================ */

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
  assert.equal(credentialProblems(undefined, undefined).length, 2);
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

/* == 2. Aliasing is rejected ============================================== */

test('identical credentials are rejected as the same store', () => {
  const problems = credentialProblems(SRC_TOKEN, SRC_TOKEN);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SAME store/);
});

test('DIFFERENT tokens that resolve to the same store are still rejected', () => {
  assert.notEqual(SRC_TOKEN, SRC_TOKEN_ALIAS);
  const problems = credentialProblems(SRC_TOKEN, SRC_TOKEN_ALIAS);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SAME store \(SourceStore01\)/);
});

test('two genuinely distinct stores are accepted', () => {
  assert.deepEqual(credentialProblems(SRC_TOKEN, DST_TOKEN), []);
  assert.deepEqual(credentialProblems(DST_TOKEN, SRC_TOKEN), []);
});

/* == 3. Source and destination cannot be confused ========================= */

test('every SDK call names the store it talks to - none rides an ambient token', () => {
  const src = migrationSource();
  for (const fn of ['get', 'put', 'list']) {
    const calls = callArgs(src, fn);
    assert.ok(calls.length > 0, `${fn}() must be called at least once`);
    for (const args of calls) {
      // Either an inline `token: creds.x`, or one of the side-specific
      // option builders, which carry the token themselves.
      assert.match(
        args,
        /token:\s*creds\.(sourceToken|destToken)|(?:source|dest)GetOptions\(creds\.(?:source|dest)Token\)/,
        `every ${fn}() must name its store. Offending: ${args.slice(0, 160)}`,
      );
    }
  }
});

test('an option builder is never handed the other side\'s token', () => {
  const src = stripComments(migrationSource());
  assert.doesNotMatch(src, /sourceGetOptions\(\s*creds\.destToken/);
  assert.doesNotMatch(src, /destGetOptions\(\s*creds\.sourceToken/);
  // And every builder call site uses the matching credential.
  const uses = [...src.matchAll(/(source|dest)GetOptions\(creds\.(source|dest)Token\)/g)];
  assert.ok(uses.length >= 6, `expected every read to use a builder, found ${uses.length}`);
  for (const m of uses) {
    assert.equal(m[1], m[2], `mismatched builder/token pairing: ${m[0]}`);
  }
});

test('writes go ONLY to the destination store, and are always private', () => {
  const src = migrationSource();
  for (const args of callArgs(src, 'put')) {
    assert.match(args, /token:\s*creds\.destToken/, `put must target dest: ${args.slice(0, 160)}`);
    assert.doesNotMatch(args, /token:\s*creds\.sourceToken/);
    assert.match(args, /access:\s*'private'/, `put must be private: ${args.slice(0, 160)}`);
  }
});

test('enumeration happens ONLY through the source store', () => {
  const calls = callArgs(migrationSource(), 'list');
  assert.equal(calls.length, 1, 'exactly one enumeration site');
  assert.match(calls[0], /token:\s*creds\.sourceToken/);
  assert.doesNotMatch(calls[0], /destToken/);
});

test('the ambient BLOB_READ_WRITE_TOKEN is never consulted', () => {
  assert.doesNotMatch(
    migrationSource(),
    /process\.env\.BLOB_READ_WRITE_TOKEN|BLOB_READ_WRITE_TOKEN['"\]]/,
  );
});

test('source bytes are addressed by pathname, never by the recorded URL', () => {
  const src = migrationSource();
  const body = src.slice(
    src.indexOf('async function copyAssetStreaming'),
    src.indexOf('async function writeDestinationRecord'),
  );
  assert.match(body, /get\(\s*identity\.pathname/);
  assert.doesNotMatch(body, /blobUrl/, 'a recorded URL could point at another store');
  assert.doesNotMatch(src, /fetch\(/, 'no raw fetch may bypass the token-scoped SDK');
});

/* == 4. The 25 MB ceiling is enforced WHILE streaming ===================== */

test('meterAndSniff aborts mid-flight instead of buffering the whole object', async () => {
  const counter = { produced: 0 };
  // 10 000 bytes available, 1 000 allowed: a buffering implementation
  // would pull all 1 000 chunks before noticing.
  const src = countingStream(10, 1000, PNG_HEAD, counter);
  const metered = await meterAndSniff(src, 1000);

  await assert.rejects(
    () => new Response(metered.body).arrayBuffer(),
    'the body must error once the ceiling is passed',
  );
  await assert.rejects(() => metered.settled, /ceiling/);

  assert.ok(
    counter.produced < 200,
    `source must be cancelled early; produced ${counter.produced} of 1000 chunks`,
  );
  assert.ok(
    counter.produced * 10 <= 1000 + 10 * 20,
    'no more than a small overshoot past the ceiling may be read',
  );
});

test('meterAndSniff passes an in-bounds object through intact and hashes it', async () => {
  const counter = { produced: 0 };
  const src = countingStream(10, 10, PNG_HEAD, counter);
  const metered = await meterAndSniff(src, 1000);
  const out = new Uint8Array(await new Response(metered.body).arrayBuffer());
  const stats = await metered.settled;

  assert.equal(out.byteLength, 100);
  assert.equal(stats.size, 100);
  assert.match(stats.sha256, /^[0-9a-f]{64}$/);
  assert.equal(counter.produced, 10);
});

test('meterAndSniff peeks the head without consuming the body', async () => {
  const counter = { produced: 0 };
  const metered = await meterAndSniff(countingStream(4, 8, PNG_HEAD, counter), 1000);
  assert.deepEqual(Array.from(metered.head.slice(0, 4)), PNG_HEAD.slice(0, 4));
  const out = new Uint8Array(await new Response(metered.body).arrayBuffer());
  assert.equal(out.byteLength, 32, 'the peeked bytes must still be delivered');
});

test('digestStream enforces the ceiling while reading, and cancels the source', async () => {
  const counter = { produced: 0 };
  const src = countingStream(10, 1000, PNG_HEAD, counter);
  await assert.rejects(() => digestStream(src, 1000), /ceiling/);
  assert.ok(
    counter.produced < 200,
    `read-back must stop early; produced ${counter.produced} of 1000 chunks`,
  );
});

test('digestStream returns size, hash and head without buffering the object', async () => {
  const counter = { produced: 0 };
  const stats = await digestStream(countingStream(10, 10, JPEG_HEAD, counter), 1000);
  assert.equal(stats.size, 100);
  assert.match(stats.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Array.from(stats.head.slice(0, 4)), JPEG_HEAD);
});

test('the production ceiling is 25 MB and is applied to both directions', () => {
  assert.equal(MAX_ASSET_BYTES, 25 * 1024 * 1024);
  const src = migrationSource();
  assert.match(src, /meterAndSniff\(source\.stream, MAX_ASSET_BYTES\)/);
  assert.match(src, /digestStream\(readBack\.stream, MAX_ASSET_BYTES\)/);
  assert.match(src, /maximumSizeInBytes: MAX_ASSET_BYTES/, 'SDK-side backstop');
});

test('no code path buffers a whole asset into memory', () => {
  const src = stripComments(migrationSource());
  const copyBody = src.slice(
    src.indexOf('async function copyAssetStreaming'),
    src.indexOf('async function writeDestinationRecord'),
  );
  assert.doesNotMatch(
    copyBody,
    /arrayBuffer\(\)|\.text\(\)|Buffer\.from/,
    'asset bytes must never be materialised whole',
  );
});

/* == 5. Content type is sniffed from the source, not echoed ============== */

test('a record whose recorded mime contradicts its bytes is refused with a bounded detail', async () => {
  const png = bytesOf(PNG_HEAD, 16);
  const verdict = verifySourceType(png, 'image/jpeg');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.result, 'content_type_mismatch');
  assert.equal(
    verdict.ok === false ? verdict.detail : '',
    'recorded_mime_mismatch',
  );
});

test('hostile recorded mime text never reaches a mismatch detail', () => {
  const png = bytesOf(PNG_HEAD, 16);
  const verdict = verifySourceType(
    png,
    'image/jpeg\nfamily@example.com',
  );
  assert.deepEqual(verdict, {
    ok: false,
    result: 'content_type_mismatch',
    detail: 'recorded_mime_mismatch',
  });
});

test('record-controlled size text never reaches operator failure detail', () => {
  const src = migrationSource();
  assert.doesNotMatch(src, /detail:\s*`record says \$\{identity\.size\}/);
  assert.match(
    src,
    /result:\s*'size_mismatch',[\s\S]*?detail:\s*'recorded_size_mismatch'/,
  );
});

test('bytes that are not a supported image are refused, whatever the record says', async () => {
  const html = new TextEncoder().encode('<!DOCTYPE html><scr');
  for (const claimed of ['image/png', 'image/jpeg', 'image/webp']) {
    const verdict = verifySourceType(html.slice(0, 16), claimed);
    assert.equal(verdict.ok, false, `claimed ${claimed} must not rescue HTML bytes`);
    assert.equal(verdict.ok === false && verdict.result, 'source_type_unrecognized');
  }
});

test('an agreeing record passes, and equivalent spellings are not spoofs', async () => {
  assert.equal(verifySourceType(bytesOf(PNG_HEAD, 16), 'image/png').ok, true);
  assert.equal(verifySourceType(bytesOf(JPEG_HEAD, 16), 'image/jpeg').ok, true);
  // image/jpg is the same format as image/jpeg.
  assert.equal(verifySourceType(bytesOf(JPEG_HEAD, 16), 'image/jpg').ok, true);
});

test('the type WRITTEN to the destination is the sniffed one, not the recorded one', () => {
  const src = stripComments(migrationSource());
  const copyBody = src.slice(
    src.indexOf('async function copyAssetStreaming'),
    src.indexOf('async function writeDestinationRecord'),
  );
  assert.match(copyBody, /contentType:\s*sniffed\.mime/);
  assert.doesNotMatch(
    copyBody,
    /contentType:\s*identity\.mime/,
    'writing the recorded mime and reading it back proves only that the SDK echoes input',
  );
  // And the destination object's own bytes are re-sniffed afterwards.
  assert.match(copyBody, /sniffImageType\(destStats\.head\)/);
  assert.match(copyBody, /dest_content_type_unverified/);
});

test('a source whose streamed length disagrees with the record is refused', () => {
  const src = migrationSource();
  assert.match(src, /sourceStats\.size !== identity\.size/);
  assert.match(src, /result: 'size_mismatch'/);
});

/* == 6. Enumeration failure is explicit ================================== */

test('a truncated enumeration throws instead of returning a short list', async () => {
  // Every page says there is more; the budget runs out.
  const pager = async (cursor: string | undefined) => ({
    blobs: [{ pathname: `p-${cursor ?? '0'}` }],
    hasMore: true,
    cursor: `${Number(cursor ?? '0') + 1}`,
  });
  await assert.rejects(
    () => collectPathnames(pager, 3),
    (err: unknown) => {
      assert.ok(err instanceof EnumerationTruncatedError);
      assert.equal((err as EnumerationTruncatedError).pagesScanned, 3);
      assert.equal((err as EnumerationTruncatedError).objectsSeen, 3);
      return true;
    },
  );
});

test('an enumeration that finishes inside the budget returns everything', async () => {
  let page = 0;
  const pager = async () => {
    page += 1;
    return {
      blobs: [{ pathname: `p-${page}` }],
      hasMore: page < 3,
      cursor: page < 3 ? `${page}` : undefined,
    };
  };
  assert.deepEqual(await collectPathnames(pager, 40), ['p-1', 'p-2', 'p-3']);
});

test('hasMore with no cursor is refused as a truncated enumeration', async () => {
  const pager = async () => ({
    blobs: [{ pathname: 'only' }],
    hasMore: true,
    cursor: undefined,
  });
  await assert.rejects(
    () => collectPathnames(pager, 40),
    (err: unknown) => {
      assert.ok(err instanceof EnumerationTruncatedError);
      assert.equal((err as EnumerationTruncatedError).pagesScanned, 1);
      assert.equal((err as EnumerationTruncatedError).objectsSeen, 1);
      return true;
    },
  );
});

test('the truncation error aborts the run with its own exit code', () => {
  const src = migrationSource();
  assert.match(src, /err instanceof EnumerationTruncatedError/);
  assert.match(src, /REFUSING TO CONTINUE/);
  assert.match(src, /process\.exit\(5\)/);
});

/* == 7. Checkpoint binding ============================================== */

test('a fresh run with no state copies every asset', () => {
  const rec = record();
  const { state, reasons } = validateCutoverState(null, rec);
  assert.deepEqual(reasons, []);
  assert.deepEqual(state.assetsVerified, []);
  assert.deepEqual(
    assetsNeedingCopy(assetIdentitiesOf(rec), state).map((i) => assetIdentityKey(i)),
    ['photo:a-photo00000001', 'photo:a-photo00000002', 'sample:a-sample00000001'],
  );
});

test('a correctly-bound complete state is honoured', () => {
  const rec = record();
  const { state, reasons } = validateCutoverState(goodState(rec), rec);
  assert.deepEqual(reasons, []);
  assert.equal(state.completedAt, '2026-08-26T00:00:00.000Z');
  assert.equal(recordIsReady(assetIdentitiesOf(rec), state), true);
});

test('state for a DIFFERENT submission is never honoured', () => {
  const rec = record();
  const foreign = { ...goodState(rec), submissionId: 'fr-someone-else' };
  const { state, reasons } = validateCutoverState(foreign, rec);
  assert.deepEqual(reasons, ['state_foreign_submission']);
  assert.deepEqual(state.assetsVerified, []);
  assert.equal(state.completedAt, undefined);
});

test('state written under an unknown schema version is discarded', () => {
  const rec = record();
  const { state, reasons } = validateCutoverState(
    { ...goodState(rec), version: 99 },
    rec,
  );
  assert.deepEqual(reasons, ['state_version_unknown']);
  assert.equal(state.completedAt, undefined);
});

test('malformed state is discarded rather than partially trusted', () => {
  const rec = record();
  for (const bad of ['a string', 42, true, { version: CUTOVER_STATE_VERSION }]) {
    const { state } = validateCutoverState(bad, rec);
    assert.deepEqual(state.assetsVerified, [], `${JSON.stringify(bad)} must not survive`);
    assert.equal(state.completedAt, undefined);
  }
});

test('assetsVerified that is not an array is discarded', () => {
  const rec = record();
  const { state, reasons } = validateCutoverState(
    { ...goodState(rec), assetsVerified: 'all of them' },
    rec,
  );
  assert.deepEqual(reasons, ['state_malformed']);
  assert.deepEqual(state.assetsVerified, []);
});

/* == 8. Crash / resume: a changed source object ========================== */

test('a record changed after partial migration invalidates the whole checkpoint', () => {
  const before = record();
  const partial = {
    version: CUTOVER_STATE_VERSION,
    submissionId: before.id,
    recordFingerprint: computeRecordFingerprint(before),
    assetsVerified: [
      { ...assetIdentitiesOf(before)[0], sourceSha256: SHA },
    ],
    recordWritten: false,
  };
  // A sample is replaced between runs - the record's shape changed.
  const after = record({ samples: [sample('a-s2')] });
  const { state, reasons } = validateCutoverState(partial, after);
  assert.deepEqual(reasons, ['record_changed']);
  assert.deepEqual(state.assetsVerified, [], 'nothing may carry over');
  assert.equal(
    assetsNeedingCopy(assetIdentitiesOf(after), state).length,
    3,
    'every asset is recopied after a record change',
  );
});

test('a source object that changed size is recopied, not skipped', () => {
  const before = record();
  const stateBefore = goodState(before);
  // Same assetId and pathname, different bytes -> different declared size.
  const after = record({ photos: { assets: [photo('a-photo00000001', { size: 9999 }), photo('a-photo00000002')] } });
  const { state, reasons } = validateCutoverState(stateBefore, after);
  // The fingerprint covers size, so the whole checkpoint is invalidated.
  assert.deepEqual(reasons, ['record_changed']);
  assert.ok(
    assetsNeedingCopy(assetIdentitiesOf(after), state).some(
      (i) => i.assetId === 'a-photo00000001',
    ),
    'the changed object must be recopied',
  );
});

test('an entry whose identity drifted from the record is dropped', () => {
  const rec = record();
  // Fingerprint still matches, but one entry claims the wrong pathname -
  // the shape a hand-edited or merged state file would have.
  const tampered = {
    ...goodState(rec),
    assetsVerified: goodState(rec).assetsVerified.map((v, i) =>
      i === 0 ? { ...v, pathname: 'family-review/photos/fr-x-1234/somewhere-else.jpg' } : v,
    ),
  };
  const { state, reasons } = validateCutoverState(tampered, rec);
  assert.ok(reasons.includes('entry_malformed'));
  assert.equal(state.assetsVerified.length, 2, 'the malformed entry is dropped');
  assert.equal(state.completedAt, undefined, 'coverage is no longer complete');
  assert.equal(recordIsReady(assetIdentitiesOf(rec), state), false);
});

test('an interrupted run resumes at the first unverified asset', () => {
  const rec = record();
  const partial = {
    version: CUTOVER_STATE_VERSION,
    submissionId: rec.id,
    recordFingerprint: computeRecordFingerprint(rec),
    assetsVerified: [{ ...assetIdentitiesOf(rec)[0], sourceSha256: SHA }],
    recordWritten: false,
  };
  const { state, reasons } = validateCutoverState(partial, rec);
  assert.deepEqual(reasons, []);
  assert.deepEqual(
    assetsNeedingCopy(assetIdentitiesOf(rec), state).map((i) => assetIdentityKey(i)),
    ['photo:a-photo00000002', 'sample:a-sample00000001'],
  );
});

test('re-running a completed submission copies nothing', () => {
  const rec = record();
  const { state } = validateCutoverState(goodState(rec), rec);
  assert.deepEqual(assetsNeedingCopy(assetIdentitiesOf(rec), state), []);
});

/* == 9. Crash / resume: reused and duplicate ids ========================= */

test('the same assetId on a photo and a sample are two distinct assets', () => {
  const rec = record({
    photos: { assets: [photo('a-shared00000001')] },
    samples: [sample('a-shared00000001')],
  });
  const identities = assetIdentitiesOf(rec);
  assert.deepEqual(
    identities.map((i) => assetIdentityKey(i)),
    ['photo:a-shared00000001', 'sample:a-shared00000001'],
    'kind must be part of the identity key',
  );
  assert.deepEqual(duplicateIdentityKeys(identities), [], 'this is legal, not a duplicate');

  // Verifying the photo must NOT mark the sample done.
  const partial = {
    version: CUTOVER_STATE_VERSION,
    submissionId: rec.id,
    recordFingerprint: computeRecordFingerprint(rec),
    assetsVerified: [{ ...identities[0], sourceSha256: SHA }],
    recordWritten: false,
  };
  const { state } = validateCutoverState(partial, rec);
  assert.deepEqual(
    assetsNeedingCopy(identities, state).map((i) => assetIdentityKey(i)),
    ['sample:a-shared00000001'],
    'a shared id must never let one copy satisfy two assets',
  );
  assert.equal(recordIsReady(identities, state), false);
});

test('a genuinely duplicated identity on one record is detected', () => {
  const rec = record({ photos: { assets: [photo('a-photo00000001'), photo('a-photo00000001')] }, samples: [] });
  assert.deepEqual(duplicateIdentityKeys(assetIdentitiesOf(rec)), ['photo:a-photo00000001']);
});

test('a record with a duplicated identity is refused outright', () => {
  const src = migrationSource();
  assert.match(src, /const dupes = duplicateIdentityKeys\(identities\);/);
  assert.match(src, /duplicate_asset_identity/);
  const refuseIdx = src.indexOf('refusing ${record.id}: duplicate asset identity');
  const stateIdx = src.indexOf('raw = await readRawCutoverState');
  assert.ok(refuseIdx > 0 && refuseIdx < stateIdx, 'refuse before touching state');
});

test('duplicated CHECKPOINT entries are counted once, not twice', () => {
  const rec = record();
  const entries = goodState(rec).assetsVerified;
  const doubled = { ...goodState(rec), assetsVerified: [...entries, entries[0]] };
  const { state, reasons } = validateCutoverState(doubled, rec);
  assert.ok(reasons.includes('entry_duplicate'));
  assert.equal(state.assetsVerified.length, 3, 'the repeat is dropped');
});

/* == 10. Crash / resume: tampered state ================================= */

test('checkpoint entries with a bad or missing hash are dropped', () => {
  const rec = record();
  const entries = goodState(rec).assetsVerified;
  for (const badHash of [undefined, '', 'nope', 'A'.repeat(64), SHA.slice(0, 63)]) {
    const tampered = {
      ...goodState(rec),
      assetsVerified: entries.map((v, i) =>
        i === 0 ? { ...v, sourceSha256: badHash } : v,
      ),
    };
    const { state, reasons } = validateCutoverState(tampered, rec);
    assert.ok(reasons.includes('entry_malformed'), `hash ${String(badHash)} must be rejected`);
    assert.equal(state.assetsVerified.length, 2);
    assert.equal(state.completedAt, undefined);
  }
});

test('non-object and structurally wrong entries are dropped', () => {
  const rec = record();
  const tampered = {
    ...goodState(rec),
    assetsVerified: ['a-photo00000001', null, 42, { assetId: 'a-photo00000001' }, { kind: 'photo' }],
  };
  const { state, reasons } = validateCutoverState(tampered, rec);
  assert.ok(reasons.includes('entry_malformed'));
  assert.deepEqual(state.assetsVerified, []);
});

test('entries naming assets that are not on the record are dropped', () => {
  const rec = record();
  const tampered = {
    ...goodState(rec),
    assetsVerified: [
      ...goodState(rec).assetsVerified,
      {
        kind: 'photo',
        assetId: 'a-ghost00000001',
        pathname: 'family-review/photos/fr-x-1234/a-ghost00000001.jpg',
        size: 1,
        mime: 'image/jpeg',
        sourceSha256: SHA2,
      },
    ],
  };
  const { state, reasons } = validateCutoverState(tampered, rec);
  assert.ok(reasons.includes('entry_not_on_record'));
  assert.equal(state.assetsVerified.length, 3, 'only the real assets survive');
});

test('completedAt is revoked when coverage does not revalidate', () => {
  const rec = record();
  // Claims completion while covering only one of three assets.
  const lying = {
    ...goodState(rec),
    assetsVerified: [{ ...assetIdentitiesOf(rec)[0], sourceSha256: SHA }],
  };
  const { state, reasons } = validateCutoverState(lying, rec);
  assert.ok(reasons.includes('completion_revoked'));
  assert.equal(state.completedAt, undefined);
  assert.equal(state.recordWritten, false);
  assert.equal(recordIsReady(assetIdentitiesOf(rec), state), false);
});

test('completedAt is revoked when recordWritten is false', () => {
  const rec = record();
  const { state, reasons } = validateCutoverState(
    { ...goodState(rec), recordWritten: false },
    rec,
  );
  assert.ok(reasons.includes('completion_revoked'));
  assert.equal(state.completedAt, undefined);
});

test('an empty record can never be marked complete', () => {
  const rec = record({ photos: { assets: [] }, samples: [] });
  const { state } = validateCutoverState(
    {
      version: CUTOVER_STATE_VERSION,
      submissionId: rec.id,
      recordFingerprint: computeRecordFingerprint(rec),
      assetsVerified: [],
      recordWritten: true,
      completedAt: 'whenever',
    },
    rec,
  );
  assert.equal(state.completedAt, undefined, 'no assets means nothing was proven');
});

test('completedAt is re-derived, never trusted as written', () => {
  const src = migrationSource();
  const validateBody = src.slice(
    src.indexOf('export function validateCutoverState'),
    src.indexOf('export function assetsNeedingCopy'),
  );
  assert.match(validateBody, /complete && recordWritten/);
  const migrateBody = src.slice(src.indexOf('async function migrateSubmission'));
  const validateIdx = migrateBody.indexOf('validateCutoverState(raw, record)');
  const honourIdx = migrateBody.indexOf('if (state.completedAt)');
  assert.ok(
    validateIdx > 0 && honourIdx > validateIdx,
    'completedAt may only be read from validated state',
  );
});

/* == 11. Fingerprint semantics ========================================== */

test('the fingerprint is deterministic and order-independent', () => {
  const a = record();
  const b = record({ photos: { assets: [photo('a-photo00000002'), photo('a-photo00000001')] } });
  assert.equal(computeRecordFingerprint(a), computeRecordFingerprint(a));
  assert.equal(
    computeRecordFingerprint(a),
    computeRecordFingerprint(b),
    'asset ordering must not change the fingerprint',
  );
});

test('the fingerprint changes on any identity change', () => {
  const base = computeRecordFingerprint(record());
  const variants = [
    record({ id: 'fr-other' }),
    record({ photos: { assets: [photo('a-photo00000001'), photo('a-photo00000003')] } }),
    record({ photos: { assets: [photo('a-photo00000001', { size: 5 }), photo('a-photo00000002')] } }),
    record({ photos: { assets: [photo('a-photo00000001', { mime: 'image/png' }), photo('a-photo00000002')] } }),
    record({
      photos: { assets: [photo('a-photo00000001', { blobPathname: 'elsewhere.jpg' }), photo('a-photo00000002')] },
    }),
    record({ samples: [] }),
  ];
  for (const v of variants) {
    assert.notEqual(computeRecordFingerprint(v), base);
  }
});

test('the fingerprint ignores volatile fields that normal admin work changes', () => {
  const base = computeRecordFingerprint(record());
  const busy = record({
    updatedAt: 'later',
    status: 'feedback_received',
    feedback: { rating: 5 },
  } as never);
  assert.equal(
    computeRecordFingerprint(busy),
    base,
    'a status or feedback change must not throw away a half-finished copy',
  );
});

/* == 12. Metadata switches only after verified persistence =============== */

test('the record is withheld until EVERY asset is verified', () => {
  const rec = record();
  const identities = assetIdentitiesOf(rec);
  const withNone = { assetsVerified: [] };
  const withSome = {
    assetsVerified: identities.slice(0, 2).map((i) => ({ ...i, sourceSha256: SHA })),
  };
  const withAll = { assetsVerified: identities.map((i) => ({ ...i, sourceSha256: SHA })) };
  assert.equal(recordIsReady(identities, withNone), false);
  assert.equal(recordIsReady(identities, withSome), false);
  assert.equal(recordIsReady(identities, withAll), true);
});

test('unrelated verified ids cannot satisfy the gate', () => {
  const rec = record();
  const identities = assetIdentitiesOf(rec);
  const bogus = {
    assetsVerified: [
      { kind: 'photo', assetId: 'a-x', pathname: 'p', size: 1, mime: 'image/jpeg', sourceSha256: SHA },
      { kind: 'photo', assetId: 'a-y', pathname: 'p', size: 1, mime: 'image/jpeg', sourceSha256: SHA },
      { kind: 'photo', assetId: 'a-z', pathname: 'p', size: 1, mime: 'image/jpeg', sourceSha256: SHA },
    ] as never,
  };
  assert.equal(recordIsReady(identities, bogus), false, 'the gate checks THESE assets, not a count');
});

test('the metadata flip points at private storage and drops the public URL', () => {
  const flipped = flipAssetToPrivate(photo('a-photo00000001')) as unknown as Record<string, unknown>;
  assert.equal(flipped.storage, 'private');
  assert.ok(!('blobUrl' in flipped), 'the legacy public URL must not survive');
  assert.equal(flipped.blobPathname, 'family-review/photos/fr-x-1234/a-photo00000001.jpg');
});

test('ordering in source: copy, checkpoint, gate, record, complete', () => {
  const src = migrationSource();
  const copy = src.indexOf('const copied = await copyAssetStreaming');
  const checkpoint = src.indexOf('state.assetsVerified = [');
  const gate = src.indexOf('if (!recordIsReady(');
  const rec = src.indexOf(
    'const writeFailure = await persistDestinationRecordOrFailure',
  );
  const complete = src.indexOf('state.completedAt = new Date().toISOString();');
  assert.ok(
    copy > 0 && checkpoint > copy && gate > checkpoint && rec > gate && complete > rec,
    'copy -> checkpoint -> readiness gate -> record -> completion',
  );
  assert.match(
    src.slice(checkpoint, gate),
    /await persistCutoverStateOrFailure\([\s\S]*?writeCutoverState\(creds, state\)/,
    'each verified asset must be checkpointed immediately through the bounded failure wrapper',
  );
});

test('the checkpoint entry carries the full identity plus the source hash', () => {
  const src = migrationSource();
  assert.match(src, /\{ \.\.\.identity, sourceSha256: copied\.sourceSha256 \}/);
});

test('cutover state is namespaced and written only to the destination', () => {
  assert.match(cutoverStatePath('fr-abc'), /family-review\/cutover\/fr-abc\.json$/);
  for (const args of callArgs(migrationSource(), 'put')) {
    if (args.includes('cutoverStatePath')) {
      assert.match(args, /token:\s*creds\.destToken/);
      assert.match(args, /access:\s*'private'/);
    }
  }
});

/* == 13. Never delete the source ======================================== */

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
    assert.equal(
      destructiveFlag([flag]),
      'destructive_flag',
      `${flag} must be refused without echoing it`,
    );
  }
  assert.equal(destructiveFlag(['--delete\nPRIVATE_CHILD_DATA']), 'destructive_flag');
  assert.equal(destructiveFlag(['--apply', '--limit=3']), null);
});

test('the script neither imports nor calls the Blob delete API', () => {
  const src = migrationSource();
  assert.doesNotMatch(src, /\bdel\s*\(/);
  const importLine = src.match(/import \{[^}]*\} from '@vercel\/blob';/)?.[0] ?? '';
  assert.doesNotMatch(importLine, /\bdel\b/);
  assert.ok(importLine.includes('get') && importLine.includes('put'));
});

/* == 14. Credentials and private URLs never surface ===================== */

test('token-shaped strings are redacted from operator-visible text', () => {
  const leaked = `failed with ${SRC_TOKEN} and Bearer abc.def-123 and ?token=${DST_TOKEN}`;
  const safe = redactTokens(leaked);
  assert.ok(!safe.includes(SRC_TOKEN));
  assert.ok(!safe.includes(DST_TOKEN));
  assert.ok(!safe.includes('abc.def-123'));
  assert.match(safe, /\[redacted/);
});

test('provider and fatal errors collapse to fixed operator-visible codes', () => {
  const src = migrationSource();
  assert.match(
    src,
    /function errorCode\(err: unknown\): string \{\s*void err;\s*return 'provider_error';/,
  );
  assert.match(src, /console\.error\('\[migrate\] fatal: internal_error'\)/);
  assert.doesNotMatch(src, /err instanceof Error \? err\.(?:name|message)/);
});

test('reporting carries opaque ids and store ids only - no tokens, URLs, or PII', () => {
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
  assert.match(src, /creds\.sourceStoreId/);
  assert.match(src, /creds\.destStoreId/);
});

test('no console output interpolates a token or state contents', () => {
  const src = migrationSource();
  for (const line of src.split('\n')) {
    if (!/console\.(log|error|warn)/.test(line)) continue;
    assert.doesNotMatch(
      line,
      /\$\{[^}]*(sourceToken|destToken|assetsVerified|sourceSha256)[^}]*\}/,
      `must not leak credentials or state into output: ${line.trim()}`,
    );
  }
});

/* == 15. Operator confirmation ========================================== */

test('dry run is the default', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.equal(parseArgs(['--limit=5', '--submission=fr-abc-1234']).apply, false);
});

test('malformed or unknown scope arguments fail closed instead of widening a run', () => {
  for (const argv of [
    ['--limit=0'],
    ['--limit=bogus'],
    ['--limit=1.5'],
    ['--limt=1'],
    ['--unknown'],
    ['--target=preview\nPRIVATE_CHILD_DATA'],
    ['--target=../production'],
    ['--limit=1', '--limit=2'],
    ['--submission=fr-a', '--submission=fr-b'],
  ]) {
    assert.throws(() => parseArgs(argv), /argument_(?:invalid|unknown|duplicate)/);
  }
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
  assert.ok(credIdx > 0 && listIdx > credIdx);
  assert.ok(credIdx < applyIdx, 'a dry run must also fail closed on bad credentials');
});

/* == 16. Enumeration stays scoped ======================================= */

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
  assert.match(
    migrationSource(),
    /const plan = buildPersistPlan\(record\);/,
    'reuse the sanitizer so no plaintext review token can reach the destination',
  );
});

/* == 17. Byte-level checkpoint revalidation on resume ==================== */

/** A PNG-headed payload of a given length whose tail encodes `fill`. */
function pngBytes(len: number, fill: number): Uint8Array {
  const out = new Uint8Array(len);
  out.set(PNG_HEAD, 0);
  for (let i = PNG_HEAD.length; i < len; i += 1) out[i] = fill;
  return out;
}

function jpegBytes(len: number, fill: number): Uint8Array {
  const out = new Uint8Array(len);
  out.set(JPEG_HEAD, 0);
  for (let i = JPEG_HEAD.length; i < len; i += 1) out[i] = fill;
  return out;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A reader that serves fixed bytes, recording every pathname asked for. */
function readerOf(
  bytes: Uint8Array | null,
  seen: string[] = [],
): (p: string) => Promise<ReadableStream<Uint8Array> | null> {
  return async (pathname: string) => {
    seen.push(pathname);
    if (bytes === null) return null;
    // Chunked, so the consumer really is streaming.
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 7, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
  };
}

/** A sample asset whose bytes are `payload`, with a truthful checkpoint. */
function boundCase(payload: Uint8Array) {
  const identity = {
    kind: 'photo' as const,
    assetId: 'a-photo00000001',
    pathname: 'family-review/photos/fr-x-1234/a-photo00000001.jpg',
    size: payload.byteLength,
    mime: 'image/png',
  };
  const entry = { ...identity, sourceSha256: sha256Of(payload) };
  return { identity, entry };
}

const PAYLOAD = pngBytes(64, 0x11);
const REPLACEMENT = pngBytes(64, 0x22); // same path, same size, same MIME

async function revalidate(
  over: {
    sourceBytes?: Uint8Array | null;
    destBytes?: Uint8Array | null;
    identity?: Record<string, unknown>;
    entry?: Record<string, unknown>;
    submissionId?: string;
  } = {},
) {
  const base = boundCase(PAYLOAD);
  return revalidateCheckpointedAsset({
    submissionId: over.submissionId ?? 'fr-x-1234',
    identity: { ...base.identity, ...(over.identity ?? {}) } as never,
    entry: { ...base.entry, ...(over.entry ?? {}) } as never,
    readSource: readerOf(
      over.sourceBytes === undefined ? PAYLOAD : over.sourceBytes,
    ),
    readDest: readerOf(over.destBytes === undefined ? PAYLOAD : over.destBytes),
    maxBytes: 1000,
  });
}

test('an honest checkpoint with matching bytes on both sides survives', async () => {
  assert.deepEqual(await revalidate(), { ok: true });
});

test('SOURCE-BYTE REPLACEMENT at the same path, size and MIME is caught', async () => {
  // The case shape validation provably cannot see: identical pathname,
  // identical length, identical sniffed type, different content.
  assert.equal(REPLACEMENT.byteLength, PAYLOAD.byteLength);
  assert.notEqual(sha256Of(REPLACEMENT), sha256Of(PAYLOAD));
  const verdict = await revalidate({ sourceBytes: REPLACEMENT, destBytes: REPLACEMENT });
  assert.deepEqual(verdict, { ok: false, reason: 'source_hash_changed' });
});

test('arbitrary valid-looking hash tampering is caught', async () => {
  // 64 hex characters, passes every shape check, describes nothing.
  const invented = 'd'.repeat(64);
  assert.match(invented, /^[0-9a-f]{64}$/);
  const verdict = await revalidate({ entry: { sourceSha256: invented } });
  assert.deepEqual(verdict, { ok: false, reason: 'source_hash_changed' });
});

test('a missing destination object revokes the checkpoint', async () => {
  assert.deepEqual(await revalidate({ destBytes: null }), {
    ok: false,
    reason: 'dest_missing',
  });
});

test('DESTINATION-BYTE REPLACEMENT is caught', async () => {
  const verdict = await revalidate({ destBytes: REPLACEMENT });
  assert.deepEqual(verdict, { ok: false, reason: 'dest_hash_mismatch' });
});

test('a destination truncated to a different length is caught', async () => {
  const short = pngBytes(32, 0x11);
  const verdict = await revalidate({ destBytes: short });
  assert.deepEqual(verdict, { ok: false, reason: 'dest_size_mismatch' });
});

test('a destination object of a different image type is caught', async () => {
  const jpeg = jpegBytes(64, 0x11);
  const verdict = await revalidate({ destBytes: jpeg });
  assert.deepEqual(verdict, { ok: false, reason: 'dest_type_mismatch' });
});

test('a missing source object revokes the checkpoint', async () => {
  assert.deepEqual(await revalidate({ sourceBytes: null }), {
    ok: false,
    reason: 'source_missing',
  });
});

test('a source that changed type is caught even when its length is unchanged', async () => {
  const jpeg = jpegBytes(64, 0x11);
  const verdict = await revalidate({ sourceBytes: jpeg, destBytes: jpeg });
  assert.deepEqual(verdict, { ok: false, reason: 'source_type_changed' });
});

test('a source whose length no longer matches the record is caught', async () => {
  const longer = pngBytes(96, 0x11);
  const verdict = await revalidate({ sourceBytes: longer, destBytes: longer });
  assert.deepEqual(verdict, { ok: false, reason: 'source_size_changed' });
});

test('revalidation enforces the ceiling on BOTH sides while streaming', async () => {
  const big = pngBytes(4000, 0x11);
  const { identity, entry } = boundCase(big);
  const source = await revalidateCheckpointedAsset({
    submissionId: 'fr-x-1234',
    identity: identity as never,
    entry: entry as never,
    readSource: readerOf(big),
    readDest: readerOf(big),
    maxBytes: 1000,
  });
  assert.deepEqual(source, { ok: false, reason: 'source_too_large' });
});

test('an entry whose pathname belongs to another submission is rejected', async () => {
  // Top-level submissionId edited to match; the entry was spliced in.
  const verdict = await revalidate({
    identity: { pathname: 'family-review/photos/fr-someone-else/a-photo00000001.jpg' },
    entry: { pathname: 'family-review/photos/fr-someone-else/a-photo00000001.jpg' },
  });
  assert.deepEqual(verdict, { ok: false, reason: 'submission_binding_mismatch' });
});

test('a photo pathname under the samples folder is rejected', () => {
  assert.equal(
    pathnameMatchesIdentity(
      'family-review/samples/fr-x-1234/a-asset00000001.jpg',
      'fr-x-1234',
      'photo',
      'a-asset00000001',
    ),
    false,
  );
  assert.equal(
    pathnameMatchesIdentity(
      'family-review/photos/fr-x-1234/a-asset00000001.jpg',
      'fr-x-1234',
      'photo',
      'a-asset00000001',
    ),
    true,
  );
  // A namespaced deployment is bound to its OWN namespace segment: the
  // expected prefix is COMPOSED with withBlobNamespace rather than
  // matched loosely anywhere in the string, so the namespace a run
  // addresses is part of the proof. (Previously this asserted that a
  // `preview/` address satisfied a production run; it must not.)
  assert.equal(
    pathnameMatchesIdentity(
      'preview/family-review/samples/fr-x-1234/a-asset00000001.png',
      'fr-x-1234',
      'sample',
      'a-asset00000001',
      'preview/family-review/samples/fr-x-1234/',
    ),
    true,
  );
  assert.equal(
    pathnameMatchesIdentity(
      'preview/family-review/samples/fr-x-1234/a-asset00000001.png',
      'fr-x-1234',
      'sample',
      'a-asset00000001',
      'family-review/samples/fr-x-1234/',
    ),
    false,
  );
});

test('an entry whose identity drifted from the record is rejected before any read', async () => {
  const seen: string[] = [];
  const verdict = await revalidateCheckpointedAsset({
    submissionId: 'fr-x-1234',
    identity: boundCase(PAYLOAD).identity as never,
    entry: { ...boundCase(PAYLOAD).entry, size: 999 } as never,
    readSource: readerOf(PAYLOAD, seen),
    readDest: readerOf(PAYLOAD, seen),
    maxBytes: 1000,
  });
  assert.deepEqual(verdict, { ok: false, reason: 'identity_mismatch' });
  assert.deepEqual(seen, [], 'no object may be read once identity fails');
});

test('both sides are read through their OWN reader, by pathname', async () => {
  const sourceSeen: string[] = [];
  const destSeen: string[] = [];
  const { identity, entry } = boundCase(PAYLOAD);
  await revalidateCheckpointedAsset({
    submissionId: 'fr-x-1234',
    identity: identity as never,
    entry: entry as never,
    readSource: readerOf(PAYLOAD, sourceSeen),
    readDest: readerOf(PAYLOAD, destSeen),
    maxBytes: 1000,
  });
  assert.deepEqual(sourceSeen, ['family-review/photos/fr-x-1234/a-photo00000001.jpg']);
  assert.deepEqual(destSeen, ['family-review/photos/fr-x-1234/a-photo00000001.jpg']);
});

/* == 18. COMPLETED state with stale bytes ================================ */

function completedRecordCase(sourceBytes: Uint8Array, destBytes: Uint8Array | null) {
  const rec = {
    id: 'fr-x-1234',
    photos: {
      assets: [
        {
          assetId: 'a-photo00000001',
          blobPathname: 'family-review/photos/fr-x-1234/a-photo00000001.jpg',
          storage: 'public',
          mime: 'image/png',
          size: PAYLOAD.byteLength,
          uploadedAt: 'now',
        },
      ],
    },
    samples: [],
  } as never as { id: string; photos: { assets: never[] }; samples: never[] };

  const state = {
    version: CUTOVER_STATE_VERSION,
    submissionId: 'fr-x-1234',
    recordFingerprint: computeRecordFingerprint(rec),
    assetsVerified: [
      { ...assetIdentitiesOf(rec)[0], sourceSha256: sha256Of(PAYLOAD) },
    ],
    recordWritten: true,
    recordUpdatedAt: '2026-08-25T23:59:59.000Z',
    completedAt: '2026-08-26T00:00:00.000Z',
  };

  return {
    rec,
    state,
    run: () =>
      revalidateCheckpoints({
        record: rec,
        state: state as never,
        readSource: readerOf(sourceBytes),
        readDest: readerOf(destBytes),
        maxBytes: 1000,
      }),
  };
}

test('a COMPLETED state passes shape validation but is revoked by stale source bytes', async () => {
  const c = completedRecordCase(REPLACEMENT, REPLACEMENT);

  // Shape validation alone is perfectly happy with this state.
  const shape = validateCutoverState(c.state, c.rec);
  assert.deepEqual(shape.reasons, []);
  assert.equal(shape.state.completedAt, '2026-08-26T00:00:00.000Z');

  // Byte revalidation is not.
  const { state, reasons } = await c.run();
  assert.deepEqual(reasons, ['source_hash_changed']);
  assert.equal(state.completedAt, undefined, 'completion must be revoked');
  assert.equal(state.recordWritten, false, 'the record must be rewritten');
  assert.deepEqual(state.assetsVerified, []);
  assert.equal(
    assetsNeedingCopy(assetIdentitiesOf(c.rec), state).length,
    1,
    'the asset must be recopied',
  );
});

test('a COMPLETED state is revoked when the destination object is gone', async () => {
  const { state, reasons } = await completedRecordCase(PAYLOAD, null).run();
  assert.deepEqual(reasons, ['dest_missing']);
  assert.equal(state.completedAt, undefined);
  assert.equal(state.recordWritten, false);
});

test('a COMPLETED state survives when both sides still match', async () => {
  const { state, reasons } = await completedRecordCase(PAYLOAD, PAYLOAD).run();
  assert.deepEqual(reasons, []);
  assert.equal(state.completedAt, '2026-08-26T00:00:00.000Z');
  assert.equal(state.recordWritten, true);
  assert.equal(state.assetsVerified.length, 1);
});

test('revoking one asset of several withdraws completion for the whole record', () => {
  const rec = record();
  const identities = assetIdentitiesOf(rec);
  const full = goodState(rec);
  const revised = reviseStateAfterRevalidation(
    full as never,
    identities,
    full.assetsVerified.slice(0, 2) as never,
  );
  assert.equal(revised.completedAt, undefined);
  assert.equal(revised.recordWritten, false);
  assert.equal(recordIsReady(identities, revised), false);
});

test('resume revalidates bytes before honouring completedAt', () => {
  const src = migrationSource();
  const body = src.slice(src.indexOf('async function migrateSubmission'));
  const shapeIdx = body.indexOf('validateCutoverState(raw, record)');
  const revalIdx = body.indexOf('await revalidateCheckpoints(');
  const honourIdx = body.indexOf('if (state.completedAt)');
  assert.ok(shapeIdx > 0 && revalIdx > shapeIdx, 'shape validation precedes byte revalidation');
  assert.ok(honourIdx > revalIdx, 'completedAt may only be read after byte revalidation');
  assert.match(body, /const state = revalidated\.state;/);
});

test('revalidation reads each side through its own credential', () => {
  const src = migrationSource();
  const sourceFn = src.slice(
    src.indexOf('function sourceReader('),
    src.indexOf('function destReader('),
  );
  const destFn = src.slice(
    src.indexOf('function destReader('),
    src.indexOf('/* -- Copy + verify -- */'),
  );
  assert.match(sourceFn, /sourceGetOptions\(creds\.sourceToken\)/);
  assert.doesNotMatch(sourceFn, /destToken|destGetOptions/);
  assert.match(destFn, /destGetOptions\(creds\.destToken\)/);
  assert.doesNotMatch(destFn, /sourceToken|sourceGetOptions/);
});

/* == 19. The source stream is released when MIME validation fails ======== */

test('a failed MIME check cancels the source stream instead of leaking it', async () => {
  let cancelled = false;
  let produced = 0;
  const src = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced += 1;
      const chunk = new Uint8Array(8);
      if (produced === 1) chunk.set(PNG_HEAD, 0);
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });

  const metered = await meterAndSniff(src, 1000);
  // Record claims JPEG; the bytes are PNG. copyAssetStreaming cancels here.
  const verdict = verifySourceType(metered.head, 'image/jpeg');
  assert.equal(verdict.ok, false);

  await metered.body.cancel();
  assert.equal(cancelled, true, 'the upstream source must be cancelled');
});

test('the copy path cancels the metered body on a MIME failure before put', () => {
  const src = stripComments(migrationSource());
  const copyBody = src.slice(
    src.indexOf('async function copyAssetStreaming'),
    src.indexOf('async function writeDestinationRecord'),
  );
  const verdictIdx = copyBody.indexOf('if (verdict.ok === false)');
  const putIdx = copyBody.indexOf('await put(');
  assert.ok(verdictIdx > 0 && putIdx > verdictIdx, 'the MIME gate precedes put');
  assert.match(
    copyBody.slice(verdictIdx, putIdx),
    /await metered\.body\.cancel\(\)/,
    'the source stream must be released before returning',
  );
});

/* == 20. SDK compatibility: useCache is private-only ===================== */

/**
 * Preview soak, 2026-08-26: a PUBLIC `get()` carrying `useCache: false`
 * returned HTTP 400; the same object returned 200 once the field was
 * dropped. The SDK documents `useCache` as effective only for private
 * blobs and ignored for public ones, so on the public side it bought
 * nothing and cost the entire read.
 */

test('public-source read options carry NO useCache at all', () => {
  const opts = sourceGetOptions('vercel_blob_rw_SourceStore01_secretsecret');
  assert.equal(opts.access, 'public');
  assert.equal(opts.token, 'vercel_blob_rw_SourceStore01_secretsecret');
  assert.ok(
    !('useCache' in opts),
    'useCache on a public read is rejected by Vercel Blob with HTTP 400',
  );
  assert.deepEqual(
    Object.keys(opts).sort(),
    ['access', 'token'],
    'exact shape pin: a new field here would be a new 400 risk',
  );
});

test('private-destination read options RETAIN useCache: false', () => {
  const opts = destGetOptions('vercel_blob_rw_DestStore99_secretsecret');
  assert.equal(opts.access, 'private');
  assert.equal(opts.token, 'vercel_blob_rw_DestStore99_secretsecret');
  assert.equal(
    opts.useCache,
    false,
    'a private read must bypass the CDN, or a verification read-back could be answered from a stale copy',
  );
  assert.deepEqual(Object.keys(opts).sort(), ['access', 'token', 'useCache']);
});

test('the two builders can never be confused for one another', () => {
  const a = sourceGetOptions('t1');
  const b = destGetOptions('t2');
  assert.notEqual(a.access, b.access, 'access modes must be disjoint');
  assert.equal(a.access, 'public');
  assert.equal(b.access, 'private');
  // The builder fixes the access mode; the CALL SITE supplies the token,
  // so pairing is asserted structurally in the companion test above.
  assert.equal(sourceGetOptions('anything').access, 'public');
  assert.equal(destGetOptions('anything').access, 'private');
});

test('no public read anywhere in the migration passes useCache', () => {
  const src = stripComments(migrationSource());
  for (const args of callArgs(src, 'get')) {
    if (/access:\s*'public'|sourceGetOptions/.test(args)) {
      assert.doesNotMatch(
        args,
        /useCache/,
        `a public read must not carry useCache. Offending: ${args.slice(0, 160)}`,
      );
    }
  }
  // And the builder itself never grows one.
  const builder = src.slice(
    src.indexOf('export function sourceGetOptions'),
    src.indexOf('export function destGetOptions'),
  );
  assert.doesNotMatch(builder, /useCache/);
});

test('every private read still passes useCache: false', () => {
  const src = stripComments(migrationSource());
  const builder = src.slice(
    src.indexOf('export function destGetOptions'),
    src.indexOf('/* -- Args -- */'),
  );
  assert.match(builder, /useCache: false/);
  // No private read may bypass the builder and lose the setting.
  for (const args of callArgs(src, 'get')) {
    if (/access:\s*'private'/.test(args)) {
      assert.match(
        args,
        /useCache:\s*false/,
        `an inline private read must keep useCache:false. Offending: ${args.slice(0, 160)}`,
      );
    }
  }
});

test('every migration read goes through a builder, none inline', () => {
  const src = stripComments(migrationSource());
  const calls = callArgs(src, 'get');
  assert.ok(calls.length >= 6, `expected at least 6 reads, found ${calls.length}`);
  for (const args of calls) {
    assert.match(
      args,
      /(source|dest)GetOptions\(/,
      `inline read options bypass the one place the useCache rule lives: ${args.slice(0, 160)}`,
    );
  }
});

test('the app record read only sends useCache on the private attempt', () => {
  // store.ts reads the record JSON with whichever access mode is
  // configured. Passing useCache on the public attempt was a regression
  // introduced earlier in this branch, and it is exactly the 400 the
  // Preview soak hit - in the lane's DEFAULT (public) mode.
  const store = readFileSync(
    resolve(process.cwd(), 'src/lib/family-review/store.ts'),
    'utf8',
  );
  const fn = store.slice(
    store.indexOf('async function getJsonAtPath'),
    store.indexOf('async function fetchSubmissionByPath'),
  );
  assert.match(
    fn,
    /\.\.\.\(access === 'private' \? \{ useCache: false \} : \{\}\)/,
    'useCache must be conditional on a private read',
  );
  assert.doesNotMatch(
    fn,
    /get\(pathname, \{ access, useCache: false \}\)/,
    'the unconditional form is the regression',
  );
});

/* == 21. First-copy pathname binding ===================================== */

/**
 * The gap these close: exact main proved an asset pathname belonged to
 * its submission only when REVALIDATING an existing checkpoint. A
 * newly-encountered asset -- the first copy, and every asset of every
 * record on a first run -- was copied on the record's say-so, and the
 * dry run reported `would_migrate` without checking an address at all.
 *
 * The binder is now the same function on all three paths (first copy,
 * write site, resume), so a record cannot name an object outside its own
 * submission and asset class and have it read or written.
 */

const PHOTO_PREFIX = 'family-review/photos/fr-x-1234/';
const SAMPLE_PREFIX = 'family-review/samples/fr-x-1234/';

test('these fixtures address the un-namespaced production shape', () => {
  // Every fixture below (and in section 17) is a production address.
  // Assert the assumption once, so a namespaced test environment fails
  // here with a usable message instead of cascading through the suite.
  assert.equal(
    familyReviewAssetPrefix('fr-x-1234', 'photo'),
    PHOTO_PREFIX,
    'run the focused suite with HSB_BLOB_NAMESPACE unset',
  );
  assert.equal(familyReviewAssetPrefix('fr-x-1234', 'sample'), SAMPLE_PREFIX);
});

/* -- positive controls -- */

test('safe-text but noncanonical Family Review identifiers fail closed', async () => {
  const submissionId = 'fr-x-1234';
  assert.throws(
    () => parseArgs(['--submission=child-private-record']),
    /submission_id_unsafe/,
  );
  assert.deepEqual(
    validateSubmissionAddress(
      'family-review/submissions/child-private-record.json',
      'child-private-record',
    ),
    {
      ok: false,
      operatorSubmissionId: 'invalid_submission_id',
      reason: 'submission_id_unsafe',
    },
  );
  assert.equal(
    safeAssetIdForOperatorOutput('child-private-photo'),
    'invalid_asset_id',
  );
  assert.deepEqual(
    bindPathnameToSubmission(
      `family-review/photos/${submissionId}/child-private-photo.jpg`,
      submissionId,
      'photo',
      'child-private-photo',
    ),
    { ok: false, reason: 'asset_id_unsafe' },
  );

  const invalidAssetRecord = {
    id: submissionId,
    photos: {
      assets: [
        {
          assetId: 'child-private-photo',
          blobPathname: `family-review/photos/${submissionId}/child-private-photo.jpg`,
          blobUrl: 'https://example.public.blob.vercel-storage.com/private.jpg',
          storage: 'public',
          mime: 'image/jpeg',
          size: 1000,
          uploadedAt: 'now',
        },
      ],
    },
    samples: [],
  } as never;
  assert.deepEqual(
    await inspectSubmissionForMigration(
      invalidAssetRecord,
      `family-review/submissions/${submissionId}.json`,
    ),
    [
      {
        submissionId,
        assetId: 'invalid_asset_id',
        kind: 'photo',
        result: 'pathname_binding_rejected',
        detail: 'asset_id_unsafe',
      },
    ],
  );
});

test('an exact photo address and an exact sample address bind', () => {
  assert.deepEqual(
    bindPathnameToSubmission(`${PHOTO_PREFIX}a-photo00000001.jpg`, 'fr-x-1234', 'photo', 'a-photo00000001'),
    { ok: true },
  );
  assert.deepEqual(
    bindPathnameToSubmission(`${SAMPLE_PREFIX}a-sample00000001.png`, 'fr-x-1234', 'sample', 'a-sample00000001'),
    { ok: true },
  );
});

test('a safe sibling leaf cannot impersonate another asset id', async () => {
  assert.deepEqual(
    bindPathnameToSubmission(
      `${PHOTO_PREFIX}not-a-photo00000001.jpg`,
      'fr-x-1234',
      'photo',
      'a-photo00000001',
    ),
    { ok: false, reason: 'pathname_leaf_mismatch' },
  );
  const mismatched = record({
    photos: { assets: [photo('a-photo00000001', { blobPathname: `${PHOTO_PREFIX}not-a-photo00000001.jpg` })] },
    samples: [],
  });
  assert.deepEqual(recordPathnameBindingFailures(mismatched as never), [
    { kind: 'photo', assetId: 'a-photo00000001', reason: 'pathname_leaf_mismatch' },
  ]);
  assert.deepEqual(
    await inspectSubmissionForMigration(
      mismatched as never,
      'family-review/submissions/fr-x-1234.json',
    ),
    [
      {
        submissionId: 'fr-x-1234',
        assetId: 'a-photo00000001',
        kind: 'photo',
        result: 'pathname_binding_rejected',
        detail: 'pathname_leaf_mismatch',
      },
    ],
  );
});

test('a namespaced run binds against its own namespace segment', () => {
  assert.deepEqual(
    bindPathnameToSubmission(
      'preview/family-review/photos/fr-x-1234/a-photo00000001.jpg',
      'fr-x-1234',
      'photo',
      'a-photo00000001',
      'preview/family-review/photos/fr-x-1234/',
    ),
    { ok: true },
  );
  // The same object is refused for a run addressing production.
  assert.deepEqual(
    bindPathnameToSubmission(
      'preview/family-review/photos/fr-x-1234/a-photo00000001.jpg',
      'fr-x-1234',
      'photo',
      'a-photo00000001',
      PHOTO_PREFIX,
    ),
    { ok: false, reason: 'pathname_prefix_mismatch' },
  );
});

test('a well-formed record has no binding failures', () => {
  assert.deepEqual(recordPathnameBindingFailures(record()), []);
});

/* -- another submission -- */

test("another valid submission's asset is refused", () => {
  assert.deepEqual(
    bindPathnameToSubmission(
      'family-review/photos/fr-someone-else/a-photo00000001.jpg',
      'fr-x-1234',
      'photo',
    ),
    { ok: false, reason: 'pathname_prefix_mismatch' },
  );
});

/* -- prefix and suffix confusion -- */

test('the submission id used only as a PREFIX is refused', () => {
  for (const other of ['fr-x-1234y', 'fr-x-12342', 'fr-x-1234-old', 'fr-x-1234x']) {
    assert.deepEqual(
      bindPathnameToSubmission(
        `family-review/photos/${other}/a-photo00000001.jpg`,
        'fr-x-1234',
        'photo',
      ),
      { ok: false, reason: 'pathname_prefix_mismatch' },
      other,
    );
  }
});

test('the submission id used only as a SUFFIX is refused', () => {
  for (const other of ['yfr-x-1234', '0fr-x-1234', 'not-fr-x-1234']) {
    assert.deepEqual(
      bindPathnameToSubmission(
        `family-review/photos/${other}/a-photo00000001.jpg`,
        'fr-x-1234',
        'photo',
      ),
      { ok: false, reason: 'pathname_prefix_mismatch' },
      other,
    );
  }
});

/* -- sibling and nested path confusion -- */

test('an address parked under an unrelated top-level folder is refused', () => {
  for (const hostile of [
    `orders/${PHOTO_PREFIX}a-photo00000001.jpg`,
    `backups/${PHOTO_PREFIX}a-photo00000001.jpg`,
    `family-review/photos/fr-y/${PHOTO_PREFIX}a-photo00000001.jpg`,
  ]) {
    assert.deepEqual(
      bindPathnameToSubmission(hostile, 'fr-x-1234', 'photo'),
      { ok: false, reason: 'pathname_prefix_mismatch' },
      hostile,
    );
  }
});

test('a sibling folder that merely starts the same way is refused', () => {
  for (const hostile of [
    'family-review/photos-archive/fr-x-1234/a-photo00000001.jpg',
    'family-reviewX/photos/fr-x-1234/a-photo00000001.jpg',
    'family-review/photo/fr-x-1234/a-photo00000001.jpg',
  ]) {
    assert.deepEqual(
      bindPathnameToSubmission(hostile, 'fr-x-1234', 'photo'),
      { ok: false, reason: 'pathname_prefix_mismatch' },
      hostile,
    );
  }
});

test('an object nested BELOW the submission folder is refused', () => {
  assert.deepEqual(
    bindPathnameToSubmission(`${PHOTO_PREFIX}deeper/a-photo00000001.jpg`, 'fr-x-1234', 'photo'),
    { ok: false, reason: 'pathname_extra_nesting' },
  );
  assert.deepEqual(bindPathnameToSubmission(PHOTO_PREFIX, 'fr-x-1234', 'photo'), {
    ok: false,
    reason: 'pathname_not_normalized',
  });
});

/* -- asset class confusion -- */

test('a photo address presented as a sample, and the reverse, are refused', () => {
  assert.deepEqual(
    bindPathnameToSubmission(`${PHOTO_PREFIX}a-photo00000001.jpg`, 'fr-x-1234', 'sample'),
    { ok: false, reason: 'pathname_prefix_mismatch' },
  );
  assert.deepEqual(
    bindPathnameToSubmission(`${SAMPLE_PREFIX}a-sample00000001.png`, 'fr-x-1234', 'photo'),
    { ok: false, reason: 'pathname_prefix_mismatch' },
  );
});

/* -- encoded and normalized separator forms -- */

test('percent-encoded separators and traversal are refused', () => {
  for (const hostile of [
    'family-review%2Fphotos%2Ffr-x-1234%2Fa-photo00000001.jpg',
    `${PHOTO_PREFIX}%2e%2e%2f%2e%2e%2forders%2fx.jpg`,
    `${PHOTO_PREFIX}..%2Fa-photo00000001.jpg`,
    `${PHOTO_PREFIX}%252e%252e/a-photo00000001.jpg`,
  ]) {
    assert.deepEqual(
      bindPathnameToSubmission(hostile, 'fr-x-1234', 'photo'),
      { ok: false, reason: 'pathname_unsafe_characters' },
      hostile,
    );
  }
});

test('backslash, whitespace, query and non-ASCII separator forms are refused', () => {
  const cases: [string, string][] = [
    ['family-review\\photos\\fr-x-1234\\a-photo00000001.jpg', 'pathname_unsafe_characters'],
    [`${PHOTO_PREFIX}a-photo00000001 .jpg`, 'pathname_unsafe_characters'],
    [`${PHOTO_PREFIX}a-photo00000001.jpg?token=x`, 'pathname_unsafe_characters'],
    [`${PHOTO_PREFIX}a-photo00000001\u0000.jpg`, 'pathname_unsafe_characters'],
    // U+FF0F FULLWIDTH SOLIDUS folds to '/' under NFKC. Hostile
    // characters are written as escapes so this file stays pure
    // ASCII and no editor or transport can re-fold them away.
    [
      'family-review\uFF0Fphotos\uFF0Ffr-x-1234\uFF0Fa-photo00000001.jpg',
      'pathname_not_normalized',
    ],
    // U+2024 ONE DOT LEADER folds to '.' under NFKC.
    [`${PHOTO_PREFIX}\u2024\u2024/a-photo00000001.jpg`, 'pathname_not_normalized'],
  ];
  for (const [hostile, reason] of cases) {
    assert.deepEqual(
      bindPathnameToSubmission(hostile, 'fr-x-1234', 'photo'),
      { ok: false, reason },
      JSON.stringify(hostile),
    );
  }
});

test('dot segments and empty segments are refused', () => {
  for (const hostile of [
    `${PHOTO_PREFIX}../../orders/x.jpg`,
    'family-review/photos/fr-x-1234/./a-photo00000001.jpg',
    'family-review/./photos/fr-x-1234/a-photo00000001.jpg',
    `/${PHOTO_PREFIX}a-photo00000001.jpg`,
    'family-review//photos/fr-x-1234/a-photo00000001.jpg',
    `${PHOTO_PREFIX}a-photo00000001.jpg/`,
  ]) {
    assert.deepEqual(
      bindPathnameToSubmission(hostile, 'fr-x-1234', 'photo'),
      { ok: false, reason: 'pathname_not_normalized' },
      hostile,
    );
  }
});

/* -- malformed input -- */

test('a malformed pathname is refused rather than coerced', () => {
  for (const bad of [undefined, null, '', 0, 42, {}, [], true]) {
    assert.deepEqual(
      bindPathnameToSubmission(bad as never, 'fr-x-1234', 'photo'),
      { ok: false, reason: 'pathname_missing' },
      JSON.stringify(bad ?? null),
    );
  }
  assert.deepEqual(
    bindPathnameToSubmission(
      `${PHOTO_PREFIX}${'a'.repeat(1100)}.jpg`,
      'fr-x-1234',
      'photo',
    ),
    { ok: false, reason: 'pathname_too_long' },
  );
});

test('a full URL is not a pathname', () => {
  assert.deepEqual(
    bindPathnameToSubmission(
      `https://example.public.blob.vercel-storage.com/${PHOTO_PREFIX}a-photo00000001.jpg`,
      'fr-x-1234',
      'photo',
    ),
    { ok: false, reason: 'pathname_unsafe_characters' },
  );
});

test('a malformed submission id refuses every address', () => {
  for (const id of [
    '',
    '..',
    '.',
    '../fr-y',
    'fr x',
    'fr/x',
    'fr%2Fx',
    'a'.repeat(300),
  ]) {
    assert.deepEqual(
      bindPathnameToSubmission(`${PHOTO_PREFIX}a-photo00000001.jpg`, id, 'photo'),
      { ok: false, reason: 'submission_id_unsafe' },
      JSON.stringify(id),
    );
  }
  // The id is checked BEFORE it is composed into an expected prefix, so
  // a traversal id can never build a prefix that then matches.
  assert.deepEqual(
    bindPathnameToSubmission(
      'family-review/photos/../../orders/x.jpg',
      '../../orders',
      'photo',
    ),
    { ok: false, reason: 'submission_id_unsafe' },
  );
});

test('record-address validation redacts malformed ids before operator output', () => {
  for (const hostile of [
    'fr-x-1234\nINJECTED',
    'fr-x-1234\rINJECTED',
    'fr-x-1234\u0000secret',
    'family@example.com',
    '../orders/ord-1',
    '\uFF0Ffamily-review',
  ]) {
    const verdict = validateSubmissionAddress(
      'family-review/submissions/fr-safe.json',
      hostile,
    );
    assert.deepEqual(verdict, {
      ok: false,
      operatorSubmissionId: 'invalid_submission_id',
      reason: 'submission_id_unsafe',
    });
    assert.equal(JSON.stringify(verdict).includes(hostile), false);
  }
});

test('record-address validation derives the address only after id validation', () => {
  assert.deepEqual(
    validateSubmissionAddress(
      'family-review/submissions/fr-x-1234.json',
      'fr-x-1234',
    ),
    { ok: true, operatorSubmissionId: 'fr-x-1234' },
  );
  assert.deepEqual(
    validateSubmissionAddress(
      'family-review/submissions/fr-y.json',
      'fr-x-1234',
    ),
    {
      ok: false,
      operatorSubmissionId: 'fr-x-1234',
      reason: 'record_address_mismatch',
    },
  );
});

test('hostile asset ids collapse to a fixed operator-safe label', () => {
  for (const hostile of [
    'asset\nINJECTED',
    'asset\rINJECTED',
    'asset\u0000secret',
    'family@example.com',
    '../orders/proof.jpg',
    'https://example.com/private.jpg',
    '\uFF0Fasset',
  ]) {
    assert.equal(safeAssetIdForOperatorOutput(hostile), 'invalid_asset_id');
  }
  assert.equal(safeAssetIdForOperatorOutput('a-photo00000001'), 'a-photo00000001');
});

test('record failure outcomes contain only bounded operator-safe identifiers', () => {
  assert.deepEqual(
    recordFailureOutcome(
      'fr-x-1234\nINJECTED',
      'record_unreadable',
      'source_record_unreadable',
    ),
    {
      submissionId: 'invalid_submission_id',
      assetId: 'record',
      kind: 'record',
      result: 'record_unreadable',
      detail: 'source_record_unreadable',
    },
  );
});

test('the real migration boundary refuses an empty record before I/O', async () => {
  const empty = record({ photos: { assets: [] }, samples: [] });
  const outcomes = await inspectSubmissionForMigration(
    empty as never,
    'family-review/submissions/fr-x-1234.json',
  );
  assert.deepEqual(outcomes, [
    {
      submissionId: 'fr-x-1234',
      assetId: 'record',
      kind: 'record',
      result: 'empty_record_rejected',
      detail: 'empty_record_rejected',
    },
  ]);
});

test('a destination record/index failure becomes a bounded failure outcome', async () => {
  let calls = 0;
  const outcome = await persistDestinationRecordOrFailure(record() as never, async () => {
    calls += 1;
    return { ok: false, detail: 'token=should-not-leak' };
  });
  assert.equal(calls, 1);
  assert.deepEqual(outcome, {
    submissionId: 'fr-x-1234',
    assetId: 'record',
    kind: 'record',
    result: 'record_write_failed',
    detail: 'destination_record_write_failed',
  });
});

test('a throwing destination writer becomes the same bounded failure outcome', async () => {
  const outcome = await persistDestinationRecordOrFailure(record() as never, async () => {
    throw new Error('token=should-not-leak');
  });
  assert.deepEqual(outcome, {
    submissionId: 'fr-x-1234',
    assetId: 'record',
    kind: 'record',
    result: 'record_write_failed',
    detail: 'destination_record_write_failed',
  });
});

test('empty records are never ready for destination persistence', () => {
  assert.equal(recordIsReady([], { assetsVerified: [] }), false);
});

test('unsafe narrowed-run submission ids are rejected before path composition', () => {
  for (const hostile of ['../orders', 'fr-x-1234\nINJECTED', 'fr/x', 'fr%2Fx']) {
    assert.throws(
      () => parseArgs([`--submission=${hostile}`]),
      /submission_id_unsafe/,
    );
  }
  assert.equal(parseArgs(['--submission=fr-x-1234']).submissionId, 'fr-x-1234');
});

test('a structurally malformed readable record becomes a bounded refusal', async () => {
  const malformed = record({ photos: null }) as unknown as Parameters<
    typeof inspectSubmissionForMigration
  >[0];
  const outcomes = await inspectSubmissionForMigration(
    malformed,
    'family-review/submissions/fr-x-1234.json',
  );
  assert.deepEqual(outcomes, [
    {
      submissionId: 'fr-x-1234',
      assetId: 'record',
      kind: 'record',
      result: 'record_unreadable',
      detail: 'source_record_malformed',
    },
  ]);
});

test('checkpoint writers return only bounded failure outcomes', async () => {
  const returned = await persistCutoverStateOrFailure('fr-x-1234', 'a-photo00000001', 'photo', async () => false);
  assert.deepEqual(returned, {
    submissionId: 'fr-x-1234',
    assetId: 'a-photo00000001',
    kind: 'photo',
    result: 'checkpoint_write_failed',
    detail: 'cutover_state_write_failed',
  });

  const thrown = await persistCutoverStateOrFailure('fr-x-1234', 'record', 'record', async () => {
    const err = new Error('https://private.example/family-review/photos/fr-x-1234/a-photo00000001.png');
    err.name = 'Injected\nPRIVATE_CHILD_DATA';
    throw err;
  });
  assert.deepEqual(thrown, {
    submissionId: 'fr-x-1234',
    assetId: 'record',
    kind: 'record',
    result: 'checkpoint_write_failed',
    detail: 'cutover_state_write_failed',
  });
});

test('fatal reporting uses a fixed code rather than provider-controlled messages', () => {
  const src = migrationSource();
  assert.match(src, /\[migrate\] fatal: internal_error/);
  assert.doesNotMatch(src, /redactTokens\(err instanceof Error \? err\.message/);
});

test('a narrowed run with no canonical source record fails closed', () => {
  assert.deepEqual(requestedRecordMissingOutcome('fr-x-1234', 0), {
    submissionId: 'fr-x-1234',
    assetId: 'record',
    kind: 'record',
    result: 'record_unreadable',
    detail: 'requested_record_not_found',
  });
  assert.equal(requestedRecordMissingOutcome('fr-x-1234', 1), null);
  assert.equal(requestedRecordMissingOutcome(null, 0), null);
});

test('narrowed runs filter by canonical source pathname, never embedded record id', () => {
  const src = stripComments(migrationSource());
  const loop = src.slice(
    src.indexOf('for (const pathname of pathnames)'),
    src.indexOf('// Aggregate, redacted reporting'),
  );
  assert.match(loop, /pathname\s*!==\s*submissionPath\(args\.submissionId\)/);
  assert.doesNotMatch(loop, /record\.id\s*!==\s*args\.submissionId/);
  assert.match(
    loop,
    /requestedRecordMissingOutcome\(\s*args\.submissionId,\s*recordsSeen,?\s*\)/,
  );
  assert.ok(
    loop.indexOf('pathname !== submissionPath(args.submissionId)') <
      loop.indexOf('readSourceRecord(creds, pathname)'),
  );
});

test('record-level failures become explicit non-success outcomes', () => {
  const src = stripComments(migrationSource());
  assert.match(src, /'record_unreadable'/);
  assert.match(src, /'record_write_failed'/);
  assert.match(src, /'empty_record_rejected'/);
  const success = src.slice(
    src.indexOf('const failures = outcomes.filter'),
    src.indexOf('if (failures.length > 0)'),
  );
  assert.doesNotMatch(success, /record_unreadable|record_write_failed|empty_record_rejected/);
});

/* -- the record-level gate (first copy, no checkpoint) -- */

test('the record gate names the offending asset and its bounded reason', () => {
  const hostile = record({
    photos: {
      assets: [
        photo('a-photo00000001'),
        photo('a-photo00000002', {
          blobPathname: 'family-review/photos/fr-someone-else/a-photo00000002.jpg',
        }),
      ],
    },
  });
  assert.deepEqual(recordPathnameBindingFailures(hostile), [
    { kind: 'photo', assetId: 'a-photo00000002', reason: 'pathname_prefix_mismatch' },
  ]);
});

test('the record gate covers samples, not just photos', () => {
  const hostile = record({
    samples: [sample('a-sample00000001', { blobPathname: `${PHOTO_PREFIX}a-sample00000001.png` })],
  });
  assert.deepEqual(recordPathnameBindingFailures(hostile), [
    { kind: 'sample', assetId: 'a-sample00000001', reason: 'pathname_prefix_mismatch' },
  ]);
});

test('a record pointing at a non-Family-Review object is refused', () => {
  const hostile = record({
    photos: {
      assets: [photo('a-photo00000001', { blobPathname: 'orders/ord-1/proof.jpg' })],
    },
    samples: [],
  });
  assert.deepEqual(recordPathnameBindingFailures(hostile), [
    { kind: 'photo', assetId: 'a-photo00000001', reason: 'pathname_prefix_mismatch' },
  ]);
});

test('binding failures redact hostile asset identifiers', () => {
  const hostile = record({
    photos: {
      assets: [
        photo('asset\nINJECTED', {
          blobPathname: `${PHOTO_PREFIX}safe.jpg`,
        }),
      ],
    },
    samples: [],
  });
  assert.deepEqual(recordPathnameBindingFailures(hostile), [
    { kind: 'photo', assetId: 'invalid_asset_id', reason: 'asset_id_unsafe' },
  ]);
});

test('binding failures carry no pathname, filename or URL', () => {
  const hostile = record({
    photos: {
      assets: [
        photo('a-photo00000001', {
          blobPathname: 'orders/ord-secret/child-name-photo.jpg',
        }),
      ],
    },
    samples: [],
  });
  const serialized = JSON.stringify(recordPathnameBindingFailures(hostile));
  for (const leak of ['orders', 'ord-secret', 'child-name', '.jpg', 'http']) {
    assert.ok(!serialized.includes(leak), `${leak} must not surface`);
  }
});

/* -- the resume path uses the same binder -- */

/** Revalidate a checkpoint whose live pathname is `pathname`. */
async function revalidateAtPathname(pathname: string) {
  const seen: string[] = [];
  const base = boundCase(PAYLOAD);
  const verdict = await revalidateCheckpointedAsset({
    submissionId: 'fr-x-1234',
    identity: { ...base.identity, pathname } as never,
    entry: { ...base.entry, pathname } as never,
    readSource: readerOf(PAYLOAD, seen),
    readDest: readerOf(PAYLOAD, seen),
    maxBytes: 1000,
  });
  return { verdict, seen };
}

test('a checkpoint with a hostile asset id is refused before any read', async () => {
  const seen: string[] = [];
  const base = boundCase(PAYLOAD);
  const identity = { ...base.identity, assetId: 'asset\nINJECTED' } as never;
  const entry = { ...base.entry, assetId: 'asset\nINJECTED' } as never;
  const verdict = await revalidateCheckpointedAsset({
    submissionId: 'fr-x-1234',
    identity,
    entry,
    readSource: readerOf(PAYLOAD, seen),
    readDest: readerOf(PAYLOAD, seen),
    maxBytes: 1000,
  });
  assert.deepEqual(verdict, {
    ok: false,
    reason: 'submission_binding_mismatch',
  });
  assert.deepEqual(seen, []);
});

test('a checkpoint whose live source address left the submission is refused before any read', async () => {
  const { verdict, seen } = await revalidateAtPathname(
    'family-review/photos/fr-x-1234-old/a-photo00000001.jpg',
  );
  assert.deepEqual(verdict, {
    ok: false,
    reason: 'submission_binding_mismatch',
  });
  assert.deepEqual(seen, [], 'no object may be read once the binding fails');
});

test('a checkpoint whose live source address changed asset class is refused', async () => {
  const { verdict, seen } = await revalidateAtPathname(
    `${SAMPLE_PREFIX}a-photo00000001.jpg`,
  );
  assert.deepEqual(verdict, {
    ok: false,
    reason: 'submission_binding_mismatch',
  });
  assert.deepEqual(seen, []);
});

test('a checkpoint whose live source address is encoded is refused', async () => {
  const { verdict, seen } = await revalidateAtPathname(
    `${PHOTO_PREFIX}..%2F..%2Forders%2Fx.jpg`,
  );
  assert.deepEqual(verdict, {
    ok: false,
    reason: 'submission_binding_mismatch',
  });
  assert.deepEqual(seen, []);
});

test('a checkpoint nested below the submission folder is refused', async () => {
  const { verdict, seen } = await revalidateAtPathname(
    `${PHOTO_PREFIX}deeper/a-photo00000001.jpg`,
  );
  assert.deepEqual(verdict, {
    ok: false,
    reason: 'submission_binding_mismatch',
  });
  assert.deepEqual(seen, []);
});

/* -- wiring: the gate cannot be routed around -- */

test('the module exports no apply-capable migration boundary', async () => {
  const mod = await import('../scripts/family-review-migrate-assets.ts');
  assert.equal('migrateSubmission' in mod, false);
  assert.equal(typeof mod.inspectSubmissionForMigration, 'function');
  const src = stripComments(migrationSource());
  assert.doesNotMatch(src, /export\s+async\s+function\s+migrateSubmission/);
  assert.match(
    src,
    /export async function inspectSubmissionForMigration[\s\S]*?migrateSubmission\([\s\S]*?false,/,
  );
});

test('the binding gate runs before the dry-run branch and before any copy', () => {
  const src = stripComments(migrationSource());
  const start = src.indexOf('async function migrateSubmission(');
  assert.ok(start > 0);
  const fn = src.slice(start);
  const address = fn.indexOf(
    'validateSubmissionAddress(sourcePathname, record.id)',
  );
  const empty = fn.indexOf('if (identities.length === 0)');
  const gate = fn.indexOf('recordPathnameBindingFailures(record)');
  const dry = fn.indexOf('if (!apply)');
  const state = fn.indexOf('readRawCutoverState(');
  const copy = fn.indexOf('copyAssetStreaming(');

  assert.ok(address > 0, 'the record id/address validator must run first');
  assert.ok(empty > address && gate > empty, 'empty records fail before asset binding');
  assert.ok(gate > 0 && dry > gate, 'a dry run must run the SAME binding gate');
  assert.ok(state > gate, 'no checkpoint is read for an unbound record');
  assert.ok(copy > gate, 'no asset is copied for an unbound record');
});

test('no source byte is read and no destination object written before the binding check', () => {
  const src = stripComments(migrationSource());
  const start = src.indexOf('async function copyAssetStreaming(');
  const end = src.indexOf('async function writeDestinationRecord(');
  assert.ok(start > 0 && end > start);
  const fn = src.slice(start, end);

  const bind = fn.indexOf('bindPathnameToSubmission(');
  const read = fn.indexOf('await get(');
  const write = fn.indexOf('await put(');
  assert.ok(bind > 0, 'the copy path must bind the pathname itself');
  assert.ok(read > bind, 'the binding check precedes the source read');
  assert.ok(write > bind, 'the binding check precedes the destination put');
});

test('the copy path is called with the record id it must bind against', () => {
  // The declaration's own parameter list is skipped; only call sites.
  const calls = callArgs(migrationSource(), 'copyAssetStreaming').filter(
    (a) => !a.includes('Credentials'),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /creds,\s*record\.id,\s*identity/);
});

test('a rejected binding is not a success class', () => {
  const src = stripComments(migrationSource());
  const idx = src.indexOf(
    "['would_migrate', 'migrated', 'already_verified']",
  );
  assert.ok(idx > 0, 'the success allow-list must still be an allow-list');
  assert.match(src, /'pathname_binding_rejected'/);
  assert.ok(
    !src
      .slice(idx, idx + 60)
      .includes('pathname_binding_rejected'),
    'a binding rejection must make the run exit non-zero',
  );
});

/* -- bounded state, input, output, and completed-resume controls -- */

test('checkpoint JSON stream is rejected before buffering beyond the byte ceiling', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_CUTOVER_JSON_BYTES));
      controller.enqueue(new Uint8Array([0x20]));
    },
  });
  await assert.rejects(
    parseBoundedJsonStream(stream, MAX_CUTOVER_JSON_BYTES),
    /json_too_large/,
  );
});

test('checkpoint completion marker must be one canonical ISO instant', () => {
  const rec = record();
  for (const completedAt of ['not-a-date', 'line\nbreak', 'x'.repeat(10_000)]) {
    const verdict = validateCutoverState(goodState(rec, { completedAt }), rec);
    assert.equal(verdict.state.completedAt, undefined);
  }
  assert.equal(
    validateCutoverState(goodState(rec), rec).state.completedAt,
    '2026-08-26T00:00:00.000Z',
  );
});

test('checkpoint identity and reason collections have hard ceilings', () => {
  const rec = record();
  const oversized = goodState(rec, {
    assetsVerified: Array.from({ length: MAX_ASSETS_PER_RECORD + 1 }, () => ({
      ...assetIdentitiesOf(rec)[0],
      sourceSha256: SHA,
    })),
  });
  const verdict = validateCutoverState(oversized, rec);
  assert.deepEqual(verdict.reasons, ['state_too_large']);
  assert.ok(verdict.reasons.length <= MAX_STATE_REASONS);
  assert.equal(verdict.state.assetsVerified.length, 0);
});

test('record-controlled asset cardinality is refused as one bounded outcome', async () => {
  const oversizedRecord = record({
    photos: {
      assets: Array.from({ length: MAX_ASSETS_PER_RECORD + 1 }, (_, index) =>
        photo(`a-overflow${String(index).padStart(12, '0')}`),
      ),
    },
    samples: [],
  });
  const outcomes = await inspectSubmissionForMigration(
    oversizedRecord as never,
    `family-review/submissions/${oversizedRecord.id}.json`,
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].result, 'record_unreadable');
  assert.equal(outcomes[0].detail, 'source_record_malformed');
});

test('completed resume record proof requires the exact canonical persisted record', () => {
  const source = record({
    reviewTokenHash: 'a'.repeat(64),
    status: 'pending_review',
    updatedAt: '2026-08-20T00:00:00.000Z',
    parent: { name: 'Parent', email: 'owner@example.test' },
    child: { firstName: 'Hero' },
  });
  const destination = record({
    reviewTokenHash: 'a'.repeat(64),
    status: 'pending_review',
    updatedAt: '2026-08-25T23:59:59.000Z',
    parent: { name: 'Parent', email: 'owner@example.test' },
    child: { firstName: 'Hero' },
    photos: {
      assets: source.photos.assets.map((asset) => flipAssetToPrivate(asset)),
    },
    samples: source.samples.map((asset) => flipAssetToPrivate(asset)),
  });
  assert.equal(
    destinationRecordMatchesSource(
      destination as never,
      source as never,
      '2026-08-25T23:59:59.000Z',
    ),
    true,
  );

  for (const contradictory of [
    { ...destination, status: 'approved' },
    { ...destination, parent: { name: 'Parent', email: 'wrong@example.test' } },
    { ...destination, reviewTokenHash: 'b'.repeat(64) },
    (() => {
      const { child: _missing, ...rest } = destination as typeof destination & {
        child?: unknown;
      };
      return rest;
    })(),
    {
      ...destination,
      photos: {
        assets: destination.photos.assets.map((asset, index) =>
          index === 0
            ? { ...(asset as Record<string, unknown>), blobUrl: 'https://public.invalid/x' }
            : asset,
        ),
      },
    },
  ]) {
    assert.equal(
      destinationRecordMatchesSource(
        contradictory as never,
        source as never,
        '2026-08-25T23:59:59.000Z',
      ),
      false,
    );
  }
});

test('unknown or malformed checkpoint schemas require apply refusal', () => {
  const rec = record();
  for (const raw of [
    'not-an-object',
    { ...goodState(rec), version: 999 },
    { ...goodState(rec), submissionId: 'fr-other-1234' },
    { ...goodState(rec), recordFingerprint: 123 },
    { ...goodState(rec), assetsVerified: [{ bad: true }] },
    {
      ...goodState(rec),
      assetsVerified: goodState(rec).assetsVerified.map((entry, index) =>
        index === 0 ? { ...entry, unexpected: true } : entry,
      ),
    },
    { ...goodState(rec), completedAt: 'not-a-date' },
    { ...goodState(rec), completedAt: '' },
    { ...goodState(rec), completedAt: false },
    { ...goodState(rec), recordUpdatedAt: 'not-a-date' },
    (() => {
      const { completedAt: _completed, ...partial } = goodState(rec);
      return {
        ...partial,
        recordWritten: false,
        recordUpdatedAt: '2026-08-25T23:59:59.000Z',
      };
    })(),
    (() => {
      const { recordWritten: _missing, ...rest } = goodState(rec);
      return rest;
    })(),
    { ...goodState(rec), recordWritten: 'true' },
    { ...goodState(rec), unexpected: true },
    { ...goodState(rec), assetsVerified: Array(MAX_ASSETS_PER_RECORD + 1).fill({}) },
  ]) {
    const verdict = validateCutoverState(raw, rec);
    assert.equal(checkpointStateRequiresRefusal(verdict.reasons), true);
  }
  assert.equal(
    checkpointStateRequiresRefusal(validateCutoverState(null, rec).reasons),
    false,
  );
  const changedFingerprint = 'f'.repeat(64);
  for (const raw of [
    { ...goodState(rec), recordFingerprint: changedFingerprint, completedAt: false },
    { ...goodState(rec), recordFingerprint: changedFingerprint, assetsVerified: [null] },
    { ...goodState(rec), recordFingerprint: changedFingerprint, assetsVerified: false },
    { ...goodState(rec), recordFingerprint: changedFingerprint, recordUpdatedAt: false },
    {
      ...goodState(rec),
      recordFingerprint: changedFingerprint,
      assetsVerified: goodState(rec).assetsVerified.map((entry, index) =>
        index === 0 ? { ...entry, mime: 'text/plain' } : entry,
      ),
    },
    {
      ...goodState(rec),
      recordFingerprint: changedFingerprint,
      assetsVerified: goodState(rec).assetsVerified.map((entry, index) =>
        index === 0 ? { ...entry, unexpected: true } : entry,
      ),
    },
  ]) {
    const verdict = validateCutoverState(raw, rec);
    assert.equal(checkpointStateRequiresRefusal(verdict.reasons), true);
  }

  const changed = record({
    photos: { assets: [photo('a-photo00000001')] },
    samples: [],
  });
  assert.deepEqual(validateCutoverState(goodState(rec), changed).reasons, [
    'record_changed',
  ]);
  assert.equal(
    checkpointStateRequiresRefusal(
      validateCutoverState(goodState(rec), changed).reasons,
    ),
    false,
  );
});

test('apply path distinguishes checkpoint read failure and verifies completed persistence', () => {
  const src = stripComments(migrationSource());
  const start = src.indexOf('async function migrateSubmission(');
  const fn = src.slice(start);
  const read = fn.indexOf('readRawCutoverState(');
  const checkpointFailure = fn.indexOf("'checkpoint_read_failed'");
  const stateRefusal = fn.indexOf('checkpointStateRequiresRefusal(shape.reasons)');
  const completed = fn.indexOf('if (state.completedAt)');
  const verify = fn.indexOf('verifyDestinationPersistence(');
  const alreadyVerified = fn.indexOf("result: 'already_verified'");
  assert.ok(read > 0 && checkpointFailure > read);
  assert.ok(stateRefusal > checkpointFailure && completed > stateRefusal);
  assert.ok(verify > completed);
  assert.ok(alreadyVerified > verify);
});
