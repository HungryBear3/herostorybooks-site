import test from 'node:test';
import assert from 'node:assert/strict';

import { lintHsbClaims } from '../scripts/hsb-claims-lint.mjs';

test('HSB claims lint blocks unsafe speed/deletion/guarantee claims', () => {
  const result = lintHsbClaims('Instant same-day storybook with guaranteed delivery and automatic deletion after shipping.');
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => v.id).sort(), [
    'automatic_deletion',
    'guaranteed_delivery',
    'instant_claim',
    'same_day_claim',
  ]);
});

test('HSB claims lint allows manually defensible proof-first copy', () => {
  const result = lintHsbClaims('We prepare your proof in a small batch for your review before any printed book is submitted.');
  assert.equal(result.ok, true);
});
