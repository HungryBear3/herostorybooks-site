/**
 * Mobile (Pixel 5, 393x851, touch) counterpart to public-ai-surfaces.spec.ts.
 *
 * The JSON endpoints are viewport-independent, so the mobile lane only covers
 * what a narrow viewport can actually break: the homepage still renders its
 * JSON-LD and its prices, without sideways scroll.
 */
import { test, expect } from './fixtures.ts';
import { PUBLIC_CATALOG } from '../../src/lib/public-catalog.ts';

test('homepage JSON-LD and prices survive a mobile render', async ({ page }) => {
  await page.goto('/');

  const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
  const graph = JSON.parse(raw!);
  expect(graph['@graph'].filter((n: { '@type': string }) => n['@type'] === 'Product')).toHaveLength(
    PUBLIC_CATALOG.products.length,
  );

  const body = await page.locator('body').innerText();
  for (const product of PUBLIC_CATALOG.products) {
    expect(body).toContain(product.priceDisplay);
  }

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page must not scroll horizontally on mobile').toBeLessThanOrEqual(0);
});
