import test from 'node:test';
import assert from 'node:assert/strict';

import { openaiImageProvider } from '../src/lib/image-provider-openai.ts';

// Tests for the OpenAI image provider timeout. Mirrors the FAL / Seedream
// timeout pattern: a stuck OpenAI call must not hang the fulfillment
// pipeline; instead the provider returns a structured `error` result with
// the abort message so runWithRetry can move on / fall back.

const ORIGINAL_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_TIMEOUT = process.env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS;

function setStubEnv() {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS = '50';
}

function restoreEnv() {
  if (ORIGINAL_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_TIMEOUT === undefined) delete process.env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS;
  else process.env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS = ORIGINAL_TIMEOUT;
}

test('openaiImageProvider passes AbortSignal.timeout to fetch and surfaces a timeout', async () => {
  setStubEnv();
  try {
    let observedSignal: AbortSignal | null = null;
    const hangingFetch: typeof fetch = async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
      observedSignal = signal ?? null;
      // Resolve when the caller's signal fires. Mirrors what a hung HTTPS
      // socket would look like to the provider.
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) return; // shouldn't happen; assertion below catches it
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    };

    const result = await openaiImageProvider.generate(
      { prompt: 'a friendly dragon' },
      { fetch: hangingFetch },
    );

    assert.ok(observedSignal, 'fetch must receive an AbortSignal');
    assert.equal(result.imageUrl, null);
    assert.equal(result.provider, 'openai');
    assert.ok(
      typeof result.error === 'string' && /abort|aborted|timeout/i.test(result.error),
      `Expected an abort/timeout error message; got: ${result.error}`,
    );
    // Latency should reflect that we waited at least the configured timeout.
    assert.ok(
      result.latencyMs >= 40,
      `Expected latency to reflect the timeout (~50ms), got ${result.latencyMs}`,
    );
  } finally {
    restoreEnv();
  }
});

test('openaiImageProvider returns a structured error (not a throw) on non-2xx', async () => {
  setStubEnv();
  try {
    const stubFetch: typeof fetch = async () =>
      new Response('overloaded', { status: 503 });
    const result = await openaiImageProvider.generate(
      { prompt: 'a kite' },
      { fetch: stubFetch },
    );
    assert.equal(result.imageUrl, null);
    assert.ok(
      typeof result.error === 'string' && /OpenAI 503/.test(result.error),
      `Expected 503 to surface in error; got: ${result.error}`,
    );
  } finally {
    restoreEnv();
  }
});

test('openaiImageProvider returns OPENAI_API_KEY-not-set error without fetching', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    let called = false;
    const stubFetch: typeof fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    const result = await openaiImageProvider.generate(
      { prompt: 'no-op' },
      { fetch: stubFetch },
    );
    assert.equal(called, false);
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /OPENAI_API_KEY not set/);
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});
