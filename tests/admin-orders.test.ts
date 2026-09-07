import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createOrderRecord,
  getOrder,
  listOrders,
  persistOrder,
  prepareOrderForAdminFulfillmentRetry,
} from '../src/lib/orders.ts';
import type { OrderRecord } from '../src/lib/orders.ts';
import { isAdminAuthedFromRequest, readAdminSessionCookie } from '../src/lib/admin-auth.ts';

function makeTmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-admin-'));
  process.env.HSB_ORDER_STORE_DIR = dir;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  return dir;
}

function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HSB_ORDER_STORE_DIR;
}

async function seed(overrides: Partial<OrderRecord>, id: string): Promise<OrderRecord> {
  const base = createOrderRecord(
    { childName: overrides.childName ?? 'Luna', bookFormat: overrides.bookFormat ?? 'digital', email: 'luna@example.com' },
    { id, now: overrides.createdAt ?? '2026-04-23T10:00:00Z' },
  );
  const order: OrderRecord = { ...base, ...overrides };
  await persistOrder(order);
  return order;
}

// ── listOrders ────────────────────────────────────────────────────────────────

test('listOrders returns empty array when store is empty', async () => {
  const dir = makeTmp();
  try {
    const orders = await listOrders();
    assert.deepEqual(orders, []);
  } finally { cleanup(dir); }
});

test('listOrders returns all persisted orders', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'paid' }, 'ord_list_a');
    await seed({ paymentStatus: 'pending' }, 'ord_list_b');
    await seed({ paymentStatus: 'paid', fulfillmentStatus: 'failed_manual_review' }, 'ord_list_c');

    const orders = await listOrders();
    assert.equal(orders.length, 3);
    const ids = orders.map(o => o.id).sort();
    assert.deepEqual(ids, ['ord_list_a', 'ord_list_b', 'ord_list_c']);
  } finally { cleanup(dir); }
});

test('listOrders skips non-JSON files silently', async () => {
  const dir = makeTmp();
  try {
    await seed({}, 'ord_list_valid');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'readme.txt'), 'not an order');

    const orders = await listOrders();
    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, 'ord_list_valid');
  } finally { cleanup(dir); }
});

// ── isAdminAuthedFromRequest ──────────────────────────────────────────────────

test('admin auth: no key configured → always false', () => {
  delete process.env.HSB_ORDER_ADMIN_KEY;
  const req = new Request('https://example.com', {
    headers: { 'x-hsb-order-admin-key': 'whatever' },
  });
  assert.equal(isAdminAuthedFromRequest(req), false);
});

test('admin auth: correct header key → true', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { 'x-hsb-order-admin-key': 'secret-key-abc' },
    });
    assert.equal(isAdminAuthedFromRequest(req), true);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: wrong header key → false', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { 'x-hsb-order-admin-key': 'wrong' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: correct cookie → true', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'other=1; hsb-ops-key=secret-key-abc; foo=bar' },
    });
    assert.equal(isAdminAuthedFromRequest(req), true);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: wrong cookie → false', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'hsb-ops-key=wrong-key' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: no header and no cookie → false', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com');
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: a look-alike cookie name must not shadow the real session', () => {
  // Anyone able to write a cookie on the site domain could otherwise park
  // `ahsb-ops-key=junk` ahead of the real one and lock operators out.
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'ahsb-ops-key=junk; hsb-ops-key=secret-key-abc' },
    });
    assert.equal(isAdminAuthedFromRequest(req), true);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: a cookie whose name merely ends in the admin name is not the admin cookie', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'Xhsb-ops-key=secret-key-abc' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: a duplicate admin cookie is rejected when the real value comes first', () => {
  // Two entries with the *same* name are ambiguous: Next's RequestCookies keeps
  // the last one, a first-match scan keeps the first, so the API reader and the
  // ops page reader would reach opposite verdicts on the same header. Anyone who
  // can write a cookie on the apex could then lock operators out of every
  // mutation route while the dashboard still renders. Both readers fail closed.
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'hsb-ops-key=secret-key-abc; hsb-ops-key=attacker-junk' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: a duplicate admin cookie is rejected when the real value comes last', () => {
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'hsb-ops-key=attacker-junk; hsb-ops-key=secret-key-abc' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: two identical valid admin cookies are still ambiguous', () => {
  // Not "accept if any copy matches" — a stale or injected duplicate must not be
  // rendered harmless just because a valid credential also appears.
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    const req = new Request('https://example.com', {
      headers: { cookie: 'hsb-ops-key=secret-key-abc; hsb-ops-key=secret-key-abc' },
    });
    assert.equal(isAdminAuthedFromRequest(req), false);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('admin auth: a configured key with stray whitespace still authenticates', () => {
  process.env.HSB_ORDER_ADMIN_KEY = ' secret-key-abc ';
  try {
    const req = new Request('https://example.com', {
      headers: { 'x-hsb-order-admin-key': 'secret-key-abc' },
    });
    assert.equal(isAdminAuthedFromRequest(req), true);
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

// ── readAdminSessionCookie (the parser both readers share) ────────────────────

test('readAdminSessionCookie: returns the lone admin cookie value', () => {
  assert.equal(readAdminSessionCookie('other=1; hsb-ops-key=secret-key-abc; foo=bar'), 'secret-key-abc');
});

test('readAdminSessionCookie: absent, empty and null headers → null', () => {
  assert.equal(readAdminSessionCookie(null), null);
  assert.equal(readAdminSessionCookie(undefined), null);
  assert.equal(readAdminSessionCookie(''), null);
  assert.equal(readAdminSessionCookie('other=1; foo=bar'), null);
});

test('readAdminSessionCookie: look-alike names are not the admin cookie', () => {
  assert.equal(readAdminSessionCookie('ahsb-ops-key=junk; hsb-ops-key=real'), 'real');
  assert.equal(readAdminSessionCookie('Xhsb-ops-key=real'), null);
  assert.equal(readAdminSessionCookie('hsb-ops-key-extra=real'), null);
});

test('readAdminSessionCookie: duplicate entries are ambiguous in either order', () => {
  assert.equal(readAdminSessionCookie('hsb-ops-key=real; hsb-ops-key=junk'), null);
  assert.equal(readAdminSessionCookie('hsb-ops-key=junk; hsb-ops-key=real'), null);
  assert.equal(readAdminSessionCookie('hsb-ops-key=real; hsb-ops-key=real'), null);
  assert.equal(readAdminSessionCookie('hsb-ops-key=a;hsb-ops-key=b'), null);
  assert.equal(readAdminSessionCookie('hsb-ops-key=real; other=1; hsb-ops-key=junk'), null);
  // A look-alike alongside the real one is still a single admin cookie.
  assert.equal(readAdminSessionCookie('ahsb-ops-key=junk; hsb-ops-key=real; Xhsb-ops-key=junk'), 'real');
});

test('readAdminSessionCookie: an empty admin cookie is a value, not an absence', () => {
  // `hsb-ops-key=` must not be skipped in favour of a later entry — that would
  // reintroduce the shadowing this parser exists to close.
  assert.equal(readAdminSessionCookie('hsb-ops-key='), '');
  assert.equal(readAdminSessionCookie('hsb-ops-key=; hsb-ops-key=real'), null);
});

test('readAdminSessionCookie: percent-encoded values round-trip', () => {
  assert.equal(readAdminSessionCookie('hsb-ops-key=secret%20key'), 'secret key');
  assert.equal(readAdminSessionCookie('hsb-ops-key=a%2Bb%2Fc%3D'), 'a+b/c=');
});

test('readAdminSessionCookie: a malformed escape falls back to the raw value', () => {
  // Can only ever match if the configured key *is* that literal string.
  assert.equal(readAdminSessionCookie('hsb-ops-key=%zz'), '%zz');
});

test('both admin cookie readers reach the same verdict for every cookie shape', () => {
  // The ops page reader (`isAdminAuthedFromCookie`) cannot be imported here —
  // `next/headers` does not resolve outside the Next build — so pin the shared
  // parser it consumes against the same hand-written table the request reader
  // is held to. Divergence between the two readers now requires changing this
  // table, not merely one of the two call sites.
  const cases: Array<[string, boolean]> = [
    ['hsb-ops-key=secret-key-abc', true],
    ['other=1; hsb-ops-key=secret-key-abc; foo=bar', true],
    ['ahsb-ops-key=junk; hsb-ops-key=secret-key-abc', true],
    ['hsb-ops-key=wrong-key', false],
    ['Xhsb-ops-key=secret-key-abc', false],
    ['', false],
    ['hsb-ops-key=secret-key-abc; hsb-ops-key=attacker-junk', false],
    ['hsb-ops-key=attacker-junk; hsb-ops-key=secret-key-abc', false],
    ['hsb-ops-key=secret-key-abc; hsb-ops-key=secret-key-abc', false],
  ];
  process.env.HSB_ORDER_ADMIN_KEY = 'secret-key-abc';
  try {
    for (const [cookie, expected] of cases) {
      const req = new Request('https://example.com', { headers: { cookie } });
      assert.equal(isAdminAuthedFromRequest(req), expected, `request reader: ${cookie}`);
      const parsed = readAdminSessionCookie(cookie);
      assert.equal(parsed !== null && parsed === 'secret-key-abc', expected, `page reader: ${cookie}`);
    }
  } finally { delete process.env.HSB_ORDER_ADMIN_KEY; }
});

test('the ops page reader parses the raw Cookie header with the shared parser', () => {
  const src = readFileSync(new URL('../src/lib/admin-auth-server.ts', import.meta.url), 'utf8');
  assert.match(src, /readAdminSessionCookie\(/, 'must delegate parsing to the shared parser');
  assert.match(src, /await headers\(\)\)\.get\('cookie'\)/, 'must read the raw Cookie header');
  const bindings = src.match(/import\s*\{([^}]*)\}\s*from\s*'next\/headers'/)?.[1] ?? '';
  assert.doesNotMatch(
    bindings,
    /\bcookies\b/,
    'must not import next/headers cookies(): RequestCookies collapses duplicate hsb-ops-key entries (last wins) so this reader could not see the ambiguity the request reader sees',
  );
});

test('ops admin auth compares keys in constant time', () => {
  for (const rel of ['../src/lib/admin-auth.ts', '../src/lib/admin-auth-server.ts']) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.match(src, /timingSafeEqualStr/, `${rel} must compare via timingSafeEqualStr`);
    assert.doesNotMatch(
      src,
      /[!=]==\s*configured/,
      `${rel} must not compare directly against the configured key`,
    );
  }
});

test('ops login route compares the submitted key in constant time', () => {
  const src = readFileSync(new URL('../src/app/api/admin/login/route.ts', import.meta.url), 'utf8');
  assert.match(src, /timingSafeEqualStr/, 'login route must compare via timingSafeEqualStr');
  assert.doesNotMatch(
    src,
    /[!=]==\s*configured/,
    'login route must not compare directly against the configured key',
  );
});

// ── retryOrderFulfillment ─────────────────────────────────────────────────────

test('retryOrderFulfillment: unknown order → 404', async () => {
  const dir = makeTmp();
  try {
    const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
    const result = await retryOrderFulfillment('ord_ghost');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 404);
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment: unpaid order → 400, no state change', async () => {
  const dir = makeTmp();
  try {
    await seed({ paymentStatus: 'pending' }, 'ord_retry_unpaid');
    const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
    const result = await retryOrderFulfillment('ord_retry_unpaid');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.status, 400);

    const { getOrder } = await import('../src/lib/orders.ts');
    const after = await getOrder('ord_retry_unpaid');
    assert.equal(after?.paymentStatus, 'pending');
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment refuses media-backed Custom Stories before provider calls or state changes', async () => {
  const dir = makeTmp();
  try {
    await seed({
      paymentStatus: 'paid',
      theme: 'custom-voice-story',
      fulfillmentMode: 'manual_hold',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentAttempts: 3,
      fulfillmentLastError: 'media_story_manual_review_required',
      documentBlobPath: 'orders/ord_retry_media/story-source/document.pdf',
      documentConsentAt: '2026-04-23T10:00:00Z',
    }, 'ord_retry_media');
   const { getOrder } = await import('../src/lib/orders.ts');
   const before = await getOrder('ord_retry_media');
   let storyProviderCalls = 0;
   const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
   const result = await retryOrderFulfillment('ord_retry_media', {
     generateStoryWithMeta: async () => {
       storyProviderCalls += 1;
       throw new Error('must not run');
     },
     sleep: async () => {},
   });

   assert.deepEqual(result, {
     ok: false,
     status: 409,
     error: 'Media-backed Custom Stories require manual fulfillment',
   });
   assert.equal(storyProviderCalls, 0);
   assert.deepEqual(await getOrder('ord_retry_media'), before);
 } finally { cleanup(dir); }
});

test('retry preparation without an explicit eligibility policy fails closed', async () => {
  const dir = makeTmp();
  try {
    await seed({
      paymentStatus: 'paid',
      fulfillmentMode: 'manual_hold',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentAttempts: 2,
      fulfillmentLastError: 'manual only',
      voiceBlobPath: 'orders/ord_retry_direct/story-source.webm',
    }, 'ord_retry_direct');
    const before = await getOrder('ord_retry_direct');
    const prepared = await prepareOrderForAdminFulfillmentRetry('ord_retry_direct');
    assert.equal(prepared, null);
    assert.deepEqual(await getOrder('ord_retry_direct'), before);
  } finally { cleanup(dir); }
});

test('retryOrderFulfillment uses the transactional retry preparation helper instead of a blind state reset', () => {
  const source = readFileSync(
    new URL('../src/lib/admin-actions.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /await prepareOrderForAdminFulfillmentRetry\([\s\S]{0,180}!hasMediaBackedCustomStorySource\(current\)/);
  assert.doesNotMatch(source, /await updateFulfillmentState\(orderId,\s*\{\s*fulfillmentStatus:\s*['"]not_started['"]/);
});

test('retryOrderFulfillment: provider failure stays failed and returns an honest 502', async () => {
  const dir = makeTmp();
  try {
    await seed({
      paymentStatus: 'paid',
      fulfillmentStatus: 'failed_manual_review',
      fulfillmentAttempts: 3,
      fulfillmentLastError: 'OpenAI rate limit',
    }, 'ord_retry_failed');

    const { retryOrderFulfillment } = await import('../src/lib/admin-actions.ts');
    const result = await retryOrderFulfillment('ord_retry_failed', {
      generateImages: async (prompts) => prompts.map(() => null),
      sleep: async () => {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 502);
    assert.match(result.error, /image_generation_incomplete/);

    const { getOrder } = await import('../src/lib/orders.ts');
    const after = await getOrder('ord_retry_failed');
    assert.equal(after?.fulfillmentStatus, 'failed_manual_review');
    assert.notEqual(after?.fulfillmentLastError, 'OpenAI rate limit');
    assert.match(after?.fulfillmentLastError ?? '', /image_generation_incomplete/);
  } finally { cleanup(dir); }
});
