/**
 * The dedicated private confirmation-envelope store's credential, namespace,
 * path grammar and refusal vocabulary (L-4 Slice A3-2).
 *
 * Why a store of its own
 * ----------------------
 * A frozen confirmation envelope carries the six fields the provider will
 * receive — `from`, `to`, `subject`, `html`, `text`, `replyTo` — and those are
 * customer content. The order store named by `BLOB_READ_WRITE_TOKEN` is a
 * PUBLIC Vercel Blob store whose objects are fetched unauthenticated
 * (`src/lib/orders.ts`), and a Vercel Blob store is created public or private
 * and cannot be flipped. Every other private HSB lane was evaluated and
 * rejected structurally: the intake credential is deliberately projected into
 * a browser as a client upload token, story media is under a closed
 * path-classification allowlist whose rollback throws on an unclassifiable
 * object, the guard store is a rate-limit keyspace, and Family Review is a
 * separate product lane that still permits legacy public reads. So the
 * envelope addresses a SEPARATE store with an EXPLICIT credential of its own.
 *
 * This module is pure by contract. It reads an environment, it parses, it
 * validates, and it returns either a resolved credential or a closed refusal.
 * It performs no I/O, imports no SDK, and has no log sink.
 *
 * Fail closed
 * -----------
 * A missing, malformed, or store-colliding credential, and an unresolvable
 * namespace, are hard stops BEFORE any SDK call. There is no fallback to the
 * ambient token: falling back is exactly how a retained outbound provider
 * request would end up at an anonymously readable URL.
 *
 * No value ever leaves this module. Callers receive the credential to hand
 * straight to the SDK, a closed refusal member, or a problem STRING that names
 * the variable and the fault and never quotes the value — a credential that
 * fails validation is the one most likely to be pasted into an incident
 * channel.
 */

import { applyBlobNamespace, getBlobNamespace } from './blob-namespace.ts';
import { assertDistinctBlobStores, parseBlobToken } from './checkout-blob-identity.ts';
import { CONFIRMATION_ENVELOPE_LIMITS } from './confirmation-email-envelope.ts';

/** The single environment variable that names the private envelope store. */
export const CONFIRMATION_ENVELOPE_TOKEN_ENV = 'HSB_CONFIRMATION_ENVELOPE_BLOB_TOKEN';

/**
 * The writer flag. Default-off, and the ONLY value that arms it is the exact
 * literal `true` — the repository's established convention for an enabling
 * flag (`HSB_CHECKOUT_DIRECT_UPLOAD_SERVER`,
 * `HSB_STORY_MEDIA_DIRECT_RETIREMENT_CONFIRMED`). A typo, `1`, `yes`,
 * `enabled`, or any other noncanonical spelling leaves the writer off, which
 * is the safe direction: an unarmed writer stores nothing.
 *
 * A3-2 adds no application caller, so nothing reads this flag at runtime yet.
 * It exists now because the build gate must be able to tell "Production
 * intends to write envelopes" from "Production does not", and that intent has
 * to be expressed somewhere before the producer lands in A3-4.
 */
export const CONFIRMATION_ENVELOPE_WRITER_ENV = 'HSB_CONFIRMATION_ENVELOPE_WRITER';

/** Every other HSB Blob lane the envelope store must not share a store with. */
export const CONFIRMATION_ENVELOPE_PEER_TOKEN_ENVS = {
  order: 'BLOB_READ_WRITE_TOKEN',
  intake: 'HSB_INTAKE_BLOB_READ_WRITE_TOKEN',
  guard: 'HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN',
  'story-media': 'HSB_PRIVATE_READ_WRITE_TOKEN',
  'family-review': 'FAMILY_REVIEW_DEST_BLOB_TOKEN',
} as const;

/**
 * Every operator-visible failure of the envelope storage boundary.
 *
 * Closed on purpose. No SDK message, no stack, no error property, no token
 * byte, no Blob URL and no request fragment ever crosses the module boundary;
 * a caller receives one of these members and nothing else.
 *
 * `invalid_object` covers every way a stored object fails to be a complete,
 * digest-verifiable `ConfirmationEmailEnvelopeV1` — unparseable JSON, a wrong
 * shape, an order-id binding mismatch, and (deliberately, see
 * `confirmation-envelope-store.ts`) a tombstone whose payload is already gone.
 * A3-2 implements no retention policy, so it has no tombstone-aware read to
 * distinguish; A3-7 owns that.
 */
export type ConfirmationEnvelopeStorageRefusal =
  | 'store_unconfigured'
  | 'store_not_dedicated'
  | 'namespace_invalid'
  | 'path_invalid'
  | 'store_not_private'
  | 'object_exists'
  | 'not_found'
  | 'read_failed'
  | 'write_failed'
  | 'delete_failed'
  | 'invalid_object'
  | 'too_large'
  | 'digest_mismatch';

/**
 * The resolved credential. It exists only inside the storage module: nothing
 * derived from it — not the token, not the store id — is returned, logged, or
 * projected by any store operation.
 */
export interface ConfirmationEnvelopeStoreCredential {
  readonly token: string;
  /** Resolved ONCE, here, so a namespace fault stops the store existing. */
  readonly namespace: string;
}

export type ConfirmationEnvelopeConfigResult =
  | { readonly ok: true; readonly credential: ConfirmationEnvelopeStoreCredential }
  | { readonly ok: false; readonly refusal: ConfirmationEnvelopeStorageRefusal };

/**
 * The order-id grammar, identical to the checkout grammar
 * (`CHECKOUT_ORDER_ID` / `ORDER_ID_RE`). Restated rather than imported so the
 * storage boundary does not depend on the order or intake modules: the whole
 * point of this slice is a store nothing in the application reaches into.
 */
export const CONFIRMATION_ENVELOPE_ORDER_ID_RE = /^ord_[a-f0-9]{16}$/;

/** The one object prefix this lane owns. */
export const CONFIRMATION_ENVELOPE_PATH_PREFIX = 'confirmation-envelopes';

/**
 * A fixed allowance for the envelope's self-describing header on top of the
 * canonical request ceiling.
 *
 * The stored object is the complete `ConfirmationEmailEnvelopeV1`: the request
 * (already bounded at `CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes`, and
 * serialized by the same `JSON.stringify` escaping, so it contributes the same
 * bytes) plus `envelopeVersion`, `orderId`, `templateVersion`, `createdAt`,
 * `idempotencyKey`, `providerBinding`, `canonicalDigest`, `canonicalBytes` and
 * `purgedAt`. Those are a few hundred bytes of fixed keys and bounded values;
 * 4 KiB is a generous ceiling for them and still refuses anything that could
 * only be a different, larger document.
 */
export const CONFIRMATION_ENVELOPE_OBJECT_HEADER_BYTES = 4_096;

/** The hard ceiling on one stored envelope object, checked before buffering. */
export const CONFIRMATION_ENVELOPE_OBJECT_MAX_BYTES =
  CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes + CONFIRMATION_ENVELOPE_OBJECT_HEADER_BYTES;

/**
 * The exact options every envelope write carries.
 *
 * Frozen, and a literal: `access` is NOT configurable and no environment value
 * can reach it. The global `HSB_BLOB_ACCESS_MODE` switch governs the order
 * store and is deliberately unreadable from here — a lane whose access mode an
 * unknown or misspelled environment value could downgrade is the failure this
 * slice exists to prevent.
 *
 * `allowOverwrite: false` is the write-once invariant: a frozen envelope that
 * can be rewritten is not frozen, and the digest fence that guards dispatch
 * would be checking a document that had already changed underneath it.
 * `addRandomSuffix: false` keeps the path deterministic so recovery can find
 * the object again — unguessability is explicitly NOT the control here; the
 * store being private is.
 */
export const CONFIRMATION_ENVELOPE_WRITE_OPTIONS = Object.freeze({
  access: 'private',
  allowOverwrite: false,
  addRandomSuffix: false,
  contentType: 'application/json',
} as const);

/** The exact options every envelope read carries. */
export const CONFIRMATION_ENVELOPE_READ_OPTIONS = Object.freeze({
  access: 'private',
  // A cached read must never decide a conditional write, and must never serve
  // bytes the store would now refuse to hand an unauthenticated reader.
  useCache: false,
} as const);

/** True only when Production has explicitly armed the envelope writer. */
export function isConfirmationEnvelopeWriterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[CONFIRMATION_ENVELOPE_WRITER_ENV] === 'true';
}

/**
 * The namespaced key for one order's envelope object, or null when the order
 * id fails the grammar.
 *
 * The id is validated BEFORE the path is constructed, not after. Validating
 * afterwards means a traversal segment, a separator or a case variant has
 * already been concatenated into a key, and the only thing standing between
 * that key and the store is a check someone could reorder.
 */
export function confirmationEnvelopeObjectPath(
  orderId: string,
  namespace: string,
): string | null {
  if (!CONFIRMATION_ENVELOPE_ORDER_ID_RE.test(orderId)) return null;
  return applyBlobNamespace(
    `${CONFIRMATION_ENVELOPE_PATH_PREFIX}/${orderId}/v1.json`,
    namespace,
  );
}

/**
 * Resolve the dedicated credential and namespace, or refuse.
 *
 * Order is load-bearing:
 *   1. the credential must be present at all           → `store_unconfigured`
 *   2. it must parse as a Vercel Blob read-write token → `store_not_dedicated`
 *   3. its STORE ID must differ from every configured HSB lane
 *                                                      → `store_not_dedicated`
 *   4. the namespace must resolve                      → `namespace_invalid`
 *
 * Step 3 compares store ids, never whole token strings: two different
 * credentials issued for the same store are two strings addressing one
 * keyspace, which is precisely the misconfiguration being refused.
 *
 * A peer lane whose own credential is malformed also lands on
 * `store_not_dedicated`, and that is deliberate. If a peer's store identity
 * cannot be determined, distinctness from it cannot be proven, and an
 * identity we cannot determine must not be treated as distinct from anything.
 */
export function resolveConfirmationEnvelopeStoreCredential(
  env: NodeJS.ProcessEnv = process.env,
): ConfirmationEnvelopeConfigResult {
  const token = env[CONFIRMATION_ENVELOPE_TOKEN_ENV]?.trim() ?? '';
  if (!token) return { ok: false, refusal: 'store_unconfigured' };

  try {
    // Defence in depth, and deliberately redundant: `assertDistinctBlobStores`
    // parses every configured entry below, this one included, so removing this
    // line changes no observable behaviour today and no test can catch its
    // removal. It is kept because shape validation must not become a
    // side effect of a distinctness check that a later edit might narrow.
    parseBlobToken(token, 'confirmation-envelope');
    assertDistinctBlobStores([
      { label: 'confirmation-envelope', token },
      ...Object.entries(CONFIRMATION_ENVELOPE_PEER_TOKEN_ENVS).map(([label, variable]) => ({
        label,
        token: env[variable]?.trim(),
      })),
    ]);
  } catch {
    // The underlying error names the role but never the value; collapse it to
    // the closed refusal rather than letting its message travel.
    return { ok: false, refusal: 'store_not_dedicated' };
  }

  let namespace: string;
  try {
    namespace = getBlobNamespace(env);
  } catch {
    return { ok: false, refusal: 'namespace_invalid' };
  }

  return { ok: true, credential: { token, namespace } };
}

/**
 * The printable problem for one refusal.
 *
 * Exported so the fallback arm is reachable evidence rather than unreachable
 * defensive code: the resolver only ever returns three of these members, so a
 * `default` branch buried inside the gate could be deleted without any test
 * noticing. Here it can be called with any member of the closed union and
 * asserted on.
 *
 * Every arm returns a non-empty message. A build gate that falls through to
 * "no problem" on an unrecognised refusal is a gate that opens on exactly the
 * case nobody anticipated.
 */
export function confirmationEnvelopeRefusalProblem(
  refusal: ConfirmationEnvelopeStorageRefusal,
): string {
  switch (refusal) {
    case 'store_unconfigured':
      return `${CONFIRMATION_ENVELOPE_TOKEN_ENV} is not set`;
    case 'store_not_dedicated':
      return (
        `${CONFIRMATION_ENVELOPE_TOKEN_ENV} must be a valid Vercel Blob credential ` +
        `naming a Blob store of its own, different from ` +
        `${Object.values(CONFIRMATION_ENVELOPE_PEER_TOKEN_ENVS).join(', ')}`
      );
    case 'namespace_invalid':
      return 'HSB_BLOB_NAMESPACE does not resolve to a usable Blob namespace';
    default:
      return `${CONFIRMATION_ENVELOPE_TOKEN_ENV} is unusable (${refusal})`;
  }
}

/**
 * What is wrong with the envelope lane on a Vercel PRODUCTION build, or null
 * when the build may proceed. Safe to print: it names the variable and the
 * fault, never the value.
 *
 * The writer flag off is the escape hatch, and it is the only one. An operator
 * deliberately shipping Production without the envelope lane says so by not
 * arming the writer — which is also the default, so no configuration at all is
 * a passing build.
 */
export function confirmationEnvelopeBuildContractProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isVercelProductionBuild(env)) return null;
  if (!isConfirmationEnvelopeWriterEnabled(env)) return null;

  const result = resolveConfirmationEnvelopeStoreCredential(env);
  // `=== true`, not a truthiness test: this repository compiles with
  // "strict": false, so strictNullChecks is off and a boolean-literal
  // discriminant only narrows through an explicit comparison.
  if (result.ok === true) return null;
  return confirmationEnvelopeRefusalProblem(result.refusal);
}

/**
 * True only for a build running on Vercel for the PRODUCTION environment.
 *
 * Restated rather than imported from `story-media-store.ts` so the two release
 * gates stay independent: coupling them is how one lane's misconfiguration
 * starts blocking the other lane's deploy. The rule itself is Vercel's and is
 * identical in both: `VERCEL=1` plus `VERCEL_ENV=production`. CI blanks both,
 * a local `next build` has neither, and a Preview build carries
 * `VERCEL_ENV=preview`; none of those may need a secret to build.
 */
export function isVercelProductionBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL === '1' && env.VERCEL_ENV === 'production';
}
