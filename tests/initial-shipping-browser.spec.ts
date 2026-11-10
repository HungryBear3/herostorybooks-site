import { test, expect, type Page } from '@playwright/test';
import { fillCheckoutToReview, installHandoffHarness, clickInSameTask } from './e2e/checkout-handoff-harness';

const quoteId = '00000000-0000-4000-8000-000000000001';
const capability = 'browser-synthetic-capability-'.repeat(3);
const intakeId = 'intake_' + 'a'.repeat(32);
async function harness(page: Page, baseURL: string) {
  await page.addInitScript(() => {
    (window as any).dataLayer = [];
    (window as any).gtag = (...args: unknown[]) => (window as any).dataLayer.push(args);
  });
  const order = await installHandoffHarness(page, baseURL);
  const ops: string[] = []; const bodies: any[] = []; const consoles: string[] = [];
  const state = { failQuote: false, failClear: false, ttl: 600000, pause: '', release: (() => {}) as () => void };
  let revision = 1;
  page.on('console', msg => consoles.push(msg.text()));
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/order' || url.pathname.includes('attempt')) return route.fallback();
    if (url.pathname === '/api/checkout/intake') {
      const b = route.request().postDataJSON(); ops.push('intake:' + b.action);
      return route.fulfill({ json: { intakeId, capability, expiresAt: new Date(Date.now() + 3600000).toISOString() } });
    }
    if (url.pathname !== '/api/checkout/shipping') return route.fulfill({ json: {} });
    const b = route.request().postDataJSON(); bodies.push(b); ops.push(b.op);
    if (b.op === 'put_contact') {
      expect(Object.keys(b.contact).sort()).toEqual(['city', 'country', 'line1', 'line2', 'name', 'phone', 'state', 'zip']);
      expect(b.contact.zip).toBe('60601');
      expect(b.contact).not.toHaveProperty('postalCode');
    }
    expect(b.intakeId).toBe(intakeId); expect(b.capability).toBe(capability);
    if (state.pause === b.op) await new Promise<void>(resolve => { state.release = resolve; });
    if ((state.failQuote && b.op === 'quote') || (state.failClear && b.op === 'clear')) return route.fulfill({ status: 503, json: { error: 'store_unavailable' } });
    const quoted = b.op === 'quote' || b.op === 'select';
    if (b.op === 'put_contact' || b.op === 'clear') revision++;
    return route.fulfill({ json: { pricingRuleVersion: 'landed-delta-v1', bookFormat: 'classic', revision, bookCents: 3900, deltaCents: quoted ? 420 : 0,
      deltaTaxIncludedCents: quoted ? 20 : 0, totalCents: quoted ? 4320 : 3900,
      selectedQuoteId: b.op === 'select' ? quoteId : null,
      quote: quoted ? { quoteId, service: 'EXPEDITED', label: 'Expedited', deltaCents: 420, expiresAtMs: Date.now() + state.ttl, transitDays: 2 } : null,
      estimate: 'Synthetic shipping estimate — proof approval first.', contact: b.contact ?? null } });
  });
  return { ...order, ops, bodies, state, consoles };
}
async function shippingEvents(page: Page) {
  return page.evaluate(() => ((window as any).dataLayer ?? []).filter((e: any[]) => e[0] === 'event' && e[1].startsWith('shipping_')));
}
async function printReview(page: Page) {
  const pay = await fillCheckoutToReview(page);
  await page.getByRole('button', { name: /^Softcover Classic/ }).click();
  return pay;
}
async function contact(page: Page) {
  await page.getByRole('radio', { name: 'Expedited shipping', exact: true }).check();
  for (const [label, value] of Object.entries({ 'Delivery recipient name': 'Private Recipient Sentinel', 'Delivery phone': '+13125550999', 'Street address': '991 Synthetic Lane', City: 'Chicago', 'State (2 letters)': 'IL', 'ZIP code': '60601' })) await page.getByLabel(label, { exact: true }).fill(value);
}
async function select(page: Page) {
  await contact(page);
  await page.getByRole('button', { name: 'Get shipping quote' }).click();
  await clickInSameTask(page.getByRole('button', { name: 'Use this expedited quote' }), 2);
  await expect(page.getByText('Expedited shipping selected', { exact: true })).toBeVisible();
}
for (const width of [390, 1280]) test(`mounted contact quote select exact direct payment ${width}`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 900 });
  const h = await harness(page, baseURL!); const pay = await printReview(page);
  await expect(page.getByRole('radio', { name: 'Standard shipping — Included' })).toBeChecked();
  await select(page);
  expect((await shippingEvents(page)).map((e: any[]) => e[1])).toEqual(['shipping_options_view', 'shipping_option_selected']);
  expect((await shippingEvents(page)).every((e: any[]) => e[2].pricing_rule === 'landed-delta-v1')).toBe(true);
  const rows = page.getByLabel('Shipping itemization');
  await expect(rows).toContainText('Book$39.00'); await expect(rows).toContainText('Standard shippingIncluded');
  await expect(rows).toContainText('Expedited shipping upgrade$4.20'); await expect(rows).toContainText('Shipping tax (included in upgrade)$0.20');
  await expect(rows).toContainText('Total$43.20'); await expect(pay).toContainText('$43.20');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const saved = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href, (window as any).dataLayer]));
  for (const sentinel of [capability, quoteId, 'Private Recipient Sentinel', '991 Synthetic Lane', '+13125550999']) {
    expect(saved).not.toContain(sentinel); expect(h.consoles.join('\n')).not.toContain(sentinel);
  }
  await clickInSameTask(pay, 2);
  await expect.poll(() => h.orderBodies.length).toBe(1);
  const body = h.orderBodies[0];
  expect(body).toContain('name="expeditedQuoteId"\r\n\r\n' + quoteId);
  expect(body).toContain('name="checkoutIntakeCapability"\r\n\r\n' + capability);
  expect(body).toContain(intakeId); expect(body).not.toContain('Private Recipient Sentinel');
  expect(h.ops).toEqual(['intake:create', 'put_contact', 'quote', 'select']);
});

test('digital and untouched standard preserve no shipping calls', async ({ page, baseURL }) => {
  const h = await harness(page, baseURL!); const pay = await fillCheckoutToReview(page);
  await expect(page.getByRole('group', { name: 'Shipping options' })).toHaveCount(0);
  await pay.click(); await expect.poll(() => h.orderBodies.length).toBe(1);
  expect(await shippingEvents(page)).toEqual([]);
  expect(h.ops).toEqual([]); expect(h.orderBodies[0]).not.toContain('expeditedQuoteId');
});
test('print standard defaults to included, no new contact or intake', async ({ page, baseURL }) => {
  const h = await harness(page, baseURL!); const pay = await printReview(page);
  await pay.click(); await expect.poll(() => h.orderBodies.length).toBe(1);
  expect(await shippingEvents(page)).toEqual([]);
  expect(h.ops).toEqual([]); expect(h.orderBodies[0]).not.toContain('expeditedQuoteId');
});
test('default-off print exposes no expedited option or requests', async ({ page, baseURL }) => {
  const h = await harness(page, baseURL!); const pay = await printReview(page);
  await expect(page.getByRole('group', { name: 'Shipping options' })).toHaveCount(0);
  await pay.click(); await expect.poll(() => h.orderBodies.length).toBe(1);
  expect(await shippingEvents(page)).toEqual([]);
  expect(h.ops).toEqual([]); expect(h.orderBodies[0]).not.toContain('expeditedQuoteId');
});

test('format edit invalidates receipt immediately and digital payment awaits clear', async ({ page, baseURL }) => {
  const h = await harness(page, baseURL!); const pay = await printReview(page); await select(page);
  await page.getByRole('button', { name: /^Digital Digital/ }).click();
  await expect(pay).toBeDisabled(); await expect(page.getByLabel('Shipping itemization')).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm Standard shipping' }).click();
  await expect(pay).toBeEnabled(); await pay.click(); await expect.poll(() => h.orderBodies.length).toBe(1);
  expect(h.ops.at(-1)).toBe('clear'); expect(h.orderBodies[0]).not.toContain('expeditedQuoteId');
});

test('unavailable quote retries; uncertain clear blocks until verified clear', async ({ page, baseURL }) => {
  const h = await harness(page, baseURL!); const pay = await printReview(page); await contact(page);
  h.state.failQuote = true; await page.getByRole('button', { name: 'Get shipping quote' }).click();
  await expect(page.getByText('Shipping unavailable.', { exact: false })).toBeVisible(); await expect(pay).toBeDisabled();
  h.state.failQuote = false; await page.getByRole('button', { name: 'Get shipping quote' }).click();
  await page.getByRole('button', { name: 'Use this expedited quote' }).click(); await expect(pay).toBeEnabled();
  h.state.failClear = true; await page.getByRole('radio', { name: 'Standard shipping — Included' }).click();
  await expect(page.getByText('Standard shipping is not confirmed.', { exact: false })).toBeVisible(); await expect(pay).toBeDisabled();
  h.state.failClear = false; await page.getByRole('button', { name: 'Confirm Standard shipping' }).click();
  await expect(pay).toBeEnabled(); await pay.click(); await expect.poll(() => h.orderBodies.length).toBe(1);
  expect((await shippingEvents(page)).map((e: any[]) => e[1])).toEqual(['shipping_unavailable', 'shipping_options_view', 'shipping_option_selected']);
  expect(h.orderBodies[0]).not.toContain('expeditedQuoteId'); expect(h.ops.filter(x => x === 'intake:create')).toHaveLength(1);
});
test('editing during select cannot restore stale selection; clear waits behind old server write', async ({ page, baseURL }) => {
  const h = await harness(page, baseURL!); const pay = await printReview(page); await contact(page);
  await page.getByRole('button', { name: 'Get shipping quote' }).click();
  h.state.pause = 'select'; await page.getByRole('button', { name: 'Use this expedited quote' }).click();
  await expect.poll(() => h.ops.includes('select')).toBe(true);
  await page.getByLabel('Street address', { exact: true }).fill('992 Replacement Lane');
  await expect(page.getByLabel('Shipping itemization')).toHaveCount(0); await expect(pay).toBeDisabled();
  await page.getByRole('radio', { name: 'Standard shipping — Included' }).click();
  expect(h.ops).not.toContain('clear'); h.state.release();
  await expect(pay).toBeEnabled(); expect(h.ops.slice(-2)).toEqual(['select', 'clear']);
  await expect(page.getByText('Expedited shipping selected', { exact: true })).toHaveCount(0);
  expect((await shippingEvents(page)).map((e: any[]) => e[1])).toEqual(['shipping_options_view']);
});
test('expired quote refuses payment and keyboard choice is operable', async ({ page, baseURL }) => {
  await page.clock.install();
  const h = await harness(page, baseURL!); const pay = await printReview(page);
  const standard = page.getByRole('radio', { name: 'Standard shipping — Included' });
  for (let i = 0; i < 30 && !(await standard.evaluate(element => element === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(standard).toBeFocused(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: 'Expedited shipping', exact: true })).toBeChecked();
  await select(page); h.state.ttl = -1;
  await page.clock.fastForward(601000);
  await expect(page.getByText('Shipping quote expired.', { exact: false })).toBeVisible(); await expect(pay).toBeDisabled();
  expect(h.orderBodies).toHaveLength(0);
});
