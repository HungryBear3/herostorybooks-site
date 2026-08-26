/**
 * Meta Conversions API — DEFERRED. There is no send path in this file.
 *
 * ── THE DECISION ─────────────────────────────────────────────────────────────
 *
 * The previous candidate built a Purchase payload containing exactly four
 * facts: `event_name`, `event_time`, `event_id` (a SHA-256 pseudonym of the
 * Stripe session id), `action_source`, `event_source_url` (a constant origin),
 * and `custom_data` (currency, value, content id). It deliberately sent no
 * `user_data` at all.
 *
 * That payload cannot work, and the reason is structural rather than a
 * configuration gap. Meta's Conversions API requires `user_data` on every
 * server event, and requires it to carry at least one customer-information
 * parameter for the event to be attributable. An event with no `user_data` is
 * not a weakly-matched event; it is a rejected or unattributable one.
 * `event_source_url` and `event_id` are not matching signals: `event_id` exists
 * to DEDUPLICATE a server event against a browser event of the same name, and
 * `event_source_url` describes the page, not the person. Sending them alone
 * satisfies a schema, not a purpose.
 *
 * So the honest options were: send real matching data, or do not send.
 *
 * ── WHY NOT SEND MATCHING DATA ───────────────────────────────────────────────
 *
 * The minimum viable matching contract would be a normalised, SHA-256 hashed
 * purchaser email (`em`), optionally with `fbp` / `fbc` from Meta's own
 * first-party cookies. HSB cannot currently satisfy that safely:
 *
 *  1. NO SERVER-SIDE CONSENT EVIDENCE. The consent surface added in this branch
 *     is a browser mechanism. The Stripe webhook has no consent record for the
 *     purchaser, so a server send could not prove the purchaser agreed to
 *     ad-platform sharing. Hashing is not consent; a hashed email is still
 *     personal data being disclosed to a third party.
 *  2. NO PRIVACY APPROVAL. No owner decision exists authorising customer
 *     matching to an ad platform, and the purchaser is a parent buying a
 *     product about their child. That is the last dataset to treat casually.
 *  3. `fbp` / `fbc` DO NOT EXIST HERE. Those cookies are written by the Meta
 *     Pixel, which is inert on every deployment and, when it does run, only
 *     after a granted consent. There is nothing to read.
 *
 * The brief's preferred outcome and this module's outcome are therefore the
 * same: DEFER. No misleading send path is retained.
 *
 * ── WHAT IS RETAINED ─────────────────────────────────────────────────────────
 *
 * The interface seam and the environment-variable names, so the later decision
 * has somewhere to land and so tests can prove the deferral is real. What is
 * NOT retained: any `fetch`, any endpoint, any payload builder, any scheduler,
 * and any call site. `grep -r scheduleMetaCapiPurchase src/` returns nothing
 * but this file's own documentation, and the Stripe webhook no longer
 * references Meta at all.
 *
 * ── PURCHASE OWNERSHIP, UNCHANGED ────────────────────────────────────────────
 *
 * A browser Purchase remains prohibited by contract. The signature-verified
 * Stripe webhook remains the sole authority for purchase, and GA4's
 * Measurement Protocol remains its only destination. `event_id` ownership is
 * defined for a future implementation below, but nothing owns it today because
 * nothing sends.
 */

/** Server-only. None of these may ever be given a NEXT_PUBLIC_ prefix. */
export const META_CAPI_DATASET_ID_ENV = 'META_CAPI_DATASET_ID';
export const META_CAPI_ACCESS_TOKEN_ENV = 'META_CAPI_ACCESS_TOKEN';
export const META_CAPI_FLAG_ENV = 'META_CAPI_ENABLED';

/** The one status this module can report. There is no other branch. */
export type MetaCapiStatus = 'deferred';

export interface MetaCapiDeferral {
  status: MetaCapiStatus;
  /** Machine-readable reason, for tests and for operator tooling. */
  reason: 'no_matching_contract';
  /**
   * The unmet preconditions, in the order they would have to be satisfied.
   * Configuring credentials does NOT shorten this list.
   */
  blockers: readonly string[];
}

const BLOCKERS = Object.freeze([
  'meta_requires_user_data_with_at_least_one_matching_parameter',
  'no_server_side_consent_evidence_for_the_purchaser',
  'no_owner_privacy_approval_for_customer_matching',
  'no_fbp_or_fbc_available_because_the_pixel_is_inert',
] as const);

/**
 * The current CAPI posture. Always deferred.
 *
 * Deliberately takes no arguments and reads no environment: the deferral is a
 * product and privacy decision, not a configuration state, so setting
 * META_CAPI_ENABLED cannot change what this returns.
 */
export function metaCapiStatus(): MetaCapiDeferral {
  return {
    status: 'deferred',
    reason: 'no_matching_contract',
    blockers: BLOCKERS,
  };
}

/**
 * The shape a future implementation would need, recorded so the decision has a
 * concrete target rather than a vague intention.
 *
 * This is a TYPE ONLY. Nothing constructs it, and adding a builder for it is
 * not sufficient to make CAPI live — the blockers above are.
 */
export interface FutureMetaCapiPurchaseContract {
  /**
   * Deduplication key, owned by the SERVER. If a browser Purchase were ever
   * permitted (it is not), both sides would have to send the same value. It
   * must remain a pseudonym derived from the Stripe session, never the session
   * id itself.
   */
  event_id: string;
  /**
   * The matching block. REQUIRED by Meta, and the reason this is deferred.
   * Every member would be normalised then SHA-256 hashed before it left the
   * process, and none of it may ever describe a child.
   */
  user_data: {
    /** Lowercased, trimmed, hashed purchaser email. Adult purchaser only. */
    em?: string;
    /** Meta's own first-party browser cookies, if a consented pixel set them. */
    fbp?: string;
    fbc?: string;
  };
  custom_data: {
    currency: string;
    value: number;
    content_ids: readonly string[];
    content_type: 'product';
  };
}

/**
 * Explicitly enumerated so a reviewer can check the negative claim rather than
 * take it on trust. Asserted in tests/marketing-meta-capi.test.ts.
 */
export const META_CAPI_NEVER_SENDS = Object.freeze([
  'child_name',
  'child_photo',
  'family_data',
  'story_input',
  'order_id',
  'submission_id',
  'stripe_session_id',
  'payment_intent_id',
  'customer_email',
  'shipping_address',
  'proof_token',
  'review_token',
  'asset_url',
] as const);
