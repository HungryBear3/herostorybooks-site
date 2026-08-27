/**
 * THE single storage boundary for Family Review asset bytes.
 *
 * Every write, read, and delete of a reference photo or sample
 * illustration goes through this module. Routes never call
 * `@vercel/blob` for asset bytes directly, so the access mode, the
 * size bounds, and the "never fall back to public" rule are enforced
 * in exactly one place.
 *
 * ACCESS MODE. `FAMILY_REVIEW_BLOB_ACCESS` selects how NEW assets are
 * written:
 *
 *   'public'  (default) — today's behavior, unchanged.
 *   'private'           — `access: 'private'`; bytes are readable only
 *                         with the store token, and no URL is retained.
 *
 * The default is deliberately 'public'. The Production Blob store is
 * provisioned as a PUBLIC store and rejects private writes outright
 * (`BlobError: Cannot use private access on a public store`; see the
 * getBlobAccessMode note in src/lib/orders.ts). Merging this module
 * therefore changes no runtime behavior until an operator provisions a
 * private-capable store and flips the flag. See
 * docs/reviews/hsb-family-review-private-blob-2026-08-26.md §1.4.
 *
 * FAIL CLOSED. When the mode is 'private':
 *   - a failed private write throws; it is NEVER retried as a public
 *     write,
 *   - a failed private read throws; it is NEVER retried against a
 *     public URL, and no Blob URL is ever handed to a caller.
 *
 * LEGACY OBJECTS. Assets written before this change carry
 * `storage: 'public'` (or no storage field at all) and a public
 * `blobUrl`. They keep reading through the public URL so no existing
 * family is locked out — gated by
 * FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS so the lane can be made
 * private-only once migration completes.
 */

import { del, get, head, put } from '@vercel/blob';

/** How a single stored asset is addressed. */
export type AssetStorage = 'public' | 'private';

/**
 * Hard ceiling on any single asset read streamed back through a proxy.
 * Larger than both upload limits (10 MB parent photo, 15 MB admin
 * sample) so it can only ever catch a malformed or tampered object,
 * never a legitimate one.
 */
export const MAX_ASSET_READ_BYTES = 25 * 1024 * 1024;

/** Content types this lane will ever store or serve. */
const SERVEABLE_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const MIME_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/** Thrown for every storage failure so callers can fail closed uniformly. */
export class AssetStorageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AssetStorageError';
    this.code = code;
  }
}

/**
 * Access mode for NEW asset writes. Anything other than an explicit
 * 'private' is 'public' — an unset or misspelled value must not
 * silently select the mode the production store cannot serve.
 */
export function familyReviewAssetStorageMode(): AssetStorage {
  return process.env.FAMILY_REVIEW_BLOB_ACCESS === 'private'
    ? 'private'
    : 'public';
}

/**
 * Whether a legacy public-URL asset may still be read. Defaults to true
 * so migration can be gradual; set to '0' / 'off' / 'false' once every
 * asset carries storage:'private' to make the lane private-only.
 */
export function legacyPublicAssetReadsAllowed(): boolean {
  const raw = process.env.FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS;
  if (raw === undefined) return true;
  return !['0', 'off', 'false', 'no'].includes(raw.trim().toLowerCase());
}

/** The storage mode of a stored asset; absent field means legacy public. */
export function assetStorageOf(asset: { storage?: AssetStorage }): AssetStorage {
  return asset.storage === 'private' ? 'private' : 'public';
}

/** True iff this mime may be stored/served by the Family Review lane. */
export function isServeableMime(mime: string): boolean {
  return SERVEABLE_MIME.has(mime);
}

/**
 * The Content-Type a proxy is allowed to send.
 *
 * Derived from the mime recorded on the submission at upload time —
 * never from the upstream response — so a tampered or mislabeled stored
 * object cannot choose its own type. Anything not on the allowlist is
 * downgraded to a non-renderable type rather than trusted.
 */
export function serveableContentType(mime: string | undefined): string {
  return mime && isServeableMime(mime) ? mime : 'application/octet-stream';
}

/**
 * A safe `filename=` for Content-Disposition, derived from the stored
 * mime rather than hardcoded. Only characters from a fixed alphabet
 * reach the header, so no stored value can inject a header break or a
 * quote.
 */
export function safeDownloadFilename(stem: string, mime: string | undefined): string {
  const cleanStem = stem.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'asset';
  const ext = (mime && MIME_EXTENSION[mime]) || 'bin';
  return `${cleanStem}.${ext}`;
}

/** What a caller needs to open an asset's bytes. */
export interface AssetRef {
  blobPathname: string;
  blobUrl?: string;
  storage?: AssetStorage;
  mime?: string;
}

/** An opened asset: a stream plus the metadata safe to echo in headers. */
export interface OpenedAsset {
  stream: ReadableStream<Uint8Array>;
  /** Bytes, when the storage layer reported it. */
  size: number | null;
  storage: AssetStorage;
}

/**
 * Write asset bytes and return the durable reference.
 *
 * In private mode NO url is returned: `blobPathname` is the only
 * reference, and it is useless without the store token. That is what
 * makes the reference server-only.
 */
export async function putAsset(args: {
  pathname: string;
  bytes: Buffer | Uint8Array;
  mime: string;
}): Promise<{ blobPathname: string; blobUrl?: string; storage: AssetStorage }> {
  const storage = familyReviewAssetStorageMode();
  if (!isServeableMime(args.mime)) {
    throw new AssetStorageError(
      'unsupported_mime',
      'refusing to store a non-image content type',
    );
  }
  if (args.bytes.byteLength > MAX_ASSET_READ_BYTES) {
    throw new AssetStorageError('too_large', 'asset exceeds the storage ceiling');
  }

  if (storage === 'private') {
    // Fail closed: a private write that throws propagates. There is no
    // public retry here, by design.
    const result = await put(args.pathname, args.bytes as Buffer, {
      access: 'private',
      addRandomSuffix: false,
      contentType: args.mime,
      // No long-lived edge cache for private bytes.
      cacheControlMaxAge: 0,
      allowOverwrite: true,
    });
    return { blobPathname: result.pathname ?? args.pathname, storage: 'private' };
  }

  const result = await put(args.pathname, args.bytes as Buffer, {
    access: 'public',
    addRandomSuffix: false,
    contentType: args.mime,
    cacheControlMaxAge: 31536000,
    allowOverwrite: true,
  });
  return { blobPathname: args.pathname, blobUrl: result.url, storage: 'public' };
}

/**
 * Open an asset's bytes for streaming.
 *
 * Callers MUST have completed authorization before calling this — the
 * module deliberately takes no credential and makes no authorization
 * decision of its own.
 */
export async function openAsset(asset: AssetRef): Promise<OpenedAsset> {
  const storage = assetStorageOf(asset);

  if (storage === 'private') {
    let result: Awaited<ReturnType<typeof get>>;
    try {
      result = await get(asset.blobPathname, {
        access: 'private',
        useCache: false,
      });
    } catch (err) {
      throw new AssetStorageError(
        'private_read_failed',
        `private asset read failed: ${err instanceof Error ? err.name : 'unknown'}`,
      );
    }
    if (!result || result.statusCode !== 200 || !result.stream) {
      throw new AssetStorageError('not_found', 'private asset not readable');
    }
    const size = result.blob.size;
    if (typeof size === 'number' && size > MAX_ASSET_READ_BYTES) {
      throw new AssetStorageError('too_large', 'stored asset exceeds the read ceiling');
    }
    return { stream: result.stream, size: size ?? null, storage: 'private' };
  }

  if (!legacyPublicAssetReadsAllowed()) {
    throw new AssetStorageError(
      'legacy_reads_disabled',
      'legacy public asset reads are disabled',
    );
  }
  if (!asset.blobUrl) {
    throw new AssetStorageError('no_legacy_url', 'legacy asset has no URL to read');
  }
  let upstream: Response;
  try {
    upstream = await fetch(asset.blobUrl, { cache: 'no-store' });
  } catch {
    throw new AssetStorageError('upstream_failed', 'legacy asset fetch failed');
  }
  if (!upstream.ok || !upstream.body) {
    throw new AssetStorageError('upstream_failed', 'legacy asset fetch failed');
  }
  const declared = Number(upstream.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_ASSET_READ_BYTES) {
    throw new AssetStorageError('too_large', 'stored asset exceeds the read ceiling');
  }
  return {
    stream: upstream.body,
    size: Number.isFinite(declared) ? declared : null,
    storage: 'public',
  };
}

/**
 * Delete one asset, REPORTING the outcome.
 *
 * The previous best-effort helper swallowed every error and returned
 * void, so an admin delete could report success while bytes survived.
 */
export async function deleteAsset(
  pathname: string,
): Promise<{ deleted: boolean; reason?: string }> {
  try {
    await del(pathname);
    return { deleted: true };
  } catch (err) {
    return {
      deleted: false,
      reason: err instanceof Error ? err.name : 'unknown_error',
    };
  }
}

/** Metadata probe used by the migration's verification step. */
export async function statAsset(
  pathname: string,
): Promise<{ size: number; contentType: string } | null> {
  try {
    const result = await head(pathname);
    if (!result) return null;
    return { size: result.size, contentType: result.contentType };
  } catch {
    return null;
  }
}
