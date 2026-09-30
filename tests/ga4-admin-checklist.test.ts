/**
 * The checked-in GA4 Admin checklist: only decision-grade, event-scoped custom
 * dimensions and key events, every one traceable to a parameter the event
 * contract actually emits, no funnel step marked as a key event, Enhanced
 * Measurement Site Search and browser-history page changes required OFF, no
 * item pre-marked as done — plus a read-only readback plan and evaluators that
 * decide from an Admin/Data API response whether the property matches.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildGa4AdminReadbackPlan,
  evaluateCustomDimensionsReadback,
  evaluateDataStreamsReadback,
  evaluateDimensionProbe,
  evaluateEnhancedMeasurementReadback,
  evaluateKeyEventsReadback,
  validateGa4AdminChecklist,
} from '../src/lib/ga4-admin-checklist.ts';

const CHECKLIST_PATH = new URL('../config/analytics/ga4-admin-checklist.v1.json', import.meta.url);
const checklist = () => JSON.parse(readFileSync(CHECKLIST_PATH, 'utf8'));

test('the checked-in checklist validates against the event contract', () => {
  assert.deepEqual(validateGa4AdminChecklist(checklist()), []);
});

test('the checked-in checklist registers attribution and funnel dimensions, and only purchase as a key event', () => {
  const doc = checklist();
  const dimensions = doc.custom_dimensions.map((item: { parameter_name: string }) => item.parameter_name).sort();
  assert.deepEqual(dimensions, [
    'hsb_ft_campaign', 'hsb_ft_content', 'hsb_ft_landing', 'hsb_ft_medium', 'hsb_ft_source',
    'hsb_lt_campaign', 'hsb_lt_content', 'hsb_lt_landing', 'hsb_lt_medium', 'hsb_lt_source',
    'reason', 'selected_format', 'step_id',
  ]);
  assert.deepEqual(doc.key_events.map((item: { event_name: string }) => item.event_name), ['purchase']);
  for (const item of [...doc.custom_dimensions, ...doc.key_events]) assert.equal(item.status, 'owner_action_pending');
});

type Doc = ReturnType<typeof checklist>;

function mutate(change: (doc: Doc) => void): Doc {
  const doc = checklist();
  change(doc);
  return doc;
}

test('each checklist defect is rejected at its path', () => {
  const cases: Array<[string, Doc, string[]]> = [
    ['user scope', mutate((d) => { d.custom_dimensions[0].scope = 'USER'; }),
      ['DIMENSION_SCOPE_NOT_EVENT@$.custom_dimensions[0].scope']],
    ['identifier as dimension', mutate((d) => {
      d.custom_dimensions[0].parameter_name = 'transaction_id';
      d.custom_dimensions[0].source_events = ['purchase'];
    }), ['DIMENSION_PARAM_NOT_ELIGIBLE@$.custom_dimensions[0].parameter_name']],
    ['non-decision param', mutate((d) => { d.custom_dimensions[0].parameter_name = 'step_number'; }),
      ['DIMENSION_PARAM_NOT_ELIGIBLE@$.custom_dimensions[0].parameter_name']],
    ['undeclared param', mutate((d) => { d.custom_dimensions[0].parameter_name = 'email'; }),
      ['DIMENSION_PARAM_UNDECLARED@$.custom_dimensions[0].parameter_name']],
    ['event that never sends it', mutate((d) => { d.custom_dimensions[0].source_events = ['begin_checkout']; }),
      ['DIMENSION_PARAM_UNDECLARED@$.custom_dimensions[0].parameter_name']],
    ['reserved prefix', mutate((d) => { d.custom_dimensions[0].parameter_name = 'ga_step'; }),
      ['DIMENSION_PARAM_NAME_INVALID@$.custom_dimensions[0].parameter_name']],
    ['duplicate', mutate((d) => { d.custom_dimensions.push({ ...d.custom_dimensions[0] }); }),
      [`DIMENSION_DUPLICATE@$.custom_dimensions[${checklist().custom_dimensions.length}].parameter_name`]],
    ['display name', mutate((d) => { d.custom_dimensions[0].display_name = 'Checkout step 🚀'; }),
      ['DIMENSION_DISPLAY_NAME_INVALID@$.custom_dimensions[0].display_name']],
    ['pre-marked done', mutate((d) => { d.custom_dimensions[0].status = 'verified'; }),
      ['STATUS_NOT_PENDING@$.custom_dimensions[0].status']],
    ['free-text key', mutate((d) => { d.custom_dimensions[0].notes = 'ask Jane'; }),
      ['FORBIDDEN_KEY@$.custom_dimensions[0]']],
    ['empty rationale', mutate((d) => { d.custom_dimensions[0].rationale = ''; }),
      ['RATIONALE_INVALID@$.custom_dimensions[0].rationale']],
    ['step marked as key event', mutate((d) => {
      d.key_events.push({ ...d.key_events[0], event_name: 'checkout_step_view' });
    }), ['KEY_EVENT_NOT_ELIGIBLE@$.key_events[1].event_name', 'KEY_EVENT_DECISION_CONFLICT@$.key_events[1].event_name']],
    ['begin_checkout marked as key event', mutate((d) => {
      d.key_events.push({ ...d.key_events[0], event_name: 'begin_checkout' });
    }), ['KEY_EVENT_NOT_ELIGIBLE@$.key_events[1].event_name', 'KEY_EVENT_DECISION_CONFLICT@$.key_events[1].event_name']],
    ['undecided funnel event', mutate((d) => {
      d.not_key_events = d.not_key_events.filter((item: { event_name: string }) => item.event_name !== 'checkout_step_blocked');
    }), ['KEY_EVENT_DECISION_MISSING@$.not_key_events']],
    ['counting method', mutate((d) => { d.key_events[0].counting_method = 'ONCE_PER_SESSION'; }),
      ['KEY_EVENT_COUNTING_METHOD_INVALID@$.key_events[0].counting_method']],
    ['other property', mutate((d) => { d.measurement_id = 'G-AAAAAAAAAA'; }),
      ['MEASUREMENT_ID_MISMATCH@$.measurement_id']],
    ['schema version', mutate((d) => { d.schema_version = 2; }),
      ['SCHEMA_VERSION_UNSUPPORTED@$.schema_version']],
  ];
  for (const [label, doc, expected] of cases) {
    assert.deepEqual(validateGa4AdminChecklist(doc), expected, label);
  }
  assert.deepEqual(validateGa4AdminChecklist(null), ['DOCUMENT_NOT_OBJECT@$']);
});

// ── Read-only readback plan ─────────────────────────────────────────────────

test('the readback plan is deterministic, read-only, and never touches the network', () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; throw new Error('no network'); }) as typeof fetch;
  try {
    const input = { propertyId: '123456789', dataStreamId: '4567890123', startDate: '2026-09-01', endDate: '2026-09-28' };
    const plan = buildGa4AdminReadbackPlan(checklist(), input);
    assert.equal(JSON.stringify(plan), JSON.stringify(buildGa4AdminReadbackPlan(checklist(), input)));
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    const scope = 'https://www.googleapis.com/auth/analytics.readonly';
    assert.deepEqual(plan.requests.slice(0, 2), [
      {
        id: 'custom_dimensions', method: 'GET', oauthScope: scope, body: null,
        url: 'https://analyticsadmin.googleapis.com/v1beta/properties/123456789/customDimensions?pageSize=200',
      },
      {
        id: 'key_events', method: 'GET', oauthScope: scope, body: null,
        url: 'https://analyticsadmin.googleapis.com/v1beta/properties/123456789/keyEvents?pageSize=200',
      },
    ]);
    const probe = plan.requests.find((request) => request.id === 'dimension_probe:step_id');
    assert.deepEqual(probe, {
      id: 'dimension_probe:step_id',
      method: 'POST',
      oauthScope: scope,
      url: 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport',
      body: {
        dateRanges: [{ startDate: '2026-09-01', endDate: '2026-09-28' }],
        dimensions: [{ name: 'eventName' }, { name: 'customEvent:step_id' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            inListFilter: {
              values: ['checkout_step_view', 'checkout_step_complete', 'checkout_step_blocked'],
              caseSensitive: true,
            },
          },
        },
        limit: '1000',
      },
    });
    assert.deepEqual(plan.requests.slice(2, 4), [
      {
        id: 'data_streams', method: 'GET', oauthScope: scope, body: null,
        url: 'https://analyticsadmin.googleapis.com/v1beta/properties/123456789/dataStreams?pageSize=200',
      },
      {
        id: 'enhanced_measurement_settings', method: 'GET', oauthScope: scope, body: null,
        url: 'https://analyticsadmin.googleapis.com/v1alpha/properties/123456789/dataStreams/4567890123/enhancedMeasurementSettings',
      },
    ]);
    assert.equal(plan.requests.length, 4 + checklist().custom_dimensions.length);
    for (const request of plan.requests) {
      assert.equal(request.oauthScope, scope);
      assert.ok(request.method === 'GET' || request.url.endsWith(':runReport'), request.id);
      assert.doesNotMatch(request.url, /update|patch|:batch|analytics\.edit/i, request.id);
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the readback plan refuses non-numeric properties and relative or invalid dates', () => {
  const doc = checklist();
  const stream = '4567890123';
  const bad: Array<[Record<string, string>, string]> = [
    [{ propertyId: 'G-68FKEDZEG3', dataStreamId: stream, startDate: '2026-09-01', endDate: '2026-09-28' }, 'PROPERTY_ID_INVALID'],
    [{ propertyId: '123 456', dataStreamId: stream, startDate: '2026-09-01', endDate: '2026-09-28' }, 'PROPERTY_ID_INVALID'],
    [{ propertyId: '123456789', dataStreamId: stream, startDate: '7daysAgo', endDate: 'today' }, 'DATE_INVALID'],
    [{ propertyId: '123456789', dataStreamId: stream, startDate: '2026-02-30', endDate: '2026-03-01' }, 'DATE_INVALID'],
    [{ propertyId: '123456789', dataStreamId: stream, startDate: '2026-09-28', endDate: '2026-09-01' }, 'DATE_RANGE_INVALID'],
  ];
  for (const [input, reason] of bad) {
    assert.deepEqual(buildGa4AdminReadbackPlan(doc, input as never), { ok: false, reason }, JSON.stringify(input));
  }
  assert.deepEqual(
    buildGa4AdminReadbackPlan({ ...doc, schema_version: 2 }, { propertyId: '123456789', dataStreamId: stream, startDate: '2026-09-01', endDate: '2026-09-28' }),
    { ok: false, reason: 'CHECKLIST_INVALID' },
  );
});

// ── Enhanced Measurement: Site Search and browser-history page changes OFF ──

const EM_API = 'analyticsadmin.v1alpha.properties.dataStreams.getEnhancedMeasurementSettings';

test('the checked-in checklist requires Site Search and browser-history page changes OFF, still pending readback', () => {
  const doc = checklist();
  assert.equal(doc.enhanced_measurement.readback_api, EM_API);
  assert.deepEqual(
    doc.enhanced_measurement.settings.map((item: Record<string, unknown>) => [item.setting, item.required_value, item.status]),
    [['siteSearchEnabled', false, 'owner_action_pending'], ['pageChangesEnabled', false, 'owner_action_pending']],
  );
});

test('each Enhanced Measurement checklist defect is rejected at its path', () => {
  const at = '$.enhanced_measurement';
  const cases: Array<[string, Doc, string[]]> = [
    ['block missing', mutate((d) => { delete d.enhanced_measurement; }), ['MISSING_KEY:enhanced_measurement@$']],
    ['block not an object', mutate((d) => { d.enhanced_measurement = [false, false]; }), [`TYPE_OBJECT@${at}`]],
    ['unknown block key', mutate((d) => { d.enhanced_measurement.notes = 'done'; }), [`FORBIDDEN_KEY@${at}`]],
    ['readback api missing', mutate((d) => { delete d.enhanced_measurement.readback_api; }),
      [`MISSING_KEY:readback_api@${at}`, `ENHANCED_MEASUREMENT_READBACK_API_INVALID@${at}.readback_api`]],
    ['invented readback api', mutate((d) => {
      d.enhanced_measurement.readback_api = 'analyticsadmin.v1beta.properties.dataStreams.getEnhancedMeasurementSettings';
    }), [`ENHANCED_MEASUREMENT_READBACK_API_INVALID@${at}.readback_api`]],
    ['settings not a list', mutate((d) => { d.enhanced_measurement.settings = { siteSearchEnabled: false }; }),
      [`TYPE_ARRAY@${at}.settings`]],
    ['site search missing', mutate((d) => { d.enhanced_measurement.settings.splice(0, 1); }),
      [`ENHANCED_MEASUREMENT_SETTING_MISSING:siteSearchEnabled@${at}.settings`]],
    ['page changes missing', mutate((d) => { d.enhanced_measurement.settings.splice(1, 1); }),
      [`ENHANCED_MEASUREMENT_SETTING_MISSING:pageChangesEnabled@${at}.settings`]],
    ['no settings at all', mutate((d) => { d.enhanced_measurement.settings = []; }), [
      `ENHANCED_MEASUREMENT_SETTING_MISSING:siteSearchEnabled@${at}.settings`,
      `ENHANCED_MEASUREMENT_SETTING_MISSING:pageChangesEnabled@${at}.settings`,
    ]],
    ['site search required on', mutate((d) => { d.enhanced_measurement.settings[0].required_value = true; }),
      [`ENHANCED_MEASUREMENT_MUST_BE_OFF@${at}.settings[0].required_value`]],
    ['page changes required on', mutate((d) => { d.enhanced_measurement.settings[1].required_value = true; }),
      [`ENHANCED_MEASUREMENT_MUST_BE_OFF@${at}.settings[1].required_value`]],
    ['string "false"', mutate((d) => { d.enhanced_measurement.settings[0].required_value = 'false'; }),
      [`TYPE_BOOLEAN@${at}.settings[0].required_value`]],
    ['zero', mutate((d) => { d.enhanced_measurement.settings[1].required_value = 0; }),
      [`TYPE_BOOLEAN@${at}.settings[1].required_value`]],
    ['null', mutate((d) => { d.enhanced_measurement.settings[0].required_value = null; }),
      [`TYPE_BOOLEAN@${at}.settings[0].required_value`]],
    ['required value missing', mutate((d) => { delete d.enhanced_measurement.settings[0].required_value; }),
      [`MISSING_KEY:required_value@${at}.settings[0]`, `TYPE_BOOLEAN@${at}.settings[0].required_value`]],
    ['ungoverned real setting', mutate((d) => {
      d.enhanced_measurement.settings.push({ ...d.enhanced_measurement.settings[0], setting: 'scrollsEnabled' });
    }), [`ENHANCED_MEASUREMENT_SETTING_UNKNOWN@${at}.settings[2].setting`]],
    ['invented setting', mutate((d) => { d.enhanced_measurement.settings[0].setting = 'siteSearch'; }), [
      `ENHANCED_MEASUREMENT_SETTING_UNKNOWN@${at}.settings[0].setting`,
      `ENHANCED_MEASUREMENT_SETTING_MISSING:siteSearchEnabled@${at}.settings`,
    ]],
    ['setting not a string', mutate((d) => { d.enhanced_measurement.settings[1].setting = ['pageChangesEnabled']; }), [
      `ENHANCED_MEASUREMENT_SETTING_UNKNOWN@${at}.settings[1].setting`,
      `ENHANCED_MEASUREMENT_SETTING_MISSING:pageChangesEnabled@${at}.settings`,
    ]],
    ['prototype key', mutate((d) => { d.enhanced_measurement.settings[0].setting = 'constructor'; }), [
      `ENHANCED_MEASUREMENT_SETTING_UNKNOWN@${at}.settings[0].setting`,
      `ENHANCED_MEASUREMENT_SETTING_MISSING:siteSearchEnabled@${at}.settings`,
    ]],
    ['duplicate', mutate((d) => { d.enhanced_measurement.settings.push({ ...d.enhanced_measurement.settings[0] }); }),
      [`ENHANCED_MEASUREMENT_SETTING_DUPLICATE@${at}.settings[2].setting`]],
    ['pre-marked done', mutate((d) => { d.enhanced_measurement.settings[0].status = 'verified'; }),
      [`STATUS_NOT_PENDING@${at}.settings[0].status`]],
    ['free-text key', mutate((d) => { d.enhanced_measurement.settings[1].notes = 'turned off'; }),
      [`FORBIDDEN_KEY@${at}.settings[1]`]],
    ['undeclared key', mutate((d) => { d.enhanced_measurement.settings[1].changed_on = '2026-09-30'; }),
      [`UNKNOWN_KEY@${at}.settings[1]`]],
    ['empty rationale', mutate((d) => { d.enhanced_measurement.settings[1].rationale = ''; }),
      [`RATIONALE_INVALID@${at}.settings[1].rationale`]],
  ];
  for (const [label, doc, expected] of cases) {
    assert.deepEqual(validateGa4AdminChecklist(doc), expected, label);
  }
});

test('the readback plan fails closed without a numeric data-stream id', () => {
  const doc = checklist();
  const base = { propertyId: '123456789', startDate: '2026-09-01', endDate: '2026-09-28' };
  for (const dataStreamId of [undefined, '', '0', '0123', 'G-68FKEDZEG3', '12/34', '4567890123/enhancedMeasurementSettings', 4567890123, '1'.repeat(21)]) {
    assert.deepEqual(buildGa4AdminReadbackPlan(doc, { ...base, dataStreamId } as never), { ok: false, reason: 'DATA_STREAM_ID_INVALID' },
      String(dataStreamId));
  }
  assert.equal(buildGa4AdminReadbackPlan(doc, { ...base, dataStreamId: '2000' }).ok, true);
});

const TARGET = { propertyId: '123456789', dataStreamId: '4567890123' };
const STREAM_NAME = 'properties/123456789/dataStreams/4567890123';

function webStream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: STREAM_NAME,
    type: 'WEB_DATA_STREAM',
    displayName: 'HeroStoryBooks web',
    createTime: '2026-04-01T00:00:00.000Z',
    updateTime: '2026-09-01T00:00:00.000Z',
    webStreamData: { measurementId: 'G-68FKEDZEG3', defaultUri: 'https://herostorybooks.com' },
    ...overrides,
  };
}

test('data-stream readback binds the supplied stream id to the checklist measurement id', () => {
  const doc = checklist();
  const app = {
    name: 'properties/123456789/dataStreams/99', type: 'ANDROID_APP_DATA_STREAM', displayName: 'app',
    androidAppStreamData: { firebaseAppId: 'x', packageName: 'com.example' },
  };
  assert.deepEqual(evaluateDataStreamsReadback(doc, TARGET, { dataStreams: [app, webStream()] }), { verdict: 'MATCH', issues: [] });
  assert.deepEqual(
    evaluateDataStreamsReadback(doc, { ...TARGET, dataStreamId: '99' }, { dataStreams: [app, webStream()] }),
    { verdict: 'MISMATCH', issues: ['DATA_STREAM_ID_MISMATCH'] },
  );
  const otherTag = webStream({ webStreamData: { measurementId: 'G-AAAAAAAAAA' } });
  assert.deepEqual(evaluateDataStreamsReadback(doc, TARGET, { dataStreams: [otherTag] }),
    { verdict: 'MISMATCH', issues: ['MEASUREMENT_STREAM_MISSING'] });
  assert.deepEqual(evaluateDataStreamsReadback(doc, TARGET, {}), { verdict: 'MISMATCH', issues: ['MEASUREMENT_STREAM_MISSING'] });
  assert.deepEqual(
    evaluateDataStreamsReadback(doc, TARGET, { dataStreams: [webStream(), webStream({ name: 'properties/123456789/dataStreams/5' })] }),
    { verdict: 'MISMATCH', issues: ['MEASUREMENT_STREAM_DUPLICATE'] },
  );
  assert.deepEqual(evaluateDataStreamsReadback(doc, TARGET, { dataStreams: [webStream()], nextPageToken: 'n' }),
    { verdict: 'INCONCLUSIVE', issues: ['RESPONSE_PAGINATED'] });
  const malformed: Array<[string, unknown]> = [
    ['web stream without web data', { dataStreams: [webStream({ webStreamData: undefined })] }],
    ['non-string measurement id', { dataStreams: [webStream({ webStreamData: { measurementId: 7 } })] }],
    ['stream of another property', { dataStreams: [webStream({ name: 'properties/1/dataStreams/4567890123' })] }],
    ['unknown stream type', { dataStreams: [webStream({ type: 'SMART_TV' })] }],
    ['unknown list field', { dataStreams: [webStream()], partial: true }],
    ['error body', { error: { code: 403, status: 'PERMISSION_DENIED' } }],
  ];
  for (const [label, response] of malformed) {
    const normalized = JSON.parse(JSON.stringify(response));
    assert.deepEqual(evaluateDataStreamsReadback(doc, TARGET, normalized), { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] }, label);
  }
  assert.deepEqual(evaluateDataStreamsReadback(doc, { ...TARGET, dataStreamId: '' }, { dataStreams: [webStream()] }),
    { verdict: 'INVALID_REQUEST', issues: ['DATA_STREAM_ID_INVALID'] });
  assert.deepEqual(evaluateDataStreamsReadback({ ...doc, enhanced_measurement: undefined }, TARGET, { dataStreams: [webStream()] }),
    { verdict: 'INVALID_REQUEST', issues: ['CHECKLIST_INVALID'] });
});

function emSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `${STREAM_NAME}/enhancedMeasurementSettings`,
    streamEnabled: true,
    scrollsEnabled: true,
    outboundClicksEnabled: true,
    siteSearchEnabled: false,
    videoEngagementEnabled: true,
    fileDownloadsEnabled: true,
    pageChangesEnabled: false,
    formInteractionsEnabled: false,
    searchQueryParameter: 'q,s,search,query,keyword',
    uriQueryParameter: '',
    ...overrides,
  };
}

function withoutField(field: string): Record<string, unknown> {
  const response = emSettings();
  delete response[field];
  return response;
}

test('Enhanced Measurement readback is MATCH only for explicit false Site Search and page changes', () => {
  const doc = checklist();
  assert.deepEqual(evaluateEnhancedMeasurementReadback(doc, TARGET, emSettings()), { verdict: 'MATCH', issues: [] });
  assert.deepEqual(
    evaluateEnhancedMeasurementReadback(doc, TARGET, emSettings({ streamEnabled: false, scrollsEnabled: false })),
    { verdict: 'MATCH', issues: [] },
    'other toggles are not governed',
  );
});

test('Enhanced Measurement readback reports every enabled governed setting as a MISMATCH', () => {
  const doc = checklist();
  const cases: Array<[string, unknown, string[]]> = [
    ['the reproduced blocker: site search on', emSettings({ siteSearchEnabled: true }), ['SETTING_ENABLED:siteSearchEnabled']],
    ['history page changes on', emSettings({ pageChangesEnabled: true }), ['SETTING_ENABLED:pageChangesEnabled']],
    ['both on', emSettings({ siteSearchEnabled: true, pageChangesEnabled: true }),
      ['SETTING_ENABLED:siteSearchEnabled', 'SETTING_ENABLED:pageChangesEnabled']],
    ['on while the stream toggle is off still counts', emSettings({ streamEnabled: false, siteSearchEnabled: true }),
      ['SETTING_ENABLED:siteSearchEnabled']],
    ['an enabled setting is definitive beside an absent one', { ...withoutField('pageChangesEnabled'), siteSearchEnabled: true },
      ['SETTING_ENABLED:siteSearchEnabled']],
  ];
  for (const [label, response, issues] of cases) {
    assert.deepEqual(evaluateEnhancedMeasurementReadback(doc, TARGET, response), { verdict: 'MISMATCH', issues }, label);
  }
});

test('Enhanced Measurement readback never reads an absent, mistyped or unknown field as OFF', () => {
  const doc = checklist();
  assert.deepEqual(evaluateEnhancedMeasurementReadback(doc, TARGET, withoutField('siteSearchEnabled')),
    { verdict: 'INCONCLUSIVE', issues: ['SETTING_ABSENT:siteSearchEnabled'] });
  assert.deepEqual(evaluateEnhancedMeasurementReadback(doc, TARGET, withoutField('pageChangesEnabled')),
    { verdict: 'INCONCLUSIVE', issues: ['SETTING_ABSENT:pageChangesEnabled'] });
  const shape: Array<[string, unknown, string]> = [
    ['string "false"', emSettings({ siteSearchEnabled: 'false' }), 'RESPONSE_SHAPE'],
    ['zero', emSettings({ pageChangesEnabled: 0 }), 'RESPONSE_SHAPE'],
    ['null', emSettings({ siteSearchEnabled: null }), 'RESPONSE_SHAPE'],
    ['mistyped ungoverned toggle', emSettings({ scrollsEnabled: 'yes' }), 'RESPONSE_SHAPE'],
    ['mistyped query parameter', emSettings({ searchQueryParameter: ['q'] }), 'RESPONSE_SHAPE'],
    ['unknown field', emSettings({ siteSearchEnable: false }), 'RESPONSE_SHAPE'],
    ['unknown alpha field', emSettings({ aiSummariesEnabled: false }), 'RESPONSE_SHAPE'],
    ['error body', { error: { code: 403, message: 'jane@example.com', status: 'PERMISSION_DENIED' } }, 'RESPONSE_SHAPE'],
    ['array', [emSettings()], 'RESPONSE_SHAPE'],
    ['null response', null, 'RESPONSE_SHAPE'],
    ['name missing', withoutField('name'), 'RESOURCE_NAME_MISMATCH'],
    ['another stream', emSettings({ name: 'properties/123456789/dataStreams/5/enhancedMeasurementSettings' }), 'RESOURCE_NAME_MISMATCH'],
    ['another property', emSettings({ name: 'properties/1/dataStreams/4567890123/enhancedMeasurementSettings' }), 'RESOURCE_NAME_MISMATCH'],
    ['the stream itself, not its settings', emSettings({ name: STREAM_NAME }), 'RESOURCE_NAME_MISMATCH'],
  ];
  for (const [label, response, issue] of shape) {
    const result = evaluateEnhancedMeasurementReadback(doc, TARGET, response);
    assert.deepEqual(result, { verdict: 'INVALID_RESPONSE', issues: [issue] }, label);
    assert.doesNotMatch(JSON.stringify(result), /jane|keyword/, label);
  }
  const inherited = Object.create({ siteSearchEnabled: false });
  Object.assign(inherited, withoutField('siteSearchEnabled'));
  assert.deepEqual(evaluateEnhancedMeasurementReadback(doc, TARGET, inherited), { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] },
    'an inherited property is not a readback');
});

test('Enhanced Measurement readback refuses an invalid checklist or target', () => {
  const doc = checklist();
  assert.deepEqual(evaluateEnhancedMeasurementReadback(mutate((d) => { d.enhanced_measurement.settings[0].required_value = true; }), TARGET, emSettings()),
    { verdict: 'INVALID_REQUEST', issues: ['CHECKLIST_INVALID'] });
  assert.deepEqual(evaluateEnhancedMeasurementReadback(doc, { ...TARGET, dataStreamId: undefined } as never, emSettings()),
    { verdict: 'INVALID_REQUEST', issues: ['DATA_STREAM_ID_INVALID'] });
  assert.deepEqual(evaluateEnhancedMeasurementReadback(doc, { ...TARGET, propertyId: 'G-68FKEDZEG3' }, emSettings()),
    { verdict: 'INVALID_REQUEST', issues: ['PROPERTY_ID_INVALID'] });
});

// ── Evaluators ──────────────────────────────────────────────────────────────

function adminDimensions(): Array<Record<string, unknown>> {
  return checklist().custom_dimensions.map((item: Record<string, string>, index: number) => ({
    name: `properties/123456789/customDimensions/${1000 + index}`,
    parameterName: item.parameter_name,
    displayName: item.display_name,
    description: '',
    scope: item.scope,
    disallowAdsPersonalization: false,
  }));
}

test('custom-dimension readback matches only the exact registered set', () => {
  const doc = checklist();
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: adminDimensions() }), { verdict: 'MATCH', issues: [] });

  const extra = [...adminDimensions(), { parameterName: 'email', displayName: 'Email', scope: 'EVENT' }];
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: extra }),
    { verdict: 'MISMATCH', issues: ['UNEXPECTED_DIMENSION'] });

  const missing = adminDimensions().filter((item) => item.parameterName !== 'reason');
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: missing }),
    { verdict: 'MISMATCH', issues: ['MISSING_DIMENSION:reason'] });

  const userScoped = adminDimensions().map((item) => item.parameterName === 'step_id' ? { ...item, scope: 'USER' } : item);
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: userScoped }),
    { verdict: 'MISMATCH', issues: ['SCOPE_MISMATCH:step_id'] });

  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: adminDimensions(), nextPageToken: 'x' }),
    { verdict: 'INCONCLUSIVE', issues: ['RESPONSE_PAGINATED'] });
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: 'jane' }),
    { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] });
});

test('key-event readback requires exactly purchase counted once per event', () => {
  const doc = checklist();
  const purchase = { name: 'properties/123456789/keyEvents/1', eventName: 'purchase', countingMethod: 'ONCE_PER_EVENT', custom: false, deletable: false };
  assert.deepEqual(evaluateKeyEventsReadback(doc, { keyEvents: [purchase] }), { verdict: 'MATCH', issues: [] });
  assert.deepEqual(
    evaluateKeyEventsReadback(doc, { keyEvents: [purchase, { ...purchase, eventName: 'checkout_step_view' }] }),
    { verdict: 'MISMATCH', issues: ['UNEXPECTED_KEY_EVENT'] },
  );
  assert.deepEqual(evaluateKeyEventsReadback(doc, { keyEvents: [] }), { verdict: 'MISMATCH', issues: ['MISSING_KEY_EVENT:purchase'] });
  assert.deepEqual(
    evaluateKeyEventsReadback(doc, { keyEvents: [{ ...purchase, countingMethod: 'ONCE_PER_SESSION' }] }),
    { verdict: 'MISMATCH', issues: ['COUNTING_METHOD_MISMATCH:purchase'] },
  );
});

function probeResponse(rows: Array<[string, string, string]>) {
  return {
    dimensionHeaders: [{ name: 'eventName' }, { name: 'customEvent:step_id' }],
    metricHeaders: [{ name: 'eventCount', type: 'TYPE_INTEGER' }],
    rows: rows.map(([eventName, value, count]) => ({
      dimensionValues: [{ value: eventName }, { value }],
      metricValues: [{ value: count }],
    })),
    rowCount: rows.length,
    metadata: { currencyCode: 'USD', timeZone: 'America/Chicago' },
  };
}

test('a dimension probe accepts only contract vocabulary and never echoes a value', () => {
  const doc = checklist();
  assert.deepEqual(
    evaluateDimensionProbe(doc, 'step_id', probeResponse([
      ['checkout_step_view', 'people', '12'], ['checkout_step_blocked', '(not set)', '1'],
    ])),
    { verdict: 'MATCH', issues: [] },
  );
  const leaked = evaluateDimensionProbe(doc, 'step_id', probeResponse([['checkout_step_view', 'jane@example.com', '1']]));
  assert.deepEqual(leaked, { verdict: 'MISMATCH', issues: ['UNEXPECTED_VALUE'] });
  assert.doesNotMatch(JSON.stringify(leaked), /jane/);
  assert.deepEqual(
    evaluateDimensionProbe(doc, 'step_id', probeResponse([['begin_checkout', 'people', '1']])),
    { verdict: 'MISMATCH', issues: ['UNEXPECTED_EVENT'] },
  );
  assert.deepEqual(evaluateDimensionProbe(doc, 'step_id', probeResponse([])), { verdict: 'NO_DATA', issues: [] });
  assert.deepEqual(evaluateDimensionProbe(doc, 'not_registered', probeResponse([])),
    { verdict: 'INVALID_REQUEST', issues: ['DIMENSION_NOT_IN_CHECKLIST'] });

  const campaignProbe = {
    ...probeResponse([]),
    dimensionHeaders: [{ name: 'eventName' }, { name: 'customEvent:hsb_ft_campaign' }],
    rows: [
      { dimensionValues: [{ value: 'purchase' }, { value: '2026-10-holiday' }], metricValues: [{ value: '3' }] },
      { dimensionValues: [{ value: 'purchase' }, { value: 'fall sale jane' }], metricValues: [{ value: '1' }] },
    ],
    rowCount: 2,
  };
  assert.deepEqual(evaluateDimensionProbe(doc, 'hsb_ft_campaign', campaignProbe), { verdict: 'MISMATCH', issues: ['UNEXPECTED_VALUE'] });
});

// ── MATCH rests only on a complete, exactly-shaped report ──────────────────

test('the reviewer reproducer: a truncated, sampled, thresholded, other-row probe is never MATCH', () => {
  const response = {
    dimensionHeaders: [{ name: 'eventName' }, { name: 'customEvent:step_id' }],
    metricHeaders: [{ name: 'eventCount' }],
    rows: [{ dimensionValues: [{ value: 'checkout_step_view' }, { value: 'people' }], metricValues: [{ value: '1' }] }],
    rowCount: 1001,
    metadata: {
      subjectToThresholding: true,
      dataLossFromOtherRow: true,
      samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '100' }],
    },
  };
  assert.deepEqual(evaluateDimensionProbe(checklist(), 'step_id', response),
    { verdict: 'INCONCLUSIVE', issues: ['SAMPLED', 'THRESHOLDED', 'OTHER_ROW', 'TRUNCATED'] });
});

test('a dimension probe is MATCH only for a complete, well-formed report', () => {
  const doc = checklist();
  const one = probeResponse([['checkout_step_view', 'people', '1']]);
  const full = probeResponse(Array.from({ length: 1000 }, () => ['checkout_step_view', 'people', '1'] as [string, string, string]));
  const withRow = (row: Record<string, unknown>) => ({ ...one, rows: [row] });
  const cases: Array<[string, unknown, { verdict: string; issues: string[] }]> = [
    ['a full page and more rows beyond the cap', { ...full, rowCount: 1001 }, { verdict: 'INCONCLUSIVE', issues: ['TRUNCATED'] }],
    ['rowCount above the rows received', { ...one, rowCount: 2 }, { verdict: 'INCONCLUSIVE', issues: ['TRUNCATED'] }],
    ['rowCount without rows', { ...probeResponse([]), rowCount: 3 }, { verdict: 'INCONCLUSIVE', issues: ['TRUNCATED'] }],
    ['sampled', { ...one, metadata: { ...one.metadata, samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '2' }] } },
      { verdict: 'INCONCLUSIVE', issues: ['SAMPLED'] }],
    ['thresholded', { ...one, metadata: { ...one.metadata, subjectToThresholding: true } }, { verdict: 'INCONCLUSIVE', issues: ['THRESHOLDED'] }],
    ['other row', { ...one, metadata: { ...one.metadata, dataLossFromOtherRow: true } }, { verdict: 'INCONCLUSIVE', issues: ['OTHER_ROW'] }],
    ['no rows but thresholded', { ...probeResponse([]), metadata: { subjectToThresholding: true } },
      { verdict: 'INCONCLUSIVE', issues: ['THRESHOLDED'] }],
    ['extra dimension cell', withRow({ dimensionValues: [{ value: 'checkout_step_view' }, { value: 'people' }, { value: 'x' }], metricValues: [{ value: '1' }] }),
      { verdict: 'INVALID_RESPONSE', issues: ['ROW_SHAPE'] }],
    ['extra metric cell', withRow({ dimensionValues: [{ value: 'checkout_step_view' }, { value: 'people' }], metricValues: [{ value: '1' }, { value: '2' }] }),
      { verdict: 'INVALID_RESPONSE', issues: ['ROW_SHAPE'] }],
    ['rowCount below the rows received', { ...one, rowCount: 0 }, { verdict: 'INVALID_RESPONSE', issues: ['ROW_COUNT_INVALID'] }],
    ['rowCount missing beside rows', (() => { const r: Record<string, unknown> = { ...one }; delete r.rowCount; return r; })(),
      { verdict: 'INVALID_RESPONSE', issues: ['ROW_COUNT_INVALID'] }],
    ['unrequested response field', { ...one, nextPageToken: 'x' }, { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] }],
    ['unknown metadata field', { ...one, metadata: { ...one.metadata, partial: true } }, { verdict: 'INVALID_RESPONSE', issues: ['METADATA_INVALID'] }],
    ['non-numeric count', probeResponse([['checkout_step_view', 'people', 'many']]), { verdict: 'INVALID_RESPONSE', issues: ['METRIC_INVALID'] }],
    ['a received leak is definitive even when truncated', { ...probeResponse([['checkout_step_view', 'jane@example.com', '1']]), rowCount: 5 },
      { verdict: 'MISMATCH', issues: ['UNEXPECTED_VALUE'] }],
  ];
  for (const [label, response, expected] of cases) {
    const result = evaluateDimensionProbe(doc, 'step_id', response);
    assert.deepEqual(result, expected, label);
    assert.doesNotMatch(JSON.stringify(result), /jane|people/, label);
  }
  assert.deepEqual(evaluateDimensionProbe(doc, 'step_id', full), { verdict: 'MATCH', issues: [] }, 'a complete full page still matches');
});

test('Admin list readbacks fail closed on malformed pagination, unknown fields and duplicate entries', () => {
  const doc = checklist();
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: adminDimensions(), nextPageToken: 5 }),
    { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] });
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: adminDimensions(), partial: true }),
    { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] });
  const userDuplicate = [...adminDimensions(), { parameterName: 'step_id', displayName: 'Checkout step', scope: 'USER' }];
  assert.deepEqual(evaluateCustomDimensionsReadback(doc, { customDimensions: userDuplicate }),
    { verdict: 'MISMATCH', issues: ['DUPLICATE_DIMENSION:step_id'] });

  const purchase = { name: 'properties/123456789/keyEvents/1', eventName: 'purchase', countingMethod: 'ONCE_PER_EVENT' };
  assert.deepEqual(evaluateKeyEventsReadback(doc, { keyEvents: [purchase, { ...purchase, countingMethod: 'ONCE_PER_SESSION' }] }),
    { verdict: 'MISMATCH', issues: ['DUPLICATE_KEY_EVENT:purchase'] });
  assert.deepEqual(evaluateKeyEventsReadback(doc, { keyEvents: [purchase], nextPageToken: 'next' }),
    { verdict: 'INCONCLUSIVE', issues: ['RESPONSE_PAGINATED'] });
  assert.deepEqual(evaluateKeyEventsReadback(doc, { keyEvents: [purchase], nextPageToken: null }),
    { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] });
});

test('the reviewer reproducer: a dimension probe with emptyReason is INCONCLUSIVE, never NO_DATA; beside rows it is contradictory', () => {
  const doc = checklist();
  const reason = 'Data is not available for this request';
  const empty = { ...probeResponse([]), metadata: { currencyCode: 'USD', timeZone: 'America/Chicago', emptyReason: reason } };
  const withoutRows: Record<string, unknown> = { ...empty };
  delete withoutRows.rows;
  delete withoutRows.rowCount;
  for (const [label, response] of [['rows omitted', withoutRows], ['empty rows list', empty]] as Array<[string, unknown]>) {
    const result = evaluateDimensionProbe(doc, 'step_id', response);
    assert.deepEqual(result, { verdict: 'INCONCLUSIVE', issues: ['EMPTY_REASON'] }, label);
    assert.doesNotMatch(JSON.stringify(result), /not available|request/i, label);
  }
  const contradictory = { ...probeResponse([['checkout_step_view', 'people', '1']]), metadata: { currencyCode: 'USD', timeZone: 'America/Chicago', emptyReason: reason } };
  assert.deepEqual(evaluateDimensionProbe(doc, 'step_id', contradictory), { verdict: 'INVALID_RESPONSE', issues: ['METADATA_INVALID'] });
  const flagged = { ...empty, metadata: { ...empty.metadata, subjectToThresholding: true } };
  assert.deepEqual(evaluateDimensionProbe(doc, 'step_id', flagged), { verdict: 'INCONCLUSIVE', issues: ['THRESHOLDED', 'EMPTY_REASON'] });
});
