/**
 * The size cliff under the LEGACY multipart checkout submit.
 *
 * With direct private intake unset — which is production today — checkout
 * posts one multipart `/api/order` request carrying the hero photo, every
 * supporting photo (~1.1 MiB each is ordinary from a phone), and either a voice
 * note or a story document whose own caps are 15 MiB and 10 MiB. Past the
 * platform request-body boundary (~4.5 MiB) the request is rejected at the edge
 * and no function ever runs: on 2026-09-17 an iPhone Safari buyer saw
 * `CHECKOUT_SUBMIT_UNCONFIRMED` / `current_order_request_sent` while Vercel had
 * no `/api/order` log and neither an order nor a Stripe Session existed. The
 * browser had already marked the attempt sent, so it could only describe the
 * outcome as unconfirmed — the worst possible sentence for a buyer who was, in
 * fact, never charged and never even reached the server.
 *
 * This module measures the bytes that ACTUALLY travel — the Blob/File entries
 * of the final FormData, after every legacy append — and refuses above a
 * conservative 3.5 MiB. The ~1 MiB of slack absorbs multipart framing, headers
 * and the text fields, so the estimate never has to be exact. Refusing here is
 * strictly better than the cliff: it happens BEFORE the attempt is marked sent,
 * so the existing attempt-risk classification reports a local, unsent failure
 * and the buyer gets an action instead of an ambiguity.
 *
 * Deliberately narrow. This is a browser-side preflight for the legacy lane
 * only: it never touches the direct-upload lane (which streams media straight
 * to storage and posts no bytes through `/api/order`), never changes a server
 * limit, and performs no I/O, no clearing and no rotation of anything.
 *
 * Browser-safe on purpose: the checkout page imports it.
 */

/** Conservative media-byte ceiling for one legacy multipart submit. */
export const LEGACY_CHECKOUT_MEDIA_BYTE_CAP = 3.5 * 1024 * 1024;

/** Stable code for logs and support mail. Never shown as the buyer message. */
export const LEGACY_MEDIA_PAYLOAD_TOO_LARGE = 'legacy_media_payload_too_large';

/**
 * What the buyer reads.
 *
 * It states only what this click proves: the attached media is too big to send,
 * and no order request left the browser. It says nothing about charges, and
 * nothing about any earlier attempt — the submit banner owns both, and it has
 * evidence this module does not.
 */
export const LEGACY_MEDIA_PAYLOAD_TOO_LARGE_MESSAGE =
  'The photos, voice note and documents you attached are, combined, too large for secure checkout '
  + 'to send in one request, so this click did not send a new order request. Please remove or re-record a shorter '
  + 'voice note, or reduce the optional photos and documents, then press Continue again.';

export class LegacyCheckoutPayloadTooLargeError extends Error {
  readonly code = LEGACY_MEDIA_PAYLOAD_TOO_LARGE;
  readonly mediaBytes: number;
  readonly limitBytes: number;

  constructor(mediaBytes: number, limitBytes: number) {
    super(LEGACY_MEDIA_PAYLOAD_TOO_LARGE_MESSAGE);
    this.name = 'LegacyCheckoutPayloadTooLargeError';
    this.mediaBytes = mediaBytes;
    this.limitBytes = limitBytes;
  }
}

export interface LegacyCheckoutPayloadInspection {
  /** Total bytes of the Blob/File entries actually present in the payload. */
  mediaBytes: number;
  limitBytes: number;
  withinLimit: boolean;
}

/**
 * A FormData value is `string | File`, so anything non-string carrying a
 * numeric `size` is real media. Duck-typing rather than `instanceof Blob` keeps
 * this working across the realms a form value can cross.
 */
function blobByteSize(value: unknown): number {
  if (typeof value === 'string' || value === null || typeof value !== 'object') return 0;
  const size = (value as { size?: unknown }).size;
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0;
}

/** Total byte size of the actual Blob/File entries. Text fields count as zero. */
export function legacyCheckoutMediaByteSize(payload: FormData): number {
  let total = 0;
  for (const [, value] of payload.entries()) total += blobByteSize(value);
  return total;
}

export function inspectLegacyCheckoutPayload(payload: FormData): LegacyCheckoutPayloadInspection {
  const mediaBytes = legacyCheckoutMediaByteSize(payload);
  return {
    mediaBytes,
    limitBytes: LEGACY_CHECKOUT_MEDIA_BYTE_CAP,
    withinLimit: mediaBytes <= LEGACY_CHECKOUT_MEDIA_BYTE_CAP,
  };
}

/**
 * Throw the typed local failure when the final legacy payload cannot be sent.
 * Call it only on the legacy lane, after every media append and before anything
 * marks the checkout attempt as sent.
 */
export function assertLegacyCheckoutPayloadWithinLimit(payload: FormData): void {
  const inspected = inspectLegacyCheckoutPayload(payload);
  if (inspected.withinLimit) return;
  throw new LegacyCheckoutPayloadTooLargeError(inspected.mediaBytes, inspected.limitBytes);
}
