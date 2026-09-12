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
  await page.getByRole('button', { name: 'Save Dad' }).click();
  await page.getByTestId('checkout-bottom-continue').click();

  await pay.click();

  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.orderRequests, 'one submit, one order').toHaveLength(1);
  expect(harness.orderBodies[0]).toMatch(
    /name="checkoutAttemptId"\r?\n\r?\n[a-f0-9]{32}\r?\n/,
  );
});

test('a private browser that blocks sessionStorage uses one server lease and starts one order', async ({ page, baseURL }) => {
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

  await expect.poll(() => harness.attemptLeaseRequests).toEqual(['POST']);
  await expect.poll(() => harness.orderRequests).toHaveLength(1);
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.orderBodies[0]).toMatch(
    new RegExp(`name="checkoutAttemptId"\\r?\\n\\r?\\n${'e'.repeat(32)}\\r?\\n`),
  );
});

test('a private browser whose sessionStorage methods throw still reaches one Stripe handoff', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const denied = () => { throw new DOMException('Storage is unavailable', 'SecurityError'); };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: denied, setItem: denied, removeItem: denied, clear: denied, key: denied, length: 0 },
    });
  });
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);
  await pay.click();

  await expect.poll(() => harness.attemptLeaseRequests).toEqual(['POST']);
  await expect.poll(() => harness.orderRequests).toHaveLength(1);
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
});

test('a private browser whose storage and Web Locks are denied still reaches one Stripe handoff', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const denied = () => { throw new DOMException('Storage is unavailable', 'SecurityError'); };
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: denied, setItem: denied, removeItem: denied, clear: denied, key: denied, length: 0 },
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        async request() {
          throw new DOMException('Web Locks are unavailable', 'SecurityError');
        },
      },
    });
  });
  const harness = await installHandoffHarness(page, baseURL!, { redirectTo: STRIPE_SESSION_URL });
  const pay = await fillCheckoutToReview(page);

  await pay.click();

  await expect.poll(() => harness.attemptLeaseRequests).toEqual(['POST']);
  await expect.poll(() => harness.orderRequests).toHaveLength(1);
  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
});

test('conflicting lower-risk markers converge to the already-sent attempt without a recovery API', async ({ page, baseURL }) => {
  const stalePrimary = '1'.repeat(32);
  const sentAttempt = '2'.repeat(32);
  await page.addInitScript(({ stalePrimary, sentAttempt }) => {
    sessionStorage.setItem('hsb-checkout-attempt-id', stalePrimary);
    sessionStorage.setItem('hsb-checkout-attempt-reserved', stalePrimary);
    sessionStorage.setItem('hsb-checkout-attempt-sent', sentAttempt);
  }, { stalePrimary, sentAttempt });
  const harness = await installHandoffHarness(page, baseURL!, {
    redirectTo: STRIPE_SESSION_URL,
  });
  const pay = await fillCheckoutToReview(page);

  await pay.click();

  await expect(page.locator(`#${STRIPE_STUB_MARKER}`)).toBeVisible();
  expect(harness.attemptLeaseRequests, 'readable browser storage must not be bypassed by a server lease').toHaveLength(0);
  expect(harness.attemptStatusRequests, 'local convergence must not enumerate orders').toHaveLength(0);
  expect(harness.orderRequests, 'recovery reuses exactly one order attempt').toHaveLength(1);
  expect(harness.orderBodies[0]).toMatch(
    new RegExp(`name="checkoutAttemptId"\\r?\\n\\r?\\n${sentAttempt}\\r?\\n`),
  );
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

test('a picker error after an ambiguous hand-off keeps the entire banner reconciliation-safe', async ({
  page,
  baseURL,
}) => {
  const harness = await installHandoffHarness(page, baseURL!, {
    redirectTo: 'https://checkout.stripe.com.attacker.invalid/c/pay/cs_x',
  });
  const pay = await fillCheckoutToReview(page);
  await pay.click();
  await expect(page.getByTestId('submit-error')).toContainText(/do not pay again/i);

  await page.getByRole('button', { name: 'Hero photo or description' }).click();
  await page.getByLabel('Upload hero photo from your phone').setInputFiles({
    name: 'not-a-photo.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a photo'),
  });

  const submitError = page.getByTestId('submit-error');
  await expect(submitError).toContainText('We need to confirm your order status.');
  await expect(submitError).toContainText(/do not pay again/i);
  await expect(submitError).not.toContainText("We couldn't start your order.");
  await expect(submitError).not.toContainText(/have not been charged/i);
  expect(harness.orderRequests).toHaveLength(1);
});

const RECONCILIATION_SENTENCE =
  'We could not confirm the status of this checkout. Please do not pay again — contact '
  + 'support@herostorybooks.com with your order details and we will confirm exactly what '
  + 'happened and put it right.';

test('a reconciliation refusal offers one bounded fresh attempt and never retries itself', async ({
  page,
  baseURL,
}) => {
  const harness = await installHandoffHarness(page, baseURL!, {
    orderRefusal: {
      status: 409,
      body: { error: RECONCILIATION_SENTENCE, code: 'checkout_intent_order_ownership_conflict' },
    },
  });
  const pay = await fillCheckoutToReview(page);
  await pay.click();

  const submitError = page.getByTestId('submit-error');
  await expect(submitError).toBeVisible();
  // The server's own sentence still leads, unchanged.
  await expect(submitError).toContainText(/do not pay again/i);
  await expect(submitError).toContainText(/support@herostorybooks\.com/i);
  // Plus the bounded recovery the buyer can act on, which promises nothing.
  await expect(submitError).toContainText(/submit this form once more/i);
  await expect(submitError).toContainText(/will not send a new order while that attempt is still open/i);
  await expect(submitError).not.toContainText(/have not been charged/i);
  await expect(submitError).not.toContainText(/no charge/i);
  await expect(submitError).not.toContainText(/stopped before payment/i);

  expect(new URL(page.url()).pathname).toBe('/checkout');
  // Bounded means the BUYER decides: the page must not have resubmitted itself.
  await expect(pay).toBeEnabled();
  expect(harness.orderRequests, 'a refusal may never auto-retry the order').toHaveLength(1);
});

test('an unrecognised refusal keeps the plain reconciliation answer', async ({ page, baseURL }) => {
  await installHandoffHarness(page, baseURL!, {
    orderRefusal: {
      status: 503,
      body: { error: RECONCILIATION_SENTENCE, code: 'checkout_unconfirmed' },
    },
  });
  const pay = await fillCheckoutToReview(page);
  await pay.click();

  const submitError = page.getByTestId('submit-error');
  await expect(submitError).toContainText(/do not pay again/i);
  await expect(submitError).not.toContainText(/submit this form once more/i);
});

test('a response carrying no redirect URL never navigates', async ({ page, baseURL }) => {
  await installHandoffHarness(page, baseURL!, {});
  const pay = await fillCheckoutToReview(page);
  await pay.click();

  await expect(page.getByTestId('submit-error')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/checkout');
});
