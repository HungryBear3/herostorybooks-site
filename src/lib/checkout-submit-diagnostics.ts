/**
 * Stable, non-sensitive diagnostics for a failed checkout submission.
 *
 * Incident (2026-09-17, iPhone Safari): a buyer pressed Continue, the submit
 * banner said only that we couldn't start the order, and there was nothing to
 * correlate their report with. Production evidence: one `/api/recovery` 200 and
 * NO `/api/order` request; the authoritative two-hour scans found zero new
 * orders and zero Stripe Checkout Sessions. The failure was entirely on the
 * browser side of the network, in a phase that emitted no signal at all.
 *
 * This module adds the missing signal and nothing else:
 *
 *   • a CLOSED vocabulary of failure classes, one per place the submit path can
 *     stop, so "it failed" becomes "it failed HERE";
 *   • a short display code (`CHK-03`) plus a per-occurrence reference the buyer
 *     can read out to support and we can grep for in Vercel logs;
 *   • a best-effort, same-origin, sanitized event carrying those and nothing
 *     else.
 *
 * PRIVACY IS THE WHOLE DESIGN
 * ---------------------------
 * The reported payload is built HERE, field by field, from closed enums plus an
 * opaque random reference. It is not a projection of a caller-supplied object,
 * so there is no shape of input — hostile, buggy, or merely careless — that can
 * add a key. No email, child/person name, filename, media metadata, free-form
 * server or error message, URL, cookie, checkout/order/session id, attempt id,
 * user-agent, IP, or stack trace can reach it.
 *
 * IT MAY NEVER AFFECT CHECKOUT
 * ----------------------------
 * `reportCheckoutSubmitDiagnostic` takes no storage, no attempt identity, and
 * no risk state, so it has no parameter through which it could clear, rotate,
 * or reinterpret an attempt. It swallows every transport outcome and always
 * resolves: a diagnostics failure must be invisible to the buyer.
 *
 * Browser-safe on purpose: the checkout page imports it.
 */

/**
 * Where the submit path stopped. `attempt` covers everything before any private
 * file leaves the browser; `intake` the direct upload; `order` the `/api/order`
 * request; `handoff` the navigation to Stripe Checkout.
 */
export const CHECKOUT_DIAGNOSTIC_PHASES = ['attempt', 'intake', 'order', 'handoff'] as const;
export type CheckoutDiagnosticPhase = (typeof CHECKOUT_DIAGNOSTIC_PHASES)[number];

/**
 * The closed failure vocabulary. One entry per distinguishable stop point:
 *
 *   attempt_identity_conflict    conflicting attempt markers in this browser
 *   attempt_storage_unavailable  a reserve/mark/readback this browser refused
 *   attempt_lease_unavailable    neither storage nor the server lease could
 *                                authoritatively name the attempt
 *   intake_preparation_failed    direct-intake preparation or upload failed
 *   order_request_refused        `/api/order` refused, with a bounded code
 *   network_unavailable          transport failure, or anything unrecognized
 *   stripe_handoff_unconfirmed   no/invalid Stripe redirect target
 *   previous_attempt_paid        the prior attempt is already paid
 */
export const CHECKOUT_DIAGNOSTIC_CODES = [
  'attempt_identity_conflict',
  'attempt_storage_unavailable',
  'attempt_lease_unavailable',
  'intake_preparation_failed',
  'order_request_refused',
  'network_unavailable',
  'stripe_handoff_unconfirmed',
  'previous_attempt_paid',
] as const;
export type CheckoutDiagnosticCode = (typeof CHECKOUT_DIAGNOSTIC_CODES)[number];

/**
 * What the buyer sees and reads out. Deliberately opaque and short: it is a
 * support handle, not an explanation, and the banner sentence above it is what
 * actually tells them what to do. Values are STABLE — support mail and logs
 * outlive any reordering of the list above, so these are never renumbered.
 */
export const CHECKOUT_DIAGNOSTIC_DISPLAY_CODES: Record<CheckoutDiagnosticCode, string> = {
  attempt_identity_conflict: 'CHK-01',
  attempt_storage_unavailable: 'CHK-02',
  attempt_lease_unavailable: 'CHK-03',
  intake_preparation_failed: 'CHK-04',
  order_request_refused: 'CHK-05',
  network_unavailable: 'CHK-06',
  stripe_handoff_unconfirmed: 'CHK-07',
  previous_attempt_paid: 'CHK-08',
};

/**
 * `network_unavailable` is reported in the `order` phase because that is the
 * one place the submit path lets a raw transport rejection escape: the attempt
 * and lease helpers resolve to their own decisions rather than throwing, and
 * direct intake reports its failures as preparation errors.
 */
export const CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE: Record<CheckoutDiagnosticCode, CheckoutDiagnosticPhase> = {
  attempt_identity_conflict: 'attempt',
  attempt_storage_unavailable: 'attempt',
  attempt_lease_unavailable: 'attempt',
  previous_attempt_paid: 'attempt',
  intake_preparation_failed: 'intake',
  order_request_refused: 'order',
  network_unavailable: 'order',
  stripe_handoff_unconfirmed: 'handoff',
};

/** The unknown-failure fallback. Every degradation lands here, in-vocabulary. */
const FALLBACK_CODE: CheckoutDiagnosticCode = 'network_unavailable';

/**
 * The refusal codes `/api/order` is known to return, plus the reconciliation
 * codes the hand-off helper recognizes.
 *
 * This list is the ONLY thing that may travel as `serverCode`. A code that is
 * not on it degrades to `other` rather than being echoed: the server's code
 * space is maintained elsewhere and a future addition must not become a hole
 * through which a free-form string reaches a log.
 */
export const CHECKOUT_ORDER_REFUSAL_CODES: readonly string[] = [
  'attachment_type_conflict',
  'checkout_canonical_reconciliation_required',
  'checkout_intent_order_ownership_conflict',
  'checkout_order_media_persist_failed',
  'checkout_unconfirmed',
  'custom_story_brief_invalid_json',
  'custom_story_manual_review_required',
  'custom_story_paid_beta_required',
  'custom_story_source_required',
  'custom_story_source_theme_mismatch',
  'direct_intake_semantic_identity_unavailable',
  'direct_upload_disabled',
  'document_consent_required',
  'document_invalid_type',
  'document_persist_failed',
  'document_too_large',
  'duplicate_document_attachment',
  'hero_photo_persist_failed',
  'photo_missing',
  'primary_hero_beta_required',
  'primary_hero_recipient_context_required',
  'story_media_disabled',
  'supporting_character_details_required',
  'supporting_photo_persist_failed',
  'voice_consent_required',
  'voice_invalid_type',
  'voice_persist_failed',
  'voice_too_large',
];

/** The closed stand-in for any refusal code not on the allowlist above. */
export const CHECKOUT_ORDER_REFUSAL_OTHER = 'other';

/** Exactly the keys a diagnostic event may carry, on the wire and in the log. */
export const CHECKOUT_DIAGNOSTIC_EVENT_KEYS = ['code', 'phase', 'reference', 'serverCode'] as const;

/** Same-origin, relative. Never an absolute URL: diagnostics never leave us. */
export const CHECKOUT_DIAGNOSTIC_REPORT_PATH = '/api/checkout/diagnostics';

/** 12 uppercase hex characters. Short enough to read out, wide enough to grep. */
export const CHECKOUT_DIAGNOSTIC_REFERENCE = /^[0-9A-F]{12}$/;

const REFERENCE_BYTES = 6;

export interface CheckoutDiagnosticEvent {
  code: CheckoutDiagnosticCode;
  phase: CheckoutDiagnosticPhase;
  reference: string;
  serverCode: string | null;
}

/**
 * A submit failure that already knows which diagnostic class it belongs to.
 *
 * The message is unchanged from the plain `Error` it replaces — the banner copy
 * and every existing charge-honesty rule still read exactly the same sentence.
 * The only addition is the class, so the catch path no longer has to infer a
 * failure's origin from its prose.
 */
export class CheckoutSubmitDiagnosticError extends Error {
  readonly diagnosticCode: CheckoutDiagnosticCode;
  /** The server's refusal code, when this failure came from one. */
  readonly serverCode: string | null;

  constructor(
    diagnosticCode: CheckoutDiagnosticCode,
    message: string,
    serverCode: unknown = null,
  ) {
    super(message);
    this.name = 'CheckoutSubmitDiagnosticError';
    this.diagnosticCode = diagnosticCode;
    this.serverCode = typeof serverCode === 'string' && serverCode ? serverCode : null;
  }
}

function isDiagnosticCode(value: unknown): value is CheckoutDiagnosticCode {
  return typeof value === 'string'
    && (CHECKOUT_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

/** Bound a server refusal code to the allowlist, or to the closed `other`. */
export function boundedOrderRefusalCode(value: unknown): string {
  return typeof value === 'string' && CHECKOUT_ORDER_REFUSAL_CODES.includes(value)
    ? value
    : CHECKOUT_ORDER_REFUSAL_OTHER;
}

/** A fresh, opaque, per-occurrence reference. Derived from nothing. */
export function newCheckoutDiagnosticReference(): string {
  return browserRandomHex(REFERENCE_BYTES).toUpperCase();
}

/**
 * Local copy of the retry-nonce generator, kept here so this module stays a
 * leaf the checkout page can import without dragging in attempt-identity code.
 */
function browserRandomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  try {
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes);
      return hex(bytes);
    }
  } catch {
    // Restricted in-app WebViews can expose `crypto` while refusing its methods.
  }
  const now = Date.now();
  for (let index = 0; index < bytes.length; index += 1) {
    const timeByte = Math.floor(now / (2 ** ((index % 6) * 8))) & 0xff;
    bytes[index] = Math.floor(Math.random() * 256) ^ timeByte;
  }
  return hex(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Decide the diagnostic class for a caught submit failure.
 *
 * Total and closed: every input produces a code from the vocabulary. Nothing is
 * inferred from a message string, so buyer-facing copy can be rewritten freely
 * without silently reclassifying an incident.
 */
export function classifyCheckoutSubmitFailure(input: {
  error: unknown;
  fallbackPhase?: CheckoutDiagnosticPhase;
}): { code: CheckoutDiagnosticCode; phase: CheckoutDiagnosticPhase; serverCode: string | null } {
  const { error } = input;
  let code: CheckoutDiagnosticCode = fallbackCodeForPhase(input.fallbackPhase ?? 'order');
  let serverCode: string | null = null;

  if (error instanceof CheckoutSubmitDiagnosticError && isDiagnosticCode(error.diagnosticCode)) {
    code = error.diagnosticCode;
    if (code === 'order_request_refused') serverCode = boundedOrderRefusalCode(error.serverCode);
  } else if (isDirectIntakePreparationFailure(error) || isLegacyPayloadPreparationFailure(error)) {
    // Matched on `name`, not on the class, so this leaf module does not have to
    // import the whole direct-upload client flow to classify one failure.
    code = 'intake_preparation_failed';
  }

  return { code, phase: CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE[code], serverCode };
}

function fallbackCodeForPhase(phase: CheckoutDiagnosticPhase): CheckoutDiagnosticCode {
  switch (phase) {
    case 'attempt': return 'attempt_storage_unavailable';
    case 'intake': return 'intake_preparation_failed';
    case 'handoff': return 'stripe_handoff_unconfirmed';
    case 'order': return 'network_unavailable';
  }
}

function isDirectIntakePreparationFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'DirectIntakePreparationError';
}

function isLegacyPayloadPreparationFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'LegacyCheckoutPayloadTooLargeError';
}

/**
 * The line the banner shows. One token, so a buyer reading it over the phone or
 * pasting it into support mail cannot split it in half.
 */
export function checkoutDiagnosticReferenceLine(input: {
  code: CheckoutDiagnosticCode;
  reference: string;
}): string {
  const code = isDiagnosticCode(input.code) ? input.code : FALLBACK_CODE;
  return `Support reference: ${CHECKOUT_DIAGNOSTIC_DISPLAY_CODES[code]}-${input.reference}`;
}

/**
 * Emit the diagnostic, best effort.
 *
 * Always resolves. Never throws. The returned promise is a convenience for
 * tests — the checkout page deliberately does not await it, because a slow or
 * hanging diagnostics request must not delay the buyer's banner.
 */
export async function reportCheckoutSubmitDiagnostic(
  input: { code: CheckoutDiagnosticCode; phase: CheckoutDiagnosticPhase; serverCode?: unknown },
  options: { reference: string; fetchImpl?: typeof fetch },
): Promise<void> {
  try {
    const code = isDiagnosticCode(input.code) ? input.code : FALLBACK_CODE;
    // Rebuilt field by field. `input` is read, never spread.
    const event: CheckoutDiagnosticEvent = {
      code,
      phase: CHECKOUT_DIAGNOSTIC_PHASE_BY_CODE[code],
      reference: CHECKOUT_DIAGNOSTIC_REFERENCE.test(options.reference) ? options.reference : '',
      serverCode: code === 'order_request_refused' || input.serverCode != null
        ? boundedOrderRefusalCode(input.serverCode)
        : null,
    };
    if (!event.reference) return;
    const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) return;
    await fetchImpl(CHECKOUT_DIAGNOSTIC_REPORT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      cache: 'no-store',
      // The banner renders and the buyer may navigate immediately after.
      keepalive: true,
    });
  } catch {
    // A diagnostics failure is never the buyer's problem.
  }
}
