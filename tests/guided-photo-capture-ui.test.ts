/**
 * Phase 3 — guided capture UI behavior (logic-level; repo has no DOM test infra).
 * The React component delegates its imperative bits to these pure helpers, so the
 * required behaviors are verified here: flag gating, reassurance copy, consent
 * gate, getUserMedia(audio:false), still-only FormData submit, delete/retake, and
 * media-track cleanup.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GUIDED_CAPTURE_MEDIA_CONSTRAINTS,
  GUIDED_PHOTO_CAPTURE_VERSION,
  GUIDED_PHOTO_CONSENT_COPY,
  GUIDED_PHOTO_STILL_ONLY_COPY,
  appendGuidedCaptureToFormData,
  canStartGuidedCamera,
  isGuidedPhotoCaptureEnabled,
  stopMediaTracks,
  type GuidedCaptureAppendable,
} from '../src/lib/guided-photo-capture.ts';

function frame(label: string): GuidedCaptureAppendable {
  return { label, file: new File([new Uint8Array(32)], `${label}.jpg`, { type: 'image/jpeg' }) };
}

// ── flag gating (flag off = no guided UI; flag on = guided UI) ─────────────────

test('isGuidedPhotoCaptureEnabled only true for exact "true"', () => {
  assert.equal(isGuidedPhotoCaptureEnabled(undefined), false);
  assert.equal(isGuidedPhotoCaptureEnabled(''), false);
  assert.equal(isGuidedPhotoCaptureEnabled('false'), false);
  assert.equal(isGuidedPhotoCaptureEnabled('1'), false);
  assert.equal(isGuidedPhotoCaptureEnabled('true'), true);
});

// ── required reassurance copy ─────────────────────────────────────────────────

test('consent copy contains the required negated reassurances', () => {
  assert.match(GUIDED_PHOTO_CONSENT_COPY, /not a face scan/i);
  assert.match(GUIDED_PHOTO_CONSENT_COPY, /biometric scan/i);
  assert.match(GUIDED_PHOTO_CONSENT_COPY, /Face ID/i);
});

test('still-only copy says still photos only / never video', () => {
  assert.match(GUIDED_PHOTO_STILL_ONLY_COPY, /still photos/i);
  assert.match(GUIDED_PHOTO_STILL_ONLY_COPY, /never video/i);
});

// ── consent gates camera ──────────────────────────────────────────────────────

test('camera cannot start without parent/guardian consent', () => {
  assert.equal(canStartGuidedCamera(false), false);
  assert.equal(canStartGuidedCamera(true), true);
});

// ── getUserMedia audio:false (never records sound; only still frames) ─────────

test('media constraints request front camera with audio disabled', () => {
  assert.equal(GUIDED_CAPTURE_MEDIA_CONSTRAINTS.audio, false);
  assert.equal(GUIDED_CAPTURE_MEDIA_CONSTRAINTS.video.facingMode, 'user');
});

// ── submit appends still frames + labels + version + consent (never video) ────

test('appendGuidedCaptureToFormData appends stills, labels, version, consent', () => {
  const fd = new FormData();
  const count = appendGuidedCaptureToFormData(fd, [frame('front'), frame('left')]);
  assert.equal(count, 2);

  const p0 = fd.get('guidedPhoto_0');
  const p1 = fd.get('guidedPhoto_1');
  assert.ok(p0 instanceof File && p1 instanceof File);
  // Every appended asset is a still image — there is no video key/path.
  assert.match((p0 as File).type, /^image\//);
  assert.match((p1 as File).type, /^image\//);
  for (const key of [...fd.keys()]) assert.doesNotMatch(key, /video/i);

  assert.equal(fd.get('guidedPhotoConsent'), 'true');
  assert.equal(fd.get('guidedPhotoCaptureVersion'), GUIDED_PHOTO_CAPTURE_VERSION);
  assert.deepEqual(JSON.parse(String(fd.get('guidedPhotoLabels'))), ['front', 'left']);
});

test('no frames → nothing appended (feature simply unused)', () => {
  const fd = new FormData();
  assert.equal(appendGuidedCaptureToFormData(fd, []), 0);
  assert.equal(fd.get('guidedPhotoConsent'), null);
});

test('delete/retake: a removed frame is not re-sent (rebuilt from current frames)', () => {
  // Captured front+left, then deleted "left" → submit only sends front.
  const afterDelete = [frame('front')];
  const fd = new FormData();
  const count = appendGuidedCaptureToFormData(fd, afterDelete);
  assert.equal(count, 1);
  assert.ok(fd.get('guidedPhoto_0') instanceof File);
  assert.equal(fd.get('guidedPhoto_1'), null);
  assert.deepEqual(JSON.parse(String(fd.get('guidedPhotoLabels'))), ['front']);
});

// ── media tracks stop on finish/cancel/unmount ────────────────────────────────

test('stopMediaTracks stops every track and is null-safe', () => {
  let stopped = 0;
  const fakeStream = { getTracks: () => [{ stop: () => { stopped += 1; } }, { stop: () => { stopped += 1; } }] };
  assert.equal(stopMediaTracks(fakeStream), 2);
  assert.equal(stopped, 2);
  assert.equal(stopMediaTracks(null), 0);
  assert.equal(stopMediaTracks(undefined), 0);
  assert.equal(stopMediaTracks({} as never), 0);
});
