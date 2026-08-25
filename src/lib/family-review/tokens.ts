/**
 * Crypto-random id + token helpers for /family-review.
 *
 * Three distinct kinds of identifier:
 *
 *  - submissionId — the admin-facing primary key, and the path
 *    component of every persisted object for a submission
 *    (record JSON, reference photos, samples). Because those objects
 *    live in a PUBLIC Blob store in this lane, the pathname is the
 *    only thing standing between a stranger and the bytes, so the id
 *    must be a real capability: 16 crypto-random bytes (128 bits),
 *    base64url-encoded, with NO timestamp, counter, or ordering
 *    signal. The old `fr-{base36-ms}-{8-hex}` shape leaked submission
 *    time and carried only 32 random bits — see
 *    tests/family-review-token-privacy.test.ts.
 *
 *  - reviewToken — the PARENT's private capability URL component
 *    (/family-review/review/{reviewToken}). This is the only thing
 *    standing between any other parent and the current parent's
 *    submission, so it must be wide and crypto-random. We use
 *    24 random bytes → 32 url-safe base64 characters
 *    (~192 bits of entropy). The raw token is handed to the parent
 *    exactly once, in the creation response; it is NEVER persisted.
 *    Storage addresses it only through hashReviewToken().
 *
 *  - assetId — used inside Blob pathnames for both reference photos
 *    and admin-uploaded samples. 12 bytes of randomness keeps Blob
 *    paths short while remaining unguessable.
 *
 * crypto.randomUUID is intentionally NOT used for reviewToken — its 122
 * bits are fine cryptographically but the dashed shape is recognizable
 * and slightly leaks identifier class. Base64url is opaque.
 */
import { createHash, randomBytes } from 'node:crypto';

const SUBMISSION_PREFIX = 'fr';
const ASSET_PREFIX = 'a';

/** 16 bytes → 128 bits, the floor for a public-path capability id. */
const SUBMISSION_ID_BYTES = 16;
/** base64url length of SUBMISSION_ID_BYTES with padding stripped. */
const SUBMISSION_ID_CHARS = Math.ceil((SUBMISSION_ID_BYTES * 4) / 3);

function b64urlBytes(len: number): string {
  return randomBytes(len)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Opaque submission id: "fr-{22 base64url chars}" = 128 random bits.
 *
 * Deliberately NOT sortable. Admin "most recent" ordering comes from the
 * Blob object's own uploadedAt (see listRecentSubmissions), not from the
 * pathname, so nothing about submission time, order, or count is visible
 * to anyone who sees an id.
 */
export function newSubmissionId(): string {
  return `${SUBMISSION_PREFIX}-${b64urlBytes(SUBMISSION_ID_BYTES)}`;
}

/**
 * Parent-private review token. ~192 bits crypto random; the parent's
 * URL is the only credential, so width matters.
 */
export function newReviewToken(): string {
  return b64urlBytes(24);
}

/**
 * Deterministic, preimage-resistant address for a review token.
 *
 * Token indexes are keyed by this digest so the raw token never appears
 * in a Blob pathname and never has to be persisted. The token carries
 * ~192 bits, so the digest is not brute-forceable back to the token.
 */
export function hashReviewToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
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

/** sha256 hex, the only shape a token index is ever keyed by. */
export function isWellFormedReviewTokenHash(value: string): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Accepts BOTH shapes:
 *
 *   - new:    fr-{22 base64url chars}
 *   - legacy: fr-{base36-ms}-{8-hex}   (bounded compatibility — records
 *             created before the Lane B hardening must stay routable
 *             for admin and parent access)
 */
export function isWellFormedSubmissionId(value: string): boolean {
  if (typeof value !== 'string') return false;
  const newShape = new RegExp(
    `^${SUBMISSION_PREFIX}-[A-Za-z0-9_-]{${SUBMISSION_ID_CHARS}}$`,
  );
  if (newShape.test(value)) return true;
  return /^fr-[a-z0-9]{1,12}-[a-z0-9]{4,16}$/i.test(value);
}

export function isWellFormedAssetId(value: string): boolean {
  return typeof value === 'string' && /^a-[A-Za-z0-9_-]{12,32}$/.test(value);
}
