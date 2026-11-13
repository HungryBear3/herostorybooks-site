import assert from 'node:assert/strict';
import test from 'node:test';
import { produceShippingQuote, parseShippingLandedCost } from '../src/lib/shipping-quote.ts';
import { validateShippingSelection, SHIPPING_QUOTE_TTL_MS } from '../src/lib/shipping-selection.ts';
import { calculatePrintJobCost, clearTokenCache } from '../src/lib/lulu.ts';

function request() {
  return { draftId: 'synthetic-draft-1', ownerBinding: 'a'.repeat(64), operation: 'initial_checkout_shipping',
    plannedProductVersion: 'synthetic-layout-v1', bookFormat: 'classic', podPackageId: 'SC.PKG',
    pageCount: 32, quantity: 1, currency: 'USD', baselineService: 'MAIL', selectedService: 'EXPEDITED',
    address: { name: 'Synthetic Recipient', phone: '+13125550101', line1: '123 Example Lane', line2: null,
      city: 'Chicago', state: 'IL', zip: '60601', country: 'US', isBusiness: false, isPostbox: false } };
}
const decimal = (n: number) => (n / 100).toFixed(2);
function block(excl: number, tax: number) {
  return { total_cost_excl_tax: decimal(excl), total_tax: decimal(tax), total_cost_incl_tax: decimal(excl + tax) };
}
function cost(shipping = 500, tax = 50): any {
  const print = block(1000, 100), ship = block(shipping, tax), fulfillment = block(100, 10);
  return { currency: 'USD', line_item_costs: [{ ...print, quantity: 1 }], shipping_cost: ship,
    fulfillment_cost: fulfillment, total_cost_excl_tax: decimal(1000 + shipping + 100),
    total_tax: decimal(100 + tax + 10), total_cost_incl_tax: decimal(1000 + shipping + 100 + 100 + tax + 10) };
}
function options(): any[] {
  return ['MAIL', 'EXPEDITED'].map((level, i) => ({ id: i + 1, level, postbox_ok: true, home_only: false,
    business_only: false, traceable: true, transit_time: i ? 2 : 8 }));
}
interface Seen { url: string; body: any; headers: Headers; }
function transport(seen: Seen[], config: {
  discover?: () => unknown; cost?: (body: any) => unknown; step?: (kind: string) => void;
  error?: string; badToken?: boolean;
} = {}): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    const u = String(url); const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init?.body;
    seen.push({ url: u, body, headers: new Headers(init?.headers) });
    const kind = u.endsWith('/shipping-options/') ? 'discover' : u.endsWith('/print-job-cost-calculations/') ? 'cost' :
      u.endsWith('/openid-connect/token') ? 'token' : 'unexpected';
    config.step?.(kind);
    if (config.error) throw new Error(config.error);
    if (kind === 'discover') return new Response(JSON.stringify(config.discover?.() ?? options()));
    if (kind === 'token') return new Response(JSON.stringify(config.badToken ? { access_token: {}, expires_in: 'bad' } :
      { access_token: 'synthetic-only-token', expires_in: 3600 }));
    if (kind === 'cost') return new Response(JSON.stringify(config.cost?.(body) ?? cost(body.shipping_option === 'MAIL' ? 500 : 900)));
    throw new Error('UNEXPECTED_SYNTHETIC_FETCH');
  }) as typeof fetch;
}
const KEYS = ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_API_URL', 'LULU_FALLBACK_PHONE', 'LULU_SHIPPING_LEVEL', 'LULU_SOFTCOVER_POD_PACKAGE_ID'] as const;
async function env(run: () => Promise<void>) {
  const old = KEYS.map(k => [k, process.env[k]] as const);
  process.env.LULU_CLIENT_KEY = 'synthetic-client'; process.env.LULU_CLIENT_SECRET = 'synthetic-secret';
  process.env.LULU_API_URL = 'https://api.sandbox.lulu.com'; process.env.LULU_FALLBACK_PHONE = '000-000-0000';
  clearTokenCache();
  try { await run(); } finally { clearTokenCache(); for (const [k, v] of old) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('documented absent optional fulfillment block is zero, but supplied malformed block is invalid', () => {
  const raw = cost(); delete raw.fulfillment_cost;
  raw.total_cost_excl_tax = decimal(1000 + 500);
  raw.total_tax = decimal(100 + 50);
  raw.total_cost_incl_tax = decimal(1000 + 500 + 100 + 50);
  assert.deepEqual(parseShippingLandedCost(raw).fulfillment, { exclTaxCents: 0, taxCents: 0, totalCents: 0 });
  assert.throws(() => parseShippingLandedCost({ ...raw, fulfillment_cost: null }), /^Error: SHIPPING_QUOTE_INVALID$/);
  assert.throws(() => parseShippingLandedCost({ ...raw, fulfillment_cost: {} }), /^Error: SHIPPING_QUOTE_INVALID$/);
  assert.throws(() => parseShippingLandedCost({ ...raw, total_tax: '999.00' }), /^Error: SHIPPING_QUOTE_INVALID$/);
});

test('real paired producer accepts absent zero-fee fulfillment only with reconciled top totals', () => env(async () => {
  const absent = (shipping: number) => {
    const c = cost(shipping); delete c.fulfillment_cost;
    c.total_cost_excl_tax = decimal(1000 + shipping); c.total_tax = decimal(100 + 50);
    c.total_cost_incl_tax = decimal(1000 + shipping + 100 + 50); return c;
  };
  const q = await produceShippingQuote(request(), { now: () => 1000, fetch: transport([], {
    cost: body => absent(body.shipping_option === 'MAIL' ? 500 : 900) }) });
  for (const side of [q.baseline, q.selected]) assert.deepEqual(side.fulfillment, { exclTaxCents: 0, taxCents: 0, totalCents: 0 });
  assert.equal(q.deltaCents, 400); assert.equal(q.selected.totalCents - q.baseline.totalCents, 400);
  assert.equal(validateShippingSelection(q, request(), 1000).quoteId, q.quoteId);
  for (const bad of [null, {}]) {
    await assert.rejects(produceShippingQuote(request(), { now: () => 1000, fetch: transport([], { cost: body => {
      const c = absent(body.shipping_option === 'MAIL' ? 500 : 900); if (body.shipping_option !== 'MAIL') c.fulfillment_cost = bad; return c;
    } }) }), /^Error: SHIPPING_QUOTE_INVALID$/);
  }
}));

test('real paired producer uses public discovery and exact contact-bearing transport then real consumer', () => env(async () => {
  const seen: Seen[] = []; const now = 1000000;
  const q = await produceShippingQuote(request(), { fetch: transport(seen), now: () => now });
  const costs = seen.filter(x => x.url.endsWith('/print-job-cost-calculations/'));
  assert.equal(costs.length, 2); assert.equal(seen.filter(x => x.url.endsWith('/openid-connect/token')).length, 1);
  const discovery = seen.find(x => x.url.endsWith('/shipping-options/'))!;
  assert.equal(discovery.headers.has('Authorization'), false);
  assert.equal(discovery.body.currency, 'USD'); assert.equal(discovery.body.shipping_address.country, 'US');
  assert.equal(discovery.body.shipping_address.state, 'IL');
  assert.equal(discovery.body.shipping_address.phone_number, '+13125550101');
  assert.equal(discovery.body.shipping_address.name, 'Synthetic Recipient');
  assert.deepEqual(costs.map(x => x.body.shipping_option), ['MAIL', 'EXPEDITED']);
  for (const c of costs) {
    assert.equal(c.body.currency, undefined, 'cost request has no undocumented currency property');
    assert.deepEqual(c.body.line_items, [{ pod_package_id: 'SC.PKG', page_count: 32, quantity: 1 }]);
    assert.equal(c.body.shipping_address.phone_number, '+13125550101'); assert.equal(c.body.shipping_address.name, 'Synthetic Recipient');
    assert.equal(c.body.shipping_address.country_code, 'US'); assert.equal(c.body.shipping_address.state_code, 'IL');
  }
  assert.equal(q.deltaCents, parseShippingLandedCost(cost(900)).totalCents - parseShippingLandedCost(cost(500)).totalCents);
  assert.equal(q.expiresAtMs, now + SHIPPING_QUOTE_TTL_MS);
  assert.equal(q.providerExpiresAtMs, null); assert.equal(q.providerQuoteId, null);
  assert.equal(q.transitDays, 2);
  assert.equal(validateShippingSelection(q, request(), now).quoteId, q.quoteId);
}));

test('invalid input/contact does not make discovery, authentication or cost requests', () => env(async () => {
  for (const patch of [{ phone: undefined }, { phone: '' }, { name: '' }, { phone: '000-000-0000' }]) {
    const seen: Seen[] = [];
    await assert.rejects(produceShippingQuote({ ...request(), address: { ...request().address, ...patch } },
      { fetch: transport(seen) }), /^Error: SHIPPING_INPUT_INVALID$/);
    assert.equal(seen.length, 0);
  }
}));

test('operation detaches caller data and freezes endpoint/auth/service/product across awaits', () => env(async () => {
  const raw = request(); const seen: Seen[] = [];
  const q = await produceShippingQuote(raw, { now: () => 1000, fetch: transport(seen, { step: kind => {
    if (kind === 'discover') {
      raw.address.phone = '+13125550103'; raw.podPackageId = 'DRIFT.PKG'; raw.selectedService = 'EXPRESS';
      process.env.LULU_API_URL = 'https://api.lulu.com'; process.env.LULU_CLIENT_KEY = 'changed-synthetic-key';
      process.env.LULU_CLIENT_SECRET = 'changed-synthetic-secret'; process.env.LULU_FALLBACK_PHONE = '1111111111';
      process.env.LULU_SHIPPING_LEVEL = 'EXPRESS'; process.env.LULU_SOFTCOVER_POD_PACKAGE_ID = 'DRIFT.PKG';
    }
  } }) });
  assert.equal(q.input.address.phone, '+13125550101'); assert.equal(q.input.podPackageId, 'SC.PKG');
  assert.ok(seen.every(x => x.url.startsWith('https://api.sandbox.lulu.com/')));
  const auth = seen.find(x => x.url.endsWith('/openid-connect/token'))!;
  assert.equal(auth.headers.get('Authorization'), 'Basic ' + Buffer.from('synthetic-client:synthetic-secret').toString('base64'));
  const costs = seen.filter(x => x.url.endsWith('/print-job-cost-calculations/'));
  assert.equal(costs[1].body.shipping_option, 'EXPEDITED');
  assert.ok(costs.every(x => x.body.line_items[0].pod_package_id === 'SC.PKG' && x.body.shipping_address.phone_number === '+13125550101'));
}));

test('strict operations do not reuse legacy or overlapping-context auth caches', () => env(async () => {
  const legacySeen: Seen[] = [];
  await calculatePrintJobCost({ podPackageId: 'SC.PKG', pageCount: 32, shippingAddress: request().address, shippingLevel: 'MAIL' }, { fetch: transport(legacySeen) });
  let release!: () => void; let reached!: () => void;
  const barrier = new Promise<void>(r => { release = r; }); const arrival = new Promise<void>(r => { reached = r; });
  const aSeen: Seen[] = []; const aFetch = transport(aSeen);
  const a = produceShippingQuote(request(), { now: () => 1000, fetch: (async (u: any, init?: RequestInit) => {
    if (String(u).endsWith('/shipping-options/')) { reached(); await barrier; }
    return aFetch(u, init);
  }) as typeof fetch });
  await arrival;
  process.env.LULU_API_URL = 'https://api.lulu.com'; process.env.LULU_CLIENT_KEY = 'synthetic-client-B';
  const bSeen: Seen[] = []; await produceShippingQuote(request(), { now: () => 1000, fetch: transport(bSeen) });
  release(); await a;
  assert.equal(aSeen.filter(x => x.url.endsWith('/openid-connect/token')).length, 1);
  assert.equal(bSeen.filter(x => x.url.endsWith('/openid-connect/token')).length, 1);
  assert.ok(aSeen.every(x => x.url.startsWith('https://api.sandbox.lulu.com/')));
  assert.ok(bSeen.every(x => x.url.startsWith('https://api.lulu.com/')));
}));

test('complete landed arithmetic rejects malformed/unsafe/inconsistent raw responses with fixed errors', () => {
  const bads: any[] = [];
  for (const field of ['total_tax', 'total_cost_excl_tax', 'total_cost_incl_tax']) {
    const missing = cost(); delete missing[field]; bads.push(missing);
    const drift = cost(); drift[field] = '999.99'; bads.push(drift);
  }
  for (const patch of [{ currency: 'EUR' }, { line_item_costs: [] }, { line_item_costs: [{ ...block(1000, 100), quantity: 2 }] }]) bads.push({ ...cost(), ...patch });
  for (const value of ['SYNTHETIC_PRIVATE_MONEY', '-1.00', '0.001', '9007199254740992.00', 1, null]) {
    const x = cost(); x.shipping_cost.total_tax = value; bads.push(x);
  }
  const negative = cost(); negative.shipping_cost = { total_cost_excl_tax: '5.00', total_cost_incl_tax: '4.00' }; bads.push(negative);
  for (const x of bads) assert.throws(() => parseShippingLandedCost(x), /^Error: SHIPPING_QUOTE_INVALID$/);
  const optional = cost(); delete optional.fulfillment_cost.total_tax;
  assert.equal(parseShippingLandedCost(optional).totalCents, parseShippingLandedCost(cost()).totalCents);
});

/** Removes only the required line-item tax; every other amount/aggregate remains the admissible fixture. */
function missingLineTax(shipping = 500): any { const c = cost(shipping); delete c.line_item_costs[0].total_tax; return c; }
/** Explicit zero line-item tax with top aggregates reconciled to it. */
function zeroLineTax(shipping = 500): any {
  const c = cost(shipping); c.line_item_costs = [{ ...block(1000, 0), quantity: 1 }];
  c.total_tax = decimal(50 + 10); c.total_cost_incl_tax = decimal(1000 + shipping + 100 + 50 + 10); return c;
}

test('required line-item total_tax is never reconstructed; explicit zero line tax stays valid', () => {
  assert.equal(parseShippingLandedCost(cost()).print.taxCents, 100);
  assert.throws(() => parseShippingLandedCost(missingLineTax()), /^Error: SHIPPING_QUOTE_INVALID$/);
  for (const value of [null, '', 0, 'SYNTHETIC_PRIVATE_MONEY']) {
    const x = cost(); x.line_item_costs[0].total_tax = value;
    assert.throws(() => parseShippingLandedCost(x), /^Error: SHIPPING_QUOTE_INVALID$/);
  }
  assert.deepEqual(parseShippingLandedCost(zeroLineTax()).print, { exclTaxCents: 1000, taxCents: 0, totalCents: 1000 });
  const optional = cost(); delete optional.shipping_cost.total_tax;
  assert.equal(parseShippingLandedCost(optional).shipping.taxCents, 50);
});

test('real paired producer refuses missing required line-item tax on baseline or selected cost', () => env(async () => {
  for (const side of ['MAIL', 'EXPEDITED']) {
    const seen: Seen[] = [];
    await assert.rejects(produceShippingQuote(request(), { now: () => 1000, fetch: transport(seen, { cost: body => {
      const shipping = body.shipping_option === 'MAIL' ? 500 : 900;
      return body.shipping_option === side ? missingLineTax(shipping) : cost(shipping);
    } }) }), /^Error: SHIPPING_QUOTE_INVALID$/);
    assert.equal(seen.filter(x => x.url.endsWith('/print-job-cost-calculations/')).length, side === 'MAIL' ? 1 : 2);
  }
  const complete = await produceShippingQuote(request(), { now: () => 1000, fetch: transport([]) });
  assert.equal(complete.deltaCents, 400); assert.equal(validateShippingSelection(complete, request(), 1000).quoteId, complete.quoteId);
  const zero = await produceShippingQuote(request(), { now: () => 1000, fetch: transport([], {
    cost: body => zeroLineTax(body.shipping_option === 'MAIL' ? 500 : 900) }) });
  assert.equal(zero.selected.print.taxCents, 0); assert.equal(zero.deltaCents, 400);
  assert.equal(validateShippingSelection(zero, request(), 1000).quoteId, zero.quoteId);
}));

test('positive landed delta permits a decreasing tax component and does not double-count tax', () => env(async () => {
  const q = await produceShippingQuote(request(), { now: () => 1000, fetch: transport([], {
    cost: body => cost(body.shipping_option === 'MAIL' ? 500 : 900, body.shipping_option === 'MAIL' ? 50 : 10),
  }) });
  assert.ok(q.selected.taxCents < q.baseline.taxCents); assert.ok(q.deltaCents > 0);
  assert.equal(q.deltaCents, q.selected.totalCents - q.baseline.totalCents);
}));

test('zero and negative landed deltas are unoffered, never converted to a minimum charge or credit', () => env(async () => {
  for (const selected of [500, 100]) {
    await assert.rejects(produceShippingQuote(request(), { now: () => 1000, fetch: transport([], {
      cost: body => cost(body.shipping_option === 'MAIL' ? 500 : selected),
    }) }), /^Error: SHIPPING_QUOTE_UNAVAILABLE$/);
  }
}));

test('discovery must actually support both distinct services and preserve postbox restrictions', () => env(async () => {
  for (const list of [[], options().slice(0, 1), [...options(), options()[0]], [{ level: 'EXPEDITED' }],
    options().map(x => ({ ...x, postbox_ok: false }))]) {
    const raw = request(); raw.address.isPostbox = true; const seen: Seen[] = [];
    await assert.rejects(produceShippingQuote(raw, { now: () => 1000, fetch: transport(seen, { discover: () => list }) }), /SHIPPING_QUOTE_(INVALID|UNAVAILABLE)/);
    assert.equal(seen.filter(x => x.url.endsWith('/print-job-cost-calculations/')).length, 0);
  }
}));

test('missing transit is omitted; production-inclusive total_days never becomes transit', () => env(async () => {
  const q = await produceShippingQuote(request(), { now: () => 1000, fetch: transport([], { discover: () => options().map(x => {
    const y: any = { ...x, total_days_min: 100, total_days_max: 200 }; delete y.transit_time; return y;
  }) }) });
  assert.equal(q.transitDays, null);
}));

test('fixed-origin lifetime is rechecked after every transport await and capped by trusted earlier authority', () => env(async () => {
  for (const expireAt of ['discover', 'token', 'baseline', 'selected']) {
    let now = 1000; let costs = 0;
    const fetch = transport([], { step: kind => {
      if (kind === 'cost') costs++;
      if (kind === expireAt || (expireAt === 'baseline' && kind === 'cost' && costs === 1) ||
        (expireAt === 'selected' && kind === 'cost' && costs === 2)) now += SHIPPING_QUOTE_TTL_MS;
    } });
    await assert.rejects(produceShippingQuote(request(), { now: () => now, fetch }), /^Error: SHIPPING_QUOTE_EXPIRED$/);
  }
  const start = 1000; const cap = start + 60000;
  const q = await produceShippingQuote(request(), { now: () => start, authorityExpiresAtMs: cap, fetch: transport([]) });
  assert.equal(q.expiresAtMs, cap); assert.equal(q.providerExpiresAtMs, null);
  assert.throws(() => validateShippingSelection(q, request(), cap), /SHIPPING_QUOTE_EXPIRED/);
}));

test('real selection consumer rejects changed trusted input and tampered receipt prices or bindings', () => env(async () => {
  const q = await produceShippingQuote(request(), { now: () => 1000, fetch: transport([]) });
  for (const patch of [{ draftId: 'wrong-draft' }, { ownerBinding: 'b'.repeat(64) }, { plannedProductVersion: 'other-layout' },
    { pageCount: 40 }, { selectedService: 'EXPRESS' }]) {
    assert.throws(() => validateShippingSelection(q, { ...request(), ...patch }, 1000), /SHIPPING_BINDING_MISMATCH/);
  }
  for (const mutate of [(x: any) => { x.deltaCents++; }, (x: any) => { x.binding = 'b'.repeat(64); },
    (x: any) => { x.input.address.phone = '+13125550103'; }, (x: any) => { x.baseline.totalCents++; },
    (x: any) => { x.expiresAtMs += SHIPPING_QUOTE_TTL_MS; }]) {
    const changed = JSON.parse(JSON.stringify(q)); mutate(changed);
    assert.throws(() => validateShippingSelection(changed, request(), 1000), /SHIPPING_(QUOTE_INVALID|BINDING_MISMATCH)/);
  }
}));

test('expiry observed after authentication sends no cost request', () => env(async () => {
  let now = 1000; const seen: Seen[] = [];
  await assert.rejects(produceShippingQuote(request(), { now: () => now, fetch: transport(seen, { step: kind => {
    if (kind === 'token') now += SHIPPING_QUOTE_TTL_MS;
  } }) }), /^Error: SHIPPING_QUOTE_EXPIRED$/);
  assert.equal(seen.filter(x => x.url.endsWith('/print-job-cost-calculations/')).length, 0);
}));

test('trusted authority cap at or before origin, or invalid clock/cap, fails before any request', () => env(async () => {
  for (const [deps, pattern] of [[{ now: () => 1000, authorityExpiresAtMs: 1000 }, /^Error: SHIPPING_QUOTE_EXPIRED$/],
    [{ now: () => 1000, authorityExpiresAtMs: 1.5 }, /^Error: SHIPPING_QUOTE_INVALID$/],
    [{ now: () => NaN }, /^Error: SHIPPING_QUOTE_INVALID$/]] as const) {
    const seen: Seen[] = [];
    await assert.rejects(produceShippingQuote(request(), { ...deps, fetch: transport(seen) }), pattern);
    assert.equal(seen.length, 0);
  }
  let now = 1000; const seen: Seen[] = [];
  await assert.rejects(produceShippingQuote(request(), { now: () => now, fetch: transport(seen, { step: kind => {
    if (kind === 'discover') now = 999;
  } }) }), /^Error: SHIPPING_QUOTE_INVALID$/);
}));

test('discovery eligibility: absent postbox_ok is ineligible for postboxes; day-of-week flags are not address restrictions', () => env(async () => {
  const raw = request(); raw.address.isPostbox = true;
  await assert.rejects(produceShippingQuote(raw, { now: () => 1000, fetch: transport([], { discover: () => options().map(x => {
    const y: any = { ...x }; delete y.postbox_ok; return y;
  }) }) }), /^Error: SHIPPING_QUOTE_UNAVAILABLE$/);
  const business = request(); business.address.isBusiness = true;
  const q = await produceShippingQuote(business, { now: () => 1000, fetch: transport([], { discover: () =>
    options().map(x => ({ ...x, home_only: true, business_only: true })) }) });
  assert.equal(q.input.address.isBusiness, true);
}));

test('malformed discovery entries and default zero transit never mint a selection or transit claim', () => env(async () => {
  for (const list of [{ level: 'MAIL' }, [null, ...options()], [{ ...options()[0], level: 7 }, options()[1]],
    options().map(x => ({ ...x, postbox_ok: 'yes' })), options().map(x => ({ ...x, transit_time: -1 })),
    options().map(x => ({ ...x, transit_time: '2' }))]) {
    const seen: Seen[] = [];
    await assert.rejects(produceShippingQuote(request(), { now: () => 1000, fetch: transport(seen, { discover: () => list }) }),
      /^Error: SHIPPING_QUOTE_INVALID$/);
    assert.equal(seen.filter(x => x.url.endsWith('/print-job-cost-calculations/')).length, 0);
  }
  const q = await produceShippingQuote(request(), { now: () => 1000, fetch: transport([], { discover: () =>
    options().map(x => ({ ...x, transit_time: 0 })) }) });
  assert.equal(q.transitDays, null);
}));

test('cost response currency or quantity drift from the frozen contract is refused', () => env(async () => {
  for (const drift of [(x: any) => { x.currency = 'usd '; }, (x: any) => { x.line_item_costs[0].quantity = '1'; },
    (x: any) => { x.line_item_costs.push(x.line_item_costs[0]); }, (x: any) => { delete x.fulfillment_cost; }]) {
    await assert.rejects(produceShippingQuote(request(), { now: () => 1000, fetch: transport([], { cost: body => {
      const c = cost(body.shipping_option === 'MAIL' ? 500 : 900); if (body.shipping_option !== 'MAIL') drift(c); return c;
    } }) }), /^Error: SHIPPING_QUOTE_INVALID$/);
  }
}));

test('auth/HTTP/JSON/transport/money failures never echo synthetic private data or raw causes', () => env(async () => {
  const sentinel = 'SYNTHETIC_PRIVATE_PHONE_ADDRESS';
  const fakeCases: typeof fetch[] = [transport([], { error: sentinel }), transport([], { badToken: true }),
    transport([], { cost: () => ({ ...cost(), total_tax: sentinel }) }),
    (async () => new Response(JSON.stringify({ detail: sentinel }), { status: 400 })) as typeof fetch,
    (async () => new Response(sentinel, { status: 200 })) as typeof fetch];
  for (const fetch of fakeCases) {
    await assert.rejects(produceShippingQuote(request(), { now: () => 1000, fetch }), (e: any) => {
      assert.match(e.message, /^SHIPPING_QUOTE_(UNAVAILABLE|INVALID)$/);
      assert.equal(e.cause, undefined); assert.ok(!String(e.stack).includes(sentinel)); return true;
    });
  }
}));
