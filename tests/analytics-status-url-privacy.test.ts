// Order-status URLs are bearer-like: /status/ord_<id> identifies an order to
// anyone holding the link, and operators append ?email=<buyer> to it. None of
// that may reach Google Analytics, Vercel Analytics, or the window.hsbEvents
// buffer. These tests pin the sanitized shape for both the explicit-pathname
// path (AnalyticsPageView -> trackPageView) and the default page-location path
// (track() reading window.location), plus the referrer and the inline gtag
// bootstrap config in the root layout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Synthetic on purpose: REQ16 in review-snapshot-and-guards.test.ts bans the
// production `ord_<16 hex>` shape from anything committable.
const ORDER_ID = 'ord_testfixture000001';
const BUYER_EMAIL = 'parent%40example.com';
const STATUS_PATH = `/status/${ORDER_ID}`;
const STATUS_URL = `https://herostorybooks.com${STATUS_PATH}?email=${BUYER_EMAIL}#timeline`;

type GtagCall = unknown[];

type Harness = {
  calls: GtagCall[];
  window: {
    location: URL;
    gtag: (...args: unknown[]) => void;
    sessionStorage: { getItem: (k: string) => string | null; setItem: () => void };
    hsbEvents?: Array<Record<string, unknown>>;
  };
  document: { referrer: string };
};

async function withAnalytics(
  init: { href: string; referrer?: string },
  body: (harness: Harness, analytics: typeof import('../src/lib/analytics.ts')) => Promise<void> | void,
): Promise<void> {
  const calls: GtagCall[] = [];
  const harness: Harness = {
    calls,
    window: {
      location: new URL(init.href),
      gtag: (...args: unknown[]) => calls.push(args),
      sessionStorage: { getItem: () => null, setItem: () => undefined },
    },
    document: { referrer: init.referrer ?? '' },
  };
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: harness.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: harness.document });
  try {
    const analytics = await import('../src/lib/analytics.ts');
    await body(harness, analytics);
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
}

function eventParams(calls: GtagCall[], name: string): Record<string, unknown> {
  const call = calls.find((c) => c[0] === 'event' && c[1] === name);
  assert.ok(call, `expected a gtag event call named ${name}`);
  return call[2] as Record<string, unknown>;
}

function assertNoBearerMaterial(serialized: string, label: string) {
  assert.doesNotMatch(serialized, new RegExp(ORDER_ID), `${label} leaked the order id`);
  assert.doesNotMatch(serialized, /testfixture000001/, `${label} leaked the raw order id body`);
  assert.doesNotMatch(serialized, /email=/, `${label} leaked an email query parameter`);
  assert.doesNotMatch(serialized, /parent(%40|@)example/, `${label} leaked a buyer email`);
  assert.doesNotMatch(serialized, /#timeline/, `${label} leaked a URL fragment`);
}

test('explicit status pathname is collapsed to a route template before it reaches analytics', async () => {
  await withAnalytics({ href: STATUS_URL }, async ({ calls, window }, { trackPageView }) => {
    trackPageView(STATUS_PATH);

    const params = eventParams(calls, 'page_view');
    assert.equal(params.pathname, '/status/[orderId]');
    assert.equal(params.page_location, 'https://herostorybooks.com/status/[orderId]');

    const record = window.hsbEvents?.[0];
    assert.ok(record);
    assert.equal(record.event, 'page_view');
    assert.equal(record.pathname, '/status/[orderId]');
    assert.equal(record.href, 'https://herostorybooks.com/status/[orderId]');

    assertNoBearerMaterial(JSON.stringify(calls), 'gtag payload');
    assertNoBearerMaterial(JSON.stringify(window.hsbEvents), 'hsbEvents buffer');
  });
});

test('an explicit path carrying a query string and fragment is stripped, not forwarded', async () => {
  await withAnalytics(
    { href: 'https://herostorybooks.com/thank-you' },
    async ({ calls }, { trackPageView }) => {
      trackPageView(`${STATUS_PATH}?email=${BUYER_EMAIL}#timeline`);

      const params = eventParams(calls, 'page_view');
      assert.equal(params.pathname, '/status/[orderId]');
      assertNoBearerMaterial(JSON.stringify(calls), 'gtag payload');
    },
  );
});

test('the default page-location path is sanitized when no pathname is supplied', async () => {
  await withAnalytics({ href: STATUS_URL }, async ({ calls, window }, { track }) => {
    const record = track('proof_approved', { bookFormat: 'digital' });

    assert.ok(record);
    assert.equal(record.pathname, '/status/[orderId]');
    assert.equal(record.href, 'https://herostorybooks.com/status/[orderId]');

    const params = eventParams(calls, 'proof_approved');
    assert.equal(params.bookFormat, 'digital');
    assert.equal(params.pathname, '/status/[orderId]');
    assert.equal(params.page_location, 'https://herostorybooks.com/status/[orderId]');

    assertNoBearerMaterial(JSON.stringify(calls), 'gtag payload');
    assertNoBearerMaterial(JSON.stringify(window.hsbEvents), 'hsbEvents buffer');
  });
});

test('a status URL arriving as the referrer is collapsed to its route template', async () => {
  await withAnalytics(
    { href: 'https://herostorybooks.com/', referrer: STATUS_URL },
    async ({ calls }, { trackPageView }) => {
      trackPageView('/');

      const params = eventParams(calls, 'page_view');
      assert.equal(params.page_referrer, 'https://herostorybooks.com/status/[orderId]');
      assertNoBearerMaterial(JSON.stringify(calls), 'gtag payload');
    },
  );
});

test('proof-review URLs lose both the order id and the approval token', async () => {
  const reviewUrl = `https://herostorybooks.com/review/${ORDER_ID}?token=rvw_secret_bearer`;
  await withAnalytics({ href: reviewUrl }, async ({ calls, window }, { trackPageView }) => {
    trackPageView(`/review/${ORDER_ID}`);

    const params = eventParams(calls, 'page_view');
    assert.equal(params.pathname, '/review/[orderId]');
    assert.equal(params.page_location, 'https://herostorybooks.com/review/[orderId]');

    const serialized = `${JSON.stringify(calls)}${JSON.stringify(window.hsbEvents)}`;
    assertNoBearerMaterial(serialized, 'review payload');
    assert.doesNotMatch(serialized, /rvw_secret_bearer/);
  });
});

test('family-review token and asset routes are collapsed to templates', async () => {
  const token = 'frv_testfixturetoken01';
  const assetId = 'asset_44c1';
  await withAnalytics(
    { href: `https://herostorybooks.com/family-review/review/${token}/image/${assetId}` },
    async ({ calls, window }, { trackPageView }) => {
      trackPageView(`/family-review/review/${token}/image/${assetId}`);
      trackPageView(`/family-review/review/${token}`);

      const pageViews = calls.filter((c) => c[0] === 'event' && c[1] === 'page_view');
      assert.equal(pageViews.length, 2);
      assert.equal(
        (pageViews[0][2] as Record<string, unknown>).pathname,
        '/family-review/review/[reviewToken]/image/[assetId]',
      );
      assert.equal(
        (pageViews[1][2] as Record<string, unknown>).pathname,
        '/family-review/review/[reviewToken]',
      );

      const serialized = `${JSON.stringify(calls)}${JSON.stringify(window.hsbEvents)}`;
      assert.doesNotMatch(serialized, new RegExp(token));
      assert.doesNotMatch(serialized, new RegExp(assetId));
    },
  );
});

test('non-sensitive routes and event names are preserved verbatim', async () => {
  await withAnalytics(
    {
      href: 'https://herostorybooks.com/checkout?utm_source=telegram',
      referrer: 'https://herostorybooks.com/gifts/birthday',
    },
    async ({ calls, window }, { track, trackPageView }) => {
      trackPageView('/checkout');
      trackPageView('/gifts/birthday');
      trackPageView('/');
      trackPageView('/admin/orders');
      track('begin_checkout', { bookFormat: 'print' });

      const pageViews = calls
        .filter((c) => c[0] === 'event' && c[1] === 'page_view')
        .map((c) => (c[2] as Record<string, unknown>).pathname);
      assert.deepEqual(pageViews, ['/checkout', '/gifts/birthday', '/', '/admin/orders']);

      const checkoutParams = eventParams(calls, 'begin_checkout');
      assert.equal(checkoutParams.pathname, '/checkout');
      assert.equal(checkoutParams.page_location, 'https://herostorybooks.com/checkout');
      assert.equal(checkoutParams.page_referrer, 'https://herostorybooks.com/gifts/birthday');
      assert.equal(checkoutParams.utm_source, 'telegram');
      assert.equal(window.hsbEvents?.length, 5);
    },
  );
});

test('the sanitizer collapses identifier routes and leaves everything else alone', async () => {
  const { sanitizeAnalyticsPath, sanitizeAnalyticsUrl } = await import(
    '../src/lib/analytics-path.ts'
  );
  const cases: Array<[string, string]> = [
    [STATUS_PATH, '/status/[orderId]'],
    [`${STATUS_PATH}/`, '/status/[orderId]'],
    ['/status/[orderId]', '/status/[orderId]'],
    ['/status/', '/status/'],
    ['/status', '/status'],
    ['/statuses/whatever', '/statuses/whatever'],
    ['/admin/orders', '/admin/orders'],
    [`/admin/orders/${ORDER_ID}`, '/admin/orders/[orderId]'],
    ['/', '/'],
    ['/gifts/birthday', '/gifts/birthday'],
    ['/checkout?childName=Private#top', '/checkout'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeAnalyticsPath(input), expected, `sanitizeAnalyticsPath(${input})`);
  }
  assert.equal(sanitizeAnalyticsUrl(STATUS_URL), 'https://herostorybooks.com/status/[orderId]');
  assert.equal(sanitizeAnalyticsUrl('not a url'), 'not a url');
});

test('the inline gtag bootstrap config never publishes a raw status URL', async () => {
  const { analyticsPathBootstrapScript } = await import('../src/lib/analytics-path.ts');
  const layoutSource = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
  const inline = layoutSource.match(
    /<Script id="google-analytics-gtag"[^>]*>\s*\{`([\s\S]*?)`\}\s*<\/Script>/,
  );
  assert.ok(inline, 'expected an inline google-analytics-gtag bootstrap script');
  const body = inline[1]
    .replaceAll('${googleAnalyticsMeasurementId}', 'G-TEST')
    .replaceAll('${analyticsPathBootstrapScript()}', analyticsPathBootstrapScript());
  // Guard the substitution above: a new interpolation must not be silently
  // evaluated as dead literal text.
  assert.doesNotMatch(body, /\$\{/, 'unresolved interpolation in the extracted bootstrap script');

  const sandbox: Record<string, unknown> = {
    document: { referrer: STATUS_URL },
    URL,
    Date,
    location: new URL(STATUS_URL),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(body, sandbox);

  const dataLayer = sandbox.dataLayer as IArguments[];
  assert.ok(Array.isArray(dataLayer));
  const config = Array.from(dataLayer)
    .map((args) => Array.from(args))
    .find((args) => args[0] === 'config');
  assert.ok(config, 'expected a gtag config call');
  const params = config[2] as Record<string, unknown>;
  assert.equal(params.page_location, 'https://herostorybooks.com/status/[orderId]');
  assert.equal(params.page_referrer, 'https://herostorybooks.com/status/[orderId]');
  assert.equal(params.send_page_view, false);

  assertNoBearerMaterial(JSON.stringify(Array.from(dataLayer).map((a) => Array.from(a))), 'gtag config');
});

// Vercel Web Analytics is the other vendor mounted on every page. Its
// `beforeSend` hook sees both the component's automatic page views and the
// custom events track() forwards, and the event URL is a full URL — so
// stripping the query string alone still hands Vercel the bearer segment
// sitting in the path. On /family-review/review/<token> that segment IS the
// parent's sole access credential, and the family-review CSP that blocks GA4
// explicitly permits this same-origin channel.
test('Vercel Analytics event URLs are redacted, not merely de-queried', async () => {
  const { sanitizeVercelAnalyticsUrl } = await import('../src/lib/analytics-path.ts');
  const origin = 'https://herostorybooks.com';
  const cases: Array<[string, string]> = [
    [STATUS_URL, `${origin}/status/[orderId]`],
    [`${origin}${STATUS_PATH}`, `${origin}/status/[orderId]`],
    // Relative event URLs resolve against the current origin.
    [`${STATUS_PATH}?email=${BUYER_EMAIL}`, `${origin}/status/[orderId]`],
    [`${origin}/review/${ORDER_ID}?token=rvw_secret_bearer`, `${origin}/review/[orderId]`],
    [`${origin}/checkout?childName=Private#top`, `${origin}/checkout`],
    [`${origin}/gifts/birthday`, `${origin}/gifts/birthday`],
    [`${origin}/`, `${origin}/`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      sanitizeVercelAnalyticsUrl(input, origin, '/'),
      expected,
      `sanitizeVercelAnalyticsUrl(${input})`,
    );
  }
  assertNoBearerMaterial(
    JSON.stringify(cases.map(([input]) => sanitizeVercelAnalyticsUrl(input, origin, '/'))),
    'vercel analytics urls',
  );
});

test('the family-review bearer token never reaches Vercel Analytics', async () => {
  const { sanitizeVercelAnalyticsUrl } = await import('../src/lib/analytics-path.ts');
  const origin = 'https://herostorybooks.com';
  const token = 'frv_testfixturetoken01';
  const assetId = 'asset_44c1';

  assert.equal(
    sanitizeVercelAnalyticsUrl(`${origin}/family-review/review/${token}`, origin, '/'),
    `${origin}/family-review/review/[reviewToken]`,
  );
  const withAsset = sanitizeVercelAnalyticsUrl(
    `${origin}/family-review/review/${token}/image/${assetId}`,
    origin,
    '/',
  );
  assert.equal(withAsset, `${origin}/family-review/review/[reviewToken]/image/[assetId]`);
  assert.doesNotMatch(withAsset, new RegExp(token), 'leaked the family-review bearer token');
  assert.doesNotMatch(withAsset, new RegExp(assetId), 'leaked the asset id');
});

test('the unparseable-URL fallback sanitizes the current location too', async () => {
  const { sanitizeVercelAnalyticsUrl } = await import('../src/lib/analytics-path.ts');
  // An empty base makes URL() throw, exercising the fallback branch.
  assert.equal(sanitizeVercelAnalyticsUrl(STATUS_PATH, '', STATUS_PATH), '/status/[orderId]');
});

test('SafeVercelAnalytics routes beforeSend through the shared redactor', () => {
  const source = readFileSync(
    new URL('../src/components/safe-vercel-analytics.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /beforeSend=/);
  assert.match(source, /sanitizeVercelAnalyticsUrl\(/);
  assert.match(source, /from ["']@\/lib\/analytics-path["']/);
  // No local copy that rebuilds the URL from the unredacted pathname.
  assert.doesNotMatch(source, /\$\{url\.origin\}\$\{url\.pathname\}/);
  assert.doesNotMatch(source, /\$\{window\.location\.origin\}\$\{window\.location\.pathname\}/);
});
