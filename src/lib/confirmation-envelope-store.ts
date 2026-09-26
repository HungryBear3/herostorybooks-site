/**
 * The dedicated private confirmation-envelope store (L-4 Slice A3-2).
 *
 * One immutable JSON object per order, holding the complete frozen
 * `ConfirmationEmailEnvelopeV1`, in a Blob store that is not the public order
 * store and not any other HSB lane's store.
 *
 * Inert by construction
 * ---------------------
 * Nothing in the order, checkout, webhook, confirmation, sweep, admin or
 * customer paths imports this module. A3-2 adds no producer, no dispatcher,
 * no route, no cron and no caller; the snapshot producer is A3-4 and the
 * frozen dispatch is A3-5. Until then this module writes nothing, because
 * nothing calls it.
 *
 * Positive private-store evidence
 * -------------------------------
 * `@vercel/blob@2.3.3` exposes no store access mode: neither `PutBlobResult`
 * nor `HeadBlobResult` carries `access`, so "a token is configured" and "a
 * head succeeded" are evidence of nothing. The evidence here is behavioural
 * and has two tiers.
 *
 * Tier 1, always on and costing no extra I/O: every write is
 * `access: 'private'` against the dedicated credential, and a PUBLIC store
 * REJECTS that call ("Cannot use private access on a public store" — the same
 * failure documented in `src/lib/orders.ts` and `src/lib/story-media-store.ts`).
 * So a write that succeeds is itself proof that the store accepted a private
 * write, obtained at the exact boundary that matters, and a write that fails
 * is a hard stop: no public retry, no ambient-token retry, no second attempt
 * against anything else.
 *
 * Tier 2, operator-invoked and never per-request: Tier 1 proves the store is
 * private-CAPABLE. It does not by itself prove an unauthenticated reader
 * cannot fetch the object. `scripts/probe-confirmation-envelope-store.ts`
 * closes that with a non-PII object whose decisive arm is an unauthenticated
 * fetch that must not return 200. That probe has NOT been run; a configured
 * credential remains evidence of nothing until it has.
 *
 * What never crosses this boundary
 * --------------------------------
 * Token bytes. `url` and `downloadUrl` from any SDK result — discarded at the
 * call site, never returned, persisted, logged or projected. SDK error
 * messages, stacks and properties. Raw payload fragments. Every operation
 * returns a discriminated result whose failure arm is a single closed
 * `ConfirmationEnvelopeStorageRefusal` member and nothing else, and no
 * operation throws.
 *
 * No enumeration
 * --------------
 * This module never imports or calls `list`. Recovery and purge enumerate from
 * ORDER RECORDS, which carry the object path; a store with an
 * enumerate-then-read path is a store whose credential leaks every buyer's
 * envelope at once.
 */

import { del, get, put } from '@vercel/blob';

import {
  CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES,
  CONFIRMATION_ENVELOPE_READ_OPTIONS,
  CONFIRMATION_ENVELOPE_WRITE_OPTIONS,
  confirmationEnvelopeObjectPath,
  resolveConfirmationEnvelopeStoreCredential,
  type ConfirmationEnvelopeStorageRefusal,
} from './confirmation-envelope-config.ts';
import {
  CONFIRMATION_ENVELOPE_VERSION,
  digestConfirmationRequest,
  type ConfirmationEmailEnvelopeV1,
  type ConfirmationEmailRequestV1,
} from './confirmation-email-envelope.ts';

export type { ConfirmationEnvelopeStorageRefusal } from './confirmation-envelope-config.ts';

/**
 * The narrow SDK seam. Production passes nothing; tests inject adapters that
 * record the pathname and the exact options each call carried.
 */
export interface ConfirmationEnvelopeStoreIo {
  put?: typeof put;
  get?: typeof get;
  del?: typeof del;
}

export type ConfirmationEnvelopeStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ConfirmationEnvelopeStorageRefusal };

/**
 * The only reference that leaves a write.
 *
 * `objectPath` is the namespaced store key — not a URL, and inert without the
 * dedicated credential. It is what A3-3's record-level
 * `ConfirmationEmailEnvelopeRefV1` will carry, and it is deliberately the
 * value this module computed rather than anything the SDK echoed back.
 */
export interface ConfirmationEnvelopeObjectRef {
  readonly objectPath: string;
  readonly storedBytes: number;
}

export interface ConfirmationEnvelopeStore {
  /**
   * Write one envelope object, write-once.
   *
   * `serialized` is the caller's ALREADY-CANONICAL serialization and is stored
   * byte-for-byte: no trim, no normalization, no reformatting, no
   * reconstruction. A canonicalizer that rewrote these bytes would describe a
   * document the digest fence was never computed over.
   */
  write(
    orderId: string,
    serialized: string,
  ): Promise<ConfirmationEnvelopeStoreResult<ConfirmationEnvelopeObjectRef>>;

  /** Read, bound, parse, validate and digest-verify one envelope object. */
  read(
    orderId: string,
  ): Promise<ConfirmationEnvelopeStoreResult<ConfirmationEmailEnvelopeV1>>;

  /** Remove one envelope object. Absent is success; the store is idempotent. */
  delete(orderId: string): Promise<ConfirmationEnvelopeStoreResult<null>>;
}

// ---------------------------------------------------------------------------
// SDK failure classification — internal only
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  // Deliberately defensive: an SDK error's `message` getter is still a getter,
  // and a thrown non-Error is still throwable. Nothing read here escapes the
  // module; it only selects a closed refusal member.
  try {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
  } catch {
    return '';
  }
}

/**
 * A public store refusing a private write.
 *
 * Matched on the SDK's message because the SDK gives no other handle: this
 * failure arrives as a generic `BlobError` carrying the API's `bad_request`
 * text, not as a distinct class. The match is narrow and the fallback is
 * `write_failed`, so an unrecognised failure is still a refusal — never a
 * success, and never a retry against another store.
 */
function isPrivateAccessRejected(text: string): boolean {
  return /private access on a public store/i.test(text);
}

/** `allowOverwrite: false` meeting an object that is already there. */
function isAlreadyExists(text: string): boolean {
  return /already exists|blob.*exist|\b409\b|conflict/i.test(text);
}

function isNotFound(text: string): boolean {
  return /BlobNotFound|not ?found|\b404\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Bounded reading and validation
// ---------------------------------------------------------------------------

/**
 * Buffer a stream under a hard ceiling.
 *
 * Returns null once the ceiling is passed, WITHOUT retaining the overflowing
 * bytes: an unbounded read of an attacker- or corruption-controlled object is
 * a memory fault, and a bounded read that still kept the bytes to report their
 * size would be the same fault with extra steps.
 */
async function readTextUnderLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        overflowed = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    // Releasing before cancel would make cancel throw on a locked stream.
    try {
      await reader.cancel();
    } catch {
      // Already closed or errored; nothing to release.
    }
  }
  if (overflowed) return null;
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateRequest(value: unknown): ConfirmationEmailRequestV1 | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const { from, to, subject, html, text, replyTo } = raw;
  if (!isNonEmptyString(from)) return null;
  if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== 'string') return null;
  if (typeof subject !== 'string') return null;
  if (typeof html !== 'string') return null;
  if (typeof text !== 'string') return null;
  if (typeof replyTo !== 'string') return null;
  // Rebuilt field by field, as an explicit allowlist: a key added to the
  // stored document later is invisible here until someone deliberately adds
  // it, and no unvalidated property rides out on a spread.
  return { from, to: [to[0]], subject, html, text, replyTo };
}

/**
 * Turn a parsed document into a validated envelope, or null.
 *
 * A well-formed TOMBSTONE — `request: null`, the shape a purge produces — is
 * refused here rather than returned. A3-2 implements no retention policy and
 * therefore has no tombstone-aware read to hand a caller; a digest cannot be
 * recomputed over a payload that is gone, so returning one would mean handing
 * back an envelope this module could not verify. A3-7 owns the retention
 * lifecycle and the tombstone-aware read that goes with it. This is a named
 * residual, not an oversight.
 */
function validateEnvelope(
  value: unknown,
  expectedOrderId: string,
): ConfirmationEmailEnvelopeV1 | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.envelopeVersion !== CONFIRMATION_ENVELOPE_VERSION) return null;
  if (raw.orderId !== expectedOrderId) return null;
  if (!isNonEmptyString(raw.templateVersion)) return null;
  if (!isNonEmptyString(raw.createdAt)) return null;
  if (!isNonEmptyString(raw.idempotencyKey)) return null;
  if (!isNonEmptyString(raw.canonicalDigest)) return null;
  if (!Number.isSafeInteger(raw.canonicalBytes) || (raw.canonicalBytes as number) < 0) return null;
  if (raw.purgedAt !== null && !isNonEmptyString(raw.purgedAt)) return null;

  const binding = raw.providerBinding;
  if (!binding || typeof binding !== 'object') return null;
  const accountLabel = (binding as Record<string, unknown>).accountLabel;
  if (!isNonEmptyString(accountLabel)) return null;

  const request = validateRequest(raw.request);
  if (!request) return null;

  return {
    envelopeVersion: CONFIRMATION_ENVELOPE_VERSION,
    orderId: raw.orderId,
    templateVersion: raw.templateVersion,
    createdAt: raw.createdAt,
    idempotencyKey: raw.idempotencyKey,
    providerBinding: { accountLabel },
    request,
    canonicalDigest: raw.canonicalDigest,
    canonicalBytes: raw.canonicalBytes as number,
    purgedAt: (raw.purgedAt as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * Construct the store, or refuse.
 *
 * Construction is where the credential and the namespace are resolved, ONCE.
 * A namespace misconfiguration must stop the store existing rather than
 * surface later as a path that silently went flat and landed a Preview
 * envelope in the production keyspace.
 */
export function createConfirmationEnvelopeStore(
  env: NodeJS.ProcessEnv = process.env,
  io: ConfirmationEnvelopeStoreIo = {},
): ConfirmationEnvelopeStoreResult<ConfirmationEnvelopeStore> {
  const resolved = resolveConfirmationEnvelopeStoreCredential(env);
  // `=== false`, not `!resolved.ok`: strictNullChecks is off repository-wide
  // and a boolean-literal discriminant narrows only on an explicit compare.
  if (resolved.ok === false) return { ok: false, refusal: resolved.refusal };

  const { token, namespace } = resolved.credential;
  const putImpl = io.put ?? put;
  const getImpl = io.get ?? get;
  const delImpl = io.del ?? del;

  const store: ConfirmationEnvelopeStore = {
    async write(orderId, serialized) {
      const objectPath = confirmationEnvelopeObjectPath(orderId, namespace);
      if (!objectPath) return { ok: false, refusal: 'path_invalid' };

      const storedBytes = Buffer.byteLength(serialized, 'utf8');
      if (storedBytes > CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES) {
        return { ok: false, refusal: 'too_large' };
      }

      // Validate WHAT is about to be stored without touching the bytes that
      // will be stored. An object that could not survive its own read fence is
      // refused now, at the only moment refusing is free; the write below
      // still hands the SDK the caller's original string, unaltered.
      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        return { ok: false, refusal: 'invalid_object' };
      }
      const envelope = validateEnvelope(parsed, orderId);
      if (!envelope) return { ok: false, refusal: 'invalid_object' };
      if (digestConfirmationRequest(envelope.request!) !== envelope.canonicalDigest) {
        return { ok: false, refusal: 'digest_mismatch' };
      }

      try {
        // The dedicated credential, and no fallback. The SDK would otherwise
        // resolve the ambient BLOB_READ_WRITE_TOKEN, which names the PUBLIC
        // order store.
        await putImpl(objectPath, serialized, {
          ...CONFIRMATION_ENVELOPE_WRITE_OPTIONS,
          token,
        });
      } catch (error) {
        const text = errorText(error);
        if (isPrivateAccessRejected(text)) {
          // The store is public. There is no retry here, by design: retrying
          // publicly is how customer content reaches an anonymous URL.
          return { ok: false, refusal: 'store_not_private' };
        }
        if (isAlreadyExists(text)) return { ok: false, refusal: 'object_exists' };
        return { ok: false, refusal: 'write_failed' };
      }

      // The SDK result carries `url` and `downloadUrl`. Both are discarded
      // here, unread. Only the path this module computed leaves the boundary.
      return { ok: true, value: { objectPath, storedBytes } };
    },

    async read(orderId) {
      const objectPath = confirmationEnvelopeObjectPath(orderId, namespace);
      if (!objectPath) return { ok: false, refusal: 'path_invalid' };

      let result: Awaited<ReturnType<typeof get>> | null;
      try {
        result = await getImpl(objectPath, { ...CONFIRMATION_ENVELOPE_READ_OPTIONS, token });
      } catch (error) {
        return { ok: false, refusal: isNotFound(errorText(error)) ? 'not_found' : 'read_failed' };
      }

      if (!result) return { ok: false, refusal: 'not_found' };
      const statusCode: number = result.statusCode;
      if (statusCode === 404) return { ok: false, refusal: 'not_found' };
      if (statusCode !== 200 || !result.stream) return { ok: false, refusal: 'read_failed' };

      // Bound BEFORE buffering where the metadata allows it, and again while
      // buffering where it does not: a size header is the store's claim, not
      // a guarantee about the bytes that follow.
      const declaredSize = result.blob?.size;
      if (typeof declaredSize === 'number' && declaredSize > CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES) {
        return { ok: false, refusal: 'too_large' };
      }

      let text: string | null;
      try {
        text = await readTextUnderLimit(result.stream, CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES);
      } catch {
        return { ok: false, refusal: 'read_failed' };
      }
      if (text === null) return { ok: false, refusal: 'too_large' };

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, refusal: 'invalid_object' };
      }

      const envelope = validateEnvelope(parsed, orderId);
      if (!envelope) return { ok: false, refusal: 'invalid_object' };

      // The integrity fence. A stored document whose request does not hash to
      // its own recorded digest is refused, never returned: dispatching it
      // would present a body under an idempotency key the provider may
      // already have accepted for a different body.
      if (digestConfirmationRequest(envelope.request!) !== envelope.canonicalDigest) {
        return { ok: false, refusal: 'digest_mismatch' };
      }

      return { ok: true, value: envelope };
    },

    async delete(orderId) {
      const objectPath = confirmationEnvelopeObjectPath(orderId, namespace);
      if (!objectPath) return { ok: false, refusal: 'path_invalid' };
      try {
        await delImpl(objectPath, { token });
      } catch (error) {
        // Absent is success. A delete that must be retried after a partial
        // failure cannot be blocked by the first attempt having worked.
        if (isNotFound(errorText(error))) return { ok: true, value: null };
        return { ok: false, refusal: 'delete_failed' };
      }
      return { ok: true, value: null };
    },
  };

  return { ok: true, value: store };
}
