/**
 * GA anonymous identity, read fail-closed from bounded first-party cookies.
 *
 * The client id comes from `_ga`; the session id and session number come only
 * from the property's own `_ga_<container>` cookie. Anything ambiguous,
 * malformed, oversized, or named even slightly differently yields nothing.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  HSB_GA4_MEASUREMENT_ID,
  readGaCookieIdentity,
  sanitizeGaSessionId,
  sanitizeGaSessionNumber,
} from '../src/lib/ga-cookie-identity.ts';
import { sanitizeGaClientId } from '../src/lib/ga4-purchase.ts';

const GA = '_ga=GA1.1.123456789.1727500000';
const GS2 = '_ga_68FKEDZEG3=GS2.1.s1727500000$o3$g1$t1727500100$j60$l0$h11223344';
const CLIENT = '123456789.1727500000';
const NONE = { clientId: null, sessionId: null, sessionNumber: null };
const CLIENT_ONLY = { clientId: CLIENT, sessionId: null, sessionNumber: null };

test('the session cookie is read for the same GA property the root layout loads', () => {
  const layout = readFileSync('src/app/layout.tsx', 'utf8');
  assert.equal(HSB_GA4_MEASUREMENT_ID, layout.match(/const googleAnalyticsMeasurementId = '([^']+)'/)?.[1]);
});

test('reads the anonymous client id and the property-specific GS2 session', () => {
  assert.deepEqual(
    readGaCookieIdentity(`theme=dark; ${GA}; ${GS2}; other=1`, 'G-68FKEDZEG3'),
    { clientId: CLIENT, sessionId: '1727500000', sessionNumber: '3' },
  );
  assert.deepEqual(readGaCookieIdentity(`${GA}; ${GS2}`), { clientId: CLIENT, sessionId: '1727500000', sessionNumber: '3' });
});

test('reads the legacy positional GS1 session layout', () => {
  assert.deepEqual(
    readGaCookieIdentity(`${GA}; _ga_68FKEDZEG3=GS1.1.1727500000.4.1.1727500100.0.0.0`),
    { clientId: CLIENT, sessionId: '1727500000', sessionNumber: '4' },
  );
});

test('only the exact property cookie supplies a session; look-alike names fail closed', () => {
  assert.deepEqual(readGaCookieIdentity(`${GA}; _ga_OTHERPROP1=GS2.1.s1727400000$o9$g1$t1727400100`), CLIENT_ONLY);
  for (const name of ['_ga_68fkedzeg3', 'x_ga_68FKEDZEG3', '_ga_68FKEDZEG3X', '_GA_68FKEDZEG3', '_ga_68FKEDZEG', '_ga%5F68FKEDZEG3']) {
    assert.deepEqual(readGaCookieIdentity(`${GA}; ${name}=GS2.1.s1727500000$o3$g1$t1727500100`), CLIENT_ONLY, name);
  }
  for (const name of ['_gax', 'x_ga', '__ga', '_GA']) {
    assert.equal(readGaCookieIdentity(`${name}=GA1.1.123456789.1727500000`).clientId, null, name);
  }
});

test('a duplicated GA cookie is ambiguous and fails closed', () => {
  assert.deepEqual(readGaCookieIdentity(`${GS2}; ${GA}; ${GS2}`), CLIENT_ONLY);
  assert.deepEqual(
    readGaCookieIdentity(`${GA}; _ga=GA1.1.987654321.1727400000; ${GS2}`),
    { clientId: null, sessionId: '1727500000', sessionNumber: '3' },
  );
});

test('malformed percent-encoding fails closed without throwing; clean encoding decodes', () => {
  assert.deepEqual(
    readGaCookieIdentity('_ga=GA1.1.123%E0%A4%A.456; _ga_68FKEDZEG3=GS2.1.s1727500000%E0%A4%A$o3'),
    NONE,
  );
  assert.deepEqual(
    readGaCookieIdentity(`${GA}; _ga_68FKEDZEG3=GS2.1.s1727500000%24o3%24g1`),
    { clientId: CLIENT, sessionId: '1727500000', sessionNumber: '3' },
  );
});

test('malformed session cookies fail closed', () => {
  const badSessions = [
    'GS2.1.s1727500000$o3$s1727500001',
    'GS2.1.s1727500000$o3$o4',
    'GS2.1.s17275$o3',
    'GS2.1.s1727500000',
    'GS2.1.s1727500000$o0',
    'GS2.1.s1727500000$o1234567',
    'GS2.1.s1727500000$o3$x<script>',
    'GS2.1.s0727500000$o3',
    'GS3.1.s1727500000$o3',
    'GS1.1.1727500000.x.1.1727500100',
    'GS1.1.1727500000',
    '',
  ];
  for (const value of badSessions) {
    assert.deepEqual(readGaCookieIdentity(`${GA}; _ga_68FKEDZEG3=${value}`), CLIENT_ONLY, value);
  }
  for (const value of ['GA1.1.123', 'GA2.1.123.456', 'GA1.1.123.456.789', 'GA1.1.abc.456', 'parent@example.com', '']) {
    assert.equal(readGaCookieIdentity(`_ga=${value}`).clientId, null, value);
  }
});

test('the hashed user-id segment is never read or returned', () => {
  assert.doesNotMatch(JSON.stringify(readGaCookieIdentity(`${GA}; ${GS2}`)), /11223344/);
});

test('input is bounded: oversized headers, too many pairs, or oversized values fail closed', () => {
  assert.deepEqual(readGaCookieIdentity(`${GA}; ${GS2}; pad=${'x'.repeat(17_000)}`), NONE);
  const many = Array.from({ length: 201 }, (_, i) => `c${i}=1`).join('; ');
  assert.deepEqual(readGaCookieIdentity(`${GA}; ${GS2}; ${many}`), NONE);
  assert.equal(readGaCookieIdentity(`_ga=GA1.1.123456789.1727500000${'0'.repeat(300)}`).clientId, null);
  for (const header of [undefined, null, 42, {}]) assert.deepEqual(readGaCookieIdentity(header), NONE);
});

test('an invalid measurement id never yields a session', () => {
  for (const id of ['68FKEDZEG3', 'G-', 'G-68fk!', 'UA-12345-1', '']) {
    assert.deepEqual(readGaCookieIdentity(`${GA}; ${GS2}`, id), CLIENT_ONLY, id);
  }
});

test('session validators accept only a 10-digit Unix time and a bounded positive count', () => {
  assert.equal(sanitizeGaSessionId('1727500000'), '1727500000');
  for (const bad of ['0727500000', '172750000', '17275000000', '1727500000.5', ' 1727500000', 1727500000, null]) {
    assert.equal(sanitizeGaSessionId(bad), null, String(bad));
  }
  assert.equal(sanitizeGaSessionNumber('1'), '1');
  assert.equal(sanitizeGaSessionNumber('999999'), '999999');
  for (const bad of ['0', '1000000', '01', '-1', '1.5', 3, '']) {
    assert.equal(sanitizeGaSessionNumber(bad), null, String(bad));
  }
});

test('the server client-id validator keeps its shape and trimming contract', () => {
  assert.equal(sanitizeGaClientId(' 123.456 '), '123.456');
  assert.equal(sanitizeGaClientId('GA1.1.123.456'), null);
  assert.equal(sanitizeGaClientId(CLIENT), CLIENT);
});
