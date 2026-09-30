import assert from 'node:assert/strict';
import test from 'node:test';
import { track, trackPageView, trackCoverEvent } from '../src/lib/analytics.ts';
import { ATTRIBUTION_STORAGE_KEY, recordBrowserAttributionLanding } from '../src/lib/attribution-contract.ts';

const LEGACY = 'hsb:first-touch-campaign:v1';
const forbidden = /312-555-0100|jane-doe|jane@example\.com|private free text|utm_term|campaign_term|"ref"/;
function fixture(run: (f: ReturnType<typeof browser>) => void) {
  const old = { window: globalThis.window, document: globalThis.document };
  const f = browser();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: f.win });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://example.com/jane-doe/312-555-0100?email=jane@example.com' } });
  try { run(f); } finally {
    for (const key of ['window', 'document'] as const) {
      if (old[key] === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, { configurable: true, value: old[key] });
    }
  }
}
function browser() {
  const local = new Map<string, string>();
  const legacy = new Map<string, string>();
  const writes: string[] = [];
  const ga: unknown[][] = [];
  const vercel: unknown[][] = [];
  const storage = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  });
  const win = {
    location: new URL('https://herostorybooks.com/'),
    localStorage: storage(local), sessionStorage: storage(legacy),
    gtag: (...args: unknown[]) => { ga.push(JSON.parse(JSON.stringify(args))); },
    va: (...args: unknown[]) => { vercel.push(JSON.parse(JSON.stringify(args))); },
    hsbEvents: [] as Record<string, unknown>[],
  };
  const serialized = () => JSON.stringify({ ga, vercel, events: win.hsbEvents });
  return { win, local, legacy, writes, ga, vercel, serialized };
}

for (const transition of ['partial', 'direct', 'tampered'] as const) {
  test(`complete event-scoped GA campaign projection: full → ${transition}`, () => fixture((f) => {
    const full = { campaign_source: 'facebook', campaign_medium: 'paid_social', campaign_name: 'launch', campaign_content: 'video-a' };
    const empty = { campaign_source: '', campaign_medium: '', campaign_name: '', campaign_content: '' };
    f.win.location.search = '?utm_source=facebook&utm_medium=paid_social&utm_campaign=launch&utm_content=video-a';
    recordBrowserAttributionLanding();
    trackPageView('/');
    if (transition === 'partial') {
      f.win.location.search = '?utm_source=newsletter&utm_medium=email';
      recordBrowserAttributionLanding();
    } else {
      f.win.location.search = '';
      if (transition === 'direct') {
        f.local.clear(); // No governed touch remains (not ordinary last-touch-preserving navigation).
        recordBrowserAttributionLanding();
      } else {
        const stored = JSON.parse(f.local.get(ATTRIBUTION_STORAGE_KEY)!);
        stored.lastNonDirectTouch.content = 'jane-doe';
        f.local.set(ATTRIBUTION_STORAGE_KEY, JSON.stringify(stored));
      }
    }
    trackPageView('/');
    f.win.location = new URL('https://herostorybooks.com/checkout');
    track('begin_checkout', { bookFormat: 'digital', campaign_name: 'untrusted', utm_term: 'private free text' });
    trackCoverEvent('preview_click', { variant: 'a', campaign_content: 'untrusted' });
    const next = transition === 'partial'
      ? { ...empty, campaign_source: 'newsletter', campaign_medium: 'email' } : empty;
    const sequence = f.ga.map(([command, name, props]) => [command, name,
      Object.fromEntries(Object.entries((props ?? {}) as Record<string, unknown>).filter(([key]) => key.startsWith('campaign_')))]);
    assert.deepEqual(sequence, [
      ['event', 'page_view', full], ['event', 'page_view', next],
      ['event', 'begin_checkout', next], ['event', 'preview_click', next],
    ], 'ordered commands must contain only events with all four campaign overrides; sparse global sets leak prior touches');
    assert.equal(f.ga.some(([command]) => command === 'set'), false);
    for (const [, , props] of f.ga) {
      const params = props as Record<string, unknown>;
      assert.equal(params.page_referrer, 'https://example.com');
      assert.match(params.page_location as string, /^https:\/\/herostorybooks\.com\/(?:checkout)?$/);
    }
    assert.equal((f.ga[2][2] as Record<string, unknown>).bookFormat, 'digital');
    for (const props of f.win.hsbEvents) {
      assert.equal(Object.keys(props).some((key) => key.startsWith('campaign_')), false);
    }
    assert.equal(f.vercel.length, 0, 'no event reaches a Vercel Analytics queue');
    assert.doesNotMatch(f.serialized(), forbidden);
  }));
}

for (const legacyPresent of [false, true]) {
  test(`actual page_view and begin_checkout reject hostile URL/storage (legacy=${legacyPresent})`, () => fixture((f) => {
    f.win.location = new URL('https://herostorybooks.com/?utm_source=facebook&utm_medium=email&utm_campaign=private%20free%20text&utm_term=312-555-0100&utm_content=jane-doe&ref=jane@example.com');
    if (legacyPresent) f.legacy.set(LEGACY, JSON.stringify({ utm_source: 'jane@example.com', utm_content: 'jane-doe', utm_term: '312-555-0100', ref: 'private free text' }));
    f.local.set(ATTRIBUTION_STORAGE_KEY, JSON.stringify({ version: 1, firstTouch: { source: 'jane@example.com' } }));
    recordBrowserAttributionLanding();
    trackPageView('/');
    f.win.location = new URL('https://herostorybooks.com/checkout');
    track('begin_checkout', { bookFormat: 'digital' });
    assert.equal(f.ga.filter((c) => c[0] === 'event').length, 2);
    assert.equal(f.vercel.length, 0, 'Vercel Analytics is not a sink for page_view or begin_checkout');
    assert.equal(f.win.hsbEvents.length, 2);
    assert.doesNotMatch(f.serialized(), forbidden);
    for (const event of f.win.hsbEvents) assert.equal(event.utm_source, 'facebook');
    assert.equal(f.writes.filter((key) => key === LEGACY).length, 0);
    assert.equal(f.writes.filter((key) => key === ATTRIBUTION_STORAGE_KEY).length, 1, 'emission never recaptures');
  }));
}

test('governed last non-direct state wins immediately and survives direct navigation without recapture', () => fixture((f) => {
  f.win.location.search = '?utm_source=facebook&utm_medium=paid_social&utm_campaign=launch&utm_content=video-a';
  const first = recordBrowserAttributionLanding();
  trackPageView('/');
  f.win.location.search = '?utm_source=google&utm_medium=cpc&utm_campaign=2026-09-gifts.v2&utm_content=image-b';
  const last = recordBrowserAttributionLanding();
  trackPageView('/');
  f.win.location = new URL('https://herostorybooks.com/checkout');
  const direct = recordBrowserAttributionLanding();
  track('begin_checkout');
  assert.deepEqual(last?.firstTouch, first?.firstTouch);
  assert.deepEqual(direct, last);
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.win.hsbEvents.map((e) => e.utm_source), ['facebook', 'google', 'google']);
  assert.equal(f.ga.some((c) => c[0] === 'set'), false);
  const lastCampaign = Object.fromEntries(Object.entries(f.ga.at(-1)?.[2] as Record<string, unknown>).filter(([key]) => key.startsWith('campaign_')));
  assert.deepEqual(lastCampaign, { campaign_source: 'google', campaign_medium: 'cpc', campaign_name: '2026-09-gifts.v2', campaign_content: 'image-b' });
  assert.equal(f.win.hsbEvents.at(-1)?.utm_campaign, '2026-09-gifts.v2');
  assert.equal(f.vercel.length, 0);
  assert.doesNotMatch(f.serialized(), forbidden);
}));

test('final boundaries ignore caller campaign overrides and revalidate tampered governed state', () => fixture((f) => {
  f.win.location.search = '?utm_source=instagram&utm_medium=social';
  recordBrowserAttributionLanding();
  const hostile = { utm_source: 'jane@example.com', utm_content: 'jane-doe', utm_term: '312-555-0100', campaign_term: 'private free text', campaign_source: 'jane-doe', ref: 'jane@example.com', page_referrer: 'private free text' };
  track('begin_checkout', hostile);
  trackCoverEvent('preview_click', hostile);
  assert.doesNotMatch(f.serialized(), forbidden);
  assert.equal(f.win.hsbEvents[0].utm_source, 'instagram');
  const stored = JSON.parse(f.local.get(ATTRIBUTION_STORAGE_KEY)!);
  stored.lastNonDirectTouch.content = 'jane-doe';
  f.local.set(ATTRIBUTION_STORAGE_KEY, JSON.stringify(stored));
  track('begin_checkout');
  assert.equal(f.win.hsbEvents.at(-1)?.utm_source, undefined, 'tampered storage is not emission authority');
  assert.doesNotMatch(f.serialized(), forbidden);
  assert.equal(f.vercel.length, 0);
}));

test('campaign first touch fallback and direct absence are deterministic', () => fixture((f) => {
  f.win.location.search = '?utm_source=newsletter&utm_medium=email';
  const state = recordBrowserAttributionLanding()!;
  state.lastNonDirectTouch = null;
  f.local.set(ATTRIBUTION_STORAGE_KEY, JSON.stringify(state));
  track('begin_checkout');
  assert.equal(f.win.hsbEvents[0].utm_source, 'newsletter');
  f.local.clear();
  f.win.location.search = '';
  recordBrowserAttributionLanding();
  trackPageView('/');
  assert.equal(f.win.hsbEvents[1].utm_source, undefined);
}));

test('blocked storage retains the validated captured landing without recapturing query', () => fixture((f) => {
  Object.defineProperty(f.win, 'localStorage', { get() { throw new Error('blocked'); } });
  Object.defineProperty(f.win, 'sessionStorage', { get() { throw new Error('blocked'); } });
  f.win.location.search = '?utm_source=pinterest&utm_medium=social&utm_content=image-c';
  recordBrowserAttributionLanding();
  trackPageView('/');
  f.win.location.search = '?utm_source=google&utm_term=312-555-0100';
  track('begin_checkout');
  assert.deepEqual(f.win.hsbEvents.map((e) => e.utm_source), ['pinterest', 'pinterest']);
  assert.doesNotMatch(f.serialized(), forbidden);
}));
