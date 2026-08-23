/**
 * Mobile (Pixel 5, 393x851, touch) counterpart to processing-copy-surfaces.spec.ts.
 *
 * The processing copy is the longest text added to these four surfaces, so the
 * narrow viewport is where a layout regression would show first. Kept to the
 * two highest-risk surfaces plus both status branches so the mobile lane stays
 * fast.
 */
import { test, expect } from './fixtures.ts';
import { PROOF_REVIEW_ASSURANCE, PROOF_VOLUME_NOTE } from '../../src/lib/proof-turnaround.ts';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page must not scroll horizontally on mobile').toBeLessThanOrEqual(0);
}

test('homepage renders the processing copy without sideways scroll on mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText(PROOF_REVIEW_ASSURANCE);
  await expect(page.locator('body')).toContainText(PROOF_VOLUME_NOTE);
  await expectNoHorizontalOverflow(page);
});

test('checkout renders the processing copy without sideways scroll on mobile', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.locator('body')).toContainText(PROOF_VOLUME_NOTE);
  await expect(page.locator('body')).toContainText(/Nothing prints until/i);
  await expectNoHorizontalOverflow(page);
});

test('status keeps the same note/no-note decision on mobile', async ({ seed, page }) => {
  const waiting = seed({ overrides: { fulfillmentStatus: 'generating_images', storyArtifactUrl: null } });
  await page.goto(`/status/${waiting.orderId}`);
  await expect(page.locator('body')).toContainText(PROOF_VOLUME_NOTE);
  await expectNoHorizontalOverflow(page);

  const emailFailed = seed({ overrides: { fulfillmentStatus: 'delivery_email_failed' } });
  await page.goto(`/status/${emailFailed.orderId}`);
  await expect(page.locator('body')).not.toContainText(PROOF_VOLUME_NOTE);
  await expectNoHorizontalOverflow(page);
});
