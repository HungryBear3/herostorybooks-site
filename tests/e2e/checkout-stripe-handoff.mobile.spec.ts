/**
 * Mobile (Pixel 5, 393x851, touch) counterpart to
 * checkout-stripe-handoff.spec.ts.
 *
 * Mobile is where the removed 1.2s timer was most dangerous: a backgrounded or
 * discarded tab throttles or drops pending timers, so the navigation could be
 * swallowed entirely after the order and Stripe Checkout Session already
 * existed. Kept to the three highest-risk cases so the mobile lane stays fast.
 *
 * Hermetic: see tests/e2e/checkout-handoff-harness.ts.
 */
import { test, expect } from '@playwright/test';

import {
  STRIPE_SESSION_URL,
  STRIPE_STUB_MARKER,
  clickInSameTask,
  fillCheckoutToReview,
  installHandoffHarness,
} from './checkout-handoff-harness.ts';

test('mobile hands off to Stripe immediately on tap, with no timer', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);

  const startedAt = Date.now();
  await pay.tap();
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  const elapsed = Date.now() - startedAt;

  expect(page.url()).toBe(STRIPE_SESSION_URL);
  expect(harness.orderRequests).toHaveLength(1);
  expect(elapsed, 'hand-off must not be gated behind a timer').toBeLessThan(1000);
});

test('a double tap creates only one order/session attempt on mobile', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);

  await clickInSameTask(pay, 2);

  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.orderRequests, 'one tap, one order').toHaveLength(1);
});

test('a dropped hand-off leaves a working manual link on mobile', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!, {
    redirectTo: STRIPE_SESSION_URL,
    dropFirstStripeNavigation: true,
  });

  const pay = await fillCheckoutToReview(page);
  await pay.tap();

  const fallback = page.getByTestId('stripe-handoff-fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute('href', STRIPE_SESSION_URL);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'interstitial must not scroll horizontally on mobile').toBeLessThanOrEqual(0);

  await fallback.tap();
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.orderRequests, 'the fallback must not create a second order').toHaveLength(1);
});
