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
  const message = input.attemptMayHaveReachedServer
    ? (/do not pay again/i.test(proposedMessage) && !UNSAFE_ATTEMPT_GUIDANCE.test(proposedMessage)
      ? proposedMessage
      : CHECKOUT_SUBMIT_UNCONFIRMED)
    : proposedMessage;
  return {
    message,
    showRecordedVoiceHint: input.voiceSource === 'recorded' && !input.attemptMayHaveReachedServer,
    reference: code,
  };
}
