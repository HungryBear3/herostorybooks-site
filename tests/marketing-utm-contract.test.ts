import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GOVERNED_UTM_FIELDS,
  UTM_MEDIUM_ALLOWLIST,
  isPiiLikeUtmValue,
  parseGovernedUtms,
  utmQueryString,
  utmTupleKey,
  validateUtmField,
  validateUtmTuple,
} from '../src/lib/marketing/utm-contract.ts';

test('governed fields are exactly the four HSB owns; utm_term is deliberately absent', () => {
  assert.deepEqual([...GOVERNED_UTM_FIELDS], ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']);
  assert.equal((GOVERNED_UTM_FIELDS as readonly string[]).includes('utm_term'), false);
});

test('values are lowercased deterministically and never coerced into validity', () => {
  assert.deepEqual(validateUtmField('utm_source', ' School-Pilot-A '), { ok: true, value: 'school-pilot-a' });
  // A space is not silently removed; the value is rejected instead.
  assert.deepEqual(validateUtmField('utm_source', 'school pilot a'), { ok: false, reason: 'malformed' });
  assert.deepEqual(validateUtmField('utm_source', ''), { ok: false, reason: 'empty' });
  assert.deepEqual(validateUtmField('utm_source', 42), { ok: false, reason: 'not_a_string' });
  assert.deepEqual(validateUtmField('utm_source', 'x'.repeat(41)), { ok: false, reason: 'too_long' });
});

test('utm_medium is a closed vocabulary', () => {
  for (const medium of UTM_MEDIUM_ALLOWLIST) {
    assert.equal(validateUtmField('utm_medium', medium).ok, true, medium);
  }
  for (const medium of ['cpc', 'ppc', 'display', 'banner', 'unknown']) {
    assert.deepEqual(validateUtmField('utm_medium', medium), { ok: false, reason: 'medium_not_allowlisted' });
  }
});

test('token-shaped values that still look like people or identifiers are rejected', () => {
  const piiLike = [
    'jane-at-gmail-com',
    'parent_at_school',
    'sarah-yahoo-inbox',
    '5551234567',
    'ord_synthetic0001',
    'cs_live_a1b2c3d4e5f6',
    'a1b2c3d4e5f60718',
    'review-token-abc',
  ];
  for (const value of piiLike) {
    assert.equal(isPiiLikeUtmValue(value), true, `${value} should read as PII-like`);
    assert.deepEqual(validateUtmField('utm_content', value), { ok: false, reason: 'pii_like' });
  }
});

test('legitimate partner labels containing short year digits still pass', () => {
  for (const value of ['fall-partnership-2026', 'school-pilot-a', 'qr-poster', 'takehome-card']) {
    assert.equal(isPiiLikeUtmValue(value), false, value);
    assert.equal(validateUtmField('utm_campaign', value).ok, true, value);
  }
});

test('parsing drops rejected fields rather than truncating them, and reports why', () => {
  const params = new URLSearchParams(
    'utm_source=School-Pilot-A&utm_medium=cpc&utm_campaign=fall-partnership-2026'
    + '&utm_content=jane-at-gmail-com&utm_term=ignored&childName=PrivateName',
  );
  const { utms, rejected } = parseGovernedUtms(params);
  assert.deepEqual(utms, { utm_source: 'school-pilot-a', utm_campaign: 'fall-partnership-2026' });
  assert.deepEqual(rejected, [
    { field: 'utm_medium', reason: 'medium_not_allowlisted' },
    { field: 'utm_content', reason: 'pii_like' },
  ]);
  // utm_term and childName are not governed fields and never appear at all.
  assert.equal(JSON.stringify(utms).includes('PrivateName'), false);
  assert.equal(Object.keys(utms).includes('utm_term'), false);
});

test('parsing accepts a plain object as well as URLSearchParams', () => {
  const { utms } = parseGovernedUtms({ utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'fall-paid-test-2026' });
  assert.deepEqual(utms, { utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'fall-paid-test-2026' });
});

test('a tuple requires source, medium, and campaign; content is optional', () => {
  const ok = validateUtmTuple({ utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'fall-paid-test-2026' });
  assert.equal(ok.ok, true);

  const missing = validateUtmTuple({ utm_source: 'meta' });
  assert.equal(missing.ok, false);
  assert.ok((missing as { errors: string[] }).errors.includes('utm.utm_medium is required'));
  assert.ok((missing as { errors: string[] }).errors.includes('utm.utm_campaign is required'));
});

test('a tuple rejects ungoverned extra fields instead of ignoring them', () => {
  const result = validateUtmTuple({
    utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'c', utm_term: 'kids books',
  });
  assert.equal(result.ok, false);
  assert.ok((result as { errors: string[] }).errors.some((e) => e.includes('utm_term is not a governed field')));
});

test('collision keys distinguish tuples that differ only by content', () => {
  const base = { utm_source: 'school-pilot-a', utm_medium: 'partner', utm_campaign: 'fall-partnership-2026' };
  assert.notEqual(utmTupleKey({ ...base, utm_content: 'card' }), utmTupleKey({ ...base, utm_content: 'newsletter' }));
  assert.equal(utmTupleKey(base), utmTupleKey({ ...base }));
});

test('the rendered query string carries only governed fields, in a stable order', () => {
  assert.equal(
    utmQueryString({ utm_source: 'school-pilot-a', utm_medium: 'partner', utm_campaign: 'fall-partnership-2026', utm_content: 'takehome-card' }),
    'utm_source=school-pilot-a&utm_medium=partner&utm_campaign=fall-partnership-2026&utm_content=takehome-card',
  );
});
