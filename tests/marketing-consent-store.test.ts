/**
 * The shared consent surface: default, accept, decline, persistence,
 * revocation, same-tab reactivity, and the fact that GA4 and Meta obey the
 * same source of truth.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CONSENT_STORAGE_KEY,
  __resetConsentStoreForTests,
  clearConsent,
  getConsent,
  parseStoredConsent,
  readStoredConsent,
  setConsent,
  subscribeConsent,
} from '../src/lib/marketing/consent-store.ts';
import { CONSENT_GLOBAL_KEY } from '../src/lib/marketing/consent.ts';

const surfaceSource = readFileSync(
  new URL('../src/components/marketing/consent-surface.tsx', import.meta.url),
  'utf8',
);
const analyticsSource = readFileSync(
  new URL('../src/lib/analytics.ts', import.meta.url),
  'utf8',
);
const mountSource = readFileSync(
  new URL('../src/components/marketing/meta-pixel-mount.tsx', import.meta.url),
  'utf8',
);
const layoutSource = readFileSync(
  new URL('../src/app/layout.tsx', import.meta.url),
  'utf8',
);

function withFakeWindow<T>(fn: (storage: Map<string, string>) => T): T {
  const map = new Map<string, string>();
  const prior = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    },
  });
  try {
    __resetConsentStoreForTests();
    return fn(map);
  } finally {
    __resetConsentStoreForTests();
    if (prior === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: prior });
  }
}

/* ── 1. Default is not consent ──────────────────────────────────────────── */

test('with no stored choice the state is unknown, and unknown is not a grant', () => {
  withFakeWindow((map) => {
    assert.equal(getConsent(), 'unknown');
    assert.equal(map.size, 0, 'nothing may be stored before a choice is made');
  });
});

test('an unparseable or unknown stored value is unknown, never granted', () => {
  for (const raw of [
    null,
    '',
    'granted',
    '{}',
    JSON.stringify({ v: 2, c: 'granted', at: 1 }),
    JSON.stringify({ v: 1, c: 'yes', at: 1 }),
    JSON.stringify({ v: 1, c: 'granted' }),
    JSON.stringify({ v: 1, c: 'granted', at: 0 }),
    'x'.repeat(400),
  ]) {
    assert.equal(parseStoredConsent(raw as string | null), null, `honoured: ${String(raw).slice(0, 40)}`);
  }
  assert.equal(readStoredConsent(null), 'unknown');
});

/* ── 2. Accept, decline, persistence ────────────────────────────────────── */

test('accept persists a bounded first-party record and reports granted', () => {
  withFakeWindow((map) => {
    setConsent('granted', 1_700_000_000_000);
    assert.equal(getConsent(), 'granted');
    const raw = map.get(CONSENT_STORAGE_KEY) ?? '';
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['at', 'c', 'v']);
    assert.equal(JSON.parse(raw).c, 'granted');
    assert.ok(raw.length < 128);
  });
});

test('decline persists too, so the banner does not come back every page', () => {
  withFakeWindow((map) => {
    setConsent('denied');
    assert.equal(getConsent(), 'denied');
    assert.equal(JSON.parse(map.get(CONSENT_STORAGE_KEY) ?? '{}').c, 'denied');
  });
});

test('the stored record carries no identifier of any kind', () => {
  withFakeWindow((map) => {
    setConsent('granted', 1_700_000_000_000);
    const parsed = JSON.parse(map.get(CONSENT_STORAGE_KEY) ?? '{}');
    // Version, choice, timestamp. Nothing that distinguishes one visitor.
    assert.deepEqual(Object.keys(parsed).sort(), ['at', 'c', 'v']);
    assert.equal(typeof parsed.at, 'number');
  });
});

/* ── 3. Revocation ──────────────────────────────────────────────────────── */

test('clearing returns to unknown and removes the stored record', () => {
  withFakeWindow((map) => {
    setConsent('granted');
    clearConsent();
    assert.equal(getConsent(), 'unknown');
    assert.equal(map.has(CONSENT_STORAGE_KEY), false);
  });
});

test('changing your mind withdraws first, it never flips straight to a grant', () => {
  // The surface calls clearConsent() when re-opening, so the interim state is
  // 'unknown' -- optional measurement is off while the choice is re-offered.
  assert.match(surfaceSource, /const reopen = useCallback\(\(\) => \{\s*\n\s*\/\/[\s\S]*?clearConsent\(\);/);
});

/* ── 4. Same-tab reactivity ─────────────────────────────────────────────── */

test('subscribers are notified synchronously on every change', () => {
  withFakeWindow(() => {
    const seen: string[] = [];
    const unsubscribe = subscribeConsent((s) => seen.push(s));
    setConsent('granted');
    setConsent('denied');
    clearConsent();
    unsubscribe();
    setConsent('granted');
    assert.deepEqual(seen, ['granted', 'denied', 'unknown']);
  });
});

test('one throwing subscriber cannot block the others', () => {
  withFakeWindow(() => {
    const seen: string[] = [];
    subscribeConsent(() => {
      throw new Error('bad subscriber');
    });
    subscribeConsent((s) => seen.push(s));
    setConsent('granted');
    assert.deepEqual(seen, ['granted']);
  });
});

test('the documented global mirrors the state for existing consumers', () => {
  withFakeWindow(() => {
    setConsent('granted');
    assert.equal((globalThis as Record<string, unknown>)[CONSENT_GLOBAL_KEY], 'granted');
    setConsent('denied');
    assert.equal((globalThis as Record<string, unknown>)[CONSENT_GLOBAL_KEY], 'denied');
    clearConsent();
    assert.equal((globalThis as Record<string, unknown>)[CONSENT_GLOBAL_KEY], undefined);
  });
});

/* ── 5. GA4 and Meta obey the SAME source of truth ──────────────────────── */

test('the browser analytics layer gates every outbound destination on consent', () => {
  assert.match(analyticsSource, /function optionalAnalyticsAllowed\(\)/);
  assert.match(analyticsSource, /isMarketingConsentGranted\(getConsent\(\)\)/);
  // The gate sits above gtag, Vercel, and the Meta bridge, so none can be
  // reached without it.
  const trackBody = analyticsSource.slice(
    analyticsSource.indexOf('export function track('),
    analyticsSource.indexOf('export function trackPageView('),
  );
  const gateIdx = trackBody.indexOf('optionalAnalyticsAllowed()');
  for (const destination of ['window.gtag', 'trackVercelEvent(', 'metaHandleHsbEvent(']) {
    const idx = trackBody.indexOf(destination);
    assert.ok(idx > gateIdx, `${destination} is reachable before the consent gate`);
  }
});

test('a declined visitor produces no gtag, Vercel, or Meta call', async () => {
  const calls: unknown[][] = [];
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: new URL('https://herostorybooks.com/checkout'),
      gtag: (...args: unknown[]) => calls.push(args),
      sessionStorage: { getItem: () => null, setItem: () => undefined },
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: '' } });
  try {
    __resetConsentStoreForTests();
    const { track } = await import('../src/lib/analytics.ts');

    // Default (no choice at all).
    track('begin_checkout', { theme: 'space' });
    assert.equal(calls.length, 0, 'an undecided visitor produced a gtag call');

    // Explicit decline.
    setConsent('denied');
    track('begin_checkout', { theme: 'space' });
    assert.equal(calls.length, 0, 'a declined visitor produced a gtag call');

    // And a grant turns it on in the same tab, with no reload.
    setConsent('granted');
    track('begin_checkout', { theme: 'space' });
    assert.ok(calls.some((c) => c[0] === 'event' && c[1] === 'begin_checkout'));
  } finally {
    __resetConsentStoreForTests();
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
});

test('the Meta mount subscribes to the same store and re-offers the route on change', () => {
  assert.match(mountSource, /subscribeConsent/);
  assert.match(mountSource, /from "@\/lib\/marketing\/consent-store"/);
  // Consent is a dependency of the effect that offers the route, so a grant
  // reaches the controller without a reload.
  assert.match(mountSource, /\}, \[pathname, consent\]\);/);
});

/* ── 6. Google Consent Mode defaults, and no dark patterns ──────────────── */

test('Consent Mode v2 defaults to denied, before config', () => {
  assert.match(layoutSource, /gtag\('consent', 'default', \{/);
  for (const key of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage']) {
    assert.match(layoutSource, new RegExp(`${key}: 'denied'`));
  }
  const defaultIdx = layoutSource.indexOf("gtag('consent', 'default'");
  const configIdx = layoutSource.indexOf("gtag('config'");
  assert.ok(defaultIdx > 0 && defaultIdx < configIdx, 'consent default must precede config');
});

test('the surface offers accept and decline with identical affordance', () => {
  // One shared style object, so decline cannot be made quieter than accept
  // without changing both at once.
  assert.match(surfaceSource, /style=\{buttonStyle\}[\s\S]*?data-testid="consent-decline"|data-testid="consent-decline"[\s\S]*?style=\{buttonStyle\}/);
  const acceptCount = (surfaceSource.match(/style=\{buttonStyle\}/g) ?? []).length;
  assert.equal(acceptCount, 2, 'both buttons must share the one style object');
  assert.doesNotMatch(surfaceSource, /defaultChecked|checked=\{true\}/, 'no pre-checked consent');
});

test('the surface is accessible and reachable again after a choice', () => {
  assert.match(surfaceSource, /role="dialog"/);
  assert.match(surfaceSource, /aria-labelledby="hsb-consent-title"/);
  assert.match(surfaceSource, /aria-describedby="hsb-consent-body"/);
  assert.match(surfaceSource, /data-testid="consent-reopen"/);
});

test('no fingerprinting, advanced matching, or cross-site identifier is introduced', () => {
  for (const forbidden of [
    'canvas', 'fingerprint', 'AdvancedMatching', 'advanced_matching',
    'navigator.userAgent', 'screen.width', 'third-party', 'document.cookie',
  ]) {
    assert.equal(surfaceSource.includes(forbidden), false, `surface uses ${forbidden}`);
  }
});

/* ── 7. Essential behaviour is never gated ──────────────────────────────── */

test('no order, payment, webhook, or family-review path consults consent', () => {
  for (const file of [
    '../src/app/api/order/route.ts',
    '../src/app/api/webhooks/stripe/route.ts',
    '../src/lib/ga4-purchase.ts',
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(
      /consent-store|isMarketingConsentGranted|getConsent\(/.test(src),
      false,
      `${file} gates server behaviour on browser consent`,
    );
  }
});
