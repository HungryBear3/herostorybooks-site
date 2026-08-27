/**
 * Family Review private asset storage — behavioral guards.
 *
 * Covers: private configuration missing, no public fallback, size
 * bounds, content-type spoofing, safe content-disposition, legacy
 * handling, and deletion reporting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AssetStorageError,
  MAX_ASSET_READ_BYTES,
  assetStorageOf,
  deleteAsset,
  familyReviewAssetStorageMode,
  legacyPublicAssetReadsAllowed,
  openAsset,
  safeDownloadFilename,
  serveableContentType,
} from '../src/lib/family-review/private-assets.ts';

function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
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

/* ── 1. Private configuration missing ──────────────────────────────── */

test('access mode defaults to public when unconfigured', async () => {
  await withEnv({ FAMILY_REVIEW_BLOB_ACCESS: undefined }, () => {
    assert.equal(familyReviewAssetStorageMode(), 'public');
  });
});

test('only the exact string "private" selects private mode', async () => {
  for (const value of ['Private', 'PRIVATE', 'priv', 'true', '1', '']) {
    await withEnv({ FAMILY_REVIEW_BLOB_ACCESS: value }, () => {
      assert.equal(
        familyReviewAssetStorageMode(),
        'public',
        `"${value}" must not be read as private — a typo must never select a mode the production store cannot serve`,
      );
    });
  }
  await withEnv({ FAMILY_REVIEW_BLOB_ACCESS: 'private' }, () => {
    assert.equal(familyReviewAssetStorageMode(), 'private');
  });
});

test('an asset with no storage field is treated as legacy public', () => {
  assert.equal(assetStorageOf({}), 'public');
  assert.equal(assetStorageOf({ storage: 'public' }), 'public');
  assert.equal(assetStorageOf({ storage: 'private' }), 'private');
});

test('legacy public reads default on, and are disabled by explicit off values', async () => {
  await withEnv({ FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS: undefined }, () => {
    assert.equal(legacyPublicAssetReadsAllowed(), true);
  });
  for (const off of ['0', 'off', 'false', 'no', 'OFF']) {
    await withEnv({ FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS: off }, () => {
      assert.equal(legacyPublicAssetReadsAllowed(), false, `"${off}" must disable`);
    });
  }
});

/* ── 2. No public fallback for a private asset ─────────────────────── */

test('a private asset read NEVER falls back to a public URL fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  try {
    await withEnv(
      { FAMILY_REVIEW_BLOB_ACCESS: 'private', BLOB_READ_WRITE_TOKEN: undefined },
      async () => {
        await assert.rejects(
          () =>
            openAsset({
              blobPathname: 'family-review/photos/fr-x/a-y.jpg',
              // A URL is present on the record, and must still be ignored.
              blobUrl: 'https://example.public.blob.vercel-storage.com/leak.jpg',
              storage: 'private',
              mime: 'image/jpeg',
            }),
          (err: unknown) => err instanceof AssetStorageError,
          'a failed private read must throw, not fall back',
        );
      },
    );
    assert.equal(
      fetchCalls,
      0,
      'a private asset must never be fetched over a public URL, even when the record still carries one',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy public reads are refused once the switch is off', async () => {
  await withEnv(
    { FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS: '0' },
    async () => {
      await assert.rejects(
        () =>
          openAsset({
            blobPathname: 'family-review/photos/fr-x/a-y.jpg',
            blobUrl: 'https://example.public.blob.vercel-storage.com/x.jpg',
            storage: 'public',
            mime: 'image/jpeg',
          }),
        (err: unknown) =>
          err instanceof AssetStorageError && err.code === 'legacy_reads_disabled',
      );
    },
  );
});

/* ── 3. Size bounds ────────────────────────────────────────────────── */

test('an oversized legacy object is refused before it streams', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('x', {
      status: 200,
      headers: { 'content-length': String(MAX_ASSET_READ_BYTES + 1) },
    })) as typeof fetch;
  try {
    await withEnv(
      { FAMILY_REVIEW_ALLOW_LEGACY_PUBLIC_ASSET_READS: undefined },
      async () => {
        await assert.rejects(
          () =>
            openAsset({
              blobPathname: 'family-review/photos/fr-x/a-y.jpg',
              blobUrl: 'https://example.public.blob.vercel-storage.com/big.jpg',
              storage: 'public',
              mime: 'image/jpeg',
            }),
          (err: unknown) =>
            err instanceof AssetStorageError && err.code === 'too_large',
        );
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a legacy asset with no URL cannot be opened', async () => {
  await assert.rejects(
    () =>
      openAsset({
        blobPathname: 'family-review/photos/fr-x/a-y.jpg',
        storage: 'public',
        mime: 'image/jpeg',
      }),
    (err: unknown) =>
      err instanceof AssetStorageError && err.code === 'no_legacy_url',
  );
});

/* ── 4. Content-type spoofing ──────────────────────────────────────── */

test('only allowlisted image types are ever served as themselves', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']) {
    assert.equal(serveableContentType(mime), mime);
  }
  for (const spoof of [
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'text/html; charset=utf-8',
    undefined,
    '',
  ]) {
    assert.equal(
      serveableContentType(spoof as string | undefined),
      'application/octet-stream',
      `${String(spoof)} must be downgraded, never echoed as a renderable type`,
    );
  }
});

/* ── 5. Content-Disposition safety ─────────────────────────────────── */

test('download filenames cannot inject quotes, headers, or paths', () => {
  const hostile = 'a"; filename="evil.html\r\nX-Injected: 1';
  const name = safeDownloadFilename(hostile, 'image/png');
  assert.ok(!name.includes('"'), 'no quote may survive');
  assert.ok(!/[\r\n]/.test(name), 'no CR/LF may survive');
  assert.ok(!name.includes('/'), 'no path separator may survive');
  assert.match(name, /\.png$/);
});

test('the filename extension follows the STORED mime, not a hardcoded png', () => {
  assert.match(safeDownloadFilename('sample', 'image/jpeg'), /\.jpg$/);
  assert.match(safeDownloadFilename('sample', 'image/webp'), /\.webp$/);
  // An unknown/spoofed type must not be handed a renderable extension.
  assert.match(safeDownloadFilename('sample', 'text/html'), /\.bin$/);
});

/* ── 6. Deletion behavior ──────────────────────────────────────────── */

test('deleteAsset reports failure instead of swallowing it', async () => {
  await withEnv({ BLOB_READ_WRITE_TOKEN: undefined }, async () => {
    const result = await deleteAsset('family-review/photos/fr-x/a-y.jpg');
    assert.equal(result.deleted, false, 'a delete that cannot run must report false');
    assert.ok(result.reason, 'a failure must carry a reason code');
  });
});
