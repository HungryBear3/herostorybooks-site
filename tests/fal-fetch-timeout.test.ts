/**
 * Diagnosis: ord_a3a8e0cb18bb44ee got stuck at fulfillmentStatus=
 * 'generating_images' with pageArtifacts=[] and lastError=null. The
 * cause was the FAL providers calling fetch with no AbortSignal — when
 * a FAL request hangs and the serverless function exceeds its time
 * budget, runWithRetry's catch never fires and the order is silently
 * stuck.
 *
 * This test asserts the providers now (a) pass an AbortSignal on every
 * fetch call, and (b) surface an aborted/throwing fetch as a structured
 * GeneratedImageResult with `error` populated, never as an unhandled
 * hang.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { falImageProvider } from '../src/lib/image-provider-fal.ts';
import { falEditImageProvider } from '../src/lib/image-provider-fal-edit.ts';

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const k of Object.keys(values)) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  });
}

test('falImageProvider: passes an AbortSignal on every fetch call', async () => {
  await withEnv({ FAL_KEY: 'test-key' }, async () => {
    let capturedSignal: AbortSignal | undefined | null = null;
    const spy = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ images: [{ url: 'https://x/y.png' }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await falImageProvider.generate({ prompt: 'p' }, { fetch: spy });
    assert.ok(capturedSignal instanceof AbortSignal, 'falImageProvider must pass init.signal');
    assert.equal(capturedSignal!.aborted, false);
  });
});

test('falEditImageProvider: passes an AbortSignal on every fetch call', async () => {
  await withEnv({ FAL_KEY: 'test-key' }, async () => {
    let capturedSignal: AbortSignal | undefined | null = null;
    const spy = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal | undefined;
      return new Response(JSON.stringify({ images: [{ url: 'https://x/y.png' }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await falEditImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch: spy },
    );
    assert.ok(capturedSignal instanceof AbortSignal, 'falEditImageProvider must pass init.signal');
    assert.equal(capturedSignal!.aborted, false);
  });
});

test('falImageProvider: surfaces aborted/timed-out fetch as a structured error, never hangs', async () => {
  await withEnv({ FAL_KEY: 'test-key' }, async () => {
    const abortSpy = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      // Simulate what AbortSignal.timeout fires when the deadline elapses.
      const err = new Error('The operation was aborted due to timeout');
      (err as Error & { name: string }).name = 'TimeoutError';
      throw err;
    }) as unknown as typeof globalThis.fetch;

    const result = await falImageProvider.generate({ prompt: 'p' }, { fetch: abortSpy });
    assert.equal(result.imageUrl, null);
    assert.match(String(result.error), /aborted|timeout/i);
  });
});

test('falEditImageProvider: surfaces aborted/timed-out fetch as a structured error, never hangs', async () => {
  await withEnv({ FAL_KEY: 'test-key' }, async () => {
    const abortSpy = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const err = new Error('The operation was aborted due to timeout');
      (err as Error & { name: string }).name = 'TimeoutError';
      throw err;
    }) as unknown as typeof globalThis.fetch;

    const result = await falEditImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch: abortSpy },
    );
    assert.equal(result.imageUrl, null);
    assert.match(String(result.error), /aborted|timeout/i);
  });
});
