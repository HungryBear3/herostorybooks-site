import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sendGa4Purchase } from '../src/lib/ga4-purchase.ts';
import {
  META_CAPI_ACCESS_TOKEN_ENV,
  META_CAPI_DATASET_ID_ENV,
  META_CAPI_FLAG_ENV,
  sendMetaCapiPurchase,
} from '../src/lib/marketing/meta-capi.ts';

const webhookSource = readFileSync(
  new URL('../src/app/api/webhooks/stripe/route.ts', import.meta.url), 'utf8',
);
const ga4Source = readFileSync(new URL('../src/lib/ga4-purchase.ts', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');

// ── GA4 and Stripe attribution are preserved exactly ────────────────────────

test('the GA4 purchase path is unchanged: Stripe session id remains transaction_id', () => {
  assert.match(ga4Source, /transaction_id: input\.transactionId/);
  assert.match(ga4Source, /status === 'paid' \|\| status === 'no_payment_required'/);
  assert.match(ga4Source, /GA4_MEASUREMENT_ID \|\| env\.NEXT_PUBLIC_GA_MEASUREMENT_ID/);
  assert.match(ga4Source, /google-analytics\.com\/mp\/collect/);
  // The GA4 module knows nothing about Meta.
  assert.equal(ga4Source.includes('meta'), false);
  assert.equal(ga4Source.toLowerCase().includes('facebook'), false);
});

test('the GA client id capture and Stripe metadata carry are untouched', () => {
  const orderRoute = readFileSync(new URL('../src/app/api/order/route.ts', import.meta.url), 'utf8');
  const checkoutForm = readFileSync(new URL('../src/app/checkout/checkout-form.tsx', import.meta.url), 'utf8');
  assert.match(checkoutForm, /const gaClientId = currentGaClientId\(\);/);
  assert.match(orderRoute, /const gaClientId = sanitizeGaClientId\(form\.get\('gaClientId'\)\);/);
  assert.match(orderRoute, /\.\.\.\(gaClientId \? \{ gaClientId \} : \{\}\)/);
  assert.match(webhookSource, /clientId: session\.metadata\?\.gaClientId/);
});

test('the existing gtag forwarding and sanitised page_location survive the bridge', () => {
  assert.match(analyticsSource, /window\.gtag\('event', event, googleSafeProps\(record\)\)/);
  assert.match(analyticsSource, /props\.page_location = pageLocation/);
  assert.match(analyticsSource, /props\.page_referrer = sanitizedPageReferrer\(\)/);
  assert.match(analyticsSource, /trackVercelEvent\(event, vercelSafeProps\(record\)\)/);
  assert.doesNotMatch(analyticsSource, /window\.location\.href/);
});

test('the bridge receives only the event name, never the event record', () => {
  assert.match(analyticsSource, /metaHandleHsbEvent\(event\);/);
  // No call site passes the record, the props, or the campaign params.
  assert.equal(/metaHandleHsbEvent\(\s*event\s*,/.test(analyticsSource), false);
  assert.equal(/metaHandleHsbEvent\([^)]*record/.test(analyticsSource), false);
  assert.equal(/metaHandleHsbEvent\([^)]*props/.test(analyticsSource), false);
});

// ── Webhook wiring: same sites, same order, nothing extra ───────────────────

test('Meta CAPI is wired at exactly the sites GA4 already occupies, and nowhere else', () => {
  const ga4Calls = webhookSource.match(/scheduleGa4Purchase\(\{/g) ?? [];
  const metaCalls = webhookSource.match(/scheduleMetaCapiPurchase\(/g) ?? [];
  assert.equal(ga4Calls.length, 3, 'the three GA4 purchase call sites changed');
  assert.equal(metaCalls.length, 3, 'Meta is not wired one-for-one with GA4');
});

test('every Meta CAPI call sits immediately after its GA4 call, i.e. after the durable write', () => {
  const segments = webhookSource.split('scheduleMetaCapiPurchase(');
  assert.equal(segments.length, 4);
  for (const before of segments.slice(0, 3)) {
    const window = before.slice(-500);
    assert.ok(
      window.includes('scheduleGa4Purchase({'),
      'a Meta CAPI call is not preceded by the GA4 call that marks the trusted, post-write point',
    );
  }
});

test('the webhook hands Meta four facts and no customer, order, or shipping data', () => {
  const helper = webhookSource.slice(
    webhookSource.indexOf('function metaCapiPurchaseFrom'),
    webhookSource.indexOf('function getStripe'),
  );
  assert.ok(helper.length > 0);
  for (const banned of [
    'customer_email', 'shipping', 'orderId', 'client_reference_id',
    'payment_intent', 'metadata?.invite', 'metadata?.cohort', 'gaClientId',
  ]) {
    assert.equal(helper.includes(banned), false, `metaCapiPurchaseFrom passes ${banned}`);
  }
  assert.match(helper, /stripeSessionId: session\.id/);
  assert.match(helper, /amountCents: session\.amount_total \?\? 0/);
  assert.match(helper, /paymentStatus: session\.payment_status/);
});

test('the refund and terminal-state guards are untouched by this candidate', () => {
  assert.match(webhookSource, /refusing to resurrect; no state change, no fulfillment retrigger/);
  assert.match(webhookSource, /existing\.paymentStatus === 'refunded' \|\| existing\.refundedAt/);
  // The refunded branch returns before any analytics call.
  const refundBranch = webhookSource.slice(
    webhookSource.indexOf("if (existing.paymentStatus === 'refunded'"),
    webhookSource.indexOf('refundedSkipped: true'),
  );
  assert.equal(refundBranch.includes('scheduleMetaCapiPurchase'), false);
  assert.equal(refundBranch.includes('scheduleGa4Purchase'), false);
});

// ── No duplicate purchase across GA4, Stripe, and Meta, including replay ────

test('a webhook replay produces one GA4 transaction_id and one Meta event_id', async () => {
  const ga4TransactionIds: string[] = [];
  const metaEventIds: string[] = [];

  const ga4Deps = {
    env: { GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      ga4TransactionIds.push(JSON.parse(String(init?.body)).events[0].params.transaction_id);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  };
  const metaDeps = {
    env: {
      [META_CAPI_FLAG_ENV]: 'true',
      [META_CAPI_DATASET_ID_ENV]: '987654321098765',
      [META_CAPI_ACCESS_TOKEN_ENV]: 'test-token',
    } as unknown as NodeJS.ProcessEnv,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      metaEventIds.push(JSON.parse(String(init?.body)).data[0].event_id);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  };

  const purchase = {
    transactionId: 'cs_live_replay_case', amountCents: 6400, currency: 'usd',
    itemId: 'book_premium', itemName: 'HeroStoryBooks premium', paymentStatus: 'paid',
  };
  const metaPurchase = {
    stripeSessionId: 'cs_live_replay_case', amountCents: 6400, currency: 'usd',
    contentId: 'book_premium', paymentStatus: 'paid', eventTimeSeconds: 1_790_000_000,
  };

  // Three independent deliveries of the same Stripe session, each in a fresh
  // runtime (separate sentEventIds), which is the worst case: the in-process
  // guard cannot help and only the stable identifiers can.
  for (let i = 0; i < 3; i += 1) {
    await sendGa4Purchase(purchase, ga4Deps);
    await sendMetaCapiPurchase(metaPurchase, { ...metaDeps, sentEventIds: new Set() });
  }

  assert.equal(new Set(ga4TransactionIds).size, 1, 'GA4 cannot deduplicate these deliveries');
  assert.equal(new Set(metaEventIds).size, 1, 'Meta cannot deduplicate these deliveries');
  assert.equal(ga4TransactionIds[0], 'cs_live_replay_case');
  assert.match(metaEventIds[0], /^hsb_[0-9a-f]{32}$/);
  // The two platforms dedupe on different values, and Meta never learns GA4's.
  assert.notEqual(ga4TransactionIds[0], metaEventIds[0]);
});

test('no browser-emitting surface names Purchase at all', () => {
  // event-contract.ts is excluded deliberately: it is the shared contract and
  // must name Purchase, both as the server event and in the prohibited list.
  // Its own guarantees are asserted in tests/marketing-meta-pixel.test.ts.
  const emittingSources = [
    '../src/lib/analytics.ts',
    '../src/lib/marketing/meta-pixel.ts',
    '../src/lib/marketing/meta-bridge.ts',
    '../src/components/marketing/meta-pixel-mount.tsx',
    '../src/app/checkout/checkout-form.tsx',
    '../src/app/thank-you/page.tsx',
  ];
  for (const relative of emittingSources) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.equal(source.includes('Purchase'), false, `${relative} names a Meta Purchase event`);
  }
});

test('the browser mapping table cannot reach a purchase event', async () => {
  const { HSB_EVENT_TO_META_BROWSER, META_BROWSER_EVENT_ALLOWLIST, CANONICAL_EVENT_MATRIX } =
    await import('../src/lib/marketing/event-contract.ts');
  assert.deepEqual(Object.values(HSB_EVENT_TO_META_BROWSER), ['InitiateCheckout']);
  assert.equal((META_BROWSER_EVENT_ALLOWLIST as readonly string[]).includes('Purchase'), false);
  for (const mapping of CANONICAL_EVENT_MATRIX) {
    if (mapping.metaServerEvent !== null) {
      assert.equal(mapping.owner, 'stripe_webhook', `${mapping.stage} sends a server event from the browser`);
      assert.equal(mapping.metaBrowserEvent, null, `${mapping.stage} has both a browser and a server Meta event`);
    }
  }
});

// ── The bridge is inert on a deployment with no Meta configuration ──────────

test('with no Meta environment, tracking a funnel event creates no controller and no Meta call', async () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const gtagCalls: unknown[][] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: new URL('https://herostorybooks.com/checkout?childName=PrivateName'),
      gtag: (...args: unknown[]) => gtagCalls.push(args),
      sessionStorage: { getItem: () => null, setItem: () => undefined },
    },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: '' } });

  try {
    const { track } = await import('../src/lib/analytics.ts');
    const bridge = await import('../src/lib/marketing/meta-bridge.ts');
    bridge.__resetMetaBridgeForTests();

    track('begin_checkout', { theme: 'space' });
    track('page_view');

    assert.equal(bridge.getMetaPixelController(), null, 'a controller was constructed without configuration');
    assert.deepEqual(bridge.metaHandleRoute('/checkout'), { status: 'skipped', reason: 'no_pixel_id' });
    assert.deepEqual(bridge.metaHandleHsbEvent('begin_checkout'), { status: 'skipped', reason: 'no_pixel_id' });
    // GA4 still received both events; the Meta candidate changed nothing.
    assert.ok(gtagCalls.some((c) => c[0] === 'event' && c[1] === 'begin_checkout'));
    assert.ok(gtagCalls.some((c) => c[0] === 'event' && c[1] === 'page_view'));
    // No Meta runtime was created anywhere on the fake global.
    assert.equal((globalThis as Record<string, unknown>).fbq, undefined);
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
});

test('the bridge forwards a fixed, contract-allowlisted parameter pair and nothing derived', () => {
  const bridgeSource = readFileSync(new URL('../src/lib/marketing/meta-bridge.ts', import.meta.url), 'utf8');
  assert.match(bridgeSource, /content_type: 'product'/);
  assert.match(bridgeSource, /content_category: 'storybook'/);
  assert.match(bridgeSource, /export function metaHandleHsbEvent\(hsbEvent: string\): MetaPixelOutcome/);
});
