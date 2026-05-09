import test from 'node:test';
import assert from 'node:assert/strict';

import { readBlobText } from '../src/lib/orders.ts';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test('readBlobText in public mode reads directly from blob.url via fetch and never requires @vercel/blob get()', async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response('{"id":"ord_public"}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    await withEnv({ HSB_BLOB_ACCESS_MODE: 'public' }, async () => {
      const text = await readBlobText({
        pathname: 'orders/ord_public.json',
        url: 'https://example.public.blob.vercel-storage.com/orders/ord_public.json',
        token: 'blob_rw_test',
      });
      assert.equal(text, '{"id":"ord_public"}');
      assert.deepEqual(seen, ['https://example.public.blob.vercel-storage.com/orders/ord_public.json']);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
