import test from 'node:test';
import assert from 'node:assert/strict';

import { generateStoryImageResults } from '../src/lib/image-generator.ts';

function withEnv(key: string, value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

test('generateStoryImageResults limits concurrency and preserves input order', async () => {
  await withEnv('HSB_IMAGE_GEN_CONCURRENCY', '2', async () => {
    await withEnv('FAL_KEY', 'test-key', async () => {
      let active = 0;
      let maxActive = 0;

      const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const prompt = String(body.prompt ?? 'missing');
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, prompt === 'p1' ? 30 : 10));
        active -= 1;
        return new Response(
          JSON.stringify({ images: [{ url: `https://img.example/${prompt}.png` }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof globalThis.fetch;

      const prompts = ['p0', 'p1', 'p2', 'p3'];
      const results = await generateStoryImageResults(prompts, {
        fetch,
        referenceImageUrl: 'https://photo.example/kid.jpg',
      });

      assert.equal(maxActive, 2);
      assert.deepEqual(
        results.map((r) => r.imageUrl),
        prompts.map((p) => `https://img.example/${p}.png`),
      );
    });
  });
});
