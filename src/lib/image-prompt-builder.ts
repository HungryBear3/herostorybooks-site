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
];

const QUALITY_CONSTRAINTS = [
  'anatomically clean child illustration',
  'exactly two arms',
  'exactly two hands',
  'exactly two legs',
  'exactly two feet',
  'aligned eyes',
  'no extra limbs',
  'no floating props unless story-critical',
  'warm, age-appropriate children\u2019s book art style',
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
    'same hair, skin tone, and outfit unless the story calls for a change',
    'same illustration style and color palette',
  ].join(' — ');
}

function qualitySection(): string {
  return `Quality requirements: ${QUALITY_CONSTRAINTS.join('; ')}.`;
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
