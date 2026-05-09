/**
 * FAL fallback provider must send a deterministic seed derived from the
 * prompt. This stabilizes flux/schnell's stochastic noise so the same
 * (anchor + basePrompt + feedback) produces the same kid on regenerate, and
 * pages of the same book share the frozen anchor portion of the prompt.
 *
 * Note: this only stabilizes noise. flux/schnell is text-only — it does not
 * condition on the customer's uploaded photo. Real face resemblance still
 * requires an identity-preserving model (see fix #3 in the audit report).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { falImageProvider } from '../src/lib/image-provider-fal.ts';

function makeFakeFetch(captured: { body: unknown }[]): typeof globalThis.fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ images: [{ url: 'https://fake.example/img.png' }] }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

test('FAL request body includes a numeric seed', async () => {
  const original = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key';
  try {
    const captured: { body: unknown }[] = [];
    const fetch = makeFakeFetch(captured);
    const result = await falImageProvider.generate(
      { prompt: 'CHARACTER ANCHOR ... A starlit nebula scene.' },
      { fetch },
    );
    assert.equal(result.error, null);
    const body = captured[0]?.body as { seed?: unknown };
    assert.equal(typeof body.seed, 'number');
    assert.ok(Number.isInteger(body.seed));
    assert.ok((body.seed as number) >= 0);
  } finally {
    if (original === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = original;
  }
});

test('FAL seed is deterministic for the same prompt', async () => {
  const original = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key';
  try {
    const a: { body: unknown }[] = [];
    const b: { body: unknown }[] = [];
    const promptText = 'identical prompt content for both calls';
    await falImageProvider.generate({ prompt: promptText }, { fetch: makeFakeFetch(a) });
    await falImageProvider.generate({ prompt: promptText }, { fetch: makeFakeFetch(b) });
    const seedA = (a[0]?.body as { seed?: number }).seed;
    const seedB = (b[0]?.body as { seed?: number }).seed;
    assert.equal(seedA, seedB);
  } finally {
    if (original === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = original;
  }
});

test('FAL seed differs for different prompts (different basePrompts in same book)', async () => {
  const original = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key';
  try {
    const a: { body: unknown }[] = [];
    const b: { body: unknown }[] = [];
    await falImageProvider.generate({ prompt: 'page 1: launchpad' }, { fetch: makeFakeFetch(a) });
    await falImageProvider.generate({ prompt: 'page 4: alien friend' }, { fetch: makeFakeFetch(b) });
    const seedA = (a[0]?.body as { seed?: number }).seed;
    const seedB = (b[0]?.body as { seed?: number }).seed;
    assert.notEqual(seedA, seedB);
  } finally {
    if (original === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = original;
  }
});
