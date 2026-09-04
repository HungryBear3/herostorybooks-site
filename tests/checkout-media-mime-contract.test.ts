/**
 * The one shared MIME contract behind checkout media.
 *
 * `checkout-media-mime.ts` is imported by the browser orchestration, the
 * story-attachment classifier, and the server intake policy. It must stay
 * browser-safe (no Node-only imports) and must be the single place the
 * accepted formats and their browser aliases are written down.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { INTAKE_CATEGORY_POLICY } from '../src/lib/checkout-intake.ts';
import {
  AUDIO_MIME_TYPES,
  DOCUMENT_MIME_TYPES,
  PHOTO_MIME_TYPES,
  canonicalAllowlistedMime,
  canonicalMediaMime,
  mediaClassForCategory,
  normalizeMimeToken,
} from '../src/lib/checkout-media-mime.ts';
import { ALLOWED_PHOTO_MIME_TYPES } from '../src/lib/photo-upload.ts';

test('the shared MIME module has no Node-only imports', () => {
  const source = readFileSync('src/lib/checkout-media-mime.ts', 'utf8');
  assert.doesNotMatch(source, /from ['"]node:/);
  assert.doesNotMatch(source, /require\(/);
  assert.doesNotMatch(source, /@vercel\/blob/);
});

test('normalizeMimeToken trims, lowercases, and strips parameters', () => {
  assert.equal(normalizeMimeToken('  Audio/WebM;codecs=opus '), 'audio/webm');
  assert.equal(normalizeMimeToken('image/JPEG'), 'image/jpeg');
  assert.equal(normalizeMimeToken(''), '');
  assert.equal(normalizeMimeToken(undefined), '');
  assert.equal(normalizeMimeToken(42), '');
});

test('known browser aliases canonicalize to the server-accepted string', () => {
  assert.deepEqual(canonicalMediaMime({ name: 'New Recording 3.m4a', type: 'audio/x-m4a' }, 'audio'), { ok: true, mimeType: 'audio/mp4' });
  assert.deepEqual(canonicalMediaMime({ name: 'memo.mp3', type: 'audio/mp3' }, 'audio'), { ok: true, mimeType: 'audio/mpeg' });
  assert.deepEqual(canonicalMediaMime({ name: 'memo.aiff', type: 'audio/x-aiff' }, 'audio'), { ok: true, mimeType: 'audio/aiff' });
  assert.deepEqual(canonicalMediaMime({ name: 'hero.jpg', type: 'image/jpg' }, 'photo'), { ok: true, mimeType: 'image/jpeg' });
  assert.deepEqual(canonicalMediaMime({ name: 'hero.JPG', type: 'IMAGE/JPEG' }, 'photo'), { ok: true, mimeType: 'image/jpeg' });
  assert.deepEqual(canonicalMediaMime({ name: 'note.webm', type: 'audio/webm;codecs=opus' }, 'audio'), { ok: true, mimeType: 'audio/webm' });
});

test('extension fallback applies only to the audio and document lanes', () => {
  assert.deepEqual(canonicalMediaMime({ name: 'memo.m4a', type: '' }, 'audio'), { ok: true, mimeType: 'audio/mp4' });
  assert.deepEqual(canonicalMediaMime({ name: 'memo.mp3', type: 'application/octet-stream' }, 'audio'), { ok: true, mimeType: 'audio/mpeg' });
  assert.deepEqual(canonicalMediaMime({ name: 'notes.pdf', type: '' }, 'document'), { ok: true, mimeType: 'application/pdf' });
  assert.deepEqual(canonicalMediaMime({ name: 'hero.jpg', type: '' }, 'photo'), { ok: false, reason: 'unspecified' });
  assert.deepEqual(canonicalMediaMime({ name: 'hero.jpg', type: 'application/octet-stream' }, 'photo'), { ok: false, reason: 'unspecified' });
});

test('unsupported photo types are a typed refusal, never a pass-through', () => {
  for (const type of ['image/heic', 'image/heif', 'image/gif', 'image/tiff', 'image/bmp', 'image/svg+xml', 'image/*', 'video/mp4', 'text/plain']) {
    assert.deepEqual(canonicalMediaMime({ name: 'IMG_0421.HEIC', type }, 'photo'), { ok: false, reason: 'unsupported' }, type);
  }
  // A HEIC extension does not rescue an unspecified type either.
  assert.deepEqual(canonicalMediaMime({ name: 'IMG_0421.HEIC', type: '' }, 'photo'), { ok: false, reason: 'unspecified' });
});

test('an audio alias in the wrong lane is refused', () => {
  assert.deepEqual(canonicalMediaMime({ name: 'memo.m4a', type: 'audio/x-m4a' }, 'photo'), { ok: false, reason: 'unsupported' });
  assert.deepEqual(canonicalMediaMime({ name: 'hero.jpg', type: 'image/jpeg' }, 'audio'), { ok: false, reason: 'unsupported' });
  assert.deepEqual(canonicalMediaMime({ name: 'hero.jpg', type: 'image/jpeg' }, 'document'), { ok: false, reason: 'unsupported' });
});

test('the server-side canonicalizer never uses extension fallback and refuses non-allowlisted values', () => {
  assert.equal(canonicalAllowlistedMime('audio/x-m4a', 'audio'), 'audio/mp4');
  assert.equal(canonicalAllowlistedMime('Image/JPG', 'photo'), 'image/jpeg');
  assert.equal(canonicalAllowlistedMime('', 'audio'), null);
  assert.equal(canonicalAllowlistedMime('application/octet-stream', 'photo'), null);
  assert.equal(canonicalAllowlistedMime('image/heic', 'photo'), null);
  assert.equal(canonicalAllowlistedMime('audio/mp4', 'photo'), null);
  assert.equal(canonicalAllowlistedMime(undefined as unknown as string, 'audio'), null);
});

test('the server category policy is the shared allowlist, not a private copy', () => {
  assert.equal(mediaClassForCategory('primary_hero_photo'), 'photo');
  assert.equal(mediaClassForCategory('family_pet_reference'), 'photo');
  assert.equal(mediaClassForCategory('guided_still'), 'photo');
  assert.equal(mediaClassForCategory('voice_inspiration'), 'audio');
  assert.equal(mediaClassForCategory('document_inspiration'), 'document');
  assert.deepEqual([...INTAKE_CATEGORY_POLICY.primary_hero_photo.allowedMimeTypes], [...PHOTO_MIME_TYPES]);
  assert.deepEqual([...INTAKE_CATEGORY_POLICY.family_pet_reference.allowedMimeTypes], [...PHOTO_MIME_TYPES]);
  assert.deepEqual([...INTAKE_CATEGORY_POLICY.guided_still.allowedMimeTypes], [...PHOTO_MIME_TYPES]);
  assert.deepEqual([...INTAKE_CATEGORY_POLICY.voice_inspiration.allowedMimeTypes], [...AUDIO_MIME_TYPES]);
  assert.deepEqual([...INTAKE_CATEGORY_POLICY.document_inspiration.allowedMimeTypes], [...DOCUMENT_MIME_TYPES]);
  assert.deepEqual([...ALLOWED_PHOTO_MIME_TYPES].sort(), [...PHOTO_MIME_TYPES].sort());
});

test('the accepted still formats are exactly JPEG, PNG, and WebP', () => {
  assert.deepEqual([...PHOTO_MIME_TYPES].sort(), ['image/jpeg', 'image/png', 'image/webp']);
  assert.ok(!PHOTO_MIME_TYPES.includes('image/heic' as never));
  assert.ok(!PHOTO_MIME_TYPES.includes('image/heif' as never));
});

test('the buyer-facing audio picker does not advertise a broad audio wildcard', () => {
  const source = readFileSync('src/components/checkout/VoiceRecorderSection.tsx', 'utf8');
  assert.doesNotMatch(source, /['"]audio\/\*['"]/);
});
