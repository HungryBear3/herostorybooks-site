/**
 * Chromium smoke for the machine-readable public surface: the catalog endpoint,
 * llms.txt, robots, and the sitemap.
 *
 * The unit suites already prove the contract's contents. What only a real
 * server can prove is that these files are actually served, with the right
 * status, content type, and cache headers.
 *
 * Hermetic: playwright.config.ts blanks every provider credential and points the
 * order store at a throwaway .e2e-store/, so nothing here can reach Stripe,
 * Resend, a print provider, or a real order. That also means the server is NOT
 * VERCEL_ENV=production, which is exactly why the robots assertion below checks
 * that a non-production deployment stays non-indexable.
 */
import { test, expect } from './fixtures.ts';
import { PUBLIC_CATALOG } from '../../src/lib/public-catalog.ts';
import { PRODUCTION_ORIGIN } from '../../src/lib/site-url.ts';

test('the public catalog endpoint serves the contract as cacheable JSON', async ({ request }) => {
  const response = await request.get('/api/public/v1/catalog');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['cache-control']).toContain('s-maxage=3600');
  expect(response.headers()['etag']).toBeTruthy();

  // Middleware must not hand a read-only public contract a cover-variant
  // cookie, and on a non-production server it must still mark it noindex.
  expect(response.headers()['set-cookie']).toBeUndefined();
  expect(response.headers()['x-robots-tag']).toContain('noindex');

  expect(await response.json()).toEqual(JSON.parse(JSON.stringify(PUBLIC_CATALOG)));
});

test('the catalog endpoint rejects writes and ignores query parameters', async ({ request }) => {
  for (const method of ['post', 'put', 'patch', 'delete'] as const) {
    const response = await request[method]('/api/public/v1/catalog', { failOnStatusCode: false });
    expect(response.status(), `${method.toUpperCase()} must not be handled`).toBe(405);
    expect(response.headers()['allow']).toContain('GET');
  }

  const plain = await (await request.get('/api/public/v1/catalog')).text();
  const probed = await (
    await request.get('/api/public/v1/catalog?fields=*&include=orders&id=ord_1&admin=1')
  ).text();
  expect(probed, 'query parameters must not expand or filter the response').toBe(plain);
});

test('the served catalog carries no private marker', async ({ request }) => {
  const body = (await (await request.get('/api/public/v1/catalog')).text()).toLowerCase();
  for (const marker of ['ord_', 'sk_live', 'sk_test', 'whsec_', 'blob.vercel-storage.com', 'reviewtoken']) {
    expect(body, `private marker "${marker}" served publicly`).not.toContain(marker);
  }
});

test('llms.txt is served and points only at production URLs', async ({ request }) => {
  const response = await request.get('/llms.txt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/plain');

  const body = await response.text();
  expect(body).toContain(`${PRODUCTION_ORIGIN}/api/public/v1/catalog`);
  expect(body).toContain(PUBLIC_CATALOG.policies.shippingGeography);
  for (const url of [...body.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0])) {
    expect(url, 'llms.txt must not leak a preview URL').toContain(PRODUCTION_ORIGIN);
  }
});

test('a non-production deployment stays fully non-indexable', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /');
  expect(robots, 'preview must not allow crawling').not.toContain('Allow: /');
});

test('the sitemap lists only canonical production pages', async ({ request }) => {
  const response = await request.get('/sitemap.xml');
  expect(response.status()).toBe(200);

  const locs = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  expect(locs.length).toBeGreaterThan(0);
  for (const loc of locs) {
    expect(loc, 'sitemap must be production-host only').toContain(PRODUCTION_ORIGIN);
    expect(loc, 'sitemap must not list a private route').not.toMatch(
      /\/(?:api|admin|checkout|order|review|status|thank-you|family-review)(?:\/|$)/,
    );
  }
});
