import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ArtDirectionPromptBuilderError,
  buildArtDirectionPromptObject,
} from '../src/lib/art-direction-prompt-builder.ts';
import { lukasDinoArtDirectionFixture } from './fixtures/art-direction/lukas-dino-valid.ts';

const page4 = lukasDinoArtDirectionFixture.storyboard.entries[3];

test('art-direction prompt builder is deterministic for the same validated inputs', () => {
  const first = buildArtDirectionPromptObject({
    styleBible: lukasDinoArtDirectionFixture.style_bible,
    characterSheets: lukasDinoArtDirectionFixture.character_sheets,
    storyboardEntry: page4,
  });
  const second = buildArtDirectionPromptObject({
    styleBible: structuredClone(lukasDinoArtDirectionFixture.style_bible),
    characterSheets: structuredClone(lukasDinoArtDirectionFixture.character_sheets),
    storyboardEntry: structuredClone(page4),
  });

  assert.deepEqual(second, first);
});

test('art-direction prompt builder includes style bible, continuity, recurring objects, and story beat inputs', () => {
  const prompt = buildArtDirectionPromptObject({
    styleBible: lukasDinoArtDirectionFixture.style_bible,
    characterSheets: lukasDinoArtDirectionFixture.character_sheets,
    storyboardEntry: page4,
  });

  assert.equal(prompt.storyBeat, 'rising');
  assert.equal(prompt.visualBeat, 'Lukas and Sprout continue the backyard dinosaur adventure on page 4.');
  assert.match(prompt.positive, /Style bible:/);
  assert.match(prompt.positive, /watercolor_classic/);
  assert.match(prompt.positive, /2_soft_painterly/);
  assert.match(prompt.positive, /Continuity motifs: red-bandana, yellow-flower, cloth-map/);
  assert.match(prompt.positive, /Continuity callback: echo page 3 via prior_object/);
  assert.match(prompt.positive, /Transition into next: match_action/);
  assert.match(prompt.positive, /Required recurring objects on this page: yellow-flower/);
  assert.deepEqual(prompt.requiredRecurringObjects, ['yellow-flower']);
});

test('art-direction prompt builder emits character anchors and reference ids for Lukas and Sprout only', () => {
  const prompt = buildArtDirectionPromptObject({
    styleBible: lukasDinoArtDirectionFixture.style_bible,
    characterSheets: lukasDinoArtDirectionFixture.character_sheets,
    storyboardEntry: page4,
  });

  assert.equal(prompt.characterAnchors.length, 2);
  assert.match(prompt.positive, /Lukas \(hero\) must stay visually consistent/);
  assert.match(prompt.positive, /age 5; face round; eyes warm brown round/);
  assert.match(prompt.positive, /Sprout \(companion\) must stay visually consistent/);
  assert.match(prompt.positive, /Companion silhouette friendly_T_rex_juvenile/);
  assert.match(prompt.positive, /scale same_height_or_slightly_smaller/);
  assert.deepEqual(prompt.refs.characterSheetIds, ['char_lukas', 'char_sprout']);
  assert.deepEqual(prompt.refs.characterWatercolorAnchorIds, [
    'anchor_lukas_watercolor_1',
    'anchor_sprout_watercolor_1',
  ]);
  assert.deepEqual(prompt.refs.referencePhotoIds, [
    'photo_lukas_parent_ref_1',
    'style_ref_sprout_sketch',
  ]);
});

test('art-direction prompt builder includes negative/style guardrails from style, page, and companion anchors', () => {
  const prompt = buildArtDirectionPromptObject({
    styleBible: lukasDinoArtDirectionFixture.style_bible,
    characterSheets: lukasDinoArtDirectionFixture.character_sheets,
    storyboardEntry: page4,
  });

  assert.match(prompt.negative, /photorealism/);
  assert.match(prompt.negative, /cinematic_HDR/);
  assert.match(prompt.negative, /plastic_3d_cgi/);
  assert.match(prompt.negative, /sharp teeth shown/);
  assert.match(prompt.negative, /predatory stance/);
  assert.match(prompt.negative, /towering over Lukas/);
  assert.equal(new Set(prompt.negativeGuardrails).size, prompt.negativeGuardrails.length);
});

test('art-direction prompt builder includes page and safe-zone notes without raw object blobs', () => {
  const prompt = buildArtDirectionPromptObject({
    styleBible: lukasDinoArtDirectionFixture.style_bible,
    characterSheets: lukasDinoArtDirectionFixture.character_sheets,
    storyboardEntry: page4,
  });

  assert.match(prompt.positive, /Text safe zone: bottom 22% with 0.5in padding/);
  assert.match(prompt.positive, /Style safe zone: bottom 22% with 0.5in padding; spine safety 0.25in/);
  assert.match(prompt.positive, /Page text context: Lukas and Sprout found wonder waiting on page 4/);
  assert.doesNotMatch(prompt.positive, /\bundefined\b/);
  assert.doesNotMatch(prompt.positive, /\bnull\b/);
  assert.doesNotMatch(prompt.positive, /\[object Object\]/);
  assert.doesNotMatch(prompt.negative, /\bundefined\b/);
  assert.doesNotMatch(prompt.negative, /\bnull\b/);
  assert.doesNotMatch(prompt.negative, /\[object Object\]/);
});

test('art-direction prompt builder reports missing inputs with specific error codes', () => {
  assert.throws(
    () => buildArtDirectionPromptObject({
      styleBible: null as any,
      characterSheets: lukasDinoArtDirectionFixture.character_sheets,
      storyboardEntry: page4,
    }),
    (error) => error instanceof ArtDirectionPromptBuilderError && error.code === 'missing_style_bible',
  );
  assert.throws(
    () => buildArtDirectionPromptObject({
      styleBible: lukasDinoArtDirectionFixture.style_bible,
      characterSheets: [],
      storyboardEntry: page4,
    }),
    (error) => error instanceof ArtDirectionPromptBuilderError && error.code === 'missing_character_sheets',
  );
  assert.throws(
    () => buildArtDirectionPromptObject({
      styleBible: lukasDinoArtDirectionFixture.style_bible,
      characterSheets: lukasDinoArtDirectionFixture.character_sheets,
      storyboardEntry: undefined as any,
    }),
    (error) => error instanceof ArtDirectionPromptBuilderError && error.code === 'missing_storyboard_entry',
  );
});

test('art-direction prompt builder rejects invalid entries and missing referenced sheets', () => {
  const invalidPage = structuredClone(page4) as any;
  invalidPage.required_recurring_objects = [];
  assert.throws(
    () => buildArtDirectionPromptObject({
      styleBible: lukasDinoArtDirectionFixture.style_bible,
      characterSheets: lukasDinoArtDirectionFixture.character_sheets,
      storyboardEntry: invalidPage,
    }),
    (error) => error instanceof ArtDirectionPromptBuilderError && error.code === 'invalid_storyboard_entry',
  );

  const missingRef = structuredClone(page4);
  missingRef.refs.character_sheet_ids = ['char_lukas', 'char_missing'];
  assert.throws(
    () => buildArtDirectionPromptObject({
      styleBible: lukasDinoArtDirectionFixture.style_bible,
      characterSheets: lukasDinoArtDirectionFixture.character_sheets,
      storyboardEntry: missingRef,
    }),
    (error) => error instanceof ArtDirectionPromptBuilderError && error.code === 'missing_referenced_character_sheet',
  );
});
