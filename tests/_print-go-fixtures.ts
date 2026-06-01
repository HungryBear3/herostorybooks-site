/**
 * Tiny shared fixture for G3 print-go concurrency tests.
 * Kept in a separate file to avoid bloating the test file's imports.
 */
import type { StoryContent } from '../src/lib/fulfillment-types.ts';

export const MOCK_STORY_FOR_PRINT_GO_TESTS: StoryContent = {
  title: "Luna's Tale",
  dedication: 'For Luna.',
  characterDescription: 'A brave child named Luna.',
  pages: [
    { pageNum: 1, sceneTitle: 'A', story: 'A', imagePrompt: 'A' },
    { pageNum: 2, sceneTitle: 'B', story: 'B', imagePrompt: 'B' },
  ],
};
