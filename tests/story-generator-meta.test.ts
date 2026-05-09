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

test('story meta: OPENAI_API_KEY alone does not burn credits — default path stays template', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    await withEnv('HSB_ENABLE_OPENAI_STORY', undefined, async () => {
      await withEnv('HSB_ENABLE_OPENAI_PAGE_PROSE', undefined, async () => {
      let called = false;
      const fakeFetch = (async () => {
        called = true;
        throw new Error('should not call OpenAI when template-only mode is default');
      }) as unknown as typeof globalThis.fetch;
      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(called, false);
      assert.equal(result.meta.source, 'template');
      assert.match(result.meta.model, /^template:/);
      assert.equal(result.meta.fallbackError ?? null, null);
      });
    });
  });
});

test('story meta: explicit HSB_ENABLE_OPENAI_PAGE_PROSE=true uses planner-driven page prose path', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    await withEnv('HSB_ENABLE_OPENAI_STORY', undefined, async () => {
      await withEnv('HSB_ENABLE_OPENAI_PAGE_PROSE', 'true', async () => {
        let calls = 0;
        const fakeFetch = (async (_input, init) => {
          calls += 1;
          const body = JSON.parse(String(init?.body ?? '{}'));
          const userPrompt = body.messages?.[1]?.content ?? '';
          if (!new RegExp(`PAGE NUMBER:\\s+${calls} of 24`).test(userPrompt)) {
            throw new Error(`unexpected prompt: ${userPrompt}`);
          }
          return {
            ok: true,
            status: 200,
            text: async () => '',
            json: async () => ({
              choices: [
                {
                  message: {
                    content: 'Rex crouches by the wet cave wall and runs one finger through the spiral. Water drums all around him. The bronze compass gives a tiny kick in his palm.',
                  },
                },
              ],
            }),
          };
        }) as unknown as typeof globalThis.fetch;
        const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
        assert.equal(result.meta.source, 'openai_page_prose');
        assert.equal(result.meta.model, 'gpt-4o-mini');
        assert.equal(calls, 24);
        assert.equal(result.story.pages.length, 24);
        assert.doesNotMatch(result.story.pages[0]!.story, /pulls the eye first|Everything is held in a|guided by/i);
      });
    });
  });
});

test('story meta: explicit HSB_ENABLE_OPENAI_PAGE_PROSE=true + OpenAI failure falls back cleanly', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    await withEnv('HSB_ENABLE_OPENAI_STORY', undefined, async () => {
      await withEnv('HSB_ENABLE_OPENAI_PAGE_PROSE', 'true', async () => {
        const fakeFetch = (async () => ({
          ok: false,
          status: 429,
          text: async () => 'quota exceeded',
          json: async () => ({}),
        })) as unknown as typeof globalThis.fetch;
        const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
        assert.equal(result.meta.source, 'template_after_openai_failure');
        assert.match(result.meta.fallbackError ?? '', /OpenAI API error 429/);
      });
    });
  });
});

test('story meta: explicit HSB_ENABLE_OLLAMA_PAGE_PROSE=true uses local Ollama page prose path', async () => {
  await withEnv('HSB_ENABLE_OLLAMA_PAGE_PROSE', 'true', async () => {
    await withEnv('HSB_OLLAMA_PAGE_PROSE_MODEL', 'qwen2.5:14b', async () => {
      let calls = 0;
      const fakeFetch = (async (input, init) => {
        calls += 1;
        assert.equal(String(input), 'http://127.0.0.1:11434/api/chat');
        const body = JSON.parse(String(init?.body ?? '{}'));
        assert.equal(body.model, 'qwen2.5:14b');
        const userPrompt = body.messages?.[1]?.content ?? '';
        if (!new RegExp(`PAGE NUMBER:\\s+${calls} of 24`).test(userPrompt)) {
          throw new Error(`unexpected prompt: ${userPrompt}`);
        }
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            message: {
              content: 'Luna presses her hand to the cool wall and listens. Water taps the stones behind her. In her palm, the compass gives one small, steady tug.',
            },
          }),
        };
      }) as unknown as typeof globalThis.fetch;
      const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
      assert.equal(result.meta.source, 'ollama_page_prose');
      assert.equal(result.meta.model, 'ollama:qwen2.5:14b');
      assert.equal(calls, 24);
      assert.equal(result.story.pages.length, 24);
      assert.doesNotMatch(result.story.pages[0]!.story, /pulls the eye first|Everything is held in a|guided by/i);
    });
  });
});

test('story meta: explicit HSB_ENABLE_OLLAMA_PAGE_PROSE=true + Ollama failure falls back cleanly', async () => {
  await withEnv('HSB_ENABLE_OLLAMA_PAGE_PROSE', 'true', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => 'ollama down',
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;
    const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
    assert.equal(result.meta.source, 'template_after_openai_failure');
    assert.match(result.meta.fallbackError ?? '', /Ollama API error 500/);
  });
});

test('story meta: explicit HSB_ENABLE_OLLAMA_PAGE_PROSE=true retries invalid page prose and succeeds on a later attempt', async () => {
  await withEnv('HSB_ENABLE_OLLAMA_PAGE_PROSE', 'true', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      const invalid = 'Luna presses her hand to the cool wall and listens. Luna hears the dripping water and Luna holds the compass while Luna waits for it to answer. Luna stays very still beside the stone and keeps listening for the hidden voice in the cave.';
      const valid = 'Luna presses her hand to the cool wall and listens. Water taps the stones behind her. In her palm, the compass gives one small, steady tug.';
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          message: {
            content: calls === 1 ? invalid : valid,
          },
        }),
      };
    }) as unknown as typeof globalThis.fetch;
    const result = await generateStoryWithMeta(makeOrder(), { fetch: fakeFetch });
    assert.equal(result.meta.source, 'ollama_page_prose');
    assert.ok(calls > 24, 'expected at least one retry beyond 24 base page calls');
  });
});

test('story meta: brave-explorer home sharing page keeps the listening-stone payoff and rejects a surprise bird reveal', async () => {
  await withEnv('HSB_ENABLE_OLLAMA_PAGE_PROSE', 'true', async () => {
    await withEnv('HSB_OLLAMA_PAGE_PROSE_MODEL', 'qwen2.5:14b', async () => {
      let calls = 0;
      const order = createOrderRecord(
        {
          childName: 'Lukas Kaplun',
          bookFormat: 'classic',
          email: 'lukas@example.com',
          theme: 'brave-explorer',
          lesson: 'courage',
          occasion: 'birthday',
          characterNotes: 'loves frogs',
          appearanceOptions: 'brown hair, hazel eyes',
          childPronouns: 'he/him',
        },
        { id: 'ord_listening_stones_guard', now: '2026-05-04T14:00:00Z' },
      );
      const fakeFetch = (async (_input, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body ?? '{}'));
        const prompt = String(body.messages?.[1]?.content ?? '');
        const pageMatch = prompt.match(/PAGE NUMBER:\s+(\d+) of 24/);
        const pageNumber = Number(pageMatch?.[1] ?? '0');
        const content = pageNumber === 23
          ? 'Lukas sets down the stone on the porch rail. His family gathers close, leaning to hear. Suddenly, soft rustling sounds come from inside the stone wrapping. They unwrap it carefully and find a tiny chirping bird nestled inside. Everyone gasps in wonder.'
          : 'Lukas cups the smooth stone and listens. Warm evening air moves through the leaves. The path home feels close and calm.';
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ message: { content } }),
        };
      }) as unknown as typeof globalThis.fetch;
      const result = await generateStoryWithMeta(order, { fetch: fakeFetch });
      assert.equal(result.meta.source, 'ollama_page_prose');
      const sharingPage = result.story.pages[22]!;
      assert.doesNotMatch(sharingPage.story, /chirp|nestled inside|inside the stone|inside the wrapping|tiny\s+bird/i);
      assert.match(sharingPage.story, /hum|sound|rustl|call|listen/i);
    });
  });
});

test('story meta: explicit HSB_ENABLE_OPENAI_STORY=true + OpenAI 200 OK → source=openai_chat, model=gpt-4o-mini', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    await withEnv('HSB_ENABLE_OPENAI_STORY', 'true', async () => {
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
});

test('story meta: explicit HSB_ENABLE_OPENAI_STORY=true + OpenAI 500 → source=template_after_openai_failure with truncated fallbackError', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    await withEnv('HSB_ENABLE_OPENAI_STORY', 'true', async () => {
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
      assert.ok(result.story.title);
    });
  });
});

test('story meta: explicit HSB_ENABLE_OPENAI_STORY=true + OpenAI invalid JSON → fallback path with parse error', async () => {
  await withEnv('OPENAI_API_KEY', 'test-key', async () => {
    await withEnv('HSB_ENABLE_OPENAI_STORY', 'true', async () => {
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
});
