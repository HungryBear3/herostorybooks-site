import type { OrderRecord } from './orders.ts';
import type { StoryContent, StoryPage } from './fulfillment-types.ts';
import { STORY_THEMES } from './story-catalog.ts';
import { SAMPLE_ADVENTURES } from './sample-adventures.ts';

// ── Template fallback ──────────────────────────────────────────────────────────

function buildTemplateFallback(order: OrderRecord): StoryContent {
  const theme = STORY_THEMES.find(t => t.id === order.theme);
  const sample = SAMPLE_ADVENTURES.find(a => a.name.toLowerCase().includes(order.theme?.split('-')[0] ?? ''))
    ?? SAMPLE_ADVENTURES[0];

  const childName = order.childName;
  const lesson = order.lesson || 'courage';

  const pages: StoryPage[] = sample.pages.map((p, i) => ({
    pageNum: i + 1,
    sceneTitle: p.sceneTitle ?? p.subtitle ?? `Chapter ${i + 1}`,
    story: p.story.replace(/\b(Marcus|Zara|Lily|Sam)\b/g, childName),
    imagePrompt: `A children's book illustration of ${childName}, ${theme?.description ?? 'on a grand adventure'}. ${p.subtitle ?? ''}. Warm, colorful, age-appropriate art style.`,
  }));

  return {
    title: `${childName}'s ${theme?.name ?? 'Great'} Adventure`,
    dedication: `For ${childName} — may you always be the hero of your own story.`,
    characterDescription: `A brave child named ${childName}${order.childAge ? `, age ${order.childAge}` : ''}. ${order.characterNotes ?? ''}`.trim(),
    pages,
  };
}

// ── OpenAI generation ──────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a professional children's book author. You write personalized, age-appropriate storybooks (ages 2-10). Stories should be warm, adventurous, educational, and about 100 words per page. Always write in the third person with the child as the hero.`;
}

function sanitizeInput(value: string | undefined | null, maxLen: number): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function buildUserPrompt(order: OrderRecord): string {
  const theme = STORY_THEMES.find(t => t.id === order.theme);
  const childName = sanitizeInput(order.childName, 60);
  const giftMessage = sanitizeInput(order.giftMessage, 200);
  const characterNotes = sanitizeInput(order.characterNotes, 200);
  const appearanceOptions = sanitizeInput(order.appearanceOptions, 200);
  return `Write a 6-page personalized children's storybook with the following details:
- Hero's name: ${childName}
- Age: ${sanitizeInput(order.childAge, 10) || 'not specified'}
- Theme: ${theme?.name ?? sanitizeInput(order.theme, 60) ?? 'adventure'}. ${theme?.description ?? ''}
- Core lesson: ${sanitizeInput(order.lesson, 100) || 'courage and bravery'}
- Occasion: ${sanitizeInput(order.occasion, 60) || 'general'}
- Gift message: ${giftMessage || 'none'}
- Character notes: ${characterNotes || 'none'}
- Appearance: ${appearanceOptions || 'not specified'}

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

Write exactly 6 pages. Make the story arc: setup → adventure begins → challenge → peak moment → resolution → happy ending.`;
}

interface FetchDep {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export async function generateStory(
  order: OrderRecord,
  deps: { fetch?: FetchDep } = {},
): Promise<StoryContent> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return buildTemplateFallback(order);
  }

  const _fetch = deps.fetch ?? globalThis.fetch;

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
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('OpenAI returned empty content');

  let parsed: StoryContent;
  try {
    parsed = JSON.parse(raw) as StoryContent;
  } catch {
    throw new Error(`OpenAI returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  if (!parsed.title || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    throw new Error('OpenAI story missing required fields');
  }

  return parsed;
}
