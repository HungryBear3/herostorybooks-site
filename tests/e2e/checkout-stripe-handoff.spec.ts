/**
 * Browser → Stripe Checkout hand-off (desktop Chromium).
 *
 * Regression cover for the 2026-08-26 incident: the backend created a durable
 * draft order bound to an open Stripe Checkout Session and returned HTTP 200,
 * but the customer never reached payment and no PaymentIntent was ever bound.
 * The form waited 1.2s in a setTimeout before navigating, so anything that
 * interrupted that window stranded a buyer whose order already existed.
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

test('a successful order response hands off to Stripe immediately, with no timer', async ({
  page,
  baseURL,
}) => {
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);

  const startedAt = Date.now();
  await pay.click();
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  const elapsed = Date.now() - startedAt;

  expect(page.url()).toBe(STRIPE_SESSION_URL);
  expect(harness.orderRequests).toHaveLength(1);
  // The removed delay was 1200 ms. This bound is not a performance target — it
  // is the regression signal that no timer sits in the hand-off path.
  expect(elapsed, 'hand-off must not be gated behind a timer').toBeLessThan(1000);
});

test('the hand-off replaces the checkout entry so Back does not return to a submitted form', async ({
  page,
  baseURL,
}) => {
  await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  await page.goto('/');
  const pay = await fillCheckoutToReview(page);
  await pay.click();
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();

  await page.goBack();
  // location.replace() dropped /checkout from history; href would have kept it.
  expect(new URL(page.url()).pathname).toBe('/');
});

test('clicks batched in one task create only one order/session attempt', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);

  await clickInSameTask(pay, 3);

  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.orderRequests, 'one submit, one order').toHaveLength(1);
});

test('a restricted in-app browser without Web Crypto ID methods can still start one order', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(Crypto.prototype, 'getRandomValues', {
      configurable: true,
      value: undefined,
    });
  });
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);
  await page.getByRole('button', { name: /People and pets/ }).click();
  await page.getByRole('button', { name: /Dad/ }).click();
  await page.getByPlaceholder('e.g., Alexy').fill('Dad');
  await page.getByPlaceholder(/Hair, skin tone/).fill('Short brown hair and glasses');
  await page.getByRole('button', { name: 'Save person' }).click();
  await page.getByTestId('checkout-bottom-continue').click();

  await pay.click();

  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.orderRequests, 'one submit, one order').toHaveLength(1);
  expect(harness.orderBodies[0]).toMatch(
    /name="checkoutAttemptId"\r?\n\r?\n[a-f0-9]{32}\r?\n/,
  );
});

test('an in-app browser that blocks sessionStorage can still start one order', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage is unavailable', 'SecurityError');
      },
    });
  });
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);

  await pay.click();

  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.orderRequests, 'one submit, one order').toHaveLength(1);
});

test('a dropped hand-off leaves a working manual link to the SAME session', async ({
  page,
  baseURL,
}) => {
  const harness = await installHandoffHarness(page, baseURL!, {
    redirectTo: STRIPE_SESSION_URL,
    dropFirstStripeNavigation: true,
  });

  const pay = await fillCheckoutToReview(page);
  await pay.click();

  // The browser swallowed the navigation. Before this fix the customer was
  // stranded here indefinitely with an order and Stripe Session already
  // created server-side, and no way forward.
  const fallback = page.getByTestId('stripe-handoff-fallback');
  await expect(fallback).toBeVisible();
  await expect(fallback).toHaveAttribute('href', STRIPE_SESSION_URL);
  await expect(page.locator('body')).toContainText(/does not create a second order/i);
  expect(harness.orderRequests).toHaveLength(1);

  await fallback.click();
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(page.url()).toBe(STRIPE_SESSION_URL);
  // Following the fallback reuses the existing session: no second order.
  expect(harness.orderRequests, 'the fallback must not create a second order').toHaveLength(1);
});

test('an unapproved redirect target fails closed and keeps the recovery path', async ({
  page,
  baseURL,
}) => {
  const harness = await installHandoffHarness(page, baseURL!, {
    redirectTo: 'https://checkout.stripe.com.attacker.invalid/c/pay/cs_x',
  });
  const pay = await fillCheckoutToReview(page);
  await pay.click();

  const submitError = page.getByTestId('submit-error');
  await expect(submitError).toBeVisible();
  await expect(submitError).toContainText(/do not pay again/i);
  await expect(submitError).toContainText(/support@herostorybooks\.com/i);
  await expect(submitError).not.toContainText(/have not been charged/i);
  // Still on checkout: the lookalike host was never navigated to.
  expect(new URL(page.url()).pathname).toBe('/checkout');
  expect(harness.orderRequests).toHaveLength(1);
  // The failed submit is retryable — the lock was released.
  await expect(pay).toBeEnabled();
});

test('a response carrying no redirect URL never navigates', async ({ page, baseURL }) => {
  await installHandoffHarness(page, baseURL!, {});
  const pay = await fillCheckoutToReview(page);
  await pay.click();

  await expect(page.getByTestId('submit-error')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/checkout');
});
