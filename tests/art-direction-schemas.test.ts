import test from 'node:test';
import assert from 'node:assert/strict';

import { ZodError } from 'zod';
import {
  CharacterSheetSchema,
  StyleBibleSchema,
  StoryboardSchema,
  parseArtDirectionPacket,
  parseStoryboard,
} from '../src/lib/art-direction-schemas.ts';
import { lukasDinoMissingContinuityFixture } from './fixtures/art-direction/lukas-dino-invalid-missing-continuity.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';

function issuePaths(error: ZodError) {
  return error.issues.map((issue) => issue.path.join('.'));
}

test('art-direction schemas parse the Lukas + juvenile dinosaur fixture', () => {
  const parsed = parseArtDirectionPacket(lukasDinoArtDirectionFixture);

  assert.equal(parsed.style_bible.book_id, 'book_lukas_dino');
  assert.equal(parsed.character_sheets.find((sheet) => sheet.role === 'hero')?.display_name, 'Lukas');
  assert.equal(parsed.character_sheets.find((sheet) => sheet.role === 'companion')?.companion_anchors?.scale_relative_to_hero, 'same_height_or_slightly_smaller');
  assert.equal(parsed.storyboard.entries.length, 24);
  assert.equal(parsed.storyboard.entries[0].continuity_callback.to_page, null);
  assert.equal(parsed.storyboard.entries[23].story_beat, 'tag');
});

test('art-direction fixtures survive JSON-like serialization before validation', () => {
  const jsonLikePayload = JSON.parse(JSON.stringify(lukasDinoArtDirectionFixture));
  const parsed = parseArtDirectionPacket(jsonLikePayload);

  assert.equal(parsed.style_bible.target_illustration_style, 'watercolor_classic');
  assert.deepEqual(parsed.style_bible.continuity_motifs, ['red-bandana', 'yellow-flower', 'cloth-map']);
});

test('style bible rejects missing operator approval fields', () => {
  const payload = structuredClone(lukasDinoArtDirectionFixture.style_bible) as any;
  delete payload.versioning.approved_by;

  const result = StyleBibleSchema.safeParse(payload);
  assert.equal(result.success, false);
  assert.ok(issuePaths(result.error).includes('versioning.approved_by'));
});

test('character sheet enforces role-specific companion anchors', () => {
  const companion = structuredClone(lukasDinoArtDirectionFixture.character_sheets[1]) as any;
  delete companion.companion_anchors;

  const result = CharacterSheetSchema.safeParse(companion);
  assert.equal(result.success, false);
  assert.ok(issuePaths(result.error).includes('companion_anchors'));
  assert.match(result.error.issues.map((issue) => issue.message).join('\n'), /companion sheets require companion_anchors/);
});

test('storyboard rejects fewer than 24 entries', () => {
  const storyboard = structuredClone(lukasDinoArtDirectionFixture.storyboard);
  storyboard.entries = storyboard.entries.slice(0, 23);

  const result = StoryboardSchema.safeParse(storyboard);
  assert.equal(result.success, false);
  assert.match(result.error.issues.map((issue) => issue.message).join('\n'), /Array must contain exactly 24 element/);
});

test('storyboard rejects missing continuity_callback and required_recurring_objects', () => {
  const result = StoryboardSchema.safeParse(lukasDinoMissingContinuityFixture.storyboard);

  assert.equal(result.success, false);
  assert.ok(issuePaths(result.error).includes('entries.1.continuity_callback'));
  assert.ok(issuePaths(result.error).includes('entries.1.required_recurring_objects'));
});

test('storyboard enforces all required story beats across the full book', () => {
  const storyboard = structuredClone(lukasDinoArtDirectionFixture.storyboard);
  storyboard.entries = storyboard.entries.map((entry) => entry.story_beat === 'climax' ? { ...entry, story_beat: 'rising' as const } : entry);

  const result = parseStoryboard.bind(null, storyboard);
  assert.throws(result, /storyboard missing story_beat climax/);
});
