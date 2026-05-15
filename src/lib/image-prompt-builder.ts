// Prompt builder for HSB page images.
//
// Two surfaces:
//   1. buildPagePrompt() — initial generation prompt (used by fulfillment)
//   2. buildRegeneratePrompt() — composes (a) the original page beat,
//      (b) child identity grounding, (c) lightweight feedback tags, (d) the
//      raw customer feedback delta, (e) quality constraints.
//
// Tags are derived from raw feedback by simple keyword detection so the prompt
// includes structured emphasis ("hands: anatomically correct, exactly two
// hands") rather than just appending raw user text.

import type { OrderRecord } from './orders.ts';
import type { PageTextLayout } from './fulfillment-types.ts';

export const FEEDBACK_TAGS = [
  'hands',
  'eyes',
  'face_similarity',
  'lighting',
  'background',
  'expression',
  'pose',
  'outfit',
  'color',
  'style_consistency',
] as const;
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number];

const TAG_PATTERNS: Array<{ tag: FeedbackTag; pattern: RegExp }> = [
  { tag: 'hands', pattern: /\b(hand|hands|finger|fingers|grip|holding)\b/i },
  { tag: 'eyes', pattern: /\b(eye|eyes|gaze|pupil|iris|lash)\b/i },
  { tag: 'face_similarity', pattern: /\b(face|look like|resemble|similar|likeness|match the photo|like the photo)\b/i },
  { tag: 'lighting', pattern: /\b(light|lighting|brighten|darker|sunlit|shadow|glow)\b/i },
  { tag: 'background', pattern: /\b(background|backdrop|scene|environment|setting|room|sky|garden|forest)\b/i },
  { tag: 'expression', pattern: /\b(smile|smiling|happier|happy|sad|angry|surprised|laughing|frown|expression)\b/i },
  { tag: 'pose', pattern: /\b(pose|stance|standing|sitting|jumping|running|posture|arms up)\b/i },
  { tag: 'outfit', pattern: /\b(outfit|clothes|clothing|shirt|dress|hoodie|jacket|hat|shoes|sock|costume)\b/i },
  { tag: 'color', pattern: /\b(color|colour|red|blue|green|yellow|pink|purple|brown|black|white|orange)\b/i },
  { tag: 'style_consistency', pattern: /\b(style|stylistic|painterly|painted|rendering|match the other pages|same style|consistent)\b/i },
];

const QUALITY_CONSTRAINTS = [
  'anatomically clean child illustration',
  'exactly two arms',
  'exactly two hands',
  'exactly two legs',
  'exactly two feet',
  'aligned eyes',
  'face fully visible in front-facing or three-quarter view',
  'both eyes visible unless the scene is physically impossible otherwise',
  'head turned toward the camera even when the body is in motion',
  'face not obscured by hands, hair, hat brim, water, mist, shadow, props, or posture',
  'child is fully clothed and age-appropriate at all times',
  'no nude-looking, shirtless, or bare-skin-only costume reads',
  'no extra limbs',
  'no floating props unless story-critical',
  'warm, painterly, age-appropriate children\u2019s book art style',
  'style consistency must match the other pages of the same book, including indoor or nighttime scenes',
];

export function deriveFeedbackTags(rawFeedback: string): FeedbackTag[] {
  if (!rawFeedback) return [];
  const seen = new Set<FeedbackTag>();
  for (const { tag, pattern } of TAG_PATTERNS) {
    if (pattern.test(rawFeedback)) seen.add(tag);
  }
  return Array.from(seen);
}

function sanitizeFeedback(raw: string, maxLen = 500): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export interface PagePromptInput {
  /** The story beat for this page (from the generated story). */
  basePrompt: string;
  /** Optional caller-supplied story text (for context only — basePrompt drives the image). */
  storyText?: string;
  order: Pick<
    OrderRecord,
    | 'childName'
    | 'childAge'
    | 'characterNotes'
    | 'appearanceOptions'
    | 'photoBlobPath'
    | 'theme'
    | 'childPronouns'
  >;
  /**
   * Frozen story-level character description. When present, prepended to
   * every page prompt VERBATIM as the leading section so the same child stays
   * visually consistent across all pages of the same story (and across
   * regenerates of any single page). Set once at fulfillment time from
   * StoryContent.characterDescription; never re-derived per page.
   */
  characterAnchor?: string | null;
  /** Customer feedback for a regenerate. Empty/undefined for initial generation. */
  feedback?: string;
  /**
   * Where the page caption/margin will sit relative to this illustration.
   * Current production PDFs place prose in a separate cream margin below
   * the art; this hint keeps important details away from the crop edge and
   * remains useful for legacy/regenerated layouts that still carry per-page
   * text-layout metadata.
   */
  textLayout?: PageTextLayout;
}

/**
 * Frozen anchor section. This must be the FIRST thing the model sees so the
 * canonical child description sets the identity before any per-page beat or
 * customer-feedback delta has a chance to perturb it.
 */
function characterAnchorSection(anchor: string | null | undefined): string {
  const trimmed = (anchor ?? '').trim();
  if (!trimmed) return '';
  return [
    'CHARACTER (must remain identical across all pages of this story; do not reinterpret):',
    trimmed,
  ].join('\n');
}

function parseAppearanceOptions(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([key, value]) => [key, String(value).trim()]),
    );
  } catch {
    return { raw: raw.trim() };
  }
}

function describeLockedAppearance(order: PagePromptInput['order']): string[] {
  const options = parseAppearanceOptions(order.appearanceOptions);
  const lines: string[] = [];
  const pronouns = (order.childPronouns ?? '').toLowerCase();
  if (pronouns.includes('he/him')) {
    lines.push('Gender presentation lock: Lukas is a young boy; do not feminize him, do not give him long hair, a bob, pigtails, hair ribbons, makeup, dresses, or feminine-coded styling.');
  }
  if (options.skinTone) lines.push(`Skin tone: ${options.skinTone}.`);
  if (options.hairStyle === 'straight-dark') {
    lines.push('Hair lock: short straight dark boy haircut, hair above the ears/neck, neat and childlike; never shoulder-length or long.');
  } else if (options.hairStyle) {
    lines.push(`Hair lock: ${options.hairStyle}; keep the same hair length and style on every page.`);
  }
  if (options.eyewear) lines.push(`Eyewear: ${options.eyewear}.`);
  if (options.raw) lines.push(`Appearance: ${options.raw}.`);
  return lines;
}

function childIdentitySection(order: PagePromptInput['order']): string {
  const lines: string[] = [];
  lines.push(`Hero: ${order.childName.trim()}${order.childAge ? `, age ${order.childAge}` : ''}.`);
  lines.push(...describeLockedAppearance(order));
  if (order.characterNotes && order.characterNotes.trim()) {
    lines.push(`Character notes: ${order.characterNotes.trim()}.`);
  }
  if (order.photoBlobPath) {
    lines.push('Reference photo of the child is provided; preserve facial likeness, age, haircut, and boyish presentation across every page.');
  }
  return lines.join(' ');
}

function continuitySection(order: PagePromptInput['order']): string {
  return [
    'Maintain visual continuity with prior pages of the same book:',
    `same child (${order.childName.trim()})`,
    'same apparent age, same short dark haircut, same hair length, same skin tone, and same outfit unless the story explicitly calls for a change',
    'never change the child into a girl, never add long hair, never add feminine hair accessories, never soften the face into a different child',
    'no masks, no face-obscuring accessories, no logo costume treatment unless the story explicitly requires it',
    'same illustration style, same painterly rendering language, and same color palette',
    'the style does not change for indoor, nighttime, cave, or moonlit scenes',
  ].join(' — ');
}

function sceneGroundingSection(storyText?: string): string {
  const trimmed = (storyText ?? '').trim();
  if (!trimmed) {
    return 'Illustrate the specific story beat in the base prompt. Do not invent a different scene, different costume, or unrelated action.';
  }
  return [
    'Match the specific story beat on this page. Do not invent a different scene, different costume, or unrelated action.',
    `Scene grounding from the page text: ${trimmed}`,
  ].join(' ');
}

function themeGuidanceSection(order: PagePromptInput['order']): string {
  switch (order.theme) {
    case 'brave-explorer':
      return [
        'Theme outfit lock: tan explorer shirt, khaki shorts, explorer hat, small backpack, sturdy boots.',
        'No capes. No masks. No superhero styling. No logo costume treatment.',
        'Do not show a branded book, logo book, or random glowing storybook unless the page text explicitly mentions a book.',
      ].join(' ');
    case 'space-voyager':
      return [
        'Theme outfit lock: child-safe explorer/astronaut clothing that keeps the face visible.',
        'No opaque face mask, no helmet blocking the face, no floating helmet, no duplicated head, no cutaway helmet, no glass glare hiding the face, no logo costume treatment.',
        'Do not show a branded book, logo book, or random glowing storybook unless the page text explicitly mentions a book.',
      ].join(' ');
    default:
      return 'Do not show a branded book, logo book, or random glowing storybook unless the page text explicitly mentions a book.';
  }
}

function qualitySection(): string {
  return `Quality requirements: ${QUALITY_CONSTRAINTS.join('; ')}.`;
}

const ZONE_DESCRIPTIONS: Record<PageTextLayout['zone'], string> = {
  top_left: 'the upper-left quarter of the frame',
  top_right: 'the upper-right quarter of the frame',
  bottom_left: 'the lower-left quarter of the frame',
  bottom_right: 'the lower-right quarter of the frame',
  bottom_band: 'a horizontal strip across the bottom ~22% of the frame',
  top_band: 'a horizontal strip across the top ~22% of the frame',
  natural: 'the lower portion of the frame',
};

/**
 * Baseline composition discipline that EVERY page image must follow,
 * regardless of whether the story planner attached a specific
 * `textLayout` zone hint. Pulled out as its own always-on section after
 * the 2026-05-15 Gemini preview proof test, where p16 and p19 failed
 * text-safe / natural-negative-space checks because the page had no
 * `textLayout` and `safeTextAreaSection` therefore emitted nothing.
 *
 * Phrasing rules picked from Rex's benchmark feedback:
 *   - prefer "natural negative space" over abrupt blank bars (p01 note)
 *   - protect a clean text-safe area for the layout's prose box
 *   - explicitly forbid pseudo-text, glyphs, signage, labels, and
 *     readable-looking lettering of any kind (p19 note)
 *   - avoid splash-page busy compositions when the page must carry text
 *     (p16 note)
 */
function compositionDisciplineSection(): string {
  return [
    'Page composition rules (this is a children’s picture book; the final layout overlays prose in a clean cream margin around the illustration):',
    '- Preserve a clear, protected text-safe area that the book layout can use without covering faces or paid-for story details.',
    '- Achieve the protected area through natural negative space — soft sky, calm water, open ground, gentle fog, quiet foliage — NOT through a hard blank bar, a hard rectangle, a vignette mask, or an abrupt color block.',
    '- Let the focal subject sit naturally off-center when the page needs room for text; do not paint an over-centered, edge-to-edge splash composition that fights the prose box.',
    '- Maintain a warm watercolor storybook style with painterly brushwork and soft edges. Style consistency must hold across every page of the same book, including indoor or nighttime scenes.',
    '- Render zero readable lettering anywhere in the image: no captions, no titles, no signage, no shop signs, no labels, no maps with readable text, no banners, no scrolls with writing, no chalkboards, no books showing words, no symbols arranged to look like writing, no pseudo-text glyphs, no decorative scribbles that read as letters. The book layout adds the caption itself.',
  ].join('\n');
}

function safeTextAreaSection(layout: PageTextLayout | undefined): string {
  if (!layout) return '';
  const zoneCopy = ZONE_DESCRIPTIONS[layout.zone];
  return [
    `Layout hint for this specific page: prose will be placed in a clean cream margin below the illustration, with extra protection over ${zoneCopy} and the extreme bottom crop edge.`,
    `Keep faces, hands, and key paid-for story details away from ${zoneCopy}; quiet the brushwork there so the image can crop cleanly without losing important art.`,
    'Reminder: no readable text, lettering, signs, captions, glyphs, signage, labels, or word-shaped marks anywhere in the image.',
  ].join(' ');
}

function tagEmphasisSection(tags: FeedbackTag[]): string {
  if (tags.length === 0) return '';
  const focus = tags.map((t) => {
    switch (t) {
      case 'hands':
        return 'hands: anatomically correct, exactly two hands, five fingers each, no extra digits';
      case 'eyes':
        return 'eyes: aligned, symmetric, both eyes visible and same color';
      case 'face_similarity':
        return 'face: closer match to the supplied reference photo of the child';
      case 'lighting':
        return 'lighting: rebalance per the customer feedback';
      case 'background':
        return 'background: revise per the customer feedback while keeping focus on the child';
      case 'expression':
        return 'expression: adjust facial expression per the customer feedback';
      case 'pose':
        return 'pose: change the child\u2019s pose per the customer feedback';
      case 'outfit':
        return 'outfit: adjust clothing per the customer feedback';
      case 'color':
        return 'color: adjust palette per the customer feedback';
      case 'style_consistency':
        return 'style: match the same warm painterly rendering, brush texture, character design language, and palette as the strongest existing pages in the book';
    }
  });
  return `Customer-flagged focus areas: ${focus.join('; ')}.`;
}

export function buildPagePrompt(input: PagePromptInput): string {
  return [
    characterAnchorSection(input.characterAnchor),
    input.basePrompt.trim(),
    childIdentitySection(input.order),
    continuitySection(input.order),
    themeGuidanceSection(input.order),
    sceneGroundingSection(input.storyText),
    compositionDisciplineSection(),
    safeTextAreaSection(input.textLayout),
    qualitySection(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface RegeneratePromptResult {
  prompt: string;
  tags: FeedbackTag[];
  sanitizedFeedback: string;
}

export function buildRegeneratePrompt(input: PagePromptInput): RegeneratePromptResult {
  const sanitizedFeedback = sanitizeFeedback(input.feedback ?? '');
  const tags = deriveFeedbackTags(sanitizedFeedback);
  const sections: string[] = [
    characterAnchorSection(input.characterAnchor),
    input.basePrompt.trim(),
    childIdentitySection(input.order),
    continuitySection(input.order),
    themeGuidanceSection(input.order),
    sceneGroundingSection(input.storyText),
    compositionDisciplineSection(),
    safeTextAreaSection(input.textLayout),
  ];
  const tagSection = tagEmphasisSection(tags);
  if (tagSection) sections.push(tagSection);
  if (sanitizedFeedback) {
    sections.push(`Customer feedback (verbatim, treat as a delta from the previous version): "${sanitizedFeedback}"`);
  }
  sections.push(qualitySection());
  return {
    prompt: sections.filter(Boolean).join('\n\n'),
    tags,
    sanitizedFeedback,
  };
}
