/**
 * Tier1 C — deterministic singular-they correction.
 *
 * `correctSingularThey` is a post-generation transform applied before image
 * prompts / PDF build. `detectSingularTheyIssues` remains the fail-closed
 * backstop — so corrected output must also pass the detector.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { correctSingularThey, detectSingularTheyIssues } from '../src/lib/story-generator.ts';

test('corrects the canonical singular-they agreement bugs', () => {
  assert.equal(
    correctSingularThey('They is brave and they was scared.'),
    'They are brave and they were scared.',
  );
  assert.equal(
    correctSingularThey('Then they runs fast and they watches the sky.'),
    'Then they run fast and they watch the sky.',
  );
  assert.equal(
    correctSingularThey('They has a map and they goes home.'),
    'They have a map and they go home.',
  );
});

test('corrects them-is and themself artifacts (case-preserving)', () => {
  assert.equal(correctSingularThey('them is ready'), 'they are ready');
  assert.equal(correctSingularThey('Them is ready'), 'They are ready');
  assert.equal(correctSingularThey('Lucas hugged themself tight.'), 'Lucas hugged themselves tight.');
});

test('corrected output passes the detector backstop (no residual issues)', () => {
  const corrected = correctSingularThey(
    'They is here, they was there, they runs, they goes, and they has it.',
  );
  assert.deepEqual(detectSingularTheyIssues(corrected), []);
});

test('leaves grammatically correct plural-agreement prose untouched', () => {
  const clean = 'They are brave. They run and they watch the stars.';
  assert.equal(correctSingularThey(clean), clean);
});

test('is a no-op on empty input', () => {
  assert.equal(correctSingularThey(''), '');
});
