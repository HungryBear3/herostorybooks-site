/**
 * Browser-side size preflight for Custom Story attachments.
 *
 * WHAT THIS PINS
 * --------------
 * A buyer who attaches a 40 MB voice memo or a 12 MB Word file used to learn
 * about it at the payment button: the browser happily built a preview URL,
 * stored the File in checkout state, and only `POST /api/order` (or the direct
 * intake reservation) refused it — after four photos had already been staged.
 *
 * The caps are now declared once, in a browser-safe module, and both the
 * server enforcement (`orders.ts`, `INTAKE_CATEGORY_POLICY`) and the client
 * preflight read that one declaration. The selection surface refuses an
 * oversize file BEFORE `URL.createObjectURL`, before `onVoiceChange`, before
 * any intake reservation, order POST, or Stripe handoff can see it.
 *
 * Why the component assertions are source-level: the repo's `node --test`
 * harness strips TypeScript types but cannot parse JSX, so
 * `VoiceRecorderSection.tsx` is not importable here. The decision logic it
 * calls is exercised for real below; the wiring is pinned by ordering
 * assertions over its source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  STORY_MEDIA_MAX_BYTES,
  checkRecordedStoryAudioSize,
  checkStoryMediaBytes,
  checkStoryMediaFileSize,
  storyMediaMaxBytes,
} from '../src/lib/story-media-size.ts';
import { MAX_DOCUMENT_BYTES, MAX_VOICE_BYTES } from '../src/lib/orders.ts';
import { INTAKE_CATEGORY_POLICY } from '../src/lib/checkout-intake.ts';

const MIB = 1024 * 1024;

const COMPONENT_SRC = readFileSync('src/components/checkout/VoiceRecorderSection.tsx', 'utf8');
const CHECKOUT_FORM_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

/**
 * The early-return branch guarding an oversize selection, at `indent` spaces.
 *
 * Either spelling of the discriminant check is accepted — `!v.ok` and
 * `v.ok === false` are the same guard, and only the latter narrows the verdict
 * union well enough for `tsc` to reach `.message`. What this pins is the
 * branch's CONTENTS, asserted by the caller.
 */
const REJECTION_BRANCH = (indent: number) =>
  new RegExp(`if \\((?:!\\w+\\.ok|\\w+\\.ok === false)\\) \\{([\\s\\S]*?)\\n {${indent}}\\}`);

/** A File-shaped identity; `size` is set independently so no bytes are allocated. */
function fileOfSize(name: string, type: string, size: number) {
  return { name, type, size };
}

// ── One canonical declaration ────────────────────────────────────────────────

test('the canonical module declares exactly 15 MiB audio and 10 MiB document caps', () => {
  assert.equal(STORY_MEDIA_MAX_BYTES.audio, 15 * 1024 * 1024);
  assert.equal(STORY_MEDIA_MAX_BYTES.document, 10 * 1024 * 1024);
  assert.equal(storyMediaMaxBytes('audio'), 15 * 1024 * 1024);
  assert.equal(storyMediaMaxBytes('document'), 10 * 1024 * 1024);
});

test('server enforcement reads the canonical caps rather than its own copy', () => {
  // The legacy order route and uploadOrderDocument still import these names.
  assert.equal(MAX_VOICE_BYTES, STORY_MEDIA_MAX_BYTES.audio);
  assert.equal(MAX_DOCUMENT_BYTES, STORY_MEDIA_MAX_BYTES.document);
  assert.equal(INTAKE_CATEGORY_POLICY.voice_inspiration.maxBytes, STORY_MEDIA_MAX_BYTES.audio);
  assert.equal(INTAKE_CATEGORY_POLICY.document_inspiration.maxBytes, STORY_MEDIA_MAX_BYTES.document);

  const ordersSrc = readFileSync('src/lib/orders.ts', 'utf8');
  const intakeSrc = readFileSync('src/lib/checkout-intake.ts', 'utf8');
  assert.match(ordersSrc, /export const MAX_VOICE_BYTES = STORY_MEDIA_MAX_BYTES\.audio/);
  assert.match(ordersSrc, /export const MAX_DOCUMENT_BYTES = STORY_MEDIA_MAX_BYTES\.document/);
  assert.match(intakeSrc, /voice_inspiration:[\s\S]*?maxBytes: STORY_MEDIA_MAX_BYTES\.audio/);
  assert.match(intakeSrc, /document_inspiration:[\s\S]*?maxBytes: STORY_MEDIA_MAX_BYTES\.document/);
});

test('the canonical module is browser-safe', () => {
  const src = readFileSync('src/lib/story-media-size.ts', 'utf8');
  assert.doesNotMatch(src, /from '(node:|@vercel\/blob|stripe)/);
});

// ── Boundary: exactly at the limit passes, one byte over is refused ──────────

test('an audio file at exactly 15 MiB is accepted and 15 MiB + 1 is refused', () => {
  assert.equal(checkStoryMediaFileSize(fileOfSize('note.mp3', 'audio/mpeg', 15 * MIB)).ok, true);

  const verdict = checkStoryMediaFileSize(fileOfSize('note.mp3', 'audio/mpeg', 15 * MIB + 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.kind, 'audio');
  assert.match(verdict.ok === false ? verdict.message : '', /15 MB/);
});

test('a document at exactly 10 MiB is accepted and 10 MiB + 1 is refused', () => {
  assert.equal(checkStoryMediaFileSize(fileOfSize('memory.pdf', 'application/pdf', 10 * MIB)).ok, true);

  const verdict = checkStoryMediaFileSize(fileOfSize('memory.pdf', 'application/pdf', 10 * MIB + 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.kind, 'document');
  assert.match(verdict.ok === false ? verdict.message : '', /10 MB/);
});

// ── The two lanes carry their own cap ────────────────────────────────────────

test('a 12 MiB document is refused even though it would fit the audio cap', () => {
  const verdict = checkStoryMediaFileSize(fileOfSize('memory.docx', 'application/pdf', 12 * MIB));
  // Contradictory name/type is the classifier's business; use a coherent pair.
  assert.equal(verdict.ok, true, 'contradictory pairs are the type boundary, not the size boundary');

  const coherent = checkStoryMediaFileSize(fileOfSize('memory.pdf', 'application/pdf', 12 * MIB));
  assert.equal(coherent.ok, false);
  assert.equal(coherent.ok === false && coherent.kind, 'document');
});

test('a 12 MiB audio file is accepted — the document cap does not leak into the audio lane', () => {
  assert.equal(checkStoryMediaFileSize(fileOfSize('note.m4a', 'audio/mp4', 12 * MIB)).ok, true);
});

// ── Classification boundary is reused, not widened ───────────────────────────

test("Safari's audio/x-m4a is judged against the audio cap", () => {
  assert.equal(checkStoryMediaFileSize(fileOfSize('memo.m4a', 'audio/x-m4a', 15 * MIB)).ok, true);

  const verdict = checkStoryMediaFileSize(fileOfSize('memo.m4a', 'audio/x-m4a', 15 * MIB + 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.kind, 'audio');
});

test('an oversize file of an unsupported type gets no size verdict — the type boundary owns it', () => {
  // Refusing this here would invent a second, contradictory type policy.
  assert.equal(checkStoryMediaFileSize(fileOfSize('payload.exe', 'application/x-msdownload', 900 * MIB)).ok, true);
});

test('a type-less document is derived from its extension and judged as a document', () => {
  const verdict = checkStoryMediaFileSize(fileOfSize('memory.docx', '', 10 * MIB + 1));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.kind, 'document');
});

// ── Recorded blobs ───────────────────────────────────────────────────────────

test('a recorded blob at exactly 15 MiB is accepted and 15 MiB + 1 is refused', () => {
  assert.equal(checkRecordedStoryAudioSize({ size: 15 * MIB }).ok, true);

  const verdict = checkRecordedStoryAudioSize({ size: 15 * MIB + 1 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.kind, 'audio');
  assert.match(verdict.ok === false ? verdict.message : '', /15 MB/);
});

// ── Customer copy ────────────────────────────────────────────────────────────

test('refusal copy names the media, the actual size, and the limit — and claims nothing else', () => {
  const audio = checkStoryMediaBytes('audio', 18 * MIB + 512 * 1024);
  const document = checkStoryMediaBytes('document', 12 * MIB);
  assert.equal(audio.ok, false);
  assert.equal(document.ok, false);
  const audioMessage = audio.ok === false ? audio.message : '';
  const documentMessage = document.ok === false ? document.message : '';

  assert.match(audioMessage, /18\.5 MB/);
  assert.match(audioMessage, /15 MB/);
  assert.match(documentMessage, /12\.0 MB/);
  assert.match(documentMessage, /10 MB/);
  assert.notEqual(audioMessage, documentMessage);

  for (const message of [audioMessage, documentMessage]) {
    assert.ok(message.length <= 160, `refusal copy must stay concise: ${message}`);
    assert.doesNotMatch(message, /clon|training|every order|compliant|legal|GDPR|COPPA/i);
  }
});

// ── Wiring: the refusal happens before anything irreversible ─────────────────

test('an uploaded selection is size-checked before any preview URL, state, or recorder authority change', () => {
  const start = COMPONENT_SRC.indexOf('const handleUpload =');
  const end = COMPONENT_SRC.indexOf('const handleRemove =');
  assert.ok(start > -1 && end > start, 'handleUpload must exist');
  const body = COMPONENT_SRC.slice(start, end);

  const check = body.indexOf('checkStoryMediaFileSize(file)');
  assert.ok(check > -1, 'handleUpload must run the canonical size preflight');
  assert.ok(check < body.indexOf('URL.createObjectURL'), 'preflight must precede createObjectURL');
  assert.ok(check < body.indexOf('URL.revokeObjectURL'), 'preflight must precede revoking the existing preview');
  assert.ok(check < body.indexOf('onVoiceChange('), 'preflight must precede onVoiceChange');
  assert.ok(
    check < body.indexOf('mediaOperationRef.current += 1'),
    'preflight must precede bumping recorder authority',
  );

  // The rejection branch returns without touching attachment state, and still
  // clears the native input so reselecting the same file re-fires onChange.
  const rejection = REJECTION_BRANCH(6).exec(body);
  assert.ok(rejection, 'handleUpload must have an early rejection branch');
  const rejectionBody = rejection![1]!;
  assert.match(rejectionBody, /event\.target\.value = ''/);
  assert.match(rejectionBody, /return;/);
  assert.doesNotMatch(rejectionBody, /URL\.createObjectURL/);
  assert.doesNotMatch(rejectionBody, /URL\.revokeObjectURL/);
  assert.doesNotMatch(rejectionBody, /onVoiceChange|onConsentChange|mediaOperationRef/);
});

test('a recorded blob is size-checked before the preview URL replaces recorder state', () => {
  const start = COMPONENT_SRC.indexOf("recorder.addEventListener('stop'");
  const end = COMPONENT_SRC.indexOf('mediaRecorderRef.current = recorder;');
  assert.ok(start > -1 && end > start, 'the recorder stop handler must exist');
  const body = COMPONENT_SRC.slice(start, end);

  const check = body.indexOf('checkRecordedStoryAudioSize(blob)');
  assert.ok(check > -1, 'the stop handler must run the canonical size preflight');
  assert.ok(check < body.indexOf('URL.createObjectURL'), 'preflight must precede createObjectURL');
  assert.ok(check < body.indexOf('URL.revokeObjectURL'), 'preflight must precede revoking the existing preview');
  assert.ok(check < body.indexOf('onVoiceChange('), 'preflight must precede onVoiceChange');

  const rejection = REJECTION_BRANCH(8).exec(body.slice(check));
  assert.ok(rejection, 'the stop handler must have an early rejection branch');
  const rejectionBody = rejection![1]!;
  assert.match(rejectionBody, /return;/);
  assert.doesNotMatch(rejectionBody, /URL\.createObjectURL/);
  assert.doesNotMatch(rejectionBody, /URL\.revokeObjectURL/);
  assert.doesNotMatch(rejectionBody, /onVoiceChange|onConsentChange/);
});

test('the refusal is announced, not merely painted', () => {
  assert.match(COMPONENT_SRC, /role="alert"[\s\S]{0,200}\{recorderError\}|\{recorderError\}[\s\S]{0,200}role="alert"/);
});

test('the section keeps no private copy of the caps', () => {
  assert.match(COMPONENT_SRC, /from '@\/lib\/story-media-size'/);
  assert.doesNotMatch(COMPONENT_SRC, /15 \* 1024|10 \* 1024 \* 1024|MAX_VOICE_BYTES = |MAX_DOCUMENT_BYTES = /);
});

// ── Zero intake / order / payment traffic from a refused selection ───────────

test('the recorder section issues no intake, order, or payment request of its own', () => {
  assert.doesNotMatch(COMPONENT_SRC, /\bfetch\s*\(/);
  assert.doesNotMatch(COMPONENT_SRC, /\/api\/(order|checkout|intake)/);
  assert.doesNotMatch(COMPONENT_SRC, /reserveIntakeUpload|uploadIntakeFile|prepareOrReuseDirectIntakeSubmission|stripe/i);
});

test('every attachment upload and payment path downstream is gated on the file the section handed up', () => {
  // onVoiceChange is the only writer of form.voiceFile, and form.voiceFile is
  // the only source of the submitted attachment — so a refused selection can
  // reach neither direct intake, nor POST /api/order, nor Stripe.
  assert.match(CHECKOUT_FORM_SRC, /const attachedStoryFile = isCustomStorySelected \? form\.voiceFile : null/);
  assert.match(CHECKOUT_FORM_SRC, /voice:\s*\n?\s*attachedStoryFile && attachedStoryFileIsAudio && form\.voiceSource/);
  assert.match(CHECKOUT_FORM_SRC, /document:\s*\n?\s*attachedStoryFile && !attachedStoryFileIsAudio/);
  assert.match(CHECKOUT_FORM_SRC, /if \(attachedStoryFile && attachedStoryFileIsAudio\) \{[\s\S]*?payload\.set\("voice", attachedStoryFile\)/);
  assert.match(CHECKOUT_FORM_SRC, /else if \(attachedStoryFile\) \{[\s\S]*?payload\.set\("document", attachedStoryFile\)/);

  const writers = CHECKOUT_FORM_SRC.match(/voiceFile:/g) ?? [];
  // Declaration, initial state, the two resets, and the onVoiceChange writer.
  assert.ok(writers.length > 0);
  assert.match(CHECKOUT_FORM_SRC, /onVoiceChange=\{\([\s\S]*?voiceFile: file,/);
});
