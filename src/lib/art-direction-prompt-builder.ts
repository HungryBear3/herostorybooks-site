import {
  CharacterSheetSchema,
  StoryboardEntrySchema,
  StyleBibleSchema,
  type CharacterSheet,
  type StoryboardEntry,
  type StyleBible,
} from './art-direction-schemas.ts';

export type ArtDirectionPromptBuilderErrorCode =
  | 'missing_style_bible'
  | 'missing_character_sheets'
  | 'missing_storyboard_entry'
  | 'invalid_style_bible'
  | 'invalid_character_sheets'
  | 'invalid_storyboard_entry'
  | 'missing_referenced_character_sheet';

export class ArtDirectionPromptBuilderError extends Error {
  readonly code: ArtDirectionPromptBuilderErrorCode;

  constructor(code: ArtDirectionPromptBuilderErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ArtDirectionPromptBuilderError';
    this.code = code;
  }
}

export interface ArtDirectionCharacterAnchor {
  characterId: string;
  displayName: string;
  role: CharacterSheet['role'];
  anchorText: string;
  watercolorAnchorId: string;
  referencePhotoId: string;
}

export interface ArtDirectionPromptRefs {
  bookId: string;
  pageNumber: number;
  characterSheetIds: string[];
  characterWatercolorAnchorIds: string[];
  referencePhotoIds: string[];
  priorPageIds: string[];
  motifAssets: string[];
  paletteCard: string;
  brushReference: string;
  priorBookAnchors: string[];
}

export interface ArtDirectionPromptObject {
  positive: string;
  negative: string;
  refs: ArtDirectionPromptRefs;
  styleBible: string[];
  characterAnchors: ArtDirectionCharacterAnchor[];
  continuityCallback: string;
  transition: string;
  requiredRecurringObjects: string[];
  storyBeat: string;
  visualBeat: string;
  pageNotes: string[];
  negativeGuardrails: string[];
}

export interface BuildArtDirectionPromptInput {
  styleBible: StyleBible;
  characterSheets: CharacterSheet[];
  storyboardEntry: StoryboardEntry;
}

function compact(parts: Array<string | null | undefined>): string[] {
  return parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0);
}

function sentenceList(label: string, values: readonly string[]): string | null {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return `${label}: ${cleaned.join(', ')}.`;
}

function parseStyleBibleForPrompt(input: unknown): StyleBible {
  if (!input) throw new ArtDirectionPromptBuilderError('missing_style_bible');
  const result = StyleBibleSchema.safeParse(input);
  if (!result.success) {
    throw new ArtDirectionPromptBuilderError('invalid_style_bible', result.error.issues[0]?.message);
  }
  return result.data;
}

function parseCharacterSheetsForPrompt(input: unknown): CharacterSheet[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ArtDirectionPromptBuilderError('missing_character_sheets');
  }
  const parsed: CharacterSheet[] = [];
  for (const sheet of input) {
    const result = CharacterSheetSchema.safeParse(sheet);
    if (!result.success) {
      throw new ArtDirectionPromptBuilderError('invalid_character_sheets', result.error.issues[0]?.message);
    }
    parsed.push(result.data);
  }
  return parsed;
}

function parseStoryboardEntryForPrompt(input: unknown): StoryboardEntry {
  if (!input) throw new ArtDirectionPromptBuilderError('missing_storyboard_entry');
  const result = StoryboardEntrySchema.safeParse(input);
  if (!result.success) {
    throw new ArtDirectionPromptBuilderError('invalid_storyboard_entry', result.error.issues[0]?.message);
  }
  return result.data;
}

function buildStyleBibleLines(styleBible: StyleBible): string[] {
  return compact([
    `Style bible ${styleBible.template_id}: ${styleBible.target_illustration_style}, ${styleBible.rendering_level}.`,
    `Palette primary ${styleBible.palette.primary.join(', ')}; secondary ${styleBible.palette.secondary.join(', ')}; accent ${styleBible.palette.accent.join(', ')}.`,
    sentenceList('Avoid palette/style drift', styleBible.palette.avoid),
    `Lighting arc ${styleBible.lighting.time_of_day_arc}; source ${styleBible.lighting.source}; mood ${styleBible.lighting.mood}; shadows ${styleBible.lighting.shadow_treatment}.`,
    `Line ${styleBible.line.weight}, opacity ${styleBible.line.opacity}, presence ${styleBible.line.presence}.`,
    `Texture ${styleBible.texture.paper_grain}, brush visibility ${styleBible.texture.brush_visibility}, layering ${styleBible.texture.layering}.`,
    `Composition default camera ${styleBible.composition.default_camera_distance}; ${styleBible.composition.child_position_rule}.`,
    sentenceList('Continuity motifs', styleBible.continuity_motifs),
    `Typography zone ${styleBible.typography_zone.location}, ${styleBible.typography_zone.background_treatment}, ${styleBible.typography_zone.contrast_requirement}, ${styleBible.typography_zone.font_family}.`,
  ]);
}

function buildCharacterAnchor(sheet: CharacterSheet): ArtDirectionCharacterAnchor {
  const companion = sheet.companion_anchors
    ? compact([
      `Companion silhouette ${sheet.companion_anchors.species_silhouette}`,
      `scale ${sheet.companion_anchors.scale_relative_to_hero}`,
      `color ${sheet.companion_anchors.color_base}`,
      `pattern ${sheet.companion_anchors.pattern}`,
      `eyes ${sheet.companion_anchors.eye_treatment}`,
      `mouth ${sheet.companion_anchors.mouth_default}`,
      `role ${sheet.companion_anchors.emotional_role}`,
      sentenceList('recurring traits', sheet.companion_anchors.recurring_traits),
      sentenceList('forbidden companion visuals', sheet.companion_anchors.forbidden_visuals),
    ]).join('; ')
    : '';
  const family = sheet.family_anchors
    ? `Family anchor ${sheet.family_anchors.relationship_to_hero}; clothing ${sheet.family_anchors.recurring_clothing_signature}; palette link ${sheet.family_anchors.palette_link_to_hero}.`
    : '';
  const pet = sheet.pet_anchors
    ? `Pet anchor ${sheet.pet_anchors.species}; size ${sheet.pet_anchors.size_to_hero}; signature ${sheet.pet_anchors.recurring_signature}.`
    : '';

  const anchorText = compact([
    `${sheet.display_name} (${sheet.role}) must stay visually consistent.`,
    `Immutable: age ${sheet.immutable.age_visual}; face ${sheet.immutable.face_shape}; eyes ${sheet.immutable.eye_color} ${sheet.immutable.eye_shape}; hair ${sheet.immutable.hair_color}, ${sheet.immutable.hair_style_base}; skin ${sheet.immutable.skin_tone}; body ${sheet.immutable.body_proportions}.`,
    sentenceList('Defining features', sheet.immutable.defining_features),
    sentenceList('Outfit signature', sheet.flexible.outfit_signature),
    `Outfit palette lock: ${sheet.flexible.outfit_palette_lock}.`,
    sentenceList('Allowed expressions', sheet.flexible.expression_range),
    sentenceList('Allowed poses', sheet.flexible.pose_range),
    sentenceList('Temporary accessories', sheet.flexible.accessories_temporary),
    sentenceList('Never change', sheet.never_change),
    companion,
    family,
    pet,
  ]).join(' ');

  return {
    characterId: sheet.character_id,
    displayName: sheet.display_name,
    role: sheet.role,
    anchorText,
    watercolorAnchorId: sheet.watercolor_anchor_id,
    referencePhotoId: sheet.reference_photo_id,
  };
}

function buildContinuity(entry: StoryboardEntry): string {
  const callback = entry.continuity_callback.to_page === null
    ? 'opening page; establish motifs for later callbacks'
    : `echo page ${entry.continuity_callback.to_page} via ${entry.continuity_callback.via}`;
  return `Continuity callback: ${callback}.`;
}

function buildTransition(entry: StoryboardEntry): string {
  if (entry.transition_into_next === null) return 'Transition into next: final tag page; resolve gently.';
  return `Transition into next: ${entry.transition_into_next}.`;
}

function buildPageNotes(styleBible: StyleBible, entry: StoryboardEntry): string[] {
  return compact([
    `Spread position ${entry.spread_position}; camera ${entry.camera.distance}, ${entry.camera.angle} angle, ${entry.camera.motion}.`,
    `Setting ${entry.setting.location}; ${entry.setting.time_of_day}; ${entry.setting.weather}.`,
    sentenceList('Setting key objects', entry.setting.key_objects),
    `Action motion: ${entry.action_motion}.`,
    `Text safe zone: ${entry.text_safe_zone.side} ${entry.text_safe_zone.percent}% with ${entry.text_safe_zone.padding_inches}in padding.`,
    `Style safe zone: ${styleBible.composition.safe_zones.text_zone.side} ${styleBible.composition.safe_zones.text_zone.percent_of_page}% with ${styleBible.composition.safe_zones.text_zone.padding_inches}in padding; spine safety ${styleBible.composition.safe_zones.spine_safety_inches}in.`,
    `Page text context: ${entry.text_content}.`,
    `Image prompt notes: ${entry.image_prompt_notes}.`,
  ]);
}

function uniqueStable(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function buildArtDirectionPromptObject(input: BuildArtDirectionPromptInput): ArtDirectionPromptObject {
  const styleBible = parseStyleBibleForPrompt(input?.styleBible);
  const characterSheets = parseCharacterSheetsForPrompt(input?.characterSheets);
  const storyboardEntry = parseStoryboardEntryForPrompt(input?.storyboardEntry);

  const sheetsById = new Map(characterSheets.map((sheet) => [sheet.character_id, sheet]));
  const referencedCharacterIds = storyboardEntry.refs.character_sheet_ids;
  const referencedSheets = referencedCharacterIds.map((id) => {
    const sheet = sheetsById.get(id);
    if (!sheet) {
      throw new ArtDirectionPromptBuilderError('missing_referenced_character_sheet', id);
    }
    return sheet;
  });
  const characterAnchors = referencedSheets.map(buildCharacterAnchor);
  const styleBibleLines = buildStyleBibleLines(styleBible);
  const continuityCallback = buildContinuity(storyboardEntry);
  const transition = buildTransition(storyboardEntry);
  const pageNotes = buildPageNotes(styleBible, storyboardEntry);
  const negativeGuardrails = uniqueStable([
    ...styleBible.prohibited,
    ...storyboardEntry.negative_prompt,
    ...referencedSheets.flatMap((sheet) => sheet.companion_anchors?.forbidden_visuals ?? []),
    'no readable text',
    'no placeholder artifacts',
    'no empty schema artifacts',
  ]);

  const characterStaging = storyboardEntry.characters_present.map((character) =>
    `${character.character_id}: ${character.position}, ${character.action}, ${character.expression}, scale ${character.scale}.`);

  const positive = [
    'HSB art-direction prompt input. Follow exactly; do not invent a different page.',
    `Book ${styleBible.book_id}, page ${storyboardEntry.page_number}.`,
    `Story beat: ${storyboardEntry.story_beat}; emotional beat: ${storyboardEntry.emotional_beat}.`,
    `Visual beat: ${storyboardEntry.visual_beat}.`,
    'Style bible:',
    ...styleBibleLines.map((line) => `- ${line}`),
    'Character anchors:',
    ...characterAnchors.map((anchor) => `- ${anchor.anchorText}`),
    continuityCallback,
    transition,
    sentenceList('Required recurring objects on this page', storyboardEntry.required_recurring_objects),
    'Character staging:',
    ...characterStaging.map((line) => `- ${line}`),
    'Page and safe-zone notes:',
    ...pageNotes.map((line) => `- ${line}`),
  ].filter((value): value is string => Boolean(value && value.trim())).join('\n');

  const negative = [
    'Negative/style guardrails:',
    ...negativeGuardrails.map((guardrail) => `- ${guardrail}`),
  ].join('\n');

  return {
    positive,
    negative,
    refs: {
      bookId: styleBible.book_id,
      pageNumber: storyboardEntry.page_number,
      characterSheetIds: [...referencedCharacterIds],
      characterWatercolorAnchorIds: characterAnchors.map((anchor) => anchor.watercolorAnchorId),
      referencePhotoIds: characterAnchors.map((anchor) => anchor.referencePhotoId),
      priorPageIds: [...storyboardEntry.refs.prior_page_ids],
      motifAssets: [...storyboardEntry.refs.motif_assets],
      paletteCard: styleBible.ref_images.palette_card,
      brushReference: styleBible.ref_images.brush_reference,
      priorBookAnchors: [...styleBible.ref_images.prior_book_anchors],
    },
    styleBible: styleBibleLines,
    characterAnchors,
    continuityCallback,
    transition,
    requiredRecurringObjects: [...storyboardEntry.required_recurring_objects],
    storyBeat: storyboardEntry.story_beat,
    visualBeat: storyboardEntry.visual_beat,
    pageNotes,
    negativeGuardrails,
  };
}
