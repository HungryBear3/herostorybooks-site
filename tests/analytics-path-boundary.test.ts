/**
 * The GA path boundary. Every pathname GA can see — the event `pathname`, the
 * event `page_location`, and the bootstrap `config` call — is an approved
 * public route, an identifier-route template, or the opaque `/(other)`
 * bucket. A raw browser path never crosses: not a 404 someone typed, a
 * child's name, a phone number, a street address, an order or provider id, a
 * query string or a fragment. Referrers cross as an origin only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { checkGa4BrowserEventCall, projectBrowserEventParams } from '../src/lib/analytics-event-contract.ts';
import { track, trackPageView } from '../src/lib/analytics.ts';
import { analyticsRouteBootstrapScript, analyticsRoutePath } from '../src/lib/attribution-contract.ts';
import { withBrowser } from './helpers/analytics-browser-fixture.ts';

const NOW = Date.parse('2026-09-28T15:00:00.000Z');
const ORIGIN = 'https://herostorybooks.com';
const NO_CAMPAIGN = { campaign_source: '', campaign_medium: '', campaign_name: '', campaign_content: '' };
const HOSTILE_REFERRER = 'https://mail.example/inbox/jane-doe/312-555-0100?email=jane@example.com#child=Jane';
const LEAK = /jane|doe|312|555|0100|main-st|springfield|62704|zqxsynth|cs_live|cs_test|a1b2c3d4|email|childname|%4a|inbox|birthday(?!s)/i;

// [label, browser path (may carry a query or fragment), the only route GA may see]
const HOSTILE_PATHS: Array<[string, string, string]> = [
  ['child name + phone', '/child-Jane-Doe-312-555-0100', '/(other)'],
  ['phone number', '/call/312-555-0100', '/(other)'],
  ['street address', '/ship/1600-W-Main-St-Apt-4B-Springfield-IL-62704', '/(other)'],
  ['order id', '/orders/ord_ZQXSYNTH7731', '/(other)'],
  ['admin order id', '/admin/orders/ord_ZQXSYNTH7731', '/(other)'],
  ['order-status id', '/status/ord_ZQXSYNTH7731', '/status/[orderId]'],
  ['provider id', '/checkout/cs_live_a1B2c3D4e5F6', '/(other)'],
  ['provider id under an approved prefix', '/gifts/cs_test_a1B2c3D4', '/(other)'],
  ['query string', '/?email=jane%40example.com&childName=Jane', '/'],
  ['fragment', '/gifts#jane-doe-312-555-0100', '/gifts'],
  ['near-miss route', '/gifts/birthday', '/(other)'],
  ['percent-encoded name', '/%4Aane-Doe', '/(other)'],
  ['protocol-relative shape', '//jane.example/312-555-0100', '/(other)'],
  ['approved route, trailing slash', '/pricing/', '/pricing'],
];

test('the reviewer reproducer: track() on an unknown child-name path sends only /(other)', async () => {
  await withBrowser({ href: `${ORIGIN}/child-Jane-Doe-312-555-0100`, now: NOW }, (f) => {
    track('begin_checkout');
    assert.deepEqual(f.gtag, [['event', 'begin_checkout', {
      timestamp: NOW,
      pathname: '/(other)',
      ...NO_CAMPAIGN,
      page_location: `${ORIGIN}/(other)`,
      page_referrer: '',
    }]]);
    assert.deepEqual(checkGa4BrowserEventCall(f.gtag[0]), []);
  });
});

test('the reviewer reproducer: trackPageView(callerPath) collapses a hostile caller path', async () => {
  await withBrowser({ href: `${ORIGIN}/`, now: NOW }, (f) => {
    trackPageView('/child-Jane-Doe-312-555-0100');
    assert.deepEqual(f.gtag, [['event', 'page_view', {
      timestamp: NOW,
      pathname: '/(other)',
      ...NO_CAMPAIGN,
      page_location: `${ORIGIN}/`,
      page_referrer: '',
    }]]);
    assert.deepEqual(checkGa4BrowserEventCall(f.gtag[0]), []);
  });
});

test('track() on a hostile page serializes only the approved route to GA, Vercel and the buffer', async () => {
  for (const [label, path, route] of HOSTILE_PATHS) {
    await withBrowser({ href: `${ORIGIN}${path}`, referrer: HOSTILE_REFERRER, now: NOW }, (f) => {
      track('begin_checkout', { bookFormat: 'digital' });
      assert.deepEqual(f.gtag, [['event', 'begin_checkout', {
        timestamp: NOW,
        pathname: route,
        bookFormat: 'digital',
        ...NO_CAMPAIGN,
        page_location: `${ORIGIN}${route}`,
        page_referrer: 'https://mail.example',
      }]], label);
      assert.deepEqual(f.vercel, [['event', { name: 'begin_checkout', data: { timestamp: NOW, pathname: route, bookFormat: 'digital' } }]], label);
      assert.deepEqual(f.win.hsbEvents, [{
        event: 'begin_checkout', timestamp: NOW, href: `${ORIGIN}${route}`, pathname: route, bookFormat: 'digital',
      }], label);
      assert.deepEqual(checkGa4BrowserEventCall(f.gtag[0]), [], label);
      assert.doesNotMatch(JSON.stringify({ gtag: f.gtag, vercel: f.vercel, events: f.win.hsbEvents }), LEAK, label);
    });
  }
});

test('trackPageView() collapses every hostile caller path the same way', async () => {
  for (const [label, path, route] of HOSTILE_PATHS) {
    await withBrowser({ href: `${ORIGIN}/`, now: NOW }, (f) => {
      trackPageView(path);
      const params = f.gtag[0]?.[2] as Record<string, unknown>;
      assert.equal(params.pathname, route, label);
      assert.equal(params.page_location, `${ORIGIN}/`, label);
      assert.equal(f.win.hsbEvents?.[0]?.pathname, route, label);
      assert.deepEqual(checkGa4BrowserEventCall(f.gtag[0]), [], label);
      assert.doesNotMatch(JSON.stringify({ gtag: f.gtag, events: f.win.hsbEvents }), LEAK, label);
    });
  }
});

test('the contract projection collapses a caller path and drops a non-path', () => {
  assert.deepEqual(projectBrowserEventParams('page_view', { pathname: '/child-Jane-Doe-312-555-0100' }), { pathname: '/(other)' });
  assert.deepEqual(projectBrowserEventParams('page_view', { pathname: '/status/ord_ZQXSYNTH7731?email=jane%40example.com' }),
    { pathname: '/status/[orderId]' });
  assert.deepEqual(projectBrowserEventParams('page_view', { pathname: '/gifts/holidays/' }), { pathname: '/gifts/holidays' });
  assert.deepEqual(projectBrowserEventParams('page_view', { pathname: 'https://evil.example/jane' }), {});
  assert.deepEqual(projectBrowserEventParams('page_view', { pathname: 42 }), {});
});

test('direct contract validation rejects every raw path and accepts only routes and /(other)', () => {
  const layer = { timestamp: NOW, ...NO_CAMPAIGN, page_referrer: '' };
  const call = (event: string, pathname: string, location: string) =>
    ['event', event, { ...layer, pathname, page_location: `${ORIGIN}${location}` }];
  const cases: Array<[string, unknown[], string[]]> = [
    ['page_view raw pathname', call('page_view', '/child-Jane-Doe-312-555-0100', '/(other)'), ['PARAM_VALUE_INVALID:pathname']],
    ['page_view phone pathname', call('page_view', '/call/312-555-0100', '/'), ['PARAM_VALUE_INVALID:pathname']],
    ['layer raw pathname', call('begin_checkout', '/ship/1600-W-Main-St', '/(other)'), ['LAYER_VALUE_INVALID:pathname']],
    ['layer order id', call('begin_checkout', '/orders/ord_ZQXSYNTH7731', '/(other)'), ['LAYER_VALUE_INVALID:pathname']],
    ['layer near-miss route', call('begin_checkout', '/gifts/birthday', '/(other)'), ['LAYER_VALUE_INVALID:pathname']],
    ['layer non-canonical slash', call('begin_checkout', '/pricing/', '/pricing'), ['LAYER_VALUE_INVALID:pathname']],
    ['raw page_location', call('begin_checkout', '/(other)', '/child-Jane-Doe'), ['PAGE_LOCATION_NOT_SANITIZED']],
    ['provider id page_location', call('begin_checkout', '/(other)', '/checkout/cs_live_a1B2c3D4e5F6'), ['PAGE_LOCATION_NOT_SANITIZED']],
    ['encoded page_location', call('begin_checkout', '/(other)', '/%4Aane-Doe'), ['PAGE_LOCATION_NOT_SANITIZED']],
    ['query page_location', call('begin_checkout', '/', '/?childName=Jane'), ['PAGE_LOCATION_NOT_SANITIZED']],
    ['hash page_location', call('begin_checkout', '/', '/#jane'), ['PAGE_LOCATION_NOT_SANITIZED']],
    ['other bucket', call('begin_checkout', '/(other)', '/(other)'), []],
    ['identifier template', call('page_view', '/status/[orderId]', '/status/[orderId]'), []],
    ['approved route', call('page_view', '/gifts/birthdays', '/gifts/birthdays'), []],
  ];
  for (const [label, candidate, expected] of cases) {
    const issues = checkGa4BrowserEventCall(candidate);
    assert.deepEqual(issues, expected, label);
    assert.doesNotMatch(JSON.stringify(issues), LEAK, label);
  }
});

// ── The inline gtag bootstrap (root layout) ─────────────────────────────────

function bootstrapConfig(href: string, referrer: string): Record<string, unknown> {
  const layoutSource = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
  const inline = layoutSource.match(/<Script id="google-analytics-gtag"[^>]*>\s*\{`([\s\S]*?)`\}\s*<\/Script>/);
  assert.ok(inline, 'expected the inline google-analytics-gtag bootstrap');
  const body = inline[1]
    .replaceAll('${googleAnalyticsMeasurementId}', 'G-TEST')
    .replaceAll('${analyticsRouteBootstrapScript()}', analyticsRouteBootstrapScript());
  assert.doesNotMatch(body, /\$\{/, 'unresolved interpolation in the extracted bootstrap');
  const sandbox: Record<string, unknown> = { document: { referrer }, URL, Date, location: new URL(href) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);
  const config = Array.from(sandbox.dataLayer as IArguments[]).map((args) => Array.from(args)).find((args) => args[0] === 'config');
  assert.ok(config, 'expected a gtag config call');
  return config[2] as Record<string, unknown>;
}

test('the bootstrap config publishes only the approved route and a referrer origin', () => {
  for (const [label, path, route] of HOSTILE_PATHS) {
    const params = bootstrapConfig(`${ORIGIN}${path}`, HOSTILE_REFERRER);
    assert.equal(params.page_location, `${ORIGIN}${route}`, label);
    assert.equal(params.page_referrer, 'https://mail.example', label);
    assert.equal(params.send_page_view, false, label);
    assert.doesNotMatch(JSON.stringify(params), LEAK, label);
  }
  const fromStripe = bootstrapConfig(`${ORIGIN}/thank-you?session_id=cs_live_a1B2c3D4e5F6`, 'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5F6');
  assert.deepEqual([fromStripe.page_location, fromStripe.page_referrer, fromStripe.ignore_referrer], [`${ORIGIN}/thank-you`, '', true]);
});

test('the inline route function is the module boundary, value for value', () => {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(analyticsRouteBootstrapScript(), sandbox);
  const inline = sandbox.hsbSafeRoute as (path: unknown) => string;
  const inputs: unknown[] = [
    ...HOSTILE_PATHS.map(([, path]) => path),
    '/', '/about', '/gifts/child-as-hero', '/create/your-memory', '/family-review/review/frv_x/image/asset_1',
    '/status', '/status/', '/(other)', '/admin/orders', '', 'relative/path', `/${'a'.repeat(600)}`, '/?', '/#',
    undefined, null, 42, ['/'],
  ];
  for (const input of inputs) {
    assert.equal(inline(input), analyticsRoutePath(input), JSON.stringify(input));
  }
  assert.equal(analyticsRoutePath('/child-Jane-Doe-312-555-0100'), '/(other)');
  assert.equal(analyticsRoutePath('/family-review/review/frv_x'), '/family-review/review/[reviewToken]');
});
