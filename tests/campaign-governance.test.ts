/**
 * Campaign governance: one closed naming convention shared with the Phase-A
 * attribution allowlists, and a machine-readable experiment registry whose
 * linter rejects PII/free text, unknown keys, overlapping experiments on one
 * governed segment, invalid dates/statuses/decisions and transitions, floats,
 * and mixed or unknown currencies. Governed links are proven to attribute
 * exactly through the real Phase-A capture path.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureAttributionTouch, sanitizeAttributionValue, sanitizeLandingPath } from '../src/lib/attribution-contract.ts';
import {
  CAMPAIGN_CONTENT_VALUES,
  CAMPAIGN_MEDIUM_VALUES,
  CAMPAIGN_SOURCE_VALUES,
  buildGovernedCampaignUrl,
  isCalendarDate,
  validateExperimentRegistry,
  validateExperimentRegistryTransition,
} from '../src/lib/campaign-governance.ts';
import { APPROVED_PUBLIC_ROUTE_TEMPLATES } from '../src/lib/analytics-event-contract.ts';

const EXPERIMENT = {
  experiment_id: 'hsb_exp_2026_001',
  business: 'hsb',
  status: 'running',
  start_date: '2026-10-01',
  end_date: '2026-10-31',
  source: 'facebook',
  medium: 'paid_social',
  campaign: '2026-10-holiday',
  content: 'video-a',
  landing_path: '/gifts/holidays',
  budget: { amount_minor: 150000, currency: 'USD' },
  primary_outcome: 'paid_order_rate',
  evidence_threshold: { min_denominator: 1000, min_events: 10 },
  decision: 'pending',
};
const SECOND = {
  ...EXPERIMENT,
  experiment_id: 'hsb_exp_2026_002',
  status: 'planned',
  start_date: '2026-11-01',
  end_date: '2026-11-30',
  campaign: '2026-11-holiday',
  content: null,
  primary_outcome: 'checkout_start_rate',
};

type Experiment = Record<string, any>;

function registry(experiments: Experiment[] = [EXPERIMENT, SECOND]) {
  return {
    schema: 'hsb.experiment_registry',
    schema_version: 1,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    currency: 'USD',
    // Clone each entry on its own: SECOND shares nested objects with EXPERIMENT.
    experiments: experiments.map((experiment): Experiment => structuredClone(experiment)),
  };
}

type Registry = ReturnType<typeof registry>;
function withChange(change: (doc: Registry & Record<string, any>) => void): Registry {
  const doc = registry() as Registry & Record<string, any>;
  change(doc);
  return doc;
}

// ── Naming convention is the Phase-A allowlist ──────────────────────────────

test('the governed vocabulary lists are exactly Phase-A-canonical values', () => {
  for (const value of CAMPAIGN_SOURCE_VALUES) assert.equal(sanitizeAttributionValue('utm_source', value), value);
  for (const value of CAMPAIGN_MEDIUM_VALUES) assert.equal(sanitizeAttributionValue('utm_medium', value), value);
  for (const value of CAMPAIGN_CONTENT_VALUES) assert.equal(sanitizeAttributionValue('utm_content', value), value);
  assert.equal(CAMPAIGN_CONTENT_VALUES.length, 12);
  // No value Phase A would accept is missing from the lists.
  const corpus = [
    'facebook', 'instagram', 'google', 'bing', 'newsletter', 'pinterest', 'youtube', 'tiktok', 'telegram',
    'twitter', 'x', 'reddit', 'linkedin', 'duckduckgo', 'email', 'direct', 'meta', 'fb', 'ig', 'sms',
    'paid_social', 'social', 'cpc', 'organic', 'referral', 'display', 'affiliate', 'qr', 'paid', 'none',
  ];
  for (const value of corpus) {
    assert.equal(sanitizeAttributionValue('utm_source', value) !== null, (CAMPAIGN_SOURCE_VALUES as readonly string[]).includes(value), `source ${value}`);
    assert.equal(sanitizeAttributionValue('utm_medium', value) !== null, (CAMPAIGN_MEDIUM_VALUES as readonly string[]).includes(value), `medium ${value}`);
  }
  for (const format of ['video', 'image', 'carousel', 'text', 'vid', 'img', 'story', 'reel']) {
    for (const variant of ['a', 'b', 'c', 'd', 'v2']) {
      const value = `${format}-${variant}`;
      assert.equal(sanitizeAttributionValue('utm_content', value) !== null, (CAMPAIGN_CONTENT_VALUES as readonly string[]).includes(value), value);
    }
  }
});

test('approved landing templates are Phase-A canonical public routes without identifiers', () => {
  assert.ok(APPROVED_PUBLIC_ROUTE_TEMPLATES.includes('/'));
  for (const template of APPROVED_PUBLIC_ROUTE_TEMPLATES) {
    assert.equal(sanitizeLandingPath(template), template, template);
    assert.doesNotMatch(template, /\[|\(|status|review|thank-you|admin|family-review/, template);
  }
});

// ── Registry validation ─────────────────────────────────────────────────────

test('a governed registry and the checked-in registry validate', () => {
  assert.deepEqual(validateExperimentRegistry(registry()), []);
  const checkedIn = JSON.parse(readFileSync(new URL('../config/analytics/experiment-registry.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateExperimentRegistry(checkedIn), []);
});

test('the registry linter rejects PII, free text, URLs, identifiers and unknown keys with value-free codes', () => {
  const at = (field: string) => `$.experiments[0].${field}`;
  const cases: Array<[string, Registry, string[]]> = [
    ['absolute URL', withChange((d) => { d.experiments[0].landing_path = 'https://herostorybooks.com/gifts/holidays'; }), [`FORBIDDEN_VALUE:URL@${at('landing_path')}`]],
    ['query', withChange((d) => { d.experiments[0].landing_path = '/gifts?utm_term=jane'; }), [`FORBIDDEN_VALUE:QUERY_STRING@${at('landing_path')}`]],
    ['hash', withChange((d) => { d.experiments[0].landing_path = '/gifts#top'; }), [`FORBIDDEN_VALUE:QUERY_STRING@${at('landing_path')}`]],
    ['identifier template', withChange((d) => { d.experiments[0].landing_path = '/status/[orderId]'; }), [`LANDING_PATH_NOT_APPROVED@${at('landing_path')}`]],
    ['other bucket', withChange((d) => { d.experiments[0].landing_path = '/(other)'; }), [`LANDING_PATH_NOT_APPROVED@${at('landing_path')}`]],
    ['utm_term key', withChange((d) => { d.experiments[0].utm_term = 'jane'; }), ['FORBIDDEN_KEY@$.experiments[0]']],
    ['notes key', withChange((d) => { d.experiments[0].notes = 'ask Jane'; }), ['FORBIDDEN_KEY@$.experiments[0]']],
    ['owner email key', withChange((d) => { d.owner_email = 'jane@example.com'; }), ['FORBIDDEN_KEY@$']],
    ['neutral unknown key', withChange((d) => { d.experiments[0].priority = 1; }), ['UNKNOWN_KEY@$.experiments[0]']],
    ['free text', withChange((d) => { d.experiments[0].campaign = 'fall gifts promo'; }), [`FORBIDDEN_VALUE:FREE_TEXT@${at('campaign')}`]],
    ['email', withChange((d) => { d.experiments[0].source = 'jane@example.com'; }), [`FORBIDDEN_VALUE:EMAIL@${at('source')}`]],
    ['phone', withChange((d) => { d.experiments[0].campaign = '312-555-0100'; }), [`FORBIDDEN_VALUE:PHONE@${at('campaign')}`]],
    ['name', withChange((d) => { d.experiments[0].content = 'jane-doe'; }), [`VALUE_NOT_GOVERNED@${at('content')}`]],
    ['order id', withChange((d) => { d.experiments[0].campaign = 'ord_ZQXSYNTH7731'; }), [`FORBIDDEN_VALUE:ORDER_ID@${at('campaign')}`]],
    ['Stripe customer', withChange((d) => { d.experiments[0].campaign = 'cus_Q1w2E3r4T5y6'; }), [`FORBIDDEN_VALUE:PROVIDER_ID@${at('campaign')}`]],
    ['Stripe session', withChange((d) => { d.experiments[0].content = 'cs_live_a1B2c3D4e5F6'; }), [`FORBIDDEN_VALUE:PROVIDER_ID@${at('content')}`]],
    ['GA client id', withChange((d) => { d.experiments[0].source = '123456789.1727500000'; }), [`FORBIDDEN_VALUE:GA_CLIENT_ID@${at('source')}`]],
    ['uuid', withChange((d) => { d.experiments[0].content = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'; }), [`FORBIDDEN_VALUE:UUID@${at('content')}`]],
    ['non-ascii', withChange((d) => { d.experiments[0].campaign = '2026-10-holiday‐x'; }), [`FORBIDDEN_VALUE:NON_ASCII@${at('campaign')}`]],
    ['not canonical', withChange((d) => { d.experiments[0].campaign = '2026-10-Holiday'; }), [`VALUE_NOT_CANONICAL@${at('campaign')}`]],
    ['missing medium', withChange((d) => { d.experiments[0].medium = null; }), [`TYPE_STRING@${at('medium')}`]],
  ];
  for (const [label, doc, expected] of cases) {
    const issues = validateExperimentRegistry(doc);
    assert.deepEqual(issues, expected, label);
    assert.doesNotMatch(JSON.stringify(issues), /jane|ord_zqx|cus_|cs_live|312-555|3f2504e0|123456789\./i, label);
  }
});

test('the registry linter rejects invalid experiments, dates, statuses, money and outcomes', () => {
  const at = (field: string) => `$.experiments[0].${field}`;
  const overlap = { ...EXPERIMENT, experiment_id: 'hsb_exp_2026_003', start_date: '2026-10-15', end_date: '2026-11-15' };
  const cases: Array<[string, Registry, string[]]> = [
    ['overlap on one segment', registry([EXPERIMENT, SECOND, overlap]), ['EXPERIMENT_OVERLAP@$.experiments[2]']],
    ['overlap even when cancelled', registry([EXPERIMENT, { ...overlap, status: 'cancelled' }]), ['EXPERIMENT_OVERLAP@$.experiments[1]']],
    ['impossible date', withChange((d) => { d.experiments[0].start_date = '2026-02-30'; }), [`INVALID_DATE@${at('start_date')}`]],
    ['inverted window', withChange((d) => { d.experiments[0].start_date = '2026-11-01'; }), ['DATE_WINDOW_INVALID@$.experiments[0]']],
    ['unknown status', withChange((d) => { d.experiments[0].status = 'live'; }), [`INVALID_ENUM@${at('status')}`]],
    ['decision before completion', withChange((d) => { d.experiments[0].decision = 'scale'; }), [`DECISION_BEFORE_COMPLETION@${at('decision')}`]],
    ['float budget', withChange((d) => { d.experiments[0].budget.amount_minor = 1500.5; }), [`TYPE_INTEGER@${at('budget.amount_minor')}`]],
    ['string budget', withChange((d) => { d.experiments[0].budget.amount_minor = '150000'; }), [`TYPE_INTEGER@${at('budget.amount_minor')}`]],
    ['negative budget', withChange((d) => { d.experiments[0].budget.amount_minor = -1; }), [`INTEGER_OUT_OF_RANGE@${at('budget.amount_minor')}`]],
    ['float threshold', withChange((d) => { d.experiments[0].evidence_threshold.min_events = 1.5; }), [`TYPE_INTEGER@${at('evidence_threshold.min_events')}`]],
    ['zero denominator', withChange((d) => { d.experiments[0].evidence_threshold.min_denominator = 0; }), [`INTEGER_OUT_OF_RANGE@${at('evidence_threshold.min_denominator')}`]],
    ['mixed currency', withChange((d) => { d.experiments[0].budget.currency = 'EUR'; }), [`MIXED_CURRENCY@${at('budget.currency')}`]],
    ['unknown registry currency', withChange((d) => { d.currency = 'XYZ'; }), ['INVALID_ENUM@$.currency']],
    ['two primary outcomes', withChange((d) => { d.experiments[0].primary_outcome = ['paid_order_rate', 'checkout_start_rate']; }), [`MULTIPLE_PRIMARY_OUTCOMES@${at('primary_outcome')}`]],
    ['meta-sourced outcome', withChange((d) => { d.experiments[0].primary_outcome = 'meta_purchase_rate'; }), [`INVALID_ENUM@${at('primary_outcome')}`]],
    ['duplicate id', withChange((d) => { d.experiments[1].experiment_id = 'hsb_exp_2026_001'; }), ['DUPLICATE_EXPERIMENT_ID@$.experiments[1].experiment_id']],
    ['id not normalized', withChange((d) => { d.experiments[0].experiment_id = 'HSB-EXP-1'; }), [`EXPERIMENT_ID_FORMAT@${at('experiment_id')}`]],
    ['id zero', withChange((d) => { d.experiments[0].experiment_id = 'hsb_exp_2026_000'; }), [`EXPERIMENT_ID_FORMAT@${at('experiment_id')}`]],
    ['other business id', withChange((d) => { d.experiments[0].experiment_id = 'ot_exp_2026_001'; }), [`EXPERIMENT_ID_FORMAT@${at('experiment_id')}`]],
    ['other business', withChange((d) => { d.experiments[0].business = 'ot'; }), [`INVALID_ENUM@${at('business')}`]],
    ['data origin', withChange((d) => { d.data_origin = 'prod'; }), ['INVALID_ENUM@$.data_origin']],
    ['schema version', withChange((d) => { d.schema_version = 2; }), ['SCHEMA_VERSION_UNSUPPORTED@$.schema_version']],
    ['experiments shape', withChange((d) => { d.experiments = 'jane' as never; }), ['TYPE_ARRAY@$.experiments']],
    ['budget shape', withChange((d) => { d.experiments[0].budget = 'free'; }), [`TYPE_OBJECT@${at('budget')}`]],
  ];
  for (const [label, doc, expected] of cases) assert.deepEqual(validateExperimentRegistry(doc), expected, label);
  assert.deepEqual(validateExperimentRegistry(null), ['DOCUMENT_NOT_OBJECT@$']);
});

// ── Transitions ─────────────────────────────────────────────────────────────

test('valid lifecycle transitions pass', () => {
  const next = withChange((d) => {
    d.experiments[0].status = 'completed';
    d.experiments[0].end_date = '2026-10-20';
    d.experiments[0].decision = 'scale';
    d.experiments[1].status = 'running';
    d.experiments[1].campaign = '2026-11-gifts';
  });
  assert.deepEqual(validateExperimentRegistryTransition(registry(), next), []);
  const appended = registry([EXPERIMENT, SECOND, { ...SECOND, experiment_id: 'hsb_exp_2026_004', start_date: '2027-01-04', end_date: '2027-01-31', campaign: '2027-01-launch' }]);
  assert.deepEqual(validateExperimentRegistryTransition(registry(), appended), []);
});

test('invalid transitions are rejected', () => {
  const completed = withChange((d) => { d.experiments[0].status = 'completed'; d.experiments[0].decision = 'scale'; });
  const cases: Array<[string, Registry, Registry, string[]]> = [
    ['completed back to running', completed, withChange((d) => { d.experiments[0].status = 'running'; }), ['STATUS_TRANSITION_INVALID@$.experiments[0].status']],
    ['removed', registry(), registry([EXPERIMENT]), ['EXPERIMENT_REMOVED@$.experiments']],
    ['segment edited while running', registry(), withChange((d) => { d.experiments[0].campaign = '2026-10-gifts'; }), ['IMMUTABLE_FIELD_CHANGED@$.experiments[0].campaign']],
    ['start moved while running', registry(), withChange((d) => { d.experiments[0].start_date = '2026-10-02'; }), ['IMMUTABLE_FIELD_CHANGED@$.experiments[0].start_date']],
    ['outcome swapped while running', registry(), withChange((d) => { d.experiments[0].primary_outcome = 'checkout_start_rate'; }), ['IMMUTABLE_FIELD_CHANGED@$.experiments[0].primary_outcome']],
    ['decision rewritten', completed, withChange((d) => { d.experiments[0].status = 'completed'; d.experiments[0].decision = 'stop'; }), ['DECISION_FINAL@$.experiments[0].decision']],
    ['terminal window edited', completed, withChange((d) => { d.experiments[0].status = 'completed'; d.experiments[0].decision = 'scale'; d.experiments[0].end_date = '2026-10-25'; }),
      ['IMMUTABLE_FIELD_CHANGED@$.experiments[0].end_date']],
    ['new experiment arrives decided', registry(), registry([EXPERIMENT, SECOND, { ...SECOND, experiment_id: 'hsb_exp_2026_005', start_date: '2027-02-01', end_date: '2027-02-28', campaign: '2027-02-gifts', status: 'completed', decision: 'scale' }]),
      ['NEW_EXPERIMENT_STATUS_INVALID@$.experiments[2].status']],
  ];
  for (const [label, previous, next, expected] of cases) {
    assert.deepEqual(validateExperimentRegistryTransition(previous, next), expected, label);
  }
  assert.deepEqual(validateExperimentRegistryTransition({ schema: 'x' }, registry()), ['PREVIOUS_INVALID@$']);
  assert.deepEqual(
    validateExperimentRegistryTransition(registry(), withChange((d) => { d.experiments[0].source = 'jane@example.com'; })),
    ['FORBIDDEN_VALUE:EMAIL@$.experiments[0].source'],
  );
});

// ── Governed links attribute exactly through Phase A ────────────────────────

test('a governed campaign link round-trips exactly through the Phase-A capture path', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
    [EXPERIMENT, 'https://herostorybooks.com/gifts/holidays?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-10-holiday&utm_content=video-a',
      { source: 'facebook', medium: 'paid_social', campaign: '2026-10-holiday', content: 'video-a', term: null, landingPath: '/gifts/holidays' }],
    [SECOND, 'https://herostorybooks.com/gifts/holidays?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-11-holiday',
      { source: 'facebook', medium: 'paid_social', campaign: '2026-11-holiday', content: null, term: null, landingPath: '/gifts/holidays' }],
    [{ ...EXPERIMENT, landing_path: '/', source: 'newsletter', medium: 'email', campaign: 'launch', content: 'text-c' },
      'https://herostorybooks.com/?utm_source=newsletter&utm_medium=email&utm_campaign=launch&utm_content=text-c',
      { source: 'newsletter', medium: 'email', campaign: 'launch', content: 'text-c', term: null, landingPath: '/' }],
  ];
  for (const [experiment, expectedUrl, expectedTouch] of cases) {
    const url = buildGovernedCampaignUrl(experiment);
    assert.equal(url, expectedUrl);
    const parsed = new URL(url!);
    assert.deepEqual(
      captureAttributionTouch({ search: parsed.search, pathname: parsed.pathname, now }),
      { ...expectedTouch, capturedAt: '2026-10-02T12:00:00.000Z' },
    );
  }
  assert.equal(buildGovernedCampaignUrl({ ...EXPERIMENT, landing_path: '/status/[orderId]' }), null);
  assert.equal(buildGovernedCampaignUrl({ ...EXPERIMENT, campaign: 'jane-doe' }), null);
  assert.equal(buildGovernedCampaignUrl({ ...EXPERIMENT, utm_term: 'jane' }), null);
});

// ── Governance CLI ──────────────────────────────────────────────────────────

const CLI = ['--experimental-strip-types', 'scripts/analytics-governance.ts'];
function runCli(args: string[]) {
  return spawnSync(process.execPath, [...CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
}

test('the governance CLI accepts the checked-in artifacts and fails closed on hostile registries without echoing values', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-governance-'));
  try {
    const ok = runCli(['check']);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.match(ok.stdout, /^OK experiment_registry experiments=0$/m);
    assert.match(ok.stdout, /^OK ga4_admin_checklist$/m);
    assert.match(ok.stdout, /^OK decision_packet_mapping$/m);
    assert.match(ok.stdout, /^OK meta_server_purchase DEFERRED$/m);

    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(registry()));
    const accepted = runCli(['check', '--registry', good]);
    assert.equal(accepted.status, 0, accepted.stdout);
    assert.match(accepted.stdout, /^OK experiment_registry experiments=2$/m);

    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify(withChange((d) => { d.experiments[0].source = 'jane@example.com'; })));
    const rejected = runCli(['check', '--registry', bad]);
    assert.equal(rejected.status, 3);
    assert.match(rejected.stdout, /^REJECTED experiment_registry FORBIDDEN_VALUE:EMAIL@\$\.experiments\[0\]\.source$/m);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /jane/);

    const next = path.join(dir, 'next.json');
    writeFileSync(next, JSON.stringify(registry([EXPERIMENT])));
    const transition = runCli(['check', '--registry', next, '--previous', good]);
    assert.equal(transition.status, 3);
    assert.match(transition.stdout, /^REJECTED experiment_registry EXPERIMENT_REMOVED@\$\.experiments$/m);

    const malformed = path.join(dir, 'malformed.json');
    writeFileSync(malformed, '{"schema": "hsb.experiment_registry", jane@example.com');
    const unreadable = runCli(['check', '--registry', malformed]);
    assert.equal(unreadable.status, 3);
    assert.doesNotMatch(unreadable.stdout + unreadable.stderr, /jane/);

    assert.equal(runCli(['check', '--registry']).status, 2);
    assert.equal(runCli(['frobnicate']).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the governance CLI regenerates the checked-in fixture and schema byte for byte', () => {
  const fixture = runCli(['fixture']);
  assert.equal(fixture.status, 0);
  assert.equal(fixture.stdout, readFileSync(new URL('../config/analytics/fixtures/hsb-ga4-behavior-export.synthetic.v1.json', import.meta.url), 'utf8'));
  const schema = runCli(['schema']);
  assert.equal(schema.status, 0);
  assert.equal(schema.stdout, readFileSync(new URL('../config/analytics/hsb-ga4-behavior-export.schema.v1.json', import.meta.url), 'utf8'));
});

test('a calendar date is a real proleptic-Gregorian day between 0001-01-01 and 9999-12-31, as in the pinned packet', () => {
  for (const day of ['0001-01-01', '9999-12-31', '2026-02-28', '2028-02-29']) assert.equal(isCalendarDate(day), true, day);
  for (const day of ['0000-01-01', '0000-12-31', '2026-02-30', '2026-09-31', '2027-02-29', '2026-9-1', '2026-09-01T00:00:00Z', '2026-09-01 ', ' 2026-09-01', '+2026-09-01', '20260901', 2026, null]) {
    assert.equal(isCalendarDate(day), false, String(day));
  }
});
