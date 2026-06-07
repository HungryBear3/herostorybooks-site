/**
 * Review Room copy/state polish (CD audit, launch blockers).
 *
 * Source-string guards for the calm, honest review-room language. A parent must
 * never think a page/book is settled until the server confirms it, and customer
 * copy must never leak internal failure words (failed / blocked / reseed / limit)
 * or raw status codes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const CLIENT = 'src/app/review/[orderId]/review-client.tsx';

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

test('page-level action uses "Looks good", not whole-book "approve" language', () => {
  const src = read(CLIENT);
  assert.match(src, /Looks good/);
  // The page card must not call its action "Approve this page" anymore.
  assert.doesNotMatch(src, /Approve this page/);
});

test('page card explains "Looks good" only marks the page, not the book', () => {
  const src = read(CLIENT);
  assert.match(src, /only marks this page/);
});

test('regenerate framing reads as asking for a new version', () => {
  const src = read(CLIENT);
  assert.match(src, /Ask for a new version/);
});

test('final acknowledgment scopes to the whole book, cover to cover', () => {
  const src = read(CLIENT);
  assert.match(src, /cover to cover/);
  assert.match(src, /complete printed book/);
});

test('sticky mobile CTA navigates to approval only (no direct approve)', () => {
  const src = read(CLIENT);
  // A scroll anchor to the approval section, not an approve action.
  assert.match(src, /href="#approve-whole-book"/);
  assert.match(src, /id="approve-whole-book"/);
  assert.match(src, /Go to approval/);
});

test('customer-facing copy does not leak internal failure words or status codes', () => {
  const src = read(CLIENT);
  assert.doesNotMatch(src, /Approval failed/);
  assert.doesNotMatch(src, /Could not save acknowledgment/);
  assert.doesNotMatch(src, /\(\$\{res\.status\}\)/);
});
