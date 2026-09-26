/**
 * The record-level pointer to a frozen confirmation envelope (L-4 Slice A3-3).
 *
 * The A1 envelope holds the six provider request fields verbatim. Those are
 * customer content and they live in the dedicated private store (A3-2). What
 * stays on the public order record is THIS: a closed, non-PII reference with a
 * fixed key set, plus the strict validator that decides whether a candidate
 * value is one.
 *
 * The validator is the load-bearing half. `orders.ts` runs it on every
 * public-store write, and what it accepts is serialized into the public order
 * blob — as the fresh null-prototype object it materializes, never as the caller's object
 * (see `materializeConfirmationEmailEnvelopeRef`). It therefore refuses rather
 * than repairs, and it refuses on an exact key set rather than on a list of
 * known-bad keys: a subtractive rule would pass the next field somebody adds.
 *
 * This module is pure by contract. No storage, no network, no provider, no
 * credential read, no environment read, no clock, no log sink. Both the write
 * boundary and the operator projection depend on that: the projection runs
 * inside `admin-order-dto.ts`, which an accepted A3-1 guard holds to no
 * `process.env` and no I/O at all.
 */

/** The only storage this lane may name. A public store is not a value here. */
export const CONFIRMATION_ENVELOPE_REF_STORAGE_KIND = 'private_blob' as const;

export const CONFIRMATION_ENVELOPE_REF_VERSION = 1 as const;

/**
 * The non-PII reference that lives on `OrderRecord`.
 *
 * Every member is either integrity metadata that survives a purge, a
 * non-secret provider binding label, or the store key. There is deliberately
 * no `request`, no `idempotencyKey`, no `url` and no token: the first two are
 * customer/deduplication content that belong in the private object, and the
 * last two are credentials-adjacent values that must never reach a record a
 * customer-facing or operator surface can serialize.
 */
export interface ConfirmationEmailEnvelopeRefV1 {
  readonly envelopeVersion: typeof CONFIRMATION_ENVELOPE_REF_VERSION;
  readonly orderId: string;
  readonly templateVersion: string;
  /** Canonical ISO 8601 UTC instant, millisecond precision. */
  readonly createdAt: string;
  /** Lowercase hex sha256 over the canonical request bytes. Integrity only. */
  readonly canonicalDigest: string;
  readonly canonicalBytes: number;
  /** Provider binding label. Explicit operator data, never credential-derived. */
  readonly accountLabel: string;
  readonly storageKind: typeof CONFIRMATION_ENVELOPE_REF_STORAGE_KIND;
  /** Namespaced private-store key. Never a URL, and inert without the token. */
  readonly objectPath: string;
  /** Set when the private payload is purged; null while it is retained. */
  readonly purgedAt: string | null;
}

/**
 * The exact key set. Exported so a guard can assert it without restating it,
 * and so the allowlist is readable in one place.
 */
export const CONFIRMATION_ENVELOPE_REF_KEYS = [
  'envelopeVersion',
  'orderId',
  'templateVersion',
  'createdAt',
  'canonicalDigest',
  'canonicalBytes',
  'accountLabel',
  'storageKind',
  'objectPath',
  'purgedAt',
] as const;

/**
 * The non-PII view an operator surface may render for a valid ref.
 *
 * Exactly the eight fields the accepted A1 envelope projection already
 * allowlists (`confirmation-email-envelope.ts:263-275`). `storageKind` and
 * `objectPath` are deliberately NOT here: a store key is an internal locator,
 * it is not operator-actionable without the dedicated credential, and the
 * architecture's operator allowlist does not name it.
 */
export interface ConfirmationEmailOperatorView {
  envelopeVersion: typeof CONFIRMATION_ENVELOPE_REF_VERSION;
  orderId: string;
  templateVersion: string;
  createdAt: string;
  canonicalDigest: string;
  canonicalBytes: number;
  accountLabel: string;
  purgedAt: string | null;
}

export const CONFIRMATION_ENVELOPE_OPERATOR_VIEW_KEYS = [
  'envelopeVersion',
  'orderId',
  'templateVersion',
  'createdAt',
  'canonicalDigest',
  'canonicalBytes',
  'accountLabel',
  'purgedAt',
] as const;

/**
 * The order-id grammar and the object prefix, restated rather than imported.
 *
 * `confirmation-envelope-config.ts` restates the same grammar for the same
 * reason, and states it: the storage boundary must not depend on the order or
 * intake modules. The dependency here runs the other way and the constraint is
 * stronger — `admin-order-dto.ts` imports this module at run time, and an
 * accepted A3-1 guard requires that module to reach no storage, no
 * environment and no `@vercel/blob`. Importing the storage config would pull
 * `checkout-blob-identity.ts` and `confirmation-email-envelope.ts` into the
 * admin projection's module graph to obtain two constants.
 *
 * Drift is closed by test, not by hope:
 * `tests/confirmation-envelope-record-boundary.test.ts` asserts these three
 * constants against `confirmation-envelope-config.ts`'s own values and asserts
 * that `expectedConfirmationEnvelopeObjectPath` agrees with
 * `confirmationEnvelopeObjectPath` across namespaces.
 */
export const CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE = /^ord_[a-f0-9]{16}$/;

/** Mirror of `CONFIRMATION_ENVELOPE_PATH_PREFIX`. */
export const CONFIRMATION_ENVELOPE_REF_PATH_PREFIX = 'confirmation-envelopes';

/** Mirror of `CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes`. */
export const CONFIRMATION_ENVELOPE_REF_MAX_CANONICAL_BYTES = 327_680;

/** Mirror of `blob-namespace.ts`'s private `BLOB_NAMESPACE_RE`. */
const NAMESPACE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const LOWERCASE_HEX_SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * Printable ASCII, bounded.
 *
 * Both label fields are deployment metadata chosen by the producer, not
 * customer content. Refusing control characters and non-ASCII keeps a label
 * from carrying a newline into a log line or a bidi override into an operator
 * view, and the producer that will mint these (A3-4) does not exist yet, so
 * there is no stored value this can retroactively break.
 */
const REF_LABEL_RE = /^[\x20-\x7E]{1,256}$/;

/**
 * Keys that would mean request bytes, a deduplication identity, or a
 * credential-adjacent locator had reached the record.
 *
 * The exact-key rule below already refuses every one of these, because none is
 * in `CONFIRMATION_ENVELOPE_REF_KEYS`. This set exists so the refusal NAMES
 * that case instead of reporting a generic key-set mismatch — a write refused
 * for `ref_request_like_field` is an incident, and a write refused for
 * `ref_key_set` is usually a version skew.
 *
 * These are field NAMES, never values: nothing here is a credential or a
 * canary, and no value from the candidate record is read into a message.
 */
const REQUEST_LIKE_REF_KEYS: ReadonlySet<string> = new Set([
  'request',
  'from',
  'to',
  'subject',
  'html',
  'text',
  'replyTo',
  'idempotencyKey',
  'providerBinding',
  'url',
  'downloadUrl',
  'blobUrl',
  'token',
  'accessToken',
  'body',
  'headers',
  'email',
  'recipient',
]);

/**
 * Every way a candidate can fail to be a ref.
 *
 * A closed union of codes, and only codes. No member quotes a value, so a
 * refusal is safe to put in an error message, an audit reason or a log line.
 */
export type ConfirmationEnvelopeRefProblem =
  | 'ref_not_object'
  | 'ref_not_plain_data'
  | 'ref_request_like_field'
  | 'ref_key_set'
  | 'ref_envelope_version'
  | 'ref_order_id'
  | 'ref_order_id_mismatch'
  | 'ref_template_version'
  | 'ref_created_at'
  | 'ref_canonical_digest'
  | 'ref_canonical_bytes'
  | 'ref_account_label'
  | 'ref_storage_kind'
  | 'ref_object_path'
  | 'ref_purged_at';

/**
 * A canonical ISO instant, round-trip proven.
 *
 * `Date.parse` accepts a zone-less date-time and reads it in the HOST zone, so
 * the same stored string can mean two instants on two machines. Requiring the
 * value to reproduce itself through `toISOString()` admits only the absolute
 * UTC form, which is why every gate on this slice runs under both `TZ=UTC` and
 * `TZ=America/Chicago` and neither can disagree.
 */
function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * The one object key an order's envelope may occupy, for an already-resolved
 * namespace. An empty namespace means flat paths — the production default.
 *
 * The order id is validated BEFORE the key is built, exactly as
 * `confirmationEnvelopeObjectPath` does it: validating afterwards means a
 * separator or a traversal segment has already been concatenated in.
 */
export function expectedConfirmationEnvelopeObjectPath(
  orderId: string,
  namespace: string,
): string | null {
  if (!CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE.test(orderId)) return null;
  const key = `${CONFIRMATION_ENVELOPE_REF_PATH_PREFIX}/${orderId}/v1.json`;
  if (!namespace) return key;
  if (!NAMESPACE_SEGMENT_RE.test(namespace)) return null;
  return `${namespace}/${key}`;
}

/**
 * Is `objectPath` the exact key for this order, under SOME valid namespace?
 *
 * "Somewhere under the prefix" is explicitly not enough: the suffix must be the
 * whole remainder, so `confirmation-envelopes/<other>/v1.json`,
 * `.../v1.json.bak` and `a/b/confirmation-envelopes/<id>/v1.json` are all
 * refused. This is the namespace-agnostic form, used where the caller cannot
 * read the environment to resolve the namespace.
 */
function objectPathShapeProblem(
  objectPath: unknown,
  orderId: string,
): ConfirmationEnvelopeRefProblem | null {
  if (typeof objectPath !== 'string' || !objectPath) return 'ref_object_path';
  const flat = expectedConfirmationEnvelopeObjectPath(orderId, '');
  if (flat === null) return 'ref_object_path';
  if (objectPath === flat) return null;
  if (!objectPath.endsWith(`/${flat}`)) return 'ref_object_path';
  const namespace = objectPath.slice(0, objectPath.length - flat.length - 1);
  return NAMESPACE_SEGMENT_RE.test(namespace) ? null : 'ref_object_path';
}

/** The outcome of materializing a candidate: a fresh validated ref, or why not. */
export type ConfirmationEnvelopeRefMaterialization =
  | { readonly ok: true; readonly ref: ConfirmationEmailEnvelopeRefV1 }
  | { readonly ok: false; readonly problem: ConfirmationEnvelopeRefProblem };

/**
 * Read a candidate ONCE into a fresh null-prototype object, or refuse it.
 *
 * Own enumerable keys are NOT what `JSON.stringify` emits. It calls a `toJSON`
 * found anywhere on the prototype chain — or an own non-enumerable one — and
 * reads each member through [[Get]], so a getter or a proxy can answer
 * differently from whatever a validator saw. Deciding about the candidate
 * object therefore decides nothing about the stored bytes.
 *
 * So the candidate must be strict plain data, and it is copied rather than
 * trusted:
 *
 *   - its prototype is `Object.prototype` (what `JSON.parse` produces) or
 *     `null`, and no `toJSON` is reachable from it at all;
 *   - `Reflect.ownKeys` — which includes symbols and non-enumerable keys — is
 *     exactly the ten ref keys;
 *   - every one of the ten is an enumerable DATA property, read by descriptor,
 *     never through a getter.
 *
 * The ten descriptor values are copied into a null-prototype object, in the candidate's
 * own key order so a valid stored ref round-trips byte-identically. Every field
 * check afterwards runs on that object: the values judged are the values a
 * caller serializes, and the candidate is never read again. A value that
 * passes is a primitive, so nothing nested can carry a `toJSON` either.
 *
 * Total by construction: a revoked proxy, a throwing trap or any other
 * inspection failure is refused as `ref_not_plain_data`, never thrown.
 */
function materializeRefShape(
  value: unknown,
  ctx: { readonly orderId: string },
): ConfirmationEnvelopeRefMaterialization {
  let copy: Record<string, unknown>;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, problem: 'ref_not_object' };
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { ok: false, problem: 'ref_not_plain_data' };

    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key === 'string' && REQUEST_LIKE_REF_KEYS.has(key)) {
        return { ok: false, problem: 'ref_request_like_field' };
      }
    }
    if (keys.length !== CONFIRMATION_ENVELOPE_REF_KEYS.length) return { ok: false, problem: 'ref_key_set' };
    const allowed: ReadonlySet<unknown> = new Set(CONFIRMATION_ENVELOPE_REF_KEYS);
    for (const key of keys) {
      if (!allowed.has(key)) return { ok: false, problem: 'ref_key_set' };
    }
    // An own `toJSON`, enumerable or not, is already an extra key above. What
    // is left is one reachable through a permitted prototype: a polluted
    // `Object.prototype`, or a proxy's `has` trap.
    if ('toJSON' in value) return { ok: false, problem: 'ref_not_plain_data' };

    // The output must not inherit hooks installed before or during inspection.
    copy = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.enumerable !== true) {
        return { ok: false, problem: 'ref_not_plain_data' };
      }
      copy[key] = descriptor.value;
    }
  } catch {
    return { ok: false, problem: 'ref_not_plain_data' };
  }

  const problem = refFieldProblem(copy, ctx);
  return problem ? { ok: false, problem } : { ok: true, ref: copy as unknown as ConfirmationEmailEnvelopeRefV1 };
}

/** Field checks, on a fresh null-prototype object with own data properties. */
function refFieldProblem(
  ref: Record<string, unknown>,
  ctx: { readonly orderId: string },
): ConfirmationEnvelopeRefProblem | null {
  if (ref.envelopeVersion !== CONFIRMATION_ENVELOPE_REF_VERSION) return 'ref_envelope_version';

  if (typeof ref.orderId !== 'string' || !CONFIRMATION_ENVELOPE_REF_ORDER_ID_RE.test(ref.orderId)) {
    return 'ref_order_id';
  }
  // A ref is a pointer to THIS order's envelope. A ref carrying another
  // order's id on this record is a cross-order binding, not a typo, and the
  // dispatch fence would compare a digest against the wrong frozen request.
  if (ref.orderId !== ctx.orderId) return 'ref_order_id_mismatch';

  if (typeof ref.templateVersion !== 'string' || !REF_LABEL_RE.test(ref.templateVersion)) {
    return 'ref_template_version';
  }
  if (!isCanonicalIsoInstant(ref.createdAt)) return 'ref_created_at';
  if (typeof ref.canonicalDigest !== 'string' || !LOWERCASE_HEX_SHA256_RE.test(ref.canonicalDigest)) {
    return 'ref_canonical_digest';
  }
  if (
    typeof ref.canonicalBytes !== 'number'
    || !Number.isSafeInteger(ref.canonicalBytes)
    || ref.canonicalBytes <= 0
    || ref.canonicalBytes > CONFIRMATION_ENVELOPE_REF_MAX_CANONICAL_BYTES
  ) {
    return 'ref_canonical_bytes';
  }
  if (typeof ref.accountLabel !== 'string' || !REF_LABEL_RE.test(ref.accountLabel)) {
    return 'ref_account_label';
  }
  if (ref.storageKind !== CONFIRMATION_ENVELOPE_REF_STORAGE_KIND) return 'ref_storage_kind';

  const pathProblem = objectPathShapeProblem(ref.objectPath, ref.orderId);
  if (pathProblem) return pathProblem;

  // Presence, not truthiness: `undefined` is not `null`, and a tombstone whose
  // instant is unstated is not a tombstone.
  if (ref.purgedAt !== null && !isCanonicalIsoInstant(ref.purgedAt)) return 'ref_purged_at';

  return null;
}

/**
 * Validate a candidate ref without reading the environment.
 *
 * Returns the problem code, or `null` when the value is a structurally valid
 * `ConfirmationEmailEnvelopeRefV1` for `orderId`. This is the form the admin
 * projection uses: it cannot resolve a Blob namespace, because the A3-1 guard
 * holds `admin-order-dto.ts` to no `process.env` read at all. The write
 * boundary uses `validateConfirmationEmailEnvelopeRef` below, which adds the
 * exact-namespace check on top of this.
 */
export function validateConfirmationEmailEnvelopeRefShape(
  value: unknown,
  ctx: { readonly orderId: string },
): ConfirmationEnvelopeRefProblem | null {
  const result = materializeRefShape(value, ctx);
  return 'problem' in result ? result.problem : null;
}

/**
 * Materialize a candidate ref against a resolved Blob namespace.
 *
 * The write boundary uses this form: `objectPath` must equal the ONE key this
 * deployment would write for this order, not merely a well-shaped key under
 * some namespace. A record whose ref points into another environment's
 * namespace is refused rather than written, which is the same fail-closed
 * posture `getBlobNamespace` already takes for the order store itself.
 *
 * On success the returned `ref` is a fresh null-prototype object holding exactly the
 * validated values. A writer serializes THAT, never the candidate: the
 * candidate is whatever the caller handed in, and only the copy is proven to
 * stringify as ten primitive members.
 */
export function materializeConfirmationEmailEnvelopeRef(
  value: unknown,
  ctx: { readonly orderId: string; readonly namespace: string },
): ConfirmationEnvelopeRefMaterialization {
  const result = materializeRefShape(value, ctx);
  if ('problem' in result) return result;
  const expected = expectedConfirmationEnvelopeObjectPath(ctx.orderId, ctx.namespace);
  if (expected === null || result.ref.objectPath !== expected) {
    return { ok: false, problem: 'ref_object_path' };
  }
  return result;
}

/** Problem-code form of `materializeConfirmationEmailEnvelopeRef`. */
export function validateConfirmationEmailEnvelopeRef(
  value: unknown,
  ctx: { readonly orderId: string; readonly namespace: string },
): ConfirmationEnvelopeRefProblem | null {
  const result = materializeConfirmationEmailEnvelopeRef(value, ctx);
  return 'problem' in result ? result.problem : null;
}

/** Narrowing form of the shape validator, for callers that want the type. */
export function isConfirmationEmailEnvelopeRef(
  value: unknown,
  ctx: { readonly orderId: string },
): value is ConfirmationEmailEnvelopeRefV1 {
  return validateConfirmationEmailEnvelopeRefShape(value, ctx) === null;
}

/** A tombstone is a ref whose private payload is gone and whose identity is not. */
export function isConfirmationEmailEnvelopeRefTombstone(
  ref: ConfirmationEmailEnvelopeRefV1,
): boolean {
  return ref.purgedAt !== null;
}

/**
 * The only view of a ref an operator surface may render.
 *
 * An explicit allowlist in a fresh literal, not a redaction: a member added to
 * the ref later is invisible here until someone adds it, which is the same rule
 * the A1 envelope projection states for itself. `storageKind` and `objectPath`
 * stop here.
 *
 * The caller is responsible for having validated the ref first — every call
 * site in the candidate does, and `projectConfirmationEmailEnvelopeRefIfValid`
 * exists so that is not left to discipline.
 */
export function projectConfirmationEmailEnvelopeRefForOperator(
  ref: ConfirmationEmailEnvelopeRefV1,
): ConfirmationEmailOperatorView {
  return {
    envelopeVersion: ref.envelopeVersion,
    orderId: ref.orderId,
    templateVersion: ref.templateVersion,
    createdAt: ref.createdAt,
    canonicalDigest: ref.canonicalDigest,
    canonicalBytes: ref.canonicalBytes,
    accountLabel: ref.accountLabel,
    purgedAt: ref.purgedAt,
  };
}

/**
 * Validate, then project — or report absence.
 *
 * `null` for every case that is not a positively validated, non-tombstoned ref:
 * absent, `null`, a non-object, extra keys, a request-like key, any malformed
 * member, a foreign `orderId`, or a tombstone. There is no fallback branch that
 * returns the original object, and no partial view: the caller gets a complete
 * allowlisted view or nothing.
 *
 * A tombstone is omitted rather than rendered. The record still proves what was
 * frozen, but A3-3 adds no operator surface for a purged payload; whether one
 * is useful is a retention question that belongs to A3-7.
 *
 * The view is built from the materialized copy, so the candidate is read once
 * and a getter or proxy cannot answer the projection differently from the
 * validation.
 */
export function projectConfirmationEmailEnvelopeRefIfValid(
  value: unknown,
  ctx: { readonly orderId: string },
): ConfirmationEmailOperatorView | null {
  const result = materializeRefShape(value, ctx);
  if ('problem' in result) return null;
  if (isConfirmationEmailEnvelopeRefTombstone(result.ref)) return null;
  return projectConfirmationEmailEnvelopeRefForOperator(result.ref);
}
