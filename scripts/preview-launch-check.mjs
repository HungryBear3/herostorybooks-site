#!/usr/bin/env node
/**
 * HSB Preview-only launch verification.
 *
 * Purpose: gate every Preview URL handed to Alexy on a deterministic
 * checklist so a dirty / unverified Preview cannot slip through. Runs
 * locally; never deploys production; never prints secret values; never
 * mutates checkout / Lulu / payment code.
 *
 * Phases:
 *   1. Git safety info (branch, HEAD, dirty file count). Dirty trees
 *      emit a loud warning but do not abort — the operator may have
 *      intentional WIP. Warning is reflected in the final report.
 *   2. Env presence check. Reports PRESENT / MISSING for the env vars
 *      below. Never prints values.
 *   3. Gates: `npm run build` and the targeted test suite. Lint is
 *      optional — if eslint cannot start (the repo's pre-existing v9
 *      migration issue), this phase reports the blocker without failing.
 *   4. Preview-only deploy via `vercel deploy` (no --prod flag, ever).
 *      Captures the Preview URL from stdout.
 *   5. Smoke routes against the captured Preview URL. Each route must
 *      return 200 or a 30x redirect to count as healthy.
 *   6. Final report with explicit safety lines:
 *        "Production deploy: NOT RUN"
 *        "Payment/Lulu live actions: NOT RUN"
 *        "Preview only"
 *
 * Hard rules enforced by THIS script:
 *   - No `vercel deploy --prod`, ever. The `--prod` flag is explicitly
 *     rejected before the deploy command runs.
 *   - No env-var values printed; only PRESENT / MISSING.
 *   - No git mutations. No file writes outside ./.preview-check-*.log.
 *   - No Stripe / Lulu / Supabase / Resend / FAL / OpenAI / Gemini
 *     calls. The only network call this script makes is HTTP GET against
 *     the Preview URL it captured from vercel deploy output.
 *
 * Exit codes:
 *   0  all gates green
 *   1  one or more gates failed
 *   2  invocation error (vercel CLI missing, etc.)
 *
 * Usage:
 *   npm run preview:check
 *   node scripts/preview-launch-check.mjs --skip-deploy   (env+gates only)
 *   node scripts/preview-launch-check.mjs --json          (machine-readable)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────

/**
 * Env vars we check for presence (never value). Keep this list in sync
 * with the operator runbook. Adding a new var here is the canonical
 * place to record "this must be set on Preview before we ship a URL to
 * Alexy."
 */
const ENV_GROUPS = {
  Stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY'],
  'Gemini / Google': ['GOOGLE_GEMINI_API_KEY', 'HSB_GEMINI_IMAGE_MODEL'],
  Lulu: ['LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET'],
  'Blob / storage': ['BLOB_READ_WRITE_TOKEN', 'HSB_BLOB_NAMESPACE'],
  Vercel: ['VERCEL_TOKEN'],
};

/** Routes to smoke against the captured Preview URL. Each must return
 *  200 or 3xx. Order is informational, not significant. */
const SMOKE_ROUTES = [
  '/',
  '/checkout',
  '/pricing',
  '/samples',
  '/sample',                              // 308 → /samples (2026-05-19 hotfix)
  '/start',                               // 308 → /checkout (2026-05-19 hotfix)
  '/faq',                                 // 308 → /#faq (2026-05-19 hotfix)
  '/thank-you',
  '/privacy',
  '/terms',
  '/this-route-does-not-exist-on-purpose', // branded 404 surface
];

const ROUTE_TIMEOUT_MS = 15_000;
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

// ── Output helpers ────────────────────────────────────────────────────────

const ANSI = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function color(name, s) {
  if (process.stdout.isTTY) return `${ANSI[name]}${s}${ANSI.reset}`;
  return s;
}

function header(title) {
  console.log('');
  console.log(color('bold', `── ${title} ${'─'.repeat(Math.max(0, 72 - title.length - 4))}`));
}

function ok(label, detail = '') {
  console.log(`${color('green', '✓')} ${label}${detail ? ` ${color('dim', detail)}` : ''}`);
}

function warn(label, detail = '') {
  console.log(`${color('yellow', '!')} ${label}${detail ? ` ${color('dim', detail)}` : ''}`);
}

function fail(label, detail = '') {
  console.log(`${color('red', '✗')} ${label}${detail ? ` ${color('dim', detail)}` : ''}`);
}

function info(line) {
  console.log(`  ${color('dim', line)}`);
}

// ── Arg parsing ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { skipDeploy: false, json: false, help: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--skip-deploy') args.skipDeploy = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--prod' || arg === '--production') {
      // Defense in depth — refuse to be tricked into a production deploy.
      console.error('[preview-check] --prod / --production is REFUSED by this script. Preview only.');
      process.exit(2);
    } else {
      console.error(`[preview-check] unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.log(`HSB Preview-only launch verification.

USAGE
  npm run preview:check
  node scripts/preview-launch-check.mjs [--skip-deploy] [--json]

OPTIONS
  --skip-deploy    Run phases 1-3 only (env + gates), no Vercel deploy
  --json           Emit a final JSON report on stdout (still logs to stderr)
  --help, -h       This message

This script NEVER deploys production. The Vercel command is hardcoded
to deploy in Preview mode. The --prod / --production flag is rejected
before any deploy command runs.
`);
}

// ── Phase 1: git safety ───────────────────────────────────────────────────

function gitInfo() {
  function run(args) {
    try {
      return execFileSync('git', args, { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = run(['rev-parse', '--short=12', 'HEAD']);
  const dirtyLines = run(['status', '--porcelain']).split('\n').filter(Boolean);
  return {
    branch: branch || '(unknown)',
    head: head || '(unknown)',
    dirty: dirtyLines.length > 0,
    dirtyFileCount: dirtyLines.length,
  };
}

function reportGit(state) {
  header('Git safety');
  ok('branch', state.branch);
  ok('HEAD', state.head);
  if (state.dirty) {
    warn(
      'working tree is DIRTY',
      `${state.dirtyFileCount} file(s) modified — uncommitted changes will be deployed to Preview`,
    );
  } else {
    ok('working tree clean');
  }
}

// ── Phase 2: env presence ─────────────────────────────────────────────────

function envPresence() {
  const out = {};
  for (const [group, vars] of Object.entries(ENV_GROUPS)) {
    out[group] = vars.map((name) => ({
      name,
      present: typeof process.env[name] === 'string' && process.env[name].length > 0,
    }));
  }
  return out;
}

function reportEnv(state) {
  header('Env presence (no values printed)');
  let anyMissing = false;
  for (const [group, vars] of Object.entries(state)) {
    console.log(`  ${color('bold', group)}`);
    for (const { name, present } of vars) {
      if (present) {
        ok(`    ${name}`, 'PRESENT');
      } else {
        warn(`    ${name}`, 'MISSING');
        anyMissing = true;
      }
    }
  }
  if (anyMissing) {
    info('At least one env var is MISSING in this shell. Vercel Preview may still');
    info('have these set on the deployment — this report reflects the LOCAL shell.');
  }
}

// ── Phase 3: gates (build / tests / lint) ─────────────────────────────────

function runGate(cmd, args, opts = {}) {
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    stdio: opts.captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: opts.timeoutMs ?? undefined,
    env: opts.env ?? process.env,
  });
  const elapsedMs = Date.now() - start;
  const ok = result.status === 0;
  const stdout = result.stdout?.toString('utf8') ?? '';
  const stderr = result.stderr?.toString('utf8') ?? '';
  return { ok, status: result.status, signal: result.signal, elapsedMs, stdout, stderr };
}

function runBuild() {
  header('Gate: npm run build');
  const r = runGate('npm', ['run', 'build']);
  if (r.ok) {
    ok('build passed', `${(r.elapsedMs / 1000).toFixed(1)}s`);
  } else {
    fail('build FAILED', `exit ${r.status}`);
  }
  return r;
}

function runTests() {
  header('Gate: npm test');
  const r = runGate('npm', ['test']);
  if (r.ok) {
    ok('tests passed', `${(r.elapsedMs / 1000).toFixed(1)}s`);
  } else {
    fail('tests FAILED', `exit ${r.status}`);
  }
  return r;
}

function runLintOptional() {
  header('Optional: npm run lint');
  // Many HSB checkouts carry a pre-existing ESLint v9 migration error
  // (legacy `.eslintrc.*` rather than `eslint.config.js`). Treat lint as
  // a soft signal so this script's report does not crash on a known
  // unrelated tooling state.
  const r = runGate('npm', ['run', 'lint'], { captureOutput: true });
  if (r.ok) {
    ok('lint passed');
    return { ok: true, skipped: false };
  }
  const text = `${r.stdout}\n${r.stderr}`;
  if (/eslint.+(not\s+found|migration|config file)/i.test(text)) {
    warn('lint SKIPPED', 'ESLint v9 migration / config absent — pre-existing tooling state');
    return { ok: true, skipped: true, reason: 'eslint-v9-migration' };
  }
  fail('lint FAILED', `exit ${r.status}`);
  return { ok: false, skipped: false };
}

// ── Phase 4: Preview-only deploy ──────────────────────────────────────────

function vercelAvailable() {
  const r = spawnSync('vercel', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0;
}

function vercelLinked() {
  return existsSync(resolve(process.cwd(), '.vercel', 'project.json'));
}

function deployPreview() {
  header('Phase 4: Preview deploy (NEVER --prod)');
  if (!vercelAvailable()) {
    fail('vercel CLI not found in PATH');
    info('Install with:  npm i -g vercel');
    info('Or run via npx: npx vercel --version');
    return { ok: false, reason: 'vercel-cli-missing' };
  }
  ok('vercel CLI', 'available');
  if (!vercelLinked()) {
    fail('.vercel/project.json missing — project is not linked');
    info('Run:  vercel link');
    info('Then re-run this check.');
    return { ok: false, reason: 'vercel-not-linked' };
  }
  ok('.vercel/project.json', 'present (project linked)');

  // Hardcoded preview flags. NEVER include --prod / --production.
  const args = ['deploy', '--yes', '--archive=tgz'];
  console.log(color('dim', `  invoking: vercel ${args.join(' ')}`));
  const start = Date.now();
  const r = spawnSync('vercel', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DEPLOY_TIMEOUT_MS,
    env: process.env,
  });
  const elapsedMs = Date.now() - start;
  const stdout = r.stdout?.toString('utf8') ?? '';
  const stderr = r.stderr?.toString('utf8') ?? '';

  if (r.status !== 0) {
    fail('vercel deploy FAILED', `exit ${r.status} (${(elapsedMs / 1000).toFixed(1)}s)`);
    // Surface vercel's own error lines (not values, just diagnostics).
    const tail = stderr.split('\n').slice(-8).filter(Boolean);
    for (const line of tail) info(line);
    return { ok: false, reason: 'vercel-deploy-failed', stderr: tail.join('\n'), elapsedMs };
  }

  // Vercel prints the Preview URL as the last URL-shaped line on stdout.
  const urlMatch = stdout.match(/https:\/\/[a-z0-9-]+(?:-[a-z0-9-]+)*\.vercel\.app/g);
  const previewUrl = urlMatch ? urlMatch[urlMatch.length - 1] : null;
  if (!previewUrl) {
    fail('Preview URL not captured from vercel output');
    info('vercel deploy succeeded but the URL parser missed it — inspect stdout.');
    return { ok: false, reason: 'preview-url-not-captured', stdout: stdout.slice(0, 400), elapsedMs };
  }
  ok('preview URL captured', previewUrl);
  return { ok: true, previewUrl, elapsedMs };
}

// ── Phase 5: route smoke ──────────────────────────────────────────────────

async function smokeRoute(baseUrl, path) {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'user-agent': 'hsb-preview-launch-check/1.0' },
    });
    const status = res.status;
    const ok = status === 200 || (status >= 300 && status < 400);
    return { path, url, status, ok };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path, url, status: 0, ok: false, error: msg.slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

async function smokeRoutes(baseUrl) {
  header(`Phase 5: smoke routes against ${baseUrl}`);
  const results = [];
  for (const path of SMOKE_ROUTES) {
    const r = await smokeRoute(baseUrl, path);
    results.push(r);
    if (r.ok) ok(`${path}`, `${r.status}`);
    else fail(`${path}`, r.error ? `error: ${r.error}` : `status ${r.status}`);
  }
  return results;
}

// ── Phase 6: final report ─────────────────────────────────────────────────

function finalReport(state) {
  header('Final report');
  console.log(`  Branch:           ${state.git.branch}`);
  console.log(`  HEAD:             ${state.git.head}`);
  console.log(`  Working tree:     ${state.git.dirty ? color('yellow', `DIRTY (${state.git.dirtyFileCount} file(s))`) : 'clean'}`);
  console.log(`  Build:            ${state.build?.ok ? color('green', 'PASS') : color('red', 'FAIL')}`);
  console.log(`  Tests:            ${state.tests?.ok ? color('green', 'PASS') : color('red', 'FAIL')}`);
  console.log(`  Lint:             ${
    state.lint?.skipped
      ? color('yellow', `SKIPPED (${state.lint.reason})`)
      : state.lint?.ok
      ? color('green', 'PASS')
      : color('red', 'FAIL')
  }`);
  if (state.deploy?.previewUrl) {
    console.log(`  Preview URL:      ${color('green', state.deploy.previewUrl)}`);
  } else if (state.deploy?.skipped) {
    console.log(`  Preview URL:      ${color('yellow', 'SKIPPED (--skip-deploy)')}`);
  } else {
    console.log(`  Preview URL:      ${color('red', `NOT CAPTURED (${state.deploy?.reason ?? 'unknown'})`)}`);
  }
  if (state.smoke) {
    const passing = state.smoke.filter((r) => r.ok).length;
    console.log(`  Route smoke:      ${passing}/${state.smoke.length} ${passing === state.smoke.length ? color('green', 'PASS') : color('red', 'FAIL')}`);
    for (const r of state.smoke) {
      const tag = r.ok ? color('green', 'ok ') : color('red', 'BAD');
      console.log(`    ${tag}  ${r.path.padEnd(14)} ${r.status || (r.error ?? '')}`);
    }
  }

  console.log('');
  console.log(color('bold', '  Safety:'));
  console.log(`    ${color('green', 'Production deploy:')}        NOT RUN`);
  console.log(`    ${color('green', 'Payment/Lulu live actions:')} NOT RUN`);
  console.log(`    ${color('green', 'Preview only')}`);
  console.log('');
}

function computeExitCode(state) {
  if (state.build && !state.build.ok) return 1;
  if (state.tests && !state.tests.ok) return 1;
  if (state.deploy && state.deploy.ok === false && !state.deploy.skipped) return 1;
  if (state.smoke && state.smoke.some((r) => !r.ok)) return 1;
  return 0;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  // Pin cwd to the repo root so spawn calls resolve consistently.
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = resolve(scriptPath, '..', '..');
  if (process.cwd() !== repoRoot) process.chdir(repoRoot);

  const state = {};

  // Phase 1
  state.git = gitInfo();
  reportGit(state.git);

  // Phase 2
  state.env = envPresence();
  reportEnv(state.env);

  // Phase 3
  state.build = runBuild();
  state.tests = runTests();
  state.lint = runLintOptional();

  // Phase 4
  if (args.skipDeploy) {
    header('Phase 4: Preview deploy SKIPPED (--skip-deploy)');
    info('Re-run without --skip-deploy to actually deploy.');
    state.deploy = { ok: false, skipped: true };
  } else if (!state.build.ok) {
    header('Phase 4: Preview deploy SKIPPED');
    info('Refusing to deploy because the build gate failed above.');
    state.deploy = { ok: false, skipped: true, reason: 'build-failed' };
  } else {
    state.deploy = deployPreview();
  }

  // Phase 5
  if (state.deploy?.previewUrl) {
    state.smoke = await smokeRoutes(state.deploy.previewUrl);
  } else {
    header('Phase 5: smoke routes SKIPPED');
    info('No Preview URL available (deploy was skipped or failed).');
  }

  // Phase 6
  finalReport(state);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(
      {
        git: state.git,
        env: state.env,
        build: { ok: state.build?.ok, elapsedMs: state.build?.elapsedMs },
        tests: { ok: state.tests?.ok, elapsedMs: state.tests?.elapsedMs },
        lint: state.lint,
        deploy: state.deploy?.previewUrl
          ? { ok: true, previewUrl: state.deploy.previewUrl, elapsedMs: state.deploy.elapsedMs }
          : { ok: false, skipped: !!state.deploy?.skipped, reason: state.deploy?.reason ?? null },
        smoke: state.smoke ?? null,
        safety: {
          productionDeploy: 'NOT_RUN',
          paymentLuluLiveActions: 'NOT_RUN',
          previewOnly: true,
        },
      },
      null,
      2,
    )}\n`);
  }

  process.exit(computeExitCode(state));
}

main().catch((err) => {
  console.error('[preview-check] fatal:', err instanceof Error ? err.message : err);
  process.exit(2);
});
