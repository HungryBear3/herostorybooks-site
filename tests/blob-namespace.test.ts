/**
 * Blob namespace isolation — guarantees Preview deployments cannot read or
 * write the Production order namespace by accident.
 *
 * The contract:
 *   - VERCEL_ENV=preview  + HSB_BLOB_NAMESPACE unset/empty → throws BlobNamespaceError
 *   - VERCEL_ENV=preview  + HSB_BLOB_NAMESPACE=production  → throws BlobNamespaceError
 *   - VERCEL_ENV=preview  + HSB_BLOB_NAMESPACE=preview     → 'preview'
 *   - VERCEL_ENV=development + HSB_BLOB_NAMESPACE unset    → 'development'
 *   - VERCEL_ENV=production + HSB_BLOB_NAMESPACE unset     → '' (flat paths, prod compat)
 *   - VERCEL_ENV=production + HSB_BLOB_NAMESPACE=production → 'production'
 *   - non-Vercel (no VERCEL_ENV) + unset                   → '' (flat paths)
 *
 * withBlobNamespace must produce keys that, when combined with a prefix list,
 * cannot accidentally match production keys.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BlobNamespaceError,
  getBlobNamespace,
  withBlobNamespace,
} from '../src/lib/orders.ts';

function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => void,
) {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) before[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('preview without HSB_BLOB_NAMESPACE → throws BlobNamespaceError', () => {
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: undefined }, () => {
    assert.throws(() => getBlobNamespace(), BlobNamespaceError);
  });
});

test('preview with empty HSB_BLOB_NAMESPACE → throws BlobNamespaceError', () => {
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: '   ' }, () => {
    assert.throws(() => getBlobNamespace(), BlobNamespaceError);
  });
});

test('preview with HSB_BLOB_NAMESPACE=production → throws BlobNamespaceError', () => {
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'production' }, () => {
    assert.throws(() => getBlobNamespace(), BlobNamespaceError);
  });
});

test('preview with HSB_BLOB_NAMESPACE=preview → "preview"', () => {
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'preview' }, () => {
    assert.equal(getBlobNamespace(), 'preview');
  });
});

test('preview with arbitrary non-production HSB_BLOB_NAMESPACE → echoed back', () => {
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'qa-2026-04-27' }, () => {
    assert.equal(getBlobNamespace(), 'qa-2026-04-27');
  });
});

test('development without HSB_BLOB_NAMESPACE → "development"', () => {
  withEnv({ VERCEL_ENV: 'development', HSB_BLOB_NAMESPACE: undefined }, () => {
    assert.equal(getBlobNamespace(), 'development');
  });
});

test('development with explicit HSB_BLOB_NAMESPACE → respects it', () => {
  withEnv({ VERCEL_ENV: 'development', HSB_BLOB_NAMESPACE: 'dev-claude' }, () => {
    assert.equal(getBlobNamespace(), 'dev-claude');
  });
});

test('production without HSB_BLOB_NAMESPACE → "" (flat paths preserved)', () => {
  withEnv({ VERCEL_ENV: 'production', HSB_BLOB_NAMESPACE: undefined }, () => {
    assert.equal(getBlobNamespace(), '');
  });
});

test('production with HSB_BLOB_NAMESPACE=production → "production"', () => {
  withEnv({ VERCEL_ENV: 'production', HSB_BLOB_NAMESPACE: 'production' }, () => {
    assert.equal(getBlobNamespace(), 'production');
  });
});

test('non-Vercel environment (no VERCEL_ENV) → "" by default', () => {
  withEnv({ VERCEL_ENV: undefined, HSB_BLOB_NAMESPACE: undefined }, () => {
    assert.equal(getBlobNamespace(), '');
  });
});

test('non-Vercel environment with explicit namespace → respected', () => {
  withEnv({ VERCEL_ENV: undefined, HSB_BLOB_NAMESPACE: 'ci-test' }, () => {
    assert.equal(getBlobNamespace(), 'ci-test');
  });
});

// ── withBlobNamespace ──

test('withBlobNamespace: empty namespace → input passes through unchanged', () => {
  withEnv({ VERCEL_ENV: 'production', HSB_BLOB_NAMESPACE: undefined }, () => {
    assert.equal(withBlobNamespace('orders/abc.json'), 'orders/abc.json');
    assert.equal(withBlobNamespace('orders/'), 'orders/');
    assert.equal(withBlobNamespace('orders/abc/photo-x.jpg'), 'orders/abc/photo-x.jpg');
  });
});

test('withBlobNamespace: preview namespace prepends correctly for files + prefixes', () => {
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'preview' }, () => {
    assert.equal(withBlobNamespace('orders/abc.json'), 'preview/orders/abc.json');
    assert.equal(withBlobNamespace('orders/'), 'preview/orders/');
    assert.equal(withBlobNamespace('orders/abc/photo-x.jpg'), 'preview/orders/abc/photo-x.jpg');
    assert.equal(withBlobNamespace('recovery/hash.json'), 'preview/recovery/hash.json');
  });
});

test('withBlobNamespace: leading slash on input is normalized away', () => {
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'preview' }, () => {
    assert.equal(withBlobNamespace('/orders/abc.json'), 'preview/orders/abc.json');
    assert.equal(withBlobNamespace('//orders/abc.json'), 'preview/orders/abc.json');
  });
});

test('isolation guarantee: preview list-prefix never overlaps production keys', () => {
  // Concrete invariant: a preview deployment's getOrdersListPrefix() must
  // start with the namespace, so it cannot match flat `orders/...` keys.
  withEnv({ VERCEL_ENV: 'preview', HSB_BLOB_NAMESPACE: 'preview' }, () => {
    const previewPrefix = withBlobNamespace('orders/');
    assert.ok(previewPrefix.startsWith('preview/'), 'preview prefix must lead with namespace');
    assert.ok(!previewPrefix.startsWith('orders/'), 'preview prefix must NOT collide with prod flat namespace');
  });
});
