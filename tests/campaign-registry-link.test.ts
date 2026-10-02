/**
 * Registry-bound governed links: a link exists only for one validated
 * registry entry, found by its exact experiment id, whose status is still
 * `planned` or `running`. Unknown, inactive, ambiguous and invalid inputs
 * fail closed with value-free codes, and the empty checked-in registry stays
 * valid (it simply has nothing to link).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureAttributionTouch } from '../src/lib/attribution-contract.ts';
import { buildGovernedCampaignUrl, resolveRegistryCampaignLink } from '../src/lib/campaign-governance.ts';

type Experiment = Record<string, any>;

const RUNNING: Experiment = {
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
const PLANNED: Experiment = {
  ...RUNNING,
  experiment_id: 'hsb_exp_2026_002',
  status: 'planned',
  start_date: '2026-11-01',
  end_date: '2026-11-30',
  campaign: '2026-11-holiday',
  content: null,
};

function registry(experiments: Experiment[] = [RUNNING, PLANNED]) {
  return {
    schema: 'hsb.experiment_registry',
    schema_version: 1,
    data_origin: 'synthetic_fixture',
    business: 'hsb',
    currency: 'USD',
    experiments: experiments.map((experiment) => structuredClone(experiment)),
  };
}
const EMPTY = { ...registry([]), data_origin: 'operator_export' };

test('a planned or running registry entry yields exactly its one canonical link', () => {
  assert.deepEqual(resolveRegistryCampaignLink(registry(), 'hsb_exp_2026_001'), {
    ok: true,
    url: 'https://herostorybooks.com/gifts/holidays?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-10-holiday&utm_content=video-a',
  });
  const planned = resolveRegistryCampaignLink(registry(), 'hsb_exp_2026_002');
  assert.deepEqual(planned, {
    ok: true,
    url: 'https://herostorybooks.com/gifts/holidays?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-11-holiday',
  });
  // The link is the library builder's output for that same entry, and it
  // attributes to exactly that segment through the Phase-A capture.
  assert.equal(planned.ok && planned.url, buildGovernedCampaignUrl(PLANNED));
  const url = new URL((planned as { url: string }).url);
  const touch = captureAttributionTouch({ search: url.search, pathname: url.pathname, now: 0 });
  assert.deepEqual(
    [touch?.source, touch?.medium, touch?.campaign, touch?.content, touch?.term, touch?.landingPath],
    ['facebook', 'paid_social', '2026-11-holiday', null, null, '/gifts/holidays'],
  );
});

test('paused, completed and cancelled entries have no link', () => {
  for (const [status, decision] of [['paused', 'pending'], ['completed', 'scale'], ['cancelled', 'pending']] as const) {
    const doc = registry([{ ...RUNNING, status, decision }, PLANNED]);
    assert.deepEqual(resolveRegistryCampaignLink(doc, 'hsb_exp_2026_001'), {
      ok: false,
      issues: ['EXPERIMENT_NOT_LINKABLE@$.experiments[0].status'],
    }, status);
  }
});

test('unknown ids fail closed, and the empty checked-in registry stays valid with nothing to link', () => {
  assert.deepEqual(resolveRegistryCampaignLink(registry(), 'hsb_exp_2026_003'), { ok: false, issues: ['EXPERIMENT_UNKNOWN@$.experiment_id'] });
  assert.deepEqual(resolveRegistryCampaignLink(EMPTY, 'hsb_exp_2026_001'), { ok: false, issues: ['EXPERIMENT_UNKNOWN@$.experiment_id'] });
  // Ids are matched exactly, never normalized.
  for (const id of ['HSB_EXP_2026_001', ' hsb_exp_2026_001', 'hsb_exp_2026_001 ', 'hsb_exp_2026_01', 'jane@example.com', '', 42, null]) {
    const result = resolveRegistryCampaignLink(registry(), id);
    assert.deepEqual(result, { ok: false, issues: ['EXPERIMENT_ID_FORMAT@$.experiment_id'] }, String(id));
    assert.doesNotMatch(JSON.stringify(result), /jane/);
  }
});

test('an invalid or ambiguous registry yields no link and echoes no value', () => {
  const duplicate = registry([RUNNING, { ...PLANNED, experiment_id: 'hsb_exp_2026_001' }]);
  assert.deepEqual(resolveRegistryCampaignLink(duplicate, 'hsb_exp_2026_001'), {
    ok: false,
    issues: ['DUPLICATE_EXPERIMENT_ID@$.experiments[1].experiment_id'],
  });
  const overlap = registry([RUNNING, { ...RUNNING, experiment_id: 'hsb_exp_2026_003', start_date: '2026-10-15', end_date: '2026-11-15' }]);
  assert.deepEqual(resolveRegistryCampaignLink(overlap, 'hsb_exp_2026_001'), { ok: false, issues: ['EXPERIMENT_OVERLAP@$.experiments[1]'] });
  // A single invalid sibling refuses every link: the registry is one artifact.
  const hostile = registry([RUNNING, { ...PLANNED, source: 'jane@example.com' }]);
  const refused = resolveRegistryCampaignLink(hostile, 'hsb_exp_2026_001');
  assert.deepEqual(refused, { ok: false, issues: ['FORBIDDEN_VALUE:EMAIL@$.experiments[1].source'] });
  assert.doesNotMatch(JSON.stringify(refused), /jane/);
  assert.deepEqual(resolveRegistryCampaignLink(null, 'hsb_exp_2026_001'), { ok: false, issues: ['DOCUMENT_NOT_OBJECT@$'] });
  assert.deepEqual(resolveRegistryCampaignLink({ ...registry(), schema: 'x' }, 'hsb_exp_2026_001'), { ok: false, issues: ['SCHEMA_INVALID@$.schema'] });
});

test('an unsafe landing path never produces a link', () => {
  for (const landing of ['/status/[orderId]', '/(other)', 'https://evil.example/gifts', '//evil.example/', '/gifts?x=1']) {
    const result = resolveRegistryCampaignLink(registry([{ ...RUNNING, landing_path: landing }]), 'hsb_exp_2026_001');
    assert.equal(result.ok, false, landing);
    assert.doesNotMatch(JSON.stringify(result), /evil|orderId/, landing);
  }
});

// ── CLI ─────────────────────────────────────────────────────────────────────

const CLI = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/analytics-governance.ts'];
function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [...CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
  assert.doesNotMatch(result.stderr, /MODULE_TYPELESS_PACKAGE_JSON|file:\/\/|(?:^|\s)\/|[A-Za-z]:\\/);
  assert.ok(!result.stderr.includes(process.cwd()));
  if (result.status === 0 || result.status === 3) assert.equal(result.stderr, '');
  return result;
}

test('documented governance commands have empty stderr, with no runtime path leakage', () => {
  for (const command of ['check', 'fixture', 'schema', 'packet-fixture']) {
    const result = runCli([command]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  }
  assert.equal(runCli(['packet-export', '/nonexistent/synthetic-input.json']).status, 2);
});

test('the link command prints one canonical URL or a value-free refusal', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-link-'));
  try {
    const file = path.join(dir, 'registry.json');
    writeFileSync(file, JSON.stringify(registry()));
    const ok = runCli(['link', 'hsb_exp_2026_001', '--registry', file]);
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    assert.equal(ok.stdout, 'https://herostorybooks.com/gifts/holidays?utm_source=facebook&utm_medium=paid_social&utm_campaign=2026-10-holiday&utm_content=video-a\n');
    assert.doesNotMatch(ok.stderr, /utm_|holiday|facebook/);

    const paused = path.join(dir, 'paused.json');
    writeFileSync(paused, JSON.stringify(registry([{ ...RUNNING, status: 'paused' }])));
    const inactive = runCli(['link', 'hsb_exp_2026_001', '--registry', paused]);
    assert.equal(inactive.status, 3);
    assert.equal(inactive.stdout, 'REJECTED campaign_link EXPERIMENT_NOT_LINKABLE@$.experiments[0].status\n');

    // The checked-in registry is empty: every id is unknown, nothing is printed but the code.
    const empty = runCli(['link', 'hsb_exp_2026_001']);
    assert.equal(empty.status, 3);
    assert.equal(empty.stdout, 'REJECTED campaign_link EXPERIMENT_UNKNOWN@$.experiment_id\n');

    const hostileId = runCli(['link', 'jane@example.com', '--registry', file]);
    assert.equal(hostileId.status, 3);
    assert.doesNotMatch(hostileId.stdout + hostileId.stderr, /jane/);

    const malformed = path.join(dir, 'malformed.json');
    writeFileSync(malformed, '{"schema": jane@example.com');
    const unparsable = runCli(['link', 'hsb_exp_2026_001', '--registry', malformed]);
    assert.equal(unparsable.status, 3);
    assert.equal(unparsable.stdout, 'REJECTED campaign_link JSON_INVALID@$\n');

    assert.equal(runCli(['link']).status, 2);
    assert.equal(runCli(['link', 'hsb_exp_2026_001', 'hsb_exp_2026_002']).status, 2);
    assert.equal(runCli(['link', 'hsb_exp_2026_001', '--registry']).status, 2);
    assert.equal(runCli(['link', 'hsb_exp_2026_001', '--previous', file]).status, 2);
    assert.equal(runCli(['link', 'hsb_exp_2026_001', '--registry', path.join(dir, 'missing.json')]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
