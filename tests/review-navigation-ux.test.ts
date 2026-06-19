/**
 * Public review navigation UX guards.
 *
 * This repo does not have a DOM/component renderer for the Next review page,
 * so this test follows the nearby review-client source-contract tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REVIEW_CLIENT = 'src/app/review/[orderId]/review-client.tsx';

function source(): string {
  return readFileSync(REVIEW_CLIENT, 'utf8');
}

test('review client provides previous and next page navigation controls', () => {
  const src = source();
  assert.match(src, /goToPreviousPage/);
  assert.match(src, /goToNextPage/);
  assert.match(src, /aria-label="Review previous page"/);
  assert.match(src, /aria-label="Review next page"/);
  assert.match(src, /Previous/);
  assert.match(src, /Next/);
});

test('review client shows a selected-page counter', () => {
  const src = source();
  assert.match(src, /Page \{selectedIdx \+ 1\} of \{pageCount\}/);
  assert.match(src, /\{selectedIdx \+ 1\} \/ \{pageCount\}/);
});

test('review client supports desktop arrow-key navigation without hijacking form fields', () => {
  const src = source();
  assert.match(src, /addEventListener\('keydown', onKeyDown\)/);
  assert.match(src, /removeEventListener\('keydown', onKeyDown\)/);
  assert.match(src, /event\.key === 'ArrowLeft'/);
  assert.match(src, /event\.key === 'ArrowRight'/);
  assert.match(src, /tagName === 'TEXTAREA'/);
  assert.match(src, /target\.isContentEditable/);
});

test('review navigation keeps existing review actions wired to the selected page', () => {
  const src = source();
  assert.match(src, /action: 'request_changes'/);
  assert.match(src, /pageIndex: selected\.pageIndex/);
  assert.match(src, /note: feedback/);
  assert.match(src, /action: 'approve_page'/);
  assert.match(src, /Request changes/);
  assert.match(src, /Approve this page/);
});
