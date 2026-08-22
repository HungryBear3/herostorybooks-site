import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('terms include adult authorization, no-training/no-cloning, deletion, and primary hero preview copy', () => {
  const src = readFileSync('src/app/terms/page.tsx', 'utf8');
  assert.match(src, /you are an adult/);
  assert.match(src, /permission from their parent or guardian/);
  assert.match(src, /do <strong>not<\/strong> use uploaded media for voice cloning/);
  assert.match(src, /AI model training/);
  assert.match(src, /request deletion of uploaded photos, voice files, or documents/);
  assert.match(src, /Primary hero preview features/);
  assert.match(src, /concierge intake confirmation/);
});

test('privacy copy keeps legal-review marker and avoids compliance overclaiming', () => {
  const src = readFileSync('src/app/privacy/page.tsx', 'utf8');
  assert.match(src, /LEGAL REVIEW REQUIRED/);
  assert.match(src, /This is NOT a claim of legal compliance/);
  assert.match(src, /Illinois Biometric Information Privacy Act \(BIPA\)/);
  assert.match(src, /do <strong>not<\/strong> clone anyone&apos;s voice/);
});


test('Fable-required legal copy covers no templates, no voiceprints, and transcription disclosure', () => {
  const privacy = readFileSync('src/app/privacy/page.tsx', 'utf8');
  const terms = readFileSync('src/app/terms/page.tsx', 'utf8');
  assert.match(privacy, /do <strong>not<\/strong> create face-recognition templates/);
  assert.match(privacy, /do <strong>not<\/strong> create voiceprints/);
  assert.match(terms, /transcribed/);
  assert.match(terms, /story inspiration/);
});
