/**
 * Hermetic harness for the browser → Stripe Checkout hand-off specs.
 *
 * /api/order is mocked, checkout.stripe.com is served from an in-memory stub,
 * and EVERY other off-origin request is aborted. No real order, Checkout
 * Session, PaymentIntent, charge, or network egress is possible from these
 * tests, and no Stripe credential is present in the e2e server process
 * (see playwright.config.ts).
 */
import { expect, type Locator, type Page, type Route } from '@playwright/test';

export const STRIPE_SESSION_URL = 'https://checkout.stripe.com/c/pay/cs_test_e2e_placeholder';
export const STRIPE_STUB_MARKER = 'e2e-stripe-checkout-stub';

const STRIPE_STUB_HTML =
  `<!doctype html><title>Stripe stub</title><h1 id="${STRIPE_STUB_MARKER}">Stripe Checkout stub</h1>`;

export interface HarnessOptions {
  /**
   * Body shape for the mocked order API:
   *   string    → { ok: true, redirectTo: <string> }
   *   undefined → { ok: true }  (no redirect URL at all)
   */
  redirectTo?: string;
  /**
   * Answer the FIRST navigation to Stripe with `204 No Content`, which a
   * browser treats as "abort this navigation and stay put". That is a faithful
   * reproduction of a programmatic hand-off being silently dropped — the exact
   * situation the manual fallback link exists for — without needing to patch
   * the unforgeable `window.location.replace`. Later requests get the stub, so
   * the fallback link can be followed for real.
   */
  dropFirstStripeNavigation?: boolean;
}

export interface HandoffHarness {
  /** One entry per /api/order request the page made. */
  orderRequests: string[];
}

export async function installHandoffHarness(
  page: Page,
  baseURL: string,
  options: HarnessOptions = {},
): Promise<HandoffHarness> {
  const harness: HandoffHarness = { orderRequests: [] };
  const appOrigin = new URL(baseURL).origin;
  const body = options.redirectTo !== undefined
    ? { ok: true, redirectTo: options.redirectTo }
    : { ok: true };
  let stripeNavigations = 0;

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.origin === appOrigin && url.pathname === '/api/order') {
      harness.orderRequests.push(request.method());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    }
    if (url.origin === appOrigin) return route.continue();
    if (url.hostname === 'checkout.stripe.com') {
      stripeNavigations += 1;
      if (options.dropFirstStripeNavigation && stripeNavigations === 1) {
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ status: 200, contentType: 'text/html', body: STRIPE_STUB_HTML });
    }
    // Analytics, fonts, everything else off-origin: hard-blocked.
    return route.abort();
  });

  return harness;
}

/**
 * Walk the checkout wizard to the review step with the minimum required
 * fields, and return the enabled payment CTA. Deliberately touches nothing
 * beyond what `isReadyToPay` needs — no photo, no voice note, no extra people.
 */
export async function fillCheckoutToReview(page: Page): Promise<Locator> {
  await page.goto('/checkout');
  await page.getByRole('button', { name: /Space Voyager/ }).click();
  await page.locator('#childName').fill('Testhero');

  const continueButton = page.getByTestId('checkout-bottom-continue');
  await continueButton.click(); // Hero details → Hero appearance/photo
  await page
    .getByPlaceholder('Example: 6 years old, warm brown skin, short curly dark hair, bright green hoodie')
    .fill('6 years old, short curly dark hair, bright green hoodie');
  await continueButton.click(); // → Story
  await continueButton.click(); // → People and pets
  await continueButton.click(); // → Contact, delivery, and review
  await page.locator('#email').fill('e2e-buyer@example.invalid');

  const pay = page.getByRole('button', { name: /Continue to secure payment/ });
  await expect(pay).toBeEnabled();
  return pay;
}

/**
 * Fire N clicks inside ONE task, before React can re-render the button as
 * disabled. This is the double-submit window that an `isSubmitting`-state
 * guard alone cannot close: every click in the batch reads the pre-update
 * value. Only the ref-backed submit lock stops it.
 */
export async function clickInSameTask(target: Locator, times: number): Promise<void> {
  await target.evaluate((element, count) => {
    for (let i = 0; i < count; i += 1) (element as HTMLElement).click();
  }, times);
}
