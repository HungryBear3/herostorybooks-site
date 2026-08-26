/**
 * Migrate legacy PUBLIC Family Review assets to PRIVATE storage.
 *
 * DRY RUN IS THE DEFAULT. The script reports what it would do and exits.
 * Writing anything requires THREE independent, matching confirmations
 * (see requireApplyAuthorization) so no single flag, typo, or stray env
 * var can mutate a store — least of all Production.
 *
 * What it does, per asset:
 *
 *   1. enumerate  — ONLY records under {ns}/family-review/submissions/.
 *                   Asset pathnames come from inside each record. No
 *                   prefix is ever globbed or inferred.
 *   2. skip       — anything already storage:'private' (idempotency).
 *   3. copy       — write the SAME pathname with access:'private'.
 *                   The source object is NEVER deleted here.
 *   4. verify     — size, content type, and sha256 of the bytes read
 *                   BACK out of private storage must match the source.
 *   5. record     — only after verification passes, flip the asset to
 *                   storage:'private', drop blobUrl, persist.
 *
 * SOURCE DELETION IS NOT IMPLEMENTED. Reclaiming the old public objects
 * is a separate, separately-authorized operation. Any flag that looks
 * like a deletion request is a hard error.
 *
 * Usage:
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts --submission=fr-xxxx
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts --limit=25
 *
 * To actually write (all three required, and they must agree):
 *   --apply
 *   --target=<namespace>                     ('production' for the prod store)
 *   FAMILY_REVIEW_MIGRATION_CONFIRM=i-am-migrating-<namespace>
 */

import { createHash } from 'node:crypto';

import { get, list, put } from '@vercel/blob';

import { getBlobNamespace, withBlobNamespace } from '../src/lib/orders.ts';
import {
  normalizeSubmissionRecord,
  persistSubmission,
  type FamilyReviewSubmission,
  type PhotoAsset,
  type SampleAsset,
} from '../src/lib/family-review/store.ts';

const LIST_PAGE_SIZE = 250;
const MAX_LIST_PAGES = 40;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

type AnyAsset = PhotoAsset | SampleAsset;

type CopyResult =
  | { ok: true; result?: undefined; detail?: undefined }
  | { ok: false; result: AssetOutcome['result']; detail?: string };

interface AssetOutcome {
  submissionId: string;
  assetId: string;
  kind: 'photo' | 'sample';
  result:
    | 'would_migrate'
    | 'migrated'
    | 'already_private'
    | 'no_source_url'
    | 'source_read_failed'
    | 'too_large'
    | 'write_failed'
    | 'verify_failed';
  detail?: string;
}

/** The store this process would actually touch. */
function resolveTarget(): string {
  return getBlobNamespace() || 'production';
}

/**
 * Any flag that looks like a deletion request. Source deletion is a
 * separate, separately-authorized operation and is not implemented
 * here, so such a flag is refused rather than ignored.
 */
export function destructiveFlag(argv: string[]): string | null {
  return argv.find((arg) => /^--(delete|purge|remove|drop)/i.test(arg)) ?? null;
}

export function parseArgs(argv: string[]): {
  apply: boolean;
  target: string | null;
  submissionId: string | null;
  limit: number | null;
} {
  let apply = false;
  let target: string | null = null;
  let submissionId: string | null = null;
  let limit: number | null = null;

  for (const arg of argv) {
    if (arg === '--apply') apply = true;
    else if (arg.startsWith('--target=')) target = arg.slice('--target='.length);
    else if (arg.startsWith('--submission=')) {
      submissionId = arg.slice('--submission='.length);
    } else if (arg.startsWith('--limit=')) {
      const n = Number(arg.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) limit = Math.floor(n);
    }
  }
  return { apply, target, submissionId, limit };
}

/**
 * Three independent confirmations, all of which must name the SAME
 * target. Returns the list of unmet ones — empty means authorized.
 *
 * Pure so it is directly testable: nothing here exits or writes.
 */
export function applyAuthorizationProblems(
  target: string,
  args: { apply: boolean; target: string | null },
  confirm: string | undefined,
): string[] {
  const expected = `i-am-migrating-${target}`;
  const problems: string[] = [];

  if (!args.apply) problems.push('missing --apply');
  if (args.target === null) problems.push('missing --target=<namespace>');
  else if (args.target !== target) {
    problems.push(
      `--target=${args.target} does not match the resolved store '${target}'`,
    );
  }
  if ((confirm ?? '') !== expected) {
    problems.push(
      `FAMILY_REVIEW_MIGRATION_CONFIRM must be exactly '${expected}'`,
    );
  }
  return problems;
}

function requireApplyAuthorization(
  target: string,
  args: { apply: boolean; target: string | null },
): void {
  const problems = applyAuthorizationProblems(
    target,
    args,
    process.env.FAMILY_REVIEW_MIGRATION_CONFIRM,
  );
  if (problems.length > 0) {
    console.error('\nREFUSING TO WRITE. Unmet confirmations:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nAll three must be present and agree on the same target.\n' +
        'Re-run without --apply for a dry run.\n',
    );
    process.exit(3);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every submission record under the Family Review prefix. Bounded. */
async function listSubmissionPathnames(): Promise<string[]> {
  const prefix = withBlobNamespace('family-review/submissions/');
  const pathnames: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await list({ prefix, limit: LIST_PAGE_SIZE, cursor });
    for (const blob of res.blobs) pathnames.push(blob.pathname);
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  return pathnames;
}

async function readRecord(pathname: string): Promise<FamilyReviewSubmission | null> {
  for (const access of ['public', 'private'] as const) {
    try {
      const result = await get(pathname, { access, useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) continue;
      const text = await new Response(result.stream).text();
      return normalizeSubmissionRecord(JSON.parse(text));
    } catch {
      // try the other access mode
    }
  }
  return null;
}

/** Read the legacy public bytes for one asset. */
async function readSourceBytes(
  asset: AnyAsset,
): Promise<{ bytes: Uint8Array } | { error: AssetOutcome['result'] }> {
  if (!asset.blobUrl) return { error: 'no_source_url' };
  let res: Response;
  try {
    res = await fetch(asset.blobUrl, { cache: 'no-store' });
  } catch {
    return { error: 'source_read_failed' };
  }
  if (!res.ok) return { error: 'source_read_failed' };
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_ASSET_BYTES) return { error: 'too_large' };
  return { bytes: buf };
}

/**
 * Copy one asset to private storage and verify it byte-for-byte by
 * reading it BACK. Returns the verified asset patch, or an error.
 */
async function copyAndVerify(
  asset: AnyAsset,
  bytes: Uint8Array,
): Promise<CopyResult> {
  const sourceHash = sha256(bytes);

  try {
    await put(asset.blobPathname, Buffer.from(bytes), {
      access: 'private',
      addRandomSuffix: false,
      contentType: asset.mime,
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
  } catch (err) {
    return {
      ok: false,
      result: 'write_failed',
      detail: err instanceof Error ? err.name : 'unknown',
    };
  }

  // Verify by reading the object back out of PRIVATE storage.
  let readBack: Awaited<ReturnType<typeof get>>;
  try {
    readBack = await get(asset.blobPathname, {
      access: 'private',
      useCache: false,
    });
  } catch (err) {
    return {
      ok: false,
      result: 'verify_failed',
      detail: err instanceof Error ? err.name : 'unknown',
    };
  }
  if (!readBack || readBack.statusCode !== 200 || !readBack.stream) {
    return { ok: false, result: 'verify_failed', detail: 'not_readable' };
  }
  if (readBack.blob.contentType !== asset.mime) {
    return { ok: false, result: 'verify_failed', detail: 'content_type_mismatch' };
  }
  if (readBack.blob.size !== bytes.byteLength) {
    return { ok: false, result: 'verify_failed', detail: 'size_mismatch' };
  }
  const roundTripped = new Uint8Array(
    await new Response(readBack.stream).arrayBuffer(),
  );
  if (sha256(roundTripped) !== sourceHash) {
    return { ok: false, result: 'verify_failed', detail: 'hash_mismatch' };
  }
  return { ok: true };
}

async function migrateSubmission(
  record: FamilyReviewSubmission,
  apply: boolean,
): Promise<AssetOutcome[]> {
  const outcomes: AssetOutcome[] = [];
  const photos = [...record.photos.assets];
  const samples = [...record.samples];
  let changed = false;

  const process_ = async (asset: AnyAsset, kind: 'photo' | 'sample') => {
    if (asset.storage === 'private') {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: 'already_private',
      });
      return;
    }
    if (!apply) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: 'would_migrate',
      });
      return;
    }
    const source = await readSourceBytes(asset);
    if ('error' in source) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: source.error,
      });
      return;
    }
    const verified = await copyAndVerify(asset, source.bytes);
    if (verified.ok === false) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: verified.result,
        ...(verified.detail ? { detail: verified.detail } : {}),
      });
      return;
    }
    // Metadata is updated ONLY after verification passed.
    asset.storage = 'private';
    delete asset.blobUrl;
    changed = true;
    outcomes.push({
      submissionId: record.id,
      assetId: asset.assetId,
      kind,
      result: 'migrated',
    });
  };

  for (const p of photos) await process_(p, 'photo');
  for (const s of samples) await process_(s, 'sample');

  if (apply && changed) {
    const next: FamilyReviewSubmission = {
      ...record,
      photos: { ...record.photos, assets: photos },
      samples,
      updatedAt: new Date().toISOString(),
    };
    const persisted = await persistSubmission(next);
    if (!persisted.persisted) {
      // The bytes are safely in private storage and the source object
      // is untouched, so the next run simply retries this record.
      console.error(
        `[migrate] record update FAILED for ${record.id} (reason=${persisted.reason}). ` +
          'Assets were copied and verified but the record still points at ' +
          'public storage; re-run to retry. No source object was deleted.',
      );
    }
  }

  return outcomes;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const destructive = destructiveFlag(argv);
  if (destructive) {
    console.error(
      `REFUSED: ${destructive}\n` +
        'Source deletion is NOT implemented in this utility and is a ' +
        'separate operation requiring its own authorization. This script ' +
        'only ever copies and verifies; it never deletes.',
    );
    process.exit(2);
  }
  const args = parseArgs(argv);
  const target = resolveTarget();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN is not set — nothing to do.');
    process.exit(1);
  }

  console.log('Family Review asset migration');
  console.log(`  target store : ${target}`);
  console.log(`  mode         : ${args.apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  if (args.submissionId) console.log(`  submission   : ${args.submissionId}`);
  if (args.limit) console.log(`  limit        : ${args.limit}`);
  console.log('  source delete: NOT IMPLEMENTED (separate operation)');
  console.log('');

  if (args.apply) requireApplyAuthorization(target, args);

  const pathnames = await listSubmissionPathnames();
  const outcomes: AssetOutcome[] = [];
  let recordsSeen = 0;
  let recordsUnreadable = 0;

  for (const pathname of pathnames) {
    if (args.limit !== null && recordsSeen >= args.limit) break;
    const record = await readRecord(pathname);
    if (!record) {
      recordsUnreadable += 1;
      continue;
    }
    if (args.submissionId && record.id !== args.submissionId) continue;
    recordsSeen += 1;
    outcomes.push(...(await migrateSubmission(record, args.apply)));
  }

  // Aggregate, redacted reporting: opaque ids and counts only. No parent
  // name, email, child name, review token, URL, or pathname.
  const tally = new Map<string, number>();
  for (const o of outcomes) tally.set(o.result, (tally.get(o.result) ?? 0) + 1);

  console.log(`records scanned      : ${recordsSeen}`);
  console.log(`records unreadable   : ${recordsUnreadable}`);
  console.log(`assets examined      : ${outcomes.length}`);
  for (const [result, count] of [...tally].sort()) {
    console.log(`  ${result.padEnd(20)}: ${count}`);
  }

  const failures = outcomes.filter((o) =>
    ['source_read_failed', 'write_failed', 'verify_failed', 'too_large', 'no_source_url'].includes(
      o.result,
    ),
  );
  if (failures.length > 0) {
    console.log('\nfailed assets (opaque ids only):');
    for (const f of failures) {
      console.log(`  ${f.submissionId} ${f.assetId} ${f.kind} ${f.result}${f.detail ? ` (${f.detail})` : ''}`);
    }
    console.log('\nRe-run to retry. Nothing was deleted.');
    process.exit(1);
  }

  if (!args.apply) {
    console.log('\nDry run only — no object or record was written.');
  }
}

// Only run when invoked directly, so tests can import the pure guards
// above without the script trying to talk to a store.
if (process.argv[1]?.endsWith('family-review-migrate-assets.ts')) {
  main().catch((err) => {
    console.error('[migrate] fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
