import { test, expect } from '@playwright/test';
import { installHandoffHarness } from './checkout-handoff-harness.ts';

test('linear Continue controls advance every step without covering fields or submitting', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/checkout');

  const primary = page.getByTestId('checkout-primary-continue');
  const bottom = page.getByTestId('checkout-bottom-continue');
  await expect(page.getByTestId('checkout-sticky-continue')).toHaveCount(0);
  await expect(primary).toBeVisible();
  await expect(primary).toHaveText('Next: Add hero photo or description');
  await expect(bottom).toHaveText('Next: Add hero photo or description');

  await primary.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hero details' })).toBeVisible();
  await expect(page.getByText(/^Missing: Story direction/)).toBeVisible();
  await expect(page.getByTestId('checkout-theme-step')).toBeFocused();
  expect(harness.orderRequests).toHaveLength(0);

  await page.getByRole('button', { name: /Space Voyager/ }).click();
  await page.locator('#childName').fill('Testhero');
  await primary.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hero photo or description' })).toBeVisible();
  await expect(page.getByTestId('hero-photo-primary-choice')).toBeFocused();
  await expect
    .poll(async () => (await page.getByTestId('hero-photo-primary-choice').boundingBox())?.y ?? -9999)
    .toBeGreaterThanOrEqual(0);
  await expect(bottom).toHaveText('Next: Story');
  await expect(page.getByRole('heading', { name: 'Upload a photo for the best likeness' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Or describe the hero instead' })).toBeVisible();
  const photoBox = await page.getByTestId('hero-photo-primary-choice').boundingBox();
  const descriptionBox = await page.getByTestId('hero-description-alternative').boundingBox();
  expect(photoBox).not.toBeNull();
  expect(descriptionBox).not.toBeNull();
  expect(photoBox!.y).toBeGreaterThanOrEqual(0);
  expect(photoBox!.y).toBeLessThan(844);
  expect(photoBox!.y).toBeLessThan(descriptionBox!.y);
  const uploadBox = await page.getByTestId('hero-photo-upload-control').boundingBox();
  const proofExampleBox = await page.getByTestId('hero-photo-proof-example').boundingBox();
  expect(uploadBox).not.toBeNull();
  expect(proofExampleBox).not.toBeNull();
  expect(uploadBox!.y).toBeLessThan(proofExampleBox!.y);

  const uploadInput = page.getByLabel('Upload hero photo from your phone');
  const uploadControl = page.getByTestId('hero-photo-upload-control');
  await page.keyboard.press('Tab');
  await expect(uploadInput).toBeFocused();
  expect(await uploadControl.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none');
  const uploadChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await uploadChooser;

  const cameraInput = page.getByLabel('Take a new hero photo');
  const cameraControl = cameraInput.locator('xpath=..');
  await page.keyboard.press('Tab');
  await expect(cameraInput).toBeFocused();
  expect(await cameraControl.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none');
  const cameraChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await cameraChooser;

  await page
    .getByLabel('Describe the hero')
    .fill('6 years old, short curly dark hair, bright green hoodie');
  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Story' })).toBeVisible();
  await expect(bottom).toHaveText('Next: People and pets');

  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'People and pets' })).toBeVisible();
  await expect(bottom).toHaveText('Next: Contact, delivery, and review');

  await bottom.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Contact, delivery, and review' })).toBeVisible();
  await expect(bottom).toHaveCount(0);
  expect(harness.orderRequests).toHaveLength(0);
});

test('desktop header Continue uses the same owner-facing destination label', async ({ page, baseURL }) => {
  await installHandoffHarness(page, baseURL!);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/checkout');
  await expect(page.getByTestId('checkout-header-continue')).toHaveText(
    'Next: Add hero photo or description',
  );
});

test('Custom Story immediately reveals written, recording, audio, and document paths', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/checkout');

  await expect(page.getByTestId('custom-story-intake-panel')).toHaveCount(0);
  await page.getByRole('button', { name: /Custom Story/ }).click();

  const panel = page.getByTestId('custom-story-intake-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('Type the memory or story idea')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record audio' })).toBeVisible();
  await expect(page.getByTestId('custom-story-audio-upload-control')).toBeVisible();
  await expect(page.getByTestId('custom-story-document-upload-control')).toBeVisible();
  await expect(page.getByText('Or pick a ready adventure template')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a ready-made adventure instead' })).toBeVisible();

  const panelBox = await panel.boundingBox();
  const heroBox = await page.getByRole('heading', { name: 'Who this story celebrates' }).boundingBox();
  expect(panelBox).not.toBeNull();
  expect(heroBox).not.toBeNull();
  expect(panelBox!.y).toBeLessThan(heroBox!.y);

  await page.getByLabel('Type the memory or story idea').fill('A short family memory for the custom story.');
  await page.locator('#childName').fill('Testhero');
  await expect(page.getByTestId('checkout-primary-continue')).toHaveText('Next: Add hero photo or description');

  const record = page.getByRole('button', { name: 'Record audio' });
  const audioInput = page.getByLabel('Upload audio file');
  const documentInput = page.getByLabel('Upload document');
  await record.focus();
  await page.keyboard.press('Tab');
  await expect(audioInput).toBeFocused();
  const audioChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await audioChooser;

  await record.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(documentInput).toBeFocused();
  const documentChooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await documentChooser;
  expect(harness.orderRequests).toHaveLength(0);
});
