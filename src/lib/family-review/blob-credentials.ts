/**
 * The Family Review lane's OWN Blob store credential.
 *
 * Why this module exists
 * ----------------------
 * `BLOB_READ_WRITE_TOKEN` is not the Family Review lane's token. It is
 * the whole application's token: `orders/<id>.json`, `orders/<id>/photo-*`,
 * `orders/<id>/*voice-*`, `payment-recovery/*.json`, and `recovery/*.json`
 * all live in the store it names.
 *
 * A Vercel Blob token is scoped to exactly one store, and a store is
 * created public or private and cannot be flipped. So the private
 * Family Review lane is a DIFFERENT store — and before this module, the
 * only way to point the runtime at it was to repoint the ambient token,
 * which would have taken every order, customer photo, voice note, and
 * recovery record with it into a store the migration never populated
 * (it copies only `{namespace}/family-review/submissions/`). See
 * docs/reviews/hsb-private-blob-rebound-20260827.md §4.
 *
 * So: in private mode the Family Review lane addresses its store with an
 * EXPLICIT token of its own, and every other lane keeps using the
 * ambient one, untouched.
 *
 * Which variable
 * --------------
 * `FAMILY_REVIEW_DEST_BLOB_TOKEN` — deliberately the same name the
 * migration already writes to. It names the migrated destination store,
 * it is already one of the five approved cutover variables, and reusing
 * it means the runtime and the migration cannot disagree about which
 * store "the private Family Review store" is. No sixth Production
 * variable is introduced.
 *
 * Fail closed
 * -----------
 * In private mode a missing, blank, or malformed credential is a hard
 * stop BEFORE any SDK call. There is no fallback to the ambient token
 * and no fallback to a public read: falling back would silently serve
 * the lane out of the public store while every operator signal said
 * "private".
 *
 * No value ever leaves this module. Callers receive the token to hand
 * straight to the SDK, or a problem STRING that names the variable and
 * the fault and never quotes the value.
 */

/** The single environment variable that names the private lane's store. */
export const FAMILY_REVIEW_PRIVATE_TOKEN_ENV = 'FAMILY_REVIEW_DEST_BLOB_TOKEN';

/**
 * The store id a Blob token is scoped to.
 *
 * Vercel Blob tokens are `vercel_blob_rw_<storeId>_<secret>`. The store
 * id is what makes two tokens the same store, so it — never the token —
 * is what may be compared or printed.
 *
 * Shared with `scripts/family-review-migrate-assets.ts` on purpose: if
 * the runtime and the migration disagreed about what a well-formed token
 * looks like, one of them would accept a credential the other refuses.
 * If Vercel ever changes the format, both stop parsing and both fail
 * closed together.
 */
export function blobStoreIdFromToken(token: string | undefined | null): string | null {
  if (typeof token !== 'string') return null;
  const match = token.trim().match(/^vercel_blob_rw_([A-Za-z0-9]+)_[A-Za-z0-9]+$/);
  return match ? match[1] : null;
}

/**
 * What is wrong with the private credential, or null when it is usable.
 *
 * Returns a message safe to log: it names the variable and the fault,
 * and never contains the value.
 */
export function familyReviewPrivateTokenProblem(
  raw: string | undefined = process.env[FAMILY_REVIEW_PRIVATE_TOKEN_ENV],
): string | null {
  if (typeof raw !== 'string' || !raw.trim()) {
    return `${FAMILY_REVIEW_PRIVATE_TOKEN_ENV} is not set`;
  }
  if (!blobStoreIdFromToken(raw)) {
    return `${FAMILY_REVIEW_PRIVATE_TOKEN_ENV} is not a well-formed Blob token`;
  }
  return null;
}

/** True when the private lane has a usable credential of its own. */
export function familyReviewPrivateTokenAvailable(): boolean {
  return familyReviewPrivateTokenProblem() === null;
}

/**
 * The private lane's token, or null when it is missing or malformed.
 *
 * Null is a STOP, never a signal to try something else. Every caller
 * turns it into a refusal — a 503 storage gate, an `AssetStorageError`,
 * or a `persisted: false` — without touching the ambient store.
 */
export function familyReviewPrivateToken(): string | null {
  const raw = process.env[FAMILY_REVIEW_PRIVATE_TOKEN_ENV];
  if (familyReviewPrivateTokenProblem(raw) !== null) return null;
  return (raw as string).trim();
}
