import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const layoutSource = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
const analyticsSource = readFileSync(new URL('../src/lib/analytics.ts', import.meta.url), 'utf8');
const pageViewSource = readFileSync(new URL('../src/components/analytics-page-view.tsx', import.meta.url), 'utf8');

test('GA4 loads only from the consent-gated component, never from the layout', () => {
  const analyticsMount = readFileSync(
    new URL('../src/components/marketing/browser-analytics.tsx', import.meta.url),
    'utf8',
  );
  // The layout must not load, configure, or reference gtag at all any more.
  assert.doesNotMatch(layoutSource, /googletagmanager\.com/);
  assert.doesNotMatch(layoutSource, /gtag\(/);
  assert.doesNotMatch(layoutSource, /SafeVercelAnalytics/);
  assert.match(layoutSource, /<BrowserAnalytics/);
  assert.match(layoutSource, /productionEnabled=\{googleAnalyticsEnabled\}/);
  assert.match(layoutSource, /process\.env\.VERCEL_ENV === 'production'/);
  assert.match(layoutSource, /G-68FKEDZEG3/);

  // The component keeps every previously-released GA4 property, and adds the
  // consent gate above them.
  assert.match(analyticsMount, /if \(consent !== "granted"\) return null;/);
  assert.match(analyticsMount, /if \(!productionEnabled\) return null;/);
  assert.match(analyticsMount, /googletagmanager\.com\/gtag\/js\?id=\$\{measurementId\}/);
  assert.match(analyticsMount, /<Script id="google-analytics-gtag"/);
  assert.match(analyticsMount, /gtag\('js', new Date\(\)\)/);
  assert.match(analyticsMount, /var pageLocation = window\.location\.origin \+ window\.location\.pathname/);
  assert.match(analyticsMount, /pageReferrer = referrerUrl\.origin \+ referrerUrl\.pathname/);
  assert.match(analyticsMount, /send_page_view: false/);
  assert.match(analyticsMount, /page_location: pageLocation/);
  assert.match(analyticsMount, /page_referrer: pageReferrer/);
  assert.match(analyticsMount, /ignore_referrer: ignoreReferrer/);
  assert.match(analyticsMount, /referrerUrl\.hostname\.toLowerCase\(\) === 'checkout\.stripe\.com'/);
  // Vercel Analytics is mounted from the same gate, not from the layout.
  assert.match(analyticsMount, /<SafeVercelAnalytics \/>/);
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
      'https://herostorybooks.com/checkout?childName=PrivateName&utm_source=brightwood_pta&utm_medium=partner&utm_campaign=autumn_pilot',
    ),
    gtag: (...args: unknown[]) => calls.push(args),
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
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
    // Optional browser measurement is consent-gated. Grant it so this test
    // keeps asking its original question. The declined case is covered in
    // tests/marketing-consent-store.test.ts.
    const consentStore = await import('../src/lib/marketing/consent-store.ts');
    consentStore.setConsent('granted');
    // Attribution is captured once at the landing boundary and then read from
    // the governed record, not re-read from the URL on every event. Simulate
    // the landing so "preserved across navigation" is a real question.
    const attribution = await import('../src/lib/marketing/attribution-session.ts');
    attribution.captureAttribution({
      search: mockWindow.location.search,
      storage: attribution.browserAttributionStorage(),
      now: Date.now(),
    });
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
    assert.equal(purchaseParams.utm_source, 'brightwood_pta');
    assert.equal(purchaseParams.utm_medium, 'partner');
    assert.equal(purchaseParams.utm_campaign, 'autumn_pilot');
    assert.equal(purchaseParams.page_location, 'https://herostorybooks.com/thank-you');

    const directVisitCall = calls.find(
      (call) => call[0] === 'event' && call[1] === 'start_checkout',
    );
    assert.ok(directVisitCall);
    assert.equal((directVisitCall[2] as Record<string, unknown>).page_referrer, '');

    const campaignSetCall = calls.find(
      (call) =>
        call[0] === 'set' &&
        (call[1] as Record<string, unknown>).campaign_source === 'brightwood_pta',
    );
    assert.ok(campaignSetCall);
    // Exactly the governed fields. No campaign_term: utm_term has no governed
    // equivalent and is no longer read at all.
    assert.deepEqual(campaignSetCall[1], {
      campaign_source: 'brightwood_pta',
      campaign_medium: 'partner',
      campaign_name: 'autumn_pilot',
    });

    const serialized = JSON.stringify(calls);
    assert.match(serialized, /page_view/);
    assert.match(serialized, /utm_source/);
    assert.doesNotMatch(serialized, /PrivateName|PriorName|childName/);
  } finally {
    (await import('../src/lib/marketing/consent-store.ts')).__resetConsentStoreForTests();
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

test('Stripe Checkout returns preserve the original session attribution', async () => {
  const calls: unknown[][] = [];
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: new URL('https://herostorybooks.com/thank-you'),
      gtag: (...args: unknown[]) => calls.push(args),
      sessionStorage: { getItem: () => null, setItem: () => undefined },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { referrer: 'https://checkout.stripe.com/c/pay/cs_live_private' },
  });

  try {
    const { isUnwantedReferral, trackPageView } = await import('../src/lib/analytics.ts');
    // Optional browser measurement is consent-gated. Grant it so this test
    // keeps asking its original question. The declined case is covered in
    // tests/marketing-consent-store.test.ts.
    const consentStore = await import('../src/lib/marketing/consent-store.ts');
    consentStore.setConsent('granted');
    assert.equal(isUnwantedReferral('https://checkout.stripe.com/c/pay/private'), true);
    assert.equal(isUnwantedReferral('https://facebook.com/story'), false);
    trackPageView('/thank-you');
    const eventCall = calls.find((call) => call[0] === 'event' && call[1] === 'page_view');
    assert.ok(eventCall);
    assert.equal((eventCall[2] as Record<string, unknown>).page_referrer, '');
    assert.equal((eventCall[2] as Record<string, unknown>).ignore_referrer, true);
    assert.doesNotMatch(JSON.stringify(calls), /cs_live_private/);
  } finally {
    (await import('../src/lib/marketing/consent-store.ts')).__resetConsentStoreForTests();
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
});

test('GA cookie parsing returns only the anonymous GA client id', async () => {
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { cookie: 'other=x; _ga=GA1.1.123456789.987654321; consent=yes' },
  });
  try {
    const { currentGaClientId } = await import('../src/lib/analytics.ts');
    assert.equal(currentGaClientId(), '123456789.987654321');
  } finally {
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
});
