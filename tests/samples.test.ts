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

test('sample adventure interior pages are prewired to fal output filenames', () => {
  const expectedPrefixes = {
    'Brave Explorer': '/assets/brave-explorer-page-',
    'Space Voyager': '/assets/space-voyager-page-',
    'Ocean Dreams': '/assets/ocean-dreams-page-',
    'Dinosaur Discovery': '/assets/dinosaur-discovery-page-',
  } as const;

  for (const adventure of SAMPLE_ADVENTURES) {
    const prefix = expectedPrefixes[adventure.name as keyof typeof expectedPrefixes];
    assert.ok(prefix, `unexpected adventure ${adventure.name}`);

    for (const [index, page] of adventure.pages.entries()) {
      if (index === 0) continue;
      assert.equal(page.image?.startsWith(prefix), true, `${adventure.name} page ${index + 1} missing prewired image`);
    }
  }
});
