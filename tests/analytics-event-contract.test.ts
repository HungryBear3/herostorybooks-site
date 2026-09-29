/**
 * The checked-in GA4 event contract, executed against the real emitters.
 *
 * `track()` and `trackCoverEvent()` are the only browser writers. Every call
 * they make to gtag, Vercel and the local `hsbEvents` buffer must be exactly
 * the contract's closed parameter set — under a hostile URL (query, fragment,
 * identifier path), a hostile referrer, tampered attribution storage, and
 * hostile caller props — and a purchase can never be written by the browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_EVENT_CONTRACT,
  META_EVENT_CONTRACT,
  checkGa4BrowserEventCall,
  projectBrowserEventParams,
} from '../src/lib/analytics-event-contract.ts';
import { track, trackCoverEvent, trackPageView } from '../src/lib/analytics.ts';
import { ATTRIBUTION_STORAGE_KEY, recordBrowserAttributionLanding } from '../src/lib/attribution-contract.ts';
import {
  CHECKOUT_STEP_BLOCKED_REASONS,
  CHECKOUT_TELEMETRY_STEP_IDS,
  checkoutStepEventProps,
} from '../src/lib/checkout-step-telemetry.ts';
import { STORY_THEMES } from '../src/lib/story-catalog.ts';
import { withBrowser } from './helpers/analytics-browser-fixture.ts';

const NOW = Date.parse('2026-09-28T15:00:00.000Z');
const LEAK = /jane|312-555-0100|example\.com|ord_zqx|token=|childName|utm_term|evil\.example|free text|cs_live/i;
const NO_CAMPAIGN = { campaign_source: '', campaign_medium: '', campaign_name: '', campaign_content: '' };
const TAMPERED_ATTRIBUTION = JSON.stringify({
  version: 1,
  firstTouch: {
    source: 'jane@example.com', medium: null, campaign: null, content: null, term: null,
    landingPath: '/', capturedAt: '2026-09-27T15:00:00.000Z',
  },
  lastNonDirectTouch: null,
});

function assertConforms(calls: unknown[][]) {
  for (const call of calls) assert.deepEqual(checkGa4BrowserEventCall(call), [], JSON.stringify(call));
}

// ── Exact serialized GA4 / Vercel boundary ──────────────────────────────────

test('page_view on an identifier route with hostile query, fragment, referrer and storage is exact', async () => {
  await withBrowser({
    href: 'https://herostorybooks.com/status/ord_ZQXSYNTH7731?email=jane%40example.com&childName=Jane#token=abc',
    referrer: 'https://mail.example/inbox/jane-doe/312-555-0100?email=jane@example.com',
    storage: { [ATTRIBUTION_STORAGE_KEY]: TAMPERED_ATTRIBUTION },
    now: NOW,
  }, (f) => {
    recordBrowserAttributionLanding();
    trackPageView('/status/ord_ZQXSYNTH7731');

    assert.deepEqual(f.gtag, [['event', 'page_view', {
      timestamp: NOW,
      pathname: '/status/[orderId]',
      ...NO_CAMPAIGN,
      page_location: 'https://herostorybooks.com/status/[orderId]',
      page_referrer: 'https://mail.example',
    }]]);
    assert.deepEqual(f.win.hsbEvents, [{
      event: 'page_view', timestamp: NOW, href: 'https://herostorybooks.com/status/[orderId]', pathname: '/status/[orderId]',
    }]);
    assert.deepEqual(f.vercel, [], 'page views are not forwarded as Vercel custom events');
    assertConforms(f.gtag);
  });
});

test('begin_checkout keeps only contract params and the governed campaign under hostile caller props', async () => {
  await withBrowser({
    href: 'https://herostorybooks.com/checkout?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-10-holiday'
      + '&utm_content=video-a&utm_term=jane-doe&childName=Jane&email=jane%40example.com#step',
    referrer: 'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4e5F6#fidkdWxOYHwnPyd1blpxYHZxWjA0',
    now: NOW,
  }, (f) => {
    recordBrowserAttributionLanding();
    const record = track('begin_checkout', {
      email: 'jane@example.com',
      childName: 'Jane',
      utm_source: 'jane-doe',
      campaign_name: 'free text',
      page_referrer: 'https://evil.example/jane-doe',
      href: 'https://evil.example/?q=jane',
      pathname: '/jane-doe/312-555-0100',
      timestamp: 1,
      bookFormat: 'premium',
    });

    const governed = {
      utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: '2026-10-holiday', utm_content: 'video-a',
    };
    assert.deepEqual(record, {
      event: 'begin_checkout', timestamp: NOW, href: 'https://herostorybooks.com/checkout', pathname: '/checkout',
      bookFormat: 'premium', ...governed,
    });
    assert.deepEqual(f.gtag, [['event', 'begin_checkout', {
      timestamp: NOW,
      pathname: '/checkout',
      bookFormat: 'premium',
      ...governed,
      campaign_source: 'facebook',
      campaign_medium: 'paid_social',
      campaign_name: '2026-10-holiday',
      campaign_content: 'video-a',
      page_location: 'https://herostorybooks.com/checkout',
      page_referrer: '',
      ignore_referrer: true,
    }]]);
    assert.deepEqual(f.vercel, [['event', {
      name: 'begin_checkout',
      data: { timestamp: NOW, pathname: '/checkout', bookFormat: 'premium', ...governed },
    }]]);
    assertConforms(f.gtag);
    assert.doesNotMatch(JSON.stringify({ gtag: f.gtag, vercel: f.vercel, events: f.win.hsbEvents }), LEAK);
  });
});

test('checkout step events from the real prop builder serialize exactly', async () => {
  await withBrowser({
    href: 'https://herostorybooks.com/checkout?childName=Jane%20Doe',
    referrer: 'https://mail.example/jane-doe',
    now: NOW,
  }, (f) => {
    track('checkout_step_view', checkoutStepEventProps('hero-details', 'digital'));
    track('checkout_step_blocked', { ...checkoutStepEventProps('people', 'premium'), reason: 'email_required' });
    track('checkout_step_complete', checkoutStepEventProps('review', 'unknown-format'));

    const layer = {
      timestamp: NOW, pathname: '/checkout', ...NO_CAMPAIGN,
      page_location: 'https://herostorybooks.com/checkout', page_referrer: 'https://mail.example',
    };
    assert.deepEqual(f.gtag, [
      ['event', 'checkout_step_view', {
        ...layer, step_id: 'hero-details', step_number: 1, total_steps: 4, selected_format: 'digital',
      }],
      ['event', 'checkout_step_blocked', {
        ...layer, step_id: 'people', step_number: 3, total_steps: 4, selected_format: 'premium', reason: 'email_required',
      }],
      ['event', 'checkout_step_complete', {
        ...layer, step_id: 'review', step_number: 4, total_steps: 4, selected_format: null,
      }],
    ]);
    assertConforms(f.gtag);
  });
});

test('a storage-restored free-text theme never reaches a vendor; catalog themes still do', async () => {
  await withBrowser({ href: 'https://herostorybooks.com/checkout', now: NOW }, (f) => {
    const hostile = { theme: 'Jane Doe 312-555-0100', bookFormat: 'premium', hasPhoto: true, hasVoice: false, familyCharacterCount: 2 };
    track('order_submit_attempt', hostile);
    track('purchase_intent', hostile);
    track('story_selected', { theme: 'brave-explorer' });
    track('story_selected', { theme: 'jane@example.com' });

    const layer = {
      timestamp: NOW, pathname: '/checkout', ...NO_CAMPAIGN,
      page_location: 'https://herostorybooks.com/checkout', page_referrer: '',
    };
    const intent = { bookFormat: 'premium', hasPhoto: true, hasVoice: false, familyCharacterCount: 2 };
    assert.deepEqual(f.gtag, [
      ['event', 'order_submit_attempt', { ...layer, ...intent }],
      ['event', 'purchase_intent', { ...layer, ...intent }],
      ['event', 'story_selected', { ...layer, theme: 'brave-explorer' }],
      ['event', 'story_selected', { ...layer }],
    ]);
    assert.deepEqual(f.vercel.map((call) => (call[1] as { data: unknown }).data), [
      { timestamp: NOW, pathname: '/checkout', ...intent },
      { timestamp: NOW, pathname: '/checkout', ...intent },
      { timestamp: NOW, pathname: '/checkout', theme: 'brave-explorer' },
      { timestamp: NOW, pathname: '/checkout' },
    ]);
    assertConforms(f.gtag);
    assert.doesNotMatch(JSON.stringify({ gtag: f.gtag, vercel: f.vercel, events: f.win.hsbEvents }), LEAK);
  });
});

test('cover events carry only the closed variant; a free-form page label is dropped', async () => {
  await withBrowser({ href: 'https://herostorybooks.com/?utm_source=google&utm_medium=cpc', now: NOW }, (f) => {
    recordBrowserAttributionLanding();
    trackCoverEvent('cover_variant_shown', { variant: 'B', page: 'jane-doe-312-555-0100' });
    trackCoverEvent('preview_click', { variant: 'jane-doe' });

    const layer = {
      utm_source: 'google', utm_medium: 'cpc',
      campaign_source: 'google', campaign_medium: 'cpc', campaign_name: '', campaign_content: '',
      page_location: 'https://herostorybooks.com/', page_referrer: '',
    };
    assert.deepEqual(f.gtag, [
      ['event', 'cover_variant_shown', { variant: 'B', ...layer }],
      ['event', 'preview_click', { ...layer }],
    ]);
    assert.deepEqual(f.vercel, [
      ['event', { name: 'cover_variant_shown', data: { variant: 'B', utm_source: 'google', utm_medium: 'cpc' } }],
      ['event', { name: 'preview_click', data: { utm_source: 'google', utm_medium: 'cpc' } }],
    ]);
    assertConforms(f.gtag);
  });
});

test('no browser writer can emit a purchase or an undeclared event', async () => {
  await withBrowser({ href: 'https://herostorybooks.com/thank-you?session_id=cs_live_a1B2c3D4e5F6', now: NOW }, (f) => {
    assert.equal(track('purchase' as never, { value: 19, transaction_id: 'cs_live_a1B2c3D4e5F6' }), null);
    assert.equal(track('Purchase' as never), null);
    assert.equal(track(' PURCHASE ' as never), null);
    assert.equal(track('refund' as never, { value: 19 }), null);
    trackCoverEvent('purchase' as never, { variant: 'A' });
    trackCoverEvent('jane_doe' as never, { variant: 'A' });

    assert.deepEqual(f.gtag, []);
    assert.deepEqual(f.vercel, []);
    assert.deepEqual(f.win.hsbEvents, []);
  });
});

test('a throwing caller prop cannot throw into the UI and is not forwarded', async () => {
  await withBrowser({ href: 'https://herostorybooks.com/checkout', now: NOW }, (f) => {
    const props = { bookFormat: 'classic' } as Record<string, unknown>;
    Object.defineProperty(props, 'theme', { enumerable: true, get() { throw new Error('hostile getter'); } });
    const record = track('order_submit_attempt', props as never);
    assert.equal(record?.bookFormat, 'classic');
    assert.equal(Object.hasOwn(record ?? {}, 'theme'), false);
    assert.equal(f.gtag.length, 1);
  });
});

// ── Projection: the contract admits every live value and nothing else ───────

test('projection keeps every value the real prop builders and catalogs produce', () => {
  for (const step of CHECKOUT_TELEMETRY_STEP_IDS) {
    for (const format of ['digital', 'classic', 'premium', null, 'bogus']) {
      const props = checkoutStepEventProps(step, format);
      assert.deepEqual(projectBrowserEventParams('checkout_step_view', props), props);
      assert.deepEqual(projectBrowserEventParams('checkout_step_complete', props), props);
      for (const reason of CHECKOUT_STEP_BLOCKED_REASONS) {
        assert.deepEqual(projectBrowserEventParams('checkout_step_blocked', { ...props, reason }), { ...props, reason });
      }
    }
  }
  for (const theme of STORY_THEMES.map((entry) => entry.id)) {
    assert.deepEqual(projectBrowserEventParams('story_selected', { theme }), { theme });
  }
  assert.deepEqual(
    projectBrowserEventParams('name_preview_submitted', { has_name: true, preview_name_length: 5 }),
    { has_name: true, preview_name_length: 5 },
  );
  assert.deepEqual(
    projectBrowserEventParams('order_submit_attempt', {
      theme: null, bookFormat: null, hasPhoto: false, hasVoice: true, familyCharacterCount: 0,
    }),
    { theme: null, bookFormat: null, hasPhoto: false, hasVoice: true, familyCharacterCount: 0 },
  );
  assert.deepEqual(projectBrowserEventParams('page_view', { pathname: '/gifts/holidays' }), { pathname: '/gifts/holidays' });
  assert.deepEqual(projectBrowserEventParams('start_checkout', {}), {});
});

test('projection drops undeclared keys and out-of-contract values, and refuses undeclared events', () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown> | null]> = [
    ['order_submit_attempt', {
      theme: 'Jane Doe', bookFormat: 'print', hasPhoto: 'yes', hasVoice: false, familyCharacterCount: 2.5,
      email: 'jane@example.com',
    }, { hasVoice: false }],
    ['checkout_step_view', { step_id: 'people', reason: 'email_required', step_number: 0, total_steps: 5 }, { step_id: 'people' }],
    ['checkout_step_blocked', { reason: 'Missing: Jane Doe' }, {}],
    ['name_preview_submitted', { has_name: 1, preview_name_length: -1, child_name: 'Jane' }, {}],
    ['format_selected', { format: 'Premium' }, {}],
    ['proof_approved', { bookFormat: 'digital', orderId: 'ord_ZQXSYNTH7731' }, { bookFormat: 'digital' }],
    ['begin_checkout', { value: 19, currency: 'USD', transaction_id: 'cs_live_x' }, {}],
    ['page_view', { pathname: 'https://evil.example/jane' }, {}],
    ['purchase', { value: 19 }, null],
    ['Purchase', {}, null],
    ['__proto__', {}, null],
    ['toString', {}, null],
  ];
  for (const [event, props, expected] of cases) {
    assert.deepEqual(projectBrowserEventParams(event, props), expected, `${event} ${JSON.stringify(props)}`);
  }
  assert.deepEqual(projectBrowserEventParams('begin_checkout', null), {});
  assert.deepEqual(projectBrowserEventParams('begin_checkout', 'jane' as never), {});
});

// ── The validator catches every boundary defect it exists to catch ──────────

const VALID_STEP_CALL = ['event', 'checkout_step_view', {
  timestamp: NOW,
  pathname: '/checkout',
  step_id: 'people',
  step_number: 3,
  total_steps: 4,
  selected_format: 'premium',
  utm_source: 'facebook',
  utm_medium: 'paid_social',
  utm_campaign: '2026-10-holiday',
  utm_content: 'video-a',
  campaign_source: 'facebook',
  campaign_medium: 'paid_social',
  campaign_name: '2026-10-holiday',
  campaign_content: 'video-a',
  page_location: 'https://herostorybooks.com/checkout',
  page_referrer: '',
}] as const;

function mutated(change: (params: Record<string, unknown>) => void): unknown[] {
  const params = { ...(VALID_STEP_CALL[2] as Record<string, unknown>) };
  change(params);
  return ['event', VALID_STEP_CALL[1], params];
}

test('the browser call validator rejects each defect with a value-free code', () => {
  assert.deepEqual(checkGa4BrowserEventCall([...VALID_STEP_CALL]), []);
  const cases: Array<[string, unknown[], string[]]> = [
    ['undeclared PII param', mutated((p) => { p.email = 'jane@example.com'; }), ['UNDECLARED_PARAM']],
    ['utm_term', mutated((p) => { p.utm_term = 'jane-doe'; }), ['UNDECLARED_PARAM']],
    ['param of another event', mutated((p) => { p.reason = 'email_required'; }), ['UNDECLARED_PARAM']],
    ['sparse campaign projection', mutated((p) => { delete p.campaign_content; }), ['CAMPAIGN_PROJECTION_INCOMPLETE']],
    ['ungoverned campaign value', mutated((p) => { p.campaign_source = 'jane-doe'; }), ['CAMPAIGN_VALUE_UNGOVERNED']],
    ['stale campaign value', mutated((p) => { p.campaign_name = ''; }), ['CAMPAIGN_PROJECTION_MISMATCH']],
    ['campaign without attribution', mutated((p) => { delete p.utm_content; }), ['CAMPAIGN_PROJECTION_MISMATCH']],
    ['query in page_location', mutated((p) => { p.page_location = 'https://herostorybooks.com/checkout?childName=Jane'; }), ['PAGE_LOCATION_NOT_SANITIZED']],
    ['raw identifier path', mutated((p) => { p.page_location = 'https://herostorybooks.com/status/ord_ZQXSYNTH7731'; }), ['PAGE_LOCATION_NOT_SANITIZED']],
    ['referrer path', mutated((p) => { p.page_referrer = 'https://mail.example/jane-doe'; }), ['PAGE_REFERRER_NOT_ORIGIN']],
    ['ignored referrer kept', mutated((p) => { p.ignore_referrer = true; p.page_referrer = 'https://mail.example'; }), ['LAYER_VALUE_INVALID:ignore_referrer']],
    ['bad enum', mutated((p) => { p.step_id = 'jane-doe'; }), ['PARAM_VALUE_INVALID:step_id']],
    ['float timestamp', mutated((p) => { p.timestamp = 1.5; }), ['LAYER_VALUE_INVALID:timestamp']],
    ['query in pathname', mutated((p) => { p.pathname = '/checkout?x=1'; }), ['LAYER_VALUE_INVALID:pathname']],
    ['missing timestamp', mutated((p) => { delete p.timestamp; }), ['LAYER_PARAM_MISSING:timestamp']],
    ['persistent set', ['set', { campaign_source: 'facebook' }], ['PERSISTENT_SET_FORBIDDEN']],
    ['browser purchase', ['event', 'purchase', VALID_STEP_CALL[2]], ['BROWSER_PURCHASE_FORBIDDEN']],
    ['cased browser purchase', ['event', ' Purchase', VALID_STEP_CALL[2]], ['BROWSER_PURCHASE_FORBIDDEN']],
    ['undeclared event', ['event', 'jane_doe', VALID_STEP_CALL[2]], ['UNDECLARED_EVENT']],
    ['non-object params', ['event', 'checkout_step_view', 'jane'], ['PARAMS_SHAPE']],
    ['config command', ['config', 'G-68FKEDZEG3', {}], ['NOT_AN_EVENT_CALL']],
  ];
  for (const [label, call, expected] of cases) {
    assert.deepEqual(checkGa4BrowserEventCall(call), expected, label);
  }
});

test('cover events validate without track-only layer params', () => {
  const cover = ['event', 'cover_variant_shown', {
    variant: 'A', ...NO_CAMPAIGN, page_location: 'https://herostorybooks.com/', page_referrer: '',
  }];
  assert.deepEqual(checkGa4BrowserEventCall(cover), []);
  const withTimestamp = ['event', 'cover_variant_shown', { ...(cover[2] as object), timestamp: NOW }];
  assert.deepEqual(checkGa4BrowserEventCall(withTimestamp), ['UNDECLARED_PARAM']);
});

// ── Contract data invariants ─────────────────────────────────────────────────

test('the contract declares only GA4-valid, non-identifying parameter names and never a browser purchase', () => {
  const identifying = /^(?:e?mail|name|child_?name|first_?name|last_?name|phone|address|order_?id|transaction_id|client_id|user_id|session_id|url|href|referrer|query|search|term|notes?|text|message|coupon)$/i;
  for (const [event, spec] of Object.entries(BROWSER_EVENT_CONTRACT)) {
    assert.notEqual(event.trim().toLowerCase(), 'purchase');
    for (const param of Object.keys(spec.params)) {
      assert.match(param, /^[A-Za-z][A-Za-z0-9_]{0,39}$/, `${event}.${param}`);
      assert.doesNotMatch(param, /^(?:google_|ga_|firebase_)/, `${event}.${param}`);
      assert.doesNotMatch(param, identifying, `${event}.${param}`);
    }
  }
  assert.equal(Object.hasOwn(BROWSER_EVENT_CONTRACT, 'purchase'), false);
  assert.equal(META_EVENT_CONTRACT.Purchase.browser, 'forbidden');
});
