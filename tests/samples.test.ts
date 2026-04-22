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
