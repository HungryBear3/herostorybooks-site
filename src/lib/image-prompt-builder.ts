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
   * Where the page caption will sit on top of this illustration. When
   * present we ask the generator to keep that zone visually quiet so the
   * translucent caption panel doesn't have to fight a face, prop, or
   * busy texture for legibility. The renderer uses the same layout to
   * place the panel — this is how we keep image and typography in sync.
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

function childIdentitySection(order: PagePromptInput['order']): string {
  const lines: string[] = [];
  lines.push(`Hero: ${order.childName.trim()}${order.childAge ? `, age ${order.childAge}` : ''}.`);
  if (order.appearanceOptions && order.appearanceOptions.trim()) {
    lines.push(`Appearance: ${order.appearanceOptions.trim()}.`);
  }
  if (order.characterNotes && order.characterNotes.trim()) {
    lines.push(`Character notes: ${order.characterNotes.trim()}.`);
  }
  if (order.photoBlobPath) {
    lines.push('Reference photo of the child is provided; preserve facial likeness across pages.');
  }
  return lines.join(' ');
}

function continuitySection(order: PagePromptInput['order']): string {
  return [
    'Maintain visual continuity with prior pages of the same book:',
    `same child (${order.childName.trim()})`,
    'same apparent age, same haircut, same hair length, same skin tone, and same outfit unless the story explicitly calls for a change',
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
        'No opaque face mask, no helmet blocking the face, no logo costume treatment.',
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

function safeTextAreaSection(layout: PageTextLayout | undefined): string {
  if (!layout) return '';
  const zoneCopy = ZONE_DESCRIPTIONS[layout.zone];
  return [
    `Composition note for caption legibility: leave ${zoneCopy} visually quiet — keep faces, hands, and other key story details OUT of that zone, and use low-contrast background tones (sky, foliage, water, soft floor, distant terrain) so a translucent caption panel can sit there without hiding important art.`,
    'Do not render any text, lettering, signs, captions, or word-shaped marks anywhere in the image. The book layout adds the caption itself.',
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
