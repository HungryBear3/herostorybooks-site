import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const layoutSource = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');
const pageViewSource = readFileSync(new URL('../src/components/analytics-page-view.tsx', import.meta.url), 'utf8');

test('root layout loads the Google Analytics gtag script with the production measurement id', () => {
  assert.match(layoutSource, /G-68FKEDZEG3/);
  assert.match(layoutSource, /process\.env\.VERCEL_ENV === 'production'/);
  assert.match(layoutSource, /googleAnalyticsEnabled \? \(/);
  assert.match(layoutSource, /googletagmanager\.com\/gtag\/js\?id=\$\{googleAnalyticsMeasurementId\}/);
  assert.match(layoutSource, /<Script id="google-analytics-gtag" strategy="beforeInteractive">/);
  assert.match(layoutSource, /gtag\('js', new Date\(\)\)/);
  assert.match(layoutSource, /var pageLocation = window\.location\.origin \+ window\.location\.pathname/);
  assert.match(layoutSource, /pageReferrer = referrerUrl\.origin \+ referrerUrl\.pathname/);
  assert.match(layoutSource, /send_page_view: false/);
  assert.match(layoutSource, /page_location: pageLocation/);
  assert.match(layoutSource, /page_referrer: pageReferrer/);
  assert.match(layoutSource, /<AnalyticsPageView \/>/);
});

test('shared analytics layer forwards HSB funnel events to gtag once when available', () => {
  assert.match(analyticsSource, /window\.gtag\('event', event, googleSafeProps\(record\)\)/);
  assert.doesNotMatch(analyticsSource, /dataLayer\.push\(record\)/);
  assert.match(analyticsSource, /props\.page_location = pageLocation/);
  assert.match(analyticsSource, /props\.page_referrer = sanitizedPageReferrer\(\)/);
  assert.match(analyticsSource, /trackVercelEvent\(event/);
});

test('global page views track pathname changes without query strings', () => {
  assert.match(pageViewSource, /usePathname\(\)/);
  assert.match(pageViewSource, /trackPageView\(pathname\)/);
  assert.doesNotMatch(pageViewSource, /useSearchParams|window\.location\.search/);
  assert.doesNotMatch(analyticsSource, /window\.location\.href/);
  assert.match(analyticsSource, /window\.location\.origin/);
});

test('runtime payload strips PII and preserves first-touch campaign attribution across navigation', async () => {
  const calls: unknown[][] = [];
  const storage = new Map<string, string>();
  const mockWindow = {
    location: new URL(
      'https://herostorybooks.com/checkout?childName=PrivateName&utm_source=telegram&utm_medium=social&utm_campaign=launch',
    ),
    gtag: (...args: unknown[]) => calls.push(args),
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  };
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: mockWindow,
  });
  const mockDocument = {
    referrer: 'https://herostorybooks.com/?childName=PriorName&utm_source=telegram',
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: mockDocument,
  });

  try {
    const { track, trackPageView } = await import('../src/lib/analytics.ts');
    trackPageView('/checkout');
    mockWindow.location = new URL('https://herostorybooks.com/thank-you');
    track('purchase_intent', { bookFormat: 'digital' });
    mockDocument.referrer = '';
    track('start_checkout');

    const eventCall = calls.find((call) => call[0] === 'event' && call[1] === 'page_view');
    assert.ok(eventCall);
    const eventParams = eventCall[2] as Record<string, unknown>;
    assert.equal(eventParams.page_location, 'https://herostorybooks.com/checkout');
    assert.equal(eventParams.page_referrer, 'https://herostorybooks.com/');
    assert.equal(eventParams.pathname, '/checkout');

    const purchaseCall = calls.find(
      (call) => call[0] === 'event' && call[1] === 'purchase_intent',
    );
    assert.ok(purchaseCall);
    const purchaseParams = purchaseCall[2] as Record<string, unknown>;
    assert.equal(purchaseParams.utm_source, 'telegram');
    assert.equal(purchaseParams.utm_medium, 'social');
    assert.equal(purchaseParams.utm_campaign, 'launch');
    assert.equal(purchaseParams.page_location, 'https://herostorybooks.com/thank-you');

    const directVisitCall = calls.find(
      (call) => call[0] === 'event' && call[1] === 'start_checkout',
    );
    assert.ok(directVisitCall);
    assert.equal((directVisitCall[2] as Record<string, unknown>).page_referrer, '');

    const campaignSetCall = calls.find(
      (call) =>
        call[0] === 'set' &&
        (call[1] as Record<string, unknown>).campaign_source === 'telegram',
    );
    assert.ok(campaignSetCall);
    assert.deepEqual(campaignSetCall[1], {
      campaign_source: 'telegram',
      campaign_medium: 'social',
      campaign_name: 'launch',
    });

    const serialized = JSON.stringify(calls);
    assert.match(serialized, /page_view/);
    assert.match(serialized, /utm_source/);
    assert.doesNotMatch(serialized, /PrivateName|PriorName|childName/);
  } finally {
    if (priorWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    }
    if (priorDocument === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: priorDocument,
      });
    }
  }
});
