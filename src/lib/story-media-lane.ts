/**
 * Which picker a chosen Custom Story file is allowed to enter.
 *
 * WHY THIS EXISTS
 * ---------------
 * `checkStoryMediaFileSize` deliberately returns ACCEPTED for a file the
 * classifier calls invalid — judging type there would be a second type policy,
 * and two policies drift. So the selection surface, which ran only the size
 * preflight, let an unsupported or contradictory file through: it revoked the
 * live preview URL, minted a new one, bumped the recorder's operation token,
 * and replaced the attachment plus its consent. The refusal arrived much later,
 * from the server, as `asset_mime_invalid` at the payment button.
 *
 * The lane argument is a SECOND, narrower guard, and it is worth being exact
 * about what it does NOT fix. Nothing downstream ever routed by picker: this
 * section's `attachedFileIsAudio` and checkout's `isStoryAudioFile` both read
 * the FILE, so a PDF chosen in the audio picker was already stored, rendered,
 * and consented to as a document — that flow worked end to end. Binding a lane
 * per input repairs no routing bug; it keeps the picker's own promise, refusing
 * at the click a selection the customer would otherwise watch land under the
 * other heading. The classification-based routing this sits in front of is
 * still load-bearing, and deleting it as "redundant" would break the product.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It owns no MIME list. Every type decision here is `classifyStoryAttachment`'s
 * — the same authoritative boundary the server-facing canonicalization uses, so
 * Safari's `audio/x-m4a` is `audio/mp4` here exactly as it is everywhere else.
 * This module adds two things on top: the lane the firing picker owns, which
 * the classifier cannot know, and WHY a refusal happened, which the classifier
 * collapses into a single `invalid`.
 *
 * The format list is read from the shared extension tables rather than retyped,
 * so it can never name an extension those tables do not carry. That is NOT a
 * congruence proof, and this module does not claim one: a `.flac` file whose
 * browser reports the unmapped alias `audio/x-flac` is refused while the label
 * still names FLAC, because `AUDIO_BY_MIME` in `story-attachment.ts` does not
 * carry that alias. Nothing here can tell that case apart from a plain video
 * without keeping a MIME list of its own, so the gap is left for the owner of
 * that table. What the reason split does fix is the class this module CAN
 * identify without one: a file whose name and whose reported type each name an
 * accepted format, but not the same one. Those get `name_type_conflict`, which
 * names the mismatch; only `unsupported` — where neither half names anything
 * we take — is answered with the format list.
 */

import {
  AUDIO_MIME_BY_EXTENSION,
  DOCUMENT_MIME_BY_EXTENSION,
} from './checkout-media-mime.ts';
import { classifyStoryAttachment, type StoryAttachmentKind } from './story-attachment.ts';

export type StoryMediaLaneRefusal = 'unsupported' | 'name_type_conflict' | 'wrong_lane';

export type StoryMediaLaneVerdict =
  | { ok: true; kind: StoryAttachmentKind; mimeType: string }
  | { ok: false; reason: StoryMediaLaneRefusal; message: string };

/** `['DOC','DOCX','PDF','TXT']` → `"DOC, DOCX, PDF, or TXT"`. */
function readableList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

/**
 * The formats a picker actually accepts, spelled the way a customer sees them
 * in a file browser. Read from the shared extension tables so the copy and the
 * policy cannot disagree.
 */
export function storyMediaAcceptedFormatsLabel(kind: StoryAttachmentKind): string {
  const table = kind === 'audio' ? AUDIO_MIME_BY_EXTENSION : DOCUMENT_MIME_BY_EXTENSION;
  return readableList(Object.keys(table).map((extension) => extension.toUpperCase()).sort());
}

/**
 * Copy for a recording this browser produced in a format the policy refuses.
 * Neither picker message fits: the customer chose no file and named nothing —
 * `recordedStoryAudioFileName` did — so "your name and type disagree" blames
 * them for our filename, and a list of formats answers a question they were
 * never asked. Point at the path that still works instead.
 */
export const STORY_MEDIA_RECORDING_REFUSAL_MESSAGE =
  "This browser recorded in a format we can't use. Please upload an audio file instead.";

/**
 * Copy for a file whose two halves each name a format we accept, but not the
 * same one. It names the mismatch and lists nothing: the customer is holding an
 * extension that IS on the accepted list, so repeating that list would name the
 * very format being refused and leave them re-picking the same file forever.
 * Neither the filename nor the reported type is echoed back.
 */
const NAME_TYPE_CONFLICT_MESSAGE =
  "That file's name and the file type your device reported describe different formats, so we can't tell which one it is. Try re-saving or exporting it, then choose it again.";

function unsupportedMessage(lane: StoryAttachmentKind): string {
  return lane === 'audio'
    ? `We can't use that file as a voice note. Accepted audio formats: ${storyMediaAcceptedFormatsLabel('audio')}.`
    : `We can't use that file as a written note. Accepted document formats: ${storyMediaAcceptedFormatsLabel('document')}.`;
}

function wrongLaneMessage(lane: StoryAttachmentKind): string {
  return lane === 'audio'
    ? `That looks like a written file, not a voice note. Add it under “Upload document”, or choose an audio file: ${storyMediaAcceptedFormatsLabel('audio')}.`
    : `That looks like a voice note, not a written file. Add it under “Upload audio file”, or choose a document: ${storyMediaAcceptedFormatsLabel('document')}.`;
}

/**
 * Given a file the classifier ALREADY called invalid: did each half of its
 * identity — the filename on its own, the reported type on its own — name a
 * format this product accepts? If both did, they must be naming different ones,
 * because agreement would have been accepted. That is the conflict class.
 *
 * Derived by re-asking the SAME classifier twice, once per half, so no MIME or
 * extension knowledge is added here. A half the classifier also calls invalid
 * is not a conflict: it is a format we do not take (`video/mp4` under a `.mp4`
 * name), or an alias the policy has not mapped, and both of those are answered
 * with the accepted-formats list.
 */
function invalidBecauseNameAndTypeDisagree(file: { type?: string; name?: string }): boolean {
  return (
    classifyStoryAttachment({ name: file.name }).kind !== 'invalid' &&
    classifyStoryAttachment({ type: file.type }).kind !== 'invalid'
  );
}

/**
 * Judge a file the customer just chose in a specific picker. The lane is passed
 * in by the handler that fired — never inferred from the event, the markup, or
 * any mutable ambient state — so the audio picker cannot accept a document and
 * the document picker cannot accept a voice memo.
 */
export function checkStoryMediaLane(
  file: { type?: string; name?: string },
  lane: StoryAttachmentKind,
): StoryMediaLaneVerdict {
  const classification = classifyStoryAttachment(file);
  if (classification.kind === 'invalid') {
    return invalidBecauseNameAndTypeDisagree(file)
      ? { ok: false, reason: 'name_type_conflict', message: NAME_TYPE_CONFLICT_MESSAGE }
      : { ok: false, reason: 'unsupported', message: unsupportedMessage(lane) };
  }
  if (classification.kind !== lane) {
    return { ok: false, reason: 'wrong_lane', message: wrongLaneMessage(lane) };
  }
  return { ok: true, kind: classification.kind, mimeType: classification.mimeType };
}
