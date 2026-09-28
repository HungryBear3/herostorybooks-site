/**
 * The bounded analytics context that travels with a checkout: built in the
 * browser from validated storage and fail-closed GA cookies, re-validated by
 * the checkout API, and written into Stripe metadata as flat bounded keys.
 * None of it may ever change a checkout's identity.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHECKOUT_ANALYTICS_FORM_FIELDS,
  browserCheckoutAnalyticsFormFields,
  checkoutAnalyticsFormFields,
  checkoutAnalyticsStripeMetadata,
  parseCheckoutAnalyticsForm,
} from '../src/lib/checkout-analytics-context.ts';
import { ATTRIBUTION_STORAGE_KEY } from '../src/lib/attribution-contract.ts';
import { checkoutRequestFingerprint } from '../src/lib/checkout-request-fingerprint.ts';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const CLIENT = '123456789.1727500000';
const COOKIE = `_ga=GA1.1.${CLIENT}; _ga_68FKEDZEG3=GS2.1.s1727500000$o3$g1$t1727500100`;

const STATE = {
  version: 1,
  firstTouch: {
    source: 'facebook', medium: 'paid_social', campaign: '2026-10-gifts', content: null, term: null,
    landingPath: '/gifts/birthdays', capturedAt: '2026-09-20T10:00:00.000Z',
  },
  lastNonDirectTouch: {
    source: 'newsletter', medium: 'email', campaign: null, content: null, term: null,
    landingPath: '/', capturedAt: '2026-09-27T10:00:00.000Z',
  },
} as const;
const STATE_JSON = JSON.stringify(STATE);

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key: string) => (map.has(key) ? map.get(key)! : null), setItem: () => {} };
}

// ── Browser ─────────────────────────────────────────────────────────────────

test('the checkout form attaches only fail-closed GA ids and the validated stored attribution', () => {
  const storage = memoryStorage({ [ATTRIBUTION_STORAGE_KEY]: STATE_JSON, 'hsb:other': 'jane@example.com' });
  assert.deepEqual(checkoutAnalyticsFormFields({ storage, cookie: COOKIE, now: NOW }), {
    gaClientId: CLIENT,
    gaSessionId: '1727500000',
    gaSessionNumber: '3',
    attribution: STATE_JSON,
  });
});

test('a session without a client id, a tampered store, or missing inputs attach nothing', () => {
  const storage = memoryStorage({ [ATTRIBUTION_STORAGE_KEY]: '{"version":1}' });
  assert.deepEqual(
    checkoutAnalyticsFormFields({ storage, cookie: '_ga_68FKEDZEG3=GS2.1.s1727500000$o3', now: NOW }),
    {},
  );
  assert.deepEqual(checkoutAnalyticsFormFields({ storage: null, cookie: undefined, now: NOW }), {});
  const throwing = { getItem(): string | null { throw new Error('SecurityError'); }, setItem() {} };
  assert.deepEqual(checkoutAnalyticsFormFields({ storage: throwing, cookie: COOKIE, now: NOW }), {
    gaClientId: CLIENT,
    gaSessionId: '1727500000',
    gaSessionNumber: '3',
  });
});

test('the browser adapter reads window storage and document cookies and never throws', () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const recentState = {
    ...STATE,
    firstTouch: { ...STATE.firstTouch, capturedAt: new Date(Date.now() - 60_000).toISOString() },
    lastNonDirectTouch: null,
  };
  try {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: memoryStorage({ [ATTRIBUTION_STORAGE_KEY]: JSON.stringify(recentState) }) },
    });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: COOKIE } });
    assert.deepEqual(browserCheckoutAnalyticsFormFields(), {
      gaClientId: CLIENT,
      gaSessionId: '1727500000',
      gaSessionNumber: '3',
      attribution: JSON.stringify(recentState),
    });

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { get localStorage(): never { throw new Error('SecurityError'); } },
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { get cookie(): never { throw new Error('SecurityError'); } },
    });
    assert.deepEqual(browserCheckoutAnalyticsFormFields(), {});
  } finally {
    if (priorWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow });
    if (priorDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: priorDocument });
  }
});

// ── Server ──────────────────────────────────────────────────────────────────

function analyticsForm(entries: Array<[string, string | File]>): FormData {
  const form = new FormData();
  for (const [name, value] of entries) form.append(name, value);
  return form;
}

test('the checkout API keeps a validated attribution state and a GA session paired to a client id', () => {
  const form = analyticsForm([['attribution', STATE_JSON], ['gaSessionId', '1727500000'], ['gaSessionNumber', '3']]);
  assert.deepEqual(parseCheckoutAnalyticsForm(form, { now: NOW, gaClientId: CLIENT }), {
    attribution: STATE,
    analytics: { gaSessionId: '1727500000', gaSessionNumber: '3' },
  });
  assert.deepEqual(
    parseCheckoutAnalyticsForm(form, { now: NOW, gaClientId: null }).analytics,
    { gaSessionId: null, gaSessionNumber: null },
    'a session is meaningless without the client it belongs to',
  );
});

test('hostile or ambiguous analytics fields fail closed', () => {
  const none = { gaSessionId: null, gaSessionNumber: null };
  const cases: Array<[string, Array<[string, string | File]>]> = [
    ['unpaired session number', [['gaSessionId', '1727500000'], ['gaSessionNumber', 'ZQX-7731']]],
    ['duplicated session id', [['gaSessionId', '1727500000'], ['gaSessionId', '1727500001'], ['gaSessionNumber', '3']]],
    ['file in place of text', [['gaSessionId', new File(['1727500000'], 'x.txt')], ['gaSessionNumber', '3']]],
    ['duplicated attribution', [['attribution', STATE_JSON], ['attribution', STATE_JSON]]],
    ['attribution carrying a contact detail', [['attribution', STATE_JSON.replace('"term":null', '"term":"zqx.parent.7731@example.invalid"')]]],
    ['attribution with an unknown key', [['attribution', STATE_JSON.replace('{"version":1', '{"version":1,"childName":"ZQX-CHILD-7731"')]]],
    ['oversized attribution', [['attribution', `${' '.repeat(3000)}${STATE_JSON}`]]],
    ['attribution as a file', [['attribution', new File([STATE_JSON], 'a.json')]]],
  ];
  for (const [label, entries] of cases) {
    const parsed = parseCheckoutAnalyticsForm(analyticsForm(entries), { now: NOW, gaClientId: CLIENT });
    assert.deepEqual(parsed, { attribution: null, analytics: none }, label);
  }
});

test('Stripe metadata receives exactly the attribution keys and a validated GA session', () => {
  assert.deepEqual(
    checkoutAnalyticsStripeMetadata({ attribution: STATE, analytics: { gaSessionId: '1727500000', gaSessionNumber: '3' } }),
    {
      hsbAttrV: '1',
      hsbFtSrc: 'facebook',
      hsbFtMed: 'paid_social',
      hsbFtCmp: '2026-10-gifts',
      hsbFtPath: '/gifts/birthdays',
      hsbFtAt: '2026-09-20T10:00:00.000Z',
      hsbLtSrc: 'newsletter',
      hsbLtMed: 'email',
      hsbLtPath: '/',
      hsbLtAt: '2026-09-27T10:00:00.000Z',
      gaSessionId: '1727500000',
      gaSessionNumber: '3',
    },
  );
  assert.deepEqual(checkoutAnalyticsStripeMetadata({ attribution: null, analytics: null }), {});
  assert.deepEqual(
    checkoutAnalyticsStripeMetadata({ attribution: undefined, analytics: { gaSessionId: '1727500000', gaSessionNumber: 'x' } }),
    {},
  );
});

test('analytics fields never change a checkout attempt fingerprint', async () => {
  const base = (extra: Array<[string, string]> = [], gaClientId = CLIENT) => {
    const form = analyticsForm([
      ['checkoutAttemptId', 'a'.repeat(32)],
      ['childName', 'Mina'],
      ['email', 'buyer@example.com'],
      ['bookFormat', 'digital'],
      ['theme', 'space-adventure'],
      ['gaClientId', gaClientId],
    ]);
    for (const [name, value] of extra) form.append(name, value);
    return form;
  };
  const plain = await checkoutRequestFingerprint(base());
  const other = { ...STATE, lastNonDirectTouch: null };
  assert.equal(
    await checkoutRequestFingerprint(base([['attribution', STATE_JSON], ['gaSessionId', '1727500000'], ['gaSessionNumber', '3']])),
    plain,
  );
  assert.equal(
    await checkoutRequestFingerprint(base([['attribution', JSON.stringify(other)], ['gaSessionId', '1727600000'], ['gaSessionNumber', '4']])),
    plain,
    'a later GA session or an advanced last touch on retry is the same checkout',
  );
  for (const field of CHECKOUT_ANALYTICS_FORM_FIELDS) {
    assert.equal(await checkoutRequestFingerprint(base([[field, 'x']])), plain, field);
  }
  // Controls: purchased content still defines identity, and the pre-existing
  // gaClientId keeps its place, so no in-flight attempt changes identity on deploy.
  assert.notEqual(await checkoutRequestFingerprint(base([['bookFormat', 'premium']])), plain);
  assert.notEqual(await checkoutRequestFingerprint(base([], '987654321.1727400000')), plain);
});
