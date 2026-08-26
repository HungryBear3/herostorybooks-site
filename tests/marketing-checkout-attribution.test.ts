/**
 * UTM preservation through checkout creation and into the trusted purchase.
 *
 * The chain under test: landing capture -> client navigation -> checkout POST
 * -> server re-validation -> order record -> Stripe metadata -> signed webhook
 * -> GA4 purchase. Each hop must carry only governed values, and no hop may
 * put a campaign label anywhere the customer can see it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sendGa4Purchase } from '../src/lib/ga4-purchase.ts';

const orderRouteSource = readFileSync(
  new URL('../src/app/api/order/route.ts', import.meta.url),
  'utf8',
);
const webhookSource = readFileSync(
  new URL('../src/app/api/webhooks/stripe/route.ts', import.meta.url),
  'utf8',
);
const checkoutFormSource = readFileSync(
  new URL('../src/app/checkout/checkout-form.tsx', import.meta.url),
  'utf8',
);

const GA4_ENV = {
  GA4_MEASUREMENT_ID: 'G-TEST123',
  GA4_API_SECRET: 'secret',
} as unknown as NodeJS.ProcessEnv;

async function ga4ParamsFor(campaign: unknown): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {};
  await sendGa4Purchase(
    {
      transactionId: 'cs_test_1',
      amountCents: 4900,
      currency: 'usd',
      itemId: 'book_classic',
      itemName: 'HeroStoryBooks classic',
      paymentStatus: 'paid',
      campaign: campaign as never,
    },
    {
      env: GA4_ENV,
      fetchImpl: (async (_i: RequestInfo | URL, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body)).events[0].params;
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    },
  );
  return captured;
}

/* ── 1. The client sends only governed fields ───────────────────────────── */

test('the checkout POST carries the governed tuple and nothing else campaign-shaped', () => {
  assert.match(checkoutFormSource, /attributionMetadata\(currentAttribution\(\)\)/);
  // No raw URL, referrer, or arbitrary parameter is attached to the payload.
  const block = checkoutFormSource.slice(
    checkoutFormSource.indexOf('const gaClientId = currentGaClientId();'),
    checkoutFormSource.indexOf('const gaClientId = currentGaClientId();') + 800,
  );
  for (const forbidden of ['document.referrer', 'location.href', 'location.search', 'utm_term', 'gclid']) {
    assert.equal(block.includes(forbidden), false, `checkout POST carries ${forbidden}`);
  }
});

/* ── 2. The server re-validates rather than trusting the client ─────────── */

test('the order route re-validates the tuple with the governed contract', () => {
  assert.match(orderRouteSource, /validateUtmTuple\(\{/);
  assert.match(orderRouteSource, /utm_source: form\.get\('utm_source'\)/);
  assert.match(orderRouteSource, /utm_medium: form\.get\('utm_medium'\)/);
  assert.match(orderRouteSource, /utm_campaign: form\.get\('utm_campaign'\)/);
  // Invalid resolves to null, never a partial record.
  assert.match(
    orderRouteSource,
    /campaignAttributionResult\.ok && campaignAttributionResult\.tuple\s*\n?\s*\? campaignAttributionResult\.tuple\s*\n?\s*: null/,
  );
});

test('the validated tuple is bound to the order record', () => {
  assert.match(orderRouteSource, /campaignAttribution,/);
  const ordersSource = readFileSync(
    new URL('../src/lib/orders.ts', import.meta.url),
    'utf8',
  );
  assert.match(ordersSource, /campaignAttribution\?: GovernedUtmTuple \| null;/);
  assert.match(ordersSource, /campaignAttribution: input\.campaignAttribution \?\? null,/);
});

/* ── 3. Stripe carries it in metadata only, never customer-visible ──────── */

test('attribution rides in Stripe metadata and nowhere the customer can see', () => {
  assert.match(orderRouteSource, /\.\.\.attributionMetadata\(order\.campaignAttribution \?\? null\)/);

  // It must appear inside the metadata object, and must not appear in the
  // line item, product data, or any description/name field.
  const sessionCall = orderRouteSource.slice(
    orderRouteSource.indexOf('stripe.checkout.sessions.create({'),
    orderRouteSource.indexOf('payment_intent_data:'),
  );
  assert.match(sessionCall, /metadata: \{[\s\S]*attributionMetadata/);

  const lineItems = orderRouteSource.slice(
    orderRouteSource.indexOf('line_items: ['),
    orderRouteSource.indexOf('line_items: [') + 1200,
  );
  for (const forbidden of ['attributionMetadata', 'campaignAttribution', 'utm_']) {
    assert.equal(lineItems.includes(forbidden), false, `line items expose ${forbidden}`);
  }
});

/* ── 4. The trusted purchase re-validates once more ─────────────────────── */

test('a governed tuple reaches GA4 as reserved campaign parameters', async () => {
  const params = await ga4ParamsFor({
    utm_source: 'brightwood_pta',
    utm_medium: 'partner',
    utm_campaign: 'autumn_pilot',
    utm_content: 'poster_a',
  });
  assert.equal(params.campaign_source, 'brightwood_pta');
  assert.equal(params.campaign_medium, 'partner');
  assert.equal(params.campaign_name, 'autumn_pilot');
  assert.equal(params.campaign_content, 'poster_a');
  assert.equal(params.transaction_id, 'cs_test_1');
});

test('an unapproved medium contributes nothing, not a partial campaign', async () => {
  const params = await ga4ParamsFor({
    utm_source: 'telegram',
    utm_medium: 'social',
    utm_campaign: 'launch',
  });
  for (const key of ['campaign_source', 'campaign_medium', 'campaign_name', 'campaign_content']) {
    assert.equal(params[key], undefined, `${key} survived an invalid tuple`);
  }
  // The purchase itself is unaffected.
  assert.equal(params.transaction_id, 'cs_test_1');
  assert.equal(params.value, 49);
});

test('a PII-shaped or oversized value contributes nothing', async () => {
  for (const bad of [
    { utm_source: 'jane-at-gmail-com', utm_medium: 'partner', utm_campaign: 'launch' },
    { utm_source: 'a'.repeat(60), utm_medium: 'partner', utm_campaign: 'launch' },
    { utm_source: 'ord_sample_placeholder', utm_medium: 'partner', utm_campaign: 'launch' },
    { utm_source: 'x', utm_medium: 'partner' },
    null,
    undefined,
    'not an object',
  ]) {
    const params = await ga4ParamsFor(bad);
    assert.equal(params.campaign_source, undefined, `accepted: ${JSON.stringify(bad)}`);
  }
});

test('extra keys smuggled beside the governed four reject the WHOLE tuple', async () => {
  // Stronger than dropping them: an ungoverned key makes the tuple invalid, so
  // a caller cannot get a valid campaign AND a passenger field. Nothing leaks,
  // and nothing is attributed either.
  const params = await ga4ParamsFor({
    utm_source: 'brightwood_pta',
    utm_medium: 'partner',
    utm_campaign: 'autumn_pilot',
    childName: 'PrivateName',
    email: 'parent@example.com',
    orderId: 'order-placeholder-value',
  } as never);
  const serialized = JSON.stringify(params);
  for (const leak of ['PrivateName', 'parent@example.com', 'order-placeholder-value', 'childName', 'email', 'orderId']) {
    assert.equal(serialized.includes(leak), false, `${leak} reached GA4`);
  }
  assert.equal(params.campaign_source, undefined, 'an ungoverned key must fail the tuple closed');
  // The purchase itself is unaffected by the rejected campaign.
  assert.equal(params.transaction_id, 'cs_test_1');
  assert.equal(params.value, 49);
});

/* ── 5. The webhook side is signed and idempotent ───────────────────────── */

test('the campaign is recovered from the signed session, not from a request body', () => {
  const helper = webhookSource.slice(
    webhookSource.indexOf('function campaignFromSession'),
    webhookSource.indexOf('function getStripe'),
  );
  assert.match(helper, /session as \{ metadata\?: Record<string, string> \}/);
  assert.match(helper, /validateUtmTuple\(/);
  assert.doesNotMatch(helper, /req\.|request\.|searchParams/);
});

test('signature verification and the purchase call count are untouched', () => {
  assert.match(webhookSource, /stripe-signature/i);
  assert.equal((webhookSource.match(/scheduleGa4Purchase\(\{/g) ?? []).length, 3);
  assert.equal((webhookSource.match(/campaign: campaignFromSession\(session\),/g) ?? []).length, 3);
});
