/**
 * Client/server MIME parity for the direct private-intake path.
 *
 * The browser decides what a selected file "is" with `classifyStoryAttachment`
 * and hands that string to `reserve-upload`, where `INTAKE_CATEGORY_POLICY`
 * judges it by exact match. The two used to be maintained separately, and the
 * owner incident of 2026-09-04 was the gap between them: an iPhone Voice Memo
 * (`.m4a`, reported by Safari as `audio/x-m4a`) was accepted by the classifier
 * and refused by the server as `asset_mime_invalid`.
 *
 * This suite is the pin: every MIME string the client can emit for an audio or
 * document attachment must be a string the server category policy accepts.
 * The same kind of pin already exists for slot keys
 * (`checkout-intake-client-flow.test.ts`); MIME had none.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { INTAKE_CATEGORY_POLICY } from '../src/lib/checkout-intake.ts';
import { classifyStoryAttachment } from '../src/lib/story-attachment.ts';

/**
 * Browser-reported MIME strings that real file pickers and recorders produce
 * for the audio formats the product already accepts. Aliases are included on
 * purpose: Safari reports `.m4a` as `audio/x-m4a`, some Android pickers
 * report `.mp3` as `audio/mp3`, and AIFF is commonly `audio/x-aiff`.
 */
const BROWSER_AUDIO_INPUTS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'New Recording 3.m4a', type: 'audio/x-m4a' },
  { name: 'New Recording 3.m4a', type: 'audio/mp4' },
  { name: 'memo.mp3', type: 'audio/mp3' },
  { name: 'memo.mp3', type: 'audio/mpeg' },
  { name: 'memo.aiff', type: 'audio/x-aiff' },
  { name: 'memo.aif', type: 'audio/aiff' },
  { name: 'memo.wav', type: 'audio/wav' },
  { name: 'memo.wav', type: 'audio/x-wav' },
  { name: 'memo.ogg', type: 'audio/ogg' },
  { name: 'memo.oga', type: 'audio/ogg' },
  { name: 'memo.aac', type: 'audio/aac' },
  { name: 'memo.flac', type: 'audio/flac' },
  { name: 'memo.caf', type: 'audio/x-caf' },
  { name: 'child-voice-note.webm', type: 'audio/webm;codecs=opus' },
  { name: 'child-voice-note.webm', type: 'audio/webm' },
  { name: 'child-voice-note.m4a', type: 'audio/mp4' },
  { name: 'child-voice-note.ogg', type: 'audio/ogg' },
];

/** The empty-MIME lane: the picker knew the extension but not the type. */
const EMPTY_TYPE_AUDIO_NAMES = [
  'memo.webm', 'memo.ogg', 'memo.oga', 'memo.mp4', 'memo.m4a', 'memo.aac',
  'memo.mp3', 'memo.wav', 'memo.flac', 'memo.caf', 'memo.aif', 'memo.aiff',
];

const BROWSER_DOCUMENT_INPUTS: ReadonlyArray<{ name: string; type: string }> = [
  { name: 'notes.txt', type: 'text/plain' },
  { name: 'notes.pdf', type: 'application/pdf' },
  { name: 'notes.doc', type: 'application/msword' },
  { name: 'notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { name: 'notes.txt', type: '' },
  { name: 'notes.pdf', type: 'application/octet-stream' },
];

test('every audio MIME the client classifier emits is accepted by the server voice policy', () => {
  const allowed = INTAKE_CATEGORY_POLICY.voice_inspiration.allowedMimeTypes;
  const refused: string[] = [];
  for (const input of BROWSER_AUDIO_INPUTS) {
    const classified = classifyStoryAttachment(input);
    assert.equal(classified.kind, 'audio', `${input.name} (${input.type}) must classify as audio`);
    if (classified.kind === 'audio' && !allowed.includes(classified.mimeType)) {
      refused.push(`${input.type} -> ${classified.mimeType}`);
    }
  }
  assert.deepEqual(refused, [], 'client-accepted audio MIME strings the server would refuse');
});

test('the empty-MIME audio extension lane emits only server-accepted MIME strings', () => {
  const allowed = INTAKE_CATEGORY_POLICY.voice_inspiration.allowedMimeTypes;
  const refused: string[] = [];
  for (const name of EMPTY_TYPE_AUDIO_NAMES) {
    const classified = classifyStoryAttachment({ name, type: '' });
    assert.equal(classified.kind, 'audio', `${name} with no MIME must classify as audio by extension`);
    if (classified.kind === 'audio' && !allowed.includes(classified.mimeType)) {
      refused.push(`${name} -> ${classified.mimeType}`);
    }
  }
  assert.deepEqual(refused, [], 'extension-derived audio MIME strings the server would refuse');
});

test('every document MIME the client classifier emits is accepted by the server document policy', () => {
  const allowed = INTAKE_CATEGORY_POLICY.document_inspiration.allowedMimeTypes;
  for (const input of BROWSER_DOCUMENT_INPUTS) {
    const classified = classifyStoryAttachment(input);
    assert.equal(classified.kind, 'document', `${input.name} (${input.type}) must classify as a document`);
    if (classified.kind === 'document') {
      assert.ok(allowed.includes(classified.mimeType), `${input.type} -> ${classified.mimeType} must be server-accepted`);
    }
  }
});

test('the classifier never emits a browser alias as the reservation MIME', () => {
  for (const [alias, canonical] of [
    ['audio/x-m4a', 'audio/mp4'],
    ['audio/mp3', 'audio/mpeg'],
    ['audio/x-aiff', 'audio/aiff'],
  ] as const) {
    const name = alias === 'audio/x-m4a' ? 'memo.m4a' : alias === 'audio/mp3' ? 'memo.mp3' : 'memo.aiff';
    const classified = classifyStoryAttachment({ name, type: alias });
    assert.equal(classified.kind, 'audio');
    assert.equal(classified.kind === 'audio' && classified.mimeType, canonical, `${alias} must canonicalize to ${canonical}`);
  }
});
