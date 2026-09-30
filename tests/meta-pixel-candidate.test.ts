/**
 * The Meta browser pixel candidate: default-off, consent-gated,
 * production-only, canonical-host-only, route-allowlisted. It loads no
 * third-party script at all; an allowed event is one exactly-serialized image
 * beacon with a closed event name and a sanitized origin + route template —
 * never the raw URL, referrer, storage, Advanced Matching, or a Purchase.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ATTRIBUTION_STORAGE_KEY } from '../src/lib/attribution-contract.ts';
import {
  emitMetaPixelEvent,
  readMarketingConsent,
  readMetaPixelPublicConfig,
  resolveMetaPixelActivation,
} from '../src/lib/meta-pixel-candidate.ts';
import { withBrowser } from './helpers/analytics-browser-fixture.ts';

const NOW = Date.parse('2026-09-28T15:00:00.000Z');
const PIXEL = '123456789012345';
const ENV = {
  NEXT_PUBLIC_HSB_META_PIXEL_ID: PIXEL,
  NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'true',
  NEXT_PUBLIC_VERCEL_ENV: 'production',
};
const INIT = {
  method: 'GET',
  mode: 'no-cors',
  credentials: 'include',
  referrerPolicy: 'no-referrer',
  keepalive: true,
  cache: 'no-store',
};

function fetchSpy() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const impl = ((url: unknown, init: unknown) => {
    calls.push([String(url), JSON.parse(JSON.stringify(init))]);
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  return { calls, impl };
}

test('public configuration is explicit: an exact flag and a well-formed pixel id', () => {
  const cases: Array<[Record<string, string | undefined>, { pixelId: string | null; enabled: boolean }]> = [
    [{}, { pixelId: null, enabled: false }],
    [{ NEXT_PUBLIC_HSB_META_PIXEL_ID: PIXEL, NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'true' }, { pixelId: PIXEL, enabled: true }],
    [{ NEXT_PUBLIC_HSB_META_PIXEL_ID: PIXEL, NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'TRUE' }, { pixelId: PIXEL, enabled: false }],
    [{ NEXT_PUBLIC_HSB_META_PIXEL_ID: PIXEL, NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: '1' }, { pixelId: PIXEL, enabled: false }],
    [{ NEXT_PUBLIC_HSB_META_PIXEL_ID: 'abc', NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'true' }, { pixelId: null, enabled: true }],
    [{ NEXT_PUBLIC_HSB_META_PIXEL_ID: '12345', NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'true' }, { pixelId: null, enabled: true }],
    [{ NEXT_PUBLIC_HSB_META_PIXEL_ID: ` ${PIXEL}`, NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'true' }, { pixelId: null, enabled: true }],
    // Legacy or unprefixed names never configure the candidate.
    [{ NEXT_PUBLIC_META_PIXEL_ID: PIXEL, NEXT_PUBLIC_META_PIXEL_ENABLED: 'true', META_PIXEL_ID: PIXEL }, { pixelId: null, enabled: false }],
  ];
  for (const [env, expected] of cases) assert.deepEqual(readMetaPixelPublicConfig(env), expected, JSON.stringify(env));
});

test('each activation gate refuses on its own', () => {
  const config = { pixelId: PIXEL, enabled: true };
  const canonical = new URL('https://herostorybooks.com/');
  const base = { config, deploymentEnv: 'production', location: canonical, consent: 'granted' } as const;
  assert.deepEqual(resolveMetaPixelActivation(base), { active: true, pixelId: PIXEL });
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ config: { pixelId: PIXEL, enabled: false } }, 'disabled'],
    [{ config: { pixelId: null, enabled: true } }, 'not_configured'],
    [{ deploymentEnv: 'preview' }, 'not_production'],
    [{ deploymentEnv: 'development' }, 'not_production'],
    [{ deploymentEnv: undefined }, 'not_production'],
    [{ location: new URL('https://www.herostorybooks.com/') }, 'noncanonical_host'],
    [{ location: new URL('https://hero-story-books-git-main-hsb.vercel.app/') }, 'noncanonical_host'],
    [{ location: new URL('http://herostorybooks.com/') }, 'noncanonical_host'],
    [{ location: new URL('https://herostorybooks.com:8443/') }, 'noncanonical_host'],
    [{ location: new URL('https://herostorybooks.com.evil.example/') }, 'noncanonical_host'],
    [{ location: null }, 'no_browser'],
    [{ consent: 'denied' }, 'no_consent'],
    [{ consent: 'unknown' }, 'no_consent'],
    [{ consent: 'GRANTED' }, 'no_consent'],
    [{ consent: true }, 'no_consent'],
  ];
  for (const [change, reason] of cases) {
    assert.deepEqual(resolveMetaPixelActivation({ ...base, ...change } as never), { active: false, reason }, JSON.stringify(change));
  }
});

test('disabled, preview, noncanonical and no-consent browsers send nothing and load no script', async () => {
  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ['https://herostorybooks.com/', { env: {} }, 'disabled'],
    ['https://herostorybooks.com/', { env: { ...ENV, NEXT_PUBLIC_HSB_META_PIXEL_ENABLED: 'false' } }, 'disabled'],
    ['https://herostorybooks.com/', { env: { ...ENV, NEXT_PUBLIC_HSB_META_PIXEL_ID: undefined } }, 'not_configured'],
    ['https://herostorybooks.com/', { env: { ...ENV, NEXT_PUBLIC_VERCEL_ENV: 'preview' } }, 'not_production'],
    ['https://herostorybooks.com/', { env: { ...ENV, NEXT_PUBLIC_VERCEL_ENV: undefined } }, 'not_production'],
    ['https://hero-story-books-git-main-hsb.vercel.app/', {}, 'noncanonical_host'],
    ['https://www.herostorybooks.com/', {}, 'noncanonical_host'],
    ['https://herostorybooks.com/', { consent: 'denied' }, 'no_consent'],
    ['https://herostorybooks.com/', { consent: 'unknown' }, 'no_consent'],
  ];
  for (const [href, change, reason] of refusals) {
    await withBrowser({ href, now: NOW }, (f) => {
      const spy = fetchSpy();
      const result = emitMetaPixelEvent('PageView', { env: ENV, consent: 'granted', fetchImpl: spy.impl, ...change } as never);
      assert.deepEqual(result, { sent: false, reason }, `${href} ${JSON.stringify(change)}`);
      assert.deepEqual(spy.calls, []);
      assert.deepEqual(f.domWrites, []);
    });
  }
  const spy = fetchSpy();
  assert.deepEqual(emitMetaPixelEvent('PageView', { env: ENV, consent: 'granted', fetchImpl: spy.impl }), { sent: false, reason: 'no_browser' });
  assert.deepEqual(spy.calls, []);
});

test('consent cannot be claimed through storage, cookies or globals: there is no consent surface yet', async () => {
  await withBrowser({
    href: 'https://herostorybooks.com/',
    cookie: 'hsb_marketing_consent=granted; consent=granted; hsb:consent=granted',
    storage: { 'hsb:consent': 'granted', 'hsb:marketing-consent:v1': 'granted', consent: 'granted' },
    now: NOW,
  }, (f) => {
    f.win.__hsbMarketingConsent = 'granted';
    f.win.hsbConsent = { marketing: 'granted' };
    assert.equal(readMarketingConsent(), 'unknown');
    const spy = fetchSpy();
    assert.deepEqual(emitMetaPixelEvent('PageView', { env: ENV, fetchImpl: spy.impl }), { sent: false, reason: 'no_consent' });
    assert.deepEqual(spy.calls, []);
    assert.deepEqual(f.domWrites, []);
  });
});

test('an allowed event is one exactly-serialized beacon despite hostile URL, referrer, storage and props', async () => {
  await withBrowser({
    href: 'https://herostorybooks.com/gifts/holidays?email=jane%40example.com&fbclid=IwAR0jane&utm_source=facebook#frag',
    referrer: 'https://mail.example/jane-doe?e=jane@example.com',
    cookie: '_ga=GA1.1.123456789.1727500000; _fbp=fb.1.1727500000.123456789',
    storage: { [ATTRIBUTION_STORAGE_KEY]: '{"version":1,"firstTouch":{"source":"jane@example.com"}}' },
    now: NOW,
  }, (f) => {
    const spy = fetchSpy();
    const hostileProps = { em: 'jane@example.com', value: 19, currency: 'USD', content_name: 'Jane Doe' };
    const emit = emitMetaPixelEvent as (...args: unknown[]) => unknown;
    assert.deepEqual(emit('PageView', { env: ENV, consent: 'granted', fetchImpl: spy.impl, customData: hostileProps }, hostileProps), { sent: true });
    assert.deepEqual(spy.calls, [[
      'https://www.facebook.com/tr?id=123456789012345&ev=PageView&dl=https%3A%2F%2Fherostorybooks.com%2Fgifts%2Fholidays&noscript=1',
      INIT,
    ]]);
    assert.deepEqual(f.domWrites, [], 'no third-party script is ever loaded');
  });
});

test('InitiateCheckout is allowed only on the checkout route', async () => {
  await withBrowser({ href: 'https://herostorybooks.com/checkout?childName=Jane&email=jane%40example.com', now: NOW }, () => {
    const spy = fetchSpy();
    assert.deepEqual(emitMetaPixelEvent('InitiateCheckout', { env: ENV, consent: 'granted', fetchImpl: spy.impl }), { sent: true });
    assert.deepEqual(spy.calls, [[
      'https://www.facebook.com/tr?id=123456789012345&ev=InitiateCheckout&dl=https%3A%2F%2Fherostorybooks.com%2Fcheckout&noscript=1',
      INIT,
    ]]);
  });
  await withBrowser({ href: 'https://herostorybooks.com/', now: NOW }, () => {
    const spy = fetchSpy();
    assert.deepEqual(emitMetaPixelEvent('InitiateCheckout', { env: ENV, consent: 'granted', fetchImpl: spy.impl }), { sent: false, reason: 'route_not_allowed' });
    assert.deepEqual(spy.calls, []);
  });
});

test('private, identifier-bearing and unknown routes never carry a pixel', async () => {
  for (const href of [
    'https://herostorybooks.com/status/ord_ZQXSYNTH7731?email=jane%40example.com',
    'https://herostorybooks.com/review/ord_ZQXSYNTH7731',
    'https://herostorybooks.com/family-review/review/tok_abcdef',
    'https://herostorybooks.com/thank-you?session_id=cs_live_a1B2c3D4e5F6',
    'https://herostorybooks.com/admin/orders',
    'https://herostorybooks.com/jane-doe-312-555-0100',
  ]) {
    await withBrowser({ href, now: NOW }, () => {
      const spy = fetchSpy();
      assert.deepEqual(emitMetaPixelEvent('PageView', { env: ENV, consent: 'granted', fetchImpl: spy.impl }), { sent: false, reason: 'route_not_allowed' }, href);
      assert.deepEqual(spy.calls, []);
    });
  }
});

test('Purchase and every other event name are refused in the browser', async () => {
  await withBrowser({ href: 'https://herostorybooks.com/checkout', now: NOW }, () => {
    for (const event of ['Purchase', 'purchase', ' Purchase', 'AddPaymentInfo', 'Lead', 'CompleteRegistration', 'ViewContent', 'pageview', '', 'toString', '__proto__']) {
      const spy = fetchSpy();
      assert.deepEqual(emitMetaPixelEvent(event as never, { env: ENV, consent: 'granted', fetchImpl: spy.impl }), { sent: false, reason: 'event_not_allowed' }, event);
      assert.deepEqual(spy.calls, []);
    }
  });
});

test('a transport failure is contained', async () => {
  await withBrowser({ href: 'https://herostorybooks.com/', now: NOW }, async () => {
    const throwing = (() => { throw new Error('blocked by client'); }) as unknown as typeof fetch;
    assert.deepEqual(emitMetaPixelEvent('PageView', { env: ENV, consent: 'granted', fetchImpl: throwing }), { sent: false, reason: 'transport_failed' });
    const rejecting = (() => Promise.reject(new Error('network'))) as unknown as typeof fetch;
    assert.deepEqual(emitMetaPixelEvent('PageView', { env: ENV, consent: 'granted', fetchImpl: rejecting }), { sent: true });
    await new Promise((resolve) => setImmediate(resolve));
  });
});
