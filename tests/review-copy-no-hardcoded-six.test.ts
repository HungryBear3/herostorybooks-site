/**
 * Slice 2: review/proof customer copy must use pageArtifacts.length so
 * long-form classic (24) and premium (32) orders display truthfully.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const STALE_ILLUSTRATED_PAGE_COUNT_COPY = new RegExp(String.raw`\b${6} illustrated story pages\b`);

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

test('review-client.tsx: no stale fixed illustrated-page-count copy', () => {
  const src = read('src/app/review/[orderId]/review-client.tsx');
  assert.doesNotMatch(src, STALE_ILLUSTRATED_PAGE_COUNT_COPY);
});

test('inline-proof-preview.tsx: no stale fixed illustrated-page-count copy', () => {
  const src = read('src/app/review/[orderId]/inline-proof-preview.tsx');
  assert.doesNotMatch(src, STALE_ILLUSTRATED_PAGE_COUNT_COPY);
});

test('review-client.tsx: still describes the print proof as "the complete printed book"', () => {
  // Slice 2 keeps the approve-gate language honest about scope while deriving
  // the illustrated-page count from the order snapshot.
  const src = read('src/app/review/[orderId]/review-client.tsx');
  assert.match(src, /complete printed book/);
});

test('review-client.tsx: passes pageArtifacts.length into the InlineProofPreview', () => {
  const src = read('src/app/review/[orderId]/review-client.tsx');
  assert.match(src, /illustratedPageCount=\{snapshot\.pageArtifacts\.length\}/);
});

test('review-client.tsx: print copy interpolates pageArtifacts.length', () => {
  const src = read('src/app/review/[orderId]/review-client.tsx');
  // The dynamic count must appear inside the print-only branch copy.
  assert.match(src, /\$\{snapshot\.pageArtifacts\.length\} illustrated story pages above/);
});

test('inline-proof-preview.tsx: print copy uses the illustratedPageCount prop', () => {
  const src = read('src/app/review/[orderId]/inline-proof-preview.tsx');
  assert.match(src, /illustratedPageCount/);
});
