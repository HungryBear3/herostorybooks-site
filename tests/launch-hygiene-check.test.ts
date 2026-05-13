/**
 * Tests for the deploy-hygiene guardrail (scripts/launch-hygiene-check.mjs).
 *
 * The script is read-only and does no git mutation, file writes, or network
 * calls, so the test exercises the pure pieces directly:
 *
 *   - classifyPath / classifyChangedFiles: regex-driven scope routing
 *   - checkMixedScope: the load-bearing fail that prevents launch-safety +
 *     landing-marketing churn from sharing a branch
 *   - demoChecks: runbook canned outputs (smoke check — every case parses)
 *
 * The end-to-end git/Vercel surface is exercised by running the actual
 * script as a subprocess against this worktree (see the bottom test).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  classifyPath,
  classifyChangedFiles,
  checkMixedScope,
  demoChecks,
} from '../scripts/launch-hygiene-check.mjs';

// ── classifyPath: each scope is reachable, ambiguous paths fall through ──

test('classifyPath: launch-safety paths are routed to launch-safety', () => {
  const cases = [
    'src/app/api/webhooks/stripe/route.ts',
    'src/app/api/order/route.ts',
    'src/lib/fulfillment.ts',
    'src/lib/fulfillment-kickoff.ts',
    'src/lib/order-recovery.ts',
    'src/lib/orders.ts',
    'src/lib/stripe-env.ts',
    'src/lib/lulu.ts',
    'src/lib/admin-actions.ts',
    'src/lib/pdf-builder.ts',
    'src/app/admin/orders/page.tsx',
    'src/app/checkout/page.tsx',
    'src/app/thank-you/page.tsx',
    'src/app/review/[orderId]/page.tsx',
    'src/app/status/[orderId]/page.tsx',
    'tests/fulfillment-kickoff.test.ts',
    'tests/stripe-webhook-refund-replay.test.ts',
    'tests/admin-orders.test.ts',
    'tests/pdf-builder.test.ts',
  ];
  for (const p of cases) {
    assert.equal(classifyPath(p), 'launch-safety', `expected launch-safety for ${p}`);
  }
});

test('classifyPath: landing-marketing paths are routed to landing-marketing', () => {
  const cases = [
    'src/components/landing/Hero.tsx',
    'src/components/landing/FeaturedBooks.tsx',
    'src/components/Hero.tsx',
    'src/components/Testimonials.tsx',
    'src/components/HowItWorks.tsx',
    'src/components/Pricing.tsx',
    'src/components/Footer.tsx',
    'src/components/Navbar.tsx',
    'src/components/Logo.tsx',
    'src/components/TrustBadges.tsx',
    'src/app/page.tsx',
    'src/app/samples/page.tsx',
    'src/app/pricing/page.tsx',
    'public/samples/page-01.png',
    'public/hero/main.png',
    'public/book-covers/space.png',
    'src/styles/landing.css',
    'src/styles/theme.css',
  ];
  for (const p of cases) {
    assert.equal(classifyPath(p), 'landing-marketing', `expected landing-marketing for ${p}`);
  }
});

test('classifyPath: shared infra files are routed to shared (NOT launch-safety even when keyword matches)', () => {
  const cases = [
    'docs/runbooks/release-hygiene.md',
    'docs/runbooks/order-thing.md', // doc with "order" keyword — must stay shared
    'docs/runbooks/2026-05-08-stripe-webhook-preview-env.md',
    'scripts/launch-hygiene-check.mjs',
    'scripts/order-status.ts',
    'tests/launch-hygiene-check.test.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'next.config.js',
    'tailwind.config.js',
    'postcss.config.js',
    'components.json',
    'README.md',
    'CLAUDE.md',
    'PRD.md',
  ];
  for (const p of cases) {
    assert.equal(classifyPath(p), 'shared', `expected shared for ${p}`);
  }
});

test('classifyPath: unclassified files fall through to unknown', () => {
  const cases = [
    'src/components/charts/RandomNewWidget.tsx',
    'src/lib/some-new-thing.ts',
    'public/random/file.png',
    'misc/scratch.md',
  ];
  for (const p of cases) {
    assert.equal(classifyPath(p), 'unknown', `expected unknown for ${p}`);
  }
});

// ── classifyChangedFiles: groups across scopes ───────────────────────────────

test('classifyChangedFiles: aggregates a mixed file list correctly', () => {
  const files = [
    'src/app/api/webhooks/stripe/route.ts', // launch
    'src/lib/fulfillment-kickoff.ts',       // launch
    'src/components/landing/Hero.tsx',      // landing
    'src/app/page.tsx',                     // landing
    'docs/runbooks/release-hygiene.md',     // shared
    'misc/scratch.md',                      // unknown
  ];
  const grouped = classifyChangedFiles(files);
  assert.equal(grouped['launch-safety'].length, 2);
  assert.equal(grouped['landing-marketing'].length, 2);
  assert.equal(grouped.shared.length, 1);
  assert.equal(grouped.unknown.length, 1);
});

// ── checkMixedScope: the load-bearing fail ───────────────────────────────────

test('checkMixedScope: launch-safety + landing-marketing together → fail', () => {
  const grouped = {
    'launch-safety': ['src/lib/fulfillment-kickoff.ts'],
    'landing-marketing': ['src/app/page.tsx'],
    shared: [],
    unknown: [],
  };
  const r = checkMixedScope(grouped);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /split this branch.*single-purpose/i.test(r.reason ?? '') ? /single-purpose branches/ : /single-purpose branches/);
});

test('checkMixedScope: launch-safety only → ok', () => {
  const grouped = {
    'launch-safety': ['src/lib/fulfillment-kickoff.ts'],
    'landing-marketing': [],
    shared: ['docs/runbooks/release-hygiene.md'],
    unknown: [],
  };
  assert.equal(checkMixedScope(grouped).ok, true);
});

test('checkMixedScope: landing-marketing only → ok (no launch-safety contamination)', () => {
  const grouped = {
    'launch-safety': [],
    'landing-marketing': ['src/app/page.tsx', 'src/components/landing/Hero.tsx'],
    shared: [],
    unknown: [],
  };
  assert.equal(checkMixedScope(grouped).ok, true);
});

test('checkMixedScope: only shared/unknown → ok (no scope assertion to make)', () => {
  const grouped = {
    'launch-safety': [],
    'landing-marketing': [],
    shared: ['package.json'],
    unknown: ['misc/scratch.md'],
  };
  assert.equal(checkMixedScope(grouped).ok, true);
});

// ── demoChecks: every documented case parses + produces the expected verdict ─

test('demoChecks: clean → all pass', () => {
  const cs = demoChecks('clean');
  assert.ok(cs.length > 0);
  assert.equal(cs.some((c) => c.level === 'fail'), false);
});

test('demoChecks: dirty → at least one fail (the tree check)', () => {
  const cs = demoChecks('dirty');
  const treeFail = cs.find((c) => c.id === 'tree' && c.level === 'fail');
  assert.ok(treeFail, 'expected a fail-level tree check');
});

test('demoChecks: on-main → branch check fails', () => {
  const cs = demoChecks('on-main');
  const branchFail = cs.find((c) => c.id === 'branch' && c.level === 'fail');
  assert.ok(branchFail);
});

test('demoChecks: mixed-scope → scope fail with both launch-safety + landing-marketing files', () => {
  const cs = demoChecks('mixed-scope');
  const scopeFail = cs.find((c) => c.id === 'scope' && c.level === 'fail');
  assert.ok(scopeFail);
  const g = scopeFail!.data?.grouped as Record<string, string[]> | undefined;
  assert.ok(g);
  assert.ok(g!['launch-safety'].length > 0);
  assert.ok(g!['landing-marketing'].length > 0);
});

test('demoChecks: no-vercel → warn (no fail)', () => {
  const cs = demoChecks('no-vercel');
  assert.equal(cs.some((c) => c.level === 'fail'), false);
  assert.ok(cs.some((c) => c.id === 'vercel' && c.level === 'warn'));
});

test('demoChecks: unknown demo case throws', () => {
  assert.throws(() => demoChecks('not-a-case'), /unknown demo case/);
});

// ── End-to-end: real subprocess against this worktree ────────────────────────

test('e2e: --help exits 0 and prints usage', () => {
  const out = execFileSync(process.execPath, ['scripts/launch-hygiene-check.mjs', '--help'], { encoding: 'utf8' });
  assert.match(out, /Usage:/);
  assert.match(out, /--base/);
  assert.match(out, /--demo/);
});

test('e2e: --demo=mixed-scope exits 1 (fail) and prints both file lists', () => {
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['scripts/launch-hygiene-check.mjs', '--demo=mixed-scope'], { encoding: 'utf8' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number; stdout?: Buffer };
    code = e.status ?? -1;
    stdout = e.stdout?.toString() ?? '';
  }
  assert.equal(code, 1, `expected exit 1, got ${code}`);
  assert.match(stdout, /MIXED SCOPE/);
  assert.match(stdout, /launch-safety/);
  assert.match(stdout, /landing-marketing/);
  assert.match(stdout, /NOT safe to deploy/);
});

test('e2e: --demo=clean exits 0 (pass) and prints safe-to-deploy verdict', () => {
  const out = execFileSync(process.execPath, ['scripts/launch-hygiene-check.mjs', '--demo=clean'], { encoding: 'utf8' });
  assert.match(out, /safe to deploy/);
});

test('e2e: --json --demo=mixed-scope emits parseable JSON with a fail check', () => {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, ['scripts/launch-hygiene-check.mjs', '--json', '--demo=mixed-scope'], { encoding: 'utf8' });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: Buffer };
    stdout = e.stdout?.toString() ?? '';
  }
  const parsed = JSON.parse(stdout) as { checks: Array<{ id: string; level: string }> };
  assert.ok(Array.isArray(parsed.checks));
  assert.ok(parsed.checks.some((c) => c.id === 'scope' && c.level === 'fail'));
});

test('script source: read-only invariants (no git mutations, no fs writes, no network)', () => {
  const src = readFileSync('scripts/launch-hygiene-check.mjs', 'utf8');
  // Strip block + line comments so the regexes only inspect executable code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // No mutating git verbs.
  for (const verb of ['commit', 'push', 'reset', 'checkout', 'stash', 'add', 'rm']) {
    assert.doesNotMatch(
      code,
      new RegExp(`["'](?:git\\s+)?${verb}\\b`, 'i'),
      `script must not invoke git ${verb}`,
    );
  }
  // No fs write APIs.
  assert.doesNotMatch(code, /\bwriteFile(?:Sync)?\s*\(/);
  assert.doesNotMatch(code, /\bappendFile(?:Sync)?\s*\(/);
  assert.doesNotMatch(code, /\bunlink(?:Sync)?\s*\(/);
  // No network calls.
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.doesNotMatch(code, /\brequire\(["']https?["']\)/);
});
