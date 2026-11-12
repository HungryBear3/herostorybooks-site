/**
 * CI harness alignment: the canonical Node suite launcher, the separately run
 * joined mounted journey, and the feature-on layout browser partition.
 *
 * Checked against the ACTUAL package scripts, workflow text and Playwright's
 * own collected test lists — not against intentions. Missing helpers fail with
 * an explicit SETUP_RED assertion; they are never skipped.
 *
 * Offline. The only children are local node processes: a module-mock probe,
 * preload probes, a synthetic-tree suite run, and `playwright test --list`
 * (which collects without building, serving or launching a browser). Nothing
 * reaches a provider, a database or an off-host address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPERS = path.join(ROOT, 'tests', 'helpers');
const HELPER_NAMES = [
  'ci-node-suite.mjs',
  'ci-joined.mjs',
  'ci-offline-preload.mjs',
  'ci-loopback-preload.mjs',
  'ci-native-aliases.mjs',
];
const JOURNEY = 'initial-shipping-journey.test.ts';
const LAYOUT_SPEC = 'checkout-primary-layout.spec.ts';
const CORE_FLAGS = ['--experimental-strip-types', '--experimental-test-module-mocks', '--test', '--test-concurrency=1'];
const DOTENV_PRELOAD = path.join(ROOT, 'tests', 'e2e', 'disable-next-dotenv.cjs');
const NEXT_BIN = path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
const PLAYWRIGHT_CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/** Workflow text with whole-line comments removed, so prose cannot satisfy a check. */
function code(text: string): string {
  return text.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
}
const unitAt = workflow.indexOf('\n  unit-and-build:\n');
const e2eAt = workflow.indexOf('\n  e2e:\n');
const unitJob = code(workflow.slice(Math.max(unitAt, 0), e2eAt > unitAt ? e2eAt : undefined));
const e2eJob = code(workflow.slice(Math.max(e2eAt, 0)));

/** Explicit child environment: nothing inherited, NODE_TEST_CONTEXT never set. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? os.homedir(), ...extra };
}

function scratchDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function loadHelper(name: string): Promise<any> {
  const file = path.join(HELPERS, name);
  assert.ok(existsSync(file), `SETUP_RED: ${path.relative(ROOT, file)} does not exist yet`);
  return import(pathToFileURL(file).href);
}

function tapCount(output: string, name: string): number | null {
  const match = output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'));
  return match ? Number(match[1]) : null;
}

function repositoryTestFiles(root: string): string[] {
  return readdirSync(path.join(root, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name)
    .sort();
}

// ── package.json ───────────────────────────────────────────────────────────

test('package build, browser, lint scripts and module type are unchanged', () => {
  assert.equal(
    pkg.scripts.build,
    'node --experimental-strip-types scripts/check-story-media-env.ts && node --experimental-strip-types scripts/check-confirmation-envelope-env.ts && next build',
  );
  assert.equal(pkg.scripts['test:e2e'], 'playwright test');
  assert.equal(pkg.scripts['test:e2e:desktop'], 'playwright test --project=desktop-chromium');
  assert.equal(pkg.scripts['test:e2e:mobile'], 'playwright test --project=mobile-chromium');
  assert.equal(pkg.scripts.lint, 'eslint .');
  assert.equal(pkg.scripts.dev, 'next dev');
  assert.equal(pkg.scripts.start, 'next start');
  assert.equal(pkg.type, undefined, 'the package module type must not change');
});

test('package dependencies and devDependencies are unchanged', () => {
  assert.deepEqual(pkg.dependencies, {
    '@hookform/resolvers': '^3.9.1',
    '@radix-ui/react-accordion': '1.2.12',
    '@radix-ui/react-alert-dialog': '1.1.15',
    '@radix-ui/react-aspect-ratio': '1.1.8',
    '@radix-ui/react-avatar': '1.1.11',
    '@radix-ui/react-checkbox': '1.3.3',
    '@radix-ui/react-collapsible': '1.1.12',
    '@radix-ui/react-context-menu': '2.2.16',
    '@radix-ui/react-dialog': '1.1.15',
    '@radix-ui/react-dropdown-menu': '2.1.16',
    '@radix-ui/react-hover-card': '1.1.15',
    '@radix-ui/react-label': '2.1.8',
    '@radix-ui/react-menubar': '1.1.16',
    '@radix-ui/react-navigation-menu': '1.2.14',
    '@radix-ui/react-popover': '1.1.15',
    '@radix-ui/react-progress': '1.1.8',
    '@radix-ui/react-radio-group': '1.3.8',
    '@radix-ui/react-scroll-area': '1.2.10',
    '@radix-ui/react-select': '2.2.6',
    '@radix-ui/react-separator': '1.1.8',
    '@radix-ui/react-slider': '1.3.6',
    '@radix-ui/react-slot': '1.2.4',
    '@radix-ui/react-switch': '1.2.6',
    '@radix-ui/react-tabs': '1.1.13',
    '@radix-ui/react-toast': '1.2.15',
    '@radix-ui/react-toggle': '1.1.10',
    '@radix-ui/react-toggle-group': '1.1.11',
    '@radix-ui/react-tooltip': '1.2.8',
    '@vercel/blob': '^2.3.3',
    autoprefixer: '^10.4.20',
    'class-variance-authority': '^0.7.1',
    clsx: '^2.1.1',
    cmdk: '1.1.1',
    'date-fns': '4.1.0',
    'embla-carousel-react': '8.6.0',
    'framer-motion': '^12.38.0',
    'input-otp': '1.4.2',
    'lucide-react': '^0.564.0',
    next: '16.2.0',
    'next-themes': '^0.4.6',
    'node-fetch': '^2.6.9',
    openai: '^6.34.0',
    pdfkit: '^0.18.0',
    pg: '8.23.0',
    react: '^19',
    'react-day-picker': '9.13.2',
    'react-dom': '^19',
    'react-hook-form': '^7.54.1',
    'react-resizable-panels': '^2.1.7',
    recharts: '2.15.0',
    resend: '^6.12.2',
    sharp: '^0.34.5',
    sonner: '^1.7.1',
    stripe: '^22.0.2',
    'tailwind-merge': '^3.3.1',
    vaul: '^1.1.2',
    zod: '^3.24.1',
  });
  assert.deepEqual(pkg.devDependencies, {
    '@playwright/test': '^1.62.1',
    '@tailwindcss/postcss': '^4.2.0',
    '@types/node': '^22',
    '@types/pdfkit': '^0.17.6',
    '@types/pg': '8.23.1',
    '@types/react': '^19',
    '@types/react-dom': '^19',
    postcss: '^8.5',
    tailwindcss: '^4.2.0',
    'tw-animate-css': '1.3.3',
    typescript: '5.7.3',
  });
});

test('npm test runs the canonical suite launcher', () => {
  assert.equal(pkg.scripts.test, 'node tests/helpers/ci-node-suite.mjs');
});

test('the joined journey and the feature-on layout suite have their own scripts', () => {
  assert.equal(pkg.scripts['test:joined'], 'node tests/helpers/ci-joined.mjs');
  assert.equal(pkg.scripts['test:e2e:layout'], 'playwright test --config=playwright.layout.config.ts');
});

// ── Workflow: preserved read-only and credential posture ───────────────────

test('workflow keeps stable check names, read-only permissions and no secret access', () => {
  assert.ok(unitAt >= 0 && e2eAt > unitAt, 'workflow jobs unit-and-build and e2e were not located');
  assert.equal(workflow.split('\n    name: npm test + next build\n').length, 2);
  assert.equal(workflow.split('\n    name: npm run test:e2e (Chromium)\n').length, 2);
  const live = code(workflow);
  assert.match(live, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(live, /secrets\./);
  assert.doesNotMatch(live, /^\s*environment\s*:/m);
  assert.doesNotMatch(live, /^\s*pull_request_target\s*:/m);
  assert.doesNotMatch(live, /continue-on-error/);
  assert.equal(live.split('persist-credentials: false').length, 3);
  for (const name of [
    'BLOB_READ_WRITE_TOKEN', 'CRON_SECRET', 'FAL_KEY', 'GOOGLE_GEMINI_API_KEY', 'HSB_ORDER_ADMIN_KEY',
    'HSB_PRIVATE_READ_WRITE_TOKEN', 'HSB_INTAKE_BLOB_READ_WRITE_TOKEN', 'HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN',
    'HSB_RESEND_API_KEY', 'LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_WEBHOOK_SECRET', 'OPENAI_API_KEY',
    'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'VERCEL', 'VERCEL_ENV',
  ]) {
    assert.match(live, new RegExp(`^ {2}${name}: ''$`, 'm'), `${name} is no longer blanked`);
  }
  assert.match(live, /^ {2}HSB_BLOB_ACCESS_MODE: 'private'$/m);
});

test('workflow makes no broad system, service or local-database changes', () => {
  const live = code(workflow);
  assert.doesNotMatch(live, /\bsystemctl\b|\bservice\s+postgresql|\bpg_ctlcluster\b|\bpg_createcluster\b|\bbrew\s/);
  assert.doesNotMatch(live, /chmod[^\n]*(?:RUNNER_TEMP|runner\.temp)/, 'RUNNER_TEMP must be validated, never chmod-ed');
  assert.doesNotMatch(live, /--use-existing-build|--test-skip-pattern|--test-name-pattern|--grep-invert|--pass-with-no-tests/);
  assert.doesNotMatch(live, />\s*\/etc\/postgresql-common\/createcluster\.conf\b/, 'createcluster.conf must not be overwritten');
  assert.doesNotMatch(live, /tee\s+(?!-a\b)[^\n|]*\/etc\/postgresql-common\/createcluster\.conf\b/);
  assert.doesNotMatch(live, /apt-get install[^\n]*\bpostgresql\b(?!-)/, 'the postgresql metapackage creates a default cluster');
  assert.doesNotMatch(live, /\bpostgresql-1[78]\b/);
  assert.doesNotMatch(e2eJob, /postgresql/, 'the browser job installs no PostgreSQL');
  assert.doesNotMatch(unitJob, /test:joined|test:e2e:layout/, 'the unit job runs no browser partition');
});

// ── Workflow: hosted PostgreSQL binaries and owned scratch ─────────────────

const npmTestAt = unitJob.search(/^\s*run:\s*npm test\s*$/m);
const beforeNpmTest = npmTestAt >= 0 ? unitJob.slice(0, npmTestAt) : '';

test('unit job installs postgresql-16 only after disabling default cluster creation', () => {
  assert.ok(npmTestAt >= 0, 'the unit job no longer runs npm test');
  assert.match(unitJob, /apt-get install[^\n]*poppler-utils[^\n]*ripgrep/);
  const common = unitJob.search(/apt-get install[^\n]*\bpostgresql-common\b/);
  const config = unitJob.search(/create_main_cluster\s*=\s*false/);
  const server = unitJob.search(/apt-get install[^\n]*\bpostgresql-16\b/);
  assert.ok(common >= 0, 'postgresql-common is not installed');
  assert.ok(config > common, 'create_main_cluster = false is not configured after postgresql-common');
  assert.ok(server > config, 'postgresql-16 is not installed after the cluster-creation opt-out');
  assert.ok(server < npmTestAt, 'PostgreSQL binaries must be present before npm test');
});

test('unit job discovers one coherent versioned bin dir and proves the harness resolves it', () => {
  assert.match(beforeNpmTest, /\/usr\/lib\/postgresql\//);
  const ordered = /18\s+17\s+16/.test(beforeNpmTest)
    || (beforeNpmTest.indexOf('postgresql/18') >= 0
      && beforeNpmTest.indexOf('postgresql/18') < beforeNpmTest.indexOf('postgresql/17')
      && beforeNpmTest.indexOf('postgresql/17') < beforeNpmTest.indexOf('postgresql/16'));
  assert.ok(ordered, 'versioned directories are not searched 18, 17, 16 in order');
  for (const tool of ['initdb', 'pg_ctl', 'psql', 'postgres']) {
    assert.match(beforeNpmTest, new RegExp(`(?:/|\\s)${tool}(?![\\w-])`), `${tool} is not checked`);
  }
  assert.match(beforeNpmTest, /-x\s/, 'binaries are not checked for executability');
  assert.match(beforeNpmTest, /--version/);
  assert.match(beforeNpmTest, />>\s*"?\$\{?GITHUB_PATH\}?"?/, 'the selected dir is not added to GITHUB_PATH');
  assert.match(beforeNpmTest, /resolvePostgresTools/);
  assert.match(beforeNpmTest, /tests\/support\/postgres-harness\.ts/);
});

test('unit job validates RUNNER_TEMP and creates only the fixed 0700 owned child', () => {
  assert.match(
    beforeNpmTest,
    /mkdir\s+-m\s+0?700\s+"?(?:\$\{?RUNNER_TEMP\}?|\$\{\{\s*runner\.temp\s*\}\})\/hsb-scratch"?/,
  );
  assert.match(beforeNpmTest, /realpath/);
  assert.match(beforeNpmTest, /-L\s+"?\$\{?RUNNER_TEMP/);
  const step = unitJob.slice(npmTestAt, unitJob.indexOf('run: npm run build'));
  assert.match(step, /^\s*TMPDIR:\s*\$\{\{\s*runner\.temp\s*\}\}\/hsb-scratch\s*$/m);
  assert.match(step, /HSB_ORDER_STORE_DIR:\s*\$\{\{\s*runner\.temp\s*\}\}\/hsb-order-store-unit/);
});

// ── Workflow: feature-on layout and joined journey in the required browser job

test('browser job runs the layout partition and the joined journey after the default suite', () => {
  const chromium = e2eJob.indexOf('npx playwright install --with-deps chromium');
  const main = e2eJob.search(/^\s*run:\s*npm run test:e2e\s*$/m);
  const layout = e2eJob.search(/^\s*run:\s*npm run test:e2e:layout\s*$/m);
  const joined = e2eJob.search(/^\s*run:\s*npm run test:joined\s*$/m);
  const upload = e2eJob.indexOf('actions/upload-artifact');
  assert.ok(chromium >= 0 && main > chromium, 'default browser suite no longer follows the Chromium install');
  assert.ok(layout > main, 'feature-on layout partition is not run in the browser job');
  assert.ok(joined > main, 'joined journey is not run in the browser job');
  assert.ok(upload > Math.max(layout, joined));
  const joinedStep = e2eJob.slice(joined, upload);
  assert.match(joinedStep, /^\s*TMPDIR:\s*\$\{\{\s*runner\.temp\s*\}\}\s*$/m);
  const timeout = Number(e2eJob.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  assert.ok(timeout > 30 && timeout <= 60, `browser job timeout ${timeout} does not budget three builds`);
  for (const artifact of ['playwright-report/', 'test-results/', 'playwright-report-layout/', 'test-results-layout/']) {
    assert.ok(e2eJob.slice(upload).includes(artifact), `${artifact} is not uploaded on failure`);
  }
});

// ── Playwright: collected partitions ───────────────────────────────────────

type Listed = {
  workers: number;
  webServer: { url?: string; reuseExistingServer?: boolean; env?: Record<string, string> } | null;
  projects: Array<{ name: string; outputDir: string; testDir: string }>;
  tests: Array<{ project: string | null; file: string; title: string }>;
};

const REPORTER_SOURCE = `'use strict';
const fs = require('node:fs');
class AlignmentListReporter {
  printsToStdio() { return false; }
  onBegin(config, suite) {
    const ws = config.webServer;
    fs.writeFileSync(process.env.HSB_ALIGN_OUT, JSON.stringify({
      workers: config.workers,
      webServer: ws ? { url: ws.url, reuseExistingServer: ws.reuseExistingServer, env: ws.env || null } : null,
      projects: config.projects.map((p) => ({ name: p.name, outputDir: p.outputDir, testDir: p.testDir })),
      tests: suite.allTests().map((t) => ({
        project: t.parent.project() ? t.parent.project().name : null,
        file: t.location.file,
        title: t.titlePath().slice(3).join(' > '),
      })),
    }));
  }
}
module.exports = AlignmentListReporter;
`;

const listCache = new Map<string, Listed>();
function listWith(config: string): Listed {
  const cached = listCache.get(config);
  if (cached) return cached;
  const dir = scratchDir('hsb-align-list-');
  try {
    const reporter = path.join(dir, 'reporter.cjs');
    const out = path.join(dir, 'out.json');
    writeFileSync(reporter, REPORTER_SOURCE);
    const result = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '--list', `--config=${config}`, `--reporter=${reporter}`], {
      cwd: ROOT,
      env: cleanEnv({ TMPDIR: dir, HSB_ALIGN_OUT: out }),
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 0, `playwright --list ${config} failed:\n${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(out), `SETUP_RED: the list reporter produced no output for ${config}`);
    const listed = JSON.parse(readFileSync(out, 'utf8')) as Listed;
    for (const t of listed.tests) t.file = path.relative(ROOT, t.file);
    listCache.set(config, listed);
    return listed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const specFiles = readdirSync(path.join(ROOT, 'tests', 'e2e')).filter((name) => name.endsWith('.spec.ts')).sort();
const KNOWN_CREDENTIALS = [
  'HSB_PRIVATE_READ_WRITE_TOKEN', 'RESEND_API_KEY', 'HSB_RESEND_API_KEY', 'OPENAI_API_KEY', 'FAL_KEY',
  'GEMINI_API_KEY', 'GOOGLE_GEMINI_API_KEY', 'LULU_CLIENT_KEY', 'LULU_CLIENT_SECRET', 'LULU_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY', 'HSB_STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CRON_SECRET', 'HSB_ORDER_ADMIN_KEY',
];

test('default browser config keeps feature-off, credential-blank, loopback posture', { timeout: 180_000 }, () => {
  const listed = listWith('playwright.config.ts');
  assert.deepEqual(listed.projects.map((p) => p.name), ['desktop-chromium', 'mobile-chromium']);
  for (const project of listed.projects) {
    assert.equal(project.testDir, path.join(ROOT, 'tests', 'e2e'));
    assert.equal(project.outputDir, path.join(ROOT, 'test-results'));
  }
  assert.ok(listed.webServer, 'SETUP_RED: webServer is not observable through the reporter config');
  const env = listed.webServer!.env ?? {};
  assert.match(listed.webServer!.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/$/);
  for (const flag of ['HSB_INITIAL_EXPEDITED_QUOTES_ENABLED', 'HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED']) {
    assert.notEqual(env[flag], 'true', `${flag} must stay off in the ordinary browser suite`);
  }
  assert.equal(env.HSB_CHECKOUT_DIRECT_UPLOAD, '');
  assert.equal(env.NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD, '');
  for (const name of [...KNOWN_CREDENTIALS, 'BLOB_READ_WRITE_TOKEN', 'HSB_INTAKE_BLOB_READ_WRITE_TOKEN', 'HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN']) {
    assert.equal(env[name], '', `${name} must be blank`);
  }
  assert.equal(env.HSB_ORDER_STORE_DIR, path.join(ROOT, '.e2e-store'));
});

test('default browser config collects exactly the 143 ordinary tests and no layout test', { timeout: 180_000 }, () => {
  const listed = listWith('playwright.config.ts');
  const layoutHere = listed.tests.filter((t) => path.basename(t.file) === LAYOUT_SPEC);
  assert.deepEqual(layoutHere.map((t) => t.title), [], 'layout cases still run feature-off in the default config');
  assert.equal(listed.tests.filter((t) => t.project === 'mobile-chromium').length, 15);
  assert.equal(listed.tests.filter((t) => t.project === 'desktop-chromium').length, 128);
  assert.equal(listed.tests.length, 143);
});

test('layout config is one feature-on project collecting exactly the 9 layout tests', { timeout: 180_000 }, () => {
  const listed = listWith('playwright.layout.config.ts');
  assert.deepEqual(listed.projects.map((p) => p.name), ['layout-chromium']);
  assert.equal(listed.projects[0].outputDir, path.join(ROOT, 'test-results-layout'));
  assert.equal(listed.workers, 1);
  assert.ok(listed.webServer, 'SETUP_RED: webServer is not observable through the reporter config');
  const env = listed.webServer!.env ?? {};
  assert.equal(listed.webServer!.reuseExistingServer, false);
  for (const flag of ['HSB_INITIAL_EXPEDITED_QUOTES_ENABLED', 'HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED', 'HSB_CHECKOUT_DIRECT_UPLOAD', 'NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD']) {
    assert.equal(env[flag], 'true', `${flag} must be on for the layout partition`);
  }
  for (const name of KNOWN_CREDENTIALS) assert.equal(env[name], '', `${name} must stay blank`);
  assert.equal(env.HSB_ORDER_STORE_DIR, path.join(ROOT, '.e2e-store-layout'));
  assert.ok(listed.tests.every((t) => t.file === path.join('tests', 'e2e', LAYOUT_SPEC)), 'layout config collects other specs');
  assert.ok(listed.tests.every((t) => t.project === 'layout-chromium'));
  assert.equal(listed.tests.length, 9);
});

test('default and layout partitions are disjoint and together cover every spec once', { timeout: 180_000 }, () => {
  const ordinary = listWith('playwright.config.ts');
  const layout = listWith('playwright.layout.config.ts');
  const key = (t: { file: string; title: string }) => `${t.file}::${t.title}`;
  const ordinaryKeys = new Set(ordinary.tests.map(key));
  assert.deepEqual(layout.tests.map(key).filter((k) => ordinaryKeys.has(k)), [], 'a test runs in both partitions');
  const covered = [...new Set([...ordinary.tests, ...layout.tests].map((t) => path.basename(t.file)))].sort();
  assert.deepEqual(covered, specFiles);
  assert.equal(ordinary.tests.length + layout.tests.length, 152);
});

test('layout HTML report folder is distinct from the default report', () => {
  const layoutSource = readFileSync(path.join(ROOT, 'playwright.layout.config.ts'), 'utf8');
  const baseSource = readFileSync(path.join(ROOT, 'playwright.config.ts'), 'utf8');
  assert.match(layoutSource, /outputFolder:\s*'playwright-report-layout'/);
  assert.doesNotMatch(baseSource, /playwright-report-layout/);
});

// ── Canonical Node suite launcher ──────────────────────────────────────────

test('SETUP: every CI helper exists', () => {
  const missing = HELPER_NAMES.filter((name) => !existsSync(path.join(HELPERS, name)));
  assert.deepEqual(missing, [], `SETUP_RED: missing helpers ${missing.join(', ')}`);
});

test('canonical suite selects every repository test file except only the joined journey', async () => {
  const suite = await loadHelper('ci-node-suite.mjs');
  assert.equal(suite.ROOT, ROOT);
  assert.equal(suite.JOINED_ONLY, JOURNEY);
  const onDisk = repositoryTestFiles(ROOT);
  assert.ok(onDisk.includes(JOURNEY), 'the joined journey test file disappeared');
  const selected: string[] = suite.selectFiles(ROOT);
  assert.deepEqual(selected, onDisk.filter((name) => name !== JOURNEY).map((name) => `tests/${name}`));
  assert.equal(selected.length, onDisk.length - 1);
  for (const required of [
    'control-plane-postgres.test.ts',
    'control-plane-shadow-settlement-postgres.test.ts',
    'postgres-harness-scratch-root.test.ts',
    'control-plane-isolation.test.ts',
    'initial-shipping-dispatch.test.ts',
    'initial-shipping-metrics.test.ts',
    'initial-shipping-settlement.test.ts',
    'initial-shipping-summary.test.ts',
    'ci-harness-alignment.test.ts',
  ]) {
    assert.ok(selected.includes(`tests/${required}`), `${required} is not in the canonical suite`);
  }
  assert.ok(!selected.includes(`tests/${JOURNEY}`));
});

test('canonical args are exactly the core flags followed by the files', async () => {
  const suite = await loadHelper('ci-node-suite.mjs');
  const files = suite.selectFiles(ROOT);
  assert.deepEqual(suite.buildArgs(files), [...CORE_FLAGS, ...files]);
});

test('selection over a synthetic tree is files-only, sorted, and requires the journey', async () => {
  const suite = await loadHelper('ci-node-suite.mjs');
  const root = scratchDir('hsb-align-tree-');
  try {
    mkdirSync(path.join(root, 'tests'));
    for (const name of ['b.test.ts', 'a.test.ts', JOURNEY, 'c.spec.ts', 'helper.ts']) {
      writeFileSync(path.join(root, 'tests', name), '');
    }
    mkdirSync(path.join(root, 'tests', 'nested.test.ts'));
    assert.deepEqual(suite.selectFiles(root), ['tests/a.test.ts', 'tests/b.test.ts']);
    rmSync(path.join(root, 'tests', JOURNEY));
    assert.throws(() => suite.selectFiles(root), /initial-shipping-journey/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('module mocks work in a native child launched with the planned args, and the flag is load-bearing', async () => {
  const suite = await loadHelper('ci-node-suite.mjs');
  const dir = scratchDir('hsb-align-mock-');
  try {
    writeFileSync(path.join(dir, 'dep.mjs'), "export const value = 'real';\n");
    writeFileSync(path.join(dir, 'probe.test.ts'), [
      "import test, { mock } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "const typed: string = 'strip-types';",
      "test('module mocks are available', async () => {",
      "  assert.equal(typed, 'strip-types');",
      "  assert.equal(typeof mock.module, 'function');",
      "  const dep = new URL('./dep.mjs', import.meta.url).href;",
      "  mock.module(dep, { namedExports: { value: 'mocked' } });",
      "  assert.equal((await import(dep)).value, 'mocked');",
      '});',
      '',
    ].join('\n'));
    const args: string[] = suite.buildArgs(['probe.test.ts']);
    assert.equal(args[args.length - 1], 'probe.test.ts');
    const withTap = [...args.slice(0, -1), '--test-reporter=tap', 'probe.test.ts'];
    const run = (argv: string[]) => spawnSync(process.execPath, argv, {
      cwd: dir, env: cleanEnv({ TMPDIR: dir }), encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
    });
    const planned = run(withTap);
    assert.equal(tapCount(planned.stdout, 'pass'), 1, planned.stdout + planned.stderr);
    assert.equal(tapCount(planned.stdout, 'fail'), 0);
    assert.equal(planned.status, 0);
    const withoutMocks = run(withTap.filter((arg) => arg !== '--experimental-test-module-mocks'));
    assert.equal(tapCount(withoutMocks.stdout, 'fail'), 1, 'the probe does not discriminate the module-mock flag');
    assert.notEqual(withoutMocks.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonical child env strips database settings and nested test context', async () => {
  const suite = await loadHelper('ci-node-suite.mjs');
  const env = suite.childEnv({
    PATH: '/bin', HOME: '/h', TMPDIR: '/t', CI: 'true', HSB_ORDER_STORE_DIR: '/o',
    PGHOST: 'h', PGPORT: '5432', PGUSER: 'u', PGPASSWORD: 'p', PGDATABASE: 'd', PGSERVICE: 's', PGPASSFILE: 'f',
    DATABASE_URL: 'postgres://x', POSTGRES_URL: 'postgres://y', POSTGRES_PASSWORD: 'p', NODE_TEST_CONTEXT: 'child',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', TMPDIR: '/t', CI: 'true', HSB_ORDER_STORE_DIR: '/o' });
});

test('runNodeSuite runs the selected set, never the journey, and propagates failure', { timeout: 120_000 }, async () => {
  const suite = await loadHelper('ci-node-suite.mjs');
  const root = scratchDir('hsb-align-run-');
  try {
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests', 'a.test.ts'), "import test from 'node:test';\ntest('passes', () => {});\n");
    writeFileSync(path.join(root, 'tests', JOURNEY), "throw new Error('JOURNEY_MUST_NOT_RUN_IN_CANONICAL_SUITE');\n");
    const env = cleanEnv({ TMPDIR: root, NODE_TEST_CONTEXT: 'child', PGHOST: '/nonexistent' });
    assert.deepEqual(await suite.runNodeSuite({ root, env, stdio: 'ignore' }), { code: 0, signal: null });
    writeFileSync(path.join(root, 'tests', 'b.test.ts'), "import test from 'node:test';\ntest('fails', () => { throw new Error('expected'); });\n");
    const failed = await suite.runNodeSuite({ root, env, stdio: 'ignore' });
    assert.equal(failed.signal, null);
    assert.notEqual(failed.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Joined mounted journey orchestration ───────────────────────────────────

test('joined constants pin the journey, its exact count and its loopback port', async () => {
  const joined = await loadHelper('ci-joined.mjs');
  assert.equal(joined.JOINED_FILE, `tests/${JOURNEY}`);
  assert.equal(joined.JOINED_EXPECTED, 9);
  assert.equal(joined.PORT, 3199);
  assert.equal(joined.HOST, '127.0.0.1');
  for (const name of ['BUILD_TIMEOUT_MS', 'READY_TIMEOUT_MS', 'GATE_TIMEOUT_MS']) {
    assert.ok(Number.isSafeInteger(joined[name]) && joined[name] > 0 && joined[name] <= 900_000, `${name} is unbounded`);
  }
});

const SYNTHETIC_TOKEN = (store: string) => ['vercel', 'blob', 'rw', store, 'syntheticSecret'].join('_');

test('joined server env is an exact credential-free allowlist with production primary-hero default', async () => {
  const joined = await loadHelper('ci-joined.mjs');
  const env = joined.serverEnv({ home: '/h', tmp: '/t', path: '/usr/bin:/bin' });
  assert.deepEqual(env, {
    PATH: '/usr/bin:/bin',
    HOME: '/h',
    TMPDIR: '/t',
    NEXT_TELEMETRY_DISABLED: '1',
    HSB_REQUIRE_DURABLE_PERSISTENCE: 'false',
    HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    NEXT_PUBLIC_HSB_CHECKOUT_DIRECT_UPLOAD: 'true',
    HSB_INITIAL_EXPEDITED_QUOTES_ENABLED: 'true',
    HSB_INITIAL_EXPEDITED_CHECKOUT_ENABLED: 'true',
    HSB_CHECKOUT_GUARD_MODE: 'durable',
    HSB_INTAKE_BLOB_READ_WRITE_TOKEN: SYNTHETIC_TOKEN('syntheticintake'),
    HSB_CHECKOUT_GUARD_BLOB_READ_WRITE_TOKEN: SYNTHETIC_TOKEN('syntheticguard'),
    BLOB_READ_WRITE_TOKEN: SYNTHETIC_TOKEN('syntheticorders'),
  });
  assert.ok(!('NEXT_PUBLIC_HSB_PRIMARY_HERO_BETA' in env) && !('HSB_PRIMARY_HERO_BETA' in env));
});

test('joined gate env is an exact allowlist with an explicit browser cache', async () => {
  const joined = await loadHelper('ci-joined.mjs');
  const base = { home: '/h', tmp: '/t', path: '/bin' };
  assert.deepEqual(joined.gateEnv({ ...base, browsersPath: '/b', realHome: '/r', platform: 'linux' }), {
    PATH: '/bin', HOME: '/h', TMPDIR: '/t', NEXT_TELEMETRY_DISABLED: '1', PLAYWRIGHT_BROWSERS_PATH: '/b',
  });
  assert.equal(joined.gateEnv({ ...base, realHome: '/r', platform: 'linux' }).PLAYWRIGHT_BROWSERS_PATH, '/r/.cache/ms-playwright');
  assert.equal(joined.gateEnv({ ...base, realHome: '/r', platform: 'darwin' }).PLAYWRIGHT_BROWSERS_PATH, '/r/Library/Caches/ms-playwright');
  assert.throws(() => joined.gateEnv({ ...base, realHome: '/r', platform: 'win32' }));
});

function preloadTarget(value: string): string {
  return value.startsWith('file:') ? fileURLToPath(value) : path.resolve(ROOT, value);
}
function pairs(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, i) => (arg === flag ? [preloadTarget(argv[i + 1])] : []));
}

test('joined plan is a hermetic build, a loopback server, then the exact gate', async () => {
  const joined = await loadHelper('ci-joined.mjs');
  const options = { root: ROOT, home: '/h', tmp: '/t', path: '/bin', tapFile: '/t/joined.tap', browsersPath: '/b', realHome: '/r', platform: 'linux' };
  const steps = joined.plan(options);
  assert.deepEqual(steps.map((s: any) => s.kind), ['build', 'server', 'gate']);
  for (const step of steps) assert.equal(step.command, process.execPath);
  const [build, server, gate] = steps;

  assert.deepEqual(pairs(build.argv, '--require'), [DOTENV_PRELOAD]);
  assert.ok(build.argv.includes(NEXT_BIN));
  assert.equal(build.argv[build.argv.length - 1], 'build');
  assert.ok(!build.argv.includes('start'));

  assert.deepEqual(pairs(server.argv, '--require'), [DOTENV_PRELOAD]);
  assert.deepEqual(pairs(server.argv, '--import'), [path.join(HELPERS, 'ci-loopback-preload.mjs')]);
  assert.ok(server.argv.includes(NEXT_BIN) && server.argv.includes('start'));
  const host = server.argv.findIndex((a: string) => a === '-H' || a === '--hostname');
  const port = server.argv.findIndex((a: string) => a === '-p' || a === '--port');
  assert.equal(server.argv[host + 1], '127.0.0.1');
  assert.equal(server.argv[port + 1], '3199');
  const expectedServerEnv = joined.serverEnv({ home: '/h', tmp: '/t', path: '/bin' });
  assert.deepEqual(build.env, expectedServerEnv);
  assert.deepEqual(server.env, expectedServerEnv);

  assert.deepEqual(gate.argv.slice(0, 2), CORE_FLAGS.slice(0, 2));
  assert.deepEqual(pairs(gate.argv, '--require'), [DOTENV_PRELOAD]);
  assert.deepEqual(pairs(gate.argv, '--import'), [
    path.join(HELPERS, 'ci-offline-preload.mjs'),
    path.join(HELPERS, 'ci-native-aliases.mjs'),
  ]);
  assert.ok(gate.argv.includes('--test'));
  assert.equal(gate.argv.filter((a: string) => a.startsWith('--test-concurrency')).length, 1);
  assert.ok(gate.argv.includes('--test-concurrency=1'));
  const tap = gate.argv.indexOf('--test-reporter=tap');
  assert.ok(tap >= 0);
  assert.equal(gate.argv[tap + 1], '--test-reporter-destination=/t/joined.tap');
  assert.equal(path.resolve(ROOT, gate.argv[gate.argv.length - 1]), path.join(ROOT, 'tests', JOURNEY));
  assert.deepEqual(gate.argv.filter((a: string) => /^--test-(?:name-pattern|skip-pattern|only|shard)/.test(a)), []);
  assert.deepEqual(gate.env, joined.gateEnv(options));
});

test('joined TAP summary admits only exactly 9 passing and nothing else', async () => {
  const joined = await loadHelper('ci-joined.mjs');
  const tap = (o: Partial<Record<'tests' | 'pass' | 'fail' | 'cancelled' | 'skipped' | 'todo', number>>, drop?: string) => [
    'TAP version 13',
    `# tests ${o.tests ?? 9}`, '# suites 0', `# pass ${o.pass ?? 9}`, `# fail ${o.fail ?? 0}`,
    `# cancelled ${o.cancelled ?? 0}`, `# skipped ${o.skipped ?? 0}`, `# todo ${o.todo ?? 0}`, '# duration_ms 12.5',
  ].filter((line) => !drop || !line.startsWith(`# ${drop} `)).join('\n');
  assert.equal(joined.parseTapSummary(tap({})).ok, true);
  for (const [label, text] of [
    ['one failure', tap({ pass: 8, fail: 1 })],
    ['one skip', tap({ pass: 8, skipped: 1 })],
    ['one todo', tap({ pass: 8, todo: 1 })],
    ['one cancelled', tap({ pass: 8, cancelled: 1 })],
    ['ten tests', tap({ tests: 10, pass: 10 })],
    ['eight tests', tap({ tests: 8, pass: 8 })],
    ['zero tests', tap({ tests: 0, pass: 0 })],
    ['missing pass line', tap({}, 'pass')],
    ['missing skipped line', tap({}, 'skipped')],
    ['duplicated summary', `${tap({})}\n# tests 9`],
    ['empty', ''],
  ] as const) {
    assert.equal(joined.parseTapSummary(text).ok, false, label);
  }
});

test('joined port probe sees an occupied loopback port and its release', async () => {
  const joined = await loadHelper('ci-joined.mjs');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  assert.equal(await joined.portIsFree(port, '127.0.0.1'), false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await joined.portIsFree(port, '127.0.0.1'), true);
});

// ── Preloads and aliases ────────────────────────────────────────────────────

const PROBE_PRELUDE = `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
const r = {};
const t = (key, marker, fn) => {
  try {
    const v = fn();
    if (v && typeof v.catch === 'function') v.catch(() => {});
    if (v && typeof v.on === 'function') { v.on('error', () => {}); if (typeof v.destroy === 'function') v.destroy(); }
    r[key] = 'allowed';
  } catch (e) {
    r[key] = String(e && e.message).includes(marker) ? 'blocked' : 'other:' + (e && e.message);
  }
};
`;

function probe(preload: string, body: string): Record<string, string> {
  const file = path.join(HELPERS, preload);
  assert.ok(existsSync(file), `SETUP_RED: tests/helpers/${preload} does not exist yet`);
  const dir = scratchDir('hsb-align-probe-');
  try {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(file).href, '--input-type=module', '-e',
      `${PROBE_PRELUDE}\n${body}\nconsole.log(JSON.stringify(r));\nprocess.exit(0);`], {
      cwd: dir, env: cleanEnv({ TMPDIR: dir }), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    return JSON.parse(lines[lines.length - 1] || '{}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('offline preload blocks every outbound primitive before any connection', () => {
  const marker = 'UNEXPECTED_NETWORK_ATTEMPT_BLOCKED';
  const r = probe('ci-offline-preload.mjs', [
    `t('fetch', '${marker}', () => fetch('http://127.0.0.1:9/'));`,
    `t('httpRequest', '${marker}', () => http.request('http://127.0.0.1:9/'));`,
    `t('httpGet', '${marker}', () => http.get('http://127.0.0.1:9/'));`,
    `t('httpsRequest', '${marker}', () => https.request('https://127.0.0.1:9/'));`,
    `t('httpsGet', '${marker}', () => https.get('https://127.0.0.1:9/'));`,
    `t('netConnect', '${marker}', () => net.connect(9, '127.0.0.1'));`,
    `t('netCreateConnection', '${marker}', () => net.createConnection(9, '127.0.0.1'));`,
  ].join('\n'));
  assert.deepEqual(r, {
    fetch: 'blocked', httpRequest: 'blocked', httpGet: 'blocked', httpsRequest: 'blocked',
    httpsGet: 'blocked', netConnect: 'blocked', netCreateConnection: 'blocked',
  });
});

test('loopback preload admits only http://127.0.0.1:3199', () => {
  const marker = 'OFFHOST_BLOCKED';
  const r = probe('ci-loopback-preload.mjs', [
    `t('otherHostFetch', '${marker}', () => fetch('http://127.0.0.2:3199/'));`,
    `t('otherPortFetch', '${marker}', () => fetch('http://127.0.0.1:3198/'));`,
    `t('httpsGet', '${marker}', () => https.get('https://127.0.0.1:3199/'));`,
    `t('httpOtherHost', '${marker}', () => http.get('http://127.0.0.2:3199/'));`,
    `t('netOtherPort', '${marker}', () => new net.Socket().connect(3198, '127.0.0.1'));`,
    `t('netOtherHost', '${marker}', () => new net.Socket().connect({ host: '127.0.0.2', port: 3199 }));`,
    `t('fetchServer', '${marker}', () => fetch('http://127.0.0.1:3199/'));`,
    `t('netServer', '${marker}', () => new net.Socket().connect({ host: '127.0.0.1', port: 3199 }));`,
  ].join('\n'));
  assert.deepEqual(r, {
    otherHostFetch: 'blocked', otherPortFetch: 'blocked', httpsGet: 'blocked', httpOtherHost: 'blocked',
    netOtherPort: 'blocked', netOtherHost: 'blocked', fetchServer: 'allowed', netServer: 'allowed',
  });
});

test('native aliases resolve @/ into this checkout from any cwd and next/server to its .js entry', () => {
  const file = path.join(HELPERS, 'ci-native-aliases.mjs');
  assert.ok(existsSync(file), 'SETUP_RED: tests/helpers/ci-native-aliases.mjs does not exist yet');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /\/Users\//, 'aliases must not hardcode a checkout path');
  const resolve = (cwd: string, specifiers: string[]) => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(file).href, '--input-type=module', '-e',
      `console.log(JSON.stringify(${JSON.stringify(specifiers)}.map((s) => import.meta.resolve(s))));`], {
      cwd, env: cleanEnv(), encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim()) as string[];
  };
  const [alias, nextServer] = resolve(ROOT, ['@/lib/orders', 'next/server']);
  assert.equal(alias, pathToFileURL(path.join(ROOT, 'src', 'lib', 'orders.ts')).href);
  assert.equal(nextServer, pathToFileURL(path.join(ROOT, 'node_modules', 'next', 'server.js')).href);
  const elsewhere = scratchDir('hsb-align-alias-');
  try {
    assert.deepEqual(resolve(elsewhere, ['@/lib/orders']), [alias]);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
