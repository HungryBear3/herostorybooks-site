import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  UNSUPPORTED_STILL_PHOTO_MESSAGE,
  validateStillPhotoMetadata,
} from '../src/lib/photo-upload.ts';

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
const CHECKOUT_FLOW_SRC = readFileSync('src/lib/checkout-flow.ts', 'utf8');

test('HER-49 rejects synthetic non-image files even when file input accept is bypassed', () => {
  const result = validateStillPhotoMetadata({
    name: 'not-image.txt',
    size: 24,
    type: 'text/plain',
  });

  assert.deepEqual(result, {
    ok: false,
    error: UNSUPPORTED_STILL_PHOTO_MESSAGE,
  });
});

test('HER-49 requires both supported still-photo extension and MIME type', () => {
  assert.equal(validateStillPhotoMetadata({ name: 'hero.jpg', size: 42, type: 'image/jpeg' }).ok, true);
  assert.equal(validateStillPhotoMetadata({ name: 'hero.png', size: 42, type: 'image/png' }).ok, true);
  assert.equal(validateStillPhotoMetadata({ name: 'hero.webp', size: 42, type: 'image/webp' }).ok, true);
  assert.equal(validateStillPhotoMetadata({ name: 'hero.heic', size: 42, type: 'image/heic' }).ok, true);

  assert.equal(
    validateStillPhotoMetadata({ name: 'hero.txt', size: 42, type: 'image/png' }).ok,
    false,
    'image MIME with .txt extension must not be counted as a photo',
  );
  assert.equal(
    validateStillPhotoMetadata({ name: 'hero.jpg', size: 42, type: 'text/plain' }).ok,
    false,
    'supported extension with non-image MIME must not be counted as a photo',
  );
});

test('HER-49 checkout copy clarifies add-later photo timing before proofing', () => {
  assert.match(CHECKOUT_FLOW_SRC, /Required before production starts — optional before payment/);
  assert.match(CHECKOUT_SRC, /Add later before proofing/);
});

test('HER-49 supporting-character photo control appears before long details fields on narrow layouts', () => {
  const characterCard = CHECKOUT_SRC.slice(
    CHECKOUT_SRC.indexOf('Supporting character {index + 1}'),
    CHECKOUT_SRC.indexOf('{form.familyCharacters.length > 0 &&', CHECKOUT_SRC.indexOf('Supporting character {index + 1}') + 1),
  );
  const photoPromptIndex = characterCard.indexOf('Want this character to look more like themselves?');
  const detailsIndex = characterCard.indexOf('Details to capture');

  assert.ok(photoPromptIndex >= 0, 'supporting character cards should expose the optional photo prompt');
  assert.ok(detailsIndex >= 0, 'supporting character cards should still include notes/details');
  assert.ok(
    photoPromptIndex < detailsIndex,
    'optional photo prompt should appear before details so it is visible without scrolling on narrow screens',
  );
});
