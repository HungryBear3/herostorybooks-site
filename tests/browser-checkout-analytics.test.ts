/**
 * Browser-side analytics wiring for checkout: `begin_checkout` fires exactly
 * once per validated submit attempt, landings are recorded through the attribution contract,
 * checkout attaches analytics only through the bounded builder, and no browser
 * code path can write a GA4 `purchase` — that event belongs to the signed
 * webhook alone.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createSubmitLock } from '../src/lib/checkout-handoff.ts';
import { ATTRIBUTION_STORAGE_KEY, recordBrowserAttributionLanding } from '../src/lib/attribution-contract.ts';

const CHECKOUT_FORM = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');

function withGlobals<T>(values: { window?: unknown; document?: unknown }, run: () => T): T {
  const prior = { window: globalThis.window, document: globalThis.document };
  try {
    for (const key of ['window', 'document'] as const) {
      if (key in values) Object.defineProperty(globalThis, key, { configurable: true, value: values[key] });
      else Reflect.deleteProperty(globalThis, key);
    }
    return run();
  } finally {
    for (const key of ['window', 'document'] as const) {
      if (prior[key] === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, value: prior[key] });
    }
  }
}

// ── begin_checkout ──────────────────────────────────────────────────────────

test('validated lock-winning submits emit once each, including a genuine retry', () => {
  // Execute the real synchronous submit prefix with the real lock. Mount and
  // StrictMode effect replay must contain no begin_checkout writer.
  const start = CHECKOUT_FORM.indexOf('    if (currentStepId !== "review"');
  const end = CHECKOUT_FORM.indexOf('    // A submit owns', start);
  const prefix = CHECKOUT_FORM.slice(start, end);
  assert.match(prefix, /track\("begin_checkout"/);
  assert.equal(CHECKOUT_FORM.match(/track\(\s*["']begin_checkout["']/g)?.length, 1);
  assert.doesNotMatch(CHECKOUT_FORM, /claimBeginCheckout/);
  const lock = createSubmitLock();
  const events: string[] = [];
  const submit = new Function('currentStepId', 'isReadyToPay', 'submitLockRef', 'track',
    'checkoutStepEventProps', 'checkoutSubmitBlockedReason', 'checkoutProgress',
    'directMediaBlockers', 'setStepError', 'form', prefix);
  const run = (ready = true) => submit('review', ready, { current: lock },
    (name: string) => events.push(name), () => ({}), () => 'blocked',
    { currentStep: 'review' }, [], () => {}, { bookFormat: 'digital' });
  run(false);
  run(); run(); run();
  assert.equal(events.filter((event) => event === 'begin_checkout').length, 1);
  lock.release();
  run(); run();
  assert.equal(events.filter((event) => event === 'begin_checkout').length, 2);
});

// ── Checkout form fields ────────────────────────────────────────────────────

test('checkout attaches analytics only through the bounded, fail-closed builder', () => {
  assert.match(CHECKOUT_FORM, /browserCheckoutAnalyticsFormFields\(\)/);
  assert.doesNotMatch(CHECKOUT_FORM, /currentGaClientId\(\)/, 'the first-match _ga reader is not used for checkout');
  assert.doesNotMatch(CHECKOUT_FORM, /payload\.set\(\s*["'](?:attribution|gaSessionId|gaSessionNumber|gaClientId)["']/);
});

// ── Landing capture ─────────────────────────────────────────────────────────

test('every page view records the landing through the attribution contract', () => {
  const pageView = readFileSync('src/components/analytics-page-view.tsx', 'utf8');
  assert.match(pageView, /recordBrowserAttributionLanding\(\)/);
});

test('the browser landing recorder reads location and localStorage and never throws', () => {
  const map = new Map<string, string>();
  const localStorage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
  const state = withGlobals({
    window: {
      location: new URL('https://herostorybooks.com/gifts/birthdays?utm_source=facebook&utm_medium=paid_social&childName=ZQXEMMA'),
      localStorage,
    },
  }, () => recordBrowserAttributionLanding());
  assert.equal(state?.firstTouch.source, 'facebook');
  assert.equal(state?.firstTouch.landingPath, '/gifts/birthdays');
  assert.doesNotMatch(map.get(ATTRIBUTION_STORAGE_KEY) ?? '', /ZQX/);
  assert.ok(map.has(ATTRIBUTION_STORAGE_KEY));

  const blocked = withGlobals({
    window: {
      location: new URL('https://herostorybooks.com/?utm_source=instagram'),
      get localStorage(): never { throw new Error('SecurityError'); },
    },
  }, () => recordBrowserAttributionLanding());
  assert.equal(blocked?.firstTouch.source, 'instagram', 'blocked storage still yields the current landing');

  assert.equal(withGlobals({}, () => recordBrowserAttributionLanding()), null, 'server render records nothing');
});

// ── No browser purchase writer ──────────────────────────────────────────────

test('the browser analytics layer refuses to write a purchase event', async () => {
  const calls: unknown[][] = [];
  const mockWindow: Record<string, unknown> = {
    location: new URL('https://herostorybooks.com/thank-you'),
    gtag: (...args: unknown[]) => { calls.push(args); },
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  };
  const prior = { window: globalThis.window, document: globalThis.document };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: mockWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: '' } });
  try {
    const { track } = await import('../src/lib/analytics.ts');
    assert.equal(track('purchase' as never, { value: 19 }), null);
    assert.equal(track(' Purchase ' as never), null);
    assert.deepEqual(calls, [], 'no gtag call for a purchase');
    assert.equal(mockWindow.hsbEvents, undefined, 'no buffered purchase record');

    assert.ok(track('purchase_intent', { bookFormat: 'digital' }), 'funnel intent events still flow');
    assert.ok(calls.some((call) => call[0] === 'event' && call[1] === 'purchase_intent'));
  } finally {
    for (const key of ['window', 'document'] as const) {
      if (prior[key] === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, value: prior[key] });
    }
  }
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

test('no source file writes a browser-side GA4 purchase', () => {
  const writers: string[] = [];
  for (const file of sourceFiles('src')) {
    const text = readFileSync(file, 'utf8');
    if (/gtag\(\s*['"]event['"]\s*,\s*['"]purchase['"]/.test(text) || /\btrack(?:CoverEvent)?\(\s*['"]purchase['"]/.test(text)) {
      writers.push(file);
    }
  }
  assert.deepEqual(writers, []);
});
