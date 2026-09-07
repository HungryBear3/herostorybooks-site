/**
 * Browser-side TYPE preflight for Custom Story attachments.
 *
 * WHAT THIS PINS
 * --------------
 * The selection surface already refused an oversize file at the picker
 * (`story-media-size-preflight.test.ts`). It did NOT refuse an unsupported one:
 * `handleUpload` called only `checkStoryMediaFileSize`, and that function
 * deliberately returns ACCEPTED for anything `classifyStoryAttachment` calls
 * invalid — inventing a second type policy inside the size module is how the
 * two drift apart. So a `.exe`, a `video/mp4`, or an `audio/mpeg` file named
 * `memory.pdf` sailed through the picker: it revoked the current preview URL,
 * built a new one, bumped the recorder's operation token, and replaced the
 * attachment and its consent — and only failed later, at the payment button.
 *
 * The per-picker lane is a smaller, separate claim, and the difference matters.
 * Routing never depended on which input fired: `attachedFileIsAudio` in this
 * section and `isStoryAudioFile` in `checkout-form.tsx` both read the FILE, so a
 * PDF chosen in the audio picker was already stored, rendered, and consented to
 * as a document. Binding a lane per input fixes no routing bug — it is a UX
 * guard that refuses at the click a selection which would otherwise land under
 * the other heading. The file-based routing it sits in front of stays
 * load-bearing and is not replaced here.
 *
 * The fix reuses the ONE authoritative classifier that already canonicalizes
 * Safari's `audio/x-m4a`. This module adds no MIME list of its own; it decides
 * which of the two existing lanes a picked file may enter, and WHY a refusal
 * happened — a distinction `classifyStoryAttachment` collapses into `invalid`,
 * and the difference between copy that helps and copy that names the very
 * format it is refusing.
 *
 * Why the component assertions are source-level: the repo's `node --test`
 * harness strips TypeScript types but cannot parse JSX, so
 * `VoiceRecorderSection.tsx` is not importable here. The decision logic it
 * calls is exercised for real below; the wiring is pinned over its source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  STORY_MEDIA_RECORDING_REFUSAL_MESSAGE,
  checkStoryMediaLane,
  storyMediaAcceptedFormatsLabel,
} from '../src/lib/story-media-lane.ts';
import {
  AUDIO_MIME_BY_EXTENSION,
  DOCUMENT_MIME_BY_EXTENSION,
} from '../src/lib/checkout-media-mime.ts';
import { classifyStoryAttachment, recordedStoryAudioFileName } from '../src/lib/story-attachment.ts';

const MIB = 1024 * 1024;

const COMPONENT_SRC = readFileSync('src/components/checkout/VoiceRecorderSection.tsx', 'utf8');
const LANE_SRC = readFileSync('src/lib/story-media-lane.ts', 'utf8');

/** A File-shaped identity; `size` is set independently so no bytes are allocated. */
function file(name: string, type: string, size = 1024) {
  return { name, type, size };
}

function messageOf(verdict: ReturnType<typeof checkStoryMediaLane>): string {
  return verdict.ok === false ? verdict.message : '';
}

// ── The supported selections keep working, canonicalized ─────────────────────

test("Safari's .m4a voice memo is accepted into the audio lane as audio/mp4", () => {
  const verdict = checkStoryMediaLane(file('memo.m4a', 'audio/x-m4a', 3 * MIB), 'audio');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok === true && verdict.kind, 'audio');
  assert.equal(verdict.ok === true && verdict.mimeType, 'audio/mp4');
});

test('the audio/mp3 alias is accepted into the audio lane as audio/mpeg', () => {
  const verdict = checkStoryMediaLane(file('note.mp3', 'audio/mp3'), 'audio');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok === true && verdict.mimeType, 'audio/mpeg');
});

test('a type-less audio file is derived from its extension, exactly as the classifier does', () => {
  const verdict = checkStoryMediaLane(file('memo.m4a', ''), 'audio');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok === true && verdict.mimeType, 'audio/mp4');
});

test('every supported document type is accepted into the document lane', () => {
  for (const [extension, mimeType] of Object.entries(DOCUMENT_MIME_BY_EXTENSION)) {
    const verdict = checkStoryMediaLane(file(`memory.${extension}`, mimeType), 'document');
    assert.equal(verdict.ok, true, `${extension} must be accepted`);
    assert.equal(verdict.ok === true && verdict.mimeType, mimeType);
  }
});

test('every supported audio extension is accepted into the audio lane', () => {
  for (const [extension, mimeType] of Object.entries(AUDIO_MIME_BY_EXTENSION)) {
    const verdict = checkStoryMediaLane(file(`memo.${extension}`, mimeType), 'audio');
    assert.equal(verdict.ok, true, `${extension} must be accepted`);
    assert.equal(verdict.ok === true && verdict.mimeType, mimeType);
  }
});

test('the lane verdict agrees with the authoritative classifier, never widening it', () => {
  const candidates = [
    file('memo.m4a', 'audio/x-m4a'),
    file('note.mp3', 'audio/mp3'),
    file('memory.pdf', 'application/pdf'),
    file('memory.docx', ''),
    file('payload.exe', 'application/x-msdownload'),
    file('clip.mp4', 'video/mp4'),
    file('memory.pdf', 'audio/mpeg'),
    file('photo.jpg', 'image/jpeg'),
  ];
  for (const candidate of candidates) {
    const classification = classifyStoryAttachment(candidate);
    for (const lane of ['audio', 'document'] as const) {
      const verdict = checkStoryMediaLane(candidate, lane);
      const expected = classification.kind === lane;
      assert.equal(verdict.ok, expected, `${candidate.name} (${candidate.type}) in the ${lane} lane`);
      if (verdict.ok === true) assert.equal(verdict.mimeType, classification.kind !== 'invalid' ? classification.mimeType : '');
    }
  }
});

// ── Unsupported and contradictory selections are refused ─────────────────────

test('an unsupported file is refused by the audio picker instead of being size-accepted', () => {
  const verdict = checkStoryMediaLane(file('payload.exe', 'application/x-msdownload', 900 * MIB), 'audio');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'unsupported');
});

test('a video file is refused by the audio picker', () => {
  const verdict = checkStoryMediaLane(file('clip.mp4', 'video/mp4'), 'audio');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'unsupported');
});

test('an image is refused by both pickers — this surface is not a photo lane', () => {
  assert.equal(checkStoryMediaLane(file('hero.jpg', 'image/jpeg'), 'audio').ok, false);
  assert.equal(checkStoryMediaLane(file('hero.jpg', 'image/jpeg'), 'document').ok, false);
});

test('a name that contradicts the reported type is refused as a conflict, not as an unsupported format', () => {
  // Each half of the identity names a format this product accepts — they just
  // name DIFFERENT ones. `classifyStoryAttachment` collapses that into
  // `invalid`, but answering it with a format list names the very extension the
  // customer is holding, so re-picking the same file can only fail again.
  const conflicts = [
    [file('memory.docx', 'application/msword'), 'document'],
    [file('memory.pdf', 'audio/mpeg'), 'audio'],
    [file('memory.pdf', 'audio/mpeg'), 'document'],
    [file('memo.wav', 'audio/mpeg'), 'audio'],
    [file('memory.pdf', 'text/plain'), 'document'],
  ] as const;
  for (const [candidate, lane] of conflicts) {
    const verdict = checkStoryMediaLane(candidate, lane);
    assert.equal(verdict.ok, false, `${candidate.name} (${candidate.type}) must be refused`);
    assert.equal(
      verdict.ok === false && verdict.reason,
      'name_type_conflict',
      `${candidate.name} (${candidate.type}) in the ${lane} lane`,
    );
  }
});

test('a format the policy genuinely does not accept stays `unsupported`, whatever its name says', () => {
  const unsupported = [
    [file('payload.exe', 'application/x-msdownload'), 'audio'],
    [file('hero.jpg', 'image/jpeg'), 'document'],
    [file('notes.pages', 'application/x-iwork-pages-sffpages'), 'document'],
    // The extension is in the audio table, but `video/mp4` names no format this
    // product accepts, so the accepted-formats list is the right answer here —
    // not a mismatch story about a file that is simply a video.
    [file('clip.mp4', 'video/mp4'), 'audio'],
    // KNOWN GAP, pinned as-is and NOT fixed here: `audio/x-flac` is on the
    // server allowlist (`AUDIO_MIME_TYPES`) but absent from `AUDIO_BY_MIME` and
    // `MEDIA_MIME_ALIASES`, so a .flac file whose browser reports that alias is
    // refused while the label still names FLAC. Nothing in the lane module can
    // tell that apart from `video/mp4` without keeping a MIME list of its own —
    // the fix belongs in story-attachment.ts.
    [file('memory.flac', 'audio/x-flac'), 'audio'],
  ] as const;
  for (const [candidate, lane] of unsupported) {
    const verdict = checkStoryMediaLane(candidate, lane);
    assert.equal(verdict.ok, false, `${candidate.name} (${candidate.type}) must be refused`);
    assert.equal(
      verdict.ok === false && verdict.reason,
      'unsupported',
      `${candidate.name} (${candidate.type}) in the ${lane} lane`,
    );
  }
});

// ── The picker lane is enforced, not merely hinted at by `accept` ─────────────

test('a supported document chosen in the audio picker is refused', () => {
  const verdict = checkStoryMediaLane(file('memory.pdf', 'application/pdf'), 'audio');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'wrong_lane');
});

test('a supported voice memo chosen in the document picker is refused', () => {
  const verdict = checkStoryMediaLane(file('memo.m4a', 'audio/x-m4a'), 'document');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.reason, 'wrong_lane');
});

// ── Customer copy: names the accepted formats, and cannot drift from them ────

test('the accepted-formats label is derived from the shared tables, not retyped', () => {
  const audio = storyMediaAcceptedFormatsLabel('audio');
  const document = storyMediaAcceptedFormatsLabel('document');

  for (const extension of Object.keys(AUDIO_MIME_BY_EXTENSION)) {
    assert.match(audio, new RegExp(`\\b${extension.toUpperCase()}\\b`), `audio label must name ${extension}`);
  }
  for (const extension of Object.keys(DOCUMENT_MIME_BY_EXTENSION)) {
    assert.match(document, new RegExp(`\\b${extension.toUpperCase()}\\b`), `document label must name ${extension}`);
  }
  // Nothing the policy does not accept may be advertised.
  for (const label of [audio, document]) {
    assert.doesNotMatch(label, /HEIC|HEIF|JPEG|JPG|PNG|EXE|MOV|AVI|PAGES|RTF|ODT/i);
  }
  assert.doesNotMatch(document, /\bMP3\b/);
  assert.doesNotMatch(audio, /\bPDF\b/);
});

test('a refusal tells the customer which formats that picker takes, and claims nothing else', () => {
  const unsupported = messageOf(checkStoryMediaLane(file('payload.exe', 'application/x-msdownload'), 'audio'));
  const wrongLane = messageOf(checkStoryMediaLane(file('memory.pdf', 'application/pdf'), 'audio'));
  const documentUnsupported = messageOf(checkStoryMediaLane(file('payload.exe', 'application/x-msdownload'), 'document'));
  const conflict = messageOf(checkStoryMediaLane(file('memory.docx', 'application/msword'), 'document'));

  assert.ok(unsupported.includes(storyMediaAcceptedFormatsLabel('audio')));
  assert.ok(wrongLane.includes(storyMediaAcceptedFormatsLabel('audio')));
  assert.ok(documentUnsupported.includes(storyMediaAcceptedFormatsLabel('document')));
  assert.notEqual(unsupported, wrongLane);
  assert.notEqual(unsupported, documentUnsupported);
  assert.notEqual(unsupported, conflict);
  assert.notEqual(wrongLane, conflict);

  for (const message of [unsupported, wrongLane, documentUnsupported, conflict]) {
    assert.ok(message.length <= 220, `refusal copy must stay concise: ${message}`);
    // No promise, no gate, no legal claim — this is a format error.
    assert.doesNotMatch(message, /clon|training|review|guarantee|refund|compliant|legal|GDPR|COPPA|error code/i);
  }
});

test('the wrong-lane refusal names the OTHER picker, and an unsupported one names no picker at all', () => {
  // Swapping the two message bodies must fail here. Each is pinned to the one
  // thing only it may say: wrong-lane points at the button that WOULD take this
  // file, unsupported points at the formats this picker takes. Without both
  // halves the suite survives the swap and the copy can silently invert.
  const AUDIO_BUTTON = 'Upload audio file';
  const DOCUMENT_BUTTON = 'Upload document';
  // The button a message sends the customer to has to be a button on screen.
  assert.ok(COMPONENT_SRC.includes(`aria-label="${AUDIO_BUTTON}"`), 'the audio picker label must match the copy');
  assert.ok(COMPONENT_SRC.includes(`aria-label="${DOCUMENT_BUTTON}"`), 'the document picker label must match the copy');

  const wrongLaneInAudio = messageOf(checkStoryMediaLane(file('memory.pdf', 'application/pdf'), 'audio'));
  const wrongLaneInDocument = messageOf(checkStoryMediaLane(file('memo.m4a', 'audio/x-m4a'), 'document'));
  const unsupportedInAudio = messageOf(checkStoryMediaLane(file('payload.exe', 'application/x-msdownload'), 'audio'));
  const unsupportedInDocument = messageOf(checkStoryMediaLane(file('payload.exe', 'application/x-msdownload'), 'document'));

  assert.ok(
    wrongLaneInAudio.includes(DOCUMENT_BUTTON),
    'a document in the audio picker must be sent to the document picker by name',
  );
  assert.ok(
    wrongLaneInDocument.includes(AUDIO_BUTTON),
    'a voice memo in the document picker must be sent to the audio picker by name',
  );
  for (const message of [unsupportedInAudio, unsupportedInDocument]) {
    assert.doesNotMatch(
      message,
      /Upload (?:audio file|document)/,
      `unsupported copy must not send the customer to a picker that would refuse it too: ${message}`,
    );
  }
  assert.ok(unsupportedInAudio.includes(storyMediaAcceptedFormatsLabel('audio')));
  assert.ok(unsupportedInDocument.includes(storyMediaAcceptedFormatsLabel('document')));
});

test('a name/type conflict names the mismatch and advertises no format it is refusing', () => {
  const conflict = messageOf(checkStoryMediaLane(file('memory.docx', 'application/msword'), 'document'));

  assert.match(conflict, /name/i, 'the copy must say which two things disagree');
  assert.match(conflict, /type/i, 'the copy must say which two things disagree');
  // The whole point: a file whose extension the product DOES accept must not be
  // answered with a list that names that extension.
  assert.ok(!conflict.includes(storyMediaAcceptedFormatsLabel('document')));
  assert.ok(!conflict.includes(storyMediaAcceptedFormatsLabel('audio')));
  assert.doesNotMatch(conflict, /\bDOCX?\b|\bPDF\b|\bTXT\b|\bMP3\b|\bM4A\b/);
  // And never echo the filename or the reported type back at the customer.
  assert.doesNotMatch(conflict, /memory|msword|application\/|audio\/|\.docx/i);
  assert.doesNotMatch(conflict, /Upload (?:audio file|document)/);
});

// ── No second MIME policy, and no server reach from the browser ──────────────

test('the lane module declares no MIME or extension list of its own', () => {
  assert.match(LANE_SRC, /from '\.\/story-attachment\.ts'/);
  assert.match(LANE_SRC, /from '\.\/checkout-media-mime\.ts'/);
  // Any literal MIME string here would be a second policy that can drift.
  const source = LANE_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(source, /['"](?:audio|image|video|text|application)\/[\w.+-]+['"]/);
});

test('the lane module is browser-safe', () => {
  assert.doesNotMatch(LANE_SRC, /from '(node:|@vercel\/blob|stripe)/);
});

// ── Wiring: classification runs at selection time, before anything else ──────

test('each picker has its own lane-specific handler — the lane is never inferred', () => {
  // The audio input and the document input must not share one ambient handler.
  assert.match(
    COMPONENT_SRC,
    /id="custom-story-audio-upload"[\s\S]{0,400}?onChange=\{handleAudioUpload\}/,
    'the audio input must use the audio-lane handler',
  );
  assert.match(
    COMPONENT_SRC,
    /id="custom-story-document-upload"[\s\S]{0,400}?onChange=\{handleDocumentUpload\}/,
    'the document input must use the document-lane handler',
  );
  assert.doesNotMatch(COMPONENT_SRC, /onChange=\{handleUpload\}/);

  // The lane comes from the handler that fired, not from anything mutable.
  assert.match(COMPONENT_SRC, /handleAudioUpload[\s\S]{0,200}?'audio'/);
  assert.match(COMPONENT_SRC, /handleDocumentUpload[\s\S]{0,200}?'document'/);
  assert.doesNotMatch(COMPONENT_SRC, /className[\s\S]{0,80}?\?\s*'audio'/);
  assert.doesNotMatch(COMPONENT_SRC, /event\.target\.(?:accept|id|className|dataset)/);
});

test('a picked file is classified before any preview, state, consent, or authority change', () => {
  const start = COMPONENT_SRC.indexOf('const handleUpload =');
  const end = COMPONENT_SRC.indexOf('const handleRemove =');
  assert.ok(start > -1 && end > start, 'handleUpload must exist');
  const body = COMPONENT_SRC.slice(start, end);

  const lane = body.indexOf('checkStoryMediaLane(file, lane)');
  assert.ok(lane > -1, 'handleUpload must run the shared lane/type preflight for the firing picker');
  assert.ok(lane < body.indexOf('URL.createObjectURL'), 'classification must precede createObjectURL');
  assert.ok(lane < body.indexOf('URL.revokeObjectURL'), 'classification must precede revoking the existing preview');
  assert.ok(lane < body.indexOf('onVoiceChange('), 'classification must precede onVoiceChange');
  assert.ok(
    lane < body.indexOf('mediaOperationRef.current += 1'),
    'classification must precede bumping recorder authority',
  );
  // An unsupported file must never be handed to the size check as if accepted.
  assert.ok(
    lane < body.indexOf('checkStoryMediaFileSize(file)'),
    'classification must precede the size preflight',
  );
});

test('a refused selection preserves the current attachment, preview, consent, and authority', () => {
  const start = COMPONENT_SRC.indexOf('const handleUpload =');
  const end = COMPONENT_SRC.indexOf('const handleRemove =');
  const body = COMPONENT_SRC.slice(start, end);

  const rejection = /if \(laneVerdict\.ok === false\) \{([\s\S]*?)\n {6}\}/.exec(body);
  assert.ok(rejection, 'handleUpload must have an early type-rejection branch');
  const rejectionBody = rejection![1]!;

  assert.match(rejectionBody, /setRecorderError\(laneVerdict\.message\)/);
  // Only the newly rejected input is cleared, so re-picking re-fires onChange.
  assert.match(rejectionBody, /event\.target\.value = ''/);
  assert.match(rejectionBody, /return;/);
  assert.doesNotMatch(rejectionBody, /URL\.createObjectURL/);
  assert.doesNotMatch(rejectionBody, /URL\.revokeObjectURL/);
  assert.doesNotMatch(rejectionBody, /onVoiceChange|onConsentChange|mediaOperationRef/);
});

// ── The recorded lane goes through the same verdict as the picked one ────────

test('a recording this browser cannot express as audio is refused by the same lane verdict', () => {
  // `recordedStoryAudioFileName` falls back to `.webm` for any type it cannot
  // map, so a non-audio `recorder.mimeType` mints a File the classifier calls
  // invalid — the same late `asset_mime_invalid` this surface exists to prevent,
  // reached by the one path that never asked for a type verdict.
  const recorded = file(recordedStoryAudioFileName('video/webm'), 'video/webm');
  assert.equal(recorded.name, 'child-voice-note.webm');
  assert.equal(classifyStoryAttachment(recorded).kind, 'invalid');
  assert.equal(checkStoryMediaLane(recorded, 'audio').ok, false);
});

test('every format this recorder actually asks for still survives that verdict', () => {
  const declared = /const candidates = \[([^\]]*)\]/.exec(COMPONENT_SRC);
  assert.ok(declared, 'the recorder must declare its candidate MIME types');
  const candidates = [...declared![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  assert.ok(candidates.length > 0, 'the candidate list must not be empty');
  // Plus the fallback the stop handler uses when the recorder reports nothing.
  for (const mimeType of [...candidates, 'audio/webm']) {
    const recorded = file(recordedStoryAudioFileName(mimeType), mimeType);
    assert.equal(
      checkStoryMediaLane(recorded, 'audio').ok,
      true,
      `a ${mimeType} recording must not be refused by its own gate`,
    );
  }
});

test('a refused recording keeps the existing attachment and gets recorder copy, not picker copy', () => {
  const start = COMPONENT_SRC.indexOf('const handleRecord =');
  const end = COMPONENT_SRC.indexOf('const handleStop =');
  assert.ok(start > -1 && end > start, 'handleRecord must exist');
  const body = COMPONENT_SRC.slice(start, end);

  const lane = body.indexOf("checkStoryMediaLane(file, 'audio')");
  assert.ok(lane > -1, 'the recorded file must go through the same lane verdict as a picked one');
  assert.ok(lane < body.indexOf('URL.createObjectURL'), 'the verdict must precede minting a preview URL');
  assert.ok(lane < body.indexOf('URL.revokeObjectURL'), 'the verdict must precede revoking the existing preview');
  assert.ok(lane < body.indexOf('onVoiceChange('), 'the verdict must precede replacing the attachment');

  const rejection = /if \(recordedVerdict\.ok === false\) \{([\s\S]*?)\n {8}\}/.exec(body);
  assert.ok(rejection, 'the recording rejection branch must exist');
  const rejectionBody = rejection![1]!;
  assert.match(rejectionBody, /setRecorderError\(STORY_MEDIA_RECORDING_REFUSAL_MESSAGE\)/);
  assert.match(rejectionBody, /return;/);
  assert.doesNotMatch(rejectionBody, /URL\.createObjectURL|URL\.revokeObjectURL/);
  assert.doesNotMatch(rejectionBody, /onVoiceChange|onConsentChange/);

  // The customer chose no file and named nothing — `recordedStoryAudioFileName`
  // did — so "your name and type disagree" and "pick one of these formats" are
  // both answers to a question they were never asked.
  assert.match(STORY_MEDIA_RECORDING_REFUSAL_MESSAGE, /upload/i, 'the copy must point at the path that works');
  assert.doesNotMatch(STORY_MEDIA_RECORDING_REFUSAL_MESSAGE, /name/i);
  assert.ok(!STORY_MEDIA_RECORDING_REFUSAL_MESSAGE.includes(storyMediaAcceptedFormatsLabel('audio')));
  assert.ok(STORY_MEDIA_RECORDING_REFUSAL_MESSAGE.length <= 220);
});

test('the section still keeps no private type policy of its own', () => {
  assert.match(COMPONENT_SRC, /from '@\/lib\/story-media-lane'/);
  assert.doesNotMatch(COMPONENT_SRC, /['"]audio\/\*['"]/);
  // The pickers' `accept` hints stay as they are; no new MIME judgement here.
  assert.doesNotMatch(COMPONENT_SRC, /MEDIA_MIME_ALIASES|AUDIO_MIME_TYPES|DOCUMENT_MIME_TYPES/);
});

test('a refused selection still cannot reach intake, the order route, or Stripe', () => {
  assert.doesNotMatch(COMPONENT_SRC, /\bfetch\s*\(/);
  assert.doesNotMatch(COMPONENT_SRC, /\/api\/(order|checkout|intake)/);
  assert.doesNotMatch(COMPONENT_SRC, /reserveIntakeUpload|uploadIntakeFile|prepareOrReuseDirectIntakeSubmission|stripe/i);
});
