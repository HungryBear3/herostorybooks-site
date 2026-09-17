/**
 * Customer copy for a failed checkout submission.
 *
 * The direct private-intake orchestration reports failures as stable codes
 * (`asset_mime_invalid`, `upload_failed`, …) plus, where it knows, the label of
 * the asset that failed ("hero photo", "voice note"). Those codes are for logs
 * and support, not for the banner: on 2026-09-04 a buyer saw the raw string
 * `asset_mime_invalid` as the entire explanation. This module turns a code into
 * a sentence, keeps the code as a support reference, and decides whether the
 * "download your recorded voice note before retrying" hint applies — it only
 * does for a fresh, unsent attempt with an in-checkout RECORDING that a reload
 * would lose.
 *
 * Browser-safe on purpose: the checkout page imports it.
 */

import { CHECKOUT_SUBMIT_UNCONFIRMED } from './checkout-handoff.ts';
import type { CheckoutSubmitAttemptRisk } from './checkout-saved-draft.ts';
import {
  CHECKOUT_DIAGNOSTIC_REFERENCE,
  checkoutDiagnosticReferenceLine,
  type CheckoutDiagnosticCode,
} from './checkout-submit-diagnostics.ts';

export type CheckoutVoiceSource = 'recorded' | 'uploaded' | null | undefined;

export interface CheckoutSubmitErrorInput {
  /** Stable failure code from the orchestration or the server. */
  code: string;
  /** Buyer-facing name of the asset that failed, when known. */
  label?: string | null;
  /** How the current voice note (if any) got into the form. */
  voiceSource?: CheckoutVoiceSource;
  /**
   * A sentence the server already wrote for the buyer (legacy `/api/order`
   * responses). Used as the message only when it is a sentence, never when it
   * is a bare code.
   */
  serverMessage?: string | null;
  /** This attempt ID existed before the current local submit, or this submit sent it. */
  attemptMayHaveReachedServer?: boolean;
  /** Distinguishes the current request from unresolved evidence left by an older click. */
  attemptRisk?: CheckoutSubmitAttemptRisk;
}

export interface CheckoutSubmitErrorCopy {
  /** The primary banner message. Always a sentence, never a bare code. */
  message: string;
  /** Show the recorded-note preservation hint. */
  showRecordedVoiceHint: boolean;
  /** The code, for support mail and logs. */
  reference: string;
}

export const NOT_CHARGED = 'You have not been charged.';
export const ACCEPTED_PHOTO_FORMATS = 'JPG, PNG, or WebP';
export const ACCEPTED_AUDIO_FORMATS = 'M4A, MP3, WAV, AAC, OGG, FLAC, AIFF, CAF, or WebM';
export const ACCEPTED_DOCUMENT_FORMATS = 'TXT, PDF, or Word';

const BARE_CODE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const UNSAFE_ATTEMPT_GUIDANCE = /\b(?:not been charged|no charge|nothing was charged|stopped before payment|try again|retry|reload|start a fresh attempt)\b/i;
const GENERIC = `We couldn't start your order. ${NOT_CHARGED} Please try again.`;

/**
 * This used to promise that Continue "will safely reuse the same checkout
 * attempt". It cannot promise that: an unresolved attempt may turn out to be
 * already paid, and the recovery path then routes to confirmation rather than
 * reusing anything. What IS guaranteed is the part the buyer needs — pressing
 * Continue re-checks the old attempt first and never starts a second payment
 * for it.
 */
export const PREVIOUS_CHECKOUT_UNRESOLVED_WARNING =
  'Your previous order status still needs confirmation, so please do not pay again. '
  + 'Correct the issue above, then press Continue again; we will re-check that attempt '
  + 'first and will never start a second payment for it.';

export const CURRENT_ORDER_NOT_SENT_GUIDANCE =
  'This click did not send a new order request. Correct the issue above, then press Continue again.';

export const PREVIOUS_CHECKOUT_PAID_RECOVERY =
  'Your previous checkout was already paid, so we did not start a second payment — please do not '
  + 'pay again for it. Check your email for that order confirmation, or contact '
  + 'support@herostorybooks.com if it has not arrived. If you want an additional book, choose '
  + '"Start a separate new order" below.';

export const PREVIOUS_CHECKOUT_PAID_RECOVERY_NO_ACTION =
  'Your previous checkout may already be paid. Check your email or order status and please do not '
  + 'pay again. Contact support@herostorybooks.com if you need help confirming it.';

export const SUBMIT_BANNER_HEADING_FAILED = "We couldn't start your order.";
export const SUBMIT_BANNER_HEADING_UNRESOLVED = 'We need to confirm your order status.';
export const SUBMIT_BANNER_HEADING_PAID = 'Your previous order was already paid.';
export const SUBMIT_BANNER_RECORDED_VOICE_HINT =
  'If you recorded a voice note, download it from the section above before retrying so it '
  + "isn't lost.";
export const SUBMIT_BANNER_SUPPORT_PROMPT =
  "If the issue continues, email support@herostorybooks.com and we'll help you finish the order "
  + 'manually.';

export interface CheckoutSubmitBanner {
  visible: boolean;
  heading: string;
  message: string;
  /** The ONLY authorization to render categorical no-charge reassurance. */
  noChargeReassurance: boolean;
  showRecordedVoiceHint: boolean;
  /** The buyer must take a separate action before a second payable checkout. */
  newPurchaseActionRequired: boolean;
  /**
   * The support-correlation line: a closed diagnostic code plus this
   * occurrence's reference, or `''` when no diagnostic was supplied. Empty
   * string rather than null so the page renders it with a plain truthiness
   * check and cannot accidentally print `null`.
   */
  diagnosticLine: string;
  /** Exactly the text the banner renders, in order. */
  lines: readonly string[];
}

export const EMPTY_CHECKOUT_SUBMIT_BANNER: CheckoutSubmitBanner = {
  visible: false,
  heading: '',
  message: '',
  noChargeReassurance: false,
  showRecordedVoiceHint: false,
  newPurchaseActionRequired: false,
  diagnosticLine: '',
  lines: [],
};

/**
 * Decide everything the submit-error banner renders.
 *
 * The banner used to derive its no-charge line from `!chargeUnconfirmed`, which
 * conflated two different questions. "Is the payment status unconfirmed?" picks
 * the heading. "May we state categorically that no money moved?" authorizes the
 * reassurance — and only a click that provably never reached `/api/order`, on a
 * browser holding no prior dispatch evidence, can answer that yes.
 *
 * `previous_attempt_resolved` is emphatically NOT such a state: restart approval
 * covers `completed_paid`, so a resolved prior attempt may be one the buyer has
 * already paid for. The mapper strips the sentence from the message for exactly
 * that reason; the banner must not put it back underneath.
 *
 * `diagnostic` is purely additive. It appends one correlation line at the very
 * end and touches no other decision here: a code cannot change the heading, the
 * message, or whether a no-charge sentence is authorized.
 */
export function checkoutSubmitBanner(input: {
  message: string | null | undefined;
  attemptRisk: CheckoutSubmitAttemptRisk;
  recordedVoiceHint?: boolean;
  paidAttemptId?: string | null;
  diagnostic?: { code: CheckoutDiagnosticCode; reference: string } | null;
}): CheckoutSubmitBanner {
  if (!input.message) return EMPTY_CHECKOUT_SUBMIT_BANNER;
  const previousAttemptPaid = input.attemptRisk === 'previous_attempt_paid';
  const paidAttemptIdKnown = typeof input.paidAttemptId === 'string'
    && /^[a-f0-9]{32}$/i.test(input.paidAttemptId);
  const message = previousAttemptPaid && !paidAttemptIdKnown
    ? PREVIOUS_CHECKOUT_PAID_RECOVERY_NO_ACTION
    : checkoutSubmitErrorMessageForAttempt(input.message, input.attemptRisk);
  const statusUnconfirmed = input.attemptRisk === 'previous_attempt_unresolved'
    || input.attemptRisk === 'current_order_request_sent';
  const noChargeReassurance = input.attemptRisk === 'none';
  const showRecordedVoiceHint = Boolean(input.recordedVoiceHint)
    && !statusUnconfirmed
    && !previousAttemptPaid;
  const heading = previousAttemptPaid
    ? SUBMIT_BANNER_HEADING_PAID
    : statusUnconfirmed
      ? SUBMIT_BANNER_HEADING_UNRESOLVED
      : SUBMIT_BANNER_HEADING_FAILED;
  // A reference we cannot vouch for is not shown. The format check is what
  // keeps this line a closed value rather than an echo of whatever the caller
  // happened to hold.
  const diagnosticLine = input.diagnostic
    && CHECKOUT_DIAGNOSTIC_REFERENCE.test(input.diagnostic.reference)
    ? checkoutDiagnosticReferenceLine(input.diagnostic)
    : '';
  return {
    visible: true,
    heading,
    message,
    noChargeReassurance,
    showRecordedVoiceHint,
    newPurchaseActionRequired: previousAttemptPaid && paidAttemptIdKnown,
    diagnosticLine,
    lines: [
      heading,
      message,
      ...(noChargeReassurance ? [NOT_CHARGED] : []),
      ...(showRecordedVoiceHint ? [SUBMIT_BANNER_RECORDED_VOICE_HINT] : []),
      SUBMIT_BANNER_SUPPORT_PROMPT,
      ...(diagnosticLine ? [diagnosticLine] : []),
    ],
  };
}

function withoutUnprovenNoChargeClaim(message: string): string {
  return message.replace(/\s*You have not been charged\.\s*/gi, ' ').trim();
}

export function checkoutSubmitErrorMessageForAttempt(
  proposedMessage: string,
  attemptRisk: CheckoutSubmitAttemptRisk | boolean,
): string {
  const risk = typeof attemptRisk === 'boolean'
    ? attemptRisk ? 'current_order_request_sent' : 'none'
    : attemptRisk;
  if (risk === 'none') return proposedMessage;
  // An already-paid prior attempt outranks whatever went wrong locally: the
  // buyer's next safe step is their existing order, not a corrected retry.
  if (risk === 'previous_attempt_paid') return PREVIOUS_CHECKOUT_PAID_RECOVERY;
  if (risk === 'previous_attempt_resolved') {
    if (proposedMessage.endsWith(CURRENT_ORDER_NOT_SENT_GUIDANCE)) return proposedMessage;
    const actionable = withoutUnprovenNoChargeClaim(proposedMessage);
    return `${actionable} ${CURRENT_ORDER_NOT_SENT_GUIDANCE}`;
  }
  if (risk === 'previous_attempt_unresolved') {
    if (proposedMessage.endsWith(PREVIOUS_CHECKOUT_UNRESOLVED_WARNING)) return proposedMessage;
    const actionable = withoutUnprovenNoChargeClaim(proposedMessage);
    return `${actionable} ${PREVIOUS_CHECKOUT_UNRESOLVED_WARNING}`;
  }
  return /do not pay again/i.test(proposedMessage) && !UNSAFE_ATTEMPT_GUIDANCE.test(proposedMessage)
    ? proposedMessage
    : CHECKOUT_SUBMIT_UNCONFIRMED;
}

type AssetKind = 'photo' | 'audio' | 'document' | 'unknown';

function kindOf(label: string | null | undefined): AssetKind {
  const text = (label ?? '').toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('voice') || text.includes('audio') || text.includes('recording')) return 'audio';
  if (text.includes('document') || text.includes('written')) return 'document';
  return 'photo';
}

function withLabel(label: string | null | undefined, fallback: string): string {
  const text = (label ?? '').trim();
  return text ? `your ${text}` : fallback;
}

/** Copy for a photo the picker cannot accept. Shared by the pre-intake gate and the banner. */
export function photoTypeUnsupportedMessage(label?: string | null): string {
  return `We couldn't accept ${withLabel(label, 'that photo')}: please choose a ${ACCEPTED_PHOTO_FORMATS} photo.`;
}

function unsupportedTypeMessage(label: string | null | undefined): string {
  switch (kindOf(label)) {
    case 'audio':
      return `We couldn't accept ${withLabel(label, 'your voice note')}: that audio format isn't supported. Please use an ${ACCEPTED_AUDIO_FORMATS} file, or record a new note. ${NOT_CHARGED}`;
    case 'document':
      return `We couldn't accept ${withLabel(label, 'your story document')}: please use a ${ACCEPTED_DOCUMENT_FORMATS} file. ${NOT_CHARGED}`;
    case 'photo':
      return `${photoTypeUnsupportedMessage(label)} ${NOT_CHARGED}`;
    default:
      return `One of your files is in a format we can't accept (photos: ${ACCEPTED_PHOTO_FORMATS}; audio: ${ACCEPTED_AUDIO_FORMATS}; documents: ${ACCEPTED_DOCUMENT_FORMATS}). ${NOT_CHARGED}`;
  }
}

function messageFor(code: string, label: string | null | undefined): string {
  const thing = withLabel(label, 'one of your files');
  switch (code) {
    case 'asset_mime_invalid':
    case 'photo_type_unsupported':
    case 'voice_type_invalid':
    case 'document_type_invalid':
      return unsupportedTypeMessage(label);
    case 'asset_too_large':
      return `${capitalize(thing)} is too large to upload. Please choose a smaller file and try again. ${NOT_CHARGED}`;
    case 'asset_size_invalid':
      return `${capitalize(thing)} appears to be empty or unreadable. Please choose it again. ${NOT_CHARGED}`;
    case 'voice_consent_required':
    case 'document_consent_required':
    case 'child_voice_authorization_required':
    case 'document_authorization_required':
    case 'media_authorization_required':
      return `Please confirm you have permission to share the files you attached, then try again. ${NOT_CHARGED}`;
    case 'upload_failed':
    case 'upload_not_reconciled':
    case 'reservation_failed':
    case 'intake_store_unavailable':
    case 'intake_write_conflict':
      return `We couldn't finish saving ${thing} securely. Please check your connection and try again. ${NOT_CHARGED}`;
    case 'upload_superseded':
    case 'direct_upload_unsettled':
      return `A file was still being replaced when you continued. Please wait a moment and try again. ${NOT_CHARGED}`;
    case 'direct_upload_identity_unmapped':
    case 'direct_upload_selection_changed_reload_required':
      return `Your photos changed after we prepared your order. Please reload the page and try again. ${NOT_CHARGED}`;
    case 'intake_expired':
    case 'intake_forbidden':
    case 'intake_not_found':
    case 'intake_create_failed':
      return `Your upload session has ended. Please reload the page and choose your files again. ${NOT_CHARGED}`;
    default:
      return GENERIC;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeCheckoutSubmitError(input: CheckoutSubmitErrorInput): CheckoutSubmitErrorCopy {
  const code = typeof input.code === 'string' && input.code ? input.code : 'unknown_error';
  const serverMessage = (input.serverMessage ?? '').trim();
  const serverSentence = serverMessage && !BARE_CODE.test(serverMessage) ? serverMessage : null;
  const proposedMessage = serverSentence ?? messageFor(code, input.label);
  const attemptRisk = input.attemptRisk
    ?? (input.attemptMayHaveReachedServer ? 'current_order_request_sent' : 'none');
  const message = checkoutSubmitErrorMessageForAttempt(
    proposedMessage,
    attemptRisk,
  );
  return {
    message,
    showRecordedVoiceHint: input.voiceSource === 'recorded'
      && (attemptRisk === 'none' || attemptRisk === 'previous_attempt_resolved'),
    reference: code,
  };
}
