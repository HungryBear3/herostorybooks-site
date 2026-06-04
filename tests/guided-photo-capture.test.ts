/**
 * Tests for Guided Photo Capture (MVP).
 * Spec: agent-shared/handoffs/2026-06-03-hsb-guided-photo-capture-spec.md
 *
 * The repo runs `node --test` (no DOM, and the order route can't load next/server
 * + Stripe directly), so:
 *   - Camera/canvas React logic is exercised via the pure lib.
 *   - Flag gating + route ordering are asserted structurally against source.
 *   - The fail-before-Stripe building block is tested for real against
 *     uploadOrderGuidedReferencePhoto under forced durable persistence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  GUIDED_PHOTO_CAPTURE_FLAG,
  GUIDED_PHOTO_CAPTURE_VERSION,
  GUIDED_CAPTURE_PROMPTS,
  GUIDED_CAPTURE_CONSENT_COPY,
  GUIDED_CAPTURE_CONCISE_COPY,
  isGuidedPhotoCaptureEnabled,
  guidedFrameFileName,
  sanitizeGuidedLabel,
  addFrame,
  removeFrame,
  retakeFrame,
  setFrameSelected,
  selectedStills,
  selectedLabels,
  framesToUploadFiles,
  cameraSupport,
  stopStreamTracks,
  shouldOfferFileUploadFallback,
  describeGetUserMediaError,
  type CapturedFrame,
} from '../src/lib/guided-photo-capture.ts';
import {
  uploadOrderGuidedReferencePhoto,
  OrderPersistenceError,
} from '../src/lib/orders.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (p: string) => readFileSync(resolve(here, '..', p), 'utf8');

function imageFile(name = 'still.jpg'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}
function frame(id: string, label: string, opts: Partial<CapturedFrame> = {}): CapturedFrame {
  return { id, label, file: imageFile(`${id}.jpg`), previewUrl: `blob:${id}`, selected: true, ...opts };
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── 1 & 2: feature flag gates the entry ────────────────────────────────────

test('feature flag OFF hides guided capture (predicate false)', () => {
  assert.equal(isGuidedPhotoCaptureEnabled({}), false);
  assert.equal(isGuidedPhotoCaptureEnabled({ [GUIDED_PHOTO_CAPTURE_FLAG]: 'false' }), false);
});

test('feature flag ON shows guided capture (predicate true)', () => {
  assert.equal(isGuidedPhotoCaptureEnabled({ [GUIDED_PHOTO_CAPTURE_FLAG]: 'true' }), true);
});

test('checkout form renders the entry only behind the flag gate', () => {
  const src = readSrc('src/app/checkout/checkout-form.tsx');
  assert.match(src, /import GuidedPhotoCapture from "@\/components\/checkout\/GuidedPhotoCapture"/);
  assert.match(src, /GUIDED_PHOTO_CAPTURE_ENABLED\s*&&[\s\S]{0,80}<GuidedPhotoCapture/);
  assert.match(src, /NEXT_PUBLIC_HSB_GUIDED_PHOTO_CAPTURE === "true"/);
});

// ── 3: consent / privacy copy ──────────────────────────────────────────────

test('consent copy states not a face scan / biometric / Face ID and delete-before-submit', () => {
  assert.match(GUIDED_CAPTURE_CONSENT_COPY, /not a face scan/i);
  assert.match(GUIDED_CAPTURE_CONSENT_COPY, /biometric/i);
  assert.match(GUIDED_CAPTURE_CONSENT_COPY, /Face ID/i);
  assert.match(GUIDED_CAPTURE_CONSENT_COPY, /not a face scan, biometric scan, or Face ID/);
  assert.match(GUIDED_CAPTURE_CONSENT_COPY, /delete any photo before submitting/i);
});

test('concise copy promises stills-only, never video', () => {
  assert.match(GUIDED_CAPTURE_CONCISE_COPY, /still photos you approve/i);
  assert.match(GUIDED_CAPTURE_CONCISE_COPY, /never video/i);
});

test('component uses no forbidden POSITIVE claims (only negated reassurance allowed)', () => {
  const src = readSrc('src/components/checkout/GuidedPhotoCapture.tsx');
  // These positive-claim terms must never appear at all.
  assert.doesNotMatch(src, /identity verification|3d face model|depth map/i);
  // "biometric" / "Face ID" / "face scan" are allowed ONLY in negated form
  // ("NOT Face ID", "not a face scan"). Strip negated occurrences, then assert
  // nothing positive remains.
  const stripped = src.replace(/not (a )?(face id|face scan|biometric|depth\/3d|depth map|3d face)/gi, '');
  assert.doesNotMatch(stripped, /biometric|face id|face scan/i);
});

// ── prompts + filenames ────────────────────────────────────────────────────

test('prompts are the five guided angles, in order, with stable labels', () => {
  assert.deepEqual(GUIDED_CAPTURE_PROMPTS.map((p) => p.label), ['front', 'left', 'right', 'up', 'smile']);
  assert.deepEqual(
    GUIDED_CAPTURE_PROMPTS.map((p) => p.title),
    ['Look straight', 'Turn slightly left', 'Turn slightly right', 'Tilt slightly up', 'Smile'],
  );
});

test('frame filenames are stable + sanitized', () => {
  assert.equal(guidedFrameFileName('front'), 'guided-front.jpg');
  assert.equal(guidedFrameFileName('smile', 'image/webp'), 'guided-smile.webp');
  assert.equal(sanitizeGuidedLabel('  Weird Label!! '), 'weird-label');
  assert.equal(sanitizeGuidedLabel(''), 'frame');
});

// ── 4: review supports delete / retake ─────────────────────────────────────

test('captured frame review supports delete', () => {
  const frames = [frame('frame-1', 'front'), frame('frame-2', 'left')];
  const { frames: next, removed } = removeFrame(frames, 'frame-1');
  assert.equal(removed?.id, 'frame-1');
  assert.deepEqual(next.map((f) => f.id), ['frame-2']);
});

test('captured frame review supports retake (reopens that angle slot)', () => {
  const frames = [frame('frame-1', 'front'), frame('frame-2', 'left')];
  const { frames: next, removed } = retakeFrame(frames, 'front');
  assert.deepEqual(removed.map((f) => f.id), ['frame-1']);
  assert.deepEqual(next.map((f) => f.label), ['left']);
});

// ── 5: submit uses selected stills, never video ────────────────────────────

test('submit path returns only selected still images + matching labels', () => {
  let frames = [frame('frame-1', 'front'), frame('frame-2', 'left'), frame('frame-3', 'right')];
  frames = addFrame(frames, frame('frame-4', 'up'));
  frames = setFrameSelected(frames, 'frame-2', false); // parent deselected one
  const files = framesToUploadFiles(frames);
  assert.equal(files.length, 3);
  assert.ok(files.every((f) => f.type.startsWith('image/')));
  assert.deepEqual(selectedLabels(frames), ['front', 'right', 'up']);
  assert.equal(selectedStills(frames).length, 3);
});

test('submit path REFUSES to upload a non-image (video) blob', () => {
  const videoFrame: CapturedFrame = {
    id: 'v1', label: 'front',
    file: new File([new Uint8Array([0])], 'clip.mp4', { type: 'video/mp4' }),
    previewUrl: 'blob:v1', selected: true,
  };
  assert.throws(() => framesToUploadFiles([videoFrame]), /still images, never video/);
});

// ── 6: camera cleanup stops tracks ─────────────────────────────────────────

test('stopStreamTracks stops every track and is null-safe', () => {
  const stopped: string[] = [];
  const fakeStream = { getTracks: () => [{ stop: () => stopped.push('a') }, { stop: () => stopped.push('b') }] };
  assert.equal(stopStreamTracks(fakeStream), 2);
  assert.deepEqual(stopped, ['a', 'b']);
  assert.equal(stopStreamTracks(null), 0);
  assert.equal(stopStreamTracks(undefined), 0);
});

// ── 7: upload fallback + camera support ────────────────────────────────────

test('file-upload fallback is always available', () => {
  assert.equal(shouldOfferFileUploadFallback(), true);
});

test('cameraSupport detects missing getUserMedia (Safari/iOS / in-app browser / no camera)', () => {
  assert.deepEqual(cameraSupport(null), { supported: false, reason: 'no-navigator' });
  assert.deepEqual(cameraSupport({}), { supported: false, reason: 'no-getusermedia' });
  assert.deepEqual(cameraSupport({ mediaDevices: { getUserMedia: () => {} } }), { supported: true, reason: 'ok' });
});

test('getUserMedia errors map to friendly, fallback-pointing copy', () => {
  assert.match(describeGetUserMediaError({ name: 'NotAllowedError' }), /blocked|settings/i);
  assert.match(describeGetUserMediaError({ name: 'NotFoundError' }), /no usable camera|file upload/i);
  assert.match(describeGetUserMediaError({}), /file upload/i);
});

// ── Server: fail-before-Stripe persistence ─────────────────────────────────

test('uploadOrderGuidedReferencePhoto throws OrderPersistenceError when durable storage required but token missing', async () => {
  await withEnv(
    { HSB_REQUIRE_DURABLE_PERSISTENCE: 'true', BLOB_READ_WRITE_TOKEN: undefined, VERCEL: undefined, NODE_ENV: 'development' },
    async () => {
      await assert.rejects(
        () => uploadOrderGuidedReferencePhoto('order_test', 0, 'front', imageFile('guided-front.jpg')),
        (err: unknown) => err instanceof OrderPersistenceError,
      );
    },
  );
});

test('uploadOrderGuidedReferencePhoto is a no-op (null) in dev without a blob token', async () => {
  await withEnv(
    { HSB_REQUIRE_DURABLE_PERSISTENCE: undefined, BLOB_READ_WRITE_TOKEN: undefined, VERCEL: undefined, NODE_ENV: 'development' },
    async () => {
      const result = await uploadOrderGuidedReferencePhoto('order_test', 0, 'front', imageFile());
      assert.equal(result, null);
    },
  );
});

test('order route uploads guided refs + aborts BEFORE Stripe, and persists guidedReferencePhotos', () => {
  const src = readSrc('src/app/api/order/route.ts');
  const guidedUploadAt = src.indexOf('uploadOrderGuidedReferencePhoto(');
  const guidedAbortAt = src.indexOf('guided_ref_persist_failed');
  const stripeAt = src.indexOf('stripe.checkout.sessions.create(');
  assert.ok(guidedUploadAt > -1, 'guided upload present');
  assert.ok(guidedAbortAt > -1, 'guided abort code present');
  assert.ok(stripeAt > -1, 'stripe session create present');
  // The guided upload + its fail-before-Stripe abort must come BEFORE Stripe.
  assert.ok(guidedUploadAt < stripeAt, 'guided upload runs before Stripe');
  assert.ok(guidedAbortAt < stripeAt, 'guided abort returns before Stripe');
  // And the refs are handed to persistOrder.
  assert.match(src, /guidedReferencePhotos:\s*guidedReferencePhotos/);
});

test('capture version stamp is set', () => {
  assert.equal(GUIDED_PHOTO_CAPTURE_VERSION, 'guided-photo-capture-mvp-v1');
});
