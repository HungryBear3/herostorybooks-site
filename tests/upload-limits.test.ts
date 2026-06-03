/**
 * Pure-logic tests for src/lib/upload-limits.ts — the Phase 1 client-side
 * upload-size caps that keep the combined checkout payload under Vercel's
 * request-body limit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TOTAL_UPLOAD_BYTES,
  MAX_VOICE_UPLOAD_BYTES,
  combinedTooLargeMessage,
  estimateTotalUploadBytes,
  isCombinedUploadTooLarge,
  isVoiceUploadTooLarge,
  voiceTooLargeMessage,
} from '../src/lib/upload-limits.ts';

test('caps are the chosen values (3 MiB voice, 4 MiB combined) and sit under Vercel ~4.5 MB', () => {
  assert.equal(MAX_VOICE_UPLOAD_BYTES, 3 * 1024 * 1024);
  assert.equal(MAX_TOTAL_UPLOAD_BYTES, 4 * 1024 * 1024);
  assert.ok(MAX_TOTAL_UPLOAD_BYTES < 4.5 * 1000 * 1000, 'combined cap must stay under Vercel limit');
});

test('isVoiceUploadTooLarge: boundary at MAX_VOICE_UPLOAD_BYTES', () => {
  assert.equal(isVoiceUploadTooLarge(MAX_VOICE_UPLOAD_BYTES), false);
  assert.equal(isVoiceUploadTooLarge(MAX_VOICE_UPLOAD_BYTES + 1), true);
  assert.equal(isVoiceUploadTooLarge(1024), false);
});

test('voiceTooLargeMessage: customer-friendly, points to shorter note or text', () => {
  const msg = voiceTooLargeMessage(5 * 1024 * 1024);
  assert.match(msg, /5\.0 MB/);
  assert.match(msg, /shorter voice note/i);
  assert.match(msg, /text or PDF/i);
});

test('estimateTotalUploadBytes: sums main + supporting + voice', () => {
  assert.equal(
    estimateTotalUploadBytes({ mainPhotoBytes: 1000, supportingPhotoBytes: [200, 300], voiceBytes: 500 }),
    2000,
  );
  assert.equal(estimateTotalUploadBytes({}), 0);
  assert.equal(estimateTotalUploadBytes({ supportingPhotoBytes: [] }), 0);
});

test('isCombinedUploadTooLarge: boundary at MAX_TOTAL_UPLOAD_BYTES', () => {
  assert.equal(isCombinedUploadTooLarge(MAX_TOTAL_UPLOAD_BYTES), false);
  assert.equal(isCombinedUploadTooLarge(MAX_TOTAL_UPLOAD_BYTES + 1), true);
});

test('combined over cap (e.g. 3 MiB voice + a photo) is blocked, message says NOT charged', () => {
  const total = estimateTotalUploadBytes({ voiceBytes: 3 * 1024 * 1024, mainPhotoBytes: 1500 * 1024 });
  assert.equal(isCombinedUploadTooLarge(total), true);
  const msg = combinedTooLargeMessage(total);
  assert.match(msg, /you have not been charged/i);
  assert.match(msg, /shorter voice note or text/i);
});
