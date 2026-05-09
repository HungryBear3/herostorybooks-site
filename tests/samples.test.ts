import test from 'node:test';
import assert from 'node:assert/strict';

import { SAMPLE_ADVENTURES } from '../src/lib/sample-adventures.ts';

test('sample adventures no longer rely on the old generic sample-page placeholders', () => {
  const refs = SAMPLE_ADVENTURES.flatMap((adventure) =>
    adventure.pages.map((page) => page.image ?? page.sceneTitle ?? ''),
  );

  assert.equal(refs.some((value) => value.includes('sample-page-2.png')), false);
  assert.equal(refs.some((value) => value.includes('sample-page-3.png')), false);
});

test('every sample adventure shows more than a thin three-page teaser', () => {
  for (const adventure of SAMPLE_ADVENTURES) {
    assert.ok(adventure.pages.length >= 5, `${adventure.name} only has ${adventure.pages.length} pages`);
  }
});

test('samples include Dragon Quest and Royal Adventure with full five-page arcs', () => {
  const names = SAMPLE_ADVENTURES.map((adventure) => adventure.name);
  assert.equal(names.includes('Dragon Quest'), true);
  assert.equal(names.includes('Royal Adventure'), true);

  const dragon = SAMPLE_ADVENTURES.find((adventure) => adventure.name === 'Dragon Quest');
  const royal = SAMPLE_ADVENTURES.find((adventure) => adventure.name === 'Royal Adventure');
  assert.equal(dragon?.pages.length, 5);
  assert.equal(royal?.pages.length, 5);
  assert.equal(dragon?.pages[0]?.image, '/assets/dragon-quest-gpt.png');
  assert.equal(royal?.pages[0]?.image, '/assets/royal-regen-candidates-v7/cover-v7.png');
  assert.equal(royal?.pages[0]?.sceneTitle, 'A Golden Invitation Arrives');
});

test('royal adventure sample now uses real artwork references for all five sample pages', () => {
  const royal = SAMPLE_ADVENTURES.find((adventure) => adventure.name === 'Royal Adventure');
  assert.ok(royal);
  const expected = [
    '/assets/royal-regen-candidates-v7/cover-v7.png',
    '/assets/royal-regen-candidates-v7/page2-v7.png',
    '/assets/royal-regen-candidates-v7/page3-v7.png',
    '/assets/royal-regen-candidates-v7/page4-v7.png',
    '/assets/royal-regen-candidates-v7/page5-v7.png',
  ];

  assert.deepEqual(
    royal?.pages.map((page) => page.image),
    expected,
  );
});

test('royal adventure sample marks all v7 pages as portrait so the samples viewer does not crop their heads', () => {
  const royal = SAMPLE_ADVENTURES.find((adventure) => adventure.name === 'Royal Adventure');
  assert.ok(royal);
  assert.deepEqual(
    royal?.pages.map((page) => page.imageLayout),
    ['portrait', 'portrait', 'portrait', 'portrait', 'portrait'],
  );
});

test('royal adventure sample keeps scene metadata for placeholder fallback safety', () => {
  const royal = SAMPLE_ADVENTURES.find((adventure) => adventure.name === 'Royal Adventure');
  assert.ok(royal);
  for (const page of royal.pages) {
    assert.ok(page.sceneTitle);
    assert.ok(page.sceneAccent);
  }
});
