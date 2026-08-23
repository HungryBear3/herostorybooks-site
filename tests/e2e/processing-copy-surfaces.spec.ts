/**
 * Committed Chromium coverage for the four customer surfaces that carry the
 * honest processing-expectation copy: homepage, checkout (pre-payment),
 * thank-you, and order status.
 *
 * Before this file the Playwright suite exercised only the text-placement
 * editor, so a copy regression on any of these four could ship green. The
 * status assertions in particular lock the two defects confirmed in candidate
 * c66ed44: the wait note must NOT appear once the proof exists
 * (`delivery_email_failed`, `complete`), and must never sit under a subhead
 * promising a minutes-scale wait.
 *
 * Hermetic: playwright.config.ts blanks every provider credential and points the
 * order store at a throwaway .e2e-store/, so nothing here can reach Stripe,
 * Resend, a print provider, or a real order.
 */
import { test, expect } from './fixtures.ts';
import {
  PROOF_DELAY_SUPPORT_NOTE,
  PROOF_REVIEW_ASSURANCE,
  PROOF_VOLUME_NOTE,
} from '../../src/lib/proof-turnaround.ts';

/** Short numeric timings that would contradict a multi-day queue caveat. */
const SHORT_TIMING = /\b(a few|within a|in a)\s+(minute|minutes|second|seconds)\b/i;

/** The page body must never scroll sideways, at any width. */
async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page must not scroll horizontally').toBeLessThanOrEqual(0);
}

test('homepage states the personal review and the high-volume caveat', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText(PROOF_REVIEW_ASSURANCE);
  await expect(page.locator('body')).toContainText(PROOF_VOLUME_NOTE);
  await expectNoHorizontalOverflow(page);
});

test('checkout states the expectation before payment and keeps the proof-first promise', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.locator('body')).toContainText(PROOF_REVIEW_ASSURANCE);
  await expect(page.locator('body')).toContainText(PROOF_VOLUME_NOTE);
  // Proof-first control must survive any copy edit.
  await expect(page.locator('body')).toContainText(/Nothing prints until/i);
  await expectNoHorizontalOverflow(page);
});

test('thank-you states the expectation and the support path for a paid order', async ({ seed, page }) => {
  const order = seed();
  await page.goto(`/thank-you?orderId=${order.orderId}`);
  await expect(page.locator('body')).toContainText(PROOF_REVIEW_ASSURANCE);
  await expect(page.locator('body')).toContainText(PROOF_VOLUME_NOTE);
  await expect(page.locator('body')).toContainText(PROOF_DELAY_SUPPORT_NOTE);
  await expectNoHorizontalOverflow(page);
});

test('status shows the wait note while the proof is still being produced', async ({ seed, page }) => {
  const order = seed({ overrides: { fulfillmentStatus: 'generating_images', storyArtifactUrl: null } });
  await page.goto(`/status/${order.orderId}`);
  const body = page.locator('body');
  await expect(body).toContainText(PROOF_VOLUME_NOTE);
  await expect(body).toContainText(PROOF_DELAY_SUPPORT_NOTE);
  // Defect 2: the note must not sit under a minutes-scale promise.
  await expect(body).not.toContainText(SHORT_TIMING);
  await expectNoHorizontalOverflow(page);
});

test('status hides the wait note once the proof exists but delivery email failed', async ({ seed, page }) => {
  // Defect 1: artifacts are built and only the notification failed, so a
  // queue-delay explanation would misstate the cause.
  const order = seed({ overrides: { fulfillmentStatus: 'delivery_email_failed' } });
  await page.goto(`/status/${order.orderId}`);
  await expect(page.locator('body')).not.toContainText(PROOF_VOLUME_NOTE);
  await expectNoHorizontalOverflow(page);
});

test('status hides the wait note for a completed order', async ({ seed, page }) => {
  const order = seed({ overrides: { fulfillmentStatus: 'complete' } });
  await page.goto(`/status/${order.orderId}`);
  await expect(page.locator('body')).not.toContainText(PROOF_VOLUME_NOTE);
  await expectNoHorizontalOverflow(page);
});

test('status hides the wait note for an unpaid order', async ({ seed, page }) => {
  const order = seed({ state: 'unpaid' });
  await page.goto(`/status/${order.orderId}`);
  await expect(page.locator('body')).not.toContainText(PROOF_VOLUME_NOTE);
  await expectNoHorizontalOverflow(page);
});
