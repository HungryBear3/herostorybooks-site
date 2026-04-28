/**
 * Regression test for the production blob access-mode mismatch.
 *
 * Original failure: orders + photos were written with `access: 'private'`,
 * which the production blob store (provisioned as public) rejects with
 * `BlobError: Cannot use private access on a public store.`
 *
 * Fix: getBlobAccessMode() reads HSB_BLOB_ACCESS_MODE (default 'public')
 * and is used everywhere we previously hardcoded 'private'.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { getBlobAccessMode } from '../src/lib/orders.ts';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) previous[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('getBlobAccessMode: defaults to public (matches production store provisioning)', () => {
  withEnv({ HSB_BLOB_ACCESS_MODE: undefined }, () => {
    assert.equal(getBlobAccessMode(), 'public');
  });
});

test('getBlobAccessMode: respects explicit HSB_BLOB_ACCESS_MODE=private', () => {
  withEnv({ HSB_BLOB_ACCESS_MODE: 'private' }, () => {
    assert.equal(getBlobAccessMode(), 'private');
  });
});

test('getBlobAccessMode: respects explicit HSB_BLOB_ACCESS_MODE=public', () => {
  withEnv({ HSB_BLOB_ACCESS_MODE: 'public' }, () => {
    assert.equal(getBlobAccessMode(), 'public');
  });
});

test('getBlobAccessMode: ignores garbage values, falls back to public default', () => {
  withEnv({ HSB_BLOB_ACCESS_MODE: 'banana' }, () => {
    assert.equal(getBlobAccessMode(), 'public');
  });
});

// ── Static guard: no callsite hardcodes 'private' anymore ───────────────────

test('source-level: no remaining hardcoded private access in order/recovery code', async () => {
  const files = [
    'src/lib/orders.ts',
    'src/lib/order-recovery.ts',
    'src/lib/recovery.ts',
  ];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    assert.equal(
      /access:\s*['"]private['"]/i.test(src),
      false,
      `${f} still contains a hardcoded private access — must use getBlobAccessMode()`,
    );
    assert.equal(
      /PRIVATE_BLOB_ACCESS/.test(src),
      false,
      `${f} still references the old PRIVATE_BLOB_ACCESS const — must use getBlobAccessMode()`,
    );
  }
});

test('source-level: every blob put/get/list site uses getBlobAccessMode()', async () => {
  // Each file we changed should reference getBlobAccessMode at least once per
  // blob put/get site. The exact count is brittle; instead assert presence.
  const files = ['src/lib/orders.ts', 'src/lib/order-recovery.ts', 'src/lib/recovery.ts'];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    assert.match(src, /getBlobAccessMode\(\)/);
  }
});
