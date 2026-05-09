/**
 * getOrderPhotoUrl — resolves OrderRecord.photoBlobPath into a fetchable URL
 * for the FAL image-edit provider.
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

test('getOrderPhotoUrl: returns null when photoBlobPath missing', () => {
  assert.equal(getOrderPhotoUrl({ photoBlobPath: null }), null);
  assert.equal(getOrderPhotoUrl({ photoBlobPath: undefined as unknown as null }), null);
  assert.equal(getOrderPhotoUrl({ photoBlobPath: '' }), null);
  assert.equal(getOrderPhotoUrl({ photoBlobPath: '   ' }), null);
});

test('getOrderPhotoUrl: passes through absolute URLs', () => {
  assert.equal(
    getOrderPhotoUrl({ photoBlobPath: 'https://store.public.blob.vercel-storage.com/orders/x.jpg' }),
    'https://store.public.blob.vercel-storage.com/orders/x.jpg',
  );
  assert.equal(
    getOrderPhotoUrl({ photoBlobPath: 'http://example.test/img.png' }),
    'http://example.test/img.png',
  );
});

test('getOrderPhotoUrl: prefixes with HSB_PUBLIC_BLOB_BASE when set', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', 'https://cdn.example.test', () => {
    assert.equal(
      getOrderPhotoUrl({ photoBlobPath: 'preview/orders/abc/photo-x.jpg' }),
      'https://cdn.example.test/preview/orders/abc/photo-x.jpg',
    );
  });
});

test('getOrderPhotoUrl: trailing slash on base is normalized', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', 'https://cdn.example.test/', () => {
    assert.equal(
      getOrderPhotoUrl({ photoBlobPath: 'orders/abc/photo-x.jpg' }),
      'https://cdn.example.test/orders/abc/photo-x.jpg',
    );
  });
});

test('getOrderPhotoUrl: returns null when no env override and not absolute (forces fallback to text-only)', () => {
  withEnv('HSB_PUBLIC_BLOB_BASE', undefined, () => {
    assert.equal(getOrderPhotoUrl({ photoBlobPath: 'orders/abc/photo-x.jpg' }), null);
  });
});
