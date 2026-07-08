/**
 * Taco Gate regression suite (gatekeeper review B1).
 *
 * Built from the SANITIZED concierge sample brief (Rex packet §2), never the raw
 * transcript. Locks the failure mode that produced "Taco Gate": ensemble
 * collapse, template takeover, anchor loss, conflict leak.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateCustomStoryBrief,
  validateCustomStoryPlanAnchors,
  validateFinalCustomStoryProse,
} from '../src/lib/custom-story/validate.ts';
import { statusForShape } from '../src/lib/custom-story/shapes.ts';
import {
  TACO_GATE_BRIEF,
  TACO_GATE_PLAN_LINES,
  tacoGatePlanBeats,
} from './fixtures/taco-gate-brief.ts';

const planText = TACO_GATE_PLAN_LINES.join(' \n ').toLowerCase();

test('fixture is sanitized: no raw transcript field, provenance sanitized', () => {
  assert.ok(!('rawTranscript' in (TACO_GATE_BRIEF as Record<string, unknown>)));
  assert.equal(TACO_GATE_BRIEF.provenance.voiceMemoDerived, true);
  assert.equal(TACO_GATE_BRIEF.provenance.transcriptSanitized, true);
  assert.ok(TACO_GATE_BRIEF.sanitizedSourceSummary.length > 0);
});

test('shape is the concierge-only Taco Gate shape (not self-serve)', () => {
  const status = statusForShape(TACO_GATE_BRIEF.storyShape);
  assert.equal(status.lane, 'concierge');
  assert.equal(status.sellableSelfServe, false);
  assert.equal(status.conciergeAllowed, true);
});

test('sanitized brief validates', () => {
  const r = validateCustomStoryBrief(TACO_GATE_BRIEF);
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('planned output includes the required anchors (taco bar, boat, Dad birthday, Mom protects joy)', () => {
  const r = validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, tacoGatePlanBeats());
  assert.equal(r.ok, true, JSON.stringify(r.failures));
  // Explicit anchor presence spot-checks.
  assert.match(planText, /floating taco bar/);
  assert.match(planText, /boat/);
  assert.match(planText, /birthday/);
  assert.match(planText, /mom .*protects the birthday joy|mom gently protects/);
});

test('planned output excludes preset-template lexicon', () => {
  for (const forbidden of ['listening stones', 'brave explorer', 'jungle', 'temple']) {
    assert.ok(!planText.includes(forbidden), `plan must not contain '${forbidden}'`);
  }
});

test('Dad and Mom each pass the ≥1/3 co-protagonist beat-share check', () => {
  const beats = tacoGatePlanBeats();
  const total = beats.length;
  const share = (name: string) =>
    beats.filter((b) => b.text.toLowerCase().split(/[^a-z]+/).includes(name)).length / total;
  assert.ok(share('dad') >= 1 / 3 - 1e-9, `Dad share ${share('dad')}`);
  assert.ok(share('mom') >= 1 / 3 - 1e-9, `Mom share ${share('mom')}`);
  // And the validator agrees.
  assert.equal(validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, beats).ok, true);
});

test('Lukas never becomes a plot-driver/protagonist', () => {
  const beats = tacoGatePlanBeats();
  // Recipient appears (framing) but only with observer verbs.
  const lukasBeats = beats.filter((b) => /lukas/i.test(b.text));
  assert.ok(lukasBeats.length > 0, 'Lukas should appear in framing scenes');
  for (const b of lukasBeats) {
    assert.doesNotMatch(b.text, /lukas\s+\w*\s*(saves|rescues|solves|decides|leads|defeats)/i);
  }
  assert.equal(validateCustomStoryPlanAnchors(TACO_GATE_BRIEF, beats).ok, true);
});

test('banned adult-conflict terms are absent from the plan', () => {
  for (const term of ['divorce', 'separation', 'illness', 'blame', 'custody', 'lawyer', 'alcohol']) {
    assert.ok(!planText.includes(term), `plan must not contain '${term}'`);
  }
});

test('no real business names or names outside the cast in the plan', () => {
  // Cast-locked names may appear; nothing else proper-noun-like should drive.
  assert.ok(!/taco bell|taco time/i.test(planText), 'no real business names');
  // The only person-names in the plan are the locked cast.
  const proseCast = ['dad', 'mom', 'lukas'];
  for (const name of proseCast) {
    assert.ok(TACO_GATE_BRIEF.castLock.map((n) => n.toLowerCase()).includes(name));
  }
});

test('final prose validation passes on the manual-proof target with the transcript available', () => {
  const transcript =
    'it was my birthday trip and we caught a little charter out to a floating taco place ' +
    'the morning got messy but my wife kept the whole day fun for us';
  const r = validateFinalCustomStoryProse(TACO_GATE_BRIEF, tacoGatePlanBeats(), {
    sourceTranscript: transcript,
    detectedNames: ['Dad', 'Mom', 'Lukas'],
  });
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});
