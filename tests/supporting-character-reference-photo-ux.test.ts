import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const CHECKOUT_SRC = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('supporting character photos are presented as optional single reference photos', () => {
  assert.match(
    CHECKOUT_SRC,
    /Supporting character reference photo/,
    'family-member cards should label the feature as a first-class reference-photo section',
  );
  assert.match(
    CHECKOUT_SRC,
    /Want this character to look more like themselves\?/,
    'family-member cards should prompt users to add a photo after adding a person',
  );
  assert.match(
    CHECKOUT_SRC,
    /One optional still photo helps guide the illustration/,
    'copy should explain the safer MVP: one optional still reference photo',
  );
  assert.match(
    CHECKOUT_SRC,
    /The child remains the main hero reference/,
    'copy should avoid implying every supporting character gets the same hero capture treatment',
  );
});

test('supporting character photo UI keeps camera and upload choices without biometric claims', () => {
  assert.match(CHECKOUT_SRC, /Use camera/);
  assert.match(CHECKOUT_SRC, /Upload photo/);
  assert.match(CHECKOUT_SRC, /capture="user"/);

  const supportingSection = CHECKOUT_SRC.slice(
    CHECKOUT_SRC.indexOf('Who else should appear?'),
    CHECKOUT_SRC.indexOf('{VOICE_BETA_ENABLED &&'),
  );
  assert.doesNotMatch(
    supportingSection,
    /face scan|Face ID|biometric|exact likeness/i,
    'supporting-character copy must not create biometric/exact-likeness promises',
  );
});
