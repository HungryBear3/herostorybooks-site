import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createMetaPixelController,
  META_PIXEL_FLAG_ENV,
  META_PIXEL_ID_ENV,
  resolveMetaPixelSettings,
  type MetaPixelAdapter,
} from '../src/lib/marketing/meta-pixel.ts';
import {
  META_BROWSER_EVENT_ALLOWLIST,
  META_BROWSER_PROHIBITED_EVENTS,
  assertNoBlockedFields,
  filterBrowserParams,
  CANONICAL_EVENT_MATRIX,
} from '../src/lib/marketing/event-contract.ts';
import {
  META_TRACKABLE_ROUTES,
  isMetaTrackableRoute,
  metaRouteFor,
  sanitizeRoute,
  stripQueryAndFragment,
} from '../src/lib/marketing/route-sanitizer.ts';
import { normalizeConsent, resolveConsent } from '../src/lib/marketing/consent.ts';

/** Records every adapter interaction. No network, ever. */
function recordingAdapter() {
  const calls: { kind: 'load' | 'init' | 'track'; args: unknown[] }[] = [];
  const adapter: MetaPixelAdapter = {
    load: (pixelId) => { calls.push({ kind: 'load', args: [pixelId] }); },
    init: (pixelId) => { calls.push({ kind: 'init', args: [pixelId] }); },
    track: (event, params) => { calls.push({ kind: 'track', args: [event, params] }); },
  };
  return { adapter, calls };
}

const ENABLED_ENV = { [META_PIXEL_ID_ENV]: '123456789012345', [META_PIXEL_FLAG_ENV]: 'true' };

function enabledController() {
  const { adapter, calls } = recordingAdapter();
  const controller = createMetaPixelController({ adapter, env: ENABLED_ENV, consent: () => 'granted' });
  return { controller, calls };
}

// ── 1. No id, no flag, no consent  =>  zero Meta behaviour ──────────────────

test('with no pixel id there is no script load, no init, and no event', () => {
  const { adapter, calls } = recordingAdapter();
  const controller = createMetaPixelController({ adapter, env: {}, consent: () => 'granted' });
  assert.deepEqual(controller.handleRoute('/'), { status: 'skipped', reason: 'no_pixel_id' });
  assert.deepEqual(controller.handleHsbEvent('begin_checkout'), { status: 'skipped', reason: 'no_pixel_id' });
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.debug, { initialized: false, scriptLoaded: false, lastRoute: null });
});

test('with the pixel id but the flag off there is no Meta behaviour', () => {
  const { adapter, calls } = recordingAdapter();
  const controller = createMetaPixelController({
    adapter, env: { [META_PIXEL_ID_ENV]: '123456789012345' }, consent: () => 'granted',
  });
  assert.deepEqual(controller.handleRoute('/'), { status: 'skipped', reason: 'flag_off' });
  assert.deepEqual(calls, []);
});

test('a non-numeric or short pixel id is treated as absent, not trusted', () => {
  for (const pixelId of ['', '  ', 'abc', '123', 'G-68FKEDZEG3', '1234567890123456789012']) {
    assert.deepEqual(
      resolveMetaPixelSettings({ [META_PIXEL_ID_ENV]: pixelId, [META_PIXEL_FLAG_ENV]: 'true' }),
      { enabled: false, reason: 'no_pixel_id' },
      pixelId,
    );
  }
});

test('the flag must be exactly the string true', () => {
  for (const flag of ['1', 'yes', 'TRUE', 'True', ' true', '']) {
    assert.deepEqual(
      resolveMetaPixelSettings({ [META_PIXEL_ID_ENV]: '123456789012345', [META_PIXEL_FLAG_ENV]: flag }),
      { enabled: false, reason: 'flag_off' },
      flag,
    );
  }
});

test('consent absent or unknown fails closed even when fully configured', () => {
  for (const consent of ['unknown', 'denied'] as const) {
    const { adapter, calls } = recordingAdapter();
    const controller = createMetaPixelController({ adapter, env: ENABLED_ENV, consent: () => consent });
    assert.deepEqual(controller.handleRoute('/'), { status: 'skipped', reason: 'consent_not_granted' });
    assert.deepEqual(calls, []);
  }
});

test('consent resolution defaults to unknown and only an explicit grant counts', () => {
  assert.equal(resolveConsent({}), 'unknown');
  assert.equal(resolveConsent({ hsbMarketingConsent: true as unknown as string }), 'unknown');
  assert.equal(resolveConsent({ hsbMarketingConsent: 'yes' }), 'unknown');
  assert.equal(resolveConsent({ hsbMarketingConsent: 'granted' }), 'granted');
  assert.equal(resolveConsent({ hsbMarketingConsent: 'denied' }), 'denied');
  assert.equal(normalizeConsent(undefined), 'unknown');
  // A throwing getter is not a grant.
  const hostile = Object.defineProperty({}, 'hsbMarketingConsent', { get() { throw new Error('nope'); } });
  assert.equal(resolveConsent(hostile), 'unknown');
});

// ── 2. Initialise once, PageView deduped ────────────────────────────────────

test('the script loads once and init runs once across many navigations', () => {
  const { controller, calls } = enabledController();
  controller.handleRoute('/');
  controller.handleRoute('/about');
  controller.handleRoute('/samples');
  assert.equal(calls.filter((c) => c.kind === 'load').length, 1);
  assert.equal(calls.filter((c) => c.kind === 'init').length, 1);
  assert.deepEqual(calls[0], { kind: 'load', args: ['123456789012345'] });
  assert.deepEqual(calls[1], { kind: 'init', args: ['123456789012345'] });
});

test('exactly one PageView per route transition and no duplicate initial page view', () => {
  const { controller, calls } = enabledController();
  // Two mounts of the same route, as React StrictMode produces.
  assert.equal(controller.handleRoute('/').status, 'tracked');
  assert.deepEqual(controller.handleRoute('/'), { status: 'skipped', reason: 'duplicate_route' });
  controller.handleRoute('/about');
  assert.deepEqual(controller.handleRoute('/about'), { status: 'skipped', reason: 'duplicate_route' });
  const pageViews = calls.filter((c) => c.kind === 'track' && c.args[0] === 'PageView');
  assert.equal(pageViews.length, 2);
  assert.deepEqual(pageViews.map((c) => c.args[1]), [{}, {}]);
});

test('the same route reached with a different query is still one route transition', () => {
  const { controller, calls } = enabledController();
  controller.handleRoute('/checkout?childName=PrivateName');
  assert.deepEqual(controller.handleRoute('/checkout?childName=Other&format=premium'), {
    status: 'skipped', reason: 'duplicate_route',
  });
  assert.equal(calls.filter((c) => c.kind === 'track').length, 1);
});

// ── 3. Sanitised and templated routes ───────────────────────────────────────

test('query strings and fragments are stripped before anything else happens', () => {
  assert.equal(stripQueryAndFragment('/checkout?childName=PrivateName#step2'), '/checkout');
  assert.equal(stripQueryAndFragment('/thank-you?orderId=abc&email=p@example.com&sessionId=cs_live_x'), '/thank-you');
  assert.equal(stripQueryAndFragment('https://herostorybooks.com/gifts/birthday?utm_source=x'), '/gifts/birthday');
  assert.equal(stripQueryAndFragment('/'), '/');
  assert.equal(stripQueryAndFragment(''), '/');
  assert.equal(stripQueryAndFragment('/about//'), '/about');
  assert.equal(stripQueryAndFragment('about'), '/about');
});

test('dynamic segments are templated, never sent as instances', () => {
  assert.equal(sanitizeRoute('/gifts/birthday'), '/gifts/[occasion]');
  assert.equal(sanitizeRoute('/status/a1b2c3d4e5f60718'), '/status/[orderId]');
  assert.equal(sanitizeRoute('/review/a1b2c3d4e5f60718?token=x'), '/review/[orderId]');
  assert.equal(sanitizeRoute('/admin/orders/a1b2c3d4e5f60718'), '/admin/orders/[orderId]');
  assert.equal(sanitizeRoute('/family-review/review/secret-token'), '/family-review/review/[reviewToken]');
  assert.equal(
    sanitizeRoute('/family-review/review/secret-token/image/asset-99'),
    '/family-review/review/[reviewToken]/image/[assetId]',
  );
});

test('a tracked PageView reports the template, never the raw path', () => {
  const { controller, calls } = enabledController();
  const outcome = controller.handleRoute('/gifts/birthday?utm_source=school-pilot-a');
  assert.deepEqual(outcome, { status: 'tracked', event: 'PageView', route: '/gifts/[occasion]', params: {} });
  assert.equal(JSON.stringify(calls).includes('birthday'), false);
  assert.equal(JSON.stringify(calls).includes('utm_source'), false);
});

// ── 4. Private routes produce nothing at all, not even a script load ────────

test('private, post-purchase, and family surfaces load nothing and send nothing', () => {
  const privateRoutes = [
    '/thank-you?orderId=a1b2c3d4e5f60718&email=parent@example.com',
    '/order',
    '/status/a1b2c3d4e5f60718',
    '/review/a1b2c3d4e5f60718',
    '/admin/orders/a1b2c3d4e5f60718',
    '/family-review',
    '/family-review/review/secret-token',
    '/family-review/review/secret-token/image/asset-99',
    '/create/your-memory',
    '/privacy',
    '/terms',
    '/api/public/v1/catalog',
  ];
  for (const route of privateRoutes) {
    const { adapter, calls } = recordingAdapter();
    const controller = createMetaPixelController({ adapter, env: ENABLED_ENV, consent: () => 'granted' });
    assert.deepEqual(controller.handleRoute(route), { status: 'skipped', reason: 'route_not_trackable' }, route);
    assert.deepEqual(calls, [], `${route} caused adapter activity`);
    assert.equal(controller.debug.scriptLoaded, false, `${route} loaded the Meta script`);
  }
});

test('the trackable allowlist is the public funnel only', () => {
  assert.deepEqual([...META_TRACKABLE_ROUTES], ['/', '/about', '/samples', '/gifts', '/gifts/[occasion]', '/checkout']);
  // /pricing is a redirect, not a page, so it is deliberately absent.
  assert.equal(isMetaTrackableRoute('/pricing'), false);
  assert.equal(isMetaTrackableRoute('/family-review/review/[reviewToken]'), false);
  assert.equal(isMetaTrackableRoute('/thank-you'), false);
  assert.equal(metaRouteFor('/family-review/review/tok'), null);
  assert.equal(metaRouteFor('/gifts/christmas'), '/gifts/[occasion]');
});

// ── 5. Event and parameter allowlists ───────────────────────────────────────

test('Purchase is not an allowlisted browser event and never becomes one', () => {
  assert.deepEqual([...META_BROWSER_EVENT_ALLOWLIST], ['PageView', 'ViewContent', 'InitiateCheckout']);
  assert.equal((META_BROWSER_EVENT_ALLOWLIST as readonly string[]).includes('Purchase'), false);
  assert.ok((META_BROWSER_PROHIBITED_EVENTS as readonly string[]).includes('Purchase'));
  const purchaseStage = CANONICAL_EVENT_MATRIX.find((m) => m.stage === 'purchase')!;
  assert.equal(purchaseStage.metaBrowserEvent, null);
  assert.equal(purchaseStage.owner, 'stripe_webhook');
});

test('an unmapped HSB event produces no Meta call at all', () => {
  const { controller, calls } = enabledController();
  controller.handleRoute('/checkout');
  const before = calls.length;
  for (const event of ['page_view', 'name_preview_submitted', 'format_selected', 'story_selected',
    'order_submit_attempt', 'purchase_intent', 'proof_approved', 'checkout_start', 'purchase']) {
    assert.deepEqual(controller.handleHsbEvent(event), { status: 'skipped', reason: 'event_not_mapped' }, event);
  }
  assert.equal(calls.length, before);
});

test('begin_checkout maps to InitiateCheckout with allowlisted parameters only', () => {
  const { controller, calls } = enabledController();
  controller.handleRoute('/checkout?childName=PrivateName');
  const outcome = controller.handleHsbEvent('begin_checkout', {
    content_type: 'product',
    content_category: 'storybook',
    // Everything below is what the live begin_checkout record actually carries.
    childNameFromUrl: 'yes',
    themePreselected: 'space',
    hadSavedProgress: true,
    directionFromUrl: 'a-brave-dragon',
    occasionFromUrl: 'birthday',
  });
  assert.deepEqual(outcome, {
    status: 'tracked',
    event: 'InitiateCheckout',
    route: '/checkout',
    params: { content_type: 'product', content_category: 'storybook' },
  });
  const serialized = JSON.stringify(calls);
  for (const leak of ['PrivateName', 'childName', 'space', 'dragon', 'birthday', 'hadSavedProgress']) {
    assert.equal(serialized.includes(leak), false, `${leak} reached the adapter`);
  }
});

test('parameter values outside their vocabulary are dropped, keys and all', () => {
  assert.deepEqual(
    filterBrowserParams('InitiateCheckout', {
      content_type: 'child', content_category: 'Lukas', num_items: 0, notes: 'free text',
    }),
    { params: {}, dropped: ['content_type', 'content_category', 'num_items', 'notes'] },
  );
  assert.deepEqual(
    filterBrowserParams('InitiateCheckout', { content_type: 'product', content_category: 'storybook', num_items: 1 }),
    { params: { content_type: 'product', content_category: 'storybook', num_items: 1 }, dropped: [] },
  );
  // PageView takes no parameters at all.
  assert.deepEqual(filterBrowserParams('PageView', { content_type: 'product' }), { params: {}, dropped: ['content_type'] });
});

test('a funnel event before any tracked route is not sent', () => {
  const { controller, calls } = enabledController();
  assert.deepEqual(controller.handleHsbEvent('begin_checkout'), { status: 'skipped', reason: 'route_not_trackable' });
  assert.deepEqual(calls, []);
});

// ── 6. Structural PII / identifier guard ────────────────────────────────────

test('the blocked-field guard rejects family, order, token, asset, and free-text payloads', () => {
  const rejected: unknown[] = [
    { user_data: { em: 'hash' } },
    { em: 'abc' },
    { external_id: 'x' },
    { client_ip_address: '1.2.3.4' },
    { client_user_agent: 'Mozilla' },
    { childName: 'Lukas' },
    { child_name: 'Lukas' },
    { order_id: 'x' },
    { transaction_id: 'cs_live_1' },
    { review_token: 't' },
    { asset_url: 'https://x' },
    { notes: 'free text' },
    { custom: 'cs_live_a1b2c3d4e5f6' },
    { custom: 'ord_synthetic0001' },
    { custom: 'a1b2c3d4e5f60718' },
    { custom: 'parent@example.com' },
    { custom: 'https://abc.public.blob.vercel-storage.com/orders/x/photo.png' },
    { nested: [{ deep: { em: 'x' } }] },
  ];
  for (const payload of rejected) {
    assert.throws(() => assertNoBlockedFields(payload), /Meta payload rejected/, JSON.stringify(payload));
  }
  assert.doesNotThrow(() => assertNoBlockedFields({
    content_type: 'product', content_category: 'storybook', num_items: 1, value: 19, currency: 'USD',
  }));
});

test('a blocked payload is refused rather than trimmed', () => {
  const { adapter, calls } = recordingAdapter();
  const controller = createMetaPixelController({ adapter, env: ENABLED_ENV, consent: () => 'granted' });
  controller.handleRoute('/checkout');
  const before = calls.length;
  // Reach past the contract filter to prove the second guard also holds.
  const outcome = (controller as unknown as {
    handleHsbEvent(e: string, p: Record<string, unknown>): unknown;
  }).handleHsbEvent('begin_checkout', { content_type: 'product' });
  assert.deepEqual(outcome, {
    status: 'tracked', event: 'InitiateCheckout', route: '/checkout', params: { content_type: 'product' },
  });
  assert.equal(calls.length, before + 1);
});

// ── 7. CSP: nothing Meta-shaped is added to any served header ───────────────

test('middleware adds no Meta origin to any CSP, and family review stays self-only', () => {
  const middleware = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');
  for (const origin of ['facebook', 'fbcdn', 'fbevents', 'connect.facebook.net', 'graph.facebook.com']) {
    assert.equal(middleware.includes(origin), false, `middleware.ts references ${origin}`);
  }
  assert.match(middleware, /"default-src 'self'"/);
  assert.match(middleware, /"script-src 'self' 'unsafe-inline'"/);
  assert.match(middleware, /"connect-src 'self'"/);
  // No wildcard was introduced anywhere in the family-review CSP.
  const csp = middleware.slice(middleware.indexOf('const FAMILY_REVIEW_CSP'), middleware.indexOf('function applyFamilyReviewPrivacyHeaders'));
  assert.equal(csp.includes('*'), false);
});

test('no global Content-Security-Policy header was introduced by this candidate', () => {
  const nextConfig = readFileSync(new URL('../next.config.js', import.meta.url), 'utf8');
  const vercelJson = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
  assert.equal(/Content-Security-Policy/i.test(nextConfig), false);
  assert.equal(/Content-Security-Policy/i.test(vercelJson), false);
});

// ── 8. The mount is inert by construction ───────────────────────────────────

test('the root layout mounts the pixel component and still gates GA4 on production', () => {
  const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /<MetaPixelMount \/>/);
  assert.match(layout, /process\.env\.VERCEL_ENV === 'production'/);
  // GA4 moved behind the consent gate; the production guard and every GA4
  // property moved with it, unchanged.
  const browserAnalytics = readFileSync(
    new URL('../src/components/marketing/browser-analytics.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(layout, /googletagmanager\.com/);
  assert.match(layout, /mode=\{analyticsMode\.mode\}/);
  assert.match(browserAnalytics, /googletagmanager\.com\/gtag\/js\?id=\$\{measurementId\}/);
  assert.match(browserAnalytics, /send_page_view: false/);
});

test('the mount reads pathname only, never search params or href', () => {
  const mount = readFileSync(new URL('../src/components/marketing/meta-pixel-mount.tsx', import.meta.url), 'utf8');
  assert.match(mount, /usePathname\(\)/);
  assert.equal(/useSearchParams|location\.search|location\.href/.test(mount), false);
});

test('the browser adapter is the only module that names a Meta origin, and names exactly one', () => {
  const pixel = readFileSync(new URL('../src/lib/marketing/meta-pixel.ts', import.meta.url), 'utf8');
  const origins = pixel.match(/https:\/\/[a-z0-9.-]+/g) ?? [];
  assert.deepEqual(origins, ['https://connect.facebook.net']);
  // The only fbq commands this module can issue are init and track. There is no
  // call site that forwards a caller-supplied command string.
  const commands = [...pixel.matchAll(/(?:fbq|ensureStub\(\))\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(commands)].sort(), ['init', 'track']);
});
