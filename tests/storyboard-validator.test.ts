import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildArtDirectionStoryboardRecord,
  validateStoryboardCompleteness,
} from '../src/lib/storyboard-validator.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';

function issueCodes(result: ReturnType<typeof validateStoryboardCompleteness>) {
  return result.issues.map((issue) => issue.code);
}

test('storyboard validator accepts the complete Lukas + dino storyboard', () => {
  const result = validateStoryboardCompleteness(lukasDinoArtDirectionFixture);

  assert.equal(result.status, 'complete');
  assert.equal(result.bookId, 'book_lukas_dino');
  assert.equal(result.summary.expectedEntries, 24);
  assert.equal(result.summary.actualEntries, 24);
  assert.deepEqual(result.summary.missingPages, []);
  assert.deepEqual(result.summary.duplicatePages, []);
  assert.deepEqual(result.summary.missingStoryBeats, []);
  assert.deepEqual(result.summary.missingArcSections, []);
  assert.deepEqual(result.errors, []);
});

test('storyboard validator reports missing continuity and recurring objects with page paths', () => {
  const packet = structuredClone(lukasDinoArtDirectionFixture);
  delete (packet.storyboard.entries[1] as any).continuity_callback;
  packet.storyboard.entries[2].transition_into_next = null as any;
  packet.storyboard.entries[3].required_recurring_objects = [];

  const result = validateStoryboardCompleteness(packet);

  assert.equal(result.status, 'incomplete');
  assert.ok(issueCodes(result).includes('missing_continuity_callback'));
  assert.ok(issueCodes(result).includes('missing_transition_into_next'));
  assert.ok(issueCodes(result).includes('missing_required_recurring_objects'));
  assert.ok(result.errors.some((issue) =>
    issue.code === 'missing_continuity_callback' &&
    issue.path === 'entries.1.continuity_callback' &&
    issue.pageNumber === 2,
  ));
});

test('storyboard validator reports duplicate and missing page numbers', () => {
  const packet = structuredClone(lukasDinoArtDirectionFixture);
  packet.storyboard.entries[5] = {
    ...packet.storyboard.entries[5],
    page_number: 5,
  };

  const result = validateStoryboardCompleteness(packet);

  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.summary.duplicatePages, [5]);
  assert.deepEqual(result.summary.missingPages, [6]);
  assert.ok(issueCodes(result).includes('duplicate_page'));
  assert.ok(issueCodes(result).includes('missing_page'));
});

test('storyboard validator reports incomplete beat and beginning/middle/end coverage', () => {
  const packet = structuredClone(lukasDinoArtDirectionFixture);
  packet.storyboard.entries = packet.storyboard.entries.map((entry) => ({
    ...entry,
    story_beat: 'rising',
  }));

  const result = validateStoryboardCompleteness(packet);

  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.summary.coveredArcSections, ['middle']);
  assert.deepEqual(result.summary.missingArcSections, ['beginning', 'end']);
  assert.ok(result.summary.missingStoryBeats.includes('setup'));
  assert.ok(result.summary.missingStoryBeats.includes('tag'));
  assert.ok(issueCodes(result).includes('missing_story_arc_section'));
});

test('storyboard validator checks approval readiness fields represented in schemas', () => {
  const packet = structuredClone(lukasDinoArtDirectionFixture);
  delete (packet.style_bible.versioning as any).approved_by;
  delete (packet.character_sheets[0].versioning as any).approved_at;

  const result = validateStoryboardCompleteness(packet);

  assert.equal(result.status, 'incomplete');
  assert.ok(issueCodes(result).includes('style_bible_approval_missing'));
  assert.ok(issueCodes(result).includes('character_sheet_approval_missing'));
});

test('storyboard validator exposes persistence/model scaffolding without storage writes', () => {
  const validatedAt = '2026-05-28T21:30:00.000Z';
  const record = buildArtDirectionStoryboardRecord({
    packet: lukasDinoArtDirectionFixture,
    validatedAt,
  });

  assert.equal(record.bookId, 'book_lukas_dino');
  assert.equal(record.validationStatus, 'complete');
  assert.equal(record.validatedAt, validatedAt);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.storyboard.entries.length, 24);
});
