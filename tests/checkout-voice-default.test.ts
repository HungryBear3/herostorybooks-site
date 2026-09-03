import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('Custom Story audio, text, and document intake is always available without a client feature flag', () => {
  assert.doesNotMatch(checkoutFormSource, /STORY_UPLOAD_ENABLED/);
  assert.doesNotMatch(checkoutFormSource, /NEXT_PUBLIC_HSB_STORY_UPLOAD/);
  assert.match(checkoutFormSource, /isCustomStorySelected && \([\s\S]*?data-testid="custom-story-intake-panel"/);
  assert.match(checkoutFormSource, /data-testid="custom-story-intake-panel"[\s\S]*?<VoiceRecorderSection/);
});
