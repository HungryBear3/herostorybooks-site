import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const timestampString = nonEmptyString;
const percent0To30 = z.number().min(0).max(30);
const paddingInches = z.number().min(0.3).max(0.75);

export const ArtDirectionStoryBeatSchema = z.enum([
  'setup',
  'inciting',
  'rising',
  'midpoint',
  'climax',
  'resolution',
  'tag',
]);

export const StyleBibleSchema = z.object({
  book_id: nonEmptyString,
  child_id: nonEmptyString,
  template_id: nonEmptyString,
  target_illustration_style: z.enum(['watercolor_classic', 'watercolor_modern', 'gouache_storybook', 'ink_and_watercolor']),
  rendering_level: z.enum(['1_flat_storybook', '2_soft_painterly', '3_richly_illustrated']),
  palette: z.object({
    primary: z.array(nonEmptyString).length(3),
    secondary: z.array(nonEmptyString).length(2),
    accent: z.array(nonEmptyString).length(1),
    avoid: z.array(nonEmptyString).min(1),
  }),
  lighting: z.object({
    time_of_day_arc: z.enum(['morning_to_golden_to_bedtime', 'midday_constant', 'golden_to_bedtime', 'dawn_to_full_day']),
    source: z.enum(['natural_warm', 'natural_cool', 'indoor_warm', 'magical_glow']),
    mood: z.enum(['gentle', 'playful', 'tender', 'adventurous']),
    shadow_treatment: z.enum(['soft_painted_no_hard_edges', 'minimal_shadow', 'painted_shadows_with_brushwork']),
  }),
  line: z.object({
    weight: z.enum(['none', 'hairline', 'medium', 'bold']),
    opacity: z.number().min(0).max(1),
    presence: z.enum(['invisible', 'visible_but_not_inked', 'inked']),
  }),
  texture: z.object({
    paper_grain: z.enum(['smooth', 'cold_press_watercolor', 'hot_press_watercolor', 'linen_canvas']),
    brush_visibility: z.enum(['low', 'medium', 'high']),
    layering: z.enum(['1_wash', '2_3_washes_visible', 'rich_multi_wash']),
  }),
  composition: z.object({
    default_camera_distance: z.enum(['ECU', 'CU', 'MCU', 'MS', 'MWS', 'WS', 'EWS']),
    child_position_rule: nonEmptyString,
    safe_zones: z.object({
      text_zone: z.object({
        side: z.enum(['bottom', 'top', 'left', 'right']),
        percent_of_page: percent0To30,
        padding_inches: paddingInches,
      }),
      spine_safety_inches: z.number().min(0),
    }),
  }),
  prohibited: z.array(nonEmptyString).min(1),
  typography_zone: z.object({
    location: z.enum(['bottom_card', 'top_card', 'full_overlay']),
    background_treatment: z.enum(['painted_card', 'watercolor_wash', 'transparent']),
    contrast_requirement: z.enum(['dark_text_on_light_card', 'light_text_on_dark_card']),
    font_family: nonEmptyString,
    min_padding_inches: z.number().min(0),
  }),
  continuity_motifs: z.array(nonEmptyString).min(3).max(5),
  ref_images: z.object({
    palette_card: nonEmptyString,
    brush_reference: nonEmptyString,
    prior_book_anchors: z.array(nonEmptyString),
  }),
  drift_tolerance: z.object({
    style_embedding_max_distance: z.number().min(0),
    palette_max_off_palette_percent: z.number().min(0).max(100),
  }),
  versioning: z.object({
    version: z.number().int().min(1),
    approved_by: nonEmptyString,
    approved_at: timestampString,
  }),
});

export const CharacterSheetSchema = z.object({
  character_id: nonEmptyString,
  book_id: nonEmptyString,
  role: z.enum(['hero', 'companion', 'family', 'pet', 'extra']),
  display_name: nonEmptyString,
  immutable: z.object({
    age_visual: z.number().int().min(0),
    face_shape: z.enum(['round', 'oval', 'long', 'heart']),
    eye_color: nonEmptyString,
    eye_shape: z.enum(['large_almond', 'round', 'narrow', 'upturned']),
    hair_color: nonEmptyString,
    hair_style_base: nonEmptyString,
    skin_tone: nonEmptyString,
    body_proportions: nonEmptyString,
    defining_features: z.array(nonEmptyString),
  }),
  flexible: z.object({
    outfit_palette_lock: nonEmptyString,
    outfit_signature: z.array(nonEmptyString).min(1),
    expression_range: z.array(nonEmptyString).min(1),
    pose_range: z.array(nonEmptyString).min(1),
    accessories_temporary: z.array(nonEmptyString),
  }),
  never_change: z.array(nonEmptyString).min(1),
  reference_photo_id: nonEmptyString,
  watercolor_anchor_id: nonEmptyString,
  photo_retention_policy: z.enum(['delete_at_proof_approval', 'delete_at_day_30']),
  companion_anchors: z.object({
    species_silhouette: nonEmptyString,
    scale_relative_to_hero: nonEmptyString,
    color_base: nonEmptyString,
    pattern: nonEmptyString,
    eye_treatment: nonEmptyString,
    mouth_default: nonEmptyString,
    emotional_role: z.enum(['playmate', 'protector', 'guide', 'sidekick']),
    recurring_traits: z.array(nonEmptyString).min(1),
    forbidden_visuals: z.array(nonEmptyString).min(1),
  }).optional(),
  family_anchors: z.object({
    relationship_to_hero: z.enum(['parent', 'sibling', 'grandparent', 'aunt_uncle', 'cousin', 'friend']),
    recurring_clothing_signature: nonEmptyString,
    palette_link_to_hero: z.enum(['tight', 'loose', 'independent']),
  }).optional(),
  pet_anchors: z.object({
    species: nonEmptyString,
    size_to_hero: nonEmptyString,
    recurring_signature: nonEmptyString,
  }).optional(),
  versioning: z.object({
    version: z.number().int().min(1),
    approved_by: nonEmptyString,
    approved_at: timestampString,
  }),
}).superRefine((sheet, ctx) => {
  if (sheet.role === 'companion' && !sheet.companion_anchors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['companion_anchors'], message: 'companion sheets require companion_anchors' });
  }
  if (sheet.role === 'family' && !sheet.family_anchors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['family_anchors'], message: 'family sheets require family_anchors' });
  }
  if (sheet.role === 'pet' && !sheet.pet_anchors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pet_anchors'], message: 'pet sheets require pet_anchors' });
  }
});

export const StoryboardEntrySchema = z.object({
  page_number: z.number().int().min(1).max(24),
  spread_position: z.enum(['single', 'left', 'right']),
  story_beat: ArtDirectionStoryBeatSchema,
  emotional_beat: z.enum(['curious', 'excited', 'nervous', 'brave', 'tender', 'triumphant', 'sleepy', 'surprised_friendly', 'playful']),
  visual_beat: nonEmptyString,
  setting: z.object({
    location: nonEmptyString,
    time_of_day: nonEmptyString,
    weather: nonEmptyString,
    key_objects: z.array(nonEmptyString).min(1),
  }),
  characters_present: z.array(z.object({
    character_id: nonEmptyString,
    position: nonEmptyString,
    action: nonEmptyString,
    expression: nonEmptyString,
    scale: nonEmptyString,
  })).min(1),
  camera: z.object({
    distance: z.enum(['ECU', 'CU', 'MCU', 'MS', 'MWS', 'WS', 'EWS']),
    angle: z.enum(['eye', 'low_child_eye', 'high', 'dutch']),
    motion: z.enum(['still', 'forward_implied', 'side_pan_implied']),
  }),
  action_motion: nonEmptyString,
  continuity_callback: z.object({
    to_page: z.number().int().min(1).max(24).nullable(),
    via: z.enum(['recurring_motif', 'prior_object', 'matched_pose', 'location_continuity', 'palette_link']),
  }),
  transition_into_next: z.enum(['match_cut', 'scale_change', 'location_shift', 'time_jump', 'match_action', 'shared_gesture']).nullable(),
  required_recurring_objects: z.array(nonEmptyString).min(1),
  text_safe_zone: z.object({
    side: z.enum(['bottom', 'top', 'left', 'right']),
    percent: percent0To30,
    padding_inches: z.number().min(0),
  }),
  text_content: nonEmptyString,
  image_prompt_notes: nonEmptyString,
  negative_prompt: z.array(nonEmptyString),
  refs: z.object({
    character_sheet_ids: z.array(nonEmptyString).min(1),
    prior_page_ids: z.array(nonEmptyString),
    motif_assets: z.array(nonEmptyString),
  }),
}).superRefine((entry, ctx) => {
  if (entry.page_number === 1 && entry.continuity_callback.to_page !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['continuity_callback', 'to_page'], message: 'page 1 continuity_callback.to_page must be null' });
  }
  if (entry.page_number > 1 && entry.continuity_callback.to_page === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['continuity_callback', 'to_page'], message: 'pages after page 1 require a continuity callback' });
  }
  if (entry.page_number < 24 && entry.transition_into_next === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transition_into_next'], message: 'pages before page 24 require transition_into_next' });
  }
  if (entry.page_number === 24 && entry.story_beat !== 'tag') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['story_beat'], message: 'page 24 must use tag story_beat' });
  }
});

export const StoryboardSchema = z.object({
  book_id: nonEmptyString,
  entries: z.array(StoryboardEntrySchema).length(24),
}).superRefine((storyboard, ctx) => {
  const pageNumbers = storyboard.entries.map((entry) => entry.page_number);
  const uniquePages = new Set(pageNumbers);
  for (let page = 1; page <= 24; page += 1) {
    if (!uniquePages.has(page)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries'], message: `missing storyboard page ${page}` });
    }
  }
  if (uniquePages.size !== pageNumbers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries'], message: 'storyboard page numbers must be unique' });
  }
  for (const beat of ArtDirectionStoryBeatSchema.options) {
    if (!storyboard.entries.some((entry) => entry.story_beat === beat)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries'], message: `storyboard missing story_beat ${beat}` });
    }
  }
});

export const ArtDirectionPacketSchema = z.object({
  style_bible: StyleBibleSchema,
  character_sheets: z.array(CharacterSheetSchema).min(1),
  storyboard: StoryboardSchema,
});

export type StyleBible = z.infer<typeof StyleBibleSchema>;
export type ArtDirectionStoryBeat = z.infer<typeof ArtDirectionStoryBeatSchema>;
export type CharacterSheet = z.infer<typeof CharacterSheetSchema>;
export type StoryboardEntry = z.infer<typeof StoryboardEntrySchema>;
export type Storyboard = z.infer<typeof StoryboardSchema>;
export type ArtDirectionPacket = z.infer<typeof ArtDirectionPacketSchema>;

export function parseStyleBible(input: unknown): StyleBible {
  return StyleBibleSchema.parse(input);
}

export function parseCharacterSheet(input: unknown): CharacterSheet {
  return CharacterSheetSchema.parse(input);
}

export function parseStoryboard(input: unknown): Storyboard {
  return StoryboardSchema.parse(input);
}

export function parseArtDirectionPacket(input: unknown): ArtDirectionPacket {
  return ArtDirectionPacketSchema.parse(input);
}
