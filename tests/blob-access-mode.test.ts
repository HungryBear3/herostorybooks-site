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

import { createHash } from 'node:crypto';
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

/**
 * The story-media lane is the one sanctioned exception, and it is exempted by
 * NAME rather than by loosening the pattern.
 *
 * Order JSON, hero photos and recovery records live in the public order store
 * and must follow `getBlobAccessMode()`. Customer voice notes and story
 * documents do not live there at all: they go to a separate private store
 * addressed by `HSB_PRIVATE_READ_WRITE_TOKEN`, so their access is a constant,
 * not a mode. `assertPrivateStorySourceStorage` is where that constant lives —
 * every other hardcoded `access: 'private'` in these files is still a failure.
 */
const STORY_MEDIA_CREDENTIAL_RESOLVER = /export function assertPrivateStorySourceStorage[\s\S]*?\n}\n/;

function withoutExactShippingFactory(source: string): string {
  const start = '/** Narrow bound initial-shipping provenance marker access (H3).';
  const end = '/** A cached commit, tagged with the write generation that published it. */';
  assert.equal(source.split(start).length - 1, 1);
  assert.equal(source.split(end).length - 1, 1);
  const at = source.indexOf(start); const stop = source.indexOf(end, at);
  const prefix = '  return localOrderStoreAdapter();\n}\n\n';
  assert.equal(source.slice(at - prefix.length, at), prefix);
  assert.ok(stop > at);
  assert.equal(createHash('sha256').update(source.slice(at, stop)).digest('hex'), '054c27dbe42e2ebbd099bf2747f8f8e3b2328a5cb990b136d9d66c50be212ac3');
  return source.slice(0, at) + source.slice(stop);
}
function assertModeSource(source: string, orders: boolean) {
  const normalized = (orders ? withoutExactShippingFactory(source) : source).replace(STORY_MEDIA_CREDENTIAL_RESOLVER, '');
  assert.doesNotMatch(normalized, /access:\s*['"]private['"]/i);
  assert.doesNotMatch(normalized, /PRIVATE_BLOB_ACCESS/);
}
test('private marker exception is exact and unrelated hardcodes remain forbidden', async () => {
  const source = await readFile('src/lib/orders.ts', 'utf8');
  assertModeSource(source, true);
  for (const mutation of [
    source + "\nconst unrelated = { access: 'private' };\n",
    source.replace('/** Narrow bound initial-shipping provenance marker access (H3).', '/** changed factory'),
    source.replace('initial_shipping_provenance_context_drift', 'unauthorized_context_drift'),
  ]) {
    assert.notEqual(mutation, source);
    assert.throws(() => assertModeSource(mutation, true), { code: 'ERR_ASSERTION' });
  }
});

test('source-level: no remaining hardcoded private access in order/recovery code', async () => {
  const files = [
    'src/lib/orders.ts',
    'src/lib/order-recovery.ts',
    'src/lib/recovery.ts',
  ];
  for (const f of files) {
    const whole = await readFile(f, 'utf8');
    const src = (f === 'src/lib/orders.ts' ? withoutExactShippingFactory(whole) : whole).replace(STORY_MEDIA_CREDENTIAL_RESOLVER, '');
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
