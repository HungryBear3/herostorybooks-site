/**
 * Story generator must request the right page count per format
 * (print redesign — slice 1).
 *
 * Verified through two surfaces:
 *   1. The OpenAI user prompt — assert it asks for 24 / 24 / 32 pages.
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

import {
  generateStoryWithMeta,
  buildSafeImagePrompt,
  getLockedPageProse,
} from '../src/lib/story-generator.ts';
import { createOrderRecord, type BookFormat, type OrderRecord } from '../src/lib/orders.ts';
import type { StoryPlanPage } from '../src/lib/story-planner.ts';

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

test('OpenAI prompt: digital order asks for 24 pages', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      await generateStoryWithMeta(makeOrder('digital'), { fetch });
      const prompt = userPromptOf(captured);
      assert.match(prompt, /Write a 24-page personalized children's storybook/);
      assert.match(prompt, /Write exactly 24 pages\./);
      assert.match(prompt, /Pace the story across 24 pages/);
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

test('OpenAI prompt: digital now uses the long-form arc', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      await generateStoryWithMeta(makeOrder('digital'), { fetch });
      const prompt = userPromptOf(captured);
      assert.match(prompt, /Pace the story across 24 pages/);
      assert.doesNotMatch(prompt, /setup → adventure begins → challenge/);
    },
  );
});

// ── Template fallback path ───────────────────────────────────────────────────

test('template fallback: digital order produces exactly 24 pages', async () => {
  await withEnv({ OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined }, async () => {
    const result = await generateStoryWithMeta(makeOrder('digital'));
    assert.equal(result.meta.source, 'template');
    assert.equal(result.story.pages.length, 24);
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

test('template fallback: long-form classic should not just repeat the same short sample arc', async () => {
  await withEnv({ OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined }, async () => {
    const result = await generateStoryWithMeta(makeOrder('classic'));
    const sceneTitles = result.story.pages.map((p) => p.sceneTitle);
    const imagePrompts = result.story.pages.map((p) => p.imagePrompt);

    assert.notEqual(result.story.pages[0]?.story, result.story.pages[5]?.story, 'page 6 should not repeat page 1');
    assert.notEqual(result.story.pages[1]?.imagePrompt, result.story.pages[6]?.imagePrompt, 'page 7 should not repeat page 2 prompt');
    assert.ok(new Set(sceneTitles).size >= 18, 'long-form classic should have meaningfully varied scene titles');
    assert.ok(new Set(imagePrompts).size >= 18, 'long-form classic should have meaningfully varied image prompts');
  });
});

test('template fallback: long-form classic prose should avoid visible template boilerplate', async () => {
  await withEnv({ OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined }, async () => {
    const result = await generateStoryWithMeta(makeOrder('classic'));
    const joined = result.story.pages.map((p) => p.story).join('\n');
    assert.doesNotMatch(joined, /The whole adventure felt/i);
    assert.doesNotMatch(joined, /shaped by/i);
    assert.doesNotMatch(joined, /Page by page,/i);
    assert.doesNotMatch(joined, /On birthday/i);
    assert.doesNotMatch(joined, /journey felt especially meaningful/i);
  });
});

test('template fallback: Lukas dragon quest prose avoids broken planner/template artifacts', async () => {
  await withEnv(
    {
      OPENAI_API_KEY: undefined,
      HSB_ENABLE_OPENAI_STORY: undefined,
      HSB_ENABLE_OPENAI_PAGE_PROSE: undefined,
      HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined,
    },
    async () => {
      const order = createOrderRecord(
        {
          childName: 'Lukas Kaplun',
          childAge: '5',
          bookFormat: 'classic',
          email: 'a@b.com',
          theme: 'dragon-quest',
          lesson: 'courage',
          occasion: 'birthday',
          childPronouns: 'he/him',
          appearanceOptions: JSON.stringify({ skinTone: 'medium', hairStyle: 'straight-dark' }),
        },
        { id: 'ord_fmt_lukas_dragon', now: '2026-05-01T10:00:00Z' },
      );

      const result = await generateStoryWithMeta(order);
      const joined = result.story.pages.map((p) => p.story).join('\n');

      assert.equal(result.story.pages.length, 24);
      assert.doesNotMatch(joined, /The moment shifts/i);
      assert.doesNotMatch(joined, /Lukas Kaplun/);
      assert.doesNotMatch(joined, /\bis at (castle|moonlit|dragon|ember|mountain|warm)\b/i);
      assert.doesNotMatch(joined, /where parrots crack the morning quiet/i);
      assert.doesNotMatch(joined, /where sun stripes the ground/i);
      assert.doesNotMatch(joined, /\.[a-z]/, 'sentences should not restart with lowercase letters');

      const endings = result.story.pages.map((p) => p.story.split('.').at(-2)?.trim() ?? '');
      assert.ok(new Set(endings).size >= 10, 'page endings should not repeat a single planner-template line');
    },
  );
});

test('template fallback: character anchor carries structured appearance details from intake', async () => {
  await withEnv({ OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined }, async () => {
    const order = createOrderRecord(
      {
        childName: 'Luna',
        bookFormat: 'classic',
        email: 'a@b.com',
        theme: 'brave-explorer',
        lesson: 'courage',
        occasion: 'birthday',
        appearanceOptions: JSON.stringify({ skinTone: 'deep', hairStyle: 'short curly black hair', eyewear: 'none' }),
      },
      { id: 'ord_fmt_anchor', now: '2026-05-01T10:00:00Z' },
    );
    const result = await generateStoryWithMeta(order);
    assert.match(result.story.characterDescription, /deep/i);
    assert.match(result.story.characterDescription, /short curly black hair/i);
  });
});


test('OpenAI prompt: parent hero is not framed as a child and includes recipient context', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      const order = createOrderRecord(
        {
          heroName: 'Dad',
          childName: 'Dad',
          heroType: 'parent',
          heroAgeOrStage: 'adult',
          recipientName: 'Lukas',
          recipientRelationship: 'Dad to Lukas',
          bookFormat: 'digital',
          email: 'parent@example.com',
          theme: 'brave-explorer',
          lesson: 'courage',
          occasion: 'birthday',
        },
        { id: 'ord_parent_prompt', now: '2026-07-07T10:00:00Z' },
      );
      await generateStoryWithMeta(order, { fetch });
      const prompt = userPromptOf(captured);
      assert.match(prompt, /Hero's name: Dad/);
      assert.match(prompt, /Hero type: the parent hero/);
      assert.match(prompt, /Age \/ life stage: adult/);
      assert.match(prompt, /Recipient\/audience: Lukas/);
      assert.match(prompt, /Hero relationship: Dad to Lukas/);
      assert.doesNotMatch(prompt, /Age: adult/);
    },
  );
});


test('template fallback is blocked for non-child primary heroes', async () => {
  await withEnv(
    { OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_STORY: undefined },
    async () => {
      const order = createOrderRecord(
        {
          heroName: 'Grandma Rose',
          childName: 'Grandma Rose',
          heroType: 'grandparent',
          heroAgeOrStage: 'grandparent',
          recipientName: 'Lukas',
          recipientRelationship: 'Grandma to Lukas',
          bookFormat: 'digital',
          email: 'grandma@example.com',
          theme: 'brave-explorer',
          lesson: 'courage',
          occasion: 'birthday',
        },
        { id: 'ord_grandparent_no_template', now: '2026-07-07T10:00:00Z' },
      );
      await assert.rejects(
        () => generateStoryWithMeta(order),
        /template fallback is disabled for non-child primary heroes/,
      );
    },
  );
});


// ── C1: hero-type-aware generator prompts (parent/grandparent beta) ───────────
//
// Contract: adult primary heroes (parent/grandparent) must never be framed or
// illustrated as a child, and the child path must keep its existing child-safe
// behavior byte-for-byte.

// Child-coded PROTAGONIST framing that must not appear for an adult hero. The
// adult rules are written positively (no "young boy"/"young girl"/"child named"
// tokens) precisely so this token check is unambiguous.
const CHILD_PROTAGONIST_FRAMING = /young boy|young girl|child named/i;
const HERO_IS_A_CHILD = /\bhero (?:is|as) a (?:child|kid|young)\b/i;

function systemPromptOf(captured: CapturedRequest): string {
  const systemMessage = captured.body?.messages?.find((m) => m.role === 'system');
  return systemMessage?.content ?? '';
}

function makeBeat(page: number): StoryPlanPage {
  return {
    page,
    arc_position: 'resolution',
    beat_summary: 'the hero finds a smooth stone',
    setting: 'a jungle path',
    emotional_tone: 'wonder',
    shot_type: 'wide',
    key_object_or_detail: 'a smooth stone',
    who_else_in_frame: 'a small bird',
    text_layout: 'bottom',
  } as unknown as StoryPlanPage;
}

function adultHeroOrder(heroType: 'parent' | 'grandparent'): OrderRecord {
  return createOrderRecord(
    {
      heroName: heroType === 'parent' ? 'Dad' : 'Grandma Rose',
      childName: heroType === 'parent' ? 'Dad' : 'Grandma Rose',
      heroType,
      heroAgeOrStage: heroType === 'parent' ? 'adult' : 'grandparent',
      recipientName: 'Lukas',
      recipientRelationship: heroType === 'parent' ? 'Dad to Lukas' : 'Grandma to Lukas',
      childPronouns: heroType === 'parent' ? 'he/him' : 'she/her',
      bookFormat: 'digital',
      email: 'hero@example.com',
      theme: 'brave-explorer',
      lesson: 'courage',
      occasion: 'birthday',
    },
    { id: `ord_c1_${heroType}`, now: '2026-07-07T10:00:00Z' },
  );
}

for (const heroType of ['parent', 'grandparent'] as const) {
  test(`OpenAI prompt: ${heroType} hero is written as an adult, never as a child`, async () => {
    await withEnv(
      { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
      async () => {
        const { fetch, captured } = makeOpenAiSpyFetch();
        await generateStoryWithMeta(adultHeroOrder(heroType), { fetch });
        const user = userPromptOf(captured);
        const system = systemPromptOf(captured);

        // No child-coded protagonist framing leaks onto the adult hero...
        assert.doesNotMatch(user, CHILD_PROTAGONIST_FRAMING);
        assert.doesNotMatch(user, HERO_IS_A_CHILD);
        // ...and the prompt affirmatively frames the hero as an adult.
        assert.match(user, /is a grown ADULT/);
        assert.match(user, /do not infantilize the hero/);
        // System prompt carries the adult clause too.
        assert.match(system, /hero of THIS book is a grown adult/i);
      },
    );
  });
}

test('OpenAI prompt: child hero keeps its child-safe visual rules (child path preserved)', async () => {
  await withEnv(
    { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_STORY: 'true' },
    async () => {
      const { fetch, captured } = makeOpenAiSpyFetch();
      const order = createOrderRecord(
        {
          childName: 'Lukas',
          childPronouns: 'he/him',
          childAge: '5',
          bookFormat: 'digital',
          email: 'child@example.com',
          theme: 'brave-explorer',
          lesson: 'courage',
          occasion: 'birthday',
        },
        { id: 'ord_c1_child', now: '2026-07-07T10:00:00Z' },
      );
      await generateStoryWithMeta(order, { fetch });
      const user = userPromptOf(captured);
      const system = systemPromptOf(captured);

      // Existing child-safe behavior must survive untouched.
      assert.match(user, /describe and illustrate the hero as a young boy/);
      assert.doesNotMatch(user, /is a grown ADULT/);
      // Child system prompt is the original, without the adult clause.
      assert.doesNotMatch(system, /grown adult/i);
    },
  );
});

test('buildSafeImagePrompt: adult hero renders as adult; child/default keep child-safe guidance', () => {
  const beat = makeBeat(3);
  const adult = buildSafeImagePrompt({ childName: 'Dad', heroType: 'parent', themeDescription: 'a space voyage', page: 3, beat });
  const child = buildSafeImagePrompt({ childName: 'Luna', heroType: 'child', themeDescription: 'a space voyage', page: 3, beat });
  const noHeroType = buildSafeImagePrompt({ childName: 'Luna', themeDescription: 'a space voyage', page: 3, beat });

  assert.match(adult, /Render the hero as a grown adult/);
  assert.match(adult, /adult explorer\/astronaut clothing/);
  assert.doesNotMatch(adult, /child-safe explorer/);
  assert.doesNotMatch(adult, /Keep the child’s face/);

  assert.match(child, /Keep the child’s face fully visible/);
  assert.match(child, /child-safe explorer\/astronaut clothing/);
  // Omitting heroType must behave exactly like an explicit child hero.
  assert.equal(noHeroType, child);
});


function makePageProseFetch(kind: 'openai' | 'ollama'): typeof globalThis.fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
    const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
    const protagonist = user.match(/^PROTAGONIST:\s*(.+)$/m)?.[1]?.trim() ?? 'Dad';
    const prose = `${protagonist} steps onto the bright trail and lifts a small brass compass. Lukas watches nearby as he chooses the brave path forward.`;
    if (kind === 'openai') {
      return new Response(JSON.stringify({ choices: [{ message: { content: prose } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: { content: prose } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
}

for (const provider of ['openai', 'ollama'] as const) {
  test(`${provider} page-prose path: parent hero image prompts keep adult guidance`, async () => {
    const env = provider === 'openai'
      ? { OPENAI_API_KEY: 'sk-test', HSB_ENABLE_OPENAI_PAGE_PROSE: 'true', HSB_ENABLE_OLLAMA_PAGE_PROSE: undefined }
      : { OPENAI_API_KEY: undefined, HSB_ENABLE_OPENAI_PAGE_PROSE: undefined, HSB_ENABLE_OLLAMA_PAGE_PROSE: 'true', HSB_OLLAMA_PAGE_PROSE_MODEL: 'synthetic-test' };

    await withEnv(env, async () => {
      const result = await generateStoryWithMeta(adultHeroOrder('parent'), { fetch: makePageProseFetch(provider) });
      const prompts = result.story.pages.map((p) => p.imagePrompt).join('\n');
      assert.equal(result.story.pages.length, 24);
      assert.match(prompts, /Render the hero as a grown adult/);
      assert.match(prompts, /adult explorer\/astronaut clothing|grown adult/);
      assert.doesNotMatch(prompts, /child-safe explorer/);
      assert.doesNotMatch(prompts, /Keep the child’s face/);
    });
  });
}

test('getLockedPageProse: child hero gets the locked sample; non-child hero gets null', () => {
  const beat = makeBeat(23); // pageCount 24 → pageCount - 1, where the lock applies
  const child = createOrderRecord(
    { childName: 'Lukas', bookFormat: 'digital', email: 'child@example.com', theme: 'brave-explorer', lesson: 'courage', occasion: 'birthday' },
    { id: 'ord_c1_lock_child', now: '2026-07-07T10:00:00Z' },
  );
  const grandparent = adultHeroOrder('grandparent');

  assert.ok((getLockedPageProse(child, beat, 24) ?? '').length > 0, 'child hero should still receive the locked brave-explorer prose');
  assert.equal(getLockedPageProse(grandparent, beat, 24), null, 'non-child hero must never receive the child-coded locked prose');
});
