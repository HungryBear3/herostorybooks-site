/**
 * The 24-story-page contract + explicit layout-version fail-closed rules.
 *
 * Synthetic fixtures only. No I/O — the validator and the renderer gate are
 * pure. Mutation proof: removing the modern fail-closed throw in the renderer,
 * or the layout-metadata check in the validator, makes the modern cases below
 * pass when they must fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateStoryPageSet,
  assertStoryPageSet,
  StoryPageContractError,
} from '../src/lib/story-page-contract.ts';
import { getPictureBookStoryLayout, ModernLayoutMetadataError } from '../src/lib/pdf-builder.ts';
import type { PageArtifact } from '../src/lib/orders.ts';
import type { PageTextLayout } from '../src/lib/fulfillment-types.ts';

const VALID_LAYOUT: PageTextLayout = { zone: 'natural', colorMode: 'dark', panelStyle: 'translucent_cream' };

function page(i: number, o: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Page ${i + 1} story text`,
    basePrompt: 'p',
    currentImageUrl: `https://example.invalid/p${i}.png`,
    acceptedImageUrl: `https://example.invalid/p${i}.png`,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...o,
  };
}

/** N contiguous valid story pages (0..N-1). */
function pages(n: number, o: (i: number) => Partial<PageArtifact> = () => ({})): PageArtifact[] {
  return Array.from({ length: n }, (_, i) => page(i, o(i)));
}

// ── validateStoryPageSet (returns null when valid, else the failure) ─────────

test('24 valid legacy story pages satisfy the contract', () => {
  assert.equal(validateStoryPageSet(pages(24), 'digital', 'legacy_bottom_band'), null);
});

test('24 valid modern story pages (each with layout metadata) satisfy the contract', () => {
  const set = pages(24, () => ({ textLayout: VALID_LAYOUT }));
  assert.equal(validateStoryPageSet(set, 'digital', 'modern_full_bleed'), null);
});

test('premium requires 32 pages', () => {
  assert.equal(validateStoryPageSet(pages(32), 'premium', 'legacy_bottom_band'), null);
  assert.ok(validateStoryPageSet(pages(24), 'premium', 'legacy_bottom_band'));
});

for (const n of [6, 23, 25]) {
  test(`a ${n}-page set fails closed (wrong_page_count) — matter pages cannot fill the gap`, () => {
    const f = validateStoryPageSet(pages(n), 'digital', 'legacy_bottom_band');
    assert.equal(f?.code, 'wrong_page_count');
    assert.equal(f?.code === 'wrong_page_count' && f.expected, 24);
    assert.equal(f?.code === 'wrong_page_count' && f.actual, n);
  });
}

test('a duplicated page index fails closed', () => {
  const set = pages(24);
  set[5] = page(6); // now two pages at index 6, index 5 missing
  assert.equal(validateStoryPageSet(set, 'digital', 'legacy_bottom_band')?.code, 'duplicate_page');
});

test('a non-contiguous / out-of-range page index fails closed', () => {
  const set = pages(24);
  set[23] = page(24); // index 24 is out of 0..23 (a gap at 23)
  assert.equal(validateStoryPageSet(set, 'digital', 'legacy_bottom_band')?.code, 'out_of_range_page');
});

test('a page missing story text fails closed', () => {
  const set = pages(24);
  set[10] = page(10, { storyText: '   ' });
  assert.equal(validateStoryPageSet(set, 'digital', 'legacy_bottom_band')?.code, 'missing_story_text');
});

test('a page missing any illustration binding fails closed', () => {
  const set = pages(24);
  set[3] = page(3, { currentImageUrl: null, acceptedImageUrl: null });
  assert.equal(validateStoryPageSet(set, 'digital', 'legacy_bottom_band')?.code, 'missing_illustration');
});

test('a MODERN book with a page missing layout metadata fails closed', () => {
  const set = pages(24, () => ({ textLayout: VALID_LAYOUT }));
  set[7] = page(7, { textLayout: null });
  assert.equal(validateStoryPageSet(set, 'digital', 'modern_full_bleed')?.code, 'missing_layout_metadata');
});

test('a MODERN book with INVALID layout metadata fails closed', () => {
  const set = pages(24, () => ({ textLayout: VALID_LAYOUT }));
  // Corrupt one field so the enum-validity check rejects it.
  set[2] = page(2, { textLayout: { ...VALID_LAYOUT, zone: 'nonsense' as PageTextLayout['zone'] } });
  assert.equal(validateStoryPageSet(set, 'digital', 'modern_full_bleed')?.code, 'missing_layout_metadata');
});

test('a LEGACY / unmarked book tolerates absent layout metadata', () => {
  const set = pages(24); // no textLayout on any page
  assert.equal(validateStoryPageSet(set, 'digital', 'legacy_bottom_band'), null);
  assert.equal(validateStoryPageSet(set, 'digital', undefined), null);
  assert.equal(validateStoryPageSet(set, 'digital', null), null);
});

test('assertStoryPageSet throws StoryPageContractError carrying the typed failure', () => {
  try {
    assertStoryPageSet(pages(6), 'digital', 'legacy_bottom_band');
    assert.fail('expected StoryPageContractError');
  } catch (err) {
    assert.ok(err instanceof StoryPageContractError);
    assert.equal((err as StoryPageContractError).failure.code, 'wrong_page_count');
  }
  // A valid set does not throw.
  assert.doesNotThrow(() => assertStoryPageSet(pages(24), 'digital', 'legacy_bottom_band'));
});

// ── Renderer fail-closed gate (getPictureBookStoryLayout) ────────────────────

test('MODERN book with missing per-page layout metadata never renders the bottom band — it throws', () => {
  assert.throws(
    () => getPictureBookStoryLayout('proof', undefined, 'modern_full_bleed', 4),
    ModernLayoutMetadataError,
  );
  assert.throws(
    () => getPictureBookStoryLayout('print', { ...VALID_LAYOUT, colorMode: 'bogus' as PageTextLayout['colorMode'] }, 'modern_full_bleed', 4),
    ModernLayoutMetadataError,
  );
});

test('MODERN book with valid layout metadata renders (no throw)', () => {
  assert.doesNotThrow(() => getPictureBookStoryLayout('proof', VALID_LAYOUT, 'modern_full_bleed', 0));
});

test('LEGACY / unmarked book renders through the existing path with or without metadata', () => {
  assert.doesNotThrow(() => getPictureBookStoryLayout('proof', undefined, 'legacy_bottom_band', 0));
  assert.doesNotThrow(() => getPictureBookStoryLayout('proof', undefined, undefined, 0));
  assert.doesNotThrow(() => getPictureBookStoryLayout('proof', undefined, null, 0));
});
