/**
 * Blob credential identity.
 *
 * "These two stores must be different" was previously checked by comparing
 * whole token STRINGS. That check passes for two different credentials issued
 * for the same Vercel Blob store — different strings, one store — which is
 * exactly the misconfiguration it was supposed to catch.
 *
 * A Vercel Blob read-write token is `vercel_blob_rw_<storeId>_<secret>`, and
 * the SDK itself derives the store id the same way (`token.split('_')[3]`).
 * Identity is therefore the store id; the secret is irrelevant to it.
 *
 * Nothing here ever puts token bytes into an error message, a return value or
 * a log line — a credential that fails validation is exactly the credential
 * most likely to be pasted into an incident channel.
 */

export class BlobTokenError extends Error {
  readonly code = 'BlobTokenError';
  /** Which credential failed, by role — never the value. */
  readonly label: string;

  constructor(label: string, detail: string) {
    super(`${label} Blob credential ${detail}`);
    this.name = 'BlobTokenError';
    this.label = label;
  }
}

export interface ParsedBlobToken {
  /** The Vercel Blob store this credential addresses. */
  storeId: string;
}

const TOKEN_PREFIX = 'vercel_blob_rw_';
const SEGMENT_RE = /^[A-Za-z0-9]+$/;
const MIN_STORE_ID = 8;
const MIN_SECRET = 8;

/**
 * Validates the shape of a Vercel Blob read-write token and returns only its
 * store id.
 *
 * Shape validation is intentionally structural, not a guess at Vercel's
 * alphabet beyond "alphanumeric segments": a credential that does not split
 * into `vercel_blob_rw_<storeId>_<secret>` cannot have its store identity
 * determined, and a store identity we cannot determine must not be treated as
 * distinct from anything.
 */
export function parseBlobToken(token: unknown, label: string): ParsedBlobToken {
  if (typeof token !== 'string' || !token.trim()) {
    throw new BlobTokenError(label, 'is missing');
  }
  const value = token.trim();
  if (!value.startsWith(TOKEN_PREFIX)) {
    throw new BlobTokenError(label, 'does not have the expected vercel_blob_rw_ prefix');
  }
  const segments = value.split('_');
  // vercel | blob | rw | storeId | secret
  if (segments.length !== 5) {
    throw new BlobTokenError(label, 'does not have the expected <storeId>_<secret> shape');
  }
  const storeId = segments[3]!;
  const secret = segments[4]!;
  if (!SEGMENT_RE.test(storeId) || storeId.length < MIN_STORE_ID) {
    throw new BlobTokenError(label, 'has an unusable store id');
  }
  if (!SEGMENT_RE.test(secret) || secret.length < MIN_SECRET) {
    throw new BlobTokenError(label, 'has an unusable secret segment');
  }
  return { storeId };
}

/**
 * Refuses a configuration in which two roles address the same Blob store,
 * whatever their secrets are.
 *
 * Entries with no token configured are skipped: "not configured" is a
 * different failure, raised by whichever role actually requires it.
 */
export function assertDistinctBlobStores(
  entries: readonly { label: string; token: unknown }[],
): void {
  const byStore = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry.token !== 'string' || !entry.token.trim()) continue;
    const { storeId } = parseBlobToken(entry.token, entry.label);
    const existing = byStore.get(storeId);
    if (existing && existing !== entry.label) {
      throw new BlobTokenError(
        entry.label,
        `addresses the same Blob store as the ${existing} credential; these must be separate stores`,
      );
    }
    byStore.set(storeId, entry.label);
  }
}
