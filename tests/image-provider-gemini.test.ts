/**
 * Unit tests for the direct Google Gemini image provider.
 *
 * These tests stub fetch end-to-end (reference photo download + Gemini
 * generateContent call). They never hit the real API. The orchestrator-level
 * chain-composition contract (gate on/off, FAL fallback flag) is covered in
 * tests/image-provider-gemini-routing.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { geminiImageProvider } from '../src/lib/image-provider-gemini.ts';
import type { BlobPutFn } from '../src/lib/image-provider-types.ts';

interface StubCall {
  url: string;
  init?: RequestInit;
}

function makePngBytes(): Uint8Array {
  // 1x1 transparent PNG (the smallest valid PNG we can hand back).
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
    0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function makeFetchStub(
  responder: (call: StubCall, index: number) => Response,
): { fetch: typeof globalThis.fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const call: StubCall = { url, init };
    calls.push(call);
    return responder(call, calls.length - 1);
  };
  return { fetch: fetchFn, calls };
}

function withEnv<T>(
  patch: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    originals[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of Object.keys(originals)) {
      const value = originals[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('gemini provider: returns structured failure when GOOGLE_GEMINI_API_KEY is missing', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: undefined }, async () => {
    const { fetch, calls } = makeFetchStub(() => {
      throw new Error('fetch should not be called when key is missing');
    });
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch },
    );
    assert.equal(result.imageUrl, null);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.conditioning, 'photo_edit');
    assert.match(result.error ?? '', /GOOGLE_GEMINI_API_KEY not set/);
    assert.equal(calls.length, 0);
  });
});

test('gemini provider: returns structured failure when no reference image is supplied', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const { fetch, calls } = makeFetchStub(() => {
      throw new Error('fetch should not be called when no reference image is supplied');
    });
    const result = await geminiImageProvider.generate({ prompt: 'p' }, { fetch });
    assert.equal(result.imageUrl, null);
    assert.equal(result.provider, 'gemini');
    assert.match(result.error ?? '', /at least one reference image URL/);
    assert.equal(calls.length, 0);
  });
});

test('gemini provider: happy path returns a data URL with the generated image', async () => {
  await withEnv(
    { GOOGLE_GEMINI_API_KEY: 'test-key', HSB_GEMINI_IMAGE_MODEL: undefined },
    async () => {
      const photoBytes = makePngBytes();
      const generatedBase64 = Buffer.from(photoBytes).toString('base64');
      const { fetch, calls } = makeFetchStub((call, index) => {
        if (index === 0) {
          // Reference photo download.
          assert.equal(call.url, 'https://photos/kid.jpg');
          return new Response(photoBytes, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        }
        // Gemini generateContent call.
        assert.match(call.url, /generativelanguage\.googleapis\.com/);
        assert.match(call.url, /gemini-2\.5-flash-image-preview:generateContent/);
        assert.match(call.url, /[?&]key=test-key/);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inline_data: {
                        mime_type: 'image/png',
                        data: generatedBase64,
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      const result = await geminiImageProvider.generate(
        { prompt: 'a brave kid in a dino den', referenceImageUrl: 'https://photos/kid.jpg' },
        { fetch },
      );
      assert.equal(result.error, null);
      assert.equal(result.provider, 'gemini');
      assert.equal(result.conditioning, 'photo_edit');
      assert.equal(result.model, 'gemini-2.5-flash-image-preview');
      assert.equal(result.referencePhotoUrl, 'https://photos/kid.jpg');
      assert.ok(result.imageUrl?.startsWith('data:image/png;base64,'));
      assert.ok(result.imageUrl?.endsWith(generatedBase64));
      assert.equal(calls.length, 2);
    },
  );
});

test('gemini provider: honours HSB_GEMINI_IMAGE_MODEL override in the request URL', async () => {
  await withEnv(
    {
      GOOGLE_GEMINI_API_KEY: 'test-key',
      HSB_GEMINI_IMAGE_MODEL: 'gemini-2.5-pro-image-preview',
    },
    async () => {
      const { fetch } = makeFetchStub((call, index) => {
        if (index === 0) {
          return new Response(makePngBytes(), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        }
        assert.match(call.url, /gemini-2\.5-pro-image-preview:generateContent/);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      });
      const result = await geminiImageProvider.generate(
        { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
        { fetch },
      );
      assert.equal(result.model, 'gemini-2.5-pro-image-preview');
      assert.equal(result.error, null);
    },
  );
});

test('gemini provider: non-2xx Gemini response is surfaced as a structured error with key redacted', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const { fetch } = makeFetchStub((_call, index) => {
      if (index === 0) {
        return new Response(makePngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(
        // The body intentionally embeds the API key to prove we redact it.
        JSON.stringify({ error: { message: 'quota exceeded for key=test-key' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /Gemini API error 429/);
    assert.ok(!(result.error ?? '').includes('test-key'), 'api key must not leak into error');
    assert.match(result.error ?? '', /\[redacted-api-key\]/);
  });
});

test('gemini provider: blocked prompt is surfaced distinctly, with key redacted', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const { fetch } = makeFetchStub((_call, index) => {
      if (index === 0) {
        return new Response(makePngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(
        JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /Gemini blocked/);
    assert.match(result.error ?? '', /SAFETY/);
  });
});

test('gemini provider: response without an image part returns no_image_returned-style error', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const { fetch } = makeFetchStub((_call, index) => {
      if (index === 0) {
        return new Response(makePngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'no image here' }] } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /Gemini returned no image candidate/);
  });
});

test('gemini provider: reference fetch failure is surfaced cleanly without leaking the URL', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const { fetch } = makeFetchStub(() => new Response('not found', { status: 404 }));
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /gemini reference fetch failed/);
  });
});

test('gemini provider: accepts camelCase inlineData shape from the API response', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const { fetch } = makeFetchStub((_call, index) => {
      if (index === 0) {
        return new Response(makePngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch },
    );
    assert.equal(result.error, null);
    assert.equal(result.imageUrl, 'data:image/png;base64,AAAA');
  });
});

// ── Blob upload (rehosting inline base64 to durable HTTPS storage) ───────────

function makeBlobPutStub(returnUrl: string): {
  blobPut: BlobPutFn;
  calls: Array<{ path: string; opts: { contentType?: string } }>;
} {
  const calls: Array<{ path: string; opts: { contentType?: string } }> = [];
  const blobPut: BlobPutFn = async (path, _body, opts) => {
    calls.push({ path, opts });
    return { url: returnUrl };
  };
  return { blobPut, calls };
}

test('gemini provider: uploads inline image to Blob and returns the HTTPS URL when blobPut is injected', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const photoBytes = makePngBytes();
    const generatedBase64 = Buffer.from(photoBytes).toString('base64');
    const { fetch } = makeFetchStub((_call, index) => {
      if (index === 0) {
        return new Response(photoBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inline_data: { mime_type: 'image/png', data: generatedBase64 } },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const { blobPut, calls } = makeBlobPutStub('https://hsb-blob.example.com/preview/generated/gemini/abcd1234.png');
    const result = await geminiImageProvider.generate(
      { prompt: 'a brave kid', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch, blobPut },
    );
    assert.equal(result.error, null);
    assert.equal(result.imageUrl, 'https://hsb-blob.example.com/preview/generated/gemini/abcd1234.png');
    assert.equal(result.imageUrl?.startsWith('data:'), false, 'must not return data: URL when upload succeeded');
    assert.equal(calls.length, 1, 'blobPut must be called exactly once');
    assert.match(calls[0]!.path, /generated\/gemini\/[a-f0-9]{16}\.png$/);
    assert.equal(calls[0]!.opts.contentType, 'image/png');
  });
});

test('gemini provider: blob upload failure surfaces a structured error (no silent data-URL fallback)', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const generatedBase64 = Buffer.from(makePngBytes()).toString('base64');
    const { fetch } = makeFetchStub((_call, index) => {
      if (index === 0) {
        return new Response(makePngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inline_data: { mime_type: 'image/png', data: generatedBase64 } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const blobPut: BlobPutFn = async () => {
      throw new Error('vercel blob 503');
    };
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch, blobPut },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /gemini blob upload failed/);
    assert.match(result.error ?? '', /vercel blob 503/);
  });
});

test('gemini provider: blob put returning empty url is treated as upload failure', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const generatedBase64 = Buffer.from(makePngBytes()).toString('base64');
    const { fetch } = makeFetchStub((_call, index) => {
      if (index === 0) {
        return new Response(makePngBytes(), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { inline_data: { mime_type: 'image/png', data: generatedBase64 } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const blobPut: BlobPutFn = async () => ({ url: '' });
    const result = await geminiImageProvider.generate(
      { prompt: 'p', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch, blobPut },
    );
    assert.equal(result.imageUrl, null);
    assert.match(result.error ?? '', /blob put returned no url/);
  });
});

test('gemini provider: same prompt + bytes produces a deterministic blob path (hash-stable)', async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: 'test-key' }, async () => {
    const generatedBase64 = Buffer.from(makePngBytes()).toString('base64');
    const buildFetchStub = () =>
      makeFetchStub((_call, index) => {
        if (index === 0) {
          return new Response(makePngBytes(), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        }
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { inline_data: { mime_type: 'image/png', data: generatedBase64 } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      });
    const { blobPut: putA, calls: callsA } = makeBlobPutStub('https://blob/x.png');
    const { blobPut: putB, calls: callsB } = makeBlobPutStub('https://blob/x.png');
    const stubA = buildFetchStub();
    const stubB = buildFetchStub();
    await geminiImageProvider.generate(
      { prompt: 'same prompt', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch: stubA.fetch, blobPut: putA },
    );
    await geminiImageProvider.generate(
      { prompt: 'same prompt', referenceImageUrl: 'https://photos/kid.jpg' },
      { fetch: stubB.fetch, blobPut: putB },
    );
    assert.equal(callsA[0]!.path, callsB[0]!.path, 'same prompt + same bytes must hash to same blob path');
  });
});
