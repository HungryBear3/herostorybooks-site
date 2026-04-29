/**
 * getOrderPhotoUrl resolution order:
 *   1. order.photoBlobUrl wins
 *   2. order.photoBlobPath if absolute URL
 *   3. HSB_PUBLIC_BLOB_BASE + photoBlobPath (legacy)
 *   4. otherwise null
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getOrderPhotoUrl } from '../src/lib/orders.ts';

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

// ── 1. photoBlobUrl wins ──

test('getOrderPhotoUrl: persisted photoBlobUrl wins over everything', () => {
  // Even when an env override exists AND a relative path exists, the
  // persisted absolute URL is returned — that's the durable answer.
  withEnv('HSB_PUBLIC_BLOB_BASE', 'https://reconstructed.example/from-env', () => {
    assert.equal(
      getOrderPhotoUrl({
        photoBlobUrl: 'https://store.public.blob.vercel-storage.com/preview/orders/x/photo.jpg',
        photoBlobPath: 'preview/orders/x/photo.jpg',
      }),
      'https://store.public.blob.vercel-storage.com/preview/orders/x/photo.jpg',
    );
  });
});

test('getOrderPhotoUrl: photoBlobUrl wins even when env is unset', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', undefined, () => {
    assert.equal(
      getOrderPhotoUrl({
        photoBlobUrl: 'https://store.public.blob.vercel-storage.com/orders/y/photo.jpg',
        photoBlobPath: 'orders/y/photo.jpg',
      }),
      'https://store.public.blob.vercel-storage.com/orders/y/photo.jpg',
    );
  });
});

test('getOrderPhotoUrl: whitespace-only photoBlobUrl is ignored, falls through', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', 'https://cdn.example', () => {
    assert.equal(
      getOrderPhotoUrl({
        photoBlobUrl: '   ',
        photoBlobPath: 'orders/z/photo.jpg',
      }),
      'https://cdn.example/orders/z/photo.jpg',
    );
  });
});

// ── 2. photoBlobPath absolute pass-through ──

test('getOrderPhotoUrl: absolute photoBlobPath returned as-is when no photoBlobUrl', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', undefined, () => {
    assert.equal(
      getOrderPhotoUrl({
        photoBlobUrl: null,
        photoBlobPath: 'https://recovery.example/img.png',
      }),
      'https://recovery.example/img.png',
    );
  });
});

// ── 3. legacy HSB_PUBLIC_BLOB_BASE reconstruction ──

test('getOrderPhotoUrl: legacy order with only photoBlobPath uses HSB_PUBLIC_BLOB_BASE', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', 'https://cdn.example', () => {
    assert.equal(
      getOrderPhotoUrl({
        photoBlobUrl: null,
        photoBlobPath: 'preview/orders/abc/photo.jpg',
      }),
      'https://cdn.example/preview/orders/abc/photo.jpg',
    );
  });
});

test('getOrderPhotoUrl: legacy order with photoBlobPath but no env returns null (forces text-only fallback)', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', undefined, () => {
    assert.equal(
      getOrderPhotoUrl({
        photoBlobUrl: null,
        photoBlobPath: 'preview/orders/abc/photo.jpg',
      }),
      null,
    );
  });
});

// ── 4. neither set ──

test('getOrderPhotoUrl: returns null when neither photoBlobUrl nor photoBlobPath set', () => {
  assert.equal(getOrderPhotoUrl({ photoBlobUrl: null, photoBlobPath: null }), null);
  assert.equal(getOrderPhotoUrl({ photoBlobUrl: undefined, photoBlobPath: undefined }), null);
  assert.equal(getOrderPhotoUrl({ photoBlobUrl: '', photoBlobPath: '' }), null);
});
