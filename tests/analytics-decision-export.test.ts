/**
 * Source-side export for the offline decision packet.
 *
 * HSB never imports, runs, or emits the standalone packet's documents. It
 * emits its own versioned, closed GA4-behavior export (HSB vocabulary), a
 * JSON Schema generated from the same rules, a deterministic synthetic
 * fixture, and a machine-checked mapping contract that states exactly which
 * HSB values the packet can accept today and which need a reviewed packet
 * vocabulary extension. Raw URLs, query strings, identifiers and free text
 * can never be represented.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildGa4BehaviorExportRequest,
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
  const projected = projectGa4BehaviorReport(response, HEADER);
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
  });
  assert.doesNotMatch(JSON.stringify(projected), /jane|ord_|fbclid|\?|@|l\.facebook/i);
  if (projected.ok) assert.deepEqual(validateHsbGa4BehaviorExport(projected.document), []);
});

test('report quality metadata becomes quality flags, and malformed reports are refused', () => {
  const one: Array<[string[], string[]]> = [[['20260901', '(direct)', '(none)', '(direct)', '(not set)', '/'], ['1', '0', '0']]];
  const flagged = projectGa4BehaviorReport(ga4Report(one, {
    subjectToThresholding: true, dataLossFromOtherRow: true, samplingMetadatas: [{ samplesReadCount: '1', samplingSpaceSize: '2' }],
  }), HEADER);
  assert.equal(flagged.ok, true);
  if (flagged.ok) assert.deepEqual(flagged.document.quality, { sampled: true, thresholded: true, other_row: true });

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
    assert.deepEqual(projectGa4BehaviorReport(response, header as never), { ok: false, issues }, JSON.stringify(issues));
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
    ['undeclared extension', mutate((d) => { d.value_maps.content['video-c'] = { blocked: 'PACKET_NEW_GAP', fallback: 'other' }; }),
      ['MAPPING_EXTENSION_UNDECLARED@$.value_maps.content.video-c']],
    ['fallback that keeps a value', mutate((d) => { d.value_maps.source.telegram = { blocked: 'PACKET_SOURCE_VOCABULARY_MISSING', fallback: 'telegram' }; }),
      ['MAPPING_FALLBACK_INVALID@$.value_maps.source.telegram']],
    ['wrong target schema', mutate((d) => { d.target.schema = 'decision_packet.payment_ledger'; }), ['MAPPING_TARGET_SCHEMA@$.target.schema']],
    ['free-text key', mutate((d) => { d.notes = 'ask Jane'; }), ['FORBIDDEN_KEY@$']],
  ];
  for (const [label, doc, expected] of cases) assert.deepEqual(validateDecisionPacketMapping(doc), expected, label);
});
