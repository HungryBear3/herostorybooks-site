/**
 * Tests for scripts/capture-g5-evidence.mjs.
 *
 * The script is read-only and writes only an evidence packet, so the unit
 * tests exercise the pure pieces directly — with the security-critical focus
 * on redaction: no secret body, and no raw sensitive env value, may ever reach
 * the serialized packet. A subprocess smoke run confirms the CLI writes a
 * packet, exits 0 even with blockers, and emits no injected secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  redactSecret,
  findLeakedSecrets,
  describeEnvVar,
  buildReport,
  buildEnvChecks,
  buildWebhookChecks,
  bucketCounts,
  renderMarkdown,
  secretEnvNames,
  KNOWN_SECRET_PREFIXES,
  STATUS,
} from '../scripts/capture-g5-evidence.mjs';

const FAKE = {
  STRIPE_SECRET_KEY: 'sk-LIVE-REDACTED-ZZTOPSECRETbody1234567890ABCDEF',
  STRIPE_WEBHOOK_SECRET: 'whsec-REDACTED-[REDACTED_TEST_FIXTURE]',
  BLOB_READ_WRITE_TOKEN: 'vercel-blob-rw-REDACTED-[REDACTED_TEST_FIXTURE]',
  HSB_ORDER_ADMIN_KEY: 'super-secret-admin-key-no-prefix-9988776655',
  RESEND_API_KEY: 're_LIVERESENDkeyBODYsecret0001',
};

// ── redactSecret: the choke point ─────────────────────────────────────────────

test('redactSecret: empty/non-string → not present, no length, no prefix', () => {
  for (const v of [undefined, null, '', 123]) {
    const r = redactSecret(v as unknown as string);
    assert.equal(r.present, false);
    assert.equal(r.length, 0);
    assert.equal(r.prefix, null);
  }
});

test('redactSecret: known-format secret reveals only length + whitelisted prefix, never the body', () => {
  const r = redactSecret(FAKE.STRIPE_SECRET_KEY);
  assert.equal(r.present, true);
  assert.equal(r.length, FAKE.STRIPE_SECRET_KEY.length);
  assert.equal(r.prefix, 'sk-LIVE-REDACTED-');
  // The random body must never appear in the redaction output.
  const serialized = JSON.stringify(r);
  assert.doesNotMatch(serialized, /ZZTOPSECRET/);
  assert.doesNotMatch(serialized, /1234567890ABCDEF/);
});

test('redactSecret: unknown-format secret yields null prefix (no arbitrary leading chars)', () => {
  const r = redactSecret(FAKE.HSB_ORDER_ADMIN_KEY);
  assert.equal(r.present, true);
  assert.equal(r.prefix, null);
  assert.doesNotMatch(JSON.stringify(r), /super-secret/);
});

test('redactSecret: every emitted prefix is from the fixed whitelist', () => {
  for (const sample of ['sk-TEST-REDACTED-abc', 'whsec-REDACTED-abc', 're_abc', 'vercel-blob-rw-REDACTED-abc', 'pk_live_abc']) {
    const { prefix } = redactSecret(sample + 'XXXXXXXX');
    assert.ok(prefix === null || KNOWN_SECRET_PREFIXES.includes(prefix), `prefix ${prefix} not whitelisted`);
  }
});

// ── describeEnvVar: kind-aware exposure ───────────────────────────────────────

test('describeEnvVar: secret kind never carries a shown value', () => {
  const d = describeEnvVar({ name: 'STRIPE_SECRET_KEY', kind: 'secret', required: true }, FAKE);
  assert.equal(d.present, true);
  assert.equal(d.shown, null);
  assert.equal(d.length, FAKE.STRIPE_SECRET_KEY.length);
  assert.doesNotMatch(JSON.stringify(d), /ZZTOPSECRET/);
});

test('describeEnvVar: identity/flag/public kinds may show their value; config is presence-only', () => {
  const identity = describeEnvVar({ name: 'VERCEL_ENV', kind: 'identity', required: false }, { VERCEL_ENV: 'production' });
  assert.equal(identity.shown, 'production');
  const sha = describeEnvVar({ name: 'VERCEL_GIT_COMMIT_SHA', kind: 'identity', required: false }, { VERCEL_GIT_COMMIT_SHA: 'abcdef0123456789' });
  assert.equal(sha.shown, 'abcdef012345'); // shortened
  const cfg = describeEnvVar({ name: 'EMAIL_FROM', kind: 'config', required: false }, { EMAIL_FROM: 'hi@herostorybooks.com' });
  assert.equal(cfg.present, true);
  assert.equal(cfg.shown, null);
});

// ── findLeakedSecrets: the self-check ─────────────────────────────────────────

test('findLeakedSecrets: detects a verbatim secret body and ignores redacted output', () => {
  assert.deepEqual(findLeakedSecrets('nothing here', FAKE), []);
  const leaked = findLeakedSecrets(`packet ... ${FAKE.STRIPE_SECRET_KEY} ...`, FAKE);
  assert.deepEqual(leaked, ['STRIPE_SECRET_KEY']);
});

// ── buildReport: no sensitive env values are emitted ──────────────────────────

test('buildReport: serialized JSON + Markdown contain no secret bodies', () => {
  const report = buildReport({
    env: { ...FAKE, NODE_ENV: 'production', VERCEL_ENV: 'production' },
    now: '2026-06-02T12:00:00.000Z',
    target: 'https://herostorybooks.com',
    git: { branch: 'g5-test', head: 'abc123def456', dirty: false, dirtyCount: 0, vercelProjectId: 'prj_secret_project_id' },
    facts: { checkoutPauseLib: true, webhookRouteExists: true, webhookSignatureVerify: true },
  });
  const blob = `${JSON.stringify(report)}\n${renderMarkdown(report)}`;

  // The redaction self-check must report nothing leaked...
  const secretEnv: Record<string, string | undefined> = {};
  for (const n of secretEnvNames()) secretEnv[n] = (FAKE as Record<string, string>)[n];
  assert.deepEqual(findLeakedSecrets(blob, secretEnv), []);

  // ...and the secret bodies must be absent by direct inspection too.
  for (const body of ['ZZTOPSECRET', 'DEADBEEFdeadbeef', 'PRIVATEtokenBODY', 'super-secret-admin-key', 'LIVERESENDkey']) {
    assert.doesNotMatch(blob, new RegExp(body), `secret body ${body} leaked into packet`);
  }
  // projectId is truncated, not emitted whole.
  assert.doesNotMatch(blob, /prj_secret_project_id\b/);
});

test('buildReport: required safety + "No customer side effects performed." present', () => {
  const report = buildReport({
    env: {},
    now: '2026-06-02T12:00:00.000Z',
    target: 'local',
    git: { branch: 'b', head: 'h', dirty: false, dirtyCount: 0, vercelProjectId: null },
    facts: { checkoutPauseLib: true, webhookRouteExists: true, webhookSignatureVerify: true },
  });
  assert.equal(report.safety.readOnly, true);
  assert.equal(report.safety.productionWrites, false);
  assert.equal(report.safety.deploy, false);
  assert.match(report.safety.customerSideEffects, /No customer side effects performed/);
  assert.match(renderMarkdown(report), /No customer side effects performed/);
});

// ── status buckets ────────────────────────────────────────────────────────────

test('env checks WARN when a required var is missing, PASS when present', () => {
  const missing = buildEnvChecks({}); // nothing set
  const stripe = missing.find((c) => c.label === 'Stripe');
  assert.equal(stripe?.status, STATUS.WARNING);

  const present = buildEnvChecks({
    STRIPE_SECRET_KEY: FAKE.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: FAKE.STRIPE_WEBHOOK_SECRET,
  });
  assert.equal(present.find((c) => c.label === 'Stripe')?.status, STATUS.PASS);
});

test('webhook check is a BLOCKER when the route is missing or unsigned', () => {
  const missingRoute = buildWebhookChecks({ routeExists: false, hasSignatureVerify: false, handlesMissingSecret: true }, {});
  assert.equal(missingRoute[0].status, STATUS.BLOCKER);

  const unsigned = buildWebhookChecks({ routeExists: true, hasSignatureVerify: false, handlesMissingSecret: true }, {});
  assert.ok(unsigned.some((c) => c.status === STATUS.BLOCKER), 'unsigned route must blocker');

  const healthy = buildWebhookChecks({ routeExists: true, hasSignatureVerify: true, handlesMissingSecret: true }, { STRIPE_WEBHOOK_SECRET: FAKE.STRIPE_WEBHOOK_SECRET });
  assert.ok(healthy.every((c) => c.status === STATUS.PASS));
});

test('bucketCounts tallies each status', () => {
  const counts = bucketCounts([
    { section: 's', status: STATUS.PASS, label: 'a', detail: '' },
    { section: 's', status: STATUS.WARNING, label: 'b', detail: '' },
    { section: 's', status: STATUS.BLOCKER, label: 'c', detail: '' },
    { section: 's', status: STATUS.NOT_CHECKED, label: 'd', detail: '' },
    { section: 's', status: STATUS.PASS, label: 'e', detail: '' },
  ]);
  assert.deepEqual(counts, { PASS: 2, WARNING: 1, BLOCKER: 1, 'NOT CHECKED': 1 });
});

// ── subprocess smoke: exit 0, writes packet, leaks nothing ────────────────────

test('CLI run: writes a packet, exits 0 even with blockers, and emits no injected secret', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'g5-ev-'));
  try {
    const out = execFileSync(
      'node',
      ['scripts/capture-g5-evidence.mjs', `--out=${tmp}`, '--target=https://test.invalid'],
      {
        cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
        encoding: 'utf8',
        env: { ...process.env, ...FAKE },
      },
    );
    assert.match(out, /No customer side effects performed\./);
    assert.match(out, /g5-evidence-/);

    const dirs = readdirSync(tmp).filter((d) => d.startsWith('g5-evidence-'));
    assert.equal(dirs.length, 1, 'exactly one evidence dir written');
    const base = path.join(tmp, dirs[0]);
    const json = readFileSync(path.join(base, 'summary.json'), 'utf8');
    const md = readFileSync(path.join(base, 'summary.md'), 'utf8');

    // The injected secrets must not appear in either artifact.
    for (const body of ['ZZTOPSECRET', 'DEADBEEFdeadbeef', 'PRIVATEtokenBODY', 'super-secret-admin-key', 'LIVERESENDkey']) {
      assert.doesNotMatch(json, new RegExp(body), `secret ${body} leaked into summary.json`);
      assert.doesNotMatch(md, new RegExp(body), `secret ${body} leaked into summary.md`);
    }
    // Shape signals we DO expect (length + prefix), proving redaction ran.
    assert.match(json, /"prefix": "sk-LIVE-REDACTED-"/);
    const parsed = JSON.parse(json);
    assert.equal(parsed.safety.readOnly, true);
    assert.equal(parsed.safety.deploy, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI run: unknown flag is an invocation error (exit 2)', () => {
  let code = 0;
  try {
    execFileSync('node', ['scripts/capture-g5-evidence.mjs', '--bogus'], {
      cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    code = (err as { status?: number }).status ?? -1;
  }
  assert.equal(code, 2);
});
