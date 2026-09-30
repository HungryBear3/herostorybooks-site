/**
 * Read-only funnel diagnostics: the exact GA4 request plan, the closed
 * `hsb.funnel_diagnostics` report built from hostile or malformed responses,
 * and the funnel's privacy boundary — hostile URL/referrer/free-text markers
 * never reach an event payload or a report, the browser cannot emit a
 * purchase, no step event is duplicated, and a blocked step carries only its
 * closed reason.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BROWSER_EVENT_CONTRACT, GA4_PURCHASE_CONTRACT, checkGa4BrowserEventCall } from '../src/lib/analytics-event-contract.ts';
import { track } from '../src/lib/analytics.ts';
import { ATTRIBUTION_STORAGE_KEY, recordBrowserAttributionLanding } from '../src/lib/attribution-contract.ts';
import { CHECKOUT_STEP_BLOCKED_REASONS, checkoutStepEventProps } from '../src/lib/checkout-step-telemetry.ts';
import { validateGa4AdminChecklist } from '../src/lib/ga4-admin-checklist.ts';
import { readGa4RunReport } from '../src/lib/ga4-run-report.ts';
import {
  FUNNEL_CUSTOM_DIMENSIONS,
  FUNNEL_MIN_DENOMINATOR,
  FUNNEL_STAGE_IDS,
  buildFunnelReport,
  buildFunnelRequestPlan,
  governFunnelSegment,
  renderFunnelReportText,
  validateFunnelReport,
  type FunnelReport,
  type FunnelRequestPlan,
} from '../src/lib/ga4-funnel-diagnostics.ts';
import { withBrowser } from './helpers/analytics-browser-fixture.ts';

const PROPERTY = '123456789';
const NOW = Date.parse('2026-09-29T15:00:00.000Z');
/** Markers planted in every hostile input; none may appear in any output. */
const LEAK = /jane|312-555-0100|example\.com|ord_zqx|token=|childname|utm_term|evil|free text|cs_live|<script|secret/i;
const CHECKLIST = JSON.parse(readFileSync(new URL('../config/analytics/ga4-admin-checklist.v1.json', import.meta.url), 'utf8'));

function plan(breakdown = 'none'): FunnelRequestPlan {
  const built = buildFunnelRequestPlan({ propertyId: PROPERTY, startDate: '2026-09-01', endDate: '2026-09-28', breakdown });
  assert.ok(built.ok);
  return built.plan;
}

type Rows = string[][];

/** A GA4 `runReport` response to one plan request: dimension cells then metric cells per row. */
function response(planDoc: FunnelRequestPlan, id: string, rows: Rows, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const request = planDoc.requests.find((item) => item.id === id)!;
  const dimensions = (request.body.dimensions as Array<{ name: string }>).map((item) => item.name);
  const metrics = (request.body.metrics as Array<{ name: string }>).map((item) => item.name);
  const doc: Record<string, unknown> = {
    kind: 'analyticsData#runReport',
    dimensionHeaders: dimensions.map((name) => ({ name })),
    metricHeaders: metrics.map((name) => ({ name, type: 'TYPE_INTEGER' })),
    metadata: { currencyCode: 'USD', timeZone: 'America/Chicago' },
  };
  if (rows.length > 0) {
    doc.rows = rows.map((row) => ({
      dimensionValues: row.slice(0, dimensions.length).map((value) => ({ value })),
      metricValues: row.slice(dimensions.length).map((value) => ({ value })),
    }));
    doc.rowCount = rows.length;
  }
  return { ...doc, ...extra };
}

const TRAFFIC: Rows = [['1000', '800']];
const EVENTS: Rows = [
  ['name_preview_submitted', '120', '130'],
  ['checkout_step_view', '300', '420'],
  ['order_submit_attempt', '60', '66'],
  ['purchase', '40', '40'],
];
const STEPS: Rows = [
  ['checkout_step_view', 'hero-details', '290', '300'],
  ['checkout_step_complete', 'hero-details', '220', '230'],
  ['checkout_step_view', 'hero-appearance', '215', '220'],
  ['checkout_step_complete', 'hero-appearance', '170', '180'],
  ['checkout_step_view', 'people', '165', '170'],
  ['checkout_step_complete', 'people', '150', '150'],
  ['checkout_step_view', 'review', '140', '150'],
  ['checkout_step_complete', 'review', '60', '70'],
  ['checkout_step_blocked', 'hero-details', '90', '140'],
  ['checkout_step_blocked', 'hero-appearance', '50', '60'],
  ['checkout_step_blocked', 'people', '10', '12'],
  ['checkout_step_blocked', 'review', '5', '5'],
];
const BLOCKED: Rows = [
  ['hero-details', 'hero_name_required', '70', '100'],
  ['hero-details', 'story_direction_required', '30', '40'],
  ['hero-appearance', 'hero_appearance_required', '50', '60'],
  ['people', 'family_member_incomplete', '10', '12'],
  ['review', 'email_required', '5', '5'],
];

function responses(planDoc: FunnelRequestPlan, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const data: Record<string, Rows> = { traffic: TRAFFIC, events: EVENTS, steps: STEPS, blocked: BLOCKED };
  const out: Record<string, unknown> = {};
  for (const request of planDoc.requests) out[request.id] = response(planDoc, request.id, data[request.id]);
  return { ...out, ...overrides };
}

function report(planDoc: FunnelRequestPlan, overrides: Record<string, unknown> = {}): FunnelReport {
  const result = buildFunnelReport(planDoc, responses(planDoc, overrides));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(validateFunnelReport(result.report), []);
  return result.report;
}

function stage(doc: FunnelReport, stageId: string, segment = 0) {
  return doc.segments[segment].stages.find((item) => item.stage_id === stageId)!;
}

// ── The request plan ────────────────────────────────────────────────────────

test('the plan is exact read-only runReport requests with closed event filters', () => {
  const doc = plan();
  assert.deepEqual(doc.requests.map((item) => item.id), ['traffic', 'events', 'steps', 'blocked']);
  for (const request of doc.requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`);
    assert.equal(request.oauthScope, 'https://www.googleapis.com/auth/analytics.readonly');
    assert.deepEqual(request.body.dateRanges, [{ startDate: '2026-09-01', endDate: '2026-09-28' }]);
  }
  assert.deepEqual(doc.requests[0].body, {
    dateRanges: [{ startDate: '2026-09-01', endDate: '2026-09-28' }],
    dimensions: [],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
    keepEmptyRows: false,
    limit: '10000',
  });
  assert.deepEqual(doc.requests[1].body.dimensionFilter, {
    filter: {
      fieldName: 'eventName',
      inListFilter: { values: ['name_preview_submitted', 'checkout_step_view', 'order_submit_attempt', 'purchase'], caseSensitive: true },
    },
  });
  assert.deepEqual(doc.requests[3].body.dimensionFilter, {
    filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'checkout_step_blocked', caseSensitive: true } },
  });
  // Neither the alias nor the submit-time begin_checkout is read.
  assert.doesNotMatch(JSON.stringify(doc), /purchase_intent|begin_checkout/);
});

test('each breakdown adds exactly one GA4 dimension; selected_format reads only the step events', () => {
  const lead = (breakdown: string) => plan(breakdown).requests.map((item) => (item.body.dimensions as Array<{ name: string }>)[0]?.name);
  assert.deepEqual(lead('device_category'), ['deviceCategory', 'deviceCategory', 'deviceCategory', 'deviceCategory']);
  assert.deepEqual(lead('landing_route'), ['landingPage', 'landingPage', 'landingPage', 'landingPage']);
  assert.deepEqual(lead('campaign'), ['sessionCampaignName', 'sessionCampaignName', 'sessionCampaignName', 'sessionCampaignName']);
  const format = plan('selected_format');
  assert.deepEqual(format.requests.map((item) => item.id), ['steps', 'blocked']);
  assert.deepEqual(lead('selected_format'), ['customEvent:selected_format', 'customEvent:selected_format']);
});

test('the plan refuses invalid input with a closed reason', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ propertyId: 'properties/1', startDate: '2026-09-01', endDate: '2026-09-02' }, 'PROPERTY_ID_INVALID'],
    [{ propertyId: PROPERTY, startDate: '2026-02-30', endDate: '2026-09-02' }, 'DATE_INVALID'],
    [{ propertyId: PROPERTY, startDate: '7daysAgo', endDate: 'today' }, 'DATE_INVALID'],
    [{ propertyId: PROPERTY, startDate: '2026-09-02', endDate: '2026-09-01' }, 'DATE_RANGE_INVALID'],
    [{ propertyId: PROPERTY, startDate: '2025-01-01', endDate: '2026-09-01' }, 'DATE_RANGE_INVALID'],
    [{ propertyId: PROPERTY, startDate: '2026-09-01', endDate: '2026-09-02', breakdown: 'pagePath' }, 'BREAKDOWN_INVALID'],
    [{ propertyId: PROPERTY, startDate: '2026-09-01', endDate: '2026-09-02', breakdown: 'toString' }, 'BREAKDOWN_INVALID'],
  ];
  for (const [input, reason] of cases) {
    assert.deepEqual(buildFunnelRequestPlan(input as never), { ok: false, reason }, JSON.stringify(input));
  }
  assert.deepEqual(buildFunnelRequestPlan(null as never), { ok: false, reason: 'PROPERTY_ID_INVALID' });
});

test('every custom dimension the plan reads is an event-scoped, pending checklist dimension; only purchase is a key event', () => {
  assert.deepEqual(validateGa4AdminChecklist(CHECKLIST), []);
  const read = new Set<string>();
  for (const breakdown of ['none', 'device_category', 'landing_route', 'campaign', 'selected_format']) {
    for (const request of plan(breakdown).requests) {
      for (const { name } of request.body.dimensions as Array<{ name: string }>) {
        if (name.startsWith('customEvent:')) read.add(name.slice('customEvent:'.length));
      }
    }
  }
  assert.deepEqual([...read].sort(), [...FUNNEL_CUSTOM_DIMENSIONS].sort());
  for (const name of read) {
    const entry = CHECKLIST.custom_dimensions.find((item: { parameter_name: string }) => item.parameter_name === name);
    assert.equal(entry?.scope, 'EVENT', name);
    assert.equal(entry?.status, 'owner_action_pending', name);
  }
  assert.deepEqual(CHECKLIST.key_events.map((item: { event_name: string }) => item.event_name), ['purchase']);
  const notKey = CHECKLIST.not_key_events.map((item: { event_name: string }) => item.event_name);
  for (const event of ['page_view', 'name_preview_submitted', 'checkout_step_view', 'checkout_step_complete', 'checkout_step_blocked', 'order_submit_attempt']) {
    assert.ok(notKey.includes(event), `${event} needs an explicit not-a-key-event decision`);
  }
});

// ── The report ──────────────────────────────────────────────────────────────

test('a complete response set becomes the exact funnel with users-basis rates and drop-offs', () => {
  const doc = report(plan());
  assert.equal(doc.evidence, 'COMPLETE');
  assert.deepEqual(doc.evidence_reasons, []);
  assert.equal(doc.payment_authority, 'excluded');
  assert.equal(doc.evidence_kind, 'ga4_behavioral_aggregate');
  assert.equal(doc.timezone, 'America/Chicago');
  assert.deepEqual(doc.segments.map((item) => item.segment), ['all']);
  assert.deepEqual(doc.segments[0].stages.map((item) => item.stage_id), FUNNEL_STAGE_IDS);

  assert.deepEqual(stage(doc, 'landing'), {
    stage_id: 'landing', evidence: 'MEASURED', evidence_reasons: [], caveats: [], users: 800, events: null, sessions: 1000,
    rate_from_first: null, rate_from_previous: null, drop_off_users: null, drop_off_rate: null, rate_status: 'FIRST_STAGE',
  });
  assert.deepEqual(stage(doc, 'checkout_entry'), {
    stage_id: 'checkout_entry', evidence: 'MEASURED', evidence_reasons: [], caveats: [], users: 300, events: 420, sessions: null,
    rate_from_first: 0.375, rate_from_previous: 0.375, drop_off_users: 500, drop_off_rate: 0.625, rate_status: 'OK',
  });
  assert.equal(stage(doc, 'step_complete:review').drop_off_users, 80);
  assert.equal(stage(doc, 'step_complete:review').rate_from_previous, 0.4286);
  assert.equal(stage(doc, 'submit_attempt').users, 60);
  assert.deepEqual(stage(doc, 'purchase').caveats, ['BEHAVIORAL_NOT_PAYMENT_AUTHORITY']);
  assert.equal(stage(doc, 'purchase').rate_from_first, 0.05);

  assert.deepEqual(doc.segments[0].engagement, {
    stage: 'name_preview_submitted', evidence: 'MEASURED', evidence_reasons: [], users: 120, events: 130, rate_from_landing: 0.15,
  });
  const heroDetails = doc.segments[0].friction[0];
  assert.equal(heroDetails.step_id, 'hero-details');
  assert.equal(heroDetails.users, 90);
  assert.equal(heroDetails.blocked_rate, 0.3103);
  assert.deepEqual(heroDetails.reasons, [
    { reason: 'hero_name_required', users: 70, events: 100 },
    { reason: 'story_direction_required', users: 30, events: 40 },
  ]);
  assert.match(renderFunnelReportText(doc), /checkout_entry\s+300\s+37\.5%\s+37\.5%\s+500  OK/);
  assert.match(renderFunnelReportText(doc), /Stripe settlement is the payment authority/);
});

test('an absent row in a complete report is a measured zero; small denominators withhold rates', () => {
  const planDoc = plan();
  const doc = report(planDoc, {
    traffic: response(planDoc, 'traffic', [['25', '20']]),
    events: response(planDoc, 'events', [['checkout_step_view', '10', '12']]),
    steps: response(planDoc, 'steps', [['checkout_step_view', 'hero-details', '10', '10']]),
    blocked: response(planDoc, 'blocked', []),
  });
  assert.equal(doc.evidence, 'COMPLETE');
  assert.equal(stage(doc, 'checkout_entry').rate_status, 'DENOMINATOR_BELOW_MINIMUM');
  assert.equal(stage(doc, 'checkout_entry').rate_from_previous, null);
  assert.equal(stage(doc, 'checkout_entry').drop_off_users, 10);
  assert.equal(stage(doc, 'checkout_entry').rate_from_first, null, `first stage below ${FUNNEL_MIN_DENOMINATOR} users`);
  assert.equal(stage(doc, 'purchase').users, 0);
  assert.equal(stage(doc, 'purchase').evidence, 'MEASURED');
  assert.equal(stage(doc, 'step_view:hero-appearance').users, 0);
  assert.equal(stage(doc, 'step_complete:hero-appearance').rate_status, 'NO_DENOMINATOR');
  assert.deepEqual(doc.segments[0].friction[0].reasons, []);
});

test('a later stage above its predecessor is NON_MONOTONIC, never clamped', () => {
  const planDoc = plan();
  const doc = report(planDoc, {
    steps: response(planDoc, 'steps', STEPS.map((row) => (row[0] === 'checkout_step_view' && row[1] === 'people' ? [row[0], row[1], '400', '400'] : row))),
  });
  const people = stage(doc, 'step_view:people');
  assert.equal(people.rate_status, 'NON_MONOTONIC');
  assert.equal(people.rate_from_previous, null);
  assert.equal(people.drop_off_users, null);
  assert.equal(people.rate_from_first, 0.5);
  assert.equal(people.users, 400);
});

test('GA4 data-quality gaps become INSUFFICIENT_EVIDENCE with null counts, never numbers', () => {
  const planDoc = plan();
  const cases: Array<[string, Record<string, unknown>, string, string[]]> = [
    ['thresholded traffic', { traffic: response(planDoc, 'traffic', TRAFFIC, { metadata: { timeZone: 'America/Chicago', subjectToThresholding: true } }) }, 'landing', ['THRESHOLDED']],
    ['sampled events', { events: response(planDoc, 'events', EVENTS, { metadata: { samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '2' }] } }) }, 'purchase', ['SAMPLED']],
    ['(other) folded steps', { steps: response(planDoc, 'steps', STEPS, { metadata: { dataLossFromOtherRow: true } }) }, 'step_view:people', ['OTHER_ROW']],
    ['truncated steps', { steps: response(planDoc, 'steps', STEPS, { rowCount: 99 }) }, 'step_complete:review', ['TRUNCATED']],
    ['empty for a reason', { events: response(planDoc, 'events', [], { metadata: { emptyReason: 'jane secret' } }) }, 'checkout_entry', ['EMPTY_REASON']],
    ['step dimension not yet populated', { steps: response(planDoc, 'steps', [...STEPS, ['checkout_step_view', '(not set)', '3', '3']]) }, 'step_view:hero-details', ['DIMENSION_VALUE_NOT_SET']],
    ['out-of-contract step', { steps: response(planDoc, 'steps', [...STEPS, ['checkout_step_view', 'jane-doe', '3', '3']]) }, 'step_view:review', ['OUT_OF_CONTRACT_VALUE']],
  ];
  for (const [label, overrides, stageId, reasons] of cases) {
    const doc = report(planDoc, overrides);
    const item = stage(doc, stageId);
    assert.equal(item.evidence, 'INSUFFICIENT_EVIDENCE', label);
    assert.deepEqual(item.evidence_reasons, reasons, label);
    assert.equal(item.users, null, label);
    assert.equal(item.events, null, label);
    assert.equal(doc.evidence, 'INSUFFICIENT_EVIDENCE', label);
    assert.deepEqual(doc.evidence_reasons, reasons, label);
    assert.doesNotMatch(JSON.stringify(doc), LEAK, label);
  }
  // A stage right after an insufficient one has no measured predecessor.
  const thresholded = report(planDoc, { traffic: response(planDoc, 'traffic', TRAFFIC, { metadata: { subjectToThresholding: true } }) });
  assert.equal(stage(thresholded, 'checkout_entry').rate_status, 'NOT_COMPUTED');
  assert.equal(stage(thresholded, 'checkout_entry').rate_from_first, null);
  assert.equal(thresholded.segments[0].engagement.rate_from_landing, null);
  // Step-to-step rates between measured stages survive an insufficient first stage.
  assert.equal(stage(thresholded, 'step_view:hero-details').rate_status, 'OK');
  assert.equal(stage(thresholded, 'step_view:hero-details').rate_from_previous, 0.9667);
  assert.equal(stage(thresholded, 'step_view:hero-details').rate_from_first, null);
  // An out-of-contract blocked reason withholds the reasons, not the step counts.
  const badReason = report(planDoc, { blocked: response(planDoc, 'blocked', [...BLOCKED, ['review', 'Missing: Jane Doe', '1', '1']]) });
  assert.equal(badReason.segments[0].friction[3].reasons_evidence, 'INSUFFICIENT_EVIDENCE');
  assert.deepEqual(badReason.segments[0].friction[3].reasons, []);
  assert.equal(badReason.segments[0].friction[3].users, 5);
  assert.doesNotMatch(JSON.stringify(badReason), LEAK);
});

test('hostile raw segment values are governed or collapsed and never echoed', () => {
  const landing = plan('landing_route');
  const hostileLanding = [
    '/checkout?email=jane%40example.com&childName=Jane',
    '/status/ord_ZQXSYNTH7731',
    '/(other)',
    'https://evil.example/jane#token=abc',
    '/gifts/birthdays',
  ];
  const doc = report(landing, {
    traffic: response(landing, 'traffic', hostileLanding.map((value, index) => [value, String(10 + index), String(10 + index)])),
    events: response(landing, 'events', hostileLanding.map((value) => [value, 'checkout_step_view', '2', '2'])),
    steps: response(landing, 'steps', []),
    blocked: response(landing, 'blocked', []),
  });
  assert.deepEqual(doc.segments.map((item) => item.segment), ['/checkout', '/gifts/birthdays', 'other']);
  const other = doc.segments.find((item) => item.segment === 'other')!;
  assert.equal(other.merged_raw_values, true);
  assert.equal(other.stages[0].users, 11 + 12 + 13);
  assert.equal(doc.segments[0].merged_raw_values, false);
  assert.doesNotMatch(JSON.stringify(doc), LEAK);
  assert.doesNotMatch(renderFunnelReportText(doc), LEAK);

  const campaign = plan('campaign');
  const byCampaign = report(campaign, {
    traffic: response(campaign, 'traffic', [
      ['2026-10-holiday', '40', '30'], ['(direct)', '50', '40'], ['(not set)', '5', '5'], ['jane doe free text secret', '4', '4'],
      ['2026-10-HOLIDAY', '1', '1'],
    ]),
    events: response(campaign, 'events', []),
    steps: response(campaign, 'steps', []),
    blocked: response(campaign, 'blocked', []),
  });
  assert.deepEqual(byCampaign.segments.map((item) => item.segment), ['2026-10-holiday', 'none', 'not_set', 'other']);
  assert.equal(byCampaign.segments[0].merged_raw_values, true, 'case-folded duplicates are summed and flagged');
  assert.doesNotMatch(JSON.stringify(byCampaign), LEAK);

  assert.equal(governFunnelSegment('device_category', '<script>alert(1)</script>'), 'other');
  assert.equal(governFunnelSegment('device_category', 'mobile'), 'mobile');
  assert.equal(governFunnelSegment('device_category', '(not set)'), 'not_set');
  assert.equal(governFunnelSegment('selected_format', 'Premium'), 'other');
  assert.equal(governFunnelSegment('selected_format', 'premium'), 'premium');
  assert.equal(governFunnelSegment('campaign', 42), 'other');
});

test('breakdowns mark server-written purchases as partially attributable; selected_format has step stages only', () => {
  const device = plan('device_category');
  const doc = report(device, {
    traffic: response(device, 'traffic', [['mobile', '600', '500'], ['desktop', '400', '300']]),
    events: response(device, 'events', [['mobile', 'purchase', '10', '10'], ['(not set)', 'purchase', '20', '20']]),
    steps: response(device, 'steps', []),
    blocked: response(device, 'blocked', []),
  });
  assert.deepEqual(doc.segments.map((item) => item.segment), ['desktop', 'mobile', 'not_set']);
  for (const segment of doc.segments) {
    assert.deepEqual(segment.stages.at(-1)!.caveats, ['BEHAVIORAL_NOT_PAYMENT_AUTHORITY', 'SERVER_EVENT_SEGMENT_PARTIAL']);
  }

  const format = plan('selected_format');
  const byFormat = report(format, {
    steps: response(format, 'steps', [
      ['(not set)', 'checkout_step_view', 'hero-details', '100', '100'],
      ['premium', 'checkout_step_view', 'review', '40', '40'],
      ['premium', 'checkout_step_complete', 'review', '30', '30'],
    ]),
    blocked: response(format, 'blocked', [['premium', 'review', 'email_required', '4', '4']]),
  });
  const premium = byFormat.segments.find((item) => item.segment === 'premium')!;
  for (const stageId of ['landing', 'checkout_entry', 'submit_attempt', 'purchase']) {
    const item = premium.stages.find((entry) => entry.stage_id === stageId)!;
    assert.equal(item.evidence, 'NOT_APPLICABLE', stageId);
    assert.equal(item.users, null, stageId);
  }
  assert.equal(premium.stages.find((item) => item.stage_id === 'step_view:hero-details')!.rate_status, 'FIRST_STAGE');
  assert.equal(premium.engagement.evidence, 'NOT_APPLICABLE');
  assert.deepEqual(premium.friction[3].reasons, [{ reason: 'email_required', users: 4, events: 4 }]);
  assert.equal(byFormat.evidence, 'COMPLETE');
});

test('a malformed, hostile or unbound response set is refused with value-free codes', () => {
  const planDoc = plan();
  const all = responses(planDoc);
  const tamperedPlan = structuredClone(planDoc);
  (tamperedPlan.requests[1].body.dimensions as Array<{ name: string }>).push({ name: 'pagePathPlusQueryString' });
  const otherProperty = { ...structuredClone(planDoc), property_id: '987654321' };
  const extraLimit = structuredClone(planDoc);
  extraLimit.requests[0].body.limit = '100000';
  const events = response(planDoc, 'events', EVENTS) as { rows: Array<{ dimensionValues: Array<{ value: string }>; metricValues: Array<{ value: string }> }> };

  const cases: Array<[string, unknown, unknown, string[]]> = [
    ['plan with an added raw-URL dimension', tamperedPlan, all, ['REQUEST_PLAN_INVALID@$.plan']],
    ['plan whose URL no longer matches its property', otherProperty, all, ['REQUEST_PLAN_INVALID@$.plan']],
    ['plan with another row limit', extraLimit, all, ['REQUEST_PLAN_INVALID@$.plan']],
    ['non-object plan', 'jane', all, ['REQUEST_PLAN_INVALID@$.plan']],
    ['missing response', planDoc, Object.fromEntries(Object.entries(all).filter(([id]) => id !== 'blocked')), ['RESPONSES_SHAPE@$.responses']],
    ['undefined response', planDoc, { ...all, blocked: undefined }, ['RESPONSE_SHAPE@$.responses.blocked']],
    ['extra response', planDoc, { ...all, pages: {} }, ['RESPONSES_SHAPE@$.responses']],
    ['array of responses', planDoc, Object.values(all), ['RESPONSES_SHAPE@$.responses']],
    ['unknown response field', planDoc, { ...all, events: { ...events, propertyQuota: {} } }, ['RESPONSE_SHAPE@$.responses.events']],
    ['foreign headers', planDoc, { ...all, traffic: response(planDoc, 'events', EVENTS) }, ['HEADERS_MISMATCH@$.responses.traffic']],
    ['event outside the filter', planDoc, { ...all, events: response(planDoc, 'events', [...EVENTS, ['refund', '1', '1']]) }, ['ROW_OUTSIDE_REQUEST@$.responses.events.rows[4]']],
    ['duplicate row', planDoc, { ...all, events: response(planDoc, 'events', [...EVENTS, EVENTS[0]]) }, ['DUPLICATE_ROW@$.responses.events.rows[4]']],
    ['users above events', planDoc, { ...all, events: response(planDoc, 'events', [['purchase', '5', '4']]) }, ['METRIC_INCOHERENT@$.responses.events.rows[0]']],
    ['fractional metric', planDoc, { ...all, events: response(planDoc, 'events', [['purchase', '1.5', '4']]) }, ['METRIC_INVALID@$.responses.events.rows[0]']],
    ['negative metric', planDoc, { ...all, traffic: response(planDoc, 'traffic', [['-1', '1']]) }, ['METRIC_INVALID@$.responses.traffic.rows[0]']],
    ['emptyReason beside rows', planDoc, { ...all, events: response(planDoc, 'events', EVENTS, { metadata: { emptyReason: 'x' } }) }, ['METADATA_INVALID@$.responses.events.metadata.emptyReason']],
    ['rowCount below rows', planDoc, { ...all, events: response(planDoc, 'events', EVENTS, { rowCount: 1 }) }, ['ROW_COUNT_INVALID@$.responses.events.rowCount']],
    ['cell with extra key', planDoc, {
      ...all,
      events: { ...events, rows: [{ ...events.rows[0], dimensionValues: [{ value: 'purchase', oneValue: 'jane' }] }] },
    }, ['ROW_SHAPE@$.responses.events.rows[0]']],
    ['conflicting timezones', planDoc, {
      ...all, steps: response(planDoc, 'steps', STEPS, { metadata: { timeZone: 'Europe/London' } }),
    }, ['TIMEZONE_INVALID@$.responses.steps.metadata.timeZone']],
    ['hostile timezone', planDoc, {
      ...all, traffic: response(planDoc, 'traffic', TRAFFIC, { metadata: { timeZone: 'jane@example.com' } }),
    }, ['TIMEZONE_INVALID@$.responses.traffic.metadata.timeZone']],
  ];
  for (const [label, planInput, responseInput, expected] of cases) {
    const result = buildFunnelReport(planInput, responseInput);
    assert.deepEqual(result, { ok: false, issues: expected }, label);
    assert.doesNotMatch(JSON.stringify(result), LEAK, label);
  }
});

/**
 * The response set as the live Data API serializes it: proto3 JSON omits an
 * empty repeated field, so a zero-dimension request comes back without
 * `dimensionHeaders` and its rows carry only `metricValues`.
 */
function proto3(doc: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(doc) as Record<string, unknown> & { dimensionHeaders?: unknown[]; rows?: Array<Record<string, unknown>> };
  if (Array.isArray(out.dimensionHeaders) && out.dimensionHeaders.length === 0) delete out.dimensionHeaders;
  for (const row of out.rows ?? []) {
    if (Array.isArray(row.dimensionValues) && row.dimensionValues.length === 0) delete row.dimensionValues;
  }
  return out;
}

function liveResponses(planDoc: FunnelRequestPlan, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const all = responses(planDoc, overrides);
  return Object.fromEntries(Object.entries(all).map(([id, doc]) => [id, proto3(doc as Record<string, unknown>)]));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

test('the default report reads the live proto3 shape of its zero-dimension traffic request', () => {
  const planDoc = plan();
  const live = deepFreeze(liveResponses(planDoc));
  const traffic = live.traffic as Record<string, unknown> & { rows: Array<Record<string, unknown>> };
  assert.equal(Object.hasOwn(traffic, 'dimensionHeaders'), false);
  assert.deepEqual(Object.keys(traffic.rows[0]), ['metricValues']);
  // Dimensional requests keep their headers and row values in the live shape.
  assert.ok(Array.isArray((live.events as Record<string, unknown>).dimensionHeaders));

  const synthetic = report(planDoc);
  const read = buildFunnelReport(planDoc, live);
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual(validateFunnelReport(read.report), []);
  assert.deepEqual(read.report, synthetic);
  assert.equal(stage(read.report, 'landing').users, 800);
  assert.equal(stage(read.report, 'landing').sessions, 1000);
  assert.equal(read.report.evidence, 'COMPLETE');

  // Present-but-empty headers beside rows that omit their empty values, and a
  // zero-traffic report with neither headers nor rows, are the same contract.
  const mixed = buildFunnelReport(planDoc, { ...live, traffic: { ...traffic, dimensionHeaders: [] } });
  assert.ok(mixed.ok, JSON.stringify(mixed));
  assert.deepEqual(mixed.report, synthetic);
  const empty = buildFunnelReport(planDoc, { ...live, traffic: proto3(response(planDoc, 'traffic', [])) });
  assert.ok(empty.ok, JSON.stringify(empty));
  assert.equal(stage(empty.report, 'landing').users, 0);
});

test('an omitted dimension field is refused wherever the request asked for dimensions', () => {
  const omit = (doc: unknown, where: 'headers' | 'values') => {
    const out = structuredClone(doc) as Record<string, unknown> & { rows: Array<Record<string, unknown>> };
    if (where === 'headers') delete out.dimensionHeaders;
    else for (const row of out.rows) delete row.dimensionValues;
    return out;
  };
  const none = plan();
  const noneLive = liveResponses(none);
  const device = plan('device_category');
  const deviceAll = responses(device, {
    traffic: response(device, 'traffic', [['mobile', '600', '500']]),
    events: response(device, 'events', [['mobile', 'purchase', '10', '10']]),
    steps: response(device, 'steps', []),
    blocked: response(device, 'blocked', []),
  });
  assert.ok(buildFunnelReport(device, deviceAll).ok);
  const format = plan('selected_format');
  const formatAll = responses(format, {
    steps: response(format, 'steps', [['premium', 'checkout_step_view', 'hero-details', '9', '9']]),
    blocked: response(format, 'blocked', []),
  });
  assert.ok(buildFunnelReport(format, formatAll).ok);
  const traffic = noneLive.traffic as Record<string, unknown>;

  const cases: Array<[string, FunnelRequestPlan, unknown, string[]]> = [
    ['events headers omitted', none, { ...noneLive, events: omit(noneLive.events, 'headers') }, ['HEADERS_MISMATCH@$.responses.events']],
    ['events values omitted', none, { ...noneLive, events: omit(noneLive.events, 'values') }, ['ROW_SHAPE@$.responses.events.rows[0]']],
    ['steps headers omitted', none, { ...noneLive, steps: omit(noneLive.steps, 'headers') }, ['HEADERS_MISMATCH@$.responses.steps']],
    ['blocked values omitted', none, { ...noneLive, blocked: omit(noneLive.blocked, 'values') }, ['ROW_SHAPE@$.responses.blocked.rows[0]']],
    ['breakdown traffic headers omitted', device, { ...deviceAll, traffic: omit(deviceAll.traffic, 'headers') }, ['HEADERS_MISMATCH@$.responses.traffic']],
    ['breakdown traffic values omitted', device, { ...deviceAll, traffic: omit(deviceAll.traffic, 'values') }, ['ROW_SHAPE@$.responses.traffic.rows[0]']],
    ['format steps headers omitted', format, { ...formatAll, steps: omit(formatAll.steps, 'headers') }, ['HEADERS_MISMATCH@$.responses.steps']],
    ['format steps values omitted', format, { ...formatAll, steps: omit(formatAll.steps, 'values') }, ['ROW_SHAPE@$.responses.steps.rows[0]']],
    // A zero-dimension request still binds exactly: a null or named header, or
    // a row carrying a dimension cell, is not an omission.
    ['zero-dimension null headers', none, { ...noneLive, traffic: { ...traffic, dimensionHeaders: null } }, ['HEADERS_MISMATCH@$.responses.traffic']],
    ['zero-dimension named header', none, { ...noneLive, traffic: { ...traffic, dimensionHeaders: [{ name: 'pagePath' }] } }, ['HEADERS_MISMATCH@$.responses.traffic']],
    ['zero-dimension null row values', none, {
      ...noneLive, traffic: { ...traffic, rows: [{ dimensionValues: null, metricValues: [{ value: '1000' }, { value: '800' }] }] },
    }, ['ROW_SHAPE@$.responses.traffic.rows[0]']],
    ['zero-dimension row with a dimension cell', none, {
      ...noneLive, traffic: { ...traffic, rows: [{ dimensionValues: [{ value: 'jane' }], metricValues: [{ value: '1000' }, { value: '800' }] }] },
    }, ['ROW_SHAPE@$.responses.traffic.rows[0]']],
    ['zero-dimension row without metrics', none, { ...noneLive, traffic: { ...traffic, rows: [{}] } }, ['ROW_SHAPE@$.responses.traffic.rows[0]']],
  ];
  for (const [label, planDoc, input, expected] of cases) {
    const result = buildFunnelReport(planDoc, input);
    assert.deepEqual(result, { ok: false, issues: expected }, label);
    assert.doesNotMatch(JSON.stringify(result), LEAK, label);
  }
});

test('the shared reader accepts an omitted dimension field only for a zero-dimension request', () => {
  const metricsOnly = { metricHeaders: [{ name: 'eventCount', type: 'TYPE_INTEGER' }], rows: [{ metricValues: [{ value: '3' }] }], rowCount: 1 };
  assert.deepEqual(readGa4RunReport(metricsOnly, { dimensions: [], metrics: ['eventCount'], limit: 10 }),
    { ok: true, report: { rows: [{ dimensions: [], metrics: ['3'] }], timeZone: null, gaps: [] } });
  // The decision export, transaction readback and Admin probe all request dimensions.
  for (const dimensions of [['transactionId', 'eventName'], ['eventName', 'customEvent:step_id'], ['date']]) {
    assert.deepEqual(readGa4RunReport(metricsOnly, { dimensions, metrics: ['eventCount'], limit: 10 }),
      { ok: false, defect: 'HEADERS_MISMATCH', path: '$' }, dimensions.join());
    const headed = { ...metricsOnly, dimensionHeaders: dimensions.map((name) => ({ name })) };
    assert.deepEqual(readGa4RunReport(headed, { dimensions, metrics: ['eventCount'], limit: 10 }),
      { ok: false, defect: 'ROW_SHAPE', path: '$.rows[0]' }, dimensions.join());
  }
});

test('the report validator is closed', () => {
  const doc = report(plan());
  const mutate = (change: (value: Record<string, any>) => void) => {
    const copy = structuredClone(doc) as unknown as Record<string, any>;
    change(copy);
    return validateFunnelReport(copy);
  };
  assert.deepEqual(mutate((d) => { d.revenue = 1; }), ['UNKNOWN_KEY@$']);
  assert.deepEqual(mutate((d) => { d.segments[0].stages[1].email = 'jane@example.com'; }), ['FORBIDDEN_KEY@$.segments[0].stages[1]']);
  assert.deepEqual(mutate((d) => { d.segments[0].segment = '/checkout?x=1'; }), ['SEGMENT_NOT_GOVERNED@$.segments[0].segment']);
  assert.deepEqual(mutate((d) => { d.segments[0].stages[1].rate_from_first = 1.5; }), ['VALUE_INVALID@$.segments[0].stages[1].rate_from_first']);
  assert.deepEqual(mutate((d) => { d.segments[0].stages[1].rate_status = 'NON_MONOTONIC'; }), ['RATE_WITHOUT_STATUS@$.segments[0].stages[1]']);
  assert.deepEqual(mutate((d) => { d.segments[0].stages[2].stage_id = 'checkout_entry'; }), ['VALUE_INVALID@$.segments[0].stages[2].stage_id']);
  assert.deepEqual(mutate((d) => { d.payment_authority = 'ga4'; }), ['VALUE_INVALID@$.payment_authority']);
  assert.deepEqual(mutate((d) => { d.evidence = 'INSUFFICIENT_EVIDENCE'; }), ['EVIDENCE_MISMATCH@$.evidence']);
  assert.deepEqual(mutate((d) => { d.segments[0].friction[0].reasons[0].reason = 'Missing: Jane'; }), ['VALUE_INVALID@$.segments[0].friction[0].reasons[0].reason']);
  assert.deepEqual(mutate((d) => {
    d.segments[0].stages[1].evidence = 'INSUFFICIENT_EVIDENCE';
  }), [
    'VALUE_INVALID@$.segments[0].stages[1].users',
    'VALUE_INVALID@$.segments[0].stages[1].events',
    'EVIDENCE_REASONS_MISMATCH@$.segments[0].stages[1].evidence_reasons',
    'EVIDENCE_MISMATCH@$.evidence',
  ]);
  assert.deepEqual(validateFunnelReport({ schema: 'hsb.funnel_diagnostics', schema_version: 2 }), ['SCHEMA_VERSION_UNSUPPORTED@$.schema_version']);
});

// ── Privacy boundary of the events the funnel reads ─────────────────────────

const HOSTILE_HREF = 'https://herostorybooks.com/checkout?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-10-holiday'
  + '&utm_term=jane-doe&childName=Jane&email=jane%40example.com&token=secret#free%20text';
const HOSTILE_REFERRER = 'https://mail.example/inbox/jane-doe/312-555-0100?email=jane@example.com';

test('funnel events carry only contract params under a hostile URL, referrer, storage and free-text props', async () => {
  await withBrowser({
    href: HOSTILE_HREF,
    referrer: HOSTILE_REFERRER,
    storage: { [ATTRIBUTION_STORAGE_KEY]: '{"version":1,"firstTouch":{"source":"jane@example.com"}}' },
    now: NOW,
  }, (f) => {
    recordBrowserAttributionLanding();
    const hostile = { childName: 'Jane', email: 'jane@example.com', notes: 'free text secret', orderId: 'ord_ZQXSYNTH7731' };
    track('name_preview_submitted', { has_name: true, preview_name_length: 4, ...hostile } as never);
    track('checkout_step_view', { ...checkoutStepEventProps('hero-details', 'premium'), ...hostile } as never);
    track('checkout_step_complete', { ...checkoutStepEventProps('hero-details', 'premium'), ...hostile } as never);
    track('checkout_step_blocked', { ...checkoutStepEventProps('people', 'jane'), reason: 'Missing: Jane Doe' } as never);
    track('checkout_step_blocked', { ...checkoutStepEventProps('people', null), reason: 'family_member_incomplete' });
    track('order_submit_attempt', { theme: 'Jane', bookFormat: 'premium', hasPhoto: true, hasVoice: false, familyCharacterCount: 1, ...hostile } as never);

    assert.equal(f.gtag.length, 6);
    for (const call of f.gtag) assert.deepEqual(checkGa4BrowserEventCall(call), [], JSON.stringify(call));
    const serialized = JSON.stringify([f.gtag, f.vercel, f.win.hsbEvents]);
    assert.doesNotMatch(serialized, LEAK);
    assert.doesNotMatch(serialized, /preview_name_length/);
    const [, , namePreview] = f.gtag[0] as [string, string, Record<string, unknown>];
    assert.equal(namePreview.has_name, true);
    assert.equal(namePreview.page_referrer, 'https://mail.example');
    const [, , freeTextBlock] = f.gtag[3] as [string, string, Record<string, unknown>];
    assert.equal(Object.hasOwn(freeTextBlock, 'reason'), false, 'a free-text reason is dropped, not forwarded');
    assert.equal(freeTextBlock.selected_format, null);
    const [, , enumBlock] = f.gtag[4] as [string, string, Record<string, unknown>];
    assert.equal(enumBlock.reason, 'family_member_incomplete');
  });
});

test('the page referrer reaches GA only as an origin, and the funnel report cannot carry it', async () => {
  await withBrowser({ href: HOSTILE_HREF, referrer: HOSTILE_REFERRER, now: NOW }, (f) => {
    track('checkout_step_view', checkoutStepEventProps('review', 'digital'));
    const [, , params] = f.gtag[0] as [string, string, Record<string, unknown>];
    assert.equal(params.page_referrer, 'https://mail.example');
    assert.equal(params.page_location, 'https://herostorybooks.com/checkout');
  });
  // The referrer origin is not a report dimension: no plan request reads it.
  for (const breakdown of ['none', 'device_category', 'landing_route', 'campaign', 'selected_format']) {
    assert.doesNotMatch(JSON.stringify(plan(breakdown)), /referrer|pageLocation|pagePath|fullPageUrl|QueryString|sessionSource/i);
  }
});

test('the browser cannot emit the purchase the funnel reads; it stays server-only', async () => {
  assert.equal(GA4_PURCHASE_CONTRACT.browser, 'forbidden');
  assert.equal(GA4_PURCHASE_CONTRACT.authority, 'settled_webhook_winner');
  assert.equal(Object.hasOwn(BROWSER_EVENT_CONTRACT, 'purchase'), false);
  await withBrowser({ href: 'https://herostorybooks.com/thank-you?session_id=cs_live_a1B2c3D4e5F6', now: NOW }, (f) => {
    for (const name of ['purchase', 'Purchase', ' purchase ']) assert.equal(track(name as never, { value: 19 } as never), null);
    assert.deepEqual(f.gtag, []);
    assert.deepEqual(f.vercel, []);
  });
});

test('no step event is duplicated: the checkout form keeps its existing emit sites and blocked reasons come from the enum builders', () => {
  const form = readFileSync('src/app/checkout/checkout-form.tsx', 'utf8');
  const count = (event: string) => form.match(new RegExp(`track\\("${event}"`, 'g'))?.length ?? 0;
  assert.equal(count('checkout_step_view'), 1);
  assert.equal(count('checkout_step_complete'), 2, 'advance + validated submit of the review step');
  assert.equal(count('checkout_step_blocked'), 2, 'advance refusal + submit refusal');
  assert.equal(count('order_submit_attempt'), 1);
  assert.match(form, /createCheckoutStepViewDeduper/);
  for (const block of form.match(/track\("checkout_step_blocked", \{[\s\S]*?\}\);/g) ?? []) {
    assert.match(block, /reason: checkout(?:Step|Submit)BlockedReason\(/);
  }
  // The diagnostics module only reads GA4; it never emits.
  const module = readFileSync('src/lib/ga4-funnel-diagnostics.ts', 'utf8');
  assert.doesNotMatch(module, /\btrack\(|gtag|fetch\(|sendBeacon|process\.env/);
  assert.ok(CHECKOUT_STEP_BLOCKED_REASONS.every((reason) => /^[a-z_]+$/.test(reason)));
});

// ── CLI ─────────────────────────────────────────────────────────────────────

const CLI = ['--experimental-strip-types', 'scripts/funnel-diagnostics.ts'];
function cli(args: string[]) {
  return spawnSync(process.execPath, [...CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
}

test('the CLI prints the plan, builds a report from saved responses, and refuses value-free', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hsb-funnel-'));
  try {
    const planned = cli(['plan', '--property', PROPERTY, '--start', '2026-09-01', '--end', '2026-09-28']);
    assert.equal(planned.status, 0, planned.stderr);
    const planDoc = JSON.parse(planned.stdout);
    assert.deepEqual(planDoc, plan());
    const planFile = path.join(dir, 'plan.json');
    const responsesFile = path.join(dir, 'responses.json');
    writeFileSync(planFile, planned.stdout);
    writeFileSync(responsesFile, JSON.stringify(responses(planDoc)));

    const json = cli(['report', '--plan', planFile, '--responses', responsesFile]);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(validateFunnelReport(JSON.parse(json.stdout)), []);
    const text = cli(['report', '--plan', planFile, '--responses', responsesFile, '--format', 'text']);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^HSB funnel 2026-09-01\.\.2026-09-28/);

    // The live proto3 shape: traffic without `dimensionHeaders`, rows with only `metricValues`.
    const live = liveResponses(planDoc);
    assert.equal(Object.hasOwn(live.traffic as object, 'dimensionHeaders'), false);
    writeFileSync(responsesFile, JSON.stringify(live));
    const liveJson = cli(['report', '--plan', planFile, '--responses', responsesFile]);
    assert.equal(liveJson.status, 0, liveJson.stdout + liveJson.stderr);
    assert.equal(liveJson.stdout, json.stdout);
    const liveText = cli(['report', '--plan', planFile, '--responses', responsesFile, '--format', 'text']);
    assert.equal(liveText.status, 0, liveText.stderr);
    assert.equal(liveText.stdout, text.stdout);

    const noHeaders = structuredClone(live) as Record<string, Record<string, unknown>>;
    delete noHeaders.events.dimensionHeaders;
    writeFileSync(responsesFile, JSON.stringify(noHeaders));
    const headerless = cli(['report', '--plan', planFile, '--responses', responsesFile]);
    assert.equal(headerless.status, 3);
    assert.equal(headerless.stdout, 'REJECTED funnel_report HEADERS_MISMATCH@$.responses.events\n');
    const noValues = structuredClone(live) as Record<string, { rows: Array<Record<string, unknown>> }>;
    delete noValues.steps.rows[0].dimensionValues;
    writeFileSync(responsesFile, JSON.stringify(noValues));
    const valueless = cli(['report', '--plan', planFile, '--responses', responsesFile]);
    assert.equal(valueless.status, 3);
    assert.equal(valueless.stdout, 'REJECTED funnel_report ROW_SHAPE@$.responses.steps.rows[0]\n');

    writeFileSync(responsesFile, JSON.stringify(responses(planDoc, { events: response(planDoc, 'events', [['jane@example.com', '1', '1']]) })));
    const refused = cli(['report', '--plan', planFile, '--responses', responsesFile]);
    assert.equal(refused.status, 3);
    assert.equal(refused.stdout, 'REJECTED funnel_report ROW_OUTSIDE_REQUEST@$.responses.events.rows[0]\n');

    const badPlan = cli(['plan', '--property', PROPERTY, '--start', '2026-09-01', '--end', '2026-09-28', '--breakdown', 'jane']);
    assert.equal(badPlan.status, 3);
    assert.equal(badPlan.stdout, 'REJECTED funnel_plan BREAKDOWN_INVALID@$\n');
    assert.equal(cli(['report', '--plan', planFile]).status, 2);
    assert.equal(cli(['plan', '--property', PROPERTY, '--start', '2026-09-01', '--end', '2026-09-28', '--token', 'x']).status, 2);
    assert.equal(cli(['report', '--plan', path.join(dir, 'missing.json'), '--responses', responsesFile]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
