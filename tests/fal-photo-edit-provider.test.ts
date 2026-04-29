/**
 * fal_edit (photo-conditioned FAL) provider contract.
 *
 * Verifies:
 * - request body includes `image_urls` from referenceImageUrl + imageUrls
 * - returns conditioning='photo_edit' on success
 * - hard-fails fast (returns null + structured error) when no reference image
 * - propagates the reference URL into result.referencePhotoUrl
 * - missing FAL_KEY produces a structured error, not a thrown exception
 * - non-2xx response surfaces error string with status
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { falEditImageProvider } from '../src/lib/image-provider-fal-edit.ts';

function makeFakeFetch(captured: { url: string; body: unknown; status?: number; payload?: unknown }[]) {
  const fn = async (url: RequestInfo | URL, init?: RequestInit) => {
    const slot = captured[captured.length - 1] ?? {};
    captured[captured.length - 1] = { ...slot, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    const status = slot.status ?? 200;
    const payload = slot.payload ?? { images: [{ url: 'https://fake.example/edit.png' }] };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    } as unknown as Response;
  };
  return fn as typeof globalThis.fetch;
}

function withFalKey<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> | T {
  const original = process.env.FAL_KEY;
  if (value === undefined) delete process.env.FAL_KEY;
  else process.env.FAL_KEY = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = original;
  }
}

test('fal_edit: posts image_urls + prompt + numeric seed', async () => {
  await withFalKey('test-key', async () => {
    const captured: { url?: string; body?: unknown }[] = [{}];
    const fetch = makeFakeFetch(captured);
    const result = await falEditImageProvider.generate(
      { prompt: 'a starry forest', referenceImageUrl: 'https://photos.example/kid.jpg' },
      { fetch },
    );
    assert.equal(result.imageUrl, 'https://fake.example/edit.png');
    assert.equal(result.error, null);
    const body = captured[0]?.body as { prompt?: string; image_urls?: string[]; seed?: number };
    assert.equal(body.prompt, 'a starry forest');
    assert.deepEqual(body.image_urls, ['https://photos.example/kid.jpg']);
    assert.equal(typeof body.seed, 'number');
  });
});

test('fal_edit: returns conditioning="photo_edit" + referencePhotoUrl on success', async () => {
  await withFalKey('test-key', async () => {
    const captured: { url?: string; body?: unknown }[] = [{}];
    const result = await falEditImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos.example/kid.jpg' },
      { fetch: makeFakeFetch(captured) },
    );
    assert.equal(result.conditioning, 'photo_edit');
    assert.equal(result.referencePhotoUrl, 'https://photos.example/kid.jpg');
    assert.equal(result.provider, 'fal_edit');
  });
});

test('fal_edit: dedupes + concatenates imageUrls + referenceImageUrl in order', async () => {
  await withFalKey('test-key', async () => {
    const captured: { url?: string; body?: unknown }[] = [{}];
    await falEditImageProvider.generate(
      {
        prompt: 'p',
        imageUrls: ['https://x/a.jpg', 'https://x/b.jpg'],
        referenceImageUrl: 'https://x/a.jpg', // duplicate
      },
      { fetch: makeFakeFetch(captured) },
    );
    const body = captured[0]?.body as { image_urls?: string[] };
    assert.deepEqual(body.image_urls, ['https://x/a.jpg', 'https://x/b.jpg']);
  });
});

test('fal_edit: hard-fails fast when no reference image is supplied', async () => {
  await withFalKey('test-key', async () => {
    const captured: { url?: string; body?: unknown }[] = [{}];
    const fetchSpy = makeFakeFetch(captured);
    const result = await falEditImageProvider.generate(
      { prompt: 'no photo' },
      { fetch: fetchSpy },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /requires at least one reference image/i);
    assert.equal(result.provider, 'fal_edit');
    assert.equal(result.conditioning, 'photo_edit');
    // We must NOT have made an HTTP call — provider failed locally.
    assert.equal(captured[0]?.url, undefined);
  });
});

test('fal_edit: missing FAL_KEY returns structured error (not throw)', async () => {
  await withFalKey(undefined, async () => {
    const result = await falEditImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://x/a.jpg' },
      {},
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /FAL_KEY not set/);
    assert.equal(result.provider, 'fal_edit');
  });
});

test('fal_edit: surfaces HTTP-error status in error string', async () => {
  await withFalKey('test-key', async () => {
    const captured: { url?: string; body?: unknown; status?: number; payload?: unknown }[] = [
      { status: 503, payload: 'upstream busy' },
    ];
    const result = await falEditImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://x/a.jpg' },
      { fetch: makeFakeFetch(captured) },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /FAL 503/);
    assert.equal(result.referencePhotoUrl, 'https://x/a.jpg');
  });
});
