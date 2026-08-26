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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyAuthorizationProblems,
  assetIdentitiesOf,
  assetIdentityKey,
  assetsNeedingCopy,
  blobStoreIdFromToken,
  collectPathnames,
  computeRecordFingerprint,
  credentialProblems,
  cutoverStatePath,
  destructiveFlag,
  digestStream,
  duplicateIdentityKeys,
  EnumerationTruncatedError,
  flipAssetToPrivate,
  MAX_ASSET_BYTES,
  meterAndSniff,
  parseArgs,
  recordIsReady,
  redactTokens,
  validateCutoverState,
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
    blobPathname: `family-review/photos/fr-x/${assetId}.jpg`,
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
    blobPathname: `family-review/samples/fr-x/${assetId}.png`,
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
    id: 'fr-x',
    photos: { assets: [photo('a-p1'), photo('a-p2')] },
    samples: [sample('a-s1')],
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
      assert.match(
        args,
        /token:\s*creds\.(sourceToken|destToken)/,
        `every ${fn}() must pass an explicit store token. Offending: ${args.slice(0, 160)}`,
      );
    }
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

test('a record whose recorded mime contradicts its bytes is refused', async () => {
  const { verifySourceType } = await import(
    '../scripts/family-review-migrate-assets.ts'
  );
  const png = bytesOf(PNG_HEAD, 16);
  const verdict = verifySourceType(png, 'image/jpeg');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.result, 'content_type_mismatch');
  assert.match(
    verdict.ok === false ? verdict.detail : '',
    /record says image\/jpeg, bytes are image\/png/,
  );
});

test('bytes that are not a supported image are refused, whatever the record says', async () => {
  const { verifySourceType } = await import(
    '../scripts/family-review-migrate-assets.ts'
  );
  const html = new TextEncoder().encode('<!DOCTYPE html><scr');
  for (const claimed of ['image/png', 'image/jpeg', 'image/webp']) {
    const verdict = verifySourceType(html.slice(0, 16), claimed);
    assert.equal(verdict.ok, false, `claimed ${claimed} must not rescue HTML bytes`);
    assert.equal(verdict.ok === false && verdict.result, 'source_type_unrecognized');
  }
});

test('an agreeing record passes, and equivalent spellings are not spoofs', async () => {
  const { verifySourceType } = await import(
    '../scripts/family-review-migrate-assets.ts'
  );
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

test('hasMore with no cursor ends the scan rather than looping or throwing', async () => {
  const pager = async () => ({
    blobs: [{ pathname: 'only' }],
    hasMore: true,
    cursor: undefined,
  });
  assert.deepEqual(await collectPathnames(pager, 40), ['only']);
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
    ['photo:a-p1', 'photo:a-p2', 'sample:a-s1'],
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
  const after = record({ photos: { assets: [photo('a-p1', { size: 9999 }), photo('a-p2')] } });
  const { state, reasons } = validateCutoverState(stateBefore, after);
  // The fingerprint covers size, so the whole checkpoint is invalidated.
  assert.deepEqual(reasons, ['record_changed']);
  assert.ok(
    assetsNeedingCopy(assetIdentitiesOf(after), state).some(
      (i) => i.assetId === 'a-p1',
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
      i === 0 ? { ...v, pathname: 'family-review/photos/fr-x/somewhere-else.jpg' } : v,
    ),
  };
  const { state, reasons } = validateCutoverState(tampered, rec);
  assert.ok(reasons.includes('entry_identity_mismatch'));
  assert.equal(state.assetsVerified.length, 2, 'the drifted entry is dropped');
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
    ['photo:a-p2', 'sample:a-s1'],
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
    photos: { assets: [photo('a-dup')] },
    samples: [sample('a-dup')],
  });
  const identities = assetIdentitiesOf(rec);
  assert.deepEqual(
    identities.map((i) => assetIdentityKey(i)),
    ['photo:a-dup', 'sample:a-dup'],
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
    ['sample:a-dup'],
    'a shared id must never let one copy satisfy two assets',
  );
  assert.equal(recordIsReady(identities, state), false);
});

test('a genuinely duplicated identity on one record is detected', () => {
  const rec = record({ photos: { assets: [photo('a-p1'), photo('a-p1')] }, samples: [] });
  assert.deepEqual(duplicateIdentityKeys(assetIdentitiesOf(rec)), ['photo:a-p1']);
});

test('a record with a duplicated identity is refused outright', () => {
  const src = migrationSource();
  assert.match(src, /const dupes = duplicateIdentityKeys\(identities\);/);
  assert.match(src, /duplicate_asset_identity/);
  const refuseIdx = src.indexOf('refusing ${record.id}: duplicate asset identity');
  const stateIdx = src.indexOf('const raw = await readRawCutoverState');
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
    assetsVerified: ['a-p1', null, 42, { assetId: 'a-p1' }, { kind: 'photo' }],
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
        assetId: 'a-ghost',
        pathname: 'family-review/photos/fr-x/a-ghost.jpg',
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
  const b = record({ photos: { assets: [photo('a-p2'), photo('a-p1')] } });
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
    record({ photos: { assets: [photo('a-p1'), photo('a-p3')] } }),
    record({ photos: { assets: [photo('a-p1', { size: 5 }), photo('a-p2')] } }),
    record({ photos: { assets: [photo('a-p1', { mime: 'image/png' }), photo('a-p2')] } }),
    record({
      photos: { assets: [photo('a-p1', { blobPathname: 'elsewhere.jpg' }), photo('a-p2')] },
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
  const flipped = flipAssetToPrivate(photo('a-p1')) as unknown as Record<string, unknown>;
  assert.equal(flipped.storage, 'private');
  assert.ok(!('blobUrl' in flipped), 'the legacy public URL must not survive');
  assert.equal(flipped.blobPathname, 'family-review/photos/fr-x/a-p1.jpg');
});

test('ordering in source: copy, checkpoint, gate, record, complete', () => {
  const src = migrationSource();
  const copy = src.indexOf('const copied = await copyAssetStreaming');
  const checkpoint = src.indexOf('state.assetsVerified = [');
  const gate = src.indexOf('if (!recordIsReady(');
  const rec = src.indexOf('const written = await writeDestinationRecord');
  const complete = src.indexOf('state.completedAt = new Date().toISOString();');
  assert.ok(
    copy > 0 && checkpoint > copy && gate > checkpoint && rec > gate && complete > rec,
    'copy -> checkpoint -> readiness gate -> record -> completion',
  );
  assert.match(
    src.slice(checkpoint, gate),
    /await writeCutoverState\(creds, state\);/,
    'each verified asset must be checkpointed immediately',
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
    assert.equal(destructiveFlag([flag]), flag, `${flag} must be refused`);
  }
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

test('errors reaching the console go through redaction', () => {
  const src = migrationSource();
  assert.match(src, /function errorCode\(err: unknown\): string \{\s*return redactTokens\(/);
  assert.match(src, /console\.error\(\s*'\[migrate\] fatal:',\s*redactTokens\(/);
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
