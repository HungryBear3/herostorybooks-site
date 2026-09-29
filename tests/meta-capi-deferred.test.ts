/**
 * Meta Conversions API is DEFERRED, and that state is executable.
 *
 * CAPI needs user_data matching evidence. This architecture carries no
 * durable marketing consent and no consented fbp/fbc through signed checkout
 * metadata, and Advanced Matching is not approved — so the server purchase
 * resolves to a frozen no-send status with a null event, whatever the input
 * and whatever environment names are set. The Phase-A webhook winner stays
 * the only purchase dispatch, and no deferred Meta state may contradict the
 * event contract or what an experiment's primary outcome is measured from.
 */
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

import { META_EVENT_CONTRACT } from '../src/lib/analytics-event-contract.ts';
import { checkGa4PurchasePayload } from '../src/lib/analytics-event-contract.ts';
import { PRIMARY_OUTCOME_EVIDENCE } from '../src/lib/campaign-governance.ts';
import { getOrder } from '../src/lib/orders.ts';
import {
  META_SERVER_PURCHASE_STATUS,
  metaDeferredContractViolations,
  resolveMetaServerPurchase,
} from '../src/lib/meta-capi-status.ts';
import {
  CONFIRMATION_EMAIL_SETTLED,
  MP_ENDPOINT,
  NEWLY_PAID,
  completedEvent,
  runWebhook,
  seedPendingOrder,
  setupWebhookStore,
} from './helpers/stripe-webhook-harness.ts';

const DEFERRED = {
  status: 'DEFERRED',
  serverEvent: null,
  transport: null,
  reasons: [
    'NO_DURABLE_MARKETING_CONSENT',
    'NO_CONSENTED_FBP_FBC_IN_SIGNED_CHECKOUT_METADATA',
    'ADVANCED_MATCHING_NOT_APPROVED',
    'NO_POLICY_SAFE_USER_DATA',
  ],
};

/** Every name someone might reasonably expect to switch Meta on. */
const META_ENV: Record<string, string> = {
  META_PIXEL_ID: '123456789012345',
  META_DATASET_ID: '123456789012345',
  META_CAPI_ACCESS_TOKEN: 'EAAB-test-token',
  META_CONVERSIONS_API_TOKEN: 'EAAB-test-token',
  META_ACCESS_TOKEN: 'EAAB-test-token',
  FB_ACCESS_TOKEN: 'EAAB-test-token',
  FACEBOOK_ACCESS_TOKEN: 'EAAB-test-token',
  META_CAPI_ENABLED: 'true',
  HSB_META_CAPI_ENABLED: 'true',
  HSB_META_CAPI: 'on',
  META_TEST_EVENT_CODE: 'TEST123',
  NEXT_PUBLIC_META_PIXEL_ID: '123456789012345',
  NEXT_PUBLIC_META_PIXEL_ENABLED: 'true',
  NEXT_PUBLIC_HSB_META_PIXEL_ID: '123456789012345',
  NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'true',
  NEXT_PUBLIC_VERCEL_ENV: 'production',
};

test('the server purchase resolves to one frozen DEFERRED status for any input and any environment', () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; throw new Error('no network'); }) as typeof fetch;
  try {
    const settlements: unknown[] = [
      {
        transactionId: 'cs_live_a1B2c3D4e5F6', amountCents: 1900, currency: 'usd', paymentStatus: 'paid', itemId: 'book_digital',
        metadata: { fbp: 'fb.1.1727500000.123456789', fbc: 'fb.1.1727500000.IwAR0jane', em: 'jane@example.com', marketingConsent: 'granted' },
      },
      null,
      'jane@example.com',
    ];
    for (const settlement of settlements) {
      for (const env of [{}, META_ENV, { ...META_ENV, VERCEL_ENV: 'production' }]) {
        const result = resolveMetaServerPurchase(settlement, env);
        assert.deepEqual(result, DEFERRED);
        assert.equal(result, META_SERVER_PURCHASE_STATUS);
        assert.equal(Object.isFrozen(result), true);
        assert.equal(Object.isFrozen(result.reasons), true);
      }
    }
    assert.throws(() => { (META_SERVER_PURCHASE_STATUS as { status: string }).status = 'ACTIVE'; });
    assert.equal(resolveMetaServerPurchase().status, 'DEFERRED');
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('with every Meta env name set, concurrent and replayed webhooks dispatch one GA4 purchase and contact no Meta host', async () => {
  const restore = setupWebhookStore(META_ENV);
  const originalRead = fsPromises.readFile;
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  let winnerFinished!: () => void;
  const winnerDone = new Promise<void>((resolve) => { winnerFinished = resolve; });
  const timeout = setTimeout(() => { release(); winnerFinished(); }, 5000);
  try {
    const order = await seedPendingOrder('b1c2d3e4f5a6b7c8');
    // Hold both deliveries' advisory reads until each has seen the pending
    // order, so the durable transition itself must pick the single winner.
    fsPromises.readFile = (async (...args: Parameters<typeof originalRead>) => {
      const value = await originalRead(...args);
      if (String(args[0]).endsWith(`/${order.id}.json`) && reads < 2) {
        reads += 1;
        const position = reads;
        if (reads === 2) release();
        await bothRead;
        if (position === 2) await winnerDone;
      }
      return value;
    }) as typeof originalRead;
    syncBuiltinESMExports();

    const metadata = {
      orderId: order.id,
      gaClientId: '123456789.1727500000',
      fbp: 'fb.1.1727500000.123456789',
      fbc: 'fb.1.1727500000.IwAR0jane',
      marketingConsent: 'granted',
    };
    const event = completedEvent(order, metadata);
    const concurrent = await runWebhook(event, { deliveries: 2, settledBy: NEWLY_PAID, onResponse: winnerFinished });
    const replay = await runWebhook(event, { settledBy: [CONFIRMATION_EMAIL_SETTLED] });

    assert.equal(reads, 2, 'both deliveries must have read the pending order');
    assert.deepEqual([...concurrent.statuses, ...replay.statuses], [200, 200, 200]);
    const outbound = [...concurrent.outbound, ...replay.outbound];
    assert.equal(outbound.length, 1, outbound.map((call) => new URL(call.url).host).join(','));
    assert.ok(outbound[0].url.startsWith(`${MP_ENDPOINT}?`));
    assert.deepEqual(checkGa4PurchasePayload(outbound[0].body), []);
    assert.equal(outbound.some((call) => /facebook\.com|fbcdn|meta\.com/i.test(new URL(call.url).host)), false);
    assert.doesNotMatch(outbound[0].body, /fbp|fbc|IwAR|marketingConsent|jane/);
    assert.equal((await getOrder(order.id))?.paymentStatus, 'paid');
  } finally {
    clearTimeout(timeout);
    fsPromises.readFile = originalRead;
    syncBuiltinESMExports();
    restore();
  }
});

test('the deferred state agrees with the event contract and experiment readiness', () => {
  assert.deepEqual(metaDeferredContractViolations(), []);
  assert.equal(META_EVENT_CONTRACT.Purchase.state, META_SERVER_PURCHASE_STATUS.status);

  const purchaseActive = { ...META_EVENT_CONTRACT, Purchase: { ...META_EVENT_CONTRACT.Purchase, state: 'active' } };
  assert.deepEqual(metaDeferredContractViolations({ eventContract: purchaseActive }), ['META_PURCHASE_STATE_CONTRADICTS_SERVER_STATUS']);

  const browserPurchase = { ...META_EVENT_CONTRACT, Purchase: { ...META_EVENT_CONTRACT.Purchase, browser: 'allowed' } };
  assert.deepEqual(metaDeferredContractViolations({ eventContract: browserPurchase }), ['META_BROWSER_PURCHASE_ALLOWED']);

  const pixelPurchase = { ...META_EVENT_CONTRACT, Purchase: { ...META_EVENT_CONTRACT.Purchase, transport: 'browser_image_beacon' } };
  assert.deepEqual(metaDeferredContractViolations({ eventContract: pixelPurchase }), ['META_BROWSER_PURCHASE_ALLOWED']);

  const liveEvent = { ...META_SERVER_PURCHASE_STATUS, serverEvent: { event_name: 'Purchase' } };
  assert.deepEqual(metaDeferredContractViolations({ serverStatus: liveEvent }), ['META_DEFERRED_SERVER_EVENT_PRESENT']);

  const withTransport = { ...META_SERVER_PURCHASE_STATUS, transport: 'https://graph.facebook.com' };
  assert.deepEqual(metaDeferredContractViolations({ serverStatus: withTransport }), ['META_DEFERRED_SERVER_EVENT_PRESENT']);

  const noReasons = { ...META_SERVER_PURCHASE_STATUS, reasons: [] };
  assert.deepEqual(metaDeferredContractViolations({ serverStatus: noReasons }), ['META_DEFERRED_WITHOUT_REASONS']);

  const metaOutcome = { ...PRIMARY_OUTCOME_EVIDENCE, paid_order_rate: { events: 'meta.purchases', denominator: 'ga4.sessions' } };
  assert.deepEqual(metaDeferredContractViolations({ primaryOutcomeEvidence: metaOutcome }), ['EXPERIMENT_OUTCOME_DEPENDS_ON_DEFERRED_META']);
});

test('every primary outcome is measured from GA4 behavior, app outcomes or the payment ledger — never Meta', () => {
  assert.deepEqual(PRIMARY_OUTCOME_EVIDENCE, {
    qualified_action_rate: { events: 'app.qualified_actions', denominator: 'ga4.sessions' },
    checkout_start_rate: { events: 'ga4.checkout_starts', denominator: 'ga4.sessions' },
    paid_order_rate: { events: 'ledger.paid_orders', denominator: 'ga4.sessions' },
    paid_per_qualified_rate: { events: 'ledger.paid_orders', denominator: 'app.qualified_actions' },
    net_revenue_per_session: { events: 'ledger.paid_orders', denominator: 'ga4.sessions' },
  });
});
