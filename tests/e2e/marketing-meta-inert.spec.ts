/**
 * Chromium proof that the Meta measurement candidate is inert on a deployment
 * that has not configured it, and that the existing GA4/HSB analytics layer
 * still works alongside it.
 *
 * The unit suites prove the controller's decision logic. What only a real
 * server and a real browser can prove is that shipping <MetaPixelMount /> in
 * the root layout does not, in fact, put a third-party script on the page.
 *
 * External analytics is blocked at the network layer as well as being
 * unconfigured, so a regression cannot quietly reach Meta, Google, or Vercel
 * from this suite: every request to a non-loopback host is aborted and
 * recorded, and the recording is asserted to be empty for ad hosts.
 *
 * Hermetic in the same way as the other specs: playwright.config.ts blanks
 * every credential, so this server is not VERCEL_ENV=production and carries no
 * NEXT_PUBLIC_META_PIXEL_ID.
 */
import { test, expect } from './fixtures.ts';
import type { Page } from '@playwright/test';

const AD_HOSTS = ['facebook.net', 'facebook.com', 'fbcdn.net', 'redditstatic.com', 'reddit.com'];

/** Public funnel routes plus the private ones the pixel must never touch. */
const ROUTES = ['/', '/about', '/samples', '/pricing', '/gifts', '/gifts/birthdays', '/checkout', '/thank-you'];

async function blockExternal(page: Page): Promise<string[]> {
  const attempted: string[] = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost') || url.startsWith('data:')) {
      await route.continue();
      return;
    }
    attempted.push(url);
    await route.abort();
  });
  return attempted;
}

test('no Meta or Reddit request is attempted from any public or private route', async ({ page }) => {
  const attempted = await blockExternal(page);
  for (const route of ROUTES) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
  }
  const adRequests = attempted.filter((url) => AD_HOSTS.some((host) => url.includes(host)));
  expect(adRequests, `ad-platform requests were attempted: ${adRequests.join(', ')}`).toEqual([]);
});

test('no Meta runtime is installed on the page', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const globals = await page.evaluate(() => ({
    fbq: typeof (window as unknown as { fbq?: unknown }).fbq,
    _fbq: typeof (window as unknown as { _fbq?: unknown })._fbq,
    script: document.getElementById('hsb-meta-pixel') !== null,
  }));
  expect(globals).toEqual({ fbq: 'undefined', _fbq: 'undefined', script: false });
});

test('the existing HSB analytics layer still records sanitized page views', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/checkout?childName=PrivateName', { waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { hsbEvents?: unknown[] }).hsbEvents?.length ?? 0))
    .toBeGreaterThan(0);

  const events = await page.evaluate(() => (window as unknown as {
    hsbEvents?: Record<string, unknown>[];
  }).hsbEvents ?? []);

  expect(events.some((e) => e.event === 'page_view')).toBe(true);
  expect(events.some((e) => e.event === 'begin_checkout')).toBe(true);
  // The prefill value in the query string never reaches the event buffer.
  expect(JSON.stringify(events)).not.toContain('PrivateName');
  for (const event of events) {
    expect(String(event.href ?? '')).not.toContain('?');
    expect(String(event.pathname ?? '')).not.toContain('?');
  }
});

test('the family-review CSP still forbids third-party scripts', async ({ request }) => {
  const response = await request.get('/family-review', { failOnStatusCode: false });
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).toContain("connect-src 'self'");
  for (const host of AD_HOSTS) expect(csp).not.toContain(host);
});
