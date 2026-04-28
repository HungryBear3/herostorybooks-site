/**
 * Character anchor — keeps the same child stable across initial generation
 * and regenerates of any single page within one story.
 *
 * The anchor is the FIRST section of the page prompt. It is set once at
 * fulfillment time from StoryContent.characterDescription, persisted on each
 * PageArtifact, and reused verbatim by every regenerate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPagePrompt,
  buildRegeneratePrompt,
} from '../src/lib/image-prompt-builder.ts';

const order = {
  childName: 'Luna',
  childAge: '6',
  characterNotes: 'loves dinosaurs',
  appearanceOptions: 'brown curly hair, hazel eyes',
  photoBlobPath: 'orders/ord_x/photo-luna.jpg',
  theme: 'space-voyager',
};

const ANCHOR =
  'Luna, a 6-year-old girl with a heart-shaped face, wide hazel eyes set close together, ' +
  'thick eyebrows, shoulder-length tightly-coiled brown curls, warm tan skin, slight build, ' +
  'small dimples when smiling.';

// ── Initial-generation prompt ──

test('buildPagePrompt: anchor is the FIRST section of the prompt', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'A starlit nebula scene with a small ship.',
    order,
    characterAnchor: ANCHOR,
  });
  // The anchor section header must precede the basePrompt and the identity
  // section. This positioning is the whole point of the fix.
  const anchorIdx = prompt.indexOf('CHARACTER (must remain identical');
  const baseIdx = prompt.indexOf('A starlit nebula');
  const identityIdx = prompt.indexOf('Hero: Luna');
  assert.ok(anchorIdx >= 0, 'anchor section must be present');
  assert.ok(anchorIdx < baseIdx, 'anchor must appear before basePrompt');
  assert.ok(anchorIdx < identityIdx, 'anchor must appear before identity section');
});

test('buildPagePrompt: anchor text is included verbatim', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'A scene.',
    order,
    characterAnchor: ANCHOR,
  });
  assert.ok(prompt.includes(ANCHOR), 'full anchor description must be in the prompt');
});

test('buildPagePrompt: empty anchor is omitted (no empty section)', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'A scene.',
    order,
    characterAnchor: '',
  });
  assert.ok(!prompt.includes('CHARACTER (must remain identical'), 'no anchor header when empty');
});

test('buildPagePrompt: missing characterAnchor is omitted', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'A scene.',
    order,
  });
  assert.ok(!prompt.includes('CHARACTER (must remain identical'), 'no anchor header when undefined');
});

test('buildPagePrompt: whitespace-only anchor is treated as empty', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'A scene.',
    order,
    characterAnchor: '   \n  ',
  });
  assert.ok(!prompt.includes('CHARACTER (must remain identical'), 'no anchor header when whitespace-only');
});

// ── Cross-page consistency ──

test('cross-page consistency: same anchor produces identical anchor section across two different pages', () => {
  const p1 = buildPagePrompt({
    basePrompt: 'Page 1 scene: arriving at the launchpad.',
    order,
    characterAnchor: ANCHOR,
  });
  const p2 = buildPagePrompt({
    basePrompt: 'Page 4 scene: meeting an alien friend.',
    order,
    characterAnchor: ANCHOR,
  });
  // Both prompts must contain the exact same anchor text — the whole identity
  // contract is that the model sees the same character description on every page.
  assert.ok(p1.includes(ANCHOR));
  assert.ok(p2.includes(ANCHOR));
  // The basePrompts differ (so the prompts overall differ) but the anchor section
  // header occurs at the same position in both.
  assert.equal(p1.indexOf('CHARACTER (must remain identical'), p2.indexOf('CHARACTER (must remain identical'));
});

// ── Regenerate path ──

test('buildRegeneratePrompt: anchor leads regenerate prompts too', () => {
  const { prompt } = buildRegeneratePrompt({
    basePrompt: 'A scene.',
    order,
    characterAnchor: ANCHOR,
    feedback: 'Make her hands less floaty.',
  });
  const anchorIdx = prompt.indexOf('CHARACTER (must remain identical');
  const feedbackIdx = prompt.indexOf('Make her hands less floaty');
  assert.ok(anchorIdx >= 0, 'anchor must be present on regenerate');
  assert.ok(anchorIdx < feedbackIdx, 'anchor must appear before customer feedback delta');
});

test('buildRegeneratePrompt: same anchor across initial + regenerate of the same page', () => {
  const initial = buildPagePrompt({
    basePrompt: 'A scene.',
    order,
    characterAnchor: ANCHOR,
  });
  const regen = buildRegeneratePrompt({
    basePrompt: 'A scene.',
    order,
    characterAnchor: ANCHOR,
    feedback: 'tweak the hands',
  }).prompt;
  assert.ok(initial.includes(ANCHOR));
  assert.ok(regen.includes(ANCHOR));
});

// ── Integration with quality + identity sections ──

test('buildPagePrompt: identity section + continuity + quality all still emitted alongside anchor', () => {
  const prompt = buildPagePrompt({
    basePrompt: 'A scene.',
    order,
    characterAnchor: ANCHOR,
  });
  assert.ok(prompt.includes('Hero: Luna'), 'identity section still present');
  assert.ok(prompt.includes('Maintain visual continuity'), 'continuity section still present');
  assert.ok(prompt.includes('Quality requirements'), 'quality section still present');
});
