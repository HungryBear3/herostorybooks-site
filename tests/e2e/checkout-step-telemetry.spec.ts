/**
 * Browser smoke for the five-step checkout telemetry. Runs under the hermetic
 * hand-off harness: /api/order is mocked, every off-origin request (including
 * analytics vendors) is aborted, and the final submit is never clicked. The
 * assertions read the in-page `window.hsbEvents` buffer the analytics layer
 * keeps, which is exactly what gtag / Vercel would have been handed.
 */
import { test, expect, type Page } from '@playwright/test';
import { installHandoffHarness } from './checkout-handoff-harness.ts';

type StepEvent = { event: string; step_id?: string; reason?: string } & Record<string, unknown>;

const PII = {
  childName: 'ZQX-CHILD-7731',
  appearance: 'ZQX-APPEARANCE-7731 short curly dark hair',
  email: 'zqx.parent.7731@example.invalid',
};
const PII_TOKENS = ['ZQX', '7731', 'zqx.parent', 'example.invalid', 'curly'];

async function stepEvents(page: Page): Promise<StepEvent[]> {
  return page.evaluate(() => {
    const buffer = (window as unknown as { hsbEvents?: StepEvent[] }).hsbEvents ?? [];
    return buffer.filter((record) => String(record.event).startsWith('checkout_step_'));
  });
}

async function allEventsSerialized(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify((window as unknown as { hsbEvents?: unknown[] }).hsbEvents ?? []));
}

const shape = (events: StepEvent[]) =>
  events.map((e) => [e.event, e.step_id, e.reason ?? null] as const);

test('step view is deduplicated, complete/blocked follow validation, attribution survives, no PII is emitted', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.goto('/checkout?utm_source=founder&utm_medium=warm-intro&utm_campaign=friends&ref=e2efounder');

  const continueButton = page.getByTestId('checkout-bottom-continue');

  // Step 1 became active on mount: exactly one view.
  await expect.poll(() => stepEvents(page).then(shape)).toEqual([
    ['checkout_step_view', 'hero-details', null],
  ]);
  const firstView = (await stepEvents(page))[0];
  expect(firstView).toMatchObject({
    step_id: 'hero-details',
    step_number: 1,
    total_steps: 4,
    selected_format: 'digital',
    utm_source: 'founder',
    utm_medium: 'warm-intro',
    utm_campaign: 'friends',
    ref: 'e2efounder',
    pathname: '/checkout',
  });

  // Blocked: nothing filled in, Continue refuses with a bounded reason code.
  await continueButton.click();
  await expect(page.getByText(/^Missing: Story direction/)).toBeVisible();
  await expect.poll(() => stepEvents(page).then(shape)).toEqual([
    ['checkout_step_view', 'hero-details', null],
    ['checkout_step_blocked', 'hero-details', 'story_direction_required'],
  ]);

  // Complete step 1 → step 2 view.
  await page.getByRole('button', { name: /Space Voyager/ }).click();
  await page.locator('#childName').fill(PII.childName);
  await continueButton.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hero photo or description' })).toBeVisible();
  await expect.poll(() => stepEvents(page).then(shape)).toEqual([
    ['checkout_step_view', 'hero-details', null],
    ['checkout_step_blocked', 'hero-details', 'story_direction_required'],
    ['checkout_step_complete', 'hero-details', null],
    ['checkout_step_view', 'hero-appearance', null],
  ]);

  // Navigate back to step 1 and forward again: no second view for either step.
  await page.getByRole('button', { name: /^(✓|1)\s*Hero details$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hero details' })).toBeVisible();
  await continueButton.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hero photo or description' })).toBeVisible();
  await expect.poll(() => stepEvents(page).then(shape)).toEqual([
    ['checkout_step_view', 'hero-details', null],
    ['checkout_step_blocked', 'hero-details', 'story_direction_required'],
    ['checkout_step_complete', 'hero-details', null],
    ['checkout_step_view', 'hero-appearance', null],
    ['checkout_step_complete', 'hero-details', null],
  ]);

  // Step 2 blocked (no photo, no description), then completed with a description.
  await continueButton.click();
  await expect(page.getByText(/^Missing: Hero appearance/)).toBeVisible();
  await page.getByLabel('Describe the hero').fill(PII.appearance);
  await continueButton.click();
  await expect(page.getByRole('heading', { level: 1, name: 'People and pets' })).toBeVisible();
  await continueButton.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Contact, delivery, and review' })).toBeVisible();
  await page.locator('#email').fill(PII.email);

  await expect.poll(() => stepEvents(page).then(shape)).toEqual([
    ['checkout_step_view', 'hero-details', null],
    ['checkout_step_blocked', 'hero-details', 'story_direction_required'],
    ['checkout_step_complete', 'hero-details', null],
    ['checkout_step_view', 'hero-appearance', null],
    ['checkout_step_complete', 'hero-details', null],
    ['checkout_step_blocked', 'hero-appearance', 'hero_appearance_required'],
    ['checkout_step_complete', 'hero-appearance', null],
    ['checkout_step_view', 'people', null],
    ['checkout_step_complete', 'people', null],
    ['checkout_step_view', 'review', null],
  ]);

  // Every step event carries only the allowed fields plus the analytics
  // layer's own sanitized envelope, and attribution survives to the last step.
  const allowed = new Set([
    'event', 'timestamp', 'href', 'pathname',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref',
    'step_id', 'step_number', 'total_steps', 'selected_format', 'reason',
  ]);
  for (const event of await stepEvents(page)) {
    for (const key of Object.keys(event)) expect(allowed, `field ${key} on ${event.event}`).toContain(key);
    expect(event.utm_source).toBe('founder');
    expect(event.ref).toBe('e2efounder');
    expect(event.total_steps).toBe(4);
  }

  // The fake PII typed into the form never reached the event buffer at all —
  // not in step events and not in the pre-existing funnel events either.
  const serialized = await allEventsSerialized(page);
  for (const token of PII_TOKENS) expect(serialized, `leaked ${token}`).not.toContain(token);

  // No order, session, or submit happened.
  expect(harness.orderRequests).toHaveLength(0);
});
