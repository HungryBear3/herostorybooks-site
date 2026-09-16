/**
 * HSB Phase B control-plane foundation — deterministic contract / source-identity proof.
 *
 * Offline only. No PostgreSQL, no network, no application imports. Proves that:
 *   - every vendored contract file still has its exact accepted byte identity;
 *   - SOURCE-IDENTITY.md still declares the accepted commit/tree/manifest/registry/verdict;
 *   - the canonical registry digest re-derives to the accepted SHA-256;
 *   - the checked-in control-plane SQL binds those same accepted hashes and the
 *     contract's own stage/role/lock identities, and nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  ACCEPTED,
  CONTRACT_DIR,
  SQL_DIR,
  VENDORED_SHA256,
  canonicalRegistryDigest,
  loadContract,
  readAllSql,
  readContractFileBytes,
  sha256Hex,
  sqlFileNames,
} from './support/control-plane-identity.ts';

const sourceIdentityText = readFileSync(path.join(CONTRACT_DIR, 'SOURCE-IDENTITY.md'), 'utf8');

test('every vendored contract file keeps its exact accepted byte identity', () => {
  for (const [relative, expected] of VENDORED_SHA256) {
    const actual = sha256Hex(readContractFileBytes(relative));
    assert.equal(actual, expected, `vendored byte drift in ${relative}`);
    assert.ok(
      sourceIdentityText.includes(`${expected}  ${relative}`),
      `SOURCE-IDENTITY.md no longer lists ${relative} with ${expected}`,
    );
  }
});

test('SOURCE-IDENTITY.md still declares the accepted offline identity', () => {
  assert.ok(sourceIdentityText.includes(ACCEPTED.applicationBaseCommit), 'base commit missing');
  assert.ok(sourceIdentityText.includes(ACCEPTED.applicationBaseTree), 'base tree missing');
  assert.ok(sourceIdentityText.includes(ACCEPTED.sourceManifestSha256), 'manifest SHA missing');
  assert.ok(sourceIdentityText.includes(ACCEPTED.canonicalRegistrySha256), 'registry SHA missing');
  assert.ok(sourceIdentityText.includes(ACCEPTED.verdict), 'verdict missing');
  assert.ok(
    sourceIdentityText.includes(`Source candidate entries: \`${ACCEPTED.sourceManifestEntries}\``),
    'entry count missing',
  );
});

test('the source candidate manifest has the accepted entry count and digest', () => {
  const manifestBytes = readContractFileBytes('evidence/SOURCE-CANDIDATE-FILES.sha256');
  assert.equal(sha256Hex(manifestBytes), ACCEPTED.sourceManifestSha256);

  const entries = manifestBytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  assert.equal(entries.length, ACCEPTED.sourceManifestEntries);
  for (const entry of entries) {
    assert.match(entry, /^[0-9a-f]{64} {2}\S.*$/, `malformed manifest entry: ${entry}`);
  }
});

test('the canonical registry digest re-derives to the accepted SHA-256', () => {
  assert.equal(canonicalRegistryDigest(), ACCEPTED.canonicalRegistrySha256);
});

test('the vendored contract carries the accepted identity and provider hold', () => {
  const contract = loadContract();
  assert.equal(contract.contract_id, ACCEPTED.contractId);
  assert.equal(contract.contract_version, ACCEPTED.contractVersion);
  assert.equal(contract.provider_qualification, 'HOLD_UNQUALIFIED');
});

test('the control-plane SQL lives in its own narrow directory with ordered files', () => {
  assert.ok(existsSync(SQL_DIR), 'db/control-plane/ is missing');
  assert.ok(statSync(SQL_DIR).isDirectory(), 'db/control-plane is not a directory');

  const names = sqlFileNames();
  assert.ok(names.length > 0, 'no .sql files under db/control-plane/');
  for (const name of names) {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/, `non-deterministic SQL file name: ${name}`);
  }
  const ordinals = names.map((name) => Number(name.slice(0, 4)));
  assert.deepEqual(ordinals, [...ordinals].sort((a, b) => a - b), 'SQL apply order is not lexical');
  assert.equal(new Set(ordinals).size, ordinals.length, 'duplicate SQL ordinal prefix');
});

test('the control-plane SQL binds the accepted hashes as authoritative metadata', () => {
  const sql = readAllSql();
  assert.ok(sql.includes(ACCEPTED.canonicalRegistrySha256), 'canonical registry SHA is not bound in SQL');
  assert.ok(sql.includes(ACCEPTED.sourceManifestSha256), 'source manifest SHA is not bound in SQL');
  assert.ok(sql.includes(ACCEPTED.applicationBaseCommit), 'application base commit is not bound in SQL');
  assert.ok(sql.includes(ACCEPTED.applicationBaseTree), 'application base tree is not bound in SQL');
  assert.ok(sql.includes(ACCEPTED.contractId), 'contract id is not bound in SQL');
});

test('the control-plane SQL uses the dedicated schema and the contract lock identity', () => {
  const sql = readAllSql();
  assert.ok(/CREATE SCHEMA IF NOT EXISTS hsb_control\b/.test(sql), 'dedicated hsb_control schema is missing');
  assert.ok(!/\bCREATE (TABLE|FUNCTION|TYPE) (IF NOT EXISTS )?public\./.test(sql), 'SQL creates objects in public');

  const lock = loadContract().registries.payment_identity_lock_protocol;
  assert.equal(lock.global_lock_name, 'hsb-provider-payment-identity-v1');
  assert.equal(lock.global_lock_kind, 'pg_advisory_xact_lock');
  assert.ok(sql.includes(lock.global_lock_name), 'contract global lock name is not used in SQL');
  assert.ok(sql.includes('pg_advisory_xact_lock('), 'transaction-scoped advisory lock is not used');
  assert.ok(!/pg_advisory_lock\(/.test(sql), 'session-scoped advisory lock must not be used');
});

test('the control-plane SQL declares exactly the contract roles', () => {
  const sql = readAllSql();
  const roles: string[] = loadContract().registries.roles_and_function_grants.roles;
  assert.deepEqual(roles, [
    'hsb_owner',
    'hsb_app',
    'hsb_webhook',
    'hsb_worker',
    'hsb_backfill',
    'hsb_stage_admin',
    'hsb_auditor',
  ]);
  for (const role of roles) {
    assert.ok(sql.includes(role), `role ${role} is not represented in SQL`);
  }
  const declared = new Set((sql.match(/\bhsb_[a-z_]+\b/g) ?? []).filter((token) => /^hsb_(owner|app|webhook|worker|backfill|stage_admin|auditor)$/.test(token)));
  assert.equal(declared.size, roles.length, 'SQL references an unexpected hsb_* role set');
});

test('every SECURITY DEFINER function in the SQL pins a safe search_path', () => {
  const sql = readAllSql();
  const definers = sql.match(/SECURITY DEFINER[\s\S]{0,200}?(?=AS \$\$)/g) ?? [];
  assert.ok(definers.length > 0, 'no SECURITY DEFINER functions found');
  for (const body of definers) {
    assert.ok(/SET search_path\s*=/.test(body), `SECURITY DEFINER without pinned search_path: ${body.slice(0, 80)}`);
  }
  for (const setting of sql.match(/SET search_path\s*=\s*[^\n]+/g) ?? []) {
    assert.ok(!/\bpublic\b/.test(setting), `search_path includes public: ${setting}`);
    assert.ok(!/\$user/.test(setting), `search_path includes $user: ${setting}`);
  }
  assert.ok(/REVOKE\s+EXECUTE\s+ON\s+ALL\s+FUNCTIONS[\s\S]{0,120}FROM\s+PUBLIC/i.test(sql), 'PUBLIC execute is not revoked');
});

test('the control-plane SQL seeds stage off and never seeds an active stage', () => {
  const sql = readAllSql();
  const stages: string[] = loadContract().registries.stages.values;
  assert.deepEqual(stages, ['off', 'shadow', 'backfill', 'verified', 'activated', 'hold']);

  const seed = sql.match(/INSERT INTO hsb_control\.stage_state[\s\S]*?;/);
  assert.ok(seed, 'no stage_state singleton seed found');
  assert.ok(/'off'/.test(seed[0]), 'stage singleton is not seeded to off');
  for (const active of ['shadow', 'backfill', 'verified', 'activated', 'hold']) {
    assert.ok(!seed[0].includes(`'${active}'`), `stage singleton seed mentions ${active}`);
  }
});

test('the control-plane SQL stores no PII-shaped columns and no embedded secrets', () => {
  const sql = readAllSql();
  const piiTokens = [
    'email',
    'first_name',
    'last_name',
    'full_name',
    'child_name',
    'street',
    'address',
    'postal',
    'zip_code',
    'phone',
    'card_number',
    'ip_address',
    'user_agent',
    'photo',
  ];
  for (const token of piiTokens) {
    assert.ok(!new RegExp(`\\b${token}\\b`, 'i').test(sql), `PII-shaped identifier in control-plane SQL: ${token}`);
  }
  for (const pattern of [/\bPASSWORD\s+'/i, /\bsk_live_/, /\bsk_test_/, /\bwhsec_/, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.ok(!pattern.test(sql), `credential-shaped literal in control-plane SQL: ${pattern}`);
  }
});
