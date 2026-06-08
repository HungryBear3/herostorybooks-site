/**
 * Phase 4 — deterministic, local pre-purchase story preview.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStoryPreview } from '../src/lib/story-preview.ts';

const REQ = { childName: 'Luna', theme: 'dinosaur-discovery' };

// ── renders only once required fields are present (no early/blank card) ────────

test('returns null until both child name and theme are present', () => {
  assert.equal(buildStoryPreview({}), null);
  assert.equal(buildStoryPreview({ childName: 'Luna' }), null);
  assert.equal(buildStoryPreview({ theme: 'dinosaur-discovery' }), null);
  assert.equal(buildStoryPreview({ childName: '   ', theme: 'dinosaur-discovery' }), null);
});

test('never blank once required fields are present', () => {
  const p = buildStoryPreview(REQ)!;
  assert.ok(p);
  assert.equal(p.title, 'Your story will be about…');
  assert.equal(p.hero, 'Luna');
  assert.ok(p.beats.length >= 3 && p.beats.length <= 5);
  assert.ok(p.beats.every((b) => b.includes('Luna') || b.trim().length > 0));
  assert.ok(p.disclaimer.length > 0);
});

test('thin inputs (unknown theme) still produce a non-blank, generic preview', () => {
  const p = buildStoryPreview({ childName: 'Sam', theme: 'totally-unknown-theme' })!;
  assert.ok(p && p.beats.length >= 3);
  // Unknown theme must NOT echo the raw id.
  assert.doesNotMatch(JSON.stringify(p), /totally-unknown-theme/);
});

// ── changes with lesson / message / note ──────────────────────────────────────

test('preview changes when the lesson changes', () => {
  const a = buildStoryPreview({ ...REQ, lesson: 'courage' })!;
  const b = buildStoryPreview({ ...REQ, lesson: 'kindness' })!;
  assert.notDeepEqual(a.beats, b.beats);
});

test('preview changes when the typed note / gift message changes', () => {
  const a = buildStoryPreview({ ...REQ, characterNotes: 'loves her red bike' })!;
  const b = buildStoryPreview({ ...REQ, characterNotes: 'afraid of the dark' })!;
  assert.notEqual(a.customDetailHint, b.customDetailHint);
  const g1 = buildStoryPreview({ ...REQ, giftMessage: 'from grandma' })!;
  const g2 = buildStoryPreview({ ...REQ, giftMessage: 'from dad' })!;
  assert.notEqual(g1.customDetailHint, g2.customDetailHint);
});

// ── voice wording: direction/inspiration, not transcript certainty ────────────

test('attached-but-not-transcribed voice uses direction/inspiration wording', () => {
  const p = buildStoryPreview({ ...REQ, voiceAttached: true, voiceTranscribed: false })!;
  assert.ok(p.voiceNote);
  assert.match(p.voiceNote!, /direction|inspiration/i);
  assert.doesNotMatch(p.voiceNote!, /transcript|we heard|you said|transcribed/i);
});

test('no voice attached → no voice note; transcribed → no "will use recording" note', () => {
  assert.equal(buildStoryPreview(REQ)!.voiceNote, null);
  assert.equal(buildStoryPreview({ ...REQ, voiceAttached: true, voiceTranscribed: true })!.voiceNote, null);
});

// ── guided refs summarized by count only ──────────────────────────────────────

test('guided reference photos are summarized by count only (no names/paths)', () => {
  const p = buildStoryPreview({ ...REQ, guidedPhotoCount: 3 })!;
  assert.match(p.guidedNote!, /3 approved reference photos/);
  assert.doesNotMatch(p.guidedNote!, /\.jpg|guided-|orders\/|front|left|right/i);
  assert.equal(buildStoryPreview({ ...REQ, guidedPhotoCount: 1 })!.guidedNote, 'Using 1 approved reference photo for a consistent look.');
  assert.equal(buildStoryPreview(REQ)!.guidedNote, null);
});

// ── print proof-before-print copy ─────────────────────────────────────────────

test('print formats include proof-before-print reassurance', () => {
  for (const fmt of ['classic', 'premium']) {
    const p = buildStoryPreview({ ...REQ, bookFormat: fmt })!;
    assert.equal(p.isPrint, true);
    assert.match(p.disclaimer, /before anything prints/i);
    assert.ok(p.stylePromise.some((s) => /before anything prints/i.test(s)));
  }
  const digital = buildStoryPreview({ ...REQ, bookFormat: 'digital' })!;
  assert.equal(digital.isPrint, false);
  assert.match(digital.disclaimer, /before we finalize/i);
});

// ── no internal-label leaks ───────────────────────────────────────────────────

test('preview never leaks internal labels or raw ids', () => {
  const p = buildStoryPreview({
    childName: 'Luna',
    theme: 'custom-voice-story',
    lesson: 'courage',
    giftMessage: 'happy birthday',
    characterNotes: 'loves dinosaurs',
    voiceAttached: true,
    guidedPhotoCount: 2,
    bookFormat: 'classic',
  })!;
  const blob = JSON.stringify(p);
  for (const leak of ['Theme:', 'Format:', 'SKU', 'voiceSource', 'artifact', 'guidedPhoto_', 'bookFormat', 'custom-voice-story', 'dinosaur-discovery', 'ord_']) {
    assert.ok(!blob.includes(leak), `must not leak "${leak}"`);
  }
});
