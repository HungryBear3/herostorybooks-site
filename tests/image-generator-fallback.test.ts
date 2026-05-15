/**
 * Orchestrator fallback chain:
 *   - referenceImageUrl supplied → tries Seedream edit first, then Nano Banana edit
 *   - no referenceImageUrl       → does not use a text-only fallback
 *   - photo-conditioned failure  → stays in photo-conditioned lane only
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePageImage } from '../src/lib/image-generator.ts';
import type {
  GeneratedImageResult,
  ImageProvider,
  ImageProviderInput,
} from '../src/lib/image-provider-types.ts';

function makeProvider(name: 'fal' | 'fal_edit', behavior: (input: ImageProviderInput) => GeneratedImageResult): ImageProvider {
  const calls: ImageProviderInput[] = [];
  const provider: ImageProvider & { calls: ImageProviderInput[] } = {
    name,
    calls,
    async generate(input) {
      calls.push(input);
      return behavior(input);
    },
  };
  return provider;
}

test('orchestrator: with referenceImageUrl, Seedream edit is tried first and used on success', async () => {
  const seedreamProvider = makeProvider('fal_edit', () => ({
    imageUrl: 'https://fake/seedream.png',
    provider: 'fal_edit',
    model: 'fal-ai/bytedance/seedream/v4/edit',
    promptUsed: 'p',
    conditioning: 'photo_edit',
    referencePhotoUrl: 'https://photos/kid.jpg',
    latencyMs: 1,
    error: null,
  }));
  const nanoProvider = makeProvider('fal_edit', () => ({
    imageUrl: 'https://fake/nano.png',
    provider: 'fal_edit',
    model: 'fal-ai/nano-banana/edit',
    promptUsed: 'p',
    conditioning: 'photo_edit',
    referencePhotoUrl: 'https://photos/kid.jpg',
    latencyMs: 1,
    error: null,
  }));
  const result = await generatePageImage(
    { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
    { providers: [seedreamProvider, nanoProvider] },
  );
  assert.equal(result.provider, 'fal_edit');
  assert.equal(result.model, 'fal-ai/bytedance/seedream/v4/edit');
  assert.equal(result.conditioning, 'photo_edit');
  assert.equal(result.imageUrl, 'https://fake/seedream.png');
  assert.equal((seedreamProvider as unknown as { calls: ImageProviderInput[] }).calls.length, 1);
  assert.equal((nanoProvider as unknown as { calls: ImageProviderInput[] }).calls.length, 0);
});

test('orchestrator: when Seedream fails, falls through to Nano Banana edit only', async () => {
  const seedreamProvider = makeProvider('fal_edit', () => ({
    imageUrl: null,
    provider: 'fal_edit',
    model: 'fal-ai/bytedance/seedream/v4/edit',
    promptUsed: 'p',
    conditioning: 'photo_edit',
    referencePhotoUrl: 'https://photos/kid.jpg',
    latencyMs: 1,
    error: 'simulated seedream failure',
  }));
  const nanoProvider = makeProvider('fal_edit', () => ({
    imageUrl: 'https://fake/nano.png',
    provider: 'fal_edit',
    model: 'fal-ai/nano-banana/edit',
    promptUsed: 'p',
    conditioning: 'photo_edit',
    referencePhotoUrl: 'https://photos/kid.jpg',
    latencyMs: 1,
    error: null,
  }));
  const result = await generatePageImage(
    { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
    { providers: [seedreamProvider, nanoProvider] },
  );
  assert.equal(result.provider, 'fal_edit');
  assert.equal(result.model, 'fal-ai/nano-banana/edit');
  assert.equal(result.conditioning, 'photo_edit');
  assert.equal(result.imageUrl, 'https://fake/nano.png');
  assert.equal((seedreamProvider as unknown as { calls: ImageProviderInput[] }).calls.length, 1);
  assert.equal((nanoProvider as unknown as { calls: ImageProviderInput[] }).calls.length, 1);
});

test('orchestrator: no referenceImageUrl → does not silently fall back to text-only output', async () => {
  const seedreamCalls: ImageProviderInput[] = [];
  const nanoCalls: ImageProviderInput[] = [];
  const seedreamProvider: ImageProvider = {
    name: 'fal_edit',
    async generate(input) {
      seedreamCalls.push(input);
      return {
        imageUrl: null,
        provider: 'fal_edit',
        model: 'fal-ai/bytedance/seedream/v4/edit',
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: null,
        latencyMs: 0,
        error: 'should-not-be-called',
      };
    },
  };
  const nanoProvider: ImageProvider = {
    name: 'fal_edit',
    async generate(input) {
      nanoCalls.push(input);
      return {
        imageUrl: null,
        provider: 'fal_edit',
        model: 'fal-ai/nano-banana/edit',
        promptUsed: input.prompt,
        conditioning: 'photo_edit',
        referencePhotoUrl: null,
        latencyMs: 0,
        error: 'should-not-be-called',
      };
    },
  };
  const result = await generatePageImage(
    { prompt: 'p' },
    { providers: [] },
  );
  assert.equal(result.imageUrl, null);
  assert.equal(result.conditioning, 'photo_edit');
  assert.match(result.error ?? '', /no photo-conditioned providers configured/i);
  assert.equal(seedreamCalls.length, 0);
  assert.equal(nanoCalls.length, 0);
});

test('orchestrator: caller-supplied openai provider is filtered when gate unset → falls through to seedream stub', async () => {
  // PR1 contract: the OpenAI gate is a no-op for default callers (the
  // default chain never contains openai). It DOES apply when a caller
  // builds its own chain. In that case openai is silently filtered out
  // unless HSB_ENABLE_OPENAI_IMAGE === 'true', and the rest of the chain
  // continues to run normally. This test guards that "no silent text-only
  // fallback" stays true even in the presence of a filtered openai entry.
  const originalGate = process.env.HSB_ENABLE_OPENAI_IMAGE;
  delete process.env.HSB_ENABLE_OPENAI_IMAGE;

  const openaiCalls: ImageProviderInput[] = [];
  const openaiProvider: ImageProvider = {
    name: 'openai',
    async generate(input) {
      openaiCalls.push(input);
      throw new Error('openai provider must not be invoked when gate is unset');
    },
  };
  const seedreamProvider = makeProvider('fal_edit', () => ({
    imageUrl: 'https://fake/seedream.png',
    provider: 'fal_edit',
    model: 'fal-ai/bytedance/seedream/v4/edit',
    promptUsed: 'p',
    conditioning: 'photo_edit',
    referencePhotoUrl: 'https://photos/kid.jpg',
    latencyMs: 1,
    error: null,
  }));

  try {
    const result = await generatePageImage(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { providers: [openaiProvider, seedreamProvider] },
    );
    assert.equal(openaiCalls.length, 0);
    assert.equal(
      (seedreamProvider as unknown as { calls: ImageProviderInput[] }).calls.length,
      1,
    );
    assert.equal(result.provider, 'fal_edit');
    assert.equal(result.conditioning, 'photo_edit');
    assert.equal(result.imageUrl, 'https://fake/seedream.png');
  } finally {
    if (originalGate === undefined) delete process.env.HSB_ENABLE_OPENAI_IMAGE;
    else process.env.HSB_ENABLE_OPENAI_IMAGE = originalGate;
  }
});

test('orchestrator: when both photo-conditioned providers fail, returns the final photo-conditioned failure instead of text-only output', async () => {
  const result = await generatePageImage(
    { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
    {
      providers: [
        {
          name: 'fal_edit',
          async generate(input) {
            return {
              imageUrl: null,
              provider: 'fal_edit',
              model: 'fal-ai/bytedance/seedream/v4/edit',
              promptUsed: input.prompt,
              conditioning: 'photo_edit',
              referencePhotoUrl: 'https://photos/kid.jpg',
              latencyMs: 0,
              error: 'seedream failed',
            };
          },
        },
        {
          name: 'fal_edit',
          async generate(input) {
            return {
              imageUrl: null,
              provider: 'fal_edit',
              model: 'fal-ai/nano-banana/edit',
              promptUsed: input.prompt,
              conditioning: 'photo_edit',
              referencePhotoUrl: 'https://photos/kid.jpg',
              latencyMs: 0,
              error: 'nano failed',
            };
          },
        },
      ],
    },
  );
  assert.equal(result.provider, 'fal_edit');
  assert.equal(result.model, 'fal-ai/nano-banana/edit');
  assert.equal(result.conditioning, 'photo_edit');
  assert.equal(result.imageUrl, null);
  assert.match(result.error ?? '', /nano failed/);
});
