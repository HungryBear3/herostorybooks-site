/**
 * Source-side export for the offline decision packet.
 *
 * HSB emits its own versioned, closed GA4-behavior export (HSB vocabulary), a
 * JSON Schema generated from the same rules, a deterministic synthetic
 * fixture, and a machine-checked mapping contract that states exactly which
 * HSB values the packet can accept today and which need a reviewed packet
 * vocabulary extension. Raw URLs, query strings, identifiers and free text
 * can never be represented, and a truncated report is never certified.
 * The conversion into the packet's own document is proven against the pinned
 * packet in tests/decision-packet-compat.test.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  type Ga4BehaviorExportRequest,
  buildGa4BehaviorExportRequest,
  exportDecisionPacketGa4Behavior,
  generateSyntheticGa4BehaviorExport,
  governGa4BehaviorDimensions,
  hsbGa4BehaviorExportJsonSchema,
  projectGa4BehaviorReport,
  summarizeDecisionPacketMapping,
  validateDecisionPacketMapping,
  validateHsbGa4BehaviorExport,
} from '../src/lib/analytics-decision-export.ts';
import { validateJsonSchemaSubset } from './helpers/json-schema-subset.ts';

const readJson = (relative: string) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const readText = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// ── Raw GA4 dimension values → governed HSB values ──────────────────────────

test('raw GA4 dimensions collapse to governed HSB values or fixed sentinels', () => {
  const raw = (sessionSource: unknown, sessionMedium: unknown, sessionCampaignName: unknown, sessionManualAdContent: unknown, landingPage: unknown) =>
    ({ sessionSource, sessionMedium, sessionCampaignName, sessionManualAdContent, landingPage });
  const cases: Array<[ReturnType<typeof raw>, Record<string, string>]> = [
    [raw('(direct)', '(none)', '(direct)', '(not set)', '/'),
      { source: 'direct', medium: 'none', campaign: 'none', content: 'not_set', landing_path: '/' }],
    [raw('facebook', 'paid_social', '2026-10-holiday', 'video-a', '/gifts/holidays'),
      { source: 'facebook', medium: 'paid_social', campaign: '2026-10-holiday', content: 'video-a', landing_path: '/gifts/holidays' }],
    [raw('Facebook', ' PAID_SOCIAL ', '2026-10-HOLIDAY', 'Video-A', '/gifts/holidays/'),
      { source: 'facebook', medium: 'paid_social', campaign: '2026-10-holiday', content: 'video-a', landing_path: '/gifts/holidays' }],
    [raw('l.facebook.com', 'referral', '(referral)', '(not set)', '/status/ord_ZQXSYNTH7731'),
      { source: 'facebook', medium: 'referral', campaign: 'none', content: 'not_set', landing_path: 'other' }],
    [raw('jane@example.com', 'email', 'Jane Doe fall promo', 'jane-doe', '/?email=jane@example.com&childName=Jane'),
      { source: 'other', medium: 'email', campaign: 'other', content: 'other', landing_path: '/' }],
    [raw('google', 'organic', '(organic)', '(not set)', '/gifts?gclid=Cj0KCQjane'),
      { source: 'google', medium: 'organic', campaign: 'none', content: 'not_set', landing_path: '/gifts' }],
    [raw('(not set)', '(not set)', '(not set)', '(not set)', '(not set)'),
      { source: 'not_set', medium: 'not_set', campaign: 'not_set', content: 'not_set', landing_path: 'not_set' }],
    [raw('', '', '', '', ''),
      { source: 'not_set', medium: 'not_set', campaign: 'not_set', content: 'not_set', landing_path: 'not_set' }],
    [raw('telegram', 'social', 'launch', 'text-c', '/pricing'),
      { source: 'telegram', medium: 'social', campaign: 'launch', content: 'text-c', landing_path: '/pricing' }],
    [raw('bing', 'cpc', '2026-11-gifts.v2', 'carousel-b', 'https://herostorybooks.com/pricing'),
      { source: 'bing', medium: 'cpc', campaign: '2026-11-gifts.v2', content: 'carousel-b', landing_path: 'other' }],
    [raw('jane-doe.example.com', 'ref', 'cs_live_a1B2c3D4e5F6', '123456789.1727500000', '/family-review/review/tok_abc'),
      { source: 'other', medium: 'other', campaign: 'other', content: 'other', landing_path: 'other' }],
    [raw(42, null, undefined, {}, ['/']),
      { source: 'other', medium: 'other', campaign: 'other', content: 'other', landing_path: 'other' }],
    [raw('constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'),
      { source: 'other', medium: 'other', campaign: 'other', content: 'other', landing_path: 'other' }],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(governGa4BehaviorDimensions(input), expected, JSON.stringify(input));
  }
});

// ── Read-only export request + report projection ────────────────────────────

test('the export request is a deterministic read-only runReport', () => {
  assert.deepEqual(buildGa4BehaviorExportRequest({ propertyId: '123456789', startDate: '2026-09-01', endDate: '2026-09-30' }), {
    ok: true,
    request: {
      method: 'POST',
      url: 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport',
      oauthScope: 'https://www.googleapis.com/auth/analytics.readonly',
      body: {
        dateRanges: [{ startDate: '2026-09-01', endDate: '2026-09-30' }],
        dimensions: [
          { name: 'date' }, { name: 'sessionSource' }, { name: 'sessionMedium' },
          { name: 'sessionCampaignName' }, { name: 'sessionManualAdContent' }, { name: 'landingPage' },
        ],
        metrics: [{ name: 'sessions' }, { name: 'checkouts' }, { name: 'ecommercePurchases' }],
        keepEmptyRows: false,
        limit: '250000',
      },
    },
  });
  assert.deepEqual(buildGa4BehaviorExportRequest({ propertyId: '123456789', startDate: '30daysAgo', endDate: 'today' }),
    { ok: false, reason: 'DATE_INVALID' });
});

const DIMENSION_HEADERS = ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'sessionManualAdContent', 'landingPage'];
const METRIC_HEADERS = ['sessions', 'checkouts', 'ecommercePurchases'];

function ga4Report(rows: Array<[string[], string[]]>, metadata: Record<string, unknown> = {}) {
  return {
    dimensionHeaders: DIMENSION_HEADERS.map((name) => ({ name })),
    metricHeaders: METRIC_HEADERS.map((name) => ({ name, type: 'TYPE_INTEGER' })),
    rows: rows.map(([dimensions, metrics]) => ({
      dimensionValues: dimensions.map((value) => ({ value })),
      metricValues: metrics.map((value) => ({ value })),
    })),
    rowCount: rows.length,
    metadata: { currencyCode: 'USD', timeZone: 'America/Chicago', ...metadata },
  };
}

/** The exact built request a projection is bound to; a projection without one cannot exist. */
function request(startDate: string, endDate: string): Ga4BehaviorExportRequest {
  const built = buildGa4BehaviorExportRequest({ propertyId: '123456789', startDate, endDate });
  assert.equal(built.ok, true);
  return (built as { ok: true; request: Ga4BehaviorExportRequest }).request;
}
const TWO_DAYS_REQUEST = request('2026-09-01', '2026-09-02');
const ONE_DAY_REQUEST = request('2026-09-01', '2026-09-01');

const HEADER = {
  dataOrigin: 'operator_export',
  generatedAt: '2026-09-30T12:00:00Z',
  coverage: { start: '2026-09-01', end: '2026-09-02' },
  attestedCompleteRanges: [{ start: '2026-09-01', end: '2026-09-02' }],
};

test('a hostile GA4 report projects to an exact, aggregated, governed export', () => {
  const response = ga4Report([
    [['20260901', 'facebook', 'paid_social', '2026-09-gifts', 'video-a', '/gifts/birthdays?fbclid=IwAR0jane'], ['40', '4', '1']],
    [['20260901', 'jane@example.com', 'email', 'Jane promo', 'jane-doe', '/?email=jane@example.com'], ['3', '0', '0']],
    [['20260901', 'newsletter', 'email', '(not set)', '(not set)', '/status/ord_ZQXSYNTH7731'], ['2', '0', '0']],
    [['20260901', '(direct)', '(none)', '(direct)', '(not set)', '/'], ['20', '1', '0']],
    [['20260902', 'l.facebook.com', 'referral', '(referral)', '(not set)', '/gifts/birthdays'], ['5', '1', '1']],
    [['20260902', 'm.facebook.com', 'referral', '(referral)', '(not set)', '/gifts/birthdays/'], ['2', '0', '0']],
  ]);
  const projected = projectGa4BehaviorReport(TWO_DAYS_REQUEST, response, HEADER);
  assert.deepEqual(projected, {
    ok: true,
    document: {
      schema: 'hsb.decision_export.ga4_behavior',
      schema_version: 1,
      data_origin: 'operator_export',
      business: 'hsb',
      timezone: 'America/Chicago',
      generated_at: '2026-09-30T12:00:00Z',
      coverage: { start: '2026-09-01', end: '2026-09-02' },
      attested_complete_ranges: [{ start: '2026-09-01', end: '2026-09-02' }],
      quality: { sampled: false, thresholded: false, other_row: false },
      rows: [
        { date: '2026-09-01', source: 'direct', medium: 'none', campaign: 'none', content: 'not_set', landing_path: '/', sessions: 20, checkout_starts: 1, purchase_events: 0 },
        { date: '2026-09-01', source: 'facebook', medium: 'paid_social', campaign: '2026-09-gifts', content: 'video-a', landing_path: '/gifts/birthdays', sessions: 40, checkout_starts: 4, purchase_events: 1 },
        { date: '2026-09-01', source: 'newsletter', medium: 'email', campaign: 'not_set', content: 'not_set', landing_path: 'other', sessions: 2, checkout_starts: 0, purchase_events: 0 },
        { date: '2026-09-01', source: 'other', medium: 'email', campaign: 'other', content: 'other', landing_path: '/', sessions: 3, checkout_starts: 0, purchase_events: 0 },
        { date: '2026-09-02', source: 'facebook', medium: 'referral', campaign: 'none', content: 'not_set', landing_path: '/gifts/birthdays', sessions: 7, checkout_starts: 1, purchase_events: 1 },
      ],
    },
    completeness: 'ATTESTED',
    reasons: [],
  });
  assert.doesNotMatch(JSON.stringify(projected), /jane|ord_|fbclid|\?|@|l\.facebook/i);
  if (projected.ok) assert.deepEqual(validateHsbGa4BehaviorExport(projected.document), []);
});

test('malformed reports are refused', () => {
  const one: Array<[string[], string[]]> = [[['20260901', '(direct)', '(none)', '(direct)', '(not set)', '/'], ['1', '0', '0']]];
  const refusals: Array<[unknown, Record<string, unknown>, string[]]> = [
    [ga4Report([[['20260901', 'google', 'organic', '(organic)', '(not set)', '/'], ['1.5', '0', '0']]]), HEADER, ['METRIC_INVALID@$.rows[0]']],
    [ga4Report([[['20260901', 'google', 'organic', '(organic)', '(not set)', '/'], ['-1', '0', '0']]]), HEADER, ['METRIC_INVALID@$.rows[0]']],
    [ga4Report([[['2026-09-01', 'google', 'organic', '(organic)', '(not set)', '/'], ['1', '0', '0']]]), HEADER, ['DATE_INVALID@$.rows[0]']],
    [ga4Report([[['20260905', 'google', 'organic', '(organic)', '(not set)', '/'], ['1', '0', '0']]]), HEADER, ['ROW_OUTSIDE_COVERAGE@$.rows[0]']],
    [{ ...ga4Report(one), dimensionHeaders: [{ name: 'date' }] }, HEADER, ['HEADERS_MISMATCH@$']],
    [ga4Report(one, { timeZone: 'Europe/Paris' }), HEADER, ['TIMEZONE_UNSUPPORTED@$.metadata.timeZone']],
    [ga4Report(one), { ...HEADER, generatedAt: 'yesterday' }, ['HEADER_INVALID@$.generatedAt']],
    [ga4Report(one), { ...HEADER, dataOrigin: 'prod' }, ['HEADER_INVALID@$.dataOrigin']],
    ['jane', HEADER, ['RESPONSE_SHAPE@$']],
  ];
  for (const [response, header, issues] of refusals) {
    assert.deepEqual(projectGa4BehaviorReport(TWO_DAYS_REQUEST, response, header as never), { ok: false, issues }, JSON.stringify(issues));
  }
});

// ── Closed export schema ─────────────────────────────────────────────────────

test('the synthetic fixture generator is deterministic and literal', () => {
  const doc = generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days: 2 });
  const segment = (source: string, medium: string, campaign: string, content: string, landing_path: string) =>
    ({ source, medium, campaign, content, landing_path });
  const S0 = segment('direct', 'none', 'none', 'not_set', '/');
  const S1 = segment('facebook', 'paid_social', '2026-09-gifts', 'video-a', '/gifts/birthdays');
  const S2 = segment('newsletter', 'email', 'launch', 'text-b', '/');
  assert.deepEqual(doc, {
    schema: 'hsb.decision_export.ga4_behavior',
    schema_version: 1,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    timezone: 'America/Chicago',
    generated_at: '2026-09-05T12:00:00Z',
    coverage: { start: '2026-09-01', end: '2026-09-02' },
    attested_complete_ranges: [{ start: '2026-09-01', end: '2026-09-02' }],
    quality: { sampled: false, thresholded: false, other_row: false },
    rows: [
      { date: '2026-09-01', ...S0, sessions: 30, checkout_starts: 2, purchase_events: 1 },
      { date: '2026-09-01', ...S1, sessions: 25, checkout_starts: 3, purchase_events: 1 },
      { date: '2026-09-01', ...S2, sessions: 12, checkout_starts: 1, purchase_events: 0 },
      { date: '2026-09-02', ...S0, sessions: 31, checkout_starts: 2, purchase_events: 1 },
      { date: '2026-09-02', ...S1, sessions: 26, checkout_starts: 3, purchase_events: 1 },
      { date: '2026-09-02', ...S2, sessions: 13, checkout_starts: 1, purchase_events: 0 },
    ],
  });
  assert.equal(JSON.stringify(doc), JSON.stringify(generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days: 2 })));
  assert.deepEqual(validateHsbGa4BehaviorExport(doc), []);
});

test('the checked-in fixture and JSON Schema are exactly what the code generates', () => {
  const fixture = generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days: 7 });
  assert.equal(readText('../config/analytics/fixtures/hsb-ga4-behavior-export.synthetic.v1.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  assert.equal(readText('../config/analytics/hsb-ga4-behavior-export.schema.v1.json'), `${JSON.stringify(hsbGa4BehaviorExportJsonSchema(), null, 2)}\n`);
});

type ExportDoc = ReturnType<typeof generateSyntheticGa4BehaviorExport>;

function hostile(change: (doc: ExportDoc & Record<string, unknown>) => void): ExportDoc {
  const doc = structuredClone(generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days: 2 })) as ExportDoc & Record<string, unknown>;
  change(doc);
  return doc;
}

const HOSTILE_EXPORTS: Array<[string, ExportDoc, string[], boolean]> = [
  // [label, document, TS validator issues, also rejected by the JSON Schema]
  ['absolute URL landing', hostile((d) => { d.rows[0].landing_path = 'https://herostorybooks.com/gifts'; }), ['FORBIDDEN_VALUE:URL@$.rows[0].landing_path'], true],
  ['query landing', hostile((d) => { d.rows[0].landing_path = '/gifts?email=x'; }), ['FORBIDDEN_VALUE:QUERY_STRING@$.rows[0].landing_path'], true],
  ['email campaign', hostile((d) => { d.rows[0].campaign = 'jane@example.com'; }), ['FORBIDDEN_VALUE:EMAIL@$.rows[0].campaign'], true],
  ['GA client id content', hostile((d) => { d.rows[0].content = '123456789.1727500000'; }), ['FORBIDDEN_VALUE:GA_CLIENT_ID@$.rows[0].content'], true],
  ['Stripe id source', hostile((d) => { d.rows[0].source = 'cs_live_a1B2c3D4e5F6'; }), ['FORBIDDEN_VALUE:PROVIDER_ID@$.rows[0].source'], true],
  ['order id campaign', hostile((d) => { d.rows[0].campaign = 'ord_ZQXSYNTH7731'; }), ['FORBIDDEN_VALUE:ORDER_ID@$.rows[0].campaign'], true],
  ['free text campaign', hostile((d) => { d.rows[0].campaign = 'fall promo'; }), ['FORBIDDEN_VALUE:FREE_TEXT@$.rows[0].campaign'], true],
  ['ungoverned source', hostile((d) => { d.rows[0].source = 'twitter'; }), ['VALUE_NOT_GOVERNED@$.rows[0].source'], true],
  ['identifier key', hostile((d) => { (d.rows[0] as unknown as Record<string, unknown>).client_id = '123.456'; }), ['FORBIDDEN_KEY@$.rows[0]'], true],
  ['float count', hostile((d) => { d.rows[0].sessions = 1.5; }), ['TYPE_INTEGER@$.rows[0].sessions'], true],
  ['negative count', hostile((d) => { d.rows[0].sessions = -1; }), ['INTEGER_OUT_OF_RANGE@$.rows[0].sessions'], true],
  ['schema version', hostile((d) => { d.schema_version = 2 as never; }), ['SCHEMA_VERSION_UNSUPPORTED@$.schema_version'], true],
  ['business', hostile((d) => { d.business = 'ot' as never; }), ['INVALID_ENUM@$.business'], true],
  ['header identifier', hostile((d) => { d.property_id = '123456789'; }), ['FORBIDDEN_KEY@$'], true],
  ['duplicate row', hostile((d) => { d.rows[1] = { ...d.rows[0] }; }), ['DUPLICATE_ROW@$.rows[1]'], false],
  ['row outside coverage', hostile((d) => { d.rows[0].date = '2026-08-31'; }), ['ROW_OUTSIDE_COVERAGE@$.rows[0].date'], false],
];

test('the TS validator rejects hostile exports with value-free codes', () => {
  for (const [label, doc, issues] of HOSTILE_EXPORTS) {
    const result = validateHsbGa4BehaviorExport(doc);
    assert.deepEqual(result, issues, label);
    assert.doesNotMatch(JSON.stringify(result), /jane|ord_zqx|cs_live|123456789\.|fall promo/, label);
  }
});

test('the generated JSON Schema is closed: it accepts the fixture and rejects every structural hostile export', () => {
  const schema = hsbGa4BehaviorExportJsonSchema();
  assert.deepEqual(validateJsonSchemaSubset(schema, generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days: 7 })), []);
  for (const [label, doc, , structural] of HOSTILE_EXPORTS) {
    if (structural) assert.notDeepEqual(validateJsonSchemaSubset(schema, doc), [], label);
  }
});

test('the JSON Schema campaign rule and the Phase-A grammar accept exactly the same values', () => {
  const schema = hsbGa4BehaviorExportJsonSchema();
  const candidates = [
    'launch', 'none', 'not_set', 'other', '2026-01-gifts', '2029-12-launch.v9', '2026-10-holiday', '2027-05-birthdays.v2',
    'Launch', '2025-01-gifts', '2030-01-gifts', '2026-13-gifts', '2026-00-gifts', '2026-10-holiday.v0',
    '2026-10-holiday.v10', '2026-10-sale', 'launch.v1', '',
  ];
  for (const campaign of candidates) {
    const doc = hostile((d) => { d.rows[0].campaign = campaign; });
    assert.equal(validateJsonSchemaSubset(schema, doc).length === 0, validateHsbGa4BehaviorExport(doc).length === 0, campaign);
  }
});

// ── Mapping contract to the standalone packet ───────────────────────────────

const MAPPING_PATH = '../config/analytics/decision-packet-mapping.v1.json';

test('the checked-in mapping contract is complete and closed over the HSB export vocabulary', () => {
  assert.deepEqual(validateDecisionPacketMapping(readJson(MAPPING_PATH)), []);
});

test('the mapping contract states the packet vocabulary gaps explicitly', () => {
  assert.deepEqual(summarizeDecisionPacketMapping(readJson(MAPPING_PATH)), {
    target: { schema: 'decision_packet.ga4_behavior', schema_version: 1 },
    blocked: {
      source: ['telegram'],
      medium: [],
      campaign: ['governed'],
      content: ['carousel-c', 'image-c', 'text-c', 'video-c'],
      landing_path: [
        '/about', '/checkout', '/create/your-memory', '/gifts', '/gifts/birthdays', '/gifts/child-as-hero',
        '/gifts/grandparents', '/gifts/holidays', '/gifts/pets', '/gifts/siblings', '/pricing', '/samples',
      ],
    },
    extensions_required: [
      'PACKET_CAMPAIGN_VOCABULARY_MISSING',
      'PACKET_CONTENT_VARIANT_MISSING',
      'PACKET_LANDING_PATH_VOCABULARY_MISSING',
      'PACKET_SOURCE_VOCABULARY_MISSING',
    ],
  });
});

test('mapping defects are rejected', () => {
  const mutate = (change: (doc: Record<string, any>) => void) => { const doc = readJson(MAPPING_PATH); change(doc); return doc; };
  const cases: Array<[string, unknown, string[]]> = [
    ['missing value', mutate((d) => { delete d.value_maps.source.telegram; }),
      ['MAPPING_INCOMPLETE@$.value_maps.source', 'MAPPING_EXTENSION_UNUSED@$.extensions_required']],
    ['unknown value', mutate((d) => { d.value_maps.source['jane@example.com'] = { to: 'other' }; }), ['MAPPING_UNKNOWN_VALUE@$.value_maps.source']],
    ['forbidden target', mutate((d) => { d.value_maps.medium.email = { to: 'https://evil.example' }; }), ['MAPPING_TARGET_FORBIDDEN@$.value_maps.medium.email']],
    ['undeclared extension', mutate((d) => { d.value_maps.content['video-c'] = { blocked: 'PACKET_NEW_GAP' }; }),
      ['MAPPING_EXTENSION_UNDECLARED@$.value_maps.content.video-c']],
    ['any fallback', mutate((d) => { d.value_maps.source.telegram = { blocked: 'PACKET_SOURCE_VOCABULARY_MISSING', fallback: 'telegram' }; }),
      ['MAPPING_ENTRY_INVALID@$.value_maps.source.telegram', 'MAPPING_EXTENSION_UNUSED@$.extensions_required']],
    ['wrong target schema', mutate((d) => { d.target.schema = 'decision_packet.payment_ledger'; }), ['MAPPING_TARGET_SCHEMA@$.target.schema']],
    ['free-text key', mutate((d) => { d.notes = 'ask Jane'; }), ['FORBIDDEN_KEY@$']],
  ];
  for (const [label, doc, expected] of cases) assert.deepEqual(validateDecisionPacketMapping(doc), expected, label);
});

// ── Completeness: truncation is refused; GA4 data loss is never attested ─────

const ONE_DAY = {
  dataOrigin: 'operator_export',
  generatedAt: '2026-09-30T12:00:00Z',
  coverage: { start: '2026-09-01', end: '2026-09-01' },
  attestedCompleteRanges: [{ start: '2026-09-01', end: '2026-09-01' }],
};
const GOVERNED_ROW: [string[], string[]] = [['20260901', 'facebook', 'paid_social', '2026-09-gifts', 'video-a', '/'], ['1', '0', '0']];

test('the reviewer reproducer: rowCount 250001 against one received row is refused', () => {
  const report = {
    dimensionHeaders: DIMENSION_HEADERS.map((name) => ({ name })),
    metricHeaders: METRIC_HEADERS.map((name) => ({ name })),
    rows: [{ dimensionValues: GOVERNED_ROW[0].map((value) => ({ value })), metricValues: GOVERNED_ROW[1].map((value) => ({ value })) }],
    rowCount: 250001,
    metadata: { timeZone: 'America/Chicago' },
  };
  assert.deepEqual(projectGa4BehaviorReport(ONE_DAY_REQUEST, report, ONE_DAY), { ok: false, issues: ['REPORT_TRUNCATED@$.rowCount'] });
});

test('a full 250000-row page is refused when GA4 reports 250001 rows, and complete at exactly 250000', () => {
  const [page] = [ga4Report([GOVERNED_ROW])];
  const rows = Array.from({ length: 250_000 }, () => page.rows[0]);
  assert.deepEqual(projectGa4BehaviorReport(ONE_DAY_REQUEST, { ...page, rows, rowCount: 250_001 }, ONE_DAY),
    { ok: false, issues: ['REPORT_TRUNCATED@$.rowCount'] });
  const complete = projectGa4BehaviorReport(ONE_DAY_REQUEST, { ...page, rows, rowCount: 250_000 }, ONE_DAY);
  assert.equal(complete.ok, true);
  if (!complete.ok) return;
  assert.equal(complete.completeness, 'ATTESTED');
  assert.deepEqual(complete.document.rows.map((row) => row.sessions), [250_000]);
  assert.deepEqual(complete.document.attested_complete_ranges, [{ start: '2026-09-01', end: '2026-09-01' }]);
});

test('row-count, response and metadata ambiguity is refused rather than certified', () => {
  const one = ga4Report([GOVERNED_ROW]);
  const cases: Array<[string, unknown, string[]]> = [
    ['rowCount above the rows received', { ...one, rowCount: 2 }, ['REPORT_TRUNCATED@$.rowCount']],
    ['rowCount without rows', { ...ga4Report([]), rowCount: 5 }, ['REPORT_TRUNCATED@$.rowCount']],
    ['rowCount below the rows received', { ...one, rowCount: 0 }, ['ROW_COUNT_INVALID@$.rowCount']],
    ['rowCount missing beside rows', (() => { const r: Record<string, unknown> = { ...one }; delete r.rowCount; return r; })(),
      ['ROW_COUNT_INVALID@$.rowCount']],
    ['rowCount as text', { ...one, rowCount: '1' }, ['ROW_COUNT_INVALID@$.rowCount']],
    ['pagination token', { ...one, nextPageToken: 'next' }, ['RESPONSE_SHAPE@$']],
    ['unrequested totals', { ...one, totals: [] }, ['RESPONSE_SHAPE@$']],
    ['unknown metadata field', ga4Report([GOVERNED_ROW], { truncated: true }), ['METADATA_INVALID@$.metadata']],
    ['other-row flag as text', ga4Report([GOVERNED_ROW], { dataLossFromOtherRow: 'true' }), ['METADATA_INVALID@$.metadata.dataLossFromOtherRow']],
    ['sampling metadata not a list', ga4Report([GOVERNED_ROW], { samplingMetadatas: 'none' }), ['METADATA_INVALID@$.metadata.samplingMetadatas']],
    ['extra metric cell', { ...one, rows: [{ ...one.rows[0], metricValues: [...one.rows[0].metricValues, { value: '9' }] }] }, ['ROW_SHAPE@$.rows[0]']],
    ['cell with an extra field', { ...one, rows: [{ ...one.rows[0], dimensionValues: one.rows[0].dimensionValues.map((cell) => ({ ...cell, oneValue: 'x' })) }] },
      ['ROW_SHAPE@$.rows[0]']],
  ];
  for (const [label, response, issues] of cases) {
    assert.deepEqual(projectGa4BehaviorReport(ONE_DAY_REQUEST, response, ONE_DAY), { ok: false, issues }, label);
  }
});

test('GA4 data-loss flags make the export explicitly INSUFFICIENT_EVIDENCE and drop the attestation', () => {
  const flags: Array<[Record<string, unknown>, Record<string, boolean>, string[]]> = [
    [{ samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '2' }] }, { sampled: true, thresholded: false, other_row: false }, ['SAMPLED']],
    [{ subjectToThresholding: true }, { sampled: false, thresholded: true, other_row: false }, ['THRESHOLDED']],
    [{ dataLossFromOtherRow: true }, { sampled: false, thresholded: false, other_row: true }, ['OTHER_ROW']],
    [{ samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '2' }], subjectToThresholding: true, dataLossFromOtherRow: true },
      { sampled: true, thresholded: true, other_row: true }, ['SAMPLED', 'THRESHOLDED', 'OTHER_ROW']],
  ];
  for (const [metadata, quality, reasons] of flags) {
    const result = projectGa4BehaviorReport(ONE_DAY_REQUEST, ga4Report([GOVERNED_ROW], metadata), ONE_DAY);
    assert.equal(result.ok, true, reasons.join());
    if (!result.ok) continue;
    assert.equal(result.completeness, 'INSUFFICIENT_EVIDENCE', reasons.join());
    assert.deepEqual(result.reasons, reasons);
    assert.deepEqual(result.document.quality, quality);
    assert.deepEqual(result.document.attested_complete_ranges, [], 'no complete-range attestation survives a GA4 data-loss flag');
    assert.deepEqual(validateHsbGa4BehaviorExport(result.document), []);
  }
  const clean = projectGa4BehaviorReport(ONE_DAY_REQUEST, ga4Report([GOVERNED_ROW], { samplingMetadatas: [], subjectToThresholding: false }), ONE_DAY);
  assert.equal(clean.ok && clean.completeness, 'ATTESTED');
});

test('an export may not attest completeness while it carries a GA4 data-loss flag', () => {
  for (const flag of ['sampled', 'thresholded', 'other_row'] as const) {
    const attested = hostile((d) => { d.quality[flag] = true; });
    assert.deepEqual(validateHsbGa4BehaviorExport(attested), ['ATTESTATION_CONTRADICTS_QUALITY@$.attested_complete_ranges'], flag);
    const honest = hostile((d) => { d.quality[flag] = true; d.attested_complete_ranges = []; });
    assert.deepEqual(validateHsbGa4BehaviorExport(honest), [], flag);
  }
});

// ── B-2: every projection is bound to the request that produced the report ──

test('the reviewer reproducer: a header cannot attest days outside the requested range', () => {
  const wide = {
    ...ONE_DAY,
    generatedAt: '2026-09-30T12:00:00Z',
    coverage: { start: '2026-09-01', end: '2026-09-07' },
    attestedCompleteRanges: [{ start: '2026-09-01', end: '2026-09-07' }],
  };
  assert.deepEqual(projectGa4BehaviorReport(ONE_DAY_REQUEST, ga4Report([GOVERNED_ROW]), wide),
    { ok: false, issues: ['RANGE_UNBOUND@$.coverage'] });
});

test('coverage and attestation may narrow the request but never widen, shift, or leave it', () => {
  const three = request('2026-09-01', '2026-09-03');
  const rows: Array<[string[], string[]]> = [GOVERNED_ROW, [['20260902', '(direct)', '(none)', '(direct)', '(not set)', '/'], ['2', '0', '0']]];
  const header = (coverage: { start: string; end: string }, attested: Array<{ start: string; end: string }>) =>
    ({ dataOrigin: 'operator_export', generatedAt: '2026-09-30T12:00:00Z', coverage, attestedCompleteRanges: attested });
  const narrowed = projectGa4BehaviorReport(three, ga4Report(rows), header({ start: '2026-09-01', end: '2026-09-02' }, [{ start: '2026-09-02', end: '2026-09-02' }]));
  assert.equal(narrowed.ok, true);
  if (narrowed.ok) {
    assert.deepEqual(narrowed.document.coverage, { start: '2026-09-01', end: '2026-09-02' });
    assert.deepEqual(narrowed.document.attested_complete_ranges, [{ start: '2026-09-02', end: '2026-09-02' }]);
    assert.equal(narrowed.completeness, 'ATTESTED');
  }
  const cases: Array<[string, ReturnType<typeof header>, string[]]> = [
    ['coverage widened before the request', header({ start: '2026-08-31', end: '2026-09-03' }, []), ['RANGE_UNBOUND@$.coverage']],
    ['coverage widened after the request', header({ start: '2026-09-01', end: '2026-09-04' }, []), ['RANGE_UNBOUND@$.coverage']],
    ['coverage shifted', header({ start: '2026-09-02', end: '2026-09-04' }, []), ['RANGE_UNBOUND@$.coverage']],
    ['attestation outside coverage', header({ start: '2026-09-01', end: '2026-09-02' }, [{ start: '2026-09-01', end: '2026-09-03' }]), ['ATTESTED_RANGE_INVALID@$.attestedCompleteRanges[0]']],
    ['attestation before coverage', header({ start: '2026-09-02', end: '2026-09-03' }, [{ start: '2026-09-01', end: '2026-09-02' }]), ['ATTESTED_RANGE_INVALID@$.attestedCompleteRanges[0]']],
    ['reversed attested range', header({ start: '2026-09-01', end: '2026-09-03' }, [{ start: '2026-09-03', end: '2026-09-01' }]), ['HEADER_INVALID@$.attestedCompleteRanges']],
    ['overlapping attested ranges', header({ start: '2026-09-01', end: '2026-09-03' }, [{ start: '2026-09-01', end: '2026-09-02' }, { start: '2026-09-02', end: '2026-09-03' }]), ['ATTESTED_RANGE_INVALID@$.attestedCompleteRanges[1]']],
    ['duplicate attested ranges', header({ start: '2026-09-01', end: '2026-09-03' }, [{ start: '2026-09-01', end: '2026-09-01' }, { start: '2026-09-01', end: '2026-09-01' }]), ['ATTESTED_RANGE_INVALID@$.attestedCompleteRanges[1]']],
    ['unordered attested ranges', header({ start: '2026-09-01', end: '2026-09-03' }, [{ start: '2026-09-03', end: '2026-09-03' }, { start: '2026-09-01', end: '2026-09-01' }]), ['ATTESTED_RANGE_INVALID@$.attestedCompleteRanges[1]']],
    ['reversed coverage', header({ start: '2026-09-03', end: '2026-09-01' }, []), ['HEADER_INVALID@$.coverage']],
    ['year-zero coverage', header({ start: '0000-12-31', end: '2026-09-01' }, []), ['HEADER_INVALID@$.coverage']],
    ['timestamp-shaped coverage', header({ start: '2026-09-01T00:00:00Z', end: '2026-09-02' }, []), ['HEADER_INVALID@$.coverage']],
    ['unpadded coverage', header({ start: '2026-9-1', end: '2026-09-02' }, []), ['HEADER_INVALID@$.coverage']],
    ['impossible calendar day', header({ start: '2026-09-01', end: '2026-09-31' }, []), ['HEADER_INVALID@$.coverage']],
    ['non-string dates', header({ start: 20260901 as never, end: '2026-09-02' }, []), ['HEADER_INVALID@$.coverage']],
    ['inherited coverage', header(Object.create({ start: '2026-09-01', end: '2026-09-02' }), []), ['HEADER_INVALID@$.coverage']],
    ['attested ranges not a list', header({ start: '2026-09-01', end: '2026-09-02' }, { 0: { start: '2026-09-01', end: '2026-09-01' } } as never), ['HEADER_INVALID@$.attestedCompleteRanges']],
  ];
  for (const [label, hdr, issues] of cases) {
    const result = projectGa4BehaviorReport(three, ga4Report(rows), hdr);
    assert.deepEqual(result, { ok: false, issues }, label);
  }
});

test('a projection refuses any request that is not exactly a built export request', () => {
  const built = ONE_DAY_REQUEST;
  const body = built.body as Record<string, unknown>;
  const cases: Array<[string, unknown]> = [
    ['no request', undefined],
    ['null request', null],
    ['the response passed as the request', ga4Report([GOVERNED_ROW])],
    ['a transaction-readback-shaped request', { ...built, body: { ...body, dimensions: [{ name: 'transactionId' }], metrics: [{ name: 'eventCount' }] } }],
    ['a smaller row limit', { ...built, body: { ...body, limit: '10' } }],
    ['keepEmptyRows true', { ...built, body: { ...body, keepEmptyRows: true } }],
    ['two date ranges', { ...built, body: { ...body, dateRanges: [...(body.dateRanges as unknown[]), { startDate: '2026-09-02', endDate: '2026-09-02' }] } }],
    ['relative dates', { ...built, body: { ...body, dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }] } }],
    ['reversed dates', { ...built, body: { ...body, dateRanges: [{ startDate: '2026-09-02', endDate: '2026-09-01' }] } }],
    ['year-zero dates', { ...built, body: { ...body, dateRanges: [{ startDate: '0000-01-01', endDate: '0000-01-01' }] } }],
    ['a non-numeric property in the url', { ...built, url: built.url.replace('123456789', 'abc') }],
    ['a different endpoint', { ...built, url: built.url.replace(':runReport', ':runPivotReport') }],
    ['a GET', { ...built, method: 'GET' }],
    ['a wider scope', { ...built, oauthScope: 'https://www.googleapis.com/auth/analytics.edit' }],
    ['an extra field', { ...built, token: 'x' }],
    ['a missing body', (() => { const r: Record<string, unknown> = { ...built }; delete r.body; return r; })()],
    ['an inherited request', Object.create(built)],
  ];
  for (const [label, req] of cases) {
    assert.deepEqual(projectGa4BehaviorReport(req as never, ga4Report([GOVERNED_ROW]), ONE_DAY), { ok: false, issues: ['REQUEST_INVALID@$.request'] }, label);
  }
});

test('packet boundary dates stay representable through a bound projection', () => {
  const early = request('0001-01-01', '0001-01-02');
  const earlyHeader = { dataOrigin: 'operator_export', generatedAt: '0001-01-05T00:00:00Z', coverage: { start: '0001-01-01', end: '0001-01-02' }, attestedCompleteRanges: [{ start: '0001-01-01', end: '0001-01-02' }] };
  const earlyRows: Array<[string[], string[]]> = [[['00010101', '(direct)', '(none)', '(direct)', '(not set)', '/'], ['1', '0', '0']]];
  const earlyResult = projectGa4BehaviorReport(early, ga4Report(earlyRows), earlyHeader);
  assert.equal(earlyResult.ok && earlyResult.completeness, 'ATTESTED');
  if (earlyResult.ok) assert.deepEqual(validateHsbGa4BehaviorExport(earlyResult.document), []);
  const late = request('9999-12-26', '9999-12-27');
  const lateHeader = { dataOrigin: 'operator_export', generatedAt: '9999-12-31T00:00:00Z', coverage: { start: '9999-12-26', end: '9999-12-27' }, attestedCompleteRanges: [{ start: '9999-12-26', end: '9999-12-27' }] };
  const lateRows: Array<[string[], string[]]> = [[['99991227', '(direct)', '(none)', '(direct)', '(not set)', '/'], ['1', '0', '0']]];
  const lateResult = projectGa4BehaviorReport(late, ga4Report(lateRows), lateHeader);
  assert.equal(lateResult.ok && lateResult.completeness, 'ATTESTED');
  if (lateResult.ok) assert.deepEqual(validateHsbGa4BehaviorExport(lateResult.document), []);
  assert.deepEqual(buildGa4BehaviorExportRequest({ propertyId: '123456789', startDate: '0000-12-31', endDate: '0001-01-01' }), { ok: false, reason: 'DATE_INVALID' });
});

// ── B-1: emptyReason at the export boundary ─────────────────────────────────

test('the reviewer reproducer: an emptyReason report is INSUFFICIENT_EVIDENCE with no attested range, never ATTESTED', () => {
  const reason = 'Data is not available for this request';
  const empty: Record<string, unknown> = { ...ga4Report([], { emptyReason: reason }) };
  delete empty.rows;
  delete empty.rowCount;
  for (const [label, response] of [['rows omitted', empty], ['empty rows list', ga4Report([], { emptyReason: reason })]] as Array<[string, unknown]>) {
    const result = projectGa4BehaviorReport(ONE_DAY_REQUEST, response, ONE_DAY);
    assert.equal(result.ok, true, label);
    if (!result.ok) continue;
    assert.equal(result.completeness, 'INSUFFICIENT_EVIDENCE', label);
    assert.deepEqual(result.reasons, ['EMPTY_REASON'], label);
    assert.deepEqual(result.document.attested_complete_ranges, [], label);
    assert.deepEqual(result.document.rows, [], label);
    assert.deepEqual(result.document.quality, { sampled: false, thresholded: false, other_row: false }, label);
    assert.deepEqual(validateHsbGa4BehaviorExport(result.document), [], label);
    assert.doesNotMatch(JSON.stringify(result), /not available|request/i, `${label}: reason text leaked`);
  }
  const flagged = projectGa4BehaviorReport(ONE_DAY_REQUEST, ga4Report([], { emptyReason: reason, dataLossFromOtherRow: true }), ONE_DAY);
  assert.deepEqual(flagged.ok && flagged.reasons, ['OTHER_ROW', 'EMPTY_REASON']);
});

test('emptyReason beside returned rows is contradictory metadata and refuses the export', () => {
  assert.deepEqual(projectGa4BehaviorReport(ONE_DAY_REQUEST, ga4Report([GOVERNED_ROW], { emptyReason: 'x' }), ONE_DAY),
    { ok: false, issues: ['METADATA_INVALID@$.metadata.emptyReason'] });
  for (const value of [null, ['x'], 1, { reason: 'x' }]) {
    assert.deepEqual(projectGa4BehaviorReport(ONE_DAY_REQUEST, ga4Report([], { emptyReason: value }), ONE_DAY),
      { ok: false, issues: ['METADATA_INVALID@$.metadata.emptyReason'] }, JSON.stringify(value));
  }
});

test('an attestation the pinned packet cannot settle never becomes a packet document', () => {
  // Past 9999-12-28 the packet's 48 h settle arithmetic overflows and its validator crashes rather than rejects;
  // HSB refuses before a packet document exists, while the HSB export itself stays well formed.
  const mapping = readJson(MAPPING_PATH);
  const late = request('9999-12-26', '9999-12-30');
  const header = (end: string) => ({
    dataOrigin: 'operator_export', generatedAt: '9999-12-31T23:59:59Z',
    coverage: { start: '9999-12-26', end: '9999-12-30' }, attestedCompleteRanges: [{ start: '9999-12-26', end }],
  });
  const rows: Array<[string[], string[]]> = [[['99991226', '(direct)', '(none)', '(direct)', '(not set)', '/'], ['1', '0', '0']]];
  const settleable = projectGa4BehaviorReport(late, ga4Report(rows), header('9999-12-28'));
  assert.equal(settleable.ok, true);
  if (settleable.ok) assert.equal(exportDecisionPacketGa4Behavior(settleable.document, mapping).ok, true);
  for (const end of ['9999-12-29', '9999-12-30']) {
    const unsettleable = projectGa4BehaviorReport(late, ga4Report(rows), header(end));
    assert.equal(unsettleable.ok, true, `${end}: the HSB export is well formed`);
    if (!unsettleable.ok) continue;
    assert.deepEqual(exportDecisionPacketGa4Behavior(unsettleable.document, mapping),
      { ok: false, issues: ['ATTESTED_RANGE_UNSETTLEABLE@$.attested_complete_ranges[0]'] }, end);
  }
});
