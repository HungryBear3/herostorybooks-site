import assert from 'node:assert/strict';
import test from 'node:test';

import { readPublicOrderBlobVersioned } from '../src/lib/orders.ts';

const PATHNAME = 'orders/ord_synthetic.json';
const URL = 'https://synthetic.public.blob.vercel-storage.com/orders/ord_synthetic.json';

function listed(etag = '"etag-1"') {
  return {
    blobs: [{
      pathname: PATHNAME,
      url: URL,
      downloadUrl: `${URL}?download=1`,
      size: 12,
      uploadedAt: new Date('2026-08-04T00:00:00Z'),
      etag,
    }],
    hasMore: false,
  };
}

test('public versioned read fetches the listed URL without authorization and returns matching bytes/ETag', async () => {
  let requestedUrl = '';
  let requestedHeaders: HeadersInit | undefined;
  const result = await readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
    listImpl: async () => listed(),
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedHeaders = init?.headers;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { etag: '"etag-1"' },
      });
    },
  });

  assert.deepEqual(result, { body: '{"ok":true}', version: '"etag-1"' });
  assert.ok(requestedUrl.startsWith(URL));
  const headers = new Headers(requestedHeaders);
  assert.equal(headers.get('if-match'), '"etag-1"');
  assert.equal(headers.has('authorization'), false);
});

test('public versioned read returns null when the exact order pathname is absent', async () => {
  const result = await readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
    listImpl: async () => ({ ...listed(), blobs: [] }),
    fetchImpl: async () => { throw new Error('fetch must not run'); },
  });
  assert.equal(result, null);
});

test('public versioned read retries a list/fetch race and returns only matching bytes/ETag', async () => {
  let lists = 0;
  let fetches = 0;
  const result = await readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
    listImpl: async () => listed(`"etag-${++lists}"`),
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) return new Response(null, { status: 412 });
      return new Response('{"generation":2}', {
        status: 200,
        headers: { etag: '"etag-2"' },
      });
    },
  });

  assert.equal(lists, 2);
  assert.equal(fetches, 2);
  assert.deepEqual(result, { body: '{"generation":2}', version: '"etag-2"' });
});

test('public versioned read fails closed when response ETags never match the listed version', async () => {
  await assert.rejects(
    readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
      listImpl: async () => listed('"listed"'),
      fetchImpl: async () => new Response('{}', {
        status: 200,
        headers: { etag: '"different"' },
      }),
    }),
    /changed during 3 versioned read attempt/,
  );
});
