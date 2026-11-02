'use strict';
// Config regression test ONLY. It proves that the committed vercel.json turns off Vercel Git
// deployments for the private-pilot branch and changes nothing else. A pass does NOT prove
// hosted or provider isolation: Vercel project or dashboard settings, env scoping, deployment
// protection, and whether the provider actually honours this file all need separate checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'vercel.json');
const TARGET = 'qa/hsb-private-pilot-67909-20261102';
const EXISTING = 'rex/hsb-safeoff-20261019-jrm7sg1b';
const DEFAULT_ON_BRANCHES = [
  'main',
  'qa/hsb-private-pilot-67909-20261103',
  'qa/unrelated',
  'rex/unrelated',
  'feature/never-configured',
];

// Exact parsed original vercel.json (pre-change fixture).
const ORIGINAL = {
  git: { deploymentEnabled: { 'rex/hsb-safeoff-20261019-jrm7sg1b': false } },
  redirects: [
    { source: '/', has: [{ type: 'host', value: 'www.herostorybooks.com' }], destination: 'https://herostorybooks.com/', permanent: true },
    { source: '/:path*', has: [{ type: 'host', value: 'www.herostorybooks.com' }], destination: 'https://herostorybooks.com/:path*', permanent: true },
    { source: '/faq', destination: '/#faq', permanent: true },
    { source: '/fleccas', destination: 'https://herostorybooks.com/?utm_source=fleccas&utm_medium=podcast&utm_campaign=october_2026', permanent: false },
  ],
  crons: [
    { path: '/api/cron/fulfillment-sweep', schedule: '*/10 * * * *' },
    { path: '/api/cron/checkout-intake-cleanup', schedule: '17 4 * * *' },
    { path: '/api/cron/confirmation-email-sweep', schedule: '7,22,37,52 * * * *' },
    { path: '/api/cron/group-book-retention-sweep', schedule: '41 5 * * *' },
  ],
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const EXPECTED = clone(ORIGINAL);
EXPECTED.git.deploymentEnabled[TARGET] = false;

function readActualText() {
  return fs.readFileSync(CONFIG_PATH, 'utf8');
}

function globMatch(pattern, s) {
  if (!pattern.includes('*')) return pattern === s;
  const parts = pattern.split('*');
  if (!s.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = s.indexOf(parts[i], pos);
    if (idx < 0) return false;
    pos = idx + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return s.length - last.length >= pos && s.endsWith(last);
}

// Models Vercel's per-branch git.deploymentEnabled: a missing entry defaults to enabled.
function branchDeploymentEnabled(cfg, branch) {
  const de = isPlainObject(cfg) && isPlainObject(cfg.git) ? cfg.git.deploymentEnabled : undefined;
  if (de === false) return false;
  if (!isPlainObject(de)) return true;
  let enabled = true;
  for (const [key, value] of Object.entries(de)) {
    if (globMatch(key, branch) && value === false) enabled = false;
  }
  return enabled;
}

function sameAs(a, b) {
  try {
    assert.deepStrictEqual(a, b);
    return true;
  } catch {
    return false;
  }
}

function validateConfig(cfg) {
  if (!isPlainObject(cfg)) return ['config must be a JSON object'];
  if (!isPlainObject(cfg.git)) return ['git must be an object'];
  const de = cfg.git.deploymentEnabled;
  if (!isPlainObject(de)) return ['git.deploymentEnabled must be a per-branch object (no global toggle)'];
  const errors = [];
  const keys = Object.keys(de).sort();
  if (!sameAs(keys, [EXISTING, TARGET].sort())) errors.push('unexpected deploymentEnabled keys: ' + keys.join(','));
  for (const key of keys) {
    if (['*', '?', '[', ']', '{', '}', '!'].some((ch) => key.includes(ch))) errors.push('wildcard key not allowed: ' + key);
  }
  if (de[TARGET] !== false) errors.push('target branch must be boolean false');
  if (de[EXISTING] !== false) errors.push('existing branch entry must stay boolean false');
  if (branchDeploymentEnabled(cfg, TARGET)) errors.push('target branch would still deploy');
  for (const branch of DEFAULT_ON_BRANCHES) {
    if (!branchDeploymentEnabled(cfg, branch)) errors.push('branch must default to enabled: ' + branch);
  }
  const stripped = clone(cfg);
  delete stripped.git.deploymentEnabled[TARGET];
  if (!sameAs(stripped, ORIGINAL)) errors.push('config drift beyond the single target entry');
  return errors;
}

function validateText(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return ['malformed JSON'];
  }
  return validateConfig(cfg);
}

test('config regression: vercel.json exists and parses (RED must come from the missing target, not the file)', () => {
  assert.ok(fs.existsSync(CONFIG_PATH), 'vercel.json missing at ' + CONFIG_PATH);
  assert.ok(isPlainObject(JSON.parse(readActualText())));
});

test('config regression: target pilot branch has Git deployments disabled', () => {
  const cfg = JSON.parse(readActualText());
  assert.equal(cfg.git.deploymentEnabled[TARGET], false);
  assert.equal(branchDeploymentEnabled(cfg, TARGET), false);
});

test('config regression: existing disabled branch is unchanged', () => {
  const cfg = JSON.parse(readActualText());
  assert.equal(cfg.git.deploymentEnabled[EXISTING], false);
  assert.equal(branchDeploymentEnabled(cfg, EXISTING), false);
});

test('config regression: main, unrelated and unlisted branches still default to enabled', () => {
  const cfg = JSON.parse(readActualText());
  for (const branch of DEFAULT_ON_BRANCHES) {
    assert.equal(branchDeploymentEnabled(cfg, branch), true, branch);
  }
});

test('config regression: removing the new key restores the exact original config', () => {
  const cfg = JSON.parse(readActualText());
  const stripped = clone(cfg);
  delete stripped.git.deploymentEnabled[TARGET];
  assert.deepEqual(stripped.git, ORIGINAL.git);
  assert.deepEqual(stripped, ORIGINAL);
  assert.deepEqual(cfg, EXPECTED);
});

test('config regression: crons are unchanged', () => {
  const cfg = JSON.parse(readActualText());
  assert.deepEqual(cfg.crons, ORIGINAL.crons);
});

test('config regression: actual vercel.json passes the validator', () => {
  assert.deepEqual(validateText(readActualText()), []);
});

test('validator: positive control accepts expected config; original is rejected for missing target', () => {
  assert.deepEqual(validateText(JSON.stringify(EXPECTED, null, 2)), []);
  assert.ok(validateConfig(clone(ORIGINAL)).includes('target branch must be boolean false'));
});

const MUTATIONS = [
  ['malformed JSON', () => '{ git: {'],
  ['empty file', () => ''],
  ['null', () => 'null'],
  ['array', () => '[]'],
  ['missing git', (c) => { delete c.git; }],
  ['missing deploymentEnabled', (c) => { delete c.git.deploymentEnabled; }],
  ['global false', (c) => { c.git.deploymentEnabled = false; }],
  ['global true', (c) => { c.git.deploymentEnabled = true; }],
  ['target missing', (c) => { delete c.git.deploymentEnabled[TARGET]; }],
  ['target string false', (c) => { c.git.deploymentEnabled[TARGET] = 'false'; }],
  ['target true', (c) => { c.git.deploymentEnabled[TARGET] = true; }],
  ['target null', (c) => { c.git.deploymentEnabled[TARGET] = null; }],
  ['existing branch re-enabled', (c) => { c.git.deploymentEnabled[EXISTING] = true; }],
  ['wildcard qa/*', (c) => { c.git.deploymentEnabled['qa/*'] = false; }],
  ['catch-all *', (c) => { c.git.deploymentEnabled['*'] = false; }],
  ['wildcard replaces exact target', (c) => { delete c.git.deploymentEnabled[TARGET]; c.git.deploymentEnabled['qa/hsb-private-pilot-*'] = false; }],
  ['broad legacy github disable', (c) => { c.github = { enabled: false }; }],
  ['extra branch key', (c) => { c.git.deploymentEnabled['qa/extra'] = false; }],
  ['extra git setting', (c) => { c.git.autoJobCancelation = false; }],
  ['ignore command added', (c) => { c.ignoreCommand = 'exit 0'; }],
  ['build override', (c) => { c.buildCommand = 'true'; }],
  ['redirect drift', (c) => { c.redirects.pop(); }],
  ['cron drift', (c) => { c.crons[0].schedule = '0 0 * * *'; }],
];

for (const [name, mutate] of MUTATIONS) {
  test('validator rejects mutation: ' + name, () => {
    const c = clone(EXPECTED);
    const result = mutate(c);
    const text = typeof result === 'string' ? result : JSON.stringify(c, null, 2);
    assert.ok(validateText(text).length > 0, name + ' was accepted');
  });
}
