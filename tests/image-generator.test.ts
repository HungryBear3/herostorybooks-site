import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePageImage } from '../src/lib/image-generator.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

function makeProvider(name: 'openai' | 'fal', imageUrl: string | null, error?: string): ImageProvider {
  return {
    name,
    async generate({ prompt }) {
      return {
        imageUrl,
        provider: name,
        model: `${name}-test`,
        promptUsed: prompt,
        latencyMs: 1,
        error: error ?? null,
      };
    },
  };
}

test('orchestrator: returns OpenAI result when OpenAI succeeds', async () => {
  const result = await generatePageImage(
    { prompt: 'p' },
    {
      providers: [
        makeProvider('openai', 'https://openai/img.png'),
        makeProvider('fal', 'https://fal/img.png'),
      ],
    },
  );
  assert.equal(result.provider, 'openai');
  assert.equal(result.imageUrl, 'https://openai/img.png');
});

test('orchestrator: falls back to FAL when OpenAI returns null', async () => {
  const result = await generatePageImage(
    { prompt: 'p' },
    {
      providers: [
        makeProvider('openai', null, 'OpenAI 500'),
        makeProvider('fal', 'https://fal/img.png'),
      ],
    },
  );
  assert.equal(result.provider, 'fal');
  assert.equal(result.imageUrl, 'https://fal/img.png');
});

test('orchestrator: returns last error result when all providers fail', async () => {
  const result = await generatePageImage(
    { prompt: 'p' },
    {
      providers: [
        makeProvider('openai', null, 'OpenAI 500'),
        makeProvider('fal', null, 'FAL 500'),
      ],
    },
  );
  assert.equal(result.imageUrl, null);
  assert.equal(result.provider, 'fal');
  assert.match(result.error ?? '', /FAL/);
});

test('orchestrator: provider order is OpenAI before FAL by default contract', async () => {
  // We can't import the default array directly without env keys, but we can assert
  // that the orchestrator at least calls providers in the supplied order.
  const calls: string[] = [];
  const a: ImageProvider = {
    name: 'openai',
    async generate({ prompt }) {
      calls.push('openai');
      return { imageUrl: null, provider: 'openai', model: 'm', promptUsed: prompt, latencyMs: 0, error: 'fail' };
    },
  };
  const b: ImageProvider = {
    name: 'fal',
    async generate({ prompt }) {
      calls.push('fal');
      return { imageUrl: 'u', provider: 'fal', model: 'm', promptUsed: prompt, latencyMs: 0, error: null };
    },
  };
  await generatePageImage({ prompt: 'p' }, { providers: [a, b] });
  assert.deepEqual(calls, ['openai', 'fal']);
});
