/**
 * Single source of truth for story page count per book format
 * (print redesign — slice 1).
 *
 *   digital  ->  6
 *   classic  -> 24
 *   premium  -> 32
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getStoryPageCount } from '../src/lib/orders.ts';

test('getStoryPageCount: digital -> 6', () => {
  assert.equal(getStoryPageCount('digital'), 6);
});

test('getStoryPageCount: classic -> 24', () => {
  assert.equal(getStoryPageCount('classic'), 24);
});

test('getStoryPageCount: premium -> 32', () => {
  assert.equal(getStoryPageCount('premium'), 32);
});

test('getStoryPageCount: unknown format defaults to digital length (6)', () => {
  // Defensive: any unrecognized format must not silently produce a long
  // book — falling back to the safer digital length keeps storage and
  // generation cost bounded.
  assert.equal(getStoryPageCount('weird'), 6);
  assert.equal(getStoryPageCount(''), 6);
});
