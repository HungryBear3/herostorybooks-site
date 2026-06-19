import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const checkoutFormSource = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

test('voice upload stays visible by default unless explicitly disabled', () => {
  assert.match(
    checkoutFormSource,
    /const VOICE_BETA_ENABLED = process\.env\.NEXT_PUBLIC_HSB_VOICE_BETA !== ['"]false['"];/,
  );
  assert.doesNotMatch(
    checkoutFormSource,
    /process\.env\.NEXT_PUBLIC_HSB_VOICE_BETA === ['"]true['"]/,
  );
});
