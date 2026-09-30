/**
 * The privacy-safe attribution contract.
 *
 * Every campaign value that can leave the browser — into the checkout API, the
 * durable order, Stripe metadata, or a GA4 purchase — passes through this one
 * contract. It holds five UTM fields, a route-template landing path and a
 * capture time, each independently bounded, and nothing else: no raw query,
 * hash, referrer, name, email, or free text.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTRIBUTION_STORAGE_KEY,
  ATTRIBUTION_WINDOW_MS,
  attributionFromStripeMetadata,
  attributionToStripeMetadata,
  captureAttributionTouch,
  mergeAttributionState,
  parseAttributionState,
  recordAttributionLanding,
  sanitizeAttributionValue,
  sanitizeLandingPath,
  serializeAttributionState,
  type AttributionState,
  type AttributionTouch,
} from '../src/lib/attribution-contract.ts';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const DAY = 86_400_000;
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function direct(capturedAt: string, landingPath = '/'): AttributionTouch {
  return { source: null, medium: null, campaign: null, content: null, term: null, landingPath, capturedAt };
}

function campaign(source: string, capturedAt: string, extra: Partial<AttributionTouch> = {}): AttributionTouch {
  return {
    source,
    medium: 'paid_social',
    campaign: '2026-10-gifts',
    content: null,
    term: null,
    landingPath: '/',
    capturedAt,
    ...extra,
  };
}

const VALID: AttributionState = {
  version: 1,
  firstTouch: campaign('facebook', '2026-09-20T10:00:00.000Z'),
  lastNonDirectTouch: campaign('instagram', '2026-09-25T10:00:00.000Z'),
};
const OPTS = { now: NOW, maxAgeMs: ATTRIBUTION_WINDOW_MS };

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  };
}

import { checkoutAnalyticsFormFields, parseCheckoutAnalyticsForm, checkoutAnalyticsStripeMetadata } from '../src/lib/checkout-analytics-context.ts';

test('token-shaped personal data is refused at browser, checkout, metadata write and webhook read boundaries', () => {
  for (const [field, metadataKey, value] of [
    ['term', 'hsbFtTrm', '312-555-0100'],
    ['content', 'hsbFtCnt', 'jane-doe'],
    ['source', 'hsbFtSrc', 'jane.doe'],
    ['medium', 'hsbFtMed', '3125550100'],
    ['campaign', 'hsbFtCmp', '123-main-street'],
    ['content', 'hsbFtCnt', 'jane@example.com'],
  ]) {
    const state = { ...VALID, firstTouch: { ...VALID.firstTouch, [field]: value } };
    const raw = JSON.stringify(state);
    const fields = checkoutAnalyticsFormFields({ storage: { getItem: () => raw }, cookie: '', now: NOW });
    assert.equal(fields.attribution, undefined, `browser ${field}`);
    const form = new FormData(); form.set('attribution', raw);
    assert.equal(parseCheckoutAnalyticsForm(form, { now: NOW, gaClientId: null }).attribution, null, `checkout ${field}`);
    assert.deepEqual(attributionToStripeMetadata(state), {}, `metadata write ${field}`);
    assert.deepEqual(checkoutAnalyticsStripeMetadata({ attribution: state, analytics: null }), {}, `checkout metadata ${field}`);
    const md = { ...attributionToStripeMetadata(VALID), [metadataKey]: value };
    assert.equal(attributionFromStripeMetadata(md, { now: NOW }), null, `webhook ${field}`);
    const touch = captureAttributionTouch({ search: `?utm_source=facebook&utm_${field}=${encodeURIComponent(value)}`, pathname: '/', now: NOW });
    assert.doesNotMatch(JSON.stringify(touch), new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

// ── Values ──────────────────────────────────────────────────────────────────

test('attribution values are allowlisted by key, normalized, and independently length-bounded', () => {
  assert.equal(sanitizeAttributionValue('utm_source', ' Facebook '), 'facebook');
  assert.equal(sanitizeAttributionValue('utm_medium', 'paid_social'), 'paid_social');
  assert.equal(sanitizeAttributionValue('utm_campaign', '2026-10-holiday.v2'), '2026-10-holiday.v2');

  // Only the five UTM keys can carry attribution, whatever the value.
  for (const key of ['ref', 'gclid', 'fbclid', 'utm_id', 'email', '__proto__', 'UTM_SOURCE']) {
    assert.equal(sanitizeAttributionValue(key, 'facebook'), null, key);
  }

  // Tokens are not a privacy boundary: unknown labels are never accepted.
  const token31 = 'a'.repeat(31);
  assert.equal(sanitizeAttributionValue('utm_medium', 'a'.repeat(30)), null);
  assert.equal(sanitizeAttributionValue('utm_medium', token31), null);
  assert.equal(sanitizeAttributionValue('utm_campaign', token31), null);
  assert.equal(sanitizeAttributionValue('utm_source', 'a'.repeat(50)), null);
  assert.equal(sanitizeAttributionValue('utm_source', 'a'.repeat(51)), null);
  assert.equal(sanitizeAttributionValue('utm_term', 'a'.repeat(50)), null);
  assert.equal(sanitizeAttributionValue('utm_term', 'a'.repeat(51)), null);
  assert.equal(sanitizeAttributionValue('utm_campaign', 'a'.repeat(100)), null);
  assert.equal(sanitizeAttributionValue('utm_campaign', 'a'.repeat(101)), null);
  assert.equal(sanitizeAttributionValue('utm_content', 'a'.repeat(100)), null);
  assert.equal(sanitizeAttributionValue('utm_content', 'a'.repeat(101)), null);
});

test('contact details, free text, URLs and encodings are never attribution values', () => {
  const hostile = [
    '312-555-0100', '3125550100', 'jane-doe', 'jane.doe', 'emma', '123-main-street',
    'jane@example.com', 'jane smith', '+15551234567', 'https://evil.test/x', 'a/b', '%40',
    '-lead', 'trail-', '', '   ', 'emma\u0000', 'ëmma', 'a;b', 'a=b', '<script>', "o'brien",
  ];
  for (const value of hostile) {
    for (const key of UTM_KEYS) assert.equal(sanitizeAttributionValue(key, value), null, `${key}=${value}`);
  }
  for (const value of [123, null, undefined, {}, ['facebook'], true]) {
    assert.equal(sanitizeAttributionValue('utm_source', value), null, String(value));
  }
});

test('landing paths collapse to a known public route, a route template, or one opaque bucket', () => {
  const cases: Array<[string, string]> = [
    ['/', '/'],
    ['/pricing', '/pricing'],
    ['/pricing/', '/pricing'],
    ['/gifts/birthdays', '/gifts/birthdays'],
    ['/checkout', '/checkout'],
    ['/status/ord_synthetic0001', '/status/[orderId]'],
    ['/review/ord_synthetic0001', '/review/[orderId]'],
    ['/family-review/review/tok_synthetic', '/family-review/review/[reviewToken]'],
    ['/emma-smith-birthday', '/(other)'],
    ['/gifts/emma', '/(other)'],
    ['/admin/orders/ord_synthetic0001', '/(other)'],
    ['/pricing?email=jane%40example.com', '/pricing'],
    ['/pricing#childName=Emma', '/pricing'],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeLandingPath(input), expected, input);
  for (const bad of ['', 'pricing', 'https://herostorybooks.com/pricing', null, 42, `/${'a'.repeat(600)}`]) {
    assert.equal(sanitizeLandingPath(bad), null, String(bad));
  }
});

test('governed marketing labels have closed field-specific forms; term is always dropped', () => {
  const accepted = {
    utm_source: ['facebook', 'instagram', 'google', 'bing', 'newsletter', 'pinterest', 'youtube', 'tiktok', 'telegram'],
    utm_medium: ['paid_social', 'social', 'email', 'cpc', 'organic', 'referral'],
    utm_campaign: ['launch', '2026-10-gifts', '2026-10-holiday.v2', '2027-01-birthdays'],
    utm_content: ['video-a', 'image-b', 'carousel-c', 'text-a'],
  };
  for (const [key, values] of Object.entries(accepted)) {
    for (const value of values) assert.equal(sanitizeAttributionValue(key, value), value);
  }
  for (const value of ['bedtime', '312-555-0100', 'brand']) assert.equal(sanitizeAttributionValue('utm_term', value), null);
  for (const value of ['2026-13-gifts', '2026-10-jane-doe', '2026-10-gifts.jane', 'video-jane', 'video-3125550100']) {
    for (const key of UTM_KEYS) assert.equal(sanitizeAttributionValue(key, value), null);
  }
});

// ── Capture ─────────────────────────────────────────────────────────────────

test('a campaign landing captures only the five bounded UTM fields plus route and time', () => {
  const touch = captureAttributionTouch({
    search: '?utm_source=Facebook&utm_medium=paid_social&utm_campaign=2026-10-gifts'
      + '&utm_content=Video-A&utm_term=Bedtime&childName=ZQXEMMA&email=zqx%40example.invalid'
      + '&gclid=ZQXGCLID&fbclid=ZQXFBCLID',
    pathname: '/gifts/birthdays',
    now: NOW,
  });
  assert.deepEqual(touch, {
    source: 'facebook',
    medium: 'paid_social',
    campaign: '2026-10-gifts',
    content: 'video-a',
    term: null,
    landingPath: '/gifts/birthdays',
    capturedAt: '2026-09-28T12:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(touch), /ZQX|zqx|example\.invalid/);
});

test('a landing without one valid utm_source is direct; other invalid fields drop individually', () => {
  const directAtNow = direct('2026-09-28T12:00:00.000Z');
  assert.deepEqual(captureAttributionTouch({ search: '', pathname: '/', now: NOW }), directAtNow);
  assert.deepEqual(
    captureAttributionTouch({ search: '?utm_campaign=launch&utm_medium=email', pathname: '/', now: NOW }),
    directAtNow,
    'a campaign tuple without a source is not a campaign touch',
  );
  assert.deepEqual(
    captureAttributionTouch({ search: '?utm_source=facebook&utm_source=instagram', pathname: '/', now: NOW }),
    directAtNow,
    'a repeated source is ambiguous',
  );
  assert.deepEqual(
    captureAttributionTouch({
      search: '?utm_source=newsletter&utm_medium=email&utm_term=jane%40example.com',
      pathname: '/',
      now: NOW,
    }),
    { ...directAtNow, source: 'newsletter', medium: 'email' },
    'an invalid term is dropped without discarding the valid tuple',
  );
  assert.deepEqual(
    captureAttributionTouch({ search: `?utm_source=facebook&pad=${'x'.repeat(3000)}`, pathname: '/', now: NOW }),
    directAtNow,
    'an oversized query string is not parsed',
  );
  assert.equal(captureAttributionTouch({ search: '?utm_source=facebook', pathname: 42, now: NOW }), null);
  assert.equal(captureAttributionTouch({ search: '?utm_source=facebook', pathname: '/', now: Number.NaN }), null);
});

test('first touch is immutable; last non-direct touch advances only on campaign landings', () => {
  const a = campaign('facebook', '2026-09-20T10:00:00.000Z');
  const b = campaign('instagram', '2026-09-25T10:00:00.000Z');
  let state = mergeAttributionState(null, a);
  assert.deepEqual(state, { version: 1, firstTouch: a, lastNonDirectTouch: a });
  state = mergeAttributionState(state, direct('2026-09-22T10:00:00.000Z'));
  assert.deepEqual(state, { version: 1, firstTouch: a, lastNonDirectTouch: a });
  state = mergeAttributionState(state, b);
  assert.deepEqual(state, { version: 1, firstTouch: a, lastNonDirectTouch: b });

  const d = direct('2026-09-20T09:00:00.000Z', '/pricing');
  let fromDirect = mergeAttributionState(null, d);
  assert.deepEqual(fromDirect, { version: 1, firstTouch: d, lastNonDirectTouch: null });
  fromDirect = mergeAttributionState(fromDirect, b);
  assert.deepEqual(fromDirect, { version: 1, firstTouch: d, lastNonDirectTouch: b });
});

// ── Stored state ────────────────────────────────────────────────────────────

test('a stored state round-trips only in its exact shape, window boundaries included', () => {
  assert.deepEqual(parseAttributionState(serializeAttributionState(VALID), OPTS), VALID);
  const atWindowEdge = { ...VALID, firstTouch: { ...VALID.firstTouch, capturedAt: '2026-08-29T12:00:00.000Z' } };
  assert.deepEqual(parseAttributionState(JSON.stringify(atWindowEdge), OPTS), atWindowEdge);
  const atSkewEdge = { ...VALID, lastNonDirectTouch: { ...VALID.lastNonDirectTouch!, capturedAt: '2026-09-28T12:05:00.000Z' } };
  assert.deepEqual(parseAttributionState(JSON.stringify(atSkewEdge), OPTS), atSkewEdge);
});

test('stored state with unrecognized keys, a wrong version, or non-canonical values is unusable', () => {
  const serialized = JSON.stringify(VALID);
  const mutate = (fn: (value: any) => void) => {
    const copy = JSON.parse(serialized);
    fn(copy);
    return JSON.stringify(copy);
  };
  const cases: Array<[string, string]> = [
    ['extra top-level key', mutate((v) => { v.email = 'jane@example.com'; })],
    ['extra touch key', mutate((v) => { v.firstTouch.childName = 'Emma'; })],
    ['missing touch key', mutate((v) => { delete v.firstTouch.term; })],
    ['own __proto__ key', `{"__proto__":{"polluted":true},${serialized.slice(1)}`],
    ['version 2', mutate((v) => { v.version = 2; })],
    ['string version', mutate((v) => { v.version = '1'; })],
    ['uppercase stored value', mutate((v) => { v.firstTouch.source = 'Facebook'; })],
    ['contact detail stored value', mutate((v) => { v.firstTouch.term = 'jane@example.com'; })],
    ['non-canonical landing path', mutate((v) => { v.firstTouch.landingPath = '/pricing/'; })],
    ['free-text landing path', mutate((v) => { v.firstTouch.landingPath = '/emma-smith'; })],
    ['direct touch carrying campaign fields', mutate((v) => { v.firstTouch.source = null; })],
    ['direct last touch', mutate((v) => {
      Object.assign(v.lastNonDirectTouch, { source: null, medium: null, campaign: null });
    })],
    ['last touch before first touch', mutate((v) => { v.lastNonDirectTouch.capturedAt = '2026-09-19T10:00:00.000Z'; })],
    ['beyond future skew', mutate((v) => { v.lastNonDirectTouch.capturedAt = '2026-09-28T12:05:00.001Z'; })],
    ['older than the window', mutate((v) => { v.firstTouch.capturedAt = '2026-08-29T11:59:59.999Z'; })],
    ['parseable but non-canonical time', mutate((v) => { v.firstTouch.capturedAt = 'Sun, 20 Sep 2026 10:00:00 GMT'; })],
    ['time without milliseconds', mutate((v) => { v.firstTouch.capturedAt = '2026-09-20T10:00:00Z'; })],
    ['rolled-over clock time', mutate((v) => { v.firstTouch.capturedAt = '2026-09-20T24:00:00.000Z'; })],
    ['array', '[]'],
    ['null', 'null'],
    ['not JSON', '{version:1'],
    ['oversized', `${' '.repeat(3000)}${serialized}`],
  ];
  for (const [label, raw] of cases) assert.equal(parseAttributionState(raw, OPTS), null, label);
  assert.equal(parseAttributionState(123, OPTS), null);
  assert.equal(parseAttributionState(VALID, OPTS), null, 'only the serialized string form is accepted');
});

test('landings persist the first touch once and advance only the last non-direct touch', () => {
  const storage = memoryStorage();
  const t0 = Date.parse('2026-09-20T10:00:00.000Z');
  recordAttributionLanding({
    storage,
    search: '?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-10-gifts',
    pathname: '/gifts/birthdays',
    now: t0,
  });
  recordAttributionLanding({ storage, search: '', pathname: '/pricing', now: t0 + DAY });
  const final = recordAttributionLanding({
    storage,
    search: '?utm_source=newsletter&utm_medium=email',
    pathname: '/',
    now: t0 + 2 * DAY,
  });
  const expected = {
    version: 1,
    firstTouch: {
      source: 'facebook', medium: 'paid_social', campaign: '2026-10-gifts', content: null, term: null,
      landingPath: '/gifts/birthdays', capturedAt: '2026-09-20T10:00:00.000Z',
    },
    lastNonDirectTouch: {
      source: 'newsletter', medium: 'email', campaign: null, content: null, term: null,
      landingPath: '/', capturedAt: '2026-09-22T10:00:00.000Z',
    },
  };
  assert.deepEqual(final, expected);
  assert.deepEqual(JSON.parse(storage.map.get(ATTRIBUTION_STORAGE_KEY)!), expected);
});

test('an invalid, tampered, or expired stored value cannot suppress recapture', () => {
  const landing = { search: '?utm_source=instagram&utm_medium=paid_social', pathname: '/', now: NOW };
  const touch = {
    source: 'instagram', medium: 'paid_social', campaign: null, content: null, term: null,
    landingPath: '/', capturedAt: '2026-09-28T12:00:00.000Z',
  };
  const tampered = [
    'not json',
    JSON.stringify({ version: 1, firstTouch: { source: 'x' } }),
    JSON.stringify({ ...VALID, email: 'jane@example.com' }),
    JSON.stringify({ ...VALID, firstTouch: { ...VALID.firstTouch, capturedAt: '2026-08-01T00:00:00.000Z' } }),
    JSON.stringify({ ...VALID, lastNonDirectTouch: { ...VALID.lastNonDirectTouch!, capturedAt: '2027-01-01T00:00:00.000Z' } }),
  ];
  for (const raw of tampered) {
    const storage = memoryStorage({ [ATTRIBUTION_STORAGE_KEY]: raw });
    const state = recordAttributionLanding({ storage, ...landing });
    assert.deepEqual(state, { version: 1, firstTouch: touch, lastNonDirectTouch: touch }, raw);
    assert.deepEqual(JSON.parse(storage.map.get(ATTRIBUTION_STORAGE_KEY)!), state, raw);
  }
});

test('unavailable storage never throws and still yields the current landing', () => {
  const throwing = {
    getItem(): string | null { throw new Error('SecurityError'); },
    setItem(): void { throw new Error('QuotaExceededError'); },
  };
  const state = recordAttributionLanding({ storage: throwing, search: '?utm_source=facebook', pathname: '/', now: NOW });
  assert.equal(state?.firstTouch.source, 'facebook');
  assert.equal(recordAttributionLanding({ storage: null, search: '', pathname: '/', now: NOW })?.firstTouch.landingPath, '/');
});

// ── Stripe metadata ─────────────────────────────────────────────────────────

test('Stripe metadata carries the touches as flat bounded keys and nothing else', () => {
  assert.deepEqual(attributionToStripeMetadata(VALID), {
    hsbAttrV: '1',
    hsbFtSrc: 'facebook',
    hsbFtMed: 'paid_social',
    hsbFtCmp: '2026-10-gifts',
    hsbFtPath: '/',
    hsbFtAt: '2026-09-20T10:00:00.000Z',
    hsbLtSrc: 'instagram',
    hsbLtMed: 'paid_social',
    hsbLtCmp: '2026-10-gifts',
    hsbLtPath: '/',
    hsbLtAt: '2026-09-25T10:00:00.000Z',
  });
  assert.deepEqual(attributionToStripeMetadata(null), {});
  assert.deepEqual(
    attributionToStripeMetadata({ version: 1, firstTouch: direct('2026-09-20T10:00:00.000Z', '/pricing'), lastNonDirectTouch: null }),
    { hsbAttrV: '1', hsbFtPath: '/pricing', hsbFtAt: '2026-09-20T10:00:00.000Z' },
  );
});

test('metadata is revalidated on read: extras ignored, an invalid first touch refuses everything', () => {
  const md = attributionToStripeMetadata(VALID);
  assert.deepEqual(attributionFromStripeMetadata(md, { now: NOW }), VALID);
  assert.deepEqual(
    attributionFromStripeMetadata({ ...md, email: 'jane@example.com', childName: 'Emma', orderId: 'ord_x' }, { now: NOW }),
    VALID,
  );
  assert.equal(attributionFromStripeMetadata({ ...md, hsbFtSrc: 'jane@example.com' }, { now: NOW }), null);
  assert.equal(attributionFromStripeMetadata({ ...md, hsbFtCmp: 'Launch' }, { now: NOW }), null);
  assert.equal(attributionFromStripeMetadata({ ...md, hsbFtPath: '/emma-smith' }, { now: NOW }), null);
  assert.equal(attributionFromStripeMetadata({ ...md, hsbAttrV: '2' }, { now: NOW }), null);
  const { hsbAttrV: _version, ...unversioned } = md;
  assert.equal(attributionFromStripeMetadata(unversioned, { now: NOW }), null);
  assert.equal(attributionFromStripeMetadata({ ...md, hsbFtAt: '2026-10-05T00:00:00.000Z' }, { now: NOW }), null);
  assert.equal(attributionFromStripeMetadata({ ...md, hsbFtAt: 1790000000000 }, { now: NOW }), null);
  for (const bad of [null, 'hsbAttrV=1', ['1'], 42]) {
    assert.equal(attributionFromStripeMetadata(bad, { now: NOW }), null, String(bad));
  }
});

test('an invalid or source-less last touch in metadata drops only the last touch', () => {
  const md = attributionToStripeMetadata(VALID);
  const firstOnly = { ...VALID, lastNonDirectTouch: null };
  assert.deepEqual(attributionFromStripeMetadata({ ...md, hsbLtTrm: 'call me' }, { now: NOW }), firstOnly);
  const { hsbLtSrc: _source, ...sourceless } = md;
  assert.deepEqual(attributionFromStripeMetadata(sourceless, { now: NOW }), firstOnly);
  assert.deepEqual(
    attributionFromStripeMetadata({ ...md, hsbLtAt: '2026-09-19T10:00:00.000Z' }, { now: NOW }),
    firstOnly,
    'a last touch earlier than the first touch is not trusted',
  );
});

test('server acceptance outlasts the browser window by the Checkout Session and retry horizon', () => {
  const aged: AttributionState = { version: 1, firstTouch: campaign('facebook', '2026-08-26T12:00:00.000Z'), lastNonDirectTouch: null };
  assert.equal(parseAttributionState(JSON.stringify(aged), OPTS), null, 'too old to leave the browser');
  assert.deepEqual(
    attributionFromStripeMetadata(attributionToStripeMetadata(aged), { now: NOW }),
    aged,
    'a state accepted at checkout is still trusted when the webhook arrives days later',
  );
  const tooOld: AttributionState = { version: 1, firstTouch: campaign('facebook', '2026-08-01T12:00:00.000Z'), lastNonDirectTouch: null };
  assert.equal(attributionFromStripeMetadata(attributionToStripeMetadata(tooOld), { now: NOW }), null);
});
