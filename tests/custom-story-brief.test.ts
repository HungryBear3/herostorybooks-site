/**
 * Unit tests for the custom-story brief/plan/prose validators.
 * Fail-closed semantics: any failure → route 'manual_queue', never a fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCustomStoryBrief,
  validateCustomStoryPlanAnchors,
  validateFinalCustomStoryProse,
  enforceCastLock,
} from '../src/lib/custom-story/validate.ts';
import type { CustomStoryBrief, CustomStoryBeat } from '../src/lib/custom-story/types.ts';
import { TACO_GATE_BRIEF, tacoGatePlanBeats } from './fixtures/taco-gate-brief.ts';

function clone(brief: CustomStoryBrief): CustomStoryBrief {
  return JSON.parse(JSON.stringify(brief)) as CustomStoryBrief;
}
function beats(lines: string[]): CustomStoryBeat[] {
  return lines.map((text, index) => ({ index, text }));
}

// ── Brief validation ─────────────────────────────────────────────────────────

test('valid sanitized brief passes and routes proceed', () => {
  const r = validateCustomStoryBrief(TACO_GATE_BRIEF);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  assert.equal(r.route, 'proceed');
});

test('brief with a smuggled rawTranscript fails closed (sanitization boundary)', () => {
  const poisoned = { ...clone(TACO_GATE_BRIEF), rawTranscript: 'so anyway during the divorce we...' };
  const r = validateCustomStoryBrief(poisoned as unknown as CustomStoryBrief);
  assert.equal(r.ok, false);
  assert.equal(r.route, 'manual_queue');
  assert.ok(r.failures.some((f) => f.code === 'raw_source_leak'));
});

test('ensemble cap: a third primary hero fails', () => {
  const b = clone(TACO_GATE_BRIEF);
  b.primaryHeroes.push({ name: 'Grandpa', role: 'primary_hero' });
  b.castLock.push('Grandpa');
  const r = validateCustomStoryBrief(b);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'ensemble_cap_exceeded'));
});

test('recipient cast as protagonist fails', () => {
  const b = clone(TACO_GATE_BRIEF);
  b.recipientAudience!.role = 'primary_hero';
  const r = validateCustomStoryBrief(b);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'recipient_is_protagonist'));
});

test('name outside castLock fails', () => {
  const b = clone(TACO_GATE_BRIEF);
  b.castLock = ['Mom', 'Lukas']; // dropped Dad
  const r = validateCustomStoryBrief(b);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'cast_not_locked' && f.subject === 'Dad'));
});

test('voice-memo brief without sanitized summary fails', () => {
  const b = clone(TACO_GATE_BRIEF);
  b.sanitizedSourceSummary = '';
  const r = validateCustomStoryBrief(b);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'missing_sanitized_summary'));
});

test('voice-memo brief not yet sanitized fails', () => {
  const b = clone(TACO_GATE_BRIEF);
  b.provenance.transcriptSanitized = false;
  const r = validateCustomStoryBrief(b);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'unsanitized_source'));
});

// ── Plan validation ──────────────────────────────────────────────────────────

test('taco-gate plan satisfies all anchors + ensemble + recipient checks', () => {
  const r = validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, tacoGatePlanBeats());
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('plan missing an anchor fails with anchor_missing', () => {
  const plan = tacoGatePlanBeats().filter(
    (b) => !/taco/i.test(b.text) && !/boat/i.test(b.text),
  );
  const r = validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, plan);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'anchor_missing'));
});

test('preset-template lexicon in a custom plan fails (template contamination)', () => {
  const plan = beats([
    'The family finds the floating taco bar.',
    'They wander into the jungle toward an ancient temple.',
    'Mom protects the joy and Dad enjoys his birthday tacos on the water.',
    'The charter boat ride home under a golden sky.',
  ]);
  const r = validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, plan);
  assert.equal(r.ok, false);
  const codes = r.failures.map((f) => f.code);
  assert.ok(codes.includes('template_contamination'));
});

test('ensemble collapse (Mom-only) fails Dad beat-share', () => {
  const plan = beats([
    'Mom packs for the boat ride.',
    'Mom keeps the day bright.',
    'Mom spots the floating taco bar.',
    'Mom protects the birthday joy.',
    'Mom chooses laughter for the family.',
    'Mom remembers the birthday tacos on the water.',
  ]);
  const r = validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, plan);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'ensemble_collapse' && f.subject === 'Dad'));
});

test('recipient driving the plot fails recipient protection', () => {
  const plan = beats([
    'Dad dreams of birthday tacos on the water at the floating taco bar.',
    'Mom protects the birthday joy on the charter boat ride.',
    'Lukas saves the day and rescues the whole family.',
    'Mom and Dad choose laughter together.',
  ]);
  const r = validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, plan);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'recipient_drives_plot'));
});

test('banned adult-conflict term in a plan fails', () => {
  const plan = tacoGatePlanBeats();
  plan.push({ index: plan.length, text: 'Later the parents talked about the divorce and the lawyer.' });
  const r = validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, plan);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'banned_term'));
});

// ── Final prose validation ───────────────────────────────────────────────────

test('final prose passes when clean and transcript has no verbatim overlap', () => {
  const transcript =
    'okay so it was my birthday and we took this little charter out to a floating taco spot ' +
    'and honestly the morning was a disaster but my wife just kept everyone laughing';
  const r = validateFinalCustomStoryProse(TACO_GATE_BRIEF, tacoGatePlanBeats(), {
    sourceTranscript: transcript,
  });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('final prose reproducing a verbatim transcript run fails (P9)', () => {
  const shared = 'we took a charter boat out to the floating taco bar for dad birthday';
  const transcript = `so ${shared} and it was wonderful`;
  const prose: CustomStoryBeat[] = [
    { index: 0, text: `One sunny day ${shared} and everyone smiled.` },
    { index: 1, text: 'Mom protects the joy and Dad loves his birthday tacos.' },
  ];
  const r = validateFinalCustomStoryProse(TACO_GATE_BRIEF, prose, { sourceTranscript: transcript });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'verbatim_quote'));
});

test('verbatim check is skipped when transcript is not available to this lane', () => {
  const b = clone(TACO_GATE_BRIEF);
  b.provenance.sourceTranscriptAvailableToProofLane = false;
  const shared = 'we took a charter boat out to the floating taco bar for dad birthday';
  const prose: CustomStoryBeat[] = [
    { index: 0, text: `One sunny day ${shared} and everyone smiled.` },
    { index: 1, text: 'Mom protects the joy and Dad loves his birthday tacos on the water.' },
    { index: 2, text: 'The family chooses laughter together.' },
  ];
  const r = validateFinalCustomStoryProse(b, prose, { sourceTranscript: `so ${shared}` });
  // No verbatim failure because the transcript is not flagged as available.
  assert.ok(!r.failures.some((f) => f.code === 'verbatim_quote'));
});

// ── Cast lock ────────────────────────────────────────────────────────────────

test('enforceCastLock passes for locked names, fails for outsiders', () => {
  assert.equal(enforceCastLock(TACO_GATE_BRIEF, ['Dad', 'Mom', 'Lukas']).ok, true);
  const r = enforceCastLock(TACO_GATE_BRIEF, ['Dad', 'Captain Rob']);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => f.code === 'cast_not_locked' && f.subject === 'Captain Rob'));
});
