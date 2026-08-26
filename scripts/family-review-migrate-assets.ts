/**
 * Cross-store cutover: legacy PUBLIC Family Review objects → a PRIVATE store.
 *
 * DRY RUN IS THE DEFAULT. Writing anything requires three matching
 * operator confirmations AND two distinct, explicitly-supplied store
 * credentials.
 *
 * ── Why two credentials ──────────────────────────────────────────────
 *
 * A Vercel Blob token is scoped to ONE store, and a store is created
 * either public or private — an existing public store cannot be flipped.
 * So the private lane is a DIFFERENT store, and this migration is a
 * cross-store copy, not an in-place access change.
 *
 * Every SDK call therefore carries an EXPLICIT token naming which side
 * it talks to. Nothing here reads the ambient BLOB_READ_WRITE_TOKEN:
 * an ambient credential would silently make one store play both roles,
 * which is exactly the confusion this design exists to prevent.
 *
 *   FAMILY_REVIEW_SOURCE_BLOB_TOKEN → legacy public store. READ ONLY.
 *   FAMILY_REVIEW_DEST_BLOB_TOKEN   → private store. WRITTEN TO.
 *
 * Both must be present, both must parse, and they must resolve to
 * DIFFERENT store ids. Anything else fails closed before a single byte
 * is read.
 *
 * ── Addressing ───────────────────────────────────────────────────────
 *
 * Source objects are addressed by PATHNAME + source token, never by the
 * blobUrl recorded on the record. `get(pathname, { token })` derives the
 * host from the token's own store, so a stale, tampered, or
 * foreign-store URL in a legacy record cannot redirect a read. The
 * recorded blobUrl is treated as untrusted and is never fetched.
 *
 * ── Order of operations, per submission ──────────────────────────────
 *
 *   1. source read      — bytes, via source token, by pathname
 *   2. destination copy — access:'private', via dest token
 *   3. verification     — read BACK from the destination and compare
 *                         size, content type, and sha256
 *   4. cutover state    — record the verified asset, so an interrupted
 *                         run resumes without recopying
 *   5. record + index   — written to the DESTINATION only after every
 *                         asset for that submission is verified
 *   6. completion       — cutover state marked complete last
 *
 * Metadata flips to storage:'private' only in the record written in
 * step 5, i.e. only after verified destination persistence.
 *
 * ── What this never does ─────────────────────────────────────────────
 *
 *   - never deletes a source object (reclamation is a separate,
 *     separately-authorized operation; deletion-shaped flags are refused)
 *   - never writes to the source store
 *   - never enumerates through the destination store
 *   - never logs a token, a private URL, or any parent/child PII
 *
 * Usage (dry run):
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts --limit=25
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts --submission=fr-…
 *
 * To write (all three required, and they must agree):
 *   --apply  --target=<namespace>
 *   FAMILY_REVIEW_MIGRATION_CONFIRM=i-am-migrating-<namespace>
 */

import { createHash } from 'node:crypto';

import { get, list, put } from '@vercel/blob';

import { getBlobNamespace, withBlobNamespace } from '../src/lib/orders.ts';
import {
  buildPersistPlan,
  normalizeSubmissionRecord,
  type FamilyReviewSubmission,
  type PhotoAsset,
  type SampleAsset,
} from '../src/lib/family-review/store.ts';

const SOURCE_TOKEN_ENV = 'FAMILY_REVIEW_SOURCE_BLOB_TOKEN';
const DEST_TOKEN_ENV = 'FAMILY_REVIEW_DEST_BLOB_TOKEN';

const LIST_PAGE_SIZE = 250;
const MAX_LIST_PAGES = 40;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

type AnyAsset = PhotoAsset | SampleAsset;

type AssetResult =
  | 'would_migrate'
  | 'migrated'
  | 'already_verified'
  | 'source_read_failed'
  | 'too_large'
  | 'dest_write_failed'
  | 'verify_failed';

interface AssetOutcome {
  submissionId: string;
  assetId: string;
  kind: 'photo' | 'sample';
  result: AssetResult;
  detail?: string;
}

type CopyResult =
  | { ok: true; result?: undefined; detail?: undefined }
  | { ok: false; result: AssetResult; detail?: string };

/** Resumable per-submission cutover state, stored in the DESTINATION. */
interface CutoverState {
  submissionId: string;
  /** Asset ids proven byte-identical in the destination. */
  assetsVerified: string[];
  /** True once the record + token index exist in the destination. */
  recordWritten: boolean;
  completedAt?: string;
}

/* ── Credentials ─────────────────────────────────────────────────────── */

/**
 * The store id a Blob token is scoped to.
 *
 * Vercel Blob tokens are `vercel_blob_rw_<storeId>_<secret>`. The store
 * id is what makes two tokens the same store, so it — never the token —
 * is what gets compared and what may appear in output.
 */
export function blobStoreIdFromToken(token: string | undefined | null): string | null {
  if (typeof token !== 'string') return null;
  const match = token.trim().match(/^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/);
  return match ? match[1] : null;
}

/**
 * Fail-closed credential validation. Pure and exhaustive: it reports
 * EVERY problem rather than the first, so an operator fixes the config
 * in one pass.
 */
export function credentialProblems(
  source: string | undefined,
  dest: string | undefined,
): string[] {
  const problems: string[] = [];
  const sourceId = blobStoreIdFromToken(source);
  const destId = blobStoreIdFromToken(dest);

  if (!source || !source.trim()) {
    problems.push(`${SOURCE_TOKEN_ENV} is not set`);
  } else if (!sourceId) {
    problems.push(`${SOURCE_TOKEN_ENV} is not a well-formed Blob token`);
  }

  if (!dest || !dest.trim()) {
    problems.push(`${DEST_TOKEN_ENV} is not set`);
  } else if (!destId) {
    problems.push(`${DEST_TOKEN_ENV} is not a well-formed Blob token`);
  }

  // Aliasing: two credentials naming ONE store would make the source
  // and destination the same place, so a "copy" would overwrite the
  // legacy object in place and the verification would be self-
  // confirming. Refuse regardless of whether the token strings differ.
  if (sourceId && destId && sourceId === destId) {
    problems.push(
      `${SOURCE_TOKEN_ENV} and ${DEST_TOKEN_ENV} resolve to the SAME store (${sourceId}) — ` +
        'source and destination must be different stores',
    );
  }

  return problems;
}

interface Credentials {
  sourceToken: string;
  destToken: string;
  sourceStoreId: string;
  destStoreId: string;
}

function resolveCredentials(): Credentials {
  const source = process.env[SOURCE_TOKEN_ENV];
  const dest = process.env[DEST_TOKEN_ENV];
  const problems = credentialProblems(source, dest);
  if (problems.length > 0) {
    console.error('\nREFUSING TO RUN. Store credential problems:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\n${SOURCE_TOKEN_ENV} must name the legacy PUBLIC store (read only).\n` +
        `${DEST_TOKEN_ENV} must name the PRIVATE destination store.\n` +
        'They must be two different stores.\n',
    );
    process.exit(4);
  }
  return {
    sourceToken: (source as string).trim(),
    destToken: (dest as string).trim(),
    sourceStoreId: blobStoreIdFromToken(source) as string,
    destStoreId: blobStoreIdFromToken(dest) as string,
  };
}

/** Strip anything token-shaped out of operator-visible text. */
export function redactTokens(message: string): string {
  return message
    .replace(/vercel_blob_rw_[A-Za-z0-9]+_[A-Za-z0-9]+/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key)=)[^\s&]+/gi, '$1[redacted]')
    .slice(0, 300);
}

function errorCode(err: unknown): string {
  return redactTokens(err instanceof Error ? err.name : 'unknown');
}

/* ── Args ────────────────────────────────────────────────────────────── */

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

/* ── Cutover state (destination store only) ──────────────────────────── */

export function cutoverStatePath(submissionId: string): string {
  return withBlobNamespace(`family-review/cutover/${submissionId}.json`);
}

async function readCutoverState(
  creds: Credentials,
  submissionId: string,
): Promise<CutoverState | null> {
  try {
    const result = await get(cutoverStatePath(submissionId), {
      access: 'private',
      token: creds.destToken,
      useCache: false,
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    const parsed = JSON.parse(await new Response(result.stream).text());
    if (!parsed || typeof parsed.submissionId !== 'string') return null;
    return {
      submissionId: parsed.submissionId,
      assetsVerified: Array.isArray(parsed.assetsVerified)
        ? parsed.assetsVerified.filter((x: unknown) => typeof x === 'string')
        : [],
      recordWritten: parsed.recordWritten === true,
      ...(typeof parsed.completedAt === 'string'
        ? { completedAt: parsed.completedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

async function writeCutoverState(
  creds: Credentials,
  state: CutoverState,
): Promise<void> {
  await put(cutoverStatePath(state.submissionId), JSON.stringify(state, null, 2), {
    access: 'private',
    token: creds.destToken,
    addRandomSuffix: false,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
    allowOverwrite: true,
  });
}

/* ── Enumeration: SOURCE store only ──────────────────────────────────── */

async function listSourceSubmissionPathnames(creds: Credentials): Promise<string[]> {
  const prefix = withBlobNamespace('family-review/submissions/');
  const pathnames: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const res = await list({
      prefix,
      limit: LIST_PAGE_SIZE,
      cursor,
      token: creds.sourceToken,
    });
    for (const blob of res.blobs) pathnames.push(blob.pathname);
    if (!res.hasMore || !res.cursor) break;
    cursor = res.cursor;
  }
  return pathnames;
}

async function readSourceRecord(
  creds: Credentials,
  pathname: string,
): Promise<FamilyReviewSubmission | null> {
  try {
    const result = await get(pathname, {
      access: 'public',
      token: creds.sourceToken,
      useCache: false,
    });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return normalizeSubmissionRecord(JSON.parse(await new Response(result.stream).text()));
  } catch {
    return null;
  }
}

/**
 * Source bytes, addressed by PATHNAME + source token.
 *
 * The blobUrl recorded on a legacy asset is deliberately NOT used: it is
 * attacker- or drift-influenced data that could point at another store.
 */
async function readSourceBytes(
  creds: Credentials,
  asset: AnyAsset,
): Promise<{ bytes: Uint8Array } | { error: AssetResult; detail?: string }> {
  let result: Awaited<ReturnType<typeof get>>;
  try {
    result = await get(asset.blobPathname, {
      access: 'public',
      token: creds.sourceToken,
      useCache: false,
    });
  } catch (err) {
    return { error: 'source_read_failed', detail: errorCode(err) };
  }
  if (!result || result.statusCode !== 200 || !result.stream) {
    return { error: 'source_read_failed', detail: 'not_readable' };
  }
  const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
  if (bytes.byteLength > MAX_ASSET_BYTES) return { error: 'too_large' };
  return { bytes };
}

/* ── Copy + verify (destination store only) ──────────────────────────── */

async function copyAndVerify(
  creds: Credentials,
  asset: AnyAsset,
  bytes: Uint8Array,
): Promise<CopyResult> {
  const sourceHash = sha256(bytes);

  try {
    await put(asset.blobPathname, Buffer.from(bytes), {
      access: 'private',
      token: creds.destToken,
      addRandomSuffix: false,
      contentType: asset.mime,
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
  } catch (err) {
    return { ok: false, result: 'dest_write_failed', detail: errorCode(err) };
  }

  // Verify by reading the object BACK out of the destination store.
  let readBack: Awaited<ReturnType<typeof get>>;
  try {
    readBack = await get(asset.blobPathname, {
      access: 'private',
      token: creds.destToken,
      useCache: false,
    });
  } catch (err) {
    return { ok: false, result: 'verify_failed', detail: errorCode(err) };
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
  if (roundTripped.byteLength !== bytes.byteLength) {
    return { ok: false, result: 'verify_failed', detail: 'size_mismatch' };
  }
  if (sha256(roundTripped) !== sourceHash) {
    return { ok: false, result: 'verify_failed', detail: 'hash_mismatch' };
  }
  return { ok: true };
}

/**
 * Write the record and its token index to the DESTINATION store.
 *
 * Bytes come from buildPersistPlan, so the same sanitizer that guards
 * every runtime write guards this one: no plaintext review token in any
 * pathname or any serialized byte.
 */
async function writeDestinationRecord(
  creds: Credentials,
  record: FamilyReviewSubmission,
): Promise<{ ok: boolean; detail?: string }> {
  const plan = buildPersistPlan(record);
  if (!plan.indexPathname || !plan.indexBody) {
    return { ok: false, detail: 'no_token_hash' };
  }
  try {
    await put(plan.submissionPathname, plan.submissionBody, {
      access: 'private',
      token: creds.destToken,
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
    await put(plan.indexPathname, plan.indexBody, {
      access: 'private',
      token: creds.destToken,
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: errorCode(err) };
  }
}

/* ── Pure cutover planning ───────────────────────────────────────────── */

/**
 * Every asset on a record, in a stable order.
 */
export function allAssetsOf(record: {
  photos: { assets: PhotoAsset[] };
  samples: SampleAsset[];
}): { assetId: string; kind: 'photo' | 'sample' }[] {
  return [
    ...record.photos.assets.map((a) => ({ assetId: a.assetId, kind: 'photo' as const })),
    ...record.samples.map((a) => ({ assetId: a.assetId, kind: 'sample' as const })),
  ];
}

/**
 * Which assets still need copying, given the persisted cutover state.
 *
 * An asset already proven byte-identical in the destination is never
 * recopied, which is what makes an interrupted run resume rather than
 * restart.
 */
export function assetsNeedingCopy(
  all: { assetId: string; kind: 'photo' | 'sample' }[],
  state: Pick<CutoverState, 'assetsVerified'>,
): { assetId: string; kind: 'photo' | 'sample' }[] {
  const verified = new Set(state.assetsVerified);
  return all.filter((a) => !verified.has(a.assetId));
}

/**
 * Whether the record + index may be written to the destination.
 *
 * TRUE only when EVERY asset on the record is verified in the
 * destination. This is the gate that stops metadata from flipping to
 * storage:'private' while any byte is still unproven.
 */
export function recordIsReady(
  all: { assetId: string }[],
  verified: Iterable<string>,
): boolean {
  const done = new Set(verified);
  return all.length > 0 ? all.every((a) => done.has(a.assetId)) : true;
}

/**
 * The metadata flip itself: point the asset at private storage and drop
 * the legacy public URL entirely.
 */
export function flipAssetToPrivate<T extends AnyAsset>(asset: T): T {
  const next = { ...asset, storage: 'private' as const };
  delete next.blobUrl;
  return next;
}

/* ── Per-submission cutover ──────────────────────────────────────────── */

async function migrateSubmission(
  creds: Credentials,
  record: FamilyReviewSubmission,
  apply: boolean,
): Promise<AssetOutcome[]> {
  const outcomes: AssetOutcome[] = [];
  const photos = record.photos.assets.map((a) => ({ ...a }));
  const samples = record.samples.map((a) => ({ ...a }));
  const all: [AnyAsset, 'photo' | 'sample'][] = [
    ...photos.map((a) => [a, 'photo'] as [AnyAsset, 'photo']),
    ...samples.map((a) => [a, 'sample'] as [AnyAsset, 'sample']),
  ];

  if (!apply) {
    for (const [asset, kind] of all) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: 'would_migrate',
      });
    }
    return outcomes;
  }

  const state: CutoverState = (await readCutoverState(creds, record.id)) ?? {
    submissionId: record.id,
    assetsVerified: [],
    recordWritten: false,
  };

  if (state.completedAt) {
    for (const [asset, kind] of all) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: 'already_verified',
      });
    }
    return outcomes;
  }

  const verified = new Set(state.assetsVerified);
  const pending = new Set(
    assetsNeedingCopy(allAssetsOf(record), state).map((a) => a.assetId),
  );

  for (const [asset, kind] of all) {
    // Resume: an asset already proven in the destination is not recopied.
    if (!pending.has(asset.assetId)) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: 'already_verified',
      });
      continue;
    }

    const source = await readSourceBytes(creds, asset);
    if ('error' in source) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: source.error,
        ...(source.detail ? { detail: source.detail } : {}),
      });
      continue;
    }

    const copied = await copyAndVerify(creds, asset, source.bytes);
    if (copied.ok === false) {
      outcomes.push({
        submissionId: record.id,
        assetId: asset.assetId,
        kind,
        result: copied.result,
        ...(copied.detail ? { detail: copied.detail } : {}),
      });
      continue;
    }

    // Checkpoint immediately, so an interruption on the NEXT asset does
    // not recopy this one.
    verified.add(asset.assetId);
    state.assetsVerified = [...verified];
    await writeCutoverState(creds, state);

    outcomes.push({
      submissionId: record.id,
      assetId: asset.assetId,
      kind,
      result: 'migrated',
    });
  }

  // The record is written to the destination — and metadata flipped to
  // storage:'private' — ONLY when every asset is verified there.
  if (!recordIsReady(allAssetsOf(record), verified)) return outcomes;

  const next: FamilyReviewSubmission = {
    ...record,
    photos: { ...record.photos, assets: photos.map(flipAssetToPrivate) },
    samples: samples.map(flipAssetToPrivate),
    updatedAt: new Date().toISOString(),
  };

  const written = await writeDestinationRecord(creds, next);
  if (!written.ok) {
    console.error(
      `[migrate] destination record write FAILED for ${record.id} ` +
        `(${written.detail ?? 'unknown'}). Assets are verified in the destination; ` +
        're-run to finish. No source object was touched.',
    );
    return outcomes;
  }

  state.recordWritten = true;
  state.completedAt = new Date().toISOString();
  await writeCutoverState(creds, state);
  return outcomes;
}

/* ── Main ────────────────────────────────────────────────────────────── */

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
  const target = getBlobNamespace() || 'production';

  // Credentials are validated BEFORE anything else, including in dry
  // run: a dry run that silently used one store for both sides would
  // report a migration plan that cannot be executed as described.
  const creds = resolveCredentials();

  console.log('Family Review cross-store cutover');
  console.log(`  target namespace : ${target}`);
  console.log(`  source store     : ${creds.sourceStoreId} (public, read only)`);
  console.log(`  destination store: ${creds.destStoreId} (private)`);
  console.log(`  mode             : ${args.apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  if (args.submissionId) console.log(`  submission       : ${args.submissionId}`);
  if (args.limit) console.log(`  limit            : ${args.limit}`);
  console.log('  source delete    : NOT IMPLEMENTED (separate operation)');
  console.log('');

  if (args.apply) requireApplyAuthorization(target, args);

  const pathnames = await listSourceSubmissionPathnames(creds);
  const outcomes: AssetOutcome[] = [];
  let recordsSeen = 0;
  let recordsUnreadable = 0;

  for (const pathname of pathnames) {
    if (args.limit !== null && recordsSeen >= args.limit) break;
    const record = await readSourceRecord(creds, pathname);
    if (!record) {
      recordsUnreadable += 1;
      continue;
    }
    if (args.submissionId && record.id !== args.submissionId) continue;
    recordsSeen += 1;
    outcomes.push(...(await migrateSubmission(creds, record, args.apply)));
  }

  // Aggregate, redacted reporting: opaque ids, store ids, and counts
  // only. Never a token, a URL, a pathname, or any parent/child PII.
  const tally = new Map<string, number>();
  for (const o of outcomes) tally.set(o.result, (tally.get(o.result) ?? 0) + 1);

  console.log(`records scanned      : ${recordsSeen}`);
  console.log(`records unreadable   : ${recordsUnreadable}`);
  console.log(`assets examined      : ${outcomes.length}`);
  for (const [result, count] of [...tally].sort()) {
    console.log(`  ${result.padEnd(20)}: ${count}`);
  }

  const failures = outcomes.filter((o) =>
    ['source_read_failed', 'dest_write_failed', 'verify_failed', 'too_large'].includes(
      o.result,
    ),
  );
  if (failures.length > 0) {
    console.log('\nfailed assets (opaque ids only):');
    for (const f of failures) {
      console.log(
        `  ${f.submissionId} ${f.assetId} ${f.kind} ${f.result}${f.detail ? ` (${f.detail})` : ''}`,
      );
    }
    console.log('\nRe-run to resume. Nothing was deleted.');
    process.exit(1);
  }

  if (!args.apply) {
    console.log('\nDry run only — no destination object, record, or state was written.');
  }
}

if (process.argv[1]?.endsWith('family-review-migrate-assets.ts')) {
  main().catch((err) => {
    console.error(
      '[migrate] fatal:',
      redactTokens(err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  });
}
