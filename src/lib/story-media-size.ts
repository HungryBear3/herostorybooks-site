/**
 * The ONE size contract behind Custom Story attachments.
 *
 * WHY THIS EXISTS
 * ---------------
 * The 15 MB voice cap and the 10 MB document cap were written out three times
 * — `MAX_VOICE_BYTES` and `MAX_DOCUMENT_BYTES` in `orders.ts`, and again as
 * `maxBytes` literals inside `INTAKE_CATEGORY_POLICY` — and nowhere at all in
 * the browser. So the selection surface accepted a 40 MB voice memo, built a
 * preview URL for it, put it in checkout state, and let the buyer fill in the
 * rest of the form; the refusal arrived from the server at the payment button,
 * after the photos had already been staged.
 *
 * This module is imported by BOTH sides. It is deliberately browser-safe — no
 * `node:` imports, no SDKs — so the checkout page can refuse a file at the
 * moment it is chosen using the exact number the server will enforce.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not judge type. Which lane a file belongs to is decided by
 * `classifyStoryAttachment`, the existing authoritative boundary; a file that
 * boundary calls invalid gets NO size verdict here, because inventing a second
 * type policy is how the two drift apart.
 */

import { classifyStoryAttachment, type StoryAttachmentKind } from './story-attachment.ts';

/** Bytes each attachment lane accepts. Exact binary megabytes, not decimal. */
export const STORY_MEDIA_MAX_BYTES: Readonly<Record<StoryAttachmentKind, number>> = {
  audio: 15 * 1024 * 1024,
  document: 10 * 1024 * 1024,
};

export function storyMediaMaxBytes(kind: StoryAttachmentKind): number {
  return STORY_MEDIA_MAX_BYTES[kind];
}

export type StoryMediaSizeVerdict =
  | { ok: true }
  | { ok: false; kind: StoryAttachmentKind; message: string };

const ACCEPTED: StoryMediaSizeVerdict = { ok: true };

/** `18874368` → `"18.0 MB"`. Matches the size already shown beside an attachment. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The cap as customers read it: a whole number, no decimal point. */
function limitLabel(kind: StoryAttachmentKind): string {
  return `${Math.round(STORY_MEDIA_MAX_BYTES[kind] / (1024 * 1024))} MB`;
}

function tooLargeMessage(kind: StoryAttachmentKind, bytes: number): string {
  return kind === 'audio'
    ? `That voice note is ${formatMegabytes(bytes)}. Audio needs to be ${limitLabel('audio')} or smaller — try a shorter one.`
    : `That document is ${formatMegabytes(bytes)}. Written files need to be ${limitLabel('document')} or smaller — try a shorter one.`;
}

/** Judge a known lane against its own cap. A size we cannot read is not refused. */
export function checkStoryMediaBytes(kind: StoryAttachmentKind, bytes: number): StoryMediaSizeVerdict {
  if (!Number.isFinite(bytes) || bytes <= STORY_MEDIA_MAX_BYTES[kind]) return ACCEPTED;
  return { ok: false, kind, message: tooLargeMessage(kind, bytes) };
}

/**
 * Judge a file the customer just chose. The lane comes from the shared
 * classifier, so `audio/x-m4a` from Safari is an audio file here exactly as it
 * is everywhere else, and an unsupported type falls through untouched.
 */
export function checkStoryMediaFileSize(
  file: { type?: string; name?: string; size?: number },
): StoryMediaSizeVerdict {
  const classification = classifyStoryAttachment(file);
  if (classification.kind === 'invalid') return ACCEPTED;
  return checkStoryMediaBytes(classification.kind, file.size ?? 0);
}

/** A blob just produced by MediaRecorder is always the audio lane. */
export function checkRecordedStoryAudioSize(blob: { size?: number }): StoryMediaSizeVerdict {
  return checkStoryMediaBytes('audio', blob.size ?? 0);
}
