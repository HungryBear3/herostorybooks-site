import test from 'node:test';
import assert from 'node:assert/strict';

import { fixSingularTheyAgreement, spreadIndex } from '../src/lib/prose-quality.ts';

test('fixes singular-they verb agreement (the G5 defects)', () => {
  assert.equal(fixSingularTheyAgreement('They tells the best parts.'), 'They tell the best parts.');
  assert.equal(fixSingularTheyAgreement('this time, they does not hurry'), 'this time, they do not hurry');
  assert.equal(fixSingularTheyAgreement('They brushes dirt from a fossil tooth.'), 'They brush dirt from a fossil tooth.');
  assert.equal(fixSingularTheyAgreement('they is ready'), 'they are ready');
  assert.equal(fixSingularTheyAgreement('They chooses carefully.'), 'They choose carefully.');
  assert.equal(fixSingularTheyAgreement('they understands what the path asked'), 'they understand what the path asked');
});

test('leaves correct he/she singular verbs untouched', () => {
  assert.equal(fixSingularTheyAgreement('He tells the best parts.'), 'He tells the best parts.');
  assert.equal(fixSingularTheyAgreement('She chooses carefully.'), 'She chooses carefully.');
  assert.equal(fixSingularTheyAgreement('They are ready and she walks home.'), 'They are ready and she walks home.');
});

test('does not mangle plural nouns or unrelated -s words', () => {
  assert.equal(fixSingularTheyAgreement('the stones around it'), 'the stones around it');
  assert.equal(fixSingularTheyAgreement('they keeps the maps and books'), 'they keep the maps and books');
});

test('spreadIndex avoids adjacent repeats and covers the pool', () => {
  const pool = 6;
  const seq = Array.from({ length: 12 }, (_, i) => spreadIndex(i, pool));
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i], seq[i - 1], `adjacent repeat at ${i}: ${seq.join(',')}`);
  }
  // full coverage within one cycle
  assert.equal(new Set(seq.slice(0, pool)).size, pool);
  assert.equal(spreadIndex(0, 1), 0);
});
