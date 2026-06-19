import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('checkout offers child camera capture in addition to upload fallback', () => {
  assert.match(checkoutFormSource, /Take a picture/);
  assert.match(checkoutFormSource, /capture="user"/);
  assert.match(checkoutFormSource, /still photo only, never video/i);
  assert.match(checkoutFormSource, /Upload picture/);
});

test('child photo and voice sections appear before choose-your-format', () => {
  const photoIndex = checkoutFormSource.indexOf('Add a photo when you&apos;re ready');
  const voiceIndex = checkoutFormSource.indexOf('<VoiceRecorderSection');
  const formatIndex = checkoutFormSource.indexOf('Choose your format');

  assert.ok(photoIndex > -1, 'photo section should exist');
  assert.ok(voiceIndex > -1, 'voice recorder section should exist');
  assert.ok(formatIndex > -1, 'format section should exist');
  assert.ok(photoIndex < formatIndex, 'photo upload should come before format choice');
  assert.ok(voiceIndex < formatIndex, 'voice upload should come before format choice');
});

test('voice upload stays visible by default unless explicitly disabled', () => {
  assert.match(
    checkoutFormSource,
    /const VOICE_BETA_ENABLED = process\.env\.NEXT_PUBLIC_HSB_VOICE_BETA !== "false";/,
  );
  assert.doesNotMatch(
    checkoutFormSource,
    /process\.env\.NEXT_PUBLIC_HSB_VOICE_BETA === "true"/,
  );
});

test('checkout pre-shrinks photos below Vercel payload limit before submit', () => {
  assert.match(checkoutFormSource, /CHECKOUT_PHOTO_MAX_BYTES\s*=\s*1\.1 \* 1024 \* 1024/);
  assert.match(checkoutFormSource, /shrinkPhotoForUpload\(file, CHECKOUT_PHOTO_MAX_BYTES\)/);
  assert.match(checkoutFormSource, /payload\.set\("photo", form\.photoFile\)/);
  assert.match(checkoutFormSource, /payload\.set\(`familyCharacterPhoto_\$\{index\}`, character\.photoFile\)/);
});
