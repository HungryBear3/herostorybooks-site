import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { generatePageImage } from '../src/lib/image-generator.ts';
import type { ImageProvider } from '../src/lib/image-provider-types.ts';

// PR1 added the HSB_ENABLE_OPENAI_IMAGE gate. The legacy tests in this
// file use 'openai' + 'fal' as convenient placeholder provider names to
// exercise orchestrator dispatch and fallback — the test names predate the
// production decision to avoid OpenAI images. Set the gate at file scope so
// the openai-named stubs still participate; this keeps each test focused on
// its actual invariant (dispatch order, null-fallthrough, last-error
// return) without entangling it with the gate behaviour. The dedicated
// PR1 gate semantics live in tests/image-provider-routing.test.ts.
let __originalOpenAIGate: string | undefined;
before(() => {
  __originalOpenAIGate = process.env.HSB_ENABLE_OPENAI_IMAGE;
  process.env.HSB_ENABLE_OPENAI_IMAGE = 'true';
});
after(() => {
  if (__originalOpenAIGate === undefined) delete process.env.HSB_ENABLE_OPENAI_IMAGE;
  else process.env.HSB_ENABLE_OPENAI_IMAGE = __originalOpenAIGate;
});

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

test('orchestrator: when a caller supplies its own chain, providers are invoked in supplied order', async () => {
  // Original intent: assert the orchestrator does not reshuffle a
  // caller-supplied chain. The file-scope `before` hook keeps the OpenAI
  // gate set for this file so we can exercise that ordering invariant
  // independently of PR1's gate logic.
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
