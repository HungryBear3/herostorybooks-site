/**
 * Checkout review layout regression.
 *
 * Contact, delivery, and shipping-quote inputs must live in the wide primary
 * column. The book preview and order summary stay a compact secondary sidebar
 * on desktop, and everything stacks with no horizontal overflow on mobile.
 *
 * Hermetic: see tests/e2e/checkout-handoff-harness.ts. Shipping quote, intake,
 * and recovery calls are also intercepted here, so no geometry check can reach
 * a real quote, upload, order, or payment path.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';

import { fillCheckoutToReview, installHandoffHarness } from './checkout-handoff-harness.ts';

const SIDE_EFFECT_PATHS = ['/api/checkout/shipping', '/api/checkout/intake', '/api/recovery'];

async function interceptCheckoutSideEffects(page: Page): Promise<string[]> {
  const calls: string[] = [];
  await page.route(
    (url) => SIDE_EFFECT_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`)),
    async (route) => {
      calls.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    },
  );
  return calls;
}

function quoteOrIntakeCalls(calls: string[]): string[] {
  return calls.filter((path) => !path.startsWith('/api/recovery'));
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

const EXPEDITED_FIELD_LABELS = [
  'Delivery recipient name',
  'Delivery phone',
  'Street address',
  'Apartment or unit (optional)',
  'City',
  'State (2 letters)',
  'ZIP code',
] as const;

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 1024, height: 768 },
] as const;

/**
 * Choose a printed format and the Expedited radio only. Never presses
 * "Get shipping quote" or Pay; this is local UI state, and the interceptor
 * would record any quote/intake request it caused.
 */
async function openExpeditedContactFields(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /Classic softcover/ }).click();
  const fieldset = page.getByTestId('checkout-shipping-options');
  await expect(fieldset).toBeVisible();
  const expedited = fieldset.getByRole('radio', { name: 'Expedited shipping' });
  await expedited.check();
  await expect(expedited).toBeChecked();
  await expect(fieldset.getByText(/US delivery recipient/)).toBeVisible();
  for (const label of EXPEDITED_FIELD_LABELS) {
    await expect(fieldset.getByLabel(label, { exact: true })).toBeVisible();
  }
  await expect(fieldset.getByRole('button', { name: 'Get shipping quote' })).toBeVisible();
  return fieldset;
}

/**
 * Instant-scroll the window, then wait until scrollY, both sidebar rects, and
 * document height are unchanged for two consecutive animation frames. This
 * also cancels any smooth scrollIntoView still running from step navigation.
 */
async function scrollAndSettle(page: Page, y: number): Promise<number> {
  return page.evaluate(async (target) => {
    window.scrollTo({ top: target, left: 0, behavior: 'instant' });
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const snapshot = () => {
      const summary = document.querySelector('[data-testid="checkout-secondary-summary"]')?.getBoundingClientRect();
      const next = document.querySelector('[data-testid="checkout-secondary-next-steps"]')?.getBoundingClientRect();
      return [window.scrollY, summary?.top, summary?.bottom, next?.top, next?.bottom, document.documentElement.scrollHeight].join('|');
    };
    let previous = snapshot();
    let stableFrames = 0;
    for (let i = 0; i < 120 && stableFrames < 2; i += 1) {
      await frame();
      const current = snapshot();
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
    }
    if (stableFrames < 2) throw new Error(`scroll/layout did not settle near ${target}`);
    return window.scrollY;
  }, y);
}

/** Live getBoundingClientRect geometry, with intersection clipped to the visible viewport. */
async function sidebarGeometry(page: Page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const measure = (testId: string) => {
      const node = document.querySelector(`[data-testid="${testId}"]`);
      if (!node) throw new Error(`missing ${testId}`);
      const r = node.getBoundingClientRect();
      const visible = {
        left: Math.max(0, r.left),
        top: Math.max(0, r.top),
        right: Math.min(viewportWidth, r.right),
        bottom: Math.min(viewportHeight, r.bottom),
      };
      return {
        top: r.top, left: r.left, right: r.right, bottom: r.bottom, height: r.height,
        visible,
        visibleHeight: Math.max(0, visible.bottom - visible.top),
      };
    };
    const summary = measure('checkout-secondary-summary');
    const nextSteps = measure('checkout-secondary-next-steps');
    const primary = measure('checkout-primary-review');
    const width = Math.max(0, Math.min(summary.visible.right, nextSteps.visible.right) - Math.max(summary.visible.left, nextSteps.visible.left));
    const height = Math.max(0, Math.min(summary.visible.bottom, nextSteps.visible.bottom) - Math.max(summary.visible.top, nextSteps.visible.top));
    return {
      scrollY: window.scrollY,
      maxScrollY: document.documentElement.scrollHeight - viewportHeight,
      viewportWidth,
      viewportHeight,
      summary,
      nextSteps,
      primary,
      overlap: { width, height, area: width * height },
    };
  });
}

test('desktop review puts contact inputs in the wide primary column beside a compact summary', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  const sideEffects = await interceptCheckoutSideEffects(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await fillCheckoutToReview(page);
  await page.evaluate(() => window.scrollTo(0, 0));

  const steps = page.getByTestId('checkout-primary-steps');
  const primary = page.getByTestId('checkout-primary-review');
  const summary = page.getByTestId('checkout-secondary-summary');
  const email = page.locator('#email');
  await expect(primary).toBeVisible();
  await expect(summary).toBeVisible();
  await expect(primary.locator('#email')).toHaveCount(1);
  await expect(primary.locator('button[type="submit"]')).toHaveCount(1);
  await expect(summary.locator('input, select, textarea, button')).toHaveCount(0);

  const stepsBox = await box(steps);
  const primaryBox = await box(primary);
  const summaryBox = await box(summary);
  const emailBox = await box(email);

  // Primary inputs share the wide main column with the step content.
  expect(Math.abs(primaryBox.x - stepsBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(primaryBox.width - stepsBox.width)).toBeLessThanOrEqual(1);
  expect(primaryBox.y).toBeGreaterThanOrEqual(stepsBox.y + stepsBox.height - 1);

  // The summary is a compact sidebar to the right, starting at the top row.
  expect(primaryBox.x + primaryBox.width).toBeLessThanOrEqual(summaryBox.x + 1);
  expect(summaryBox.width).toBeLessThanOrEqual(360);
  expect(primaryBox.width).toBeGreaterThan(summaryBox.width * 1.6);
  expect(Math.abs(summaryBox.y - stepsBox.y)).toBeLessThanOrEqual(2);

  // The contact input itself is primary-width, not sidebar-width.
  expect(emailBox.width).toBeGreaterThan(summaryBox.width);
  expect(emailBox.x + emailBox.width).toBeLessThanOrEqual(summaryBox.x);

  // DOM/focus order still runs from the contact input to the payment button.
  const emailPrecedesPay = await page.evaluate(() => {
    const emailNode = document.querySelector('#email');
    const payNode = document.querySelector('form button[type="submit"]');
    return Boolean(
      emailNode && payNode && emailNode.compareDocumentPosition(payNode) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(emailPrecedesPay).toBe(true);

  await expectNoHorizontalOverflow(page);
  expect(harness.orderRequests).toHaveLength(0);
  expect(quoteOrIntakeCalls(sideEffects)).toHaveLength(0);
});

test('shipping options heading sits inside its bordered, padded box in the primary column', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  const sideEffects = await interceptCheckoutSideEffects(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await fillCheckoutToReview(page);
  await page.getByRole('button', { name: /Classic softcover/ }).click();

  // playwright.layout.config.ts sets the direct-upload and both expedited
  // flags explicitly to true, so a missing fieldset or heading is a
  // regression, never a skip.
  const fieldset = page.getByTestId('checkout-shipping-options');
  const heading = page.getByTestId('checkout-shipping-options-heading');
  await expect(fieldset).toHaveCount(1);
  await expect(heading).toHaveCount(1);
  await expect(fieldset).toBeVisible();
  await expect(heading).toHaveText('Shipping options');
  expect(await heading.evaluate((node) => getComputedStyle(node).float)).toBe('left');

  const primaryBox = await box(page.getByTestId('checkout-primary-review'));
  const fieldsetBox = await box(fieldset);
  const headingBox = await box(heading);
  const firstChoiceBox = await box(fieldset.locator('label').first());

  // The heading is inside the border, offset by the box padding on every side.
  expect(headingBox.y).toBeGreaterThanOrEqual(fieldsetBox.y + 12);
  expect(headingBox.x).toBeGreaterThanOrEqual(fieldsetBox.x + 12);
  expect(headingBox.x + headingBox.width).toBeLessThanOrEqual(fieldsetBox.x + fieldsetBox.width - 12);
  // It lines up with the choices and sits above them.
  expect(Math.abs(headingBox.x - firstChoiceBox.x)).toBeLessThanOrEqual(1);
  expect(firstChoiceBox.y).toBeGreaterThanOrEqual(headingBox.y + headingBox.height);
  // The shipping box belongs to the wide primary column.
  expect(fieldsetBox.x).toBeGreaterThanOrEqual(primaryBox.x - 1);
  expect(fieldsetBox.x + fieldsetBox.width).toBeLessThanOrEqual(primaryBox.x + primaryBox.width + 1);

  expect(harness.orderRequests).toHaveLength(0);
  expect(quoteOrIntakeCalls(sideEffects)).toHaveLength(0);
});

test('mobile review stacks summary above full-width contact inputs with no horizontal overflow', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  const sideEffects = await interceptCheckoutSideEffects(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await fillCheckoutToReview(page);
  await page.evaluate(() => window.scrollTo(0, 0));

  const steps = page.getByTestId('checkout-primary-steps');
  const summary = page.getByTestId('checkout-secondary-summary');
  const primary = page.getByTestId('checkout-primary-review');
  const nextSteps = page.getByTestId('checkout-secondary-next-steps');

  const stepsBox = await box(steps);
  const summaryBox = await box(summary);
  const primaryBox = await box(primary);
  const nextStepsBox = await box(nextSteps);
  const emailBox = await box(page.locator('#email'));

  // One clean column in the same order as before: steps, summary, inputs, next steps.
  expect(summaryBox.y).toBeGreaterThanOrEqual(stepsBox.y + stepsBox.height - 1);
  expect(primaryBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height - 1);
  expect(nextStepsBox.y).toBeGreaterThanOrEqual(primaryBox.y + primaryBox.height - 1);
  for (const column of [stepsBox, summaryBox, primaryBox, nextStepsBox]) {
    expect(Math.abs(column.x - stepsBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(column.width - stepsBox.width)).toBeLessThanOrEqual(1);
    expect(column.x).toBeGreaterThanOrEqual(0);
    expect(column.x + column.width).toBeLessThanOrEqual(390);
  }
  expect(emailBox.x).toBeGreaterThanOrEqual(primaryBox.x);
  expect(emailBox.x + emailBox.width).toBeLessThanOrEqual(primaryBox.x + primaryBox.width);

  await expectNoHorizontalOverflow(page);
  expect(harness.orderRequests).toHaveLength(0);
  expect(quoteOrIntakeCalls(sideEffects)).toHaveLength(0);
});

for (const viewport of DESKTOP_VIEWPORTS) {
  for (const shippingState of ['standard', 'expedited-open'] as const) {
    test(`desktop ${viewport.width}x${viewport.height} (${shippingState}): scrolled summary never covers What happens next`, async ({ page, baseURL }) => {
      const harness = await installHandoffHarness(page, baseURL!);
      const sideEffects = await interceptCheckoutSideEffects(page);
      await page.setViewportSize(viewport);
      await fillCheckoutToReview(page);
      if (shippingState === 'expedited-open') await openExpeditedContactFields(page);

      await scrollAndSettle(page, 0);
      const top = await sidebarGeometry(page);
      // The two-column desktop grid is really active at this width.
      expect(top.summary.left).toBeGreaterThanOrEqual(top.primary.right - 1);
      expect(top.nextSteps.left).toBeGreaterThanOrEqual(top.primary.right - 1);
      expect(top.maxScrollY, 'page must be scrollable for this check to mean anything').toBeGreaterThan(0);

      const nextDocTop = top.nextSteps.top + top.scrollY;
      const targets = [
        Math.max(1, Math.round(top.maxScrollY / 2)),
        Math.min(top.maxScrollY, Math.max(1, Math.round(nextDocTop - top.viewportHeight / 2))),
        top.maxScrollY,
      ];
      for (const target of targets) {
        const actual = await scrollAndSettle(page, target);
        // The targeted scroll was actually exercised, not clamped back to 0.
        expect(Math.abs(actual - target)).toBeLessThanOrEqual(1);
        expect(actual).toBeGreaterThan(0);
        const geometry = await sidebarGeometry(page);
        // Only the visible intersection matters. The summary may legitimately
        // have scrolled out once its sticky containing block ends.
        expect(
          geometry.overlap.area,
          `visible summary/next-steps overlap at scrollY=${actual}: ${JSON.stringify(geometry)}`,
        ).toBeLessThanOrEqual(1);
      }

      const bottom = await sidebarGeometry(page);
      expect(Math.abs(bottom.scrollY - bottom.maxScrollY)).toBeLessThanOrEqual(1);
      // What happens next can be fully seen at the bottom (or fills the viewport).
      expect(bottom.nextSteps.visibleHeight).toBeGreaterThanOrEqual(
        Math.min(bottom.nextSteps.height, bottom.viewportHeight) - 1,
      );

      await expectNoHorizontalOverflow(page);
      expect(harness.orderRequests).toHaveLength(0);
      expect(quoteOrIntakeCalls(sideEffects)).toHaveLength(0);
    });
  }
}

test('desktop Expedited selection opens adult delivery fields in the wide primary column', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  const sideEffects = await interceptCheckoutSideEffects(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await fillCheckoutToReview(page);
  const fieldset = await openExpeditedContactFields(page);

  const primaryBox = await box(page.getByTestId('checkout-primary-review'));
  const summaryBox = await box(page.getByTestId('checkout-secondary-summary'));
  const fieldsetBox = await box(fieldset);
  expect(fieldsetBox.x).toBeGreaterThanOrEqual(primaryBox.x - 1);
  expect(fieldsetBox.x + fieldsetBox.width).toBeLessThanOrEqual(primaryBox.x + primaryBox.width + 1);
  expect(fieldsetBox.x + fieldsetBox.width).toBeLessThanOrEqual(summaryBox.x);

  let previousY = -Infinity;
  for (const label of EXPEDITED_FIELD_LABELS) {
    const fieldBox = await box(fieldset.getByLabel(label, { exact: true }));
    expect(fieldBox.x).toBeGreaterThanOrEqual(fieldsetBox.x);
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(fieldsetBox.x + fieldsetBox.width);
    expect(fieldBox.width).toBeGreaterThanOrEqual(fieldsetBox.width - 48);
    expect(fieldBox.width).toBeGreaterThan(summaryBox.width);
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(summaryBox.x);
    expect(fieldBox.y).toBeGreaterThan(previousY);
    previousY = fieldBox.y;
  }

  await expectNoHorizontalOverflow(page);
  expect(harness.orderRequests).toHaveLength(0);
  expect(quoteOrIntakeCalls(sideEffects)).toHaveLength(0);
});

test('mobile 390 Expedited selection opens adult delivery fields without horizontal overflow', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  const sideEffects = await interceptCheckoutSideEffects(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await fillCheckoutToReview(page);
  const fieldset = await openExpeditedContactFields(page);

  const summaryBox = await box(page.getByTestId('checkout-secondary-summary'));
  const primaryBox = await box(page.getByTestId('checkout-primary-review'));
  const fieldsetBox = await box(fieldset);
  expect(primaryBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height - 1);
  expect(fieldsetBox.x).toBeGreaterThanOrEqual(Math.max(0, primaryBox.x - 1));
  expect(fieldsetBox.x + fieldsetBox.width).toBeLessThanOrEqual(Math.min(390, primaryBox.x + primaryBox.width + 1));
  expect(await fieldset.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

  let previousY = -Infinity;
  for (const label of EXPEDITED_FIELD_LABELS) {
    const fieldBox = await box(fieldset.getByLabel(label, { exact: true }));
    expect(fieldBox.x).toBeGreaterThanOrEqual(fieldsetBox.x);
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(fieldsetBox.x + fieldsetBox.width);
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(390);
    expect(fieldBox.width).toBeGreaterThanOrEqual(fieldsetBox.width - 48);
    expect(fieldBox.y).toBeGreaterThan(previousY);
    previousY = fieldBox.y;
  }

  await expectNoHorizontalOverflow(page);
  expect(harness.orderRequests).toHaveLength(0);
  expect(quoteOrIntakeCalls(sideEffects)).toHaveLength(0);
});
