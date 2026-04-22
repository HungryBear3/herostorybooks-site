import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKOUT_SAMPLE_IMAGES,
  STORY_OCCASIONS,
  STORY_THEMES,
} from '../src/lib/story-catalog.ts';

test('story catalog includes real themed sample thumbnails instead of generic placeholders', () => {
  assert.equal(CHECKOUT_SAMPLE_IMAGES.some((image) => image.startsWith('/sample')), false);
  assert.deepEqual(CHECKOUT_SAMPLE_IMAGES, [
    '/assets/explorer-sample.png',
    '/assets/space-sample.png',
    '/assets/ocean-sample.png',
  ]);
});

test('story catalog includes both Mother\'s Day and Father\'s Day gifting occasions', () => {
  assert.deepEqual(
    STORY_OCCASIONS.map((occasion) => occasion.id),
    ['birthday', 'holiday', 'mothers-day', 'fathers-day', 'just-because', 'welcome-baby'],
  );
});

test('story catalog expands beyond the original four themes with family-gift options', () => {
  const ids = STORY_THEMES.map((theme) => theme.id);

  assert.equal(ids.includes('brave-explorer'), true);
  assert.equal(ids.includes('space-voyager'), true);
  assert.equal(ids.includes('ocean-dreams'), true);
  assert.equal(ids.includes('dinosaur-discovery'), true);
  assert.equal(ids.includes('mothers-day-memory-book'), true);
  assert.equal(ids.includes('fathers-day-adventure-book'), true);
  assert.ok(STORY_THEMES.length >= 6);
});

test('homepage story cards point to live sample or checkout routes instead of dead anchors', () => {
  for (const theme of STORY_THEMES) {
    assert.match(theme.href, /^\/(samples|checkout)/);
  }
});
