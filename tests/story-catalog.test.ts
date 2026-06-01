import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKOUT_SAMPLE_IMAGES,
  FEATURED_STORY_THEMES,
  STORY_OCCASIONS,
  STORY_THEMES,
} from '../src/lib/story-catalog.ts';

test('story catalog includes real themed sample thumbnails instead of generic placeholders', () => {
  assert.equal(CHECKOUT_SAMPLE_IMAGES.some((image) => image.startsWith('/sample')), false);
  assert.deepEqual(CHECKOUT_SAMPLE_IMAGES, [
    '/assets/lukas-sample-forest-portrait.jpg',
    '/assets/lukas-sample-dino-walk.jpg',
    '/assets/lukas-sample-space-portrait.jpg',
  ]);
});

test('story catalog launch occasions stay limited to evergreen gifting moments', () => {
  assert.deepEqual(
    STORY_OCCASIONS.map((occasion) => occasion.id),
    ['birthday', 'holiday', 'just-because', 'welcome-baby'],
  );
});

test('story catalog keeps only active seasonal gift variants available', () => {
  const ids = STORY_THEMES.map((theme) => theme.id);

  assert.equal(ids.includes('brave-explorer'), true);
  assert.equal(ids.includes('space-voyager'), true);
  assert.equal(ids.includes('ocean-dreams'), true);
  assert.equal(ids.includes('dinosaur-discovery'), true);
  assert.equal(ids.includes('mothers-day-memory-book'), false);
  assert.equal(ids.includes('fathers-day-adventure-book'), true);
  assert.ok(STORY_THEMES.length >= 6);
});

test('catalog surfaces the evergreen Dragon Quest and Royal Adventure options', () => {
  const dragon = STORY_THEMES.find((theme) => theme.id === 'dragon-quest');
  const royal = STORY_THEMES.find((theme) => theme.id === 'royal-adventure');
  assert.ok(dragon, 'dragon-quest must be in catalog');
  assert.ok(royal, 'royal-adventure must be in catalog');
  assert.equal(dragon?.coverImage, '/assets/dragon-quest-gpt.png');
  assert.equal(royal?.coverImage, '/assets/royal-regen-candidates-v7/cover-v7.png');
});

test('catalog includes a custom voice-led story direction for checkout', () => {
  const custom = STORY_THEMES.find((theme) => theme.id === 'custom-voice-story');
  assert.ok(custom, 'custom voice-led story direction must exist');
  assert.match(custom!.name, /Custom Story/i);
  assert.match(custom!.description, /voice note|story ideas|family details/i);
  assert.equal(custom!.href, '/checkout');
});

test('featured catalog now includes the expanded evergreen lineup', () => {
  assert.deepEqual(
    FEATURED_STORY_THEMES.map((theme) => theme.id),
    [
      'brave-explorer',
      'space-voyager',
      'ocean-dreams',
      'dinosaur-discovery',
      'dragon-quest',
      'royal-adventure',
    ],
  );
});

test('featured evergreen stories do not fall back to the old low-quality -gpt cover assets', () => {
  const forbiddenLegacyFeaturedCovers = new Set([
    '/assets/brave-explorer-gpt.png',
    '/assets/space-voyager-gpt.png',
    '/assets/ocean-dreams-gpt.png',
    '/assets/dinosaur-discovery-gpt.png',
  ]);

  for (const theme of FEATURED_STORY_THEMES) {
    if (['brave-explorer', 'space-voyager', 'ocean-dreams', 'dinosaur-discovery'].includes(theme.id)) {
      assert.equal(
        forbiddenLegacyFeaturedCovers.has(theme.coverImage ?? ''),
        false,
        `${theme.id} is pointing at a forbidden legacy featured cover: ${theme.coverImage}`,
      );
    }
  }
});

test('expired Mother\'s Day SKU is not in the public story catalog', () => {
  const mom = STORY_THEMES.find((t) => t.id === 'mothers-day-memory-book');
  assert.equal(mom, undefined);
});

test('seasonal Father\'s Day copy is honest about the one-photo experience', () => {
  const dad = STORY_THEMES.find((t) => t.id === 'fathers-day-adventure-book');
  assert.ok(dad, 'fathers-day theme must exist');
  assert.equal(
    /two[- ]?photo|both[- ]?photos|dad[’']?s photo|shared illustration|father and child together/i.test(dad!.description),
    false,
    `copy implies two-photo experience: ${dad!.description}`,
  );
  assert.match(dad!.description, /child|hero|starring/i);
  assert.match(dad!.description, /dad|father|adventure|memories/i);
});

test('homepage story cards point to live sample or checkout routes instead of dead anchors', () => {
  for (const theme of STORY_THEMES) {
    assert.match(theme.href, /^\/(samples|checkout)/);
  }
});
