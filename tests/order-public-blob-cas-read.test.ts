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
  // The CDN GET is unauthenticated and carries no `If-Match`: the public edge's
  // precondition handling and ETag representation are not a reliable mirror of
  // the metadata-API version, so binding is done by comparing the CDN validator
  // to the authoritative `list()` ETag (modulo decoration), not at the edge.
  assert.equal(headers.has('if-match'), false);
  assert.equal(headers.has('authorization'), false);
});

test('public versioned read prefers the fresh download URL over a stale normal CDN URL', async () => {
  let requestedUrl = '';
  const result = await readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
    listImpl: async () => listed(),
    fetchImpl: async (input) => {
      requestedUrl = String(input);
      if (!requestedUrl.includes('download=1')) {
        return new Response('{"stale":true}', {
          status: 200,
          headers: { etag: 'W/"previous-etag"' },
        });
      }
      return new Response('{"fresh":true}', {
        status: 200,
        headers: { etag: 'W/"etag-1"' },
      });
    },
  });

  assert.ok(requestedUrl.includes('download=1'));
  assert.deepEqual(result, { body: '{"fresh":true}', version: '"etag-1"' });
});

test('public versioned read treats an HTTP-equivalent (weak / requoted) ETag as the same version', async () => {
  // Reproduces the production 503: `list()` returns a strong quoted validator
  // while the public CDN returns the SAME validator weakened/unquoted. Raw
  // string comparison read this as a foreign change on all three attempts and
  // failed closed with no concurrent writer. It must now converge.
  for (const cdnEtag of ['W/"etag-1"', 'etag-1', ' "etag-1" ']) {
    const result = await readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
      listImpl: async () => listed('"etag-1"'),
      fetchImpl: async () =>
        new Response('{"ok":true}', { status: 200, headers: { etag: cdnEtag } }),
    });
    assert.deepEqual(
      result,
      { body: '{"ok":true}', version: '"etag-1"' },
      `expected convergence for CDN ETag ${JSON.stringify(cdnEtag)}`,
    );
  }
});

test('public versioned read converges when the CDN omits an ETag but the version is stable', async () => {
  // Some public edges return no validator on GET. Coherence is then confirmed by
  // re-listing: a stable authoritative ETag across the read means the bytes are
  // current. The returned version is the authoritative `list()` ETag.
  let lists = 0;
  const result = await readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
    listImpl: async () => {
      lists += 1;
      return listed('"stable"');
    },
    fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
  });
  assert.deepEqual(result, { body: '{"ok":true}', version: '"stable"' });
  assert.equal(lists, 2, 'expected a confirming re-list when the CDN omits an ETag');
});

test('public versioned read retries when the CDN omits an ETag and the version advanced mid-read', async () => {
  // No CDN validator AND a genuine concurrent overwrite between fetch and the
  // confirming re-list: the authoritative ETag moved, so the stale bytes must
  // not be accepted — retry, then converge on the settled version.
  let lists = 0;
  const result = await readPublicOrderBlobVersioned(PATHNAME, 'synthetic-token', {
    listImpl: async () => {
      lists += 1;
      // attempt 1: read v1, confirm sees v2 (advanced) -> retry;
      // attempt 2: read v2, confirm sees v2 (stable)   -> accept.
      const etag = lists <= 1 ? '"v1"' : '"v2"';
      return listed(etag);
    },
    fetchImpl: async () => new Response('{"settled":true}', { status: 200 }),
  });
  assert.deepEqual(result, { body: '{"settled":true}', version: '"v2"' });
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
    sleepImpl: async () => {},
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
      sleepImpl: async () => {},
    }),
    /changed during 3 versioned read attempt/,
  );
});
