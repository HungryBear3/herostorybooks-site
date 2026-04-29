/**
 * generateStoryWithMeta — observability for the story path.
 *
 * Branches:
 *   - no OPENAI_API_KEY → source='template', model='template:<Variant>'
 *   - OPENAI_API_KEY + 200 → source='openai_chat', model='gpt-4o-mini'
 *   - OPENAI_API_KEY + non-2xx or invalid JSON → source='template_after_openai_failure',
 *     fallbackError populated and truncated
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
    { id: 'ord_meta_test', now: '2026-04-29T10:00:00Z' },
  );
}

function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> | T {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

test('story meta: no OPENAI_API_KEY → template path with template:<Variant> model', async () => {
  await withEnv('OPENAI_API_KEY', undefined, async () => {
    const result = await generateStoryWithMeta(makeOrder(), {
      now: () => new Date('2026-04-29T10:00:00Z'),
    });
    assert.equal(result.meta.source, 'template');
    assert.match(result.meta.model, /^template:/);
    assert.equal(result.meta.generatedAt, '2026-04-29T10:00:00.000Z');
    assert.equal(result.meta.fallbackError ?? null, null);
    assert.ok(result.story.title);
    assert.ok(result.story.pages.length > 0);
  });
});

test('story meta: OpenAI 200 OK → source=openai_chat, model=gpt-4o-mini', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: 'Luna and the Stars',
                dedication: 'For Luna',
                characterDescription: 'A bright child',
                pages: [
                  { pageNum: 1, sceneTitle: 'Begin', story: 'p1', imagePrompt: 'i1' },
                ],
              }),
            },
          },
        ],
      }),
    })) as unknown as typeof globalThis.fetch;
    const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
    assert.equal(result.meta.source, 'openai_chat');
    assert.equal(result.meta.model, 'gpt-4o-mini');
    assert.equal(result.meta.fallbackError ?? null, null);
    assert.equal(result.story.title, 'Luna and the Stars');
  });
});

test('story meta: OpenAI 500 → source=template_after_openai_failure with truncated fallbackError', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'upstream meltdown'.repeat(50),
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;
    const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
    assert.equal(result.meta.source, 'template_after_openai_failure');
    assert.match(result.meta.model, /^template:/);
    assert.match(result.meta.fallbackError ?? '', /OpenAI API error 500/);
    assert.ok((result.meta.fallbackError ?? '').length <= 200);
    assert.ok(result.story.title); // template story still rendered
  });
});

test('story meta: OpenAI returns invalid JSON → fallback path with parse error', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        choices: [{ message: { content: 'not valid json {{{' } }],
      }),
    })) as unknown as typeof globalThis.fetch;
    const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
    assert.equal(result.meta.source, 'template_after_openai_failure');
    assert.ok(result.meta.fallbackError);
  });
});
