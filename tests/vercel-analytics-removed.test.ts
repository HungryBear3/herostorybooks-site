/**
 * Vercel Web Analytics is intentionally absent.
 *
 * `@vercel/analytics@1.6.1` and the hosted insights script send the route
 * (`dp`) and the raw cross-origin `document.referrer` (`r`) outside the reach
 * of `beforeSend`, so a typed 404, a query-string key, or a permissive
 * referring page could reach Vercel verbatim. No redactor can close that, so
 * the sink is removed: no dependency, no import, no mount, no custom-event
 * forwarding. GA4 stays the governed behavioral channel.
 *
 * These tests prove the absence at every layer a regression could re-enter:
 * the manifests, the runtime source, the real emitters under hostile input,
 * and (when a production build is present) the emitted bundles.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { BROWSER_EVENT_CONTRACT } from '../src/lib/analytics-event-contract.ts';
import { track, trackCoverEvent, trackPageView, type CoverEventName, type HsbEventName } from '../src/lib/analytics.ts';
import { withBrowser } from './helpers/analytics-browser-fixture.ts';

const ORIGIN = 'https://herostorybooks.com';
const NOW = Date.parse('2026-09-29T12:00:00.000Z');

// Any of these in runtime source or a shipped bundle means a Vercel Analytics
// client could exist again.
const FORBIDDEN: Array<[string, RegExp]> = [
  ['@vercel/analytics package', /@vercel\/analytics/],
  ['insights endpoint', /\/_vercel\/insights/],
  ['hosted script host', /vercel-scripts/],
  ['analytics queue', /\bvaq\b/],
  ['window.va sink', /window\.va\b/],
  ['removed wrapper', /SafeVercelAnalytics|safe-vercel-analytics/],
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const TEXT = /\.(?:[cm]?[jt]sx?|json|html|css|txt|map)$/;

test('no manifest declares or locks @vercel/analytics', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal('@vercel/analytics' in (pkg[field] ?? {}), false, `package.json ${field}`);
  }
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const root = lock.packages[''];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.equal('@vercel/analytics' in (root[field] ?? {}), false, `package-lock root ${field}`);
  }
  const locked = Object.keys(lock.packages).filter((key) => /(?:^|\/)node_modules\/@vercel\/analytics$/.test(key));
  assert.deepEqual(locked, [], 'no lockfile entry installs @vercel/analytics');
});

test('no runtime source imports, mounts or references a Vercel Analytics client', () => {
  const files = [
    ...walk('src'),
    ...walk('scripts'),
    'middleware.ts',
    'next.config.js',
    'vercel.json',
  ].filter((path) => existsSync(path) && TEXT.test(path));
  assert.ok(files.some((path) => path.endsWith('src/app/layout.tsx')), 'scan reached the root layout');
  assert.ok(files.some((path) => path.endsWith('src/lib/analytics.ts')), 'scan reached the shared emitter');
  const hits: string[] = [];
  for (const path of files) {
    const source = readFileSync(path, 'utf8');
    for (const [label, pattern] of FORBIDDEN) if (pattern.test(source)) hits.push(`${path}: ${label}`);
  }
  assert.deepEqual(hits, []);
  assert.equal(existsSync('src/components/safe-vercel-analytics.tsx'), false);
});

// [label, browser URL, referrer] — every way free text used to reach `dp`/`r`.
const HOSTILE: Array<[string, string, string]> = [
  ['hostile dynamic path', `${ORIGIN}/status/ord_ZQXSYNTH7731?email=jane%40example.com`, ''],
  ['404 free text', `${ORIGIN}/emma-smith-birthday-312-555-0100`, ''],
  ['query-key PII on a param-less route', `${ORIGIN}/checkout?jane-doe-312-555-0100=checkout`, ''],
  ['raw cross-origin referrer', `${ORIGIN}/`, 'https://mail.example/inbox/jane-doe/312-555-0100?email=jane@example.com'],
];
const LEAK = /jane|doe|emma|smith|312|555|0100|zqxsynth|inbox|email=/i;

test('hostile paths, query keys and referrers cannot reach a Vercel sink because none exists', async () => {
  for (const [label, href, referrer] of HOSTILE) {
    await withBrowser({ href, referrer, now: NOW }, (f) => {
      // A pre-existing queue (e.g. a stale injected script) must not be fed either.
      const vaq: unknown[] = [];
      f.win.vaq = vaq;
      trackPageView(new URL(href).pathname);
      for (const [name, spec] of Object.entries(BROWSER_EVENT_CONTRACT)) {
        if (spec.emitter === 'track') track(name as HsbEventName, { page: 'jane-doe', referrer: href });
        else trackCoverEvent(name as CoverEventName, { variant: 'A', page: 'jane-doe' });
      }
      assert.deepEqual(f.vercel, [], `${label}: window.va`);
      assert.deepEqual(vaq, [], `${label}: window.vaq`);
      assert.deepEqual(f.domWrites, [], `${label}: no script is injected`);

      // GA4 still receives every governed event, sanitized.
      const eventCount = Object.keys(BROWSER_EVENT_CONTRACT).length + 1;
      assert.equal(f.gtag.length, eventCount, `${label}: gtag events`);
      assert.equal(f.win.hsbEvents?.length, eventCount - 4, `${label}: buffered track() events`);
      for (const [, , params] of f.gtag as Array<[string, string, Record<string, unknown>]>) {
        assert.equal(params.page_referrer, referrer ? 'https://mail.example' : '', label);
      }
      assert.doesNotMatch(JSON.stringify({ gtag: f.gtag, events: f.win.hsbEvents }), LEAK, label);
    });
  }
});

test('a throwing gtag stays nonfatal', async () => {
  await withBrowser({ href: `${ORIGIN}/checkout`, now: NOW }, (f) => {
    f.win.gtag = () => { throw new Error('gtag exploded'); };
    assert.doesNotThrow(() => track('begin_checkout', { bookFormat: 'digital' }));
    assert.doesNotThrow(() => trackCoverEvent('preview_click', { variant: 'A' }));
    assert.equal(f.win.hsbEvents?.length, 1);
    assert.deepEqual(f.vercel, []);
  });
});

const BUILD_DIRS = ['.next/static', '.next/server'];
const hasBuild = BUILD_DIRS.every((dir) => existsSync(dir));

test(
  'production bundles carry no Vercel Analytics client, endpoint or queue',
  { skip: hasBuild ? false : 'no production build present; run `npm run build` first' },
  () => {
    const hits: string[] = [];
    let scanned = 0;
    for (const dir of BUILD_DIRS) {
      for (const path of walk(dir).filter((file) => TEXT.test(file))) {
        scanned += 1;
        const source = readFileSync(path, 'utf8');
        for (const [label, pattern] of FORBIDDEN) if (pattern.test(source)) hits.push(`${path}: ${label}`);
      }
    }
    assert.ok(scanned > 0, 'the build scan read files');
    assert.deepEqual(hits, []);
  },
);
