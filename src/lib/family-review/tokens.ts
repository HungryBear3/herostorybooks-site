/**
 * Crypto-random id + token helpers for /family-review.
 *
 * Two distinct kinds of identifier:
 *
 *  - submissionId — used as the admin-facing primary key and in
 *    admin-only URLs (e.g. /api/family-review/admin/submissions/{id}/...).
 *    Short and base32 is fine; admin routes are gated by
 *    FAMILY_REVIEW_ADMIN_KEY so guessability isn't the only defense.
 *
 *  - reviewToken — the PARENT's private capability URL component
 *    (/family-review/review/{reviewToken}). This is the only thing
 *    standing between any other parent and the current parent's
 *    submission, so it must be wide and crypto-random. We use
 *    24 random bytes → 32 url-safe base64 characters
 *    (~192 bits of entropy).
 *
 *  - assetId — used inside Blob pathnames for both reference photos
 *    and admin-uploaded samples. 12 bytes of randomness keeps Blob
 *    paths short while remaining unguessable.
 *
 * crypto.randomUUID is intentionally NOT used for reviewToken — its 122
 * bits are fine cryptographically but the dashed shape is recognizable
 * and slightly leaks identifier class. Base64url is opaque.
 */
import { randomBytes, randomUUID } from 'node:crypto';

const SUBMISSION_PREFIX = 'fr';
const ASSET_PREFIX = 'a';

function b64urlBytes(len: number): string {
  return randomBytes(len)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sortable-ish submission id: "fr-{base36-ms}-{8-char-rand}". The
 * timestamp half keeps Blob listings stable-ordered for admin pagination
 * without leaking submission count; the rand half is crypto-random.
 */
export function newSubmissionId(now: Date = new Date()): string {
  const ts = now.getTime().toString(36);
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${SUBMISSION_PREFIX}-${ts}-${rand}`;
}

/**
 * Parent-private review token. ~192 bits crypto random; the parent's
 * URL is the only credential, so width matters.
 */
export function newReviewToken(): string {
  return b64urlBytes(24);
}

/** Random asset id for a single photo or sample. ~96 bits. */
export function newAssetId(): string {
  return `${ASSET_PREFIX}-${b64urlBytes(12)}`;
}

/**
 * Cheap shape validation — `[A-Za-z0-9_-]` chars only and within a
 * sensible length window. Callers that take ids from URLs should call
 * this BEFORE looking them up in Blob to keep the path safe.
 */
export function isWellFormedReviewToken(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(value);
}

export function isWellFormedSubmissionId(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^fr-[a-z0-9]{1,12}-[a-z0-9]{4,16}$/i.test(value)
  );
}

export function isWellFormedAssetId(value: string): boolean {
  return typeof value === 'string' && /^a-[A-Za-z0-9_-]{12,32}$/.test(value);
}
