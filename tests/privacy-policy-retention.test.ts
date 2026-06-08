import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const PRIVACY_SRC = readFileSync(resolve(process.cwd(), 'src/app/privacy/page.tsx'), 'utf8');

test('privacy policy states approved child photo and voice retention windows', () => {
  assert.match(PRIVACY_SRC, /Last updated June 8, 2026/);
  assert.match(PRIVACY_SRC, /guided reference photos/i);
  assert.match(PRIVACY_SRC, /book delivery plus 30 days/i);
  assert.match(PRIVACY_SRC, /story\/proof generation plus 30 days/i);
  assert.match(PRIVACY_SRC, /not use uploaded photos, guided reference photos, or voice notes to train AI models/i);
  assert.match(PRIVACY_SRC, /request earlier deletion/i);
  assert.match(PRIVACY_SRC, /support@herostorybooks\.com/);
});
