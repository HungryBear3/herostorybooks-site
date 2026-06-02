/**
 * Output-shape tests for scripts/check-production-env.mjs.
 *
 * Spawned as a child process with a controlled env so we exercise the
 * real script end-to-end (CLI parsing → inspectOne → output writer).
 * Tests never use real secret values — synthetic markers only.
 *
 * These tests are scoped strictly to the script and its output:
 * - presence/shape/empty diagnostics surface correctly
 * - the new next-action text appears for each failure mode
 * - the script never echoes its input values back into stdout/stderr
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../scripts/check-production-env.mjs', import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(SCRIPT));

const MARKER = 'OPENCLAW_TEST_SYNTHETIC_VALUE_DO_NOT_PRINT';

function runChecker(envOverrides: Record<string, string>, extraArgs: string[] = []) {
  const result = spawnSync('node', [SCRIPT, '--env=production', ...extraArgs], {
    cwd: REPO_ROOT,
    env: {
      // Start from a clean slate — explicit env only.
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      ...envOverrides,
    },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function goodEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  // Synthetic-but-shape-valid values for every required var so a
  // single override can be tested in isolation.
  return {
    BLOB_READ_WRITE_TOKEN: `vercel_blob_rw_${MARKER}`,
    RESEND_WEBHOOK_SECRET: `whsec_${MARKER}`,
    RESEND_API_KEY: `re_${MARKER}`,
    HSB_ORDER_ADMIN_KEY: `admin-key-1234567890-${MARKER}`,
    LULU_CLIENT_KEY: `lulu-client-${MARKER}`,
    LULU_CLIENT_SECRET: `lulu-secret-${MARKER}`,
    STRIPE_SECRET_KEY: `sk_live_${MARKER}`,
    STRIPE_WEBHOOK_SECRET: `whsec_stripe_${MARKER}`,
    NEXT_PUBLIC_URL: 'https://herostorybooks.com',
    ...(overrides as Record<string, string>),
  };
}

test('all-good env exits 0 and PASSes without echoing any synthetic value', () => {
  const r = runChecker(goodEnv());
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Verdict: PASS/);
  assert.doesNotMatch(r.stdout, new RegExp(MARKER), 'no synthetic value may appear in stdout');
  assert.doesNotMatch(r.stderr, new RegExp(MARKER), 'no synthetic value may appear in stderr');
});

test('STRIPE_SECRET_KEY set to empty string (Vercel "encrypted but pulls blank" pattern) is reported PRESENT_BUT_EMPTY with the exact remediation', () => {
  const r = runChecker(goodEnv({ STRIPE_SECRET_KEY: '' }));
  assert.equal(r.status, 1, 'empty required var must fail');
  // Loud marker before the line.
  assert.match(r.stdout, /❌ FAIL  STRIPE_SECRET_KEY/);
  // Status label.
  assert.match(r.stdout, /PRESENT_BUT_EMPTY/);
  // Diagnostic copy that names the failure pattern explicitly.
  assert.match(r.stdout, /Encrypted in Vercel dashboard but pulls blank/);
  // Next-action contains the precise vercel env rm/add sequence and
  // points at the runbook by filename.
  assert.match(r.stdout, /vercel env rm STRIPE_SECRET_KEY production/);
  assert.match(r.stdout, /vercel env add STRIPE_SECRET_KEY production/);
  assert.match(r.stdout, /docs\/runbooks\/hsb-vercel-env-encrypted-but-blank-2026-06-02\.md/);
});

test('RESEND_WEBHOOK_SECRET completely missing is reported MISSING with a re-pull next-action', () => {
  const env = goodEnv();
  delete env.RESEND_WEBHOOK_SECRET;
  const r = runChecker(env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /❌ FAIL  RESEND_WEBHOOK_SECRET/);
  assert.match(r.stdout, /MISSING/);
  assert.match(r.stdout, /not set \(required on production\)/);
  assert.match(r.stdout, /Set RESEND_WEBHOOK_SECRET in Vercel/);
  assert.match(r.stdout, /vercel env pull --environment=production/);
});

test('LULU_WEBHOOK_SECRET missing is a WARN (not FAIL), still includes next-action', () => {
  const env = goodEnv();
  // LULU_WEBHOOK_SECRET is in spec.requiredOn=[] (optional but
  // recommended). MISSING for an optional var must be WARN, not FAIL.
  delete env.LULU_WEBHOOK_SECRET;
  const r = runChecker(env);
  // Exit 0 because the verdict is PASS for required-only — optional
  // missing is a warning per the script's failure rule.
  assert.equal(r.status, 0, 'optional-missing must not fail the run');
  assert.match(r.stdout, /⚠️  WARN LULU_WEBHOOK_SECRET/);
  assert.match(r.stdout, /Optional\. Set LULU_WEBHOOK_SECRET/);
});

test('Stripe TEST key on production is SHAPE_FAIL with explicit "test vs. live" diagnostic', () => {
  const r = runChecker(goodEnv({ STRIPE_SECRET_KEY: `sk_test_${MARKER}` }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /❌ FAIL  STRIPE_SECRET_KEY/);
  assert.match(r.stdout, /SHAPE_FAIL/);
  assert.match(r.stdout, /starts with 'sk_test_' — this is a TEST key/);
  // Next-action mentions the shape check + dashboard verification.
  assert.match(r.stdout, /Value is set but failed the shape check/);
  assert.match(r.stdout, /test key instead of live/);
});

test('--json mode returns valid JSON with verdict + per-result nextAction; no leakage', () => {
  const r = runChecker(goodEnv({ STRIPE_SECRET_KEY: '' }), ['--json']);
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'FAIL');
  assert.ok(Array.isArray(parsed.results));
  const stripe = parsed.results.find((row: { name: string }) => row.name === 'STRIPE_SECRET_KEY');
  assert.ok(stripe, 'STRIPE_SECRET_KEY must appear in results');
  assert.equal(stripe.status, 'PRESENT_BUT_EMPTY');
  assert.match(stripe.nextAction, /vercel env rm STRIPE_SECRET_KEY production/);
  // No leakage anywhere in JSON output.
  assert.doesNotMatch(r.stdout, new RegExp(MARKER));
});

test('HSB_BLOB_NAMESPACE set on production without explicit approval is PRESENT_DISALLOWED', () => {
  const r = runChecker(goodEnv({ HSB_BLOB_NAMESPACE: 'preview' }));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /❌ FAIL  HSB_BLOB_NAMESPACE/);
  assert.match(r.stdout, /PRESENT_DISALLOWED/);
  assert.match(r.stdout, /vercel env rm HSB_BLOB_NAMESPACE production/);
});

test('HSB_BLOB_NAMESPACE present + HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION=true is PRESENT (approved override)', () => {
  const r = runChecker(goodEnv({
    HSB_BLOB_NAMESPACE: 'override-namespace',
    HSB_BLOB_NAMESPACE_APPROVED_FOR_PRODUCTION: 'true',
  }));
  assert.equal(r.status, 0, 'approved override must not fail the run');
  assert.match(r.stdout, /✅ OK    HSB_BLOB_NAMESPACE/);
  assert.match(r.stdout, /treated as explicitly approved/);
});
