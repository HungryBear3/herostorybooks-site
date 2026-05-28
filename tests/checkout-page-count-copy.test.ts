import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('checkout distinguishes total book pages from illustrated story pages', () => {
  assert.match(CHECKOUT_SRC, /TOTAL_BOOK_PAGE_COUNT\s*=\s*32/);
  assert.match(CHECKOUT_SRC, /ILLUSTRATED_STORY_PAGE_COUNT\s*=\s*24/);
  assert.match(CHECKOUT_SRC, /\{bookPageCount\} total/);
  assert.match(CHECKOUT_SRC, /\{illustratedStoryPageCount\} illustrated story pages/);
  assert.doesNotMatch(CHECKOUT_SRC, />\s*\{storyPageCount\}\s*</);
});
