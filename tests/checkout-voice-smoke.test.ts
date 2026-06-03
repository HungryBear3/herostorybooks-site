/**
 * Tests for scripts/checkout-voice-smoke.mjs — the read-only source check that
 * /checkout still renders the voice section when voice beta is enabled.
 * Uses temp fixture files; never launches a browser or submits an order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../scripts/checkout-voice-smoke.mjs', import.meta.url));

const GOOD_FORM = `const VOICE_BETA_ENABLED = process.env.NEXT_PUBLIC_HSB_VOICE_BETA === "true";
{VOICE_BETA_ENABLED && (
  <VoiceRecorderSection voiceFile={form.voiceFile} />
)}`;
const BAD_FORM = `// voice section removed in this build
const VOICE_BETA_ENABLED = process.env.NEXT_PUBLIC_HSB_VOICE_BETA === "true";`;
const GOOD_SECTION = `const ACCEPT = ['audio/*', '.webm', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];`;

function fixture(form: string, section: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voice-smoke-'));
  const formPath = path.join(dir, 'checkout-form.tsx');
  const sectionPath = path.join(dir, 'VoiceRecorderSection.tsx');
  writeFileSync(formPath, form);
  writeFileSync(sectionPath, section);
  return { dir, formPath, sectionPath };
}

function run(formPath: string, sectionPath: string, extra: string[] = []) {
  const r = spawnSync('node', [SCRIPT, `--form=${formPath}`, `--section=${sectionPath}`, ...extra], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

test('voice beta OFF → PASS (section not required)', (t) => {
  const f = fixture(BAD_FORM, GOOD_SECTION);
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = run(f.formPath, f.sectionPath); // no --voice-beta, env not set
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Verdict: PASS/);
  assert.match(r.stdout, /voice beta is OFF/);
});

test('voice beta ON + section rendered + accepted-uploads copy → PASS', (t) => {
  const f = fixture(GOOD_FORM, GOOD_SECTION);
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = run(f.formPath, f.sectionPath, ['--voice-beta']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Verdict: PASS/);
  assert.match(r.stdout, /renders <VoiceRecorderSection>/);
});

test('voice beta ON but section missing from checkout → FAIL', (t) => {
  const f = fixture(BAD_FORM, GOOD_SECTION);
  t.after(() => rmSync(f.dir, { recursive: true, force: true }));
  const r = run(f.formPath, f.sectionPath, ['--voice-beta']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Verdict: FAIL/);
  assert.match(r.stdout, /does not render <VoiceRecorderSection>/);
});
