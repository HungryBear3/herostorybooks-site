/**
 * Mobile-viewport regression for the customer text-placement editor.
 *
 * Runs under real touch emulation (Pixel 5: 393x851, hasTouch, isMobile), so
 * taps are genuine touch events and the 44px target rules are measured against
 * the layout customers actually get on a phone.
 */
import { test, expect, overrideOf } from './fixtures.ts';

/** Every interactive control the editor exposes, with its minimum target. */
const TOUCH_TARGETS = [
  'layout-save',
  'layout-reset',
  'layout-request-help',
  'layout-done',
  'layout-opacity',
  'layout-fontscale',
  'layout-resize-handle',
] as const;

test.describe('mobile layout and touch interaction', () => {
  test('the editor opens by tap and fits the viewport', async ({ page, seed, gotoReview }) => {
    const o = seed();
    await gotoReview(o, page);

    await page.getByTestId('open-layout-editor').tap();
    await expect(page.getByTestId('customer-layout-editor')).toBeVisible();
    await expect(page.getByTestId('layout-save')).not.toHaveText(/Checking fit/);

    // The page must never scroll sideways on a phone.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    // The editor itself must sit inside the viewport.
    const box = await page.getByTestId('customer-layout-editor').boundingBox();
    const width = page.viewportSize()!.width;
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  });

  test('every control meets the 44px touch-target minimum', async ({ page, seed, openEditor }) => {
    const o = seed({ withOverride: true });
    await openEditor(o, page);

    for (const id of TOUCH_TARGETS) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} must be rendered`).not.toBeNull();
      expect(box!.height, `${id} height`).toBeGreaterThanOrEqual(43.5);
      // Sliders are full-width; buttons and the handle must also be wide enough.
      expect(box!.width, `${id} width`).toBeGreaterThanOrEqual(43.5);
    }
  });

  test('the colour swatches are tappable and wrap instead of overflowing', async ({ page, seed, openEditor }) => {
    const o = seed();
    await openEditor(o, page);

    const charcoal = page.getByRole('button', { name: /Charcoal/i });
    const box = await charcoal.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);

    await charcoal.tap();
    await expect(charcoal).toHaveAttribute('aria-pressed', 'true');
  });

  test('a touch drag moves the card and stays inside the page-safe area', async ({ page, seed, openEditor }) => {
    const o = seed({ withOverride: true });
    await openEditor(o, page);

    const card = page.getByTestId('layout-card');
    const before = (await card.boundingBox())!;

    // Real pointer/touch gesture: the card uses pointer capture + touch-none.
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 30, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => (await card.boundingBox())!.x).toBeGreaterThan(before.x);

    const status = await page.getByTestId('layout-geometry-status').textContent();
    const nums = (status ?? '').match(/(\d+)%/g)?.map((s) => parseInt(s, 10)) ?? [];
    expect(nums[0]).toBeGreaterThanOrEqual(4); // still inside the 5% safe margin
    expect(nums[1]).toBeGreaterThanOrEqual(4);
  });

  test('a placement saved on mobile persists server-side', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed();
    await openEditor(o, page);

    await page.getByTestId('layout-opacity').fill('0.8');
    await expect(page.getByTestId('layout-save')).toBeEnabled();
    await page.getByTestId('layout-save').tap();

    await expect(page.getByTestId('customer-layout-editor')).toHaveCount(0);
    const ov = overrideOf(readOrder(o.orderId));
    expect(ov).not.toBeNull();
    expect(ov.opacity).toBeCloseTo(0.8, 2);
  });

  test('request help by tap keeps the editor open on mobile', async ({ page, seed, openEditor, readOrder }) => {
    const o = seed();
    await openEditor(o, page);

    await page.getByTestId('layout-request-help').tap();
    await expect(page.getByTestId('layout-status')).not.toBeEmpty();
    await expect(page.getByTestId('customer-layout-editor')).toBeVisible();

    const events = (readOrder(o.orderId).auditEvents ?? [])
      .filter((e: any) => e.type === 'layout_help_requested');
    expect(events).toHaveLength(1);
  });

  test('a closed lifecycle offers no editing on mobile either', async ({ page, seed, gotoReview }) => {
    const o = seed({ state: 'approved' });
    await gotoReview(o, page);
    await expect(page.getByTestId('open-layout-editor')).toHaveCount(0);
  });
});
