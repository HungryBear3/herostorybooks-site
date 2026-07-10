/**
 * Story-shape status / gate model tests (rollout model §5 shape status map).
 * Fail-closed: unknown or not-yet-accepted shapes are never self-serve sellable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  statusForShape,
  isSelfServeSellable,
  shapeKey,
  STORY_SHAPE_STATUS,
} from '../src/lib/custom-story/shapes.ts';
import type { StoryShape } from '../src/lib/custom-story/types.ts';

test('child+guided+child-hero is the live self-serve baseline', () => {
  const shape: StoryShape = { heroStructure: 'child', storySource: 'guided', childRole: 'hero' };
  const s = statusForShape(shape);
  assert.equal(s.lane, 'self-serve-live');
  assert.equal(s.sellableSelfServe, true);
  assert.equal(isSelfServeSellable(shape), true);
});

test('parent+guided+child-recipient is gated (not self-serve yet)', () => {
  const shape: StoryShape = { heroStructure: 'parent', storySource: 'guided', childRole: 'recipient' };
  const s = statusForShape(shape);
  assert.equal(s.lane, 'gated');
  assert.equal(s.sellableSelfServe, false);
  assert.equal(s.conciergeAllowed, true);
});

test('grandparent+guided+child-recipient is sampling', () => {
  const shape: StoryShape = { heroStructure: 'grandparent', storySource: 'guided', childRole: 'recipient' };
  assert.equal(statusForShape(shape).lane, 'sampling');
});

test('dual-parent+memory+child-audience is concierge (Taco Gate)', () => {
  const shape: StoryShape = { heroStructure: 'dual-parent', storySource: 'memory', childRole: 'audience' };
  const s = statusForShape(shape);
  assert.equal(s.lane, 'concierge');
  assert.equal(s.sellableSelfServe, false);
});

test('siblings / whole-family / custom-cast are not accepted in any lane', () => {
  for (const heroStructure of ['sibling', 'whole-family', 'custom-cast'] as const) {
    const shape: StoryShape = { heroStructure, storySource: 'guided', childRole: 'hero' };
    const s = statusForShape(shape);
    assert.equal(s.lane, 'not-accepted');
    assert.equal(s.sellableSelfServe, false);
    assert.equal(s.conciergeAllowed, false);
  }
});

test('unknown combination fails closed to not-accepted, no self-serve', () => {
  const shape: StoryShape = { heroStructure: 'pet', storySource: 'custom-plot', childRole: 'listener' };
  const s = statusForShape(shape);
  assert.equal(s.lane, 'not-accepted');
  assert.equal(s.sellableSelfServe, false);
});

test('shapeKey is the canonical map key', () => {
  const shape: StoryShape = { heroStructure: 'dual-parent', storySource: 'memory', childRole: 'audience' };
  assert.equal(shapeKey(shape), 'dual-parent|memory|audience');
  assert.ok(STORY_SHAPE_STATUS[shapeKey(shape)]);
});
