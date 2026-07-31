import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ORDERS_SRC = readFileSync('src/lib/orders.ts', 'utf8');
const STORY_GENERATOR_SRC = readFileSync('src/lib/story-generator.ts', 'utf8');

test('order sanitization preserves supporting-character must-include details and reference intent', () => {
  assert.match(ORDERS_SRC, /export type CharacterLikenessIntent = 'reference' \| 'storybook'/);
  assert.match(ORDERS_SRC, /export type CharacterMustInclude =/);
  assert.match(ORDERS_SRC, /'custom-detail'/);
  assert.match(ORDERS_SRC, /mustInclude\?: CharacterMustInclude\[\] \| string\[\] \| null/);
  assert.match(ORDERS_SRC, /mustIncludeOther\?: string \| null/);
  assert.match(ORDERS_SRC, /mustInclude: sanitizeMustInclude\(character\?\.mustInclude\)/);
  assert.match(ORDERS_SRC, /mustIncludeOther: cleanShortText\(character\?\.mustIncludeOther, 80\)/);
  assert.match(
    ORDERS_SRC,
    /const likenessIntent: CharacterLikenessIntent =\s*photoFileName \|\| photoBlobPath \|\| photoBlobUrl \? 'reference' : 'storybook'/,
  );
  assert.match(ORDERS_SRC, /likenessIntent,/);
});

test('story prompt block keeps supporting-photo copy honest and includes must-include details', () => {
  assert.match(STORY_GENERATOR_SRC, /operator review\/reference only/);
  assert.match(STORY_GENERATOR_SRC, /Storybook-character treatment; use the written details without implying a real-photo match/);
  assert.match(STORY_GENERATOR_SRC, /Must include: \$\{mustInclude\.join\(', '\)\}/);
  assert.match(STORY_GENERATOR_SRC, /Reference attached for operator review/);
  assert.match(STORY_GENERATOR_SRC, /supporting[\s\S]*operator-review references rather than exact-likeness guarantees/);
});
