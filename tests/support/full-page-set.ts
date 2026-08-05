/**
 * Test support: pad a small hand-authored page set up to the digital/classic
 * story-page contract (24 pages) so fixtures satisfy the fail-closed page-count
 * gate without each test having to spell out 24 pages. Provided pages are
 * preserved at their `pageIndex`; every other index gets a valid accepted
 * filler page. Not a test file (outside the `*.test.ts` glob).
 */
import type { PageArtifact } from '../../src/lib/orders.ts';

export function fillerPage(i: number, overrides: Partial<PageArtifact> = {}): PageArtifact {
  return {
    pageIndex: i,
    storyText: `Filler page ${i + 1}`,
    basePrompt: 'filler',
    currentImageUrl: `https://example.invalid/filler-${i}.png`,
    acceptedImageUrl: `https://example.invalid/filler-${i}.png`,
    generationProvider: null,
    generationModel: null,
    regenerateCount: 0,
    accepted: true,
    feedbackHistory: [],
    versionHistory: [],
    ...overrides,
  };
}

/** Return a contiguous 0..count-1 page set: provided pages kept at their index,
 *  missing indices filled with accepted filler. */
export function padPageSet(pages: readonly PageArtifact[], count = 24): PageArtifact[] {
  const byIndex = new Map(pages.map((p) => [p.pageIndex, p]));
  return Array.from({ length: count }, (_, i) => byIndex.get(i) ?? fillerPage(i));
}
