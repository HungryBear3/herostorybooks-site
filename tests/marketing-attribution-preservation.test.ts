import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sendGa4Purchase } from '../src/lib/ga4-purchase.ts';
import { metaCapiStatus } from '../src/lib/marketing/meta-capi.ts';

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

test('the three GA4 purchase call sites are intact and Meta is wired at none of them', () => {
  const ga4Calls = webhookSource.match(/scheduleGa4Purchase\(\{/g) ?? [];
  assert.equal(ga4Calls.length, 3, 'the three GA4 purchase call sites changed');
  // CAPI is deferred: the webhook must not reference Meta at all any more.
  assert.equal(webhookSource.includes('scheduleMetaCapiPurchase'), false);
  assert.equal(webhookSource.includes('metaCapiPurchaseFrom'), false);
  assert.equal(/\bmeta-capi\b/.test(webhookSource), false, 'the webhook still imports the CAPI module');
});

test('every GA4 purchase carries the governed campaign recovered from the signed session', () => {
  const ga4Calls = webhookSource.match(/campaign: campaignFromSession\(session\),/g) ?? [];
  assert.equal(ga4Calls.length, 3, 'a GA4 purchase call site is missing its campaign');
  // Recovered from Stripe metadata, and re-validated rather than trusted.
  const helper = webhookSource.slice(
    webhookSource.indexOf('function campaignFromSession'),
    webhookSource.indexOf('function getStripe'),
  );
  assert.match(helper, /validateUtmTuple\(/);
  assert.match(helper, /result\.ok && result\.tuple \? result\.tuple : null/);
  for (const banned of [
    'customer_email', 'shipping', 'orderId', 'client_reference_id',
    'payment_intent', 'gaClientId',
  ]) {
    assert.equal(helper.includes(banned), false, `campaignFromSession touches ${banned}`);
  }
});

test('the refund and terminal-state guards are untouched by this candidate', () => {
  assert.match(webhookSource, /refusing to resurrect; no state change, no fulfillment retrigger/);
  assert.match(webhookSource, /existing\.paymentStatus === 'refunded' \|\| existing\.refundedAt/);
  // The refunded branch returns before any analytics call.
  const refundBranch = webhookSource.slice(
    webhookSource.indexOf("if (existing.paymentStatus === 'refunded'"),
    webhookSource.indexOf('refundedSkipped: true'),
  );
  assert.equal(refundBranch.includes('scheduleGa4Purchase'), false);
});

// ── No duplicate purchase across GA4, Stripe, and Meta, including replay ────

test('a webhook replay produces exactly one GA4 transaction_id, campaign included', async () => {
  const bodies: Record<string, unknown>[] = [];
  const ga4Deps = {
    env: { GA4_MEASUREMENT_ID: 'G-TEST123', GA4_API_SECRET: 'secret' } as unknown as NodeJS.ProcessEnv,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  };

  const purchase = {
    transactionId: 'cs_live_replay_case', amountCents: 6400, currency: 'usd',
    itemId: 'book_premium', itemName: 'HeroStoryBooks premium', paymentStatus: 'paid',
    campaign: {
      utm_source: 'brightwood_pta',
      utm_medium: 'partner',
      utm_campaign: 'autumn_pilot',
    },
  };

  // Three independent deliveries of the same Stripe session, each in a fresh
  // runtime, which is the worst case: only the stable identifier can help.
  for (let i = 0; i < 3; i += 1) await sendGa4Purchase(purchase, ga4Deps);

  const transactionIds = bodies.map((b) => (b as any).events[0].params.transaction_id);
  assert.equal(new Set(transactionIds).size, 1, 'GA4 cannot deduplicate these deliveries');
  assert.equal(transactionIds[0], 'cs_live_replay_case');

  // The campaign rides on every delivery and is identical each time, so a
  // replay cannot reattribute the same purchase to a different campaign.
  const campaigns = bodies.map((b) => JSON.stringify({
    s: (b as any).events[0].params.campaign_source,
    m: (b as any).events[0].params.campaign_medium,
    n: (b as any).events[0].params.campaign_name,
  }));
  assert.equal(new Set(campaigns).size, 1);
  assert.equal((bodies[0] as any).events[0].params.campaign_source, 'brightwood_pta');
  assert.equal((bodies[0] as any).events[0].params.campaign_medium, 'partner');
  assert.equal((bodies[0] as any).events[0].params.campaign_name, 'autumn_pilot');
});

test('CAPI is deferred, so there is no second purchase destination to deduplicate against', () => {
  const status = metaCapiStatus();
  assert.equal(status.status, 'deferred');
  assert.equal(status.reason, 'no_matching_contract');
  assert.ok(status.blockers.length >= 3);
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
    const consentStore = await import('../src/lib/marketing/consent-store.ts');
    bridge.__resetMetaBridgeForTests();
    // Optional browser measurement is consent-gated now. Grant it, so this
    // test still asks its original question: does the Meta candidate change
    // anything about GA4? (It must not.) The no-consent case is covered by
    // tests/marketing-consent-store.test.ts.
    consentStore.setConsent('granted');

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
    const consentStore = await import('../src/lib/marketing/consent-store.ts');
    consentStore.__resetConsentStoreForTests();
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
