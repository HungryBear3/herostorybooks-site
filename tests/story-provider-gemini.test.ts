/**
 * Gemini per-page prose provider — PR2 gate + integration coverage.
 *
 * Asserted contracts:
 *   - Gate off (HSB_ENABLE_GEMINI_PAGE_PROSE unset) → Gemini is never
 *     called, even when the API key is present.
 *   - Gate on + key absent → Gemini is never called, downstream paths
 *     run unaffected.
 *   - Gate on + key present → Gemini is called, story meta carries
 *     source='gemini_page_prose' and model='gemini:<model>'.
 *   - Gemini failure → story-generator falls back to template and
 *     records fallbackError on meta (legacy 'template_after_openai_failure'
 *     source code reused, per fulfillment-types.ts comment).
 *   - Gemini path takes precedence over Ollama and OpenAI when all three
 *     gates are set (PR2 ordering rule).
 *   - Per-request URL hits Google's Generative Language API endpoint with
 *     the configured model (default gemini-2.5-flash, overridable via
 *     HSB_GEMINI_PAGE_PROSE_MODEL).
 *
 * No external API call is ever made — all tests inject a fake fetch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateStoryWithMeta } from '../src/lib/story-generator.ts';
import { createOrderRecord, type OrderRecord } from '../src/lib/orders.ts';

function makeOrder(): OrderRecord {
  return createOrderRecord(
    {
      childName: 'Luna',
      bookFormat: 'classic',
      email: 'a@b.com',
      theme: 'space-voyager',
      lesson: 'courage',
      occasion: 'birthday',
      characterNotes: 'loves dinosaurs',
      appearanceOptions: 'brown hair, hazel eyes',
    },
    { id: 'ord_gemini_test', now: '2026-05-14T10:00:00Z' },
  );
}

const GEMINI_ENV_KEYS = [
  'GOOGLE_GEMINI_API_KEY',
  'HSB_ENABLE_GEMINI_PAGE_PROSE',
  'HSB_GEMINI_PAGE_PROSE_MODEL',
  'OPENAI_API_KEY',
  'HSB_ENABLE_OPENAI_STORY',
  'HSB_ENABLE_OPENAI_PAGE_PROSE',
  'HSB_ENABLE_OLLAMA_PAGE_PROSE',
  'HSB_OLLAMA_PAGE_PROSE_MODEL',
  'OLLAMA_BASE_URL',
] as const;

type EnvOverrides = Partial<Record<(typeof GEMINI_ENV_KEYS)[number], string | undefined>>;

async function withEnv<T>(overrides: EnvOverrides, fn: () => Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of GEMINI_ENV_KEYS) {
    originals[key] = process.env[key];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const key of GEMINI_ENV_KEYS) {
      const original = originals[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

const SAFE_PAGE_PROSE =
  'The hero crouches by the wet cave wall and runs one finger through the spiral. Water drums all around. The bronze compass gives a tiny kick in their palm.';

function buildGeminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ text }] },
          finishReason: 'STOP',
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ── (a) Gate off → Gemini never called ───────────────────────────────────────

test('story-provider-gemini: gate off → Gemini is never called even with key present', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
      HSB_ENABLE_GEMINI_PAGE_PROSE: undefined,
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      let geminiCalls = 0;
      const fakeFetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (url.includes('generativelanguage.googleapis.com')) geminiCalls += 1;
        throw new Error(`no network calls expected; got ${url}`);
      }) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(geminiCalls, 0);
      assert.equal(result.meta.source, 'template');
      assert.equal(result.meta.fallbackError ?? null, null);
    },
  );
});

// ── (b) Gate on + key missing → Gemini never called ──────────────────────────

test('story-provider-gemini: gate on but GOOGLE_GEMINI_API_KEY missing → falls through to template', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: undefined,
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      const fakeFetch = (async () => {
        throw new Error('no network calls expected when key is missing');
      }) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(result.meta.source, 'template');
      assert.equal(result.meta.fallbackError ?? null, null);
    },
  );
});

// ── (c) Gate on + key present → Gemini called, source=gemini_page_prose ──────

test('story-provider-gemini: gate on + key present → Gemini path runs, meta source is gemini_page_prose', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      HSB_GEMINI_PAGE_PROSE_MODEL: undefined, // default model
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      let calls = 0;
      const seenUrls: string[] = [];
      const fakeFetch = (async (input: RequestInfo | URL) => {
        calls += 1;
        const url = typeof input === 'string' ? input : (input as URL).toString();
        seenUrls.push(url);
        return buildGeminiResponse(SAFE_PAGE_PROSE);
      }) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });

      assert.equal(result.meta.source, 'gemini_page_prose');
      assert.equal(result.meta.model, 'gemini:gemini-2.5-flash');
      assert.equal(result.meta.fallbackError ?? null, null);
      assert.equal(result.story.pages.length, 24);
      assert.equal(calls, 24);
      assert.ok(
        seenUrls.every((u) =>
          u.startsWith('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'),
        ),
        `every call must hit Gemini default-model endpoint; got ${seenUrls[0]}`,
      );
    },
  );
});

// ── (c.1) HSB_GEMINI_PAGE_PROSE_MODEL overrides the default model ────────────

test('story-provider-gemini: HSB_GEMINI_PAGE_PROSE_MODEL overrides default model in URL + meta', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      HSB_GEMINI_PAGE_PROSE_MODEL: 'gemini-1.5-pro-latest',
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      const fakeFetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        assert.ok(
          url.includes('/models/gemini-1.5-pro-latest:generateContent'),
          `expected model override in URL; got ${url}`,
        );
        return buildGeminiResponse(SAFE_PAGE_PROSE);
      }) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(result.meta.source, 'gemini_page_prose');
      assert.equal(result.meta.model, 'gemini:gemini-1.5-pro-latest');
    },
  );
});

// ── (d) Gemini non-2xx → fallback to template with fallbackError recorded ────

test('story-provider-gemini: non-2xx response → template fallback with truncated fallbackError', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      const fakeFetch = (async () =>
        new Response('overloaded', { status: 503 })) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(result.meta.source, 'template_after_openai_failure');
      assert.match(result.meta.fallbackError ?? '', /Gemini API error 503/);
      assert.ok(result.story.pages.length > 0, 'template fallback must still produce pages');
    },
  );
});

// ── (d.1) Gemini valid HTTP but invalid validation 3× → template fallback ────

test('story-provider-gemini: prose validation fails 3 retries → template fallback with validation-error trace', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      // Forbidden phrase trips validatePageProse on every attempt.
      const bannedProse =
        'This is the page where everything is held in a hush, guided by the lamplight, while noticing the moment shift.';
      const fakeFetch = (async () =>
        buildGeminiResponse(bannedProse)) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(result.meta.source, 'template_after_openai_failure');
      assert.match(result.meta.fallbackError ?? '', /prose failed validation/);
      assert.ok(result.story.pages.length > 0);
    },
  );
});

// ── (d.2) Gemini empty candidates → fallback to template with parse hint ─────

test('story-provider-gemini: empty candidates array → template fallback with "empty content" hint', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      const fakeFetch = (async () =>
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(result.meta.source, 'template_after_openai_failure');
      assert.match(result.meta.fallbackError ?? '', /empty content|Gemini/);
    },
  );
});

// ── (e) Gemini precedence: takes priority over Ollama + OpenAI gates ─────────

test('story-provider-gemini: with all three LLM gates on, Gemini wins and is the only provider called', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-gemini-key',
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      OPENAI_API_KEY: 'test-openai-key',
      HSB_ENABLE_OPENAI_PAGE_PROSE: 'true',
      HSB_ENABLE_OPENAI_STORY: 'true',
      HSB_ENABLE_OLLAMA_PAGE_PROSE: 'true',
    },
    async () => {
      let geminiCalls = 0;
      let openaiCalls = 0;
      let ollamaCalls = 0;
      const fakeFetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as URL).toString();
        if (url.includes('generativelanguage.googleapis.com')) {
          geminiCalls += 1;
          return buildGeminiResponse(SAFE_PAGE_PROSE);
        }
        if (url.includes('api.openai.com')) {
          openaiCalls += 1;
          throw new Error('OpenAI must not be called when Gemini gate is on');
        }
        if (url.includes('ollama') || url.includes('11434')) {
          ollamaCalls += 1;
          throw new Error('Ollama must not be called when Gemini gate is on');
        }
        throw new Error(`unexpected URL: ${url}`);
      }) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(result.meta.source, 'gemini_page_prose');
      assert.equal(geminiCalls, 24);
      assert.equal(openaiCalls, 0);
      assert.equal(ollamaCalls, 0);
    },
  );
});

// ── (f) URL never logs the API key in error messages ─────────────────────────

test('story-provider-gemini: 403 error message does not echo the API key', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'secret-key-xyz-12345',
      HSB_ENABLE_GEMINI_PAGE_PROSE: 'true',
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      const fakeFetch = (async () =>
        new Response(
          'PERMISSION_DENIED secret-key-xyz-12345 https://generativelanguage.googleapis.com/v1beta/models/gemini?key=secret-key-xyz-12345',
          { status: 403 },
        )) as unknown as typeof globalThis.fetch;

      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      const trace = result.meta.fallbackError ?? '';
      assert.match(trace, /Gemini API error 403/);
      assert.ok(
        !trace.includes('secret-key-xyz-12345'),
        `fallbackError must not contain the API key: ${trace}`,
      );
    },
  );
});
