/**
 * Consent lifecycle: nothing before a grant, exactly one PageView on a grant,
 * exactly one per navigation, nothing after withdrawal, and no backlog on a
 * re-grant.
 *
 * The Meta controller is driven directly with an INJECTED adapter and an
 * INJECTED consent reader, so these assertions are behavioural and make no
 * network request of any kind. GA4 and Vercel are proven at their mount
 * boundary, which is a React component and therefore checked structurally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createMetaPixelController,
  META_PIXEL_FLAG_ENV,
  META_PIXEL_ID_ENV,
  type MetaPixelAdapter,
} from '../src/lib/marketing/meta-pixel.ts';
import { sanitizeRoute, stripQueryAndFragment } from '../src/lib/marketing/route-sanitizer.ts';
import type { ConsentState } from '../src/lib/marketing/consent.ts';

const pageViewSource = readFileSync(
  new URL('../src/components/analytics-page-view.tsx', import.meta.url),
  'utf8',
);
const browserAnalyticsSource = readFileSync(
  new URL('../src/components/marketing/browser-analytics.tsx', import.meta.url),
  'utf8',
);
const metaMountSource = readFileSync(
  new URL('../src/components/marketing/meta-pixel-mount.tsx', import.meta.url),
  'utf8',
);
const analyticsSource = readFileSync(
  new URL('../src/lib/analytics.ts', import.meta.url),
  'utf8',
);

const ENABLED_ENV = {
  [META_PIXEL_ID_ENV]: '1234567890',
  [META_PIXEL_FLAG_ENV]: 'true',
};

function recordingAdapter() {
  const loads: string[] = [];
  const inits: string[] = [];
  const events: { event: string; params: Record<string, unknown> }[] = [];
  const adapter: MetaPixelAdapter = {
    load: (id) => void loads.push(id),
    init: (id) => void inits.push(id),
    track: (event, params) => void events.push({ event, params }),
  };
  return { adapter, loads, inits, events };
}

function controllerWith(consentRef: { state: ConsentState }) {
  const rec = recordingAdapter();
  const controller = createMetaPixelController({
    adapter: rec.adapter,
    env: ENABLED_ENV,
    consent: () => consentRef.state,
  });
  return { controller, ...rec };
}

/* ── 1. Nothing at all before a grant ───────────────────────────────────── */

test('unknown consent: no load, no init, no event, even on a trackable route', () => {
  const consent = { state: 'unknown' as ConsentState };
  const { controller, loads, inits, events } = controllerWith(consent);

  const outcome = controller.handleRoute('/');
  assert.deepEqual(outcome, { status: 'skipped', reason: 'consent_not_granted' });
  assert.deepEqual(loads, [], 'a script was loaded without consent');
  assert.deepEqual(inits, [], 'the pixel was initialised without consent');
  assert.deepEqual(events, [], 'an event was emitted without consent');
  assert.equal(controller.debug.scriptLoaded, false);
  assert.equal(controller.debug.initialized, false);
});

test('declined consent: identical silence', () => {
  const consent = { state: 'denied' as ConsentState };
  const { controller, loads, inits, events } = controllerWith(consent);
  controller.handleRoute('/');
  controller.handleHsbEvent('begin_checkout');
  assert.deepEqual([loads, inits, events], [[], [], []]);
});

test('the route is NOT latched before consent, so a grant is not swallowed', () => {
  const consent = { state: 'unknown' as ConsentState };
  const { controller, events } = controllerWith(consent);

  // Visitor lands, is offered the banner, and the mount offers the route.
  controller.handleRoute('/');
  assert.equal(controller.debug.lastRoute, null, 'an unconsented route was consumed');

  // Grant, same tab, same page.
  consent.state = 'granted';
  const outcome = controller.handleRoute('/');
  assert.equal(outcome.status, 'tracked');
  assert.deepEqual(events.map((e) => e.event), ['PageView']);
});

/* ── 2. Exactly one PageView on grant, and per navigation ───────────────── */

test('a same-session grant emits exactly one current-route PageView', () => {
  const consent = { state: 'unknown' as ConsentState };
  const { controller, loads, inits, events } = controllerWith(consent);

  controller.handleRoute('/');
  controller.handleRoute('/'); // re-render before consent
  consent.state = 'granted';
  controller.handleRoute('/');
  controller.handleRoute('/'); // React StrictMode double effect after consent

  assert.equal(loads.length, 1, 'the script must load exactly once');
  assert.equal(inits.length, 1, 'the pixel must initialise exactly once');
  assert.deepEqual(events.map((e) => e.event), ['PageView']);
});

test('each later navigation emits exactly one PageView, with no re-initialisation', () => {
  const consent = { state: 'granted' as ConsentState };
  const { controller, loads, inits, events } = controllerWith(consent);

  controller.handleRoute('/');
  controller.handleRoute('/samples');
  controller.handleRoute('/samples'); // duplicate report of the same route
  controller.handleRoute('/checkout');

  assert.equal(loads.length, 1);
  assert.equal(inits.length, 1);
  assert.equal(events.length, 3, 'one PageView per route TRANSITION');
  assert.deepEqual(events.map((e) => e.event), ['PageView', 'PageView', 'PageView']);
});

/* ── 3. Withdrawal, and re-grant without a backlog ──────────────────────── */

test('withdrawal stops everything further', () => {
  const consent = { state: 'granted' as ConsentState };
  const { controller, events } = controllerWith(consent);
  controller.handleRoute('/');
  assert.equal(events.length, 1);

  consent.state = 'unknown'; // withdrawn
  // A route that IS on the trackable allowlist, so only consent can stop it.
  controller.handleRoute('/samples');
  controller.handleHsbEvent('begin_checkout');
  assert.equal(events.length, 1, 'events continued after withdrawal');
});

test('a later re-grant emits ONE current-route PageView, not a backlog', () => {
  const consent = { state: 'granted' as ConsentState };
  const { controller, loads, inits, events } = controllerWith(consent);

  controller.handleRoute('/'); // 1 PageView
  consent.state = 'denied';
  // Visitor browses several pages while declined. None of these is queued.
  controller.handleRoute('/samples');
  controller.handleRoute('/about');
  controller.handleRoute('/gifts');
  assert.equal(events.length, 1, 'routes visited while declined were queued');

  consent.state = 'granted';
  controller.handleRoute('/checkout'); // the CURRENT route only

  assert.equal(events.length, 2);
  assert.equal(loads.length, 1, 're-grant must not reload the script');
  assert.equal(inits.length, 1, 're-grant must not re-initialise');
  assert.equal(events[1].event, 'PageView');
  assert.equal((events[1].params as Record<string, unknown>).__route ?? undefined, undefined);
});

/* ── 4. Routes are templated and stripped ───────────────────────────────── */

test('query strings and fragments never survive into a route', () => {
  assert.equal(stripQueryAndFragment('/checkout?childName=PrivateName'), '/checkout');
  assert.equal(stripQueryAndFragment('/thank-you?email=a@b.c#top'), '/thank-you');
  assert.equal(sanitizeRoute('/checkout?childName=PrivateName&utm_source=x'), '/checkout');
});

test('dynamic identifiers are templated, never reported as themselves', () => {
  assert.equal(sanitizeRoute('/status/a1b2c3d4e5f60718'), '/status/[orderId]');
  assert.equal(sanitizeRoute('/review/a1b2c3d4e5f60718'), '/review/[orderId]');
  assert.equal(sanitizeRoute('/admin/orders/a1b2c3d4e5f60718'), '/admin/orders/[orderId]');
  assert.equal(
    sanitizeRoute('/family-review/review/SOME-TOKEN'),
    '/family-review/review/[reviewToken]',
  );
  assert.equal(
    sanitizeRoute('/family-review/review/SOME-TOKEN/image/a-assetid'),
    '/family-review/review/[reviewToken]/image/[assetId]',
  );
});

test('the GA4 page view is sanitized before it is sent', () => {
  assert.match(analyticsSource, /pathname: sanitizeRoute\(pathname\)/);
});

test('a private route produces no Meta behaviour at all', () => {
  const consent = { state: 'granted' as ConsentState };
  const { controller, loads, inits, events } = controllerWith(consent);
  for (const route of [
    '/family-review',
    '/family-review/review/SOME-TOKEN',
    '/admin/orders/a1b2c3d4e5f60718',
    '/review/a1b2c3d4e5f60718',
  ]) {
    controller.handleRoute(route);
  }
  assert.deepEqual([loads, inits, events], [[], [], []], 'a private route reached Meta');
});

/* ── 5. Mount-level gating for GA4, Vercel, and the page-view emitter ───── */

test('the page-view emitter delegates delivery, and cancels on withdrawal', () => {
  // The latch now lives in the coordinator, which writes it only after a
  // truthful emission -- see tests/marketing-analytics-readiness.test.ts. The
  // component's own job is narrower: report the route, and cancel anything
  // pending the moment consent stops being granted.
  assert.match(pageViewSource, /if \(consent !== "granted"\) \{[\s\S]*?coordinator\.cancelPending\(\);/);
  assert.match(pageViewSource, /coordinator\.requestPageView\(pathname\)/);
  assert.match(pageViewSource, /\}, \[pathname, consent\]\);/);
  // No local latch may shadow the coordinator's.
  assert.doesNotMatch(pageViewSource, /lastEmittedRef/);
});

test('GA4 and Vercel Analytics mount only on a grant', () => {
  const gateIdx = browserAnalyticsSource.indexOf('if (consent !== "granted") return null;');
  assert.ok(gateIdx > 0);
  for (const destination of ['googletagmanager.com', '<SafeVercelAnalytics']) {
    assert.ok(
      browserAnalyticsSource.indexOf(destination) > gateIdx,
      `${destination} renders before the consent gate`,
    );
  }
  // And the environment guard is still first: with no property to measure
  // into, consent is irrelevant and nothing mounts.
  const envIdx = browserAnalyticsSource.indexOf('if (mode === "disabled" || !measurementId) return null;');
  assert.ok(envIdx > 0 && envIdx < gateIdx);
});

test('all three mounts subscribe to the one store', () => {
  for (const [name, src] of [
    ['browser-analytics', browserAnalyticsSource],
    ['analytics-page-view', pageViewSource],
    ['meta-pixel-mount', metaMountSource],
  ] as const) {
    assert.match(src, /subscribeConsent/, `${name} does not subscribe to consent`);
    assert.match(src, /consent-store/, `${name} uses a different consent source`);
  }
});

/* ── 6. The legacy ungoverned campaign path is gone ─────────────────────── */

test('no legacy campaign reader, writer, or field survives in analytics.ts', () => {
  for (const forbidden of [
    'campaignParamKeys',
    'campaignSessionKey',
    'parseStoredCampaign',
    'campaignParamsFromUrl',
    'hsb:first-touch-campaign',
    'sessionStorage.getItem',
    'sessionStorage.setItem',
    'campaign_term:',
  ]) {
    assert.equal(
      analyticsSource.includes(forbidden),
      false,
      `the legacy campaign path still references ${forbidden}`,
    );
  }
  // Campaign params now come from the governed record only.
  assert.match(analyticsSource, /return attributionMetadata\(currentAttribution\(\)\);/);
});

test('analytics.ts reads no query parameter of its own any more', () => {
  assert.doesNotMatch(analyticsSource, /new URLSearchParams/);
  assert.doesNotMatch(analyticsSource, /location\.search/);
  assert.doesNotMatch(analyticsSource, /location\.href/);
});
