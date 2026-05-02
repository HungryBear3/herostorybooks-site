import type { OrderRecord } from './orders.ts';
import { getStoryPageCount } from './orders.ts';
import type { StoryContent, StoryMeta, StoryPage } from './fulfillment-types.ts';
import { STORY_THEMES } from './story-catalog.ts';
import { SAMPLE_ADVENTURES } from './sample-adventures.ts';

export type { StoryMeta };

/** Structured result returned by generateStoryWithMeta. */
export interface StoryWithMeta {
  story: StoryContent;
  meta: StoryMeta;
}

// ── Template fallback ──────────────────────────────────────────────────────────

interface TemplateVariantProfile {
  titleSuffix: string;
  dedicationTemplate: string;
  characterTemplate: string;
  /** Per-page flavor strings appended to the base sample-adventure scene
   *  text. Slice 1 of the print redesign relaxed this from a fixed
   *  5-element tuple to a variable-length array so long-form print
   *  books (24 / 32 pages) can scale without TypeScript fighting us.
   *  Callers cycle through these by `pageIndex % pageAdditions.length`,
   *  combined with the variant's stable index + sample-adventure scene
   *  so each page still feels meaningfully distinct. */
  pageAdditions: string[];
}

const TEMPLATE_VARIANTS: TemplateVariantProfile[] = [
  {
    titleSuffix: 'Adventure',
    dedicationTemplate: 'For {{childName}} — may every brave step lead to a wonderful story.',
    characterTemplate: 'A bright-eyed child named {{childName}}{{ageClause}} with a curious spirit, a warm smile, and a confident, ready-for-anything presence. {{notes}}',
    pageAdditions: [
      'The adventure felt new and exciting from the very first step.',
      'Every clue made the world feel bigger and more magical.',
      'A moment of courage helped the day keep moving forward.',
      'With calm focus, the biggest challenge started to make sense.',
      'By the end, the journey felt like a memory worth keeping forever.',
    ],
  },
  {
    titleSuffix: 'Quest',
    dedicationTemplate: 'For {{childName}} — your imagination turns every day into a quest worth sharing.',
    characterTemplate: 'A thoughtful child named {{childName}}{{ageClause}} with kind eyes, steady confidence, and a playful imagination that lights up every scene. {{notes}}',
    pageAdditions: [
      'Right away, {{childName}} felt ready to see what wonder was waiting.',
      'The path ahead shimmered with possibility.',
      'Even the tricky part felt easier with a brave heart.',
      'That was when the adventure opened up in its biggest way.',
      'The trip home glowed with pride, joy, and a story to tell again later.',
    ],
  },
  {
    titleSuffix: 'Journey',
    dedicationTemplate: 'For {{childName}} — may your kindness guide every journey you take.',
    characterTemplate: 'A brave child named {{childName}}{{ageClause}} with an expressive face, a gentle grin, and the kind of calm determination that helps everyone feel safe. {{notes}}',
    pageAdditions: [
      '{{childName}} could feel this would be a day to remember.',
      'Each new sight made the journey feel richer and more alive.',
      'With patience and bravery, the challenge became part of the fun.',
      'The biggest moment arrived with a rush of excitement and pride.',
      'Looking back, {{childName}} knew the whole journey had changed them for the better.',
    ],
  },
  {
    titleSuffix: 'Story',
    dedicationTemplate: 'For {{childName}} — this story is a reminder that courage can look gentle and strong at the same time.',
    characterTemplate: 'A cheerful child named {{childName}}{{ageClause}} with a lively expression, a confident stance, and a spark of wonder that stands out in every adventure scene. {{notes}}',
    pageAdditions: [
      'From the beginning, the day felt touched by storybook magic.',
      'The next discovery made {{childName}} even more eager to continue.',
      'Bravery and heart worked together at exactly the right moment.',
      'Soon, the adventure reached a turning point that felt truly unforgettable.',
      'When it was over, the whole story seemed to shine a little brighter.',
    ],
  },
  {
    titleSuffix: 'Expedition',
    dedicationTemplate: 'For {{childName}} — may you keep finding joy in every discovery ahead.',
    characterTemplate: 'An adventurous child named {{childName}}{{ageClause}} with an open, friendly expression, steady courage, and an energetic spirit that fits every grand scene. {{notes}}',
    pageAdditions: [
      '{{childName}} stepped forward with excitement and a sense of purpose.',
      'It was the kind of moment that makes an adventure feel completely real.',
      'A brave choice helped the story move toward something special.',
      'Everything came together in a bright, exciting rush.',
      'Afterward, the memory of the expedition stayed warm and clear.',
    ],
  },
];

function sanitizeInput(value: string | undefined | null, maxLen: number): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function stableIndex(input: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function personalizeTemplate(template: string, order: OrderRecord): string {
  const childName = sanitizeInput(order.childName, 60) || 'Your Child';
  const age = sanitizeInput(order.childAge, 10);
  const notes = sanitizeInput(order.characterNotes, 200);
  return template
    .replaceAll('{{childName}}', childName)
    .replaceAll('{{ageClause}}', age ? `, age ${age}` : '')
    .replaceAll('{{notes}}', notes || '');
}

function chooseTemplateVariant(order: OrderRecord): TemplateVariantProfile {
  const key = [order.theme, order.childName, order.id, order.occasion, order.giftMessage]
    .map((value) => sanitizeInput(value, 120))
    .join('|');
  return TEMPLATE_VARIANTS[stableIndex(key, TEMPLATE_VARIANTS.length)]!;
}

function buildTemplateFallback(order: OrderRecord): StoryContent {
  return buildTemplateFallbackWithVariant(order).story;
}

function isOpenAiStoryEnabled(): boolean {
  return process.env.HSB_ENABLE_OPENAI_STORY === 'true';
}

/**
 * Internal — returns the rendered story AND the chosen variant so callers
 * (notably generateStoryWithMeta) can persist a meaningful model identifier
 * like 'template:Adventure' instead of an opaque 'template'.
 */
function buildTemplateFallbackWithVariant(
  order: OrderRecord,
): { story: StoryContent; variant: TemplateVariantProfile } {
  const theme = STORY_THEMES.find(t => t.id === order.theme);
  const sample = SAMPLE_ADVENTURES.find((a) => a.name.toLowerCase().includes(order.theme?.split('-')[0] ?? ''))
    ?? SAMPLE_ADVENTURES[0];
  const variant = chooseTemplateVariant(order);

  const childName = sanitizeInput(order.childName, 60) || 'Your Child';
  // Produce exactly N pages where N = getStoryPageCount(format).
  // Long-form formats cycle through the sample-adventure scenes and the
  // variant pageAdditions, with a stable pass index so adjacent cycles
  // aren't bit-identical.
  const targetPageCount = getStoryPageCount(order.bookFormat);
  const sourceCount = sample.pages.length;
  const pages: StoryPage[] = Array.from({ length: targetPageCount }, (_, i) => {
    const source = sample.pages[i % sourceCount];
    const passIndex = Math.floor(i / sourceCount); // 0 for the first cycle, 1 for the next, etc.
    const baseStory = source.story.replace(/\b(Marcus|Zara|Lily|Sam|Ava|Mia)\b/g, childName);
    const addition = variant.pageAdditions[i % variant.pageAdditions.length] ?? '';
    const passSuffix = passIndex === 0 ? '' : ` The story continued, deeper now, with new details ${childName} hadn't noticed before.`;
    return {
      pageNum: i + 1,
      sceneTitle: source.sceneTitle ?? source.subtitle ?? `Chapter ${i + 1}`,
      story: `${baseStory} ${personalizeTemplate(addition, order)}${passSuffix}`.trim(),
      imagePrompt: `A children's book illustration of ${childName}, ${theme?.description ?? 'on a grand adventure'}. ${source.subtitle ?? ''}. Warm, colorful, age-appropriate art style.`,
    };
  });

  return {
    story: {
      title: `${childName}'s ${theme?.name ?? 'Great'} ${variant.titleSuffix}`,
      dedication: personalizeTemplate(variant.dedicationTemplate, order),
      characterDescription: personalizeTemplate(variant.characterTemplate, order).replace(/\s+/g, ' ').trim(),
      pages,
    },
    variant,
  };
}

// ── OpenAI generation ──────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a professional children's book author. You write personalized, age-appropriate storybooks (ages 2-10). Stories should be warm, adventurous, educational, and about 100 words per page. Always write in the third person with the child as the hero.`;
}

/**
 * Story arc beats per format. Short stories use the original 6-beat arc;
 * long-form stories use a broader beat structure with room for scenes
 * between the named beats so the model can pace 24 / 32 illustrated pages.
 */
function buildStoryArcInstruction(pageCount: number): string {
  if (pageCount <= 6) {
    return 'Make the story arc: setup → adventure begins → challenge → peak moment → resolution → happy ending.';
  }
  return (
    `Pace the story across ${pageCount} pages using these beats with room for scene-building pages between them: ` +
    'opening world / hero introduction → inciting incident → first try → setback → wise help or new idea → ' +
    'rising action → biggest challenge → peak moment → turning point → resolution → return home → reflection. ' +
    'Distribute illustrated scenes evenly so no two adjacent pages repeat the same setting. ' +
    `Every one of the ${pageCount} pages must move the story forward — no filler, no recap.`
  );
}

function buildUserPrompt(order: OrderRecord): string {
  const theme = STORY_THEMES.find(t => t.id === order.theme);
  const childName = sanitizeInput(order.childName, 60);
  const giftMessage = sanitizeInput(order.giftMessage, 200);
  const characterNotes = sanitizeInput(order.characterNotes, 200);
  const appearanceOptions = sanitizeInput(order.appearanceOptions, 200);
  const pageCount = getStoryPageCount(order.bookFormat);
  return `Write a ${pageCount}-page personalized children's storybook with the following details:
- Hero's name: ${childName}
- Age: ${sanitizeInput(order.childAge, 10) || 'not specified'}
- Theme: ${theme?.name ?? sanitizeInput(order.theme, 60) ?? 'adventure'}. ${theme?.description ?? ''}
- Core lesson: ${sanitizeInput(order.lesson, 100) || 'courage and bravery'}
- Occasion: ${sanitizeInput(order.occasion, 60) || 'general'}
- Gift message: ${giftMessage || 'none'}
- Character notes: ${characterNotes || 'none'}
- Appearance: ${appearanceOptions || 'not specified'}
- Format: ${order.bookFormat}

Respond ONLY with a valid JSON object matching this exact schema:
{
  "title": "string — catchy book title with child's name",
  "dedication": "string — one sentence dedication",
  "characterDescription": "string — RICH, STABLE visual description of the hero used as a canonical anchor for every page illustration. Include: face shape, eye color, eye spacing, eyebrow style, hair color/length/texture/style, skin tone, build, approximate age, and any standout features. Write it once here and never restate it inside per-page imagePrompt.",
  "pages": [
    {
      "pageNum": 1,
      "sceneTitle": "string — short scene title (3-5 words)",
      "story": "string — 80-120 words of story text",
      "imagePrompt": "string — illustration prompt for THIS SCENE ONLY. Describe action + setting + mood + key props. DO NOT describe the hero's face, hair, eyes, skin, age, or build in this field — the canonical characterDescription anchors that. Refer to the hero only as 'the hero' or by name. Keep the art style line to: 'warm colorful children's book illustration'."
    }
  ]
}

Write exactly ${pageCount} pages. ${buildStoryArcInstruction(pageCount)}`;
}

interface FetchDep {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Structured story generator that returns BOTH the story content AND a
 * StoryMeta record describing which path was taken (openai_chat / template
 * / template_after_openai_failure). Fulfillment persists the meta on the
 * order so admin diagnostics can answer "did this order use template or
 * model-generated story?" without log archaeology.
 */
export async function generateStoryWithMeta(
  order: OrderRecord,
  deps: { fetch?: FetchDep; now?: () => Date } = {},
): Promise<StoryWithMeta> {
  const apiKey = process.env.OPENAI_API_KEY;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  if (!apiKey || !isOpenAiStoryEnabled()) {
    const { story, variant } = buildTemplateFallbackWithVariant(order);
    return {
      story,
      meta: {
        source: 'template',
        model: `template:${variant.titleSuffix}`,
        generatedAt: nowIso,
        fallbackError: null,
      },
    };
  }

  const _fetch = deps.fetch ?? globalThis.fetch;

  try {
    const response = await _fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: buildUserPrompt(order) },
        ],
        temperature: 0.8,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('OpenAI returned empty content');

    const parsed = JSON.parse(raw) as StoryContent;
    if (!parsed.title || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
      throw new Error('OpenAI story missing required fields');
    }

    return {
      story: parsed,
      meta: {
        source: 'openai_chat',
        model: 'gpt-4o-mini',
        generatedAt: nowIso,
        fallbackError: null,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[story-generator] Falling back to templates for order ${order.id}: ${message}`);
    const { story, variant } = buildTemplateFallbackWithVariant(order);
    return {
      story,
      meta: {
        source: 'template_after_openai_failure',
        model: `template:${variant.titleSuffix}`,
        generatedAt: nowIso,
        fallbackError: message.slice(0, 200),
      },
    };
  }
}

/** Backward-compatible wrapper. Prefer generateStoryWithMeta for new callers. */
export async function generateStory(
  order: OrderRecord,
  deps: { fetch?: FetchDep } = {},
): Promise<StoryContent> {
  const { story } = await generateStoryWithMeta(order, deps);
  return story;
}
