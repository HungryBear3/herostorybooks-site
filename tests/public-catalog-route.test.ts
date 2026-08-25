/**
 * GET /api/public/v1/catalog — the serving contract.
 *
 * The route is the one place a private fact could escape over HTTP, so this
 * suite asserts the properties that make that impossible rather than merely
 * unlikely: the body is a pure function of the catalog module, nothing about
 * the request can change it, and no write handler exists to be called.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as route from '../src/app/api/public/v1/catalog/route.ts';
import { PUBLIC_CATALOG } from '../src/lib/public-catalog.ts';

const rawSource = readFileSync('src/app/api/public/v1/catalog/route.ts', 'utf8');

/**
 * The route's own doc comment explains why it never reads the request or sets a
 * cookie, so scanning the raw file would flag the explanation as the offence.
 * Only executable text is scanned.
 */
const source = rawSource
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('responds 200 with JSON that round-trips to the catalog exactly', async () => {
  const response = route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');

  const parsed = JSON.parse(await response.text());
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(PUBLIC_CATALOG)));
});

test('sets the reviewed caching headers and a stable ETag', async () => {
  const first = route.GET();
  const cacheControl = first.headers.get('cache-control') ?? '';
  assert.match(cacheControl, /public/);
  assert.match(cacheControl, /max-age=300/);
  assert.match(cacheControl, /s-maxage=3600/);
  assert.match(cacheControl, /stale-while-revalidate=86400/);

  const etag = first.headers.get('etag');
  assert.ok(etag && /^"[0-9a-f]{32}"$/.test(etag), `unexpected ETag: ${etag}`);

  const second = route.GET();
  assert.equal(second.headers.get('etag'), etag, 'ETag must not vary between calls');
  assert.equal(await first.text(), await second.text(), 'body must be byte-identical');
});

test('the response is statically rendered and never reads the request', () => {
  assert.match(rawSource, /export const dynamic = 'force-static'/);
  // A zero-arity GET cannot branch on a URL, header, cookie, or query string.
  assert.equal(route.GET.length, 0, 'GET must take no request argument');
  for (const forbidden of ['request', 'Request', 'headers()', 'cookies()', 'searchParams', 'nextUrl']) {
    assert.ok(
      !source.includes(forbidden),
      `route must not reference ${forbidden}; that would make the response request-dependent`,
    );
  }
});

test('no write handler exists, so Next answers other methods with 405', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD_WRITE', 'OPTIONS_WRITE']) {
    assert.equal(
      (route as Record<string, unknown>)[method],
      undefined,
      `route exports a ${method} handler`,
    );
  }
  assert.deepEqual(
    Object.keys(route).filter((key) => /^[A-Z]+$/.test(key)),
    ['GET'],
  );
});

test('the route sets no cookie and reads no environment variable', async () => {
  const response = route.GET();
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('authorization'), null);
  assert.ok(!source.includes('process.env'));
  assert.ok(!/cookie/i.test(source));
});

test('the route imports nothing but the public catalog', () => {
  const specifiers = [...rawSource.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(specifiers.sort(), ['../../../../../lib/public-catalog.ts', 'node:crypto']);
});

test('the served body carries no private marker', async () => {
  const body = (await route.GET().text()).toLowerCase();
  for (const marker of [
    'ord_',
    'sk_live',
    'sk_test',
    'pk_live',
    'whsec_',
    'blob.vercel-storage.com',
    'reviewtoken',
    'prooftoken',
    'stripe',
    'customer',
    '@gmail.com',
  ]) {
    if (marker === 'customer') {
      // "no order, customer, or delivery status" is the disclaimer denying it.
      assert.ok(
        !/customer['"]?\s*:/.test(body),
        'body exposes a customer-keyed field',
      );
      continue;
    }
    assert.ok(!body.includes(marker), `private marker "${marker}" present in public response`);
  }
});

/* ------------------------------------------------------------ middleware */

/**
 * middleware.ts uses `@/` path aliases that node's test runner cannot resolve,
 * so its structure is asserted from source here and its actual emitted headers
 * are asserted against a running server in
 * tests/e2e/public-ai-surfaces.spec.ts.
 */
test('middleware carves the catalog out of the cookie and the blanket noindex', () => {
  const middleware = readFileSync('middleware.ts', 'utf8');

  assert.match(
    middleware,
    /import \{ PUBLIC_CATALOG_ENDPOINT_PATH \} from '@\/lib\/public-catalog';/,
    'middleware must use the contract path, not a hand-copied string',
  );

  const branch = middleware.match(
    /if \(pathname === PUBLIC_CATALOG_ENDPOINT_PATH\) \{[\s\S]*?\n  \}/,
  );
  assert.ok(branch, 'middleware must special-case the catalog path');
  assert.match(branch[0], /return catalogResponse;/, 'the branch must return early');
  assert.ok(
    !/cookies\.set/.test(branch[0]),
    'the catalog response must not be handed a cookie',
  );
  assert.match(
    branch[0],
    /if \(!shouldIndexSite\(\)\) applyNoIndexHeaders/,
    'non-production must stay noindex; production must not',
  );

  // The early return has to precede the cover-variant assignment, or the
  // carve-out is decorative.
  assert.ok(
    middleware.indexOf('pathname === PUBLIC_CATALOG_ENDPOINT_PATH') <
      middleware.indexOf('response.cookies.set'),
    'the catalog branch must run before the cover-variant cookie is assigned',
  );
});

