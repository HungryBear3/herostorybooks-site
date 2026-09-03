import { test, expect } from '@playwright/test';
import { installHandoffHarness } from './checkout-handoff-harness.ts';

test('bottom Continue validates, advances every step, and never submits the form', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.goto('/checkout');

  const bottom = page.getByTestId('checkout-bottom-continue');
  await expect(bottom).toBeVisible();
  await expect(bottom).toHaveText('Continue to Hero appearance/photo');

  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hero details' })).toBeVisible();
  await expect(page.getByText(/^Missing: Story direction/)).toBeVisible();
  expect(harness.orderRequests).toHaveLength(0);

  await page.getByRole('button', { name: /Space Voyager/ }).click();
  await page.locator('#childName').fill('Testhero');
  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hero appearance/photo' })).toBeVisible();
  await expect(bottom).toHaveText('Continue to Story');

  await page
    .getByPlaceholder('Example: 6 years old, warm brown skin, short curly dark hair, bright green hoodie')
    .fill('6 years old, short curly dark hair, bright green hoodie');
  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Story' })).toBeVisible();
  await expect(bottom).toHaveText('Continue to People and pets');

  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'People and pets' })).toBeVisible();
  await expect(bottom).toHaveText('Continue to Contact, delivery, and review');

  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Contact, delivery, and review' })).toBeVisible();
  await expect(bottom).toHaveCount(0);
  expect(harness.orderRequests).toHaveLength(0);
});
