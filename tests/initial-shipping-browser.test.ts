import test from 'node:test';
import assert from 'node:assert/strict';
import { track } from '../src/lib/analytics.ts';
import { shippingMetricParams } from '../src/lib/analytics-event-contract.ts';
import { performStripeHandoff } from '../src/lib/checkout-handoff.ts';
import { readFileSync } from 'node:fs';
import { InitialShippingClient, parseShippingReceipt, type ShippingContact } from '../src/lib/initial-shipping-client.ts';
const contact: ShippingContact = { name: 'Synthetic Adult', phone: '+13125550999', line1: '1 Test Lane', line2: '', city: 'Chicago', state: 'IL', postalCode: '60601', country: 'US' };
import { normalizeShippingContact } from '../src/lib/shipping-selection.ts';

test('actual contact transport maps UI postalCode to canonical zip and excludes extras', async () => {
  const sent: Record<string, any>[] = [];
  const input = { ...contact, phone: '+13125550999', extraPrivateField: 'must-not-send' };
  const c = new InitialShippingClient(() => {}, async body => {
    sent.push(JSON.parse(JSON.stringify(body)));
    return receipt(String(body.op));
  }, () => 1);
  await c.quote('classic', input, async () => session);
  assert.equal(sent[0].op, 'put_contact');
  // Consume the captured JSON object directly; never repair it in the test.
  const canonical = normalizeShippingContact(sent[0].contact);
  assert.equal(canonical.zip, input.postalCode);
  assert.deepEqual(sent[0].contact, { name: input.name, phone: input.phone, line1: input.line1,
    line2: input.line2, city: input.city, state: input.state, zip: input.postalCode, country: input.country });
  assert.deepEqual(sent.map(b => b.op), ['put_contact', 'quote']);
  assert.equal(c.view.status, 'quoted');
});
const session = { intakeId: 'intake_' + 'a'.repeat(32), capability: 'c'.repeat(64), expiresAt: new Date(2000000).toISOString() };
const quoteId = '00000000-0000-4000-8000-000000000001';
const receipt = (op: string) => ({ pricingRuleVersion: 'landed-delta-v1', bookFormat: 'classic', revision: 1, bookCents: 3900, deltaCents: op === 'clear' || op === 'put_contact' ? 0 : 420,
  deltaTaxIncludedCents: op === 'clear' || op === 'put_contact' ? 0 : 20, totalCents: op === 'clear' || op === 'put_contact' ? 3900 : 4320,
  selectedQuoteId: op === 'select' ? quoteId : null, estimate: 'Proof first', quote: op === 'clear' || op === 'put_contact' ? null : { quoteId, deltaCents: 420, expiresAtMs: 10000, service: 'EXPEDITED', label: 'Expedited', transitDays: 2 } });
async function browser(run: (events: any[]) => Promise<void>) {
  const prior = { window: globalThis.window, document: globalThis.document };
  const dataLayer: any[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: new URL('https://herostorybooks.com/checkout?private=PRIVATE'), dataLayer,
    gtag: (...args: any[]) => dataLayer.push(args), localStorage: { getItem: () => null },
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: '', cookie: '' } });
  try { await run(dataLayer); } finally {
    for (const key of ['window', 'document'] as const) {
      if (prior[key] === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, value: prior[key] });
    }
  }
}
test('actual controller to analytics emits closed shown/accepted/unavailable with no private data', () => browser(async events => {
  let unavailable = false;
  const c = new InitialShippingClient(() => {}, async b => {
    if (b.op === 'quote' && unavailable) throw new Error('PRIVATE recipient provider error');
    return { ...receipt(String(b.op)), contact, raw: 'PRIVATE' };
  }, () => 1, (event, params) => track(event, { ...params }));
  track('shipping_payment_completed' as any, { outcome: 'paid' }); track('purchase' as any, {});
  assert.equal(events.length, 0);
  await c.quote('classic', contact, async () => session); await c.select(); await c.select();
  unavailable = true; await c.quote('classic', contact, async () => session);
  assert.deepEqual(events.map(e => e[1]), ['shipping_options_view', 'shipping_option_selected', 'shipping_unavailable']);
  assert.ok(events.every(e => e[2].pricing_rule === 'landed-delta-v1'));
  for (const marker of ['PRIVATE', contact.name, contact.phone, contact.line1, session.intakeId, session.capability, quoteId]) assert.ok(!JSON.stringify(events).includes(marker));
}));
test('stale quote and failed contact emit nothing; unknown policy does not invent a label', () => browser(async events => {
  for (const mode of ['stale', 'contact-failed', 'unknown']) {
    const c = new InitialShippingClient(() => {}, async b => {
      if (b.op === 'put_contact' && mode === 'contact-failed') throw new Error('PRIVATE');
      if (b.op === 'quote' && mode === 'stale') c.invalidate();
      return { ...receipt(String(b.op)), pricingRuleVersion: mode === 'unknown' ? 'name-shaped-token' : 'landed-delta-v1' };
    }, () => 1, (event, params) => track(event, { ...params }));
    await c.quote('classic', contact, async () => session);
  }
  assert.deepEqual(events, []);
}));
test('metric projection reads only own data fields and refuses arbitrary rule/accessor/prototype values', () => {
  const valid = { service: 'expedited', format: 'classic', outcome: 'paid', pricingRule: 'landed-delta-v1' };
  assert.ok(shippingMetricParams({ ...valid, get privateField() { throw new Error('must not read'); } }));
  assert.equal(shippingMetricParams({ ...valid, get pricingRule() { throw new Error('must not read'); } }), null);
  assert.equal(shippingMetricParams(Object.create(valid)), null);
  const accessor = { ...valid, get pricingRule() { throw new Error('must not read'); } };
  Object.defineProperty(Object.prototype, 'value', { configurable: true, value: 'landed-delta-v1' });
  try { assert.equal(shippingMetricParams(accessor), null); } finally { Reflect.deleteProperty(Object.prototype, 'value'); }
  assert.equal(shippingMetricParams({ ...valid, pricingRule: 'person-name' }), null);
});
test('terminal disposal drops capability and rejects parked completion without network or reuse', async () => {
  for (const phase of ['selected', 'prepare', 'quote', 'select']) {
    let release!: () => void; let entered!: () => void;
    const parked = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    const calls: string[] = [];
    const c = new InitialShippingClient(() => {}, async body => {
      calls.push(String(body.op));
      if (body.op === phase) { entered(); await gate; }
      return receipt(String(body.op));
    }, () => 1);
    const quoted = c.quote('classic', contact, async () => {
      if (phase === 'prepare') { entered(); await gate; }
      return session;
    });
    let pending: Promise<unknown> = quoted;
    if (phase === 'selected' || phase === 'select') { await quoted; pending = c.select(); }
    if (phase === 'selected') await pending; else await parked;
    const before = calls.length;
    c.dispose(); release(); await pending;
    assert.equal(JSON.stringify(c).includes(session.capability), false);
    assert.equal(c.view.receipt, null); assert.equal(c.ready('classic'), false); assert.equal(c.ready('digital'), false);
    await c.standard(); c.expedited(); await c.quote('classic', contact, async () => session); await c.select();
    assert.equal(calls.length, before); assert.equal(c.ready('digital'), false);
    assert.throws(() => c.bind(new FormData(), c.epoch, 'digital'));
  }
});

function setup() { let time = 1; const calls: string[] = []; const c = new InitialShippingClient(() => {}, async b => { calls.push(String(b.op)); return receipt(String(b.op)); }, () => time); return { c, calls, expire: () => { time = 10001; c.expire(); } }; }
test('standard untouched is ready; selected authority binds only to same direct intake and format', async () => {
  const { c, calls } = setup(); assert.equal(c.ready('digital'), true); assert.deepEqual(calls, []);
  c.expedited(); await c.quote('classic', contact, async () => session); await c.select(); assert.equal(c.ready('classic'), true);
  const f = new FormData(); assert.throws(() => c.bind(f, c.epoch, 'classic'));
  f.set('checkoutIntake', JSON.stringify({ intakeId: session.intakeId })); f.set('checkoutIntakeCapability', session.capability);
  c.bind(f, c.epoch, 'classic'); assert.equal(f.get('expeditedQuoteId'), quoteId); assert.equal(c.ready('digital'), false);
  c.invalidate(); assert.throws(() => c.bind(f, c.epoch, 'classic'));
});
test('expiry refuses synchronously even before expiry repaint, standard needs verified clear', async () => {
  const { c, expire, calls } = setup(); await c.quote('classic', contact, async () => session); await c.select(); expire(); assert.equal(c.ready('classic'), false);
  await c.standard(); assert.equal(c.ready('classic'), true); assert.equal(calls.at(-1), 'clear');
});
test('late quote after edit does not restore receipt; stale selection writes serialize before clear', async () => {
  let release!: () => void; let seen!: () => void; const arrived = new Promise<void>(r => { seen = r; }); const gate = new Promise<void>(r => { release = r; });
  const calls: string[] = []; const c = new InitialShippingClient(() => {}, async b => { calls.push(String(b.op)); if (b.op === 'quote') { seen(); await gate; } return receipt(String(b.op)); }, () => 1);
  const q = c.quote('classic', contact, async () => session); await arrived; c.invalidate(); const clear = c.standard();
  assert.deepEqual(calls, ['put_contact', 'quote']); release(); await q; await clear; assert.equal(c.view.receipt, null); assert.equal(c.ready('classic'), true); assert.equal(calls.at(-1), 'clear');
});
test('uncertain clear never enables standard payment or abandons intake', async () => {
  const c = new InitialShippingClient(() => {}, async b => { if (b.op === 'clear') throw new Error('lost'); return receipt(String(b.op)); }, () => 1);
  await c.quote('classic', contact, async () => session); await c.select(); await c.standard(); assert.equal(c.ready('classic'), false);
  await c.quote('classic', contact, async () => ({ ...session, intakeId: 'other' })); assert.equal(c.view.status, 'error'); assert.equal(c.ready('classic'), false);
});
test('empty-clear acknowledgement is closed; arbitrary errors and null never clear dirty authority', async () => {
  for (const raw of [null, {}, { error: 'not_found' }, { error: 'input_invalid' }, { version: 1, state: 'empty', revision: 0 }, { version: 2, state: 'empty' }]) {
    const c = new InitialShippingClient(() => {}, async body => {
      if (body.op === 'put_contact') throw new Error('invalid contact');
      return raw;
    });
    await c.quote('classic', contact, async () => session); await c.standard();
    assert.equal(c.ready('classic'), false); assert.equal(c.ready('digital'), false);
  }
});

test('validated manual Stripe link retains only the same URL, never shipping capability', async () => {
  assert.ok(readFileSync('src/app/checkout/checkout-form.tsx', 'utf8').includes('if (handoff.url) shipping.dispose();'));
  const c = new InitialShippingClient(() => {}, async b => receipt(String(b.op)), () => 1);
  await c.quote('classic', contact, async () => session); await c.select();
  const invalid = performStripeHandoff('https://invalid.example/checkout', { navigate: () => c.dispose() });
  assert.equal(invalid.url, null); assert.equal(c.ready('classic'), true);
  const url = 'https://checkout.stripe.com/synthetic';
  const result = performStripeHandoff(url, { navigate: () => {
    assert.equal(c.ready('classic'), true); throw new Error('synthetic navigation blocked');
  } });
  if (result.url) c.dispose();
  assert.equal(result.reason, 'navigation_failed'); assert.equal(result.url, url);
  assert.equal(c.ready('classic'), false); assert.equal(c.view.receipt, null);
  assert.equal(JSON.stringify(c).includes(session.capability), false);
  await c.quote('classic', contact, async () => { throw new Error('terminal must not reprepare'); });
  assert.equal(c.view.receipt, null);
});

test('strict numeric response validation retains no contact or extra private echo', () => {
  const r = parseShippingReceipt({ ...receipt('quote'), contact, lock: 'PRIVATE' });
  assert.ok(!JSON.stringify(r).includes('PRIVATE')); assert.ok(!JSON.stringify(r).includes(contact.name));
  for (const extra of [{ totalCents: 4340 }, { deltaTaxIncludedCents: 500 }, { revision: 'invented' }, { quote: null, selectedQuoteId: quoteId }]) assert.throws(() => parseShippingReceipt({ ...receipt('select'), ...extra }));
});
