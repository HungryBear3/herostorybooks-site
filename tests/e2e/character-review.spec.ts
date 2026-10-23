import { test, expect, devices } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { E2E_STORE_DIR } from '../../playwright.config.ts';

// Real loopback Next routes + real filesystem CAS. Only private image storage
// is replaced with synthetic bytes; no provider/storage credential is loaded.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64');
async function seed(expired = false) {
 const id = `ord_e2e_character_${randomBytes(8).toString('hex')}`; const token = randomBytes(32).toString('hex');
 const version = randomBytes(16).toString('hex');
 await mkdir(E2E_STORE_DIR, { recursive: true });
 const order = { id, paymentStatus: 'paid', fulfillmentMode: 'manual_hold', status: 'order_received',
  characterReview: { version, imageHash: createHash('sha256').update(PNG).digest('hex'), description: 'Synthetic adventurer with a blue jacket.', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + (expired ? -1 : 1) * 3600000).toISOString(), status: 'awaiting_customer', history: [], workQueue: [] } };
 const file = path.join(E2E_STORE_DIR, `${id}.json`); await writeFile(file, JSON.stringify(order));
 return { id, token, version, file };
}
for (const mobile of [false, true]) test.describe(mobile ? 'mobile character review' : 'desktop character review', () => {
 if (mobile) test.use({ viewport: devices['Pixel 5'].viewport, isMobile: true, hasTouch: true, userAgent: devices['Pixel 5'].userAgent });
 for (const action of ['approve', 'request_changes']) test(`${action} persists through real customer route and strips URL capability`, async ({ page }) => {
  const data = await seed(); let imageAuthorized = false;
  await page.route('**/*', async route => {
   const url = new URL(route.request().url());
   if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.abort();
   if (url.pathname === `/api/order/${data.id}/character-review` && url.searchParams.get('asset') === 'image') {
    imageAuthorized = route.request().headers().authorization === `Bearer ${data.token}` && url.searchParams.get('version') === data.version;
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
   }
   return route.continue();
  });
  await page.goto(`/character-review/${data.id}#token=${data.token}`);
  await expect(page.getByRole('heading', { name: 'Meet your storybook character' })).toBeVisible();
  await expect(page.getByAltText('Your proposed storybook character sheet')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/character-review/${data.id}$`));
  expect(imageAuthorized).toBe(true);
  if (action === 'request_changes') {
   await expect(page.getByRole('button', { name: 'Request changes', exact: true })).toBeDisabled();
   await page.getByLabel('What would you like changed?').fill('Please make the jacket green.');
  }
  const savedResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/character-review'));
  await page.getByRole('button', { name: action === 'approve' ? 'Approve this character' : 'Request changes', exact: true }).click();
  if (action === 'approve') {
   await expect(page.getByRole('dialog')).toBeVisible();
   await page.getByRole('button', { name: 'Go back' }).click();
   await expect(page.getByRole('button', { name: 'Approve this character', exact: true })).toBeFocused();
   await page.getByRole('button', { name: 'Approve this character', exact: true }).click();
   await page.getByRole('button', { name: 'Yes, approve', exact: true }).click();
  }
  const decisionResponse = await savedResponse;
  expect(decisionResponse.status()).toBe(200);
  await expect(page.getByRole('status')).toContainText(action === 'approve' ? 'Character approved' : 'Your changes are saved');
  const saved = JSON.parse(await readFile(data.file, 'utf8'));
  expect(saved.characterReview.workQueue).toHaveLength(1);
  expect(saved.characterReview.workQueue[0].kind).toBe(action === 'approve' ? 'character_approved' : 'revise_character');
  expect(saved.characterReview.status).toBe(action === 'approve' ? 'approved' : 'changes_requested');
  expect(saved.status).toBe('order_received'); expect(saved.proofApprovedAt).toBeUndefined(); expect(saved.printApprovedAt).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Approve this character' })).toHaveCount(0);
  await page.screenshot({ path: `/tmp/hsb-character-${mobile ? 'mobile' : 'desktop'}-${action}.png`, fullPage: true });
 });
});
test('expired character invitation exposes no customer content or decision controls', async ({ page }) => {
 const data = await seed(true);
 await page.goto(`/character-review/${data.id}#token=${data.token}`);
 await expect(page.getByRole('main').getByRole('alert')).toContainText('unavailable');
 await expect(page.getByRole('button', { name: 'Approve this character' })).toHaveCount(0);
 await expect(page.getByText('Synthetic adventurer with a blue jacket.')).toHaveCount(0);
});

test('refresh loses capability without calling the API or blaming expiry', async ({ page }) => {
 const data = await seed();
 await page.goto(`/character-review/${data.id}`);
 await expect(page.getByRole('main').getByRole('alert')).toContainText('If you refreshed the page');
 await expect(page.getByRole('button', { name: 'Approve this character' })).toHaveCount(0);
});
test('undecodable image cannot be approved', async ({ page }) => {
 const data = await seed();
 await page.route('**/character-review?asset=image&version=*', route => route.fulfill({ contentType: 'image/png', body: 'not an image' }));
 await page.goto(`/character-review/${data.id}#token=${data.token}`);
 await expect(page.getByRole('main').getByRole('alert')).toContainText("image didn't load");
 await expect(page.getByRole('button', { name: 'Approve this character', exact: true })).toBeDisabled();
 const saved = JSON.parse(await readFile(data.file, 'utf8'));
 expect(saved.characterReview.workQueue).toHaveLength(0);
});
test('failed save keeps notes and allows retry without claiming work started', async ({ page }) => {
 const data = await seed();
 await page.route('**/character-review?asset=image&version=*', route => route.fulfill({ contentType: 'image/png', body: PNG }));
 await page.route(`**/api/order/${data.id}/character-review`, route => route.request().method() === 'POST' ? route.fulfill({ status: 500, body: '{}' }) : route.continue());
 await page.goto(`/character-review/${data.id}#token=${data.token}`);
 await page.getByLabel('What would you like changed?').fill('Green jacket please');
 await expect(page.getByText('19 / 2000', { exact: true })).toBeVisible();
 await page.getByRole('button', { name: 'Request changes', exact: true }).click();
 await expect(page.getByRole('main').getByRole('alert')).toContainText("couldn't save");
 await expect(page.getByLabel('What would you like changed?')).toHaveValue('Green jacket please');
 await expect(page.getByRole('main').getByRole('alert')).toBeFocused();
 await expect(page.getByRole('button', { name: 'Request changes', exact: true })).toBeEnabled();
});
