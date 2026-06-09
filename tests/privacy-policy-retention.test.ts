import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const PRIVACY_SRC = readFileSync(resolve(process.cwd(), 'src/app/privacy/page.tsx'), 'utf8');

test('privacy policy avoids unsupported retention and provider no-train promises', () => {
  assert.match(PRIVACY_SRC, /Last updated June 8, 2026/);
  assert.match(PRIVACY_SRC, /guided reference photos/i);
  assert.match(PRIVACY_SRC, /train our own AI models/i);
  assert.match(PRIVACY_SRC, /providers may temporarily process or store order inputs/i);
  assert.match(PRIVACY_SRC, /request deletion/i);
  assert.doesNotMatch(PRIVACY_SRC, /book delivery plus 30 days/i);
  assert.doesNotMatch(PRIVACY_SRC, /story\/proof generation plus 30 days/i);
  assert.doesNotMatch(PRIVACY_SRC, /never used to train AI/i);
  assert.match(PRIVACY_SRC, /support@herostorybooks\.com/);
});
