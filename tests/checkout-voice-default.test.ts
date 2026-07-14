import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('story upload is controlled by the story-upload flag and scoped to Custom Story', () => {
  assert.match(
    checkoutFormSource,
    /const STORY_UPLOAD_ENABLED = process\.env\.NEXT_PUBLIC_HSB_STORY_UPLOAD === ['"]true['"];/,
  );
  assert.match(checkoutFormSource, /STORY_UPLOAD_ENABLED && customStorySourceMode === ['"]audio['"] && \(/);
  assert.doesNotMatch(
    checkoutFormSource,
    /STORY_UPLOAD_ENABLED =\s*process\.env\.NEXT_PUBLIC_HSB_VOICE_BETA/,
  );
});
