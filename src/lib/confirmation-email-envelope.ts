/**
 * The immutable paid-order confirmation envelope (L-4 Slice A1).
 *
 * Every field the provider will receive is frozen here once, verbatim, and is
 * read back out of this object at dispatch time. Nothing is ever recomputed:
 * the confirmation body is built from environment-resolved values (support
 * address, site URL, sender), so rebuilding it at send time makes two
 * presentations of one idempotency key carry different bytes — which is the
 * exact sequence that turns a lost receipt into either a provider conflict or
 * a second confirmation in the buyer's inbox.
 *
 * This module is pure by contract. It has no provider call, no credential
 * read, no environment read, no persistence, and no log sink. It cannot send
 * an email and cannot store one; it only describes and validates a shape.
 *
 * Privacy: the request is customer content. It is never projected to an
 * operator surface, and a purge turns the envelope into a tombstone that keeps
 * the deduplication identity while the payload itself is gone.
 */
import { createHash } from 'node:crypto';

export const CONFIRMATION_ENVELOPE_VERSION = 1 as const;

/**
 * Fail-closed byte ceilings, checked before any state transition.
 *
 * The path/subject values are the RFC maxima. The body ceilings are ~80x the
 * currently rendered size, and the canonical total bounds the growth of the
 * order record, which is serialized whole on every conditional commit.
 */
export const CONFIRMATION_ENVELOPE_LIMITS = {
  recipients: 1,
  fromBytes: 320,
  toBytes: 320,
  replyToBytes: 320,
  subjectBytes: 998,
  htmlBytes: 262_144,
  textBytes: 65_536,
  canonicalBytes: 327_680,
} as const;

/** Every field the provider will receive, verbatim. */
export interface ConfirmationEmailRequestV1 {
  readonly from: string;
  /** Exactly one recipient, by construction. */
  readonly to: readonly [string];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo: string;
}

/**
 * Which provider account this envelope was frozen against.
 *
 * This is explicit, non-secret, caller-supplied operator data — a versioned
 * label such as `hsb-<provider>-prod-v1`. It is deliberately NOT derived from
 * a credential, a token prefix, an environment value, or any live call: a
 * durable secret-derived verifier on a customer-readable record is security
 * metadata exposure with no corresponding gain, and a stronger cryptographic
 * binding, if it is ever needed, is a separately designed mechanism.
 */
export interface ConfirmationEmailProviderBindingV1 {
  readonly accountLabel: string;
}

export interface ConfirmationEmailEnvelopeV1 {
  readonly envelopeVersion: typeof CONFIRMATION_ENVELOPE_VERSION;
  readonly orderId: string;
  /** Deployed template identity, e.g. `order-confirmation@<commit>`. */
  readonly templateVersion: string;
  /** Canonical ISO 8601 UTC instant, millisecond precision. */
  readonly createdAt: string;
  /**
   * Copied verbatim from the order's frozen confirmation identity. It is never
   * a function of the digest, the template, the body, or any attempt: deriving
   * it from content would mint a fresh provider identity for every body change,
   * which is precisely how one order becomes two accepted messages.
   */
  readonly idempotencyKey: string;
  readonly providerBinding: ConfirmationEmailProviderBindingV1;
  /** `null` once purged. A null request is a tombstone. */
  readonly request: ConfirmationEmailRequestV1 | null;
  /** Integrity metadata only. Survives purge. Never an input to the key. */
  readonly canonicalDigest: string;
  /** Byte length of the canonical serialization. Survives purge. */
  readonly canonicalBytes: number;
  /** Set when the payload is purged; null while it is retained. */
  readonly purgedAt: string | null;
}

/** The non-PII view an operator surface may see. No request bytes. */
export interface ConfirmationEmailEnvelopeOperatorProjectionV1 {
  readonly envelopeVersion: typeof CONFIRMATION_ENVELOPE_VERSION;
  readonly orderId: string;
  readonly templateVersion: string;
  readonly createdAt: string;
  readonly canonicalDigest: string;
  readonly canonicalBytes: number;
  readonly purgedAt: string | null;
  readonly accountLabel: string;
}

export type ConfirmationEnvelopeRefusalReason =
  | 'missing_order_id'
  | 'missing_template_version'
  | 'missing_idempotency_key'
  | 'missing_account_label'
  | 'invalid_created_at'
  | 'recipient_count'
  | 'from_too_long'
  | 'to_too_long'
  | 'reply_to_too_long'
  | 'subject_too_long'
  | 'html_too_long'
  | 'text_too_long'
  | 'canonical_too_large';

export interface BuildConfirmationEmailEnvelopeInput {
  readonly orderId: string;
  readonly templateVersion: string;
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly providerBinding: ConfirmationEmailProviderBindingV1;
  readonly request: ConfirmationEmailRequestV1;
}

export type BuildConfirmationEmailEnvelopeResult =
  | { readonly ok: true; readonly envelope: ConfirmationEmailEnvelopeV1 }
  | { readonly ok: false; readonly refusal: ConfirmationEnvelopeRefusalReason };

/**
 * The canonical form exists only to produce the digest. It is a byte-exact
 * function of what is transmitted, with a fixed key order and no value
 * normalization of any kind — no NFC, no trim, no case folding, no markup
 * rebuilding. A normalizing canonicalizer would describe bytes the provider
 * never sees, which makes the digest useless as an integrity fence.
 */
export function canonicalizeConfirmationRequest(request: ConfirmationEmailRequestV1): string {
  return JSON.stringify({
    from: request.from,
    to: [...request.to],
    subject: request.subject,
    html: request.html,
    text: request.text,
    replyTo: request.replyTo,
  });
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Lowercase hex sha256 over the canonical UTF-8 bytes. Integrity only. */
export function digestConfirmationRequest(request: ConfirmationEmailRequestV1): string {
  return createHash('sha256')
    .update(Buffer.from(canonicalizeConfirmationRequest(request), 'utf8'))
    .digest('hex');
}

/**
 * Fail-closed shape and size validation. Returns the refusal reason, or null
 * when the request may be frozen.
 *
 * This reports rather than throws on purpose: a thrown error carries a message
 * and a stack, and both are routinely handed to a log sink. The request is
 * customer content, so no failure path here may produce a value that quotes it.
 */
export function checkConfirmationEnvelopeLimits(
  request: ConfirmationEmailRequestV1,
): ConfirmationEnvelopeRefusalReason | null {
  if (request.to.length !== CONFIRMATION_ENVELOPE_LIMITS.recipients) return 'recipient_count';
  if (byteLength(request.from) > CONFIRMATION_ENVELOPE_LIMITS.fromBytes) return 'from_too_long';
  if (byteLength(request.to[0]) > CONFIRMATION_ENVELOPE_LIMITS.toBytes) return 'to_too_long';
  if (byteLength(request.replyTo) > CONFIRMATION_ENVELOPE_LIMITS.replyToBytes) return 'reply_to_too_long';
  if (byteLength(request.subject) > CONFIRMATION_ENVELOPE_LIMITS.subjectBytes) return 'subject_too_long';
  if (byteLength(request.html) > CONFIRMATION_ENVELOPE_LIMITS.htmlBytes) return 'html_too_long';
  if (byteLength(request.text) > CONFIRMATION_ENVELOPE_LIMITS.textBytes) return 'text_too_long';
  if (byteLength(canonicalizeConfirmationRequest(request)) > CONFIRMATION_ENVELOPE_LIMITS.canonicalBytes) {
    return 'canonical_too_large';
  }
  return null;
}

function isCanonicalIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/**
 * Freeze one envelope, or refuse.
 *
 * Refusal is the only alternative to a valid envelope: there is no partial
 * snapshot and no reconstruction from current values. A fabricated envelope
 * would present a body the provider never saw under a key it may already have
 * accepted.
 */
export function buildConfirmationEmailEnvelope(
  input: BuildConfirmationEmailEnvelopeInput,
): BuildConfirmationEmailEnvelopeResult {
  if (!input.orderId.trim()) return { ok: false, refusal: 'missing_order_id' };
  if (!input.templateVersion.trim()) return { ok: false, refusal: 'missing_template_version' };
  if (!input.idempotencyKey.trim()) return { ok: false, refusal: 'missing_idempotency_key' };
  if (!input.providerBinding.accountLabel.trim()) return { ok: false, refusal: 'missing_account_label' };
  if (!isCanonicalIsoInstant(input.createdAt)) return { ok: false, refusal: 'invalid_created_at' };

  const refusal = checkConfirmationEnvelopeLimits(input.request);
  if (refusal) return { ok: false, refusal };

  const canonical = canonicalizeConfirmationRequest(input.request);
  return {
    ok: true,
    envelope: {
      envelopeVersion: CONFIRMATION_ENVELOPE_VERSION,
      orderId: input.orderId,
      templateVersion: input.templateVersion,
      createdAt: input.createdAt,
      idempotencyKey: input.idempotencyKey,
      providerBinding: { accountLabel: input.providerBinding.accountLabel },
      request: {
        from: input.request.from,
        to: [input.request.to[0]],
        subject: input.request.subject,
        html: input.request.html,
        text: input.request.text,
        replyTo: input.request.replyTo,
      },
      canonicalDigest: digestConfirmationRequest(input.request),
      canonicalBytes: byteLength(canonical),
      purgedAt: null,
    },
  };
}

/** A tombstone is an envelope whose payload is gone and whose identity is not. */
export function isConfirmationEmailEnvelopeTombstone(envelope: ConfirmationEmailEnvelopeV1): boolean {
  return envelope.request === null;
}

/**
 * Drop the payload, keep the identity.
 *
 * The deduplication identity outlives the customer content on purpose: after
 * this, the record still proves which provider identity was used, and the
 * transition model treats a null request as structurally unsendable. Purging
 * an already-purged envelope keeps the first purge instant — the payload was
 * already gone, and rewriting the instant would falsify the retention record.
 */
export function purgeConfirmationEmailEnvelope(
  envelope: ConfirmationEmailEnvelopeV1,
  purgedAt: string,
): ConfirmationEmailEnvelopeV1 {
  if (envelope.request === null) return envelope;
  return { ...envelope, request: null, purgedAt };
}

/**
 * The only view of an envelope any operator surface may render.
 *
 * Built as an explicit allow-list rather than a redaction, so a field added to
 * the envelope later is invisible here until someone deliberately adds it.
 */
export function projectConfirmationEmailEnvelopeForOperator(
  envelope: ConfirmationEmailEnvelopeV1,
): ConfirmationEmailEnvelopeOperatorProjectionV1 {
  return {
    envelopeVersion: envelope.envelopeVersion,
    orderId: envelope.orderId,
    templateVersion: envelope.templateVersion,
    createdAt: envelope.createdAt,
    canonicalDigest: envelope.canonicalDigest,
    canonicalBytes: envelope.canonicalBytes,
    purgedAt: envelope.purgedAt,
    accountLabel: envelope.providerBinding.accountLabel,
  };
}
