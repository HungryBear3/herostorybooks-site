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

test('fourth hero type and save-before-next-person guidance are explicit', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/checkout');

  await expect(page.getByRole('button', { name: /Child Available now/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Parent Available by review only/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Grandparent Available by review only/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Friend \/ other family member Available by review only/ })).toBeVisible();

  await page.getByRole('button', { name: /Space Voyager/ }).click();
  await page.locator('#childName').fill('Testhero');
  await page.getByTestId('checkout-primary-continue').click();
  await page.getByLabel('Describe the hero').fill('Short dark hair and a bright green hoodie');
  await page.getByTestId('checkout-bottom-continue').click();
  await page.getByTestId('checkout-bottom-continue').click();

  await expect(page.getByText('Add one person at a time. Complete and save their profile before adding the next person.')).toBeVisible();
  const dadButton = page.getByRole('button', { name: '+ Dad' });
  const momButton = page.getByRole('button', { name: '+ Mom' });
  await dadButton.click();
  await expect(momButton).toBeDisabled();
  await expect(page.getByText('Select “Save person” below before choosing another person.')).toBeVisible();
  await page.getByPlaceholder('e.g., Alexy').fill('Dad');
  await page.getByPlaceholder(/Hair, skin tone/).fill('Short brown hair and glasses');
  await page.getByRole('button', { name: 'Save person' }).click();
  await expect(momButton).toBeEnabled();
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

test('restored ready-made progress drops stale Custom Story text before it can re-enter the lane', async ({ page, baseURL }) => {
  await installHandoffHarness(page, baseURL!);
  await page.addInitScript(() => {
    localStorage.setItem('hsb_order_v1', JSON.stringify({
      theme: 'space-voyager',
      childName: 'Testhero',
      customStoryMemory: 'PRIVATE SOURCE MUST NOT CROSS',
      customStorySourceMode: 'written',
      familyCharacters: [],
      mustInclude: [],
      mustIncludeOther: '',
      bookFormat: 'digital',
      email: '',
      savedAt: Date.now(),
    }));
  });
  await page.goto('/checkout');
  await expect(page.getByTestId('custom-story-intake-panel')).toHaveCount(0);
  await page.getByRole('button', { name: /Custom Story/ }).click();
  await expect(page.getByLabel('Type the memory or story idea')).toHaveValue('');
});

test('a late recorder stop after switching lanes cannot restore abandoned audio', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.addInitScript(() => {
    const track = { stop() {} };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    });
    class FakeMediaRecorder {
      state = 'inactive';
      mimeType = 'audio/webm';
      private listeners: Record<string, Array<(event?: { data?: Blob }) => void>> = {};
      constructor(_stream: unknown, _options?: unknown) {}
      addEventListener(name: string, listener: (event?: { data?: Blob }) => void) {
        (this.listeners[name] ??= []).push(listener);
      }
      start() {
        this.state = 'recording';
        (window as unknown as { fireLateRecorderStop: () => void }).fireLateRecorderStop = () => {
          this.listeners.dataavailable?.forEach((listener) => listener({ data: new Blob(['late'], { type: 'audio/webm' }) }));
          this.listeners.stop?.forEach((listener) => listener());
        };
      }
      stop() { this.state = 'inactive'; }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
  });
  await page.goto('/checkout');
  await page.getByRole('button', { name: /Custom Story/ }).click();
  await page.getByRole('button', { name: 'Record audio' }).click();
  await page.getByRole('button', { name: 'Choose a ready-made adventure instead' }).click();
  await page.evaluate(() => (window as unknown as { fireLateRecorderStop: () => void }).fireLateRecorderStop());
  await page.getByRole('button', { name: /Custom Story/ }).click();
  await expect(page.getByText('Attached: voice note')).toHaveCount(0);
  await expect(page.getByTestId('voice-preview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove file' })).toHaveCount(0);
  expect(harness.orderRequests).toHaveLength(0);
});

test('a delayed microphone permission grant cannot start recording after leaving Custom Story', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.addInitScript(() => {
    let resolvePermission: ((stream: { getTracks: () => Array<{ stop: () => void }> }) => void) | null = null;
    Object.assign(window, {
      recorderStartedAfterLeave: false,
      latePermissionTrackStopped: false,
      resolveDelayedMicPermission: () => resolvePermission?.({
        getTracks: () => [{
          stop: () => { (window as unknown as { latePermissionTrackStopped: boolean }).latePermissionTrackStopped = true; },
        }],
      }),
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => new Promise((resolve) => { resolvePermission = resolve; }),
      },
    });
    class FakeMediaRecorder {
      state = 'inactive';
      mimeType = 'audio/webm';
      constructor(_stream: unknown, _options?: unknown) {}
      addEventListener() {}
      start() {
        (window as unknown as { recorderStartedAfterLeave: boolean }).recorderStartedAfterLeave = true;
      }
      stop() { this.state = 'inactive'; }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
  });

  await page.goto('/checkout');
  await page.getByRole('button', { name: /Custom Story/ }).click();
  await page.getByRole('button', { name: 'Record audio' }).click();
  await page.getByRole('button', { name: 'Choose a ready-made adventure instead' }).click();
  await page.evaluate(() => (window as unknown as { resolveDelayedMicPermission: () => void }).resolveDelayedMicPermission());
  await expect.poll(() => page.evaluate(() => ({
    started: (window as unknown as { recorderStartedAfterLeave: boolean }).recorderStartedAfterLeave,
    stopped: (window as unknown as { latePermissionTrackStopped: boolean }).latePermissionTrackStopped,
  }))).toEqual({ started: false, stopped: true });
  expect(harness.orderRequests).toHaveLength(0);
});

test('selecting a document invalidates a pending microphone permission request', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.addInitScript(() => {
    let resolvePermission: ((stream: { getTracks: () => Array<{ stop: () => void }> }) => void) | null = null;
    Object.assign(window, {
      recorderStartedAfterUpload: false,
      replacedPermissionTrackStopped: false,
      resolveReplacedMicPermission: () => resolvePermission?.({
        getTracks: () => [{
          stop: () => { (window as unknown as { replacedPermissionTrackStopped: boolean }).replacedPermissionTrackStopped = true; },
        }],
      }),
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => new Promise((resolve) => { resolvePermission = resolve; }),
      },
    });
    class FakeMediaRecorder {
      state = 'inactive';
      mimeType = 'audio/webm';
      constructor(_stream: unknown, _options?: unknown) {}
      addEventListener() {}
      start() {
        (window as unknown as { recorderStartedAfterUpload: boolean }).recorderStartedAfterUpload = true;
      }
      stop() { this.state = 'inactive'; }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
  });

  await page.goto('/checkout');
  await page.getByRole('button', { name: /Custom Story/ }).click();
  await page.getByRole('button', { name: 'Record audio' }).click();
  await page.getByLabel('Upload document').setInputFiles({
    name: 'replacement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 replacement'),
  });
  await page.evaluate(() => (window as unknown as { resolveReplacedMicPermission: () => void }).resolveReplacedMicPermission());

  await expect(page.getByText(/Attached:/)).toContainText('replacement.pdf');
  await expect.poll(() => page.evaluate(() => ({
    started: (window as unknown as { recorderStartedAfterUpload: boolean }).recorderStartedAfterUpload,
    stopped: (window as unknown as { replacedPermissionTrackStopped: boolean }).replacedPermissionTrackStopped,
  }))).toEqual({ started: false, stopped: true });
  expect(harness.orderRequests).toHaveLength(0);
});

test('switching from Custom Story to a ready-made adventure clears abandoned private source material', async ({ page, baseURL }) => {
  const harness = await installHandoffHarness(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/checkout');
  await page.getByRole('button', { name: /Custom Story/ }).click();
  await page.getByLabel('Type the memory or story idea').fill('Private source that must not survive the switch.');
  await page.getByLabel('Upload document').setInputFiles({
    name: 'private-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('private notes'),
  });

  await page.getByRole('button', { name: 'Choose a ready-made adventure instead' }).click();
  await expect(page.getByTestId('custom-story-intake-panel')).toHaveCount(0);
  await page.getByRole('button', { name: /Custom Story/ }).click();
  await expect(page.getByLabel('Type the memory or story idea')).toHaveValue('');
  await expect(page.getByText('private-notes.txt')).toHaveCount(0);
  expect(harness.orderRequests).toHaveLength(0);
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
