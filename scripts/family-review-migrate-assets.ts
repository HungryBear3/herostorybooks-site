/**
 * Cross-store cutover: legacy PUBLIC Family Review objects -> a PRIVATE store.
 *
 * DRY RUN IS THE DEFAULT. Writing anything requires three matching
 * operator confirmations AND two distinct, explicitly-supplied store
 * credentials.
 *
 * -- Why two credentials --
 *
 * A Vercel Blob token is scoped to ONE store, and a store is created
 * either public or private -- an existing public store cannot be
 * flipped. So the private lane is a DIFFERENT store, and this migration
 * is a cross-store copy, not an in-place access change.
 *
 * Every SDK call therefore carries an EXPLICIT token naming which side
 * it talks to. Nothing here reads the ambient BLOB_READ_WRITE_TOKEN:
 * an ambient credential would silently make one store play both roles,
 * which is exactly the confusion this design exists to prevent.
 *
 *   FAMILY_REVIEW_SOURCE_BLOB_TOKEN -> legacy public store. READ ONLY.
 *   FAMILY_REVIEW_DEST_BLOB_TOKEN   -> private store. WRITTEN TO.
 *
 * -- Streaming, not buffering --
 *
 * Bytes are never materialised whole. The source is streamed straight
 * into the destination write through a metering transform that hashes
 * and counts as bytes pass, and ABORTS the moment the ceiling is
 * exceeded. An oversized or hostile object is cut off mid-flight rather
 * than being fully read into memory and rejected afterwards. The
 * verification read-back is streamed and digested the same way.
 *
 * -- Content type is sniffed, not echoed --
 *
 * The type written to the destination comes from the SOURCE BYTES, and
 * the recorded mime must agree with them. Writing the recorded mime and
 * then reading it back would confirm only that the SDK echoes what it
 * was handed. The destination object's own leading bytes are re-sniffed
 * after the copy, so the check is about content, not bookkeeping.
 *
 * -- Checkpoint binding --
 *
 * Resume state is bound to the submission id, a deterministic
 * fingerprint of the source record, and the full identity of each
 * verified asset {kind, assetId, pathname, size, mime, sourceSha256}.
 * State that is malformed, foreign, stale, duplicated, or bound to a
 * different record is discarded rather than trusted, and completedAt is
 * never honoured without revalidating that binding.
 *
 * -- What this never does --
 *
 *   - never deletes a source object (reclamation is a separate,
 *     separately-authorized operation; deletion-shaped flags are refused)
 *   - never writes to the source store
 *   - never enumerates through the destination store
 *   - never logs a token, a private URL, or any parent/child PII
 *   - never reports success on a truncated enumeration
 *
 * Usage (dry run):
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts --limit=25
 *   node --experimental-strip-types scripts/family-review-migrate-assets.ts --submission=fr-xxx
 *
 * To write (all three required, and they must agree):
 *   --apply  --target=<namespace>
 *   FAMILY_REVIEW_MIGRATION_CONFIRM=i-am-migrating-<namespace>
 */

import { createHash } from 'node:crypto';

import { get, list, put } from '@vercel/blob';

import { getBlobNamespace, withBlobNamespace } from '../src/lib/orders.ts';
import { blobStoreIdFromToken } from '../src/lib/family-review/blob-credentials.ts';
import {
  canonicalImageMime,
  sniffImageType,
} from '../src/lib/family-review/image-type.ts';
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
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** Enough leading bytes to identify every format the lane accepts. */
const SNIFF_BYTES = 16;
/** Cutover state schema version; a different version is not trusted. */
export const CUTOVER_STATE_VERSION = 1;

type AnyAsset = PhotoAsset | SampleAsset;
export type AssetKind = 'photo' | 'sample';

type AssetResult =
  | 'would_migrate'
  | 'migrated'
  | 'already_verified'
  | 'source_read_failed'
  | 'too_large'
  | 'source_type_unrecognized'
  | 'content_type_mismatch'
  | 'size_mismatch'
  | 'dest_write_failed'
  | 'verify_failed';

interface AssetOutcome {
  submissionId: string;
  assetId: string;
  kind: AssetKind;
  result: AssetResult;
  detail?: string;
}

/** Everything that identifies one asset as the thing we intend to copy. */
export interface AssetIdentity {
  kind: AssetKind;
  assetId: string;
  pathname: string;
  size: number;
  mime: string;
}

/** An identity plus proof of the bytes that were actually copied. */
export interface VerifiedAsset extends AssetIdentity {
  sourceSha256: string;
}

/** Resumable per-submission cutover state, stored in the DESTINATION. */
export interface CutoverState {
  version: number;
  submissionId: string;
  /** Deterministic fingerprint of the source record this state describes. */
  recordFingerprint: string;
  assetsVerified: VerifiedAsset[];
  recordWritten: boolean;
  completedAt?: string;
}

/* -- Credentials -- */

/**
 * The store id a Blob token is scoped to.
 *
 * Vercel Blob tokens are `vercel_blob_rw_<storeId>_<secret>`. The store
 * id is what makes two tokens the same store, so it -- never the token
 * -- is what gets compared and what may appear in output.
 *
 * Defined in src/lib/family-review/blob-credentials.ts and re-exported
 * here: the runtime now validates the SAME dedicated credential this
 * script writes to, and two copies of this parser could drift into
 * accepting a token the other refuses.
 */
export { blobStoreIdFromToken };

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
      `${SOURCE_TOKEN_ENV} and ${DEST_TOKEN_ENV} resolve to the SAME store (${sourceId}) - ` +
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

/* -- Read options, one builder per side -- */

/**
 * Options for a read from the legacy PUBLIC source store.
 *
 * Deliberately carries NO `useCache`. Vercel Blob rejects a public
 * `get()` that supplies it with HTTP 400 -- observed in the Preview soak
 * on 2026-08-26, where the same object returned 200 once the field was
 * removed. The SDK documents `useCache` as effective only for private
 * blobs and ignored for public ones, so its presence bought nothing and
 * cost the whole read.
 *
 * Both sides go through a builder so the rule lives in one place instead
 * of being repeated at each call site.
 */
export function sourceGetOptions(token: string): {
  access: 'public';
  token: string;
} {
  return { access: 'public', token };
}

/**
 * Options for a read from the PRIVATE destination store.
 *
 * Keeps `useCache: false`: for a private object it is honoured, and it
 * is what stops a CDN copy from answering a verification read-back with
 * stale bytes.
 */
export function destGetOptions(token: string): {
  access: 'private';
  token: string;
  useCache: false;
} {
  return { access: 'private', token, useCache: false };
}

/* -- Args -- */

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

/* -- Asset identity and record fingerprint -- */

/**
 * Identity key. Includes the KIND, because a photo and a sample can
 * legitimately carry the same assetId while living at different
 * pathnames -- keying on assetId alone would let one copy mark both
 * verified.
 */
export function assetIdentityKey(asset: { kind: AssetKind; assetId: string }): string {
  return `${asset.kind}:${asset.assetId}`;
}

/** Every asset on a record, with full identity, in a stable order. */
export function assetIdentitiesOf(record: {
  photos: { assets: PhotoAsset[] };
  samples: SampleAsset[];
}): AssetIdentity[] {
  const of = (a: AnyAsset, kind: AssetKind): AssetIdentity => ({
    kind,
    assetId: a.assetId,
    pathname: a.blobPathname,
    size: a.size,
    mime: a.mime,
  });
  return [
    ...record.photos.assets.map((a) => of(a, 'photo')),
    ...record.samples.map((a) => of(a, 'sample')),
  ];
}

/**
 * Identity keys that appear more than once on one record.
 *
 * A duplicate makes "which object did we verify?" ambiguous, so such a
 * record is refused rather than migrated on a guess.
 */
export function duplicateIdentityKeys(identities: AssetIdentity[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of identities) {
    const key = assetIdentityKey(id);
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes].sort();
}

/**
 * Deterministic fingerprint of the migration-relevant shape of a record.
 *
 * Covers the submission id and the full identity of every asset, so any
 * asset added, removed, repointed, resized, or retyped changes it. It
 * deliberately excludes volatile fields (updatedAt, status, feedback):
 * those change constantly through normal admin work and must not
 * invalidate a half-finished copy.
 */
export function computeRecordFingerprint(record: {
  id: string;
  photos: { assets: PhotoAsset[] };
  samples: SampleAsset[];
}): string {
  const rows = assetIdentitiesOf(record)
    .map((a) => [a.kind, a.assetId, a.pathname, String(a.size), a.mime].join(' '))
    .sort();
  return createHash('sha256')
    .update(JSON.stringify({ id: record.id, assets: rows }))
    .digest('hex');
}

function identitiesEqual(a: AssetIdentity, b: AssetIdentity): boolean {
  return (
    a.kind === b.kind &&
    a.assetId === b.assetId &&
    a.pathname === b.pathname &&
    a.size === b.size &&
    a.mime === b.mime
  );
}

function isVerifiedAssetShaped(value: unknown): value is VerifiedAsset {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === 'photo' || v.kind === 'sample') &&
    typeof v.assetId === 'string' &&
    v.assetId.length > 0 &&
    typeof v.pathname === 'string' &&
    v.pathname.length > 0 &&
    typeof v.size === 'number' &&
    Number.isFinite(v.size) &&
    v.size >= 0 &&
    typeof v.mime === 'string' &&
    v.mime.length > 0 &&
    typeof v.sourceSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.sourceSha256)
  );
}

/**
 * Validate persisted cutover state against the record it claims to
 * describe, and return only the parts that are still trustworthy.
 *
 * Anything malformed, foreign, stale, duplicated, or bound to a
 * different record shape is DISCARDED -- the affected assets are simply
 * recopied, which is safe because a destination write is an overwrite of
 * the same pathname. completedAt is never carried over on its own: it
 * survives only if the binding revalidates AND every asset on the record
 * is covered.
 */
export function validateCutoverState(
  raw: unknown,
  record: { id: string; photos: { assets: PhotoAsset[] }; samples: SampleAsset[] },
): { state: CutoverState; reasons: string[] } {
  const fingerprint = computeRecordFingerprint(record);
  const fresh: CutoverState = {
    version: CUTOVER_STATE_VERSION,
    submissionId: record.id,
    recordFingerprint: fingerprint,
    assetsVerified: [],
    recordWritten: false,
  };
  const reasons: string[] = [];

  if (raw === null || raw === undefined) return { state: fresh, reasons };
  if (typeof raw !== 'object') return { state: fresh, reasons: ['state_malformed'] };

  const s = raw as Record<string, unknown>;

  if (s.version !== CUTOVER_STATE_VERSION) {
    return { state: fresh, reasons: ['state_version_unknown'] };
  }
  if (typeof s.submissionId !== 'string' || s.submissionId !== record.id) {
    // State belonging to another submission must never be honoured.
    return { state: fresh, reasons: ['state_foreign_submission'] };
  }
  if (
    typeof s.recordFingerprint !== 'string' ||
    s.recordFingerprint !== fingerprint
  ) {
    // The record's asset shape changed since the checkpoint was written.
    return { state: fresh, reasons: ['record_changed'] };
  }
  if (!Array.isArray(s.assetsVerified)) {
    return { state: fresh, reasons: ['state_malformed'] };
  }

  const identities = assetIdentitiesOf(record);
  const byKey = new Map(identities.map((i) => [assetIdentityKey(i), i]));

  const kept: VerifiedAsset[] = [];
  const seenKeys = new Set<string>();
  for (const entry of s.assetsVerified) {
    if (!isVerifiedAssetShaped(entry)) {
      reasons.push('entry_malformed');
      continue;
    }
    const key = assetIdentityKey(entry);
    if (seenKeys.has(key)) {
      // A duplicated checkpoint entry is evidence of tampering or of a
      // merge gone wrong; drop it rather than count it twice.
      reasons.push('entry_duplicate');
      continue;
    }
    const current = byKey.get(key);
    if (!current) {
      reasons.push('entry_not_on_record');
      continue;
    }
    if (!identitiesEqual(current, entry)) {
      // Same id, different object -- the source moved, resized, or
      // changed type. The old proof does not describe it.
      reasons.push('entry_identity_mismatch');
      continue;
    }
    seenKeys.add(key);
    kept.push(entry);
  }

  const complete =
    identities.length > 0 &&
    identities.every((i) => seenKeys.has(assetIdentityKey(i)));
  const recordWritten = s.recordWritten === true && complete;
  const completedAt =
    typeof s.completedAt === 'string' && complete && recordWritten
      ? s.completedAt
      : undefined;

  if (s.completedAt && !completedAt) reasons.push('completion_revoked');

  return {
    state: {
      version: CUTOVER_STATE_VERSION,
      submissionId: record.id,
      recordFingerprint: fingerprint,
      assetsVerified: kept,
      recordWritten,
      ...(completedAt ? { completedAt } : {}),
    },
    reasons,
  };
}

/**
 * Which assets still need copying, given VALIDATED state.
 *
 * An asset counts as done only if a checkpoint entry matches its full
 * identity, so a changed source object is recopied rather than skipped.
 */
export function assetsNeedingCopy(
  identities: AssetIdentity[],
  state: Pick<CutoverState, 'assetsVerified'>,
): AssetIdentity[] {
  const done = new Map(
    state.assetsVerified.map((v) => [assetIdentityKey(v), v] as const),
  );
  return identities.filter((i) => {
    const entry = done.get(assetIdentityKey(i));
    return !entry || !identitiesEqual(i, entry);
  });
}

/**
 * Whether the record + index may be written to the destination.
 *
 * TRUE only when EVERY asset on the record has a matching verified
 * entry. This is the gate that stops metadata from flipping to
 * storage:'private' while any byte is unproven.
 */
export function recordIsReady(
  identities: AssetIdentity[],
  state: Pick<CutoverState, 'assetsVerified'>,
): boolean {
  return assetsNeedingCopy(identities, state).length === 0;
}

/**
 * The metadata flip: point the asset at private storage and drop the
 * legacy public URL entirely.
 */
export function flipAssetToPrivate<T extends AnyAsset>(asset: T): T {
  const next = { ...asset, storage: 'private' as const };
  delete next.blobUrl;
  return next;
}

/* -- Streaming primitives -- */

function concatHead(parts: Uint8Array[], limit: number): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const buf = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const part of parts) {
    if (off >= buf.byteLength) break;
    const take = Math.min(part.byteLength, buf.byteLength - off);
    buf.set(part.subarray(0, take), off);
    off += take;
  }
  return buf;
}

export interface MeteredBody {
  /** Re-emits the peeked head, then the rest of the source. */
  body: ReadableStream<Uint8Array>;
  /** First bytes, for content sniffing, without consuming the body. */
  head: Uint8Array;
  /** Resolves once the body is fully consumed; rejects on overflow. */
  settled: Promise<{ size: number; sha256: string }>;
}

/**
 * Peek enough bytes to sniff, then hand back a stream that hashes and
 * counts as it is consumed and ERRORS as soon as maxBytes is passed.
 *
 * The ceiling is enforced mid-flight: an oversized object is cut off
 * while streaming, not read into memory and rejected afterwards.
 */
export async function meterAndSniff(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<MeteredBody> {
  const reader = source.getReader();
  const peeked: Uint8Array[] = [];
  let peekedLen = 0;
  while (peekedLen < SNIFF_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      peeked.push(value);
      peekedLen += value.byteLength;
    }
  }
  const head = concatHead(peeked, SNIFF_BYTES);

  const hash = createHash('sha256');
  let size = 0;
  let settle!: (v: { size: number; sha256: string }) => void;
  let reject!: (e: unknown) => void;
  const settled = new Promise<{ size: number; sha256: string }>((res, rej) => {
    settle = res;
    reject = rej;
  });
  // The caller may abandon this promise if the destination write fails
  // first; keep it from surfacing as an unhandled rejection.
  settled.catch(() => {});

  const queue = [...peeked];
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let chunk = queue.shift();
        if (!chunk) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            settle({ size, sha256: hash.digest('hex') });
            return;
          }
          chunk = value;
        }
        if (!chunk || chunk.byteLength === 0) return;
        size += chunk.byteLength;
        if (size > maxBytes) {
          const err = new Error('asset exceeds the streaming size ceiling');
          err.name = 'AssetTooLarge';
          await reader.cancel().catch(() => {});
          controller.error(err);
          reject(err);
          return;
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      } catch (err) {
        controller.error(err);
        reject(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
      reject(reason instanceof Error ? reason : new Error('source stream cancelled'));
    },
  });

  return { body, head, settled };
}

/**
 * Digest a stream without buffering it: hash and count as chunks
 * arrive, keeping only enough leading bytes to re-sniff the type.
 */
export async function digestStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ size: number; sha256: string; head: Uint8Array }> {
  const reader = stream.getReader();
  const hash = createHash('sha256');
  const peeked: Uint8Array[] = [];
  let peekedLen = 0;
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      const err = new Error('asset exceeds the streaming size ceiling');
      err.name = 'AssetTooLarge';
      throw err;
    }
    if (peekedLen < SNIFF_BYTES) {
      peeked.push(value);
      peekedLen += value.byteLength;
    }
    hash.update(value);
  }
  return {
    size,
    sha256: hash.digest('hex'),
    head: concatHead(peeked, SNIFF_BYTES),
  };
}

/* -- Source content-type verification -- */

export type SourceTypeVerdict =
  | { ok: true; mime: string }
  | { ok: false; result: 'source_type_unrecognized' | 'content_type_mismatch'; detail: string };

/**
 * Decide the content type from the SOURCE BYTES and require the record
 * to agree with them.
 *
 * This is the check that replaces "write the recorded mime, then read it
 * back": reading back a header we just supplied proves only that the SDK
 * echoes its input. Sniffing decides the type from content, and a record
 * that disagrees with its own bytes is a hard failure, not a relabel.
 */
export function verifySourceType(
  head: Uint8Array,
  recordedMime: string,
): SourceTypeVerdict {
  const sniffed = sniffImageType(head);
  if (!sniffed) {
    return {
      ok: false,
      result: 'source_type_unrecognized',
      detail: 'no_magic_bytes',
    };
  }
  if (canonicalImageMime(recordedMime) !== sniffed.mime) {
    return {
      ok: false,
      result: 'content_type_mismatch',
      detail: `record says ${recordedMime}, bytes are ${sniffed.mime}`,
    };
  }
  return { ok: true, mime: sniffed.mime };
}

/* -- Checkpoint revalidation (byte-level) -- */

/**
 * A stream source for one object, or null when it is absent.
 *
 * Injected so revalidation is testable without a store, and so the
 * caller is forced to decide WHICH credential each side uses.
 */
export type ObjectReader = (
  pathname: string,
) => Promise<ReadableStream<Uint8Array> | null>;

export type RevalidationReason =
  | 'identity_mismatch'
  | 'submission_binding_mismatch'
  | 'source_missing'
  | 'source_too_large'
  | 'source_type_changed'
  | 'source_size_changed'
  | 'source_hash_changed'
  | 'dest_missing'
  | 'dest_too_large'
  | 'dest_type_mismatch'
  | 'dest_size_mismatch'
  | 'dest_hash_mismatch';

export type RevalidationVerdict =
  | { ok: true }
  | { ok: false; reason: RevalidationReason };

/**
 * An asset pathname must live under its own submission's folder.
 *
 * Catches a state file whose top-level submissionId was edited to match
 * while its entries were spliced in from another submission.
 */
export function pathnameMatchesIdentity(
  pathname: string,
  submissionId: string,
  kind: AssetKind,
): boolean {
  const folder = kind === 'photo' ? 'photos' : 'samples';
  return pathname.includes(`family-review/${folder}/${submissionId}/`);
}

/**
 * Re-prove one checkpointed asset against the CURRENT bytes on both
 * sides.
 *
 * Shape validation alone cannot detect a source object replaced in place
 * with same-length, same-type bytes, a destination object deleted or
 * overwritten, or a syntactically valid hash that was simply invented.
 * Every one of those leaves a checkpoint that looks perfect. So on
 * resume the bytes are read again, through the two explicit credentials,
 * and the checkpoint is retained ONLY if all of these agree:
 *
 *   - the entry's full identity matches the record's
 *   - the pathname belongs to this submission
 *   - the live source still sniffs to the recorded mime
 *   - the live source's length matches the record
 *   - the live source's hash matches the RECORDED sourceSha256
 *   - the destination object exists, is within the ceiling, sniffs to
 *     the same mime, and matches the source's size and hash
 *
 * Both reads stream and are ceiling-enforced; neither side is buffered.
 */
export async function revalidateCheckpointedAsset(args: {
  submissionId: string;
  identity: AssetIdentity;
  entry: VerifiedAsset;
  readSource: ObjectReader;
  readDest: ObjectReader;
  maxBytes: number;
}): Promise<RevalidationVerdict> {
  const { submissionId, identity, entry, readSource, readDest, maxBytes } = args;

  if (!identitiesEqual(identity, entry)) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  if (!pathnameMatchesIdentity(identity.pathname, submissionId, identity.kind)) {
    return { ok: false, reason: 'submission_binding_mismatch' };
  }

  // --- source side -------------------------------------------------
  let sourceStream: ReadableStream<Uint8Array> | null;
  try {
    sourceStream = await readSource(identity.pathname);
  } catch {
    return { ok: false, reason: 'source_missing' };
  }
  if (!sourceStream) return { ok: false, reason: 'source_missing' };

  let sourceStats: { size: number; sha256: string; head: Uint8Array };
  try {
    sourceStats = await digestStream(sourceStream, maxBytes);
  } catch (err) {
    if (err instanceof Error && err.name === 'AssetTooLarge') {
      return { ok: false, reason: 'source_too_large' };
    }
    return { ok: false, reason: 'source_missing' };
  }

  const sourceType = verifySourceType(sourceStats.head, identity.mime);
  if (sourceType.ok === false) {
    return { ok: false, reason: 'source_type_changed' };
  }
  if (sourceStats.size !== identity.size) {
    return { ok: false, reason: 'source_size_changed' };
  }
  // The recorded proof must still describe the bytes that are there now.
  // This is what catches a same-path, same-size, same-type replacement,
  // and an invented-but-well-formed sourceSha256.
  if (sourceStats.sha256 !== entry.sourceSha256) {
    return { ok: false, reason: 'source_hash_changed' };
  }

  // --- destination side --------------------------------------------
  let destStream: ReadableStream<Uint8Array> | null;
  try {
    destStream = await readDest(identity.pathname);
  } catch {
    return { ok: false, reason: 'dest_missing' };
  }
  if (!destStream) return { ok: false, reason: 'dest_missing' };

  let destStats: { size: number; sha256: string; head: Uint8Array };
  try {
    destStats = await digestStream(destStream, maxBytes);
  } catch (err) {
    if (err instanceof Error && err.name === 'AssetTooLarge') {
      return { ok: false, reason: 'dest_too_large' };
    }
    return { ok: false, reason: 'dest_missing' };
  }

  const destSniffed = sniffImageType(destStats.head);
  if (!destSniffed || destSniffed.mime !== sourceType.mime) {
    return { ok: false, reason: 'dest_type_mismatch' };
  }
  if (destStats.size !== sourceStats.size) {
    return { ok: false, reason: 'dest_size_mismatch' };
  }
  if (destStats.sha256 !== sourceStats.sha256) {
    return { ok: false, reason: 'dest_hash_mismatch' };
  }

  return { ok: true };
}

/**
 * Rebuild state from the entries that survived byte revalidation.
 *
 * Completion is RE-DERIVED from what is still proven, so a single
 * revoked entry withdraws completedAt and recordWritten: the record must
 * be rewritten after the affected assets are recopied.
 */
export function reviseStateAfterRevalidation(
  state: CutoverState,
  identities: AssetIdentity[],
  kept: VerifiedAsset[],
): CutoverState {
  const complete = recordIsReady(identities, { assetsVerified: kept });
  const recordWritten = complete && state.recordWritten;
  // Built field by field rather than spread: spreading `state` would
  // carry completedAt straight through, so a conditional that only ever
  // RE-ADDS it can never actually revoke it.
  return {
    version: state.version,
    submissionId: state.submissionId,
    recordFingerprint: state.recordFingerprint,
    assetsVerified: kept,
    recordWritten,
    ...(recordWritten && state.completedAt
      ? { completedAt: state.completedAt }
      : {}),
  };
}

/**
 * Byte-revalidate every checkpointed asset for one record.
 *
 * Returns the surviving state plus a reason code per revoked asset.
 * Revoked assets are simply recopied, which is safe: a destination write
 * is an overwrite of the same pathname.
 */
export async function revalidateCheckpoints(args: {
  record: { id: string; photos: { assets: PhotoAsset[] }; samples: SampleAsset[] };
  state: CutoverState;
  readSource: ObjectReader;
  readDest: ObjectReader;
  maxBytes: number;
}): Promise<{ state: CutoverState; reasons: string[] }> {
  const identities = assetIdentitiesOf(args.record);
  const byKey = new Map(identities.map((i) => [assetIdentityKey(i), i]));
  const kept: VerifiedAsset[] = [];
  const reasons: string[] = [];

  for (const entry of args.state.assetsVerified) {
    const identity = byKey.get(assetIdentityKey(entry));
    if (!identity) {
      reasons.push('entry_not_on_record');
      continue;
    }
    const verdict = await revalidateCheckpointedAsset({
      submissionId: args.record.id,
      identity,
      entry,
      readSource: args.readSource,
      readDest: args.readDest,
      maxBytes: args.maxBytes,
    });
    if (verdict.ok === false) {
      reasons.push(verdict.reason);
      continue;
    }
    kept.push(entry);
  }

  return {
    state: reviseStateAfterRevalidation(args.state, identities, kept),
    reasons,
  };
}

/* -- Cutover state (destination store only) -- */

export function cutoverStatePath(submissionId: string): string {
  return withBlobNamespace(`family-review/cutover/${submissionId}.json`);
}

async function readRawCutoverState(
  creds: Credentials,
  submissionId: string,
): Promise<unknown> {
  try {
    const result = await get(
      cutoverStatePath(submissionId),
      destGetOptions(creds.destToken),
    );
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return JSON.parse(await new Response(result.stream).text());
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

/* -- Enumeration: SOURCE store only -- */

/** Raised when the submission prefix is larger than the page budget. */
export class EnumerationTruncatedError extends Error {
  readonly pagesScanned: number;
  readonly objectsSeen: number;
  constructor(pagesScanned: number, objectsSeen: number) {
    super(
      `source enumeration hit its page cap (${pagesScanned} pages, ${objectsSeen} objects) ` +
        'while the store still reported more results',
    );
    this.name = 'EnumerationTruncatedError';
    this.pagesScanned = pagesScanned;
    this.objectsSeen = objectsSeen;
  }
}

/**
 * Every submission record in the SOURCE store.
 *
 * Throws rather than returning a short list when the page budget runs
 * out with more results pending: a truncated enumeration that reported
 * success would look exactly like a completed migration while silently
 * leaving records behind.
 */
export interface ListPage {
  blobs: { pathname: string }[];
  hasMore: boolean;
  cursor?: string;
}

/**
 * Page through an enumeration, refusing to return a short list.
 *
 * Pure with respect to storage: the caller supplies the pager, so the
 * truncation contract is testable without a store.
 */
export async function collectPathnames(
  fetchPage: (cursor: string | undefined) => Promise<ListPage>,
  maxPages: number,
): Promise<string[]> {
  const pathnames: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await fetchPage(cursor);
    for (const blob of res.blobs) pathnames.push(blob.pathname);
    if (!res.hasMore || !res.cursor) return pathnames;
    cursor = res.cursor;
  }
  throw new EnumerationTruncatedError(maxPages, pathnames.length);
}

async function listSourceSubmissionPathnames(creds: Credentials): Promise<string[]> {
  const prefix = withBlobNamespace('family-review/submissions/');
  return collectPathnames(
    (cursor) =>
      list({ prefix, limit: LIST_PAGE_SIZE, cursor, token: creds.sourceToken }),
    MAX_LIST_PAGES,
  );
}

async function readSourceRecord(
  creds: Credentials,
  pathname: string,
): Promise<FamilyReviewSubmission | null> {
  try {
    const result = await get(pathname, sourceGetOptions(creds.sourceToken));
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return normalizeSubmissionRecord(JSON.parse(await new Response(result.stream).text()));
  } catch {
    return null;
  }
}

/* -- Object readers, one per credential -- */

/** Streams an object out of the SOURCE (public) store. */
function sourceReader(creds: Credentials): ObjectReader {
  return async (pathname) => {
    const result = await get(pathname, sourceGetOptions(creds.sourceToken));
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return result.stream;
  };
}

/** Streams an object out of the DESTINATION (private) store. */
function destReader(creds: Credentials): ObjectReader {
  return async (pathname) => {
    const result = await get(pathname, destGetOptions(creds.destToken));
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return result.stream;
  };
}

/* -- Copy + verify -- */

type CopyResult =
  | { ok: true; sourceSha256: string; result?: undefined; detail?: undefined }
  | { ok: false; result: AssetResult; detail?: string };

/**
 * Stream one asset from the source store into the destination store,
 * proving what was copied.
 *
 * Source bytes are addressed by PATHNAME + source token, never by the
 * blobUrl recorded on the record: the SDK derives the host from the
 * token's own store, so a stale, tampered, or foreign-store URL cannot
 * redirect the read.
 */
async function copyAssetStreaming(
  creds: Credentials,
  identity: AssetIdentity,
): Promise<CopyResult> {
  let source: Awaited<ReturnType<typeof get>>;
  try {
    source = await get(identity.pathname, sourceGetOptions(creds.sourceToken));
  } catch (err) {
    return { ok: false, result: 'source_read_failed', detail: errorCode(err) };
  }
  if (!source || source.statusCode !== 200 || !source.stream) {
    return { ok: false, result: 'source_read_failed', detail: 'not_readable' };
  }

  let metered: MeteredBody;
  try {
    metered = await meterAndSniff(source.stream, MAX_ASSET_BYTES);
  } catch (err) {
    return { ok: false, result: 'source_read_failed', detail: errorCode(err) };
  }

  // The BYTES decide the content type.
  const verdict = verifySourceType(metered.head, identity.mime);
  if (verdict.ok === false) {
    // Nothing will consume the metered body now, so cancel it: that
    // propagates to the upstream reader and releases the source
    // connection instead of leaving it open until GC.
    await metered.body.cancel().catch(() => {});
    return { ok: false, result: verdict.result, detail: verdict.detail };
  }
  const sniffed = { mime: verdict.mime };

  try {
    await put(identity.pathname, metered.body, {
      access: 'private',
      token: creds.destToken,
      addRandomSuffix: false,
      contentType: sniffed.mime,
      cacheControlMaxAge: 0,
      allowOverwrite: true,
      // Streamed body: multipart lets the SDK enforce the ceiling too,
      // as a second line of defence behind the metering transform.
      multipart: true,
      maximumSizeInBytes: MAX_ASSET_BYTES,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AssetTooLarge') {
      return { ok: false, result: 'too_large', detail: 'streaming ceiling exceeded' };
    }
    return { ok: false, result: 'dest_write_failed', detail: errorCode(err) };
  }

  let sourceStats: { size: number; sha256: string };
  try {
    sourceStats = await metered.settled;
  } catch (err) {
    if (err instanceof Error && err.name === 'AssetTooLarge') {
      return { ok: false, result: 'too_large', detail: 'streaming ceiling exceeded' };
    }
    return { ok: false, result: 'source_read_failed', detail: errorCode(err) };
  }

  // The record's declared size must match what actually streamed. A
  // divergence means the source object changed under us.
  if (sourceStats.size !== identity.size) {
    return {
      ok: false,
      result: 'size_mismatch',
      detail: `record says ${identity.size}, source streamed ${sourceStats.size}`,
    };
  }

  // Verify by reading BACK from the destination -- streamed, not buffered.
  let readBack: Awaited<ReturnType<typeof get>>;
  try {
    readBack = await get(identity.pathname, destGetOptions(creds.destToken));
  } catch (err) {
    return { ok: false, result: 'verify_failed', detail: errorCode(err) };
  }
  if (!readBack || readBack.statusCode !== 200 || !readBack.stream) {
    return { ok: false, result: 'verify_failed', detail: 'not_readable' };
  }
  if (readBack.blob.contentType !== sniffed.mime) {
    return { ok: false, result: 'verify_failed', detail: 'content_type_mismatch' };
  }

  let destStats: { size: number; sha256: string; head: Uint8Array };
  try {
    destStats = await digestStream(readBack.stream, MAX_ASSET_BYTES);
  } catch (err) {
    return { ok: false, result: 'verify_failed', detail: errorCode(err) };
  }
  if (destStats.size !== sourceStats.size) {
    return { ok: false, result: 'verify_failed', detail: 'size_mismatch' };
  }
  if (destStats.sha256 !== sourceStats.sha256) {
    return { ok: false, result: 'verify_failed', detail: 'hash_mismatch' };
  }
  // Re-sniff the DESTINATION object's own bytes, so the type check is
  // about content rather than about the header we just supplied.
  const destSniffed = sniffImageType(destStats.head);
  if (!destSniffed || destSniffed.mime !== sniffed.mime) {
    return { ok: false, result: 'verify_failed', detail: 'dest_content_type_unverified' };
  }

  return { ok: true, sourceSha256: sourceStats.sha256 };
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

/* -- Per-submission cutover -- */

async function migrateSubmission(
  creds: Credentials,
  record: FamilyReviewSubmission,
  apply: boolean,
): Promise<AssetOutcome[]> {
  const outcomes: AssetOutcome[] = [];
  const identities = assetIdentitiesOf(record);

  // An ambiguous record is refused outright: with a duplicated identity
  // key there is no single object a checkpoint could describe.
  const dupes = duplicateIdentityKeys(identities);
  if (dupes.length > 0) {
    console.error(
      `[migrate] refusing ${record.id}: duplicate asset identity ${dupes.join(', ')}`,
    );
    for (const id of identities) {
      outcomes.push({
        submissionId: record.id,
        assetId: id.assetId,
        kind: id.kind,
        result: 'verify_failed',
        detail: 'duplicate_asset_identity',
      });
    }
    return outcomes;
  }

  if (!apply) {
    for (const id of identities) {
      outcomes.push({
        submissionId: record.id,
        assetId: id.assetId,
        kind: id.kind,
        result: 'would_migrate',
      });
    }
    return outcomes;
  }

  const raw = await readRawCutoverState(creds, record.id);
  const shape = validateCutoverState(raw, record);
  if (shape.reasons.length > 0) {
    // Counts and reason codes only -- never the state contents.
    console.warn(
      `[migrate] cutover state for ${record.id} failed shape validation: ${shape.reasons.join(', ')}`,
    );
  }

  // Shape validation cannot see bytes. A source replaced in place with
  // same-length same-type content, a destination deleted or overwritten,
  // or an invented-but-well-formed hash all leave a checkpoint that
  // looks perfect. Re-prove every surviving entry against the CURRENT
  // bytes on both sides, through their own credentials, before any of it
  // is allowed to skip work.
  const revalidated = await revalidateCheckpoints({
    record,
    state: shape.state,
    readSource: sourceReader(creds),
    readDest: destReader(creds),
    maxBytes: MAX_ASSET_BYTES,
  });
  if (revalidated.reasons.length > 0) {
    console.warn(
      `[migrate] cutover state for ${record.id} revoked by byte revalidation: ${revalidated.reasons.join(', ')}`,
    );
  }
  const state = revalidated.state;

  // completedAt is honoured ONLY because BOTH gates just passed: shape
  // validation re-derived the binding, and byte revalidation re-proved
  // every asset against the current source and destination objects.
  if (state.completedAt) {
    for (const id of identities) {
      outcomes.push({
        submissionId: record.id,
        assetId: id.assetId,
        kind: id.kind,
        result: 'already_verified',
      });
    }
    return outcomes;
  }

  const pending = new Set(
    assetsNeedingCopy(identities, state).map((i) => assetIdentityKey(i)),
  );

  for (const identity of identities) {
    const key = assetIdentityKey(identity);
    if (!pending.has(key)) {
      outcomes.push({
        submissionId: record.id,
        assetId: identity.assetId,
        kind: identity.kind,
        result: 'already_verified',
      });
      continue;
    }

    const copied = await copyAssetStreaming(creds, identity);
    if (copied.ok === false) {
      outcomes.push({
        submissionId: record.id,
        assetId: identity.assetId,
        kind: identity.kind,
        result: copied.result,
        ...(copied.detail ? { detail: copied.detail } : {}),
      });
      continue;
    }

    // Checkpoint immediately, bound to this asset's full identity, so an
    // interruption on the NEXT asset does not recopy this one -- and a
    // later change to this one is not mistaken for it.
    state.assetsVerified = [
      ...state.assetsVerified.filter((v) => assetIdentityKey(v) !== key),
      { ...identity, sourceSha256: copied.sourceSha256 },
    ];
    await writeCutoverState(creds, state);

    outcomes.push({
      submissionId: record.id,
      assetId: identity.assetId,
      kind: identity.kind,
      result: 'migrated',
    });
  }

  // The record is written to the destination -- and metadata flipped to
  // storage:'private' -- ONLY when every asset is verified there.
  if (!recordIsReady(identities, state)) return outcomes;

  const next: FamilyReviewSubmission = {
    ...record,
    photos: {
      ...record.photos,
      assets: record.photos.assets.map(flipAssetToPrivate),
    },
    samples: record.samples.map(flipAssetToPrivate),
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

/* -- Main -- */

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

  let pathnames: string[];
  try {
    pathnames = await listSourceSubmissionPathnames(creds);
  } catch (err) {
    if (err instanceof EnumerationTruncatedError) {
      console.error(`\nREFUSING TO CONTINUE. ${err.message}.`);
      console.error(
        'Reporting a result over a partial enumeration would look exactly like a\n' +
          'completed migration while leaving records behind. Raise the page budget\n' +
          'or narrow the run with --submission=<id> before retrying.\n',
      );
      process.exit(5);
    }
    throw err;
  }

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
    console.log(`  ${result.padEnd(24)}: ${count}`);
  }

  const failures = outcomes.filter(
    (o) => !['would_migrate', 'migrated', 'already_verified'].includes(o.result),
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
    console.log('\nDry run only -- no destination object, record, or state was written.');
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
