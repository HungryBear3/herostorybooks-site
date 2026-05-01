/**
 * Story generator must request the right page count per format
 * (print redesign — slice 1).
 *
 * Verified through two surfaces:
 *   1. The OpenAI user prompt — assert it asks for 6 / 24 / 32 pages.
 *   2. The template fallback — assert it produces N pages per format.
 *
 * The OpenAI prompt is reached by giving generateStoryWithMeta a fake
 * fetch + STRIPE_API_KEY/HSB_ENABLE_OPENAI_STORY=true env, capturing the
 * request body, asserting on it, and returning a synthetic 200 response.
 * The template fallback is reached by leaving HSB_ENABLE_OPENAI_STORY
 * unset (the default code path).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateStoryWithMeta } from '../src/lib/story-generator.ts';
import { createOrderRecord, type BookFormat, type OrderRecord } from '../src/lib/orders.ts';

function makeOrder(bookFormat: BookFormat): OrderRecord {
  return createOrderRecord(
    {
      childName: 'Luna',
      bookFormat,
      email: 'a@b.com',
      theme: 'space-voyager',
      lesson: 'courage',
      occasion: 'birthday',
    },
    { id: `ord_fmt_${bookFormat}`, now: '2026-05-01T10:00:00Z' },
  );
}

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> | T {
  const originals: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const k of Object.keys(values)) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

interface CapturedRequest {
  body: { messages: { role: string; content: string }[]; model?: string } | null;
}

function makeOpenAiSpyFetch(): { fetch: typeof globalThis.fetch; captured: CapturedRequest } {
  const captured: CapturedRequest = { body: null };
  const spy = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    captured.body = JSON.parse(raw);
    const responseBody = JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Spy Title',
              dedication: 'Spy dedication',
              characterDescription: 'A child.',
              pages: [
                { pageNum: 1, sceneTitle: 's', story: 'p', imagePrompt: 'i' },
              ],
            }),
          },
        },
      ],
    });
    return new Response(responseBody, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: spy, captured };
}

function userPromptOf(captured: CapturedRequest): string {
  const userMessage = captured.body?.messages?.find((m) => m.role === 'user');
  return userMessage?.content ?? '';
}

// ── OpenAI prompt path ──────────────────────────────────────────────────────

test('OpenAI prompt: digital order asks for 6 pages', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      await generateStoryWithMeta(makeOrder('digital'), { fetch });
      const prompt = userPromptOf(captured);
      assert.match(prompt, /Write a 6-page personalized children's storybook/);
      assert.match(prompt, /Write exactly 6 pages\./);
    },
  );
});

test('OpenAI prompt: classic order asks for 24 pages', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      await generateStoryWithMeta(makeOrder('classic'), { fetch });
      const prompt = userPromptOf(captured);
      assert.match(prompt, /Write a 24-page personalized children's storybook/);
      assert.match(prompt, /Write exactly 24 pages\./);
      // Long-form arc instruction kicks in for any pageCount > 6.
      assert.match(prompt, /Pace the story across 24 pages/);
    },
  );
});

test('OpenAI prompt: premium order asks for 32 pages', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      await generateStoryWithMeta(makeOrder('premium'), { fetch });
      const prompt = userPromptOf(captured);
      assert.match(prompt, /Write a 32-page personalized children's storybook/);
      assert.match(prompt, /Write exactly 32 pages\./);
      assert.match(prompt, /Pace the story across 32 pages/);
    },
  );
});

test('OpenAI prompt: digital keeps the legacy 6-beat arc, NOT the long-form arc', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      await generateStoryWithMeta(makeOrder('digital'), { fetch });
      const prompt = userPromptOf(captured);
      assert.match(prompt, /setup → adventure begins → challenge/);
      assert.doesNotMatch(prompt, /Pace the story across/);
    },
  );
});

// ── Template fallback path ───────────────────────────────────────────────────

test('template fallback: digital order produces exactly 6 pages', async () => {
  await withEnv({ OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined }, async () => {
    const result = await generateStoryWithMeta(makeOrder('digital'));
    assert.equal(result.meta.source, 'template');
    assert.equal(result.story.pages.length, 6);
  });
});

test('template fallback: classic order produces exactly 24 pages', async () => {
  await withEnv({ OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined }, async () => {
    const result = await generateStoryWithMeta(makeOrder('classic'));
    assert.equal(result.meta.source, 'template');
    assert.equal(result.story.pages.length, 24);
    // Sanity: every page has non-empty story text (cycling must not produce blanks).
    for (const p of result.story.pages) {
      assert.ok(p.story.trim().length > 0, `page ${p.pageNum} has empty story text`);
      assert.ok(p.imagePrompt.trim().length > 0, `page ${p.pageNum} has empty image prompt`);
    }
  });
});

test('template fallback: premium order produces exactly 32 pages', async () => {
  await withEnv({ OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined }, async () => {
    const result = await generateStoryWithMeta(makeOrder('premium'));
    assert.equal(result.meta.source, 'template');
    assert.equal(result.story.pages.length, 32);
  });
});
