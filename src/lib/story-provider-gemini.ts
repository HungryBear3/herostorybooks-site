// Gemini per-page prose provider.
//
// Mirrors the existing Ollama per-page prose path (3-attempt retry with
// validation feedback) using Google's Generative Language REST API. The
// orchestrator in `story-generator.ts` is responsible for the gate decision
// (HSB_ENABLE_GEMINI_PAGE_PROSE + GOOGLE_GEMINI_API_KEY); this file only
// implements the per-page transport + validation loop.
//
// Hard rules:
//   - Per-request timeout via AbortSignal.timeout. A hung Gemini call must
//     not consume the whole serverless budget.
//   - On non-2xx response, invalid response shape, or repeated validation
//     failure, throw an Error. `generateStoryWithMeta` will catch it and
//     degrade to the template path, recording `fallbackError` exactly the
//     same way it does for OpenAI/Ollama failures.
//   - Never logs the API key, the prompt, or the response body. Errors
//     include only status code + a short truncated tail.

import type { OrderRecord } from './orders.ts';
import { getStoryPageCount } from './orders.ts';
import type { StoryContent, StoryPage } from './fulfillment-types.ts';
import { STORY_THEMES } from './story-catalog.ts';
import { planStorybook, validateStoryPlan } from './story-planner.ts';
import {
  buildPageProseSystemPrompt,
  buildPageProseUserPrompt,
  buildSafeImagePrompt,
  firstNameOnly,
  getLockedPageProse,
  personalizeTemplate,
  validatePageProse,
  type FetchDep,
  type TemplateVariantProfile,
} from './story-generator.ts';

/**
 * Default Gemini model for per-page prose. `gemini-2.5-flash` is the
 * current cheap/fast tier; HSB_GEMINI_PAGE_PROSE_MODEL overrides it.
 */
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Per-request timeout. Matches the FAL/Seedream/OpenAI image-provider
 * timeout convention. A hung Gemini call should not eat the whole
 * serverless budget — the per-page loop will fail this attempt and the
 * outer try/catch in `generateStoryWithMeta` will degrade to template.
 */
const GEMINI_REQUEST_TIMEOUT_MS = 60_000;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function sanitizeShort(value: string | undefined | null, maxLen: number): string {
  if (!value) return '';
  return String(value).trim().slice(0, maxLen);
}

function sanitizeGeminiErrorDetail(value: string | undefined | null, apiKey: string, maxLen = 200): string {
  if (!value) return '';
  let safe = String(value);
  if (apiKey) safe = safe.split(apiKey).join('[redacted-api-key]');
  safe = safe
    .replace(/([?&]key=)[^\s&]+/gi, '$1[redacted-api-key]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted-token]')
    .replace(/\bsk[_-][A-Za-z0-9_-]+/g, '[redacted-secret]');
  return safe.trim().slice(0, maxLen);
}

export function isGeminiPageProseEnabled(): boolean {
  return process.env.HSB_ENABLE_GEMINI_PAGE_PROSE === 'true';
}

export function getGeminiApiKey(): string | undefined {
  const raw = process.env.GOOGLE_GEMINI_API_KEY;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getGeminiPageProseModel(): string {
  return sanitizeShort(process.env.HSB_GEMINI_PAGE_PROSE_MODEL, 120) || DEFAULT_GEMINI_MODEL;
}

// ── Gemini API shape ──────────────────────────────────────────────────────────
//
// We only model the fields we read. Anything unexpected becomes a thrown
// error, which the outer fallback handles.

interface GeminiResponseBody {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

function extractGeminiText(body: GeminiResponseBody): string {
  const parts = body.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return '';
  return parts.map((p) => p?.text ?? '').join('').trim();
}

/**
 * Single call to Gemini. Returns the trimmed text content or throws.
 * Caller is responsible for prose validation + retry semantics.
 */
async function callGemini(args: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  userMessages: Array<{ role: 'user' | 'model'; text: string }>;
  fetch: FetchDep;
}): Promise<string> {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(args.model)}:generateContent?key=${encodeURIComponent(args.apiKey)}`;
  const body = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: args.systemInstruction }],
    },
    contents: args.userMessages.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 256,
    },
  };

  let response: Response;
  try {
    response = await args.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortError, network error — surface as a short, non-key-leaking message.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini fetch failed: ${sanitizeGeminiErrorDetail(message, args.apiKey)}`);
  }

  if (!response.ok) {
    const tail = sanitizeGeminiErrorDetail(await response.text().catch(() => ''), args.apiKey);
    throw new Error(`Gemini API error ${response.status}: ${tail}`);
  }

  let parsed: GeminiResponseBody;
  try {
    parsed = (await response.json()) as GeminiResponseBody;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini response parse failed: ${sanitizeGeminiErrorDetail(message, args.apiKey)}`);
  }

  // Safety: Gemini may return promptFeedback.blockReason instead of candidates
  // when the prompt trips a safety filter. Surface that distinctly.
  if (parsed.promptFeedback?.blockReason) {
    throw new Error(`Gemini blocked: ${sanitizeGeminiErrorDetail(parsed.promptFeedback.blockReason, args.apiKey, 80)}`);
  }

  const text = extractGeminiText(parsed);
  if (!text) {
    throw new Error('Gemini returned empty content');
  }
  return text;
}

/**
 * Build a complete StoryContent by running the per-page prose loop against
 * Gemini. Identical contract to `buildStoryFromOllamaPageProse` and
 * `buildStoryFromPageProse` in story-generator.ts:
 *   - plans pages via the existing planner,
 *   - reuses the locked-prose escape hatch for theme-specific pages,
 *   - generates per-page prose with up to 3 retries that include the prior
 *     validation error as a correction hint,
 *   - throws on any unrecoverable failure so the outer generator can fall
 *     back to template.
 */
export async function buildStoryFromGeminiPageProse(
  order: OrderRecord,
  variant: TemplateVariantProfile,
  _fetch: FetchDep,
  apiKey: string,
): Promise<StoryContent> {
  const theme = STORY_THEMES.find((t) => t.id === order.theme);
  const targetPageCount = getStoryPageCount(order.bookFormat);
  const storyPlan = planStorybook(order, targetPageCount);
  const planIssues = validateStoryPlan(storyPlan);
  if (planIssues.length > 0) {
    throw new Error(`story plan failed validation: ${planIssues.join('; ')}`);
  }

  const model = getGeminiPageProseModel();
  const protagonist = firstNameOnly(order);
  const themeDescription = theme?.description ?? 'a grand adventure';
  const pages: StoryPage[] = [];

  for (let index = 0; index < storyPlan.pages.length; index += 1) {
    const beat = storyPlan.pages[index]!;
    const lockedProse = getLockedPageProse(order, beat, targetPageCount);
    if (lockedProse) {
      pages.push({
        pageNum: index + 1,
        sceneTitle: beat.beat_summary,
        story: lockedProse,
        imagePrompt: buildSafeImagePrompt({
          childName: protagonist,
          heroType: order.heroType ?? undefined,
          themeDescription,
          page: index + 1,
          beat,
        }),
        textLayout: beat.text_layout,
      });
      continue;
    }

    const previousBeat = index > 0 ? storyPlan.pages[index - 1]! : null;
    const systemInstruction = buildPageProseSystemPrompt();
    const baseUserMessage = buildPageProseUserPrompt(order, beat, targetPageCount, previousBeat);

    let prose = '';
    let lastValidationError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const userMessages: Array<{ role: 'user' | 'model'; text: string }> = [
        { role: 'user', text: baseUserMessage },
      ];
      if (attempt > 1 && lastValidationError) {
        userMessages.push({
          role: 'user',
          text: `Retry this same page. Fix these validation issues exactly: ${lastValidationError}. Keep the same beat and write fresh prose only.`,
        });
      }

      const generated = await callGemini({
        apiKey,
        model,
        systemInstruction,
        userMessages,
        fetch: _fetch,
      });

      const candidate = generated.trim();
      const proseIssues = validatePageProse(candidate, protagonist);
      if (proseIssues.length === 0) {
        prose = candidate;
        lastValidationError = '';
        break;
      }
      lastValidationError = proseIssues.join('; ');
      prose = '';
    }

    if (!prose) {
      throw new Error(
        `page ${beat.page} prose failed validation: ${lastValidationError || 'unknown validation error'}`,
      );
    }

    pages.push({
      pageNum: index + 1,
      sceneTitle: beat.beat_summary,
      story: prose,
      imagePrompt: buildSafeImagePrompt({
        childName: protagonist,
        heroType: order.heroType ?? undefined,
        themeDescription,
        page: index + 1,
        beat,
      }),
      textLayout: beat.text_layout,
    });
  }

  return {
    title: storyPlan.title,
    dedication: personalizeTemplate(variant.dedicationTemplate, order),
    characterDescription: `${personalizeTemplate(variant.characterTemplate, order).replace(/\s+/g, ' ').trim()} Outfit: ${storyPlan.protagonist_outfit}.`,
    pages,
  };
}
