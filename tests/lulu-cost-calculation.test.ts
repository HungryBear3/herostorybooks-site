/**
 * Lulu print-job cost calculation adapter. Every network call is intercepted;
 * nothing leaves the host. The adapter must send the documented request shape
 * (line_items / shipping_address / shipping_option), require credentials, and
 * fail closed on any non-2xx or malformed answer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { calculatePrintJobCost, clearTokenCache, createLuluPrintCostQuoteProvider } from '../src/lib/lulu.ts';

const MANAGED = ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_API_URL', 'LULU_SHIPPING_LEVEL', 'LULU_FALLBACK_PHONE', 'LULU_HARDCOVER_POD_PACKAGE_ID', 'LULU_SOFTCOVER_POD_PACKAGE_ID'] as const;

function withEnv(values: Partial<Record<(typeof MANAGED)[number], string>>, run: () => Promise<void>) {
  return async () => {
    const saved = new Map(MANAGED.map((k) => [k, process.env[k]]));
    for (const k of MANAGED) delete process.env[k];
    for (const [k, v] of Object.entries(values)) process.env[k] = v;
    clearTokenCache();
    try {
      await run();
    } finally {
      clearTokenCache();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  };
}

const ADDRESS = { name: 'Alexy Kaplun', line1: '1234 N Broadway', line2: 'Apt 2', city: 'Chicago', state: 'IL', zip: '60640', country: 'US' };

function costBody() {
  return {
    currency: 'USD',
    line_item_costs: [{ quantity: 1, cost_excl_discounts: '9.73', total_cost_excl_discounts: '9.73', total_cost_excl_tax: '9.73', total_tax: '1.00', total_cost_incl_tax: '10.73', tax_rate: '0.1025', discounts: [] }],
    shipping_cost: { total_cost_excl_tax: '4.49', total_tax: '0.46', total_cost_incl_tax: '4.95', tax_rate: '0.1025' },
    fulfillment_cost: { total_cost_excl_tax: '1.50', total_cost_incl_tax: '1.65' },
    total_tax: '1.61',
    total_cost_excl_tax: '15.72',
    total_cost_incl_tax: '17.33',
  };
}

function fakeFetch(handlers: { token?: () => Response; cost: (body: unknown) => Response }, seen: { url: string; init: RequestInit }[]) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    if (url.includes('/openid-connect/token')) {
      return handlers.token?.() ?? new Response(JSON.stringify({ access_token: 'tok_test', expires_in: 3600 }), { status: 200 });
    }
    if (url.endsWith('/print-job-cost-calculations/')) {
      return handlers.cost(JSON.parse(String(init?.body ?? '{}')));
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

test('calculatePrintJobCost: refuses without credentials and makes no request', withEnv({}, async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  await assert.rejects(
    calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: ADDRESS, shippingLevel: 'MAIL' }, { fetch: fakeFetch({ cost: () => new Response('{}') }, seen) }),
    /LULU_CLIENT_KEY/,
  );
  assert.equal(seen.length, 0);
}));

test('calculatePrintJobCost: posts the documented request shape with bearer auth', withEnv({ LULU_CLIENT_KEY: 'k', LULU_CLIENT_SECRET: 's', LULU_API_URL: 'https://api.sandbox.lulu.com/', LULU_FALLBACK_PHONE: '312-555-0100' }, async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  let posted: unknown = null;
  const result = await calculatePrintJobCost(
    { podPackageId: '0850X0850.FC.STD.CW.080CW444.MXX', pageCount: 26, shippingAddress: ADDRESS, shippingLevel: 'MAIL' },
    { fetch: fakeFetch({ cost: (body) => { posted = body; return new Response(JSON.stringify(costBody()), { status: 201 }); } }, seen) },
  );
  assert.deepEqual(posted, {
    line_items: [{ pod_package_id: '0850X0850.FC.STD.CW.080CW444.MXX', page_count: 26, quantity: 1 }],
    shipping_address: {
      name: 'Alexy Kaplun',
      street1: '1234 N Broadway',
      street2: 'Apt 2',
      city: 'Chicago',
      state_code: 'IL',
      postcode: '60640',
      country_code: 'US',
      phone_number: '312-555-0100',
    },
    shipping_option: 'MAIL',
  });
  const costCall = seen.find((s) => s.url.endsWith('/print-job-cost-calculations/'))!;
  assert.equal(costCall.url, 'https://api.sandbox.lulu.com/print-job-cost-calculations/');
  assert.equal((costCall.init.headers as Record<string, string>).Authorization, 'Bearer tok_test');
  assert.equal(result.total_cost_incl_tax, '17.33');
}));

test('calculatePrintJobCost: a non-2xx or non-JSON answer is an error, never a quote', withEnv({ LULU_CLIENT_KEY: 'k', LULU_CLIENT_SECRET: 's' }, async () => {
  await assert.rejects(
    calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: ADDRESS, shippingLevel: 'MAIL' }, { fetch: fakeFetch({ cost: () => new Response('{"detail":"bad address"}', { status: 400 }) }, []) }),
    /Lulu cost calculation error 400/,
  );
  await assert.rejects(
    calculatePrintJobCost({ podPackageId: 'X', pageCount: 26, shippingAddress: ADDRESS, shippingLevel: 'MAIL' }, { fetch: fakeFetch({ cost: () => new Response('<html>', { status: 200 }) }, []) }),
    /Lulu cost calculation/,
  );
}));

test('createLuluPrintCostQuoteProvider: maps a target format to the configured POD package and exact cents', withEnv({ LULU_CLIENT_KEY: 'k', LULU_CLIENT_SECRET: 's', LULU_SHIPPING_LEVEL: 'GROUND', LULU_HARDCOVER_POD_PACKAGE_ID: 'HC.PKG', LULU_SOFTCOVER_POD_PACKAGE_ID: 'SC.PKG' }, async () => {
  const bodies: unknown[] = [];
  const provider = createLuluPrintCostQuoteProvider({
    fetch: fakeFetch({ cost: (body) => { bodies.push(body); return new Response(JSON.stringify(costBody()), { status: 201 }); } }, []),
  });
  const premium = await provider.quote({ targetFormat: 'premium', pageCount: 26, shippingAddress: ADDRESS });
  const classic = await provider.quote({ targetFormat: 'classic', pageCount: 32, shippingAddress: ADDRESS });
  assert.equal((bodies[0] as { line_items: { pod_package_id: string }[] }).line_items[0].pod_package_id, 'HC.PKG');
  assert.equal((bodies[1] as { line_items: { pod_package_id: string }[] }).line_items[0].pod_package_id, 'SC.PKG');
  assert.equal((bodies[0] as { shipping_option: string }).shipping_option, 'GROUND');
  assert.deepEqual(premium, {
    provider: 'lulu', podPackageId: 'HC.PKG', shippingLevel: 'GROUND', currency: 'usd',
    printCents: 973, shippingCents: 449, fulfillmentCents: 150, taxCents: 161, totalCents: 1733,
  });
  assert.equal(classic.podPackageId, 'SC.PKG');
}));

test('Lulu cost calculation binds three extra copies and rejects a one-copy response', withEnv({ LULU_CLIENT_KEY: 'k', LULU_CLIENT_SECRET: 's', LULU_API_URL: 'https://api.sandbox.lulu.com/' }, async () => {
  let posted: any = null;
  const cost = costBody();
  cost.line_item_costs[0].quantity = 3;
  const response = await calculatePrintJobCost(
    { podPackageId: 'SC.PKG', pageCount: 32, quantity: 3, shippingAddress: ADDRESS, shippingLevel: 'MAIL' },
    { fetch: fakeFetch({ cost: (body) => { posted = body; return new Response(JSON.stringify(cost), { status: 201 }); } }, []) },
  );
  assert.equal(posted.line_items[0].quantity, 3);
  assert.equal(response.line_item_costs?.[0]?.quantity, 3);
  await assert.rejects(calculatePrintJobCost({ podPackageId: 'SC.PKG', pageCount: 32, quantity: 0, shippingAddress: ADDRESS, shippingLevel: 'MAIL' }), /quantity from 1 to 10/);
}));
