import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PHOTO_BYTES,
  buildAutoShrinkNotice,
  isBrowserResizablePhoto,
  shouldAutoShrinkPhoto,
} from '../src/lib/photo-upload.ts';

test('shouldAutoShrinkPhoto returns true for oversized browser-resizable photos', () => {
  const file = {
    name: 'hero-photo.JPG',
    size: MAX_PHOTO_BYTES + 1024,
    type: 'image/jpeg',
  };

  assert.equal(isBrowserResizablePhoto(file), true);
  assert.equal(shouldAutoShrinkPhoto(file), true);
});

test('shouldAutoShrinkPhoto stays false for oversized HEIC files we cannot safely resize in-browser', () => {
  const file = {
    name: 'hero-photo.heic',
    size: MAX_PHOTO_BYTES + 1024,
    type: 'image/heic',
  };

  assert.equal(isBrowserResizablePhoto(file), false);
  assert.equal(shouldAutoShrinkPhoto(file), false);
});

test('shouldAutoShrinkPhoto stays false for already-small uploads', () => {
  const file = {
    name: 'hero-photo.png',
    size: MAX_PHOTO_BYTES - 1024,
    type: 'image/png',
  };

  assert.equal(isBrowserResizablePhoto(file), true);
  assert.equal(shouldAutoShrinkPhoto(file), false);
});

test('buildAutoShrinkNotice explains that the phone photo was reduced automatically', () => {
  const notice = buildAutoShrinkNotice(6 * 1024 * 1024, 2 * 1024 * 1024);

  assert.match(notice, /reduced/i);
  assert.match(notice, /6.0 MB/);
  assert.match(notice, /2.0 MB/);
});
