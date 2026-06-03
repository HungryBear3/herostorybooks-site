#!/usr/bin/env node
/**
 * Checkout voice-beta smoke (READ-ONLY, source-level).
 *
 * Guards the specific 2026-06-03 regression shape: a deploy that has voice
 * beta ENABLED must still render the voice-upload section on /checkout. If a
 * branch drops the section while the flag is on, customers see a broken voice
 * promise. This asserts the section + accepted-uploads copy are present in the
 * checkout source — it does NOT launch a browser, call providers, or submit an
 * order.
 *
 * Voice-beta signal: --voice-beta flag OR NEXT_PUBLIC_HSB_VOICE_BETA=true.
 * When voice beta is OFF, the section is not required and the check PASSES.
 *
 * Usage:
 *   node scripts/checkout-voice-smoke.mjs [--form=PATH] [--section=PATH]
 *        [--voice-beta] [--json]
 *
 * Exit codes: 0 PASS, 1 FAIL (beta on but section/copy missing), 2 invocation error.
 */
import { existsSync, readFileSync } from 'node:fs';

let formPath = 'src/app/checkout/checkout-form.tsx';
let sectionPath = 'src/components/checkout/VoiceRecorderSection.tsx';
let voiceBetaFlag = false;
let json = false;
for (const a of process.argv.slice(2)) {
  if (a === '--json') json = true;
  else if (a === '--voice-beta') voiceBetaFlag = true;
  else if (a === '-h' || a === '--help') {
    process.stdout.write('Usage: node scripts/checkout-voice-smoke.mjs [--form=PATH] [--section=PATH] [--voice-beta] [--json]\nRead-only source check; no browser, no providers, no order submission.\n');
    process.exit(0);
  } else if (a.startsWith('--form=')) formPath = a.slice('--form='.length);
  else if (a.startsWith('--section=')) sectionPath = a.slice('--section='.length);
  else { console.error(`Unknown argument: ${a}`); process.exit(2); }
}

const voiceBeta = voiceBetaFlag || process.env.NEXT_PUBLIC_HSB_VOICE_BETA === 'true';

const checks = [];
function add(status, detail) { checks.push({ status, detail }); }

if (!voiceBeta) {
  add('PASS', 'voice beta is OFF (NEXT_PUBLIC_HSB_VOICE_BETA != "true") — voice section not required.');
} else {
  if (!existsSync(formPath)) {
    add('FAIL', `checkout form not found: ${formPath}`);
  } else {
    const form = readFileSync(formPath, 'utf8');
    // The section must be rendered behind the voice-beta gate.
    if (/VOICE_BETA_ENABLED\s*&&[\s\S]{0,80}<VoiceRecorderSection/.test(form)) {
      add('PASS', 'checkout renders <VoiceRecorderSection> behind the VOICE_BETA_ENABLED gate.');
    } else {
      add('FAIL', 'voice beta is ON but /checkout does not render <VoiceRecorderSection> behind VOICE_BETA_ENABLED.');
    }
  }
  if (!existsSync(sectionPath)) {
    add('FAIL', `voice section component not found: ${sectionPath}`);
  } else {
    const section = readFileSync(sectionPath, 'utf8');
    const acceptsAudio = /audio\/\*/.test(section) || /\.webm/.test(section);
    const acceptsDocs = /wordprocessingml|application\/pdf|\.docx/.test(section);
    if (acceptsAudio && acceptsDocs) {
      add('PASS', 'voice section accepts audio and document uploads (accepted-uploads copy present).');
    } else {
      add('FAIL', `voice section missing accepted-uploads markers (audio=${acceptsAudio}, docs=${acceptsDocs}).`);
    }
  }
}

const verdict = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : 'PASS';
if (json) {
  process.stdout.write(JSON.stringify({ voiceBeta, checks, verdict }, null, 2) + '\n');
} else {
  process.stdout.write(`Checkout voice-beta smoke (read-only) — voiceBeta=${voiceBeta}\n\n`);
  for (const c of checks) process.stdout.write(`${c.status === 'PASS' ? '✅ PASS' : '❌ FAIL'}  ${c.detail}\n`);
  process.stdout.write(`\nVerdict: ${verdict}\n`);
}
process.exit(verdict === 'PASS' ? 0 : 1);
