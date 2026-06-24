import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  appendGuidedCaptureToFormData,
  collectGuidedReferencePhotos,
  getNextGuidedPromptIndex,
  GUIDED_PHOTO_PROMPTS,
  isAcceptedGuidedPhotoFile,
} from '../src/lib/guided-photo-capture.ts';

test('guided capture advances by required labels and jumps back to removed labels', () => {
  assert.equal(getNextGuidedPromptIndex([]), 0);
  const frames = GUIDED_PHOTO_PROMPTS.map((prompt) => ({ label: prompt.label }));
  assert.equal(getNextGuidedPromptIndex(frames), GUIDED_PHOTO_PROMPTS.length - 1);
  const withoutLeft = frames.filter((frame) => frame.label !== 'left');
  assert.equal(getNextGuidedPromptIndex(withoutLeft), 1);
});

test('guided capture appends still photos and consent metadata only', () => {
  const appended: Array<{ name: string; value: unknown; fileName?: string }> = [];
  const file = new File(['still'], 'front.jpg', { type: 'image/jpeg' });
  const count = appendGuidedCaptureToFormData({
    append(name: string, value: string | Blob, fileName?: string) {
      appended.push({ name, value, fileName });
    },
  }, [{ label: 'front', file }]);

  assert.equal(count, 1);
  assert.equal(appended.some((entry) => entry.name === 'guidedPhoto_0' && entry.fileName === 'front.jpg'), true);
  assert.equal(appended.some((entry) => entry.name === 'guidedPhotoConsent' && entry.value === 'true'), true);
  assert.equal(appended.some((entry) => entry.name.toLowerCase().includes('video')), false);
});

test('guided capture accepts still images and rejects video files', () => {
  assert.equal(isAcceptedGuidedPhotoFile({ type: 'image/jpeg', name: 'front.jpg' }), true);
  assert.equal(isAcceptedGuidedPhotoFile({ type: 'image/heic', name: 'front.heic' }), true);
  assert.equal(isAcceptedGuidedPhotoFile({ type: 'video/mp4', name: 'front.mp4' }), false);
});

test('server collection aborts invalid guided uploads before persistence/Stripe', async () => {
  const video = new File(['movie'], 'front.mp4', { type: 'video/mp4' });
  const form = new FormData();
  form.set('guidedPhoto_0', video);
  form.set('guidedPhotoConsent', 'true');

  let uploads = 0;
  const result = await collectGuidedReferencePhotos(form, 'ord_guided', {
    async upload() {
      uploads += 1;
      throw new Error('should not upload');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'guided_photo_invalid_type');
  assert.equal(uploads, 0);
});

test('server collection persists approved still metadata', async () => {
  const file = new File(['still'], 'front.jpg', { type: 'image/jpeg' });
  const form = new FormData();
  form.set('guidedPhoto_0', file);
  form.set('guidedPhotoConsent', 'true');
  form.set('guidedPhotoLabels', JSON.stringify(['front']));

  const result = await collectGuidedReferencePhotos(form, 'ord_guided', {
    async upload(orderId, index, uploadedFile) {
      assert.equal(orderId, 'ord_guided');
      assert.equal(index, 0);
      assert.equal(uploadedFile, file);
      return { pathname: 'orders/ord_guided/photo-guided-front.jpg', url: 'https://blob/front.jpg' };
    },
    now: () => new Date('2026-06-23T12:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.records, [
    {
      label: 'front',
      fileName: 'front.jpg',
      photoBlobPath: 'orders/ord_guided/photo-guided-front.jpg',
      photoBlobUrl: 'https://blob/front.jpg',
      source: 'guided_capture',
      consentAt: '2026-06-23T12:00:00.000Z',
    },
  ]);
});

test('checkout renders guided child capture behind the public flag and submits it', () => {
  const source = readFileSync(new URL('../src/app/checkout/checkout-form.tsx', import.meta.url), 'utf8');
  assert.match(source, /isGuidedPhotoCaptureEnabled\(\)/);
  assert.match(source, /<GuidedPhotoCapture/);
  assert.match(source, /appendGuidedCaptureToFormData\(payload, guidedFrames\)/);
});

test('guided component has explicit all-required completion copy', () => {
  const source = readFileSync(new URL('../src/components/checkout/GuidedPhotoCapture.tsx', import.meta.url), 'utf8');
  assert.match(source, /All required photos captured/);
  assert.match(source, /All required still reference photos are ready/);
});
